// Recall execution (PLAN.md §8.3): revert every target newest first on the current trunk. When a
// revert conflicts, revert the newest dependent that wrote a conflicting path first (it joins the
// cascade) and try again. Then run the verify command and, if it passes, push (compare-and-swap).
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { git, main } from "./common.mjs";
import { summarizeTests } from "./testsum.mjs";

// The newest not-yet-reverted dependent that wrote one of the conflicting paths after `target`.
export function pickCascade(candidates, target, paths, reverted, seqs) {
  const byPath = candidates[target] ?? {};
  const options = [...new Set(paths.flatMap((p) => byPath[p] ?? []))].filter((id) => !reverted.has(id));
  options.sort((x, y) => (seqs[y] ?? 0) - (seqs[x] ?? 0));
  return options[0] ?? null;
}

function runCommand(cwd, command, timeoutSeconds) {
  return new Promise((done) => {
    const env = { ...process.env, NO_COLOR: "1" };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn("bash", ["-c", command], { cwd, env, detached: true });
    let out = "";
    const take = (b) => {
      out = (out + b).slice(-2_000_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutSeconds * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ exitCode: code ?? (signal ? 128 + 9 : 1), out, timedOut });
    });
  });
}

async function revertOne(dir, plan, id, target, reverted, cascade, depth = 0) {
  if (depth > 50) throw new Error("cascade too deep");
  const sha = plan.commits[id];
  const res = await git(dir, ["revert", "--no-commit", sha], { allowFail: true });
  if (res.code === 0) {
    const status = await git(dir, ["status", "--porcelain"]);
    if (status.stdout.trim() === "") return; // already reverted by an earlier commit
    await git(dir, ["commit", "-q", "-m", `Revert ${id}\n\nRyke-Recall: ${plan.recall}\nRyke-Reverts: ${id}\nRyke-Commit: ${sha}`]);
    reverted.add(id);
    return;
  }
  const paths = (await git(dir, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean);
  await git(dir, ["revert", "--abort"], { allowFail: true });
  await git(dir, ["reset", "-q", "--hard"]);
  const pick = pickCascade(plan.cascadeCandidates, target, paths, reverted, plan.seqs ?? {});
  if (!pick) throw Object.assign(new Error(`reverting ${id} conflicts on ${paths.join(", ")} and no dependent explains it`), { conflict: { txn: id, paths } });
  await revertOne(dir, plan, pick, target, reverted, cascade, depth + 1);
  if (!cascade.includes(pick)) cascade.push(pick);
  await revertOne(dir, plan, id, target, reverted, cascade, depth + 1);
}

async function recall(a) {
  const plan = JSON.parse(a.plan);
  const dir = resolve("recall");
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["remote", "add", "trunk", a.trunk]);
  await git(dir, ["fetch", "-q", "trunk", "main"]);
  const base = (await git(dir, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
  await git(dir, ["checkout", "-q", base]);
  const reverted = new Set();
  const cascade = [];
  try {
    // Forced dependents (a second pass after a failed verify) are reverted along with the targets.
    for (const id of plan.order) {
      if (reverted.has(id)) continue;
      const target = plan.targetOf?.[id] ?? id;
      await revertOne(dir, plan, id, target, reverted, cascade);
    }
  } catch (e) {
    if (e.conflict) return { ok: true, pass: false, outcome: "conflict", conflict: e.conflict, base };
    throw e;
  }
  const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  const commits = [];
  for (const line of (await git(dir, ["log", "--format=%H", "--reverse", `${base}..${head}`])).stdout.trim().split("\n").filter(Boolean)) {
    const msg = (await git(dir, ["log", "-1", "--format=%B", line])).stdout;
    const txn = /Ryke-Reverts: (\S+)/.exec(msg)?.[1] ?? null;
    const paths = (await git(dir, ["diff", "--name-only", "--no-renames", `${line}~1`, line])).stdout.trim().split("\n").filter(Boolean);
    commits.push({ sha: line, txn, paths });
  }
  const run = await runCommand(dir, a.verify ?? "true", Number(a.timeout ?? 120));
  const tests = summarizeTests(run.out, { exitCode: run.exitCode, timedOut: run.timedOut, timeoutSeconds: Number(a.timeout ?? 120) });
  const pass = run.exitCode === 0 && !run.timedOut && tests.failed === 0;
  if (!pass || a.push !== "true") return { ok: true, pass, outcome: pass ? "verified" : "verify_failed", base, head, commits, cascade, tests };
  const pushed = await git(dir, ["push", "--porcelain", "trunk", `${head}:refs/heads/main`], { allowFail: true });
  if (pushed.code !== 0) return { ok: true, pass, outcome: "cas_rejected", base, head, commits, cascade, tests };
  return { ok: true, pass, outcome: "pushed", base, head, commits, cascade, tests };
}

if (import.meta.url === `file://${process.argv[1]}`) main(recall);
