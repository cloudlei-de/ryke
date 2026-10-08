import { describe, expect, it } from "vitest";
import { type LandedTxn, nextCascade, planRecall, RecallError, type RecallSelector } from "../src/worker/ledger/recall";

// `landedSeq` doubles as the position in the trunk history, so the id carries it for readability.
function txn(
  id: string,
  landedSeq: number,
  o: { agent?: string; model?: string | null; reads?: string[]; writes?: string[] } = {},
): LandedTxn {
  return {
    id,
    agent: o.agent ?? "agent-x",
    model: o.model === undefined ? null : o.model,
    landedSeq,
    commit: `c${landedSeq}`,
    reads: o.reads ?? [],
    writes: o.writes ?? [],
  };
}

const none = { targets: [], dependents: [], order: [], cascadeCandidates: {} };

describe("planRecall selector", () => {
  const landed = [
    txn("t1", 1, { agent: "bad", model: "sloppy-v0", writes: ["a"] }),
    txn("t2", 2, { agent: "good", model: "sloppy-v0", writes: ["b"] }),
    txn("t3", 3, { agent: "bad", model: "solid-v1", writes: ["c"] }),
    txn("t4", 4, { agent: "good", model: null, writes: ["d"] }),
  ];

  it("returns an empty plan when nothing has landed", () => {
    expect(planRecall([], { agent: "bad" })).toEqual(none);
    expect(planRecall([], { model: "m" })).toEqual(none);
    expect(planRecall([], { txns: [] })).toEqual(none);
  });

  it.each<[string, RecallSelector, string[]]>([
    ["by agent", { agent: "bad" }, ["t1", "t3"]],
    ["by another agent", { agent: "good" }, ["t2", "t4"]],
    ["by model", { model: "sloppy-v0" }, ["t1", "t2"]],
    ["by a model one transaction has", { model: "solid-v1" }, ["t3"]],
    ["by txns", { txns: ["t4", "t2"] }, ["t2", "t4"]],
    ["by txns with a repeated id", { txns: ["t3", "t3"] }, ["t3"]],
    ["by every txn", { txns: ["t1", "t2", "t3", "t4"] }, ["t1", "t2", "t3", "t4"]],
    ["by an agent that landed nothing", { agent: "nobody" }, []],
    ["by a model that landed nothing", { model: "ghost" }, []],
    ["by an empty txns list", { txns: [] }, []],
  ])("selects targets %s", (_name, selector, targets) => {
    expect(planRecall(landed, selector).targets).toEqual(targets);
  });

  it("never matches a model selector against a transaction without a model", () => {
    expect(planRecall(landed, { model: "null" }).targets).toEqual([]);
  });

  it("returns an empty plan, dependents included, when the selector matches nothing", () => {
    const withReader = [...landed, txn("r", 5, { reads: ["a", "b", "c", "d"] })];
    expect(planRecall(withReader, { agent: "nobody" })).toEqual(none);
  });

  it("names every txn that is not landed", () => {
    const run = () => planRecall(landed, { txns: ["t1", "ghost-1", "ghost-2"] });
    expect(run).toThrow(RecallError);
    expect(run).toThrow("txns not landed: ghost-1, ghost-2");
  });

  it("reports an unknown txn even when the landed set is empty", () => {
    expect(() => planRecall([], { txns: ["x"] })).toThrow("txns not landed: x");
  });

  it("is a RecallError named for the API layer to map to a 422", () => {
    try {
      planRecall(landed, { txns: ["ghost"] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RecallError);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("RecallError");
    }
  });

  it.each<[string, RecallSelector]>([
    ["no key", {}],
    ["only undefined keys", { agent: undefined, model: undefined, txns: undefined }],
    ["agent and model", { agent: "bad", model: "m" }],
    ["agent and txns", { agent: "bad", txns: ["t1"] }],
    ["model and txns", { model: "m", txns: ["t1"] }],
    ["all three", { agent: "bad", model: "m", txns: ["t1"] }],
  ])("rejects a selector with %s", (_name, selector) => {
    expect(() => planRecall(landed, selector)).toThrow(RecallError);
    expect(() => planRecall(landed, selector)).toThrow("exactly one of agent, model or txns");
  });

  it("rejects an invalid selector before looking at the landed set", () => {
    expect(() => planRecall([], {})).toThrow(RecallError);
  });

  it("treats undefined keys next to one real key as not given", () => {
    expect(planRecall(landed, { agent: "bad", model: undefined }).targets).toEqual(["t1", "t3"]);
  });
});

describe("planRecall dependents", () => {
  // Each case: transactions in landing order, which agent's work is recalled, expected dependents.
  const cases: { name: string; landed: LandedTxn[]; targets: string[]; dependents: string[] }[] = [
    {
      name: "a read-only dependent: it validated against content the revert removes",
      landed: [txn("T", 1, { writes: ["x"] }), txn("D", 2, { reads: ["x"] })],
      targets: ["T"],
      dependents: ["D"],
    },
    {
      name: "a write-write dependent with no read of the path",
      landed: [txn("T", 1, { writes: ["x"] }), txn("D", 2, { writes: ["x"] })],
      targets: ["T"],
      dependents: ["D"],
    },
    {
      name: "a transaction on unrelated paths is untouched",
      landed: [txn("T", 1, { writes: ["x"] }), txn("U", 2, { reads: ["z"], writes: ["z"] })],
      targets: ["T"],
      dependents: [],
    },
    {
      name: "a transaction that only reads what the target also only read is untouched",
      landed: [txn("T", 1, { reads: ["x"], writes: ["y"] }), txn("U", 2, { reads: ["x"] })],
      targets: ["T"],
      dependents: [],
    },
    {
      name: "a transaction that writes what the target only read is untouched",
      landed: [txn("T", 1, { reads: ["x"], writes: ["y"] }), txn("U", 2, { writes: ["x"] })],
      targets: ["T"],
      dependents: [],
    },
    {
      name: "a chain: B reads x and writes y, C reads y",
      landed: [
        txn("A", 1, { writes: ["x"] }),
        txn("B", 2, { reads: ["x"], writes: ["y"] }),
        txn("C", 3, { reads: ["y"] }),
      ],
      targets: ["A"],
      dependents: ["B", "C"],
    },
    {
      name: "a chain through write-write overlaps",
      landed: [
        txn("A", 1, { writes: ["x"] }),
        txn("B", 2, { writes: ["x", "y"] }),
        txn("C", 3, { writes: ["y", "z"] }),
        txn("D", 4, { reads: ["z"] }),
      ],
      targets: ["A"],
      dependents: ["B", "C", "D"],
    },
    {
      name: "a long chain, each link reading only the previous link's write",
      landed: [
        txn("A", 1, { writes: ["p0"] }),
        ...[1, 2, 3, 4, 5].map((i) => txn(`L${i}`, i + 1, { reads: [`p${i - 1}`], writes: [`p${i}`] })),
      ],
      targets: ["A"],
      dependents: ["L1", "L2", "L3", "L4", "L5"],
    },
    {
      name: "touched the path but landed before the target",
      landed: [txn("P", 1, { reads: ["x"], writes: ["x"] }), txn("T", 2, { writes: ["x"] })],
      targets: ["T"],
      dependents: [],
    },
    {
      name: "landed before the writer that would taint it, even though it reads that writer's path",
      landed: [
        txn("A", 1, { writes: ["x"] }),
        txn("C", 2, { reads: ["y"] }),
        txn("B", 3, { reads: ["x"], writes: ["y"] }),
      ],
      targets: ["A"],
      dependents: ["B"],
    },
    {
      name: "a read of a path that only a non-dependent wrote",
      landed: [
        txn("A", 1, { writes: ["x"] }),
        txn("U", 2, { writes: ["z"] }),
        txn("V", 3, { reads: ["z"] }),
      ],
      targets: ["A"],
      dependents: [],
    },
    {
      name: "a dependent that both reads and writes the tainted path counts once",
      landed: [txn("T", 1, { writes: ["x"] }), txn("D", 2, { reads: ["x"], writes: ["x"] })],
      targets: ["T"],
      dependents: ["D"],
    },
    {
      name: "paths are compared whole, not as prefixes or globs",
      landed: [
        txn("T", 1, { writes: ["src/a.ts"] }),
        txn("U", 2, { reads: ["src/a.tsx", "src", "src/*.ts", "SRC/A.TS"] }),
      ],
      targets: ["T"],
      dependents: [],
    },
    {
      name: "a target is never a dependent of an earlier target",
      landed: [txn("T1", 1, { writes: ["x"] }), txn("T2", 2, { reads: ["x"], writes: ["x"] })],
      targets: ["T1", "T2"],
      dependents: [],
    },
    {
      name: "a target's writes taint later readers even when the target landed first among several",
      landed: [
        txn("T1", 1, { writes: ["a"] }),
        txn("T2", 2, { writes: ["b"] }),
        txn("D", 3, { reads: ["b"] }),
      ],
      targets: ["T1", "T2"],
      dependents: ["D"],
    },
    {
      name: "targets interleaved with dependents, a bystander, and a txn that landed between the targets",
      landed: [
        txn("early", 1, { reads: ["a", "c"], writes: ["a", "c"] }),
        txn("T1", 2, { writes: ["a"] }),
        txn("D1", 3, { reads: ["a"], writes: ["b"] }),
        txn("T2", 4, { writes: ["c"] }),
        txn("bystander", 5, { reads: ["z"], writes: ["z"] }),
        txn("D2", 6, { reads: ["c"] }),
        txn("D3", 7, { reads: ["b"] }),
      ],
      targets: ["T1", "T2"],
      // "early" touched a and c but landed first, so it is not a dependent of either target.
      dependents: ["D1", "D2", "D3"],
    },
    {
      name: "a txn that reads a later target's path but landed before that target",
      landed: [
        txn("T1", 1, { writes: ["a"] }),
        txn("X", 2, { reads: ["b"] }),
        txn("T2", 3, { writes: ["b"] }),
      ],
      targets: ["T1", "T2"],
      dependents: [],
    },
    {
      name: "a target with no reads or writes",
      landed: [txn("T", 1), txn("U", 2, { reads: ["x"] })],
      targets: ["T"],
      dependents: [],
    },
  ];

  it.each(cases)("$name", ({ landed, targets, dependents }) => {
    const plan = planRecall(landed, { txns: targets });
    expect(plan.targets).toEqual(targets);
    expect(plan.dependents).toEqual(dependents);
  });

  it("does not depend on the order the Ledger hands the rows over", () => {
    const rows = [
      txn("A", 10, { writes: ["x"] }),
      txn("B", 20, { reads: ["x"], writes: ["y"] }),
      txn("C", 30, { reads: ["y"] }),
      txn("U", 40, { writes: ["z"] }),
    ];
    const expected = planRecall(rows, { txns: ["A"] });
    expect(expected.dependents).toEqual(["B", "C"]);
    for (const shuffled of [
      [rows[3]!, rows[2]!, rows[1]!, rows[0]!],
      [rows[2]!, rows[0]!, rows[3]!, rows[1]!],
    ]) {
      expect(planRecall(shuffled, { txns: ["A"] })).toEqual(expected);
    }
  });

  it("uses landedSeq, not the numbers' magnitude or gaps, to decide what landed after", () => {
    const plan = planRecall(
      [txn("D", 1000, { reads: ["x"] }), txn("T", 7, { writes: ["x"] }), txn("E", 8, { reads: ["x"] })],
      { txns: ["T"] },
    );
    expect(plan.dependents).toEqual(["E", "D"]);
  });

  it("leaves its input untouched", () => {
    const rows = [txn("B", 2, { reads: ["x"] }), txn("A", 1, { writes: ["x"] })];
    const copy = structuredClone(rows);
    planRecall(rows, { txns: ["A"] });
    expect(rows).toEqual(copy);
  });
});

describe("planRecall order", () => {
  it.each([
    { name: "one target", sel: { txns: ["B"] }, order: ["B"] },
    { name: "two targets, newest first", sel: { agent: "m" }, order: ["D", "B"] },
    { name: "no targets", sel: { agent: "nobody" }, order: [] },
  ])("reverts in reverse landed order: $name", ({ sel, order }) => {
    const landed = [
      txn("D", 40, { agent: "m" }),
      txn("A", 10),
      txn("B", 20, { agent: "m" }),
      txn("C", 30),
    ];
    const plan = planRecall(landed, sel);
    expect(plan.order).toEqual(order);
    // The plan lists targets oldest first, so order is exactly their reverse.
    expect(plan.order).toEqual([...plan.targets].reverse());
  });

  it("orders three targets by landedSeq, not by input order", () => {
    const plan = planRecall([txn("c", 3), txn("a", 1), txn("b", 2)], { txns: ["a", "b", "c"] });
    expect(plan.targets).toEqual(["a", "b", "c"]);
    expect(plan.order).toEqual(["c", "b", "a"]);
  });
});

describe("planRecall cascadeCandidates", () => {
  it("lists every dependent that wrote a path after the target, newest first", () => {
    const plan = planRecall(
      [
        txn("T", 1, { writes: ["a", "b"] }),
        txn("D1", 2, { reads: ["a"], writes: ["a"] }),
        txn("D2", 3, { writes: ["a", "c"] }),
        txn("D3", 4, { reads: ["c"], writes: ["b"] }),
      ],
      { txns: ["T"] },
    );
    expect(plan.dependents).toEqual(["D1", "D2", "D3"]);
    expect(plan.cascadeCandidates).toEqual({ T: { a: ["D2", "D1"], b: ["D3"], c: ["D2"] } });
  });

  it("includes paths the dependents wrote even when the target did not, for the transitive chain", () => {
    const plan = planRecall(
      [
        txn("A", 1, { writes: ["x"] }),
        txn("B", 2, { reads: ["x"], writes: ["y"] }),
        txn("C", 3, { reads: ["y"], writes: ["y", "w"] }),
      ],
      { txns: ["A"] },
    );
    expect(plan.cascadeCandidates).toEqual({ A: { y: ["C", "B"], w: ["C"] } });
  });

  it("lists a later writer of a dependent's path, because that writer is a dependent too", () => {
    const plan = planRecall(
      [txn("T", 1, { writes: ["x"] }), txn("D", 2, { reads: ["x"], writes: ["q"] }), txn("U", 3, { writes: ["q"] })],
      { txns: ["T"] },
    );
    expect(plan.dependents).toEqual(["D", "U"]);
    expect(plan.cascadeCandidates).toEqual({ T: { q: ["U", "D"] } });
  });

  it("never lists a bystander, even one that wrote a path next to the dependents' paths", () => {
    const plan = planRecall(
      [txn("T", 1, { writes: ["x"] }), txn("D", 2, { reads: ["x"], writes: ["q"] }), txn("U", 3, { writes: ["r"] })],
      { txns: ["T"] },
    );
    expect(plan.dependents).toEqual(["D"]);
    expect(plan.cascadeCandidates).toEqual({ T: { q: ["D"] } });
  });

  it("gives a target with no dependents an empty map, and a read-only dependent no entries", () => {
    expect(planRecall([txn("T", 1, { writes: ["x"] })], { txns: ["T"] }).cascadeCandidates).toEqual({ T: {} });
    expect(
      planRecall([txn("T", 1, { writes: ["x"] }), txn("D", 2, { reads: ["x"] })], { txns: ["T"] }).cascadeCandidates,
    ).toEqual({ T: {} });
  });

  it("lists, for each target, only dependents that landed after that target", () => {
    const plan = planRecall(
      [
        txn("T1", 1, { writes: ["a"] }),
        txn("D1", 2, { writes: ["a"] }),
        txn("T2", 3, { writes: ["b"] }),
        txn("D2", 4, { reads: ["b"], writes: ["a"] }),
      ],
      { txns: ["T1", "T2"] },
    );
    expect(plan.dependents).toEqual(["D1", "D2"]);
    expect(plan.cascadeCandidates).toEqual({
      T1: { a: ["D2", "D1"] },
      // D1 landed before T2, so a revert of T2 cannot conflict with it.
      T2: { a: ["D2"] },
    });
  });

  it("lists a path once per dependent even when the transaction names it twice", () => {
    const plan = planRecall(
      [txn("T", 1, { writes: ["x"] }), txn("D", 2, { reads: ["x"], writes: ["y", "y"] })],
      { txns: ["T"] },
    );
    expect(plan.cascadeCandidates).toEqual({ T: { y: ["D"] } });
  });

  it("has no entries at all for an empty plan", () => {
    expect(planRecall([txn("A", 1, { writes: ["x"] })], { agent: "nobody" }).cascadeCandidates).toEqual({});
  });
});

describe("nextCascade", () => {
  // T wrote a and b. D1 and D2 wrote a (D2 newer), D3 wrote b and is the newest of all.
  const plan = planRecall(
    [
      txn("T", 1, { writes: ["a", "b"] }),
      txn("D1", 2, { writes: ["a"] }),
      txn("D2", 3, { writes: ["a"] }),
      txn("D3", 4, { writes: ["b"] }),
    ],
    { txns: ["T"] },
  );
  const reverted = (...ids: string[]) => new Set(ids);

  it.each<[string, string[], string[], string | null]>([
    ["the newest dependent on the conflicting path", ["a"], [], "D2"],
    ["the next one once the newest is reverted", ["a"], ["D2"], "D1"],
    ["nothing once every candidate is reverted", ["a"], ["D2", "D1"], null],
    ["a path with a single candidate", ["b"], [], "D3"],
    ["nothing when that single candidate is reverted", ["b"], ["D3"], null],
    ["the newest across several conflicting paths", ["a", "b"], [], "D3"],
    ["the same answer whatever the order of the conflicting paths", ["b", "a"], [], "D3"],
    ["the newest of what is left across paths", ["a", "b"], ["D3"], "D2"],
    ["the oldest when everything newer is reverted", ["a", "b"], ["D3", "D2"], "D1"],
    ["nothing when all are reverted across paths", ["a", "b"], ["D1", "D2", "D3"], null],
    ["nothing for a path no dependent wrote", ["zzz"], [], null],
    ["a known path next to an unknown one", ["zzz", "a"], [], "D2"],
    ["nothing without conflicting paths", [], [], null],
    ["ids that are not candidates in the reverted set are ignored", ["a"], ["T", "other"], "D2"],
  ])("returns %s", (_name, conflictPaths, done, expected) => {
    expect(nextCascade(plan, "T", conflictPaths, reverted(...done))).toBe(expected);
  });

  it("returns null for a target that is not in the plan", () => {
    expect(nextCascade(plan, "unknown", ["a"], reverted())).toBeNull();
  });

  it("peels dependents off newest first while a conflict keeps recurring", () => {
    const done = new Set<string>();
    const peeled: string[] = [];
    for (let next = nextCascade(plan, "T", ["a", "b"], done); next !== null; next = nextCascade(plan, "T", ["a", "b"], done)) {
      peeled.push(next);
      done.add(next);
    }
    expect(peeled).toEqual(["D3", "D2", "D1"]);
  });

  it("does not modify the plan or the reverted set", () => {
    const copy = structuredClone(plan);
    const done = reverted("D2");
    nextCascade(plan, "T", ["a"], done);
    expect(plan).toEqual(copy);
    expect([...done]).toEqual(["D2"]);
  });

  it("picks the first path's candidate when the plan's dependents list does not know either", () => {
    // A hand-built plan: the Ledger never produces one, but the loop must not crash on it.
    const odd = {
      targets: ["T"],
      dependents: [],
      order: ["T"],
      cascadeCandidates: { T: { a: ["X"], b: ["Y"] } },
    };
    expect(nextCascade(odd, "T", ["a", "b"], new Set())).toBe("X");
  });

  it("compares per-target candidates, so a second target has its own list", () => {
    const two = planRecall(
      [
        txn("T1", 1, { writes: ["a"] }),
        txn("D1", 2, { writes: ["a"] }),
        txn("T2", 3, { writes: ["b"] }),
        txn("D2", 4, { reads: ["b"], writes: ["a"] }),
      ],
      { txns: ["T1", "T2"] },
    );
    expect(nextCascade(two, "T1", ["a"], new Set())).toBe("D2");
    expect(nextCascade(two, "T1", ["a"], new Set(["D2"]))).toBe("D1");
    expect(nextCascade(two, "T2", ["a"], new Set(["D2"]))).toBeNull();
  });
});

describe("planRecall with union paths", () => {
  const t = (id: string, seq: number, reads: string[], writes: string[], model = "m"): LandedTxn => ({ id, agent: "a", model, landedSeq: seq, commit: `c${seq}`, reads, writes });
  it("does not make later writers of a union path dependents", () => {
    const landed = [
      t("T", 1, ["src/registry.ts"], ["src/registry.ts", "src/units/x.ts"], "bad"),
      t("A", 2, ["src/registry.ts"], ["src/registry.ts", "src/units/y.ts"]),
      t("B", 3, ["src/units/x.ts"], ["src/units/z.ts"]),
    ];
    expect(planRecall(landed, { model: "bad" }, { union: ["src/registry.ts"] })).toMatchObject({ targets: ["T"], dependents: ["B"] });
    expect(planRecall(landed, { model: "bad" }).dependents).toEqual(["A", "B"]);
    expect(planRecall(landed, { model: "bad" }, { union: ["src/registry.ts"] }).cascadeCandidates.T).toEqual({ "src/units/z.ts": ["B"] });
  });
});
