// `npm run e2e:claude` (PLAN.md §13 M8 Accept): `swarm --mode claude --agents 3 --stub` lands its tasks.
// The stub plays Claude Code from recorded patches, so no API key is needed, but everything else is
// real: the runner job, the three hooks, the Ledger, leases, landing and the retry prompts.
//
// The task list is fixed. t-precision rewrites format.ts, which every category reads, so the categories
// that run next to it end in a stale abort or a failed verify and need a second attempt (that is the
// point of the run). kelvin-remove and dup-speed are left out: each aborts with agent_error when the
// task it competes with lands first (test/node/claude-mode.test.mjs), so whether they land depends on
// timing. tamper-routes is in because it is designed to be rejected as protected.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalogue, ROOT, selectTasks } from "../lib/tasks.mjs";
import { claudeVerdict, reportSummary, runNode } from "./lib.mjs";

const log = (line) => console.log(`e2e:claude  ${line}`);
// The evidence gate's judgement calls have their own tests; a live verdict that comes back uncertain parks
// a task at needs_human, which says nothing about the agent path this run checks. Same as e2e:land and the claude-mode suite.
const env = { ...process.env, RYKE_JEV: "off" };
const TASKS = ["t-precision", "cat-area", "cat-volume", "cat-pressure", "cat-energy", "cat-power", "kelvin-first", "tamper-routes"];

const dir = await mkdtemp(join(tmpdir(), "ryke-e2e-claude-"));
const jsonPath = join(dir, "swarm.json");
let failed = false;
try {
  const selected = selectTasks((await loadCatalogue("convert")).tasks, TASKS);
  const args = ["--mode", "claude", "--agents", "3", "--stub", "--stack", "--fresh", "--tasks", TASKS.join(","), "--json", jsonPath];
  log(`npm run swarm -- ${args.slice(0, -2).join(" ")}  (RYKE_PORT_OFFSET=${process.env.RYKE_PORT_OFFSET ?? 0}, Jev off)`);
  const { code, out } = await runNode([join(ROOT, "harness/swarm.mjs"), ...args], { env, onHeartbeat: (s, lines) => log(`running, ${s} s, ${lines} log lines`) });
  log(reportSummary(out).replace(/\n/g, "\n  "));
  assert.equal(code, 0, `swarm exited ${code}`);

  const { report, results } = JSON.parse(await readFile(jsonPath, "utf8"));
  log("tasks");
  for (const t of selected) {
    const r = results.find((x) => x.task === t.id);
    console.log(`  ${t.id.padEnd(14)} ${r ? `${r.outcome}${r.reason ? ` (${r.reason})` : ""}, ${r.attempts} attempt${r.attempts === 1 ? "" : "s"}` : "no result"}`);
  }
  const failures = claudeVerdict({ tasks: selected, results, report });
  assert.deepEqual(failures, [], failures.join("\n  "));
  log(`trunk ${report.trunk.head?.slice(0, 8)}: ${report.trunk.tests ?? "?"} tests pass; ${report.aborts.stale_read} stale aborts, ${report.aborts.failed_verify} failed verifies, all retried to a landing`);
  log("PASS");
} catch (e) {
  failed = true;
  console.error(`e2e:claude  FAIL: ${e.stack ?? e.message}\ne2e:claude  the full report is kept at ${jsonPath}`);
}
if (!failed) await rm(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
