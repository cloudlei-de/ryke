// `npm run e2e:contention [-- --out file.json]` (PLAN.md §13 M5 Accept): "a scripted swarm with
// --contention on vs off shows fewer stale aborts on hot files".
//
// The same swarm (same seed, same tasks) runs twice, one after the other, each on its own fresh stack
// (RYKE_PORT_OFFSET, then +10): once with `--contention off`, once with `--contention on`. Everything
// is counted from each run's op log afterwards (harness/e2e/lib.mjs contentionStats). Ryke and the
// swarm are not tuned for this: whatever the numbers are is the result, and a run where contention
// control does not reduce hot-file stale aborts exits 1 with them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { startStack } from "../../dev/stack.mjs";
import { client } from "../lib/client.mjs";
import { ROOT } from "../lib/tasks.mjs";
import { contentionCaveats, contentionStats, contentionVerdict, formatComparison, landedPerMinute, reportSummary, runNode } from "./lib.mjs";

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
  },
});
const out = values.out ?? join(tmpdir(), `ryke-contention-${Date.now()}.json`);
const base = Number(process.env.RYKE_PORT_OFFSET ?? 0);
const repo = "convert";

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

const dir = await mkdtemp(join(tmpdir(), "ryke-e2e-contention-"));
let failed = false;
try {
  const off = await oneRun("off", base, dir);
  const on = await oneRun("on", base + 10, dir);

  const failures = contentionVerdict({ off, on });
  const caveats = contentionCaveats({ off, on });
  log(`numbers (scripted, ${values.agents} agents, speed ${values.speed}, seed ${values.seed}, Jev ${process.env.RYKE_JEV}):\n${formatComparison({ off, on }).replace(/^/gm, "  ")}`);
  log(`hot files, aborts while hot: off ${JSON.stringify(off.hotByPath)}; on ${JSON.stringify(on.hotByPath)}`);
  // Written before the verdict: the numbers are the deliverable, whether or not the claim holds.
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), params: { mode: "scripted", agents: Number(values.agents), speed: Number(values.speed), seed: Number(values.seed), jev: process.env.RYKE_JEV }, off, on, failures, caveats }, null, 2)}\n`);
  log(`written to ${out}`);
  assert.deepEqual(failures, [], failures.join("; "));
  log(`contention on: ${on.hotStaleAborts} stale aborts on hot files against ${off.hotStaleAborts} with it off`);
  for (const c of caveats) log(`NOTE: ${c}`);
  log("PASS");
} catch (e) {
  failed = true;
  console.error(`e2e:contention  FAIL: ${e.stack ?? e.message}`);
}
await rm(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
