// The lander's git work (PLAN.md §5.3, §5.4).
//   prepare: merge each transaction onto the candidate with its snapshot as merge base, one squash
//            commit per clean merge, conflicts reported and skipped; push the candidate to a scratch ref.
//   push:    non-force push of the candidate to trunk main (a compare-and-swap), then git notes.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git, LANDER, main } from "./common.mjs";

const TRUNK = "trunk";

export function commitMessage(t) {
  const first = String(t.intent).split("\n")[0].trim();
  const subject = first.length > 72 ? `${first.slice(0, 71)}…` : first;
  return [
    subject,
    "",
    `Ryke-Txn: ${t.id}`,
    `Ryke-Agent: ${t.agent}`,
    `Ryke-Model: ${t.model ?? "unknown"}`,
    `Ryke-Attempt: ${t.attempt}`,
    `Ryke-Snapshot: ${t.snapshot}`,
  ].join("\n");
}

// .only( / .skip( / .todo( calls, node:test's { skip | todo | only } options, and bracket access.
const TAMPER = [/\.(?:only|skip|todo)\s*\(/, /\bskip\s*\(/, /\b(?:skip|todo|only)\s*:\s*(?:true|["'`])/, /\[\s*["'`](?:only|skip|todo)["'`]\s*\]/];

// Added test names, and whether the change sneaks a focus or skip into test/ (§9.3 hard check).
export function scanTestDiff(patch) {
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const tamper = added.some((l) => TAMPER.some((re) => re.test(l)));
  const newTests = [];
  for (const l of added) {
    const m = l.match(/\b(?:test|it|describe)\s*\(\s*(["'`])(.+?)\1/);
    if (m) newTests.push(m[2]);
  }
  return { tamper, newTests };
}

async function repo(dir, union) {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-q", "--template=", "-b", "main"]);
  await mkdir(join(dir, ".git", "info"), { recursive: true });
  // Union paths merge as a union of lines: concurrent registry and changelog additions are expected (§1.1).
  await writeFile(join(dir, ".git", "info", "attributes"), union.map((p) => `${p} merge=union\n`).join(""));
}

async function prepare(a) {
  const txns = JSON.parse(a.txns);
  const union = JSON.parse(a.union ?? "[]");
  const dir = resolve("land");
  await repo(dir, union);
  await git(dir, ["remote", "add", TRUNK, a.trunk]);
  await git(dir, ["fetch", "-q", TRUNK, a.base]);
  let current = a.base;
  const applied = [];
  const conflicts = [];
  for (const t of txns) {
    const fetched = await git(dir, ["fetch", "-q", t.fork, t.head], { allowFail: true });
    if (fetched.code !== 0) {
      conflicts.push({ txn: t.id, paths: [], error: `fetch failed: ${fetched.stderr.trim().split("\n").at(-1)}` });
      continue;
    }
    const merged = await git(dir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${t.snapshot}`, current, t.head], {
      allowFail: true,
    });
    const lines = merged.stdout.trim().split("\n");
    if (merged.code === 1) {
      conflicts.push({ txn: t.id, paths: [...new Set(lines.slice(1).filter(Boolean))].sort() });
      continue;
    }
    if (merged.code !== 0) throw new Error(`merge-tree failed for ${t.id}: ${merged.stderr}`);
    const tree = lines[0];
    const parentTree = (await git(dir, ["rev-parse", `${current}^{tree}`])).stdout.trim();
    if (tree === parentTree) {
      conflicts.push({ txn: t.id, paths: [], error: "no change against the candidate" });
      continue;
    }
    const commit = (
      await git(dir, ["commit-tree", tree, "-p", current, "-m", commitMessage(t)], {
        env: { GIT_AUTHOR_NAME: t.agent, GIT_AUTHOR_EMAIL: `${t.agent}@agents.ryke.ai`, GIT_COMMITTER_NAME: LANDER.name, GIT_COMMITTER_EMAIL: LANDER.email },
      })
    ).stdout.trim();
    const paths = (await git(dir, ["diff", "--name-only", "--no-renames", current, commit])).stdout.trim().split("\n").filter(Boolean);
    const diffstat = (await git(dir, ["diff", "--stat=120", "--no-renames", current, commit])).stdout.trim();
    const { tamper, newTests } = scanTestDiff((await git(dir, ["diff", "-U0", "--no-renames", current, commit, "--", "test/"])).stdout);
    applied.push({ txn: t.id, commit, paths, diffstat, tamper, newTests });
    current = commit;
  }
  if (applied.length > 0) await git(dir, ["push", "-q", "--force", TRUNK, `${current}:${a.ref}`]);
  return { ok: true, candidate: current, applied, conflicts };
}

async function push(a) {
  const notes = JSON.parse(a.notes ?? "[]");
  const dir = resolve("push");
  await repo(dir, []);
  await git(dir, ["remote", "add", TRUNK, a.trunk]);
  await git(dir, ["fetch", "-q", TRUNK, a.candidate]);
  const res = await git(dir, ["push", "--porcelain", TRUNK, `${a.candidate}:refs/heads/main`], { allowFail: true });
  if (res.code !== 0) {
    const rejected = /rejected|non-fast-forward|fetch first|stale info/.test(res.stdout + res.stderr);
    if (!rejected) throw new Error(`push failed: ${res.stderr || res.stdout}`);
    return { ok: true, pushed: false, reason: "cas" };
  }
  let notesPushed = false;
  if (notes.length > 0) {
    // Notes are evidence, not state: a failed notes push never undoes a landing.
    for (let attempt = 0; attempt < 2 && !notesPushed; attempt++) {
      await git(dir, ["fetch", "-q", "--force", TRUNK, "refs/notes/ryke:refs/notes/ryke"], { allowFail: true });
      for (const n of notes) await git(dir, ["notes", "--ref=ryke", "add", "-f", "-m", JSON.stringify(n.note), n.sha]);
      notesPushed = (await git(dir, ["push", "-q", TRUNK, "refs/notes/ryke:refs/notes/ryke"], { allowFail: true })).code === 0;
    }
  }
  for (const ref of JSON.parse(a.cleanup ?? "[]")) await git(dir, ["push", "-q", TRUNK, `:${ref}`], { allowFail: true });
  return { ok: true, pushed: true, notesPushed };
}

// Scratch refs of a train that did not land (a landed train deletes them in push).
async function cleanup(a) {
  const dir = resolve("cleanup");
  await repo(dir, []);
  const refs = JSON.parse(a.refs ?? "[]");
  for (const ref of refs) await git(dir, ["push", "-q", a.trunk, `:${ref}`], { allowFail: true });
  return { ok: true, deleted: refs.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(async (a) => {
    if (a.mode === "prepare") return prepare(a);
    if (a.mode === "push") return push(a);
    if (a.mode === "cleanup") return cleanup(a);
    throw new Error(`unknown --mode ${a.mode}`);
  });
}
