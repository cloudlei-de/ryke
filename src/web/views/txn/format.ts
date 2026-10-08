// Pure view-model helpers for the Transaction view (PLAN.md §12, view 2). Everything here is data in,
// data out: the React components in index.tsx and parts.tsx only lay the results out.
import { fold, type TxnView } from "../../../shared/reducers";
import type { DeltaEntry, Op, OpKind } from "../../../shared/types";
import type { TxnDetail } from "../../../worker/ledger/ledger";

export type Detail = TxnDetail;
export type DetailOp = TxnDetail["ops"][number];
export type Signal = "go" | "stop" | "caution" | "run" | "recall" | "none";
export type Failure = { name: string; message: string };
export type BlamePath = { path: string; by: string | null };

// ---------------------------------------------------------------------------- vocabulary

// §12: signal colours are used only as signals. Open, submitted, ready and aborted carry none; the
// chip draws them as an outline and a hatch instead, so a lamp always means something happened.
const SIGNALS: Record<string, Signal> = {
  landed: "go",
  stale: "stop",
  failed: "stop",
  rejected: "stop",
  needs_human: "caution",
  verifying: "run",
  recalled: "recall",
};

export function stateSignal(state: string): Signal {
  return SIGNALS[state] ?? "none";
}

export function stateLabel(state: string): string {
  return state.replace(/_/g, " ");
}

const REASONS: Record<string, string> = {
  stale_read: "stale read",
  text_conflict: "text conflict",
  tests: "tests failed",
  tests_failed: "tests failed",
  verify_failed: "verify failed",
  test_tamper: "test tampering",
  criterion_unmet: "criterion unmet",
  criterion_uncertain: "criterion uncertain",
  scope_creep: "scope creep",
  human_path: "touches a human-review path",
  protected: "wrote a protected path",
  empty: "empty change",
  max_attempts: "max attempts reached",
  agent_abort: "aborted by the agent",
  rejected_by_human: "rejected by a human",
  approved: "approved by a human",
};

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  if (reason.startsWith("duplicate_of:")) return `duplicate of ${reason.slice("duplicate_of:".length)}`;
  return REASONS[reason] ?? reason.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------- small formatters

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : "";
}

const two = (n: number) => String(n).padStart(2, "0");

// Local time: Felix reads this next to his own clock, and the op log keeps the exact ms anyway.
export function clock(at: number | null): string {
  if (at === null) return "—";
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) {
    // 59 950 ms would round to "60.0 s"; carry it into minutes instead.
    const s = (ms / 1000).toFixed(1);
    if (s !== "60.0") return `${s} s`;
  }
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} m ${two(total % 60)} s`;
}

// ---------------------------------------------------------------------------- live refetch

// The Line's op stream carries every op of the repo; this view only refetches for its own transaction.
export function lastSeqFor(ops: readonly { seq: number; txn: string | null }[], id: string): number {
  for (let i = ops.length - 1; i >= 0; i--) if (ops[i]!.txn === id) return ops[i]!.seq;
  return 0;
}

export function loadedSeq(detail: Detail): number {
  return detail.ops.reduce((max, o) => Math.max(max, o.seq), 0);
}

export function shouldRefetch(liveSeq: number, loaded: number): boolean {
  return liveSeq > loaded;
}

// Follow the newest attempt until the reader picks another one.
export function selectAttempt(picked: number | null, attempts: readonly number[]): number {
  const latest = attempts.length > 0 ? Math.max(...attempts) : 1;
  return picked !== null && attempts.includes(picked) ? picked : latest;
}

// ---------------------------------------------------------------------------- attempts timeline

export type WarningRow = { at: number; kind: "stale" | "duplicate" | "conflict"; text: string; paths: string[] };
export type AttemptRow = {
  attempt: number;
  snapshot: string | null;
  start: number;
  end: number | null;
  /** Latest `txn.*` state seen for this attempt. */
  state: string;
  /** Set once the attempt is over: landed, stale, failed, aborted, rejected or recalled. */
  outcome: string | null;
  reason: string | null;
  bisected: boolean;
  approved: boolean;
  stale: BlamePath[];
  conflicts: string[];
  protectedPaths: string[];
  failures: Failure[];
  warnings: WarningRow[];
};

const ENDS = new Set(["landed", "stale", "failed", "aborted", "rejected"]);

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// Stale ops carry `{path, seq, by}` objects, protected rejections plain strings.
function pathsOf(v: unknown): BlamePath[] {
  return list(v).flatMap((p): BlamePath[] => {
    if (typeof p === "string") return [{ path: p, by: null }];
    const o = p as { path?: unknown; by?: unknown } | null;
    return o && typeof o.path === "string" ? [{ path: o.path, by: str(o.by) }] : [];
  });
}

function failuresOf(v: unknown): Failure[] {
  return list(v).flatMap((f): Failure[] => {
    const o = f as { name?: unknown; message?: unknown } | null;
    return o && typeof o.name === "string" && typeof o.message === "string" ? [{ name: o.name, message: o.message }] : [];
  });
}

function warningOf(o: DetailOp): WarningRow | null {
  const d = o.data;
  if (o.kind === "stale.warning") {
    const paths = list(d.paths).filter((p): p is string => typeof p === "string");
    const at = num(d.seq);
    const what = paths.length > 0 ? `${paths.join(", ")} changed on trunk` : "files it read changed on trunk";
    return { at: o.at, kind: "stale", text: at === null ? what : `${what} (seq ${at})`, paths };
  }
  const paths = list(d.footprint).filter((p): p is string => typeof p === "string");
  const other = str(d.other) ?? "another transaction";
  if (o.kind === "dup.warning") {
    return { at: o.at, kind: "duplicate", text: `possible duplicate of ${other} · noul ${(num(d.value) ?? 0).toFixed(2)}`, paths };
  }
  if (o.kind === "conflict.warning") {
    const conf = num(d.confidence);
    return {
      at: o.at,
      kind: "conflict",
      text: `possible conflict with ${other} · score ${(num(d.score) ?? 0).toFixed(2)}${conf === null ? "" : ` · confidence ${conf.toFixed(2)}`}`,
      paths,
    };
  }
  return null;
}

// One row per attempt, folded from the op log. Not every op carries `data.attempt` (older logs omit it
// on txn.stale and the warnings), so an op without one belongs to the attempt that is currently open.
export function attemptRows(ops: readonly DetailOp[]): AttemptRow[] {
  const rows = new Map<number, AttemptRow>();
  let current = 0;
  const ensure = (attempt: number, at: number): AttemptRow => {
    let row = rows.get(attempt);
    if (!row) {
      row = {
        attempt,
        snapshot: null,
        start: at,
        end: null,
        state: "open",
        outcome: null,
        reason: null,
        bisected: false,
        approved: false,
        stale: [],
        conflicts: [],
        protectedPaths: [],
        failures: [],
        warnings: [],
      };
      rows.set(attempt, row);
    }
    return row;
  };

  for (const o of [...ops].sort((a, b) => a.seq - b.seq)) {
    const d = o.data;
    if (o.kind === "txn.open") {
      current = num(d.attempt) ?? current + 1;
      ensure(current, o.at).snapshot = str(d.snapshot);
      continue;
    }
    const warning = warningOf(o);
    if (warning) {
      ensure(num(d.attempt) ?? current, o.at).warnings.push(warning);
      continue;
    }
    if (!o.kind.startsWith("txn.")) continue;

    const attempt = num(d.attempt) ?? current;
    if (num(d.attempt) !== null) current = attempt;
    const row = ensure(attempt, o.at);
    const state = o.kind.slice(4);
    row.state = state;
    row.reason = str(d.reason) ?? (state === "recalled" ? row.reason : null);
    if (d.approved === true) row.approved = true;
    if (state === "recalled") {
      row.outcome = "recalled";
      continue;
    }
    if (!ENDS.has(state)) continue;

    row.end = o.at;
    row.outcome = state;
    row.bisected = d.bisected === true;
    // After max attempts the aborted op carries what the last attempt died of.
    const cause = (d.cause ?? { state, reason: row.reason }) as { state?: unknown; reason?: unknown };
    const paths = pathsOf(d.paths);
    if (cause.state === "stale" && cause.reason === "text_conflict") row.conflicts = paths.map((p) => p.path);
    else if (cause.state === "stale") row.stale = paths;
    else if (state === "rejected" && row.reason === "protected") row.protectedPaths = paths.map((p) => p.path);
    row.failures = failuresOf(d.failures);
  }
  return [...rows.values()].sort((a, b) => a.attempt - b.attempt);
}

// ---------------------------------------------------------------------------- diff classification

export type DiffKind = "file" | "meta" | "hunk" | "ctx" | "add" | "del";
export type DiffLine = { kind: DiffKind; text: string; old: number | null; new: number | null };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const FILE_HEADER = /^(diff --git |--- |\+\+\+ |index )/;

// A `---` or `+++` line is a file header only before the first hunk; inside one it is a removed or
// added line whose content starts with dashes or pluses, so the state matters.
export function diffLines(patch: string): DiffLine[] {
  const pieces = patch.split("\n");
  if (pieces.at(-1) === "") pieces.pop();
  const out: DiffLine[] = [];
  let inHunk = false;
  let o: number | null = null;
  let n: number | null = null;
  const step = (v: number | null) => (v === null ? null : v + 1);

  for (const line of pieces) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      out.push({ kind: "file", text: line, old: null, new: null });
    } else if (line.startsWith("@@")) {
      inHunk = true;
      const m = HUNK.exec(line);
      o = m ? Number(m[1]) : null;
      n = m ? Number(m[2]) : null;
      out.push({ kind: "hunk", text: line, old: null, new: null });
    } else if (!inHunk) {
      out.push({ kind: FILE_HEADER.test(line) ? "file" : "meta", text: line, old: null, new: null });
    } else if (line.startsWith("+")) {
      out.push({ kind: "add", text: line.slice(1), old: null, new: n });
      n = step(n);
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", text: line.slice(1), old: o, new: null });
      o = step(o);
    } else if (line.startsWith("\\")) {
      out.push({ kind: "meta", text: line, old: null, new: null });
    } else {
      // A context line starts with a space; some tools strip that from empty ones.
      out.push({ kind: "ctx", text: line.slice(1), old: o, new: n });
      o = step(o);
      n = step(n);
    }
  }
  return out;
}

export function diffStat(lines: readonly DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length };
}

// ---------------------------------------------------------------------------- verdicts

export type VerdictRow = {
  name: string;
  /** `criterion 1 · noul 0.96`, with the confidence appended when the answer has one. */
  text: string;
  type: "noul" | "off";
  value: number;
  confidence: number | null;
  signal: Signal;
  /** Where PLAN.md §9.3 switches the decision; the gauge draws a tick at each. */
  thresholds: number[];
  source: string | null;
};
type VerdictInput = Pick<Detail["verdicts"][number], "question" | "value" | "confidence" | "detail">;

const CRITERION = /^criterion_(\d+)$/;

export function verdictRow(v: VerdictInput): VerdictRow {
  const criterion = CRITERION.exec(v.question);
  const name = criterion ? `criterion ${criterion[1]}` : v.question.replace(/_/g, " ");
  if (v.question === "judge" && v.detail?.startsWith("judge off")) {
    return { name, text: `${name} · off`, type: "off", value: v.value, confidence: null, signal: "none", thresholds: [], source: null };
  }
  let signal: Signal = "none";
  let thresholds: number[] = [];
  if (criterion) {
    // < 0.35 fails the transaction, < 0.70 asks a human (§9.3).
    signal = v.value < 0.35 ? "stop" : v.value < 0.7 ? "caution" : "go";
    thresholds = [0.35, 0.7];
  } else if (v.question === "scope_creep") {
    signal = v.value >= 0.7 ? "caution" : "go";
    thresholds = [0.7];
  }
  const confidence = v.confidence;
  const source = v.detail === "neutral" ? "neutral: no answer" : v.detail || null;
  return {
    name,
    text: `${name} · noul ${v.value.toFixed(2)}${confidence === null ? "" : ` · confidence ${confidence.toFixed(2)}`}`,
    type: "noul",
    value: v.value,
    confidence,
    signal,
    thresholds,
    source,
  };
}

const rank = (q: string) => (CRITERION.test(q) ? 0 : q === "scope_creep" ? 1 : 2);

export function verdictRows(verdicts: Detail["verdicts"], attempt: number): VerdictRow[] {
  return verdicts
    .filter((v) => v.attempt === attempt)
    .sort((a, b) => {
      const r = rank(a.question) - rank(b.question);
      if (r !== 0) return r;
      if (rank(a.question) === 0) return Number(CRITERION.exec(a.question)![1]) - Number(CRITERION.exec(b.question)![1]);
      return a.question < b.question ? -1 : a.question > b.question ? 1 : 0;
    })
    .map(verdictRow);
}

// ---------------------------------------------------------------------------- evidence and previews

// The local runner stores the verify screenshot as `<jobId>.png` and GET /api/evidence/:file serves it. The
// container runner keeps none (that route answers 404 there and the image is hidden), and the route checks
// names with this same pattern. Anything with a path separator or a leading dot never becomes a URL.
export function evidenceUrl(ref: string | null | undefined): string | null {
  return ref && /^[A-Za-z0-9_-][\w.-]*\.png$/i.test(ref) ? `/api/evidence/${ref}` : null;
}

export function previewUrl(repo: string, sha: string | null | undefined): string | null {
  return sha && /^[0-9a-f]{7,64}$/i.test(sha) ? `/preview/${encodeURIComponent(repo)}/${sha}/` : null;
}

export function testsSummary(text: string): { passed: number; failed: number; ms: number | null; timedOut: boolean } | null {
  const m = /^(\d+) passed, (\d+) failed(?: in (\d+) ms)?(\s*\(timed out\))?/.exec(text);
  return m ? { passed: Number(m[1]), failed: Number(m[2]), ms: m[3] === undefined ? null : Number(m[3]), timedOut: m[4] !== undefined } : null;
}

export type EvidenceView = {
  tests: { summary: string; passed: number | null; failed: number | null; signal: Signal } | null;
  /** The agent's one-line description of its screenshot; the UI labels it agent-provided. */
  agentScreenshot: string | null;
  agentSummary: string | null;
  imageUrl: string | null;
  other: { kind: string; summary: string; ref: string | null }[];
};

export function evidenceView(evidence: Detail["evidence"], attempt: number): EvidenceView {
  const view: EvidenceView = { tests: null, agentScreenshot: null, agentSummary: null, imageUrl: null, other: [] };
  for (const e of evidence) {
    if (e.attempt !== attempt) continue;
    view.imageUrl ??= evidenceUrl(e.ref);
    if (e.kind === "tests") {
      const t = testsSummary(e.summary);
      view.tests = {
        summary: e.summary,
        passed: t?.passed ?? null,
        failed: t?.failed ?? null,
        signal: t ? (t.failed === 0 && !t.timedOut ? "go" : "stop") : "none",
      };
    } else if (e.ref === "agent" && e.kind === "screenshot") view.agentScreenshot = e.summary;
    else if (e.ref === "agent" && e.kind === "log") view.agentSummary = e.summary;
    else if (evidenceUrl(e.ref) === null) view.other.push({ kind: e.kind, summary: e.summary, ref: e.ref });
  }
  return view;
}

export type Preview = { kind: "commit" | "snapshot"; sha: string; url: string };

// A landed transaction previews its own commit. Every other attempt can only preview the trunk it
// started from: its fork is a separate repo that /preview/:repo/:sha does not serve.
export function previewFor(repo: string, detail: Detail, attempt: number, row: AttemptRow | null): Preview | null {
  const isCurrent = attempt === detail.txn.attempt;
  const kind = detail.commit && isCurrent ? "commit" : "snapshot";
  const sha = kind === "commit" ? detail.commit : (row?.snapshot ?? (isCurrent ? detail.txn.snapshot : null));
  const url = previewUrl(repo, sha);
  return url && sha ? { kind, sha, url } : null;
}

// ---------------------------------------------------------------------------- path lists

export type Marks = { stale: BlamePath[]; conflicts: string[]; protectedPaths: string[]; warned: string[]; failures: Failure[] };
export type PathFlag = "stale" | "conflict" | "protected" | "warned";
export type PathRow = { path: string; flags: PathFlag[]; by: string | null; delta: string | null };

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

// What went wrong with an attempt. The ops cover every attempt; the live notes on the transaction add
// nothing for the old ones (a retry resets them), so they only count for the current attempt.
export function attemptMarks(detail: Detail, row: AttemptRow | null, isCurrent: boolean): Marks {
  const notes: Detail["detail"] = isCurrent ? detail.detail : {};
  const stale = [...(row?.stale ?? []), ...(notes.stale ?? []).map((p): BlamePath => ({ path: p.path, by: p.by ?? null }))];
  const own = row?.failures ?? [];
  return {
    stale: stale.filter((p, i) => stale.findIndex((q) => q.path === p.path) === i),
    conflicts: uniq([...(row?.conflicts ?? []), ...(notes.conflicts ?? [])]),
    protectedPaths: uniq([...(row?.protectedPaths ?? []), ...(notes.protected ?? [])]),
    warned: uniq([
      ...(row?.warnings ?? []).filter((w) => w.kind === "stale").flatMap((w) => w.paths),
      ...(isCurrent ? detail.staleWarnings.map((p) => p.path) : []),
    ]),
    failures: own.length > 0 ? own : (notes.failures ?? []),
  };
}

// Stale reads are flagged in the read set and carry the delta; text conflicts and protected writes
// are flagged in the write set. A path that is flagged is listed even if the access table lacks it,
// and flagged rows sort first: stop flags, then the caution of a warning, then the rest.
export function accessRows(kind: "read" | "write", reads: string[], writes: string[], marks: Marks, delta: Detail["delta"]): PathRow[] {
  const staleBy = new Map(marks.stale.map((p) => [p.path, p.by]));
  const patch = new Map(delta.map((d) => [d.path, d.patch]));
  const paths = kind === "read" ? uniq([...reads, ...staleBy.keys()]) : uniq([...writes, ...marks.conflicts, ...marks.protectedPaths]);

  const rows = paths.map((path): PathRow => {
    const flags: PathFlag[] = [];
    if (staleBy.has(path)) flags.push("stale");
    if (kind === "write" && marks.conflicts.includes(path)) flags.push("conflict");
    if (kind === "write" && marks.protectedPaths.includes(path)) flags.push("protected");
    if (kind === "read" && flags.length === 0 && marks.warned.includes(path)) flags.push("warned");
    const showsDelta = kind === "read" ? staleBy.has(path) : marks.conflicts.includes(path);
    return { path, flags, by: staleBy.get(path) ?? null, delta: showsDelta ? (patch.get(path) ?? null) : null };
  });
  const order = (r: PathRow) => (r.flags.some((f) => f !== "warned") ? 0 : r.flags.length > 0 ? 1 : 2);
  return rows.sort((a, b) => order(a) - order(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------------------------------------------------------------------------- per-attempt view model

export type AttemptDetail = {
  attempt: number;
  isCurrent: boolean;
  row: AttemptRow | null;
  marks: Marks;
  reads: PathRow[];
  writes: PathRow[];
  verdicts: VerdictRow[];
  evidence: EvidenceView;
  failures: Failure[];
  preview: Preview | null;
};

// `pastDelta` is what delta.ts computed in the browser for an attempt that was already retried.
export function attemptDetail(detail: Detail, attempt: number, repo: string, pastDelta: DeltaEntry[] = []): AttemptDetail {
  const isCurrent = attempt === detail.txn.attempt;
  const row = attemptRows(detail.ops).find((r) => r.attempt === attempt) ?? null;
  const access = detail.attempts.find((a) => a.attempt === attempt);
  const marks = attemptMarks(detail, row, isCurrent);
  // The API computes the delta against the current head, and only while the transaction is stale. Earlier
  // attempts get theirs from the two snapshots in the op log, fetched by the page.
  const delta = isCurrent ? detail.delta : pastDelta;
  return {
    attempt,
    isCurrent,
    row,
    marks,
    reads: accessRows("read", access?.reads ?? [], access?.writes ?? [], marks, delta),
    writes: accessRows("write", access?.reads ?? [], access?.writes ?? [], marks, delta),
    verdicts: verdictRows(detail.verdicts, attempt),
    evidence: evidenceView(detail.evidence, attempt),
    failures: marks.failures,
    preview: previewFor(repo, detail, attempt, row),
  };
}

// ---------------------------------------------------------------------------- the attempts, as bars

// The detail's ops folded through the same reducer the Line uses, so an attempt's bar on this page has the
// segments its bar on the Line has. The detail leaves out the transaction and agent of each op: they are its own.
export function journeyView(detail: Detail): TxnView | null {
  const ops: Op[] = detail.ops.map((o) => ({ seq: o.seq, at: o.at, kind: o.kind as OpKind, data: o.data, txn: detail.txn.id, agent: detail.txn.agent }));
  return fold(ops).txns.get(detail.txn.id) ?? null;
}

// From the first attempt's start to the end of the last one (or now while it runs): the span the bars share.
export function journeySpan(view: TxnView, now: number): { from: number; to: number } | null {
  const first = view.attempts[0];
  if (!first) return null;
  const to = Math.max(...view.attempts.map((a) => a.end ?? now), first.start + 1);
  return { from: first.start, to };
}

// "criterion 2" of the verdicts belongs to the second acceptance criterion; the rest are checks of their own.
export function criteriaWithVerdicts(criteria: readonly string[], rows: readonly VerdictRow[]): { text: string; verdict: VerdictRow | null }[] {
  return criteria.map((text, i) => ({ text, verdict: rows.find((r) => r.name === `criterion ${i + 1}`) ?? null }));
}

export function otherVerdicts(criteria: readonly string[], rows: readonly VerdictRow[]): VerdictRow[] {
  return rows.filter((r) => {
    const m = /^criterion (\d+)$/.exec(r.name);
    return !m || Number(m[1]) > criteria.length;
  });
}
