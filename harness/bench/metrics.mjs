// Turning what the agents recorded into the numbers of src/shared/bench.ts. Pure: the cell runner
// feeds it plain arrays, the tests feed it hand-made ones.
import { POLICIES, parseBench } from "../../src/shared/bench.ts";

export { POLICIES };

// `ryke-nolease` is Ryke with write leases switched off, for the lease comparison; `ryke-nopipe` is Ryke with
// speculative pipelining switched off (§5.6), for the pipelining comparison. The dashboard's results format only
// knows POLICIES, so a run that includes either is kept apart from bench/results/latest.json.
export const ABLATION_POLICIES = ["ryke-nolease", "ryke-nopipe"];
export const BENCH_POLICIES = [...POLICIES, ...ABLATION_POLICIES];
export const isRyke = (name) => name === "ryke" || ABLATION_POLICIES.includes(name);

export const round = (n, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

// Linear interpolation between closest ranks (the usual "type 7" definition), 0 for no data.
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

const bump = (map, key, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

// attempts: { txn, attempt, endMs, thinkS, outcome }   outcome is "landed", a cause, or "abandoned"
// txns:     { txn, startMs, endMs, status: "landed" | "aborted" | "abandoned", cause }
// Times are milliseconds since the cell started. Only what finished inside the duration counts; whatever
// finishes in the grace period afterwards only drains the system, so no policy is charged or credited for it.
export function summarizeCell({ policy, agents, durationMs, attempts, txns, verifyRuns, trunkBreakages }) {
  const inside = (e) => e.endMs <= durationMs;
  const landedTxns = txns.filter((t) => t.status === "landed" && inside(t));
  const landed = landedTxns.length;
  const latencies = landedTxns.map((t) => (t.endMs - t.startMs) / 1000);

  const aborts = {};
  let wasted = 0;
  let notLanded = 0;
  for (const a of attempts) {
    if (a.outcome === "landed" || a.outcome === "abandoned" || !inside(a)) continue;
    bump(aborts, a.outcome);
    wasted += a.thinkS;
    notLanded++;
  }
  for (const t of txns) if (t.status === "aborted" && t.cause === "max_attempts" && inside(t)) bump(aborts, "max_attempts");

  const cell = {
    policy,
    agents,
    landed,
    landedPerMinute: round(landed / (durationMs / 60_000)),
    p50: round(percentile(latencies, 0.5)),
    p95: round(percentile(latencies, 0.95)),
    aborts,
    // With nothing landed there is no ratio; 0 keeps the JSON finite and the table honest next to "landed 0".
    verifyRunsPerLanded: landed === 0 ? 0 : round(verifyRuns / landed),
    wastedAgentSeconds: round(wasted, 1),
    trunkBreakages,
  };
  const extras = {
    landedInGrace: txns.filter((t) => t.status === "landed" && !inside(t)).length,
    abandoned: txns.filter((t) => t.status === "abandoned").length,
    started: txns.length,
    attemptsPerLanded: landed === 0 ? 0 : round(attempts.filter((a) => inside(a) && a.outcome !== "abandoned").length / landed),
    notLandedAttempts: notLanded,
    verifyRuns,
  };
  return { cell, extras };
}

export function buildResults({ cells, durationSeconds, note, generatedAt = new Date().toISOString() }) {
  const results = { generatedAt, durationSeconds, synthetic: true, note, cells };
  // The dashboard validates the file with the same function; a result it would refuse must never be written.
  // Ablation cells carry a name it does not know, so they are checked as the Ryke cell they are a variant of.
  const asKnown = { ...results, cells: cells.map((c) => (ABLATION_POLICIES.includes(c.policy) ? { ...c, policy: "ryke" } : c)) };
  if (parseBench(JSON.parse(JSON.stringify(asKnown))) === null) throw new Error("bench results do not match src/shared/bench.ts");
  return results;
}

// ---------------------------------------------------------------------------------------------
// Counting verify jobs on the Ryke side from its op log (the lock and queue landers count their own).
// ---------------------------------------------------------------------------------------------

// One verify per train that had something to merge, plus one per bisection probe, for the trains that
// finished inside the window (so the count lines up with the changes it is divided by). A discarded
// speculative train counts too: its prepare and verify ran and nothing landed, which is the price of
// pipelining and belongs in the ratio. `sinceAt` and `untilAt` are epoch milliseconds, like op.at.
export function rykeVerifyRuns(ops, { sinceAt = 0, untilAt = Infinity } = {}) {
  const done = new Map();
  const empty = new Set();
  const probes = new Map();
  for (const op of ops) {
    if (op.kind === "train.done") {
      done.set(op.data.train, op.at);
      if (op.data.outcome === "empty") empty.add(op.data.train);
    } else if (op.kind === "train.bisect") probes.set(op.data.train, (probes.get(op.data.train) ?? 0) + 1);
  }
  let runs = 0;
  for (const [train, at] of done) {
    if (at < sinceAt || at > untilAt) continue;
    runs += (empty.has(train) ? 0 : 1) + (probes.get(train) ?? 0);
  }
  return runs;
}

// What the platform itself recorded: train sizes, where the stale aborts landed, how many warnings went out.
export function rykeOpStats(ops, { sinceAt = 0, untilAt = Infinity } = {}) {
  const within = ops.filter((o) => o.at >= sinceAt && o.at <= untilAt);
  const trainSizes = {};
  const stalePaths = {};
  const conflictPaths = {};
  let trains = 0;
  let bisectProbes = 0;
  let staleWarnings = 0;
  let staleAborts = 0;
  let conflictAborts = 0;
  const formedAt = new Map();
  const cycles = [];
  // A speculative train is one formed on another train's candidate (`after`); it ends confirmed or discarded.
  const speculative = { formed: 0, confirmed: 0, discarded: 0 };
  // A change that went stale straight after `ready` was waiting for a train when trunk moved under it;
  // one that went stale straight after `submitted` was already stale when it was handed in.
  const lastKind = new Map();
  let staleWhileReady = 0;
  for (const o of within) {
    const wentStale = o.kind === "txn.stale" || (o.kind === "txn.aborted" && o.data.cause?.state === "stale");
    if (o.txn && wentStale && lastKind.get(o.txn) === "txn.ready") staleWhileReady++;
    if (o.txn && o.kind.startsWith("txn.")) lastKind.set(o.txn, o.kind);
    if (o.kind === "train.formed") {
      trains++;
      bump(trainSizes, String(o.data.txns?.length ?? 0));
      formedAt.set(o.data.train, o.at);
      if (o.data.after) speculative.formed++;
    } else if (o.kind === "train.confirmed") speculative.confirmed++;
    else if (o.kind === "train.done" && o.data.outcome === "discarded") speculative.discarded++;
    else if (o.kind === "train.bisect") bisectProbes++;
    else if (o.kind === "stale.warning") staleWarnings++;
    else if (o.kind === "trunk.advanced" && formedAt.has(o.data.train)) cycles.push((o.at - formedAt.get(o.data.train)) / 1000);
    else if (o.kind === "txn.stale" || (o.kind === "txn.aborted" && o.data.cause?.state === "stale")) {
      // The attempt that runs out of tries goes straight to aborted; its cause is kept in `cause`.
      const reason = o.kind === "txn.stale" ? o.data.reason : o.data.cause.reason;
      const paths = (o.data.paths ?? []).map((p) => p.path);
      if (reason === "text_conflict") {
        conflictAborts++;
        for (const p of paths) bump(conflictPaths, p);
      } else {
        staleAborts++;
        for (const p of paths) bump(stalePaths, p);
      }
    }
  }
  const sizes = Object.entries(trainSizes).flatMap(([size, n]) => Array(n).fill(Number(size)));
  return {
    trains,
    trainSizes,
    meanTrainSize: sizes.length === 0 ? 0 : round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
    maxTrainSize: Math.max(0, ...sizes),
    bisectProbes,
    speculative,
    staleWarnings,
    staleAborts,
    staleWhileReady,
    conflictAborts,
    stalePaths,
    conflictPaths,
    trainCycleSecondsP50: round(percentile(cycles, 0.5)),
    trainCycleSecondsP95: round(percentile(cycles, 0.95)),
  };
}
