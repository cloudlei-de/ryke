import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BENCH_SYNTHETIC_NOTICE, parseBench, POLICIES, type BenchCell, type BenchResults } from "../src/shared/bench";
import {
  abortCauses,
  abortSegments,
  causeLabel,
  clusterLayout,
  endGutter,
  fmtCompact,
  fmtGenerated,
  fmtNum,
  headline,
  linePath,
  makeXScale,
  measuredAgents,
  niceTicks,
  seriesByPolicy,
  spreadLabels,
  stackLayout,
  tableRows,
} from "../src/web/views/bench/chart";
import sample from "./fixtures/bench/sample.json";

const sampleCells = parseBench(sample)?.cells ?? [];

const cell = (over: Partial<BenchCell> = {}): BenchCell => ({
  policy: "ryke",
  agents: 10,
  landed: 1,
  landedPerMinute: 1,
  p50: 1,
  p95: 2,
  aborts: {},
  verifyRunsPerLanded: 1,
  wastedAgentSeconds: 0,
  trunkBreakages: 0,
  ...over,
});

describe("parseBench", () => {
  it("accepts the sample fixture and the empty placeholder", () => {
    expect(parseBench(sample)).toEqual(sample);
    const placeholder = { generatedAt: null, durationSeconds: 0, synthetic: true, note: "No bench run yet.", cells: [] };
    expect(parseBench(placeholder)).toEqual(placeholder);
  });

  const good = () => structuredClone(sample) as unknown as Record<string, unknown>;
  const withCell = (patch: Record<string, unknown>) => {
    const r = good();
    (r.cells as Record<string, unknown>[])[0] = { ...(r.cells as Record<string, unknown>[])[0], ...patch };
    return r;
  };
  const cases: [string, unknown][] = [
    ["null", null],
    ["a string", "bench"],
    ["an array", []],
    ["generatedAt a number", { ...good(), generatedAt: 5 }],
    ["generatedAt missing", (({ generatedAt: _g, ...rest }) => rest)(good())],
    ["durationSeconds a string", { ...good(), durationSeconds: "300" }],
    ["durationSeconds NaN", { ...good(), durationSeconds: Number.NaN }],
    ["synthetic false", { ...good(), synthetic: false }],
    ["synthetic missing", (({ synthetic: _s, ...rest }) => rest)(good())],
    ["note missing", { ...good(), note: undefined }],
    ["cells not an array", { ...good(), cells: {} }],
    ["a cell that is null", { ...good(), cells: [null] }],
    ["an unknown policy", withCell({ policy: "trunk" })],
    ["agents a string", withCell({ agents: "10" })],
    ["p95 infinite", withCell({ p95: Number.POSITIVE_INFINITY })],
    ["trunkBreakages missing", withCell({ trunkBreakages: undefined })],
    ["aborts null", withCell({ aborts: null })],
    ["aborts an array", withCell({ aborts: [1] })],
    ["an abort count that is not a number", withCell({ aborts: { stale_read: "3" } })],
  ];
  it.each(cases)("rejects %s", (_name, json) => {
    expect(parseBench(json)).toBeNull();
  });

  it("keeps the notice the page must always show", () => {
    expect(BENCH_SYNTHETIC_NOTICE).toBe("Bench agents are synthetic: real git, real merges, real tests, scripted edits.");
  });
});

describe("GET /api/bench", () => {
  it("serves bench/results/latest.json in the shared format, without a token", async () => {
    const res = await exports.default.fetch("http://ryke.test/api/bench");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as BenchResults;
    expect(parseBench(body)).not.toBeNull();
    expect(body.synthetic).toBe(true);
  });
});

describe("measuredAgents and seriesByPolicy", () => {
  const cells = [cell({ policy: "ryke", agents: 100, landedPerMinute: 40 }), cell({ policy: "lock", agents: 10, landedPerMinute: 4 }), cell({ policy: "ryke", agents: 10, landedPerMinute: 8 }), cell({ policy: "lock", agents: 100, landedPerMinute: 3 })];

  it("lists each measured N once, ascending", () => {
    expect(measuredAgents(cells)).toEqual([10, 100]);
    expect(measuredAgents([])).toEqual([]);
  });

  it("groups points by policy sorted by agents, with an entry for a policy that has no cells", () => {
    expect(seriesByPolicy(cells, (c) => c.landedPerMinute)).toEqual({
      lock: [
        { agents: 10, value: 4 },
        { agents: 100, value: 3 },
      ],
      queue: [],
      ryke: [
        { agents: 10, value: 8 },
        { agents: 100, value: 40 },
      ],
    });
  });

  it("lets the later cell win when a (policy, agents) pair repeats", () => {
    const s = seriesByPolicy([cell({ agents: 10, landedPerMinute: 1 }), cell({ agents: 10, landedPerMinute: 2 })], (c) => c.landedPerMinute);
    expect(s.ryke).toEqual([{ agents: 10, value: 2 }]);
  });

  it("covers every policy the format names", () => {
    expect(Object.keys(seriesByPolicy([], (c) => c.landed))).toEqual([...POLICIES]);
  });
});

describe("makeXScale", () => {
  it("uses linear spacing for a narrow range and log spacing for a wide one", () => {
    expect(makeXScale([10, 20, 30], 0, 100).kind).toBe("linear");
    expect(makeXScale([10, 39], 0, 100).kind).toBe("linear");
    expect(makeXScale([10, 40], 0, 100).kind).toBe("log");
    expect(makeXScale([10, 50, 100, 200], 0, 100).kind).toBe("log");
  });

  it("maps the smallest N to x0 and the largest to x1", () => {
    for (const ns of [[10, 20], [10, 50, 100, 200]]) {
      const s = makeXScale(ns, 20, 220);
      expect(s.x(ns[0]!)).toBeCloseTo(20);
      expect(s.x(ns.at(-1)!)).toBeCloseTo(220);
    }
  });

  it("places a log midpoint at the geometric mean and a linear one at the arithmetic mean", () => {
    expect(makeXScale([10, 1000], 0, 100).x(100)).toBeCloseTo(50);
    expect(makeXScale([10, 20, 30], 0, 100).x(20)).toBeCloseTo(50);
  });

  it("returns the measured Ns, sorted and unique, as ticks", () => {
    expect(makeXScale([100, 10, 100, 50], 0, 1).ticks).toEqual([10, 50, 100]);
  });

  it("centres a single N and an empty set", () => {
    expect(makeXScale([50], 0, 100).x(50)).toBe(50);
    expect(makeXScale([], 0, 100).x(5)).toBe(50);
    expect(makeXScale([], 0, 100).ticks).toEqual([]);
  });

  it("falls back to linear when an N is not positive, because log is undefined there", () => {
    const s = makeXScale([0, 100], 0, 100);
    expect(s.kind).toBe("linear");
    expect(s.x(50)).toBeCloseTo(50);
  });
});

describe("niceTicks", () => {
  const cases: [number, number, number[]][] = [
    [56.2, 4, [0, 20, 40, 60]],
    [8, 4, [0, 2, 4, 6, 8]],
    [7, 4, [0, 2, 4, 6, 8]],
    [100, 4, [0, 50, 100]],
    [24960, 4, [0, 10000, 20000, 30000]],
    [1, 4, [0, 0.5, 1]],
    [0.3, 4, [0, 0.1, 0.2, 0.3]],
    [3, 4, [0, 1, 2, 3]],
    [4, 4, [0, 1, 2, 3, 4]],
    [0, 4, [0, 1]],
    [-5, 4, [0, 1]],
    [Number.NaN, 4, [0, 1]],
    [12, 2, [0, 10, 20]],
  ];
  it.each(cases)("niceTicks(%s, %s) is %j", (max, want, ticks) => {
    const r = niceTicks(max, want);
    expect(r.ticks).toEqual(ticks);
    expect(r.max).toBe(ticks.at(-1));
  });

  it("always reaches the data maximum", () => {
    for (const max of [0.7, 1.3, 9.9, 33, 101, 4999, 123456]) expect(niceTicks(max).max).toBeGreaterThanOrEqual(max);
  });
});

describe("linePath", () => {
  it.each([
    [[], ""],
    [[{ x: 1, y: 2 }], "M1 2"],
    [
      [
        { x: 0, y: 0 },
        { x: 10.04, y: 20.06 },
        { x: 30, y: 5 },
      ],
      "M0 0L10 20.1L30 5",
    ],
  ] as const)("linePath(%j) is %s", (pts, d) => {
    expect(linePath([...pts])).toBe(d);
  });
});

describe("spreadLabels", () => {
  const cases: [string, number[], number, number, number, number[]][] = [
    ["nothing", [], 14, 0, 100, []],
    ["one label stays put", [50], 14, 0, 100, [50]],
    ["far apart labels stay put", [10, 100], 14, 0, 200, [10, 100]],
    ["two labels at one point part symmetrically", [100, 100], 14, 0, 200, [93, 107]],
    ["input order is preserved", [110, 100, 105], 14, 0, 200, [119, 91, 105]],
    ["three close labels centre on their mean", [100, 105, 110], 14, 0, 200, [91, 105, 119]],
    ["two clusters resolve independently", [10, 12, 100, 101], 10, -50, 200, [6, 16, 95.5, 105.5]],
    ["the hi bound pushes labels up", [200, 200], 14, 0, 200, [186, 200]],
    ["the lo bound pushes labels down", [0, 0], 14, 0, 200, [0, 14]],
    ["no room: labels overflow downward rather than overlap", [10, 10, 10], 14, 0, 20, [0, 14, 28]],
  ];
  it.each(cases)("%s", (_name, ys, gap, lo, hi, want) => {
    const got = spreadLabels(ys, gap, lo, hi);
    expect(got).toHaveLength(want.length);
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6));
  });

  it("merges a chain of near neighbours into one centred group", () => {
    const [a, b, c] = spreadLabels([100, 110, 125], 14, 0, 300);
    expect(b! - a!).toBeCloseTo(14);
    expect(c! - b!).toBeCloseTo(14);
    expect((a! + b! + c!) / 3).toBeCloseTo((100 + 110 + 125) / 3);
  });

  it("breaks ties by input order", () => {
    const [a, b] = spreadLabels([5, 5], 10, -100, 100);
    expect(a!).toBeLessThan(b!);
  });
});

describe("abort causes and stacks", () => {
  const cells = [
    cell({ aborts: { stale_read: 5, failed_verify: 1 } }),
    cell({ policy: "queue", aborts: { text_conflict: 5, failed_verify: 4 } }),
    cell({ policy: "lock", aborts: {} }),
  ];

  it("orders causes by total, then by name, and drops causes that never happened", () => {
    // failed_verify 5 ties stale_read 5 and text_conflict 5: name order decides.
    expect(abortCauses(cells)).toEqual(["failed_verify", "stale_read", "text_conflict"]);
    expect(abortCauses([cell({ aborts: { a: 0, b: 2 } })])).toEqual(["b"]);
    expect(abortCauses([])).toEqual([]);
  });

  it("folds the tail into 'other' once there are more causes than the patterns can tell apart", () => {
    const many = [cell({ aborts: { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4 } })];
    expect(abortCauses(many, 4)).toEqual(["a", "b", "c", "d", "other"]);
    expect(abortCauses(many, 6)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("does not list 'other' twice when a real cause is already called that", () => {
    const many = [cell({ aborts: { other: 20, a: 9, b: 8, c: 7, d: 6 } })];
    expect(abortCauses(many, 4)).toEqual(["other", "a", "b", "c"]);
    const tail = [cell({ aborts: { a: 20, b: 9, c: 8, d: 7, other: 1 } })];
    expect(abortCauses(tail, 4)).toEqual(["a", "b", "c", "d", "other"]);
  });

  const segCases: [string, Record<string, number>, string[], { cause: string; value: number }[]][] = [
    ["only the causes that happened, in stack order", { stale_read: 3, failed_verify: 2 }, ["failed_verify", "stale_read", "text_conflict"], [{ cause: "failed_verify", value: 2 }, { cause: "stale_read", value: 3 }]],
    ["an empty cell has no segments", {}, ["a", "b"], []],
    ["unlisted causes land in other", { a: 1, z: 4, y: 2 }, ["a", "other"], [{ cause: "a", value: 1 }, { cause: "other", value: 6 }]],
    ["a literal other cause joins the folded tail", { a: 1, other: 2, z: 3 }, ["a", "other"], [{ cause: "a", value: 1 }, { cause: "other", value: 5 }]],
    ["negative and non-finite counts are ignored", { a: -3, b: Number.NaN, c: 2 }, ["a", "b", "c"], [{ cause: "c", value: 2 }]],
  ];
  it.each(segCases)("abortSegments: %s", (_name, aborts, causes, want) => {
    expect(abortSegments(aborts, causes)).toEqual(want);
  });

  it("stacks segments upward from the baseline, trimming the gap from the top of all but the last", () => {
    const px = (v: number) => v * 10;
    const out = stackLayout(
      [
        { cause: "a", value: 3 },
        { cause: "b", value: 2 },
      ],
      px,
      100,
      2,
    );
    expect(out).toEqual([
      { cause: "a", value: 3, y: 72, h: 28 },
      { cause: "b", value: 2, y: 50, h: 20 },
    ]);
  });

  it("never trims a thin segment away", () => {
    const out = stackLayout(
      [
        { cause: "a", value: 1 },
        { cause: "b", value: 1 },
      ],
      (v) => v * 2,
      50,
      2,
    );
    expect(out[0]!.h).toBe(1);
    expect(out[1]!.h).toBe(2);
  });

  it("returns nothing for an empty stack", () => {
    expect(stackLayout([], (v) => v, 10, 2)).toEqual([]);
  });

  it.each([
    ["stale_read", "stale read"],
    ["failed_verify", "failed verify"],
    ["other", "other"],
  ])("causeLabel(%s) is %s", (cause, label) => {
    expect(causeLabel(cause)).toBe(label);
  });
});

describe("clusterLayout", () => {
  it("caps the bar width and centres the offsets on the cluster", () => {
    expect(clusterLayout([100], 3, 16, 2)).toEqual({ width: 16, offsets: [-18, 0, 18] });
  });

  it("shrinks bars to fit the closest pair of clusters", () => {
    // 40 px apart: 80 % is 32 px, minus two 2 px gaps, over three bars is 9 px.
    expect(clusterLayout([100, 140, 300], 3, 16, 2)).toEqual({ width: 9, offsets: [-11, 0, 11] });
  });

  it("never goes below a visible bar", () => {
    expect(clusterLayout([10, 12], 3, 16, 2).width).toBe(3);
  });

  it("handles a single bar per cluster and an unsorted input", () => {
    expect(clusterLayout([300, 100], 1, 16, 2)).toEqual({ width: 16, offsets: [0] });
  });

  it("returns no offsets for zero bars", () => {
    expect(clusterLayout([100], 0)).toEqual({ width: 16, offsets: [] });
  });
});

describe("endGutter", () => {
  const at = (policy: BenchCell["policy"], value: number) => cell({ policy, agents: 10, landedPerMinute: value });

  it("grows with the longest end label so a phone does not clip it", () => {
    // queue (5 chars) + a 6-char value: 5*6 + 6 + 6*6.6 = 75.6, plus 14 before and 6 after.
    expect(endGutter([at("queue", 13400)], (c) => c.landedPerMinute, 0)).toBe(96);
    // ryke + "4,310": 24 + 6 + 33 = 63 -> 83.
    expect(endGutter([at("ryke", 4310)], (c) => c.landedPerMinute, 0)).toBe(83);
  });

  it("uses the last point of each policy, because that is where its label sits", () => {
    const cells = [cell({ policy: "queue", agents: 10, landedPerMinute: 99999 }), cell({ policy: "queue", agents: 50, landedPerMinute: 1 })];
    // "queue 1" is 30 + 6 + 6.6 = 42.6 -> 63; the 99,999 at 10 agents would need 99.
    expect(endGutter(cells, (c) => c.landedPerMinute, 0)).toBe(63);
  });

  it("never goes below the minimum, including with no cells", () => {
    expect(endGutter([], (c) => c.landedPerMinute, 1)).toBe(60);
    expect(endGutter([at("ryke", 1)], (c) => c.landedPerMinute, 1, 120)).toBe(120);
  });

  it("counts the decimals the label will show", () => {
    expect(endGutter([at("lock", 3.6)], (c) => c.landedPerMinute, 1)).toBeLessThan(endGutter([at("lock", 3.6)], (c) => c.landedPerMinute, 3));
  });
});

describe("formatting", () => {
  it.each([
    [3.8, 1, "3.8"],
    [4, 1, "4.0"],
    [1234.56, 1, "1,234.6"],
    [24960, 0, "24,960"],
    [0.274, 2, "0.27"],
    [0, 0, "0"],
    [Number.NaN, 1, "–"],
    [Number.POSITIVE_INFINITY, 0, "–"],
  ])("fmtNum(%s, %s) is %s", (n, digits, want) => {
    expect(fmtNum(n, digits)).toBe(want);
  });

  it.each([
    [0, "0"],
    [7, "7"],
    [2.5, "2.5"],
    [999, "999"],
    [1000, "1k"],
    [1500, "1.5k"],
    [10000, "10k"],
    [24960, "25k"],
    [1_000_000, "1M"],
    [2_500_000, "2.5M"],
    [Number.NaN, "–"],
  ])("fmtCompact(%s) is %s", (n, want) => {
    expect(fmtCompact(n)).toBe(want);
  });

  it.each([
    [null, "not run yet"],
    ["2026-10-12T14:03:09.000Z", "2026-10-12 14:03 UTC"],
    ["not a date", "not a date"],
  ])("fmtGenerated(%s) is %s", (iso, want) => {
    expect(fmtGenerated(iso)).toBe(want);
  });
});

describe("tableRows", () => {
  it("lists every cell by agents then policy order, formatted for reading", () => {
    const rows = tableRows(sampleCells);
    expect(rows).toHaveLength(12);
    expect(rows.slice(0, 3).map((r) => [r.policy, r.agents])).toEqual([
      ["lock", "10"],
      ["queue", "10"],
      ["ryke", "10"],
    ]);
    expect(rows.at(-1)?.agents).toBe("200");
    expect(rows[2]).toEqual({
      key: "ryke-10",
      policy: "ryke",
      agents: "10",
      landed: "41",
      perMinute: "8.2",
      p50: "9.4",
      p95: "19.1",
      aborts: "stale read 6 · failed verify 1",
      abortTotal: 7,
      verifyRuns: "0.42",
      wasted: "58",
      breakages: 0,
    });
  });

  it("says 'none' for a cell without aborts and keeps zero-count causes out", () => {
    const [row] = tableRows([cell({ aborts: { stale_read: 0 } })]);
    expect(row?.aborts).toBe("none");
    expect(row?.abortTotal).toBe(0);
  });

  it("orders a cell's causes by count, largest first", () => {
    const [row] = tableRows([cell({ aborts: { a: 1, b: 9, c: 9 } })]);
    expect(row?.aborts).toBe("b 9 · c 9 · a 1");
  });

  it("is empty for no cells", () => {
    expect(tableRows([])).toEqual([]);
  });
});

describe("headline", () => {
  it("compares the three policies at the largest N all of them measured", () => {
    expect(headline(sampleCells)).toEqual({ agents: 200, values: { lock: 3.6, queue: 6.6, ryke: 56.2 } });
  });

  it("skips an N where a policy is missing", () => {
    const cells = [cell({ policy: "lock", agents: 10, landedPerMinute: 1 }), cell({ policy: "queue", agents: 10, landedPerMinute: 2 }), cell({ policy: "ryke", agents: 10, landedPerMinute: 3 }), cell({ policy: "ryke", agents: 50, landedPerMinute: 9 })];
    expect(headline(cells)).toEqual({ agents: 10, values: { lock: 1, queue: 2, ryke: 3 } });
  });

  it("is null when no N has all three policies, and for no cells", () => {
    expect(headline([cell({ policy: "lock" }), cell({ policy: "ryke", agents: 20 })])).toBeNull();
    expect(headline([])).toBeNull();
  });
});
