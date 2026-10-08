// The Line's activity feed: the op log told as sentences (PLAN.md §12 "op ticker", made readable). Each op that
// says something to a person becomes one item; bookkeeping ops (leases taken and given back, heat updates,
// verdicts, readiness) are left to the raw view, which lists every op as the Ledger wrote it.
import type { LineState, TrainView, TxnView } from "../../../shared/reducers";
import type { Op } from "../../../shared/types";
import type { MarkName } from "../../ui";
import { reasonLabel } from "../txn/format";
import { clipText, kindSignal, shortSha, type Signal } from "./geometry";

// A piece of a sentence: plain words, a transaction (shown by its intent, linked to its page), or a path.
export type Part = string | { txn: string; label: string } | { code: string };
// "agent-05 went stale", then the transaction it is about, then what happened in detail.
export type FeedItem = { seq: number; at: number; tone: Signal | null; mark: MarkName; actor: string | null; text: Part[]; subject: Part | null; detail: Part[] | null };

const INTENT_CHARS = 72;
// A transaction named inside a detail line (the one that made this one stale, the one it may duplicate) is
// the second subject of the item, so it gets less room than the first.
const CAUSE_CHARS = 44;

function txnPart(id: string | null | undefined, txns: ReadonlyMap<string, TxnView>, max = INTENT_CHARS): Part {
  if (!id) return "a transaction";
  const intent = txns.get(id)?.intent.trim();
  return { txn: id, label: intent ? clipText(intent, max) : id };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function stalePaths(d: Op["data"], txns: ReadonlyMap<string, TxnView>): Part[] | null {
  const paths: { path?: unknown; by?: unknown }[] = Array.isArray(d.paths) ? d.paths : [];
  const first = paths[0];
  if (d.reason === "text_conflict") return first ? ["text conflict in ", { code: str(first.path) }] : ["text conflict"];
  if (!first || typeof first.path !== "string") return null;
  const out: Part[] = [{ code: first.path }, " changed"];
  if (typeof first.by === "string" && first.by) out.push(" by ", txnPart(first.by, txns, CAUSE_CHARS));
  if (paths.length > 1) out.push(` · +${paths.length - 1} more`);
  return out;
}

function trainSize(train: TrainView | undefined, d: Op["data"]): number {
  return strs(d.txns).length || train?.txns.length || 0;
}

const reason = (d: Op["data"]): Part[] | null => (d.reason ? [reasonLabel(str(d.reason))] : null);

export function describeOp(op: Op, state: Pick<LineState, "txns" | "trains">): FeedItem | null {
  const d = op.data;
  const txns = state.txns;
  const subject = op.txn ? txnPart(op.txn, txns) : null;
  const base = { seq: op.seq, at: op.at, tone: kindSignal(op.kind), actor: op.agent };
  // About a transaction: the agent's name leads, the transaction follows on its own line.
  const about = (mark: MarkName, text: Part[], detail: Part[] | null = null): FeedItem => ({ ...base, mark, text, subject, detail });
  // About the trunk, a train or a recall: no agent, no subject.
  const event = (mark: MarkName, text: Part[], detail: Part[] | null, tone: Signal | null = base.tone): FeedItem => ({ ...base, tone, actor: null, mark, text, subject: null, detail });
  switch (op.kind) {
    case "txn.open":
      if (d.refresh) return null;
      return Number(d.attempt) > 1 ? about("retry", [`retried · attempt ${d.attempt}`]) : about("working", ["began"]);
    case "txn.landed":
      return about("landed", ["landed"], [`seq ${d.seq}${d.sha ? ` · ${shortSha(str(d.sha))}` : ""}`]);
    case "txn.stale":
      return about("stale", ["went stale"], stalePaths(d, txns));
    case "txn.failed": {
      const name = str(d.failures?.[0]?.name);
      return about("failed", ["failed verify"], name ? [{ code: name }] : reason(d));
    }
    case "txn.rejected":
      return about("rejected", ["was rejected"], reason(d));
    case "txn.needs_human":
      return about("human", ["needs a human"], reason(d));
    case "txn.aborted":
      return about("aborted", ["gave up"], reason(d));
    case "txn.recalled":
      return about("recalled", ["was recalled"], reason(d));
    case "stale.warning": {
      const paths = strs(d.paths);
      return about("warning", ["was warned"], paths.length ? [{ code: paths[0]! }, paths.length > 1 ? ` +${paths.length - 1}` : "", " changed on trunk"] : null);
    }
    case "lease.waiting":
      return about("lease", ["waits for a lease"], d.path ? [{ code: str(d.path) }] : null);
    case "dup.warning":
      return about("warning", ["may be a duplicate"], ["of ", txnPart(str(d.other), txns, CAUSE_CHARS)]);
    case "conflict.warning":
      return about("warning", ["may conflict"], ["with ", txnPart(str(d.other), txns, CAUSE_CHARS)]);
    case "trunk.advanced":
      if (d.recall) return event("recalled", ["Trunk reverted by recall ", { code: str(d.recall) }], [`seq ${d.seq} · ${shortSha(str(d.sha))}`], "recall");
      // A move with no transaction and no recall is the seed commit; a landing is told by txn.landed.
      return Array.isArray(d.txns) && d.txns.length > 0 ? null : event("trunk", ["Trunk created"], [`seq ${d.seq} · ${shortSha(str(d.sha))}`], null);
    case "trunk.diverged":
      return event("alert", ["Trunk diverged from the store"], [`store ${shortSha(str(d.store))} ≠ ledger ${shortSha(str(d.ledger))}`]);
    // A train of one change says nothing its landing does not; trains are news when they batch or go wrong.
    case "train.formed": {
      const n = trainSize(state.trains.get(str(d.train)), d);
      if (n < 2) return null;
      return event("train", [`Train of ${n} changes formed`], d.after ? ["speculative, behind ", { code: str(d.after) }] : [{ code: str(d.train) }]);
    }
    case "train.bisect":
      return event("train", [`Bisect: ${plural(strs(d.probe).length, "change")} ${d.pass ? "passed" : "failed"}`], [{ code: str(d.train) }], "run");
    case "train.done": {
      const n = trainSize(state.trains.get(str(d.train)), d);
      const outcome = str(d.outcome);
      if (outcome === "landed") return n < 2 ? null : event("train", [`Train landed ${n} changes together`], [{ code: str(d.train) }], "go");
      if (outcome === "discarded") return event("train", ["Speculative train discarded"], ["its base did not land · ", { code: str(d.train) }], null);
      return event("train", [`Train ${outcome.replace(/_/g, " ") || "ended"}`], [{ code: str(d.train) }], outcome === "failed" ? "stop" : null);
    }
    case "recall.planned":
      return event("recalled", [`Recall planned: ${plural(strs(d.targets).length, "target")}`], [{ code: str(d.recall) }, strs(d.dependents).length ? ` · ${plural(strs(d.dependents).length, "dependent")}` : ""]);
    case "recall.done":
      return event("recalled", [str(d.outcome) === "pass" ? "Recall landed" : `Recall ended: ${str(d.outcome).replace(/_/g, " ")}`], [{ code: str(d.recall) }], str(d.outcome) === "pass" ? "recall" : "stop");
    case "policy.updated":
      return d.error ? event("alert", ["Policy rejected"], [str(d.error)], "stop") : event("policy", ["Policy updated"], d.sha ? [shortSha(str(d.sha))] : null, null);
    default:
      return null;
  }
}

// The index just past the last op at or before `upTo`. The log is in seq order, so the replay finds its position
// in log time instead of walking every op after the playhead on each frame.
export function endIndex(ops: readonly Op[], upTo: number): number {
  let lo = 0;
  let hi = ops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ops[mid]!.seq <= upTo) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Newest first, up to `max` items, from the ops at or before `upTo` (the replay's position; live, the last op).
// Walks back from that position, so a long log costs only the ops between it and the oldest item shown.
export function feed(ops: readonly Op[], upTo: number, state: Pick<LineState, "txns" | "trains">, max = 80): FeedItem[] {
  const out: FeedItem[] = [];
  for (let i = endIndex(ops, upTo) - 1; i >= 0 && out.length < max; i--) {
    const it = describeOp(ops[i]!, state);
    if (it) out.push(it);
  }
  return out;
}

// The same window of the log, every op, for the raw view.
export function rawOps(ops: readonly Op[], upTo: number, max = 80): Op[] {
  const end = endIndex(ops, upTo);
  return ops.slice(Math.max(0, end - max), end).reverse();
}

// The words of a sentence without its markup: what a screen reader or a title attribute gets.
export function plain(parts: readonly (Part | null)[]): string {
  return parts.map((p) => (p === null ? "" : typeof p === "string" ? p : "txn" in p ? p.label : p.code)).join("");
}
