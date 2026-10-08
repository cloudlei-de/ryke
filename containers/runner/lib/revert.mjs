// Recall's git work (PLAN.md §8.3): revert every target newest first on the current trunk. When a
// revert conflicts, revert the newest dependent that wrote a conflicting path first (it joins the
// cascade) and try again. The result goes to a scratch ref; the Ledger then verifies it with a
// read-only token and pushes it with the same compare-and-swap job the lander uses, so no
// repo-controlled code ever runs next to a write credential.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git, main } from "./common.mjs";

// The newest not-yet-reverted dependent that wrote one of the conflicting paths after `target`.
export function pickCascade(candidates, target, paths, reverted, seqs) {
  const byPath = candidates[target] ?? {};
  const options = [...new Set(paths.flatMap((p) => byPath[p] ?? []))].filter((id) => !reverted.has(id));
  options.sort((x, y) => (seqs[y] ?? 0) - (seqs[x] ?? 0));
  return options[0] ?? null;
}

// Union paths took concurrent additions; reverting a commit there means removing only the lines
// that commit added, wherever later additions put them.
export function withoutAddedLines(current, added) {
  const lines = current.split("\n");
  for (const line of added) {
    const i = lines.indexOf(line);
    if (i >= 0) lines.splice(i, 1);
  }
  return lines.join("\n");
}


async function revertUnion(dir, sha, paths) {
  for (const path of paths) {
    const diff = (await git(dir, ["diff", "-U0", `${sha}~1`, sha, "--", path])).stdout;
    const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
    // Start from the current trunk's version: the working file holds the failed revert's markers.
    const current = (await git(dir, ["show", `HEAD:${path}`])).stdout;
    await writeFile(join(dir, path), withoutAddedLines(current, added));
    await git(dir, ["add", "--", path]);
  }
}

async function revertOne(dir, plan, id, target, reverted, cascade, depth = 0) {
  if (depth > 50) throw new Error("cascade too deep");
  const sha = plan.commits[id];
  const res = await git(dir, ["revert", "--no-commit", sha], { allowFail: true });
  if (res.code !== 0) {
    const paths = (await git(dir, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean);
    // The Ledger resolved which paths are union paths with the policy's matcher (ledger.ts executeRecall).
    const union = new Set(plan.unionPaths ?? []);
    if (paths.length > 0 && paths.every((p) => union.has(p))) {
      await revertUnion(dir, sha, paths);
    } else {
      await git(dir, ["revert", "--abort"], { allowFail: true });
      await git(dir, ["reset", "-q", "--hard"]);
      const pick = pickCascade(plan.cascadeCandidates, target, paths, reverted, plan.seqs ?? {});
      if (!pick) throw Object.assign(new Error(`reverting ${id} conflicts on ${paths.join(", ")} and no dependent explains it`), { conflict: { txn: id, paths } });
      await revertOne(dir, plan, pick, target, reverted, cascade, depth + 1);
      if (!cascade.includes(pick)) cascade.push(pick);
      await revertOne(dir, plan, id, target, reverted, cascade, depth + 1);
      return;
    }
  }
  const status = await git(dir, ["status", "--porcelain"]);
  if (status.stdout.trim() === "") {
    await git(dir, ["revert", "--quit"], { allowFail: true });
    reverted.add(id); // already undone by an earlier revert
    return;
  }
  await git(dir, ["commit", "-q", "-m", `Revert ${id}\n\nRyke-Recall: ${plan.recall}\nRyke-Reverts: ${id}\nRyke-Commit: ${sha}`]);
  reverted.add(id);
}

async function prepare(a) {
  const plan = JSON.parse(a.plan);
  const dir = resolve("recall");
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-q", "--template=", "-b", "main"]);
  await git(dir, ["remote", "add", "trunk", a.trunk]);
  await git(dir, ["fetch", "-q", "trunk", "main"]);
  const base = (await git(dir, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
  await git(dir, ["checkout", "-q", base]);
  const reverted = new Set();
  const cascade = [];
  try {
    for (const id of plan.order) {
      if (reverted.has(id)) continue;
      await revertOne(dir, plan, id, plan.targetOf?.[id] ?? id, reverted, cascade);
    }
  } catch (e) {
    if (e.conflict) return { ok: true, outcome: "conflict", conflict: e.conflict, base };
    throw e;
  }
  const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  const commits = [];
  for (const sha of (await git(dir, ["log", "--format=%H", "--reverse", `${base}..${head}`])).stdout.trim().split("\n").filter(Boolean)) {
    const msg = (await git(dir, ["log", "-1", "--format=%B", sha])).stdout;
    const txn = /Ryke-Reverts: (\S+)/.exec(msg)?.[1] ?? null;
    const paths = (await git(dir, ["diff", "--name-only", "--no-renames", `${sha}~1`, sha])).stdout.trim().split("\n").filter(Boolean);
    commits.push({ sha, txn, paths });
  }
  if (head !== base) await git(dir, ["push", "-q", "--force", "trunk", `${head}:${a.ref}`]);
  return { ok: true, outcome: "prepared", base, head, commits, cascade };
}

if (import.meta.url === `file://${process.argv[1]}`) main(prepare);
