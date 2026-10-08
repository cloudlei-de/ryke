// Pure geometry and formatting for the Line view (PLAN.md §12 view 1). Everything that is arithmetic
// or text lives here so it can be tested without a DOM; the React components only draw its output.
import { HOT } from "../../../worker/ledger/heat";
import type { AttemptView, LineState, Segment, Tick, TxnView } from "../../../shared/reducers";
import type { Op, OpKind } from "../../../shared/types";
import { modelLabel } from "../../agents";
import { duration, reasonLabel } from "../txn/format";

export const ROW_H = 16;
export const ROW_MAX = 34;
export const AXIS_H = 26;
export const MIN_BAR_W = 3;
// Geist at the bars' 11 px label size advances about 6 px a character; labels are sized before drawing.
export const CHAR_W = 6;
// A label needs this much of the working stretch to say anything (six characters and the padding).
export const LABEL_MIN_W = 56;
export const DOT_GAP = 9;
export const BLOCK_GAP = 12;
export const SWARM_CMD = "npm run swarm -- --mode scripted --agents 12 --fresh";

// ---------------------------------------------------------------- time axis

export type Scale = { t0: number; t1: number; x0: number; x1: number };
export type TimeWindow = { start: number; end: number };

export function toX(s: Scale, t: number): number {
  const span = s.t1 - s.t0;
  if (span <= 0) return s.x0;
  return s.x0 + ((t - s.t0) / span) * (s.x1 - s.x0);
}

export function clampX(s: Scale, x: number): number {
  return Math.min(Math.max(x, s.x0), s.x1);
}

// The label gutter shrinks on a phone so the time axis keeps most of the width. The bars start a little right
// of the gutter so the first one never touches an agent's name; the right margin is half a clock label, so the
// last tick's label is never cut off.
export function plotBox(width: number): { labelW: number; x0: number; x1: number } {
  const labelW = width < 640 ? 84 : 150;
  const x0 = labelW + 10;
  return { labelW, x0, x1: Math.max(x0 + 40, width - 24) };
}

// Fine enough that the blank margin on the right stays under a third; coarse enough that the scale holds still for a while.
export const LIVE_STEPS_MS = [60_000, 90_000, 120_000, 180_000, 240_000, 300_000, 420_000, 600_000];
export const LIVE_MAX_MS = LIVE_STEPS_MS[LIVE_STEPS_MS.length - 1]!;
const RIGHT_MARGIN = 0.06;
const LEFT_MARGIN = 0.02;
const REPLAY_MIN_SPAN_MS = 10_000;

// Earliest start of an attempt still on screen (running, or ended inside the last `notBefore`..now range).
// Anchoring the live window here means a new swarm on an old repo fills the panel from its first bar.
export function activityStart(state: LineState, notBefore: number): number | null {
  let first: number | null = null;
  for (const t of state.txns.values()) {
    for (const a of t.attempts) {
      if (a.end !== null && a.end < notBefore) continue;
      if (first === null || a.start < first) first = a.start;
    }
  }
  return first;
}

// Live: the window grows in whole steps (1, 1.5, 2, 3, 4, 5, 7, 10 min) so the scale does not creep on every tick,
// stays anchored at the first bar, and past 10 min slides with `now` just inside the right edge.
export function liveWindow(now: number, first: number | null): TimeWindow {
  const earliest = first === null ? now : Math.min(first, now);
  const span = now - earliest;
  const step = LIVE_STEPS_MS.find((s) => span <= s * (1 - RIGHT_MARGIN));
  if (step !== undefined) {
    const start = earliest - step * LEFT_MARGIN;
    return { start, end: start + step };
  }
  const end = now + LIVE_MAX_MS * RIGHT_MARGIN;
  return { start: end - LIVE_MAX_MS, end };
}

// Replay: fit the whole recording once, so scrubbing moves a cursor instead of rescaling the picture.
export function replayWindow(first: number | null, last: number | null, now: number): TimeWindow {
  const lo = Math.min(first ?? now, now);
  const hi = Math.max(last ?? now, now, lo);
  const span = Math.max(hi - lo, REPLAY_MIN_SPAN_MS);
  const pad = span * 0.02;
  return { start: lo - pad, end: lo + span + pad };
}

export function opBounds(ops: readonly Op[]): { first: number | null; last: number | null } {
  return { first: ops[0]?.at ?? null, last: ops.at(-1)?.at ?? null };
}

export const AXIS_STEPS_MS = [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];

export function axisStep(spanMs: number, widthPx: number, minLabelPx = 88): number {
  const want = (spanMs / Math.max(widthPx, 1)) * minLabelPx;
  return AXIS_STEPS_MS.find((s) => s >= want) ?? AXIS_STEPS_MS[AXIS_STEPS_MS.length - 1]!;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// Clock time in the viewer's zone. The offset is an argument (not read from Date) so tests are zone-independent.
export function formatClock(ms: number, stepMs: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60_000);
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return stepMs < 60_000 ? `${hm}:${pad2(d.getUTCSeconds())}` : hm;
}

export function axisTicks(w: TimeWindow, widthPx: number, tzOffsetMin: number): { t: number; label: string }[] {
  const span = w.end - w.start;
  if (!(span > 0) || !(widthPx > 0)) return [];
  const step = axisStep(span, widthPx);
  const off = tzOffsetMin * 60_000;
  const out: { t: number; label: string }[] = [];
  // Aligned to local clock multiples, so a 5 min step reads :00, :05, :10 whatever the zone.
  for (let t = Math.ceil((w.start + off) / step) * step - off; t <= w.end && out.length < 200; t += step) {
    out.push({ t, label: formatClock(t, step, tzOffsetMin) });
  }
  return out;
}

// ---------------------------------------------------------------- text

export function clipText(s: string, max: number): string {
  if (max < 1) return "";
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export const shortSha = (sha: string | null | undefined): string => (sha ?? "").slice(0, 8);

// `src/format.ts ← t_…` for the first stale path; further paths collapse into +n (§12 stale label).
export function staleDetail(stale: readonly { path: string; by: string | null }[], reason: string | null): string {
  const first = stale[0];
  if (!first) return reason === "text_conflict" ? "text conflict" : "";
  const extra = stale.length > 1 ? ` +${stale.length - 1}` : "";
  return `${first.path}${first.by ? ` ← ${first.by}` : ""}${extra}`;
}

export function staleLabel(stale: readonly { path: string; by: string | null }[], reason: string | null): string {
  const detail = staleDetail(stale, reason);
  return detail ? `stale · ${detail}` : "stale";
}

// ---------------------------------------------------------------- sidings

export type Tone = "open" | "queued" | "verify" | "landed" | "human" | "lease";

export function segmentTone(state: Segment["state"], landed: boolean): Tone {
  switch (state) {
    case "submitted":
    case "ready":
      return "queued";
    case "verifying":
      // Verifying is blue while it runs; once the attempt landed, the same stretch is the green bar of §12.
      return landed ? "landed" : "verify";
    case "needs_human":
      return "human";
    case "lease_wait":
      return "lease";
    default:
      return "open";
  }
}

const STATE_LABEL: Record<string, string> = { lease_wait: "waiting for lease", needs_human: "needs human" };
export const stateLabel = (s: string): string => STATE_LABEL[s] ?? s;

// Overlapping attempts of one agent (it began a second transaction before the first ended) share the
// row as sub-lanes; touching intervals (stale, then the retry) stay in one lane.
export function assignLanes(items: readonly { key: string; from: number; to: number }[]): { lane: Map<string, number>; count: number } {
  const ends: number[] = [];
  const lane = new Map<string, number>();
  for (const it of [...items].sort((a, b) => a.from - b.from)) {
    let i = ends.findIndex((end) => end <= it.from);
    if (i < 0) i = ends.length;
    ends[i] = Math.max(it.to, it.from);
    lane.set(it.key, i);
  }
  return { lane, count: Math.max(1, ends.length) };
}

// 30 agents must fit a 1440x900 screen at the minimum height (about 500 px of rows under the counters); with fewer
// agents the rows grow into the free space (up to ROW_MAX) so the bars and the intents on them are easier to read.
export function rowHeight(count: number, availablePx: number): number {
  if (count <= 0 || !(availablePx > 0)) return ROW_H;
  return Math.min(ROW_MAX, Math.max(ROW_H, Math.floor(availablePx / count)));
}

export function barHeight(rowH: number): number {
  return Math.min(20, Math.max(10, Math.round(rowH * 0.6)));
}

export function laneBox(lane: number, lanes: number, rowH = ROW_H): { y: number; h: number } {
  if (lanes <= 1) {
    const h = barHeight(rowH);
    return { y: (rowH - h) / 2, h };
  }
  const pad = 2;
  const gap = 1;
  const h = (rowH - 2 * pad - (lanes - 1) * gap) / lanes;
  return { y: pad + lane * (h + gap), h };
}

// Bars this tall have room for an 11 px label inside them.
export const LABEL_MIN_H = 14;

export type BarPart = { tone: Tone; x: number; w: number };
export type Mark = { kind: "landed" | "stale" | "failed" | "rejected" | "aborted"; x: number };
export type AttemptBar = {
  key: string;
  txn: string;
  attempt: number;
  lane: number;
  lanes: number;
  x: number;
  w: number;
  parts: BarPart[];
  mark: Mark | null;
  strike: { x1: number; x2: number } | null;
  warnings: number[];
  running: boolean;
  // The intent, written inside the stretch where the agent was working, when it is wide enough to say something.
  label: { text: string; x: number; w: number } | null;
  // What made a stale attempt stale: the paths and the transactions that changed them.
  stale: { path: string; by: string | null }[];
  title: string;
  href: string;
};
export type Row = { agent: string; index: number; bars: AttemptBar[] };

export const txnHref = (id: string): string => `#/t/${encodeURIComponent(id)}`;

// The accessible name of a bar; the hover card (tipFor) shows the same facts laid out.
function barTitle(txn: TxnView, a: AttemptView): string {
  const status = a.outcome ?? a.segments.at(-1)?.state ?? "open";
  // The model is there so a scripted or stub agent is never mistaken for a language model (§0.10).
  const lines = [`${txn.id} · attempt ${a.attempt} · ${stateLabel(status)}${a.reason ? ` (${a.reason})` : ""}`, txn.model ? `${txn.agent} · ${modelLabel(txn.model)}` : txn.agent, txn.intent];
  if (a.outcome === "stale") lines.push(staleLabel(a.stale, a.reason));
  for (const w of a.warnings) lines.push(`warning: ${w.paths.join(", ")}`);
  return lines.join("\n");
}

export function barLabel(intent: string, first: BarPart | undefined): AttemptBar["label"] {
  if (!first || first.tone !== "open" || first.w < LABEL_MIN_W || intent.trim() === "") return null;
  const text = clipText(intent.trim(), Math.floor((first.w - 12) / CHAR_W));
  return text.length < 6 ? null : { text, x: first.x + 6, w: first.w - 8 };
}

export function layoutBar(args: { txn: TxnView; attempt: AttemptView; lane: number; lanes: number; scale: Scale; now: number }): AttemptBar | null {
  const { txn, attempt: a, lane, lanes, scale, now } = args;
  const endT = Math.max(a.end ?? now, a.start);
  const rawStart = toX(scale, a.start);
  const rawEnd = toX(scale, endT);
  // Entirely left of the window (an old attempt after the live window slid) or right of it (replay before it began).
  if (rawEnd < scale.x0 || rawStart > scale.x1) return null;

  const landed = a.outcome === "landed";
  const parts: BarPart[] = [];
  for (const seg of a.segments) {
    const xs = clampX(scale, toX(scale, seg.from));
    const xe = clampX(scale, toX(scale, Math.min(seg.to ?? endT, endT)));
    if (xe - xs >= 0.5) parts.push({ tone: segmentTone(seg.state, landed), x: xs, w: xe - xs });
  }
  if (parts.length === 0) {
    const last = a.segments.at(-1);
    parts.push({ tone: segmentTone(last?.state ?? "open", landed), x: clampX(scale, rawStart), w: MIN_BAR_W });
  }
  const x = parts[0]!.x;
  const end = parts.at(-1)!.x + parts.at(-1)!.w;
  const outcome = a.outcome;
  const mark: Mark | null = outcome === "landed" || outcome === "stale" || outcome === "failed" || outcome === "rejected" || outcome === "aborted" ? { kind: outcome, x: end } : null;

  return {
    key: `${txn.id}#${a.attempt}`,
    txn: txn.id,
    attempt: a.attempt,
    lane,
    lanes,
    x,
    w: end - x,
    parts,
    mark,
    // A recalled transaction landed first; the strike runs over the green bar.
    strike: txn.state === "recalled" && landed ? { x1: x, x2: end } : null,
    warnings: a.warnings.map((w) => toX(scale, w.at)).filter((wx) => wx >= scale.x0 && wx <= scale.x1),
    running: a.end === null,
    label: barLabel(txn.intent, parts[0]),
    stale: outcome === "stale" ? a.stale : [],
    title: barTitle(txn, a),
    href: txnHref(txn.id),
  };
}

// One row per agent in first-seen order, so a row never moves once it exists.
export function buildRows(state: LineState, scale: Scale, now: number): Row[] {
  const byAgent = new Map<string, { txn: TxnView; attempt: AttemptView }[]>();
  for (const txn of state.txns.values()) {
    for (const attempt of txn.attempts) {
      const list = byAgent.get(txn.agent) ?? [];
      list.push({ txn, attempt });
      byAgent.set(txn.agent, list);
    }
  }
  return state.agents.map((agent, index) => {
    const refs = (byAgent.get(agent) ?? []).sort((p, q) => p.attempt.start - q.attempt.start);
    const keyOf = (r: { txn: TxnView; attempt: AttemptView }) => `${r.txn.id}#${r.attempt.attempt}`;
    const { lane, count } = assignLanes(refs.map((r) => ({ key: keyOf(r), from: r.attempt.start, to: r.attempt.end ?? now })));
    const bars: AttemptBar[] = [];
    for (const r of refs) {
      const bar = layoutBar({ txn: r.txn, attempt: r.attempt, lane: lane.get(keyOf(r)) ?? 0, lanes: count, scale, now });
      if (bar) bars.push(bar);
    }
    return { agent, index, bars };
  });
}

// What an agent's row says about it next to its name: the state of its newest transaction.
export function agentStatus(state: LineState, agent: string): { state: string; txn: string } | null {
  let newest: TxnView | null = null;
  for (const t of state.txns.values()) {
    if (t.agent !== agent) continue;
    const start = t.attempts.at(-1)?.start ?? 0;
    if (!newest || start >= (newest.attempts.at(-1)?.start ?? 0)) newest = t;
  }
  return newest ? { state: newest.state, txn: newest.id } : null;
}

// ---------------------------------------------------------------- trunk

export type TrunkTick = { key: string; x: number; seq: number; sha: string; txn: string | null; recall: string | null; title: string };
export type TrunkBlock = { key: string; train: string | null; at: number; x: number; w: number; ticks: TrunkTick[] };

// Commits of one train land at the same instant, so on a time axis they would be one dot. A train is
// drawn as a capsule of evenly spaced dots; blocks that would collide are pushed right, never reordered.
export function layoutTrunk(ticks: readonly Tick[], scale: Scale): TrunkBlock[] {
  const groups = new Map<string, Tick[]>();
  for (const k of [...ticks].sort((a, b) => a.at - b.at || a.seq - b.seq)) {
    if (k.at < scale.t0 || k.at > scale.t1) continue;
    const key = k.train ? `train:${k.train}` : `seq:${k.seq}`;
    const g = groups.get(key) ?? [];
    g.push(k);
    groups.set(key, g);
  }
  const blocks: TrunkBlock[] = [];
  let cursor = -Infinity;
  for (const [key, g] of groups) {
    const w = (g.length - 1) * DOT_GAP;
    const x = Math.min(Math.max(toX(scale, g[0]!.at), cursor + BLOCK_GAP), Math.max(scale.x1 - w, scale.x0));
    cursor = x + w;
    blocks.push({
      key,
      train: g[0]!.train,
      at: g[0]!.at,
      x,
      w,
      ticks: g.map((k, i) => ({
        key: `${k.seq}:${k.sha}`,
        x: x + i * DOT_GAP,
        seq: k.seq,
        sha: k.sha,
        txn: k.txn,
        recall: k.recall,
        // No txn means the seed, or the revert commit of a recall: only the recall id tells them apart.
        title: `${k.txn ?? (k.recall ? `recall ${k.recall}` : "seed")} · seq ${k.seq} · ${shortSha(k.sha)}${k.train ? ` · ${k.train}` : ""}`,
      })),
    });
  }
  return blocks;
}

// A landing that made other transactions stale, drawn as a guide from its commit on the trunk with a branch to
// the stale notch of each attempt it caught: read-set validation, visible. A notch falls when its attempt learns it
// is stale (at the landing if it was waiting, at its own submit if it was still working), so each branch runs from
// the culprit's commit to wherever its notch fell. `x` is the commit's dot; `bottom` is the lowest row reached.
export type Wave = { culprit: string; x: number; victims: { row: number; lane: number; lanes: number; x: number }[]; bottom: number };

export function staleWaves(rows: readonly Row[], blocks: readonly TrunkBlock[]): Wave[] {
  const dots = new Map<string, number>();
  for (const b of blocks) for (const t of b.ticks) if (t.txn) dots.set(t.txn, t.x);
  const found = new Map<string, Wave>();
  for (const row of rows) {
    for (const bar of row.bars) {
      if (bar.mark?.kind !== "stale") continue;
      for (const by of new Set(bar.stale.map((p) => p.by))) {
        const x = by ? dots.get(by) : undefined;
        if (!by || x === undefined) continue;
        const w = found.get(by) ?? { culprit: by, x, victims: [], bottom: row.index };
        w.victims.push({ row: row.index, lane: bar.lane, lanes: bar.lanes, x: bar.mark.x });
        w.bottom = Math.max(w.bottom, row.index);
        found.set(by, w);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.x - b.x);
}

// A block counts as arriving for a moment after it lands; the CSS animation runs once, when the class first appears.
export const ARRIVE_MS = 1500;
export function isArriving(blockAt: number, now: number): boolean {
  return now - blockAt >= 0 && now - blockAt < ARRIVE_MS;
}

// ---------------------------------------------------------------- heat

// A full bar is twice the hot threshold, so the threshold mark sits at the middle of every track.
export const HEAT_FULL = HOT * 2;
export const HEAT_COLD_BELOW = 0.05;
export const HEAT_HOT_AT = HOT / HEAT_FULL;

export function heatFraction(value: number): number {
  if (!(value >= HEAT_COLD_BELOW)) return 0;
  return Math.min(1, Math.max(value / HEAT_FULL, 0.03));
}

export type HeatRow = { path: string; value: number; hot: boolean; fraction: number };

// The listing gives the cold rows, the op log the warm ones; a path heated but absent from the listing
// (deleted since, or the listing failed) still shows.
export function heatRows(files: readonly string[] | null, heat: readonly { path: string; value: number; hot: boolean }[]): HeatRow[] {
  const byPath = new Map<string, HeatRow>();
  for (const f of files ?? []) byPath.set(f, { path: f, value: 0, hot: false, fraction: 0 });
  for (const h of heat) {
    const value = h.value >= HEAT_COLD_BELOW ? h.value : 0;
    byPath.set(h.path, { path: h.path, value, hot: h.hot && value > 0, fraction: heatFraction(value) });
  }
  return [...byPath.values()].sort((a, b) => b.value - a.value || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const formatHeat = (value: number): string => (value > 0 ? value.toFixed(1) : "·");

// ---------------------------------------------------------------- right rail

const ABORT_LABEL: Record<string, string> = {
  stale_read: "stale read",
  text_conflict: "text conflict",
  failed_verify: "failed verify",
  duplicate: "duplicate",
  max_attempts: "max attempts",
};

export function abortRows(aborts: Record<string, number>): { cause: string; label: string; count: number }[] {
  return Object.entries(aborts)
    .filter(([, n]) => n > 0)
    .map(([cause, count]) => ({ cause, label: ABORT_LABEL[cause] ?? cause.replace(/_/g, " "), count }))
    .sort((a, b) => b.count - a.count || (a.cause < b.cause ? -1 : 1));
}

// What the Run demo button reports. The endpoint may not exist yet, so the status is always shown.
export function demoResult(status: number, body: string): { ok: boolean; needsToken: boolean; text: string } {
  if (status >= 200 && status < 300) return { ok: true, needsToken: false, text: `started · HTTP ${status}` };
  let error = "";
  try {
    const v = JSON.parse(body) as { error?: unknown };
    if (typeof v.error === "string") error = v.error;
  } catch {
    // not JSON: the status alone is the message
  }
  return { ok: false, needsToken: status === 401, text: clipText(`HTTP ${status}${error ? ` · ${error}` : ""}`, 80) };
}

// ---------------------------------------------------------------- ticker

export type Signal = "go" | "stop" | "caution" | "run" | "recall";

export function kindSignal(kind: OpKind): Signal | null {
  switch (kind) {
    case "txn.landed":
    case "trunk.advanced":
      return "go";
    case "txn.stale":
    case "txn.failed":
    case "txn.rejected":
    case "txn.aborted":
    case "trunk.diverged":
      return "stop";
    case "txn.needs_human":
    case "stale.warning":
    case "lease.waiting":
    case "dup.warning":
    case "conflict.warning":
      return "caution";
    case "txn.verifying":
    case "train.formed":
    case "train.confirmed":
      return "run";
    case "txn.recalled":
    case "recall.planned":
    case "recall.done":
      return "recall";
    default:
      return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);
function list(items: string[], max = 2): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max}`;
}

export function shortData(op: Op): string {
  const d = op.data;
  switch (op.kind) {
    case "txn.open":
      return Number(d.attempt) > 1 ? `attempt ${d.attempt} · ${str(d.intent)}` : str(d.intent);
    case "txn.submitted":
      return strs(d.writes).length ? `writes ${list(strs(d.writes))}` : "";
    case "txn.ready":
      return strs(d.unionTouched).length ? `union ${list(strs(d.unionTouched))}` : "";
    case "txn.verifying":
      return str(d.train);
    case "txn.landed":
      return `seq ${str(d.seq)} ${shortSha(str(d.sha))}`;
    case "txn.stale":
      return staleDetail(
        (Array.isArray(d.paths) ? d.paths : []).map((p: { path?: unknown; by?: unknown }) => ({ path: str(p.path), by: p.by ? str(p.by) : null })),
        str(d.reason) || null,
      );
    case "txn.failed":
      return str(d.failures?.[0]?.name) || str(d.reason);
    case "txn.needs_human":
    case "txn.aborted":
    case "txn.rejected":
    case "txn.recalled":
      return str(d.reason);
    case "trunk.advanced":
      return `seq ${str(d.seq)} ${shortSha(str(d.sha))}${d.train ? ` ${str(d.train)}` : ""}${d.recall ? ` recall ${str(d.recall)}` : ""}`;
    case "trunk.diverged":
      return `store ${shortSha(str(d.store))} ≠ ledger ${shortSha(str(d.ledger))}`;
    case "train.formed": {
      const n = strs(d.txns).length;
      return `${str(d.train)} · ${n} txn${n === 1 ? "" : "s"}${d.after ? ` · on ${str(d.after)}` : ""}`;
    }
    case "train.confirmed":
      return `${str(d.train)} · ${str(d.after)} landed its base`;
    case "train.bisect":
      return `probe ${strs(d.probe).length} · ${d.pass ? "pass" : "fail"}`;
    case "train.done":
      return `${str(d.train)} · ${str(d.outcome)}`;
    case "stale.warning":
      return list(strs(d.paths));
    case "heat.changed":
      return `${str(d.path)} ${Number.isFinite(Number(d.value)) ? Number(d.value).toFixed(1) : "?"}${d.hot ? " hot" : ""}`;
    case "lease.granted":
    case "lease.waiting":
    case "lease.released":
      return str(d.path);
    case "dup.warning":
    case "conflict.warning":
      return `with ${str(d.other)}`;
    case "judge.verdict":
      return `${str(d.question)} ${str(d.value)}`;
    case "reads.fallback":
      return `${str(d.count)} paths`;
    case "recall.planned":
      return `${str(d.recall)} · ${strs(d.targets).length} targets`;
    case "recall.done":
      return `${str(d.recall)} · ${str(d.outcome)}`;
    case "policy.updated":
      return d.error ? `error ${str(d.error)}` : shortSha(str(d.sha));
    default:
      return "";
  }
}

export function tickerLine(op: Op): { seq: string; kind: string; txn: string; agent: string; data: string; signal: Signal | null } {
  return { seq: String(op.seq), kind: op.kind, txn: op.txn ?? "", agent: op.agent ?? "", data: clipText(shortData(op), 160), signal: kindSignal(op.kind) };
}

// ---------------------------------------------------------------- hover card

export type Tip = { id: string; attempt: number; status: string; intent: string; rows: [string, string][]; staleBy: string | null };

const SEGMENT_NAME: Record<string, string> = { open: "working", submitted: "queued", ready: "queued", verifying: "verifying", needs_human: "with a human", lease_wait: "waiting for a lease" };

// What the card on a hovered bar says: who, what, how long, where the time went and how it ended.
export function tipFor(txn: TxnView, a: AttemptView, now: number): Tip {
  const end = a.end ?? now;
  const status = a.outcome ?? a.segments.at(-1)?.state ?? "open";
  const spent = new Map<string, number>();
  for (const seg of a.segments) {
    const name = SEGMENT_NAME[seg.state] ?? seg.state;
    spent.set(name, (spent.get(name) ?? 0) + Math.max(0, (seg.to ?? end) - seg.from));
  }
  const rows: [string, string][] = [["Agent", txn.model ? `${txn.agent} · ${modelLabel(txn.model)}` : txn.agent]];
  rows.push(["Time", `${duration(end - a.start)}${a.end === null ? " so far" : ""}`]);
  const split = [...spent].filter(([, ms]) => ms >= 50).map(([name, ms]) => `${name} ${duration(ms)}`);
  if (split.length > 1) rows.push(["Spent", split.join(" · ")]);
  if (a.outcome === "stale") {
    const detail = staleDetail(a.stale, a.reason);
    if (detail) rows.push(["Stale", detail]);
  } else if (a.reason) rows.push(["Reason", reasonLabel(a.reason)]);
  if (a.warnings.length > 0) rows.push(["Warned", [...new Set(a.warnings.flatMap((w) => w.paths))].join(", ") || `${a.warnings.length}×`]);
  if (txn.state === "recalled") rows.push(["Recalled", txn.reason ? reasonLabel(txn.reason) : "reverted from trunk"]);
  return { id: txn.id, attempt: a.attempt, status: txn.state === "recalled" && a.outcome === "landed" ? "recalled" : status, intent: txn.intent, rows, staleBy: a.stale[0]?.by ?? null };
}
