// containers/runner/lib/land.mjs against real git: squash merges per transaction with the snapshot as
// merge base, the union driver, text conflicts, the §5.4 commit format, the CAS push, git notes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { commitMessage, scanTestDiff } from "../../containers/runner/lib/land.mjs";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
const git = async (cwd, ...a) => (await run("git", a, { cwd, env: ENV })).stdout.trim();

let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ryke-land-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function bare(name) {
  const dir = join(tmp, `${name}.git`);
  await git(tmp, "init", "-q", "--bare", "-b", "main", dir);
  await git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  return dir;
}

async function commitFiles(remote, base, files, message = "change") {
  const dir = await mkdtemp(join(tmp, "w-"));
  await git(dir, "init", "-q", "-b", "main");
  if (base) {
    await git(dir, "fetch", "-q", remote, base);
    await git(dir, "checkout", "-q", base);
  }
  for (const [p, c] of Object.entries(files)) {
    if (c === null) await rm(join(dir, p));
    else {
      await mkdir(dirname(join(dir, p)), { recursive: true });
      await writeFile(join(dir, p), c);
    }
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", message);
  const sha = await git(dir, "rev-parse", "HEAD");
  await git(dir, "push", "-q", "--force", remote, `${sha}:refs/heads/main`);
  return sha;
}

async function land(args) {
  const cwd = await mkdtemp(join(tmp, "job-"));
  const argv = Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === "string" ? v : JSON.stringify(v)]);
  const { stdout } = await run("bash", [join(ROOT, "containers/runner/bin/land.sh"), ...argv], { cwd, env: ENV }).catch((e) => e);
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

async function scenario() {
  const trunk = await bare(`trunk-${Math.random().toString(36).slice(2)}`);
  const base = await commitFiles(trunk, null, {
    "src/registry.ts": "export { a } from './a.ts';\n",
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 1;\n",
    "test/a.test.ts": "test('a', () => {});\n",
  });
  const fork = async (id, files) => {
    const f = await bare(`${id}-${Math.random().toString(36).slice(2)}`);
    await git(tmp, "--git-dir", f, "fetch", "-q", trunk, "main:main");
    return { id, fork: f, head: await commitFiles(f, base, files, id), snapshot: base, agent: `agent-${id}`, model: "m", attempt: 1, intent: `do ${id}` };
  };
  return { trunk, base, fork };
}

describe("land.mjs prepare", () => {
  it("squashes clean transactions in order, unions the registry, and reports a text conflict", async () => {
    const { trunk, base, fork } = await scenario();
    const x = await fork("x", { "src/x.ts": "x\n", "src/registry.ts": "export { a } from './a.ts';\nexport { x } from './x.ts';\n" });
    const y = await fork("y", { "src/y.ts": "y\n", "src/registry.ts": "export { a } from './a.ts';\nexport { y } from './y.ts';\n", "test/y.test.ts": "test('y works', () => {});\n" });
    const z = await fork("z", { "src/a.ts": "export const a = 3;\n" });
    const w = await fork("w", { "src/a.ts": "export const a = 4;\n" });
    const r = await land({ mode: "prepare", trunk, base, ref: "refs/ryke/candidates/t1", union: ["src/registry.ts"], txns: [x, y, z, w] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.applied.map((a) => a.txn), ["x", "y", "z"]);
    assert.deepEqual(r.conflicts, [{ txn: "w", paths: ["src/a.ts"] }]);
    assert.deepEqual(r.applied[0].paths, ["src/registry.ts", "src/x.ts"]);
    assert.deepEqual(r.applied[1].newTests, ["y works"]);
    assert.equal(r.applied[1].tamper, false);
    assert.match(r.applied[0].diffstat, /2 files changed/);
    // the candidate is in the trunk repo under the scratch ref, one commit per transaction on top of base
    assert.equal(await git(trunk, "rev-parse", "refs/ryke/candidates/t1"), r.candidate);
    assert.equal(await git(trunk, "rev-list", "--count", `${base}..${r.candidate}`), "3");
    assert.equal(await git(trunk, "show", `${r.candidate}:src/registry.ts`), "export { a } from './a.ts';\nexport { x } from './x.ts';\nexport { y } from './y.ts';");
    const msg = await git(trunk, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%B", r.applied[0].commit);
    assert.equal(msg, `agent-x <agent-x@agents.ryke.ai>|Ryke <lander@ryke.ai>|do x\n\nRyke-Txn: x\nRyke-Agent: agent-x\nRyke-Model: m\nRyke-Attempt: 1\nRyke-Snapshot: ${base}`);
  });

  it("reports no candidate push when nothing applies, and an unfetchable fork as a conflict", async () => {
    const { trunk, base, fork } = await scenario();
    const ghost = { ...(await fork("g", { "src/g.ts": "g\n" })), head: "f".repeat(40) };
    const r = await land({ mode: "prepare", trunk, base, ref: "refs/ryke/candidates/t2", union: [], txns: [ghost] });
    assert.equal(r.ok, true);
    assert.equal(r.applied.length, 0);
    assert.equal(r.conflicts[0].txn, "g");
    assert.match(r.conflicts[0].error, /fetch failed/);
    assert.equal(r.candidate, base);
  });

  it("flags .only( and skip( added under test/", async () => {
    const { trunk, base, fork } = await scenario();
    const t = await fork("t", { "test/new.test.ts": "test.only('focus', () => {});\n" });
    const r = await land({ mode: "prepare", trunk, base, ref: "refs/ryke/candidates/t3", union: [], txns: [t] });
    assert.equal(r.applied[0].tamper, true);
  });

  it("fails cleanly on a bad base", async () => {
    const { trunk } = await scenario();
    const r = await land({ mode: "prepare", trunk, base: "e".repeat(40), ref: "refs/x", union: [], txns: [] });
    assert.equal(r.ok, false);
    assert.match(r.error, /git fetch/);
  });
});

describe("land.mjs push", () => {
  it("pushes the candidate to main, writes notes, deletes scratch refs, and rejects a moved trunk", async () => {
    const { trunk, base, fork } = await scenario();
    const x = await fork("x", { "src/x.ts": "x\n" });
    const p = await land({ mode: "prepare", trunk, base, ref: "refs/ryke/candidates/t4", union: [], txns: [x] });
    const notes = [{ sha: p.applied[0].commit, note: { reads: ["src/a.ts"], writes: ["src/x.ts"] } }];
    const pushed = await land({ mode: "push", trunk, candidate: p.candidate, notes, cleanup: ["refs/ryke/candidates/t4"] });
    assert.deepEqual(pushed, { ok: true, pushed: true, notesPushed: true });
    assert.equal(await git(trunk, "rev-parse", "main"), p.candidate);
    assert.deepEqual(JSON.parse(await git(trunk, "notes", "--ref=ryke", "show", p.applied[0].commit)), notes[0].note);
    await assert.rejects(git(trunk, "rev-parse", "--verify", "refs/ryke/candidates/t4"));
    // A second candidate built on the old base must not overwrite the moved trunk.
    const y = await fork("y", { "src/y.ts": "y\n" });
    const stale = await land({ mode: "prepare", trunk, base, ref: "refs/ryke/candidates/t5", union: [], txns: [y] });
    const cas = await land({ mode: "push", trunk, candidate: stale.candidate, notes: [], cleanup: [] });
    assert.deepEqual(cas, { ok: true, pushed: false, reason: "cas" });
    assert.equal(await git(trunk, "rev-parse", "main"), p.candidate);
  });

  it("deletes scratch refs of a train that did not land", async () => {
    const { trunk, base, fork } = await scenario();
    const x = await fork("x", { "src/x.ts": "x\n" });
    await land({ mode: "prepare", trunk, base, ref: "refs/ryke/candidates/t6/0", union: [], txns: [x] });
    assert.deepEqual(await land({ mode: "cleanup", trunk, refs: ["refs/ryke/candidates/t6/0"] }), { ok: true, deleted: 1 });
    await assert.rejects(git(trunk, "rev-parse", "--verify", "refs/ryke/candidates/t6/0"));
  });

  it("rejects an unknown mode", async () => {
    const r = await land({ mode: "nope" });
    assert.deepEqual(r, { ok: false, error: "unknown --mode nope" });
  });
});

describe("land.mjs helpers", () => {
  it("formats the commit message with a 72-char subject and trailers", () => {
    const long = "x".repeat(100);
    const m = commitMessage({ id: "t_1", agent: "agent-07", model: null, attempt: 2, snapshot: "abc", intent: `${long}\nsecond line` });
    const [subject, blank, ...trailers] = m.split("\n");
    assert.equal(subject.length, 72);
    assert.equal(blank, "");
    assert.deepEqual(trailers, ["Ryke-Txn: t_1", "Ryke-Agent: agent-07", "Ryke-Model: unknown", "Ryke-Attempt: 2", "Ryke-Snapshot: abc"]);
  });

  for (const [line, tamper] of [
    ["+test.only('a', () => {})", true],
    ["+describe.skip('a', () => {})", true],
    ["+it.skip('x')", true],
    ["+  t.skip()", true],
    ["+test('ok', () => {})", false],
    ["+test(\"converts kelvin\", { skip: true }, () => {})", true],
    ["+test('x', { todo: true }, () => {})", true],
    ["+test('x', { only: true }, () => {})", true],
    ["+test('x', { skip: 'later' }, () => {})", true],
    ["+test.todo('x')", true],
    ["+test[\"skip\"]('x', () => {})", true],
    ["+const skipped = false; // skipping nothing", false],
    ["-test.only('removed')", false],
    ["+++ b/test/only.ts", false],
  ]) {
    it(`scanTestDiff: ${line} → tamper ${tamper}`, () => {
      assert.equal(scanTestDiff(line).tamper, tamper);
    });
  }

  it("collects added test names", () => {
    assert.deepEqual(scanTestDiff("+test('a b', () => {});\n+  it(\"c\", () => {});\n-test('gone')").newTests, ["a b", "c"]);
  });
});
