// The Land Workflow's logic (PLAN.md §5.3) with fake runner jobs and a real Ledger: the land path,
// text conflicts, bisection with one and two culprits, compare-and-swap rejection, needs_human removal.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { GateInput, GateResult } from "../src/worker/judge";
import { landTrain, realDeps, type LandDeps, type Prepared, type StepLike, type Verified } from "../src/worker/land";
import { access, type Runner } from "../src/worker/runner/runner";
import { parsePolicy } from "../src/shared/policy";
import type { TrainParams, TrainTxn } from "../src/worker/ledger/ledger";
import { beginTxn, commitToFork, newRepo, ok, opsOf, type TestRepo } from "./helpers";

const sha = (s: string) => s.replace(/[^0-9a-f]/g, "").padEnd(40, "0").slice(0, 40);

type Fake = {
  conflicts?: string[];
  culprits?: string[];
  cas?: boolean;
  gate?: Record<string, GateResult["decision"]>;
  failRebuild?: boolean;
  // Forks whose fetch fails, for the first `unreachableFor` prepare calls (all of them if unset).
  unreachable?: string[];
  unreachableFor?: number;
  head?: string | null;
  calls: { prepare: string[][]; verify: string[]; push: string[]; gate: string[]; cleanup: string[][] };
  candidates?: Map<string, string[]>;
};

function fakeDeps(f: Fake): LandDeps {
  const candidates = new Map<string, string[]>();
  f.candidates = candidates;
  return {
    async trunkHead() {
      return f.head ?? null;
    },
    async cleanup(refs: string[]) {
      f.calls.cleanup.push(refs);
    },
    async prepare(txns: TrainTxn[], ref: string): Promise<Prepared> {
      f.calls.prepare.push(txns.map((t) => t.id));
      const down = (id: string) => f.unreachable?.includes(id) && f.calls.prepare.length <= (f.unreachableFor ?? Infinity);
      const applied = txns.filter((t) => !f.conflicts?.includes(t.id) && !down(t.id));
      const candidate = sha(`c${f.calls.prepare.length}${ref.length}`);
      candidates.set(candidate, applied.map((t) => t.id));
      return {
        candidate,
        applied: applied.map((t, i) => ({ txn: t.id, commit: sha(`a${f.calls.prepare.length}b${i}`), paths: [`src/${t.id}.ts`], diffstat: "1 file changed", tamper: false, newTests: [] })),
        conflicts: [
          ...txns.filter((t) => f.conflicts?.includes(t.id)).map((t) => ({ txn: t.id, paths: ["src/registry.ts"] })),
          ...txns.filter((t) => f.unreachable?.includes(t.id) && f.calls.prepare.length <= (f.unreachableFor ?? Infinity)).map((t) => ({ txn: t.id, paths: [], error: "fetch failed: unable to access" })),
        ],
      };
    },
    async verify(candidate: string): Promise<Verified> {
      f.calls.verify.push(candidate);
      const bad = (candidates.get(candidate) ?? []).filter((id) => f.culprits?.includes(id));
      if (f.failRebuild && f.calls.verify.length > 1) bad.push("rebuild");
      return {
        pass: bad.length === 0,
        exitCode: bad.length ? 1 : 0,
        durationMs: 5,
        tests: { passed: 10, failed: bad.length, failures: bad.map((id) => ({ name: `breaks ${id}`, message: "assertion failed" })) },
      };
    },
    async push(candidate: string) {
      f.calls.push.push(candidate);
      return { pushed: !f.cas };
    },
    async gate(input: GateInput): Promise<GateResult> {
      f.calls.gate.push(input.intent);
      const decision = f.gate?.[input.intent] ?? "land";
      return { decision, reason: decision === "land" ? null : `fake_${decision}`, verdicts: [{ question: "criterion_1", value: decision === "land" ? 0.9 : 0.5, confidence: null, detail: "fake" }] };
    },
  };
}

const steps: StepLike & { names: string[] } = {
  names: [],
  async do(name, fn) {
    this.names.push(name);
    return fn();
  },
};

async function train(n: number): Promise<{ t: TestRepo; ids: string[]; params: TrainParams }> {
  const t = await newRepo();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = await beginTxn(t, `agent-${i}`, `intent ${i}`);
    ok(await t.L.reads(b.txn, [`src/read${i}.ts`]));
    const head = await commitToFork(b, { [`src/w${i}.ts`]: `${i}\n` });
    expect(ok(await t.L.submit(b.txn, { head })).state).toBe("ready");
    ids.push(b.txn);
  }
  const formed = ok(await t.L.formTrain());
  return { t, ids, params: formed.params! };
}

const fake = (over: Partial<Fake> = {}): Fake => ({ calls: { prepare: [], verify: [], push: [], gate: [], cleanup: [] }, ...over });
const pushedMembers = (f: Fake) => f.candidates!.get(f.calls.push[0]!);
const states = async (t: TestRepo, ids: string[]) => Promise.all(ids.map(async (id) => ok(await t.L.status(id)).txn.state));

describe("landTrain", () => {
  it("lands a clean train: one verify, one push, one trunk row per transaction", async () => {
    const { t, ids, params } = await train(3);
    const f = fake();
    expect(await landTrain(env, params, steps, () => fakeDeps(f))).toEqual({ outcome: "landed" });
    expect(await states(t, ids)).toEqual(["landed", "landed", "landed"]);
    expect(f.calls.verify).toHaveLength(1);
    expect(f.calls.push).toHaveLength(1);
    expect(f.calls.gate).toEqual(["intent 0", "intent 1", "intent 2"]);
    const s = ok(await t.L.summary());
    expect(s).toMatchObject({ seq: 3, train: null });
    expect((await opsOf(t, "train.done")).at(-1)!.data).toMatchObject({ train: params.trainId, outcome: "landed" });
    const d = ok(await t.L.detail(ids[0]!));
    expect(d.evidence).toEqual([{ attempt: 1, kind: "tests", summary: "10 passed, 0 failed in 5 ms", ref: null }]);
    expect(d.verdicts).toEqual([{ attempt: 1, question: "criterion_1", value: 0.9, confidence: null, detail: "fake" }]);
  });

  // Workflows retries a failed step; this one tries up to three times like the Land step config.
  const retrying: StepLike = {
    async do(_name, fn) {
      for (let i = 1; ; i++) {
        try {
          return await fn();
        } catch (e) {
          if (i === 3) throw e;
        }
      }
    },
  };

  it("retries prepare when a fork could not be fetched, and lands everyone once it can", async () => {
    const { t, ids, params } = await train(3);
    const f = fake({ unreachable: [ids[1]!], unreachableFor: 1 });
    expect(await landTrain(env, params, retrying, () => fakeDeps(f))).toEqual({ outcome: "landed" });
    expect(await states(t, ids)).toEqual(["landed", "landed", "landed"]);
    expect(f.calls.prepare).toHaveLength(2);
    expect(await opsOf(t, "txn.stale")).toEqual([]);
  });

  it("does not call a fork it cannot fetch a text conflict: the train errors and nobody goes stale", async () => {
    const { t, ids, params } = await train(3);
    const f = fake({ unreachable: [ids[1]!] });
    const res = await landTrain(env, params, retrying, () => fakeDeps(f));
    expect(res.outcome).toBe("error");
    expect(await states(t, ids)).toEqual(["ready", "ready", "ready"]);
    expect(await opsOf(t, "txn.stale")).toEqual([]);
    expect(f.calls.verify).toEqual([]);
  });

  it("sends a text conflict back as stale and lands the rest", async () => {
    const { t, ids, params } = await train(3);
    const f = fake({ conflicts: [ids[1]!] });
    expect((await landTrain(env, params, steps, () => fakeDeps(f))).outcome).toBe("landed");
    expect(await states(t, ids)).toEqual(["landed", "stale", "landed"]);
    expect(ok(await t.L.status(ids[1]!)).txn.reason).toBe("text_conflict");
    expect(ok(await t.L.summary()).heat[0]).toMatchObject({ path: "src/registry.ts" });
  });

  it("bisects one culprit out of four and lands the other three", async () => {
    const { t, ids, params } = await train(4);
    const f = fake({ culprits: [ids[2]!] });
    expect((await landTrain(env, params, steps, () => fakeDeps(f))).outcome).toBe("landed");
    expect(await states(t, ids)).toEqual(["landed", "landed", "failed", "landed"]);
    const d = ok(await t.L.detail(ids[2]!));
    expect(d.detail.failures).toEqual([{ name: `breaks ${ids[2]}`, message: "assertion failed" }]);
    expect(f.calls.verify.length).toBeLessThanOrEqual(1 + 4);
    expect((await opsOf(t, "train.bisect")).length).toBe(f.calls.verify.length - 1);
    expect(ok(await t.L.summary()).seq).toBe(3);
  });

  it("bisects two culprits", async () => {
    const { t, ids, params } = await train(4);
    const f = fake({ culprits: [ids[0]!, ids[3]!] });
    expect((await landTrain(env, params, steps, () => fakeDeps(f))).outcome).toBe("landed");
    expect(await states(t, ids)).toEqual(["failed", "landed", "landed", "failed"]);
    expect(pushedMembers(f)).toEqual([ids[1], ids[2]]);
    expect(ok(await t.L.summary()).seq).toBe(2);
  });

  it("fails a single-member train without bisecting", async () => {
    const { t, ids, params } = await train(1);
    const f = fake({ culprits: [ids[0]!] });
    expect((await landTrain(env, params, steps, () => fakeDeps(f))).outcome).toBe("failed");
    expect(await states(t, ids)).toEqual(["failed"]);
    expect(f.calls.verify).toHaveLength(1);
    expect(f.calls.push).toHaveLength(0);
  });

  it("requeues the whole train when the trunk moved under the push (compare-and-swap)", async () => {
    const { t, ids, params } = await train(2);
    const f = fake({ cas: true });
    expect((await landTrain(env, params, steps, () => fakeDeps(f))).outcome).toBe("cas_rejected");
    expect(await states(t, ids)).toEqual(["ready", "ready"]);
    expect(ok(await t.L.summary())).toMatchObject({ seq: 0, train: null });
    expect(ok(await t.L.formTrain()).train).toMatch(/^tr_/);
  });

  it("removes needs_human and failed-by-judge members, rebuilds and verifies the rest", async () => {
    const { t, ids, params } = await train(3);
    const f = fake({ gate: { "intent 0": "needs_human", "intent 2": "failed" } });
    expect((await landTrain(env, params, steps, () => fakeDeps(f))).outcome).toBe("landed");
    expect(await states(t, ids)).toEqual(["needs_human", "landed", "failed"]);
    expect(f.calls.prepare).toEqual([ids, [ids[1]]]);
    expect(f.calls.verify).toHaveLength(2);
    expect(pushedMembers(f)).toEqual([ids[1]]);
    expect(ok(await t.L.summary()).seq).toBe(1);
    expect(f.calls.gate).toHaveLength(3);
    expect(ok(await t.L.status(ids[0]!)).txn.reason).toBe("fake_needs_human");
  });

  it("requeues everything when a job throws, so the next train can retry", async () => {
    const { t, ids, params } = await train(2);
    const deps = fakeDeps(fake());
    deps.verify = async () => {
      throw new Error("runner down");
    };
    expect((await landTrain(env, params, steps, () => deps)).outcome).toBe("error");
    expect(await states(t, ids)).toEqual(["ready", "ready"]);
    expect((await opsOf(t, "train.done")).at(-1)!.data).toMatchObject({ outcome: "error", error: "runner down" });
  });

  it("requeues the rest when the rebuilt candidate fails, and cleans up the scratch refs", async () => {
    const { t, ids, params } = await train(3);
    const f = fake({ gate: { "intent 0": "needs_human" }, failRebuild: true });
    expect((await landTrain(env, params, steps, () => fakeDeps(f))).outcome).toBe("rebuild_failed");
    expect(await states(t, ids)).toEqual(["needs_human", "ready", "ready"]);
    expect(f.calls.push).toEqual([]);
    expect(f.calls.cleanup).toEqual([[`refs/ryke/candidates/${params.trainId}/0`, `refs/ryke/candidates/${params.trainId}/1`]]);
  });

  it("lands an approved member without asking the judge again", async () => {
    const { t, ids, params } = await train(1);
    params.txns[0]!.approved = true;
    const f = fake();
    const deps = fakeDeps(f);
    const real = await import("../src/worker/judge");
    const policy = ok(await t.L.summary()).policy;
    deps.gate = (input) => real.evidenceGate({ ...env, RYKE_JEV: "recorded" }, input, policy);
    expect((await landTrain(env, params, steps, () => deps)).outcome).toBe("landed");
    expect(ok(await t.L.status(ids[0]!)).txn.state).toBe("landed");
  });

  it("records a landing whose push succeeded even when the next step failed", async () => {
    const { t, ids, params } = await train(2);
    const f = fake();
    const deps = fakeDeps(f);
    const push = deps.push;
    deps.push = async (candidate, notes, cleanup) => {
      await push(candidate, notes, cleanup);
      f.head = candidate;
      throw new Error("runner went away after the push");
    };
    expect((await landTrain(env, params, steps, () => deps)).outcome).toBe("landed");
    expect(await states(t, ids)).toEqual(["landed", "landed"]);
    expect(ok(await t.L.summary()).seq).toBe(2);
  });

  it("does not record a landing when the trunk does not have the candidate", async () => {
    const { t, ids, params } = await train(1);
    const f = fake({ head: "f".repeat(40) });
    const deps = fakeDeps(f);
    deps.push = async () => {
      throw new Error("push failed");
    };
    expect((await landTrain(env, params, steps, () => deps)).outcome).toBe("error");
    expect(await states(t, ids)).toEqual(["ready"]);
  });

  it("names steps deterministically, so a Workflow replay returns cached results", async () => {
    const { t, params } = await train(3);
    const cache = new Map<string, unknown>();
    const names: string[][] = [[], []];
    const memo = (run: number): StepLike => ({
      async do(name, fn) {
        names[run]!.push(name);
        if (cache.has(name)) return cache.get(name) as never;
        const v = await fn();
        cache.set(name, v);
        return v;
      },
    });
    const f = fake({ culprits: [params.txns[1]!.id] });
    expect((await landTrain(env, params, memo(0), () => fakeDeps(f))).outcome).toBe("landed");
    const verifies = f.calls.verify.length;
    expect((await landTrain(env, params, memo(1), () => fakeDeps(f))).outcome).toBe("landed");
    expect(names[1]).toEqual(names[0]);
    expect(f.calls.verify.length).toBe(verifies);
    expect(ok(await t.L.summary()).seq).toBe(2);
  });

  it("fails a member whose trains keep erroring instead of requeueing it forever", async () => {
    const t = await newRepo();
    const b = await beginTxn(t, "agent-x", "keeps breaking the runner");
    ok(await t.L.reads(b.txn, ["src/a.ts"]));
    ok(await t.L.submit(b.txn, { head: await commitToFork(b, { "src/x.ts": "x\n" }) }));
    for (let i = 0; i < 3; i++) {
      const formed = ok(await t.L.formTrain());
      const deps = fakeDeps(fake());
      deps.verify = async () => {
        throw new Error("runner down");
      };
      await landTrain(env, formed.params!, steps, () => deps);
    }
    expect(ok(await t.L.status(b.txn)).txn).toMatchObject({ state: "failed", reason: "land_error" });
  });

  it("revalidates ready transactions after a landing (the stale path)", async () => {
    const t = await newRepo();
    const a = await beginTxn(t, "agent-a", "change a");
    ok(await t.L.reads(a.txn, ["src/a.ts"]));
    ok(await t.L.submit(a.txn, { head: await commitToFork(a, { "src/a.ts": "a2\n" }) }));
    const formed = ok(await t.L.formTrain());
    const b = await beginTxn(t, "agent-b", "read a");
    ok(await t.L.reads(b.txn, ["src/a.ts"]));
    ok(await t.L.submit(b.txn, { head: await commitToFork(b, { "src/bb.ts": "b\n" }) }));
    const deps = fakeDeps(fake());
    deps.prepare = async (txns) => ({
      candidate: sha("cafe"),
      applied: txns.map((x) => ({ txn: x.id, commit: sha("beef"), paths: ["src/a.ts"], diffstat: "", tamper: false, newTests: [] })),
      conflicts: [],
    });
    expect((await landTrain(env, formed.params!, steps, () => deps)).outcome).toBe("landed");
    await runDurableObjectAlarm(t.L);
    expect(ok(await t.L.status(b.txn)).txn).toMatchObject({ state: "stale", reason: "stale_read" });
  });
});

// In container mode the gateway attaches Artifacts credentials per job from RYKE_ALLOW_REPOS, so what
// each step passes there is all it can reach: only the lander's own steps write, verify only reads.
describe("realDeps: what each land step may touch", () => {
  function recordingRunner(result: (kind: string, args: Record<string, string>) => unknown) {
    const started: { kind: string; args: Record<string, string>; env: Record<string, string> }[] = [];
    const runner: Runner = {
      async start(kind, args, jobEnv) {
        started.push({ kind, args, env: jobEnv });
        return `j_${started.length}`;
      },
      async status(id) {
        const s = started[Number(id.slice(2)) - 1]!;
        return { id, kind: s.kind, state: "done", exitCode: 0, result: result(s.kind, s.args) } as never;
      },
      async log() {
        return { text: "", next: 0 };
      },
      async cancel() {},
    };
    return { runner, started };
  }

  it.each([
    ["seed, push, cleanup and revert", access.write("convert"), "convert:write"],
    ["prepare", access.prepare("convert", ["convert--t_a", "convert--t_b"]), "convert:write,convert--t_a:read,convert--t_b:read"],
    ["verify", access.verify("convert"), "convert:read"],
  ])("%s: %s", (_label, env, expected) => {
    expect(env).toEqual({ RYKE_ALLOW_REPOS: expected });
  });

  it("gives prepare its forks to read, verify the trunk to read, and only push and cleanup the trunk to write", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const head = await commitToFork(b, { "src/n.ts": "n\n" });
    const member: TrainTxn = { id: b.txn, fork: `${t.name}--${b.txn}`, head, attempt: 1, snapshot: b.snapshot, agent: "a", model: null, intent: "x", criteria: [], approved: false };
    const params: TrainParams = { repo: t.name, trainId: "tr_test", base: b.snapshot, baseSeq: 0, txns: [member] };
    const { runner, started } = recordingRunner((kind, args) =>
      kind === "verify" ? { ok: true, pass: true, tests: { passed: 1, failed: 0, failures: [] } } : args.mode === "push" ? { ok: true, pushed: true } : { ok: true, candidate: head, applied: [b.txn], conflicts: [] },
    );
    const deps = realDeps(env, params, parsePolicy(null), runner);
    await deps.prepare([member], "refs/ryke/candidates/tr_test");
    await deps.verify(head);
    await deps.push(head, [], []);
    await deps.cleanup(["refs/ryke/candidates/tr_test"]);
    expect(started.map((s) => [s.kind, s.args.mode ?? null, s.env.RYKE_ALLOW_REPOS])).toEqual([
      ["land", "prepare", `${t.name}:write,${member.fork}:read`],
      ["verify", null, `${t.name}:read`],
      ["land", "push", `${t.name}:write`],
      ["land", "cleanup", `${t.name}:write`],
    ]);
  });
});
