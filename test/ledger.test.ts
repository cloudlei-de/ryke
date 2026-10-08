// The Ledger state machine (PLAN.md §4.2) against a real local store: every legal transition, every
// illegal one answered with 409, idempotent push ingest and submit, stale warnings, leases, trains.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { beginTxn, commitToFork, err, errorText, gitHelper, landAlone, newRepo, ok, opsOf, opsPage, store, type TestRepo } from "./helpers";

// A second commit on top of `base` in the transaction's fork, as an agent pushing twice would.
async function gitHelperCommitOn(b: { remote: string; token: string }, base: string, files: Record<string, string | null>) {
  return (await gitHelper<{ sha: string }>("/commit", { remote: b.remote, token: b.token, base, files })).sha;
}

async function readyTxn(t: TestRepo, files: Record<string, string | null>, reads: string[] = [], agent = "agent-01") {
  const b = await beginTxn(t, agent);
  if (reads.length) ok(await t.L.reads(b.txn, reads));
  const sha = await commitToFork(b, files);
  const s = ok(await t.L.submit(b.txn, { head: sha }));
  return { b, sha, s };
}

describe("begin", () => {
  it("opens a transaction on a fresh fork at the trunk head", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    expect(b.txn).toMatch(/^t_[0-9a-z]+$/);
    expect(b.state).toBe("open");
    expect(b.attempt).toBe(1);
    expect(b.snapshot).toBe(t.head);
    expect(b.remote).toMatch(new RegExp(`/${t.name}--${b.txn}\\.git$`));
    expect(b.token).toMatch(/^art_v1_/);
    expect(b.trunk.remote).toMatch(new RegExp(`/${t.name}\\.git$`));
    expect(b.policy.protected).toContain("test/**");
    expect((await store.info(`${t.name}--${b.txn}`)).head).toBe(t.head);
    const [open] = await opsOf(t, "txn.open");
    expect(open).toMatchObject({ txn: b.txn, agent: "agent-01", data: { attempt: 1, snapshot: t.head, snapshotSeq: 0 } });
  });

  it.each([
    [{ intent: "x" }, "agent"],
    [{ agent: "a" }, "intent"],
    [{ agent: " ", intent: "x" }, "agent"],
    [{ agent: "a", intent: "x", criteria: "nope" }, "criteria"],
    [{ agent: "a", intent: "x", model: 3 }, "model"],
  ])("rejects invalid input %j with 422", async (input, word) => {
    const t = await newRepo();
    const res = await t.L.begin(input as never);
    expect(err(res)).toBe(422);
    expect(errorText(res)).toContain(word);
  });

  it("answers 404 for a repo that was never initialised", async () => {
    const { ledger } = await import("../src/worker/service");
    const { env } = await import("cloudflare:workers");
    expect(err(await ledger(env, "never-made").begin({ agent: "a", intent: "x" }))).toBe(404);
  });

  it("rejects a duplicate at begin without forking", async () => {
    const t = await newRepo();
    const res = ok(await t.L.begin({ agent: "a", intent: "same" }, { reject: { other: "t_other", value: 0.9 }, warnings: [] }));
    expect(res.state).toBe("rejected");
    expect(res.reason).toBe("duplicate_of:t_other");
    expect(err(await store.info(`${t.name}--${res.txn}`).then(() => ({ ok: true }), () => ({ ok: false, status: 404 })))).toBe(404);
    expect((await opsOf(t, "txn.rejected"))[0]).toMatchObject({ txn: res.txn, data: { reason: "duplicate_of:t_other" } });
  });
});

describe("submit and validate", () => {
  it("moves open → submitted → ready for a clean change", async () => {
    const t = await newRepo();
    const { b, sha, s } = await readyTxn(t, { "src/new.ts": "export const n = 1;\n" }, ["src/a.ts"]);
    expect(s.state).toBe("ready");
    const d = ok(await t.L.detail(b.txn));
    expect(d.txn.head).toBe(sha);
    expect(d.attempts[0]).toEqual({ attempt: 1, reads: ["src/a.ts"], writes: ["src/new.ts"] });
    expect((await opsOf(t)).filter((o) => o.txn === b.txn).map((o) => o.kind)).toEqual(["txn.open", "txn.submitted", "txn.ready"]);
  });

  it("finds the head through the store when neither the body nor a push event gave one", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    expect(ok(await t.L.submit(b.txn)).state).toBe("ready");
    expect(ok(await t.L.detail(b.txn)).txn.head).toBe(sha);
  });

  it("uses the head recorded by a push event, idempotently", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    const fork = `${t.name}--${b.txn}`;
    expect(ok(await t.L.onPush(fork, "refs/heads/main", sha)).txn).toBe(b.txn);
    expect(ok(await t.L.onPush(fork, "refs/heads/main", sha)).txn).toBe(b.txn);
    expect(ok(await t.L.onPush(fork, "refs/heads/other", "f".repeat(40))).txn).toBeNull();
    expect(ok(await t.L.onPush(fork, "refs/heads/main", "0".repeat(40))).txn).toBeNull();
    expect(ok(await t.L.onPush(t.name, "refs/heads/main", sha)).txn).toBeNull();
    expect(ok(await t.L.onPush(`${t.name}--t_unknown`, "refs/heads/main", sha)).txn).toBeNull();
    expect(ok(await t.L.detail(b.txn)).txn.head).toBe(sha);
    expect(ok(await t.L.submit(b.txn)).state).toBe("ready");
    expect(ok(await t.L.onPush(fork, "refs/heads/main", "a".repeat(40))).txn).toBeNull();
  });

  it("is idempotent: a repeated submit answers the current state without new ops", async () => {
    const t = await newRepo();
    const { b, sha } = await readyTxn(t, { "src/x.ts": "x\n" }, ["src/a.ts"]);
    const before = (await opsOf(t)).length;
    expect(ok(await t.L.submit(b.txn, { head: sha })).state).toBe("ready");
    expect(ok(await t.L.submit(b.txn)).state).toBe("ready");
    expect((await opsOf(t)).length).toBe(before);
    expect(err(await t.L.submit(b.txn, { head: "b".repeat(40) }))).toBe(409);
  });

  it("rejects an empty change (V8)", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const s = ok(await t.L.submit(b.txn));
    expect(s).toEqual({ state: "rejected", reason: "empty" });
  });

  it("rejects a modified protected file (V1) but allows a new file under a protected dir", async () => {
    const t = await newRepo();
    const bad = await readyTxn(t, { "test/a.test.ts": "// tampered\n" }, ["src/a.ts"]);
    expect(bad.s).toEqual({ state: "rejected", reason: "protected", paths: ["test/a.test.ts"] });
    const del = await readyTxn(t, { "ryke.json": null }, ["src/a.ts"]);
    expect(del.s).toMatchObject({ state: "rejected", reason: "protected", paths: ["ryke.json"] });
    const fine = await readyTxn(t, { "test/new.test.ts": "// new\n" }, ["src/a.ts"]);
    expect(fine.s.state).toBe("ready");
  });

  it("aborts a stale read before merge and hands over the delta on retry (§4.3 example)", async () => {
    const t = await newRepo();
    const a = await readyTxn(t, { "src/format.ts": "export const digits = 3;\n" }, ["src/format.ts"], "agent-a");
    const bBegin = await beginTxn(t, "agent-b");
    ok(await t.L.reads(bBegin.txn, ["src/format.ts"]));
    await landAlone(t, a.b.txn, a.b, a.sha, ["src/format.ts"]);
    const bSha = await commitToFork(bBegin, { "test/rounding.test.ts": "// expects 2 digits\n" });
    const s = ok(await t.L.submit(bBegin.txn, { head: bSha }));
    expect(s.state).toBe("stale");
    expect(s.reason).toBe("stale_read");
    expect(s.paths).toEqual([{ path: "src/format.ts", seq: 1, by: a.b.txn }]);
    const d = ok(await t.L.detail(bBegin.txn));
    expect(d.delta).toEqual([{ path: "src/format.ts", patch: expect.stringContaining("-export const digits = 2;\n+export const digits = 3;") }]);
    const r = ok(await t.L.retry(bBegin.txn));
    expect(r.attempt).toBe(2);
    expect(r.snapshot).toBe(a.sha);
    expect(r.delta[0]!.patch).toContain("+export const digits = 3;");
    expect(r.trunk.token).toMatch(/^art_v1_/);
    expect(ok(await t.L.status(bBegin.txn)).txn).toMatchObject({ state: "open", attempt: 2, snapshot: a.sha, snapshotSeq: 1, head: null });
    const heat = ok(await t.L.summary()).heat;
    expect(heat[0]).toMatchObject({ path: "src/format.ts", hot: false });
  });

  it("ignores union paths when validating (V3/V4)", async () => {
    const t = await newRepo();
    const a = await readyTxn(t, { "src/registry.ts": "export { a } from './a.ts';\nexport { z } from './z.ts';\n" }, ["src/registry.ts"]);
    const bBegin = await beginTxn(t, "agent-b");
    ok(await t.L.reads(bBegin.txn, ["src/registry.ts"]));
    await landAlone(t, a.b.txn, a.b, a.sha, ["src/registry.ts"]);
    const bSha = await commitToFork(bBegin, { "src/registry.ts": "export { a } from './a.ts';\nexport { y } from './y.ts';\n" });
    expect(ok(await t.L.submit(bBegin.txn, { head: bSha })).state).toBe("ready");
  });

  it("falls back to every file next to the writes when no reads were reported", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const sha = await commitToFork(b, { "src/c/e.ts": "e\n" });
    expect(ok(await t.L.submit(b.txn, { head: sha })).state).toBe("ready");
    const d = ok(await t.L.detail(b.txn));
    expect(d.attempts[0]!.reads).toEqual(["src/c/d.ts", "src/c/e.ts"]);
    expect((await opsOf(t, "reads.fallback"))[0]).toMatchObject({ txn: b.txn, data: { count: 2 } });
  });

  it.each([
    [{ head: "nope" }, "head"],
    [{ head: 7 }, "head"],
    [{ evidence: "x" }, "evidence"],
    [{ evidence: { summary: 3 } }, "summary"],
    [{ evidence: { screenshot: false } }, "screenshot"],
  ])("rejects submit input %j with 422", async (body, word) => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const res = await t.L.submit(b.txn, body as never);
    expect(err(res)).toBe(422);
    expect(errorText(res)).toContain(word);
  });

  it("answers 422 when the head is not in the fork", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    expect(err(await t.L.submit(b.txn, { head: "c".repeat(40) }))).toBe(422);
  });

  it("stores agent evidence", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    ok(await t.L.reads(b.txn, ["src/a.ts"]));
    ok(await t.L.submit(b.txn, { head: sha, evidence: { summary: "added x", screenshot: "tiles page shows x" } }));
    const d = ok(await t.L.detail(b.txn));
    expect(d.evidence).toEqual([
      { attempt: 1, kind: "log", summary: "added x", ref: "agent" },
      { attempt: 1, kind: "screenshot", summary: "tiles page shows x", ref: "agent" },
    ]);
  });
});

describe("reads", () => {
  it("records a batch, normalises paths and reports already-stale reads", async () => {
    const t = await newRepo();
    const a = await readyTxn(t, { "src/a.ts": "export const a = 3;\n" }, ["src/a.ts"], "agent-a");
    const b = await beginTxn(t, "agent-b");
    await landAlone(t, a.b.txn, a.b, a.sha, ["src/a.ts"]);
    // b's snapshot predates a's landing, so its read of src/a.ts is stale at once.
    const r = ok(await t.L.reads(b.txn, ["./src/a.ts", "src\\format.ts", "src/a.ts"]));
    expect(r.recorded).toBe(2);
    expect(r.staleWarnings).toEqual([{ path: "src/a.ts", seq: 1, by: a.b.txn }]);
    expect(ok(await t.L.detail(b.txn)).attempts[0]!.reads).toEqual(["src/a.ts", "src/format.ts"]);
  });

  it.each([["not-a-list"], [[1]], [["../x"]], [Array.from({ length: 501 }, (_, i) => `f${i}`)]])("rejects %j with 422", async (paths) => {
    const t = await newRepo();
    const b = await beginTxn(t);
    expect(err(await t.L.reads(b.txn, paths))).toBe(422);
  });

  it("answers 404 for an unknown transaction and 409 once submitted", async () => {
    const t = await newRepo();
    expect(err(await t.L.reads("t_nope", ["a"]))).toBe(404);
    const { b } = await readyTxn(t, { "src/x.ts": "x\n" }, ["src/a.ts"]);
    expect(err(await t.L.reads(b.txn, ["src/a.ts"]))).toBe(409);
  });
});

describe("early stale warnings (§4.4)", () => {
  it("warns open transactions whose reads a landing changed, and wakes their long-poll", async () => {
    const t = await newRepo();
    const watcher = await beginTxn(t, "agent-w");
    ok(await t.L.reads(watcher.txn, ["src/a.ts", "src/registry.ts"]));
    const bystander = await beginTxn(t, "agent-x");
    ok(await t.L.reads(bystander.txn, ["src/b.ts"]));
    const waiting = t.L.wait(watcher.txn, 20_000);
    const a = await readyTxn(t, { "src/a.ts": "export const a = 9;\n", "src/registry.ts": "x\n" }, ["src/a.ts"], "agent-a");
    await landAlone(t, a.b.txn, a.b, a.sha, ["src/a.ts", "src/registry.ts"]);
    const w = ok(await waiting);
    expect(w.changed).toBe(false);
    expect(w.staleWarnings.map((s) => s.path)).toEqual(["src/a.ts"]);
    const warnings = await opsOf(t, "stale.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ txn: watcher.txn, data: { paths: ["src/a.ts"], seq: 1 } });
    expect(ok(await t.L.status(watcher.txn)).staleWarnings).toEqual([{ path: "src/a.ts", seq: 1, by: a.b.txn }]);
  });
});

describe("trains", () => {
  it("lands disjoint transactions together and leaves an overlapping one ready", async () => {
    const t = await newRepo();
    const x = await readyTxn(t, { "src/x.ts": "x\n" }, ["src/a.ts"], "agent-x");
    const y = await readyTxn(t, { "src/y.ts": "y\n" }, ["src/b.ts"], "agent-y");
    const z = await readyTxn(t, { "src/z.ts": "z\n" }, ["src/x.ts"], "agent-z");
    const train = ok(await t.L.formTrain()).train!;
    expect(train).toMatch(/^tr_/);
    const formed = (await opsOf(t, "train.formed"))[0]!;
    expect(formed.data).toMatchObject({ train, txns: [x.b.txn, y.b.txn], base: t.head, baseSeq: 0 });
    expect(ok(await t.L.status(x.b.txn)).txn).toMatchObject({ state: "verifying", train });
    expect(ok(await t.L.status(z.b.txn)).txn.state).toBe("ready");
    expect(ok(await t.L.formTrain()).train).toBeNull();
    expect(err(await t.L.abort(x.b.txn, "bored"))).toBe(409);
    ok(await t.L.commitTrain(train, y.sha, [
      { txn: x.b.txn, sha: x.sha, paths: ["src/x.ts"] },
      { txn: y.b.txn, sha: y.sha, paths: ["src/y.ts"] },
    ]));
    ok(await t.L.trainDone(train, "landed"));
    expect(ok(await t.L.status(x.b.txn)).txn).toMatchObject({ state: "landed", landedSeq: 1 });
    expect(ok(await t.L.status(y.b.txn)).txn).toMatchObject({ state: "landed", landedSeq: 2 });
    expect(ok(await t.L.summary()).seq).toBe(2);
    const adv = (await opsOf(t, "trunk.advanced")).at(-1)!;
    expect(adv.data).toMatchObject({ seq: 2, train, txns: [{ txn: x.b.txn, seq: 1 }, { txn: y.b.txn, seq: 2 }] });
    // z read src/x.ts, which x just wrote: the scheduler's revalidation makes it stale.
    await runDurableObjectAlarm(t.L);
    expect(ok(await t.L.status(z.b.txn)).txn).toMatchObject({ state: "stale", reason: "stale_read" });
    expect(ok(await t.L.commitTrain(train, y.sha, [])).seq).toBe(2);
  });

  it("lets union paths overlap inside one train", async () => {
    const t = await newRepo();
    const x = await readyTxn(t, { "src/x.ts": "x\n", "CHANGELOG.md": "# Changelog\n- x\n" }, ["src/registry.ts"], "agent-x");
    const y = await readyTxn(t, { "src/y.ts": "y\n", "CHANGELOG.md": "# Changelog\n- y\n" }, ["src/registry.ts"], "agent-y");
    ok(await t.L.formTrain());
    expect((await opsOf(t, "train.formed"))[0]!.data.txns).toEqual([x.b.txn, y.b.txn]);
  });

  it("moves text conflicts to stale with heat, failures to failed, judge escalations to needs_human", async () => {
    const t = await newRepo();
    const c = await readyTxn(t, { "src/c1.ts": "1\n" }, ["src/a.ts"], "agent-c");
    const f = await readyTxn(t, { "src/c2.ts": "2\n" }, ["src/b.ts"], "agent-f");
    const h = await readyTxn(t, { "src/c3.ts": "3\n" }, ["src/format.ts"], "agent-h");
    const r = await readyTxn(t, { "src/c4.ts": "4\n" }, ["src/registry.ts"], "agent-r");
    const train = ok(await t.L.formTrain()).train!;
    expect(ok(await t.L.trainConflicts(train, [{ txn: c.b.txn, paths: ["src/c1.ts"] }])).moved).toEqual([c.b.txn]);
    expect(ok(await t.L.status(c.b.txn)).txn).toMatchObject({ state: "stale", reason: "text_conflict", train: null });
    ok(await t.L.trainProbe(train, [f.b.txn], false));
    ok(await t.L.trainEvidence(train, [{ txn: f.b.txn, kind: "tests", summary: "1 failed", ref: null }]));
    expect(ok(await t.L.trainOutcome(train, f.b.txn, "failed", "tests", { failures: [{ name: "x", message: "boom" }] })).state).toBe("failed");
    ok(await t.L.trainVerdicts(train, h.b.txn, [{ question: "criterion_1", value: 0.5, confidence: 0.4 }]));
    expect(ok(await t.L.trainOutcome(train, h.b.txn, "needs_human", "criterion_uncertain")).state).toBe("needs_human");
    expect(ok(await t.L.trainOutcome(train, "t_not_in_train", "failed", "x")).state).toBeNull();
    ok(await t.L.trainDone(train, "failed"));
    expect(ok(await t.L.status(r.b.txn)).txn).toMatchObject({ state: "ready", train: null });
    expect(ok(await t.L.summary()).heat.map((x) => x.path)).toContain("src/c1.ts");
    expect((await opsOf(t, "train.bisect"))[0]!.data).toEqual({ train, probe: [f.b.txn], pass: false });
    expect((await opsOf(t, "judge.verdict"))[0]!.data).toMatchObject({ question: "criterion_1", value: 0.5 });
    const d = ok(await t.L.detail(f.b.txn));
    expect(d.detail.failures).toEqual([{ name: "x", message: "boom" }]);
    expect(d.evidence).toEqual([{ attempt: 1, kind: "tests", summary: "1 failed", ref: null }]);
    expect(ok(await t.L.detail(h.b.txn)).verdicts).toEqual([{ attempt: 1, question: "criterion_1", value: 0.5, confidence: 0.4, detail: null }]);
    expect((await opsOf(t, "train.done")).at(-1)!.data).toMatchObject({ train, outcome: "failed" });
  });

  it("forms no train while one is in flight and gives skipped transactions priority after 3 skips", async () => {
    const t = await newRepo();
    const blocker = await readyTxn(t, { "src/x.ts": "x\n" }, ["src/a.ts"], "agent-1");
    // starved reads what blocker writes, so the two can never share a train.
    const starved = await readyTxn(t, { "src/y.ts": "y\n" }, ["src/x.ts"], "agent-2");
    for (let i = 0; i < 3; i++) {
      const tr = ok(await t.L.formTrain()).train!;
      expect((await opsOf(t, "train.formed")).at(-1)!.data.txns).toEqual([blocker.b.txn]);
      ok(await t.L.trainOutcome(tr, blocker.b.txn, "ready", null));
      ok(await t.L.trainDone(tr, "requeued"));
    }
    ok(await t.L.formTrain());
    expect((await opsOf(t, "train.formed")).at(-1)!.data.txns).toEqual([starved.b.txn]);
  });
});

describe("human gate", () => {
  async function needsHuman() {
    const t = await newRepo();
    const h = await readyTxn(t, { "src/p.ts": "p\n" }, ["src/a.ts"]);
    const train = ok(await t.L.formTrain()).train!;
    ok(await t.L.trainOutcome(train, h.b.txn, "needs_human", "human_path"));
    ok(await t.L.trainDone(train, "landed"));
    return { t, id: h.b.txn };
  }

  it("approve sends it back through a train as approved", async () => {
    const { t, id } = await needsHuman();
    expect(ok(await t.L.approve(id)).state).toBe("ready");
    expect(ok(await t.L.detail(id)).detail.approved).toBe(true);
    expect(err(await t.L.approve(id))).toBe(409);
  });

  it("reject fails it", async () => {
    const { t, id } = await needsHuman();
    expect(ok(await t.L.reject(id)).state).toBe("failed");
    expect(ok(await t.L.status(id)).txn.reason).toBe("rejected_by_human");
    expect(err(await t.L.reject(id))).toBe(409);
  });
});

describe("retry and max attempts", () => {
  it("retries a failed transaction with its failures and aborts after the third bad attempt", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    let snapshot = b.snapshot;
    let trunk = b.trunk;
    for (let attempt = 1; attempt <= 3; attempt++) {
      ok(await t.L.reads(b.txn, ["src/a.ts"]));
      const sha = await commitToFork({ ...b, snapshot }, { [`src/try${attempt}.ts`]: `${attempt}\n` }, { force: true, from: trunk });
      expect(ok(await t.L.submit(b.txn, { head: sha })).state).toBe("ready");
      const train = ok(await t.L.formTrain()).train!;
      const out = ok(await t.L.trainOutcome(train, b.txn, "failed", "tests", { failures: [{ name: `t${attempt}`, message: "no" }] }));
      ok(await t.L.trainDone(train, "failed"));
      if (attempt < 3) {
        expect(out.state).toBe("failed");
        const r = ok(await t.L.retry(b.txn));
        expect(r).toMatchObject({ attempt: attempt + 1, delta: [], failures: [{ name: `t${attempt}`, message: "no" }] });
        snapshot = r.snapshot;
        trunk = r.trunk;
      } else {
        expect(out.state).toBe("aborted");
      }
    }
    expect(ok(await t.L.status(b.txn)).txn).toMatchObject({ state: "aborted", reason: "max_attempts", attempt: 3 });
    expect((await opsOf(t, "txn.aborted"))[0]!.data).toMatchObject({ cause: { state: "failed", reason: "tests" } });
    expect(err(await t.L.retry(b.txn))).toBe(409);
  });
});

describe("illegal transitions answer 409", () => {
  it("covers every operation in a wrong state", async () => {
    const t = await newRepo();
    const open = await beginTxn(t);
    expect(err(await t.L.retry(open.txn))).toBe(409);
    expect(err(await t.L.approve(open.txn))).toBe(409);
    expect(err(await t.L.reject(open.txn))).toBe(409);
    const { b: ready } = await readyTxn(t, { "src/r.ts": "r\n" }, ["src/a.ts"]);
    expect(err(await t.L.reads(ready.txn, ["x"]))).toBe(409);
    expect(err(await t.L.intendWrite(ready.txn, "x"))).toBe(409);
    expect(err(await t.L.retry(ready.txn))).toBe(409);
    expect(err(await t.L.approve(ready.txn))).toBe(409);
    const rejected = await beginTxn(t);
    ok(await t.L.submit(rejected.txn));
    expect(err(await t.L.abort(rejected.txn, "x"))).toBe(409);
    expect(err(await t.L.retry(rejected.txn))).toBe(409);
    expect(err(await t.L.submit(rejected.txn, { head: "d".repeat(40) }))).toBe(409);
    const aborted = await beginTxn(t);
    expect(ok(await t.L.abort(aborted.txn, "changed my mind")).state).toBe("aborted");
    expect(err(await t.L.abort(aborted.txn, "again"))).toBe(409);
    expect(err(await t.L.submit(aborted.txn))).toBe(409);
    expect(err(await t.L.abort(open.txn, 42))).toBe(422);
    for (const op of [t.L.detail("t_x"), t.L.status("t_x"), t.L.retry("t_x"), t.L.abort("t_x", "x"), t.L.approve("t_x"), t.L.submit("t_x")])
      expect(err(await op)).toBe(404);
  });

  it("aborts from ready and from stale", async () => {
    const t = await newRepo();
    const { b } = await readyTxn(t, { "src/q.ts": "q\n" }, ["src/a.ts"]);
    expect(ok(await t.L.abort(b.txn, "x")).state).toBe("aborted");
    const a = await readyTxn(t, { "src/a.ts": "a3\n" }, ["src/a.ts"], "agent-a");
    const s = await beginTxn(t, "agent-s");
    ok(await t.L.reads(s.txn, ["src/a.ts"]));
    await landAlone(t, a.b.txn, a.b, a.sha, ["src/a.ts"]);
    ok(await t.L.submit(s.txn, { head: await commitToFork(s, { "src/s.ts": "s\n" }) }));
    expect(ok(await t.L.abort(s.txn, "x")).state).toBe("aborted");
  });
});

describe("admission leases (§7.2)", () => {
  it("grants freely on cool files and serialises hot ones held by an open transaction", async () => {
    const t = await newRepo();
    const one = await beginTxn(t, "agent-1");
    const two = await beginTxn(t, "agent-2");
    expect(ok(await t.L.intendWrite(one.txn, "src/a.ts"))).toEqual({ go: true });
    expect(ok(await t.L.intendWrite(two.txn, "src/a.ts"))).toEqual({ go: true });
    ok(await t.L.abort(one.txn, "done"));
    ok(await t.L.abort(two.txn, "done"));
    // Three stale aborts a few seconds apart heat src/a.ts past 2 (two decay to just under it).
    for (const agent of ["h1", "h2", "h3"]) {
      const x = await readyTxn(t, { "src/a.ts": `${agent}\n` }, ["src/a.ts"], agent);
      const y = await beginTxn(t, `${agent}-y`);
      ok(await t.L.reads(y.txn, ["src/a.ts"]));
      await landAlone(t, x.b.txn, x.b, x.sha, ["src/a.ts"]);
      ok(await t.L.submit(y.txn, { head: await commitToFork(y, { [`src/${agent}.ts`]: "y\n" }) }));
    }
    expect(ok(await t.L.summary()).heat.find((h) => h.path === "src/a.ts")).toMatchObject({ hot: true });
    const three = await beginTxn(t, "agent-3");
    const four = await beginTxn(t, "agent-4");
    expect(ok(await t.L.intendWrite(three.txn, "src/a.ts"))).toEqual({ go: true });
    const denied = ok(await t.L.intendWrite(four.txn, "src/a.ts"));
    expect(denied).toMatchObject({ go: false, owner: three.txn });
    expect((await opsOf(t, "lease.waiting")).at(-1)).toMatchObject({ txn: four.txn, data: { path: "src/a.ts", owner: three.txn } });
    ok(await t.L.abort(three.txn, "done"));
    expect((await opsOf(t, "lease.released")).at(-1)!.data).toMatchObject({ path: "src/a.ts", txn: three.txn });
    expect(ok(await t.L.intendWrite(four.txn, "src/a.ts"))).toEqual({ go: true });
    expect(err(await t.L.intendWrite(four.txn, 5))).toBe(422);
  });
});

describe("op log and stream", () => {
  it("pages ops and streams the backlog plus live ops over a WebSocket", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const page = await opsPage(t, 0, 2);
    expect(page.ops.map((o) => o.kind)).toEqual(["trunk.advanced", "policy.updated"]);
    expect(page.last).toBe(page.ops[1]!.seq);
    expect((await opsPage(t, page.last, 10)).ops.map((o) => o.kind)).toEqual(["txn.open"]);
    const res = await t.L.fetch("http://ryke/stream?after=1", { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const frames: { ops: { kind: string; txn: string | null }[] }[] = [];
    ws.accept();
    ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data as string)));
    await new Promise((r) => setTimeout(r, 50));
    expect(frames[0]!.ops.map((o) => o.kind)).toEqual(["policy.updated", "txn.open"]);
    ok(await t.L.abort(b.txn, "x"));
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.at(-1)!.ops).toMatchObject([{ kind: "txn.aborted", txn: b.txn }]);
    ws.close();
    expect((await t.L.fetch("http://ryke/stream")).status).toBe(426);
  });

  it("times out a long-poll without a change", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const w = ok(await t.L.wait(b.txn, 100));
    expect(w).toMatchObject({ changed: false, staleWarnings: [], txn: { state: "open" } });
  });

  it("summarises counts, in-flight footprints and the trunk", async () => {
    const t = await newRepo();
    const b = await beginTxn(t, "agent-s", "add s");
    ok(await t.L.reads(b.txn, ["src/a.ts"]));
    const s = ok(await t.L.summary());
    expect(s).toMatchObject({ repo: t.name, head: t.head, seq: 0, counts: { open: 1 }, train: null });
    expect(s.inflight).toEqual([{ txn: b.txn, agent: "agent-s", intent: "add s", state: "open", footprint: ["src/a.ts"] }]);
  });

  it("refuses a second init", async () => {
    const t = await newRepo();
    expect(err(await t.L.init(t.name, t.head, null))).toBe(409);
  });
});

describe("review fixes", () => {
  it("does not carry an approval over to a later attempt", async () => {
    const t = await newRepo();
    const h = await readyTxn(t, { "src/p.ts": "p\n" }, ["src/a.ts"]);
    const train = ok(await t.L.formTrain()).train!;
    ok(await t.L.trainOutcome(train, h.b.txn, "needs_human", "human_path"));
    ok(await t.L.trainDone(train, "judged"));
    // while a human looks, trunk changes what h read
    const a = await readyTxn(t, { "src/a.ts": "a9\n" }, ["src/b.ts"], "agent-a");
    await landAlone(t, a.b.txn, a.b, a.sha, ["src/a.ts"]);
    ok(await t.L.approve(h.b.txn));
    await runDurableObjectAlarm(t.L);
    expect(ok(await t.L.status(h.b.txn)).txn.state).toBe("stale");
    // the retry is new code the human never saw
    const r = ok(await t.L.retry(h.b.txn));
    const sha = await commitToFork({ ...h.b, snapshot: r.snapshot }, { "src/p.ts": "p2\n" }, { force: true, from: r.trunk });
    ok(await t.L.reads(h.b.txn, ["src/b.ts"]));
    expect(ok(await t.L.submit(h.b.txn, { head: sha })).state).toBe("ready");
    const next = ok(await t.L.formTrain());
    expect(next.params!.txns.find((x) => x.id === h.b.txn)!.approved).toBe(false);
  });

  it("takes the head from the fork, not from a push event that may be late", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const first = await commitToFork(b, { "src/one.ts": "1\n" });
    ok(await t.L.onPush(`${t.name}--${b.txn}`, "refs/heads/main", first));
    const second = await gitHelperCommitOn(b, first, { "src/two.ts": "2\n" });
    expect(ok(await t.L.submit(b.txn)).state).toBe("ready");
    const d = ok(await t.L.detail(b.txn));
    expect(d.txn.head).toBe(second);
    expect(d.attempts[0]!.writes).toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("aborts after the third stale attempt", async () => {
    const t = await newRepo();
    const victim = await beginTxn(t, "agent-v");
    let snapshot = victim.snapshot;
    let trunk = victim.trunk;
    for (let attempt = 1; attempt <= 3; attempt++) {
      ok(await t.L.reads(victim.txn, ["src/a.ts"]));
      const mover = await readyTxn(t, { "src/a.ts": `a${attempt}0\n` }, ["src/b.ts"], `mover-${attempt}`);
      await landAlone(t, mover.b.txn, mover.b, mover.sha, ["src/a.ts"]);
      const head = await commitToFork({ ...victim, snapshot }, { [`src/v${attempt}.ts`]: "v\n" }, { force: true, from: trunk });
      const s = ok(await t.L.submit(victim.txn, { head }));
      if (attempt < 3) {
        expect(s.state).toBe("stale");
        const r = ok(await t.L.retry(victim.txn));
        snapshot = r.snapshot;
        trunk = r.trunk;
      } else expect(s).toMatchObject({ state: "aborted", reason: "max_attempts" });
    }
    expect((await opsOf(t, "txn.aborted")).at(-1)!.data).toMatchObject({ cause: { state: "stale", reason: "stale_read" } });
  });

  it("answers 409 for every operation on terminal and in-flight states", async () => {
    const t = await newRepo();
    const landed = await readyTxn(t, { "src/l.ts": "l\n" }, ["src/b.ts"]);
    await landAlone(t, landed.b.txn, landed.b, landed.sha, ["src/l.ts"]);
    for (const op of [t.L.retry(landed.b.txn), t.L.approve(landed.b.txn), t.L.reject(landed.b.txn), t.L.abort(landed.b.txn, "x"), t.L.reads(landed.b.txn, ["a"])])
      expect(err(await op)).toBe(409);
    const v = await readyTxn(t, { "src/v.ts": "v\n" }, ["src/b.ts"], "agent-v");
    const train = ok(await t.L.formTrain()).train!;
    for (const op of [t.L.retry(v.b.txn), t.L.approve(v.b.txn), t.L.reject(v.b.txn), t.L.abort(v.b.txn, "x"), t.L.reads(v.b.txn, ["a"]), t.L.submit(v.b.txn, { head: "e".repeat(40) })])
      expect(err(await op)).toBe(409);
    ok(await t.L.trainOutcome(train, v.b.txn, "needs_human", "x"));
    for (const op of [t.L.retry(v.b.txn), t.L.reads(v.b.txn, ["a"]), t.L.intendWrite(v.b.txn, "a")]) expect(err(await op)).toBe(409);
  });

  it("answers 404 for an unknown train", async () => {
    const t = await newRepo();
    for (const op of [t.L.commitTrain("tr_nope", "a".repeat(40), []), t.L.trainDone("tr_nope", "x"), t.L.trainOutcome("tr_nope", "t_x", "failed", null), t.L.trainProbe("tr_nope", [], true)])
      expect(err(await op)).toBe(404);
  });

  it("lands members a watchdog already requeued when their train pushes after all", async () => {
    const t = await newRepo();
    const x = await readyTxn(t, { "src/x.ts": "x\n" }, ["src/b.ts"]);
    const train = ok(await t.L.formTrain()).train!;
    ok(await t.L.trainDone(train, "error", { error: "watchdog" }));
    expect(ok(await t.L.status(x.b.txn)).txn.state).toBe("ready");
    ok(await t.L.commitTrain(train, x.sha, [{ txn: x.b.txn, sha: x.sha, paths: ["src/x.ts"] }]));
    expect(ok(await t.L.status(x.b.txn)).txn).toMatchObject({ state: "landed", landedSeq: 1 });
  });

  it("expires leases on the alarm", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    ok(await t.L.intendWrite(b.txn, "src/a.ts"));
    await runInDurableObject(t.L, async (_o, state) => {
      state.storage.sql.exec("UPDATE lease SET expires = 1");
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(t.L);
    expect((await opsOf(t, "lease.released")).at(-1)!.data).toMatchObject({ path: "src/a.ts", txn: b.txn, expired: true });
  });

  it("wakes a long-poll with changed: true on a transition", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const w = t.L.wait(b.txn, 20_000);
    await new Promise((r) => setTimeout(r, 300));
    ok(await t.L.abort(b.txn, "bye"));
    expect(ok(await w)).toMatchObject({ changed: true, txn: { state: "aborted" } });
  });
});
