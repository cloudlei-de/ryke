// `npm run e2e:claude` (PLAN.md §13 M8 Accept): `swarm --mode claude --agents 3 --stub` lands its tasks.
// The stub plays Claude Code from recorded patches, so no API key is needed, but everything else is
// real: the runner job, the three hooks, the Ledger, leases, landing and the retry prompts.
//
// `npm run e2e:codex` (`claude.mjs codex`) is the same run with Codex's stub on the subscription path:
// the swarm checks `codex login status` before any task begins, no key reaches a job, and the reads come
// from Codex's event stream instead of hooks. Codex never waits for a lease, so nothing holds the
// categories back while t-precision lands, as Claude's lease wait on CHANGELOG.md does, and the two
// stubs finish in milliseconds: the categories would land first, and t-precision's patch, written for
// the trunk before them, would then fail their tests on every attempt. The run therefore parks the other
// tasks at the stub's gate until t-precision has landed; from there the categories meet the moved trunk
// through the reads Ryke took from their `cat`s, fail verification once on it and land on the retry.
//
// The task list is fixed. t-precision rewrites format.ts, which every category reads, so the categories
// that run next to it end in a stale abort or a failed verify and need a second attempt (that is the
// point of the run). kelvin-remove and dup-speed are left out: each aborts with agent_error when the
// task it competes with lands first (test/node/claude-mode.test.mjs), so whether they land depends on
// timing. tamper-routes is in because it is designed to be rejected as protected.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalogue, ROOT, selectTasks } from "../lib/tasks.mjs";
import { claudeVerdict, reportSummary, runNode } from "./lib.mjs";

const MODE = process.argv[2] ?? "claude";
if (!["claude", "codex"].includes(MODE)) throw new Error(`usage: claude.mjs [claude|codex], got ${MODE}`);
const log = (line) => console.log(`e2e:${MODE}  ${line}`);
// The evidence gate's judgement calls have their own tests; a live verdict that comes back uncertain parks
// a task at needs_human, which says nothing about the agent path this run checks. Same as e2e:land and the claude-mode suite.
const TASKS = ["t-precision", "cat-area", "cat-volume", "cat-pressure", "cat-energy", "cat-power", "kelvin-first", "tamper-routes"];
const UNGATED = ["t-precision", "tamper-routes"];

const dir = await mkdtemp(join(tmpdir(), `ryke-e2e-${MODE}-`));
const jsonPath = join(dir, "swarm.json");
const gates = MODE === "codex" ? join(dir, "gates") : null;
const env = { ...process.env, RYKE_JEV: "off", ...(gates ? { RYKE_STUB_GATE_DIR: gates } : {}) };
let failed = false;
let running = true;

// Opens every gate once the trunk has its first landing, which is t-precision's: the only other task
// that may pass, tamper-routes, is rejected and lands nothing.
async function openGatesAfterFirstLanding() {
  const api = `http://127.0.0.1:${5173 + Number(process.env.RYKE_PORT_OFFSET ?? 0)}/api/repos/convert`;
  while (running) {
    const seq = await fetch(api, { headers: { authorization: `Bearer ${process.env.RYKE_TOKEN ?? "dev"}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s?.seq ?? 0)
      .catch(() => 0);
    if (seq >= 1) {
      for (const id of TASKS) await writeFile(join(gates, `${id}.go`), "");
      log(`trunk has its first landing (seq ${seq}); the gates are open`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

try {
  if (gates) {
    await mkdir(gates);
    for (const id of UNGATED) await writeFile(join(gates, `${id}.go`), "");
  }
  const selected = selectTasks((await loadCatalogue("convert")).tasks, TASKS);
  const auth = MODE === "codex" ? ["--auth", "subscription"] : [];
  const args = ["--mode", MODE, ...auth, "--agents", "3", "--stub", "--stack", "--fresh", "--tasks", TASKS.join(","), "--json", jsonPath];
  log(`npm run swarm -- ${args.slice(0, -2).join(" ")}  (RYKE_PORT_OFFSET=${process.env.RYKE_PORT_OFFSET ?? 0}, Jev off)`);
  const opening = gates ? openGatesAfterFirstLanding() : null;
  const { code, out } = await runNode([join(ROOT, "harness/swarm.mjs"), ...args], { env, onHeartbeat: (s, lines) => log(`running, ${s} s, ${lines} log lines`) });
  running = false;
  await opening;
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
  console.error(`e2e:${MODE}  FAIL: ${e.stack ?? e.message}\ne2e:${MODE}  the full report is kept at ${jsonPath}`);
}
if (!failed) await rm(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
