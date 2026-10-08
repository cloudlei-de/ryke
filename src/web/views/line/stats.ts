// The numbers across the top of the Line (PLAN.md §12 "live counters"), from the folded state alone so the
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
  // Landed commits per bucket, oldest first, ending at `now`.
  spark: number[];
  trains: number;
  bisected: number;
  speculative: number;
  aborts: number;
  causes: { cause: string; label: string; count: number }[];
  needsHuman: string[];
  head: { sha: string; seq: number; at: number | null } | null;
};

export const SPARK_BUCKETS = 20;
export const SPARK_BUCKET_MS = 30_000;

export function sparkline(at: readonly number[], now: number, buckets = SPARK_BUCKETS, bucketMs = SPARK_BUCKET_MS): number[] {
  const out = new Array<number>(buckets).fill(0);
  const start = now - buckets * bucketMs;
  for (const t of at) {
    if (t <= start || t > now) continue;
    const i = Math.min(buckets - 1, Math.floor((t - start) / bucketMs));
    out[i]!++;
  }
  return out;
}

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
    spark: sparkline(
      state.ticks.filter((k) => k.txn).map((k) => k.at),
      now,
    ),
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
