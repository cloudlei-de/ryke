// The Land Workflow, one instance per train (PLAN.md §5.3):
// prepare → verify → judge → (bisect) → push → commit.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Policy, TestSummary } from "../shared/types";
import { evidenceGate, type GateInput, type GateResult } from "./judge";
import type { TrainParams, TrainTxn } from "./ledger/ledger";
import { bisectNext, bisectRecord, bisectStart } from "./ledger/trains";
import { runnerFor, runToCompletion } from "./runner/runner";
import { authRemote, ledger } from "./service";
import { storeFor } from "./store/store";

export type Applied = { txn: string; commit: string; paths: string[]; diffstat: string; tamper: boolean; newTests: string[] };
export type Prepared = { candidate: string; applied: Applied[]; conflicts: { txn: string; paths: string[] }[] };
export type Verified = { pass: boolean; exitCode: number; durationMs: number; timedOut?: boolean; tests: TestSummary; screenshot?: string; log?: string };
export type Note = { sha: string; note: Record<string, unknown> };

export type LandDeps = {
  prepare(txns: TrainTxn[], ref: string): Promise<Prepared>;
  verify(candidate: string): Promise<Verified>;
  push(candidate: string, notes: Note[], cleanup: string[]): Promise<{ pushed: boolean }>;
  gate(input: GateInput): Promise<GateResult>;
};

// The subset of WorkflowStep landTrain uses; tests pass a step that just runs the callback.
export type StepLike = { do<T>(name: string, fn: () => Promise<T>): Promise<T> };

const JOB_MS = 10 * 60_000;

function jobResult<T>(job: { state: string; exitCode?: number; result?: unknown }, what: string): T {
  const r = job.result as ({ ok?: boolean; error?: string } & T) | undefined;
  if (!r || r.ok === false) throw new Error(`${what} job failed (exit ${job.exitCode}): ${r?.error ?? "no result"}`);
  return r;
}

export function realDeps(env: Env, p: TrainParams, policy: Policy): LandDeps {
  const store = storeFor(env);
  const runner = runnerFor(env);
  const trunk = async () => authRemote(env, (await store.info(p.repo)).remote, await store.token(p.repo, "write", 3600));
  return {
    async prepare(txns, ref) {
      const forks = await Promise.all(
        txns.map(async (t) => ({ ...t, fork: authRemote(env, (await store.info(t.fork)).remote, await store.token(t.fork, "read", 3600)) })),
      );
      const job = await runToCompletion(
        runner,
        "land",
        { mode: "prepare", trunk: await trunk(), base: p.base, ref, union: JSON.stringify(policy.union), txns: JSON.stringify(forks) },
        {},
        JOB_MS,
      );
      return jobResult<Prepared>(job, "prepare");
    },
    async verify(candidate) {
      const args: Record<string, string> = { remote: await trunk(), ref: candidate, command: policy.verify, timeout: String(policy.verifyTimeoutSeconds) };
      if (policy.preview && env.RYKE_SCREENSHOTS === "1") Object.assign(args, { screenshot: "/", "preview-main": policy.preview.main });
      const job = await runToCompletion(runner, "verify", args, {}, (policy.verifyTimeoutSeconds + 60) * 1000);
      return jobResult<Verified>(job, "verify");
    },
    async push(candidate, notes, cleanup) {
      const job = await runToCompletion(
        runner,
        "land",
        { mode: "push", trunk: await trunk(), candidate, notes: JSON.stringify(notes), cleanup: JSON.stringify(cleanup) },
        {},
        JOB_MS,
      );
      return jobResult<{ pushed: boolean }>(job, "push");
    },
    gate: (input) => evidenceGate(env, input, policy),
  };
}

const key = (ids: string[]) => ids.join(",");

// RPC results lose their discriminated-union narrowing through the stub types, hence the casts.
function unwrap<T>(res: { ok: boolean }): T {
  const r = res as { ok: boolean; value?: T; error?: string };
  if (!r.ok) throw new Error(r.error ?? "ledger call failed");
  return r.value as T;
}

export async function landTrain(env: Env, p: TrainParams, step: StepLike, depsFor: (policy: Policy) => LandDeps): Promise<{ outcome: string }> {
  const L = ledger(env, p.repo);
  const t = p.trainId;
  const byId = new Map(p.txns.map((x) => [x.id, x]));
  const refs: string[] = [];
  let n = 0;
  const named = (name: string) => `${name}-${++n}`;
  try {
    const policy = await step.do("policy", async () => unwrap<{ policy: Policy }>(await L.summary()).policy);
    const deps = depsFor(policy);

    const build = async (ids: string[], label: string) => {
      const ref = `refs/ryke/candidates/${t}/${refs.length}`;
      refs.push(ref);
      const prepared = await step.do(named(`prepare-${label}`), () => deps.prepare(ids.map((id) => byId.get(id)!), ref));
      const verified = prepared.applied.length > 0 ? await step.do(named(`verify-${label}`), () => deps.verify(prepared.candidate)) : null;
      return { prepared, verified };
    };

    // 1. prepare + 2. verify the whole train.
    let members = p.txns.map((x) => x.id);
    let { prepared, verified } = await build(members, "train");
    if (prepared.conflicts.length > 0) {
      await step.do(named("conflicts"), async () => L.trainConflicts(t, prepared.conflicts.map((c) => ({ txn: c.txn, paths: c.paths }))));
    }
    members = prepared.applied.map((a) => a.txn);
    if (members.length === 0 || !verified) return await finish("empty");
    await step.do(named("evidence"), async () =>
      L.trainEvidence(t, members.map((txn) => ({ txn, kind: "tests", summary: summary(verified!), ref: verified!.screenshot ?? null }))),
    );

    // 4. bisect when the train fails.
    if (!verified.pass) {
      if (members.length === 1) {
        await step.do(named("fail"), async () => L.trainOutcome(t, members[0]!, "failed", "tests", { failures: verified!.tests.failures }));
        return await finish("failed");
      }
      const results = new Map<string, { prepared: Prepared; verified: Verified }>();
      const failing: { ids: string[]; verified: Verified }[] = [{ ids: members, verified }];
      let state = bisectStart(members);
      for (let next = bisectNext(state); next.kind === "probe"; next = bisectNext(state)) {
        const probe = await build(next.txns, "probe");
        const pass = probe.prepared.conflicts.length === 0 && probe.verified?.pass === true;
        if (probe.verified) {
          results.set(key(next.txns), { prepared: probe.prepared, verified: probe.verified });
          if (!pass) failing.push({ ids: next.txns, verified: probe.verified });
        }
        const probeTxns = next.txns;
        await step.do(named("probe-op"), async () => L.trainProbe(t, probeTxns, pass));
        state = bisectRecord(state, pass);
      }
      const done = bisectNext(state);
      if (done.kind !== "done") throw new Error("bisection did not finish");
      for (const c of done.culprits) {
        const evidence = [...failing].reverse().find((f) => f.ids.includes(c))!.verified;
        await step.do(named("culprit"), async () => L.trainOutcome(t, c, "failed", "tests", { failures: evidence.tests.failures, bisected: true }));
      }
      for (const u of done.unresolved) await step.do(named("unresolved"), async () => L.trainOutcome(t, u, "ready", null, { unresolved: true }));
      members = done.good;
      if (members.length === 0) return await finish("failed");
      const good = results.get(key(members));
      if (!good) throw new Error(`no verified candidate for ${key(members)}`);
      prepared = good.prepared;
      verified = good.verified;
    }

    // 3. judge every member that is about to land.
    for (let round = 0; round < 3; round++) {
      const removed: string[] = [];
      for (const id of members) {
        const applied = prepared.applied.find((a) => a.txn === id)!;
        const txn = byId.get(id)!;
        const v = verified!;
        const gate = await step.do(named(`judge-${id}`), async () => {
          const detail = await L.detail(id);
          const screenshot = detail.ok ? detail.value.evidence.find((e) => e.kind === "screenshot" && e.ref === "agent")?.summary : undefined;
          return deps.gate({
            intent: txn.intent,
            criteria: txn.criteria,
            writes: applied.paths,
            verify: { exitCode: v.exitCode, pass: v.pass, tests: v.tests },
            tamper: applied.tamper,
            newTests: applied.newTests,
            diffstat: applied.diffstat,
            screenshot,
            approved: txn.approved,
          });
        });
        await step.do(named(`verdicts-${id}`), async () => L.trainVerdicts(t, id, gate.verdicts));
        if (gate.decision !== "land") {
          removed.push(id);
          const decision = gate.decision;
          await step.do(named(`gate-${id}`), async () => L.trainOutcome(t, id, decision, gate.reason, { failures: decision === "failed" ? v.tests.failures : null }));
        }
      }
      if (removed.length === 0) break;
      members = members.filter((m) => !removed.includes(m));
      if (members.length === 0) return await finish("judged");
      // Drop the removed commits by rebuilding the candidate without them, and verify it again.
      ({ prepared, verified } = await build(members, "rebuild"));
      if (!verified || !verified.pass || prepared.conflicts.length > 0 || prepared.applied.length !== members.length) {
        for (const id of members) await step.do(named("requeue"), async () => L.trainOutcome(t, id, "ready", null, { rebuildFailed: true }));
        return await finish("rebuild_failed");
      }
    }

    // 5. push (compare-and-swap) + 6. commit.
    const landing = prepared;
    const notes = await step.do(named("notes"), async () => {
      const out: Note[] = [];
      for (const a of landing.applied) {
        const d = await L.detail(a.txn);
        if (!d.ok) continue;
        const attempt = d.value.attempts.at(-1);
        out.push({ sha: a.commit, note: { txn: a.txn, reads: attempt?.reads ?? [], writes: a.paths, verdicts: d.value.verdicts, evidence: d.value.evidence } });
      }
      return out;
    });
    const pushed = await step.do(named("push"), () => deps.push(landing.candidate, notes, refs));
    if (!pushed.pushed) {
      for (const id of members) await step.do(named("cas"), async () => L.trainOutcome(t, id, "ready", null, { cas: true }));
      return await finish("cas_rejected");
    }
    await step.do(named("commit"), async () =>
      unwrap<{ seq: number }>(await L.commitTrain(t, landing.candidate, landing.applied.map((a) => ({ txn: a.txn, sha: a.commit, paths: a.paths })))),
    );
    return await finish("landed");
  } catch (e) {
    return await finish("error", (e as Error).message);
  }

  async function finish(outcome: string, error?: string) {
    await step.do(named(`done-${outcome}`), async () => L.trainDone(t, outcome, error ? { error } : {}));
    return { outcome };
  }
}

function summary(v: Verified): string {
  return `${v.tests.passed} passed, ${v.tests.failed} failed in ${v.durationMs} ms${v.timedOut ? " (timed out)" : ""}`;
}

export class Land extends WorkflowEntrypoint<Env, TrainParams> {
  async run(event: WorkflowEvent<TrainParams>, step: WorkflowStep) {
    const p = event.payload;
    // Step results are plain JSON; the cast only bridges WorkflowStep's Serializable<T> typing.
    const steps: StepLike = {
      do: (name, fn) => step.do(name, { retries: { limit: 2, delay: "1 second", backoff: "constant" }, timeout: "15 minutes" }, fn as never) as never,
    };
    return landTrain(this.env, p, steps, (policy) => realDeps(this.env, p, policy));
  }
}
