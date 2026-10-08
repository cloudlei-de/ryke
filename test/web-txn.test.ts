import { describe, expect, it } from "vitest";
import e2e from "./fixtures/ops/e2e-land.json";
import { unifiedDiff } from "../src/shared/diff";
import { TXN_STATES, type Op } from "../src/shared/types";
import type { TxnDetail } from "../src/worker/ledger/ledger";
import { computeDelta, deltaRequest, deltaView, fileFetcher, MAX_DELTA_PATHS, type FetchFile } from "../src/web/views/txn/delta";
import {
  accessRows,
  attemptDetail,
  attemptMarks,
  attemptRows,
  clock,
  diffLines,
  diffStat,
  duration,
  evidenceUrl,
  evidenceView,
  lastSeqFor,
  loadedSeq,
  previewFor,
  previewUrl,
  reasonLabel,
  selectAttempt,
  shortSha,
  shouldRefetch,
  stateLabel,
  stateSignal,
  testsSummary,
  verdictRow,
  verdictRows,
  type DetailOp,
  type Marks,
} from "../src/web/views/txn/format";

// ---------------------------------------------------------------------------------------------
// fixtures: the recorded op log of `npm run e2e:land`, cut down to what GET /api/txns/:id returns

const recorded = e2e as unknown as Op[];
const opsOf = (txn: string): DetailOp[] => recorded.filter((o) => o.txn === txn).map(({ seq, at, kind, data }) => ({ seq, at, kind, data }));
const LANDED = "t_muyvqoug28lz";
const STALE = "t_muyvqps5mhz7";
const FAILED = "t_muyvqs36f4d2";

let seq = 0;
const op = (kind: string, at: number, data: Record<string, unknown> = {}): DetailOp => ({ seq: ++seq, at, kind, data });
const SNAP1 = "1111111111111111111111111111111111111111";
const SNAP2 = "2222222222222222222222222222222222222222";
const SNAP3 = "3333333333333333333333333333333333333333";
const open = (at: number, attempt: number, snapshot: string) => op("txn.open", at, { attempt, snapshot, snapshotSeq: attempt, intent: "x", model: "m" });

// ---------------------------------------------------------------------------------------------
// state and reason vocabulary

describe("stateSignal", () => {
  const table: [string, string][] = [
    ["open", "none"],
    ["submitted", "none"],
    ["ready", "none"],
    ["verifying", "run"],
    ["landed", "go"],
    ["stale", "stop"],
    ["failed", "stop"],
    ["rejected", "stop"],
    ["needs_human", "caution"],
    ["aborted", "none"],
    ["recalled", "recall"],
    ["something_new", "none"],
  ];
  it.each(table)("%s -> %s", (state, signal) => {
    expect(stateSignal(state)).toBe(signal);
  });

  it("answers for every state of the state machine", () => {
    expect(TXN_STATES.map((s) => stateSignal(s))).toHaveLength(TXN_STATES.length);
  });
});

describe("stateLabel", () => {
  it.each([
    ["needs_human", "needs human"],
    ["landed", "landed"],
    ["open", "open"],
  ])("%s -> %s", (state, label) => {
    expect(stateLabel(state)).toBe(label);
  });
});

describe("reasonLabel", () => {
  const table: [string | null | undefined, string][] = [
    [null, ""],
    [undefined, ""],
    ["", ""],
    ["stale_read", "stale read"],
    ["text_conflict", "text conflict"],
    ["tests", "tests failed"],
    ["tests_failed", "tests failed"],
    ["verify_failed", "verify failed"],
    ["test_tamper", "test tampering"],
    ["criterion_unmet", "criterion unmet"],
    ["criterion_uncertain", "criterion uncertain"],
    ["scope_creep", "scope creep"],
    ["human_path", "touches a human-review path"],
    ["protected", "wrote a protected path"],
    ["empty", "empty change"],
    ["max_attempts", "max attempts reached"],
    ["agent_abort", "aborted by the agent"],
    ["rejected_by_human", "rejected by a human"],
    ["approved", "approved by a human"],
    ["duplicate_of:t_abc123", "duplicate of t_abc123"],
    ["brand_new_reason", "brand new reason"],
  ];
  it.each(table)("%s -> %s", (reason, label) => {
    expect(reasonLabel(reason)).toBe(label);
  });
});

// ---------------------------------------------------------------------------------------------
// small formatters

describe("shortSha", () => {
  it.each([
    [SNAP1, "11111111"],
    ["abcdef0", "abcdef0"],
    [null, ""],
    [undefined, ""],
    ["", ""],
  ])("%s -> %s", (sha, out) => {
    expect(shortSha(sha)).toBe(out);
  });
});

describe("clock", () => {
  it.each([
    [new Date(2026, 9, 8, 14, 3, 7), "14:03:07"],
    [new Date(2026, 9, 8, 0, 0, 0), "00:00:00"],
    [new Date(2026, 9, 8, 23, 59, 59, 999), "23:59:59"],
  ])("%s -> %s", (date, text) => {
    expect(clock(date.getTime())).toBe(text);
  });
  it("prints a dash for a missing time", () => {
    expect(clock(null)).toBe("—");
  });
});

describe("duration", () => {
  it.each([
    [0, "0 ms"],
    [420, "420 ms"],
    [999, "999 ms"],
    [1000, "1.0 s"],
    [1234, "1.2 s"],
    [59_949, "59.9 s"],
    [59_950, "1 m 00 s"],
    [60_000, "1 m 00 s"],
    [184_000, "3 m 04 s"],
    [3_600_000, "60 m 00 s"],
    [-5, ""],
    [Number.NaN, ""],
  ])("%s -> %s", (ms, text) => {
    expect(duration(ms)).toBe(text);
  });
});

// ---------------------------------------------------------------------------------------------
// live refetch

describe("lastSeqFor / shouldRefetch / loadedSeq", () => {
  const ops = [
    { seq: 1, txn: null },
    { seq: 2, txn: "t_a" },
    { seq: 3, txn: "t_b" },
    { seq: 4, txn: "t_a" },
    { seq: 5, txn: null },
    { seq: 6, txn: "t_b" },
  ];
  it.each([
    ["t_a", 4],
    ["t_b", 6],
    ["t_none", 0],
  ])("last op of %s is seq %i", (id, seqOut) => {
    expect(lastSeqFor(ops, id)).toBe(seqOut);
  });
  it("is 0 for an empty log", () => {
    expect(lastSeqFor([], "t_a")).toBe(0);
  });

  it.each([
    [5, 4, true],
    [4, 4, false],
    [3, 4, false],
    [0, 0, false],
    [1, 0, true],
  ])("live %i vs loaded %i -> %s", (live, loaded, want) => {
    expect(shouldRefetch(live, loaded)).toBe(want);
  });

  it("reads the loaded seq from the detail's own ops", () => {
    expect(loadedSeq({ ops: opsOf(STALE) } as TxnDetail)).toBe(24);
    expect(loadedSeq({ ops: [] } as unknown as TxnDetail)).toBe(0);
  });
});

describe("selectAttempt", () => {
  it.each([
    [null, [1, 2, 3], 3],
    [2, [1, 2, 3], 2],
    [1, [1], 1],
    [7, [1, 2], 2],
    [null, [], 1],
  ])("picked %s of %j -> %i", (picked, attempts, want) => {
    expect(selectAttempt(picked, attempts)).toBe(want);
  });
});

// ---------------------------------------------------------------------------------------------
// attempts timeline

describe("attemptRows from the recorded e2e:land log", () => {
  it("a landed transaction is one attempt that ends landed", () => {
    const [row, ...rest] = attemptRows(opsOf(LANDED));
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      attempt: 1,
      snapshot: "e68b7dd2fd9ba34aa164e0e446d30e4e0ca37a53",
      start: 1791424243567,
      state: "landed",
      outcome: "landed",
      reason: null,
      bisected: false,
      approved: false,
      stale: [],
      conflicts: [],
      protectedPaths: [],
      failures: [],
    });
    expect(row!.end).toBe(recorded.find((o) => o.seq === 17)!.at);
  });

  it("a stale transaction records the culprit paths even though the op carries no attempt", () => {
    const [row] = attemptRows(opsOf(STALE));
    expect(row).toMatchObject({ attempt: 1, state: "stale", outcome: "stale", reason: "stale_read" });
    expect(row!.stale).toEqual([{ path: "src/format.ts", by: "t_muyvqoug28lz" }]);
    expect(row!.end).toBe(recorded.find((o) => o.seq === 24)!.at);
  });

  it("keeps stale, duplicate and conflict warnings in the order they arrived", () => {
    const [row] = attemptRows(opsOf(STALE));
    expect(row!.warnings.map((w) => [w.kind, w.text])).toEqual([
      ["duplicate", "possible duplicate of t_muyvqp8vqo5e · noul 0.50"],
      ["conflict", "possible conflict with t_muyvqp8vqo5e · score 1.00 · confidence 0.00"],
      ["stale", "src/format.ts changed on trunk (seq 2)"],
    ]);
    expect(row!.warnings[2]!.paths).toEqual(["src/format.ts"]);
    expect(row!.warnings[0]!.paths).toEqual(["src/ui/layout.ts"]);
  });

  it("a failed transaction keeps the failing test and the bisection flag", () => {
    const [row] = attemptRows(opsOf(FAILED));
    expect(row).toMatchObject({ outcome: "failed", reason: "tests", bisected: true });
    expect(row!.failures).toEqual([{ name: "broken by design", message: "Expected values to be strictly equal:\n\n2 !== 3" }]);
  });
});

describe("attemptRows on synthetic logs", () => {
  it("is empty without ops", () => {
    expect(attemptRows([])).toEqual([]);
  });

  it("follows retries: each txn.open starts the next attempt with its own snapshot", () => {
    const rows = attemptRows([
      open(1000, 1, SNAP1),
      op("txn.submitted", 1100, { attempt: 1 }),
      op("txn.stale", 1200, { attempt: 1, reason: "stale_read", paths: [{ path: "a.ts", seq: 3, by: "t_x" }] }),
      open(2000, 2, SNAP2),
      op("txn.submitted", 2100, { attempt: 2 }),
      op("txn.ready", 2200, { attempt: 2 }),
      op("txn.verifying", 2300, { attempt: 2, train: "tr_1" }),
    ]);
    expect(rows.map((r) => [r.attempt, shortSha(r.snapshot), r.start, r.end, r.state, r.outcome])).toEqual([
      [1, "11111111", 1000, 1200, "stale", "stale"],
      [2, "22222222", 2000, null, "verifying", null],
    ]);
  });

  it("numbers an open without data.attempt as the next attempt", () => {
    const rows = attemptRows([op("txn.open", 1, { snapshot: SNAP1 }), op("txn.failed", 2, { reason: "tests" }), op("txn.open", 3, { snapshot: SNAP2 })]);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("orders by seq even when the API hands the ops out of order", () => {
    const a = open(1000, 1, SNAP1);
    const b = op("txn.submitted", 1100, { attempt: 1 });
    expect(attemptRows([b, a]).map((r) => [r.attempt, r.state])).toEqual([[1, "submitted"]]);
  });

  it("makes a row for an attempt whose open op is missing", () => {
    const rows = attemptRows([op("txn.landed", 500, { attempt: 2, sha: SNAP3, seq: 4 })]);
    expect(rows).toEqual([expect.objectContaining({ attempt: 2, snapshot: null, start: 500, end: 500, outcome: "landed" })]);
  });

  it("a text conflict lists conflicts, not stale reads", () => {
    const [row] = attemptRows([
      open(1, 1, SNAP1),
      op("txn.stale", 5, { attempt: 1, reason: "text_conflict", paths: [{ path: "src/ui/layout.ts" }] }),
    ]);
    expect(row).toMatchObject({ outcome: "stale", reason: "text_conflict", stale: [], conflicts: ["src/ui/layout.ts"] });
  });

  it("a protected-path rejection lists the protected paths", () => {
    const [row] = attemptRows([open(1, 1, SNAP1), op("txn.rejected", 5, { attempt: 1, reason: "protected", paths: ["test/routes.test.ts"] })]);
    expect(row).toMatchObject({ outcome: "rejected", reason: "protected", protectedPaths: ["test/routes.test.ts"], stale: [] });
  });

  it("other rejections list nothing", () => {
    const [row] = attemptRows([open(1, 1, SNAP1), op("txn.rejected", 5, { attempt: 1, reason: "duplicate_of:t_z", paths: ["x.ts"] })]);
    expect(row).toMatchObject({ outcome: "rejected", protectedPaths: [] });
  });

  it("max attempts blames the cause of the last attempt", () => {
    const rows = attemptRows([
      open(1, 3, SNAP3),
      op("txn.aborted", 9, {
        attempt: 3,
        reason: "max_attempts",
        cause: { state: "stale", reason: "stale_read" },
        paths: [{ path: "src/format.ts", seq: 2, by: "t_q" }],
      }),
    ]);
    expect(rows[0]).toMatchObject({ outcome: "aborted", reason: "max_attempts", stale: [{ path: "src/format.ts", by: "t_q" }] });

    const failed = attemptRows([
      open(1, 3, SNAP3),
      op("txn.aborted", 9, { attempt: 3, reason: "max_attempts", cause: { state: "failed", reason: "tests" }, failures: [{ name: "n", message: "m" }] }),
    ]);
    expect(failed[0]).toMatchObject({ outcome: "aborted", failures: [{ name: "n", message: "m" }], stale: [] });
  });

  it("an attempt waiting for a human is not over, and approval is remembered", () => {
    const rows = attemptRows([
      open(1, 1, SNAP1),
      op("txn.submitted", 2, { attempt: 1 }),
      op("txn.needs_human", 5, { attempt: 1, reason: "criterion_uncertain" }),
    ]);
    expect(rows[0]).toMatchObject({ state: "needs_human", outcome: null, end: null, reason: "criterion_uncertain", approved: false });

    const approved = attemptRows([
      open(1, 1, SNAP1),
      op("txn.needs_human", 5, { attempt: 1, reason: "criterion_uncertain" }),
      op("txn.ready", 6, { attempt: 1, approved: true }),
      op("txn.landed", 9, { attempt: 1, sha: SNAP2, seq: 1 }),
    ]);
    expect(approved[0]).toMatchObject({ state: "landed", outcome: "landed", reason: null, approved: true, end: 9 });
  });

  it("recall keeps the end time of the landing and the reason when none is given", () => {
    const base = [open(1, 1, SNAP1), op("txn.landed", 9, { attempt: 1, sha: SNAP2, seq: 1 })];
    expect(attemptRows([...base, op("txn.recalled", 20, { attempt: 1 })])[0]).toMatchObject({ state: "recalled", outcome: "recalled", end: 9, reason: null });
    expect(attemptRows([...base, op("txn.recalled", 20, { attempt: 1, reason: "model:sloppy-v0" })])[0]).toMatchObject({ outcome: "recalled", reason: "model:sloppy-v0" });
  });

  it("ignores ops of other kinds and malformed payloads", () => {
    const rows = attemptRows([
      open(1, 1, SNAP1),
      op("judge.verdict", 2, { attempt: 1, question: "judge", value: 1 }),
      op("heat.changed", 3, { path: "x" }),
      op("txn.stale", 4, { attempt: 1, reason: "stale_read", paths: "oops" }),
      op("stale.warning", 5, { attempt: 1, paths: 7 }),
      op("txn.failed", 6, { attempt: 1, reason: "tests", failures: [{ name: 3 }, { name: "ok", message: "fine" }, null] }),
    ]);
    expect(rows[0]).toMatchObject({ stale: [], failures: [{ name: "ok", message: "fine" }] });
    expect(rows[0]!.warnings).toEqual([{ at: 5, kind: "stale", text: "files it read changed on trunk", paths: [] }]);
  });

  it("puts a stale warning without an attempt on the current attempt", () => {
    const rows = attemptRows([open(1, 1, SNAP1), op("txn.stale", 2, { attempt: 1 }), open(3, 2, SNAP2), op("stale.warning", 4, { paths: ["a.ts", "b.ts"], seq: 9 })]);
    expect(rows[0]!.warnings).toEqual([]);
    expect(rows[1]!.warnings).toEqual([{ at: 4, kind: "stale", text: "a.ts, b.ts changed on trunk (seq 9)", paths: ["a.ts", "b.ts"] }]);
  });
});

// ---------------------------------------------------------------------------------------------
// diff classification

describe("diffLines", () => {
  type Row = [string, string | null, number | null, number | null];
  const rows = (patch: string): Row[] => diffLines(patch).map((l) => [l.kind, l.text, l.old, l.new]);

  it("is empty for an empty patch", () => {
    expect(diffLines("")).toEqual([]);
  });

  it("classifies a modification hunk and numbers both sides", () => {
    const patch = ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", "@@ -3,4 +3,4 @@", " keep", "-old line", "+new line", " tail", ""].join("\n");
    expect(rows(patch)).toEqual([
      ["file", "diff --git a/f.ts b/f.ts", null, null],
      ["file", "--- a/f.ts", null, null],
      ["file", "+++ b/f.ts", null, null],
      ["hunk", "@@ -3,4 +3,4 @@", null, null],
      ["ctx", "keep", 3, 3],
      ["del", "old line", 4, null],
      ["add", "new line", null, 4],
      ["ctx", "tail", 5, 5],
    ]);
  });

  it("calls a new file's mode line meta and counts only new lines", () => {
    const patch = ["diff --git a/n.ts b/n.ts", "new file mode 100644", "--- /dev/null", "+++ b/n.ts", "@@ -0,0 +1,2 @@", "+one", "+two", ""].join("\n");
    expect(rows(patch)).toEqual([
      ["file", "diff --git a/n.ts b/n.ts", null, null],
      ["meta", "new file mode 100644", null, null],
      ["file", "--- /dev/null", null, null],
      ["file", "+++ b/n.ts", null, null],
      ["hunk", "@@ -0,0 +1,2 @@", null, null],
      ["add", "one", null, 1],
      ["add", "two", null, 2],
    ]);
  });

  it("reads removed lines that look like file headers as content once a hunk has started", () => {
    const patch = ["--- a/s.sql", "+++ b/s.sql", "@@ -1,2 +1,2 @@", "--- a comment", "+++ b comment", " x"].join("\n");
    expect(rows(patch).slice(3)).toEqual([
      ["del", "-- a comment", 1, null],
      ["add", "++ b comment", null, 1],
      ["ctx", "x", 2, 2],
    ]);
  });

  it("handles several hunks, the no-newline marker and a second file", () => {
    const patch = [
      "diff --git a/a b/a",
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+b",
      "@@ -10,2 +10,2 @@",
      " c",
      "-d",
      "+e",
      "diff --git a/z b/z",
      "deleted file mode 100644",
      "@@ -1 +0,0 @@",
      "-z",
    ].join("\n");
    expect(rows(patch)).toEqual([
      ["file", "diff --git a/a b/a", null, null],
      ["hunk", "@@ -1 +1 @@", null, null],
      ["del", "a", 1, null],
      ["meta", "\\ No newline at end of file", null, null],
      ["add", "b", null, 1],
      ["hunk", "@@ -10,2 +10,2 @@", null, null],
      ["ctx", "c", 10, 10],
      ["del", "d", 11, null],
      ["add", "e", null, 11],
      ["file", "diff --git a/z b/z", null, null],
      ["meta", "deleted file mode 100644", null, null],
      ["hunk", "@@ -1 +0,0 @@", null, null],
      ["del", "z", 1, null],
    ]);
  });

  it("treats an empty line inside a hunk as an empty context line", () => {
    expect(rows(["@@ -1,3 +1,3 @@", " a", "", " c"].join("\n"))).toEqual([
      ["hunk", "@@ -1,3 +1,3 @@", null, null],
      ["ctx", "a", 1, 1],
      ["ctx", "", 2, 2],
      ["ctx", "c", 3, 3],
    ]);
  });

  it("drops only the single trailing empty piece", () => {
    expect(diffLines("@@ -1 +1 @@\n a\n")).toHaveLength(2);
    expect(diffLines("@@ -1 +1 @@\n a")).toHaveLength(2);
  });

  it("keeps lines unnumbered when the hunk header cannot be read", () => {
    expect(rows(["@@ nonsense @@", "+x", "-y", " z"].join("\n"))).toEqual([
      ["hunk", "@@ nonsense @@", null, null],
      ["add", "x", null, null],
      ["del", "y", null, null],
      ["ctx", "z", null, null],
    ]);
  });

  it("classifies what src/shared/diff.ts really produces", () => {
    const patch = unifiedDiff("src/format.ts", "a\nb\nc\n", "a\nB\nc\nd\n");
    const kinds = diffLines(patch).map((l) => l.kind);
    expect(kinds).toEqual(["file", "file", "file", "hunk", "ctx", "del", "add", "ctx", "add"]);
    expect(diffStat(diffLines(patch))).toEqual({ added: 2, removed: 1 });
  });

  it("classifies a created file from src/shared/diff.ts", () => {
    const kinds = diffLines(unifiedDiff("n.ts", null, "x\ny\n")).map((l) => l.kind);
    expect(kinds).toEqual(["file", "meta", "file", "file", "hunk", "add", "add"]);
  });
});

describe("diffStat", () => {
  it.each([
    ["", { added: 0, removed: 0 }],
    ["@@ -1 +1 @@\n a", { added: 0, removed: 0 }],
    ["@@ -1,2 +1,3 @@\n a\n+b\n+c\n-d", { added: 2, removed: 1 }],
    ["--- a/x\n+++ b/x\n@@ -1 +1 @@\n-p\n+q", { added: 1, removed: 1 }],
  ])("%j -> %j", (patch, stat) => {
    expect(diffStat(diffLines(patch))).toEqual(stat);
  });
});

// ---------------------------------------------------------------------------------------------
// verdicts

describe("verdictRow", () => {
  const v = (question: string, value: number, confidence: number | null = null, detail: string | null = "recorded") => ({ attempt: 1, question, value, confidence, detail });

  it.each([
    [v("criterion_1", 0.96), "criterion 1 · noul 0.96", "go"],
    [v("criterion_2", 0.5), "criterion 2 · noul 0.50", "caution"],
    [v("criterion_3", 0.2), "criterion 3 · noul 0.20", "stop"],
    [v("criterion_4", 0.35), "criterion 4 · noul 0.35", "caution"],
    [v("criterion_5", 0.7), "criterion 5 · noul 0.70", "go"],
    [v("criterion_6", 0.349), "criterion 6 · noul 0.35", "stop"],
    [v("criterion_7", 0.69), "criterion 7 · noul 0.69", "caution"],
    [v("scope_creep", 0.69), "scope creep · noul 0.69", "go"],
    [v("scope_creep", 0.12), "scope creep · noul 0.12", "go"],
    [v("scope_creep", 0.7), "scope creep · noul 0.70", "caution"],
    [v("criterion_1", 0.96, 0.822), "criterion 1 · noul 0.96 · confidence 0.82", "go"],
    [v("criterion_1", 1, 0), "criterion 1 · noul 1.00 · confidence 0.00", "go"],
    [v("judge", 1, null, "judge off: hard checks only"), "judge · off", "none"],
    [v("judge", 0.8, null, "recorded"), "judge · noul 0.80", "none"],
    [v("some_new_question", 0.4), "some new question · noul 0.40", "none"],
  ])("%j -> %s (%s)", (verdict, text, signal) => {
    const row = verdictRow(verdict);
    expect(row.text).toBe(text);
    expect(row.signal).toBe(signal);
  });

  it("marks the off verdict as having no probability to draw", () => {
    expect(verdictRow(v("judge", 1, null, "judge off: hard checks only"))).toMatchObject({ type: "off", source: null, thresholds: [] });
  });

  it("carries the thresholds the gate applies (PLAN.md 9.3) so the gauge can show them", () => {
    expect(verdictRow(v("criterion_1", 0.5)).thresholds).toEqual([0.35, 0.7]);
    expect(verdictRow(v("scope_creep", 0.5)).thresholds).toEqual([0.7]);
    expect(verdictRow(v("other", 0.5)).thresholds).toEqual([]);
  });

  it.each([
    ["recorded", "recorded"],
    ["live", "live"],
    ["neutral", "neutral: no answer"],
    ["", null],
    [null, null],
  ])("source %j -> %j", (detail, source) => {
    expect(verdictRow(v("criterion_1", 0.5, null, detail)).source).toBe(source);
  });
});

describe("verdictRows", () => {
  const v = (attempt: number, question: string, value = 0.9) => ({ attempt, question, value, confidence: null, detail: "recorded" });

  it("keeps one attempt, criteria in numeric order, then scope creep, then the rest", () => {
    const rows = verdictRows(
      [v(1, "criterion_10"), v(1, "criterion_2"), v(2, "criterion_1"), v(1, "zeta"), v(1, "scope_creep"), v(1, "criterion_1"), v(1, "alpha")],
      1,
    );
    expect(rows.map((r) => r.name)).toEqual(["criterion 1", "criterion 2", "criterion 10", "scope creep", "alpha", "zeta"]);
  });

  it("is empty when the attempt has no verdicts", () => {
    expect(verdictRows([v(1, "criterion_1")], 2)).toEqual([]);
    expect(verdictRows([], 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// evidence and preview links

describe("evidenceUrl", () => {
  it.each([
    ["job_1.png", "/api/evidence/job_1.png"],
    ["abc-123.PNG", "/api/evidence/abc-123.PNG"],
    ["a.b.png", "/api/evidence/a.b.png"],
    ["agent", null],
    [null, null],
    ["", null],
    ["shot.jpg", null],
    ["../secret.png", null],
    ["dir/shot.png", null],
    ["dir\\shot.png", null],
    [".hidden.png", null],
    ["shot.png?x=1", null],
    ["a b.png", null],
  ])("%s -> %s", (ref, url) => {
    expect(evidenceUrl(ref)).toBe(url);
  });
});

describe("previewUrl", () => {
  const sha = "8bbb4cfcc68b5f06c0058e3d943187c426bd83b5";
  it.each([
    ["convert", sha, `/preview/convert/${sha}/`],
    ["my repo", "abcdef1", "/preview/my%20repo/abcdef1/"],
    ["convert", "zzz", null],
    ["convert", "abc", null],
    ["convert", "", null],
    ["convert", null, null],
    ["convert", "../x", null],
  ])("%s @ %s -> %s", (repo, s, url) => {
    expect(previewUrl(repo, s)).toBe(url);
  });
});

describe("testsSummary", () => {
  it.each([
    ["12 passed, 0 failed in 450 ms", { passed: 12, failed: 0, ms: 450, timedOut: false }],
    ["3 passed, 1 failed in 1200 ms (timed out)", { passed: 3, failed: 1, ms: 1200, timedOut: true }],
    ["5 passed, 2 failed", { passed: 5, failed: 2, ms: null, timedOut: false }],
    ["all green", null],
    ["", null],
  ])("%j", (text, out) => {
    expect(testsSummary(text)).toEqual(out);
  });
});

describe("evidenceView", () => {
  const ev = (kind: string, summary: string, ref: string | null = null, attempt = 1) => ({ attempt, kind, summary, ref });

  it("is empty without evidence", () => {
    expect(evidenceView([], 1)).toEqual({ tests: null, agentScreenshot: null, agentSummary: null, imageUrl: null, other: [] });
  });

  it("reads the test summary and the runner screenshot from the tests row", () => {
    const view = evidenceView([ev("tests", "12 passed, 0 failed in 450 ms", "job_9.png")], 1);
    expect(view.tests).toEqual({ summary: "12 passed, 0 failed in 450 ms", passed: 12, failed: 0, signal: "go" });
    expect(view.imageUrl).toBe("/api/evidence/job_9.png");
  });

  it.each([
    ["3 passed, 1 failed in 100 ms", "stop"],
    ["3 passed, 0 failed in 100 ms (timed out)", "stop"],
    ["gibberish", "none"],
  ])("tests %j -> signal %s", (summary, signal) => {
    expect(evidenceView([ev("tests", summary)], 1).tests!.signal).toBe(signal);
  });

  it("labels the agent's own lines and never turns them into an image", () => {
    const view = evidenceView([ev("screenshot", "A blue converter grid", "agent"), ev("log", "Added area units", "agent")], 1);
    expect(view).toMatchObject({ agentScreenshot: "A blue converter grid", agentSummary: "Added area units", imageUrl: null, other: [] });
  });

  it("takes a screenshot row with a png ref as the image", () => {
    expect(evidenceView([ev("screenshot", "home page", "shot.png")], 1).imageUrl).toBe("/api/evidence/shot.png");
  });

  it("lists everything else as other evidence", () => {
    const view = evidenceView([ev("preview", "https://x", null), ev("log", "runner log", "log-1.txt"), ev("screenshot", "odd", "elsewhere")], 1);
    expect(view.other.map((o) => o.kind)).toEqual(["preview", "log", "screenshot"]);
  });

  it("only looks at the chosen attempt", () => {
    const rows = [ev("tests", "1 passed, 0 failed in 1 ms", null, 1), ev("tests", "2 passed, 1 failed in 2 ms", null, 2)];
    expect(evidenceView(rows, 2).tests!.failed).toBe(1);
    expect(evidenceView(rows, 3).tests).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// path lists

const noMarks: Marks = { stale: [], conflicts: [], protectedPaths: [], warned: [], failures: [] };

describe("accessRows", () => {
  const delta = [
    { path: "src/format.ts", patch: "@@ -1 +1 @@\n-a\n+b" },
    { path: "src/ui/layout.ts", patch: "@@ -2 +2 @@\n-c\n+d" },
  ];
  const reads = ["src/format.ts", "src/index.ts", "src/units/length.ts"];
  const writes = ["src/registry.ts", "src/ui/layout.ts", "src/units/volume.ts"];
  const summary = (rows: ReturnType<typeof accessRows>) => rows.map((r) => [r.path, r.flags, r.by, r.delta !== null]);

  it("lists plain paths alphabetically without flags", () => {
    expect(summary(accessRows("read", ["b.ts", "a.ts", "a.ts"], [], noMarks, []))).toEqual([
      ["a.ts", [], null, false],
      ["b.ts", [], null, false],
    ]);
  });

  it("flags stale reads, names who changed them and shows the delta; flagged rows come first", () => {
    const marks = { ...noMarks, stale: [{ path: "src/format.ts", by: "t_other" }] };
    expect(summary(accessRows("read", reads, writes, marks, delta))).toEqual([
      ["src/format.ts", ["stale"], "t_other", true],
      ["src/index.ts", [], null, false],
      ["src/units/length.ts", [], null, false],
    ]);
    expect(accessRows("read", reads, writes, marks, delta)[0]!.delta).toBe(delta[0]!.patch);
  });

  it("lists a stale path even when the read set lacks it", () => {
    const marks = { ...noMarks, stale: [{ path: "gone.ts", by: null }] };
    expect(summary(accessRows("read", ["a.ts"], [], marks, []))).toEqual([
      ["gone.ts", ["stale"], null, false],
      ["a.ts", [], null, false],
    ]);
  });

  it("flags a written path that is also stale, without repeating its delta", () => {
    const marks = { ...noMarks, stale: [{ path: "src/format.ts", by: "t_other" }] };
    expect(summary(accessRows("write", ["src/format.ts"], ["src/format.ts", "z.ts"], marks, delta))).toEqual([
      ["src/format.ts", ["stale"], "t_other", false],
      ["z.ts", [], null, false],
    ]);
  });

  it("flags text conflicts in the write set and shows their delta there", () => {
    const marks = { ...noMarks, conflicts: ["src/ui/layout.ts"] };
    expect(summary(accessRows("write", reads, writes, marks, delta))).toEqual([
      ["src/ui/layout.ts", ["conflict"], null, true],
      ["src/registry.ts", [], null, false],
      ["src/units/volume.ts", [], null, false],
    ]);
    expect(summary(accessRows("read", reads, writes, marks, delta)).every((r) => (r[1] as string[]).length === 0)).toBe(true);
  });

  it("flags protected paths in the write set and adds the ones the write list lacks", () => {
    const marks = { ...noMarks, protectedPaths: ["test/routes.test.ts", "ryke.json"] };
    expect(summary(accessRows("write", [], ["src/a.ts", "test/routes.test.ts"], marks, []))).toEqual([
      ["ryke.json", ["protected"], null, false],
      ["test/routes.test.ts", ["protected"], null, false],
      ["src/a.ts", [], null, false],
    ]);
  });

  it("flags warned reads with caution, after the stop flags and before plain paths", () => {
    const marks = { ...noMarks, warned: ["src/index.ts"], stale: [{ path: "src/units/length.ts", by: "t_o" }] };
    expect(summary(accessRows("read", reads, [], marks, [])).map((r) => [r[0], r[1]])).toEqual([
      ["src/units/length.ts", ["stale"]],
      ["src/index.ts", ["warned"]],
      ["src/format.ts", []],
    ]);
  });

  it("a stale read is not also warned", () => {
    const marks = { ...noMarks, warned: ["a.ts"], stale: [{ path: "a.ts", by: null }] };
    expect(accessRows("read", ["a.ts"], [], marks, [])[0]!.flags).toEqual(["stale"]);
  });

  it("never marks a write-only path as warned", () => {
    const marks = { ...noMarks, warned: ["w.ts"] };
    expect(accessRows("write", [], ["w.ts"], marks, [])[0]!.flags).toEqual([]);
  });

  it("gives a delta only when it has one for the path", () => {
    const marks = { ...noMarks, stale: [{ path: "src/index.ts", by: null }] };
    expect(accessRows("read", reads, [], marks, delta)[0]).toMatchObject({ path: "src/index.ts", flags: ["stale"], delta: null });
  });

  it("is empty for empty input", () => {
    expect(accessRows("read", [], [], noMarks, [])).toEqual([]);
    expect(accessRows("write", [], [], noMarks, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// the per-attempt view model

const txn = (over: Partial<TxnDetail["txn"]> = {}): TxnDetail["txn"] => ({
  id: "t_one",
  repo: "convert",
  agent: "agent-a",
  model: "m",
  intent: "do it",
  criteria: [],
  state: "open",
  attempt: 1,
  snapshot: SNAP1,
  snapshotSeq: 0,
  fork: "convert--t_one",
  head: null,
  train: null,
  landedSeq: null,
  reason: null,
  createdAt: 0,
  updatedAt: 0,
  submittedAt: null,
  ...over,
});
const detail = (over: Partial<TxnDetail> = {}): TxnDetail => ({
  txn: txn(),
  detail: {},
  commit: null,
  attempts: [{ attempt: 1, reads: [], writes: [] }],
  verdicts: [],
  evidence: [],
  ops: [],
  delta: [],
  staleWarnings: [],
  ...over,
});

describe("previewFor", () => {
  const commit = "8bbb4cfcc68b5f06c0058e3d943187c426bd83b5";
  it("links the landed commit for the current attempt", () => {
    expect(previewFor("convert", detail({ commit, txn: txn({ state: "landed" }) }), 1, null)).toEqual({
      kind: "commit",
      sha: commit,
      url: `/preview/convert/${commit}/`,
    });
  });
  it("links the attempt's snapshot otherwise, from its row or from the transaction", () => {
    const row = attemptRows([open(1, 1, SNAP2)])[0]!;
    expect(previewFor("convert", detail(), 1, row)).toEqual({ kind: "snapshot", sha: SNAP2, url: `/preview/convert/${SNAP2}/` });
    expect(previewFor("convert", detail(), 1, null)).toEqual({ kind: "snapshot", sha: SNAP1, url: `/preview/convert/${SNAP1}/` });
  });
  it("does not offer the landed commit for an earlier attempt", () => {
    const d = detail({ commit, txn: txn({ state: "landed", attempt: 2 }), attempts: [{ attempt: 1, reads: [], writes: [] }, { attempt: 2, reads: [], writes: [] }] });
    const row = attemptRows([open(1, 1, SNAP1)])[0]!;
    expect(previewFor("convert", d, 1, row)).toMatchObject({ kind: "snapshot", sha: SNAP1 });
  });
  it("is null when no sha is known", () => {
    expect(previewFor("convert", detail({ txn: txn({ snapshot: "" }), attempts: [{ attempt: 1, reads: [], writes: [] }, { attempt: 2, reads: [], writes: [] }] }), 2, null)).toBeNull();
    expect(previewFor("convert", detail({ txn: txn({ snapshot: "" }) }), 1, null)).toBeNull();
  });
});

describe("attemptMarks", () => {
  const row = attemptRows([
    open(1, 1, SNAP1),
    op("stale.warning", 2, { attempt: 1, paths: ["w.ts"], seq: 2 }),
    op("txn.stale", 3, { attempt: 1, reason: "stale_read", paths: [{ path: "s.ts", seq: 2, by: "t_b" }] }),
  ])[0]!;

  it("reads everything from the ops of an earlier attempt and ignores the live notes", () => {
    const d = detail({ detail: { stale: [{ path: "n.ts", seq: 1, by: "t_n" }], conflicts: ["c.ts"], protected: ["p.ts"], failures: [{ name: "x", message: "y" }] }, staleWarnings: [{ path: "live.ts", seq: 5 }] });
    expect(attemptMarks(d, row, false)).toEqual({
      stale: [{ path: "s.ts", by: "t_b" }],
      conflicts: [],
      protectedPaths: [],
      warned: ["w.ts"],
      failures: [],
    });
  });

  it("adds the live notes for the current attempt without repeating paths", () => {
    const d = detail({
      detail: {
        stale: [
          { path: "s.ts", seq: 2, by: "t_b" },
          { path: "n.ts", seq: 3, by: null },
        ],
        conflicts: ["c.ts"],
        protected: ["p.ts"],
        failures: [{ name: "x", message: "y" }],
      },
      staleWarnings: [
        { path: "w.ts", seq: 2 },
        { path: "live.ts", seq: 5 },
      ],
    });
    expect(attemptMarks(d, row, true)).toEqual({
      stale: [
        { path: "s.ts", by: "t_b" },
        { path: "n.ts", by: null },
      ],
      conflicts: ["c.ts"],
      protectedPaths: ["p.ts"],
      warned: ["w.ts", "live.ts"],
      failures: [{ name: "x", message: "y" }],
    });
  });

  it("prefers the failures of the ops over the note", () => {
    const failedRow = attemptRows([open(1, 1, SNAP1), op("txn.failed", 2, { attempt: 1, reason: "tests", failures: [{ name: "from op", message: "m" }] })])[0]!;
    const d = detail({ detail: { failures: [{ name: "from note", message: "m" }] } });
    expect(attemptMarks(d, failedRow, true).failures).toEqual([{ name: "from op", message: "m" }]);
  });

  it("works without a row", () => {
    expect(attemptMarks(detail({ detail: { failures: null } }), null, true)).toEqual(noMarks);
    expect(attemptMarks(detail(), null, false)).toEqual(noMarks);
  });
});

describe("attemptDetail", () => {
  const ops = [
    open(100, 1, SNAP1),
    op("txn.submitted", 110, { attempt: 1 }),
    op("txn.stale", 120, { attempt: 1, reason: "stale_read", paths: [{ path: "src/format.ts", seq: 1, by: "t_first" }] }),
    open(200, 2, SNAP2),
    op("txn.submitted", 210, { attempt: 2 }),
    op("txn.failed", 220, { attempt: 2, reason: "tests", bisected: true, failures: [{ name: "boom", message: "2 !== 3" }] }),
  ];
  const d = detail({
    txn: txn({ state: "failed", attempt: 2, snapshot: SNAP2 }),
    attempts: [
      { attempt: 1, reads: ["src/format.ts", "src/index.ts"], writes: ["src/units/a.ts"] },
      { attempt: 2, reads: ["src/index.ts"], writes: ["test/broken.test.ts"] },
    ],
    verdicts: [{ attempt: 2, question: "criterion_1", value: 0.2, confidence: null, detail: "recorded" }],
    evidence: [{ attempt: 2, kind: "tests", summary: "0 passed, 1 failed in 12 ms", ref: null }],
    ops,
    delta: [{ path: "src/format.ts", patch: "@@ -1 +1 @@\n-a\n+b" }],
  });

  it("builds the earlier attempt from its ops and shows no delta unless the browser computed one: the API only has the current attempt's", () => {
    const a = attemptDetail(d, 1, "convert");
    expect(a.isCurrent).toBe(false);
    expect(a.row).toMatchObject({ attempt: 1, outcome: "stale" });
    expect(a.reads.map((r) => [r.path, r.flags, r.delta])).toEqual([
      ["src/format.ts", ["stale"], null],
      ["src/index.ts", [], null],
    ]);
    expect(a.writes.map((r) => r.path)).toEqual(["src/units/a.ts"]);
    expect(a.verdicts).toEqual([]);
    expect(a.evidence.tests).toBeNull();
    expect(a.preview).toMatchObject({ kind: "snapshot", sha: SNAP1 });
    expect(a.failures).toEqual([]);
  });

  it("builds the current attempt with verdicts, evidence and failures", () => {
    const a = attemptDetail(d, 2, "convert");
    expect(a.isCurrent).toBe(true);
    expect(a.reads.map((r) => r.path)).toEqual(["src/index.ts"]);
    expect(a.verdicts.map((v) => v.text)).toEqual(["criterion 1 · noul 0.20"]);
    expect(a.evidence.tests).toMatchObject({ failed: 1, signal: "stop" });
    expect(a.failures).toEqual([{ name: "boom", message: "2 !== 3" }]);
    expect(a.preview).toMatchObject({ kind: "snapshot", sha: SNAP2 });
  });

  it("attaches the delta to the stale read of the current attempt", () => {
    const stale = detail({
      txn: txn({ state: "stale", attempt: 1 }),
      attempts: [{ attempt: 1, reads: ["src/format.ts"], writes: [] }],
      ops: ops.slice(0, 3),
      delta: d.delta,
    });
    const a = attemptDetail(stale, 1, "convert");
    expect(a.reads[0]).toMatchObject({ path: "src/format.ts", flags: ["stale"], by: "t_first", delta: "@@ -1 +1 @@\n-a\n+b" });
  });

  it("attaches the delta the browser computed to the stale read of an earlier attempt", () => {
    const past = [{ path: "src/format.ts", patch: "@@ -1 +1 @@\n-old\n+new" }];
    const a = attemptDetail(d, 1, "convert", past);
    expect(a.reads[0]).toMatchObject({ path: "src/format.ts", flags: ["stale"], by: "t_first", delta: "@@ -1 +1 @@\n-old\n+new" });
    expect(a.reads[1]).toMatchObject({ path: "src/index.ts", delta: null });
  });

  it("never lets a computed past delta replace the API's delta for the current attempt", () => {
    const stale = detail({
      txn: txn({ state: "stale", attempt: 1 }),
      attempts: [{ attempt: 1, reads: ["src/format.ts"], writes: [] }],
      ops: ops.slice(0, 3),
      delta: d.delta,
    });
    const a = attemptDetail(stale, 1, "convert", [{ path: "src/format.ts", patch: "from the browser" }]);
    expect(a.reads[0]!.delta).toBe("@@ -1 +1 @@\n-a\n+b");
  });

  it("copes with an attempt that has no access rows", () => {
    const a = attemptDetail(detail({ attempts: [] }), 1, "convert");
    expect(a.reads).toEqual([]);
    expect(a.writes).toEqual([]);
    expect(a.row).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// the delta of an attempt that has already been retried

describe("deltaRequest: which two snapshots to compare", () => {
  const stale = (attempt: number, paths: { path: string; by?: string }[], reason = "stale_read") => op("txn.stale", 20, { attempt, reason, paths: paths.map((p) => ({ seq: 1, ...p })) });
  const rowsOf = (...ops: DetailOp[]) => attemptRows(ops);

  it("compares the stale attempt's snapshot with the snapshot of the retry that followed it", () => {
    const rows = rowsOf(open(1, 1, SNAP1), stale(1, [{ path: "src/format.ts", by: "t_a" }, { path: "src/ui/layout.ts" }]), open(30, 2, SNAP2));
    expect(deltaRequest(rows, 1)).toEqual({
      key: `${SNAP1}..${SNAP2} src/format.ts src/ui/layout.ts`,
      before: SNAP1,
      after: SNAP2,
      paths: ["src/format.ts", "src/ui/layout.ts"],
      omitted: 0,
    });
  });

  it("uses the conflicting paths of a text conflict", () => {
    const rows = rowsOf(open(1, 1, SNAP1), stale(1, [{ path: "src/registry.ts" }], "text_conflict"), open(30, 2, SNAP2));
    expect(deltaRequest(rows, 1)).toMatchObject({ before: SNAP1, after: SNAP2, paths: ["src/registry.ts"] });
  });

  it("compares the second retry with the third snapshot, not the first", () => {
    const rows = rowsOf(open(1, 1, SNAP1), stale(1, [{ path: "a.ts" }]), open(30, 2, SNAP2), stale(2, [{ path: "b.ts" }]), open(60, 3, SNAP3));
    expect(deltaRequest(rows, 1)).toMatchObject({ before: SNAP1, after: SNAP2, paths: ["a.ts"] });
    expect(deltaRequest(rows, 2)).toMatchObject({ before: SNAP2, after: SNAP3, paths: ["b.ts"] });
  });

  it("follows a refresh: the attempt's snapshot is the newest one it was checked against", () => {
    // Built in log order: attemptRows sorts by seq, and the helper numbers ops as they are made.
    const first = open(1, 1, SNAP1);
    const refreshed = op("txn.open", 15, { attempt: 1, snapshot: SNAP2, refresh: true });
    const rows = rowsOf(first, refreshed, stale(1, [{ path: "a.ts" }]), open(30, 2, SNAP3));
    expect(deltaRequest(rows, 1)).toMatchObject({ before: SNAP2, after: SNAP3 });
  });

  it.each<[string, DetailOp[], number]>([
    ["the current attempt has no later snapshot yet (the API's delta covers it)", [open(1, 1, SNAP1), stale(1, [{ path: "a.ts" }])], 1],
    ["an attempt that did not go stale", [open(1, 1, SNAP1), op("txn.failed", 5, { attempt: 1, reason: "tests" }), open(30, 2, SNAP2)], 1],
    ["a stale attempt without paths", [open(1, 1, SNAP1), stale(1, []), open(30, 2, SNAP2)], 1],
    ["an attempt the log does not have", [open(1, 1, SNAP1)], 4],
    ["the retry's snapshot is missing", [open(1, 1, SNAP1), stale(1, [{ path: "a.ts" }]), op("txn.open", 30, { attempt: 2 })], 1],
    ["the stale attempt's own snapshot is missing", [op("txn.open", 1, { attempt: 1 }), stale(1, [{ path: "a.ts" }]), open(30, 2, SNAP2)], 1],
    ["both attempts started from the same trunk", [open(1, 1, SNAP1), stale(1, [{ path: "a.ts" }]), open(30, 2, SNAP1)], 1],
  ])("has nothing to compare for %s", (_name, ops, attempt) => {
    expect(deltaRequest(rowsOf(...ops), attempt)).toBeNull();
  });

  it("lists a path once and stops at the cap, saying how many it left out", () => {
    const many = Array.from({ length: MAX_DELTA_PATHS + 3 }, (_, i) => ({ path: `src/f${i}.ts` }));
    const rows = rowsOf(open(1, 1, SNAP1), stale(1, [{ path: "src/f0.ts" }, ...many]), open(30, 2, SNAP2));
    const r = deltaRequest(rows, 1)!;
    expect(r.paths).toEqual(many.slice(0, MAX_DELTA_PATHS).map((p) => p.path));
    expect(r.omitted).toBe(3);
  });

  it("gives two different comparisons two different keys", () => {
    const a = deltaRequest(rowsOf(open(1, 1, SNAP1), stale(1, [{ path: "a.ts" }]), open(30, 2, SNAP2)), 1)!;
    const b = deltaRequest(rowsOf(open(1, 1, SNAP1), stale(1, [{ path: "b.ts" }]), open(30, 2, SNAP2)), 1)!;
    const c = deltaRequest(rowsOf(open(1, 1, SNAP1), stale(1, [{ path: "a.ts" }]), open(30, 2, SNAP3)), 1)!;
    expect(new Set([a.key, b.key, c.key]).size).toBe(3);
  });
});

describe("computeDelta", () => {
  const files: Record<string, string | null> = {
    [`${SNAP1}:src/format.ts`]: "export const digits = 2;\n",
    [`${SNAP2}:src/format.ts`]: "export const digits = 3;\n",
    [`${SNAP1}:src/new.ts`]: null,
    [`${SNAP2}:src/new.ts`]: "export {};\n",
    [`${SNAP1}:src/gone.ts`]: "x\n",
    [`${SNAP2}:src/gone.ts`]: null,
    [`${SNAP1}:src/same.ts`]: "same\n",
    [`${SNAP2}:src/same.ts`]: "same\n",
  };
  const fetched: string[] = [];
  const fetchFile: FetchFile = async (ref, path) => {
    fetched.push(`${ref}:${path}`);
    return files[`${ref}:${path}`] ?? null;
  };
  const request = (paths: string[]) => ({ key: "k", before: SNAP1, after: SNAP2, paths, omitted: 0 });

  it("reads each path at both snapshots and diffs them with the same unified diff the API uses", async () => {
    fetched.length = 0;
    const delta = await computeDelta(request(["src/format.ts"]), fetchFile);
    expect(delta).toEqual([{ path: "src/format.ts", patch: unifiedDiff("src/format.ts", "export const digits = 2;\n", "export const digits = 3;\n") }]);
    expect(delta[0]!.patch).toContain("-export const digits = 2;");
    expect(delta[0]!.patch).toContain("+export const digits = 3;");
    expect(fetched.sort()).toEqual([`${SNAP1}:src/format.ts`, `${SNAP2}:src/format.ts`]);
  });

  it("describes a file the other side added or deleted, and an unchanged one as no patch", async () => {
    const delta = await computeDelta(request(["src/new.ts", "src/gone.ts", "src/same.ts"]), fetchFile);
    expect(delta.map((d) => d.path)).toEqual(["src/new.ts", "src/gone.ts", "src/same.ts"]);
    expect(delta[0]!.patch).toContain("new file mode");
    expect(delta[1]!.patch).toContain("deleted file mode");
    expect(delta[2]!.patch).toBe("");
  });

  it("gives up on the whole delta when one file cannot be read, rather than show a partial one", async () => {
    const failing: FetchFile = async (ref, path) => {
      if (path === "src/b.ts") throw new Error("GET files answered 503");
      return fetchFile(ref, path);
    };
    await expect(computeDelta(request(["src/format.ts", "src/b.ts"]), failing)).rejects.toThrow("503");
  });

  it("has nothing to do for no paths", async () => {
    expect(await computeDelta(request([]), fetchFile)).toEqual([]);
  });
});

describe("fileFetcher", () => {
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const seen: string[] = [];
  const fetcher = (impl: () => Promise<Response>) => fileFetcher("convert", (async (url: string) => (seen.push(url), impl())) as unknown as typeof fetch);

  it("asks GET /api/repos/:repo/files for the path at the ref, both encoded", async () => {
    seen.length = 0;
    const f = fetcher(answer(200, { ref: SNAP1, path: "src/a b.ts", content: "hello\n" }));
    expect(await f(SNAP1, "src/a b.ts")).toBe("hello\n");
    expect(seen).toEqual([`/api/repos/convert/files?ref=${SNAP1}&path=src%2Fa%20b.ts`]);
  });

  it("reads a file that is not there at that ref as absent", async () => {
    expect(await fetcher(answer(404, { error: `no file src/x.ts at ${SNAP1}` }))(SNAP1, "src/x.ts")).toBeNull();
  });

  it.each([
    ["a repo the ledger does not know", 404, { error: "repo is not initialised" }],
    ["an unreachable store", 503, { error: "store down" }],
    ["a server error", 500, {}],
    ["an unreadable answer", 200, { ref: SNAP1 }],
  ])("fails for %s, so the page does not draw a wrong delta", async (_name, status, body) => {
    await expect(fetcher(answer(status, body))(SNAP1, "a.ts")).rejects.toThrow();
  });
});

describe("deltaView: what the page shows while the comparison loads", () => {
  const req = { key: "k1", before: SNAP1, after: SNAP2, paths: ["a.ts"], omitted: 0 };
  const entry = [{ path: "a.ts", patch: "p" }];
  it.each<[string, Parameters<typeof deltaView>[0], Parameters<typeof deltaView>[1], ReturnType<typeof deltaView>]>([
    ["no comparison is possible", null, null, { status: "none", delta: [] }],
    ["a comparison is possible and nothing has loaded", req, null, { status: "loading", delta: [] }],
    ["what loaded belongs to another comparison", req, { key: "other", status: "ready", delta: entry }, { status: "loading", delta: [] }],
    ["it loaded", req, { key: "k1", status: "ready", delta: entry }, { status: "ready", delta: entry }],
    ["it failed", req, { key: "k1", status: "error", message: "GET files answered 503" }, { status: "error", delta: [], message: "GET files answered 503" }],
    ["a result is left over for an attempt that needs none", null, { key: "k1", status: "ready", delta: entry }, { status: "none", delta: [] }],
  ])("%s", (_name, request, loaded, want) => {
    expect(deltaView(request, loaded)).toEqual(want);
  });
});
