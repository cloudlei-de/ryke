import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickCascade } from "../../containers/runner/lib/revert.mjs";

const candidates = { T: { "src/a.ts": ["D3", "D1"], "src/b.ts": ["D2"] } };
const seqs = { T: 1, D1: 2, D2: 3, D3: 4 };

describe("pickCascade", () => {
  for (const [paths, reverted, expected, why] of [
    [["src/a.ts"], [], "D3", "the newest writer of the conflicting path"],
    [["src/a.ts"], ["D3"], "D1", "skips an already reverted dependent"],
    [["src/a.ts", "src/b.ts"], [], "D3", "newest across all conflicting paths"],
    [["src/a.ts", "src/b.ts"], ["D3"], "D2", "next newest across paths"],
    [["src/c.ts"], [], null, "no dependent wrote the path"],
    [["src/a.ts"], ["D3", "D1"], null, "all candidates reverted"],
  ]) {
    it(`${JSON.stringify(paths)} reverted=${JSON.stringify(reverted)} → ${expected}: ${why}`, () => {
      assert.equal(pickCascade(candidates, "T", paths, new Set(reverted), seqs), expected);
    });
  }

  it("returns null for a target without candidates", () => {
    assert.equal(pickCascade(candidates, "X", ["src/a.ts"], new Set(), seqs), null);
  });
});

import { execFile } from "node:child_process";
import { mkdtemp, mkdir as mkdirp, rm as rmrf, writeFile as write } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname as dir, join as joinp, resolve as res } from "node:path";
import { after as afterAll, before as beforeAll } from "node:test";
import { fileURLToPath as toPath } from "node:url";
import { promisify } from "node:util";
import { withoutAddedLines } from "../../containers/runner/lib/revert.mjs";

const sh = promisify(execFile);
const ROOT = res(dir(toPath(import.meta.url)), "../..");
const GENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
const g = async (cwd, ...a) => (await sh("git", a, { cwd, env: GENV })).stdout.trim();

describe("withoutAddedLines", () => {
  for (const [current, added, expected] of [
    ["a\nb\nc\n", ["b"], "a\nc\n"],
    ["a\nb\nc\nb\n", ["b"], "a\nc\nb\n"],
    ["a\nc\n", ["b"], "a\nc\n"],
    ["a\nb\nc\n", ["b", "c"], "a\n"],
  ]) {
    it(`${JSON.stringify(current)} - ${JSON.stringify(added)}`, () => {
      assert.equal(withoutAddedLines(current, added), expected);
    });
  }
});

describe("revert.mjs against real git", () => {
  let tmp;
  beforeAll(async () => {
    tmp = await mkdtemp(joinp(tmpdir(), "ryke-revert-"));
  });
  afterAll(async () => {
    await rmrf(tmp, { recursive: true, force: true });
  });

  async function trunkWith(commits) {
    const bare = joinp(tmp, `t${Math.random().toString(36).slice(2)}.git`);
    await g(tmp, "init", "-q", "--bare", "-b", "main", bare);
    const work = await mkdtemp(joinp(tmp, "w-"));
    await g(work, "init", "-q", "-b", "main");
    const shas = [];
    for (const files of commits) {
      for (const [p, c] of Object.entries(files)) {
        await mkdirp(dir(joinp(work, p)), { recursive: true });
        await write(joinp(work, p), c);
      }
      await g(work, "add", "-A");
      await g(work, "commit", "-q", "-m", "c");
      shas.push(await g(work, "rev-parse", "HEAD"));
    }
    await g(work, "push", "-q", bare, "HEAD:refs/heads/main");
    return { bare, shas };
  }

  async function run(trunk, plan, ref = "refs/ryke/recall/rc_t") {
    const cwd = await mkdtemp(joinp(tmp, "job-"));
    const r = await sh("bash", [joinp(ROOT, "containers/runner/bin/revert.sh"), "--trunk", trunk, "--plan", JSON.stringify(plan), "--ref", ref], { cwd, env: GENV }).catch((e) => e);
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  }

  it("reverts a target, pushes the result to the scratch ref and lists the revert commits", async () => {
    const { bare, shas } = await trunkWith([{ "a.ts": "1\n" }, { "a.ts": "2\n" }, { "b.ts": "b\n" }]);
    const r = await run(bare, { recall: "rc_t", order: ["T"], commits: { T: shas[1] }, cascadeCandidates: {}, seqs: { T: 1 } });
    assert.equal(r.outcome, "prepared");
    assert.equal(r.base, shas[2]);
    assert.deepEqual(r.commits.map((c) => [c.txn, c.paths]), [["T", ["a.ts"]]]);
    assert.equal(await g(bare, "rev-parse", "refs/ryke/recall/rc_t"), r.head);
    assert.equal(await g(bare, "show", `${r.head}:a.ts`), "1");
    assert.equal(await g(bare, "rev-parse", "main"), shas[2], "main is untouched: the Ledger pushes after verify");
  });

  it("reverts the conflicting dependent first and reports the cascade", async () => {
    const { bare, shas } = await trunkWith([{ "a.ts": "1\n" }, { "a.ts": "2\n" }, { "a.ts": "3\n" }]);
    const plan = { recall: "rc_t", order: ["T"], commits: { T: shas[1], D: shas[2] }, cascadeCandidates: { T: { "a.ts": ["D"] } }, seqs: { T: 1, D: 2 } };
    const r = await run(bare, plan);
    assert.equal(r.outcome, "prepared");
    assert.deepEqual(r.cascade, ["D"]);
    assert.deepEqual(r.commits.map((c) => c.txn), ["D", "T"]);
    assert.equal(await g(bare, "show", `${r.head}:a.ts`), "1");
  });

  it("reports an unexplained conflict", async () => {
    const { bare, shas } = await trunkWith([{ "a.ts": "1\n" }, { "a.ts": "2\n" }, { "a.ts": "3\n" }]);
    const r = await run(bare, { recall: "rc_t", order: ["T"], commits: { T: shas[1] }, cascadeCandidates: {}, seqs: {} });
    assert.equal(r.outcome, "conflict");
    assert.deepEqual(r.conflict, { txn: "T", paths: ["a.ts"] });
  });

  it("removes only the target's own lines from a union file", async () => {
    const { bare, shas } = await trunkWith([{ "reg.ts": "a\n" }, { "reg.ts": "a\nbad\n" }, { "reg.ts": "a\nbad\ngood\n" }]);
    const r = await run(bare, { recall: "rc_t", order: ["T"], commits: { T: shas[1] }, cascadeCandidates: {}, seqs: {}, union: ["reg.ts"] });
    assert.equal(r.outcome, "prepared");
    assert.equal(await g(bare, "show", `${r.head}:reg.ts`), "a\ngood");
  });
});
