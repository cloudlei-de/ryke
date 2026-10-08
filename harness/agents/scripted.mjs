// The scripted agent (PLAN.md §10.4): one task at a time, speaking only the public HTTP API and git,
// exactly like an outside agent would. It replays the task's solution patch instead of thinking.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApiError, waitWhile } from "../lib/client.mjs";
import { Workspace } from "../lib/gitops.mjs";
import { identityFor, nextVariant, patchFile, thinkMs } from "../lib/tasks.mjs";

const run = promisify(execFile);

// Error bodies can be whole HTML pages (the dev server's error overlay); a log line keeps the first words.
export const brief = (e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 200);

// A nested `node --test` that inherits NODE_TEST_CONTEXT reports to its parent and exits 0 even
// when tests fail, which matters whenever the swarm itself runs inside a test run.
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export async function localVerify(dir, policy) {
  const started = Date.now();
  try {
    await run("sh", ["-c", policy.verify], { cwd: dir, env: cleanEnv(), timeout: policy.verifyTimeoutSeconds * 1000, maxBuffer: 32 * 1024 * 1024 });
    return { pass: true, ms: Date.now() - started, failing: [] };
  } catch (e) {
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    const failing = [...new Set([...output.matchAll(/^\s*not ok \d+ - (.*?)(?: # .*)?$/gm), ...output.matchAll(/^\s*✖ (.*?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)].map((m) => m[1]))];
    return { pass: false, ms: Date.now() - started, failing: failing.slice(0, 3), timedOut: e.killed === true };
  }
}

// `git apply --3way` merges union paths with the union driver when `.git/info/attributes` says so,
// and leaves conflict markers (and a non-zero exit) when it cannot. Either way a failed apply is undone.
async function applyPatch(ws, file, snapshot) {
  try {
    await ws.git("apply", "--3way", file);
    // A patch whose changes the trunk already holds applies cleanly and changes nothing.
    if ((await ws.git("diff", "--cached", "--name-only")) !== "") return true;
  } catch {
    // fall through to the reset
  }
  await ws.git("reset", "-q", "--hard", snapshot);
  await ws.git("clean", "-fdq");
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const LEASE_PATIENCE_MS = 90_000;

// §7.2 from the agent's side: wait while a hot path is leased to someone else, give up after 90 s in
// total (so a lease can never block an agent forever), then write anyway.
// Returns whether it had to wait, so the caller can refresh onto the trunk the holder just moved.
export async function admit(api, txn, paths, say, { now = Date.now, wait = sleep } = {}) {
  const until = now() + LEASE_PATIENCE_MS;
  let waited = false;
  for (const path of paths) {
    for (;;) {
      const r = await api.intendWrite(txn, path);
      if (r.go) break;
      waited = true;
      if (now() >= until) {
        say(`gave up waiting for ${path}; writing anyway`);
        break;
      }
      say(`waiting for ${path}: leased to ${r.owner}, retry in ${r.retryAfterMs} ms`);
      await wait(Math.max(50, Math.min(r.retryAfterMs, until - now())));
    }
  }
  return waited;
}

// One line per kind of warning, naming the strongest one: a begin can come back with five of each, and
// the swarm log has to stay readable with twelve agents.
export function describeWarnings(warnings) {
  const lines = [];
  for (const kind of ["duplicate", "conflict", "stale"]) {
    const same = warnings.filter((w) => w.kind === kind);
    if (same.length === 0) continue;
    const strength = (w) => (kind === "duplicate" ? w.value : kind === "conflict" ? w.score : 0);
    const top = same.reduce((a, b) => (strength(b) > strength(a) ? b : a));
    const more = same.length > 1 ? ` (+${same.length - 1} more)` : "";
    lines.push(
      kind === "stale"
        ? `warning stale: ${top.paths.join(", ")}${more}`
        : `warning ${kind} of ${top.other} "${top.intent}" (${kind === "duplicate" ? `similarity ${top.value}` : `conflict ${top.score}, confidence ${top.confidence}`})${more}`,
    );
  }
  return lines;
}

const TERMINAL = new Set(["landed", "rejected", "aborted", "recalled"]);

// ctx: { api, repo, task, dir (catalogue directory), worker (agent id of the swarm worker), rng, speed,
//        contention (boolean), log(agent, line), waitMs?, verify?(dir, policy) }
// Resolves with a record of what happened; throws only for things the agent cannot handle.
export async function runTask(ctx) {
  const { api, repo, task, dir, worker, rng, speed = 1, contention = false, log, waitMs = 600_000, verify = localVerify } = ctx;
  const { agent, model } = identityFor(task, worker);
  const say = (line) => log(agent, `${task.id}  ${line}`);
  const result = { task: task.id, agent, model, txn: null, outcome: "error", reason: null, attempts: 0, variants: [], warnings: 0 };
  const writes = [...new Set(task.writes)].sort();
  const reads = [...new Set([...task.reads, ...task.writes])];

  // `begun` resumes a transaction Ryke opened itself, e.g. an intent a recall re-queued.
  const b = ctx.begun ?? (await api.begin(repo, { agent, model, intent: task.intent, criteria: task.criteria }));
  if (!b?.txn) throw new Error(`begin failed: ${b?.error ?? JSON.stringify(b)}`);
  result.txn = b.txn;
  result.warnings = (b.warnings ?? []).length;
  for (const line of describeWarnings(b.warnings ?? [])) say(line);
  if (b.state === "rejected") {
    say(`rejected at begin: ${b.reason}`);
    return { ...result, outcome: "rejected", reason: b.reason };
  }
  say(`begin ${b.txn} at ${b.snapshot.slice(0, 8)}`);

  const ws = await Workspace.create(agent);
  try {
    let fork = { remote: b.remote, token: b.token };
    let from = { remote: b.remote, token: b.token, ref: "main" };
    for (let attempt = 1; attempt <= 6; attempt++) {
      result.attempts = attempt;
      let snapshot = await ws.fetch(from.remote, from.token, from.ref);
      await ws.checkout(snapshot);
      await ws.setUnion(b.policy.union);

      const r = await api.reads(b.txn, reads);
      if (r.staleWarnings.length > 0) say(`stale warning already: ${r.staleWarnings.map((p) => `${p.path} <- ${p.by}`).join(", ")}`);
      if (contention) {
        const waited = await admit(api, b.txn, writes, say).catch((e) => say(`lease check failed: ${brief(e)}`));
        // The holder landed while we waited: move onto its trunk before doing the work, not after.
        const after = waited ? await api.reads(b.txn, reads) : null;
        if (after && after.staleWarnings.length > 0) {
          const fresh = await api.call("POST", `/api/txns/${b.txn}/refresh`, {});
          say(`refreshed onto ${fresh.snapshot.slice(0, 8)} after the lease wait (${fresh.delta.map((d) => d.path).join(", ")})`);
          snapshot = await ws.fetch(fresh.trunk.remote, fresh.trunk.token, fresh.snapshot);
          await ws.checkout(snapshot);
          await api.reads(b.txn, reads);
        }
      }

      const ms = thinkMs(rng, task, { speed, retry: attempt > 1 });
      say(`attempt ${attempt}: thinking ${(ms / 1000).toFixed(1)} s`);
      await sleep(ms);

      const tried = [];
      for (let step = nextVariant(task, tried, result.variants); !step.done; step = nextVariant(task, tried, result.variants)) {
        if (step.abort) {
          say(`abort: ${step.abort}`);
          await api.abort(b.txn, step.abort);
          return { ...result, outcome: "aborted", reason: step.abort };
        }
        const file = patchFile(dir, task, step.variant);
        const applied = file ? await applyPatch(ws, file, snapshot) : false;
        const verified = applied ? await verify(ws.dir, b.policy) : null;
        const passed = verified?.pass === true;
        say(
          !applied
            ? `${step.variant} does not apply on ${snapshot.slice(0, 8)}`
            : passed
              ? `${step.variant} applied, local tests pass (${verified.ms} ms)`
              : `${step.variant} applied, local tests fail${verified.failing.length ? `: ${verified.failing.join("; ")}` : ""}`,
        );
        tried.push({ variant: step.variant, applied, passed });
        if (applied && !passed) {
          await ws.git("reset", "-q", "--hard", snapshot);
          await ws.git("clean", "-fdq");
        }
      }
      const variant = tried.at(-1).variant;
      result.variants.push(variant);

      const head = await ws.commitAll(task.intent);
      await ws.push(fork.remote, fork.token, head, true);
      const s = await api.submit(b.txn, { head, evidence: { summary: `${task.id}: applied ${variant}, local tests pass`, screenshot: task.screenshot_description } });
      let end = s;
      if (s.state === "ready" || s.state === "submitted") {
        const t = await waitWhile(api, b.txn, ["submitted", "ready", "verifying"], waitMs);
        end = { state: t.state, reason: t.reason, seq: t.landedSeq, train: t.train };
      } else if (s.state === "stale") {
        say(`stale at submit: ${s.paths.map((p) => `${p.path} <- ${p.by}`).join(", ")}`);
      }

      if (end.state === "landed") {
        say(`landed at seq ${end.seq} (train ${end.train}, attempt ${attempt}, ${variant})`);
        return { ...result, outcome: "landed", reason: null, seq: end.seq, train: end.train };
      }
      if (end.state === "needs_human") {
        say("needs a human decision; leaving it on the dashboard");
        return { ...result, outcome: "needs_human", reason: end.reason };
      }
      if (TERMINAL.has(end.state)) {
        say(`${end.state}${end.reason ? `: ${end.reason}` : ""}${end.paths?.length ? ` (${end.paths.join(", ")})` : ""}`);
        return { ...result, outcome: end.state, reason: end.reason };
      }
      if (end.state !== "stale" && end.state !== "failed") throw new Error(`unexpected state ${end.state} after submit`);

      say(`${end.state}${end.reason ? ` (${end.reason})` : ""}: retrying on the new trunk`);
      let next;
      try {
        next = await api.retry(b.txn);
      } catch (e) {
        // The transaction moved on while we were deciding (for example it was aborted for max attempts).
        if (!(e instanceof ApiError) || e.status !== 409) throw e;
        const t = (await api.txn(b.txn)).txn;
        say(`${t.state}${t.reason ? `: ${t.reason}` : ""}`);
        return { ...result, outcome: t.state, reason: t.reason };
      }
      if (next.delta.length > 0) say(`delta on ${next.delta.map((d) => d.path).join(", ")}`);
      fork = { remote: next.remote, token: next.token };
      from = { remote: next.trunk.remote, token: next.trunk.token, ref: next.snapshot };
    }
    throw new Error("gave up after 6 attempts");
  } catch (e) {
    // Do not leave a half-finished transaction holding leases and a footprint.
    await api.abort(b.txn, "agent_error").catch(() => {});
    throw e;
  } finally {
    await ws.remove();
  }
}
