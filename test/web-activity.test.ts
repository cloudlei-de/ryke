// The Line's activity feed: which ops become sentences, what each sentence says, and how the feed walks the log.
import { describe, expect, it } from "vitest";
import { fold } from "../src/shared/reducers";
import { OP_KINDS, type Op, type OpKind } from "../src/shared/types";
import { describeOp, endIndex, feed, plain, rawOps, type FeedItem } from "../src/web/views/line/activity";
import e2eLand from "./fixtures/ops/e2e-land.json";

let seq = 0;
const op = (kind: OpKind, data: Record<string, unknown> = {}, txn: string | null = "t_1", agent: string | null = "agent-01", at = 1000): Op => ({ seq: ++seq, at, kind, txn, agent, data });

// The state the feed reads intents and train sizes from.
const state = fold([
  { seq: 1, at: 0, kind: "txn.open", txn: "t_1", agent: "agent-01", data: { attempt: 1, intent: "Add the Energy category" } },
  { seq: 2, at: 0, kind: "txn.open", txn: "t_2", agent: "agent-02", data: { attempt: 1, intent: "Change the rounding rule" } },
  { seq: 3, at: 0, kind: "train.formed", txn: null, agent: null, data: { train: "tr_3", txns: ["t_1", "t_2", "t_9"], base: "b" } },
  { seq: 4, at: 0, kind: "train.formed", txn: null, agent: null, data: { train: "tr_1", txns: ["t_1"], base: "b" } },
]);

const said = (it: FeedItem | null) => (it ? { tone: it.tone, icon: it.icon, actor: it.actor, line: plain(it.text), subject: it.subject ? plain([it.subject]) : null, detail: it.detail ? plain(it.detail) : null } : null);

const T1 = "Add the Energy category";

const cases: [string, OpKind, Record<string, unknown>, ReturnType<typeof said>, { txn?: string | null; agent?: string | null }?][] = [
  ["a first attempt begins", "txn.open", { attempt: 1, intent: "x" }, { tone: null, icon: "pulse", actor: "agent-01", line: "began", subject: T1, detail: null }],
  ["a retry", "txn.open", { attempt: 2 }, { tone: null, icon: "retry", actor: "agent-01", line: "retried · attempt 2", subject: T1, detail: null }],
  ["a refresh onto a newer snapshot says nothing", "txn.open", { attempt: 1, refresh: true }, null],
  ["submitted is bookkeeping", "txn.submitted", { writes: ["a.ts"] }, null],
  ["ready is bookkeeping", "txn.ready", {}, null],
  ["verifying is told by its train", "txn.verifying", { train: "tr_1" }, null],
  ["a landing", "txn.landed", { seq: 7, sha: "939a38371234" }, { tone: "go", icon: "check", actor: "agent-01", line: "landed", subject: T1, detail: "seq 7 · 939a3837" }],
  [
    "a stale read names the path and the transaction that changed it",
    "txn.stale",
    { reason: "stale_read", paths: [{ path: "src/format.ts", seq: 3, by: "t_2" }, { path: "b.ts", seq: 3, by: "t_2" }] },
    { tone: "stop", icon: "retry", actor: "agent-01", line: "went stale", subject: T1, detail: "src/format.ts changed by Change the rounding rule · +1 more" },
  ],
  ["a text conflict", "txn.stale", { reason: "text_conflict", paths: [{ path: "CHANGELOG.md" }] }, { tone: "stop", icon: "retry", actor: "agent-01", line: "went stale", subject: T1, detail: "text conflict in CHANGELOG.md" }],
  ["a stale read without paths", "txn.stale", { reason: "stale_read", paths: [] }, { tone: "stop", icon: "retry", actor: "agent-01", line: "went stale", subject: T1, detail: null }],
  ["a failure names the first failing test", "txn.failed", { reason: "tests", failures: [{ name: "format › rounds", message: "x" }] }, { tone: "stop", icon: "x", actor: "agent-01", line: "failed verify", subject: T1, detail: "format › rounds" }],
  ["a failure without tests gives its reason", "txn.failed", { reason: "criterion_unmet" }, { tone: "stop", icon: "x", actor: "agent-01", line: "failed verify", subject: T1, detail: "criterion unmet" }],
  ["a rejection", "txn.rejected", { reason: "protected" }, { tone: "stop", icon: "ban", actor: "agent-01", line: "was rejected", subject: T1, detail: "wrote a protected path" }],
  ["a duplicate", "txn.rejected", { reason: "duplicate_of:t_2" }, { tone: "stop", icon: "ban", actor: "agent-01", line: "was rejected", subject: T1, detail: "duplicate of t_2" }],
  ["a human is needed", "txn.needs_human", { reason: "scope_creep" }, { tone: "caution", icon: "user", actor: "agent-01", line: "needs a human", subject: T1, detail: "scope creep" }],
  ["an abort", "txn.aborted", { reason: "max_attempts" }, { tone: "stop", icon: "x", actor: "agent-01", line: "gave up", subject: T1, detail: "max attempts reached" }],
  ["a recall of one transaction", "txn.recalled", {}, { tone: "recall", icon: "undo", actor: "agent-01", line: "was recalled", subject: T1, detail: null }],
  ["a dependent the recall took along", "txn.recalled", { reason: "cascade" }, { tone: "recall", icon: "undo", actor: "agent-01", line: "was recalled", subject: T1, detail: "taken along: its revert conflicted with a target" }],
  ["the seed commit", "trunk.advanced", { seq: 0, sha: "aaaaaaaabbbb", txns: [] }, { tone: null, icon: "commit", actor: null, line: "Trunk created", subject: null, detail: "seq 0 · aaaaaaaa" }, { txn: null, agent: null }],
  ["a landing on trunk is told by txn.landed", "trunk.advanced", { seq: 3, sha: "c", txns: [{ txn: "t_1", sha: "c", seq: 3 }] }, null, { txn: null, agent: null }],
  ["a recall's revert commit", "trunk.advanced", { seq: 9, sha: "dddddddd99", txns: [], recall: "rc_1" }, { tone: "recall", icon: "undo", actor: null, line: "Trunk reverted by recall rc_1", subject: null, detail: "seq 9 · dddddddd" }, { txn: null, agent: null }],
  ["a diverged trunk", "trunk.diverged", { store: "1111111122", ledger: "3333333344" }, { tone: "stop", icon: "alert", actor: null, line: "Trunk diverged from the store", subject: null, detail: "store 11111111 ≠ ledger 33333333" }, { txn: null, agent: null }],
  ["a train of several changes", "train.formed", { train: "tr_3", txns: ["t_1", "t_2", "t_9"] }, { tone: "run", icon: "train", actor: null, line: "Train of 3 changes formed", subject: null, detail: "tr_3" }, { txn: null, agent: null }],
  ["a speculative train behind another", "train.formed", { train: "tr_3", txns: ["t_1", "t_2"], after: "tr_1" }, { tone: "run", icon: "train", actor: null, line: "Train of 2 changes formed", subject: null, detail: "speculative, behind tr_1" }, { txn: null, agent: null }],
  ["a train of one says nothing its landing does not", "train.formed", { train: "tr_1", txns: ["t_1"] }, null, { txn: null, agent: null }],
  ["a bisect probe", "train.bisect", { train: "tr_3", probe: ["t_1", "t_2"], pass: false }, { tone: "run", icon: "train", actor: null, line: "Bisect: 2 changes failed", subject: null, detail: "tr_3" }, { txn: null, agent: null }],
  ["a confirmed speculative train is bookkeeping", "train.confirmed", { train: "tr_3", after: "tr_1" }, null, { txn: null, agent: null }],
  ["a landed train of several, sized from the state", "train.done", { train: "tr_3", outcome: "landed" }, { tone: "go", icon: "train", actor: null, line: "Train landed 3 changes together", subject: null, detail: "tr_3" }, { txn: null, agent: null }],
  ["a landed train of one", "train.done", { train: "tr_1", outcome: "landed" }, null, { txn: null, agent: null }],
  ["a discarded speculative train", "train.done", { train: "tr_3", outcome: "discarded" }, { tone: null, icon: "train", actor: null, line: "Speculative train discarded", subject: null, detail: "its base did not land · tr_3" }, { txn: null, agent: null }],
  ["a failed train", "train.done", { train: "tr_3", outcome: "failed" }, { tone: "stop", icon: "train", actor: null, line: "Train failed", subject: null, detail: "tr_3" }, { txn: null, agent: null }],
  ["a stale warning", "stale.warning", { paths: ["src/format.ts", "b.ts"] }, { tone: "caution", icon: "alert", actor: "agent-01", line: "was warned", subject: T1, detail: "src/format.ts +1 changed on trunk" }],
  ["heat is shown by the hot files card", "heat.changed", { path: "a.ts", value: 3 }, null],
  ["a lease taken is bookkeeping", "lease.granted", { path: "a.ts" }, null],
  ["waiting for a lease", "lease.waiting", { path: "src/format.ts" }, { tone: "caution", icon: "lock", actor: "agent-01", line: "waits for a lease", subject: T1, detail: "src/format.ts" }],
  ["a lease given back is bookkeeping", "lease.released", { path: "a.ts" }, null],
  ["a possible duplicate", "dup.warning", { other: "t_2" }, { tone: "caution", icon: "alert", actor: "agent-01", line: "may be a duplicate", subject: T1, detail: "of Change the rounding rule" }],
  ["a possible conflict", "conflict.warning", { other: "t_2" }, { tone: "caution", icon: "alert", actor: "agent-01", line: "may conflict", subject: T1, detail: "with Change the rounding rule" }],
  ["a verdict is shown on the transaction page", "judge.verdict", { question: "criterion_1", value: 0.9 }, null],
  ["a reads fallback is bookkeeping", "reads.fallback", { count: 3 }, null],
  ["a planned recall", "recall.planned", { recall: "rc_1", targets: ["t_1", "t_2"], dependents: ["t_3"] }, { tone: "recall", icon: "undo", actor: null, line: "Recall planned: 2 targets", subject: null, detail: "rc_1 · 1 dependent" }, { txn: null, agent: null }],
  ["a recall that landed", "recall.done", { recall: "rc_1", outcome: "pass" }, { tone: "recall", icon: "undo", actor: null, line: "Recall landed", subject: null, detail: "rc_1" }, { txn: null, agent: null }],
  ["a recall that did not", "recall.done", { recall: "rc_1", outcome: "verify_failed" }, { tone: "stop", icon: "undo", actor: null, line: "Recall ended: verify failed", subject: null, detail: "rc_1" }, { txn: null, agent: null }],
  ["a policy update", "policy.updated", { sha: "abcdef0123" }, { tone: null, icon: "shield", actor: null, line: "Policy updated", subject: null, detail: "abcdef01" }, { txn: null, agent: null }],
  ["a rejected policy", "policy.updated", { error: "bad json" }, { tone: "stop", icon: "alert", actor: null, line: "Policy rejected", subject: null, detail: "bad json" }, { txn: null, agent: null }],
];

describe("describeOp", () => {
  it.each(cases)("%s (%s)", (_n, kind, data, out, ids) => {
    expect(said(describeOp(op(kind, data, ids?.txn === undefined ? "t_1" : ids.txn, ids?.agent === undefined ? "agent-01" : ids.agent), state))).toEqual(out);
  });

  it("has a case for every op kind", () => {
    expect([...new Set(cases.map((c) => c[1]))].sort()).toEqual([...OP_KINDS].sort());
  });

  it("links the transaction by its intent and keeps its id", () => {
    const it = describeOp(op("txn.landed", { seq: 1, sha: "a" }), state)!;
    expect(it.subject).toEqual({ txn: "t_1", label: T1 });
  });

  it("falls back to the id for a transaction the state does not know, and clips a long intent", () => {
    expect(describeOp(op("txn.landed", { seq: 1, sha: "a" }, "t_x"), state)!.subject).toEqual({ txn: "t_x", label: "t_x" });
    const long = fold([{ seq: 1, at: 0, kind: "txn.open", txn: "t_l", agent: "a", data: { attempt: 1, intent: "x".repeat(200) } }]);
    const label = (describeOp(op("txn.landed", { seq: 1, sha: "a" }, "t_l"), long)!.subject as { label: string }).label;
    expect(label).toHaveLength(72);
    expect(label.endsWith("…")).toBe(true);
    // named as the cause in a detail line, it gets less room
    const cause = describeOp(op("dup.warning", { other: "t_l" }), long)!.detail!;
    expect((cause[1] as { label: string }).label).toHaveLength(44);
  });
});

describe("feed", () => {
  const ops = e2eLand as unknown as Op[];
  const s = fold(ops);

  it("lists sentences newest first", () => {
    const items = feed(ops, s.seq, s);
    expect(items.length).toBeGreaterThan(5);
    expect(items.map((i) => i.seq)).toEqual([...items.map((i) => i.seq)].sort((a, b) => b - a));
    expect(items.every((i) => describeOp(ops.find((o) => o.seq === i.seq)!, s) !== null)).toBe(true);
  });

  it("stops at the replay's position and at the limit", () => {
    const at = ops[30]!.seq;
    expect(feed(ops, at, s).every((i) => i.seq <= at)).toBe(true);
    expect(feed(ops, s.seq, s, 3)).toHaveLength(3);
    expect(feed([], 10, s)).toEqual([]);
  });

  it("tells the stale read of the recording with its culprit", () => {
    const stale = feed(ops, s.seq, s).find((i) => i.icon === "retry" && plain(i.text) === "went stale")!;
    expect(plain(stale.detail!)).toMatch(/^src\/format\.ts changed by /);
  });
});

describe("rawOps", () => {
  const ops = e2eLand as unknown as Op[];
  it("is every op up to the position, newest first, up to the limit", () => {
    const at = ops[20]!.seq;
    const raw = rawOps(ops, at, 5);
    expect(raw.map((o) => o.seq)).toEqual(ops.filter((o) => o.seq <= at).slice(-5).reverse().map((o) => o.seq));
  });
});

describe("plain", () => {
  it("joins words, intents and paths, and skips a missing part", () => {
    expect(plain(["a ", { txn: "t_1", label: "Intent" }, " in ", { code: "x.ts" }, null])).toBe("a Intent in x.ts");
  });
});

describe("endIndex", () => {
  const log = [1, 2, 5, 9].map((n) => ({ seq: n }) as Op);
  it.each([
    [0, 0],
    [1, 1],
    [4, 2],
    [5, 3],
    [9, 4],
    [100, 4],
  ])("ops at or before seq %d end at index %d", (upTo, i) => expect(endIndex(log, upTo)).toBe(i));
  it("is 0 for an empty log", () => expect(endIndex([], 5)).toBe(0));
});
