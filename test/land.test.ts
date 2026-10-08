// The Land Workflow's logic (PLAN.md §5.3) with fake runner jobs and a real Ledger: the land path,
// text conflicts, bisection with one and two culprits, compare-and-swap rejection, needs_human removal.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { GateInput, GateResult } from "../src/worker/judge";
import { landTrain, type LandDeps, type Prepared, type StepLike, type Verified } from "../src/worker/land";
import type { TrainParams, TrainTxn } from "../src/worker/ledger/ledger";
import { beginTxn, commitToFork, newRepo, ok, opsOf, type TestRepo } from "./helpers";

const sha = (s: string) => s.replace(/[^0-9a-f]/g, "").padEnd(40, "0").slice(0, 40);

type Fake = {
  conflicts?: string[];
  culprits?: string[];
  cas?: boolean;
  gate?: Record<string, GateResult["decision"]>;
  calls: { prepare: string[][]; verify: string[]; push: string[]; gate: string[] };
};

function fakeDeps(f: Fake): LandDeps {
  const candidates = new Map<string, string[]>();
  return {
    async prepare(txns: TrainTxn[], ref: string): Promise<Prepared> {
      f.calls.prepare.push(txns.map((t) => t.id));
      const applied = txns.filter((t) => !f.conflicts?.includes(t.id));
      const candidate = sha(`c${f.calls.prepare.length}${ref.length}`);
      candidates.set(candidate, applied.map((t) => t.id));
      return {
        candidate,
        applied: applied.map((t, i) => ({ txn: t.id, commit: sha(`a${f.calls.prepare.length}b${i}`), paths: [`src/${t.id}.ts`], diffstat: "1 file changed", tamper: false, newTests: [] })),
        conflicts: txns.filter((t) => f.conflicts?.includes(t.id)).map((t) => ({ txn: t.id, paths: ["src/registry.ts"] })),
      };
    },
    async verify(candidate: string): Promise<Verified> {
      f.calls.verify.push(candidate);
      const bad = (candidates.get(candidate) ?? []).filter((id) => f.culprits?.includes(id));
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

const fake = (over: Partial<Fake> = {}): Fake => ({ calls: { prepare: [], verify: [], push: [], gate: [] }, ...over });
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
