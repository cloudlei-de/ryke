// Pure playback logic for the Replay view (PLAN.md §12 view 5): the player state machine, incremental
// folding of the op log, history paging and keyboard mapping. No React, no DOM, so each rule is table-tested.
import { apply, initial, type LineState } from "../../../shared/reducers";
import type { Op, OpKind } from "../../../shared/types";

export const SPEEDS = [1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];

// idx is a position in the op array (seq order), clock is the position in op time in ms. Between ops the
// clock runs ahead of times[idx], so open bars on the Line keep growing the way they do live.
export type Player = { idx: number; clock: number; playing: boolean; speed: Speed };

export type PlayerAction =
  | { type: "toggle" }
  | { type: "seek"; idx: number }
  | { type: "step"; by: number }
  | { type: "start" }
  | { type: "end" }
  | { type: "speed"; speed: Speed }
  | { type: "tick"; dt: number }
  // `from` is how many ops the log had before it grew; the new length is `times.length`.
  | { type: "grew"; from: number }
  // The recording was deleted and started again (swarm --fresh): there is nothing left to be positioned in.
  | { type: "reset" };

export function initialPlayer(): Player {
  return { idx: 0, clock: 0, playing: false, speed: 1 };
}

// Binary search needs a sorted array; a clock that stepped back would break it, so searches run on
// the running maximum, which is also what the reducers' `now` uses.
export function prefixMaxTimes(ops: readonly Op[]): number[] {
  let max = Number.NEGATIVE_INFINITY;
  return ops.map((o) => (max = Math.max(max, o.at)));
}

// The last op at or before t, or -1 before the first.
export function indexAtTime(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

// A backgrounded tab pauses requestAnimationFrame; without a cap the first frame back would play minutes at once.
const MAX_TICK_MS = 250;

export function playerReduce(p: Player, times: readonly number[], a: PlayerAction): Player {
  const last = Math.max(0, times.length - 1);
  const at = (idx: number) => times[idx] ?? 0;
  const seek = (idx: number, playing: boolean): Player => {
    const i = Math.min(last, Math.max(0, Math.round(idx)));
    return { ...p, idx: i, clock: at(i), playing: playing && i < last };
  };
  switch (a.type) {
    case "seek":
      return Number.isNaN(a.idx) ? p : seek(a.idx, p.playing);
    case "start":
      return seek(0, p.playing);
    case "end":
      return seek(last, false);
    case "step":
      return seek(p.idx + a.by, false);
    case "toggle":
      if (times.length === 0) return p;
      if (p.playing) return { ...p, playing: false };
      // Play at the end starts over, like a video.
      // Resuming keeps the clock where pause left it (it can sit between ops), so the Line does not jump back.
      return p.idx >= last ? { ...p, idx: 0, clock: at(0), playing: true } : { ...p, clock: Math.max(p.clock, at(p.idx)), playing: true };
    case "speed":
      return SPEEDS.includes(a.speed) ? { ...p, speed: a.speed } : p;
    case "tick": {
      if (!p.playing) return p;
      if (times.length === 0) return { ...p, playing: false };
      if (!(a.dt > 0)) return p;
      const clock = p.clock + Math.min(a.dt, MAX_TICK_MS) * p.speed;
      const idx = Math.max(p.idx, indexAtTime(times, clock));
      return idx >= last ? { ...p, idx: last, clock: at(last), playing: false } : { ...p, idx, clock };
    }
    case "grew": {
      if (times.length === 0) return p;
      // First ops: show the finished picture. Paused at the old end: keep following the log as it grows.
      if (a.from === 0 || (!p.playing && p.idx === a.from - 1)) return { ...p, idx: last, clock: at(last) };
      return p;
    }
    case "reset":
      return { ...initialPlayer(), speed: p.speed };
  }
}

// What the player does when the log it plays from changes. `epoch` counts the times the live log was thrown
// away: on a new epoch the old position means nothing, and the new run's ops are all news, so the player
// starts over and then follows them to the end like it does for the first ops of any log.
export type Seen = { epoch: number; length: number };

export function logChanged(seen: Seen, epoch: number, length: number): { seen: Seen; actions: PlayerAction[] } {
  const now = { epoch, length };
  if (epoch !== seen.epoch) return { seen: now, actions: length > 0 ? [{ type: "reset" }, { type: "grew", from: 0 }] : [{ type: "reset" }] };
  return { seen: now, actions: length > seen.length ? [{ type: "grew", from: seen.length }] : [] };
}

// The `now` the Line renders at: the running clock, which equals the op's own time after any seek or step
// and runs ahead of it between ops while playing. Pausing keeps it, so the picture holds still.
export function displayNow(p: Player, times: readonly number[]): number {
  const t = times[p.idx];
  return t === undefined ? 0 : Math.max(t, p.clock);
}

// Ops from the socket and from the history fetch overlap. Base objects win so a FoldCache that holds
// one of them stays valid; if the socket has nothing the base lacks, the base itself comes back.
export function mergeOps(base: Op[], extra: readonly Op[]): Op[] {
  const have = new Set(base.map((o) => o.seq));
  const novel = extra.filter((o) => !have.has(o.seq));
  if (novel.length === 0) return base;
  return [...base, ...novel].sort((a, b) => a.seq - b.seq);
}

export type Page = { ops: Op[]; last: number };

export type HistoryStatus = { status: "loading" } | { status: "ok" } | { status: "error"; message: string };
export type History = { epoch: number; ops: Op[]; status: HistoryStatus };

// A history fetched before the log started over describes a run that is gone; merging it into the new run
// would draw two runs on one Line. Until the refetch lands the view has no history at all.
export function historyAt(h: History, epoch: number): History {
  return h.epoch === epoch ? h : { epoch, ops: [], status: { status: "loading" } };
}

// GET /api/repos/:repo/ops pages at most 5000 ops; follow `last` until a short page.
export async function loadHistory(fetchPage: (after: number, limit: number) => Promise<Page>, limit = 5000): Promise<Op[]> {
  const all: Op[] = [];
  let after = 0;
  for (;;) {
    const page = await fetchPage(after, limit);
    all.push(...page.ops);
    if (page.ops.length < limit || page.last <= after) return all;
    after = page.last;
  }
}

export type FoldCache = { ops: readonly Op[] | null; idx: number; op: Op | null; state: LineState };

export function newFoldCache(): FoldCache {
  return { ops: null, idx: -1, op: null, state: initial() };
}

// `fold(ops, seq)` for the op at `idx`, but moving forward only applies the new ops. The cached state is
// reused only while the op it stopped at is still at the same position, so a log that gained an earlier op
// refolds. Going backward refolds into a new object, so a state a view already holds is never rewound.
export function foldTo(cache: FoldCache, ops: readonly Op[], idx: number): LineState {
  const target = Math.min(idx, ops.length - 1);
  if (target < 0) {
    if (cache.op !== null) Object.assign(cache, newFoldCache());
    return cache.state;
  }
  const reusable = cache.op !== null && cache.idx <= target && ops[cache.idx] === cache.op;
  if (!reusable) cache.state = initial();
  for (let i = reusable ? cache.idx + 1 : 0; i <= target; i++) apply(cache.state, ops[i]!);
  cache.ops = ops;
  cache.idx = target;
  cache.op = ops[target]!;
  return cache.state;
}

export type KeyEvent = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; targetTag?: string; targetType?: string; editable?: boolean };

// Space and the arrows drive playback from anywhere, except where the focused element already uses the
// key: a button is pressed by space, text fields and selects use both, and the range input steps one op
// per arrow by itself (its Home and End are the same jumps as ours).
export function keyAction(e: KeyEvent): PlayerAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const tag = (e.targetTag ?? "").toUpperCase();
  const range = tag === "INPUT" && e.targetType === "range";
  const takesNavigation = Boolean(e.editable) || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
  switch (e.key) {
    case " ":
      return e.editable || ["BUTTON", "SELECT", "TEXTAREA", "A"].includes(tag) || (tag === "INPUT" && !range) ? null : { type: "toggle" };
    case "ArrowRight":
      return takesNavigation ? null : { type: "step", by: 1 };
    case "ArrowLeft":
      return takesNavigation ? null : { type: "step", by: -1 };
    case "Home":
      return takesNavigation ? null : { type: "start" };
    case "End":
      return takesNavigation ? null : { type: "end" };
    default:
      return null;
  }
}

export type Signal = "go" | "stop" | "caution" | "run" | "recall";

// Signal colours mean something (PLAN.md §12), so an op kind gets one only where the Line would.
const SIGNALS: Record<OpKind, Signal | null> = {
  "txn.open": null,
  "txn.submitted": null,
  "txn.ready": null,
  "txn.verifying": "run",
  "txn.landed": "go",
  "txn.stale": "stop",
  "txn.failed": "stop",
  "txn.needs_human": "caution",
  "txn.aborted": "stop",
  "txn.rejected": "stop",
  "txn.recalled": "recall",
  "trunk.advanced": null,
  "trunk.diverged": "stop",
  "train.formed": "run",
  "train.bisect": "run",
  "train.confirmed": "run",
  "train.done": null,
  "stale.warning": "caution",
  "heat.changed": null,
  "lease.granted": null,
  "lease.waiting": "caution",
  "lease.released": null,
  "dup.warning": "caution",
  "conflict.warning": "caution",
  "judge.verdict": null,
  "reads.fallback": null,
  "recall.planned": "recall",
  "recall.done": "recall",
  "policy.updated": null,
};

export function opSignal(kind: OpKind): Signal | null {
  return SIGNALS[kind];
}

const TRACK_MARKS: Partial<Record<OpKind, "go" | "stop" | "recall">> = { "txn.landed": "go", "txn.stale": "stop", "txn.rejected": "stop", "recall.planned": "recall" };

// Ticks above the slider so the story of the run is visible before it is played: where changes land,
// go stale or are recalled. `at` is the fraction along the track.
export function markers(ops: readonly Op[]): { at: number; tone: "go" | "stop" | "recall" }[] {
  const out: { at: number; tone: "go" | "stop" | "recall" }[] = [];
  ops.forEach((o, i) => {
    const tone = TRACK_MARKS[o.kind];
    if (tone) out.push({ at: ops.length > 1 ? i / (ops.length - 1) : 0, tone });
  });
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function fmtElapsed(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const [h, m] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60)];
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}

export function fmtClock(ms: number): string {
  if (!Number.isFinite(ms)) return "--:--:--";
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function opFields(o: Op): { seq: string; kind: string; txn: string; agent: string } {
  return { seq: String(o.seq), kind: o.kind, txn: o.txn ?? "–", agent: o.agent ?? "–" };
}
