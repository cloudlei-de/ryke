import { describe, expect, it } from "vitest";
import {
  bisectNext,
  bisectRecord,
  bisectStart,
  FAIRNESS_SKIPS,
  selectTrain,
  type BisectState,
  type BisectStep,
  type TrainCandidate,
} from "../src/worker/ledger/trains";

const cand = (id: string, submittedAt: number, footprint: string[], skips = 0): TrainCandidate => ({
  id,
  submittedAt,
  footprint,
  skips,
});

describe("selectTrain (§5.2)", () => {
  const policy = { union: ["src/registry.ts", "CHANGELOG.md", "src/gen/**"], trainMax: 8 };

  it("FAIRNESS_SKIPS is 3", () => {
    expect(FAIRNESS_SKIPS).toBe(3);
  });

  type Case = {
    name: string;
    ready: TrainCandidate[];
    expected: { train: string[]; skipped: string[] };
    policy?: { union: string[]; trainMax: number };
  };

  it.each<Case>([
    { name: "empty input gives an empty train", ready: [], expected: { train: [], skipped: [] } },
    {
      name: "a single candidate rides alone",
      ready: [cand("a", 1, ["x"])],
      expected: { train: ["a"], skipped: [] },
    },
    {
      name: "disjoint footprints all ride, in FIFO order",
      ready: [cand("a", 1, ["x"]), cand("b", 2, ["y"]), cand("c", 3, ["z"])],
      expected: { train: ["a", "b", "c"], skipped: [] },
    },
    {
      name: "input order does not matter: submittedAt decides",
      ready: [cand("c", 30, ["z"]), cand("a", 10, ["x"]), cand("b", 20, ["y"])],
      expected: { train: ["a", "b", "c"], skipped: [] },
    },
    {
      name: "equal submittedAt breaks ties by id",
      ready: [cand("t_b", 5, ["x"]), cand("t_a", 5, ["x"])],
      expected: { train: ["t_a"], skipped: ["t_b"] },
    },
    {
      name: "a later overlapping candidate is skipped, the next disjoint one still rides",
      ready: [cand("a", 1, ["x", "y"]), cand("b", 2, ["y", "z"]), cand("c", 3, ["w"])],
      expected: { train: ["a", "c"], skipped: ["b"] },
    },
    {
      name: "overlap is only against candidates in the train, not against skipped ones",
      ready: [cand("a", 1, ["x"]), cand("b", 2, ["x", "y"]), cand("c", 3, ["y"])],
      expected: { train: ["a", "c"], skipped: ["b"] },
    },
    {
      name: "overlap on a single shared path is enough",
      ready: [cand("a", 1, ["p1", "p2", "p3"]), cand("b", 2, ["q1", "q2", "p3"])],
      expected: { train: ["a"], skipped: ["b"] },
    },
    {
      name: "a candidate overlapping two train members is skipped once",
      ready: [cand("a", 1, ["x"]), cand("b", 2, ["y"]), cand("c", 3, ["x", "y"])],
      expected: { train: ["a", "b"], skipped: ["c"] },
    },
    {
      name: "union paths never count as overlap",
      ready: [cand("a", 1, ["src/registry.ts", "x"]), cand("b", 2, ["src/registry.ts", "y"])],
      expected: { train: ["a", "b"], skipped: [] },
    },
    {
      name: "union globs count as union paths",
      ready: [cand("a", 1, ["src/gen/a.ts"]), cand("b", 2, ["src/gen/a.ts", "src/gen/deep/b.ts"])],
      expected: { train: ["a", "b"], skipped: [] },
    },
    {
      name: "a union overlap does not excuse a real overlap alongside it",
      ready: [cand("a", 1, ["CHANGELOG.md", "x"]), cand("b", 2, ["CHANGELOG.md", "x"])],
      expected: { train: ["a"], skipped: ["b"] },
    },
    {
      name: "a union-only footprint is always disjoint",
      ready: [cand("a", 1, ["x"]), cand("b", 2, ["CHANGELOG.md"]), cand("c", 3, ["CHANGELOG.md"])],
      expected: { train: ["a", "b", "c"], skipped: [] },
    },
    {
      name: "an empty footprint is disjoint from everything",
      ready: [cand("a", 1, ["x"]), cand("b", 2, [])],
      expected: { train: ["a", "b"], skipped: [] },
    },
    {
      name: "the same path listed twice in one footprint is harmless",
      ready: [cand("a", 1, ["x", "x"]), cand("b", 2, ["y", "y"])],
      expected: { train: ["a", "b"], skipped: [] },
    },
    {
      name: "without a union list, a shared registry file does collide",
      ready: [cand("a", 1, ["src/registry.ts"]), cand("b", 2, ["src/registry.ts"])],
      policy: { union: [], trainMax: 8 },
      expected: { train: ["a"], skipped: ["b"] },
    },
    {
      name: "trainMax stops the train; disjoint latecomers are skipped too",
      ready: [cand("a", 1, ["1"]), cand("b", 2, ["2"]), cand("c", 3, ["3"]), cand("d", 4, ["4"]), cand("e", 5, ["5"])],
      policy: { union: [], trainMax: 3 },
      expected: { train: ["a", "b", "c"], skipped: ["d", "e"] },
    },
    {
      name: "trainMax counts members, not overlapping skips",
      ready: [cand("a", 1, ["x"]), cand("b", 2, ["x"]), cand("c", 3, ["y"]), cand("d", 4, ["z"])],
      policy: { union: [], trainMax: 2 },
      expected: { train: ["a", "c"], skipped: ["b", "d"] },
    },
    {
      name: "trainMax of 1",
      ready: [cand("a", 1, ["x"]), cand("b", 2, ["y"])],
      policy: { union: [], trainMax: 1 },
      expected: { train: ["a"], skipped: ["b"] },
    },
    {
      name: "fewer candidates than trainMax",
      ready: [cand("a", 1, ["x"])],
      policy: { union: [], trainMax: 64 },
      expected: { train: ["a"], skipped: [] },
    },
    {
      name: "skips below the threshold give no priority",
      ready: [cand("a", 1, ["x"]), cand("b", 2, ["x"], FAIRNESS_SKIPS - 1)],
      expected: { train: ["a"], skipped: ["b"] },
    },
    {
      name: "a candidate skipped FAIRNESS_SKIPS times goes first and displaces the older overlapping one",
      ready: [cand("a", 1, ["x"]), cand("b", 2, ["x"], FAIRNESS_SKIPS)],
      expected: { train: ["b"], skipped: ["a"] },
    },
    {
      name: "skips above the threshold behave the same",
      ready: [cand("a", 1, ["x"]), cand("b", 2, ["x"], 10)],
      expected: { train: ["b"], skipped: ["a"] },
    },
    {
      name: "starved candidates keep FIFO order among themselves; the older one wins an overlap",
      ready: [cand("late", 9, ["x"], 4), cand("early", 3, ["x"], 3), cand("fresh", 1, ["y"])],
      expected: { train: ["early", "fresh"], skipped: ["late"] },
    },
    {
      name: "starved candidates are placed before fresh ones in the train order",
      ready: [cand("fresh", 1, ["y"]), cand("starved", 5, ["x"], 3)],
      expected: { train: ["starved", "fresh"], skipped: [] },
    },
    {
      name: "starved candidates take the slots when trainMax is tight",
      ready: [cand("a", 1, ["1"]), cand("b", 2, ["2"]), cand("s", 3, ["3"], 3)],
      policy: { union: [], trainMax: 2 },
      expected: { train: ["s", "a"], skipped: ["b"] },
    },
    {
      name: "a starved candidate overlapping only via a union path still rides with the others",
      ready: [cand("a", 1, ["CHANGELOG.md", "x"]), cand("s", 2, ["CHANGELOG.md", "y"], 3)],
      expected: { train: ["s", "a"], skipped: [] },
    },
  ])("$name", ({ ready, expected, policy: p }) => {
    expect(selectTrain(ready, p ?? policy)).toEqual(expected);
  });

  it("does not mutate or reorder its input", () => {
    const ready = [cand("b", 2, ["y"]), cand("a", 1, ["x"], 3)];
    const snapshot = structuredClone(ready);
    selectTrain(ready, policy);
    expect(ready).toEqual(snapshot);
  });

  it("every ready candidate ends up in exactly one of train and skipped", () => {
    const ready = Array.from({ length: 20 }, (_, i) => cand(`t${i}`, i % 5, [`p${i % 7}`, `q${i % 3}`], i % 4));
    const { train, skipped } = selectTrain(ready, { union: [], trainMax: 4 });
    expect([...train, ...skipped].sort()).toEqual(ready.map((c) => c.id).sort());
    expect(train.length).toBeLessThanOrEqual(4);
    const byId = new Map(ready.map((c) => [c.id, c]));
    const seen = new Set<string>();
    for (const id of train) {
      for (const p of byId.get(id)!.footprint) {
        expect(seen.has(p)).toBe(false);
        seen.add(p);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------

// Drives the planner with a simulated verify: a probe passes iff it holds no culprit. The state
// goes through JSON between every step, as it will between Workflow steps.
function simulate(order: string[], culprits: ReadonlySet<string>, maxProbes?: number) {
  let s: BisectState = JSON.parse(JSON.stringify(bisectStart(order, maxProbes)));
  const probes: string[][] = [];
  for (let guard = 0; guard < 1000; guard++) {
    const step = bisectNext(s);
    if (step.kind === "done") return { step, probes, state: s };
    probes.push(step.txns);
    s = JSON.parse(JSON.stringify(bisectRecord(s, !step.txns.some((t) => culprits.has(t)))));
  }
  throw new Error("bisect did not terminate");
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
const ceilLog2 = (n: number) => Math.ceil(Math.log2(n));
type Done = Extract<BisectStep, { kind: "done" }>;

// Properties every finished run must satisfy, whatever the oracle and budget.
function expectConsistent(order: string[], culprits: ReadonlySet<string>, run: ReturnType<typeof simulate>) {
  const done = run.step as Done;
  // good, culprits and unresolved partition the input.
  expect([...done.good, ...done.culprits, ...done.unresolved].sort()).toEqual([...order].sort());
  // Probes are non-empty, in original order, and never contain a txn twice.
  const index = new Map(order.map((t, i) => [t, i]));
  for (const probe of run.probes) {
    expect(probe.length).toBeGreaterThan(0);
    const positions = probe.map((t) => index.get(t)!);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(probe).size).toBe(probe.length);
  }
  // `good` is safe to land: it is empty (the base) or exactly a probe that passed.
  expect(done.good.some((t) => culprits.has(t))).toBe(false);
  if (done.good.length > 0) {
    expect(run.state.lastPassingProbe).toEqual(done.good);
    expect(run.probes.some((p) => p.join() === done.good.join())).toBe(true);
  }
  // Only real culprits are ever blamed.
  for (const c of done.culprits) expect(culprits.has(c)).toBe(true);
}

describe("bisection planner (§5.3 step 4)", () => {
  describe("pinned probe sequences", () => {
    it("one culprit in the middle of four: three probes", () => {
      const run = simulate(["a", "b", "c", "d"], new Set(["c"]));
      expect(run.probes).toEqual([["a", "b"], ["a", "b", "c"], ["a", "b", "d"]]);
      expect(run.step).toEqual({ kind: "done", good: ["a", "b", "d"], culprits: ["c"], unresolved: [] });
    });

    it("two culprits among five: b and d", () => {
      const run = simulate(["a", "b", "c", "d", "e"], new Set(["b", "d"]));
      expect(run.probes).toEqual([
        ["a", "b"],
        ["a"],
        ["a", "c", "d", "e"],
        ["a", "c"],
        ["a", "c", "d"],
        ["a", "c", "e"],
      ]);
      expect(run.step).toEqual({ kind: "done", good: ["a", "c", "e"], culprits: ["b", "d"], unresolved: [] });
    });

    it("a one-element train is its own culprit with no probe", () => {
      const run = simulate(["a"], new Set(["a"]));
      expect(run.probes).toEqual([]);
      expect(run.step).toEqual({ kind: "done", good: [], culprits: ["a"], unresolved: [] });
    });

    it("the first transaction is the culprit: nothing to land, the rest is verified once", () => {
      const run = simulate(["a", "b", "c"], new Set(["a"]));
      expect(run.probes).toEqual([["a"], ["b", "c"]]);
      expect(run.step).toEqual({ kind: "done", good: ["b", "c"], culprits: ["a"], unresolved: [] });
    });

    it("the last transaction is the culprit: no whole probe is needed after it", () => {
      const run = simulate(["a", "b", "c"], new Set(["c"]));
      expect(run.probes).toEqual([["a"], ["a", "b"]]);
      expect(run.step).toEqual({ kind: "done", good: ["a", "b"], culprits: ["c"], unresolved: [] });
    });

    it("an empty train finishes immediately", () => {
      expect(bisectNext(bisectStart([]))).toEqual({ kind: "done", good: [], culprits: [], unresolved: [] });
    });
  });

  describe("single culprit at every position", () => {
    const cases = Array.from({ length: 8 }, (_, i) => i + 1).flatMap((n) =>
      Array.from({ length: n }, (_, pos) => [n, pos] as const),
    );
    it.each(cases)("n = %i, culprit at %i", (n, pos) => {
      const order = ids(n);
      const culprit = order[pos]!;
      const run = simulate(order, new Set([culprit]));
      expect(run.step).toEqual({
        kind: "done",
        good: order.filter((t) => t !== culprit),
        culprits: [culprit],
        unresolved: [],
      });
      expectConsistent(order, new Set([culprit]), run);
      expect(run.probes.length).toBeLessThanOrEqual(ceilLog2(Math.max(n, 1)) + 1 + 1);
    });
  });

  describe("two culprits", () => {
    it.each([
      [2, 0, 1],
      [3, 0, 2],
      [4, 0, 1],
      [4, 2, 3],
      [5, 1, 3],
      [6, 0, 5],
      [6, 2, 3],
      [7, 3, 6],
      [8, 0, 7],
      [8, 1, 2],
      [8, 4, 5],
      [8, 5, 7],
    ])("n = %i, culprits at %i and %i", (n, p, q) => {
      const order = ids(n);
      const culprits = new Set([order[p]!, order[q]!]);
      const run = simulate(order, culprits);
      expect(run.step).toEqual({
        kind: "done",
        good: order.filter((t) => !culprits.has(t)),
        culprits: [order[p], order[q]],
        unresolved: [],
      });
      expectConsistent(order, culprits, run);
      expect(run.probes.length).toBeLessThanOrEqual(2 * (ceilLog2(n) + 1) + 1);
    });
  });

  describe("all culprits", () => {
    it.each([1, 2, 3, 4, 5, 6, 7, 8])("n = %i", (n) => {
      const order = ids(n);
      const culprits = new Set(order);
      const run = simulate(order, culprits, 1000);
      expect(run.step).toEqual({ kind: "done", good: [], culprits: order, unresolved: [] });
      expect(run.state.lastPassingProbe).toBeNull();
      expectConsistent(order, culprits, run);
      expect(run.probes.length).toBeLessThanOrEqual(n * (ceilLog2(Math.max(n, 1)) + 1) + 1);
    });
  });

  describe("every non-empty culprit subset for n = 1..8", () => {
    it("blames exactly the culprits, lands everything else, and stays within the probe bound", () => {
      let runs = 0;
      for (let n = 1; n <= 8; n++) {
        const order = ids(n);
        for (let mask = 1; mask < 1 << n; mask++) {
          const culprits = new Set(order.filter((_, i) => mask & (1 << i)));
          const run = simulate(order, culprits, 1000);
          expect(run.step).toEqual({
            kind: "done",
            good: order.filter((t) => !culprits.has(t)),
            culprits: order.filter((t) => culprits.has(t)),
            unresolved: [],
          });
          expectConsistent(order, culprits, run);
          expect(run.probes.length).toBeLessThanOrEqual(culprits.size * (ceilLog2(n) + 1) + 1);
          runs++;
        }
      }
      // Guards the sweep itself: sum over n of (2^n - 1) non-empty subsets.
      expect(runs).toBe(1 + 3 + 7 + 15 + 31 + 63 + 127 + 255);
    });

    it("the default budget (2n + 2) covers one or two culprits for every n up to 8", () => {
      for (let n = 1; n <= 8; n++) {
        const order = ids(n);
        for (let mask = 1; mask < 1 << n; mask++) {
          const culprits = new Set(order.filter((_, i) => mask & (1 << i)));
          if (culprits.size > 2) continue;
          expect((simulate(order, culprits).step as Done).unresolved).toEqual([]);
        }
      }
    });
  });

  describe("maxProbes", () => {
    it("defaults to 2n + 2", () => {
      expect(bisectStart(ids(5)).maxProbes).toBe(12);
      expect(bisectStart(ids(1)).maxProbes).toBe(4);
      expect(bisectStart(ids(5), 3).maxProbes).toBe(3);
    });

    it("exhausted mid-search keeps the verified prefix as good and returns the rest as unresolved", () => {
      const order = ids(8);
      const run = simulate(order, new Set(["t6"]), 2);
      expect(run.probes).toEqual([order.slice(0, 4), order.slice(0, 6)]);
      expect(run.step).toEqual({ kind: "done", good: order.slice(0, 6), culprits: [], unresolved: ["t6", "t7"] });
      expect(run.state.lastPassingProbe).toEqual(order.slice(0, 6));
    });

    it("exhausted before any probe: nothing is proven, everything is unresolved", () => {
      const order = ids(3);
      const run = simulate(order, new Set(["t1"]), 0);
      expect(run.probes).toEqual([]);
      expect(run.step).toEqual({ kind: "done", good: [], culprits: [], unresolved: order });
      expect(run.state.lastPassingProbe).toBeNull();
    });

    it("exhausted with only failing probes: good stays empty", () => {
      const order = ids(8);
      const run = simulate(order, new Set(["t0"]), 2);
      expect(run.probes).toEqual([order.slice(0, 4), order.slice(0, 2)]);
      expect(run.step).toEqual({ kind: "done", good: [], culprits: [], unresolved: order });
    });

    it("exhausted right after a culprit was pinned, before the whole-set probe", () => {
      const run = simulate(["a", "b", "c", "d", "e"], new Set(["b", "d"]), 2);
      expect(run.probes).toEqual([["a", "b"], ["a"]]);
      expect(run.step).toEqual({ kind: "done", good: ["a"], culprits: ["b"], unresolved: ["c", "d", "e"] });
      expect(run.state.lastPassingProbe).toEqual(["a"]);
    });

    it("exhausted after the whole-set probe failed: the second search never starts", () => {
      const run = simulate(["a", "b", "c", "d", "e"], new Set(["b", "d"]), 3);
      expect(run.probes).toHaveLength(3);
      expect(run.step).toEqual({ kind: "done", good: ["a"], culprits: ["b"], unresolved: ["c", "d", "e"] });
    });

    it("exhausted mid second search keeps that search's verified prefix", () => {
      const run = simulate(["a", "b", "c", "d", "e"], new Set(["b", "d"]), 4);
      expect(run.probes).toHaveLength(4);
      expect(run.step).toEqual({ kind: "done", good: ["a", "c"], culprits: ["b"], unresolved: ["d", "e"] });
      expect(run.state.lastPassingProbe).toEqual(["a", "c"]);
    });

    it("a one-element train needs no budget", () => {
      expect(simulate(["a"], new Set(["a"]), 0).step).toEqual({
        kind: "done",
        good: [],
        culprits: ["a"],
        unresolved: [],
      });
    });

    it("whatever the budget, the result partitions the input and good is verified", () => {
      for (const n of [2, 3, 5, 8]) {
        const order = ids(n);
        for (let mask = 1; mask < 1 << n; mask += 3) {
          const culprits = new Set(order.filter((_, i) => mask & (1 << i)));
          for (let budget = 0; budget <= 2 * n + 2; budget++) {
            const run = simulate(order, culprits, budget);
            expectConsistent(order, culprits, run);
            expect(run.probes.length).toBeLessThanOrEqual(budget);
          }
        }
      }
    });
  });

  describe("state", () => {
    it("is JSON-serialisable at every step: a round trip changes nothing", () => {
      let s = bisectStart(ids(6), 20);
      for (let guard = 0; guard < 50; guard++) {
        expect(JSON.parse(JSON.stringify(s))).toStrictEqual(s);
        const step = bisectNext(s);
        if (step.kind === "done") return;
        s = bisectRecord(s, !step.txns.includes("t4"));
      }
      throw new Error("bisect did not terminate");
    });

    it("a run through JSON round trips equals a run without", () => {
      const order = ids(7);
      const culprits = new Set(["t2", "t5"]);
      let s = bisectStart(order);
      for (let guard = 0; guard < 50; guard++) {
        const step = bisectNext(s);
        if (step.kind === "done") {
          expect(step).toEqual(simulate(order, culprits).step);
          return;
        }
        s = bisectRecord(s, !step.txns.some((t) => culprits.has(t)));
      }
      throw new Error("bisect did not terminate");
    });

    it("bisectNext is pure: asking twice gives the same step and leaves the state alone", () => {
      const s = bisectStart(ids(4));
      const before = structuredClone(s);
      expect(bisectNext(s)).toEqual(bisectNext(s));
      expect(s).toEqual(before);
    });

    it("bisectRecord returns a new state and leaves its input alone", () => {
      const s = bisectStart(ids(4));
      const before = structuredClone(s);
      const next = bisectRecord(s, false);
      expect(s).toEqual(before);
      expect(next).not.toBe(s);
      expect(next.probes).toBe(1);
    });

    it("bisectStart copies the order it is given", () => {
      const order = ids(3);
      const s = bisectStart(order);
      order.push("extra");
      expect(s.order).toEqual(["t0", "t1", "t2"]);
    });

    it("recording a result after the planner finished is a programming error", () => {
      const done = bisectStart(["a"]);
      expect(bisectNext(done).kind).toBe("done");
      expect(() => bisectRecord(done, true)).toThrow(/finished/);
    });

    it("asking again after done keeps answering done", () => {
      const run = simulate(ids(3), new Set(["t1"]));
      expect(bisectNext(run.state)).toEqual(run.step);
    });

    it("counts probes in the state", () => {
      const run = simulate(ids(8), new Set(["t3"]));
      expect(run.state.probes).toBe(run.probes.length);
    });
  });
});

describe("selectTrain with separate write sets", () => {
  const c = (id: string, at: number, reads: string[], writes: string[], skips = 0) => ({ id, submittedAt: at, footprint: [...new Set([...reads, ...writes])], writes, skips });
  const policy = { union: ["src/registry.ts"], trainMax: 8 };

  it.each([
    ["two readers of a hot file share a train", [c("a", 1, ["src/format.ts"], ["src/a.ts"]), c("b", 2, ["src/format.ts"], ["src/b.ts"])], ["a", "b"]],
    ["a writer and a later reader of the same file do not", [c("w", 1, ["src/format.ts"], ["src/format.ts"]), c("r", 2, ["src/format.ts"], ["src/r.ts"])], ["w"]],
    ["a reader and a later writer of the same file do not", [c("r", 1, ["src/format.ts"], ["src/r.ts"]), c("w", 2, [], ["src/format.ts"])], ["r"]],
    ["two writers of one file do not", [c("x", 1, [], ["src/x.ts"]), c("y", 2, [], ["src/x.ts"])], ["x"]],
    ["union writes never clash", [c("x", 1, ["src/registry.ts"], ["src/registry.ts", "src/x.ts"]), c("y", 2, ["src/registry.ts"], ["src/registry.ts", "src/y.ts"])], ["x", "y"]],
    [
      "a reader blocked by an earlier writer leaves room for a later independent one",
      [c("w", 1, [], ["src/format.ts"]), c("r", 2, ["src/format.ts"], ["src/r.ts"]), c("z", 3, ["src/b.ts"], ["src/z.ts"])],
      ["w", "z"],
    ],
  ])("%s", (_name, ready, train) => {
    expect(selectTrain(ready, policy).train).toEqual(train);
  });

  it("treats a candidate without writes as writing its whole footprint", () => {
    const strict = { id: "s", submittedAt: 1, footprint: ["src/format.ts"], skips: 0 };
    expect(selectTrain([strict, c("r", 2, ["src/format.ts"], ["src/r.ts"])], policy).train).toEqual(["s"]);
  });
});
