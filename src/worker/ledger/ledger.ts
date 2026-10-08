import { DurableObject } from "cloudflare:workers";
import { unifiedDiff } from "../../shared/diff";
import { DEFAULT_POLICY, matchesAny, normalizePath, parsePolicy, PolicyError } from "../../shared/policy";
import {
  MAX_ATTEMPTS,
  TERMINAL_STATES,
  type DeltaEntry,
  type Op,
  type OpData,
  type OpKind,
  type Policy,
  type StalePath,
  type Txn,
  type TxnState,
  type Warning,
} from "../../shared/types";
import { StoreError, storeFor, type RepoStore } from "../store/store";
import { bump, decayed, HEAT_EMIT_MS, isHot, leaseDecision, shouldEmit } from "./heat";
import { access, RunnerError, runnerFor, runToCompletion } from "../runner/runner";
import { authRemote } from "../service";
import { planRecall, RecallError, type LandedTxn, type RecallPlan, type RecallSelector } from "./recall";
import { migrate } from "./schema";
import { selectTrain } from "./trains";
import { validate } from "./validate";

export type Res<T> = { ok: true; value: T } | { ok: false; status: number; error: string; detail?: unknown };

export class LedgerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

type TxnRow = {
  id: string;
  agent: string;
  model: string | null;
  intent: string;
  criteria: string;
  state: TxnState;
  attempt: number;
  snapshot: string;
  snapshot_seq: number;
  fork: string;
  head: string | null;
  train: string | null;
  landed_seq: number | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
  submitted_at: number | null;
  skips: number;
  detail: string;
  commit_sha: string | null;
};

type TrainRow = { id: string; base: string; base_seq: number; txns: string; state: string; created_at: number; updated_at: number; detail: string };

export type TrainTxn = {
  id: string;
  fork: string;
  head: string;
  attempt: number;
  snapshot: string;
  agent: string;
  model: string | null;
  intent: string;
  criteria: string[];
  approved: boolean;
};
export type TrainParams = { repo: string; trainId: string; base: string; baseSeq: number; txns: TrainTxn[] };

export type BeginInput = { agent: string; model?: string | null; intent: string; criteria?: string[] };
export type BeginResult = {
  txn: string;
  state: TxnState;
  reason?: string;
  attempt: number;
  snapshot: string;
  remote: string;
  token: string;
  trunk: { remote: string; token: string };
  policy: Policy;
  warnings: Warning[];
};
export type TxnNotes = {
  created?: string[];
  stale?: StalePath[];
  conflicts?: string[];
  protected?: string[];
  failures?: { name: string; message: string }[] | null;
  approved?: boolean;
  previous?: { attempt: number; state: string; reason: string | null };
};
export type TxnDetail = {
  txn: Txn;
  detail: TxnNotes;
  commit: string | null;
  attempts: { attempt: number; reads: string[]; writes: string[] }[];
  verdicts: { attempt: number; question: string; value: number; confidence: number | null; detail: string | null }[];
  evidence: { attempt: number; kind: string; summary: string; ref: string | null }[];
  ops: { seq: number; at: number; kind: string; data: OpData }[];
  delta: DeltaEntry[];
  staleWarnings: StalePath[];
};

export type RepoSummary = {
  repo: string;
  head: string;
  seq: number;
  policy: Policy;
  counts: Record<string, number>;
  inflight: { txn: string; agent: string; intent: string; state: string; footprint: string[] }[];
  heat: { path: string; value: number; hot: boolean }[];
  train: string | null;
};
type RevertJob = {
  ok: boolean;
  pass?: boolean;
  outcome: "prepared" | "pushed" | "verified" | "verify_failed" | "conflict" | "cas_rejected";
  base?: string;
  head?: string;
  commits: { sha: string; txn: string | null; paths: string[] }[];
  cascade: string[];
  conflict?: { txn: string; paths: string[] };
  tests?: { passed: number; failed: number; failures: { name: string; message: string }[] };
};
export type RecallResult = {
  dryRun: boolean;
  plan: { targets: string[]; dependents: string[]; order: string[] };
  recall?: string;
  outcome?: string;
  head?: string;
  cascade?: string[];
  requeued?: { from: string; txn: string; remote: string; token: string; trunk: { remote: string; token: string }; snapshot: string }[];
  failures?: { name: string; message: string }[];
};
export type Screen = { reject?: { other: string; value: number }; warnings: Warning[] };

// Legal moves of PLAN.md §4.2. Anything else is answered with 409.
const LEGAL: Record<TxnState, readonly TxnState[]> = {
  open: ["submitted", "aborted", "rejected"],
  submitted: ["ready", "stale", "rejected", "aborted"],
  // ready → landed only when a train the watchdog gave up on pushes after all (commitTrain).
  ready: ["verifying", "stale", "aborted", "landed"],
  verifying: ["landed", "failed", "needs_human", "stale", "ready", "aborted"],
  stale: ["open", "aborted"],
  failed: ["open", "aborted"],
  needs_human: ["ready", "failed", "aborted"],
  landed: ["recalled"],
  recalled: [],
  aborted: [],
  rejected: [],
};

const FORK_TOKEN_TTL = 4 * 3600;
const TRUNK_TOKEN_TTL = 4 * 3600;
const SCHEDULE_MS = 200;
const WATCHDOG_MS = 5000;
const STUCK_TRAIN_MS = 120_000;
const GIVE_UP_TRAIN_MS = 30 * 60_000;
// A train in any other state has ended; `committed` means trunk moved and only trainDone is left.
const LIVE_TRAIN = ["running", "bisecting", "judging", "committed"];
const MAX_CAS_REJECTIONS = 3;
const MAX_LAND_ERRORS = 3;

// 0.5 s, 1 s, 2 s … capped at 30 s between attempts to start a Land workflow.
export function createBackoffMs(failures: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, failures - 1));
}
const MAX_READS_BATCH = 500;
const SHA = /^[0-9a-f]{40}$/;

export function newId(prefix: string, now = Date.now()): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => (b % 36).toString(36)).join("");
  return `${prefix}${now.toString(36)}${rand}`;
}

function fail(status: number, message: string, detail?: unknown): never {
  throw new LedgerError(status, message, detail);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function strings(v: unknown, what: string, max = Infinity): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) fail(422, `${what} must be a list of strings`);
  if (v.length > max) fail(422, `${what} has more than ${max} entries`);
  return v as string[];
}

function paths(v: unknown, what: string, max = Infinity): string[] {
  try {
    return [...new Set(strings(v, what, max).map(normalizePath))];
  } catch (e) {
    if (e instanceof PolicyError) fail(422, e.message);
    throw e;
  }
}

export class Ledger extends DurableObject<Env> {
  private sql: SqlStorage;
  private store: RepoStore;
  private waiters = new Map<string, Set<() => void>>();
  private locks = new Map<string, Promise<void>>();
  private outbox: Op[] = [];
  private heatEmitted = new Map<string, number>();
  private heatPending = new Set<string>();
  private trunkWaiters: (() => void)[] = [];
  private policyCache: Policy | null = null;
  private trunkAccess: { remote: string; token: string; expires: number } | null = null;
  private reserved = new Map<string, { intent: string; until: number }>();
  // In memory on purpose: the recall runs inside one RPC, so a restart that kills it also clears the
  // hold instead of blocking the lander forever.
  private recalling: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    migrate(this.sql);
    this.store = storeFor(env);
  }

  // ---------------------------------------------------------------- plumbing

  private async run<T>(fn: () => Promise<T> | T): Promise<Res<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof LedgerError) return { ok: false, status: e.status, error: e.message, detail: e.detail };
      if (e instanceof PolicyError) return { ok: false, status: 422, error: e.message };
      if (e instanceof StoreError) {
        const status = { NOT_FOUND: 404, ALREADY_EXISTS: 409, INVALID: 422, UNAVAILABLE: 503 }[e.code];
        return { ok: false, status, error: `store: ${e.message}` };
      }
      // An unreachable runner is an outage to retry, like an unavailable store.
      if (e instanceof RunnerError) return { ok: false, status: 503, error: `runner: ${e.message}` };
      throw e;
    }
  }

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => mine);
    this.locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  private now(): number {
    return Date.now();
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.sql.exec("DELETE FROM meta WHERE key = ?", key);
    else this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  private repo(): string {
    return this.meta("repo") ?? fail(404, "repo is not initialised");
  }

  private policy(): Policy {
    if (!this.policyCache) {
      const raw = this.meta("policy");
      this.policyCache = raw ? (JSON.parse(raw) as Policy) : { ...DEFAULT_POLICY };
    }
    return this.policyCache;
  }

  private head(): { seq: number; sha: string } {
    return (
      this.sql.exec<{ seq: number; sha: string }>("SELECT seq, sha FROM trunk ORDER BY seq DESC LIMIT 1").toArray()[0] ??
      fail(404, "repo has no trunk")
    );
  }

  private op(kind: OpKind, txn: { id: string; agent: string } | null, data: Record<string, unknown> = {}): Op {
    const at = this.now();
    const { seq } = this.sql
      .exec<{ seq: number }>(
        "INSERT INTO op (at, kind, txn, agent, data) VALUES (?, ?, ?, ?, ?) RETURNING seq",
        at,
        kind,
        txn?.id ?? null,
        txn?.agent ?? null,
        JSON.stringify(data),
      )
      .one();
    const op: Op = { seq, at, kind, txn: txn?.id ?? null, agent: txn?.agent ?? null, data };
    // One frame per turn of the event loop keeps WebSocket traffic proportional to bursts, not ops.
    if (this.outbox.push(op) === 1) queueMicrotask(() => this.flush());
    return op;
  }

  private flush(): void {
    const ops = this.outbox;
    this.outbox = [];
    if (ops.length === 0) return;
    const frame = JSON.stringify({ ops });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        // a closing socket; its close handler cleans up
      }
    }
  }

  private notify(txn: string): void {
    const set = this.waiters.get(txn);
    if (!set) return;
    this.waiters.delete(txn);
    for (const wake of set) wake();
  }

  private row(id: string): TxnRow {
    return this.sql.exec<TxnRow>("SELECT * FROM txn WHERE id = ?", id).toArray()[0] ?? fail(404, `unknown transaction ${id}`);
  }

  private toTxn(r: TxnRow): Txn {
    return {
      id: r.id,
      repo: this.meta("repo") ?? "",
      agent: r.agent,
      model: r.model,
      intent: r.intent,
      criteria: JSON.parse(r.criteria) as string[],
      state: r.state,
      attempt: r.attempt,
      snapshot: r.snapshot,
      snapshotSeq: r.snapshot_seq,
      fork: r.fork,
      head: r.head,
      train: r.train,
      landedSeq: r.landed_seq,
      reason: r.reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      submittedAt: r.submitted_at,
    };
  }

  private detailOf(r: TxnRow): Record<string, unknown> {
    return JSON.parse(r.detail) as Record<string, unknown>;
  }

  // Every state change goes through here: legality, max attempts, the op, and waking long-polls.
  private transition(
    r: TxnRow,
    to: TxnState,
    opts: { reason?: string | null; set?: Partial<TxnRow>; detail?: Record<string, unknown>; data?: Record<string, unknown> } = {},
  ): TxnRow {
    if (!LEGAL[r.state].includes(to)) fail(409, `transaction ${r.id} is ${r.state}; cannot move to ${to}`);
    let target = to;
    let reason = opts.reason === undefined ? r.reason : opts.reason;
    const data: Record<string, unknown> = { attempt: r.attempt, ...opts.data };
    if ((to === "stale" || to === "failed") && r.attempt >= MAX_ATTEMPTS) {
      target = "aborted";
      data.cause = { state: to, reason };
      reason = "max_attempts";
    }
    const detail = opts.detail === undefined ? r.detail : JSON.stringify({ ...this.detailOf(r), ...opts.detail });
    const next: TxnRow = { ...r, ...opts.set, state: target, reason, detail, updated_at: this.now() };
    this.sql.exec(
      `UPDATE txn SET state = ?, attempt = ?, snapshot = ?, snapshot_seq = ?, head = ?, train = ?, landed_seq = ?,
         reason = ?, updated_at = ?, submitted_at = ?, skips = ?, detail = ?, commit_sha = ? WHERE id = ?`,
      next.state,
      next.attempt,
      next.snapshot,
      next.snapshot_seq,
      next.head,
      next.train,
      next.landed_seq,
      next.reason,
      next.updated_at,
      next.submitted_at,
      next.skips,
      next.detail,
      next.commit_sha,
      next.id,
    );
    if (reason && data.reason === undefined) data.reason = reason;
    this.op(`txn.${target}` as OpKind, next, data);
    if (TERMINAL_STATES.includes(target) || target === "stale" || target === "failed") this.releaseLeases(next.id);
    this.notify(next.id);
    return next;
  }

  private changedSince(seq: number): Map<string, number> {
    const rows = this.sql
      .exec<{ path: string; seq: number }>("SELECT path, MAX(seq) AS seq FROM changed WHERE seq > ? GROUP BY path", seq)
      .toArray();
    return new Map(rows.map((r) => [r.path, r.seq]));
  }

  private access(txn: string, attempt: number, kind: "read" | "write"): string[] {
    return this.sql
      .exec<{ path: string }>("SELECT path FROM access WHERE txn = ? AND attempt = ? AND kind = ? ORDER BY path", txn, attempt, kind)
      .toArray()
      .map((r) => r.path);
  }

  private created(r: TxnRow): string[] {
    return (this.detailOf(r).created as string[] | undefined) ?? [];
  }

  private recordAccess(txn: string, attempt: number, kind: "read" | "write", list: string[]): void {
    const at = this.now();
    for (const p of list) this.sql.exec("INSERT OR IGNORE INTO access (txn, attempt, path, kind, at) VALUES (?, ?, ?, ?, ?)", txn, attempt, p, kind, at);
  }

  private txnAtSeq(seq: number): string | null {
    return this.sql.exec<{ txn: string | null }>("SELECT txn FROM trunk WHERE seq = ?", seq).toArray()[0]?.txn ?? null;
  }

  private staleWith(paths: { path: string; seq: number }[]): StalePath[] {
    return paths.map((p) => ({ ...p, by: this.txnAtSeq(p.seq) }));
  }

  private bumpHeat(list: string[]): void {
    const now = this.now();
    for (const path of list) {
      const prev = this.sql.exec<{ value: number; at: number }>("SELECT value, at FROM heat WHERE path = ?", path).toArray()[0];
      const next = bump(prev, now);
      this.sql.exec(
        "INSERT INTO heat (path, value, at) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET value = excluded.value, at = excluded.at",
        path,
        next.value,
        next.at,
      );
      this.heatPending.add(path);
    }
    this.flushHeat();
  }

  // heat.changed is throttled per path (§7.1); throttled values wait here and go out on a later
  // alarm, so a burst of aborts on one file still ends with its true heat on the dashboard.
  private flushHeat(): void {
    const now = this.now();
    for (const path of this.heatPending) {
      if (!shouldEmit(this.heatEmitted.get(path), now)) continue;
      this.heatPending.delete(path);
      this.heatEmitted.set(path, now);
      const value = this.heatOf(path);
      this.op("heat.changed", null, { path, value, hot: isHot(value) });
    }
    if (this.heatPending.size > 0) this.scheduleSoon(HEAT_EMIT_MS + 50);
  }

  private heatOf(path: string): number {
    const h = this.sql.exec<{ value: number; at: number }>("SELECT value, at FROM heat WHERE path = ?", path).toArray()[0];
    return h ? decayed(h.value, h.at, this.now()) : 0;
  }

  private releaseLeases(txn: string): void {
    const held = this.sql.exec<{ path: string }>("SELECT path FROM lease WHERE txn = ?", txn).toArray();
    if (held.length === 0) return;
    this.sql.exec("DELETE FROM lease WHERE txn = ?", txn);
    for (const { path } of held) this.op("lease.released", null, { path, txn });
  }

  private async seqOf(sha: string): Promise<number> {
    const find = () => this.sql.exec<{ seq: number }>("SELECT seq FROM trunk WHERE sha = ?", sha).toArray()[0]?.seq;
    // A fork taken between the lander's push and commitTrain sees a head the index does not know yet.
    const until = this.now() + 15_000;
    for (let seq = find(); ; seq = find()) {
      if (seq !== undefined) return seq;
      if (this.now() > until) fail(503, `trunk head ${sha} is not in the trunk index`);
      await new Promise<void>((r) => {
        this.trunkWaiters.push(r);
        setTimeout(r, 1000);
      });
    }
  }

  private async trunk(): Promise<{ remote: string; token: string }> {
    const now = this.now();
    if (!this.trunkAccess || this.trunkAccess.expires - now < 3600_000) {
      const repo = this.repo();
      const [info, token] = await Promise.all([this.store.info(repo), this.store.token(repo, "read", TRUNK_TOKEN_TTL)]);
      this.trunkAccess = { remote: info.remote, token, expires: now + TRUNK_TOKEN_TTL * 1000 };
    }
    return { remote: this.trunkAccess.remote, token: this.trunkAccess.token };
  }

  private scheduleSoon(ms = SCHEDULE_MS): void {
    const at = this.now() + ms;
    void this.ctx.storage.getAlarm().then((cur) => {
      if (cur === null || cur > at) return this.ctx.storage.setAlarm(at);
    });
  }

  // ---------------------------------------------------------------- repo lifecycle

  async init(repo: string, seedSha: string, policyText: string | null, opts: { autoland?: boolean } = {}): Promise<Res<{ repo: string; head: string }>> {
    return this.run(() => {
      if (this.meta("repo")) fail(409, `repo ${this.meta("repo")} is already initialised`);
      if (!SHA.test(seedSha)) fail(422, "seed sha must be 40 hex characters");
      const policy = parsePolicy(policyText);
      this.setMeta("repo", repo);
      this.setMeta("policy", JSON.stringify(policy));
      this.setMeta("autoland", opts.autoland === false ? "0" : "1");
      this.policyCache = policy;
      this.sql.exec("INSERT INTO trunk (seq, sha, txn, at) VALUES (0, ?, NULL, ?)", seedSha, this.now());
      this.op("trunk.advanced", null, { seq: 0, sha: seedSha, txns: [], train: null });
      this.op("policy.updated", null, { policy });
      return { repo, head: seedSha };
    });
  }

  // Every fork this repo created, so deleting the repo can delete them too.
  async forks(): Promise<Res<string[]>> {
    return this.run(() => this.sql.exec<{ fork: string }>("SELECT fork FROM txn WHERE fork != ''").toArray().map((r) => r.fork));
  }

  async reset(): Promise<Res<{ reset: true }>> {
    return this.run(async () => {
      for (const ws of this.ctx.getWebSockets()) ws.close(1012, "repo reset");
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.policyCache = null;
      this.trunkAccess = null;
      migrate(this.sql);
      return { reset: true as const };
    });
  }

  async summary(): Promise<Res<RepoSummary>> {
    return this.run(() => {
      const repo = this.repo();
      const head = this.head();
      const counts = Object.fromEntries(
        this.sql.exec<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM txn GROUP BY state").toArray().map((r) => [r.state, r.n]),
      );
      const inflight = this.sql
        .exec<TxnRow>("SELECT * FROM txn WHERE state IN ('open','submitted','ready','verifying') ORDER BY created_at")
        .toArray()
        .map((r) => ({
          txn: r.id,
          agent: r.agent,
          intent: r.intent,
          state: r.state,
          footprint: [...new Set([...this.access(r.id, r.attempt, "read"), ...this.access(r.id, r.attempt, "write")])].sort(),
        }));
      const now = this.now();
      const heat = this.sql
        .exec<{ path: string; value: number; at: number }>("SELECT path, value, at FROM heat")
        .toArray()
        .map((h) => ({ path: h.path, value: decayed(h.value, h.at, now) }))
        .filter((h) => h.value > 0.01)
        .sort((a, b) => b.value - a.value)
        .slice(0, 20)
        .map((h) => ({ ...h, hot: isHot(h.value) }));
      return { repo, head: head.sha, seq: head.seq, policy: this.policy(), counts, inflight, heat, train: this.meta("train") };
    });
  }

  // ---------------------------------------------------------------- agent operations

  async begin(input: BeginInput, screen: Screen = { warnings: [] }, reservedId?: string): Promise<Res<BeginResult>> {
    return this.run(async () => {
      const repo = this.repo();
      if (reservedId !== undefined && !this.reserved.has(reservedId)) fail(409, `reservation ${reservedId} is unknown or expired`);
      if (typeof input?.agent !== "string" || input.agent.trim() === "") fail(422, "agent is required");
      if (typeof input.intent !== "string" || input.intent.trim() === "") fail(422, "intent is required");
      if (input.model !== undefined && input.model !== null && typeof input.model !== "string") fail(422, "model must be a string");
      const criteria = input.criteria === undefined ? [] : strings(input.criteria, "criteria");
      const id = reservedId ?? newId("t_");
      this.reserved.delete(id);
      const fork = `${repo}--${id}`;
      const now = this.now();
      const insert = (snapshot: string, snapshotSeq: number) =>
        this.sql.exec(
          `INSERT INTO txn (id, agent, model, intent, criteria, state, attempt, snapshot, snapshot_seq, fork, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?)`,
          id,
          input.agent,
          input.model ?? null,
          input.intent,
          JSON.stringify(criteria),
          snapshot,
          snapshotSeq,
          fork,
          now,
          now,
        );
      const policy = this.policy();
      if (screen.reject) {
        const h = this.head();
        insert(h.sha, h.seq);
        const r = this.row(id);
        this.op("txn.open", r, { attempt: 1, intent: r.intent, model: r.model, snapshot: h.sha, snapshotSeq: h.seq, criteria });
        for (const w of screen.warnings) this.op(w.kind === "duplicate" ? "dup.warning" : "conflict.warning", r, w);
        this.transition(r, "rejected", { reason: `duplicate_of:${screen.reject.other}`, data: { other: screen.reject.other, value: screen.reject.value } });
        return {
          txn: id,
          state: "rejected" as const,
          reason: `duplicate_of:${screen.reject.other}`,
          attempt: 1,
          snapshot: h.sha,
          remote: "",
          token: "",
          trunk: await this.trunk(),
          policy,
          warnings: screen.warnings,
        };
      }
      const f = await this.openFork(fork);
      insert(f.snapshot, f.snapshotSeq);
      const r = this.row(id);
      this.op("txn.open", r, { attempt: 1, intent: r.intent, model: r.model, snapshot: f.snapshot, snapshotSeq: f.snapshotSeq, criteria, fork });
      for (const w of screen.warnings) this.op(w.kind === "duplicate" ? "dup.warning" : "conflict.warning", r, w);
      return { txn: id, state: "open" as const, attempt: 1, snapshot: f.snapshot, remote: f.remote, token: f.token, trunk: f.trunk, policy, warnings: screen.warnings };
    });
  }

  // Forks the trunk for a transaction; the snapshot is whatever head the fork actually got.
  private async openFork(fork: string) {
    const repo = this.repo();
    await this.store.fork(repo, fork);
    const info = await this.store.info(fork);
    if (!info.head) fail(409, `trunk ${repo} has no commits`);
    const snapshotSeq = await this.seqOf(info.head);
    const [token, trunk] = await Promise.all([this.store.token(fork, "write", FORK_TOKEN_TTL), this.trunk()]);
    return { snapshot: info.head, snapshotSeq, remote: info.remote, token, trunk };
  }

  // Candidates for the duplicate/conflict screen at begin (§7.3): live work plus the last 30 minutes of landings.
  // Candidates for the duplicate/conflict screen at begin (§7.3): live work, the last 30 minutes of
  // landings, and begins still being screened. The caller's own begin is reserved here, so two
  // near-identical intents racing through the screen still see each other.
  async screenCandidates(intent?: string): Promise<Res<{ txn: string; candidates: { id: string; intent: string; footprint: string[] }[] }>> {
    return this.run(() => {
      this.repo();
      const now = this.now();
      for (const [id, r] of this.reserved) if (r.until < now) this.reserved.delete(id);
      const since = now - 30 * 60_000;
      const candidates = this.sql
        .exec<TxnRow>(
          "SELECT * FROM txn WHERE state IN ('open','submitted','ready','verifying') OR (state = 'landed' AND updated_at >= ?)",
          since,
        )
        .toArray()
        .map((r) => ({
          id: r.id,
          intent: r.intent,
          footprint: [...new Set([...this.access(r.id, r.attempt, "read"), ...this.access(r.id, r.attempt, "write")])].sort(),
        }));
      for (const [id, r] of this.reserved) candidates.push({ id, intent: r.intent, footprint: [] });
      const txn = newId("t_");
      if (typeof intent === "string") this.reserved.set(txn, { intent, until: now + 60_000 });
      return { txn, candidates };
    });
  }

  private staleReads(r: TxnRow): StalePath[] {
    const changed = this.changedSince(r.snapshot_seq);
    const union = this.policy().union;
    const out: { path: string; seq: number }[] = [];
    for (const p of this.access(r.id, r.attempt, "read")) {
      const seq = changed.get(p);
      if (seq !== undefined && !matchesAny(union, p)) out.push({ path: p, seq });
    }
    return this.staleWith(out);
  }

  async reads(txnId: string, input: unknown): Promise<Res<{ recorded: number; staleWarnings: StalePath[] }>> {
    return this.run(() => {
      const list = paths(input, "paths", MAX_READS_BATCH);
      const r = this.row(txnId);
      if (r.state !== "open") fail(409, `transaction ${txnId} is ${r.state}; reads are recorded only while open`);
      this.recordAccess(r.id, r.attempt, "read", list);
      return { recorded: list.length, staleWarnings: this.staleReads(r) };
    });
  }

  async intendWrite(txnId: string, input: unknown): Promise<Res<{ go: true } | { go: false; owner: string; retryAfterMs: number }>> {
    return this.run(() => {
      if (typeof input !== "string") fail(422, "path must be a string");
      const [path] = paths([input], "path");
      const r = this.row(txnId);
      if (r.state !== "open") fail(409, `transaction ${txnId} is ${r.state}; write intents need an open transaction`);
      const now = this.now();
      const lease = this.sql.exec<{ path: string; txn: string; expires: number }>("SELECT * FROM lease WHERE path = ?", path!).toArray()[0] ?? null;
      // A holder keeps its lease until it lands or fails: admitting the next writer while the holder's
      // change is still on its way to trunk would only start work on a snapshot about to go stale.
      const holderState = lease ? this.sql.exec<{ state: string }>("SELECT state FROM txn WHERE id = ?", lease.txn).toArray()[0]?.state : undefined;
      const holder = holderState === "open" ? "working" : holderState && ["submitted", "ready", "verifying"].includes(holderState) ? "landing" : "gone";
      const d = leaseDecision({ path: path!, requester: r.id, heat: this.heatOf(path!), lease, holder, now });
      if (d.go) {
        this.sql.exec(
          "INSERT INTO lease (path, txn, expires) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET txn = excluded.txn, expires = excluded.expires",
          path!,
          r.id,
          d.lease.expires,
        );
        if (!lease || lease.txn !== r.id || lease.expires <= now) this.op("lease.granted", r, { path, expires: d.lease.expires });
        return { go: true as const };
      }
      this.op("lease.waiting", r, { path, owner: d.owner, retryAfterMs: d.retryAfterMs });
      return { go: false as const, owner: d.owner, retryAfterMs: d.retryAfterMs };
    });
  }

  async submit(txnId: string, body: { head?: unknown; evidence?: unknown } = {}): Promise<Res<{ state: TxnState; reason?: string | null; paths?: string[] | StalePath[] }>> {
    return this.run(() =>
      this.locked(txnId, async () => {
        let r = this.row(txnId);
        if (body.head !== undefined && (typeof body.head !== "string" || !SHA.test(body.head))) fail(422, "head must be a 40-hex commit sha");
        const evidence = body.evidence as { summary?: unknown; screenshot?: unknown } | undefined;
        if (evidence !== undefined && (typeof evidence !== "object" || evidence === null)) fail(422, "evidence must be an object");
        if (evidence?.summary !== undefined && typeof evidence.summary !== "string") fail(422, "evidence.summary must be a string");
        if (evidence?.screenshot !== undefined && typeof evidence.screenshot !== "string") fail(422, "evidence.screenshot must be a string");
        if (r.state !== "open") {
          // A repeated submit (agent retry after a timeout) answers with the current state.
          if (r.state !== "aborted" && r.submitted_at !== null && (body.head === undefined || body.head === r.head))
            return { state: r.state, reason: r.reason };
          fail(409, `transaction ${txnId} is ${r.state}; only open transactions can be submitted`);
        }
        // Push events can arrive late or out of order (production ingest is asynchronous), so without
        // an explicit head the fork itself says what was pushed.
        const head = (body.head as string | undefined) ?? (await this.store.info(r.fork)).head;
        if (!head || head === r.snapshot) {
          r = this.transition(this.row(txnId), "rejected", { reason: "empty", set: { head } });
          return { state: r.state, reason: r.reason };
        }
        let changes;
        try {
          changes = await this.store.diff(r.fork, r.snapshot, head);
        } catch (e) {
          if (e instanceof StoreError && e.code === "NOT_FOUND") fail(422, `head ${head} is not in fork ${r.fork}`);
          throw e;
        }
        let reads = this.access(r.id, r.attempt, "read");
        const writes = changes.map((c) => c.path);
        const created = changes.filter((c) => c.status === "A").map((c) => c.path);
        let fallback: string[] = [];
        if (reads.length === 0 && writes.length > 0) {
          // Untracked reads: assume the agent read everything next to what it wrote (§6.2).
          const dirs = new Set(writes.map(dirname));
          const files = await this.store.files(this.repo(), r.snapshot);
          fallback = [...new Set([...writes, ...files.filter((f) => dirs.has(dirname(f)))])].sort();
        }
        r = this.row(txnId);
        if (r.state !== "open") fail(409, `transaction ${txnId} is ${r.state}; only open transactions can be submitted`);
        if (fallback.length) {
          this.recordAccess(r.id, r.attempt, "read", fallback);
          reads = fallback;
          this.op("reads.fallback", r, { attempt: r.attempt, count: fallback.length });
        }
        this.recordAccess(r.id, r.attempt, "write", writes);
        if (evidence?.summary) this.putEvidence(r.id, r.attempt, "log", evidence.summary as string, "agent");
        if (evidence?.screenshot) this.putEvidence(r.id, r.attempt, "screenshot", evidence.screenshot as string, "agent");
        r = this.transition(r, "submitted", {
          set: { head, submitted_at: this.now() },
          detail: { created },
          data: { head, writes, reads: reads.length },
        });
        const v = validate({ reads, writes, created, changedSinceSnapshot: this.changedSince(r.snapshot_seq), policy: this.policy() });
        if (v.ok) {
          r = this.transition(r, "ready", { reason: null, data: { unionTouched: v.unionTouched } });
          this.scheduleSoon();
          return { state: r.state };
        }
        if (v.kind === "empty") {
          r = this.transition(r, "rejected", { reason: "empty" });
          return { state: r.state, reason: r.reason };
        }
        if (v.kind === "protected") {
          r = this.transition(r, "rejected", { reason: "protected", detail: { protected: v.paths }, data: { paths: v.paths } });
          return { state: r.state, reason: r.reason, paths: v.paths };
        }
        const stale = this.staleWith(v.paths);
        this.bumpHeat(stale.map((p) => p.path));
        r = this.transition(r, "stale", { reason: "stale_read", detail: { stale }, data: { paths: stale } });
        return { state: r.state, reason: r.reason, paths: stale };
      }),
    );
  }

  private putEvidence(txn: string, attempt: number, kind: string, summary: string, ref: string | null): void {
    this.sql.exec(
      "INSERT INTO evidence (txn, attempt, kind, summary, ref) VALUES (?, ?, ?, ?, ?) ON CONFLICT (txn, attempt, kind) DO UPDATE SET summary = excluded.summary, ref = excluded.ref",
      txn,
      attempt,
      kind,
      summary,
      ref,
    );
  }

  private stalePathsOf(r: TxnRow): string[] {
    const d = this.detailOf(r);
    if (r.reason === "text_conflict") return (d.conflicts as string[] | undefined) ?? [];
    return ((d.stale as StalePath[] | undefined) ?? []).map((p) => p.path);
  }

  private async delta(r: TxnRow, to: string): Promise<DeltaEntry[]> {
    const repo = this.repo();
    return Promise.all(
      this.stalePathsOf(r).map(async (path) => {
        const [before, after] = await Promise.all([this.store.readFile(repo, r.snapshot, path), this.store.readFile(repo, to, path)]);
        return { path, patch: unifiedDiff(path, before, after) };
      }),
    );
  }

  async retry(txnId: string): Promise<
    Res<{ snapshot: string; attempt: number; delta: DeltaEntry[]; failures: { name: string; message: string }[] | null; trunk: { remote: string; token: string }; remote: string; token: string }>
  > {
    return this.run(() =>
      this.locked(txnId, async () => {
        let r = this.row(txnId);
        if (r.state !== "stale" && r.state !== "failed") fail(409, `transaction ${txnId} is ${r.state}; only stale or failed transactions can be retried`);
        const head = this.head();
        const [delta, trunk, token, info] = await Promise.all([
          r.state === "stale" ? this.delta(r, head.sha) : Promise.resolve([]),
          this.trunk(),
          this.store.token(r.fork, "write", FORK_TOKEN_TTL),
          this.store.info(r.fork),
        ]);
        const failures = (this.detailOf(r).failures as { name: string; message: string }[] | undefined) ?? null;
        r = this.row(txnId);
        if (r.state !== "stale" && r.state !== "failed") fail(409, `transaction ${txnId} is ${r.state}; only stale or failed transactions can be retried`);
        r = this.transition(r, "open", {
          reason: null,
          set: { attempt: r.attempt + 1, snapshot: head.sha, snapshot_seq: head.seq, head: null, train: null, submitted_at: null, skips: 0 },
          // A human approved the code they saw; a new attempt is new code and goes through the gate again.
          detail: { created: [], stale: [], conflicts: [], failures: null, approved: false, previous: { attempt: r.attempt, state: r.state, reason: r.reason } },
          data: { attempt: r.attempt + 1, snapshot: head.sha, snapshotSeq: head.seq, intent: r.intent, model: r.model, retry: true },
        });
        return { snapshot: head.sha, attempt: r.attempt, delta, failures, trunk, remote: info.remote, token };
      }),
    );
  }

  // Moves an open transaction onto the current trunk before its agent has submitted, e.g. after
  // waiting for a lease on a hot file while the holder landed. Same attempt (nothing failed), fresh
  // snapshot; the reads carry over and the paths that changed in between come back as the delta.
  async refresh(txnId: string): Promise<Res<{ snapshot: string; attempt: number; delta: DeltaEntry[]; trunk: { remote: string; token: string } }>> {
    return this.run(() =>
      this.locked(txnId, async () => {
        let r = this.row(txnId);
        if (r.state !== "open") fail(409, `transaction ${txnId} is ${r.state}; only open transactions can be refreshed`);
        const head = this.head();
        const stale = this.staleReads(r);
        const repo = this.repo();
        const [delta, trunk] = await Promise.all([
          Promise.all(
            stale.map(async ({ path }) => {
              const [before, after] = await Promise.all([this.store.readFile(repo, r.snapshot, path), this.store.readFile(repo, head.sha, path)]);
              return { path, patch: unifiedDiff(path, before, after) };
            }),
          ),
          this.trunk(),
        ]);
        r = this.row(txnId);
        if (r.state !== "open") fail(409, `transaction ${txnId} is ${r.state}; only open transactions can be refreshed`);
        if (head.sha === r.snapshot) return { snapshot: r.snapshot, attempt: r.attempt, delta: [], trunk };
        // Reads stay: a path read at the old snapshot that did not change up to the new one is a read of
        // the new one, and the changed paths come back in the delta. Dropping them would let a semantic
        // conflict on a file the agent does not report again land unnoticed.
        this.sql.exec("UPDATE txn SET snapshot = ?, snapshot_seq = ?, head = NULL, updated_at = ? WHERE id = ?", head.sha, head.seq, this.now(), r.id);
        this.op("txn.open", r, { attempt: r.attempt, snapshot: head.sha, snapshotSeq: head.seq, intent: r.intent, model: r.model, refresh: true });
        this.notify(r.id);
        return { snapshot: head.sha, attempt: r.attempt, delta, trunk };
      }),
    );
  }

  async abort(txnId: string, reason: unknown): Promise<Res<{ state: TxnState }>> {
    return this.run(() => {
      if (reason !== undefined && typeof reason !== "string") fail(422, "reason must be a string");
      const r = this.row(txnId);
      if (r.state === "verifying") fail(409, `transaction ${txnId} is verifying in train ${r.train}; wait for the result`);
      return { state: this.transition(r, "aborted", { reason: (reason as string | undefined) || "agent_abort" }).state };
    });
  }

  async approve(txnId: string): Promise<Res<{ state: TxnState }>> {
    return this.run(() => {
      const r = this.row(txnId);
      if (r.state !== "needs_human") fail(409, `transaction ${txnId} is ${r.state}; only needs_human can be approved`);
      // Approval sends it back through a train so the trunk still never takes an unverified tree.
      const next = this.transition(r, "ready", { reason: null, set: { train: null }, detail: { approved: true }, data: { approved: true } });
      this.scheduleSoon();
      return { state: next.state };
    });
  }

  async reject(txnId: string): Promise<Res<{ state: TxnState }>> {
    return this.run(() => {
      const r = this.row(txnId);
      if (r.state !== "needs_human") fail(409, `transaction ${txnId} is ${r.state}; only needs_human can be rejected`);
      return { state: this.transition(r, "failed", { reason: "rejected_by_human" }).state };
    });
  }

  async detail(txnId: string): Promise<Res<TxnDetail>> {
    return this.run(async () => {
      const r = this.row(txnId);
      const attempts = Array.from({ length: r.attempt }, (_, i) => i + 1).map((attempt) => ({
        attempt,
        reads: this.access(r.id, attempt, "read"),
        writes: this.access(r.id, attempt, "write"),
      }));
      const verdicts = this.sql
        .exec<{ attempt: number; question: string; value: number; confidence: number | null; detail: string | null }>(
          "SELECT attempt, question, value, confidence, detail FROM verdict WHERE txn = ? ORDER BY attempt, question",
          r.id,
        )
        .toArray();
      const evidence = this.sql
        .exec<{ attempt: number; kind: string; summary: string; ref: string | null }>(
          "SELECT attempt, kind, summary, ref FROM evidence WHERE txn = ? ORDER BY attempt, kind",
          r.id,
        )
        .toArray();
      const ops = this.sql.exec<{ seq: number; at: number; kind: string; data: string }>("SELECT seq, at, kind, data FROM op WHERE txn = ? ORDER BY seq", r.id).toArray();
      const delta = r.state === "stale" ? await this.delta(r, this.head().sha) : [];
      return {
        txn: this.toTxn(r),
        detail: this.detailOf(r) as TxnNotes,
        commit: r.commit_sha,
        attempts,
        verdicts,
        evidence,
        ops: ops.map((o) => ({ ...o, data: JSON.parse(o.data) })),
        delta,
        staleWarnings: r.state === "open" ? this.staleReads(r) : [],
      };
    });
  }

  async status(txnId: string): Promise<Res<{ txn: Txn; staleWarnings: StalePath[]; detail: TxnNotes }>> {
    return this.run(() => {
      const r = this.row(txnId);
      return { txn: this.toTxn(r), staleWarnings: r.state === "open" ? this.staleReads(r) : [], detail: this.detailOf(r) as TxnNotes };
    });
  }

  async wait(txnId: string, timeoutMs: number): Promise<Res<{ txn: Txn; changed: boolean; staleWarnings: StalePath[]; detail: TxnNotes }>> {
    return this.run(async () => {
      const before = this.row(txnId);
      const ms = Math.max(0, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : 30_000, 60_000));
      const warned = before.state === "open" ? this.staleReads(before).length : 0;
      if (!TERMINAL_STATES.includes(before.state) && warned === 0) {
        await new Promise<void>((resolve) => {
          const set = this.waiters.get(txnId) ?? new Set();
          const wake = () => {
            clearTimeout(timer);
            set.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, ms);
          set.add(wake);
          this.waiters.set(txnId, set);
        });
      }
      const after = this.row(txnId);
      return {
        txn: this.toTxn(after),
        changed: after.state !== before.state || after.attempt !== before.attempt,
        staleWarnings: after.state === "open" ? this.staleReads(after) : [],
        detail: this.detailOf(after) as TxnNotes,
      };
    });
  }

  async ops(after: number, limit: number): Promise<Res<{ ops: Op[]; last: number }>> {
    return this.run(() => {
      this.repo();
      const lim = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 500, 5000));
      const rows = this.sql
        .exec<{ seq: number; at: number; kind: OpKind; txn: string | null; agent: string | null; data: string }>(
          "SELECT * FROM op WHERE seq > ? ORDER BY seq LIMIT ?",
          Number.isFinite(after) ? after : 0,
          lim,
        )
        .toArray();
      const ops: Op[] = rows.map((o) => ({ ...o, data: JSON.parse(o.data) as OpData }));
      return { ops, last: ops.at(-1)?.seq ?? after };
    });
  }

  async files(): Promise<Res<string[]>> {
    return this.run(() => this.store.files(this.repo(), this.head().sha));
  }

  // Push-event ingest (§5.5): idempotent, records the fork head for the transaction that owns it.
  async onPush(repoName: string, ref: string, after: string): Promise<Res<{ txn: string | null }>> {
    return this.run(() => {
      const repo = this.repo();
      if (!repoName.startsWith(`${repo}--`) || ref !== "refs/heads/main" || !SHA.test(after) || /^0+$/.test(after)) return { txn: null };
      const id = repoName.slice(repo.length + 2);
      const r = this.sql.exec<TxnRow>("SELECT * FROM txn WHERE id = ?", id).toArray()[0];
      if (!r || r.state !== "open") return { txn: null };
      this.sql.exec("UPDATE txn SET head = ?, updated_at = ? WHERE id = ?", after, this.now(), id);
      return { txn: id };
    });
  }

  // ---------------------------------------------------------------- scheduling

  async alarm(): Promise<void> {
    if (!this.meta("repo")) return;
    this.flushHeat();
    this.expireLeases();
    this.revalidateReady();
    await this.maybeFormTrain();
    if (this.meta("train")) await this.ctx.storage.setAlarm(this.now() + WATCHDOG_MS);
  }

  // Only an open holder's lease lapses: one on its way to trunk keeps the path until it lands or fails
  // (leaseDecision), and releaseLeases frees it then.
  private expireLeases(): void {
    const now = this.now();
    const lapsed = "expires <= ? AND txn NOT IN (SELECT id FROM txn WHERE state IN ('submitted', 'ready', 'verifying'))";
    const expired = this.sql.exec<{ path: string; txn: string }>(`SELECT path, txn FROM lease WHERE ${lapsed}`, now).toArray();
    if (expired.length === 0) return;
    this.sql.exec(`DELETE FROM lease WHERE ${lapsed}`, now);
    for (const l of expired) this.op("lease.released", null, { path: l.path, txn: l.txn, expired: true });
  }

  private revalidateReady(): void {
    const policy = this.policy();
    for (const r of this.sql.exec<TxnRow>("SELECT * FROM txn WHERE state = 'ready' ORDER BY submitted_at").toArray()) {
      const v = validate({
        reads: this.access(r.id, r.attempt, "read"),
        writes: this.access(r.id, r.attempt, "write"),
        created: this.created(r),
        changedSinceSnapshot: this.changedSince(r.snapshot_seq),
        policy,
      });
      if (v.ok || v.kind !== "stale") continue;
      const stale = this.staleWith(v.paths);
      this.bumpHeat(stale.map((p) => p.path));
      this.transition(r, "stale", { reason: "stale_read", detail: { stale }, data: { paths: stale } });
    }
  }

  // Tests (autoland off) form trains by hand and run the Land logic themselves with the params.
  async formTrain(): Promise<Res<{ train: string | null; params: TrainParams | null }>> {
    return this.run(async () => {
      const params = await this.startTrain(true);
      return { train: params?.trainId ?? null, params };
    });
  }

  private async maybeFormTrain(): Promise<void> {
    const inflight = this.meta("train");
    if (inflight) {
      await this.watchdog(inflight);
      return;
    }
    if (this.meta("autoland") === "0") return;
    await this.startTrain(false);
  }

  private async startTrain(manual: boolean): Promise<TrainParams | null> {
    if (this.meta("train") || this.recalling) return null;
    if (await this.trunkDiverged()) return null;
    const policy = this.policy();
    const ready = this.sql.exec<TxnRow>("SELECT * FROM txn WHERE state = 'ready' ORDER BY submitted_at, id").toArray();
    if (ready.length === 0) return null;
    const footprints = new Map(
      ready.map((r) => [r.id, [...new Set([...this.access(r.id, r.attempt, "read"), ...this.access(r.id, r.attempt, "write")])]]),
    );
    const { train, skipped } = selectTrain(
      ready.map((r) => ({
        id: r.id,
        submittedAt: r.submitted_at ?? r.updated_at,
        footprint: footprints.get(r.id)!,
        writes: this.access(r.id, r.attempt, "write"),
        skips: r.skips,
      })),
      policy,
    );
    if (train.length === 0) return null;
    const trainId = newId("tr_");
    const head = this.head();
    const now = this.now();
    const members: TrainTxn[] = [];
    for (const id of train) {
      const r = this.row(id);
      members.push({
        id: r.id,
        fork: r.fork,
        head: r.head!,
        attempt: r.attempt,
        snapshot: r.snapshot,
        agent: r.agent,
        model: r.model,
        intent: r.intent,
        criteria: JSON.parse(r.criteria) as string[],
        approved: this.detailOf(r).approved === true,
      });
      this.transition(r, "verifying", { set: { train: trainId }, data: { train: trainId } });
    }
    for (const id of skipped) this.sql.exec("UPDATE txn SET skips = skips + 1 WHERE id = ?", id);
    this.sql.exec(
      "INSERT INTO train (id, base, base_seq, txns, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
      trainId,
      head.sha,
      head.seq,
      JSON.stringify(train),
      now,
      now,
    );
    this.setMeta("train", trainId);
    this.op("train.formed", null, { train: trainId, txns: train, base: head.sha, baseSeq: head.seq });
    const params: TrainParams = { repo: this.repo(), trainId, base: head.sha, baseSeq: head.seq, txns: members };
    if (!manual) {
      try {
        await this.env.LAND.create({ id: trainId, params });
        this.setMeta("create_failures", null);
      } catch (e) {
        // Without a backoff an unavailable Workflows binding re-forms the same train every 200 ms.
        const failures = Number(this.meta("create_failures") ?? 0) + 1;
        this.setMeta("create_failures", String(failures));
        // Not a land error: the train never ran, so its members must not be charged for it.
        this.endTrain(trainId, "create_failed", train, { error: (e as Error).message }, createBackoffMs(failures));
        return null;
      }
      await this.ctx.storage.setAlarm(this.now() + WATCHDOG_MS);
    }
    return params;
  }

  private async watchdog(trainId: string): Promise<void> {
    const t = this.sql.exec<TrainRow>("SELECT * FROM train WHERE id = ?", trainId).toArray()[0];
    if (!t) {
      this.setMeta("train", null);
      return;
    }
    const idle = this.now() - t.updated_at;
    if (idle < STUCK_TRAIN_MS) return;
    let status = "unknown";
    try {
      status = (await (await this.env.LAND.get(trainId)).status()).status;
    } catch {
      // A failed lookup is not evidence the train died; ending it early could double-land members.
      if (idle < GIVE_UP_TRAIN_MS) return;
    }
    if (["running", "queued", "waiting", "paused", "waitingForPause", "unknown"].includes(status) && idle < GIVE_UP_TRAIN_MS) return;
    // The workflow may have reported in while the lookup was in flight.
    const now = this.sql.exec<TrainRow>("SELECT * FROM train WHERE id = ?", trainId).toArray()[0];
    if (this.meta("train") !== trainId || !now || !LIVE_TRAIN.includes(now.state)) return;
    this.endTrain(trainId, "error", JSON.parse(t.txns) as string[], { error: `land workflow ${status}` });
  }

  // Trains keep being rejected when trunk moved outside the Ledger (a push whose answer was lost and
  // could not be reconciled). Forming more would loop prepare and verify forever, so after a few
  // rejections the store is asked, and a trunk the Ledger does not know stops the lander with an op.
  private async trunkDiverged(): Promise<boolean> {
    if (Number(this.meta("cas_rejections") ?? 0) < MAX_CAS_REJECTIONS) return false;
    const store = await this.store.info(this.repo()).then((i) => i.head, () => null);
    const ledger = this.head().sha;
    if (store === null || store === ledger) {
      this.setMeta("cas_rejections", null);
      return false;
    }
    if (this.meta("diverged") !== store) {
      this.setMeta("diverged", store);
      this.op("trunk.diverged", null, { store, ledger });
    }
    return true;
  }

  // Requeues whatever the train still holds and frees the lander for the next train.
  private endTrain(trainId: string, outcome: string, members: string[], extra: Record<string, unknown> = {}, nextInMs = SCHEDULE_MS): void {
    for (const id of members) {
      const r = this.sql.exec<TxnRow>("SELECT * FROM txn WHERE id = ?", id).toArray()[0];
      if (r?.state !== "verifying" || r.train !== trainId) continue;
      const errors = ((this.detailOf(r).landErrors as number | undefined) ?? 0) + (outcome === "error" ? 1 : 0);
      if (errors >= MAX_LAND_ERRORS)
        this.transition(r, "failed", { reason: "land_error", set: { train: null }, detail: { landErrors: errors }, data: { train: trainId, error: extra.error ?? null } });
      else this.transition(r, "ready", { set: { train: null }, detail: { landErrors: errors }, data: { train: trainId, requeued: true } });
    }
    this.sql.exec("UPDATE train SET state = ?, updated_at = ?, detail = ? WHERE id = ?", outcome, this.now(), JSON.stringify(extra), trainId);
    if (outcome === "cas_rejected") this.setMeta("cas_rejections", String(Number(this.meta("cas_rejections") ?? 0) + 1));
    else if (outcome === "landed") this.setMeta("cas_rejections", null);
    if (this.meta("train") === trainId) this.setMeta("train", null);
    this.op("train.done", null, { train: trainId, outcome, ...extra });
    this.scheduleSoon(nextInMs);
  }

  // ---------------------------------------------------------------- Land Workflow callbacks

  private member(trainId: string, txnId: string): TxnRow | null {
    const r = this.sql.exec<TxnRow>("SELECT * FROM txn WHERE id = ?", txnId).toArray()[0];
    return r && r.state === "verifying" && r.train === trainId ? r : null;
  }

  private touchTrain(trainId: string, state?: string): TrainRow {
    const t = this.sql.exec<TrainRow>("SELECT * FROM train WHERE id = ?", trainId).toArray()[0] ?? fail(404, `unknown train ${trainId}`);
    // A zombie workflow calling in after its train ended must not bring the train back.
    if (LIVE_TRAIN.includes(t.state)) this.sql.exec("UPDATE train SET updated_at = ?, state = COALESCE(?, state) WHERE id = ?", this.now(), state ?? null, trainId);
    return t;
  }

  async trainConflicts(trainId: string, conflicts: { txn: string; paths: string[] }[]): Promise<Res<{ moved: string[] }>> {
    return this.run(() => {
      this.touchTrain(trainId);
      const moved: string[] = [];
      for (const c of conflicts) {
        const r = this.member(trainId, c.txn);
        if (!r) continue;
        this.bumpHeat(c.paths);
        this.transition(r, "stale", { reason: "text_conflict", set: { train: null }, detail: { conflicts: c.paths }, data: { paths: c.paths.map((path) => ({ path })) } });
        moved.push(c.txn);
      }
      return { moved };
    });
  }

  async trainProbe(trainId: string, txns: string[], pass: boolean): Promise<Res<{ ok: true }>> {
    return this.run(() => {
      this.touchTrain(trainId, "bisecting");
      this.op("train.bisect", null, { train: trainId, probe: txns, pass });
      return { ok: true as const };
    });
  }

  async trainEvidence(trainId: string, items: { txn: string; kind: string; summary: string; ref?: string | null }[]): Promise<Res<{ ok: true }>> {
    return this.run(() => {
      this.touchTrain(trainId);
      for (const e of items) {
        const r = this.member(trainId, e.txn);
        if (r) this.putEvidence(r.id, r.attempt, e.kind, e.summary, e.ref ?? null);
      }
      return { ok: true as const };
    });
  }

  async trainVerdicts(
    trainId: string,
    txnId: string,
    verdicts: { question: string; value: number; confidence: number | null; detail?: string | null }[],
  ): Promise<Res<{ ok: true }>> {
    return this.run(() => {
      this.touchTrain(trainId, "judging");
      const r = this.member(trainId, txnId);
      if (!r) return { ok: true as const };
      for (const v of verdicts) {
        this.sql.exec(
          "INSERT INTO verdict (txn, attempt, question, value, confidence, detail) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (txn, attempt, question) DO UPDATE SET value = excluded.value, confidence = excluded.confidence, detail = excluded.detail",
          r.id,
          r.attempt,
          v.question,
          v.value,
          v.confidence,
          v.detail ?? null,
        );
        this.op("judge.verdict", r, { attempt: r.attempt, question: v.question, value: v.value, confidence: v.confidence, detail: v.detail ?? null });
      }
      return { ok: true as const };
    });
  }

  async trainOutcome(
    trainId: string,
    txnId: string,
    outcome: "failed" | "needs_human" | "ready",
    reason: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<Res<{ state: TxnState | null }>> {
    return this.run(() => {
      this.touchTrain(trainId);
      const r = this.member(trainId, txnId);
      if (!r) return { state: null };
      return { state: this.transition(r, outcome, { reason, set: { train: null }, detail, data: { train: trainId, ...detail } }).state };
    });
  }

  async commitTrain(trainId: string, candidate: string, commits: { txn: string; sha: string; paths: string[] }[]): Promise<Res<{ seq: number }>> {
    return this.run(async () => {
      const t = this.touchTrain(trainId);
      if (t.state === "committed" || t.state === "landed") return { seq: this.head().seq };
      let seq = this.head().seq;
      const now = this.now();
      const changedPaths = new Set<string>();
      const landed: { txn: string; sha: string; seq: number }[] = [];
      for (const c of commits) {
        seq++;
        this.sql.exec("INSERT INTO trunk (seq, sha, txn, at) VALUES (?, ?, ?, ?)", seq, c.sha, c.txn, now);
        for (const p of c.paths) {
          this.sql.exec("INSERT OR IGNORE INTO changed (seq, path) VALUES (?, ?)", seq, p);
          changedPaths.add(p);
        }
        // Trunk has this commit, so its transaction landed even if the watchdog had already given its
        // train up and requeued it (ready) or another train has since picked it up (verifying).
        const r = this.sql.exec<TxnRow>("SELECT * FROM txn WHERE id = ?", c.txn).toArray()[0];
        if (r && (r.state === "verifying" || r.state === "ready"))
          this.transition(r, "landed", { reason: null, set: { landed_seq: seq, commit_sha: c.sha, train: trainId }, data: { train: trainId, sha: c.sha, seq } });
        landed.push({ txn: c.txn, sha: c.sha, seq });
      }
      this.sql.exec("UPDATE train SET state = 'committed', updated_at = ? WHERE id = ?", now, trainId);
      this.op("trunk.advanced", null, { seq, sha: commits.at(-1)?.sha ?? candidate, txns: landed, train: trainId });
      this.warnOpen(changedPaths, seq);
      for (const wake of this.trunkWaiters.splice(0)) wake();
      if (changedPaths.has("ryke.json")) await this.reloadPolicy(candidate);
      return { seq };
    });
  }

  // §4.4: tell open transactions that something they read just changed on trunk.
  private warnOpen(changed: Set<string>, seq: number): void {
    const union = this.policy().union;
    const relevant = [...changed].filter((p) => !matchesAny(union, p));
    if (relevant.length === 0) return;
    for (const r of this.sql.exec<TxnRow>("SELECT * FROM txn WHERE state = 'open'").toArray()) {
      const reads = new Set(this.access(r.id, r.attempt, "read"));
      const hit = relevant.filter((p) => reads.has(p));
      if (hit.length === 0) continue;
      this.op("stale.warning", r, { attempt: r.attempt, paths: hit, seq });
      this.notify(r.id);
    }
  }

  private async reloadPolicy(sha: string): Promise<void> {
    try {
      const policy = parsePolicy(await this.store.readFile(this.repo(), sha, "ryke.json"));
      this.setMeta("policy", JSON.stringify(policy));
      this.policyCache = policy;
      this.op("policy.updated", null, { policy, sha });
    } catch (e) {
      this.op("policy.updated", null, { error: (e as Error).message, sha, kept: true });
    }
  }

  async trainDone(trainId: string, outcome: string, extra: Record<string, unknown> = {}): Promise<Res<{ ok: true }>> {
    return this.run(() => {
      const t = this.sql.exec<TrainRow>("SELECT * FROM train WHERE id = ?", trainId).toArray()[0] ?? fail(404, `unknown train ${trainId}`);
      if (!LIVE_TRAIN.includes(t.state)) return { ok: true as const };
      this.endTrain(trainId, t.state === "committed" ? "landed" : outcome, JSON.parse(t.txns) as string[], extra);
      return { ok: true as const };
    });
  }

  // ---------------------------------------------------------------- recall (§8)

  private landed(): LandedTxn[] {
    return this.sql
      .exec<TxnRow>("SELECT * FROM txn WHERE state = 'landed' AND commit_sha IS NOT NULL ORDER BY landed_seq")
      .toArray()
      .map((r) => ({
        id: r.id,
        agent: r.agent,
        model: r.model,
        landedSeq: r.landed_seq!,
        commit: r.commit_sha!,
        reads: this.access(r.id, r.attempt, "read"),
        writes: this.access(r.id, r.attempt, "write"),
      }));
  }

  async recall(selector: unknown, dryRun: boolean): Promise<Res<RecallResult>> {
    return this.run(() =>
      this.locked("__recall", async () => {
        if (typeof selector !== "object" || selector === null || Array.isArray(selector)) fail(422, "selector must be an object");
        const plan = () => {
          try {
            return planRecall(this.landed(), selector as RecallSelector, { union: this.policy().union });
          } catch (e) {
            if (e instanceof RecallError) fail(422, e.message);
            throw e;
          }
        };
        if (dryRun) {
          const p = plan();
          return { dryRun: true, plan: { targets: p.targets, dependents: p.dependents, order: p.order } };
        }
        plan(); // reject a bad selector before taking the lander
        // Recall writes trunk, so it holds the lander like a train: no new train forms from here on,
        // and the plan is made only after the train in flight has landed what it was landing.
        this.recalling = "pending";
        try {
          for (const until = this.now() + 15 * 60_000; this.meta("train"); ) {
            if (this.now() > until) fail(409, "a train is still landing; try again");
            await new Promise((r) => setTimeout(r, 250));
          }
          const landed = this.landed();
          const p = plan();
          if (p.targets.length === 0) fail(422, "the selector matches no landed transaction");
          const id = newId("rc_");
          this.recalling = id;
          this.op("recall.planned", null, { recall: id, selector: selector as RecallSelector, targets: p.targets, dependents: p.dependents, order: p.order });
          try {
            return await this.executeRecall(id, p, landed);
          } catch (e) {
            // A recall.planned without recall.done would leave the dashboard animating forever.
            this.op("recall.done", null, { recall: id, outcome: "error", error: (e as Error).message });
            throw e;
          }
        } finally {
          this.recalling = null;
          this.scheduleSoon();
        }
      }),
    );
  }

  private async executeRecall(id: string, plan: RecallPlan, landed: LandedTxn[]): Promise<RecallResult> {
    const repo = this.repo();
    const policy = this.policy();
    const seqs = Object.fromEntries(landed.map((l) => [l.id, l.landedSeq]));
    const commits = Object.fromEntries(landed.map((l) => [l.id, l.commit]));
    const firstTarget = (dep: string) => plan.targets.find((t) => seqs[t]! < seqs[dep]!) ?? plan.targets[0]!;
    const runner = runnerFor(this.env);
    const token = async (scope: "read" | "write") => authRemote(this.env, (await this.store.info(repo)).remote, await this.store.token(repo, scope, 3600));
    const jobMs = (policy.verifyTimeoutSeconds + 120) * 1000;
    const done = <T>(job: { state: string; exitCode?: number; result?: unknown }, what: string): T => {
      const r = job.result as ({ ok?: boolean; error?: string } & T) | undefined;
      if (job.state !== "done" || !r || r.ok === false) fail(503, `${what} job failed (exit ${job.exitCode}): ${r?.error ?? "no result"}`);
      return r;
    };
    const ref = `refs/ryke/recall/${id}`;
    // Revert (write token, no repo code runs), then verify with a read-only token: agent-written tests
    // never run next to a credential that could push to trunk.
    const revert = async (order: string[]): Promise<RevertJob> => {
      // Union membership is resolved here with the policy's own matcher and handed over as paths, so the
      // revert job cannot read a glob differently (it once disagreed on `**`).
      const unionPaths = [...new Set(landed.filter((l) => order.includes(l.id)).flatMap((l) => l.writes))].filter((p) => matchesAny(policy.union, p)).sort();
      const script = {
        recall: id,
        order,
        commits,
        seqs,
        unionPaths,
        cascadeCandidates: plan.cascadeCandidates,
        targetOf: Object.fromEntries(order.map((t) => [t, plan.targets.includes(t) ? t : firstTarget(t)])),
      };
      const prepared = done<RevertJob>(
        await runToCompletion(runner, "revert", { trunk: await token("write"), plan: JSON.stringify(script), ref }, access.write(repo), jobMs),
        "revert",
      );
      if (prepared.outcome !== "prepared" || !prepared.head || prepared.head === prepared.base) return prepared;
      const verified = done<{ pass: boolean; tests: NonNullable<RevertJob["tests"]> }>(
        await runToCompletion(
          runner,
          "verify",
          { remote: await token("read"), ref: prepared.head, command: policy.verify, timeout: String(policy.verifyTimeoutSeconds) },
          access.verify(repo),
          jobMs,
        ),
        "verify",
      );
      return { ...prepared, pass: verified.pass, outcome: verified.pass ? "verified" : "verify_failed", tests: verified.tests };
    };
    // The revert job leaves its result on a scratch ref; a push removes it, anything else must too.
    const dropRef = () =>
      token("write")
        .then((trunk) => runToCompletion(runner, "land", { mode: "cleanup", trunk, refs: JSON.stringify([ref]) }, access.write(repo), 60_000))
        .catch(() => undefined);
    let forced = false;
    let result: RevertJob;
    try {
      result = await revert(plan.order);
      // §8.4: if the reverted trunk fails its tests, the dependents that relied on the targets go too.
      if (result.outcome === "verify_failed" && plan.dependents.length > 0) {
        forced = true;
        result = await revert([...plan.targets, ...plan.dependents].sort((a, b) => seqs[b]! - seqs[a]!));
      }
      if (result.outcome === "verified") {
        let pushed: boolean;
        try {
          pushed = done<{ pushed: boolean }>(
            await runToCompletion(
              runner,
              "land",
              { mode: "push", trunk: await token("write"), candidate: result.head!, notes: "[]", cleanup: JSON.stringify([ref]) },
              access.write(repo),
              jobMs,
              { cancelOnTimeout: false },
            ),
            "push",
          ).pushed;
        } catch (e) {
          // The push may have landed although its answer was lost; trunk itself says which. Without this
          // the trunk index would stay behind the store and every later train would be rejected.
          const head = await this.store.info(repo).then((i) => i.head, () => null);
          if (head !== result.head) throw e;
          pushed = true;
        }
        result = { ...result, outcome: pushed ? "pushed" : "cas_rejected" };
      }
    } catch (e) {
      await dropRef();
      throw e;
    }
    const summary = { targets: plan.targets, dependents: plan.dependents, order: plan.order };
    if (result.outcome !== "pushed") {
      await dropRef();
      this.op("recall.done", null, { recall: id, outcome: result.outcome, conflict: result.conflict ?? null, failures: result.tests?.failures ?? [], forced });
      return { dryRun: false, recall: id, plan: summary, outcome: result.outcome, cascade: [], requeued: [], failures: result.tests?.failures ?? [] };
    }
    let seq = this.head().seq;
    const now = this.now();
    const changed = new Set<string>();
    for (const c of result.commits) {
      seq++;
      this.sql.exec("INSERT INTO trunk (seq, sha, txn, at) VALUES (?, ?, NULL, ?)", seq, c.sha, now);
      for (const p of c.paths) {
        this.sql.exec("INSERT OR IGNORE INTO changed (seq, path) VALUES (?, ?)", seq, p);
        changed.add(p);
      }
    }
    const cascade = forced ? plan.dependents : result.cascade;
    for (const t of plan.targets) this.transition(this.row(t), "recalled", { reason: "target", data: { recall: id } });
    for (const t of cascade) {
      const r = this.row(t);
      if (r.state === "landed") this.transition(r, "recalled", { reason: "cascade", data: { recall: id } });
    }
    this.op("trunk.advanced", null, { seq, sha: result.head, txns: [], train: null, recall: id });
    this.warnOpen(changed, seq);
    for (const wake of this.trunkWaiters.splice(0)) wake();
    // Cascaded work is not lost: each intent comes back as a new transaction for the same agent.
    const requeued: RecallResult["requeued"] = [];
    const requeueErrors: { from: string; error: string }[] = [];
    for (const from of cascade) {
      const r = this.row(from);
      const txn = newId("t_");
      const fork = `${repo}--${txn}`;
      // One unreachable fork must not lose the other cascaded intents.
      let f: Awaited<ReturnType<Ledger["openFork"]>>;
      try {
        f = await this.openFork(fork);
      } catch (e) {
        requeueErrors.push({ from, error: (e as Error).message });
        continue;
      }
      const at = this.now();
      this.sql.exec(
        `INSERT INTO txn (id, agent, model, intent, criteria, state, attempt, snapshot, snapshot_seq, fork, created_at, updated_at, detail)
         VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?, ?)`,
        txn,
        r.agent,
        r.model,
        r.intent,
        r.criteria,
        f.snapshot,
        f.snapshotSeq,
        fork,
        at,
        at,
        JSON.stringify({ requeuedFrom: from, recall: id }),
      );
      const nr = this.row(txn);
      this.op("txn.open", nr, { attempt: 1, intent: nr.intent, model: nr.model, snapshot: f.snapshot, snapshotSeq: f.snapshotSeq, criteria: JSON.parse(nr.criteria), fork, requeuedFrom: from, recall: id });
      requeued.push({ from, txn, remote: f.remote, token: f.token, trunk: f.trunk, snapshot: f.snapshot });
    }
    this.op("recall.done", null, {
      recall: id,
      outcome: "pass",
      recalled: plan.targets,
      cascade,
      forced,
      requeued: requeued.map((q) => ({ from: q.from, txn: q.txn })),
      requeueErrors,
      head: result.head,
    });
    return { dryRun: false, recall: id, plan: summary, outcome: "pass", head: result.head, cascade, requeued, failures: [] };
  }

  // ---------------------------------------------------------------- op stream

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });
    const after = Number(new URL(request.url).searchParams.get("after") ?? 0) || 0;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    for (let cursor = after; ; ) {
      const rows = this.sql
        .exec<{ seq: number; at: number; kind: OpKind; txn: string | null; agent: string | null; data: string }>(
          "SELECT * FROM op WHERE seq > ? ORDER BY seq LIMIT 500",
          cursor,
        )
        .toArray();
      if (rows.length === 0) break;
      server.send(JSON.stringify({ ops: rows.map((o) => ({ ...o, data: JSON.parse(o.data) })) }));
      cursor = rows.at(-1)!.seq;
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "closing");
    } catch {
      // already closed
    }
  }

  // ---------------------------------------------------------------- txn → repo index (lives in the "__index" instance)

  async indexPut(txn: string, repo: string): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO txn_index (txn, repo) VALUES (?, ?)", txn, repo);
  }

  async indexGet(txn: string): Promise<string | null> {
    return this.sql.exec<{ repo: string }>("SELECT repo FROM txn_index WHERE txn = ?", txn).toArray()[0]?.repo ?? null;
  }
}
