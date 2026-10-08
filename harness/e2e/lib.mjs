// The pure parts of the `npm run e2e:*` scripts, kept apart so they can be unit tested
// (test/node/e2e-lib.test.mjs) without a stack: hot-file stale counting, the contention verdicts for
// the scripted and the bench leg, criteria aggregation, the production config assertions and the curl
// transcript redaction.
import { spawn } from "node:child_process";
import { bump, decayed, isHot } from "../../src/worker/ledger/heat.ts";
import { HOT_FILES, isPin } from "../bench/workload.mjs";

// ---------------------------------------------------------------------------------------------
// Running the swarm as a child process (e2e:swarm, e2e:contention, e2e:claude)
// ---------------------------------------------------------------------------------------------

// Runs `node <args>` to completion and returns its exit code and stdout. The swarm logs one line per
// agent step, so the output is kept for the report instead of echoed; stderr (stack warnings, the
// swarm's own failure message) still goes straight to the terminal. A run takes minutes, hence the
// heartbeat, and a signal to this process is passed on so the child can stop its stack.
export async function runNode(args, { env = process.env, heartbeatMs = 60_000, onHeartbeat } = {}) {
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  const started = Date.now();
  const timer = onHeartbeat ? setInterval(() => onHeartbeat(Math.round((Date.now() - started) / 1000), out.split("\n").length - 1), heartbeatMs) : null;
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // A child killed by a signal has no exit code; 128 keeps it from reading as success.
  const code = await new Promise((resolve) => child.once("exit", (c, signal) => resolve(c ?? (signal ? 128 : 1))));
  if (timer) clearInterval(timer);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  return { code, out };
}

// The part of the swarm's stdout worth printing: the report, without the M3 criteria block (the e2e
// scripts print their own verdict) and without the trailer. When there is no report the run died
// early, and the last lines say why.
export function reportSummary(out) {
  const start = out.lastIndexOf("Swarm report:");
  if (start < 0) return out.trimEnd().split("\n").slice(-15).join("\n");
  const rest = out.slice(start);
  const cuts = ["\nM3 criteria", "\nreport written to"].map((m) => rest.indexOf(m)).filter((i) => i >= 0);
  return (cuts.length ? rest.slice(0, Math.min(...cuts)) : rest).trimEnd();
}

// ---------------------------------------------------------------------------------------------
// Contention (M5 Accept): stale aborts on hot files, with and without leases
// ---------------------------------------------------------------------------------------------

// Every ledger path that ends an attempt as stale, whether it was recorded as `txn.stale` or, for the
// third attempt, as `txn.aborted` whose `cause` says it was stale. Both bump heat in the Ledger.
// Returns null for any other op.
export function stalePaths(op) {
  const stale = op.kind === "txn.stale" || (op.kind === "txn.aborted" && op.data?.cause?.state === "stale");
  if (!stale) return null;
  const raw = Array.isArray(op.data?.paths) ? op.data.paths : [];
  // Stale entries are {path, seq, by}, text conflicts {path}; a plain string is accepted too.
  const named = raw.map((p) => (typeof p === "string" ? p : p?.path)).filter((p) => typeof p === "string" && p !== "");
  return [...new Set(named)];
}

// Replays the Ledger's heat from the stale aborts themselves (heat.ts: +1 per abort that lists the
// path, halved every 5 minutes, hot at >= 2) instead of reading `heat.changed` ops, which are throttled
// to one per second and per path and so can lag the abort they describe.
//
// An abort is "on a hot file" when one of its paths was already hot *before this abort's own bump*:
// the file had been aborting repeatedly and recently, which is exactly the situation an admission
// lease exists for. `hotStaleAbortsInclusive` also counts the abort that makes a path hot, which no
// lease could have prevented; it is reported next to the headline number, never instead of it.
export function contentionStats(ops) {
  const sorted = [...ops].sort((a, b) => a.seq - b.seq);
  const heat = new Map();
  const hotByPath = {};
  const waiting = new Set();
  const landed = new Set();
  let staleAborts = 0;
  let hotStaleAborts = 0;
  let hotStaleAbortsInclusive = 0;
  let leaseWaitOps = 0;
  let leaseGrants = 0;
  for (const op of sorted) {
    if (op.kind === "lease.granted") {
      leaseGrants++;
      continue;
    }
    if (op.kind === "lease.waiting") {
      leaseWaitOps++;
      if (op.txn) waiting.add(op.txn);
      continue;
    }
    if (op.kind === "txn.landed") {
      if (op.txn) landed.add(op.txn);
      continue;
    }
    const paths = stalePaths(op);
    if (!paths) continue;
    staleAborts++;
    let hot = false;
    let hotAfter = false;
    for (const path of paths) {
      const prev = heat.get(path);
      const before = prev ? decayed(prev.value, prev.at, op.at) : 0;
      const next = bump(prev, op.at);
      heat.set(path, next);
      if (isHot(before)) {
        hot = true;
        hotByPath[path] = (hotByPath[path] ?? 0) + 1;
      }
      if (isHot(next.value)) hotAfter = true;
    }
    if (hot) hotStaleAborts++;
    if (hotAfter) hotStaleAbortsInclusive++;
  }
  return { staleAborts, hotStaleAborts, hotStaleAbortsInclusive, hotByPath, leaseGrants, leaseWaitOps, leaseWaits: waiting.size, landed: landed.size };
}

// Floor of one second, like harness/lib/report.mjs, so an instant run does not report an infinite rate.
export function landedPerMinute(landed, wallMs) {
  return landed / (Math.max(wallMs, 1000) / 60_000);
}

// Failures of the scripted leg, as strings; none means it holds. A run whose trunk is red proves nothing
// about contention, so that is checked first and reported on its own.
//
// What is asserted depends on whether leases ever made anyone wait. A lease only delays a writer of a path
// that is hot and leased to another open transaction, and the scripted catalogue never has two of those at
// once (a path only turns hot after its first stale aborts, and the queue order keeps the writers of
// src/format.ts and of src/ui/layout.ts apart). So in that run the hot-file counts of the two swarms differ
// by timing alone, and asserting on them made the verdict a coin flip (off 24 / on 25 at e080cb1, off 24 /
// on 28 before). What must hold in every case is that the mechanism ran: leases were granted. Only a run in
// which leases did make someone wait can credit them with a difference, and then the claim is asserted as
// M5 states it.
export function contentionVerdict({ off, on }) {
  const failures = [];
  for (const [name, run] of [["off", off], ["on", on]]) {
    if (run.trunkGreen !== true) failures.push(`the trunk of the contention ${name} run is not green`);
  }
  if (!(on.leaseGrants > 0)) failures.push("contention on granted no leases (0 lease.granted ops), so the lease mechanism was not exercised");
  if (!Number.isFinite(on.leaseWaits)) {
    failures.push("contention on has no lease wait count, so it is unknown whether leases made anyone wait");
  } else if (on.leaseWaits > 0) {
    if (!Number.isFinite(off.hotStaleAborts) || !Number.isFinite(on.hotStaleAborts)) {
      failures.push(`contention on made transactions wait, so hot-file stale aborts are compared, but a count is missing: off ${off.hotStaleAborts}, on ${on.hotStaleAborts}`);
    } else if (on.hotStaleAborts >= off.hotStaleAborts) {
      failures.push(`contention on did not reduce stale aborts on hot files: off ${off.hotStaleAborts}, on ${on.hotStaleAborts}`);
    }
  }
  return failures;
}

// Things that do not fail the run but that a reader of the numbers must not miss.
export function contentionCaveats({ off, on }) {
  const caveats = [];
  if (on.leaseWaits === 0) {
    caveats.push(`contention on never made a transaction wait for a lease (${on.leaseGrants ?? 0} grants, 0 waits), so leases changed nothing in this run: the hot-file difference between the runs is reported, not asserted, and the lease effect is the bench leg's`);
  }
  if (off.leaseGrants > 0 || off.leaseWaits > 0) {
    caveats.push(`contention off still recorded ${off.leaseGrants} lease grants and ${off.leaseWaits} waits`);
  }
  return caveats;
}

const duration = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

// Two columns after a label, the baseline first. The columns are as wide as their widest value (at least
// 10), so a long policy name does not push the numbers out of line.
function sideBySide(labels, rows) {
  const width = Math.max(...rows.map((r) => r[0].length));
  const column = Math.max(10, ...rows.flatMap((r) => [String(r[1]).length, String(r[2]).length]).map((n) => n + 2), ...labels.map((l) => l.length + 2));
  const pad = (v) => String(v).padStart(column);
  return [`${"".padEnd(width)}${labels.map(pad).join("")}`, ...rows.map(([label, a, b]) => `${label.padEnd(width)}${pad(a)}${pad(b)}`)].join("\n");
}

// Side by side, off first because it is the baseline.
export function formatComparison({ off, on }) {
  return sideBySide(["off", "on"], [
    ["stale aborts, all", off.staleAborts, on.staleAborts],
    ["stale aborts on hot files", off.hotStaleAborts, on.hotStaleAborts],
    ["  (incl. the abort that made the file hot)", off.hotStaleAbortsInclusive, on.hotStaleAbortsInclusive],
    ["lease grants (ops)", off.leaseGrants, on.leaseGrants],
    ["lease waits (distinct txns)", off.leaseWaits, on.leaseWaits],
    ["landed", off.landed, on.landed],
    ["wall time", duration(off.wallMs), duration(on.wallMs)],
    ["landed/min", off.landedPerMinute.toFixed(1), on.landedPerMinute.toFixed(1)],
    ["trunk green", off.trunkGreen ? "yes" : "NO", on.trunkGreen ? "yes" : "NO"],
  ]);
}

// ---------------------------------------------------------------------------------------------
// Contention, bench leg: `ryke` against `ryke-nolease` on the bench workload, where agents do contend
// ---------------------------------------------------------------------------------------------

// "Hot" the way the bench workload defines it (harness/bench/workload.mjs): the three files its Zipf draw
// reads and writes most, and the pins, which whoever changes one of those constants rewrites and which
// therefore heat and get leased with it. The cell's details do not say which paths the Ledger had heated
// when an abort happened (that needs the op log, which the cell does not keep), so the set is fixed by the
// workload and the same for both policies.
export const isBenchHotPath = (path) => HOT_FILES.includes(path) || isPin(path);

const count = (v) => (Number.isFinite(v) ? v : null);
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The numbers of one bench cell the verdict and the report need, from the results cell and the details
// entry runBench returns for it (harness/bench.mjs). Anything the cell does not carry is null, never 0: a
// missing count must not read as "no aborts".
//
// `hotStaleAborts` sums, over the hot paths, how many stale_read aborts listed each path (details.ryke.
// stalePaths), so an abort that lists two hot files counts twice; it does so for both policies alike.
// `staleAborts` is the cell's own stale_read count, the one the bench table prints.
export function benchCellStats(cell, detail) {
  const paths = detail?.ryke?.stalePaths;
  return {
    policy: typeof cell?.policy === "string" ? cell.policy : null,
    agents: count(cell?.agents),
    landed: count(cell?.landed),
    landedPerMinute: count(cell?.landedPerMinute),
    staleAborts: isMap(cell?.aborts) ? count(cell.aborts.stale_read ?? 0) : null,
    hotStaleAborts: isMap(paths) ? Object.entries(paths).reduce((n, [path, hits]) => n + (isBenchHotPath(path) && Number.isFinite(hits) ? hits : 0), 0) : null,
    leaseWaits: count(detail?.leaseWaits),
    leaseWaitSeconds: count(detail?.leaseWaitSeconds),
    trunkBreakages: count(cell?.trunkBreakages),
    errors: count(detail?.errors),
  };
}

const BENCH_NAME = { off: "ryke-nolease", on: "ryke" };
const BENCH_REQUIRED = [
  ["landedPerMinute", "landed/min"],
  ["staleAborts", "stale_read aborts"],
  ["hotStaleAborts", "stale_read aborts on hot files"],
  ["leaseWaits", "lease waits"],
];

// Failures of the bench leg, as strings. `off` is the cell without leases, `on` the one with. The claim: with
// leases there are fewer stale_read aborts on hot files, and leases did get used (at least one agent waited
// for one), otherwise a lower count would be luck and not their doing. A cell that is missing or lacks a
// number fails by name before anything is compared; a trunk that broke never gets here, runBench throws.
export function benchVerdict({ off, on }) {
  const failures = [];
  for (const side of ["off", "on"]) {
    const run = { off, on }[side];
    if (!run) {
      failures.push(`the bench ${BENCH_NAME[side]} cell has no result`);
      continue;
    }
    for (const [field, what] of BENCH_REQUIRED) {
      if (!Number.isFinite(run[field])) failures.push(`the bench ${BENCH_NAME[side]} cell has no ${what}`);
    }
  }
  if (failures.length > 0) return failures;
  if (on.leaseWaits < 1) failures.push(`the bench ryke cell never made an agent wait for a lease (${on.leaseWaits} lease waits), so it shows nothing about leases`);
  if (!(on.hotStaleAborts < off.hotStaleAborts)) {
    failures.push(`in the bench, leases did not reduce stale_read aborts on hot files: ryke-nolease ${off.hotStaleAborts}, ryke ${on.hotStaleAborts}`);
  }
  return failures;
}

// Things that do not fail the leg but change what its numbers mean.
export function benchCaveats({ off, on }) {
  const caveats = [];
  if (off?.leaseWaits > 0) {
    caveats.push(`the bench ryke-nolease cell recorded ${off.leaseWaits} lease waits, so the ablation did not take effect and the comparison is not leases against none`);
  }
  for (const side of ["off", "on"]) {
    const run = { off, on }[side];
    if (run?.errors > 0) caveats.push(`the bench ${BENCH_NAME[side]} cell had ${run.errors} agent error(s), so what it measured is partly the errors`);
  }
  return caveats;
}

// A number the cell does not carry is a dash, not "NaN" or "undefined".
const shown = (v, f = String) => (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "-" : f(v));

export function formatBenchComparison({ off, on }) {
  const both = (key, f) => [shown(off?.[key], f), shown(on?.[key], f)];
  return sideBySide(["off", "on"], [
    ["policy", ...both("policy")],
    ["agents", ...both("agents")],
    ["landed", ...both("landed")],
    ["landed/min", ...both("landedPerMinute", (v) => v.toFixed(1))],
    ["stale_read aborts, all", ...both("staleAborts")],
    ["stale_read aborts on hot files", ...both("hotStaleAborts")],
    ["lease waits (agents)", ...both("leaseWaits")],
    ["lease wait time (s)", ...both("leaseWaitSeconds")],
    ["trunk breakages", ...both("trunkBreakages")],
  ]);
}

// ---------------------------------------------------------------------------------------------
// The swarm's criteria (M3 Accept) and the claude run's outcomes (M8 Accept)
// ---------------------------------------------------------------------------------------------

// The criteria harness/lib/report.mjs evaluates. A report that stopped evaluating one of them must not pass silently.
export const M3_CRITERIA = ["landed", "g3", "g5", "precision", "trunk", "preview"];

// A full-catalogue run contains everything a criterion is about, so `pass: null` (not evaluated) fails like `false`.
export function criteriaVerdict(criteria, required = M3_CRITERIA) {
  if (!Array.isArray(criteria) || criteria.length === 0) return { ok: false, failing: ["the report has no criteria"] };
  const failing = criteria.filter((c) => c.pass !== true).map((c) => `${c.id}: ${c.pass === null ? "not evaluated" : "failed"} (${c.detail})`);
  for (const id of required) if (!criteria.some((c) => c.id === id)) failing.push(`${id}: missing from the report`);
  return { ok: failing.length === 0, failing };
}

const label = (pass) => (pass === true ? "PASS" : pass === false ? "FAIL" : "n/a ");
export function formatCriteria(criteria) {
  const width = Math.max(0, ...criteria.map((c) => c.id.length));
  return criteria.map((c) => `  [${label(c.pass)}] ${c.id.padEnd(width)}  ${c.text}: ${c.detail}`).join("\n");
}

// What `--stub` claude mode must produce for the tasks it was given: everything lands, except a task
// the catalogue marks as designed to be rejected, which must be rejected for that reason. At least one
// landed task has to have needed a second attempt, or the retry path (stale delta, failing tests fed
// back to the agent) was not exercised and the run proves less than M8 claims.
export function claudeVerdict({ tasks, results, report }) {
  const failures = [];
  const byTask = new Map(results.map((r) => [r.task, r]));
  for (const t of tasks) {
    const r = byTask.get(t.id);
    if (!r) {
      failures.push(`${t.id}: no result`);
      continue;
    }
    const got = `${r.outcome}${r.reason ? ` (${r.reason})` : ""}`;
    if (t.expect === "reject_protected") {
      if (r.outcome !== "rejected" || r.reason !== "protected") failures.push(`${t.id}: ${got}, expected rejected (protected)`);
    } else if (r.outcome !== "landed") {
      failures.push(`${t.id}: ${got}, expected landed`);
    }
  }
  if (!results.some((r) => r.outcome === "landed" && r.attempts > 1)) failures.push("no landed task needed a second attempt, so no retry was exercised");
  if (report?.trunk?.pass !== true) failures.push(`final trunk tests did not pass: ${report?.trunk?.failing?.join("; ") || report?.trunk?.error || "not checked"}`);
  return failures;
}

// ---------------------------------------------------------------------------------------------
// The production build (M9 Accept): what the emitted dist/ryke/wrangler.json must say
// ---------------------------------------------------------------------------------------------

export const REQUIRED_BINDINGS = ["LEDGER", "RUNNER", "LAND", "INGEST", "LOADER", "ARTIFACTS"];
// Secrets are set with `wrangler secret put`; one of them showing up as a var would ship it in the config.
export const SECRET_NAMES = ["RYKE_TOKEN", "RYKE_INTERNAL_SECRET", "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY"];
const EXPECTED_VARS = { RYKE_STORE: "artifacts", RYKE_RUNNER: "container", RYKE_JEV: "live" };
const LOCAL_ADDRESS = /127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0/i;

// Durable Objects name their binding `name`, everything else `binding`.
export function bindingNames(cfg) {
  const names = new Set();
  for (const b of cfg?.durable_objects?.bindings ?? []) if (typeof b?.name === "string") names.add(b.name);
  for (const value of Object.values(cfg ?? {})) {
    if (!Array.isArray(value)) continue;
    for (const item of value) if (typeof item?.binding === "string") names.add(item.binding);
  }
  return names;
}

const present = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v));

// `devSecrets` are the values from .dev.vars: none of them may appear anywhere in the config, under any
// var name. Values under 8 characters ("dev") would match unrelated text and are not looked for.
export function checkProductionConfig(cfg, { devSecrets = [] } = {}) {
  const failures = [];
  const vars = cfg?.vars ?? {};
  for (const [name, want] of Object.entries(EXPECTED_VARS)) {
    if (vars[name] !== want) failures.push(`vars.${name} is ${JSON.stringify(vars[name])}, expected ${JSON.stringify(want)}`);
  }
  for (const name of SECRET_NAMES) if (name in vars) failures.push(`vars contains the secret ${name}; it belongs in \`wrangler secret put\``);
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === "string" && LOCAL_ADDRESS.test(value)) failures.push(`vars.${name} points at a local address: ${value}`);
  }
  const have = bindingNames(cfg);
  for (const name of REQUIRED_BINDINGS) if (!have.has(name)) failures.push(`binding ${name} is missing`);
  if (!present(cfg?.containers)) failures.push("containers is missing or empty");
  if (!present(cfg?.triggers?.events)) failures.push("triggers.events is missing or empty");
  if (!present(cfg?.routes)) failures.push("routes is missing or empty");
  const text = JSON.stringify(cfg ?? {});
  for (const secret of devSecrets) {
    if (typeof secret === "string" && secret.length >= 8 && text.includes(secret)) failures.push("the config contains a value from .dev.vars");
  }
  return failures;
}

// The KEY=value lines of a .dev.vars file, optionally `export`ed and quoted. Comments, blank lines and
// empty values are not entries.
export function parseDevVarEntries(text) {
  return text
    .split("\n")
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line))
    .filter(Boolean)
    .map(([, key, value]) => [key, value.replace(/^(["'])(.*)\1$/, "$2")])
    .filter(([, value]) => value !== "");
}

export const parseDevVars = (text) => parseDevVarEntries(text).map(([, value]) => value);

// e2e:swarm asserts "G3 duplicates rejected or warned", and since a3dd095 begin only warns on what the
// judge actually answered. Without a key there is no judge, so the criterion cannot be judged at all and
// the run must say that instead of reaching a verdict. The key counts if it is in .dev.vars (what the
// local Worker loads) or in the environment.
export function jevPlan({ devVars = "", env = {} } = {}) {
  const fromFile = new Map(parseDevVarEntries(devVars)).get("TYPESAFE_API_KEY");
  if (!fromFile && !env.TYPESAFE_API_KEY) {
    return { ok: false, reason: "G3 not judged (no Jev key): TYPESAFE_API_KEY is in neither .dev.vars nor the environment, so there is no judge to call a duplicate" };
  }
  return { ok: true, mode: "live", source: fromFile ? ".dev.vars" : "the environment" };
}

// ---------------------------------------------------------------------------------------------
// The curl walkthrough (M1 Accept): a transcript that can be pasted into PROGRESS.md
// ---------------------------------------------------------------------------------------------

const WORD = /[A-Za-z0-9_]/;
const regexEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A private-use character cannot occur in a command, so a placeholder survives quoting untouched.
const OPEN = "\uE000";
const CLOSE = "\uE001";
const byLength = (a, b) => b[1].length - a[1].length;

// `secrets` ({NAME: value}) are only replaced right after "Bearer ", and only as a whole token, so a
// short dev token such as "dev" never mangles other text. `vars` ({NAME: value}) are plain substring
// replacements for values that are long and distinctive (the API URL, the remote, a work directory).
// A word that carries a placeholder is double-quoted so that `$NAME` expands when the line is pasted
// into a shell; every other word is single-quoted when it needs quoting at all.
export function commandLine(argv, { secrets = {}, vars = {} } = {}) {
  const mark = (name) => `${OPEN}${name}${CLOSE}`;
  const words = argv.map((arg) => {
    let word = String(arg);
    for (const [name, value] of Object.entries(secrets).sort(byLength)) {
      if (!value) continue;
      word = word.replace(new RegExp(`Bearer ${regexEscape(value)}(?![A-Za-z0-9._~+/=-])`, "g"), `Bearer ${mark(name)}`);
    }
    for (const [name, value] of Object.entries(vars).sort(byLength)) {
      if (value) word = word.split(value).join(mark(name));
    }
    return word;
  });
  return words
    .map((word) => {
      const marked = word.includes(OPEN);
      if (!marked && word !== "" && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(word)) return word;
      if (!marked) return `'${word.replace(/'/g, `'\\''`)}'`;
      const escaped = word.replace(/["\\`$]/g, "\\$&");
      const expanded = escaped.replace(new RegExp(`${OPEN}(\\w+)${CLOSE}(.?)`, "gs"), (_, name, next) => (next && WORD.test(next) ? `\${${name}}${next}` : `$${name}${next}`));
      return `"${expanded}"`;
    })
    .join(" ");
}

// A response as it is shown in the transcript: the credentials a begin call hands out never are.
export function redactTokens(value) {
  if (Array.isArray(value)) return value.map(redactTokens);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "token" && typeof v === "string" ? "<redacted>" : redactTokens(v)]));
  }
  return value;
}
