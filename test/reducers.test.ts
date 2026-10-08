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

describe("refresh", () => {
  it("keeps one attempt when an open transaction is refreshed onto a newer snapshot", () => {
    const s = fold([open("t", "a", 1), op("txn.open", 2, { attempt: 1, refresh: true, snapshot: "s2" }, "t", "a"), move("txn.submitted", "t", "a", 3)]);
    expect(s.txns.get("t")!.attempts).toHaveLength(1);
    expect(s.txns.get("t")!.state).toBe("submitted");
  });
});

describe("a recall's revert commit", () => {
  const seed = op("trunk.advanced", 0, { seq: 0, sha: "s0", txns: [], train: null });
  const landed = (txn: string, at: number, seq: number) => op("trunk.advanced", at, { seq, sha: `s${seq}`, txns: [{ txn, sha: `s${seq}`, seq }], train: `tr${seq}` });

  it("is a tick of its own that carries the recall's id, not the seed's empty slot", () => {
    const s = fold([seed, landed("t1", 10, 1), op("trunk.advanced", 20, { seq: 2, sha: "s2", txns: [], train: null, recall: "rc_1" })]);
    expect(s.ticks).toEqual([
      { seq: 0, sha: "s0", txn: null, train: null, recall: null, at: 0 },
      { seq: 1, sha: "s1", txn: "t1", train: "tr1", recall: null, at: 10 },
      { seq: 2, sha: "s2", txn: null, train: null, recall: "rc_1", at: 20 },
    ]);
    expect(s.head).toEqual({ sha: "s2", seq: 2 });
  });

  it("is not counted as a landing, so landed and landed-per-minute stay about transactions", () => {
    const s = fold([seed, landed("t1", 10, 1), op("trunk.advanced", 20, { seq: 2, sha: "s2", txns: [], train: null, recall: "rc_1" })]);
    expect(counters(s, 30)).toMatchObject({ landed: 1, landedPerMinute: 1 });
  });

  it("leaves the seed without a recall", () => {
    expect(fold([seed]).ticks[0]!.recall).toBeNull();
  });

  it("keeps a train's ticks free of the recall field", () => {
    const s = fold([landed("t1", 10, 1)]);
    expect(s.ticks.map((t) => t.recall)).toEqual([null]);
  });
});

describe("a transaction that waits for a human", () => {
  const flow = [open("t", "a", 1), move("txn.submitted", "t", "a", 2), move("txn.ready", "t", "a", 3), move("txn.verifying", "t", "a", 4, { train: "tr" })];

  it("draws needs_human as its own open segment and counts the transaction as in flight", () => {
    const s = fold([...flow, move("txn.needs_human", "t", "a", 5, { reason: "human_path" })]);
    const t = s.txns.get("t")!;
    expect(t.state).toBe("needs_human");
    expect(t.reason).toBe("human_path");
    expect(t.attempts[0]!.segments.at(-1)).toEqual({ state: "needs_human", from: 5, to: null });
    expect(t.attempts[0]!.segments.at(-2)).toEqual({ state: "verifying", from: 4, to: 5 });
    expect(t.attempts[0]!.outcome).toBeNull();
    expect(counters(s).inflight).toBe(1);
  });

  it("closes the segment when the human approves and the transaction goes back to ready", () => {
    const s = fold([...flow, move("txn.needs_human", "t", "a", 5), move("txn.ready", "t", "a", 9, { approved: true })]);
    expect(s.txns.get("t")!.attempts[0]!.segments.slice(-2)).toEqual([
      { state: "needs_human", from: 5, to: 9 },
      { state: "ready", from: 9, to: null },
    ]);
  });

  it("closes it when the human rejects", () => {
    const s = fold([...flow, move("txn.needs_human", "t", "a", 5), move("txn.rejected", "t", "a", 8, { reason: "rejected_by_human" })]);
    const a = s.txns.get("t")!.attempts[0]!;
    expect(a.segments.at(-1)).toEqual({ state: "needs_human", from: 5, to: 8 });
    expect(a).toMatchObject({ outcome: "rejected", reason: "rejected_by_human", end: 8 });
  });
});

describe("lease.released", () => {
  // Built inside each test: `apply` ignores an op whose seq is not past the last one, and seq counts creation order.
  const granted = () => op("lease.granted", 2, { path: "src/format.ts", expires: 90 }, "holder", "a1");

  it("deletes the lease when its holder lets go", () => {
    expect(fold([open("holder", "a1", 1), granted()]).leases.size).toBe(1);
    const s = fold([open("holder", "a1", 1), granted(), op("lease.released", 5, { path: "src/format.ts", txn: "holder" })]);
    expect(s.leases.size).toBe(0);
  });

  it("does not delete the holder's lease when another transaction's release arrives", () => {
    const s = fold([open("holder", "a1", 1), granted(), op("lease.released", 5, { path: "src/format.ts", txn: "someone-else" })]);
    expect(s.leases.get("src/format.ts")).toEqual({ txn: "holder", expires: 90 });
  });

  it("ignores a release for a path nobody holds", () => {
    const s = fold([op("lease.released", 5, { path: "src/none.ts", txn: "t" })]);
    expect(s.leases.size).toBe(0);
  });

  it("deletes an expired lease: the release names the holder it expired from", () => {
    const s = fold([open("holder", "a1", 1), granted(), op("lease.released", 95, { path: "src/format.ts", txn: "holder", expired: true })]);
    expect(s.leases.size).toBe(0);
  });
});

describe("txn.failed", () => {
  it.each([
    ["verify_failed", "failed_verify"],
    ["tests_failed", "failed_verify"],
    ["tests", "failed_verify"],
    ["land_error", "land_error"],
    ["criterion_unmet", "criterion_unmet"],
  ])("counts the reason %s as the abort cause %s", (reason, cause) => {
    const s = fold([open("t", "a", 1), move("txn.failed", "t", "a", 2, { reason })]);
    expect(s.aborts).toEqual({ [cause]: 1 });
    expect(s.txns.get("t")).toMatchObject({ state: "failed", reason });
    expect(s.txns.get("t")!.attempts[0]).toMatchObject({ outcome: "failed", reason });
  });

  it("counts a failure without a reason as a plain failure and keeps the reason null", () => {
    const s = fold([open("t", "a", 1), move("txn.failed", "t", "a", 2)]);
    expect(s.aborts).toEqual({ failed: 1 });
    expect(s.txns.get("t")!.reason).toBeNull();
    expect(s.txns.get("t")!.attempts[0]!.reason).toBeNull();
  });

  it("adds up failures of different reasons under their own causes", () => {
    const s = fold([open("a", "x", 1), open("b", "y", 1), move("txn.failed", "a", "x", 2, { reason: "verify_failed" }), move("txn.failed", "b", "y", 2, { reason: "tests_failed" }), open("c", "z", 1), move("txn.failed", "c", "z", 2)]);
    expect(s.aborts).toEqual({ failed_verify: 2, failed: 1 });
  });
});

describe("refresh drops the stale warnings of the snapshot it replaced", () => {
  const refresh = (at: number, snapshot: string) => op("txn.open", at, { attempt: 1, refresh: true, snapshot }, "t", "a");
  const warn = (at: number, paths: string[]) => op("stale.warning", at, { paths, seq: at }, "t", "a");

  it("clears the warnings that were about reads of the old snapshot", () => {
    const s = fold([open("t", "a", 1), warn(2, ["src/format.ts"]), warn(3, ["src/ui/layout.ts"]), refresh(4, "s2")]);
    expect(s.txns.get("t")!.attempts[0]!.warnings).toEqual([]);
  });

  it("keeps warnings that arrive after the refresh: they are about the new snapshot", () => {
    const s = fold([open("t", "a", 1), warn(2, ["src/format.ts"]), refresh(4, "s2"), warn(6, ["src/index.ts"])]);
    expect(s.txns.get("t")!.attempts[0]!.warnings).toEqual([{ at: 6, paths: ["src/index.ts"] }]);
  });

  it("only touches the attempt that was refreshed", () => {
    const s = fold([
      open("t", "a", 1),
      warn(2, ["src/format.ts"]),
      move("txn.stale", "t", "a", 3, { reason: "stale_read", paths: [{ path: "src/format.ts", by: "x" }] }),
      open("t", "a", 5, 2),
      warn(6, ["src/index.ts"]),
      op("txn.open", 7, { attempt: 2, refresh: true, snapshot: "s3" }, "t", "a"),
    ]);
    const [first, second] = s.txns.get("t")!.attempts;
    expect(first!.warnings).toEqual([{ at: 2, paths: ["src/format.ts"] }]);
    expect(second!.warnings).toEqual([]);
  });

  it("is harmless when there is nothing to clear", () => {
    const s = fold([open("t", "a", 1), refresh(2, "s2")]);
    expect(s.txns.get("t")!.attempts).toHaveLength(1);
    expect(s.txns.get("t")!.attempts[0]!.warnings).toEqual([]);
  });
});
