// The counters over the Line: in flight by where the time goes, landings and their sparkline, trains, aborts,
// the transactions waiting for a human, and the trunk head.
import { describe, expect, it } from "vitest";
import { fold } from "../src/shared/reducers";
import type { Op, OpKind } from "../src/shared/types";
import { ago, sparkline, SPARK_BUCKET_MS, SPARK_BUCKETS, stats } from "../src/web/views/line/stats";
import e2eLand from "./fixtures/ops/e2e-land.json";

let seq = 0;
const op = (kind: OpKind, at: number, data: Record<string, unknown> = {}, txn: string | null = null, agent: string | null = null): Op => ({ seq: ++seq, at, kind, txn, agent, data });

describe("sparkline", () => {
  const now = 1_000_000;
  it.each<[string, number[], number, number, number[]]>([
    ["empty", [], 4, 1000, [0, 0, 0, 0]],
    ["one landing in the newest bucket", [now - 10], 4, 1000, [0, 0, 0, 1]],
    ["counts per bucket, oldest first", [now - 3500, now - 3400, now - 1500, now], 4, 1000, [2, 0, 1, 1]],
    ["drops landings older than the window or in the future", [now - 4000, now - 4001, now + 1], 4, 1000, [0, 0, 0, 0]],
  ])("%s", (_n, at, buckets, ms, out) => expect(sparkline(at, now, buckets, ms)).toEqual(out));

  it("defaults to ten minutes in thirty-second buckets", () => {
    expect(SPARK_BUCKETS * SPARK_BUCKET_MS).toBe(600_000);
    expect(sparkline([now], now)).toHaveLength(SPARK_BUCKETS);
  });
});

describe("ago", () => {
  it.each([
    [0, "now"],
    [999, "now"],
    [1000, "1s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [3_599_999, "59m"],
    [3_600_000, "1h"],
    [-5, "now"],
    [NaN, "now"],
  ])("ago(%d) = %s", (ms, out) => expect(ago(ms)).toBe(out));
});

describe("stats", () => {
  it("splits in flight by where the time goes and lists who waits for a human", () => {
    const s = fold([
      op("txn.open", 0, { attempt: 1, intent: "a" }, "t1", "a1"),
      op("txn.open", 0, { attempt: 1, intent: "b" }, "t2", "a2"),
      op("txn.submitted", 10, {}, "t2", "a2"),
      op("txn.open", 0, { attempt: 1, intent: "c" }, "t3", "a3"),
      op("txn.verifying", 20, { train: "tr1" }, "t3", "a3"),
      op("txn.open", 0, { attempt: 1, intent: "d" }, "t4", "a4"),
      op("txn.needs_human", 30, { reason: "scope_creep" }, "t4", "a4"),
    ]);
    expect(stats(s, 100)).toMatchObject({ inflight: 4, working: 1, queued: 1, verifying: 1, human: 1, needsHuman: ["t4"], landed: 0, head: null });
  });

  it("counts trains, the speculative ones and the bisected ones", () => {
    const s = fold([
      op("train.formed", 0, { train: "tr1", txns: ["a"], base: "x" }),
      op("train.formed", 1, { train: "tr2", txns: ["b"], base: "x", after: "tr1" }),
      op("train.bisect", 2, { train: "tr1", probe: ["a"], pass: true }),
    ]);
    expect(stats(s, 10)).toMatchObject({ trains: 2, speculative: 1, bisected: 1 });
  });

  it("reads the recorded scenario: landings, aborts by cause and the trunk head", () => {
    const ops = e2eLand as unknown as Op[];
    const s = fold(ops);
    const out = stats(s, s.now);
    expect(out).toMatchObject({ landed: 5, trains: 2, inflight: 0, aborts: 2 });
    expect(out.causes.map((c) => [c.label, c.count])).toEqual([
      ["failed verify", 1],
      ["stale read", 1],
    ]);
    expect(out.head).toEqual({ ...s.head, at: s.ticks.at(-1)!.at });
    expect(out.spark.reduce((a, b) => a + b, 0)).toBe(5);
  });
});
