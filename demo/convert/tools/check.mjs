#!/usr/bin/env node
// Checks the Convert seed and its solution patches with real git and the seed's own verify command.
//
//   check.mjs seed
//   check.mjs patch <id> [--v2] [--on <id>[:v2],<id>…]
//   check.mjs all [--strict] [--json]
//
// Common flags: --demo <dir> (use another demo directory, for tests), --keep (leave temp repos), --concurrency <n>.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Everything in the demo directory except these is the seed, i.e. the first commit of the trunk.
const NOT_SEED = new Set(["tools", "solutions", "tasks.json"]);

// The cumulative run `all` ends with: the cross-cutting tasks first (they make the G1 tests stale),
// then the sloppy pair and one conflict-pair side, then every category in its post-precision form.
const INTEGRATION_HEAD = [
  "t-precision",
  "t-search",
  "t-dark",
  "t-favorites",
  "t-share",
  "t-locale:v2",
  "sloppy-a",
  "sloppy-b",
  "kelvin-first:v2",
];

// NODE_TEST_CONTEXT is set inside `node --test`; a nested `node --test` that inherits it reports to its parent
// instead of running as a normal run, and exits 0 even when tests fail.
const INHERITED_ENV = { ...process.env };
delete INHERITED_ENV.NODE_TEST_CONTEXT;

// Real git, but isolated from the caller's configuration (signing, hooks, templates) so results do not depend on the machine.
const GIT_ENV = {
  ...INHERITED_ENV,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_AUTHOR_NAME: "Ryke Check",
  GIT_AUTHOR_EMAIL: "check@ryke.invalid",
  GIT_COMMITTER_NAME: "Ryke Check",
  GIT_COMMITTER_EMAIL: "check@ryke.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const withValue = new Set(["--on", "--demo", "--concurrency"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) positional.push(a);
    else if (withValue.has(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else flags[a.slice(2)] = true;
  }
  return { positional, flags };
}

export function listSeedFiles(demoDir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(demoDir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && NOT_SEED.has(entry.name)) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk("");
  return out.sort();
}

// Same meaning as src/shared/policy.ts: `**` spans segments, `*` stays inside one.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(globs, file) {
  return globs.some((g) => globToRegExp(g).test(file));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

const git = (cwd, args) => run("git", args, { cwd });

// Node's default reporter is TAP when stdout is not a terminal and spec otherwise; accept both.
export function parseFailures(output) {
  const names = new Set();
  for (const line of output.split("\n")) {
    const tap = /^\s*not ok \d+ - (.*?)(?: # .*)?$/.exec(line);
    if (tap) names.add(tap[1]);
    const spec = /^\s*✖ (.*?)(?: \(\d+(?:\.\d+)?ms\))?$/.exec(line);
    if (spec && !/^failing tests:?$/.test(spec[1])) names.add(spec[1]);
  }
  return [...names];
}

// Test counts from the runner's summary (TAP prints "# tests 65", the spec reporter "ℹ tests 65"); null if there is none.
export function parseCounts(output) {
  const grab = (name) => {
    const m = new RegExp(`^(?:#|ℹ) ${name} (\\d+)`, "m").exec(output);
    return m ? Number(m[1]) : null;
  };
  return { tests: grab("tests"), pass: grab("pass"), fail: grab("fail") };
}

function runVerify(dir, policy) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("sh", ["-c", policy.verify], { cwd: dir, env: GIT_ENV });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, policy.verifyTimeoutSeconds * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const failures = parseFailures(output);
      const counts = parseCounts(output);
      // Exit 0 with no tests counted would mean the verify command did not really run the suite.
      const ran = counts.tests === null || counts.tests > 0;
      resolve({ pass: code === 0 && !timedOut && ran, ms: Date.now() - started, failures, timedOut, output, tests: counts.tests });
    });
  });
}

class Demo {
  constructor(dir, keep) {
    this.dir = dir;
    this.keep = keep;
    this.policy = JSON.parse(fs.readFileSync(path.join(dir, "ryke.json"), "utf8"));
    const tasksFile = path.join(dir, "tasks.json");
    this.tasks = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, "utf8")) : [];
    this.seedPaths = new Set(listSeedFiles(dir));
  }

  task(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`unknown task ${id}`);
    return t;
  }

  // Resolves "id" or "id:v2" to a patch file, or null when the author has not written it yet.
  patchFor(id, variant) {
    const t = this.task(id);
    const rel = variant === "v2" ? t.v2 : t.solution;
    if (!rel) return null;
    const file = path.join(this.dir, rel);
    return fs.existsSync(file) ? file : null;
  }

  async newRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ryke-convert-"));
    for (const rel of this.seedPaths) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(path.join(this.dir, rel), path.join(dir, rel));
    }
    await git(dir, ["init", "-q", "-b", "main"]);
    // The trunk merges union paths by taking both sides; the same attribute drives `git apply --3way` here.
    const attributes = this.policy.union.map((p) => `${p} merge=union`).join("\n");
    fs.writeFileSync(path.join(dir, ".git", "info", "attributes"), `${attributes}\n`);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "seed"]);
    const base = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    return {
      dir,
      base,
      cleanup: () => {
        if (!this.keep) fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  // Applies the patch with a three-way merge and commits it; `touched` is the set of paths the commit changed.
  async applyAndCommit(repo, patchFile, label) {
    const applied = await git(repo.dir, ["apply", "--3way", patchFile]);
    if (applied.code !== 0) {
      return { ok: false, error: (applied.stderr || applied.stdout).trim().split("\n").slice(0, 6).join(" | ") };
    }
    const touched = (await git(repo.dir, ["diff", "--cached", "--name-only"])).stdout.split("\n").filter(Boolean).sort();
    // A clean three-way apply can still leave nothing to commit when the trunk already holds every change of the patch.
    if (touched.length === 0) return { ok: false, error: "the patch changes nothing: the trunk already has all of it" };
    const commit = await git(repo.dir, ["commit", "-q", "-m", label]);
    if (commit.code !== 0) return { ok: false, error: `commit failed: ${(commit.stderr || commit.stdout).trim()}` };
    const sha = (await git(repo.dir, ["rev-parse", "HEAD"])).stdout.trim();
    return { ok: true, touched, sha };
  }

  // Applies a list of "id" / "id:v2" steps in order. Stops at the first step that is missing or does not apply.
  async applyChain(repo, steps) {
    const shas = {};
    for (const step of steps) {
      const [id, variant = "v1"] = step.split(":");
      const file = this.patchFor(id, variant);
      if (!file) return { ok: false, missing: step, shas };
      const res = await this.applyAndCommit(repo, file, step);
      if (!res.ok) return { ok: false, failedStep: step, error: res.error, shas };
      shas[step] = res.sha;
    }
    return { ok: true, shas };
  }

  // The write-set recorded in tasks.json is what the scripted agent reports, so it has to match the patch.
  metadataProblems(task, touched) {
    const problems = [];
    const declared = [...task.writes].sort();
    if (JSON.stringify(declared) !== JSON.stringify(touched)) {
      problems.push(`writes mismatch: tasks.json ${JSON.stringify(declared)} vs patch ${JSON.stringify(touched)}`);
    }
    const protectedHits = touched.filter((p) => this.seedPaths.has(p) && matchesAny(this.policy.protected, p));
    if (task.expect === "reject_protected") {
      if (protectedHits.length === 0) problems.push("expect is reject_protected but the patch changes no existing protected file");
    } else if (protectedHits.length > 0) {
      problems.push(`changes existing protected files: ${protectedHits.join(", ")}`);
    }
    return problems;
  }

  // Result for one task: base chain, then the task's patch, then verify.
  async checkPatch(id, { variant = "v1", on = [], verify = true } = {}) {
    const task = this.task(id);
    const result = { id, variant, on, applied: false, verify: "skipped", failures: [], ms: 0, problems: [] };
    const file = this.patchFor(id, variant);
    if (!file) return { ...result, verify: "missing" };
    const repo = await this.newRepo();
    try {
      const chain = await this.applyChain(repo, on);
      if (!chain.ok) {
        const why = chain.missing ? `${chain.missing} is missing` : `${chain.failedStep} does not apply: ${chain.error}`;
        return { ...result, verify: chain.missing ? "missing" : "skipped", problems: [`base ${why}`] };
      }
      const res = await this.applyAndCommit(repo, file, `${id}:${variant}`);
      if (!res.ok) return { ...result, problems: [`patch does not apply: ${res.error}`] };
      result.applied = true;
      result.problems = this.metadataProblems(task, res.touched);
      if (verify) {
        const v = await runVerify(repo.dir, this.policy);
        result.verify = v.pass ? "pass" : "fail";
        result.failures = v.failures;
        result.ms = v.ms;
        if (!v.pass && v.failures.length === 0) result.detail = v.timedOut ? "verify timed out" : v.output.trim().split("\n").slice(-12).join("\n");
      }
      return result;
    } finally {
      repo.cleanup();
    }
  }

  async checkSeed() {
    const repo = await this.newRepo();
    try {
      const v = await runVerify(repo.dir, this.policy);
      return { seed: v.pass ? "pass" : "fail", ms: v.ms, tests: v.tests, failures: v.failures, output: v.output };
    } finally {
      repo.cleanup();
    }
  }

  // One cumulative run: every available patch in order, with union paths merged, then verify once.
  async checkIntegration() {
    const wanted = [...INTEGRATION_HEAD, ...this.tasks.filter((t) => t.group === "G1").map((t) => `${t.id}:v2`)];
    const steps = [];
    const skipped = [];
    for (const step of wanted) {
      const [id, variant] = step.split(":");
      if (!this.tasks.some((t) => t.id === id)) continue;
      if (this.patchFor(id, variant ?? "v1")) steps.push(step);
      else skipped.push(step);
    }
    const row = { name: "integration", status: "pass", applied: steps.length, skipped, failures: [], note: "" };
    if (steps.length === 0) return { ...row, status: "missing" };
    const repo = await this.newRepo();
    try {
      const chain = await this.applyChain(repo, steps);
      if (!chain.ok) return { ...row, status: "fail", note: `${chain.failedStep} does not apply: ${chain.error}` };
      const v = await runVerify(repo.dir, this.policy);
      if (!v.pass) {
        return { ...row, status: "fail", failures: v.failures, note: v.failures.length ? "verify failed" : v.output.trim().split("\n").slice(-6).join(" | ") };
      }
      row.note = `${steps.length} patches, verify ${v.ms} ms`;
      return row;
    } finally {
      repo.cleanup();
    }
  }

  // Recall behaviour the demo relies on, checked on the real patches:
  //  cascade: sloppy-a's revert conflicts once kelvin-first landed after it, and reverting kelvin-first first fixes that.
  //  clean:   sloppy-b's revert does not conflict with the category tasks that only read length.ts.
  async checkRecall(kind) {
    const spec =
      kind === "cascade"
        ? { name: "recall:cascade", steps: ["sloppy-a", "kelvin-first:v2"], target: "sloppy-a", dependents: ["kelvin-first:v2"] }
        : { name: "recall:clean", steps: ["sloppy-b", "cat-area", "cat-volume", "cat-speed"], target: "sloppy-b", dependents: [] };
    const row = { name: spec.name, status: "pass", failures: [], note: "" };
    if (!spec.steps.every((s) => this.tasks.some((t) => t.id === s.split(":")[0]))) return { ...row, status: "missing" };
    const repo = await this.newRepo();
    try {
      const chain = await this.applyChain(repo, spec.steps);
      if (chain.missing) return { ...row, status: "missing", note: `${chain.missing} is missing` };
      if (!chain.ok) return { ...row, status: "fail", note: `${chain.failedStep} does not apply: ${chain.error}` };
      const target = chain.shas[spec.target];
      const first = await git(repo.dir, ["revert", "--no-edit", target]);
      if (kind === "cascade") {
        if (first.code === 0) return { ...row, status: "fail", note: "revert of the target did not conflict, so there is no cascade" };
        await git(repo.dir, ["revert", "--abort"]);
        for (const dep of spec.dependents) {
          const r = await git(repo.dir, ["revert", "--no-edit", chain.shas[dep]]);
          if (r.code !== 0) return { ...row, status: "fail", note: `reverting dependent ${dep} failed` };
        }
        const second = await git(repo.dir, ["revert", "--no-edit", target]);
        if (second.code !== 0) return { ...row, status: "fail", note: "target revert still conflicts after the dependents were reverted" };
      } else if (first.code !== 0) {
        await git(repo.dir, ["revert", "--abort"]);
        return { ...row, status: "fail", note: "revert of the target conflicts with a dependent that should be non-conflicting" };
      }
      const v = await runVerify(repo.dir, this.policy);
      if (!v.pass) return { ...row, status: "fail", failures: v.failures, note: "verify fails after the recall" };
      row.note = kind === "cascade" ? "revert conflicts, cascade resolves it" : "revert is clean, dependents survive";
      return row;
    } finally {
      repo.cleanup();
    }
  }
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function rowOf(name, r) {
  let status;
  if (r.verify === "missing") status = "missing";
  else if (!r.applied) status = "fail";
  else if (r.verify === "fail" || r.problems.length) status = "fail";
  else status = "pass";
  const note = [...r.problems, ...(r.failures.length ? [`failing: ${r.failures.slice(0, 3).join("; ")}`] : []), r.detail ?? ""].filter(Boolean).join(" | ");
  return { name, status, note, failures: r.failures };
}

async function checkAll(demo, { concurrency }) {
  const jobs = [];
  for (const task of demo.tasks) {
    // The tamper patch is meant to be refused by the platform, so the tool only proves that it applies.
    jobs.push(async () => rowOf(task.id, await demo.checkPatch(task.id, { verify: task.expect !== "reject_protected" })));
    if (task.v2) {
      const on = task.v2_after ?? [];
      jobs.push(async () => {
        const missingBase = on.find((id) => !demo.patchFor(id, "v1"));
        if (missingBase) return { name: `${task.id} v2`, status: "missing", note: `base ${missingBase} is missing`, failures: [] };
        return rowOf(`${task.id} v2`, await demo.checkPatch(task.id, { variant: "v2", on }));
      });
    }
  }
  jobs.push(async () => demo.checkIntegration());
  jobs.push(async () => demo.checkRecall("cascade"));
  jobs.push(async () => demo.checkRecall("clean"));
  return pool(jobs, concurrency, (job) => job());
}

function printTable(rows) {
  const width = Math.max(...rows.map((r) => r.name.length), 4);
  for (const r of rows) console.log(`${r.name.padEnd(width)}  ${r.status.padEnd(7)}  ${r.note ?? ""}`);
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\n${count("pass")} pass, ${count("fail")} fail, ${count("missing")} missing`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const demoDir = flags.demo ? path.resolve(flags.demo) : path.resolve(here, "..");
  const demo = new Demo(demoDir, Boolean(flags.keep));
  const [cmd, id] = positional;

  if (cmd === "seed") {
    const r = await demo.checkSeed();
    console.log(JSON.stringify({ seed: r.seed, ms: r.ms, tests: r.tests, ...(r.seed === "fail" ? { failures: r.failures } : {}) }));
    if (r.seed !== "pass") {
      console.error(r.output.trim().split("\n").slice(-20).join("\n"));
      process.exit(1);
    }
    return;
  }

  if (cmd === "patch") {
    if (!id) throw new Error("usage: check.mjs patch <id> [--v2] [--on <id>[:v2],…]");
    const task = demo.task(id);
    const variant = flags.v2 ? "v2" : "v1";
    if (variant === "v2" && !task.v2) throw new Error(`${id} has no v2 patch`);
    // A v2 patch is written against the state its predecessors leave, so default to that base.
    const on = flags.on ? String(flags.on).split(",").filter(Boolean) : variant === "v2" ? (task.v2_after ?? []) : [];
    const r = await demo.checkPatch(id, { variant, on });
    const ok = r.applied && r.verify === "pass" && r.problems.length === 0;
    console.log(JSON.stringify({ id, applied: r.applied, verify: r.verify, failures: r.failures, ms: r.ms, ...(r.problems.length ? { problems: r.problems } : {}), ...(r.detail ? { detail: r.detail } : {}) }));
    if (!ok) process.exit(1);
    return;
  }

  if (cmd === "all") {
    const rows = await checkAll(demo, { concurrency: Number(flags.concurrency ?? Math.min(4, os.cpus().length)) });
    if (flags.json) console.log(JSON.stringify(rows, null, 2));
    else printTable(rows);
    const bad = rows.some((r) => r.status === "fail" || (flags.strict && r.status === "missing"));
    if (bad) process.exit(1);
    return;
  }

  throw new Error("usage: check.mjs seed | patch <id> [--v2] [--on …] | all [--strict] [--json]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
