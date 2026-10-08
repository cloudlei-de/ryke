// One bench cell: a fresh `convert` trunk, N synthetic agents under one policy for a fixed time, then
// the numbers and the trunk check (PLAN.md §11.3).
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { promisify } from "node:util";
import { runAgent, brief } from "../agents/synthetic.mjs";
import { client } from "../lib/client.mjs";
import { Workspace } from "../lib/gitops.mjs";
import { resilient } from "../swarm.mjs";
import { rykeOpStats, rykeVerifyRuns, round, summarizeCell } from "./metrics.mjs";
import { checkTrunk, controlPlane, sleep } from "./plumbing.mjs";
import { lockPolicy, queuePolicy, rykePolicy } from "./policies.mjs";
import { waitWhileSettling } from "./settle.mjs";
import { estimateIncompatibility, seedFiles } from "./workload.mjs";

const run = promisify(execFile);

export const GRACE_SECONDS = 20;
const SEED_MESSAGE = "Bench: add the constants tests may pin";

export function endpointsOf(stack) {
  return {
    apiUrl: stack.apiUrl,
    token: stack.token,
    storeUrl: `http://127.0.0.1:${stack.storePort}`,
    runnerUrl: `http://127.0.0.1:${stack.runnerPort}`,
    secret: stack.internalSecret,
  };
}

// Runs the repo's own verify command in a checkout. The nested `node --test` must not inherit the
// context of the test run this may live in, or it reports to its parent and always exits 0.
export async function runVerifyCommand(dir, command, timeoutMs) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    await run("sh", ["-c", command], { cwd: dir, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { pass: true };
  } catch (e) {
    const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    const failing = [...new Set([...out.matchAll(/^\s*not ok \d+ - (.*?)(?: # .*)?$/gm), ...out.matchAll(/^\s*✖ (.*?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)].map((m) => m[1]))];
    return { pass: false, failing: failing.slice(0, 5), tail: out.trim().split("\n").slice(-4).join(" | ") };
  }
}

function recorder() {
  const data = { plans: [], attempts: [], txns: [], errors: [], opened: [] };
  return {
    plan: (p) => data.plans.push(p),
    attempt: (a) => data.attempts.push(a),
    txn: (t) => data.txns.push(t),
    error: (m) => data.errors.push(m),
    opened: (id) => data.opened.push(id),
    data,
  };
}

// The cell's own seed commit: one numeric constant per hot file that tests may pin (see workload.mjs).
async function seedTrunk({ ctl, api, repo, policyName }) {
  const read = async (path) => (await ctl.file(repo, "main", path)) ?? "";
  const files = Object.fromEntries(await Promise.all(["src/format.ts", "src/ui/layout.ts"].map(async (p) => [p, await read(p)])));
  const edits = seedFiles(files);
  if (policyName !== "ryke") {
    const ws = await Workspace.create("bench-seed");
    try {
      const [info, token] = [await ctl.info(repo), await ctl.token(repo, "write", 600)];
      const head = await ws.fetch(info.remote, token, "main");
      await ws.git("checkout", "-q", "--detach", head);
      await ws.write(edits);
      await ws.push(info.remote, token, await ws.commitAll(SEED_MESSAGE));
    } finally {
      await ws.remove();
    }
    return;
  }
  // On Ryke the seed lands like any change, so the Ledger knows the new head.
  const b = await api.begin(repo, { agent: "bench-seed", model: "bench", intent: SEED_MESSAGE });
  const ws = await Workspace.create("bench-seed");
  try {
    await ws.git("checkout", "-q", "--detach", await ws.fetch(b.remote, b.token, "main"));
    await ws.write(edits);
    const head = await ws.commitAll(SEED_MESSAGE);
    await ws.push(b.remote, b.token, head, true);
    const landed = await waitWhileSettling(api, b.txn, await api.submit(b.txn, { head }));
    if (!landed.landed) throw new Error(`the bench seed commit did not land: ${JSON.stringify(landed)}`);
  } finally {
    await ws.remove();
  }
}

async function quiesce(api, repo, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await api.repo(repo);
    const busy = (s.counts.submitted ?? 0) + (s.counts.ready ?? 0) + (s.counts.verifying ?? 0);
    if (s.train === null && busy === 0) return { quiet: true, summary: s };
    if (Date.now() > until) return { quiet: false, summary: s };
    await sleep(500);
  }
}

async function allOps(api, repo) {
  const ops = [];
  for (let after = 0; ; ) {
    const page = await api.ops(repo, after, 5000);
    ops.push(...page.ops);
    if (page.ops.length < 5000) return ops;
    after = page.last;
  }
}

const tally = (list) => list.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

// opts: { policy, agents, durationS, factor, seed, stack, graceS, log, staggerS }
export async function runCell(opts) {
  const { policy: policyName, agents, durationS, factor = 1, seed = 7, stack, graceS = GRACE_SECONDS, log = () => {}, intermediate = 10 } = opts;
  const { apiUrl, token, storeUrl, runnerUrl, secret } = endpointsOf(stack);
  const api = resilient(client(apiUrl, token));
  const ctl = controlPlane({ storeUrl, runnerUrl, secret });
  const repo = `bench-${policyName}-${agents}`;
  const say = (line) => log(`  ${line}`);

  const created = await api.createRepo(repo, "convert", true);
  const policy = (await api.repo(repo)).policy;
  say(`${repo}: seeded from convert at ${created.head.slice(0, 8)}`);
  await seedTrunk({ ctl, api, repo, policyName });

  const rec = recorder();
  const stats = { verifyMs: [], refreshes: 0, leaseWaits: 0, leaseWaitMs: 0, leaseGaveUp: 0 };
  let verifyRuns = 0;
  const abort = new AbortController();
  const started = performance.now();
  const clock = {
    elapsedMs: () => performance.now() - started,
    expired: () => performance.now() - started >= durationS * 1000,
    signal: abort.signal,
  };
  const impl = { ctl, trunk: repo, policy, clock, stats };
  const pol = policyName === "lock" ? lockPolicy(impl) : policyName === "queue" ? queuePolicy(impl) : rykePolicy({ api, repo, clock, stats });

  const root = await mkdtemp(join(tmpdir(), `ryke-bench-${policyName}-${agents}-`));
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const cpu0 = process.cpuUsage();
  const t0Epoch = Date.now();
  const staggerMs = (opts.staggerS ?? 6) * 1000 * factor;
  const hardStop = setTimeout(() => abort.abort(new Error("bench: hard stop")), (durationS + graceS) * 1000);
  const progress = setInterval(() => {
    const landed = rec.data.txns.filter((t) => t.status === "landed" && t.endMs <= durationS * 1000).length;
    say(`${Math.round(clock.elapsedMs() / 1000)} s: landed ${landed}, started ${rec.data.plans.length}, errors ${rec.data.errors.length}`);
  }, 15_000);

  const workers = Array.from({ length: agents }, (_, i) =>
    runAgent({ index: i + 1, name: `bench-${String(i + 1).padStart(3, "0")}`, policy: pol, rec, clock, seed, factor, root, staggerMs }).catch((e) => rec.error(`agent ${i + 1} died: ${brief(e)}`)),
  );
  await Promise.all(workers);
  clearTimeout(hardStop);
  clearInterval(progress);
  lag.disable();
  const wallS = clock.elapsedMs() / 1000;
  const cpuS = (({ user, system }) => (user + system) / 1e6)(process.cpuUsage(cpu0));
  await rm(root, { recursive: true, force: true });

  // Let the lander finish what it already holds, so the trunk check sees a trunk that stopped moving.
  let ledger = null;
  let ops = [];
  if (policyName === "ryke") {
    const q = await quiesce(api, repo, 90_000);
    ledger = { quiet: q.quiet, head: q.summary.head, seq: q.summary.seq };
    ops = await allOps(api, repo);
    verifyRuns = rykeVerifyRuns(ops, { sinceAt: t0Epoch, untilAt: t0Epoch + durationS * 1000 });
  } else {
    // One verify per attempt that merged cleanly, counted for the attempts that ended inside the window.
    verifyRuns = rec.data.attempts.filter((a) => a.verified && a.endMs <= durationS * 1000).length;
  }

  const check = await checkTrunk(ctl, { repo, policy, runCommand: runVerifyCommand, intermediate });
  const problems = [];
  if (ledger?.quiet && ledger.head !== check.head) problems.push(`the Ledger's head ${ledger.head} differs from the trunk's ${check.head}`);

  const { cell, extras } = summarizeCell({
    policy: policyName,
    agents,
    durationMs: durationS * 1000,
    attempts: rec.data.attempts,
    txns: rec.data.txns,
    verifyRuns,
    trunkBreakages: check.breakages,
  });
  const failedChecks = check.checked.filter((c) => !c.pass);
  const incompat = estimateIncompatibility(rec.data.plans);

  const detail = {
    ...extras,
    wallSeconds: round(wallS, 1),
    trunkCommits: check.commits,
    checkedCommits: check.checked.length,
    failedChecks,
    problems,
    incompatibility: { ...incompat, rate: round(incompat.rate, 4) },
    refreshes: stats.refreshes,
    refreshedAttempts: rec.data.attempts.filter((a) => a.refreshes > 0).length,
    lostThinkSeconds: round(rec.data.attempts.reduce((n, a) => n + (a.lostThinkS ?? 0), 0), 1),
    leaseWaits: stats.leaseWaits,
    leaseWaitSeconds: round(stats.leaseWaitMs / 1000, 1),
    leaseGaveUp: stats.leaseGaveUp,
    errors: rec.data.errors.length,
    errorSamples: rec.data.errors.slice(0, 5),
    meanVerifySeconds: stats.verifyMs.length === 0 ? null : round(stats.verifyMs.reduce((a, b) => a + b, 0) / stats.verifyMs.length / 1000),
    conflictPaths: tally(rec.data.attempts.flatMap((a) => (a.outcome === "text_conflict" ? (a.paths ?? []) : []))),
    failingTests: tally(rec.data.attempts.flatMap((a) => a.failures ?? [])),
    loopLagMs: { p50: round(lag.percentile(50) / 1e6, 1), p99: round(lag.percentile(99) / 1e6, 1), max: round(lag.max / 1e6, 1) },
    agentCpuSeconds: round(cpuS, 1),
    loadAverage1m: round(loadavg()[0]),
    ledger,
    ryke: policyName === "ryke" ? rykeOpStats(ops, { sinceAt: t0Epoch, untilAt: t0Epoch + durationS * 1000 }) : null,
  };

  // Forks are scratch; the trunk stays for a post-mortem.
  const forks = [...new Set(rec.data.opened)];
  for (let i = 0; i < forks.length; i += 8) await Promise.all(forks.slice(i, i + 8).map((t) => ctl.remove(`${repo}--${t}`).catch(() => {})));

  return { cell, detail };
}
