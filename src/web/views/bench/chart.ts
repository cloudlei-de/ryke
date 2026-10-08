// Pure geometry, grouping and formatting for the Bench view's hand-written SVG charts (PLAN.md §12).
// Kept free of React and the DOM so every rule is table-tested.
import { POLICIES, type BenchCell, type BenchPolicy } from "../../../shared/bench";

export type Point = { agents: number; value: number };

export function measuredAgents(cells: readonly BenchCell[]): number[] {
  return [...new Set(cells.map((c) => c.agents))].sort((a, b) => a - b);
}

export function seriesByPolicy(cells: readonly BenchCell[], metric: (c: BenchCell) => number): Record<BenchPolicy, Point[]> {
  const out = { lock: [], queue: [], ryke: [] } as Record<BenchPolicy, Point[]>;
  for (const policy of POLICIES) {
    // A Map so a repeated (policy, agents) pair is one point, not a vertical jump in the line.
    const byAgents = new Map<number, number>();
    for (const c of cells) if (c.policy === policy) byAgents.set(c.agents, metric(c));
    out[policy] = [...byAgents].map(([agents, value]) => ({ agents, value })).sort((a, b) => a.agents - b.agents);
  }
  return out;
}

export type XScale = { kind: "log" | "linear"; x: (agents: number) => number; ticks: number[] };

// The measured Ns are 10, 50, 100, 200 in the plan: on a linear axis the first two would sit on top of
// each other, so a range of 4x or more is spaced logarithmically.
export function makeXScale(ns: readonly number[], x0: number, x1: number): XScale {
  const ticks = [...new Set(ns)].sort((a, b) => a - b);
  const lo = ticks[0];
  const hi = ticks.at(-1);
  if (lo === undefined || hi === undefined || lo === hi) return { kind: "linear", x: () => (x0 + x1) / 2, ticks };
  const log = lo > 0 && hi / lo >= 4;
  const f = log ? Math.log : (v: number) => v;
  const span = f(hi) - f(lo);
  return { kind: log ? "log" : "linear", x: (n) => x0 + ((f(n) - f(lo)) / span) * (x1 - x0), ticks };
}

const round9 = (v: number) => Math.round(v * 1e9) / 1e9;

// Ticks 0..max at a 1, 2, 5 x 10^k step; `max` is the last tick, never below the data.
export function niceTicks(max: number, want = 4): { ticks: number[]; max: number } {
  if (!Number.isFinite(max) || max <= 0) return { ticks: [0, 1], max: 1 };
  const raw = max / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const count = Math.ceil(max / step - 1e-9);
  const ticks = Array.from({ length: count + 1 }, (_, i) => round9(i * step));
  return { ticks, max: ticks.at(-1)! };
}

const r1 = (v: number) => String(Math.round(v * 10) / 10);

export function linePath(pts: readonly { x: number; y: number }[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${r1(p.x)} ${r1(p.y)}`).join("");
}

// End-of-line labels that would overlap are pushed apart around the centre of their cluster, so each
// label stays as close as possible to its own line. The result is in input order. When [lo, hi] is too
// small for the labels they overflow downward rather than overlap.
export function spreadLabels(ys: readonly number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((y, i) => i).sort((a, b) => ys[a]! - ys[b]! || a - b);
  type Group = { members: number[]; top: number };
  const place = (members: number[]): Group => {
    const mean = members.reduce((sum, i) => sum + ys[i]!, 0) / members.length;
    return { members, top: mean - ((members.length - 1) * gap) / 2 };
  };
  const groups: Group[] = [];
  for (const i of order) {
    groups.push(place([i]));
    // Merging can create a new overlap with the group before, so keep folding back.
    while (groups.length > 1) {
      const cur = groups[groups.length - 1]!;
      const prev = groups[groups.length - 2]!;
      if (cur.top >= prev.top + prev.members.length * gap - 1e-9) break;
      groups.splice(-2, 2, place([...prev.members, ...cur.members]));
    }
  }
  const sorted = groups.flatMap((g) => g.members.map((m, k) => ({ m, y: g.top + k * gap })));
  for (let k = sorted.length - 1; k >= 0; k--) sorted[k]!.y = Math.min(sorted[k]!.y, k === sorted.length - 1 ? hi : sorted[k + 1]!.y - gap);
  for (let k = 0; k < sorted.length; k++) sorted[k]!.y = Math.max(sorted[k]!.y, k === 0 ? lo : sorted[k - 1]!.y + gap);
  const out = new Array<number>(ys.length);
  for (const { m, y } of sorted) out[m] = y;
  return out;
}

// Width of the column right of the plot that holds the end-of-line labels ("queue 13,400"), from the
// longest label, because a fixed gutter clips them on a phone. 6 px a character is the sans at 12 px, 6.6 the mono at 11 px.
export function endGutter(cells: readonly BenchCell[], metric: (c: BenchCell) => number, digits: number, min = 60): number {
  const series = seriesByPolicy(cells, metric);
  let widest = 0;
  for (const policy of POLICIES) {
    const last = series[policy].at(-1);
    if (last) widest = Math.max(widest, policy.length * 6 + 6 + fmtNum(last.value, digits).length * 6.6);
  }
  return Math.max(min, Math.ceil(14 + widest + 6));
}

export function causeLabel(cause: string): string {
  return cause.replaceAll("_", " ");
}

// The stack needs a distinguishable fill per cause, so beyond `keep` causes the tail is one "other" bucket.
export function abortCauses(cells: readonly BenchCell[], keep = 4): string[] {
  const totals = new Map<string, number>();
  for (const c of cells) for (const [cause, n] of Object.entries(c.aborts)) if (n > 0) totals.set(cause, (totals.get(cause) ?? 0) + n);
  const names = [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([cause]) => cause);
  const head = names.slice(0, keep);
  if (names.length > keep && !head.includes("other")) head.push("other");
  return head;
}

export type Segment = { cause: string; value: number };

export function abortSegments(aborts: Record<string, number>, causes: readonly string[]): Segment[] {
  const named = causes.filter((c) => c !== "other");
  const count = (cause: string) => (Number.isFinite(aborts[cause]) && aborts[cause]! > 0 ? aborts[cause]! : 0);
  const out: Segment[] = [];
  for (const cause of causes) {
    const value = cause === "other" ? Object.keys(aborts).reduce((sum, k) => (named.includes(k) ? sum : sum + count(k)), 0) : count(cause);
    if (value > 0) out.push({ cause, value });
  }
  return out;
}

// Segments stack upward from `baseline`. A segment gives up `gap` px at its top so neighbours read as
// separate without a stroke; the top one keeps its full height and a thin segment is never trimmed away.
export function stackLayout(segs: readonly Segment[], px: (value: number) => number, baseline: number, gap: number) {
  let cursor = baseline;
  return segs.map((s, i) => {
    const h = px(s.value);
    const top = cursor - h;
    cursor = top;
    const trim = i === segs.length - 1 ? 0 : Math.min(gap, h / 2);
    return { ...s, y: top + trim, h: h - trim };
  });
}

// Bars of one cluster (one per policy) sit around the N's x. They shrink so the two closest clusters
// never touch, down to a visible minimum.
export function clusterLayout(xs: readonly number[], bars: number, maxBar = 16, gap = 2): { width: number; offsets: number[] } {
  const sorted = [...xs].sort((a, b) => a - b);
  let spacing = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sorted.length; i++) spacing = Math.min(spacing, sorted[i]! - sorted[i - 1]!);
  const fit = Math.floor((spacing * 0.8 - gap * Math.max(0, bars - 1)) / Math.max(1, bars));
  const width = Math.max(3, Math.min(maxBar, fit));
  return { width, offsets: Array.from({ length: bars }, (_, k) => (k - (bars - 1) / 2) * (width + gap)) };
}

export function fmtNum(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Axis ticks: 10000 -> 10k, so a tick label stays narrower than the gutter it sits in.
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  if (Math.abs(n) >= 1e6) return `${trim(n / 1e6)}M`;
  if (Math.abs(n) >= 1e3) return `${trim(n / 1e3)}k`;
  return trim(n);
}

export function fmtGenerated(iso: string | null): string {
  if (iso === null) return "not run yet";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : `${t.toISOString().slice(0, 10)} ${t.toISOString().slice(11, 16)} UTC`;
}

export type TableRow = {
  key: string;
  policy: BenchPolicy;
  agents: string;
  landed: string;
  perMinute: string;
  p50: string;
  p95: string;
  aborts: string;
  abortTotal: number;
  verifyRuns: string;
  wasted: string;
  breakages: number;
};

export function tableRows(cells: readonly BenchCell[]): TableRow[] {
  return [...cells]
    .sort((a, b) => a.agents - b.agents || POLICIES.indexOf(a.policy) - POLICIES.indexOf(b.policy))
    .map((c) => {
      const causes = Object.entries(c.aborts)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      return {
        key: `${c.policy}-${c.agents}`,
        policy: c.policy,
        agents: fmtNum(c.agents, 0),
        landed: fmtNum(c.landed, 0),
        perMinute: fmtNum(c.landedPerMinute, 1),
        p50: fmtNum(c.p50, 1),
        p95: fmtNum(c.p95, 1),
        aborts: causes.length === 0 ? "none" : causes.map(([cause, n]) => `${causeLabel(cause)} ${n}`).join(" · "),
        abortTotal: causes.reduce((sum, [, n]) => sum + n, 0),
        verifyRuns: fmtNum(c.verifyRunsPerLanded, 2),
        wasted: fmtNum(c.wastedAgentSeconds, 0),
        breakages: c.trunkBreakages,
      };
    });
}

// The one sentence the page leads with: the three policies side by side at the largest N they share.
export function headline(cells: readonly BenchCell[]): { agents: number; values: Record<BenchPolicy, number> } | null {
  for (const agents of measuredAgents(cells).reverse()) {
    const at = POLICIES.map((p) => cells.find((c) => c.policy === p && c.agents === agents));
    if (at.every((c) => c !== undefined)) {
      return { agents, values: { lock: at[0]!.landedPerMinute, queue: at[1]!.landedPerMinute, ryke: at[2]!.landedPerMinute } };
    }
  }
  return null;
}

export const POLICY_NAME: Record<BenchPolicy, string> = { lock: "Global lock", queue: "Merge queue", ryke: "Ryke" };

// Each policy's best throughput and where it was measured, for the cards over the charts.
export function peaks(cells: readonly BenchCell[]): Record<BenchPolicy, { agents: number; value: number } | null> {
  const out = { lock: null, queue: null, ryke: null } as Record<BenchPolicy, { agents: number; value: number } | null>;
  for (const c of cells) {
    const best = out[c.policy];
    if (!best || c.landedPerMinute > best.value || (c.landedPerMinute === best.value && c.agents < best.agents)) out[c.policy] = { agents: c.agents, value: c.landedPerMinute };
  }
  return out;
}

// "2.0×": how many times the baseline Ryke lands; null when the baseline landed nothing to compare with.
export function ratio(ryke: number, baseline: number): string | null {
  if (!(baseline > 0) || !Number.isFinite(ryke)) return null;
  return `${(ryke / baseline).toFixed(1)}×`;
}

// The page states BENCH_SYNTHETIC_NOTICE itself, so the results file's note loses any sentence that only says it
// again ("Synthetic agents: real git, …"); the run settings after it stay.
export function noteDetail(note: string, notice: string): string {
  const tail = notice.slice(notice.indexOf(":") + 1).trim().toLowerCase();
  return note
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !(tail && sentence.trim().toLowerCase().endsWith(tail)))
    .join(" ")
    .trim();
}
