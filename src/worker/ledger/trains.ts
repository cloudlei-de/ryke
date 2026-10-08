import { matchesAny } from "../../shared/policy";
import type { Policy } from "../../shared/types";

export type TrainCandidate = { id: string; submittedAt: number; footprint: string[]; skips: number };

// A transaction skipped this often goes first in the next train, so a busy path cannot starve it (§5.2).
export const FAIRNESS_SKIPS = 3;

const byAge = (a: TrainCandidate, b: TrainCandidate): number =>
  a.submittedAt - b.submittedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// `skipped` is in the order candidates were considered (starved first, then FIFO); the Ledger
// increments their skip counters. Footprints are already normalised paths from the access table.
export function selectTrain(
  ready: TrainCandidate[],
  policy: Pick<Policy, "union" | "trainMax">,
): { train: string[]; skipped: string[] } {
  const fifo = [...ready].sort(byAge);
  const considered = [
    ...fifo.filter((c) => c.skips >= FAIRNESS_SKIPS),
    ...fifo.filter((c) => c.skips < FAIRNESS_SKIPS),
  ];

  const train: string[] = [];
  const skipped: string[] = [];
  // Union paths are expected to be edited concurrently (git merges them, verify judges them), so
  // they never occupy a slot and never collide.
  const taken = new Set<string>();
  for (const c of considered) {
    const paths = c.footprint.filter((p) => !matchesAny(policy.union, p));
    if (train.length < policy.trainMax && paths.every((p) => !taken.has(p))) {
      train.push(c.id);
      for (const p of paths) taken.add(p);
    } else {
      skipped.push(c.id);
    }
  }
  return { train, skipped };
}

// ---------------------------------------------------------------------------------------------
// Bisection planner (§5.3 step 4). A pure state machine: the Land Workflow runs one verify per
// probe inside its own step.do, so the state must survive JSON between steps and Workflow retries.
//
// Invariant while searching: `good` + remaining[0..lo) passed, `good` + remaining[0..hi) failed.
// Each search ends with hi = lo + 1, which makes remaining[lo] the first culprit. Everything before
// it joins `good`, and `good` is only ever extended by a set a probe has just verified, so the
// workflow can land exactly the candidate it built for `lastPassingProbe`.
// ---------------------------------------------------------------------------------------------

export type BisectState = {
  order: string[];
  good: string[];
  remaining: string[];
  culprits: string[];
  unresolved: string[];
  // "search": binary search over `remaining`. "whole": about to probe good + all of remaining.
  phase: "search" | "whole" | "done";
  lo: number;
  hi: number;
  probes: number;
  maxProbes: number;
  // Txns of the most recent probe that passed, or null. Whenever `good` is non-empty this equals `good`.
  lastPassingProbe: string[] | null;
};

export type BisectStep =
  | { kind: "probe"; txns: string[] }
  | { kind: "done"; good: string[]; culprits: string[]; unresolved: string[] };

// `order` is the full set, known to FAIL verification. The default budget covers a train with one
// or two culprits; a larger blast radius is handed back as `unresolved` for the Ledger to re-queue
// rather than burning the verify timeout n times.
export function bisectStart(order: string[], maxProbes: number = 2 * order.length + 2): BisectState {
  return settle({
    order: [...order],
    good: [],
    remaining: [...order],
    culprits: [],
    unresolved: [],
    phase: "search",
    lo: 0,
    hi: order.length,
    probes: 0,
    maxProbes,
    lastPassingProbe: null,
  });
}

export function bisectNext(s: BisectState): BisectStep {
  if (s.phase === "done") return { kind: "done", good: s.good, culprits: s.culprits, unresolved: s.unresolved };
  return { kind: "probe", txns: probeOf(s) };
}

// The probe is a pure function of the state, so the workflow only has to store the state and the
// verdict; it never has to hand the probe back.
export function bisectRecord(s: BisectState, pass: boolean): BisectState {
  if (s.phase === "done") throw new Error("bisect is already finished; there is no probe to record");
  const probe = probeOf(s);
  const next: BisectState = { ...s, probes: s.probes + 1 };
  if (pass) next.lastPassingProbe = probe;
  if (s.phase === "search") {
    const mid = (s.lo + s.hi) >> 1;
    if (pass) next.lo = mid;
    else next.hi = mid;
  } else if (pass) {
    // Everything left is innocent: good + remaining just verified, so it is the new good.
    next.good = probe;
    next.remaining = [];
  } else {
    next.phase = "search";
    next.lo = 0;
    next.hi = s.remaining.length;
  }
  return settle(next);
}

function probeOf(s: BisectState): string[] {
  // Concatenation keeps the original order: every `good` txn precedes every `remaining` one.
  if (s.phase === "whole") return [...s.good, ...s.remaining];
  return [...s.good, ...s.remaining.slice(0, (s.lo + s.hi) >> 1)];
}

// Advances through every step that needs no verify, so a state is always either awaiting a probe or done.
function settle(s: BisectState): BisectState {
  const state = { ...s, good: [...s.good], remaining: [...s.remaining], culprits: [...s.culprits] };
  for (;;) {
    if (state.remaining.length === 0) {
      state.phase = "done";
      return state;
    }
    if (state.phase === "search" && state.hi - state.lo === 1) {
      // remaining[lo] is the first txn whose addition breaks verify; the ones before it passed.
      state.culprits.push(state.remaining[state.lo]!);
      state.good.push(...state.remaining.slice(0, state.lo));
      state.remaining = state.remaining.slice(state.hi);
      state.phase = "whole";
      // Reset the window: the out-of-budget branch below reads `lo` and must see 0 outside a search.
      state.lo = 0;
      state.hi = state.remaining.length;
      continue;
    }
    if (state.probes < state.maxProbes) return state;
    // Out of budget. A search in progress has already verified good + remaining[0..lo), so keep that
    // progress; the rest is neither proven good nor blamed, and goes back to the queue.
    state.good.push(...state.remaining.slice(0, state.lo));
    state.unresolved = state.remaining.slice(state.lo);
    state.remaining = [];
    state.phase = "done";
    return state;
  }
}
