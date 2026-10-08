#!/usr/bin/env node
// `npm run bench -- --agents 10,50,100,200 --policy lock,queue,ryke --duration 300` (PLAN.md §11.3, M7):
// synthetic agents against a fresh `convert` trunk per (policy, agents) cell, one cell after another,
// on one local stack. Writes bench/results/<date>.json, latest.json and latest.md.
import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startStack } from "../dev/stack.mjs";
import { POLICIES } from "../src/shared/bench.ts";
import { runCell } from "./bench/cell.mjs";
import { ABLATION_POLICIES, BENCH_POLICIES, buildResults } from "./bench/metrics.mjs";
import { renderMarkdown, table } from "./bench/render.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

const USAGE = `usage: bench.mjs [--agents 10,50,100,200] [--policy lock,queue,ryke] [--duration 300]
                [--time-factor 1] [--seed 7] [--offset 70] [--grace 20] [--out bench/results]
                [--caveat "text" ...] [--detail file.json]
  --policy       any of lock, queue, ryke, ryke-nolease (Ryke with write leases off, for the lease comparison).
                 A run that includes ryke-nolease writes to bench/results/ablation by default, because the
                 dashboard's results format does not know that name
  --duration     seconds of wall time per cell; only changes landed inside it count
  --time-factor  multiplies every think time (median 6 s), the same for every policy
  --offset       port offset of the private stack (store 8788, runner 8789, worker 5173 + offset)
  --caveat       an extra line for latest.md (for example why N = 200 was left out); repeatable
  --detail       also write the per-cell details (not part of the results format) to this file`;

export class UsageError extends Error {}

const list = (text, what, check) => {
  const items = String(text)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) throw new UsageError(`--${what} needs at least one value`);
  for (const i of items) if (!check(i)) throw new UsageError(`--${what}: bad value ${JSON.stringify(i)}`);
  return items;
};

export function parseBenchArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        agents: { type: "string", default: "10,50,100,200" },
        policy: { type: "string", default: POLICIES.join(",") },
        duration: { type: "string", default: "300" },
        "time-factor": { type: "string", default: "1" },
        seed: { type: "string", default: "7" },
        offset: { type: "string", default: "70" },
        grace: { type: "string", default: "20" },
        out: { type: "string" },
        caveat: { type: "string", multiple: true, default: [] },
        detail: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    throw new UsageError(e.message);
  }
  const num = (name, v, ok, hint) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !ok(n)) throw new UsageError(`--${name} must be ${hint}, got ${v}`);
    return n;
  };
  const policies = list(values.policy, "policy", (s) => BENCH_POLICIES.includes(s));
  // The dashboard file must only ever hold policies the dashboard knows, so a run with an ablation goes elsewhere.
  const out = values.out ?? join(ROOT, "bench/results", policies.some((p) => ABLATION_POLICIES.includes(p)) ? "ablation" : "");
  return {
    agents: list(values.agents, "agents", (s) => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 1000).map(Number),
    policies,
    durationS: num("duration", values.duration, (n) => n >= 5, "a number of seconds of at least 5"),
    factor: num("time-factor", values["time-factor"], (n) => n > 0, "greater than 0"),
    seed: num("seed", values.seed, Number.isInteger, "an integer"),
    offset: num("offset", values.offset, (n) => Number.isInteger(n) && n >= 0, "a non-negative integer"),
    graceS: num("grace", values.grace, (n) => n >= 0, "0 or more seconds"),
    out: resolve(out),
    caveats: values.caveat,
    detail: values.detail ? resolve(values.detail) : null,
    help: values.help,
  };
}

// Jev off for every cell: no cell waits on the network and all three policies share one gate, the tests.
// The state dir lives outside the repo: `vite dev` watches its root, and every fork the bench creates is a
// directory tree full of git objects. Inside the root that exhausts the machine's inotify watches
// ("ENOSPC: System limit for number of file watchers reached") and makes the dev server spend its CPU
// on file events instead of on the Worker.
export function startBenchStack(offset) {
  process.env.RYKE_JEV = "off";
  process.env.RYKE_STATE_DIR = join(tmpdir(), `ryke-bench-state-${offset}`);
  return startStack({ offset, fresh: true, quiet: true });
}

export function noteFor({ factor, seed }) {
  return `Synthetic agents: real git, real merges, real tests, scripted edits. Time factor ${factor} (median think ${+(factor * 6).toFixed(2)} s), seed ${seed}, ${availableParallelism()}-vCPU VM, Jev off (the tests are the only gate for every policy).`;
}

const STATIC_CAVEATS = [
  "The agents are synthetic: they do not read or reason, they apply scripted edits after a random think time. The platform, git, the merges and the tests are real.",
  "`src/registry.ts` carries no numeric constant (the protected units test and `src/index.ts` read every export of it as a category), so only `src/format.ts` and `src/ui/layout.ts` can be semantically incompatible. The registry is still the third hottest file by reads and writes; on Ryke it is a union path and never aborts anything.",
  "The lock and queue policies run the same lander jobs as Ryke (`land.sh prepare`, `verify.sh`, `land.sh push`) with a train of one; they enforce no read tracking and no protected paths. Both baselines retry up to the same three attempts as Ryke.",
  "Agents, store, runner and worker share one machine, so absolute numbers depend on its load; compare policies within one run, not across runs.",
];

// Facts about a run that a reader needs before trusting its numbers.
export function caveatsFor(details, extra = []) {
  const out = [...STATIC_CAVEATS, ...extra];
  if (details.some((d) => ABLATION_POLICIES.includes(d.policy))) {
    out.push("`ryke-nolease` is Ryke with write leases off: identical agents and refresh on a stale warning, but they never call intend-write. The dashboard's results format only knows lock, queue and ryke, so this run is not written to bench/results/latest.json.");
  }
  const cpus = availableParallelism();
  for (const d of details) {
    const where = `${d.policy} x ${d.agents}`;
    if (d.errors > 0) out.push(`${where}: ${d.errors} agent error(s), for example: ${d.errorSamples[0]}`);
    if (d.loopLagMs.p99 > 250) out.push(`${where}: the bench process's event loop lagged (p99 ${d.loopLagMs.p99} ms, max ${d.loopLagMs.max} ms), so agents were partly starved by the machine rather than by the policy.`);
    if (d.loadAverage1m > cpus * 1.5) out.push(`${where}: load average ${d.loadAverage1m} on ${cpus} vCPUs at the end of the cell; the machine was oversubscribed.`);
    if (d.ledger && !d.ledger.quiet) out.push(`${where}: the lander was still busy 90 s after the cell; the trunk check ran on a trunk that was still moving.`);
  }
  return out;
}

// `run` is the cell runner and `start` starts the stack; tests swap both for fakes.
export async function runBench(opts, { log = console.log, stack = null, run = runCell, start = startBenchStack } = {}) {
  const own = stack === null;
  const live = stack ?? (await start(opts.offset));
  // Ctrl-C must not leave the store, runner and worker running.
  const stop = async () => {
    await live.close();
    process.exit(130);
  };
  if (own) for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, stop);
  const cells = [];
  const details = [];
  const total = opts.agents.length * opts.policies.length;
  const startedAt = Date.now();
  try {
    log(`bench: ${total} cells of ${opts.durationS} s (+ up to ${opts.graceS} s grace), time factor ${opts.factor}, seed ${opts.seed}, stack on offset ${opts.offset}`);
    let n = 0;
    for (const agents of opts.agents) {
      for (const policy of opts.policies) {
        n++;
        log(`[${n}/${total}] ${policy} x ${agents} agents`);
        const { cell, detail } = await run({ policy, agents, durationS: opts.durationS, factor: opts.factor, seed: opts.seed, stack: live, graceS: opts.graceS, log });
        cells.push(cell);
        details.push({ policy, agents, ...detail });
        log(
          `  -> landed ${cell.landed} (${cell.landedPerMinute}/min), p50 ${cell.p50} s, p95 ${cell.p95} s, verify runs/landed ${cell.verifyRunsPerLanded}, wasted ${cell.wastedAgentSeconds} agent-s, ` +
            `aborts ${JSON.stringify(cell.aborts)}, incompatible pairs ${(detail.incompatibility.rate * 100).toFixed(1)} %, trunk checks ${detail.checkedCommits} commits, breakages ${cell.trunkBreakages}`,
        );
        await writeFile(join(live.stateDir, "bench-partial.json"), `${JSON.stringify({ cells, details }, null, 1)}\n`);
        // A broken trunk or a trunk the Ledger does not agree with is a platform bug: stop loudly, publish nothing.
        if (cell.trunkBreakages !== 0 || detail.problems.length > 0) {
          const why = [...detail.failedChecks.map((c) => `${c.sha.slice(0, 8)}: ${c.failing.join("; ") || c.tail}`), ...detail.problems];
          throw new Error(`TRUNK BREAKAGE in ${policy} x ${agents}: ${cell.trunkBreakages} commit(s) failed the verify command.\n  ${why.join("\n  ")}`);
        }
      }
    }
  } finally {
    if (own) await live.close();
  }
  const results = buildResults({ cells, durationSeconds: opts.durationS, note: noteFor(opts) });
  const markdown = renderMarkdown({ results, details, meta: { caveats: caveatsFor(details, opts.caveats) } });
  return { results, details, markdown, wallSeconds: Math.round((Date.now() - startedAt) / 1000) };
}

export async function writeResults(out, { results, markdown, details }, detailPath = null) {
  await mkdir(out, { recursive: true });
  const json = `${JSON.stringify(results, null, 2)}\n`;
  const day = (results.generatedAt ?? new Date().toISOString()).slice(0, 10);
  const files = [join(out, `${day}.json`), join(out, "latest.json"), join(out, "latest.md")];
  await writeFile(files[0], json);
  await writeFile(files[1], json);
  await writeFile(files[2], markdown);
  if (detailPath) {
    await mkdir(dirname(detailPath), { recursive: true });
    await writeFile(detailPath, `${JSON.stringify({ results, details }, null, 1)}\n`);
    files.push(detailPath);
  }
  return files;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseBenchArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const run = await runBench(opts);
    const files = await writeResults(opts.out, run, opts.detail);
    console.log(`\n${table(["policy", "agents", "landed", "landed/min", "p50 s", "p95 s", "verify/landed", "wasted s", "breakages"], run.results.cells.map((c) => [c.policy, c.agents, c.landed, c.landedPerMinute, c.p50, c.p95, c.verifyRunsPerLanded, c.wastedAgentSeconds, c.trunkBreakages]))}`);
    console.log(`\nbench finished in ${run.wallSeconds} s; wrote\n  ${files.join("\n  ")}`);
    return 0;
  } catch (e) {
    console.error(`bench failed: ${e.stack ?? e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
