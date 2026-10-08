// The numbers in the Line's margin (PLAN.md §12 "live counters"), from the folded state alone so the
// replay shows the counters of the moment it is at. Pure, so every rule is table-tested.
import { counters, type LineState } from "../../../shared/reducers";
import { abortRows } from "./geometry";

export type Stats = {
  inflight: number;
  // In flight, split by where the time goes: the agent working, waiting for a train, under test, or a human.
  working: number;
  queued: number;
  verifying: number;
  human: number;
  landed: number;
  perMinute: number;
  trains: number;
  bisected: number;
  speculative: number;
  aborts: number;
  causes: { cause: string; label: string; count: number }[];
  needsHuman: string[];
  head: { sha: string; seq: number; at: number | null } | null;
};

export function stats(state: LineState, now: number): Stats {
  const c = counters(state, now);
  let working = 0;
  let queued = 0;
  let verifying = 0;
  const needsHuman: string[] = [];
  for (const t of state.txns.values()) {
    if (t.state === "open") working++;
    else if (t.state === "submitted" || t.state === "ready") queued++;
    else if (t.state === "verifying") verifying++;
    else if (t.state === "needs_human") needsHuman.push(t.id);
  }
  const trains = [...state.trains.values()];
  const causes = abortRows(c.aborts);
  const last = state.ticks.at(-1);
  return {
    inflight: c.inflight,
    working,
    queued,
    verifying,
    human: needsHuman.length,
    landed: c.landed,
    perMinute: c.landedPerMinute,
    trains: c.trains,
    bisected: trains.filter((t) => t.probes.length > 0).length,
    speculative: trains.filter((t) => t.after !== null).length,
    aborts: causes.reduce((sum, a) => sum + a.count, 0),
    causes,
    needsHuman,
    head: state.head ? { ...state.head, at: last?.at ?? null } : null,
  };
}

// "12s", "4m", "2h": how long ago, for the feed and the trunk head. Under a second reads "now".
export function ago(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
