// Recall execution (PLAN.md §8) end to end inside the platform: the Ledger plans, revert.sh reverts
// on a real trunk through the runner, conflicts cascade, cascaded intents come back as new work.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AUTH, beginTxn, commitToFork, err, gitHelper, landAlone, newRepo, ok, opsOf, store, type TestRepo } from "./helpers";

async function landChange(t: TestRepo, agent: string, model: string, reads: string[], files: Record<string, string | null>) {
  const b = ok(await t.L.begin({ agent, model, intent: `${agent} changes ${Object.keys(files).join(" ")}` }));
  if (reads.length) ok(await t.L.reads(b.txn, reads));
  const sha = await commitToFork(b, files);
  expect(ok(await t.L.submit(b.txn, { head: sha })).state).toBe("ready");
  await landAlone(t, b.txn, b, sha, Object.keys(files));
  return b.txn;
}

const policyWith = (verify: string) =>
  JSON.stringify({ protected: ["test/**", "ryke.json"], union: ["src/registry.ts", "CHANGELOG.md"], verify, trainMax: 4 });

describe("recall", () => {
  it("plans targets and transitive dependents without touching anything on a dry run", async () => {
    const t = await newRepo();
    const target = await landChange(t, "agent-13", "sloppy-v0", ["src/a.ts"], { "src/a.ts": "export const a = 5;\n" });
    const reader = await landChange(t, "agent-01", "m", ["src/a.ts"], { "src/r.ts": "export const r = 1;\n" });
    const chained = await landChange(t, "agent-02", "m", ["src/r.ts"], { "src/q.ts": "q\n" });
    await landChange(t, "agent-03", "m", ["src/b.ts"], { "src/z.ts": "z\n" });
    const plan = ok(await t.L.recall({ model: "sloppy-v0" }, true));
    expect(plan).toEqual({ dryRun: true, plan: { targets: [target], dependents: [reader, chained], order: [target] } });
    expect(ok(await t.L.status(target)).txn.state).toBe("landed");
    expect(await opsOf(t, "recall.planned")).toEqual([]);
  });

  it("reverts the target, cascades the dependent whose revert conflicts, re-queues it, and keeps clean dependents", async () => {
    const t = await newRepo();
    const target = await landChange(t, "agent-13", "sloppy-v0", ["src/a.ts"], { "src/a.ts": "export const a = 5;\n" });
    const clean = await landChange(t, "agent-01", "m", ["src/a.ts"], { "src/r.ts": "export const r = 1;\n" });
    const conflicting = await landChange(t, "agent-02", "model-x", ["src/a.ts"], { "src/a.ts": "export const a = 5;\nexport const a2 = 6;\n" });
    const res = ok(await t.L.recall({ agent: "agent-13" }, false));
    expect(res).toMatchObject({ dryRun: false, outcome: "pass", cascade: [conflicting], plan: { targets: [target], dependents: [clean, conflicting] } });
    expect(ok(await t.L.status(target)).txn).toMatchObject({ state: "recalled", reason: "target" });
    expect(ok(await t.L.status(conflicting)).txn).toMatchObject({ state: "recalled", reason: "cascade" });
    expect(ok(await t.L.status(clean)).txn.state).toBe("landed");
    // the trunk content is back to the fixture's a.ts, and r.ts (clean dependent) survives
    const head = (await store.info(t.name)).head!;
    expect(head).toBe(res.head);
    expect(await store.readFile(t.name, head, "src/a.ts")).toBe("export const a = 2;\n");
    expect(await store.readFile(t.name, head, "src/r.ts")).toBe("export const r = 1;\n");
    expect(ok(await t.L.summary()).seq).toBe(5);
    // the cascaded intent comes back as a new open transaction for the same agent and model
    expect(res.requeued).toHaveLength(1);
    const q = res.requeued![0]!;
    expect(q.from).toBe(conflicting);
    const fresh = ok(await t.L.status(q.txn)).txn;
    expect(fresh).toMatchObject({ state: "open", attempt: 1, agent: "agent-02", model: "model-x", snapshot: head });
    expect(fresh.intent).toBe(ok(await t.L.status(conflicting)).txn.intent);
    expect(q.token).toMatch(/^art_v1_/);
    const planned = (await opsOf(t, "recall.planned"))[0]!;
    const done = (await opsOf(t, "recall.done"))[0]!;
    expect(planned.data).toMatchObject({ recall: res.recall, targets: [target], dependents: [clean, conflicting] });
    expect(done.data).toMatchObject({ recall: res.recall, outcome: "pass", recalled: [target], cascade: [conflicting], forced: false, requeued: [{ from: conflicting, txn: q.txn }] });
  });

  it("reverts every dependent too when the reverted trunk fails its tests", async () => {
    const t = await newRepo({ policy: policyWith("! test -f src/needs-a.ts || grep -q 'a = 5' src/a.ts") });
    const target = await landChange(t, "agent-13", "sloppy-v0", ["src/a.ts"], { "src/a.ts": "export const a = 5;\n" });
    const dependent = await landChange(t, "agent-01", "m", ["src/a.ts"], { "src/needs-a.ts": "// relies on a = 5\n" });
    const res = ok(await t.L.recall({ model: "sloppy-v0" }, false));
    expect(res).toMatchObject({ outcome: "pass", cascade: [dependent] });
    expect(ok(await t.L.status(dependent)).txn).toMatchObject({ state: "recalled", reason: "cascade" });
    expect((await opsOf(t, "recall.done"))[0]!.data).toMatchObject({ forced: true });
    const head = (await store.info(t.name)).head!;
    expect(await store.readFile(t.name, head, "src/needs-a.ts")).toBeNull();
    expect(res.requeued!.map((r) => r.from)).toEqual([dependent]);
  });

  it("leaves trunk alone when the reverted trunk fails and there is nothing else to revert", async () => {
    const t = await newRepo({ policy: policyWith("grep -q 'a = 5' src/a.ts") });
    const target = await landChange(t, "agent-13", "sloppy-v0", ["src/a.ts"], { "src/a.ts": "export const a = 5;\n" });
    const before = (await store.info(t.name)).head;
    const res = ok(await t.L.recall({ txns: [target] }, false));
    expect(res.outcome).toBe("verify_failed");
    expect((await store.info(t.name)).head).toBe(before);
    expect(ok(await t.L.status(target)).txn.state).toBe("landed");
    expect((await opsOf(t, "recall.done"))[0]!.data).toMatchObject({ outcome: "verify_failed" });
  });

  it("waits for the train in flight and recalls what it landed too", async () => {
    const t = await newRepo();
    const first = await landChange(t, "agent-13", "sloppy-v0", ["src/a.ts"], { "src/a.ts": "export const a = 5;\n" });
    const b = ok(await t.L.begin({ agent: "agent-13", model: "sloppy-v0", intent: "agent-13 changes src/z.ts" }));
    ok(await t.L.reads(b.txn, ["src/b.ts"]));
    const sha = await commitToFork(b, { "src/z.ts": "z\n" });
    expect(ok(await t.L.submit(b.txn, { head: sha })).state).toBe("ready");
    const train = ok(await t.L.formTrain()).train!;
    const recall = t.L.recall({ agent: "agent-13" }, false);
    await new Promise((r) => setTimeout(r, 400));
    // the train lands while the recall waits for the lander
    const trunkToken = await store.token(t.name, "write", 600);
    await gitHelper("/push", { from: b, sha, to: { remote: (await store.info(t.name)).remote, token: trunkToken } });
    ok(await t.L.commitTrain(train, sha, [{ txn: b.txn, sha, paths: ["src/z.ts"] }]));
    ok(await t.L.trainDone(train, "landed"));
    const res = ok(await recall);
    expect(res.outcome).toBe("pass");
    expect(res.plan.targets).toEqual([first, b.txn]);
    expect(ok(await t.L.status(b.txn)).txn.state).toBe("recalled");
    expect(await store.readFile(t.name, res.head!, "src/z.ts")).toBeNull();
  });

  it("reverts a target's registry line without cascading through the union path", async () => {
    const t = await newRepo();
    const target = await landChange(t, "agent-13", "sloppy-v0", ["src/registry.ts"], {
      "src/registry.ts": "export { a } from './a.ts';\nexport { bad } from './bad.ts';\n",
      "src/bad.ts": "export const bad = 1;\n",
    });
    const later = await landChange(t, "agent-01", "m", ["src/registry.ts"], {
      "src/registry.ts": "export { a } from './a.ts';\nexport { bad } from './bad.ts';\nexport { good } from './good.ts';\n",
      "src/good.ts": "export const good = 1;\n",
    });
    const res = ok(await t.L.recall({ model: "sloppy-v0" }, false));
    expect(res).toMatchObject({ outcome: "pass", cascade: [], plan: { dependents: [] } });
    expect(ok(await t.L.status(later)).txn.state).toBe("landed");
    expect(ok(await t.L.status(target)).txn.state).toBe("recalled");
    expect(await store.readFile(t.name, res.head!, "src/registry.ts")).toBe("export { a } from './a.ts';\nexport { good } from './good.ts';\n");
    expect(await store.readFile(t.name, res.head!, "src/bad.ts")).toBeNull();
  });

  it.each([
    [{}, 422],
    [{ agent: "a", model: "b" }, 422],
    [{ txns: ["t_not_landed"] }, 422],
    ["nope", 422],
  ])("rejects selector %j with %i", async (selector, status) => {
    const t = await newRepo();
    expect(err(await t.L.recall(selector, true))).toBe(status);
  });

  it("refuses to execute a selector that matches nothing", async () => {
    const t = await newRepo();
    expect(ok(await t.L.recall({ model: "nobody" }, true)).plan.targets).toEqual([]);
    expect(err(await t.L.recall({ model: "nobody" }, false))).toBe(422);
  });

  it("is exposed at POST /api/repos/:repo/recall, admin only, and indexes re-queued transactions", async () => {
    const t = await newRepo();
    const target = await landChange(t, "agent-13", "sloppy-v0", ["src/a.ts"], { "src/a.ts": "export const a = 5;\n" });
    await landChange(t, "agent-02", "m", ["src/a.ts"], { "src/a.ts": "export const a = 5;\nexport const a2 = 6;\n" });
    const url = `http://ryke.test/api/repos/${t.name}/recall`;
    const unauth = await exports.default.fetch(url, { method: "POST", body: JSON.stringify({ selector: { model: "sloppy-v0" }, dryRun: true }) });
    expect(unauth.status).toBe(401);
    const dry = await exports.default.fetch(url, { method: "POST", headers: AUTH, body: JSON.stringify({ selector: { model: "sloppy-v0" } }) });
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as { dryRun: boolean }).dryRun).toBe(true);
    const bad = await exports.default.fetch(url, { method: "POST", headers: AUTH, body: "[]" });
    expect(bad.status).toBe(422);
    const run = await exports.default.fetch(url, { method: "POST", headers: AUTH, body: JSON.stringify({ selector: { model: "sloppy-v0" }, dryRun: false }) });
    const body = (await run.json()) as { outcome: string; requeued: { txn: string }[] };
    expect(run.status).toBe(200);
    expect(body.outcome).toBe("pass");
    const detail = await exports.default.fetch(`http://ryke.test/api/txns/${body.requeued[0]!.txn}`);
    expect(detail.status).toBe(200);
    expect(ok(await t.L.status(target)).txn.state).toBe("recalled");
  });
});
