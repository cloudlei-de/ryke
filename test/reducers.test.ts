import { describe, expect, it } from "vitest";
import { apply, counters, fold, heatAt, initial } from "../src/shared/reducers";
import type { Op, OpKind } from "../src/shared/types";

let seq = 0;
const op = (kind: OpKind, at: number, data: Record<string, unknown> = {}, txn: string | null = null, agent: string | null = null): Op => ({
  seq: ++seq,
  at,
  kind,
  txn,
  agent,
  data,
});
const open = (txn: string, agent: string, at: number, attempt = 1) => op("txn.open", at, { attempt, intent: `do ${txn}`, model: "m" }, txn, agent);
const move = (kind: OpKind, txn: string, agent: string, at: number, data: Record<string, unknown> = {}) => op(kind, at, data, txn, agent);

describe("apply", () => {
  it("tracks one transaction from open to landed with segments per state", () => {
    const s = fold([
      op("trunk.advanced", 0, { seq: 0, sha: "s0", txns: [], train: null }),
      open("t1", "a1", 10),
      move("txn.submitted", "t1", "a1", 20),
      move("txn.ready", "t1", "a1", 21),
      op("train.formed", 22, { train: "tr1", txns: ["t1"], base: "s0" }),
      move("txn.verifying", "t1", "a1", 22, { train: "tr1" }),
      move("txn.landed", "t1", "a1", 30, { train: "tr1", sha: "s1", seq: 1 }),
      op("trunk.advanced", 30, { seq: 1, sha: "s1", txns: [{ txn: "t1", sha: "s1", seq: 1 }], train: "tr1" }),
      op("train.done", 31, { train: "tr1", outcome: "landed" }),
    ]);
    const t = s.txns.get("t1")!;
    expect(t).toMatchObject({ state: "landed", sha: "s1", landedSeq: 1, train: "tr1", agent: "a1", intent: "do t1" });
    expect(t.attempts).toHaveLength(1);
    expect(t.attempts[0]!.segments).toEqual([
      { state: "open", from: 10, to: 20 },
      { state: "submitted", from: 20, to: 21 },
      { state: "ready", from: 21, to: 22 },
      { state: "verifying", from: 22, to: 30 },
    ]);
    expect(t.attempts[0]).toMatchObject({ end: 30, outcome: "landed" });
    expect(s.head).toEqual({ sha: "s1", seq: 1 });
    expect(s.ticks.map((k) => k.txn)).toEqual([null, "t1"]);
    expect(s.trains.get("tr1")).toMatchObject({ outcome: "landed", doneAt: 31, txns: ["t1"] });
    expect(s.agents).toEqual(["a1"]);
  });

  it("records a stale abort with its paths and a retry continuing on the same row", () => {
    const s = fold([
      open("t2", "a2", 1),
      move("txn.submitted", "t2", "a2", 2),
      move("txn.stale", "t2", "a2", 3, { reason: "stale_read", paths: [{ path: "src/format.ts", seq: 4, by: "t9" }] }),
      open("t2", "a2", 5, 2),
      op("stale.warning", 6, { paths: ["src/ui/layout.ts"], seq: 5 }, "t2", "a2"),
    ]);
    const t = s.txns.get("t2")!;
    expect(t.state).toBe("open");
    expect(t.attempt).toBe(2);
    expect(t.attempts.map((a) => a.outcome)).toEqual(["stale", null]);
    expect(t.attempts[0]!.stale).toEqual([{ path: "src/format.ts", by: "t9" }]);
    expect(t.attempts[1]!.warnings).toEqual([{ at: 6, paths: ["src/ui/layout.ts"] }]);
    expect(s.aborts).toEqual({ stale_read: 1 });
  });

  it.each([
    ["txn.stale", "text_conflict", "text_conflict"],
    ["txn.stale", "stale_read", "stale_read"],
    ["txn.failed", "tests", "failed_verify"],
    ["txn.failed", "criterion_unmet", "criterion_unmet"],
    ["txn.rejected", "protected", "protected"],
    ["txn.rejected", "duplicate_of:t_x", "duplicate"],
    ["txn.aborted", "max_attempts", "max_attempts"],
  ] as const)("counts %s/%s as abort cause %s", (kind, reason, cause) => {
    const s = fold([open("t", "a", 1), move(kind, "t", "a", 2, { reason })]);
    expect(s.aborts).toEqual({ [cause]: 1 });
  });

  it("does not count an agent's own abort as a cause", () => {
    expect(fold([open("t", "a", 1), move("txn.aborted", "t", "a", 2, { reason: "agent_abort" })]).aborts).toEqual({});
  });

  it("draws a lease wait as its own segment until the lease is granted", () => {
    const s = fold([
      open("t3", "a3", 1),
      op("lease.waiting", 2, { path: "src/format.ts", owner: "t4" }, "t3", "a3"),
      op("lease.waiting", 3, { path: "src/format.ts", owner: "t4" }, "t3", "a3"),
      op("lease.granted", 4, { path: "src/format.ts", expires: 90 }, "t3", "a3"),
    ]);
    expect(s.txns.get("t3")!.attempts[0]!.segments).toEqual([
      { state: "open", from: 1, to: 2 },
      { state: "lease_wait", from: 2, to: 4 },
      { state: "open", from: 4, to: null },
    ]);
    expect(s.leases.get("src/format.ts")).toEqual({ txn: "t3", expires: 90 });
    apply(s, op("lease.released", 5, { path: "src/format.ts", txn: "t3" }));
    expect(s.leases.size).toBe(0);
  });

  it("records bisection probes, recalls, recalled transactions and the policy", () => {
    const s = fold([
      op("policy.updated", 0, { policy: { trainMax: 8 } }),
      op("train.formed", 1, { train: "tr", txns: ["a", "b"], base: "s0" }),
      op("train.bisect", 2, { train: "tr", probe: ["a"], pass: true }),
      open("x", "ag", 3),
      move("txn.landed", "x", "ag", 4, { sha: "s", seq: 1 }),
      op("recall.planned", 5, { recall: "rc", targets: ["x"], dependents: ["y"] }),
      move("txn.recalled", "x", "ag", 6, { reason: "target" }),
      op("recall.done", 7, { recall: "rc", outcome: "pass", cascade: ["y"] }),
    ]);
    expect(s.trains.get("tr")!.probes).toEqual([{ txns: ["a"], pass: true, at: 2 }]);
    expect(s.recalls).toEqual([{ id: "rc", at: 5, targets: ["x"], dependents: ["y"], cascade: ["y"], outcome: "pass" }]);
    expect(s.txns.get("x")!.state).toBe("recalled");
    expect(s.policy).toEqual({ trainMax: 8 });
  });

  it("ignores ops it has already applied and ops for unknown transactions", () => {
    const s = initial();
    const o = open("t", "a", 1);
    apply(s, o);
    apply(s, o);
    expect(s.txns.get("t")!.attempts).toHaveLength(1);
    expect(() => apply(s, move("txn.landed", "ghost", "a", 2))).not.toThrow();
    expect(s.txns.has("ghost")).toBe(false);
  });

  it("keeps the newest 12 ops in the ticker", () => {
    const ops = Array.from({ length: 20 }, (_, i) => op("heat.changed", i, { path: `p${i}`, value: 1 }));
    const s = fold(ops);
    expect(s.ticker).toHaveLength(12);
    expect(s.ticker[0]!.data.path).toBe("p19");
  });

  it("folds up to a seq for replay", () => {
    const ops = [open("t", "a", 1), move("txn.submitted", "t", "a", 2), move("txn.ready", "t", "a", 3)];
    expect(fold(ops, ops[1]!.seq).txns.get("t")!.state).toBe("submitted");
    expect(fold(ops).txns.get("t")!.state).toBe("ready");
  });
});

describe("counters and heat", () => {
  it("counts in-flight work, landings in the last minute and trains", () => {
    const ops = [
      open("a", "x", 0),
      open("b", "y", 0),
      op("train.formed", 1, { train: "tr", txns: ["a"], base: "s" }),
      move("txn.landed", "a", "x", 1000, { sha: "s1", seq: 1 }),
      op("trunk.advanced", 1000, { seq: 1, sha: "s1", txns: [{ txn: "a", sha: "s1", seq: 1 }], train: "tr" }),
      op("trunk.advanced", 70_000, { seq: 2, sha: "s2", txns: [{ txn: "c", sha: "s2", seq: 2 }], train: "tr2" }),
    ];
    const s = fold(ops);
    expect(counters(s)).toEqual({ inflight: 1, landedPerMinute: 1, landed: 2, aborts: {}, trains: 1 });
    expect(counters(s, 30_000).landedPerMinute).toBe(1);
  });

  it("decays heat to the given time and marks hot paths", () => {
    const s = fold([op("heat.changed", 0, { path: "src/format.ts", value: 4 }), op("heat.changed", 0, { path: "src/a.ts", value: 1 })]);
    expect(heatAt(s, 0)).toEqual([
      { path: "src/format.ts", value: 4, hot: true },
      { path: "src/a.ts", value: 1, hot: false },
    ]);
    const later = heatAt(s, 5 * 60_000);
    expect(later[0]).toEqual({ path: "src/format.ts", value: 2, hot: true });
    expect(later[1]!.value).toBeCloseTo(0.5);
  });
});
