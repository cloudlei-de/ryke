// Pure projections of the op log (PLAN.md §12 "Data flow"). The live dashboard and the replay
// scrubber both fold ops through `apply`, so a replayed seq renders exactly what was live.
import { decayed, isHot } from "../worker/ledger/heat";
import type { Op, Policy, TxnState } from "./types";

export type Segment = { state: TxnState | "lease_wait"; from: number; to: number | null };
export type AttemptView = {
  attempt: number;
  start: number;
  end: number | null;
  outcome: TxnState | null;
  reason: string | null;
  stale: { path: string; by: string | null }[];
  segments: Segment[];
  warnings: { at: number; paths: string[] }[];
};
export type TxnView = {
  id: string;
  agent: string;
  intent: string;
  model: string | null;
  state: TxnState;
  reason: string | null;
  attempt: number;
  train: string | null;
  sha: string | null;
  landedSeq: number | null;
  attempts: AttemptView[];
};
export type TrainView = {
  id: string;
  txns: string[];
  base: string;
  formedAt: number;
  doneAt: number | null;
  outcome: string | null;
  probes: { txns: string[]; pass: boolean; at: number }[];
};
export type Tick = { seq: number; sha: string; txn: string | null; train: string | null; at: number };
export type RecallView = { id: string; at: number; targets: string[]; dependents: string[]; cascade: string[]; outcome: string | null };

export type LineState = {
  seq: number;
  now: number;
  head: { sha: string; seq: number } | null;
  ticks: Tick[];
  txns: Map<string, TxnView>;
  agents: string[];
  trains: Map<string, TrainView>;
  heat: Map<string, { value: number; at: number }>;
  leases: Map<string, { txn: string; expires: number }>;
  aborts: Record<string, number>;
  ticker: Op[];
  recalls: RecallView[];
  policy: Policy | null;
};

const TICKER = 12;
const TERMINAL: TxnState[] = ["landed", "recalled", "aborted", "rejected"];

export function initial(): LineState {
  return {
    seq: 0,
    now: 0,
    head: null,
    ticks: [],
    txns: new Map(),
    agents: [],
    trains: new Map(),
    heat: new Map(),
    leases: new Map(),
    aborts: {},
    ticker: [],
    recalls: [],
    policy: null,
  };
}

function current(t: TxnView): AttemptView | undefined {
  return t.attempts.at(-1);
}

function closeSegment(a: AttemptView, at: number): void {
  const last = a.segments.at(-1);
  if (last && last.to === null) last.to = at;
}

function enter(t: TxnView, state: TxnState, at: number): void {
  const a = current(t);
  if (!a) return;
  closeSegment(a, at);
  if (!TERMINAL.includes(state) && state !== "stale" && state !== "failed") a.segments.push({ state, from: at, to: null });
}

// Counted by cause, the way the right rail shows them (§12): stale reads, text conflicts, failed verifies, …
function abortCause(kind: string, reason: string | null): string | null {
  if (kind === "txn.stale") return reason === "text_conflict" ? "text_conflict" : "stale_read";
  if (kind === "txn.failed") return reason === "tests" || reason === "verify_failed" || reason === "tests_failed" ? "failed_verify" : (reason ?? "failed");
  if (kind === "txn.rejected") return reason?.startsWith("duplicate_of") ? "duplicate" : (reason ?? "rejected");
  if (kind === "txn.aborted") return reason === "max_attempts" ? "max_attempts" : null;
  return null;
}

export function apply(s: LineState, op: Op): LineState {
  if (op.seq <= s.seq) return s;
  s.seq = op.seq;
  s.now = Math.max(s.now, op.at);
  s.ticker = [op, ...s.ticker].slice(0, TICKER);
  const d = op.data;
  const t = op.txn ? s.txns.get(op.txn) : undefined;
  switch (op.kind) {
    case "txn.open": {
      if (!op.txn || !op.agent) break;
      let view = t;
      if (!view) {
        view = { id: op.txn, agent: op.agent, intent: d.intent ?? "", model: d.model ?? null, state: "open", reason: null, attempt: 1, train: null, sha: null, landedSeq: null, attempts: [] };
        s.txns.set(op.txn, view);
        if (!s.agents.includes(op.agent)) s.agents.push(op.agent);
      }
      view.state = "open";
      view.reason = null;
      view.attempt = d.attempt ?? view.attempt;
      view.train = null;
      view.attempts.push({ attempt: view.attempt, start: op.at, end: null, outcome: null, reason: null, stale: [], segments: [{ state: "open", from: op.at, to: null }], warnings: [] });
      break;
    }
    case "txn.submitted":
    case "txn.ready":
    case "txn.verifying":
    case "txn.needs_human": {
      if (!t) break;
      t.state = op.kind.slice(4) as TxnState;
      if (op.kind === "txn.verifying") t.train = d.train ?? null;
      if (op.kind === "txn.ready") t.train = null;
      t.reason = d.reason ?? null;
      enter(t, t.state, op.at);
      break;
    }
    case "txn.landed":
    case "txn.stale":
    case "txn.failed":
    case "txn.aborted":
    case "txn.rejected": {
      if (!t) break;
      t.state = op.kind.slice(4) as TxnState;
      t.reason = d.reason ?? null;
      if (op.kind === "txn.landed") {
        t.sha = d.sha ?? null;
        t.landedSeq = d.seq ?? null;
      }
      const a = current(t);
      if (a) {
        enter(t, t.state, op.at);
        a.end = op.at;
        a.outcome = t.state;
        a.reason = t.reason;
        if (op.kind === "txn.stale") a.stale = (d.paths ?? []).map((p: { path: string; by?: string | null }) => ({ path: p.path, by: p.by ?? null }));
      }
      t.train = op.kind === "txn.landed" ? t.train : null;
      const cause = abortCause(op.kind, t.reason);
      if (cause) s.aborts[cause] = (s.aborts[cause] ?? 0) + 1;
      break;
    }
    case "txn.recalled": {
      if (!t) break;
      t.state = "recalled";
      t.reason = d.reason ?? null;
      break;
    }
    case "trunk.advanced": {
      const landed: { txn: string; sha: string; seq: number }[] = d.txns ?? [];
      if (landed.length === 0 && typeof d.sha === "string") s.ticks.push({ seq: d.seq, sha: d.sha, txn: null, train: d.train ?? null, at: op.at });
      for (const l of landed) s.ticks.push({ seq: l.seq, sha: l.sha, txn: l.txn, train: d.train ?? null, at: op.at });
      s.head = { sha: d.sha, seq: d.seq };
      break;
    }
    case "train.formed":
      s.trains.set(d.train, { id: d.train, txns: d.txns ?? [], base: d.base, formedAt: op.at, doneAt: null, outcome: null, probes: [] });
      break;
    case "train.bisect":
      s.trains.get(d.train)?.probes.push({ txns: d.probe ?? [], pass: Boolean(d.pass), at: op.at });
      break;
    case "train.done": {
      const tr = s.trains.get(d.train);
      if (tr) {
        tr.doneAt = op.at;
        tr.outcome = d.outcome ?? null;
      }
      break;
    }
    case "stale.warning":
      if (t) current(t)?.warnings.push({ at: op.at, paths: d.paths ?? [] });
      break;
    case "heat.changed":
      s.heat.set(d.path, { value: d.value, at: op.at });
      break;
    case "lease.granted":
      s.leases.set(d.path, { txn: op.txn ?? "", expires: d.expires });
      if (t) {
        const a = current(t);
        const last = a?.segments.at(-1);
        if (a && last?.state === "lease_wait" && last.to === null) {
          last.to = op.at;
          a.segments.push({ state: t.state, from: op.at, to: null });
        }
      }
      break;
    case "lease.waiting":
      if (t) {
        const a = current(t);
        const last = a?.segments.at(-1);
        if (a && last?.state !== "lease_wait") {
          closeSegment(a, op.at);
          a.segments.push({ state: "lease_wait", from: op.at, to: null });
        }
      }
      break;
    case "lease.released":
      if (s.leases.get(d.path)?.txn === d.txn) s.leases.delete(d.path);
      break;
    case "recall.planned":
      s.recalls.push({ id: d.recall, at: op.at, targets: d.targets ?? [], dependents: d.dependents ?? [], cascade: [], outcome: null });
      break;
    case "recall.done": {
      const r = s.recalls.find((x) => x.id === d.recall);
      if (r) {
        r.outcome = d.outcome ?? null;
        r.cascade = d.cascade ?? [];
      }
      break;
    }
    case "policy.updated":
      if (d.policy) s.policy = d.policy;
      break;
    default:
      break;
  }
  return s;
}

export function fold(ops: readonly Op[], upTo = Infinity): LineState {
  const s = initial();
  for (const op of ops) {
    if (op.seq > upTo) break;
    apply(s, op);
  }
  return s;
}

// Right-rail numbers (§12): in flight, landed per minute over the last minute, aborts by cause, trains.
export function counters(s: LineState, now = s.now) {
  let inflight = 0;
  for (const t of s.txns.values()) if (["open", "submitted", "ready", "verifying", "needs_human"].includes(t.state)) inflight++;
  const landedLastMinute = s.ticks.filter((k) => k.txn && k.at > now - 60_000 && k.at <= now).length;
  return { inflight, landedPerMinute: landedLastMinute, landed: s.ticks.filter((k) => k.txn).length, aborts: { ...s.aborts }, trains: s.trains.size };
}

export function heatAt(s: LineState, now = s.now): { path: string; value: number; hot: boolean }[] {
  return [...s.heat.entries()]
    .map(([path, h]) => {
      const value = decayed(h.value, h.at, now);
      return { path, value, hot: isHot(value) };
    })
    .sort((a, b) => b.value - a.value || (a.path < b.path ? -1 : 1));
}
