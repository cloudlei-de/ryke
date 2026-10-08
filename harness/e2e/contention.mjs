// `npm run e2e:contention [-- --out file.json] [--bench-agents 50] [--bench-seconds 120]` (PLAN.md §13 M5
// Accept): "a scripted swarm with --contention on vs off shows fewer stale aborts on hot files". It has two
// legs, because one of them cannot prove the claim and the other can.
//
// Leg 1, scripted: the same swarm (same seed, same tasks) runs twice, one after the other, each on its own
// fresh stack (RYKE_PORT_OFFSET, then +10): once with `--contention off`, once with `--contention on`.
// Everything is counted from each run's op log afterwards (harness/e2e/lib.mjs contentionStats). Its
// numbers are the M5 deliverable and are printed as they are. What this leg proves is that the mechanism
// runs end to end in both modes: each swarm exits 0, each trunk is green, the op log and the swarm report
// agree on the abort counts, and with contention on leases were actually granted (lease.granted ops).
// What it cannot prove is that leases reduce hot-file stale aborts. A lease only delays a writer of a path
// that is hot and leased to another open transaction, and in the scripted catalogue no two transactions
// ever write a hot file at the same time (only t-precision and t-locale write src/format.ts, only t-search
// and t-dark write src/ui/layout.ts, the queue order keeps each pair apart, and a path only turns hot after
// its first stale aborts). Leases are granted and nobody waits, so the hot-file counts of the two swarms
// differ by timing alone: off 24 / on 25 at e080cb1, off 24 / on 28 before, a verdict that is a coin flip.
// So that difference is asserted (on < off) only when the on run really had lease waits; otherwise it is
// reported next to a caveat and not asserted.
//
// Leg 2, bench: one cell of the bench's `ryke` and one of `ryke-nolease` (Ryke with write leases off), run
// by the bench's own code (harness/bench.mjs runBench: its stack, its cell runner, its trunk check) on a
// fresh private stack at +20, Jev off, at --bench-agents agents for --bench-seconds s each. Its synthetic
// agents do write hot files concurrently, which is the situation leases are for (bench/results/ablation:
// 56 against 46 landed/min and 106 against 245 stale aborts at 50 agents over 120 s). It asserts that with
// leases there are fewer stale_read aborts on hot files AND that at least one agent waited for a lease, so
// a lower count is the leases' doing and not luck. The cells are not written to bench/results.
//
// Ryke and the swarm are not tuned for this: whatever the numbers are is the result, and they are written
// to --out before the verdict. A run where a rule fails exits 1 with them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { startStack } from "../../dev/stack.mjs";
import { parseBenchArgs, runBench, UsageError } from "../bench.mjs";
import { client } from "../lib/client.mjs";
import { ROOT } from "../lib/tasks.mjs";
import {
  benchCaveats,
  benchCellStats,
  benchVerdict,
  contentionCaveats,
  contentionStats,
  contentionVerdict,
  formatBenchComparison,
  formatComparison,
  landedPerMinute,
  reportSummary,
  runNode,
} from "./lib.mjs";

const log = (line) => console.log(`e2e:contention  ${line}`);
// Contention is about leases and stale aborts, not about the judge. With live Jev an uncertain verdict parks
// a task at needs_human in one run and not in the other, which changes what is in flight and so the numbers.
process.env.RYKE_JEV = "off";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    agents: { type: "string", default: "12" },
    speed: { type: "string", default: "4" },
    seed: { type: "string", default: "42" },
    "bench-agents": { type: "string", default: "50" },
    "bench-seconds": { type: "string", default: "120" },
  },
});
const out = values.out ?? join(tmpdir(), `ryke-contention-${Date.now()}.json`);
const base = Number(process.env.RYKE_PORT_OFFSET ?? 0);
const repo = "convert";

// The bench leg takes the bench's own defaults (seed, time factor, grace) and its argument checks, and they
// run now: a bad flag must not be found after two swarms. `ryke-nolease` goes first, the baseline, like `off`.
let benchOpts;
try {
  benchOpts = parseBenchArgs(["--agents", values["bench-agents"], "--policy", "ryke-nolease,ryke", "--duration", values["bench-seconds"], "--offset", String(base + 20)]);
  if (benchOpts.agents.length !== 1) throw new UsageError(`one agent count, got ${values["bench-agents"]}`);
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(`e2e:contention  bad --bench-agents (${values["bench-agents"]}) or --bench-seconds (${values["bench-seconds"]}): ${e.message}`);
  process.exit(2);
}

async function allOps(api) {
  const ops = [];
  for (let after = 0; ; ) {
    const page = await api.ops(repo, after, 1000);
    ops.push(...page.ops);
    if (page.ops.length < 1000) return ops;
    after = page.last;
  }
}

// One swarm on its own stack; the stack stays up until the op log has been read.
async function oneRun(mode, offset, dir) {
  const stack = await startStack({ offset, fresh: true, quiet: true });
  try {
    const jsonPath = join(dir, `${mode}.json`);
    const args = ["--mode", "scripted", "--agents", values.agents, "--fresh", "--speed", values.speed, "--repo", repo, "--seed", values.seed, "--contention", mode, "--json", jsonPath];
    log(`contention ${mode}: swarm ${args.slice(0, -2).join(" ")} on offset ${offset}`);
    const env = { ...process.env, RYKE_PORT_OFFSET: String(offset), RYKE_API_URL: stack.apiUrl, RYKE_TOKEN: stack.token };
    const { code, out: stdout } = await runNode([join(ROOT, "harness/swarm.mjs"), ...args], { env, onHeartbeat: (s, lines) => log(`contention ${mode}: running, ${s} s, ${lines} log lines`) });
    log(`contention ${mode}:\n  ${reportSummary(stdout).replace(/\n/g, "\n  ")}`);
    assert.equal(code, 0, `the contention ${mode} swarm exited ${code}`);
    const { report, startedAt, finishedAt } = JSON.parse(await readFile(jsonPath, "utf8"));
    const ops = await allOps(client(stack.apiUrl, stack.token));
    const stats = contentionStats(ops);
    // The swarm report counts the same aborts from the same log; a difference means one of the two counts is wrong.
    const reported = report.aborts.stale_read + report.aborts.text_conflict;
    assert.equal(stats.staleAborts, reported, `the ops show ${stats.staleAborts} stale aborts, the swarm report ${reported}`);
    const wallMs = finishedAt - startedAt;
    return {
      ...stats,
      wallMs,
      landedPerMinute: landedPerMinute(stats.landed, wallMs),
      trunkGreen: report.trunk?.pass === true,
      trunk: report.trunk,
      aborts: report.aborts,
      ops: ops.length,
    };
  } finally {
    await stack.close();
  }
}

// The bench's own runner decides everything about the cells (stack, seeding, agents, trunk check); this only
// picks the two out of its results. It never throws: a leg that could not run is a failure of the verdict,
// and the scripted numbers are still written. It goes last because startBenchStack sets RYKE_STATE_DIR in
// this process's environment, which the scripted stacks and their swarms would otherwise inherit.
async function benchLeg() {
  const [agents, seconds] = [benchOpts.agents[0], benchOpts.durationS];
  log(`bench: ryke-nolease then ryke, ${agents} agents, ${seconds} s each (+ up to ${benchOpts.graceS} s grace), on offset ${benchOpts.offset}`);
  try {
    const run = await runBench(benchOpts, { log: (line) => log(`bench: ${line}`) });
    const pick = (policy) => benchCellStats(run.results.cells.find((c) => c.policy === policy), run.details.find((d) => d.policy === policy));
    return { off: pick("ryke-nolease"), on: pick("ryke"), raw: { cells: run.results.cells, details: run.details }, error: null };
  } catch (e) {
    console.error(`e2e:contention  the bench leg failed: ${e.stack ?? e.message}`);
    return { off: null, on: null, raw: null, error: e.message };
  }
}

const dir = await mkdtemp(join(tmpdir(), "ryke-e2e-contention-"));
let failed = false;
try {
  const off = await oneRun("off", base, dir);
  const on = await oneRun("on", base + 10, dir);
  const bench = await benchLeg();

  const failures = [...contentionVerdict({ off, on }), ...(bench.error ? [`the bench leg did not finish: ${bench.error}`] : benchVerdict(bench))];
  const caveats = [...contentionCaveats({ off, on }), ...(bench.error ? [] : benchCaveats(bench))];
  log(`numbers (scripted, ${values.agents} agents, speed ${values.speed}, seed ${values.seed}, Jev ${process.env.RYKE_JEV}):\n${formatComparison({ off, on }).replace(/^/gm, "  ")}`);
  log(`hot files, aborts while hot: off ${JSON.stringify(off.hotByPath)}; on ${JSON.stringify(on.hotByPath)}`);
  if (!bench.error) {
    log(`numbers (bench, off = ryke-nolease, on = ryke, ${benchOpts.agents[0]} agents, ${benchOpts.durationS} s per cell, seed ${benchOpts.seed}, time factor ${benchOpts.factor}, Jev ${process.env.RYKE_JEV}):\n${formatBenchComparison(bench).replace(/^/gm, "  ")}`);
  }
  for (const c of caveats) log(`NOTE: ${c}`);
  // Written before the verdict: the numbers are the deliverable, whether or not the claim holds.
  const benchParams = { agents: benchOpts.agents[0], seconds: benchOpts.durationS, graceSeconds: benchOpts.graceS, seed: benchOpts.seed, timeFactor: benchOpts.factor, offset: benchOpts.offset, jev: process.env.RYKE_JEV, off: "ryke-nolease", on: "ryke" };
  await mkdir(dirname(out), { recursive: true });
  const record = {
    generatedAt: new Date().toISOString(),
    params: { mode: "scripted", agents: Number(values.agents), speed: Number(values.speed), seed: Number(values.seed), jev: process.env.RYKE_JEV },
    off,
    on,
    bench: { params: benchParams, off: bench.off, on: bench.on, error: bench.error, raw: bench.raw },
    failures,
    caveats,
  };
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  log(`written to ${out}`);
  assert.deepEqual(failures, [], failures.join("; "));
  const asserted = on.leaseWaits > 0 ? "asserted, leases made transactions wait" : "not asserted, no transaction waited for a lease";
  log(`scripted: ${on.leaseGrants} lease grants and ${on.leaseWaits} waits with contention on; stale aborts on hot files ${on.hotStaleAborts} on against ${off.hotStaleAborts} off (${asserted})`);
  log(`bench: stale_read aborts on hot files ${bench.on.hotStaleAborts} with leases against ${bench.off.hotStaleAborts} without, after ${bench.on.leaseWaits} lease waits; landed/min ${bench.on.landedPerMinute} against ${bench.off.landedPerMinute}`);
  log("PASS");
} catch (e) {
  failed = true;
  console.error(`e2e:contention  FAIL: ${e.stack ?? e.message}`);
}
await rm(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
