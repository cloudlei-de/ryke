// `npm run e2e:swarm` (PLAN.md §13 M3 Accept): `swarm --mode scripted --agents 12 --fresh --speed 4`
// on a private stack. swarm.mjs already evaluates the M3 criteria from the op log
// (harness/lib/report.mjs evaluateCriteria); this run fails unless every one of them passed. A criterion
// the run could not evaluate (`pass: null`) fails too: the full catalogue contains what each is about.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../lib/tasks.mjs";
import { criteriaVerdict, formatCriteria, jevPlan, reportSummary, runNode } from "./lib.mjs";

const log = (line) => console.log(`e2e:swarm  ${line}`);

// G3 needs a judge: with Jev off, a recording missing or no key, begin warns about nothing and the
// criterion would have nothing to pass on. So the stack runs with live Jev, and without a key the run stops here.
const jev = jevPlan({ devVars: await readFile(join(ROOT, ".dev.vars"), "utf8").catch(() => ""), env: process.env });
if (!jev.ok) {
  console.error(`e2e:swarm  FAIL: ${jev.reason}`);
  process.exit(1);
}
const env = { ...process.env, RYKE_JEV: "live" };

const dir = await mkdtemp(join(tmpdir(), "ryke-e2e-swarm-"));
const jsonPath = join(dir, "swarm.json");
let failed = false;
try {
  const args = ["--mode", "scripted", "--agents", "12", "--fresh", "--speed", "4", "--stack", "--json", jsonPath];
  log(`npm run swarm -- ${args.slice(0, -2).join(" ")}  (RYKE_PORT_OFFSET=${process.env.RYKE_PORT_OFFSET ?? 0}, Jev live, key from ${jev.source})`);
  const { code, out } = await runNode([join(ROOT, "harness/swarm.mjs"), ...args], { env, onHeartbeat: (s, lines) => log(`running, ${s} s, ${lines} log lines`) });
  log(reportSummary(out).replace(/\n/g, "\n  "));
  assert.equal(code, 0, `swarm exited ${code}`);

  const { report } = JSON.parse(await readFile(jsonPath, "utf8"));
  log("M3 criteria");
  console.log(formatCriteria(report.criteria));
  const verdict = criteriaVerdict(report.criteria);
  assert.ok(verdict.ok, `criteria not met:\n  ${verdict.failing.join("\n  ")}`);
  log("PASS");
} catch (e) {
  failed = true;
  console.error(`e2e:swarm  FAIL: ${e.stack ?? e.message}\ne2e:swarm  the full report is kept at ${jsonPath}`);
}
// A failed run keeps its JSON: it is the only record of what the swarm did.
if (!failed) await rm(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
