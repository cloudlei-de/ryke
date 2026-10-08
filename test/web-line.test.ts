import { describe, expect, it } from "vitest";
import { counters, fold, heatAt, type AttemptView, type LineState, type Tick, type TxnView } from "../src/shared/reducers";
import { OP_KINDS, type Op, type OpKind } from "../src/shared/types";
import {
  abortRows,
  activityStart,
  assignLanes,
  axisStep,
  axisTicks,
  barHeight,
  agentStatus,
  barLabel,
  BLOCK_GAP,
  buildRows,
  CHAR_W,
  clampX,
  clipText,
  demoResult,
  DOT_GAP,
  formatClock,
  formatHeat,
  heatFraction,
  heatRows,
  idleView,
  isArriving,
  kindSignal,
  laneBox,
  layoutBar,
  layoutTrunk,
  liveWindow,
  LIVE_MAX_MS,
  MIN_BAR_W,
  LABEL_MIN_W,
  opBounds,
  plotBox,
  replayWindow,
  ROW_H,
  ROW_MAX,
  rowHeight,
  segmentTone,
  shortData,
  shortSha,
  staleDetail,
  staleLabel,
  staleWaves,
  stateLabel,
  TRUNK_PUSH_MAX,
  tickerLine,
  tipFor,
  toX,
  txnHref,
  type Scale,
} from "../src/web/views/line/geometry";
import e2eLand from "./fixtures/ops/e2e-land.json";

// ---------------------------------------------------------------- builders

let seq = 0;
const op = (kind: OpKind, at: number, data: Record<string, unknown> = {}, txn: string | null = null, agent: string | null = null): Op => ({
  seq: ++seq,
  at,
  kind,
  txn,
  agent,
  data,
});
const open = (txn: string, agent: string, at: number, attempt = 1) => op("txn.open", at, { attempt, intent: `intent of ${txn}` }, txn, agent);
const move = (kind: OpKind, txn: string, agent: string, at: number, data: Record<string, unknown> = {}) => op(kind, at, data, txn, agent);

// 1 ms = 1 px between x = 0 and x = 1000, so expected positions read straight off the timestamps.
const scale: Scale = { t0: 0, t1: 1000, x0: 0, x1: 1000 };
const attemptOf = (s: LineState, txn: string, i = 0): { txn: TxnView; attempt: AttemptView } => {
  const t = s.txns.get(txn)!;
  return { txn: t, attempt: t.attempts[i]! };
};
const bar = (s: LineState, txn: string, now: number, i = 0, sc = scale) => layoutBar({ ...attemptOf(s, txn, i), lane: 0, lanes: 1, scale: sc, now });

const landedFlow = (txn: string, agent: string, t: number, { train = "tr1", n = 1, attempt = 1 } = {}) => [
  open(txn, agent, t, attempt),
  move("txn.submitted", txn, agent, t + 100),
  move("txn.ready", txn, agent, t + 150),
  move("txn.verifying", txn, agent, t + 200, { train }),
  move("txn.landed", txn, agent, t + 400, { train, sha: `sha${n}`.padEnd(40, "0"), seq: n }),
];

// ---------------------------------------------------------------- scale

describe("toX and clampX", () => {
  const s: Scale = { t0: 1000, t1: 2000, x0: 100, x1: 600 };
  it.each([
    [1000, 100],
    [1500, 350],
    [2000, 600],
    [500, -150],
    [2500, 850],
  ])("toX(%d) = %d", (t, x) => expect(toX(s, t)).toBe(x));
  it("collapses to x0 when the window is empty or reversed", () => {
    expect(toX({ t0: 5, t1: 5, x0: 10, x1: 20 }, 9)).toBe(10);
    expect(toX({ t0: 9, t1: 5, x0: 10, x1: 20 }, 7)).toBe(10);
  });
  it.each([
    [-5, 100],
    [100, 100],
    [350, 350],
    [600, 600],
    [900, 600],
  ])("clampX(%d) = %d", (x, out) => expect(clampX(s, x)).toBe(out));
});

describe("plotBox", () => {
  it.each([
    [1440, { labelW: 150, x0: 160, x1: 1416 }],
    [640, { labelW: 150, x0: 160, x1: 616 }],
    [639, { labelW: 84, x0: 94, x1: 615 }],
    [390, { labelW: 84, x0: 94, x1: 366 }],
    [50, { labelW: 84, x0: 94, x1: 134 }],
  ])("width %d", (w, box) => expect(plotBox(w)).toEqual(box));
});

// ---------------------------------------------------------------- windows

describe("activityStart", () => {
  const s = fold([
    open("old", "a1", 100),
    move("txn.aborted", "old", "a1", 200, { reason: "max_attempts" }),
    open("recent", "a2", 5000),
    move("txn.submitted", "recent", "a2", 5100),
    move("txn.landed", "recent", "a2", 5200, { sha: "s", seq: 1 }),
    open("running", "a3", 7000),
  ]);
  it.each([
    [0, 100],
    [150, 100], // old ended at 200 >= 150, so it is still on screen
    [201, 5000], // old ended before the window
    [5200, 5000], // ended exactly at the edge counts
    [5201, 7000],
  ])("notBefore %d starts at %d", (nb, expected) => expect(activityStart(s, nb)).toBe(expected));
  it("is null when nothing is on screen or nothing exists", () => {
    expect(activityStart(fold([]), 0)).toBeNull();
    const done = fold([open("t", "a", 1), move("txn.aborted", "t", "a", 2, { reason: "x" })]);
    expect(activityStart(done, 10)).toBeNull();
  });
});

describe("liveWindow", () => {
  const MIN = 60_000;
  const now = 10_000_000;
  const cases: [string, number | null, number][] = [
    // [name, now - first, expected window length]
    ["no data yet", null, MIN],
    ["a fresh swarm", 0, MIN],
    ["30 s of data", 30_000, MIN],
    ["just inside the usable 94% of one minute", 56_000, MIN],
    ["just past it steps up to a minute and a half", 57_000, 1.5 * MIN],
    ["eighty seconds still fits a minute and a half", 80_000, 1.5 * MIN],
    ["ninety seconds needs two minutes", 90_000, 2 * MIN],
    ["just inside the usable 94% of two minutes", 110_000, 2 * MIN],
    ["two and a half minutes", 150_000, 3 * MIN],
    ["three and a half minutes", 210_000, 4 * MIN],
    ["four minutes", 225_000, 4 * MIN],
    ["four and a half minutes", 270_000, 5 * MIN],
    ["six minutes", 360_000, 7 * MIN],
    ["eight minutes", 480_000, 10 * MIN],
    ["just inside the usable 94% of ten minutes", 560_000, 10 * MIN],
  ];
  it.each(cases)("%s", (_name, age, length) => {
    const w = liveWindow(now, age === null ? null : now - age);
    expect(w.end - w.start).toBeCloseTo(length, 6);
    expect(w.start).toBeLessThanOrEqual(now - (age ?? 0)); // the first bar is never clipped inside the 10 min range
    expect(w.end).toBeGreaterThan(now); // and now sits inside
  });
  it("anchors at the first bar, with a 2% left margin", () => {
    const w = liveWindow(now, now - 30_000);
    expect(w.start).toBeCloseTo(now - 30_000 - 0.02 * MIN, 6);
  });
  it("stays put while the data grows inside one step, so the scale does not creep", () => {
    const a = liveWindow(now, now - 10_000);
    const b = liveWindow(now + 20_000, now - 10_000);
    expect(b).toEqual(a);
  });
  it("slides once past ten minutes, keeping now 6% inside the right edge", () => {
    const w = liveWindow(now, now - 3_600_000);
    expect(w.end - w.start).toBeCloseTo(10 * MIN, 6);
    expect(w.end).toBeCloseTo(now + 0.06 * 10 * MIN, 6);
  });
  it("treats a first bar in the future (clock skew) as now", () => {
    const w = liveWindow(now, now + 5000);
    expect(w.end - w.start).toBeCloseTo(MIN, 6);
    expect(w.start).toBeLessThanOrEqual(now);
  });
});

// The Replay hands the Line the whole recording and a `now` that moves from the first op to the last one
// (displayNow never goes below the playhead's op), so the window is the same at every position.
describe("replayWindow and opBounds", () => {
  it.each<[string, number | null, number | null, number, [number, number]]>([
    ["scrubbed to the start: the window already reaches the last op", 1000, 61_000, 1000, [1000 - 1200, 61_000 + 1200]],
    ["scrubbed to the middle keeps the whole log", 1000, 61_000, 30_000, [1000 - 1200, 61_000 + 1200]],
    ["playing or paused at the end", 1000, 61_000, 61_000, [1000 - 1200, 61_000 + 1200]],
    ["a clock past the last op (its timestamp is older than an earlier op's) extends the window", 1000, 61_000, 81_000, [1000 - 1600, 81_000 + 1600]],
    ["a very short log gets a 10 s span", 1000, 1500, 1500, [1000 - 200, 11_000 + 200]],
    ["no ops falls back to now", null, null, 5000, [5000 - 200, 15_000 + 200]],
    // The Replay's `now` starts at the first op, so this only guards the arithmetic of the pure function.
    ["a first op later than now is clamped to now", 9000, 9500, 5000, [5000 - 200, 15_000 + 200]],
  ])("%s", (_n, first, last, now, [start, end]) => {
    const w = replayWindow(first, last, now);
    expect(w.start).toBeCloseTo(start, 6);
    expect(w.end).toBeCloseTo(end, 6);
  });
  it("opBounds reads the first and last op time", () => {
    expect(opBounds([])).toEqual({ first: null, last: null });
    expect(opBounds([op("policy.updated", 7), op("policy.updated", 9)])).toEqual({ first: 7, last: 9 });
  });
});

// ---------------------------------------------------------------- axis

describe("axis", () => {
  it.each([
    [60_000, 1000, 10_000], // 5.28 s per 88 px label
    [60_000, 400, 15_000], // 13.2 s
    [300_000, 1000, 30_000], // 26.4 s
    [600_000, 1000, 60_000], // 52.8 s
    [600_000, 300, 300_000], // 176 s
    [10_000, 1000, 1000], // 0.88 s -> the smallest step
    [86_400_000, 300, 3_600_000], // beyond the table: the largest step
    [1000, 0, 120_000], // zero width must not divide by zero: treated as 1 px
  ])("axisStep(span %d ms, %d px) = %d ms", (span, w, step) => expect(axisStep(span, w)).toBe(step));

  it.each([
    [Date.UTC(2026, 9, 8, 14, 3, 7), 1000, 0, "14:03:07"],
    [Date.UTC(2026, 9, 8, 14, 3, 7), 30_000, 0, "14:03:07"],
    [Date.UTC(2026, 9, 8, 14, 3, 0), 60_000, 0, "14:03"],
    [Date.UTC(2026, 9, 8, 14, 3, 0), 3_600_000, 0, "14:03"],
    [Date.UTC(2026, 9, 8, 23, 30, 0), 60_000, 120, "01:30"], // CEST wraps past midnight
    [Date.UTC(2026, 9, 8, 0, 5, 0), 60_000, -300, "19:05"],
    [Date.UTC(2026, 9, 8, 9, 5, 9), 1000, 0, "09:05:09"], // zero padded
  ])("formatClock(%d, step %d, tz %d) = %s", (ms, step, tz, text) => expect(formatClock(ms, step, tz)).toBe(text));

  const t = Date.UTC(2026, 9, 8, 14, 0, 0);
  it("places ticks on clock multiples of the step", () => {
    // 60 s over 600 px: 8.8 s per label -> 10 s steps
    const ticks = axisTicks({ start: t + 3000, end: t + 63_000 }, 600, 0);
    expect(ticks.map((k) => k.label)).toEqual(["14:00:10", "14:00:20", "14:00:30", "14:00:40", "14:00:50", "14:01:00"]);
    expect(ticks[0]!.t).toBe(t + 10_000);
  });
  it("aligns to the viewer's clock, not UTC, in a zone that is not a whole hour from it", () => {
    // Nepal, UTC+5:45: 30 min steps must read :00 and :30 locally, which is :15 and :45 in UTC
    const ticks = axisTicks({ start: t, end: t + 3 * 3_600_000 }, 600, 345);
    expect(ticks.map((k) => k.label)).toEqual(["20:00", "20:30", "21:00", "21:30", "22:00", "22:30"]);
    expect(new Date(ticks[0]!.t).getUTCMinutes()).toBe(15);
  });
  it.each([
    ["reversed window", { start: 10, end: 5 }, 600],
    ["empty window", { start: 5, end: 5 }, 600],
    ["no width", { start: 0, end: 5000 }, 0],
    ["NaN window", { start: NaN, end: 5 }, 600],
  ])("returns nothing for %s", (_n, w, width) => expect(axisTicks(w, width, 0)).toEqual([]));
  it("never emits more than 200 ticks", () => {
    expect(axisTicks({ start: 0, end: 86_400_000 }, 1_000_000, 0)).toHaveLength(200);
  });
});

// ---------------------------------------------------------------- text

describe("text helpers", () => {
  it.each([
    ["agent-07", 14, "agent-07"],
    ["agent-07", 8, "agent-07"],
    ["agent-0701", 8, "agent-0…"],
    ["abc", 1, "…"],
    ["abc", 0, ""],
    ["abc", -3, ""],
    ["", 5, ""],
  ])("clipText(%j, %d) = %j", (s, n, out) => expect(clipText(s, n)).toBe(out));

  it("shortSha is 8 characters and tolerates null", () => {
    expect(shortSha("8bbb4cfcc68b5f06c0058e3d943187c426bd83b5")).toBe("8bbb4cfc");
    expect(shortSha("abc")).toBe("abc");
    expect(shortSha(null)).toBe("");
    expect(shortSha(undefined)).toBe("");
  });

  it.each<[string, { path: string; by: string | null }[], string | null, string, string]>([
    ["one path with its cause", [{ path: "src/format.ts", by: "t_a1" }], "stale_read", "src/format.ts ← t_a1", "stale · src/format.ts ← t_a1"],
    ["path without a known cause", [{ path: "src/format.ts", by: null }], "stale_read", "src/format.ts", "stale · src/format.ts"],
    [
      "three paths collapse to +2",
      [
        { path: "a.ts", by: "t1" },
        { path: "b.ts", by: "t2" },
        { path: "c.ts", by: null },
      ],
      "stale_read",
      "a.ts ← t1 +2",
      "stale · a.ts ← t1 +2",
    ],
    ["text conflict has no stale path", [], "text_conflict", "text conflict", "stale · text conflict"],
    ["no paths and no reason", [], null, "", "stale"],
    ["no paths and another reason", [], "stale_read", "", "stale"],
  ])("staleLabel: %s", (_n, stale, reason, detail, label) => {
    expect(staleDetail(stale, reason)).toBe(detail);
    expect(staleLabel(stale, reason)).toBe(label);
  });

});

describe("barLabel", () => {
  const part = (tone: "open" | "queued", w: number) => ({ tone, x: 100, w });
  const intent = "Add the Energy converter category";
  it.each<[string, string, ReturnType<typeof part> | undefined, ReturnType<typeof barLabel>]>([
    ["writes the whole intent when the working stretch has room", intent, part("open", 400), { text: intent, x: 106, w: 392 }],
    ["clips it to the stretch, 6 px a character inside 6 px of padding each side", intent, part("open", 72), { text: "Add the E…", x: 106, w: 64 }],
    ["needs the minimum width", intent, part("open", LABEL_MIN_W - 1), null],
    ["writes nothing on a queued stretch", intent, part("queued", 400), null],
    ["writes nothing without an intent", "   ", part("open", 400), null],
    ["writes nothing without a first part", intent, undefined, null],
  ])("%s", (_n, text, first, out) => expect(barLabel(text, first)).toEqual(out));
  it("keeps a label at least six characters long", () => {
    const w = LABEL_MIN_W;
    const label = barLabel(intent, part("open", w));
    expect(label!.text.length).toBe(Math.floor((w - 12) / CHAR_W));
    expect(label!.text.length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------- bars

describe("segmentTone and stateLabel", () => {
  it.each([
    ["open", false, "open"],
    ["submitted", false, "queued"],
    ["ready", false, "queued"],
    ["verifying", false, "verify"],
    ["verifying", true, "landed"],
    ["needs_human", false, "human"],
    ["lease_wait", false, "lease"],
    ["landed", false, "open"],
    ["stale", false, "open"],
  ] as const)("%s (landed=%s) -> %s", (state, landed, tone) => expect(segmentTone(state, landed)).toBe(tone));
  it("makes lease_wait and needs_human readable and leaves the rest", () => {
    expect(stateLabel("lease_wait")).toBe("waiting for lease");
    expect(stateLabel("needs_human")).toBe("needs human");
    expect(stateLabel("verifying")).toBe("verifying");
  });
});

describe("assignLanes", () => {
  const lanes = (items: [string, number, number][]) => {
    const r = assignLanes(items.map(([key, from, to]) => ({ key, from, to })));
    return { lane: Object.fromEntries(r.lane), count: r.count };
  };
  it.each([
    ["no attempts still reserves one lane", [], {}, 1],
    ["one attempt", [["a", 0, 10]], { a: 0 }, 1],
    ["sequential attempts share a lane", [["a", 0, 10], ["b", 20, 30]], { a: 0, b: 0 }, 1],
    ["touching attempts (stale then retry) share a lane", [["a", 0, 10], ["b", 10, 30]], { a: 0, b: 0 }, 1],
    ["overlap opens a second lane", [["a", 0, 10], ["b", 5, 30]], { a: 0, b: 1 }, 2],
    ["a freed lane is reused", [["a", 0, 10], ["b", 5, 30], ["c", 12, 20]], { a: 0, b: 1, c: 0 }, 2],
    ["three at once", [["a", 0, 100], ["b", 1, 100], ["c", 2, 100]], { a: 0, b: 1, c: 2 }, 3],
    ["input order does not matter", [["b", 5, 30], ["a", 0, 10]], { a: 0, b: 1 }, 2],
    ["a zero-length attempt does not block its lane", [["a", 5, 5], ["b", 5, 9]], { a: 0, b: 0 }, 1],
  ] as [string, [string, number, number][], Record<string, number>, number][])("%s", (_n, items, lane, count) => {
    expect(lanes(items)).toEqual({ lane, count });
  });
});

describe("laneBox", () => {
  it.each([
    [0, 1, { y: 3.5, h: 11 }],
    [0, 0, { y: 3.5, h: 11 }],
    [0, 2, { y: 2, h: 6.5 }],
    [1, 2, { y: 9.5, h: 6.5 }],
    [2, 3, { y: 12, h: 4 }],
  ])("lane %d of %d in an 18 px row", (lane, lanes, box) => expect(laneBox(lane, lanes, 18)).toEqual(box));
});

describe("rowHeight and barHeight", () => {
  it.each([
    ["thirty agents in 560 px get 18 px rows", 30, 560, 18],
    ["thirty agents in 480 px fit exactly at the minimum", 30, 480, ROW_H],
    ["more agents than fit never go below the minimum (the panel scrolls)", 45, 560, ROW_H],
    ["twelve agents grow into the space, up to the cap", 12, 560, ROW_MAX],
    ["sixteen agents take what is left", 16, 500, 31],
    ["thirty agents fit the 500 px a 1440x900 Line has for rows", 30, 497, 16],
    ["twenty agents take what is left", 20, 560, 28],
    ["a single agent is capped", 1, 560, ROW_MAX],
    ["no agents", 0, 560, ROW_H],
    ["not measured yet", 12, 0, ROW_H],
    ["negative space", 12, -50, ROW_H],
    ["NaN space", 12, NaN, ROW_H],
  ])("%s", (_n, count, avail, h) => expect(rowHeight(count, avail)).toBe(h));

  it.each([
    [18, 11],
    [22, 13],
    [24, 14],
    [28, 17],
    [32, 19],
    [40, 20],
    [10, 10],
  ])("barHeight(%d) = %d", (row, h) => expect(barHeight(row)).toBe(h));

  it("centres the single-lane bar in a taller row and splits a tall row between lanes", () => {
    expect(laneBox(0, 1, 32)).toEqual({ y: 6.5, h: 19 });
    expect(laneBox(1, 2, 32)).toEqual({ y: 2 + 13.5 + 1, h: 13.5 });
  });
});

describe("layoutBar", () => {
  it("draws a running open attempt as an outline reaching now, without a mark", () => {
    const s = fold([open("t1", "a1", 100)]);
    const b = bar(s, "t1", 400)!;
    expect(b.parts).toEqual([{ tone: "open", x: 100, w: 300 }]);
    expect([b.x, b.w, b.running, b.mark, b.strike]).toEqual([100, 300, true, null, null]);
    expect(b.href).toBe("#/t/t1");
    expect(b.key).toBe("t1#1");
    // the intent is written inside the working stretch
    expect(b.label).toEqual({ text: "intent of t1", x: 106, w: 292 });
    expect(b.stale).toEqual([]);
  });

  it("builds a landed attempt from its segments, with the verifying stretch green and a landed mark at the end", () => {
    const s = fold(landedFlow("t1", "a1", 100));
    const b = bar(s, "t1", 900)!;
    expect(b.parts.map((p) => p.tone)).toEqual(["open", "queued", "queued", "landed"]);
    expect(b.parts.map((p) => [p.x, p.w])).toEqual([
      [100, 100],
      [200, 50],
      [250, 50],
      [300, 200],
    ]);
    expect(b.mark).toEqual({ kind: "landed", x: 500 });
    expect(b.running).toBe(false);
    expect(b.strike).toBeNull();
    expect([b.x, b.w]).toEqual([100, 400]);
  });

  it("keeps verifying blue while the train runs", () => {
    const s = fold([...landedFlow("t1", "a1", 100).slice(0, 4)]);
    const b = bar(s, "t1", 600)!;
    expect(b.parts.at(-1)).toEqual({ tone: "verify", x: 300, w: 300 });
    expect(b.mark).toBeNull();
    expect(b.running).toBe(true);
  });

  it("marks stale at the end of the bar and keeps what went stale for the hover card and the wave", () => {
    const s = fold([
      open("t2", "a2", 100),
      move("txn.submitted", "t2", "a2", 200),
      move("txn.stale", "t2", "a2", 300, { reason: "stale_read", paths: [{ path: "src/format.ts", seq: 4, by: "t_9" }] }),
    ]);
    const b = bar(s, "t2", 900)!;
    expect(b.mark).toEqual({ kind: "stale", x: 300 });
    expect(b.stale).toEqual([{ path: "src/format.ts", by: "t_9" }]);
    expect(b.title).toContain("t2 · attempt 1 · stale (stale_read)");
    expect(b.title).toContain("stale · src/format.ts ← t_9");
    expect(b.title).toContain("intent of t2");
  });

  it("writes no intent on a bar whose working stretch is too narrow", () => {
    const s = fold([open("t2", "a2", 100), move("txn.submitted", "t2", "a2", 130)]);
    expect(bar(s, "t2", 900)!.label).toBeNull();
  });

  it("continues the retry on the same row: two bars, stale first, then an open one", () => {
    const s = fold([
      open("t3", "a3", 100),
      move("txn.stale", "t3", "a3", 200, { reason: "stale_read", paths: [{ path: "x.ts", seq: 1, by: "t_1" }] }),
      open("t3", "a3", 210, 2),
    ]);
    const rows = buildRows(s, scale, 500);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bars.map((b) => [b.key, b.lane, b.lanes, b.mark?.kind ?? null, b.running])).toEqual([
      ["t3#1", 0, 1, "stale", false],
      ["t3#2", 0, 1, null, true],
    ]);
  });

  it.each([
    ["failed", "txn.failed", { reason: "tests" }],
    ["rejected", "txn.rejected", { reason: "duplicate_of:t_1" }],
    ["aborted", "txn.aborted", { reason: "max_attempts" }],
  ] as const)("ends a %s attempt with its own mark at the end of the bar", (kind, opKind, data) => {
    const s = fold([open("t4", "a4", 100), move("txn.submitted", "t4", "a4", 150), move(opKind, "t4", "a4", 250, data)]);
    const b = bar(s, "t4", 900)!;
    expect(b.mark).toEqual({ kind, x: 250 });
    expect(b.title).toContain(`(${data.reason})`);
  });

  it("strikes through a recalled transaction over the whole bar", () => {
    const s = fold([...landedFlow("t5", "a5", 100), move("txn.recalled", "t5", "a5", 700, { reason: "recall" })]);
    const b = bar(s, "t5", 900)!;
    expect(b.mark).toEqual({ kind: "landed", x: 500 });
    expect(b.strike).toEqual({ x1: 100, x2: 500 });
  });

  it("does not strike an attempt that never landed even if the transaction is recalled later", () => {
    const s = fold([
      open("t6", "a6", 100),
      move("txn.stale", "t6", "a6", 150, { reason: "stale_read", paths: [] }),
      ...landedFlow("t6", "a6", 200, { attempt: 2 }),
      move("txn.recalled", "t6", "a6", 800, {}),
    ]);
    expect(bar(s, "t6", 900, 0)!.strike).toBeNull();
    expect(bar(s, "t6", 900, 1)!.strike).not.toBeNull();
  });

  it("puts a tick at each stale warning inside the window", () => {
    const s = fold([open("t7", "a7", 100), op("stale.warning", 250, { paths: ["a.ts"] }, "t7", "a7"), op("stale.warning", 400, { paths: ["b.ts", "c.ts"] }, "t7", "a7")]);
    const b = bar(s, "t7", 500)!;
    expect(b.warnings).toEqual([250, 400]);
    expect(b.title).toContain("warning: a.ts");
    expect(b.title).toContain("warning: b.ts, c.ts");
    // a window that starts at 300 no longer contains the first warning
    const late = bar(s, "t7", 500, 0, { t0: 300, t1: 1000, x0: 0, x1: 1000 })!;
    expect(late.warnings).toHaveLength(1);
    expect(late.warnings[0]).toBeCloseTo(((400 - 300) / 700) * 1000, 6);
  });

  it("shows a lease wait as its own dotted segment between open stretches", () => {
    const s = fold([
      open("t8", "a8", 100),
      op("lease.waiting", 200, { path: "f.ts", owner: "x", retryAfterMs: 500 }, "t8", "a8"),
      op("lease.granted", 350, { path: "f.ts", expires: 9999 }, "t8", "a8"),
    ]);
    const b = bar(s, "t8", 500)!;
    expect(b.parts.map((p) => [p.tone, p.x, p.w])).toEqual([
      ["open", 100, 100],
      ["lease", 200, 150],
      ["open", 350, 150],
    ]);
  });

  it("draws needs_human as its own tone", () => {
    const s = fold([...landedFlow("t9", "a9", 100).slice(0, 4), move("txn.needs_human", "t9", "a9", 400, { reason: "payments" })]);
    const b = bar(s, "t9", 600)!;
    expect(b.parts.at(-1)).toEqual({ tone: "human", x: 400, w: 200 });
    expect(b.title).toContain("needs human");
  });

  it("gives an attempt shorter than half a pixel a minimum visible bar", () => {
    const s = fold([open("t10", "a10", 100), move("txn.rejected", "t10", "a10", 100, { reason: "duplicate_of:t_1" })]);
    const b = bar(s, "t10", 900)!;
    expect(b.parts).toEqual([{ tone: "open", x: 100, w: MIN_BAR_W }]);
    expect(b.w).toBe(MIN_BAR_W);
    expect(b.mark).toEqual({ kind: "rejected", x: 100 + MIN_BAR_W });
  });

  it("clips a bar that starts before the window and drops one that is entirely outside", () => {
    const s = fold([open("t11", "a11", 100), move("txn.submitted", "t11", "a11", 300), move("txn.landed", "t11", "a11", 450, { sha: "s", seq: 1 })]);
    // x = 50 + (t - 200): the attempt begins 150 px left of the plot
    const clipped = bar(s, "t11", 900, 0, { t0: 200, t1: 1200, x0: 50, x1: 1050 })!;
    expect(clipped.parts.map((p) => [p.tone, p.x, p.w])).toEqual([
      ["open", 50, 100],
      ["queued", 150, 150],
    ]);
    expect(clipped.mark).toEqual({ kind: "landed", x: 300 });
    expect(bar(s, "t11", 900, 0, { t0: 500, t1: 1500, x0: 0, x1: 1000 })).toBeNull(); // ended at 450, before the window
    expect(bar(s, "t11", 900, 0, { t0: -900, t1: 50, x0: 0, x1: 1000 })).toBeNull(); // begins after the window
  });

  it("clips a running bar at the right edge without a mark", () => {
    const s = fold([open("t12", "a12", 900)]);
    const b = bar(s, "t12", 5000)!;
    expect([b.x, b.w]).toEqual([900, 100]);
  });

  it("never lets an attempt end before it starts (a clock that went back)", () => {
    const s = fold([open("t13", "a13", 500)]);
    const b = bar(s, "t13", 300)!;
    expect(b.w).toBeGreaterThanOrEqual(MIN_BAR_W);
    expect(b.x).toBe(500);
  });

  it("encodes the transaction id in the link", () => {
    expect(txnHref("t_abc")).toBe("#/t/t_abc");
    expect(txnHref("a b/c")).toBe("#/t/a%20b%2Fc");
  });
});

describe("buildRows", () => {
  it("makes one row per agent in first-seen order, each with its own bars", () => {
    const s = fold([open("t1", "agent-b", 10), open("t2", "agent-a", 20), open("t3", "agent-b", 30), open("t4", "agent-c", 40)]);
    const rows = buildRows(s, scale, 100);
    expect(rows.map((r) => [r.agent, r.index, r.bars.map((b) => b.txn)])).toEqual([
      ["agent-b", 0, ["t1", "t3"]],
      ["agent-a", 1, ["t2"]],
      ["agent-c", 2, ["t4"]],
    ]);
  });

  it("splits overlapping transactions of one agent into sub-lanes", () => {
    const s = fold([open("t1", "a", 10), open("t2", "a", 20), move("txn.landed", "t1", "a", 60, { sha: "s", seq: 1 }), open("t3", "a", 70)]);
    const [row] = buildRows(s, scale, 100);
    expect(row!.bars.map((b) => [b.txn, b.lane, b.lanes])).toEqual([
      ["t1", 0, 2],
      ["t2", 1, 2],
      ["t3", 0, 2],
    ]);
  });

  it("keeps a row for an agent whose bars have all left the window", () => {
    const s = fold([open("t1", "a", 10), move("txn.aborted", "t1", "a", 20, { reason: "x" })]);
    const rows = buildRows(s, { t0: 500, t1: 1500, x0: 0, x1: 1000 }, 900);
    expect(rows).toEqual([{ agent: "a", index: 0, bars: [] }]);
  });

  it("returns no rows for an empty state", () => {
    expect(buildRows(fold([]), scale, 0)).toEqual([]);
  });

  it("scales to thirty agents and beyond", () => {
    const ops = Array.from({ length: 45 }, (_, i) => open(`t${i}`, `agent-${String(i).padStart(2, "0")}`, i * 10));
    const rows = buildRows(fold(ops), scale, 1000);
    expect(rows).toHaveLength(45);
    expect(rows[44]!.index).toBe(44);
    expect(rows.every((r) => r.bars.length === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------- trunk

describe("layoutTrunk", () => {
  const tk = (seq: number, at: number, train: string | null, txn: string | null = `t${seq}`, recall: string | null = null): Tick => ({ seq, sha: `${seq}`.padEnd(40, "a"), txn, train, recall, at });

  it("draws the ticks of one train as one block of evenly spaced ticks", () => {
    const blocks = layoutTrunk([tk(1, 100, "tr1"), tk(2, 100, "tr1"), tk(3, 100, "tr1")], scale);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ key: "train:tr1", train: "tr1", at: 100, x: 100, w: 2 * DOT_GAP });
    expect(blocks[0]!.ticks.map((t) => t.x)).toEqual([100, 100 + DOT_GAP, 100 + 2 * DOT_GAP]);
    expect(blocks[0]!.ticks.map((t) => t.txn)).toEqual(["t1", "t2", "t3"]);
  });

  it("puts the transaction, seq and short sha on the hover title", () => {
    const [b] = layoutTrunk([tk(7, 100, "tr1")], scale);
    expect(b!.ticks[0]!.title).toBe(`t7 · seq 7 · ${"7".padEnd(8, "a")} · tr1`);
  });

  it("titles the seed commit and a commit outside any train", () => {
    const [seed, solo] = layoutTrunk([tk(0, 10, null, null), tk(1, 20, null)], scale);
    expect(seed!.ticks[0]!.title).toBe(`seed · seq 0 · ${"0".padEnd(8, "a")}`);
    expect(solo!.ticks[0]!.title).toBe(`t1 · seq 1 · ${"1".padEnd(8, "a")}`);
  });

  it("titles a recall's revert commit with the recall, not as the seed", () => {
    const [b] = layoutTrunk([tk(7, 100, null, null, "rc_1")], scale);
    expect(b!.ticks[0]).toMatchObject({ txn: null, recall: "rc_1", title: `recall rc_1 · seq 7 · ${"7".padEnd(8, "a")}` });
  });

  it("gives the seed and transactions no recall, and keeps a recall commit in its place after the train it follows", () => {
    const blocks = layoutTrunk([tk(0, 10, null, null), tk(1, 100, "tr1"), tk(2, 400, null, null, "rc_1")], scale);
    expect(blocks.map((b) => b.ticks[0]!.recall)).toEqual([null, null, "rc_1"]);
    expect(blocks.map((b) => b.key)).toEqual(["seq:0", "train:tr1", "seq:2"]);
  });

  it("treats commits without a train as blocks of their own", () => {
    const blocks = layoutTrunk([tk(1, 100, null), tk(2, 100, null)], scale);
    expect(blocks.map((b) => b.key)).toEqual(["seq:1", "seq:2"]);
    // same instant: the second is pushed right of the first by the block gap
    expect(blocks.map((b) => b.x)).toEqual([100, 100 + BLOCK_GAP]);
  });

  it("pushes a colliding block right but never reorders", () => {
    const blocks = layoutTrunk([tk(1, 100, "a"), tk(2, 100, "a"), tk(3, 102, "b"), tk(4, 600, "c")], scale);
    expect(blocks.map((b) => b.train)).toEqual(["a", "b", "c"]);
    expect(blocks[0]!.x).toBe(100);
    // right of block a's last dot would be 100 + DOT_GAP + BLOCK_GAP = 121, more than TRUNK_PUSH_MAX past its time
    expect(blocks[1]!.x).toBe(102 + TRUNK_PUSH_MAX);
    expect(blocks[2]!.x).toBe(600); // far enough away to stay on its time
  });

  it("pushes a block clear of the one before when that keeps it near its time", () => {
    const blocks = layoutTrunk([tk(1, 100, "a"), tk(2, 105, "b")], scale);
    expect(blocks[1]!.x).toBe(100 + BLOCK_GAP);
  });

  it("never draws a commit more than TRUNK_PUSH_MAX right of its time, however crowded the trunk, and never reorders", () => {
    const ticks = Array.from({ length: 40 }, (_, i) => tk(i + 1, 500 + i, null));
    const blocks = layoutTrunk(ticks, scale);
    blocks.forEach((b, i) => {
      expect(b.x - (500 + i)).toBeLessThanOrEqual(TRUNK_PUSH_MAX);
      if (i > 0) expect(b.x).toBeGreaterThanOrEqual(blocks[i - 1]!.x);
    });
  });

  it("spaces a train's dots by the gap it is given", () => {
    const [b] = layoutTrunk([tk(1, 100, "t"), tk(2, 100, "t"), tk(3, 100, "t")], scale, 6);
    expect(b!.ticks.map((t) => t.x)).toEqual([100, 106, 112]);
  });

  it("sorts by time even if the ticks arrive out of order", () => {
    const blocks = layoutTrunk([tk(2, 500, "b"), tk(1, 100, "a")], scale);
    expect(blocks.map((b) => b.train)).toEqual(["a", "b"]);
  });

  it("drops ticks outside the window", () => {
    const blocks = layoutTrunk([tk(1, -5, "a"), tk(2, 500, "b"), tk(3, 1001, "c")], scale);
    expect(blocks.map((b) => b.train)).toEqual(["b"]);
  });

  it("keeps a block that lands at the right edge inside the plot", () => {
    const [b] = layoutTrunk([tk(1, 1000, "a"), tk(2, 1000, "a"), tk(3, 1000, "a")], scale);
    expect(b!.x + b!.w).toBe(1000);
    expect(b!.ticks.at(-1)!.x).toBe(1000);
  });

  it("returns nothing for no ticks", () => {
    expect(layoutTrunk([], scale)).toEqual([]);
  });
});

describe("staleWaves", () => {
  const stale = (txn: string, agent: string, at: number, by: string | null, path = "src/format.ts") => move("txn.stale", txn, agent, at, { reason: "stale_read", paths: [{ path, seq: 1, by }] });
  const trunk = (txn: string, at: number, seq: number) => op("trunk.advanced", at, { seq, sha: `${seq}`.padEnd(40, "0"), txns: [{ txn, sha: `${seq}`.padEnd(40, "0"), seq }], train: null });
  const waves = (s: LineState) => staleWaves(buildRows(s, scale, 1000), layoutTrunk(s.ticks, scale));

  it("drops a guide from the culprit's commit with a branch to each notch it caused, wherever the notch fell", () => {
    const s = fold([
      open("c", "agent-0", 10),
      open("v1", "agent-1", 20),
      open("v2", "agent-2", 30),
      open("v3", "agent-3", 40),
      trunk("c", 300, 1),
      // v1 was waiting for a train and went stale at the landing; v3 was still working and found out at its submit
      stale("v1", "agent-1", 300, "c"),
      stale("v3", "agent-3", 460, "c"),
    ]);
    expect(waves(s)).toEqual([
      {
        culprit: "c",
        x: 300,
        bottom: 3,
        victims: [
          { row: 1, lane: 0, lanes: 1, x: 300 },
          { row: 3, lane: 0, lanes: 1, x: 460 },
        ],
      },
    ]);
  });

  it("starts at the commit's dot even when a crowded trunk pushed it right of its time", () => {
    const s = fold([open("v1", "agent-1", 10), trunk("a", 300, 1), trunk("c", 300, 2), stale("v1", "agent-1", 301, "c")]);
    const [w] = waves(s);
    expect(w).toMatchObject({ culprit: "c", x: 300 + BLOCK_GAP, victims: [{ row: 0, x: 301 }] });
  });

  it("counts a stale attempt once even when several of its paths name the same culprit", () => {
    const s = fold([
      open("v1", "agent-1", 10),
      trunk("c", 300, 1),
      move("txn.stale", "v1", "agent-1", 302, { reason: "stale_read", paths: [{ path: "a.ts", seq: 1, by: "c" }, { path: "b.ts", seq: 1, by: "c" }] }),
    ]);
    expect(waves(s).map((w) => w.victims.length)).toEqual([1]);
  });

  it("gives an attempt made stale by two landings a branch from each", () => {
    const s = fold([
      open("v1", "agent-1", 10),
      trunk("c1", 200, 1),
      trunk("c2", 250, 2),
      move("txn.stale", "v1", "agent-1", 300, { reason: "stale_read", paths: [{ path: "a.ts", seq: 1, by: "c1" }, { path: "b.ts", seq: 2, by: "c2" }] }),
    ]);
    expect(waves(s).map((w) => [w.culprit, w.victims.length])).toEqual([
      ["c1", 1],
      ["c2", 1],
    ]);
  });

  it("draws nothing for a culprit that is not on the trunk in view, or a stale read with no known cause", () => {
    const s = fold([open("v1", "agent-1", 10), open("v2", "agent-2", 20), stale("v1", "agent-1", 302, "gone"), stale("v2", "agent-2", 303, null)]);
    expect(waves(s)).toEqual([]);
  });

  it("orders waves left to right", () => {
    const s = fold([open("v1", "agent-1", 10), open("v2", "agent-2", 20), trunk("c1", 200, 1), trunk("c2", 600, 2), stale("v2", "agent-2", 601, "c2"), stale("v1", "agent-1", 201, "c1")]);
    expect(waves(s).map((w) => w.culprit)).toEqual(["c1", "c2"]);
  });
});

describe("agentStatus", () => {
  it("is the state of the agent's newest transaction", () => {
    const s = fold([...landedFlow("t1", "a", 10), open("t2", "a", 600), open("t3", "b", 20)]);
    expect(agentStatus(s, "a")).toEqual({ state: "open", txn: "t2" });
    expect(agentStatus(s, "b")).toEqual({ state: "open", txn: "t3" });
    expect(agentStatus(s, "nobody")).toBeNull();
  });

  it("follows a retry of an older transaction that started after the newer one", () => {
    const s = fold([open("t1", "a", 10), open("t2", "a", 50), move("txn.stale", "t1", "a", 100, { reason: "stale_read", paths: [] }), open("t1", "a", 110, 2)]);
    expect(agentStatus(s, "a")).toEqual({ state: "open", txn: "t1" });
  });
});

describe("tipFor", () => {
  it("says who, how long, where the time went and how it ended", () => {
    const s = fold([...landedFlow("t1", "agent-01", 1000)]);
    const t = s.txns.get("t1")!;
    t.model = "scripted-v1";
    expect(tipFor(t, t.attempts[0]!, 5000)).toEqual({
      id: "t1",
      attempt: 1,
      status: "landed",
      intent: "intent of t1",
      staleBy: null,
      rows: [
        ["Agent", "agent-01 · scripted-v1 (scripted)"],
        ["Time", "400 ms"],
        ["Spent", "working 100 ms · queued 100 ms · verifying 200 ms"],
      ],
    });
  });

  it("names the stale path and its culprit, and counts a running attempt up to now", () => {
    const s = fold([open("t1", "a", 0), move("txn.stale", "t1", "a", 2000, { reason: "stale_read", paths: [{ path: "src/format.ts", seq: 3, by: "t_9" }] }), open("t1", "a", 2100, 2)]);
    const t = s.txns.get("t1")!;
    const first = tipFor(t, t.attempts[0]!, 9000);
    expect(first.status).toBe("stale");
    expect(first.staleBy).toBe("t_9");
    expect(first.rows).toContainEqual(["Stale", "src/format.ts ← t_9"]);
    expect(tipFor(t, t.attempts[1]!, 92_100).rows).toContainEqual(["Time", "1 m 30 s so far"]);
    // just under a minute carries into minutes instead of reading "60.0 s"
    expect(tipFor(t, t.attempts[1]!, 2100 + 59_950).rows).toContainEqual(["Time", "1 m 00 s so far"]);
  });

  it("shows the reason of a failure, the warnings and a recall", () => {
    const s = fold([open("t1", "a", 0), op("stale.warning", 50, { paths: ["x.ts"] }, "t1", "a"), move("txn.rejected", "t1", "a", 100, { reason: "duplicate_of:t_2" })]);
    const t = s.txns.get("t1")!;
    const tip = tipFor(t, t.attempts[0]!, 200);
    expect(tip.rows).toContainEqual(["Reason", "duplicate of t_2"]);
    expect(tip.rows).toContainEqual(["Warned", "x.ts"]);
    const r = fold([...landedFlow("t5", "a5", 100), move("txn.recalled", "t5", "a5", 700, { reason: "recall" })]);
    const tr = r.txns.get("t5")!;
    expect(tipFor(tr, tr.attempts[0]!, 900)).toMatchObject({ status: "recalled" });
    expect(tipFor(tr, tr.attempts[0]!, 900).rows).toContainEqual(["Recalled", "recall"]);
  });
});

describe("isArriving", () => {
  it.each([
    [1000, 1000, true],
    [1000, 2499, true],
    [1000, 2500, false],
    [1000, 999, false], // a block from the future (replay scrubbed back) is not arriving
    [1000, 90_000, false],
  ])("block at %d, now %d -> %s", (at, now, out) => expect(isArriving(at, now)).toBe(out));
});

// ---------------------------------------------------------------- heat

describe("heat", () => {
  it.each([
    [0, 0],
    [0.04, 0],
    [-1, 0],
    [NaN, 0],
    [0.05, 0.03], // a trace is always visible
    [0.1, 0.03],
    [1, 0.25],
    [2, 0.5], // the hot threshold sits mid-track
    [3, 0.75],
    [4, 1],
    [9, 1],
  ])("heatFraction(%d) = %d", (v, f) => expect(heatFraction(v)).toBeCloseTo(f, 10));

  it.each([
    [0, "·"],
    [1.24, "1.2"],
    [2, "2.0"],
    [12.345, "12.3"],
  ])("formatHeat(%d) = %s", (v, text) => expect(formatHeat(v)).toBe(text));

  it("lists every file, cold ones at zero, hottest first and ties alphabetical", () => {
    const rows = heatRows(["src/z.ts", "src/a.ts", "src/format.ts", "src/layout.ts"], [
      { path: "src/format.ts", value: 2.5, hot: true },
      { path: "src/layout.ts", value: 0.8, hot: false },
    ]);
    expect(rows.map((r) => [r.path, r.value, r.hot])).toEqual([
      ["src/format.ts", 2.5, true],
      ["src/layout.ts", 0.8, false],
      ["src/a.ts", 0, false],
      ["src/z.ts", 0, false],
    ]);
    expect(rows[0]!.fraction).toBeCloseTo(0.625, 10);
    expect(rows[2]!.fraction).toBe(0);
  });

  it("keeps a heated path that the listing does not have", () => {
    const rows = heatRows(["a.ts"], [{ path: "gone.ts", value: 1, hot: false }]);
    expect(rows.map((r) => r.path)).toEqual(["gone.ts", "a.ts"]);
  });

  it("shows only the heated paths while the listing is unavailable", () => {
    expect(heatRows(null, [{ path: "x.ts", value: 3, hot: true }]).map((r) => r.path)).toEqual(["x.ts"]);
    expect(heatRows(null, [])).toEqual([]);
    expect(heatRows([], [])).toEqual([]);
  });

  it("treats a fully decayed value as cold, and never hot", () => {
    const [r] = heatRows(["a.ts"], [{ path: "a.ts", value: 0.01, hot: true }]);
    expect(r).toEqual({ path: "a.ts", value: 0, hot: false, fraction: 0 });
  });

  it("decays with the clock through heatAt, so a hot file cools while idle", () => {
    const s = fold([op("heat.changed", 0, { path: "src/format.ts", value: 4, hot: true })]);
    const at = (now: number) => heatRows(["src/format.ts"], heatAt(s, now))[0]!;
    expect(at(0)).toMatchObject({ value: 4, hot: true, fraction: 1 });
    expect(at(5 * 60_000)).toMatchObject({ hot: true }); // one half-life: 2.0 is still hot
    expect(at(5 * 60_000).value).toBeCloseTo(2, 6);
    expect(at(10 * 60_000)).toMatchObject({ hot: false });
    expect(at(120 * 60_000)).toMatchObject({ value: 0, fraction: 0 });
  });
});

// ---------------------------------------------------------------- rail

describe("abortRows", () => {
  it("labels causes, drops zeros and sorts by count then name", () => {
    expect(abortRows({ stale_read: 3, text_conflict: 3, failed_verify: 5, duplicate: 0, max_attempts: 1, weird_cause: 2 })).toEqual([
      { cause: "failed_verify", label: "failed verify", count: 5 },
      { cause: "stale_read", label: "stale read", count: 3 },
      { cause: "text_conflict", label: "text conflict", count: 3 },
      { cause: "weird_cause", label: "weird cause", count: 2 },
      { cause: "max_attempts", label: "max attempts", count: 1 },
    ]);
  });
  it("is empty without aborts", () => {
    expect(abortRows({})).toEqual([]);
  });
});

describe("demoResult", () => {
  it.each<[number, string, { ok: boolean; needsToken: boolean; text: string }]>([
    [202, "{}", { ok: true, needsToken: false, text: "started · HTTP 202" }],
    [200, "", { ok: true, needsToken: false, text: "started · HTTP 200" }],
    [401, '{"error":"unauthorized"}', { ok: false, needsToken: true, text: "HTTP 401 · unauthorized" }],
    [404, "<html>Not found</html>", { ok: false, needsToken: false, text: "HTTP 404" }],
    [404, '{"error":"no such route"}', { ok: false, needsToken: false, text: "HTTP 404 · no such route" }],
    [500, '{"error":42}', { ok: false, needsToken: false, text: "HTTP 500" }],
    [503, "", { ok: false, needsToken: false, text: "HTTP 503" }],
    [409, `{"error":"${"x".repeat(200)}"}`, { ok: false, needsToken: false, text: `HTTP 409 · ${"x".repeat(68)}…` }],
  ])("status %d, body %j", (status, body, out) => expect(demoResult(status, body)).toEqual(out));
});

// ---------------------------------------------------------------- ticker

describe("kindSignal", () => {
  const expected: Record<OpKind, string | null> = {
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
    "trunk.advanced": "go",
    "trunk.diverged": "stop",
    "train.formed": "run",
    "train.bisect": null,
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
  it("covers every op kind", () => expect(Object.keys(expected).sort()).toEqual([...OP_KINDS].sort()));
  it.each(OP_KINDS.map((k) => [k, expected[k]] as const))("%s -> %s", (kind, signal) => expect(kindSignal(kind)).toBe(signal));
});

describe("shortData", () => {
  const sha = "8bbb4cfcc68b5f06c0058e3d943187c426bd83b5";
  const cases: [OpKind, Record<string, unknown>, string][] = [
    ["txn.open", { attempt: 1, intent: "Show three digits" }, "Show three digits"],
    ["txn.open", { attempt: 2, intent: "Show three digits" }, "attempt 2 · Show three digits"],
    ["txn.open", {}, ""],
    ["txn.submitted", { writes: ["a.ts"] }, "writes a.ts"],
    ["txn.submitted", { writes: ["a.ts", "b.ts"] }, "writes a.ts, b.ts"],
    ["txn.submitted", { writes: ["a.ts", "b.ts", "c.ts", "d.ts"] }, "writes a.ts, b.ts +2"],
    ["txn.submitted", {}, ""],
    ["txn.ready", { unionTouched: [] }, ""],
    ["txn.ready", { unionTouched: ["src/registry.ts"] }, "union src/registry.ts"],
    ["txn.verifying", { train: "tr_1" }, "tr_1"],
    ["txn.landed", { seq: 3, sha }, "seq 3 8bbb4cfc"],
    ["txn.stale", { reason: "stale_read", paths: [{ path: "src/format.ts", seq: 1, by: "t_1" }] }, "src/format.ts ← t_1"],
    ["txn.stale", { reason: "text_conflict", paths: [] }, "text conflict"],
    ["txn.stale", { reason: "stale_read", paths: [{ path: "a.ts", by: null }, { path: "b.ts" }] }, "a.ts +1"],
    ["txn.stale", {}, ""],
    ["txn.failed", { failures: [{ name: "broken by design", message: "x" }], reason: "tests" }, "broken by design"],
    ["txn.failed", { reason: "tests" }, "tests"],
    ["txn.needs_human", { reason: "human:src/payments/**" }, "human:src/payments/**"],
    ["txn.aborted", { reason: "max_attempts" }, "max_attempts"],
    ["txn.rejected", { reason: "duplicate_of:t_1" }, "duplicate_of:t_1"],
    ["txn.recalled", { reason: "cascade" }, "cascade"],
    ["trunk.advanced", { seq: 5, sha, train: "tr_2" }, "seq 5 8bbb4cfc tr_2"],
    ["trunk.advanced", { seq: 0, sha, train: null }, "seq 0 8bbb4cfc"],
    ["trunk.advanced", { seq: 7, sha, txns: [], train: null, recall: "rc_1" }, "seq 7 8bbb4cfc recall rc_1"],
    ["train.formed", { train: "tr_1", txns: ["a", "b"] }, "tr_1 · 2 txns"],
    ["train.formed", { train: "tr_1", txns: ["a"] }, "tr_1 · 1 txn"],
    ["train.formed", { train: "tr_2", txns: ["a"], after: "tr_1" }, "tr_2 · 1 txn · on tr_1"],
    ["train.confirmed", { train: "tr_2", after: "tr_1" }, "tr_2 · tr_1 landed its base"],
    ["train.bisect", { probe: ["a", "b"], pass: false }, "probe 2 · fail"],
    ["trunk.diverged", { store: "a".repeat(40), ledger: "b".repeat(40) }, "store aaaaaaaa ≠ ledger bbbbbbbb"],
    ["train.bisect", { probe: ["a"], pass: true }, "probe 1 · pass"],
    ["train.done", { train: "tr_1", outcome: "landed" }, "tr_1 · landed"],
    ["stale.warning", { paths: ["a.ts"] }, "a.ts"],
    ["heat.changed", { path: "src/format.ts", value: 2.26, hot: true }, "src/format.ts 2.3 hot"],
    ["heat.changed", { path: "src/format.ts", value: 1, hot: false }, "src/format.ts 1.0"],
    ["heat.changed", { path: "src/format.ts", value: "nope" }, "src/format.ts ?"],
    ["lease.granted", { path: "f.ts" }, "f.ts"],
    ["lease.waiting", { path: "f.ts", owner: "t_1" }, "f.ts"],
    ["lease.released", { path: "f.ts", txn: "t_1" }, "f.ts"],
    ["dup.warning", { other: "t_9" }, "with t_9"],
    ["conflict.warning", { other: "t_9" }, "with t_9"],
    ["judge.verdict", { question: "judge", value: 1 }, "judge 1"],
    ["reads.fallback", { count: 4 }, "4 paths"],
    ["recall.planned", { recall: "rc_1", targets: ["a", "b", "c"] }, "rc_1 · 3 targets"],
    ["recall.done", { recall: "rc_1", outcome: "passed" }, "rc_1 · passed"],
    ["policy.updated", { sha }, "8bbb4cfc"],
    ["policy.updated", { policy: {} }, ""],
    ["policy.updated", { error: "bad json", kept: true }, "error bad json"],
  ];
  it.each(cases)("%s %j -> %j", (kind, data, out) => expect(shortData(op(kind, 0, data))).toBe(out));
  it("has a case for every op kind", () => {
    for (const k of OP_KINDS) expect(cases.some(([kind]) => kind === k), k).toBe(true);
  });
});

describe("tickerLine", () => {
  it("lays out seq, kind, transaction, agent and a short summary with its signal", () => {
    const o = op("txn.stale", 5, { reason: "stale_read", paths: [{ path: "a.ts", by: "t_1" }] }, "t_2", "agent-c");
    expect(tickerLine(o)).toEqual({ seq: String(o.seq), kind: "txn.stale", txn: "t_2", agent: "agent-c", data: "a.ts ← t_1", signal: "stop" });
  });
  it("leaves transaction and agent empty for trunk ops and clips very long summaries", () => {
    const l = tickerLine(op("txn.open", 1, { intent: "x".repeat(400) }));
    expect([l.txn, l.agent, l.signal]).toEqual(["", "", null]);
    expect(l.data).toHaveLength(160);
    expect(l.data.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------- a recorded scenario

describe("the recorded e2e-land scenario", () => {
  const ops = e2eLand as unknown as Op[];
  const state = fold(ops);
  const { first, last } = opBounds(ops);
  const win = replayWindow(first, last, state.now);
  const sc: Scale = { t0: win.start, t1: win.end, x0: 96, x1: 1400 };

  it("has one row per agent, in the order they began", () => {
    const rows = buildRows(state, sc, state.now);
    expect(rows.map((r) => r.agent)).toEqual(["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-g", "agent-f"]);
    expect(rows.every((r) => r.bars.length === 1)).toBe(true);
  });

  it("shows each outcome of the scenario on its bar", () => {
    const byAgent = Object.fromEntries(buildRows(state, sc, state.now).map((r) => [r.agent, r.bars[0]!]));
    expect(byAgent["agent-a"]!.mark?.kind).toBe("landed");
    expect(byAgent["agent-b"]!.mark?.kind).toBe("landed");
    expect(byAgent["agent-d"]!.mark?.kind).toBe("landed");
    expect(byAgent["agent-f"]!.mark?.kind).toBe("failed");
    expect(byAgent["agent-c"]!.mark?.kind).toBe("stale");
    expect(byAgent["agent-c"]!.stale).toEqual([{ path: "src/format.ts", by: "t_muyvqoug28lz" }]);
    expect(byAgent["agent-c"]!.warnings).toHaveLength(1); // the early stale warning came before the abort
    for (const b of Object.values(byAgent)) {
      expect(b.x).toBeGreaterThanOrEqual(sc.x0);
      expect(b.x + b.w).toBeLessThanOrEqual(sc.x1);
      expect(b.parts.every((p) => p.w > 0)).toBe(true);
    }
  });

  it("draws the stale read as a wave from the commit that caused it", () => {
    const rows = buildRows(state, sc, state.now);
    const waves = staleWaves(rows, layoutTrunk(state.ticks, sc));
    expect(waves.map((w) => [w.culprit, w.victims.length])).toEqual([["t_muyvqoug28lz", 1]]);
  });

  it("draws the two trains as blocks of two and three ticks after the seed", () => {
    const blocks = layoutTrunk(state.ticks, sc);
    expect(blocks.map((b) => [b.train ?? "seed", b.ticks.length])).toEqual([
      ["seed", 1],
      ["tr_muyvqqcm0zf0", 2],
      ["tr_muyvqss8gqmn", 3],
    ]);
    const xs = blocks.flatMap((b) => b.ticks.map((t) => t.x));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("feeds the right rail: counters, aborts and the heat row", () => {
    const c = counters(state);
    expect(c).toMatchObject({ landed: 5, trains: 2, inflight: 0 });
    expect(abortRows(c.aborts).map((r) => [r.label, r.count])).toEqual([
      ["failed verify", 1],
      ["stale read", 1],
    ]);
    const rows = heatRows(["src/format.ts", "src/index.ts"], heatAt(state));
    expect(rows[0]).toMatchObject({ path: "src/format.ts", hot: false });
    expect(rows[0]!.value).toBeCloseTo(1, 1);
    expect(rows[1]).toMatchObject({ path: "src/index.ts", value: 0 });
  });

  it("keeps the ticker to the latest twelve ops, newest first", () => {
    const lines = state.ticker.map(tickerLine);
    expect(lines).toHaveLength(12);
    expect(lines[0]).toMatchObject({ seq: "59", kind: "train.done", data: "tr_muyvqss8gqmn · landed" });
    expect(lines.map((l) => Number(l.seq))).toEqual([...lines.map((l) => Number(l.seq))].sort((a, b) => b - a));
    expect(lines.find((l) => l.kind === "txn.failed")).toMatchObject({ txn: "t_muyvqs36f4d2", agent: "agent-f", data: "broken by design", signal: "stop" });
  });

  it("scrubbing forward only adds to the picture: nothing already drawn moves", () => {
    // The Replay's window comes from the whole recording, so the scale is the same at every position.
    const barXs = (s: LineState) => new Map(buildRows(s, sc, s.now).flatMap((r) => r.bars.map((b) => [b.key, b.x] as const)));
    const tickXs = (s: LineState) => new Map(layoutTrunk(s.ticks, sc).flatMap((b) => b.ticks.map((t) => [t.key, t.x] as const)));
    let before = { bars: new Map<string, number>(), ticks: new Map<string, number>() };
    let positions = 0;
    for (const o of ops) {
      const s = fold(ops, o.seq);
      const now = { bars: barXs(s), ticks: tickXs(s) };
      for (const [key, x] of before.bars) expect(now.bars.get(key), `bar ${key} at seq ${o.seq}`).toBe(x);
      for (const [key, x] of before.ticks) expect(now.ticks.get(key), `tick ${key} at seq ${o.seq}`).toBe(x);
      before = now;
      positions++;
    }
    expect(positions).toBe(ops.length);
    expect(before.bars.size).toBe(7);
  });

  it("draws nothing that has not happened yet at an early position", () => {
    const early = fold(ops, 16); // before the first landing
    const rows = buildRows(early, sc, early.now);
    expect(rows.flatMap((r) => r.bars).filter((b) => b.mark !== null)).toEqual([]);
    expect(layoutTrunk(early.ticks, sc)).toHaveLength(1);
  });
});

describe("idleView", () => {
  const MIN = 60_000;
  it("is null while something is on screen, and for a repo with nothing yet", () => {
    expect(idleView(fold([]), 10 * MIN)).toBeNull();
    const busy = fold([open("t1", "a", 0)]); // still running: always on screen
    expect(idleView(busy, 60 * MIN)).toBeNull();
    const recent = fold([open("t1", "a", 0), move("txn.landed", "t1", "a", 5 * MIN, { sha: "s", seq: 1 })]);
    expect(idleView(recent, 9 * MIN)).toBeNull();
  });

  it("frames the last activity as if now were its last op once the repo has been quiet past the live window", () => {
    const s = fold([open("t1", "a", 0), move("txn.landed", "t1", "a", 3 * MIN, { sha: "s", seq: 1 })]);
    const idle = idleView(s, 3 * MIN + LIVE_MAX_MS + 1)!;
    expect(idle.last).toBe(3 * MIN);
    expect(idle.window).toEqual(liveWindow(3 * MIN, 0));
    expect(idle.window.start).toBeLessThanOrEqual(0);
    expect(idle.window.end).toBeGreaterThan(3 * MIN);
  });
});
