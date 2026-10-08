// Shared vocabulary for the Worker, the dashboard and the harness (PLAN.md §1.1, §4).

export const TXN_STATES = [
  "open",
  "submitted",
  "ready",
  "verifying",
  "landed",
  "stale",
  "failed",
  "needs_human",
  "aborted",
  "rejected",
  "recalled",
] as const;
export type TxnState = (typeof TXN_STATES)[number];

export const TERMINAL_STATES: readonly TxnState[] = ["landed", "recalled", "aborted", "rejected"];
export const MAX_ATTEMPTS = 3;

export type Policy = {
  protected: string[];
  union: string[];
  verify: string;
  verifyTimeoutSeconds: number;
  human: string[];
  trainMax: number;
  preview?: { main: string };
  // Speculative trains (PLAN.md §5.6); absent means on.
  pipeline?: boolean;
};

export type Txn = {
  id: string;
  repo: string;
  agent: string;
  model: string | null;
  intent: string;
  criteria: string[];
  state: TxnState;
  attempt: number;
  snapshot: string;
  snapshotSeq: number;
  fork: string;
  head: string | null;
  train: string | null;
  landedSeq: number | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  submittedAt: number | null;
};

export type StalePath = { path: string; seq: number; by?: string | null };
export type DeltaEntry = { path: string; patch: string };
export type Warning =
  | { kind: "duplicate"; other: string; intent: string; footprint: string[]; value: number }
  | { kind: "conflict"; other: string; intent: string; footprint: string[]; score: number; confidence: number }
  | { kind: "stale"; paths: string[]; seq: number };

export const OP_KINDS = [
  "txn.open",
  "txn.submitted",
  "txn.ready",
  "txn.verifying",
  "txn.landed",
  "txn.stale",
  "txn.failed",
  "txn.needs_human",
  "txn.aborted",
  "txn.rejected",
  "txn.recalled",
  "trunk.advanced",
  "trunk.diverged",
  "train.formed",
  "train.bisect",
  "train.confirmed",
  "train.done",
  "stale.warning",
  "heat.changed",
  "lease.granted",
  "lease.waiting",
  "lease.released",
  "dup.warning",
  "conflict.warning",
  "judge.verdict",
  "reads.fallback",
  "recall.planned",
  "recall.done",
  "policy.updated",
] as const;
export type OpKind = (typeof OP_KINDS)[number];

// Op payloads differ per kind; `any` (not `unknown`) so they survive Workers RPC typing, and the
// reducers in src/shared narrow them per kind.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpData = { [key: string]: any };

export type Op = {
  seq: number;
  at: number;
  kind: OpKind;
  txn: string | null;
  agent: string | null;
  data: OpData;
};

// Store push event, the exact envelope Artifacts emits (PLAN.md §3.2).
export type PushEvent = {
  type: "cf.artifacts.repo.pushed";
  source: { type: "artifacts.repo"; namespace: string; repoName: string };
  payload: {
    ref: string;
    before: string;
    after: string;
    commits: { sha: string; message: string; author: string; at: number }[];
    totalCommitsCount: number;
    commitsTruncated: boolean;
  };
  metadata: { eventTimestamp: string };
};

export type TestSummary = { passed: number; failed: number; failures: { name: string; message: string }[] };
