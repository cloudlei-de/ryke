// Claude agent mode (PLAN.md §10.4, §7.2, §4.4, M8): the three Claude Code hooks, the settings and prompt
// they ship with, agent.sh (the runner job), the fake `claude`, the harness side that starts the job,
// and one end-to-end run of the stub against a real local stack.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startStack } from "../../dev/stack.mjs";
import { acquire, handle as intendWrite } from "../../containers/runner/hooks/intend-write.mjs";
import { handle as recordWrite } from "../../containers/runner/hooks/record-write.mjs";
import { handle as readsHook } from "../../containers/runner/hooks/reads.mjs";
import * as H from "../../containers/runner/hooks/common.mjs";
import { LEASE_PATIENCE_MS, loadConfig, repoPath, runHook, touchedPaths } from "../../containers/runner/hooks/common.mjs";
import * as Agent from "../../containers/runner/lib/agent.mjs";
import {
  claudeArgs,
  agentEnv,
  describeEvent,
  fillPrompt,
  inputsFrom,
  installHooks,
  mergeHooks,
  outcomeOf,
  PLACEHOLDER_KEY,
  renderCriteria,
  retryNotice,
  RETRY_FAILED,
  RETRY_STALE,
} from "../../containers/runner/lib/agent.mjs";
import * as Claude from "../../harness/agents/claude.mjs";
import { follow, relayable, runnerClient, runTask, STUB_BIN, STUB_BINS, STUB_MODEL, validateKey } from "../../harness/agents/claude.mjs";
import { parseSwarmArgs } from "../../harness/swarm.mjs";
import { chooseVariant, describePatch, fill, hooksFor, matches, parseArgv, subjectOf } from "../../harness/agents/claude-stub/claude.mjs";
import { client } from "../../harness/lib/client.mjs";
import { Workspace } from "../../harness/lib/gitops.mjs";
import { loadCatalogue } from "../../harness/lib/tasks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SETTINGS = join(ROOT, "containers/runner/claude/settings.json");
const PROMPT = join(ROOT, "containers/runner/prompt.md");
const AGENT_SH = join(ROOT, "containers/runner/bin/agent.sh");
const DEMO = join(ROOT, "demo/convert");

const exec = promisify(execFile);
const tmp = mkdtempSync(join(tmpdir(), "ryke-claude-mode-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;
const fresh = (name) => join(tmp, `${name}-${++counter}`);

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

// Real git, isolated from the caller's configuration. NODE_TEST_CONTEXT must not leak into children:
// a nested `node --test` that inherits it reports to this run and exits 0 even when tests fail.
const BASE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
delete BASE_ENV.NODE_TEST_CONTEXT;
const GIT_ENV = { ...BASE_ENV, GIT_AUTHOR_NAME: "seed", GIT_AUTHOR_EMAIL: "seed@example.com", GIT_COMMITTER_NAME: "seed", GIT_COMMITTER_EMAIL: "seed@example.com" };
const git = (cwd, ...argv) => execFileSync("git", argv, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const tasks = JSON.parse(readFileSync(join(DEMO, "tasks.json"), "utf8"));
const byId = (id) => tasks.find((t) => t.id === id);

let seedDir;
// The trunk of the Convert demo exactly as the seed job builds it (containers/runner/lib/seed.mjs).
function seed() {
  if (seedDir) return seedDir;
  seedDir = fresh("seed");
  cpSync(DEMO, seedDir, { recursive: true, filter: (src) => !["tools", "solutions", "tasks.json"].includes(relative(DEMO, src).split(sep)[0]) });
  git(seedDir, "init", "-q", "-b", "main");
  git(seedDir, "add", "-A");
  git(seedDir, "commit", "-q", "-m", "Seed convert");
  return seedDir;
}

const cloneWorking = (name) => {
  const dir = fresh(name);
  git(tmp, "clone", "-q", seed(), dir);
  return dir;
};
const cloneBare = (name) => {
  const dir = `${fresh(name)}.git`;
  git(tmp, "clone", "-q", "--bare", seed(), dir);
  return dir;
};

// Lands t-precision's v1 patch on a bare trunk the way the lander would: one commit, subject = the intent cut at 72.
function advanceTrunk(trunk) {
  const work = fresh("advance");
  git(tmp, "clone", "-q", trunk, work);
  const t = byId("t-precision");
  git(work, "apply", "--3way", join(DEMO, t.solution));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", subjectOf(t.intent));
  git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  return git(work, "rev-parse", "HEAD");
}

// One more commit on a bare trunk that touches only its own file, so it can never conflict with an agent's work.
function commitOnTrunk(trunk, path, text) {
  const work = fresh("advance");
  git(tmp, "clone", "-q", trunk, work);
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), text);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", `trunk: ${path}`);
  git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  return git(work, "rev-parse", "HEAD");
}

// A tiny HTTP server. A route is "METHOD /path"; its handler gets { body, query, auth } and the 1-based
// call number, and returns JSON, [status, json], or { raw, headers } for text.
async function fakeServer(routes = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const key = `${req.method} ${url.pathname}`;
    const call = { key, body: raw ? JSON.parse(raw) : null, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, headers: req.headers };
    calls.push(call);
    const handler = routes[key];
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `no route ${key}` }));
    }
    const out = await handler(call, calls.filter((c) => c.key === key).length);
    if (out && typeof out === "object" && "raw" in out) {
      res.writeHead(200, { "content-type": "text/plain", ...out.headers });
      return res.end(out.raw);
    }
    const [status, json] = Array.isArray(out) && typeof out[0] === "number" ? out : [200, out];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    of: (key) => calls.filter((c) => c.key === key),
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
  };
}

// A throwaway server that every test of a group can share; closed with the group.
function servers() {
  const open = [];
  return {
    async start(routes) {
      const s = await fakeServer(routes);
      open.push(s);
      return s;
    },
    async closeAll() {
      await Promise.all(open.map((s) => s.close()));
    },
  };
}

// The agent's checkout, as agent.mjs leaves it before Claude runs: a git repo at the snapshot.
function checkoutWith(files) {
  const dir = fresh("checkout");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "snapshot");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

const FORMAT_V1 = 'export function formatValue(n: number, digits = 2): string {\n  return n.toFixed(digits);\n}\n';
const FORMAT_V2 = 'export function formatValue(n: number, digits = 3): string {\n  return n.toFixed(digits);\n}\n';

function hookEnv(api, co, extra = {}) {
  return { RYKE_API_URL: api, RYKE_TOKEN: "tok", RYKE_TXN: "t_1", RYKE_REPO: "convert", RYKE_CHECKOUT: co.dir, RYKE_SNAPSHOT: co.sha, ...extra };
}

// Drives a hook module the way Claude Code does: JSON on stdin, whatever it prints on stdout.
async function drive(handle, input, env) {
  let stdout = "";
  const stderr = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => (stderr.push(String(chunk)), true);
  try {
    await runHook(handle, { stdin: Readable.from([JSON.stringify(input)]), stdout: { write: (s) => (stdout += s) }, env });
  } finally {
    process.stderr.write = realWrite;
  }
  return { stdout, stderr: stderr.join("") };
}

const readPayload = (co, file = "src/format.ts") => ({
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  cwd: co.dir,
  tool_input: { file_path: join(co.dir, file) },
  tool_response: { type: "text", file: { filePath: join(co.dir, file), content: "x", numLines: 1, startLine: 1, totalLines: 1 } },
});
const editPayload = (co, tool = "Edit", file = "src/format.ts") => ({
  hook_event_name: tool === "Read" ? "PostToolUse" : "PreToolUse",
  tool_name: tool,
  cwd: co.dir,
  tool_input: { file_path: join(co.dir, file), old_string: "a", new_string: "b" },
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const until = async (fn, ms = 20_000, what = "condition") => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

// What git sees as changed in an agent checkout, without the scaffolding that is never part of a change.
const dirty = (dir) => git(dir, "status", "--porcelain").split("\n").filter((l) => l && !/^\?\? \.(ryke|claude)\/$/.test(l));

const lines = (text) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l));

// A killed process whose parent has not reaped it yet still answers signal 0.
function isRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// settings.json and prompt.md
// ---------------------------------------------------------------------------------------------

describe("shipped configuration", () => {
  const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));

  it("prompt.md is the prompt of PLAN.md §10.4, word for word", () => {
    const plan = readFileSync(join(ROOT, "PLAN.md"), "utf8");
    const block = /Agent prompt for claude mode \(`containers\/runner\/prompt\.md`\):\s*```\n([\s\S]*?)\n```/.exec(plan);
    assert.ok(block, "PLAN.md no longer has the prompt block this test reads");
    assert.equal(readFileSync(PROMPT, "utf8").trim(), block[1].trim());
  });

  it("prompt-codex.md is that prompt with the lines about Claude's Read tool and hooks swapped for how Codex's reads are tracked", () => {
    const claude = readFileSync(PROMPT, "utf8").split("\n");
    const codex = readFileSync(join(ROOT, "containers/runner/prompt-codex.md"), "utf8").split("\n");
    const only = (a, b) => a.filter((l) => !b.includes(l));
    assert.deepEqual(only(claude, codex), [
      "Rules: work only inside this checkout. Read files with the Read tool so Ryke can track your reads.",
      "If a hook tells you a file changed on trunk since you read it, re-read it and adapt.",
    ]);
    assert.deepEqual(only(codex, claude), [
      "Rules: work only inside this checkout. Ryke tracks your reads from the commands you run, so open each",
      "file you use by its path relative to the checkout (`cat src/a.ts`, `sed -n 1,80p src/a.ts`, `rg -n name src`).",
    ]);
    const filled = fillPrompt(codex.join("\n"), { agent: "A", repo: "R", intent: "I", criteria: "C", verify: "V" });
    assert.doesNotMatch(filled, /\{\{/);
    assert.match(filled, /^Intent: I$/m, "the stubs find their task by this line");
  });

  it("prompt.md only uses the placeholders agent.mjs fills", () => {
    const filled = fillPrompt(readFileSync(PROMPT, "utf8"), { agent: "A", repo: "R", intent: "I", criteria: "C", verify: "V" });
    assert.doesNotMatch(filled, /\{\{/);
    assert.match(filled, /agent A working in a Ryke transaction on repo R\./);
    assert.match(filled, /make sure `V` passes/);
  });

  // [event, tool, scripts that must run, in this order]
  const WIRING = [
    ["PostToolUse", "Read", ["reads.mjs"]],
    ["PostToolUse", "Grep", ["reads.mjs"]],
    ["PostToolUse", "Glob", ["reads.mjs"]],
    ["PostToolUse", "Edit", ["record-write.mjs"]],
    ["PostToolUse", "Write", ["record-write.mjs"]],
    ["PostToolUse", "MultiEdit", ["record-write.mjs"]],
    ["PreToolUse", "Edit", ["intend-write.mjs"]],
    ["PreToolUse", "Write", ["intend-write.mjs"]],
    ["PreToolUse", "MultiEdit", ["intend-write.mjs"]],
    ["PreToolUse", "Read", []],
    ["PostToolUse", "Bash", []],
    ["PreToolUse", "Bash", []],
    ["PostToolUse", "NotebookEdit", []],
  ];
  for (const [event, tool, scripts] of WIRING) {
    it(`${event} on ${tool} runs ${scripts.join(", ") || "nothing"}`, () => {
      const found = hooksFor(settings, event, tool).map((h) => /hooks\/([\w-]+\.mjs)/.exec(h.command)?.[1]);
      assert.deepEqual(found, scripts);
    });
  }

  it("every command is a command hook for a script that exists, with a timeout above the 90 s lease wait", () => {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          assert.equal(h.type, "command");
          const file = /\$RYKE_ROOT\/(containers\/runner\/hooks\/[\w-]+\.mjs)/.exec(h.command)?.[1];
          assert.ok(file && existsSync(join(ROOT, file)), `${event}: ${h.command}`);
          assert.ok(h.timeout > 0, `${event} ${file} has no timeout`);
          if (file.endsWith("intend-write.mjs")) assert.ok(h.timeout > LEASE_PATIENCE_MS / 1000, "the hook would be cut off before its own patience runs out");
        }
      }
    }
  });

  it("every hook has a time budget under its timeout, so it answers before Claude Code kills it", () => {
    for (const groups of Object.values(settings.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          const script = /hooks\/([\w-]+\.mjs)/.exec(h.command)[1];
          const budget = H.HOOK_BUDGET_MS?.[script];
          assert.ok(budget > 0, `${script} has no budget`);
          assert.ok(budget < h.timeout * 1000, `${script}: ${budget} ms budget against a ${h.timeout} s timeout`);
        }
      }
    }
    assert.ok(H.HOOK_BUDGET_MS["intend-write.mjs"] >= LEASE_PATIENCE_MS + 30_000, "after the lease wait there must be time left to poll for stale reads");
  });

  it("runs the shipped commands through a shell like Claude Code does", async () => {
    const api = await fakeServer({ "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [] }) });
    try {
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const [hook] = hooksFor(settings, "PostToolUse", "Read");
      const child = spawn("sh", ["-c", hook.command], { cwd: co.dir, env: { ...BASE_ENV, RYKE_ROOT: ROOT, ...hookEnv(api.url, co) } });
      child.stdin.end(JSON.stringify(readPayload(co)));
      const code = await new Promise((r) => child.on("close", r));
      assert.equal(code, 0);
      assert.deepEqual(api.of("POST /api/txns/t_1/reads").map((c) => c.body), [{ paths: ["src/format.ts"] }]);
    } finally {
      await api.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Hooks: paths
// ---------------------------------------------------------------------------------------------

describe("hook paths", () => {
  const co = checkoutWith({ "src/format.ts": FORMAT_V1, "src/a.ts": "export const a = 1;\n", "src/ui/layout.ts": "x\n", ".ryke/x": "x\n", ".claude/settings.json": "{}\n", "node_modules/m/i.js": "x\n" });
  // Force-added files above are committed; the paths below only need to exist.
  const cfg = loadConfig({ RYKE_CHECKOUT: co.dir }, { cwd: co.dir });
  const abs = (p) => join(co.dir, p);

  it("repoPath makes posix paths relative to the checkout and refuses everything that is not a repo file", () => {
    const rows = [
      [abs("src/format.ts"), "src/format.ts"],
      ["src/format.ts", "src/format.ts"],
      ["./src/../src/format.ts", "src/format.ts"],
      [abs("src/ui/layout.ts"), "src/ui/layout.ts"],
      [co.dir, null],
      ["/etc/passwd", null],
      ["../elsewhere.ts", null],
      [abs("../elsewhere.ts"), null],
      [abs(".git/config"), null],
      [abs(".claude/settings.json"), null],
      [abs(".ryke/reads.jsonl"), null],
      [abs("node_modules/m/i.js"), null],
      [abs(".gitignore"), ".gitignore"],
      [abs("src/.ryke-notes.ts"), "src/.ryke-notes.ts"],
      ["", null],
      [undefined, null],
      [42, null],
    ];
    for (const [raw, want] of rows) assert.equal(repoPath(raw, cfg), want, String(raw));
  });

  it("repoPath resolves relative paths against the hook's cwd and sees through a symlinked checkout", () => {
    assert.equal(repoPath("format.ts", { ...cfg, cwd: abs("src") }), "src/format.ts");
    const link = fresh("link");
    execFileSync("ln", ["-s", co.dir, link]);
    assert.equal(repoPath(abs("src/format.ts"), { ...cfg, checkout: link }), "src/format.ts");
    assert.equal(repoPath(join(link, "src/format.ts"), cfg), "src/format.ts");
  });

  // V7: Grep and Glob record the files they matched, never the pattern.
  const response = (extra) => ({ tool_response: extra });
  const TOUCHED = [
    ["Read, absolute path", { tool_name: "Read", tool_input: { file_path: abs("src/format.ts") } }, ["src/format.ts"]],
    ["Read, relative path", { tool_name: "Read", tool_input: { file_path: "src/format.ts" } }, ["src/format.ts"]],
    ["Read, only the response names the file", { tool_name: "Read", tool_input: {}, ...response({ type: "text", file: { filePath: abs("src/a.ts") } }) }, ["src/a.ts"]],
    ["Read outside the checkout", { tool_name: "Read", tool_input: { file_path: "/etc/hostname" } }, []],
    ["Read of ryke's own state", { tool_name: "Read", tool_input: { file_path: abs(".ryke/x") } }, []],
    ["Read with nothing to go on", { tool_name: "Read", tool_input: {} }, []],
    ["Glob, relative names", { tool_name: "Glob", tool_input: { pattern: "src/**/*.ts" }, ...response({ numFiles: 2, filenames: ["src/a.ts", "src/format.ts"] }) }, ["src/a.ts", "src/format.ts"]],
    ["Glob, absolute names with a duplicate and a stranger", { tool_name: "Glob", tool_input: { pattern: "**" }, ...response({ filenames: [abs("src/a.ts"), "src/a.ts", "/tmp/else"] }) }, ["src/a.ts"]],
    ["Glob without matches", { tool_name: "Glob", tool_input: { pattern: "nothing" }, ...response({ numFiles: 0, filenames: [] }) }, []],
    ["Grep, files_with_matches", { tool_name: "Grep", tool_input: { pattern: "digits" }, ...response({ mode: "files_with_matches", numFiles: 1, filenames: [abs("src/format.ts")] }) }, ["src/format.ts"]],
    [
      "Grep, content mode lists the files in the text",
      { tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content" }, ...response({ mode: "content", numFiles: 0, filenames: [], content: `${abs("src/format.ts")}:1:export function\nsrc/a.ts:3:const a\nnot a path:12:code that looks like a hit` }) },
      ["src/format.ts", "src/a.ts"],
    ],
    ["Grep, content mode on one file prints no names", { tool_name: "Grep", tool_input: { pattern: "x", path: abs("src/a.ts"), output_mode: "content" }, ...response({ mode: "content", numFiles: 0, filenames: [], content: "1:export const a = 1;" }) }, ["src/a.ts"]],
    [
      "Grep, count mode names its files in the text, as path:count",
      { tool_name: "Grep", tool_input: { pattern: "x", output_mode: "count" }, ...response({ mode: "count", numFiles: 0, filenames: [], content: `src/format.ts:2\n${abs("src/a.ts")}:1\nnot a file:3\nsrc/ghost.ts:4\n\nFound 10 total occurrences across 4 files.` }) },
      ["src/format.ts", "src/a.ts"],
    ],
    ["Grep, count mode on one file prints only the count", { tool_name: "Grep", tool_input: { pattern: "x", path: abs("src/a.ts"), output_mode: "count" }, ...response({ mode: "count", numFiles: 0, filenames: [], content: "3" }) }, ["src/a.ts"]],
    [
      "Grep, content mode without line numbers prints path:text, believed only for files that exist",
      {
        tool_name: "Grep",
        tool_input: { pattern: "x", output_mode: "content", "-n": false },
        ...response({ mode: "content", numFiles: 0, filenames: [], content: `src/format.ts:export function formatValue\n${abs("src/a.ts")}:export const a: number = 1;\nsrc/ghost.ts:const b = 2;\nplain text: with a colon\nno colon at all` }),
      },
      ["src/format.ts", "src/a.ts"],
    ],
    ["Grep of one file with no hit is not a read of it", { tool_name: "Grep", tool_input: { pattern: "zzz", path: abs("src/a.ts") }, ...response({ mode: "content", numFiles: 0, filenames: [], content: "" }) }, []],
    ["Grep of a directory names only the matches", { tool_name: "Grep", tool_input: { pattern: "digits", path: abs("src") }, ...response({ numFiles: 1, filenames: ["src/format.ts"] }) }, ["src/format.ts"]],
    ["Bash is not a read", { tool_name: "Bash", tool_input: { command: "cat src/format.ts" }, ...response({ stdout: "x" }) }, []],
    ["Edit is not a read", { tool_name: "Edit", tool_input: { file_path: abs("src/format.ts") } }, []],
  ];
  for (const [name, input, want] of TOUCHED) {
    it(`touchedPaths: ${name}`, () => {
      assert.deepEqual(touchedPaths({ cwd: co.dir, ...input }, cfg), want);
    });
  }
});

describe("hook configuration", () => {
  it("defaults to the 90 s of PLAN.md §7.2 and reads everything from the environment", () => {
    assert.equal(LEASE_PATIENCE_MS, 90_000);
    const cfg = loadConfig({ RYKE_API_URL: "http://x:1///", RYKE_TOKEN: "t", RYKE_TXN: "t_9", RYKE_REPO: "r", RYKE_CHECKOUT: "/w/c", RYKE_SNAPSHOT: "abcdef0123" });
    assert.deepEqual(
      { api: cfg.api, token: cfg.token, txn: cfg.txn, repo: cfg.repo, checkout: cfg.checkout, snapshot: cfg.snapshot, patienceMs: cfg.patienceMs, contention: cfg.contention },
      { api: "http://x:1", token: "t", txn: "t_9", repo: "r", checkout: "/w/c", snapshot: "abcdef0123", patienceMs: 90_000, contention: true },
    );
  });

  it("honours the test knobs, ignoring garbage, and falls back from RYKE_CHECKOUT to CLAUDE_PROJECT_DIR to the payload's cwd", () => {
    assert.equal(loadConfig({ RYKE_LEASE_PATIENCE_MS: "250" }).patienceMs, 250);
    assert.equal(loadConfig({ RYKE_LEASE_PATIENCE_MS: "soon" }).patienceMs, 90_000);
    assert.equal(loadConfig({ RYKE_LEASE_PATIENCE_MS: "" }).patienceMs, 90_000);
    assert.equal(loadConfig({ RYKE_HOOK_TIMEOUT_MS: "75" }).timeoutMs, 75);
    assert.equal(loadConfig({ RYKE_CONTENTION: "off" }).contention, false);
    assert.equal(loadConfig({ RYKE_CONTENTION: "on" }).contention, true);
    assert.equal(loadConfig({ RYKE_CHECKOUT: "/a", CLAUDE_PROJECT_DIR: "/b" }, { cwd: "/c" }).checkout, "/a");
    assert.equal(loadConfig({ CLAUDE_PROJECT_DIR: "/b" }, { cwd: "/c" }).checkout, "/b");
    assert.equal(loadConfig({}, { cwd: "/c" }).checkout, "/c");
    assert.equal(loadConfig({}, {}).snapshot, "HEAD");
  });
});

// ---------------------------------------------------------------------------------------------
// Hooks: reads
// ---------------------------------------------------------------------------------------------

describe("reads hook (PostToolUse on Read, Grep, Glob)", () => {
  const s = servers();
  after(() => s.closeAll());

  it("reports the file to POST /reads with the bearer token and keeps a local record", async () => {
    const api = await s.start({ "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [] }) });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const { stdout } = await drive(readsHook, readPayload(co), hookEnv(api.url, co));
    assert.equal(stdout, "", "nothing stale, so nothing to say to the agent");
    const [call] = api.of("POST /api/txns/t_1/reads");
    assert.deepEqual(call.body, { paths: ["src/format.ts"] });
    assert.equal(call.auth, "Bearer tok");
    const [record] = lines(readFileSync(join(co.dir, ".ryke/reads.jsonl"), "utf8"));
    assert.deepEqual({ tool: record.tool, paths: record.paths }, { tool: "Read", paths: ["src/format.ts"] });
  });

  it("batches a Grep that matched 1,200 files into calls of at most 500, as the API requires", async () => {
    const api = await s.start({ "POST /api/txns/t_1/reads": () => ({ recorded: 0, staleWarnings: [] }) });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const names = Array.from({ length: 1200 }, (_, i) => `src/gen/f${i}.ts`);
    const input = { hook_event_name: "PostToolUse", tool_name: "Grep", cwd: co.dir, tool_input: { pattern: "x" }, tool_response: { mode: "files_with_matches", numFiles: 1200, filenames: names } };
    await drive(readsHook, input, hookEnv(api.url, co));
    const sizes = api.of("POST /api/txns/t_1/reads").map((c) => c.body.paths.length);
    assert.deepEqual(sizes, [500, 500, 200]);
    assert.deepEqual(api.of("POST /api/txns/t_1/reads").flatMap((c) => c.body.paths), names);
  });

  it("reports the matched files of a Glob and not its pattern", async () => {
    const api = await s.start({ "POST /api/txns/t_1/reads": () => ({ recorded: 2, staleWarnings: [] }) });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const input = { hook_event_name: "PostToolUse", tool_name: "Glob", cwd: co.dir, tool_input: { pattern: "src/**/*.ts" }, tool_response: { numFiles: 2, filenames: ["src/format.ts", join(co.dir, "src/index.ts")], truncated: false } };
    await drive(readsHook, input, hookEnv(api.url, co));
    assert.deepEqual(api.of("POST /api/txns/t_1/reads").map((c) => c.body.paths), [["src/format.ts", "src/index.ts"]]);
  });

  it("says nothing and calls nothing when the tool touched no repo file", async () => {
    const api = await s.start({ "POST /api/txns/t_1/reads": () => ({ recorded: 0, staleWarnings: [] }) });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const input = { hook_event_name: "PostToolUse", tool_name: "Glob", cwd: co.dir, tool_input: { pattern: "zzz" }, tool_response: { numFiles: 0, filenames: [] } };
    const { stdout } = await drive(readsHook, input, hookEnv(api.url, co));
    assert.equal(stdout, "");
    assert.equal(api.calls.length, 0);
    assert.equal(existsSync(join(co.dir, ".ryke/reads.jsonl")), false);
  });

  describe("stale warnings", () => {
    const warning = { path: "src/format.ts", seq: 4, by: "t_k3x9a1b2" };

    it("returns them in the documented PostToolUse shape, with the change on trunk as a diff", async () => {
      const api = await s.start({
        "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [warning] }),
        "GET /api/repos/convert/files": () => ({ ref: "r", path: "src/format.ts", content: FORMAT_V2 }),
      });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const { stdout } = await drive(readsHook, readPayload(co), hookEnv(api.url, co));
      const reply = JSON.parse(stdout);
      assert.deepEqual(Object.keys(reply), ["hookSpecificOutput"]);
      assert.deepEqual(Object.keys(reply.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
      assert.equal(reply.hookSpecificOutput.hookEventName, "PostToolUse");
      const text = reply.hookSpecificOutput.additionalContext;
      assert.match(text, /a file you read changed on trunk after your snapshot/);
      assert.match(text, /- src\/format\.ts, changed by t_k3x9a1b2 at trunk seq 4/);
      assert.match(text, /still at the snapshot, so Read, Grep and Glob show the old version/);
      // What really happens at the end of the session: the change is moved onto trunk, not aborted as stale.
      assert.match(text, /Adapt your edits to what trunk has now\. When you stop, Ryke moves your change onto the current trunk and submits it there/);
      assert.match(text, /starts you again from the new trunk with these changes/);
      assert.doesNotMatch(text, /aborts the transaction as stale|will be rebased|re-read it/);
      assert.match(text, /^--- a\/src\/format\.ts\n\+\+\+ b\/src\/format\.ts$/m);
      assert.match(text, /^-export function formatValue\(n: number, digits = 2\)/m);
      assert.match(text, /^\+export function formatValue\(n: number, digits = 3\)/m);
      assert.ok(text.length < 10_000, "Claude Code cuts longer additionalContext off");
      assert.equal(api.of("GET /api/repos/convert/files")[0].query.path, "src/format.ts");
    });

    it("still warns, without a diff, when trunk's file cannot be fetched", async () => {
      const api = await s.start({
        "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [warning] }),
        "GET /api/repos/convert/files": () => [503, { error: "store down" }],
      });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const { stdout, stderr } = await drive(readsHook, readPayload(co), hookEnv(api.url, co));
      const text = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert.match(text, /src\/format\.ts, changed by t_k3x9a1b2/);
      assert.doesNotMatch(text, /^@@/m);
      assert.match(stderr, /no diff for src\/format\.ts/);
    });

    it("describes a file that trunk deleted as a diff against nothing", async () => {
      const api = await s.start({
        "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [warning] }),
        "GET /api/repos/convert/files": () => [404, { error: "no file" }],
      });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const text = JSON.parse((await drive(readsHook, readPayload(co), hookEnv(api.url, co))).stdout).hookSpecificOutput.additionalContext;
      assert.match(text, /^-export function formatValue/m);
    });

    it("announces each (path, seq) once per attempt and a newer change to the same path again", async () => {
      let seq = 4;
      const api = await s.start({
        "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [{ ...warning, seq }] }),
        "GET /api/repos/convert/files": () => ({ content: FORMAT_V2 }),
      });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const env = hookEnv(api.url, co);
      assert.match((await drive(readsHook, readPayload(co), env)).stdout, /trunk seq 4/);
      assert.equal((await drive(readsHook, readPayload(co), env)).stdout, "", "the same warning twice teaches the agent to ignore it");
      seq = 9;
      assert.match((await drive(readsHook, readPayload(co), env)).stdout, /trunk seq 9/);
    });

    it("names every stale file when several changed", async () => {
      const api = await s.start({
        "POST /api/txns/t_1/reads": () => ({ recorded: 2, staleWarnings: [warning, { path: "src/ui/layout.ts", seq: 6, by: "t_other" }] }),
        "GET /api/repos/convert/files": () => ({ content: "changed\n" }),
      });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1, "src/ui/layout.ts": "old\n" });
      const text = JSON.parse((await drive(readsHook, readPayload(co), hookEnv(api.url, co))).stdout).hookSpecificOutput.additionalContext;
      assert.match(text, /2 files you read changed on trunk/);
      assert.match(text, /- src\/format\.ts, changed by t_k3x9a1b2 at trunk seq 4/);
      assert.match(text, /- src\/ui\/layout\.ts, changed by t_other at trunk seq 6/);
    });

    it("works without a recorded author", async () => {
      const api = await s.start({
        "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [{ path: "src/format.ts", seq: 2 }] }),
        "GET /api/repos/convert/files": () => ({ content: FORMAT_V2 }),
      });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const text = JSON.parse((await drive(readsHook, readPayload(co), hookEnv(api.url, co))).stdout).hookSpecificOutput.additionalContext;
      assert.match(text, /- src\/format\.ts at trunk seq 2/);
    });
  });

  describe("time and concurrency", () => {
    const warning = { path: "src/format.ts", seq: 4, by: "t_k3x9a1b2" };
    const claude = (api, co, extra = {}) => hookEnv(api.url, co, extra);

    it("fetches the diffs of several files at once, not one after the other", async () => {
      const names = ["src/a.ts", "src/b.ts", "src/c.ts"];
      const api = await s.start({
        "POST /api/txns/t_1/reads": () => ({ recorded: 3, staleWarnings: names.map((path, i) => ({ path, seq: i + 1 })) }),
        "GET /api/repos/convert/files": async () => {
          await pause(500);
          return { content: "new\n" };
        },
      });
      const co = checkoutWith(Object.fromEntries(names.map((n) => [n, "old\n"])));
      const started = Date.now();
      const text = JSON.parse((await drive(readsHook, readPayload(co, "src/a.ts"), claude(api, co))).stdout).hookSpecificOutput.additionalContext;
      assert.ok(Date.now() - started < 1100, `took ${Date.now() - started} ms for three 500 ms fetches`);
      for (const n of names) assert.match(text, new RegExp(`^--- a/${n}`, "m"));
    });

    it("lets exactly one of two hooks that race announce a warning", async () => {
      const api = await s.start({
        "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [warning] }),
        "GET /api/repos/convert/files": async () => {
          await pause(200);
          return { content: FORMAT_V2 };
        },
      });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const input = readPayload(co);
      const cfg = loadConfig(claude(api, co), input);
      const replies = await Promise.all([readsHook(input, cfg), readsHook(input, cfg), readsHook(input, cfg)]);
      assert.equal(replies.filter(Boolean).length, 1, "the same warning three times teaches the agent to ignore it");
      assert.match(replies.find(Boolean), /trunk seq 4/);
    });

    it("announces only after the text is built: a hook killed on the way leaves the warning for the next one", async () => {
      let hang = true;
      const api = await s.start({
        "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [warning] }),
        "GET /api/repos/convert/files": () => (hang ? new Promise(() => {}) : { content: FORMAT_V2 }),
      });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const child = spawn(process.execPath, [join(ROOT, "containers/runner/hooks/reads.mjs")], { cwd: co.dir, env: { ...BASE_ENV, ...claude(api, co, { RYKE_HOOK_TIMEOUT_MS: "60000" }) }, stdio: ["pipe", "pipe", "ignore"] });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stdin.end(JSON.stringify(readPayload(co)));
      await until(() => api.of("GET /api/repos/convert/files").length > 0, 10_000, "the hook to ask for the diff");
      child.kill("SIGKILL");
      await new Promise((r) => child.on("close", r));
      assert.equal(stdout, "");
      hang = false;
      const second = JSON.parse((await drive(readsHook, readPayload(co), claude(api, co))).stdout);
      assert.match(second.hookSpecificOutput.additionalContext, /trunk seq 4/, "the killed hook announced nothing");
    });

    it("answers inside RYKE_HOOK_BUDGET_MS with the warning but no diff when the diff never arrives", { timeout: 15_000 }, async () => {
      const api = await s.start({ "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [warning] }), "GET /api/repos/convert/files": () => new Promise(() => {}) });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const started = Date.now();
      const { stdout } = await drive(readsHook, readPayload(co), claude(api, co, { RYKE_HOOK_BUDGET_MS: "700", RYKE_HOOK_TIMEOUT_MS: "60000" }));
      assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
      const text = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert.match(text, /src\/format\.ts, changed by t_k3x9a1b2/);
      assert.doesNotMatch(text, /^@@/m);
    });

    it("cannot wait on the Ledger for longer than the budget either", { timeout: 15_000 }, async () => {
      const api = await s.start({ "POST /api/txns/t_1/reads": () => new Promise(() => {}) });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const started = Date.now();
      const { stdout, stderr } = await drive(readsHook, readPayload(co), claude(api, co, { RYKE_HOOK_BUDGET_MS: "300", RYKE_HOOK_TIMEOUT_MS: "60000" }));
      assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
      assert.equal(stdout, "");
      assert.match(stderr, /failed open/);
    });

    it("claims each (path, seq) once, exclusively", () => {
      const co = checkoutWith({ "a.txt": "x\n" });
      const cfg = loadConfig({ RYKE_CHECKOUT: co.dir });
      const rows = [
        ["src/a.ts", 1, true],
        ["src/a.ts", 1, false],
        ["src/a.ts", 2, true],
        ["src/b.ts", 1, true],
        ["src/b.ts", 1, false],
        [`${"deep/".repeat(60)}file.ts`, 7, true],
      ];
      for (const [path, seq, want] of rows) assert.equal(H.claimAnnouncement(cfg, path, seq), want, `${path}@${seq}`);
      assert.equal(H.isAnnounced(cfg, "src/a.ts", 2), true);
      assert.equal(H.isAnnounced(cfg, "src/c.ts", 1), false);
    });
  });

  describe("failing open", () => {
    const FAILURES = [
      ["the API answers 500", () => [500, { error: "boom" }]],
      ["the API answers 401", () => [401, { error: "unauthorized" }]],
      ["the API answers 409 because the transaction left open", () => [409, { error: "transaction t_1 is submitted" }]],
    ];
    for (const [name, handler] of FAILURES) {
      it(`exits quietly when ${name}`, async () => {
        const api = await s.start({ "POST /api/txns/t_1/reads": handler });
        const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
        const { stdout, stderr } = await drive(readsHook, readPayload(co), hookEnv(api.url, co));
        assert.equal(stdout, "");
        assert.match(stderr, /ryke-hook: failed open: POST \/api\/txns\/t_1\/reads -> /);
        assert.equal(lines(readFileSync(join(co.dir, ".ryke/reads.jsonl"), "utf8")).length, 1, "the read is still on record for agent.mjs to re-send");
      });
    }

    it("exits quietly when nothing listens on the API port", async () => {
      const dead = await fakeServer();
      const url = dead.url;
      await dead.close();
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const { stdout, stderr } = await drive(readsHook, readPayload(co), hookEnv(url, co));
      assert.equal(stdout, "");
      assert.match(stderr, /failed open/);
    });

    it("gives up on a hung API after RYKE_HOOK_TIMEOUT_MS", async () => {
      const api = await s.start({ "POST /api/txns/t_1/reads": () => new Promise(() => {}) });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const started = Date.now();
      const { stdout, stderr } = await drive(readsHook, readPayload(co), hookEnv(api.url, co, { RYKE_HOOK_TIMEOUT_MS: "150" }));
      assert.equal(stdout, "");
      assert.match(stderr, /failed open/);
      assert.ok(Date.now() - started < 5000);
    });

    it("exits quietly on input that is not JSON", async () => {
      let out = "";
      const realWrite = process.stderr.write.bind(process.stderr);
      let err = "";
      process.stderr.write = (c) => ((err += c), true);
      try {
        await runHook(readsHook, { stdin: Readable.from(["{not json"]), stdout: { write: (s2) => (out += s2) }, env: {} });
      } finally {
        process.stderr.write = realWrite;
      }
      assert.equal(out, "");
      assert.match(err, /failed open/);
    });

    it("records the read locally and says so when the API is not configured", async () => {
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const { stdout, stderr } = await drive(readsHook, readPayload(co), { RYKE_CHECKOUT: co.dir });
      assert.equal(stdout, "");
      assert.match(stderr, /RYKE_API_URL or RYKE_TXN is not set/);
      assert.equal(lines(readFileSync(join(co.dir, ".ryke/reads.jsonl"), "utf8")).length, 1);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Hooks: intend-write (the lease, PLAN.md §7.2)
// ---------------------------------------------------------------------------------------------

describe("intend-write hook (PreToolUse on Edit, Write, MultiEdit)", () => {
  const s = servers();
  after(() => s.closeAll());
  const NO_STALE = { "POST /api/txns/t_1/reads": () => ({ recorded: 0, staleWarnings: [] }) };

  describe("acquire, on a fake clock", () => {
    // Each row: the answers the Ledger gives in turn, the patience, and what must happen.
    const ROWS = [
      ["granted at once", [{ go: true }], 90_000, { requests: 1, waits: [], gaveUp: false, waitedMs: 0 }],
      ["granted after the holder moves on", [{ go: false, owner: "t_a", retryAfterMs: 500 }, { go: false, owner: "t_a", retryAfterMs: 500 }, { go: true }], 90_000, { requests: 3, waits: [500, 500], gaveUp: false, waitedMs: 1000 }],
      ["waits exactly what the Ledger suggests", [{ go: false, owner: "t_a", retryAfterMs: 4321 }, { go: true }], 90_000, { requests: 2, waits: [4321], gaveUp: false, waitedMs: 4321 }],
      ["never waits less than the floor, whatever the Ledger says", [{ go: false, owner: "t_a", retryAfterMs: 0 }, { go: true }], 90_000, { requests: 2, waits: [50], gaveUp: false, waitedMs: 50 }],
      ["a missing retryAfterMs also gets the floor", [{ go: false, owner: "t_a" }, { go: true }], 90_000, { requests: 2, waits: [50], gaveUp: false, waitedMs: 50 }],
      ["gives up after 90 s in total and never waits past the deadline", Array.from({ length: 9 }, () => ({ go: false, owner: "t_a", retryAfterMs: 40_000 })), 90_000, { requests: 4, waits: [40_000, 40_000, 10_000], gaveUp: true, waitedMs: 90_000 }],
      ["gives up at once when the patience is zero", [{ go: false, owner: "t_a", retryAfterMs: 100 }], 0, { requests: 1, waits: [], gaveUp: true, waitedMs: 0 }],
      ["an answer that arrives exactly at the deadline still counts", [{ go: false, owner: "t_a", retryAfterMs: 1000 }, { go: true }], 1000, { requests: 2, waits: [1000], gaveUp: false, waitedMs: 1000 }],
    ];
    for (const [name, answers, patienceMs, want] of ROWS) {
      it(name, async () => {
        const api = await s.start({ "POST /api/txns/t_1/intend-write": (_c, n) => answers[Math.min(n, answers.length) - 1] });
        let clock = 0;
        const waits = [];
        // Giving up is remembered in the checkout's .ryke, so every row needs a checkout of its own.
        const cfg = { ...loadConfig({ RYKE_API_URL: api.url, RYKE_TXN: "t_1", RYKE_TOKEN: "tok", RYKE_CHECKOUT: checkoutWith({ "a.txt": "x\n" }).dir }), patienceMs };
        const got = await acquire(cfg, "src/format.ts", { now: () => clock, wait: async (ms) => ((clock += ms), waits.push(ms)) });
        assert.deepEqual({ requests: api.calls.length, waits, gaveUp: got.gaveUp, waitedMs: got.waitedMs }, want);
        assert.equal(got.denied, want.requests - (want.gaveUp ? 0 : 1), "every answer but a final grant was a denial");
        assert.deepEqual(api.calls[0].body, { path: "src/format.ts" });
        if (want.requests > 1) assert.equal(got.owner, "t_a");
      });
    }
  });

  describe("a lease the agent gave up on", () => {
    const intendUrl = "POST /api/txns/t_1/intend-write";

    it("is not waited for again by the next request of the same owner, on a fake clock", async () => {
      const api = await s.start({ [intendUrl]: () => ({ go: false, owner: "t_a", retryAfterMs: 40_000 }) });
      const cfg = { ...loadConfig({ RYKE_API_URL: api.url, RYKE_TXN: "t_1", RYKE_CHECKOUT: checkoutWith({ "a.txt": "x\n" }).dir }), patienceMs: 90_000 };
      let clock = 0;
      const deps = { now: () => clock, wait: async (ms) => void (clock += ms) };
      const first = await acquire(cfg, "src/format.ts", deps);
      assert.deepEqual([first.gaveUp, first.waitedMs, first.remembered], [true, 90_000, undefined]);
      const requests = api.calls.length;
      const second = await acquire(cfg, "src/format.ts", deps);
      assert.deepEqual([second.gaveUp, second.waitedMs, second.remembered, second.owner, second.denied], [true, 0, true, "t_a", 1]);
      assert.equal(api.calls.length - requests, 1, "one request to learn who holds it");
      assert.equal(clock, 90_000, "no second wait");
    });

    it("is not waited for again by the next edit of the same path, and says so briefly", async () => {
      const api = await s.start({ [intendUrl]: () => ({ go: false, owner: "t_other", retryAfterMs: 60 }), ...NO_STALE });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const env = hookEnv(api.url, co, { RYKE_LEASE_PATIENCE_MS: "400" });
      const first = JSON.parse((await drive(intendWrite, editPayload(co), env)).stdout).hookSpecificOutput;
      assert.match(first.permissionDecisionReason, /gave up after 0\.\d s waiting for the lease on src\/format\.ts held by t_other/);
      assert.match(first.additionalContext, /src\/format\.ts is being edited by t_other/);

      const before = api.of(intendUrl).length;
      const started = Date.now();
      const second = JSON.parse((await drive(intendWrite, editPayload(co), env)).stdout).hookSpecificOutput;
      assert.ok(Date.now() - started < 300, `the second edit waited ${Date.now() - started} ms`);
      assert.equal(api.of(intendUrl).length - before, 1);
      assert.equal(second.permissionDecision, "allow");
      assert.equal(second.permissionDecisionReason, "ryke: already gave up on the lease on src/format.ts held by t_other; writing anyway");
      assert.equal(second.additionalContext, undefined, "the agent was told once");
    });

    it("is waited for again when another transaction holds it, or for another path", async () => {
      let owner = "t_other";
      const api = await s.start({ [intendUrl]: () => ({ go: false, owner, retryAfterMs: 60 }), ...NO_STALE });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1, "src/ui/layout.ts": "x\n" });
      const env = hookEnv(api.url, co, { RYKE_LEASE_PATIENCE_MS: "400" });
      await drive(intendWrite, editPayload(co), env);

      const timed = async (payload) => {
        const started = Date.now();
        const out = JSON.parse((await drive(intendWrite, payload, env)).stdout).hookSpecificOutput;
        return { ms: Date.now() - started, out };
      };
      const other = await timed(editPayload(co, "Edit", "src/ui/layout.ts"));
      assert.ok(other.ms >= 350, `another path waited only ${other.ms} ms`);
      owner = "t_third";
      const third = await timed(editPayload(co));
      assert.ok(third.ms >= 350, `another owner waited only ${third.ms} ms`);
      assert.match(third.out.permissionDecisionReason, /gave up after 0\.\d s .* held by t_third/);
    });

    it("is granted at once when the holder is gone, whatever was remembered", async () => {
      let go = false;
      const api = await s.start({ [intendUrl]: () => (go ? { go: true } : { go: false, owner: "t_other", retryAfterMs: 60 }), ...NO_STALE });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const env = hookEnv(api.url, co, { RYKE_LEASE_PATIENCE_MS: "200" });
      await drive(intendWrite, editPayload(co), env);
      go = true;
      const out = JSON.parse((await drive(intendWrite, editPayload(co), env)).stdout).hookSpecificOutput;
      assert.equal(out.permissionDecisionReason, "ryke: lease on src/format.ts granted");
    });
  });

  it("allows the edit at once when the lease is granted, in the documented PreToolUse shape", async () => {
    const api = await s.start({ "POST /api/txns/t_1/intend-write": () => ({ go: true }), ...NO_STALE });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const { stdout } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co));
    assert.deepEqual(JSON.parse(stdout), {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "ryke: lease on src/format.ts granted" },
    });
    assert.deepEqual(api.of("POST /api/txns/t_1/intend-write").map((c) => [c.body, c.auth]), [[{ path: "src/format.ts" }, "Bearer tok"]]);
  });

  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    it(`asks for the lease on a ${tool} of a nested path`, async () => {
      const api = await s.start({ "POST /api/txns/t_1/intend-write": () => ({ go: true }), ...NO_STALE });
      const co = checkoutWith({ "src/ui/layout.ts": "x\n" });
      await drive(intendWrite, editPayload(co, tool, "src/ui/layout.ts"), hookEnv(api.url, co));
      assert.deepEqual(api.of("POST /api/txns/t_1/intend-write").map((c) => c.body), [{ path: "src/ui/layout.ts" }]);
    });
  }

  it("waits for a hot file and retries until the holder is done", async () => {
    const api = await s.start({
      "POST /api/txns/t_1/intend-write": (_c, n) => (n < 4 ? { go: false, owner: "t_other", retryAfterMs: 30 } : { go: true }),
      ...NO_STALE,
    });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const started = Date.now();
    const { stdout } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co));
    assert.equal(api.of("POST /api/txns/t_1/intend-write").length, 4);
    assert.ok(Date.now() - started >= 80, "it slept between the attempts");
    assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "allow");
  });

  it("says in its reason how long it waited, once the wait was noticeable", async () => {
    const api = await s.start({
      "POST /api/txns/t_1/intend-write": (_c, n) => (n < 2 ? { go: false, owner: "t_other", retryAfterMs: 1100 } : { go: true }),
      ...NO_STALE,
    });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const { stdout } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co));
    assert.match(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason, /^ryke: waited 1\.\d s for the lease on src\/format\.ts held by t_other$/);
  });

  it("writes anyway once the patience is used up, and tells the agent why a conflict is likely", async () => {
    const api = await s.start({ "POST /api/txns/t_1/intend-write": () => ({ go: false, owner: "t_other", retryAfterMs: 60 }), ...NO_STALE });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const started = Date.now();
    const { stdout } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co, { RYKE_LEASE_PATIENCE_MS: "300" }));
    const took = Date.now() - started;
    assert.ok(took >= 280 && took < 3000, `waited ${took} ms for a patience of 300`);
    const { hookSpecificOutput: out } = JSON.parse(stdout);
    assert.equal(out.permissionDecision, "allow", "a lease must never block an agent forever");
    assert.match(out.permissionDecisionReason, /gave up after 0\.\d s waiting for the lease on src\/format\.ts held by t_other; writing anyway/);
    assert.match(out.additionalContext, /src\/format\.ts is being edited by t_other/);
    const n = api.of("POST /api/txns/t_1/intend-write").length;
    assert.ok(n >= 4 && n <= 7, `${n} requests while waiting`);
  });

  it("never outlives its budget, whatever the patience: the edit goes through undecided", { timeout: 15_000 }, async () => {
    const api = await s.start({ "POST /api/txns/t_1/intend-write": () => ({ go: false, owner: "t_other", retryAfterMs: 100 }), ...NO_STALE });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const started = Date.now();
    const { stdout, stderr } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co, { RYKE_LEASE_PATIENCE_MS: "600000", RYKE_HOOK_BUDGET_MS: "600" }));
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
    assert.equal(stdout, "", "no decision means the normal flow: the edit proceeds");
    assert.match(stderr, /time budget is used up/);
  });

  it("passes through the lease when contention control is off, without calling intend-write", async () => {
    const api = await s.start({ ...NO_STALE });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const { stdout } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co, { RYKE_CONTENTION: "off" }));
    assert.equal(api.of("POST /api/txns/t_1/intend-write").length, 0);
    assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason, "ryke: contention control is off");
  });

  it("also tells the agent, on its next edit, that a file it read has changed on trunk", async () => {
    const api = await s.start({
      "POST /api/txns/t_1/intend-write": () => ({ go: true }),
      "POST /api/txns/t_1/reads": () => ({ recorded: 0, staleWarnings: [{ path: "src/ui/layout.ts", seq: 3, by: "t_search" }] }),
      "GET /api/repos/convert/files": () => ({ content: "new layout\n" }),
    });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1, "src/ui/layout.ts": "old layout\n" });
    const { stdout } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "allow");
    assert.match(out.additionalContext, /src\/ui\/layout\.ts, changed by t_search at trunk seq 3/);
    assert.match(out.additionalContext, /^\+new layout$/m);
    assert.deepEqual(api.of("POST /api/txns/t_1/reads").map((c) => c.body), [{ paths: [] }], "polling must not record reads");
  });

  describe("after waiting for a lease", () => {
    const holder = (n) => (n < 3 ? { go: false, owner: "t_holder", retryAfterMs: 60 } : { go: true });
    const changedLayout = { path: "src/ui/layout.ts", seq: 3, by: "t_search" };
    // What the reads hook logged earlier in the attempt.
    const seedReads = (co, batches) => {
      mkdirSync(join(co.dir, ".ryke"), { recursive: true });
      writeFileSync(join(co.dir, ".ryke/reads.jsonl"), batches.map((paths) => `${JSON.stringify({ at: 1, tool: "Read", paths })}\n`).join(""));
    };

    it("states the paths read so far again and tells the agent what changed on trunk while it waited, and that its edits will be rebased", async () => {
      const api = await s.start({
        "POST /api/txns/t_1/intend-write": (_c, n) => holder(n),
        "POST /api/txns/t_1/reads": () => ({ recorded: 3, staleWarnings: [changedLayout] }),
        "GET /api/repos/convert/files": () => ({ content: "new layout\n" }),
      });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1, "src/ui/layout.ts": "old layout\n" });
      seedReads(co, [["src/format.ts", "src/ui/layout.ts"], ["src/format.ts", "src/registry.ts"]]);
      const { stdout } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co));
      assert.deepEqual(api.of("POST /api/txns/t_1/reads").map((c) => c.body), [{ paths: ["src/format.ts", "src/ui/layout.ts", "src/registry.ts"] }]);
      const out = JSON.parse(stdout).hookSpecificOutput;
      assert.equal(out.permissionDecision, "allow");
      assert.match(out.additionalContext, /^Ryke: you waited 0\.\d s for the write lease on src\/format\.ts, held by t_holder\. While you waited, a file you read changed on trunk after your snapshot/);
      assert.match(out.additionalContext, /- src\/ui\/layout\.ts, changed by t_search at trunk seq 3/);
      assert.match(out.additionalContext, /^\+new layout$/m, "with the change itself");
      assert.match(out.additionalContext, /Adapt your edits to what trunk has now\. When you stop, Ryke moves your change onto the current trunk and submits it there/);
      assert.doesNotMatch(out.additionalContext, /will be rebased|if these reads are still out of date/);
      assert.equal(api.of("POST /api/txns/t_1/refresh").length, 0, "the checkout holds uncommitted work, so the hook never refreshes the snapshot");
    });

    it("says nothing about trunk when nothing changed while it waited, but still restated the reads", async () => {
      const api = await s.start({ "POST /api/txns/t_1/intend-write": (_c, n) => holder(n), "POST /api/txns/t_1/reads": () => ({ recorded: 2, staleWarnings: [] }) });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      seedReads(co, [["src/format.ts", "src/registry.ts"]]);
      const out = JSON.parse((await drive(intendWrite, editPayload(co), hookEnv(api.url, co))).stdout).hookSpecificOutput;
      assert.equal(out.additionalContext, undefined);
      assert.deepEqual(api.of("POST /api/txns/t_1/reads").map((c) => c.body.paths), [["src/format.ts", "src/registry.ts"]]);
    });

    it("restates a long read set in calls of at most 500 paths", async () => {
      const api = await s.start({ "POST /api/txns/t_1/intend-write": (_c, n) => holder(n), "POST /api/txns/t_1/reads": () => ({ recorded: 0, staleWarnings: [] }) });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      seedReads(co, [Array.from({ length: 600 }, (_, i) => `src/gen/f${i}.ts`)]);
      await drive(intendWrite, editPayload(co), hookEnv(api.url, co));
      assert.deepEqual(api.of("POST /api/txns/t_1/reads").map((c) => c.body.paths.length), [500, 100]);
    });

    it("still polls with no paths when the hooks logged no reads", async () => {
      const api = await s.start({ "POST /api/txns/t_1/intend-write": (_c, n) => holder(n), "POST /api/txns/t_1/reads": () => ({ recorded: 0, staleWarnings: [changedLayout] }), "GET /api/repos/convert/files": () => ({ content: "new\n" }) });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1, "src/ui/layout.ts": "old\n" });
      const out = JSON.parse((await drive(intendWrite, editPayload(co), hookEnv(api.url, co))).stdout).hookSpecificOutput;
      assert.deepEqual(api.of("POST /api/txns/t_1/reads").map((c) => c.body), [{ paths: [] }]);
      assert.match(out.additionalContext, /you waited .* While you waited, a file you read changed on trunk/s);
    });

    it("does not repeat a change the agent was already told about", async () => {
      const api = await s.start({ "POST /api/txns/t_1/intend-write": (_c, n) => holder(n), "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [changedLayout] }), "GET /api/repos/convert/files": () => ({ content: "new\n" }) });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1, "src/ui/layout.ts": "old\n" });
      seedReads(co, [["src/ui/layout.ts"]]);
      H.claimAnnouncement(loadConfig({ RYKE_CHECKOUT: co.dir }), "src/ui/layout.ts", 3);
      const out = JSON.parse((await drive(intendWrite, editPayload(co), hookEnv(api.url, co))).stdout).hookSpecificOutput;
      assert.equal(out.additionalContext, undefined);
    });

    it("gives both notes when it gave up waiting and trunk moved meanwhile", async () => {
      const api = await s.start({
        "POST /api/txns/t_1/intend-write": () => ({ go: false, owner: "t_holder", retryAfterMs: 60 }),
        "POST /api/txns/t_1/reads": () => ({ recorded: 1, staleWarnings: [changedLayout] }),
        "GET /api/repos/convert/files": () => ({ content: "new\n" }),
      });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1, "src/ui/layout.ts": "old\n" });
      seedReads(co, [["src/ui/layout.ts"]]);
      const out = JSON.parse((await drive(intendWrite, editPayload(co), hookEnv(api.url, co, { RYKE_LEASE_PATIENCE_MS: "200" }))).stdout).hookSpecificOutput;
      assert.match(out.additionalContext, /src\/format\.ts is being edited by t_holder/);
      assert.match(out.additionalContext, /While you waited, a file you read changed on trunk/);
    });

    it("does not resend the reads when the lease was granted at once", async () => {
      const api = await s.start({ "POST /api/txns/t_1/intend-write": () => ({ go: true }), "POST /api/txns/t_1/reads": () => ({ recorded: 0, staleWarnings: [] }) });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      seedReads(co, [["src/format.ts"]]);
      await drive(intendWrite, editPayload(co), hookEnv(api.url, co));
      assert.deepEqual(api.of("POST /api/txns/t_1/reads").map((c) => c.body), [{ paths: [] }]);
    });
  });

  it("still allows the edit when the stale poll fails", async () => {
    const api = await s.start({ "POST /api/txns/t_1/intend-write": () => ({ go: true }), "POST /api/txns/t_1/reads": () => [500, { error: "boom" }] });
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const { stdout, stderr } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "allow");
    assert.equal(out.additionalContext, undefined);
    assert.match(stderr, /stale poll failed/);
  });

  describe("failing open", () => {
    it("lets the edit through, silently, when intend-write answers 500", async () => {
      const api = await s.start({ "POST /api/txns/t_1/intend-write": () => [500, { error: "boom" }] });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const { stdout, stderr } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co));
      assert.equal(stdout, "", "no decision means the normal flow: the edit proceeds");
      assert.match(stderr, /failed open/);
    });

    it("lets the edit through when the transaction is no longer open (409)", async () => {
      const api = await s.start({ "POST /api/txns/t_1/intend-write": () => [409, { error: "transaction t_1 is submitted" }] });
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      const { stdout } = await drive(intendWrite, editPayload(co), hookEnv(api.url, co));
      assert.equal(stdout, "");
    });

    it("lets the edit through when the API is unreachable", async () => {
      const dead = await fakeServer();
      const url = dead.url;
      await dead.close();
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      assert.equal((await drive(intendWrite, editPayload(co), hookEnv(url, co))).stdout, "");
    });

    it("lets the edit through when the API is not configured", async () => {
      const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
      assert.equal((await drive(intendWrite, editPayload(co), { RYKE_CHECKOUT: co.dir })).stdout, "");
    });

    for (const [name, path] of [["outside the checkout", "/etc/hosts"], ["in ryke's own state", ".ryke/screenshot.txt"], ["in .claude", ".claude/settings.json"]]) {
      it(`ignores a write ${name} without calling the API`, async () => {
        const api = await s.start({ "POST /api/txns/t_1/intend-write": () => ({ go: true }), ...NO_STALE });
        const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
        const input = { hook_event_name: "PreToolUse", tool_name: "Write", cwd: co.dir, tool_input: { file_path: path.startsWith("/") ? path : join(co.dir, path), content: "x" } };
        assert.equal((await drive(intendWrite, input, hookEnv(api.url, co))).stdout, "");
        assert.equal(api.calls.length, 0);
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Hooks: record-write
// ---------------------------------------------------------------------------------------------

describe("record-write hook (PostToolUse on Edit, Write, MultiEdit)", () => {
  it("appends one line per write to .ryke/writes.jsonl and needs no API", async () => {
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    const env = { RYKE_CHECKOUT: co.dir };
    for (const [tool, file] of [["Edit", "src/format.ts"], ["Write", "src/units/area.ts"], ["MultiEdit", "src/format.ts"]]) {
      const { stdout } = await drive(recordWrite, { hook_event_name: "PostToolUse", tool_name: tool, cwd: co.dir, tool_input: { file_path: join(co.dir, file) }, tool_response: {} }, env);
      assert.equal(stdout, "");
    }
    const written = lines(readFileSync(join(co.dir, ".ryke/writes.jsonl"), "utf8"));
    assert.deepEqual(written.map((w) => [w.tool, w.path]), [["Edit", "src/format.ts"], ["Write", "src/units/area.ts"], ["MultiEdit", "src/format.ts"]]);
    assert.ok(written.every((w) => Number.isFinite(w.at)));
  });

  it("ignores files outside the repo", async () => {
    const co = checkoutWith({ "src/format.ts": FORMAT_V1 });
    await drive(recordWrite, { hook_event_name: "PostToolUse", tool_name: "Write", cwd: co.dir, tool_input: { file_path: "/tmp/elsewhere.txt" }, tool_response: {} }, { RYKE_CHECKOUT: co.dir });
    assert.equal(existsSync(join(co.dir, ".ryke/writes.jsonl")), false);
  });
});

// ---------------------------------------------------------------------------------------------
// agent.mjs: the pure parts
// ---------------------------------------------------------------------------------------------

describe("agent.mjs inputs", () => {
  const ARGS = { repo: "convert", txn: "t_1", agent: "agent-01", intent: "Do it", remote: "/r.git", snapshot: "abc" };

  it("fills in the defaults of the spec", () => {
    const inp = inputsFrom({ ...ARGS }, { RYKE_API_URL: "http://api", RYKE_TOKEN: "tok", RYKE_FORK_TOKEN: "fork" });
    assert.deepEqual(
      { ...inp, criteria: undefined },
      {
        ...ARGS,
        criteria: undefined,
        cli: "claude",
        auth: "auto",
        model: "claude-sonnet-5-5",
        maxAttempts: 3,
        apiUrl: "http://api",
        token: "tok",
        forkToken: "fork",
        bin: "claude",
        stub: false,
        contention: true,
        keepCheckout: false,
        claudeTimeoutMs: 1_500_000,
        waitMs: 900_000,
      },
    );
    assert.deepEqual(inp.criteria, []);
  });

  it("takes the fork token out of its own environment once it has read it", () => {
    const env = { RYKE_FORK_TOKEN: "fork-secret", RYKE_TOKEN: "tok", PATH: "/bin" };
    const inp = Agent.takeInputs(ARGS, env);
    assert.equal(inp.forkToken, "fork-secret");
    assert.deepEqual(env, { RYKE_TOKEN: "tok", PATH: "/bin" }, "nothing this process starts, git included, inherits it");
  });

  it("keeps the checkout only when asked", () => {
    assert.equal(inputsFrom(ARGS, { RYKE_KEEP_CHECKOUT: "1" }).keepCheckout, true);
    assert.equal(inputsFrom(ARGS, { RYKE_KEEP_CHECKOUT: "0" }).keepCheckout, false);
  });

  // The job's longest possible life, which the harness must outlast (PLAN.md §10.4: it follows the job).
  const BUDGETS = [
    ["the defaults", {}, { claudeTimeoutMs: 1_500_000, waitMs: 900_000 }],
    ["overrides", { RYKE_CLAUDE_TIMEOUT_S: "10", RYKE_WAIT_S: "20" }, { claudeTimeoutMs: 10_000, waitMs: 20_000 }],
  ];
  for (const [name, env, want] of BUDGETS) {
    it(`budgetsFrom reads ${name}`, () => {
      assert.deepEqual(Agent.budgetsFrom(env), want);
    });
  }

  it("worstCaseMs covers every run's Claude session, its wait and the overhead of git and API retries", () => {
    const one = Agent.worstCaseMs({ maxAttempts: 1, claudeTimeoutMs: 10_000, waitMs: 20_000 });
    assert.equal(one, 10_000 + 20_000 + Agent.ATTEMPT_OVERHEAD_MS);
    assert.equal(Agent.worstCaseMs({ maxAttempts: 3, claudeTimeoutMs: 10_000, waitMs: 20_000 }), 3 * one);
    assert.ok(Agent.ATTEMPT_OVERHEAD_MS >= 5 * 30_000, "at least five API calls that each retry for their full 30 s");
  });

  it("reads the overrides", () => {
    const inp = inputsFrom(
      { ...ARGS, model: "claude-opus-5", "max-attempts": "2", criteria: '["a","b"]', api: "http://flag" },
      { CLAUDE_BIN: "/x/claude", RYKE_AGENT_STUB: "1", RYKE_CONTENTION: "off", RYKE_CLAUDE_TIMEOUT_S: "2.5", RYKE_WAIT_S: "30" },
    );
    assert.deepEqual([inp.model, inp.maxAttempts, inp.criteria, inp.apiUrl, inp.bin, inp.stub, inp.contention, inp.claudeTimeoutMs, inp.waitMs], ["claude-opus-5", 2, ["a", "b"], "http://flag", "/x/claude", true, false, 2500, 30_000]);
  });

  it("takes the API URL from the environment before the flag", () => {
    assert.equal(inputsFrom({ ...ARGS, api: "http://flag" }, { RYKE_API_URL: "http://env" }).apiUrl, "http://env");
  });

  it("requires what the harness must pass", () => {
    for (const key of Object.keys(ARGS)) {
      const { [key]: _gone, ...rest } = ARGS;
      assert.throws(() => inputsFrom(rest, {}), new RegExp(`--${key} is required`));
    }
  });

  it("rejects numbers that are not positive", () => {
    assert.throws(() => inputsFrom({ ...ARGS, "max-attempts": "0" }, {}), /--max-attempts must be a positive number/);
    assert.throws(() => inputsFrom(ARGS, { RYKE_CLAUDE_TIMEOUT_S: "-1" }), /RYKE_CLAUDE_TIMEOUT_S must be a positive number/);
    assert.throws(() => inputsFrom(ARGS, { RYKE_WAIT_S: "soon" }), /RYKE_WAIT_S must be a positive number/);
  });

  it("accepts criteria that are not a JSON list", () => {
    assert.deepEqual(inputsFrom({ ...ARGS, criteria: "just one thing" }, {}).criteria, ["just one thing"]);
    assert.deepEqual(inputsFrom({ ...ARGS, criteria: '"quoted"' }, {}).criteria, ["quoted"]);
    assert.deepEqual(inputsFrom({ ...ARGS, criteria: "[1,2]" }, {}).criteria, ["1", "2"]);
  });
});

describe("agent.mjs prompt", () => {
  it("renders criteria as a list, a single line or an admission", () => {
    assert.equal(renderCriteria([]), "none given; the intent is the criterion");
    assert.equal(renderCriteria(["only"]), "only");
    assert.equal(renderCriteria(["a", "b"]), "\n1. a\n2. b");
  });

  it("refuses a template placeholder it does not know", () => {
    assert.throws(() => fillPrompt("hello {{nobody}}", { agent: "a" }), /uses \{\{nobody\}\}/);
  });

  it("puts every value in, and leaves braces inside values alone", () => {
    assert.equal(fillPrompt("{{a}}-{{b}}-{{a}}", { a: "x {{b}}", b: "y" }), "x {{b}}-y-x {{b}}");
  });

  const delta = [{ path: "src/format.ts", patch: "--- a/src/format.ts\n+++ b/src/format.ts\n@@ -1 +1 @@\n-digits = 2\n+digits = 3\n" }];

  it("a stale retry shows the delta of every file and where the old diff is", () => {
    const text = retryNotice({ state: "stale", reason: "stale_read", attempt: 2, max: 3, snapshot: "0123456789abcdef", delta, hasPrevious: true });
    assert.ok(text.startsWith("\n\n---\nRyke retry, attempt 2 of 3."));
    assert.ok(text.includes(RETRY_STALE));
    assert.doesNotMatch(text, new RegExp(RETRY_FAILED));
    assert.match(text, /### src\/format\.ts\n```diff\n--- a\/src\/format\.ts/);
    assert.match(text, /\+digits = 3/);
    assert.match(text, /fresh copy of trunk at 01234567; the diff of your previous attempt is saved at \.ryke\/previous\.patch/);
    assert.match(text, /\.ryke\/screenshot\.txt/);
  });

  it("a conflict notice says nothing was aborted: the change did not apply on the trunk that moved", () => {
    const text = retryNotice({ state: "conflict", attempt: 2, max: 3, snapshot: "0123456789abcdef", delta, hasPrevious: true });
    assert.ok(text.includes(RETRY_STALE));
    assert.match(text, /does not apply cleanly on the new trunk, so Ryke started you again from it/);
    assert.doesNotMatch(text, /aborted/);
    assert.match(text, /### src\/format\.ts\n```diff/);
    assert.match(text, /fresh copy of trunk at 01234567; the diff of your previous attempt is saved at \.ryke\/previous\.patch/);
    assert.match(retryNotice({ state: "conflict", attempt: 2, max: 3, snapshot: "abcdef012", delta: [], hasPrevious: false }), /\(no delta was recorded\)/);
  });

  it("a retry after a failed verification lists the failing tests", () => {
    const text = retryNotice({ state: "failed", attempt: 2, max: 3, snapshot: "0123456789abcdef", failures: [{ name: "area converts ha", message: "expected 10000.00" }, { name: "bare", message: "" }], hasPrevious: true });
    assert.ok(text.includes(RETRY_FAILED));
    assert.doesNotMatch(text, new RegExp(RETRY_STALE));
    assert.match(text, /- area converts ha: expected 10000\.00\n- bare\n/);
  });

  it("copes with missing failures, a missing delta and no previous diff", () => {
    assert.match(retryNotice({ state: "failed", attempt: 2, max: 3, snapshot: "abcdef012", failures: null, hasPrevious: false }), /\(no test names were recorded\)/);
    const stale = retryNotice({ state: "stale", reason: "text_conflict", attempt: 3, max: 3, snapshot: "abcdef012", delta: [], hasPrevious: false });
    assert.match(stale, /\(no delta was recorded\)/);
    assert.match(stale, /\(text_conflict\)/);
    assert.doesNotMatch(stale, /previous\.patch/);
  });

  it("cuts long patches and the notice as a whole", () => {
    const long = [{ path: "big.ts", patch: "+x\n".repeat(5000) }];
    const one = retryNotice({ state: "stale", attempt: 2, max: 3, snapshot: "abcdef012", delta: long, hasPrevious: false });
    assert.match(one, /\.\.\. \(cut\)/);
    assert.ok(one.length < 7000);
    const many = retryNotice({ state: "stale", attempt: 2, max: 3, snapshot: "abcdef012", delta: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, patch: "+x\n".repeat(2500) })), hasPrevious: false });
    assert.ok(many.length <= 24_100);
  });
});

describe("agent.mjs claude invocation", () => {
  it("passes exactly the flags of docs/platform-notes.md, the prompt last", () => {
    assert.deepEqual(claudeArgs("claude-sonnet-5-5", "the prompt"), ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence", "--model", "claude-sonnet-5-5", "--", "the prompt"]);
  });

  const inp = { apiUrl: "http://api", token: "tok", txn: "t_1", repo: "convert", snapshot: "abc", contention: true };

  it("sets what Claude Code needs as root in a container and what the hooks need", () => {
    const env = agentEnv(inp, "/w/checkout", { base: { PATH: "/bin", RYKE_FORK_TOKEN: "fork-secret", NODE_TEST_CONTEXT: "child-v8", ANTHROPIC_API_KEY: "sk-real" }, container: false });
    assert.equal(env.IS_SANDBOX, "1");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.deepEqual([env.RYKE_API_URL, env.RYKE_TOKEN, env.RYKE_TXN, env.RYKE_REPO, env.RYKE_CHECKOUT, env.RYKE_SNAPSHOT, env.RYKE_CONTENTION], ["http://api", "tok", "t_1", "convert", "/w/checkout", "abc", "on"]);
    assert.equal(env.RYKE_ROOT, ROOT);
    assert.equal(env.ANTHROPIC_API_KEY, "sk-real");
    assert.equal(env.PATH, "/bin");
  });

  it("keeps the fork's git token and the test runner's context out of Claude's environment", () => {
    const env = agentEnv(inp, "/w", { base: { RYKE_FORK_TOKEN: "fork-secret", NODE_TEST_CONTEXT: "child-v8" }, container: false });
    assert.equal("RYKE_FORK_TOKEN" in env, false);
    assert.equal("NODE_TEST_CONTEXT" in env, false);
  });

  // Claude's Bash tool sees this environment, so it is an allow-list: whatever a job inherits that is
  // not named here (host secrets above all) never reaches the model.
  const INHERITED = {
    PATH: "/bin",
    HOME: "/home/a",
    USER: "a",
    LOGNAME: "a",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    LC_CTYPE: "C",
    TZ: "UTC",
    TMPDIR: "/t",
    TERM: "dumb",
    SHELL: "/bin/sh",
    HTTPS_PROXY: "http://p:1",
    https_proxy: "http://p:1",
    HTTP_PROXY: "http://p:1",
    http_proxy: "http://p:1",
    NO_PROXY: "localhost",
    no_proxy: "localhost",
    ALL_PROXY: "http://p:1",
    NODE_EXTRA_CA_CERTS: "/ca.crt",
    SSL_CERT_FILE: "/ca.crt",
    SSL_CERT_DIR: "/certs",
    CURL_CA_BUNDLE: "/ca.crt",
    GIT_SSL_CAINFO: "/ca.crt",
    NODE_USE_ENV_PROXY: "1",
    ANTHROPIC_API_KEY: "sk-real",
    ANTHROPIC_BASE_URL: "http://anthropic",
    CLAUDE_CONFIG_DIR: "/c",
    RYKE_AGENT_VERBOSE: "1",
    RYKE_LEASE_PATIENCE_MS: "250",
    RYKE_HOOK_TIMEOUT_MS: "75",
    RYKE_HOOK_BUDGET_MS: "900",
    RYKE_CATALOGUE_DIR: "/cat",
    RYKE_STUB_GATE_DIR: "/gates",
    RYKE_STUB_DELAY_MS: "5",
  };
  const WITHHELD = {
    RYKE_FORK_TOKEN: "fork-secret",
    RYKE_INTERNAL_SECRET: "internal",
    RYKE_TOKEN: "admin-token",
    TYPESAFE_API_KEY: "tsk",
    NODE_TEST_CONTEXT: "child-v8",
    GITHUB_TOKEN: "ghp",
    AWS_SECRET_ACCESS_KEY: "aws",
    CLOUDFLARE_API_TOKEN: "cf",
    RYKE_STATE_DIR: "/state",
    RYKE_STORE_URL: "http://store",
    GIT_CONFIG_VALUE_0: "Authorization: Bearer x",
    NODE_OPTIONS: "--require /x.js",
    // A key run must not be sent to another provider, nor carry the other vendor's secrets.
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-login",
    ANTHROPIC_AUTH_TOKEN: "bearer",
    OPENAI_API_KEY: "sk-proj-openai",
    CODEX_API_KEY: "sk-proj-codex",
    CODEX_HOME: "/codex",
  };

  it("passes on what Claude Code, git and the hooks need, and nothing else", () => {
    const env = agentEnv(inp, "/w/checkout", { base: { ...INHERITED, ...WITHHELD }, container: false });
    for (const [k, v] of Object.entries(INHERITED)) assert.equal(env[k], v, `${k} must reach claude`);
    for (const k of Object.keys(WITHHELD)) assert.ok(!(k in env) || k === "RYKE_TOKEN", `${k} must not reach claude`);
    assert.equal(env.RYKE_TOKEN, "tok", "the transaction's own token replaces whatever the job inherited");
    const known = new Set([...Object.keys(INHERITED), "IS_SANDBOX", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "RYKE_API_URL", "RYKE_TOKEN", "RYKE_TXN", "RYKE_REPO", "RYKE_CHECKOUT", "RYKE_SNAPSHOT", "RYKE_ROOT", "RYKE_CONTENTION"]);
    assert.deepEqual(Object.keys(env).filter((k) => !known.has(k)), [], "nothing unlisted slipped through");
  });

  it("uses a placeholder key only inside the container, where the gateway swaps it", () => {
    assert.equal(agentEnv(inp, "/w", { base: {}, container: true }).ANTHROPIC_API_KEY, PLACEHOLDER_KEY);
    assert.equal(agentEnv(inp, "/w", { base: {}, container: false }).ANTHROPIC_API_KEY, undefined);
    assert.equal(agentEnv(inp, "/w", { base: { ANTHROPIC_API_KEY: "sk-real" }, container: true }).ANTHROPIC_API_KEY, "sk-real");
  });

  it("turns contention off for the hooks when asked", () => {
    assert.equal(agentEnv({ ...inp, contention: false }, "/w", { base: {}, container: false }).RYKE_CONTENTION, "off");
  });

  // The outcome is read from the last result line, by is_error, never by subtype.
  const OK = { type: "result", subtype: "success", is_error: false, result: "done" };
  const OUTCOMES = [
    ["a successful result", [{ type: "system" }, OK], 0, false, { isError: false, text: "done" }],
    ["the last result wins", [{ ...OK, result: "first" }, { ...OK, is_error: true, result: "second" }], 1, false, { isError: true, text: "second" }],
    ["is_error true with subtype success is an error", [{ ...OK, is_error: true, result: "Invalid API key" }], 1, false, { isError: true, text: "Invalid API key" }],
    ["is_error false with an error subtype is not an error", [{ ...OK, subtype: "error_max_turns", is_error: false, result: "ran out of turns" }], 0, false, { isError: false, text: "ran out of turns" }],
    ["no result line", [{ type: "assistant" }], 0, false, { isError: true, text: "claude exited with code 0 without a result line" }],
    ["no output at all", [], 137, false, { isError: true, text: "claude exited with code 137 without a result line" }],
    ["a timeout beats a result", [OK], null, true, { isError: true, text: "claude timed out" }],
    ["a result without is_error is not trusted", [{ type: "result", result: "?" }], 0, false, { isError: true, text: "?" }],
  ];
  for (const [name, stream, code, timedOut, want] of OUTCOMES) {
    it(`outcomeOf: ${name}`, () => {
      const got = outcomeOf(stream, code, timedOut);
      assert.deepEqual({ isError: got.isError, text: got.text }, want);
    });
  }

  it("describeEvent logs writes and the result by default, everything with verbose, and strips the checkout path", () => {
    const tool = (name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
    assert.equal(describeEvent(tool("Edit", { file_path: "/w/c/src/a.ts" }), { cwd: "/w/c" }), "claude: Edit src/a.ts");
    assert.equal(describeEvent(tool("Write", { file_path: "/w/c/src/b.ts" }), { cwd: "/w/c" }), "claude: Write src/b.ts");
    assert.equal(describeEvent(tool("Read", { file_path: "/w/c/src/a.ts" }), { cwd: "/w/c" }), null);
    assert.equal(describeEvent(tool("Read", { file_path: "/w/c/src/a.ts" }), { cwd: "/w/c", verbose: true }), "claude: Read src/a.ts");
    assert.equal(describeEvent(tool("Bash", { command: "node --test" }), { verbose: true }), "claude: Bash node --test");
    assert.equal(describeEvent(tool("Grep", { pattern: "digits" }), { verbose: true }), "claude: Grep digits");
    assert.equal(describeEvent({ type: "assistant", message: { content: [{ type: "text", text: "Looking at it" }] } }), null);
    assert.equal(describeEvent({ type: "assistant", message: { content: [{ type: "text", text: "Looking  at\nit" }] } }, { verbose: true }), "claude: Looking at it");
    assert.equal(describeEvent({ type: "result", is_error: false, result: "all done" }), "claude: result is_error=false all done");
    assert.equal(describeEvent({ type: "system", subtype: "init" }), null);
    assert.equal(describeEvent(undefined), null);
  });
});

describe("agent.mjs hook installation", () => {
  const template = JSON.parse(readFileSync(SETTINGS, "utf8"));

  it("merges hooks without stacking a second copy and keeps what the repo had", () => {
    const foreign = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };
    const once = mergeHooks({ PreToolUse: [foreign], Stop: [foreign] }, template.hooks);
    assert.deepEqual(once.Stop, [foreign]);
    assert.deepEqual(once.PreToolUse[0], foreign);
    assert.equal(once.PreToolUse.length, 2);
    const twice = mergeHooks(once, template.hooks);
    assert.deepEqual(twice, once);
    assert.deepEqual(mergeHooks(undefined, template.hooks), template.hooks);
  });

  it("writes .claude/settings.json into the checkout", async () => {
    const co = checkoutWith({ "a.txt": "x\n" });
    await installHooks(co.dir, template);
    assert.deepEqual(JSON.parse(readFileSync(join(co.dir, ".claude/settings.json"), "utf8")), template);
  });

  it("merges into a settings file the repo tracks and hides the change from git", async () => {
    const co = checkoutWith({ "a.txt": "x\n", ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] } }) });
    await installHooks(co.dir, template);
    await installHooks(co.dir, template);
    const merged = JSON.parse(readFileSync(join(co.dir, ".claude/settings.json"), "utf8"));
    assert.deepEqual(merged.permissions, { allow: ["Bash(ls)"] });
    assert.equal(merged.hooks.Stop.length, 1);
    assert.equal(merged.hooks.PreToolUse.length, 1);
    assert.equal(git(co.dir, "status", "--porcelain"), "", "the agent's change must not include the hooks");
  });

  it("replaces a settings file that is not valid JSON", async () => {
    const co = checkoutWith({ "a.txt": "x\n" });
    mkdirSync(join(co.dir, ".claude"));
    writeFileSync(join(co.dir, ".claude/settings.json"), "{ nope");
    await installHooks(co.dir, template);
    assert.deepEqual(JSON.parse(readFileSync(join(co.dir, ".claude/settings.json"), "utf8")), template);
  });
});

describe("agent.mjs API calls", () => {
  const s = servers();
  after(() => s.closeAll());
  const cfgFor = (api) => ({ api: api.url, token: "tok", txn: "t_1", timeoutMs: 2000 });
  const noSleep = () => {
    const waits = [];
    return { waits, sleep: async (ms) => void waits.push(ms) };
  };

  it("retries a 5xx with a doubling backoff and returns the answer that finally comes", async () => {
    const api = await s.start({ "POST /api/txns/t_1/submit": (_c, n) => (n < 4 ? [503, { error: "restarting" }] : { state: "ready" }) });
    const { waits, sleep } = noSleep();
    const got = await H.apiCallRetrying(cfgFor(api), "POST", "/api/txns/t_1/submit", { head: "h" }, { sleep });
    assert.deepEqual(got, { state: "ready" });
    assert.deepEqual(waits, [500, 1000, 2000]);
    assert.deepEqual(api.calls.map((c) => c.body), [{ head: "h" }, { head: "h" }, { head: "h" }, { head: "h" }], "the same request every time");
  });

  it("retries a dropped connection", async () => {
    const dead = await fakeServer();
    const url = dead.url;
    await dead.close();
    const { waits, sleep } = noSleep();
    await assert.rejects(H.apiCallRetrying({ api: url, token: "t", txn: "t_1", timeoutMs: 500 }, "GET", "/api/txns/t_1", undefined, { sleep }), /fetch failed/);
    assert.ok(waits.length > 0, "a refused connection is transient");
  });

  it("retries a request that times out", async () => {
    const api = await s.start({ "GET /api/txns/t_1": () => new Promise(() => {}) });
    const { waits, sleep } = noSleep();
    await assert.rejects(H.apiCallRetrying({ ...cfgFor(api), timeoutMs: 80 }, "GET", "/api/txns/t_1", undefined, { sleep }));
    assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, 8000], "a hung server is as transient as a dropped connection");
  });

  it("gives up after about 30 s of waiting and reports the last error", async () => {
    const api = await s.start({ "GET /api/txns/t_1": (_c, n) => [502, { error: `bad gateway ${n}` }] });
    const { waits, sleep } = noSleep();
    await assert.rejects(H.apiCallRetrying(cfgFor(api), "GET", "/api/txns/t_1", undefined, { sleep }), /GET \/api\/txns\/t_1 -> 502 bad gateway 7/);
    assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, 8000]);
    assert.ok(waits.reduce((a, b) => a + b) <= 30_000);
    assert.equal(api.calls.length, 7);
  });

  for (const status of [400, 401, 404, 409, 422, 429]) {
    it(`never retries a ${status}`, async () => {
      const api = await s.start({ "POST /api/txns/t_1/submit": () => [status, { error: "no" }] });
      const { waits, sleep } = noSleep();
      await assert.rejects(H.apiCallRetrying(cfgFor(api), "POST", "/api/txns/t_1/submit", {}, { sleep }), new RegExp(`-> ${status} no`));
      assert.deepEqual(waits, []);
      assert.equal(api.calls.length, 1);
    });
  }

  it("does not retry what is not a network failure, or when told not to", async () => {
    const { waits, sleep } = noSleep();
    await assert.rejects(H.apiCallRetrying({ api: "", token: "", txn: "t_1", timeoutMs: 500 }, "GET", "/x", undefined, { sleep }), /Failed to parse URL|Invalid URL/);
    const api = await s.start({ "POST /api/txns/t_1/retry": () => [503, { error: "boom" }] });
    await assert.rejects(H.apiCallRetrying(cfgFor(api), "POST", "/api/txns/t_1/retry", {}, { sleep, retry: false }), /503 boom/);
    assert.deepEqual(waits, []);
    assert.equal(api.calls.length, 1, "retry creates an attempt, so repeating it is not safe");
  });

  it("says what it is waiting for", async () => {
    const api = await s.start({ "GET /api/txns/t_1": (_c, n) => (n < 2 ? [500, { error: "boom" }] : { txn: {} }) });
    const notes = [];
    await H.apiCallRetrying(cfgFor(api), "GET", "/api/txns/t_1", undefined, { sleep: async () => {}, onRetry: (m) => notes.push(m) });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /GET \/api\/txns\/t_1 failed \(.*500 boom\); retrying in 0\.5 s/);
  });
});

describe("hook API calls and their budget", () => {
  const s = servers();
  after(() => s.closeAll());

  it("refuses a call once the hook's budget is used up, and cuts a call to what is left of it", async () => {
    const api = await s.start({ "GET /x": () => new Promise(() => {}) });
    const cfg = { api: api.url, token: "t", txn: "t_1", timeoutMs: 60_000 };
    await assert.rejects(H.apiCall({ ...cfg, deadline: Date.now() - 1 }, "GET", "/x"), /GET \/x: the hook's time budget is used up/);
    assert.equal(api.calls.length, 0);
    const started = Date.now();
    await assert.rejects(H.apiCall({ ...cfg, deadline: Date.now() + 150 }, "GET", "/x"), (e) => e.name === "TimeoutError");
    assert.ok(Date.now() - started < 3000, "not the 60 s of the call's own timeout");
    assert.equal(H.remaining({ deadline: undefined }), Infinity);
  });
});

describe("agent.mjs checkout and attempt files", () => {
  it("treeTracker kills what it saw below the root, even after the parent is gone, and never a recycled pid", () => {
    const row = (ppid, start) => ({ ppid, start });
    let table = new Map([[100, row(1, "a")], [101, row(100, "b")], [102, row(101, "c")], [200, row(1, "z")]]);
    const killed = [];
    const tracker = Agent.treeTracker(100, { table: () => table, kill: (pid, signal) => killed.push([pid, signal]) });
    tracker.sample();
    // Claude and its Bash child die; the grandchild is reparented to init and a new process takes 101's pid.
    table = new Map([[102, row(1, "c")], [101, row(1, "other")], [103, row(102, "d")], [200, row(1, "z")]]);
    tracker.killAll();
    assert.deepEqual(killed, [[102, "SIGKILL"]], "102 is the same process, 101 is a stranger, 200 was never below the root");
    killed.length = 0;
    // A process that appeared below the root since the last sample is found by the sweep itself.
    table = new Map([[100, row(1, "a")], [104, row(100, "e")]]);
    tracker.killAll();
    assert.deepEqual(killed, [[104, "SIGKILL"]]);
    assert.doesNotThrow(() => Agent.treeTracker(undefined).killAll(), "a claude that never started has no tree");
  });

  it("treeTracker shrugs off a process that is gone already", () => {
    const table = new Map([[100, { ppid: 1, start: "a" }], [101, { ppid: 100, start: "b" }]]);
    const tracker = Agent.treeTracker(100, { table: () => table, kill: () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); } });
    assert.doesNotThrow(() => tracker.killAll());
  });

  it("memoryAbove finds the CLAUDE.md of any ancestor, and ignores the directory itself", () => {
    const root = fresh("memory");
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    assert.equal(Agent.memoryAbove(deep), null);
    writeFileSync(join(deep, "CLAUDE.md"), "the checkout's own\n");
    assert.equal(Agent.memoryAbove(deep), null, "the checkout's own memory is the repo's business");
    const rows = [
      ["CLAUDE.md", join(root, "a", "CLAUDE.md")],
      ["CLAUDE.local.md", join(root, "a", "b", "CLAUDE.local.md")],
      [join(".claude", "CLAUDE.md"), join(root, ".claude", "CLAUDE.md")],
    ];
    for (const [name, found] of rows) {
      mkdirSync(dirname(found), { recursive: true });
      writeFileSync(found, "x\n");
      assert.equal(Agent.memoryAbove(deep), found, name);
      rmSync(found);
    }
    assert.equal(Agent.memoryAbove(deep), null);
  });

  it("makeCheckoutDir makes a private directory under the base and refuses a base inside a project with a CLAUDE.md", () => {
    const base = fresh("base");
    mkdirSync(base);
    const dir = Agent.makeCheckoutDir(base);
    assert.equal(dirname(dir), base);
    assert.equal(existsSync(dir), true);
    assert.equal(Agent.makeCheckoutDir(base) === dir, false, "a directory per call");
    writeFileSync(join(base, "CLAUDE.md"), "x\n");
    assert.throws(() => Agent.makeCheckoutDir(base), (e) => e.message.includes(join(realpathSync(base), "CLAUDE.md")) && /TMPDIR/.test(e.message));
    assert.equal(readdirSync(base).filter((n) => n.startsWith("ryke-agent-")).length, 2, "the refused directory was removed again");
  });

  it("archiveAttempt moves the attempt's tracking files and directories aside", () => {
    const dir = fresh("archive");
    const ryke = join(dir, ".ryke");
    mkdirSync(join(ryke, "announced"), { recursive: true });
    mkdirSync(join(ryke, "gaveup"), { recursive: true });
    for (const f of ["reads.jsonl", "writes.jsonl", "screenshot.txt", "previous.patch", "announced/aa", "gaveup/bb", "claude.log"]) writeFileSync(join(ryke, f), "x\n");
    Agent.archiveAttempt(dir, 1);
    for (const f of ["reads.jsonl", "writes.jsonl", "screenshot.txt", "previous.patch", "announced/aa", "gaveup/bb"]) {
      assert.equal(existsSync(join(ryke, f)), false, `${f} left in place`);
      assert.equal(existsSync(join(ryke, "attempt-1", f)), true, `${f} not archived`);
    }
    assert.equal(existsSync(join(ryke, "claude.log")), true, "files that are not per-attempt stay");
    Agent.archiveAttempt(dir, 2);
    assert.equal(existsSync(join(ryke, "attempt-2")), true, "an attempt with nothing to archive is fine");
  });

  it("procTable reads the process tree and descendantsOf walks children of children", () => {
    const proc = fresh("proc");
    const entry = (pid, comm, state, ppid, start) => {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      // field 22 is the start time; comm may hold spaces and parentheses.
      writeFileSync(join(proc, String(pid), "stat"), `${pid} (${comm}) ${state} ${ppid} 1 1 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000 100 18446744073709551615\n`);
    };
    entry(100, "claude", "S", 1, 1000);
    entry(101, "bash (tool)", "S", 100, 1010);
    entry(102, "sleep", "S", 101, 1020);
    entry(103, "dev server", "S", 102, 1030);
    entry(104, "defunct", "Z", 100, 1040);
    entry(200, "other", "S", 1, 2000);
    mkdirSync(join(proc, "self"));
    writeFileSync(join(proc, "not-a-pid"), "x");
    const table = Agent.procTable(proc);
    assert.deepEqual([...table.keys()].sort(), [100, 101, 102, 103, 200], "zombies and non-pids are left out");
    assert.deepEqual(table.get(101), { ppid: 100, start: "1010" });
    assert.deepEqual(Agent.descendantsOf(table, 100).map(([pid]) => pid).sort(), [101, 102, 103]);
    assert.deepEqual(Agent.descendantsOf(table, 200), []);
    assert.deepEqual(Agent.descendantsOf(table, 999), []);
  });

  it("procTable is empty where there is no /proc", () => {
    assert.equal(Agent.procTable(join(fresh("nowhere"), "proc")).size, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// The fake claude
// ---------------------------------------------------------------------------------------------

describe("the fake claude", { concurrency: 4 }, () => {
  const FLAGS = ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence", "--model", "m"];

  it("parses the invocation agent.mjs makes", () => {
    assert.deepEqual(parseArgv(claudeArgs("claude-sonnet-5-5", "P")), { model: "claude-sonnet-5-5", prompt: "P" });
  });

  const BAD = [
    ["no prompt", [...FLAGS], /expected the prompt after `--`/],
    ["something after the prompt", [...FLAGS, "--", "P", "extra"], /expected the prompt/],
    ["--print missing", FLAGS.filter((f) => f !== "--print").concat("--", "P"), /missing --print/],
    ["--verbose missing", FLAGS.filter((f) => f !== "--verbose").concat("--", "P"), /missing --verbose/],
    ["--dangerously-skip-permissions missing", FLAGS.filter((f) => f !== "--dangerously-skip-permissions").concat("--", "P"), /missing --dangerously-skip-permissions/],
    ["--no-session-persistence missing", FLAGS.filter((f) => f !== "--no-session-persistence").concat("--", "P"), /missing --no-session-persistence/],
    ["another output format", ["--print", "--output-format", "json", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence", "--model", "m", "--", "P"], /must be stream-json/],
    ["no model", FLAGS.slice(0, -2).concat("--", "P"), /--model is required/],
    ["a flag the spec does not have", [...FLAGS, "--max-turns", "3", "--", "P"], /unexpected argument --max-turns/],
  ];
  for (const [name, argv, message] of BAD) {
    it(`refuses an invocation with ${name}`, () => {
      assert.throws(() => parseArgv(argv), message);
    });
  }

  it("matches hooks the way Claude Code documents", () => {
    const rows = [
      ["Edit|Write|MultiEdit", "Edit", true],
      ["Edit|Write|MultiEdit", "MultiEdit", true],
      ["Edit|Write|MultiEdit", "NotebookEdit", false],
      ["Read|Grep|Glob", "Glob", true],
      ["Edit, Write", "Write", true],
      ["Bash", "Bash", true],
      ["Bash", "BashOutput", false],
      ["*", "anything", true],
      ["", "anything", true],
      [undefined, "anything", true],
      ["^Notebook", "NotebookEdit", true],
      ["Edit.*", "NotebookEdit", true],
      ["^Edit$", "NotebookEdit", false],
      ["mcp__memory__.*", "mcp__memory__create_entities", true],
      ["mcp__memory", "mcp__memory__create_entities", false],
    ];
    for (const [matcher, tool, want] of rows) assert.equal(matches(matcher, tool), want, `${matcher} vs ${tool}`);
  });

  it("hooksFor lists the command hooks of the matching groups, in order, and skips other types", () => {
    const settings = { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "a" }, { type: "prompt", prompt: "p" }] }, { matcher: "Edit|Write", hooks: [{ type: "command", command: "b" }] }, { matcher: "Read", hooks: [{ type: "command", command: "c" }] }] } };
    assert.deepEqual(hooksFor(settings, "PreToolUse", "Edit").map((h) => h.command), ["a", "b"]);
    assert.deepEqual(hooksFor(settings, "PostToolUse", "Edit"), []);
    assert.deepEqual(hooksFor({}, "PreToolUse", "Edit"), []);
  });

  it("fills fixtures: a whole-string placeholder keeps its type, an embedded one becomes text, unknown ones fail", () => {
    assert.deepEqual(fill({ n: "{{n}}", s: "a {{s}} b", nested: [{ o: "{{o}}" }], keep: 5 }, { n: 7, s: "X", o: { k: 1 } }), { n: 7, s: "a X b", nested: [{ o: { k: 1 } }], keep: 5 });
    assert.deepEqual(fill({ v: "{{v}}" }, { v: "has {{braces}}" }), { v: "has {{braces}}" });
    assert.throws(() => fill({ x: "{{missing}}" }, {}), /does not provide/);
  });

  it("reads the files and new-file status out of a patch", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " keep",
      "diff --git a/test/n.test.ts b/test/n.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test/n.test.ts",
      "@@ -0,0 +1,2 @@",
      "+line 1",
      "+line 2",
      "",
    ].join("\n");
    assert.deepEqual(describePatch(patch), [
      { path: "src/a.ts", isNew: false, added: "new", removed: "old" },
      { path: "test/n.test.ts", isNew: true, added: "line 1\nline 2", removed: "" },
    ]);
    assert.deepEqual(describePatch(""), []);
  });

  it("cuts commit subjects like the lander does", () => {
    assert.equal(subjectOf("Short one"), "Short one");
    assert.equal(subjectOf("A".repeat(72)), "A".repeat(72));
    assert.equal(subjectOf("A".repeat(73)), `${"A".repeat(71)}…`);
    assert.equal(subjectOf("first line\nsecond"), "first line");
  });

  describe("chooseVariant", () => {
    const cat = byId("cat-area");
    const pre = byId("t-precision");
    const landed = [subjectOf(pre.intent)];
    const ROWS = [
      ["a first attempt is v1", cat, "Intent: x", landed, "v1"],
      ["a stale retry after t-precision is v2", cat, `Intent: x${retryNotice({ state: "stale", attempt: 2, max: 3, snapshot: "abcdef012", delta: [], hasPrevious: false })}`, landed, "v2"],
      ["a failed retry after t-precision is v2", cat, `Intent: x${retryNotice({ state: "failed", attempt: 2, max: 3, snapshot: "abcdef012", failures: [], hasPrevious: false })}`, landed, "v2"],
      ["a retry on a trunk without t-precision stays v1", cat, `${RETRY_STALE}`, ["Seed convert"], "v1"],
      ["a task with no v2 stays v1", byId("tamper-routes"), `${RETRY_STALE}`, landed, "v1"],
      ["a retry marker of neither kind is v1", cat, "Ryke retry", landed, "v1"],
    ];
    for (const [name, task, prompt, subjects, want] of ROWS) {
      it(name, () => assert.equal(chooseVariant(task, tasks, prompt, subjects), want));
    }
  });

  // One process per run, as agent.mjs starts it.
  function runStub(cwd, argv, env = {}) {
    return new Promise((resolveRun) => {
      const child = spawn(STUB_BIN, argv, { cwd, env: { ...BASE_ENV, IS_SANDBOX: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", RYKE_CATALOGUE_DIR: DEMO, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (code) => resolveRun({ code, stdout, stderr, events: stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
    });
  }
  const promptFor = (task) => fillPrompt(readFileSync(PROMPT, "utf8"), { agent: "agent-01", repo: "convert", intent: task.intent, criteria: renderCriteria(task.criteria), verify: "node --test" });

  it("streams a session like the real CLI and ends with a result line", async () => {
    const task = byId("cat-area");
    const dir = cloneWorking("stub-stream");
    const r = await runStub(dir, claudeArgs("claude-sonnet-5-5", promptFor(task)));
    assert.equal(r.code, 0, r.stderr);
    const [first] = r.events;
    assert.deepEqual([first.type, first.subtype, first.model, first.cwd], ["system", "init", "claude-sonnet-5-5", realpathSync(dir)]);
    const last = r.events.at(-1);
    assert.deepEqual([last.type, last.subtype, last.is_error], ["result", "success", false]);
    assert.equal(typeof last.duration_ms, "number");
    assert.match(last.result, /Applied v1 of cat-area/);
    const uses = r.events.filter((e) => e.type === "assistant").flatMap((e) => e.message.content).filter((c) => c.type === "tool_use");
    assert.deepEqual([...new Set(uses.map((u) => u.name))].sort(), ["Edit", "Glob", "Grep", "Read", "Write"]);
    for (const read of uses.filter((u) => u.name === "Read")) assert.ok(read.input.file_path.startsWith(realpathSync(dir)), "Claude Code sends absolute paths");
    const results = r.events.filter((e) => e.type === "user").flatMap((e) => e.message.content);
    assert.equal(results.length, uses.length, "every tool call gets its result");
    assert.deepEqual(results.map((c) => c.tool_use_id), uses.map((u) => u.id));
  });

  it("applies the task's patch and writes the screenshot line", async () => {
    const task = byId("cat-area");
    const dir = cloneWorking("stub-apply");
    await runStub(dir, claudeArgs("m", promptFor(task)));
    assert.deepEqual(git(dir, "status", "--porcelain").split("\n").map((l) => l.slice(3)).filter((p) => !p.startsWith(".ryke")).sort(), [...task.writes].sort());
    assert.equal(readFileSync(join(dir, ".ryke/screenshot.txt"), "utf8").trim(), task.screenshot_description);
  });

  it("runs the hooks it finds in .claude/settings.json with Claude Code's payloads and records what they said", async () => {
    const task = byId("cat-area");
    const dir = cloneWorking("stub-hooks");
    const trace = join(dir, "..", `trace-${counter}.jsonl`);
    const hook = join(dir, "..", `trace-hook-${counter}.mjs`);
    writeFileSync(hook, `import { appendFileSync, readFileSync } from "node:fs";\nconst input = JSON.parse(readFileSync(0, "utf8"));\nappendFileSync(${JSON.stringify(trace)}, JSON.stringify(input) + "\\n");\nif (input.hook_event_name === "PreToolUse") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: "note for " + input.tool_name } }));\n`);
    mkdirSync(join(dir, ".claude"));
    const entry = (matcher) => [{ matcher, hooks: [{ type: "command", command: `node ${JSON.stringify(hook)}` }] }];
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: entry("Edit|Write"), PostToolUse: entry("Read|Grep|Glob|Edit|Write") } }));
    const logDir = fresh("stub-log");
    const r = await runStub(dir, claudeArgs("m", promptFor(task)), { RYKE_STUB_LOG_DIR: logDir });
    assert.equal(r.code, 0, r.stderr);
    const seen = lines(readFileSync(trace, "utf8"));
    const post = seen.filter((p) => p.hook_event_name === "PostToolUse");
    const pre = seen.filter((p) => p.hook_event_name === "PreToolUse");
    assert.deepEqual([...new Set(post.map((p) => p.tool_name))].sort(), ["Edit", "Glob", "Grep", "Read", "Write"]);
    assert.deepEqual([...new Set(pre.map((p) => p.tool_name))].sort(), ["Edit", "Write"]);
    for (const p of seen) {
      assert.equal(p.cwd, realpathSync(dir));
      assert.match(p.tool_use_id, /^toolu_/);
      assert.ok(p.session_id);
    }
    const read = post.find((p) => p.tool_name === "Read");
    assert.equal(read.tool_response.type, "text");
    assert.equal(read.tool_response.file.filePath, read.tool_input.file_path);
    assert.ok(post.find((p) => p.tool_name === "Glob").tool_response.filenames.length === 1);
    assert.ok(post.find((p) => p.tool_name === "Grep").tool_response.filenames[0].startsWith(realpathSync(dir)));
    assert.equal(pre.filter((p) => p.tool_name === "Write").length, 2, "one intent per new file");
    assert.ok(pre.every((p) => p.tool_response === undefined), "PreToolUse comes before the tool ran");
    const [record] = lines(readFileSync(join(logDir, "cat-area.jsonl"), "utf8"));
    assert.deepEqual([...new Set(record.contexts)].sort(), ["note for Edit", "note for Write"]);
    assert.equal(r.events.filter((e) => e.subtype === "hook_response").length, seen.length);
  });

  it("stops with an error result when a hook denies a write", async () => {
    const task = byId("cat-area");
    const dir = cloneWorking("stub-deny");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "echo 'no lease' >&2; exit 2" }] }] } }));
    const r = await runStub(dir, claudeArgs("m", promptFor(task)));
    assert.equal(r.code, 1);
    const last = r.events.at(-1);
    assert.deepEqual([last.type, last.is_error], ["result", true]);
    assert.match(last.result, /a hook blocked Edit of .*: no lease/);
    assert.deepEqual(dirty(dir), [], "nothing was applied");
  });

  it("answers with an error result and exit 2 when invoked wrongly", async () => {
    const dir = cloneWorking("stub-bad");
    const r = await runStub(dir, ["--print", "--", "hi"]);
    assert.equal(r.code, 2);
    const last = r.events.at(-1);
    assert.deepEqual([last.type, last.is_error], ["result", true]);
    assert.match(last.result, /stub: unexpected invocation: missing --verbose/);
  });

  for (const key of ["IS_SANDBOX", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
    it(`insists on ${key}=1, which agent.mjs must set`, async () => {
      const dir = cloneWorking("stub-env");
      const r = await runStub(dir, claudeArgs("m", promptFor(byId("cat-area"))), { [key]: "0" });
      assert.equal(r.code, 2);
      assert.match(r.events.at(-1).result, new RegExp(`${key}=1 is not set`));
    });
  }

  it("answers with an error result when no task has the prompt's intent", async () => {
    const dir = cloneWorking("stub-unknown");
    const r = await runStub(dir, claudeArgs("m", promptFor({ intent: "Something nobody catalogued", criteria: [] })));
    assert.equal(r.code, 1);
    assert.match(r.events.at(-1).result, /no task in .* has the intent "Something nobody catalogued"/);
  });

  it("answers with an error result when neither patch applies to the checkout", async () => {
    const dir = cloneWorking("stub-conflict");
    const task = byId("cat-area");
    mkdirSync(join(dir, "src/units"), { recursive: true });
    writeFileSync(join(dir, "src/units/area.ts"), "already here\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "somebody was faster");
    const r = await runStub(dir, claudeArgs("m", promptFor(task)));
    assert.equal(r.code, 1);
    assert.match(r.events.at(-1).result, /neither patch of cat-area applies/);
    assert.deepEqual(dirty(dir), [], "a failed apply leaves the checkout as it was");
  });

  it("parks at the gate until the test opens it", async () => {
    const task = byId("kelvin-first");
    const dir = cloneWorking("stub-gate");
    const gate = fresh("gate");
    const running = runStub(dir, claudeArgs("m", promptFor(task)), { RYKE_STUB_GATE_DIR: gate });
    await until(() => existsSync(join(gate, "kelvin-first.waiting")), 10_000, "the stub to reach the gate");
    assert.deepEqual(dirty(dir), [], "nothing is written before the gate opens");
    writeFileSync(join(gate, "kelvin-first.go"), "");
    assert.equal((await running).code, 0);
  });

  // The catalogue and the stub must agree for every task, or the swarm's claude mode silently
  // lands fewer tasks than scripted mode does.
  it("plays every task of the catalogue: the v1 patch applies to the seed and touches exactly the task's writes", async () => {
    const queue = [...tasks];
    const failures = [];
    const worker = async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        const dir = cloneWorking(`sweep-${task.id}`);
        const r = await runStub(dir, claudeArgs("m", promptFor(task)));
        const last = r.events.at(-1);
        const touched = git(dir, "status", "--porcelain").split("\n").map((l) => l.slice(3)).filter((p) => p && !p.startsWith(".ryke")).sort();
        const shot = existsSync(join(dir, ".ryke/screenshot.txt")) ? readFileSync(join(dir, ".ryke/screenshot.txt"), "utf8").trim() : null;
        if (r.code !== 0 || last.is_error !== false || JSON.stringify(touched) !== JSON.stringify([...task.writes].sort()) || shot !== task.screenshot_description) {
          failures.push(`${task.id}: exit ${r.code}, result ${last?.result}, touched ${touched.join(",")}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    assert.deepEqual(failures, []);
  });
});

// ---------------------------------------------------------------------------------------------
// agent.sh, the runner job, against a fake API and real git
// ---------------------------------------------------------------------------------------------

describe("agent.sh", { concurrency: 4 }, () => {
  const s = servers();
  after(() => s.closeAll());

  const TXN = "t_1";
  // The routes the hooks and agent.mjs use; tests override the ones they care about.
  const baseRoutes = (over = {}) => ({
    [`POST /api/txns/${TXN}/reads`]: () => ({ recorded: 0, staleWarnings: [] }),
    [`POST /api/txns/${TXN}/intend-write`]: () => ({ go: true }),
    [`POST /api/txns/${TXN}/submit`]: () => ({ state: "ready" }),
    [`GET /api/txns/${TXN}/wait`]: () => ({ txn: { id: TXN, state: "landed", landedSeq: 5, train: "tr_1", reason: null }, changed: true, staleWarnings: [], detail: {} }),
    [`POST /api/txns/${TXN}/abort`]: () => ({ state: "aborted" }),
    ...over,
  });

  // Runs bin/agent.sh as the runner does: arguments plus environment, in a fresh working directory. The
  // checkout lives under TMPDIR, which the test points into its own scratch space; `keep` leaves it there
  // (RYKE_KEEP_CHECKOUT) and reports where, so a test can look at what agent.mjs left in .ryke.
  function startJob(api, fork, taskId, { env = {}, args = {}, keep = false } = {}) {
    const task = byId(taskId);
    const cwd = fresh("job");
    mkdirSync(cwd);
    const tmpRoot = fresh("job-tmp");
    mkdirSync(tmpRoot);
    const logDir = fresh("stub-log");
    const argv = ["--repo", "convert", "--txn", TXN, "--agent", "agent-07", "--intent", task.intent, "--criteria", JSON.stringify(task.criteria), "--remote", fork, "--snapshot", git(fork, "rev-parse", "refs/heads/main"), "--model", "claude-sonnet-5-5"];
    for (const [k, v] of Object.entries(args)) argv.push(`--${k}`, v);
    const child = spawn("bash", [AGENT_SH, ...argv], {
      cwd,
      env: { ...BASE_ENV, TMPDIR: tmpRoot, RYKE_API_URL: api.url, RYKE_TOKEN: "dev-token", RYKE_FORK_TOKEN: "fork-secret", CLAUDE_BIN: STUB_BIN, RYKE_AGENT_STUB: "1", RYKE_CATALOGUE_DIR: DEMO, RYKE_STUB_LOG_DIR: logDir, RYKE_KEEP_CHECKOUT: keep ? "1" : "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = { stdout: "", stderr: "" };
    child.stdout.on("data", (c) => (out.stdout += c));
    child.stderr.on("data", (c) => (out.stderr += c));
    const done = new Promise((r) => child.on("close", r)).then((code) => {
      const last = out.stdout.trim().split("\n").at(-1);
      const stubRuns = existsSync(join(logDir, `${taskId}.jsonl`)) ? lines(readFileSync(join(logDir, `${taskId}.jsonl`), "utf8")) : [];
      const checkout = /checkout kept at (.+)$/m.exec(out.stderr)?.[1] ?? null;
      return { code, result: last?.startsWith("{") ? JSON.parse(last) : null, stdout: out.stdout, stderr: out.stderr, cwd, tmpRoot, checkout, stubRuns };
    });
    return { child, done, out, cwd, tmpRoot };
  }
  const job = (...args) => startJob(...args).done;

  // A `claude` written as a script, for tests that need it to do something particular.
  const RESULT_LINE = '{"type":"result","subtype":"success","is_error":false,"result":"done"}';
  const fakeClaude = (body, { node = false } = {}) => {
    const file = join(tmp, `fake-claude-${++counter}${node ? ".mjs" : ""}`);
    writeFileSync(file, node ? `#!/usr/bin/env node\n${body}` : `#!/bin/sh\n${body}`, { mode: 0o755 });
    return file;
  };
  const withFake = (bin, env = {}) => ({ CLAUDE_BIN: bin, RYKE_AGENT_STUB: "0", ...env });

  const submitBodies = (api) => api.of(`POST /api/txns/${TXN}/submit`).map((c) => c.body);

  it("runs one attempt: clones, lets claude work, commits as the agent, pushes, submits with evidence, waits", async () => {
    const api = await s.start(baseRoutes());
    const fork = cloneBare("fork");
    const snapshot = git(fork, "rev-parse", "refs/heads/main");
    const task = byId("cat-area");
    const r = await job(api, fork, "cat-area", { keep: true });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.result, { ok: true, txn: TXN, state: "landed", attempts: 1, landed: true, reason: null, seq: 5, train: "tr_1" });

    // The commit on the fork.
    const head = git(fork, "rev-parse", "refs/heads/main");
    assert.notEqual(head, snapshot);
    assert.equal(git(fork, "log", "-1", "--format=%an <%ae>|%cn|%s", head), `agent-07 <agent-07@agents.ryke.ai>|agent-07|${task.intent}`);
    assert.equal(git(fork, "rev-parse", `${head}^`), snapshot);
    const changed = git(fork, "diff", "--name-only", snapshot, head).split("\n").sort();
    assert.deepEqual(changed, [...task.writes].sort(), "scaffolding (.ryke, .claude) is not part of the change");

    // The submit.
    const [submit] = submitBodies(api);
    assert.equal(submit.head, head);
    assert.equal(submit.evidence.screenshot, task.screenshot_description);
    assert.match(submit.evidence.summary, /^claude \(stub\) attempt 1: Applied v1 of cat-area/);
    assert.equal(api.of(`POST /api/txns/${TXN}/submit`)[0].auth, "Bearer dev-token");
    assert.equal(api.of(`GET /api/txns/${TXN}/wait`).length, 1);

    // The hooks ran: reads went to the API as they happened, and every write asked for its lease.
    const reads = [...new Set(api.of(`POST /api/txns/${TXN}/reads`).flatMap((c) => c.body.paths))].sort();
    assert.deepEqual(reads, ["src/format.ts", "src/registry.ts", "src/ui/layout.ts", "src/units/length.ts"]);
    assert.deepEqual(api.of(`POST /api/txns/${TXN}/intend-write`).map((c) => c.body.path).sort(), [...task.writes].sort());
    const writes = lines(readFileSync(join(r.checkout, ".ryke/writes.jsonl"), "utf8"));
    assert.deepEqual(writes.map((w) => w.path).sort(), [...task.writes].sort());
    assert.equal(r.stubRuns.length, 1);
    assert.equal(r.stubRuns[0].variant, "v1");
    assert.equal(r.stubRuns[0].model, "claude-sonnet-5-5");
  });

  it("keeps the fork's git token out of arguments, logs and Claude's environment", async () => {
    const api = await s.start(baseRoutes());
    const r = await job(api, cloneBare("fork"), "cat-area", { env: { RYKE_AGENT_VERBOSE: "1" } });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /fork-secret/);
    assert.equal(r.stubRuns.length, 1);
    assert.equal(r.stubRuns[0].env.RYKE_FORK_TOKEN, null, "claude's Bash tool inherits its environment");
    assert.equal(r.stubRuns[0].env.RYKE_TOKEN, "dev-token", "the hooks need the API token, so claude sees it too");
  });

  it("re-sends every read the hooks logged before it submits, so a lost POST cannot shrink the footprint", async () => {
    const flaky = baseRoutes({ [`POST /api/txns/${TXN}/reads`]: (_c, n) => (n <= 6 ? [503, { error: "restarting" }] : { recorded: 0, staleWarnings: [] }) });
    const api = await s.start(flaky);
    const r = await job(api, cloneBare("fork"), "cat-area");
    assert.equal(r.code, 0, r.stderr);
    const calls = api.of(`POST /api/txns/${TXN}/reads`);
    const final = calls.at(-1).body.paths.sort();
    assert.deepEqual(final, ["src/format.ts", "src/registry.ts", "src/ui/layout.ts", "src/units/length.ts"], "the last call carries the union of everything read");
    assert.match(r.stderr, /reads reported: 4 files/);
  });

  it("on stale: retries, syncs to the returned snapshot from trunk, and re-runs claude with the delta", async () => {
    const trunk = cloneBare("trunk");
    const fork = cloneBare("fork");
    const advanced = advanceTrunk(trunk);
    const delta = [{ path: "src/format.ts", patch: "--- a/src/format.ts\n+++ b/src/format.ts\n@@ -4,3 +4,6 @@\n-  return n.toFixed(digits);\n+  const fixed = n.toFixed(digits);\n" }];
    const api = await s.start(
      baseRoutes({
        [`POST /api/txns/${TXN}/submit`]: (_c, n) => (n === 1 ? { state: "stale", reason: "stale_read", paths: [{ path: "src/format.ts", seq: 1, by: "t_pre" }] } : { state: "ready" }),
        [`POST /api/txns/${TXN}/retry`]: () => ({ snapshot: advanced, attempt: 2, delta, failures: null, trunk: { remote: trunk, token: "trunk-read" }, remote: fork, token: "fork-write-2" }),
      }),
    );
    const task = byId("cat-area");
    const r = await job(api, fork, "cat-area", { keep: true });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.result.ok, r.result.state, r.result.attempts, r.result.landed], [true, "landed", 2, true]);

    // Two runs of claude: the second one knows what changed and starts from the new trunk.
    assert.equal(r.stubRuns.length, 2);
    const [first, second] = r.stubRuns;
    assert.equal(first.variant, "v1");
    assert.doesNotMatch(first.prompt, new RegExp(RETRY_STALE));
    assert.equal(second.variant, "v2", "t-precision is on trunk now, so the patch written for that trunk is the one that fits");
    assert.ok(second.prompt.startsWith(first.prompt), "the retry prompt is the original prompt with the delta appended");
    assert.ok(second.prompt.includes(RETRY_STALE));
    assert.match(second.prompt, /### src\/format\.ts\n```diff\n--- a\/src\/format\.ts/);
    assert.match(second.prompt, /attempt 2 of 3/);
    assert.match(second.prompt, new RegExp(`fresh copy of trunk at ${advanced.slice(0, 8)}`));

    // The fork got the second attempt on top of the new snapshot (a force push: it replaces the first attempt).
    const head = git(fork, "rev-parse", "refs/heads/main");
    assert.equal(git(fork, "rev-parse", `${head}^`), advanced);
    assert.equal(submitBodies(api).length, 2);
    assert.equal(submitBodies(api)[1].head, head);
    assert.match(submitBodies(api)[1].evidence.summary, /attempt 2: Applied v2 of cat-area/);
    assert.equal(git(fork, "diff", "--name-only", advanced, head).split("\n").sort().join(), [...task.writes].sort().join());

    // The first attempt's diff is kept for claude, outside the commit, and the fork was written with the retry's token.
    assert.match(readFileSync(join(r.checkout, ".ryke/previous.patch"), "utf8"), /diff --git a\/src\/units\/area\.ts/);
    assert.equal(existsSync(join(r.checkout, ".ryke/attempt-1/reads.jsonl")), true, "attempt 1's tracking moved aside");
    assert.equal(api.of(`POST /api/txns/${TXN}/retry`).length, 1);
  });

  it("on failed: retries and shows claude the failing tests", async () => {
    const trunk = cloneBare("trunk");
    const fork = cloneBare("fork");
    const advanced = advanceTrunk(trunk);
    const api = await s.start(
      baseRoutes({
        [`GET /api/txns/${TXN}/wait`]: (_c, n) =>
          n === 1
            ? { txn: { id: TXN, state: "failed", reason: "tests_failed", train: "tr_1" }, changed: true, staleWarnings: [], detail: {} }
            : { txn: { id: TXN, state: "landed", landedSeq: 9, train: "tr_2", reason: null }, changed: true, staleWarnings: [], detail: {} },
        [`POST /api/txns/${TXN}/retry`]: () => ({
          snapshot: advanced,
          attempt: 2,
          delta: [],
          failures: [{ name: "area converts hectares", message: "expected '10000.00' but got '10000'" }],
          trunk: { remote: trunk, token: "t" },
          remote: fork,
          token: "f2",
        }),
      }),
    );
    const r = await job(api, fork, "cat-area");
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.result.state, r.result.attempts, r.result.seq], ["landed", 2, 9]);
    const second = r.stubRuns[1];
    assert.ok(second.prompt.includes(RETRY_FAILED));
    assert.match(second.prompt, /- area converts hectares: expected '10000\.00' but got '10000'/);
    assert.equal(second.variant, "v2");
  });

  it("stops at a terminal state without retrying: rejected as protected", async () => {
    const api = await s.start(baseRoutes({ [`POST /api/txns/${TXN}/submit`]: () => ({ state: "rejected", reason: "protected", paths: ["test/routes.test.ts"] }) }));
    const r = await job(api, cloneBare("fork"), "tamper-routes");
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.result.ok, r.result.state, r.result.landed, r.result.reason], [true, "rejected", false, "protected"]);
    assert.equal(api.of(`POST /api/txns/${TXN}/retry`).length, 0);
    assert.equal(api.of(`GET /api/txns/${TXN}/wait`).length, 0, "a rejection at submit needs no waiting");
  });

  it("stops at needs_human", async () => {
    const api = await s.start(baseRoutes({ [`GET /api/txns/${TXN}/wait`]: () => ({ txn: { id: TXN, state: "needs_human", reason: "low_confidence" }, changed: true, staleWarnings: [], detail: {} }) }));
    const r = await job(api, cloneBare("fork"), "cat-area");
    assert.deepEqual([r.result.ok, r.result.state, r.result.landed], [true, "needs_human", false]);
  });

  it("keeps waiting while the transaction is submitted, ready or verifying", async () => {
    const states = ["submitted", "ready", "verifying", "verifying"];
    const api = await s.start(
      baseRoutes({
        [`GET /api/txns/${TXN}/wait`]: (_c, n) => ({ txn: { id: TXN, state: n <= states.length ? states[n - 1] : "landed", landedSeq: 3, train: "tr_1" }, changed: true, staleWarnings: [], detail: {} }),
      }),
    );
    const r = await job(api, cloneBare("fork"), "kelvin-first");
    assert.equal(r.result.state, "landed");
    assert.equal(api.of(`GET /api/txns/${TXN}/wait`).length, 5);
  });

  it("reports the in-flight state when the wait times out", async () => {
    const api = await s.start(baseRoutes({ [`GET /api/txns/${TXN}/wait`]: () => ({ txn: { id: TXN, state: "verifying" }, changed: false, staleWarnings: [], detail: {} }) }));
    const r = await job(api, cloneBare("fork"), "kelvin-first", { env: { RYKE_WAIT_S: "0.3" } });
    assert.equal(r.code, 1);
    assert.deepEqual([r.result.ok, r.result.state, r.result.reason], [false, "verifying", "wait_timeout"]);
  });

  it("gives up after --max-attempts: aborts the transaction instead of leaving it stale", async () => {
    const api = await s.start(baseRoutes({ [`POST /api/txns/${TXN}/submit`]: () => ({ state: "stale", reason: "stale_read", paths: [{ path: "src/format.ts", seq: 1, by: "t_pre" }] }) }));
    const r = await job(api, cloneBare("fork"), "cat-area", { args: { "max-attempts": "1" } });
    assert.deepEqual([r.result.ok, r.result.state, r.result.attempts, r.result.reason], [true, "aborted", 1, "max_attempts"]);
    assert.deepEqual(api.of(`POST /api/txns/${TXN}/abort`).map((c) => c.body), [{ reason: "max_attempts" }]);
    assert.equal(api.of(`POST /api/txns/${TXN}/retry`).length, 0);
  });

  it("answers a 409 on retry by reporting where the transaction ended up", async () => {
    const api = await s.start(
      baseRoutes({
        [`POST /api/txns/${TXN}/submit`]: () => ({ state: "stale", reason: "stale_read", paths: [] }),
        [`POST /api/txns/${TXN}/retry`]: () => [409, { error: "transaction t_1 is aborted" }],
        [`GET /api/txns/${TXN}`]: () => ({ txn: { id: TXN, state: "aborted", reason: "max_attempts" } }),
      }),
    );
    const r = await job(api, cloneBare("fork"), "cat-area");
    assert.deepEqual([r.code, r.result.ok, r.result.state, r.result.reason], [0, true, "aborted", "max_attempts"]);
  });

  it("submits the snapshot itself when claude changed nothing, and does not push", async () => {
    const api = await s.start(baseRoutes({ [`POST /api/txns/${TXN}/submit`]: () => ({ state: "rejected", reason: "empty" }) }));
    const fork = cloneBare("fork");
    const snapshot = git(fork, "rev-parse", "refs/heads/main");
    const idle = join(tmp, `idle-claude-${++counter}`);
    writeFileSync(idle, '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"nothing to change"}\\n\'\n', { mode: 0o755 });
    const r = await job(api, fork, "cat-area", { env: { CLAUDE_BIN: idle, RYKE_AGENT_STUB: "0" } });
    assert.deepEqual([r.code, r.result.ok, r.result.state, r.result.reason], [0, true, "rejected", "empty"]);
    assert.equal(submitBodies(api)[0].head, snapshot);
    assert.equal(git(fork, "rev-parse", "refs/heads/main"), snapshot, "nothing was pushed");
    assert.equal("screenshot" in submitBodies(api)[0].evidence, false, "no screenshot.txt, no screenshot");
    assert.match(submitBodies(api)[0].evidence.summary, /^claude attempt 1: nothing to change/, "a real run is not labelled as the stub");
  });

  describe("whose credentials claude runs on", () => {
    it("on a subscription, no key from the runner's environment reaches claude", async () => {
      const api = await s.start(baseRoutes());
      const r = await job(api, cloneBare("fork"), "cat-area", { args: { auth: "subscription" }, env: { ANTHROPIC_API_KEY: "sk-ant-shell", ANTHROPIC_BASE_URL: "http://elsewhere", OPENAI_API_KEY: "sk-openai-shell" } });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.state, "landed");
      assert.match(r.stderr, /claude runs on your own login \(subscription\)/);
      const seen = r.stubRuns[0].envNames;
      for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY"]) assert.ok(!seen.includes(name), `${name} must not reach claude`);
      assert.doesNotMatch(r.stdout + r.stderr, /sk-ant-shell|sk-openai-shell/);
    });

    it("on a key, claude gets that key and nothing of Codex's", async () => {
      const api = await s.start(baseRoutes());
      const r = await job(api, cloneBare("fork"), "cat-area", { args: { auth: "api-key" }, env: { ANTHROPIC_API_KEY: "sk-ant-shell", OPENAI_API_KEY: "sk-openai-shell", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-shell" } });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /claude runs on an API key/);
      const seen = r.stubRuns[0].envNames;
      assert.ok(seen.includes("ANTHROPIC_API_KEY"));
      assert.ok(!seen.includes("OPENAI_API_KEY") && !seen.includes("CLAUDE_CODE_OAUTH_TOKEN"));
    });

    it("refuses a key run without a key, before it clones anything, and aborts the transaction", async () => {
      const api = await s.start(baseRoutes());
      const env = { ANTHROPIC_API_KEY: "" };
      const r = await job(api, cloneBare("fork"), "cat-area", { args: { auth: "api-key" }, env });
      assert.equal(r.code, 1);
      assert.match(r.result.error, /--auth api-key needs ANTHROPIC_API_KEY/);
      assert.equal(r.stubRuns.length, 0, "claude never ran");
      assert.deepEqual(api.of(`POST /api/txns/${TXN}/abort`).map((c) => c.body.reason), ["agent_error"]);
    });
  });

  describe("codex", () => {
    const codexJob = (api, fork, taskId, { args = {}, env = {}, keep = false } = {}) =>
      job(api, fork, taskId, { keep, args: { cli: "codex", model: "codex-model-x", ...args }, env: { CODEX_BIN: STUB_BINS.codex, ...env } });

    it("runs one attempt: codex works without hooks, its reads and patches reach the Ledger from its event stream", async () => {
      const api = await s.start(baseRoutes());
      const fork = cloneBare("fork");
      const snapshot = git(fork, "rev-parse", "refs/heads/main");
      const task = byId("cat-area");
      const r = await codexJob(api, fork, "cat-area", { keep: true });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.result, { ok: true, txn: TXN, state: "landed", attempts: 1, landed: true, reason: null, seq: 5, train: "tr_1" });
      assert.match(r.stderr, /attempt 1 of 3: stub .*codex-stub\/codex --model codex-model-x/);
      assert.match(r.stderr, /codex: patch /);
      assert.match(r.stderr, /codex: turn completed/);

      // The change, committed by the agent on the snapshot, scaffolding left out.
      const head = git(fork, "rev-parse", "refs/heads/main");
      assert.equal(git(fork, "rev-parse", `${head}^`), snapshot);
      assert.equal(git(fork, "log", "-1", "--format=%an", head), "agent-07");
      assert.deepEqual(git(fork, "diff", "--name-only", snapshot, head).split("\n").sort(), [...task.writes].sort());
      assert.equal(existsSync(join(r.checkout, ".claude")), false, "codex gets no Claude hooks");

      // Reads: every file it cat'ed or found, and every existing file it patched; none it created.
      const existing = task.writes.filter((p) => existsSync(join(seed(), p)));
      const reads = [...new Set(api.of(`POST /api/txns/${TXN}/reads`).flatMap((c) => c.body.paths))].sort();
      assert.deepEqual(reads, [...new Set([...task.reads, ...existing])].sort());
      assert.ok(lines(readFileSync(join(r.checkout, ".ryke/reads.jsonl"), "utf8")).every((l) => l.tool === "codex"));
      // Every file it patched asked for its lease, once.
      assert.deepEqual(api.of(`POST /api/txns/${TXN}/intend-write`).map((c) => c.body.path).sort(), [...task.writes].sort());

      const [submit] = submitBodies(api);
      assert.equal(submit.head, head);
      assert.match(submit.evidence.summary, /^codex \(stub\) attempt 1: Applied v1 of cat-area/);
      assert.equal(submit.evidence.screenshot, task.screenshot_description);
      assert.equal(r.stubRuns[0].model, "codex-model-x");
      assert.match(r.stubRuns[0].prompt, /Ryke tracks your reads from the commands you run/);
      assert.doesNotMatch(r.stubRuns[0].prompt, /Read tool|hook/);
      assert.equal(existsSync(join(r.cwd, "transcripts", "codex-1.jsonl")), true);
    });

    it("gives codex neither Ryke's tokens nor Claude's credentials", async () => {
      const api = await s.start(baseRoutes());
      const r = await codexJob(api, cloneBare("fork"), "cat-area", { env: { ANTHROPIC_API_KEY: "sk-ant-shell", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-shell", CLAUDE_CONFIG_DIR: "/c" } });
      assert.equal(r.code, 0, r.stderr);
      const seen = r.stubRuns[0].envNames;
      for (const name of ["RYKE_TOKEN", "RYKE_FORK_TOKEN", "RYKE_API_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "IS_SANDBOX"]) assert.ok(!seen.includes(name), `${name} must not reach codex`);
    });

    it("on a subscription, no key reaches codex: it uses its own ChatGPT login", async () => {
      const api = await s.start(baseRoutes());
      const r = await codexJob(api, cloneBare("fork"), "cat-area", { args: { auth: "subscription" }, env: { OPENAI_API_KEY: "sk-openai-shell", CODEX_API_KEY: "sk-codex-shell", CODEX_ACCESS_TOKEN: "pat-shell", CODEX_HOME: "/home/x/.codex" } });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /codex runs on your own login \(subscription\)/);
      const seen = r.stubRuns[0].envNames;
      for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]) assert.ok(!seen.includes(name), `${name} must not reach codex`);
      assert.ok(seen.includes("CODEX_HOME"), "where codex keeps its login");
    });

    it("on a key, codex gets OPENAI_API_KEY under its own name", async () => {
      const api = await s.start(baseRoutes());
      const r = await codexJob(api, cloneBare("fork"), "cat-area", { args: { auth: "api-key" }, env: { OPENAI_API_KEY: "sk-openai-shell", RYKE_STUB_LOGIN: "none" } });
      assert.equal(r.code, 0, r.stderr);
      const seen = r.stubRuns[0].envNames;
      assert.ok(seen.includes("CODEX_API_KEY"));
      assert.ok(!seen.includes("OPENAI_API_KEY"));
    });

    it("aborts with codex's own reason when it cannot run, here because nobody is logged in", async () => {
      const api = await s.start(baseRoutes());
      const r = await codexJob(api, cloneBare("fork"), "cat-area", { args: { auth: "subscription" }, env: { RYKE_STUB_LOGIN: "none" } });
      assert.equal(r.code, 1);
      assert.deepEqual([r.result.ok, r.result.state, r.result.reason], [false, "aborted", "agent_error"]);
      assert.match(r.result.error, /codex: Not logged in/);
      assert.deepEqual(api.of(`POST /api/txns/${TXN}/abort`).map((c) => c.body.reason), ["agent_error"]);
      assert.equal(submitBodies(api).length, 0);
    });

    it("on stale: re-runs codex on the new trunk with the delta, and the second patch fits it", async () => {
      const trunk = cloneBare("trunk");
      const fork = cloneBare("fork");
      const advanced = advanceTrunk(trunk);
      const delta = [{ path: "src/format.ts", patch: "--- a/src/format.ts\n+++ b/src/format.ts\n@@ -4,3 +4,6 @@\n" }];
      const api = await s.start(
        baseRoutes({
          [`POST /api/txns/${TXN}/submit`]: (_c, n) => (n === 1 ? { state: "stale", reason: "stale_read", paths: [{ path: "src/format.ts", seq: 1, by: "t_pre" }] } : { state: "ready" }),
          [`POST /api/txns/${TXN}/retry`]: () => ({ snapshot: advanced, attempt: 2, delta, failures: null, trunk: { remote: trunk, token: "trunk-read" }, remote: fork, token: "fork-write-2" }),
        }),
      );
      const r = await codexJob(api, fork, "cat-area", { keep: true });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual([r.result.state, r.result.attempts], ["landed", 2]);
      const [first, second] = r.stubRuns;
      assert.deepEqual([first.variant, second.variant], ["v1", "v2"]);
      assert.ok(second.prompt.startsWith(first.prompt));
      assert.ok(second.prompt.includes(RETRY_STALE));
      assert.equal(git(fork, "rev-parse", `${git(fork, "rev-parse", "refs/heads/main")}^`), advanced);
      assert.equal(existsSync(join(r.checkout, ".ryke/attempt-1/reads.jsonl")), true, "attempt 1's reads moved aside");
      assert.equal(existsSync(join(r.cwd, "transcripts", "codex-2.jsonl")), true);
    });

    it("leaves leases alone when contention control is off", async () => {
      const api = await s.start(baseRoutes());
      const r = await codexJob(api, cloneBare("fork"), "cat-area", { env: { RYKE_CONTENTION: "off" } });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(api.of(`POST /api/txns/${TXN}/intend-write`).length, 0);
      assert.ok(api.of(`POST /api/txns/${TXN}/reads`).length > 0, "reads are reported either way");
    });

    it("says so when another transaction holds the lease on a file codex patched, and goes on", async () => {
      const api = await s.start(baseRoutes({ [`POST /api/txns/${TXN}/intend-write`]: () => ({ go: false, owner: "t_other", retryAfterMs: 500 }) }));
      const r = await codexJob(api, cloneBare("fork"), "cat-area");
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /is leased to t_other; codex has already written it/);
      assert.equal(r.result.state, "landed");
    });
  });

  describe("claude's own commits", () => {
    // Claude often ignores "Do not commit". Only the tree it leaves counts, and the agent commits it.
    it("are dropped and the tree it left is committed by the agent on top of the snapshot", async () => {
      const api = await s.start(baseRoutes());
      const fork = cloneBare("fork");
      const snapshot = git(fork, "rev-parse", "refs/heads/main");
      const claude = fakeClaude(
        [
          "echo 'export const extra = 1;' > src/extra.ts",
          "git add -A",
          "git -c user.name=claude -c user.email=claude@example.com commit -q -m \"claude's own commit\"",
          "echo '// edited after the commit' >> src/extra.ts",
          "echo 'export const second = 2;' > src/second.ts",
          `printf '%s\\n' '${RESULT_LINE}'`,
        ].join("\n"),
      );
      const r = await job(api, fork, "cat-area", { env: withFake(claude) });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.state, "landed");
      assert.doesNotMatch(r.stderr, /no changes were made/);
      const [submit] = submitBodies(api);
      assert.notEqual(submit.head, snapshot, "the Ledger would reject the snapshot itself as empty");
      assert.equal(git(fork, "rev-parse", "refs/heads/main"), submit.head, "and it was pushed");
      assert.equal(git(fork, "rev-parse", `${submit.head}^`), snapshot, "one commit on the snapshot: Claude's is gone");
      assert.equal(git(fork, "log", "-1", "--format=%an <%ae>|%cn|%s", submit.head), `agent-07 <agent-07@agents.ryke.ai>|agent-07|${byId("cat-area").intent}`);
      assert.deepEqual(git(fork, "diff", "--name-only", snapshot, submit.head).split("\n").sort(), ["src/extra.ts", "src/second.ts"]);
      assert.equal(git(fork, "show", `${submit.head}:src/extra.ts`), "export const extra = 1;\n// edited after the commit");
    });

    it("count even when that is all there is: nothing uncommitted left", async () => {
      const api = await s.start(baseRoutes());
      const fork = cloneBare("fork");
      const snapshot = git(fork, "rev-parse", "refs/heads/main");
      const claude = fakeClaude(["echo 'export const extra = 1;' > src/extra.ts", "git add -A", "git -c user.name=c -c user.email=c@example.com commit -q -m mine", `printf '%s\\n' '${RESULT_LINE}'`].join("\n"));
      const r = await job(api, fork, "cat-area", { env: withFake(claude) });
      assert.equal(r.result.state, "landed");
      assert.equal(git(fork, "diff", "--name-only", snapshot, submitBodies(api)[0].head), "src/extra.ts");
    });

    it("that are undone leave nothing to submit, as before", async () => {
      const api = await s.start(baseRoutes({ [`POST /api/txns/${TXN}/submit`]: () => ({ state: "rejected", reason: "empty" }) }));
      const fork = cloneBare("fork");
      const snapshot = git(fork, "rev-parse", "refs/heads/main");
      const claude = fakeClaude(["echo x > src/extra.ts", "git add -A", "git -c user.name=c -c user.email=c@example.com commit -q -m mine", "git reset -q --hard HEAD~1", `printf '%s\\n' '${RESULT_LINE}'`].join("\n"));
      const r = await job(api, fork, "cat-area", { env: withFake(claude) });
      assert.equal(r.result.reason, "empty");
      assert.equal(submitBodies(api)[0].head, snapshot);
      assert.equal(git(fork, "rev-parse", "refs/heads/main"), snapshot);
    });
  });

  describe("the checkout", () => {
    it("is a fresh directory under TMPDIR, outside the job's directory and the repo, with no CLAUDE.md above it", async () => {
      const api = await s.start(baseRoutes());
      const r = await job(api, cloneBare("fork"), "cat-area");
      assert.equal(r.code, 0, r.stderr);
      // The run has ended and removed the directory, so only its parent can be resolved.
      const cwd = join(realpathSync(dirname(r.stubRuns[0].cwd)), basename(r.stubRuns[0].cwd));
      assert.equal(dirname(cwd), realpathSync(r.tmpRoot), "made by mkdtemp under TMPDIR");
      assert.match(basename(cwd), /^ryke-agent-/);
      for (const [name, base] of [["the job's directory", r.cwd], ["the repo root", ROOT]]) {
        assert.ok(relative(realpathSync(base), cwd).startsWith(".."), `${cwd} is inside ${name}`);
      }
      for (let d = dirname(cwd); ; d = dirname(d)) {
        for (const f of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) assert.equal(existsSync(join(d, f)), false, `${join(d, f)} would be loaded into claude's context`);
        if (dirname(d) === d) break;
      }
    });

    it("is removed when the run ends, and its transcript is kept next to the job", async () => {
      const api = await s.start(baseRoutes());
      const r = await job(api, cloneBare("fork"), "cat-area");
      assert.equal(existsSync(r.stubRuns[0].cwd), false);
      assert.deepEqual(readdirSync(r.tmpRoot), []);
      const transcript = lines(readFileSync(join(r.cwd, "transcripts", "claude-1.jsonl"), "utf8"));
      assert.equal(transcript.at(-1).type, "result");
    });

    it("is removed when claude fails, and when the API goes wrong", async () => {
      const api = await s.start(baseRoutes({ [`POST /api/txns/${TXN}/submit`]: () => [422, { error: "head is not in fork" }] }));
      const pwd = join(tmp, `pwd-${++counter}`);
      const claude = fakeClaude(`pwd > ${pwd}\necho x > src/extra.ts\nprintf '%s\\n' '${RESULT_LINE}'`);
      const failed = await job(api, cloneBare("fork"), "cat-area", { env: withFake(claude) });
      assert.equal(failed.result.ok, false);
      assert.equal(existsSync(readFileSync(pwd, "utf8").trim()), false, "removed after an API failure");

      const bad = fakeClaude(`pwd > ${pwd}\necho x > src/extra.ts\nexit 1`);
      const second = await job(api, cloneBare("fork"), "cat-area", { env: withFake(bad) });
      assert.equal(second.result.ok, false);
      assert.equal(existsSync(readFileSync(pwd, "utf8").trim()), false, "removed after claude failed");
      assert.deepEqual(readdirSync(second.tmpRoot), []);
    });

    it("stays when RYKE_KEEP_CHECKOUT=1, and the log says where", async () => {
      const api = await s.start(baseRoutes());
      const r = await job(api, cloneBare("fork"), "cat-area", { keep: true });
      assert.ok(r.checkout && existsSync(join(r.checkout, ".ryke")), r.stderr);
      assert.equal(r.checkout, r.stubRuns[0].cwd);
    });

    for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    it(`is removed, and claude with it, when the job is cancelled with ${signal}`, async () => {
      const api = await s.start(baseRoutes());
      const pid = join(tmp, `claude-pid-${++counter}`);
      const pwd = join(tmp, `pwd-${++counter}`);
      const claude = fakeClaude(`pwd > ${pwd}\necho $$ > ${pid}\nsleep 300 &\nwait`);
      const run = startJob(api, cloneBare("fork"), "cat-area", { env: withFake(claude) });
      await until(() => existsSync(pid) && readFileSync(pid, "utf8").trim() !== "", 10_000, "claude to start");
      const claudePid = Number(readFileSync(pid, "utf8"));
      const dir = readFileSync(pwd, "utf8").trim();
      assert.equal(existsSync(dir), true);
      run.child.kill(signal);
      const r = await run.done;
      assert.equal(r.code, code);
      assert.equal(existsSync(dir), false);
      await until(() => !isRunning(claudePid), 5000, "claude to be killed with the job");
    });
    }

    it("is refused, before claude starts, when a CLAUDE.md sits above TMPDIR", async () => {
      const api = await s.start(baseRoutes());
      const project = fresh("project");
      mkdirSync(join(project, "tmp"), { recursive: true });
      writeFileSync(join(project, "CLAUDE.md"), "project rules\n");
      const r = await job(api, cloneBare("fork"), "cat-area", { env: { TMPDIR: join(project, "tmp") } });
      assert.equal(r.code, 1);
      assert.equal(r.result.ok, false);
      assert.match(r.result.error, /CLAUDE\.md would be loaded into claude's context.*TMPDIR/s);
      assert.equal(r.stubRuns.length, 0);
      assert.deepEqual(api.of(`POST /api/txns/${TXN}/abort`).map((c) => c.body), [{ reason: "agent_error" }], "the transaction does not stay open");
    });
  });

  describe("a transient API failure after claude has finished", () => {
    it("is ridden out: a 503 on submit and a 502 on wait cost a retry each, not the transaction", async () => {
      const api = await s.start(
        baseRoutes({
          [`POST /api/txns/${TXN}/submit`]: (_c, n) => (n === 1 ? [503, { error: "restarting" }] : { state: "ready" }),
          [`GET /api/txns/${TXN}/wait`]: (_c, n) => (n === 1 ? [502, { error: "bad gateway" }] : { txn: { id: TXN, state: "landed", landedSeq: 5, train: "tr_1" }, changed: true, staleWarnings: [], detail: {} }),
        }),
      );
      const r = await job(api, cloneBare("fork"), "cat-area");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual([r.result.ok, r.result.state, r.result.attempts], [true, "landed", 1]);
      assert.equal(api.of(`POST /api/txns/${TXN}/submit`).length, 2);
      assert.equal(api.of(`GET /api/txns/${TXN}/wait`).length, 2);
      assert.deepEqual(submitBodies(api)[0], submitBodies(api)[1], "submit is idempotent: the same head, the same evidence");
      assert.equal(api.of(`POST /api/txns/${TXN}/abort`).length, 0);
      assert.match(r.stderr, /POST \/api\/txns\/t_1\/submit failed \(.*503 restarting\); retrying in 0\.5 s/);
    });

    it("is ridden out on the transaction lookup after a 409 on retry, too", async () => {
      const api = await s.start(
        baseRoutes({
          [`POST /api/txns/${TXN}/submit`]: () => ({ state: "stale", reason: "stale_read", paths: [] }),
          [`POST /api/txns/${TXN}/retry`]: () => [409, { error: "transaction t_1 is aborted" }],
          [`GET /api/txns/${TXN}`]: (_c, n) => (n === 1 ? [503, { error: "restarting" }] : { txn: { id: TXN, state: "aborted", reason: "max_attempts" } }),
        }),
      );
      const r = await job(api, cloneBare("fork"), "cat-area");
      assert.deepEqual([r.result.ok, r.result.state, r.result.reason], [true, "aborted", "max_attempts"]);
      assert.equal(api.of(`GET /api/txns/${TXN}`).length, 2);
    });

    it("is not ridden out on retry, which creates an attempt: one 503 aborts the transaction", async () => {
      const api = await s.start(
        baseRoutes({
          [`POST /api/txns/${TXN}/submit`]: () => ({ state: "stale", reason: "stale_read", paths: [] }),
          [`POST /api/txns/${TXN}/retry`]: () => [503, { error: "restarting" }],
        }),
      );
      const r = await job(api, cloneBare("fork"), "cat-area");
      assert.equal(r.result.ok, false);
      assert.equal(api.of(`POST /api/txns/${TXN}/retry`).length, 1);
      assert.deepEqual(api.of(`POST /api/txns/${TXN}/abort`).map((c) => c.body), [{ reason: "agent_error" }]);
    });

    it("does not make a 4xx wait: a 422 on submit is one request", async () => {
      const api = await s.start(baseRoutes({ [`POST /api/txns/${TXN}/submit`]: () => [422, { error: "head is not in fork" }] }));
      const started = Date.now();
      const r = await job(api, cloneBare("fork"), "cat-area");
      assert.equal(r.result.ok, false);
      assert.equal(api.of(`POST /api/txns/${TXN}/submit`).length, 1);
      assert.ok(Date.now() - started < 20_000);
    });
  });

  describe("reads that went stale while claude worked", () => {
    const stale = [{ path: "src/format.ts", seq: 1, by: "t_pre" }];
    const DELTA = [{ path: "src/format.ts", patch: "--- a/src/format.ts\n+++ b/src/format.ts\n@@ -1 +1 @@\n-// delta from trunk: old\n+// delta from trunk: new\n" }];
    const READS = '{"at":1,"tool":"Read","paths":["src/format.ts","src/registry.ts"]}';
    const sequence = (api) => api.calls.map((c) => c.key).filter((k) => /\/(reads|refresh|retry|submit|abort)$|\/wait$/.test(k)).map((k) => k.split(" ")[1].replace(`/api/txns/${TXN}`, ""));
    const promptsOf = (file) => readFileSync(file, "utf8").split("\n----\n").filter(Boolean);

    // A claude that reads two files and then writes `body`; $last is the prompt.
    const worker = (runs, body) =>
      fakeClaude(["for a; do last=\"$a\"; done", `printf '%s\\n----\\n' "$last" >> ${runs}`, "mkdir -p .ryke", `printf '%s\\n' '${READS}' >> .ryke/reads.jsonl`, body, `printf '%s\\n' '${RESULT_LINE}'`].join("\n"));

    const refreshOnto = (trunk, snapshot, delta = DELTA) => ({ snapshot, attempt: 1, delta, trunk: { remote: trunk, token: "trunk-read" } });

    it("moves the agent's change onto the new trunk, re-sends the reads and submits there, on attempt 1", async () => {
      const trunk = cloneBare("trunk");
      const fork = cloneBare("fork");
      const advanced = advanceTrunk(trunk);
      const runs = join(tmp, `runs-${++counter}`);
      const claude = worker(runs, "echo 'export const extra = 1;' > src/extra.ts");
      const api = await s.start(
        baseRoutes({
          [`POST /api/txns/${TXN}/reads`]: (_c, n) => ({ recorded: 2, staleWarnings: n === 1 ? stale : [] }),
          [`POST /api/txns/${TXN}/refresh`]: () => refreshOnto(trunk, advanced),
        }),
      );
      const r = await job(api, fork, "cat-area", { env: withFake(claude) });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual([r.result.ok, r.result.state, r.result.attempts, r.result.landed], [true, "landed", 1, true]);
      assert.deepEqual(sequence(api), ["/reads", "/refresh", "/reads", "/submit", "/wait"], "stale reads are moved before submitting, and nothing is retried");
      assert.deepEqual(api.of(`POST /api/txns/${TXN}/reads`).map((c) => c.body.paths), [["src/format.ts", "src/registry.ts"], ["src/format.ts", "src/registry.ts"]], "the Ledger forgot the reads at the refresh, so all of them are sent again");
      assert.equal(api.of(`POST /api/txns/${TXN}/refresh`)[0].auth, "Bearer dev-token", "the job's own token may refresh");

      const [submit] = submitBodies(api);
      assert.equal(git(fork, "rev-parse", "refs/heads/main"), submit.head);
      assert.equal(git(fork, "rev-parse", `${submit.head}^`), advanced, "on top of the snapshot the Ledger now holds");
      assert.equal(git(fork, "show", `${submit.head}:src/extra.ts`), "export const extra = 1;");
      assert.match(git(fork, "show", `${submit.head}:src/format.ts`), /digits = 3/, "and trunk's own change is still there");
      assert.deepEqual(git(fork, "diff", "--name-only", advanced, submit.head), "src/extra.ts", "the write set is the agent's, not trunk's");
      assert.equal(git(fork, "log", "-1", "--format=%an|%s", submit.head), `agent-07|${byId("cat-area").intent}`);
      assert.equal(promptsOf(runs).length, 1, "claude ran once");
      assert.match(r.stderr, /moved onto trunk/);
    });

    it("rides out a transient failure of refresh", async () => {
      const trunk = cloneBare("trunk");
      const advanced = advanceTrunk(trunk);
      const claude = worker(join(tmp, `runs-${++counter}`), "echo 'export const extra = 1;' > src/extra.ts");
      const api = await s.start(
        baseRoutes({
          [`POST /api/txns/${TXN}/reads`]: (_c, n) => ({ recorded: 2, staleWarnings: n === 1 ? stale : [] }),
          [`POST /api/txns/${TXN}/refresh`]: (_c, n) => (n === 1 ? [503, { error: "restarting" }] : refreshOnto(trunk, advanced)),
        }),
      );
      const r = await job(api, cloneBare("fork"), "cat-area", { env: withFake(claude) });
      assert.equal(r.result.state, "landed");
      assert.equal(api.of(`POST /api/txns/${TXN}/refresh`).length, 2);
    });

    it("does not touch the trunk when claude changed nothing", async () => {
      const api = await s.start(baseRoutes({ [`POST /api/txns/${TXN}/reads`]: () => ({ recorded: 2, staleWarnings: stale }), [`POST /api/txns/${TXN}/submit`]: () => ({ state: "rejected", reason: "empty" }) }));
      const r = await job(api, cloneBare("fork"), "cat-area", { env: withFake(worker(join(tmp, `runs-${++counter}`), ":")) });
      assert.equal(r.result.reason, "empty");
      assert.equal(api.of(`POST /api/txns/${TXN}/refresh`).length, 0, "there is no work to move");
    });

    it("takes a change that trunk already holds as an empty submit, which the Ledger rejects", async () => {
      const trunk = cloneBare("trunk");
      const fork = cloneBare("fork");
      const advanced = commitOnTrunk(trunk, "src/extra.ts", "export const extra = 1;\n");
      const claude = worker(join(tmp, `runs-${++counter}`), "printf 'export const extra = 1;\\n' > src/extra.ts");
      const api = await s.start(
        baseRoutes({
          [`POST /api/txns/${TXN}/reads`]: (_c, n) => ({ recorded: 2, staleWarnings: n === 1 ? stale : [] }),
          [`POST /api/txns/${TXN}/refresh`]: () => refreshOnto(trunk, advanced),
          [`POST /api/txns/${TXN}/submit`]: () => ({ state: "rejected", reason: "empty" }),
        }),
      );
      const r = await job(api, fork, "cat-area", { env: withFake(claude) });
      assert.deepEqual([r.result.ok, r.result.state, r.result.reason], [true, "rejected", "empty"]);
      assert.equal(git(fork, "rev-parse", `${submitBodies(api)[0].head}^{tree}`), git(fork, "rev-parse", `${advanced}^{tree}`), "no change on top of trunk");
    });

    it("asks again after moving, and stops after three rounds with what it has", async () => {
      const trunk = cloneBare("trunk");
      const fork = cloneBare("fork");
      const commits = [1, 2, 3, 4].map((i) => commitOnTrunk(trunk, `trunk-${i}.txt`, `${i}\n`));
      const claude = worker(join(tmp, `runs-${++counter}`), "echo 'export const extra = 1;' > src/extra.ts");
      const api = await s.start(
        baseRoutes({
          [`POST /api/txns/${TXN}/reads`]: () => ({ recorded: 2, staleWarnings: stale }),
          [`POST /api/txns/${TXN}/refresh`]: (_c, n) => refreshOnto(trunk, commits[n - 1]),
          [`POST /api/txns/${TXN}/submit`]: () => ({ state: "stale", reason: "stale_read", paths: stale }),
          [`POST /api/txns/${TXN}/retry`]: () => [409, { error: "transaction t_1 is aborted" }],
          [`GET /api/txns/${TXN}`]: () => ({ txn: { id: TXN, state: "aborted", reason: "max_attempts" } }),
        }),
      );
      await job(api, fork, "cat-area", { env: withFake(claude) });
      assert.equal(api.of(`POST /api/txns/${TXN}/refresh`).length, 3);
      assert.equal(git(fork, "rev-parse", `${submitBodies(api)[0].head}^`), commits[2], "on the third trunk it moved to");
      assert.deepEqual(sequence(api).slice(0, 8), ["/reads", "/refresh", "/reads", "/refresh", "/reads", "/refresh", "/reads", "/submit"]);
    });

    it("submits where it stands when nothing moved, or when the Ledger will not refresh", async () => {
      const fork = cloneBare("fork");
      const snapshot = git(fork, "rev-parse", "refs/heads/main");
      const rows = [
        ["the trunk has not moved", () => ({ snapshot, attempt: 1, delta: [], trunk: { remote: fork, token: "t" } })],
        ["the transaction is no longer open (409)", () => [409, { error: "transaction t_1 is submitted; only open transactions can be refreshed" }]],
      ];
      for (const [name, refresh] of rows) {
        const claude = worker(join(tmp, `runs-${++counter}`), "echo 'export const extra = 1;' > src/extra.ts");
        const api = await s.start(baseRoutes({ [`POST /api/txns/${TXN}/reads`]: () => ({ recorded: 2, staleWarnings: stale }), [`POST /api/txns/${TXN}/refresh`]: refresh }));
        const r = await job(api, cloneBare("fork"), "cat-area", { env: withFake(claude) });
        assert.equal(r.result.state, "landed", name);
        assert.equal(api.of(`POST /api/txns/${TXN}/refresh`).length, 1, name);
        assert.equal(api.of(`POST /api/txns/${TXN}/submit`).length, 1, name);
      }
    });

    describe("when the change does not apply on the new trunk", () => {
      // Run 1 edits the line trunk changed; run 2, told why, only adds a file.
      const conflicting = (runs) => worker(runs, ['case "$last" in', '  *"files you read changed on trunk"*) echo "export const second = 1;" > src/extra.ts ;;', "  *) sed -i 's/digits = 2/digits = 5/' src/format.ts ;;", "esac"].join("\n"));

      it("starts claude again on the new trunk with what changed, in the same attempt, and submits that", async () => {
        const trunk = cloneBare("trunk");
        const fork = cloneBare("fork");
        const advanced = advanceTrunk(trunk);
        const runs = join(tmp, `runs-${++counter}`);
        const api = await s.start(
          baseRoutes({
            [`POST /api/txns/${TXN}/reads`]: (_c, n) => ({ recorded: 2, staleWarnings: n === 1 ? stale : [] }),
            [`POST /api/txns/${TXN}/refresh`]: () => refreshOnto(trunk, advanced),
          }),
        );
        const r = await job(api, fork, "cat-area", { env: withFake(conflicting(runs)), keep: true });
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual([r.result.ok, r.result.state, r.result.attempts], [true, "landed", 1], "the Ledger's attempt is unchanged: the refresh did not consume one");
        assert.match(r.stderr, /does not apply on trunk/);

        assert.equal(api.of(`POST /api/txns/${TXN}/refresh`).length, 1);
        assert.equal(api.of(`POST /api/txns/${TXN}/retry`).length, 0, "the transaction is open, so there is nothing to retry");
        assert.equal(api.of(`POST /api/txns/${TXN}/submit`).length, 1, "the commit on the old snapshot is never submitted");
        const [first, second] = promptsOf(runs);
        assert.equal(promptsOf(runs).length, 2);
        assert.ok(!first.includes(RETRY_STALE));
        assert.ok(second.startsWith(first), "the original prompt, with the notice appended");
        assert.ok(second.includes(RETRY_STALE));
        assert.match(second, /does not apply cleanly on the new trunk/);
        assert.match(second, /### src\/format\.ts\n```diff\n--- a\/src\/format\.ts[\s\S]*\+\/\/ delta from trunk: new/);
        assert.match(second, /attempt 2 of 3/);
        assert.match(second, new RegExp(`fresh copy of trunk at ${advanced.slice(0, 8)}`));
        assert.match(readFileSync(join(r.checkout, ".ryke/previous.patch"), "utf8"), /\+export function formatValue\(n: number, digits = 5\)/, "the first attempt's work is kept for claude");

        const [submit] = submitBodies(api);
        assert.equal(git(fork, "rev-parse", `${submit.head}^`), advanced);
        assert.equal(git(fork, "show", `${submit.head}:src/extra.ts`), 'export const second = 1;');
        assert.match(git(fork, "show", `${submit.head}:src/format.ts`), /digits = 3/);
        assert.equal(git(fork, "diff", "--name-only", advanced, submit.head), "src/extra.ts");
        assert.deepEqual(sequence(api), ["/reads", "/refresh", "/reads", "/submit", "/wait"]);
      });

      it("counts the second run against --max-attempts and aborts instead of starting a third", async () => {
        const trunk = cloneBare("trunk");
        const advanced = advanceTrunk(trunk);
        const api = await s.start(
          baseRoutes({
            [`POST /api/txns/${TXN}/reads`]: () => ({ recorded: 2, staleWarnings: stale }),
            [`POST /api/txns/${TXN}/refresh`]: () => refreshOnto(trunk, advanced),
          }),
        );
        const r = await job(api, cloneBare("fork"), "cat-area", { env: withFake(conflicting(join(tmp, `runs-${++counter}`))), args: { "max-attempts": "1" } });
        assert.deepEqual([r.result.ok, r.result.state, r.result.reason], [true, "aborted", "max_attempts"]);
        assert.deepEqual(api.of(`POST /api/txns/${TXN}/abort`).map((c) => c.body), [{ reason: "max_attempts" }]);
        assert.equal(api.of(`POST /api/txns/${TXN}/submit`).length, 0);
      });

      it("also counts runs that follow a stale outcome, so the two paths share one budget", async () => {
        const trunk = cloneBare("trunk");
        const advanced = advanceTrunk(trunk);
        const runs = join(tmp, `runs-${++counter}`);
        const api = await s.start(
          baseRoutes({
            [`POST /api/txns/${TXN}/reads`]: (_c, n) => ({ recorded: 2, staleWarnings: n === 1 ? stale : [] }),
            [`POST /api/txns/${TXN}/refresh`]: () => refreshOnto(trunk, advanced),
            [`POST /api/txns/${TXN}/submit`]: () => ({ state: "stale", reason: "stale_read", paths: stale }),
          }),
        );
        // Run 1 conflicts, run 2 is submitted and goes stale: with two runs allowed there is no third.
        const r = await job(api, cloneBare("fork"), "cat-area", { env: withFake(conflicting(runs)), args: { "max-attempts": "2" } });
        assert.equal(promptsOf(runs).length, 2);
        assert.deepEqual([r.result.state, r.result.reason], ["aborted", "max_attempts"]);
        assert.equal(api.of(`POST /api/txns/${TXN}/retry`).length, 0);
      });
    });
  });

  describe("claude's children", () => {
    // A detached grandchild is what Claude Code's Bash tool leaves behind: its own session, so a kill of
    // the process group never reaches it. The fake claude records its pid.
    const GRANDCHILDREN = [
      ["a shell's `setsid` command that holds claude's output open", (pid) => `setsid sleep 300 &\necho $! > ${pid}\nwait`],
      ["a shell's `setsid` command with its output redirected", (pid) => `setsid sleep 300 > /dev/null 2>&1 &\necho $! > ${pid}\nwait`],
    ];
    for (const [name, body] of GRANDCHILDREN) {
      it(`are killed with it when it runs past the timeout: ${name}`, { timeout: 60_000 }, async () => {
        const api = await s.start(baseRoutes());
        const pid = join(tmp, `grandchild-${++counter}`);
        const claude = fakeClaude(body(pid));
        const started = Date.now();
        const r = await job(api, cloneBare("fork"), "cat-area", { env: withFake(claude, { RYKE_CLAUDE_TIMEOUT_S: "0.5" }) });
        assert.ok(Date.now() - started < 30_000);
        assert.equal(r.result.error, "claude timed out");
        const grandchild = Number(readFileSync(pid, "utf8"));
        await until(() => !isRunning(grandchild), 5000, "the detached grandchild to be killed");
      });
    }

    it("are killed with it when it runs past the timeout: a node child detached with its own session", { timeout: 60_000 }, async () => {
      const api = await s.start(baseRoutes());
      const pid = join(tmp, `grandchild-${++counter}`);
      const claude = fakeClaude(
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          `const c = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });`,
          `writeFileSync(${JSON.stringify(pid)}, String(c.pid));`,
          "c.unref();",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        { node: true },
      );
      const r = await job(api, cloneBare("fork"), "cat-area", { env: withFake(claude, { RYKE_CLAUDE_TIMEOUT_S: "0.5" }) });
      assert.equal(r.result.error, "claude timed out");
      await until(() => !isRunning(Number(readFileSync(pid, "utf8"))), 5000, "the detached grandchild to be killed");
    });

    it("are killed when claude exits on its own and leaves a dev server behind", { timeout: 60_000 }, async () => {
      const api = await s.start(baseRoutes());
      const pid = join(tmp, `grandchild-${++counter}`);
      const claude = fakeClaude(`setsid sleep 300 > /dev/null 2>&1 &\necho $! > ${pid}\nsleep 2.2\nprintf '%s\\n' '${RESULT_LINE}'`);
      const r = await job(api, cloneBare("fork"), "cat-area", { env: withFake(claude) });
      assert.equal(r.result.ok, true, r.stderr);
      await until(() => !isRunning(Number(readFileSync(pid, "utf8"))), 5000, "the dev server to be killed once the session is over");
    });
  });

  describe("secrets", () => {
    it("RYKE_FORK_TOKEN is gone from the environment of everything agent.mjs starts, git included", async () => {
      const api = await s.start(baseRoutes());
      const shim = fresh("git-shim");
      mkdirSync(shim);
      const seen = join(tmp, `git-env-${++counter}`);
      const realGit = execFileSync("which", ["git"]).toString().trim();
      writeFileSync(join(shim, "git"), `#!/bin/sh\nenv >> ${seen}\nexec ${realGit} "$@"\n`, { mode: 0o755 });
      const r = await job(api, cloneBare("fork"), "cat-area", { env: { PATH: `${shim}:${process.env.PATH}` } });
      assert.equal(r.code, 0, r.stderr);
      const env = readFileSync(seen, "utf8");
      assert.ok(env.includes("GIT_CONFIG_VALUE_0=Authorization: Bearer fork-secret"), "git still gets the token, for the calls that need it");
      assert.doesNotMatch(env, /^RYKE_FORK_TOKEN=/m);
    });

    it("a job environment that carries host secrets does not pass them to claude, hooks or Bash", async () => {
      const api = await s.start(baseRoutes());
      const r = await job(api, cloneBare("fork"), "cat-area", { env: { TYPESAFE_API_KEY: "host-secret", RYKE_INTERNAL_SECRET: "internal-secret", GITHUB_TOKEN: "ghp_x" } });
      assert.equal(r.code, 0, r.stderr);
      const names = r.stubRuns[0].envNames;
      for (const secret of ["TYPESAFE_API_KEY", "RYKE_INTERNAL_SECRET", "GITHUB_TOKEN", "RYKE_FORK_TOKEN"]) assert.ok(!names.includes(secret), `${secret} reached claude`);
      for (const needed of ["PATH", "HOME", "RYKE_API_URL", "RYKE_TOKEN", "RYKE_TXN", "RYKE_CHECKOUT", "RYKE_ROOT", "IS_SANDBOX"]) assert.ok(names.includes(needed), `${needed} did not reach claude`);
      assert.doesNotMatch(r.stdout + r.stderr, /host-secret|internal-secret/);
    });
  });

  describe("when claude fails", () => {
    const abortBodies = (api) => api.of(`POST /api/txns/${TXN}/abort`).map((c) => c.body);

    it("aborts the transaction on a result line with is_error", async () => {
      const api = await s.start(baseRoutes());
      const task = byId("cat-area");
      const bad = join(tmp, `bad-claude-${++counter}`);
      writeFileSync(bad, '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key"}\\n\'\nexit 1\n', { mode: 0o755 });
      const r = await job(api, cloneBare("fork"), task.id, { env: { CLAUDE_BIN: bad, RYKE_AGENT_STUB: "0" } });
      assert.equal(r.code, 1);
      assert.deepEqual([r.result.ok, r.result.state, r.result.landed, r.result.reason, r.result.error], [false, "aborted", false, "agent_error", "Invalid API key"]);
      assert.deepEqual(abortBodies(api), [{ reason: "agent_error" }]);
      assert.equal(api.of(`POST /api/txns/${TXN}/submit`).length, 0);
    });

    it("aborts when the stub itself reports an error", async () => {
      const api = await s.start(baseRoutes());
      const empty = fresh("empty-catalogue");
      mkdirSync(empty);
      writeFileSync(join(empty, "tasks.json"), "[]");
      const r = await job(api, cloneBare("fork"), "cat-area", { env: { RYKE_CATALOGUE_DIR: empty } });
      assert.deepEqual([r.code, r.result.ok, r.result.state], [1, false, "aborted"]);
      assert.match(r.result.error, /stub: no task in/);
    });

    it("aborts when claude exits without a result line", async () => {
      const api = await s.start(baseRoutes());
      const mute = join(tmp, `mute-claude-${++counter}`);
      writeFileSync(mute, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
      const r = await job(api, cloneBare("fork"), "cat-area", { env: { CLAUDE_BIN: mute, RYKE_AGENT_STUB: "0" } });
      assert.deepEqual([r.result.ok, r.result.state], [false, "aborted"]);
      assert.match(r.result.error, /exited with code 3 without a result line/);
      assert.deepEqual(abortBodies(api), [{ reason: "agent_error" }]);
    });

    it("aborts when the claude binary does not exist", async () => {
      const api = await s.start(baseRoutes());
      const r = await job(api, cloneBare("fork"), "cat-area", { env: { CLAUDE_BIN: "/nonexistent/claude", RYKE_AGENT_STUB: "0" } });
      assert.deepEqual([r.result.ok, r.result.state], [false, "aborted"]);
      assert.match(r.stderr, /claude could not start/);
    });

    it("kills claude and everything it started when it runs past the timeout", async () => {
      const api = await s.start(baseRoutes());
      const pidFile = join(tmp, `child-pid-${++counter}`);
      const slow = join(tmp, `slow-claude-${++counter}`);
      writeFileSync(slow, `#!/bin/sh\nsleep 60 &\necho $! > ${pidFile}\nwait\n`, { mode: 0o755 });
      const started = Date.now();
      const r = await job(api, cloneBare("fork"), "cat-area", { env: { CLAUDE_BIN: slow, RYKE_AGENT_STUB: "0", RYKE_CLAUDE_TIMEOUT_S: "0.5" } });
      assert.ok(Date.now() - started < 20_000);
      assert.deepEqual([r.result.ok, r.result.state], [false, "aborted"]);
      assert.equal(r.result.error, "claude timed out");
      const pid = Number(readFileSync(pidFile, "utf8"));
      await until(() => !isRunning(pid), 5000, "the sleeping grandchild to be killed");
    });

    it("aborts the transaction and reports the error when the API goes wrong during submit", async () => {
      const api = await s.start(baseRoutes({ [`POST /api/txns/${TXN}/submit`]: () => [422, { error: "head is not in fork" }] }));
      const r = await job(api, cloneBare("fork"), "cat-area");
      assert.equal(r.code, 1);
      assert.equal(r.result.ok, false);
      assert.match(r.result.error, /submit -> 422 head is not in fork/);
      assert.deepEqual(abortBodies(api), [{ reason: "agent_error" }]);
    });
  });

  it("fails clearly when a required argument is missing", async () => {
    const api = await s.start(baseRoutes());
    const cwd = fresh("job");
    mkdirSync(cwd);
    const child = spawn("bash", [AGENT_SH, "--repo", "convert"], { cwd, env: { ...BASE_ENV, RYKE_API_URL: api.url }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.resume();
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)), { ok: false, error: "--txn is required" });
  });
});

// ---------------------------------------------------------------------------------------------
// The harness side
// ---------------------------------------------------------------------------------------------

describe("harness/agents/claude.mjs", () => {
  const s = servers();
  after(() => s.closeAll());

  describe("runner client and follow", () => {
    it("speaks the runner's job API", async () => {
      const text = "hello\nworld\n";
      const api = await s.start({
        "POST /v1/jobs": () => [201, { id: "j_1" }],
        "GET /v1/jobs/j_1": () => ({ id: "j_1", state: "done", exitCode: 0, result: { ok: true } }),
        "GET /v1/jobs/j_1/log": (c) => ({ raw: text.slice(Number(c.query.offset)), headers: { "x-ryke-next-offset": String(text.length) } }),
        "DELETE /v1/jobs/j_1": () => ({ cancelled: true }),
        "GET /v1/jobs/j_bad": () => [404, { error: { code: "NOT_FOUND", message: 'no such job "j_bad"' } }],
      });
      const runner = runnerClient(api.url);
      assert.equal(await runner.start("agent", { repo: "convert" }, { A: "1" }), "j_1");
      assert.deepEqual(api.of("POST /v1/jobs")[0].body, { kind: "agent", args: { repo: "convert" }, env: { A: "1" } });
      assert.deepEqual(await runner.status("j_1"), { id: "j_1", state: "done", exitCode: 0, result: { ok: true } });
      assert.deepEqual(await runner.log("j_1", 6), { text: "world\n", next: 12 });
      assert.deepEqual(await runner.cancel("j_1"), { cancelled: true });
      await assert.rejects(runner.status("j_bad"), /runner GET \/v1\/jobs\/j_bad -> 404: no such job "j_bad"/);
    });

    // A scripted runner: each poll takes the next status, and the log grows with it.
    const scripted = (steps) => {
      let i = 0;
      let text = "";
      const cancelled = [];
      return {
        cancelled,
        status: async () => ({ state: steps[Math.min(i, steps.length - 1)].state, result: steps[Math.min(i, steps.length - 1)].result }),
        log: async (_id, offset) => {
          text += steps[Math.min(i, steps.length - 1)].add ?? "";
          i++;
          return { text: text.slice(offset), next: text.length };
        },
        cancel: async (id) => cancelled.push(id),
      };
    };

    it("delivers lines in order, joins a line split across polls and flushes a last line without a newline", async () => {
      const runner = scripted([{ state: "running", add: "one\ntw" }, { state: "running", add: "o\nthree\n" }, { state: "done", add: "tail", result: { ok: true } }]);
      const got = [];
      const status = await follow(runner, "j", (l) => got.push(l), { pollMs: 1 });
      assert.deepEqual(got, ["one", "two", "three", "tail"]);
      assert.equal(status.state, "done");
    });

    it("reads the log once more after the job ends, so its last lines are not lost", async () => {
      const runner = scripted([{ state: "done", add: "all of it\n", result: { ok: true } }]);
      const got = [];
      await follow(runner, "j", (l) => got.push(l), { pollMs: 1 });
      assert.deepEqual(got, ["all of it"]);
    });

    it("returns failed jobs too", async () => {
      const status = await follow(scripted([{ state: "failed", add: "boom\n" }]), "j", () => {}, { pollMs: 1 });
      assert.equal(status.state, "failed");
    });

    it("cancels a job that outlives the timeout", async () => {
      const runner = scripted([{ state: "running", add: "." }]);
      await assert.rejects(follow(runner, "j_7", () => {}, { timeoutMs: 30, pollMs: 5 }), /agent job j_7 still running after 0 s; cancelled/);
      assert.deepEqual(runner.cancelled, ["j_7"]);
    });
  });

  it("relays the job's own lines, not its result line, blank lines or Node's proxy warnings", () => {
    const rows = [
      ["attempt 1 of 3: stub claude", true],
      ["claude: Edit src/a.ts", true],
      ['{"ok":true,"txn":"t_1","state":"landed"}', false],
      ["", false],
      ["   ", false],
      ["(node:4107) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.", false],
      ["(Use `node --trace-warnings ...` to show where the warning was created)", false],
      ["(node:12) Warning: something else", true],
    ];
    for (const [line, want] of rows) assert.equal(relayable(line), want, JSON.stringify(line));
  });

  describe("validateKey", () => {
    it("accepts a key the API accepts, once per key", async () => {
      const api = await s.start({ "GET /v1/models": () => ({ data: [] }) });
      await validateKey("sk-good", api.url);
      await validateKey("sk-good", api.url);
      assert.equal(api.calls.length, 1);
      assert.equal(api.calls[0].headers["x-api-key"], "sk-good");
      assert.equal(api.calls[0].headers["anthropic-version"], "2023-06-01");
      assert.equal(api.calls[0].query.limit, "1");
    });

    for (const status of [401, 403]) {
      it(`rejects a key answered with ${status}, naming the way out`, async () => {
        const api = await s.start({ "GET /v1/models": () => [status, { error: { type: "authentication_error" } }] });
        await assert.rejects(validateKey(`sk-bad-${status}`, api.url), new RegExp(`ANTHROPIC_API_KEY was rejected by ${api.url} \\(HTTP ${status}\\); fix the key or run with --stub`));
        await assert.rejects(validateKey(`sk-bad-${status}`, api.url), /was rejected/, "the verdict is remembered");
        assert.equal(api.calls.length, 1);
      });
    }

    it("lets Claude Code find out for itself when the API cannot be reached from here", async () => {
      const dead = await fakeServer();
      const url = dead.url;
      await dead.close();
      await validateKey("sk-unreachable", url);
    });

    it("does not treat other errors as a bad key", async () => {
      const api = await s.start({ "GET /v1/models": () => [529, { error: "overloaded" }] });
      await validateKey("sk-busy", api.url);
    });
  });

  describe("runTask", () => {
    const task = byId("cat-area");
    const BEGIN = { txn: "t_9", state: "open", snapshot: "0123456789abcdef", remote: "/forks/convert--t_9.git", token: "fork-token", agentToken: "rtx.t_9.agent", trunk: { remote: "/trunk.git", token: "t" }, warnings: [] };

    // A fake of the client the swarm passes in, recording what the agent calls. Like the Ledger, an abort
    // moves a transaction to aborted, unless `refuseAbort` says the train owns it (409).
    function ledger({ begin = BEGIN, txn = { id: "t_9", state: "landed", attempt: 1, landedSeq: 7, train: "tr_1", reason: null }, refuseAbort = false } = {}) {
      const calls = { begin: [], abort: [] };
      let current = txn;
      return {
        calls,
        begin: async (repo, input) => (calls.begin.push({ repo, input }), begin),
        txn: async () => ({ txn: current }),
        abort: async (id, reason) => {
          calls.abort.push({ id, reason });
          if (refuseAbort) throw Object.assign(new Error(`transaction ${id} is verifying; wait for the result`), { status: 409 });
          current = { ...current, state: "aborted", reason };
          return { state: "aborted" };
        },
      };
    }
    const runnerRoutes = (result, { state = "done", log = "", exitCode = 0 } = {}) => ({
      "POST /v1/jobs": () => [201, { id: "j_1" }],
      "GET /v1/jobs/j_1": () => ({ id: "j_1", state, exitCode, result }),
      "GET /v1/jobs/j_1/log": () => ({ raw: log, headers: { "x-ryke-next-offset": String(log.length) } }),
      "DELETE /v1/jobs/j_1": () => ({ cancelled: true }),
    });
    const ctxFor = async (api, runnerRoutesOrServer, over = {}) => {
      const runner = runnerRoutesOrServer.url ? runnerRoutesOrServer : await s.start(runnerRoutesOrServer);
      const out = [];
      // An explicit auth, so a key in the shell that runs the tests cannot change what they see.
      return { runner, out, ctx: { api, repo: "convert", task, dir: DEMO, worker: "agent-03", contention: true, log: (a, l) => out.push(`${a}|${l}`), stub: true, auth: "subscription", apiUrl: "http://api.test", token: "api-token", runnerUrl: runner.url, ...over } };
    };

    it("begins the transaction, starts the agent job with everything it needs and returns the scripted agent's record", async () => {
      const api = ledger();
      const { runner, ctx, out } = await ctxFor(api, runnerRoutes({ ok: true, txn: "t_9", state: "landed", attempts: 2, landed: true }, { log: "attempt 1 of 3\nattempt 2 of 3\n{\"ok\":true}\n" }));
      const r = await runTask(ctx);
      assert.deepEqual(r, { task: "cat-area", agent: "agent-03", model: STUB_MODEL, txn: "t_9", outcome: "landed", reason: null, attempts: 2, variants: [], warnings: 0, seq: 7, train: "tr_1" });
      assert.deepEqual(api.calls.begin, [{ repo: "convert", input: { agent: "agent-03", model: "claude-stub", intent: task.intent, criteria: task.criteria } }]);

      const [start] = runner.of("POST /v1/jobs");
      assert.equal(start.body.kind, "agent");
      assert.deepEqual(start.body.args, { repo: "convert", txn: "t_9", agent: "agent-03", intent: task.intent, criteria: JSON.stringify(task.criteria), cli: "claude", auth: "subscription", model: "claude-sonnet-5-5", remote: BEGIN.remote, snapshot: BEGIN.snapshot });
      assert.deepEqual(start.body.env, {
        RYKE_API_URL: "http://api.test",
        RYKE_TOKEN: "rtx.t_9.agent",
        RYKE_FORK_TOKEN: "fork-token",
        RYKE_CONTENTION: "on",
        RYKE_AGENT_STUB: "1",
        CLAUDE_BIN: STUB_BIN,
        RYKE_CATALOGUE_DIR: DEMO,
      });
      const logged = out.filter((l) => l.startsWith("agent-03|"));
      assert.ok(logged.some((l) => l.includes("cat-area  begin t_9 at 01234567")));
      assert.ok(logged.some((l) => l.includes("cat-area  attempt 2 of 3")), "the job's log lines are relayed");
      assert.ok(!logged.some((l) => l.includes('{"ok"')), "the result line is not a log line");
      assert.ok(logged.some((l) => l.includes("landed after 2 attempts, seq 7")));
    });

    it("hands the job the transaction's agent token, never the admin token, and aborts when begin has none", async () => {
      const api = ledger();
      const { runner, ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }));
      await runTask(ctx);
      const [start] = runner.of("POST /v1/jobs");
      assert.equal(start.body.env.RYKE_TOKEN, "rtx.t_9.agent");
      assert.ok(!JSON.stringify(start.body).includes("api-token"), "the admin token appears nowhere in the job");

      const bare = ledger({ begin: { ...BEGIN, agentToken: undefined } });
      const second = await ctxFor(bare, runnerRoutes({ ok: true, state: "landed", attempts: 1 }));
      await assert.rejects(runTask(second.ctx), /no agentToken/);
      assert.equal(second.runner.of("POST /v1/jobs").length, 0, "no job starts");
      assert.deepEqual(bare.calls.abort, [{ id: "t_9", reason: "agent_error" }]);
    });

    it("labels a stub run honestly, but keeps the sloppy pair's identity so a recall still finds it", async () => {
      const sloppy = byId("sloppy-a");
      const api = ledger();
      const { ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { task: sloppy });
      const r = await runTask(ctx);
      assert.deepEqual([r.agent, r.model], ["agent-13", "sloppy-v0"]);
      assert.deepEqual([api.calls.begin[0].input.agent, api.calls.begin[0].input.model], ["agent-13", "sloppy-v0"]);
    });

    it("passes the real binary, the model and the key through when it is not a stub, after the key checked out", async () => {
      const anthropic = await s.start({ "GET /v1/models": () => ({ data: [] }) });
      const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, bin: process.env.CLAUDE_BIN };
      process.env.ANTHROPIC_API_KEY = "sk-run-key";
      process.env.ANTHROPIC_BASE_URL = anthropic.url;
      process.env.CLAUDE_BIN = "/opt/claude";
      try {
        const api = ledger();
        const { runner, ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { stub: false, model: "claude-opus-5", contention: false, auth: "auto" });
        const r = await runTask(ctx);
        assert.equal(r.model, "claude-opus-5");
        assert.equal(api.calls.begin[0].input.model, "claude-opus-5");
        const [start] = runner.of("POST /v1/jobs");
        assert.equal(start.body.args.model, "claude-opus-5");
        assert.equal(start.body.args.auth, "api-key", "auto takes the key that is set");
        assert.deepEqual(start.body.env, {
          RYKE_API_URL: "http://api.test",
          RYKE_TOKEN: "rtx.t_9.agent",
          RYKE_FORK_TOKEN: "fork-token",
          RYKE_CONTENTION: "off",
          RYKE_AGENT_STUB: "0",
          CLAUDE_BIN: "/opt/claude",
          ANTHROPIC_API_KEY: "sk-run-key",
          ANTHROPIC_BASE_URL: anthropic.url,
        });
        assert.equal(anthropic.of("GET /v1/models")[0].headers["x-api-key"], "sk-run-key");
      } finally {
        for (const [k, v] of [["ANTHROPIC_API_KEY", saved.key], ["ANTHROPIC_BASE_URL", saved.base], ["CLAUDE_BIN", saved.bin]]) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });

    it("refuses to start anything when the key is rejected, before it begins a transaction", async () => {
      const anthropic = await s.start({ "GET /v1/models": () => [401, { error: {} }] });
      const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
      process.env.ANTHROPIC_API_KEY = "sk-nope";
      process.env.ANTHROPIC_BASE_URL = anthropic.url;
      try {
        const api = ledger();
        const { runner, ctx } = await ctxFor(api, runnerRoutes({}), { stub: false, auth: "api-key" });
        await assert.rejects(runTask(ctx), /ANTHROPIC_API_KEY was rejected/);
        assert.equal(api.calls.begin.length, 0);
        assert.equal(runner.calls.length, 0);
      } finally {
        for (const [k, v] of [["ANTHROPIC_API_KEY", saved.key], ["ANTHROPIC_BASE_URL", saved.base]]) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });

    it("hands a stub job the stub's knobs from this process, which the runner would not pass on", async () => {
      await withEnv({ RYKE_STUB_DELAY_MS: "7", RYKE_STUB_LOGIN: "claude.ai" }, async () => {
        const api = ledger();
        const { runner, ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }));
        await runTask(ctx);
        const env = runner.of("POST /v1/jobs")[0].body.env;
        assert.deepEqual([env.RYKE_STUB_DELAY_MS, env.RYKE_STUB_LOGIN], ["7", "claude.ai"]);
      });
      await withEnv({ RYKE_STUB_DELAY_MS: "7", CLAUDE_BIN: STUB_BIN }, async () => {
        const api = ledger();
        const { runner, ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { stub: false });
        await runTask(ctx);
        assert.equal("RYKE_STUB_DELAY_MS" in runner.of("POST /v1/jobs")[0].body.env, false, "a real run carries no stub knobs");
      });
    });

    it("lets a test or a caller add to the job's environment", async () => {
      const api = ledger();
      const { runner, ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { env: { RYKE_STUB_GATE_DIR: "/gates", RYKE_CONTENTION: "off" } });
      await runTask(ctx);
      const env = runner.of("POST /v1/jobs")[0].body.env;
      assert.equal(env.RYKE_STUB_GATE_DIR, "/gates");
      assert.equal(env.RYKE_CONTENTION, "off", "the caller's value wins");
    });

    // Sets process.env for one test and puts it back, whatever happens.
    async function withEnv(vars, fn) {
      const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
      for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        return await fn();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    it("runs codex's stub, labelled codex-stub, on the codex binary and without a model of Claude's", async () => {
      const api = ledger();
      const { runner, ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { cli: "codex" });
      const r = await withEnv({ RYKE_CODEX_MODEL: undefined }, () => runTask(ctx));
      assert.equal(r.model, "codex-stub");
      assert.equal(api.calls.begin[0].input.model, "codex-stub");
      const [start] = runner.of("POST /v1/jobs");
      assert.deepEqual(start.body.args, { repo: "convert", txn: "t_9", agent: "agent-03", intent: task.intent, criteria: JSON.stringify(task.criteria), cli: "codex", auth: "subscription", remote: BEGIN.remote, snapshot: BEGIN.snapshot });
      assert.deepEqual(start.body.env, { RYKE_API_URL: "http://api.test", RYKE_TOKEN: "rtx.t_9.agent", RYKE_FORK_TOKEN: "fork-token", RYKE_CONTENTION: "on", RYKE_AGENT_STUB: "1", CODEX_BIN: STUB_BINS.codex, RYKE_CATALOGUE_DIR: DEMO });
    });

    it("labels a real codex on its own default model as codex, and passes a model it was given", async () => {
      await withEnv({ CODEX_BIN: STUB_BINS.codex, RYKE_CODEX_MODEL: undefined }, async () => {
        const plain = ledger();
        const first = await ctxFor(plain, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { cli: "codex", stub: false });
        assert.equal((await runTask(first.ctx)).model, "codex");
        assert.equal("model" in first.runner.of("POST /v1/jobs")[0].body.args, false);
        assert.equal(first.runner.of("POST /v1/jobs")[0].body.env.CODEX_BIN, STUB_BINS.codex);

        const named = ledger();
        const second = await ctxFor(named, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { cli: "codex", stub: false, model: "codex-model-x" });
        assert.equal((await runTask(second.ctx)).model, "codex-model-x");
        assert.equal(second.runner.of("POST /v1/jobs")[0].body.args.model, "codex-model-x");
      });
    });

    it("hands a subscription job no key, even when the shell has one, and checks no key either", async () => {
      const anthropic = await s.start({ "GET /v1/models": () => ({ data: [] }) });
      await withEnv({ ANTHROPIC_API_KEY: "sk-shell", ANTHROPIC_BASE_URL: anthropic.url, CLAUDE_BIN: STUB_BIN }, async () => {
        const api = ledger();
        const { runner, ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { stub: false, auth: "subscription" });
        await runTask(ctx);
        const [start] = runner.of("POST /v1/jobs");
        assert.equal(start.body.args.auth, "subscription");
        assert.ok(!JSON.stringify(start.body).includes("sk-shell"), "the key appears nowhere in the job");
        assert.equal(anthropic.calls.length, 0, "a subscription run spends no call on a key");
      });
    });

    it("refuses a subscription on a runner that is not this machine, before it begins a transaction", async () => {
      const api = ledger();
      const { ctx } = await ctxFor(api, runnerRoutes({}), { runnerUrl: "http://10.0.0.5:8789" });
      await assert.rejects(runTask(ctx), /the runner must be on this machine/);
      assert.equal(api.calls.begin.length, 0);
    });

    it("refuses a CLI that is not logged in, before it begins a transaction", async () => {
      await withEnv({ RYKE_STUB_LOGIN: "none" }, async () => {
        const api = ledger();
        const { runner, ctx } = await ctxFor(api, runnerRoutes({}), { cli: "codex" });
        await assert.rejects(runTask(ctx), /codex is not logged in on this machine/);
        assert.equal(api.calls.begin.length, 0);
        assert.equal(runner.calls.length, 0);
      });
    });

    it("refuses an unknown CLI or auth mode", async () => {
      const { ctx } = await ctxFor(ledger(), runnerRoutes({}), { cli: "gemini" });
      await assert.rejects(runTask(ctx), /cli must be claude or codex, got gemini/);
      const other = await ctxFor(ledger(), runnerRoutes({}), { auth: "oauth" });
      await assert.rejects(runTask(other.ctx), /auth must be subscription or api-key or auto, got oauth/);
    });

    it("returns a rejection at begin without starting a job", async () => {
      const api = ledger({ begin: { ...BEGIN, state: "rejected", reason: "duplicate_of:t_8", warnings: [{ kind: "duplicate", other: "t_8", intent: "x", footprint: [], value: 0.9 }] } });
      const { runner, ctx, out } = await ctxFor(api, runnerRoutes({}));
      const r = await runTask(ctx);
      assert.deepEqual([r.outcome, r.reason, r.warnings, r.txn], ["rejected", "duplicate_of:t_8", 1, "t_9"]);
      assert.equal(runner.calls.length, 0);
      assert.ok(out.some((l) => l.includes("rejected at begin: duplicate_of:t_8")));
      assert.ok(out.some((l) => l.includes("warning duplicate of t_8")));
    });

    it("throws when begin gives no transaction", async () => {
      const { ctx } = await ctxFor(ledger({ begin: { error: "no such repo" } }), runnerRoutes({}));
      await assert.rejects(runTask(ctx), /begin failed: no such repo/);
    });

    it("counts and logs the warnings of an opened transaction", async () => {
      const api = ledger({ begin: { ...BEGIN, warnings: [{ kind: "stale", paths: ["src/format.ts"], seq: 2 }] } });
      const { ctx, out } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }));
      const r = await runTask(ctx);
      assert.equal(r.warnings, 1);
      assert.ok(out.some((l) => l.includes("warning stale: src/format.ts")));
    });

    // [what the job answered, what the Ledger says, expected outcome, whether the transaction must be aborted]
    const OUTCOMES = [
      ["needs a human", { ok: true, state: "needs_human", attempts: 1 }, { state: "needs_human", reason: "low_confidence", attempt: 1 }, { outcome: "needs_human", reason: "low_confidence" }, false],
      ["rejected as protected", { ok: true, state: "rejected", attempts: 1 }, { state: "rejected", reason: "protected", attempt: 1 }, { outcome: "rejected", reason: "protected" }, false],
      ["aborted after max attempts", { ok: true, state: "aborted", attempts: 3 }, { state: "aborted", reason: "max_attempts", attempt: 3 }, { outcome: "aborted", reason: "max_attempts" }, false],
      ["recalled", { ok: true, state: "recalled", attempts: 1 }, { state: "recalled", reason: null, attempt: 1 }, { outcome: "recalled", reason: null }, false],
      ["the agent failed and aborted the transaction itself", { ok: false, state: "aborted", error: "Invalid API key" }, { state: "aborted", reason: "agent_error", attempt: 1 }, { outcome: "aborted", reason: "agent_error", error: "Invalid API key" }, false],
      ["the agent failed and left the transaction open", { ok: false, state: "open", error: "git exploded" }, { state: "open", reason: null, attempt: 1 }, { outcome: "aborted", reason: "agent_error", error: "git exploded" }, true],
    ];
    for (const [name, result, txn, want, aborted] of OUTCOMES) {
      it(`maps a job where ${name}`, async () => {
        const api = ledger({ txn });
        const { ctx } = await ctxFor(api, runnerRoutes(result));
        const r = await runTask(ctx);
        for (const [k, v] of Object.entries(want)) assert.equal(r[k], v, k);
        assert.deepEqual(api.calls.abort.map((a) => a.reason), aborted ? ["agent_error"] : []);
      });
    }

    it("reports an error, and aborts, when the job ends without a result", async () => {
      const api = ledger({ txn: { id: "t_9", state: "open", attempt: 1 } });
      const { ctx, out } = await ctxFor(api, runnerRoutes(undefined, { state: "failed", exitCode: 127 }));
      const r = await runTask(ctx);
      assert.deepEqual([r.outcome, r.reason], ["error", "no_result"]);
      assert.match(r.error, /ended failed without a result line/);
      assert.deepEqual(api.calls.abort.map((a) => a.reason), ["agent_error"]);
      assert.ok(out.some((l) => l.includes("(exit 127) without a result")));
    });

    it("reports where the transaction really is when the Ledger refuses the abort, not that it was aborted", async () => {
      const api = ledger({ txn: { id: "t_9", state: "verifying", attempt: 1, reason: null, train: "tr_4" }, refuseAbort: true });
      const { ctx } = await ctxFor(api, runnerRoutes({ ok: false, state: "verifying", reason: "wait_timeout", attempts: 1 }));
      const r = await runTask(ctx);
      assert.deepEqual(api.calls.abort.map((a) => a.reason), ["agent_error"], "it did try");
      assert.deepEqual([r.outcome, r.reason, r.train], ["verifying", null, "tr_4"]);
      assert.match(r.error, /wait_timeout/);
    });

    it("reports what the Ledger says after an abort that went through", async () => {
      const api = ledger({ txn: { id: "t_9", state: "open", attempt: 1, reason: null } });
      const { ctx, out } = await ctxFor(api, runnerRoutes({ ok: false, state: "open", error: "git exploded", attempts: 1 }));
      const r = await runTask(ctx);
      assert.deepEqual([r.outcome, r.reason, r.error], ["aborted", "agent_error", "git exploded"]);
      assert.ok(out.some((l) => l.includes("aborted (agent_error) after 1 attempt")));
    });

    // The harness follows the job for as long as agent.mjs can possibly take: every run's Claude session
    // and wait, plus what git and API retries add (containers/runner/lib/agent.mjs worstCaseMs).
    const TIMEOUTS = [
      ["the defaults", {}, Agent.worstCaseMs({ maxAttempts: 3, claudeTimeoutMs: 1_500_000, waitMs: 900_000 })],
      ["a shorter Claude timeout and wait", { RYKE_CLAUDE_TIMEOUT_S: "60", RYKE_WAIT_S: "30" }, Agent.worstCaseMs({ maxAttempts: 3, claudeTimeoutMs: 60_000, waitMs: 30_000 })],
    ];
    for (const [name, env, worst] of TIMEOUTS) {
      it(`gives the agent job more time than its own worst case with ${name}`, () => {
        const ms = Claude.jobTimeoutMs(env);
        assert.ok(ms > worst, `${ms} ms for a job that can take ${worst} ms`);
        assert.ok(ms <= worst + 10 * 60_000, "and not absurdly more");
      });
    }

    it("passes the timeout overrides on to the job, so the job and the harness agree, and sets none when there are none", async () => {
      const api = ledger();
      const { runner, ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { env: { RYKE_CLAUDE_TIMEOUT_S: "60", RYKE_WAIT_S: "30" } });
      await runTask(ctx);
      const env = runner.of("POST /v1/jobs")[0].body.env;
      assert.deepEqual([env.RYKE_CLAUDE_TIMEOUT_S, env.RYKE_WAIT_S], ["60", "30"]);

      const plain = await ctxFor(ledger(), runnerRoutes({ ok: true, state: "landed", attempts: 1 }));
      await runTask(plain.ctx);
      const bare = plain.runner.of("POST /v1/jobs")[0].body.env;
      assert.ok(!("RYKE_CLAUDE_TIMEOUT_S" in bare) && !("RYKE_WAIT_S" in bare), "the job's own defaults apply");
    });

    it("refuses a bad timeout before it begins a transaction", async () => {
      const api = ledger();
      const { ctx } = await ctxFor(api, runnerRoutes({}), { env: { RYKE_WAIT_S: "soon" } });
      await assert.rejects(runTask(ctx), /RYKE_WAIT_S must be a positive number/);
      assert.equal(api.calls.begin.length, 0);
    });

    it("does not abort a transaction that already reached a terminal state", async () => {
      const api = ledger({ txn: { id: "t_9", state: "landed", attempt: 1, landedSeq: 2, train: "t" } });
      const { ctx } = await ctxFor(api, runnerRoutes(undefined, { state: "failed", exitCode: 1 }));
      const r = await runTask(ctx);
      assert.equal(r.outcome, "error");
      assert.equal(api.calls.abort.length, 0);
    });

    it("throws, after aborting and cancelling the job, when the runner cannot be reached", async () => {
      const dead = await fakeServer();
      const url = dead.url;
      await dead.close();
      const api = ledger();
      const { ctx } = await ctxFor(api, { url }, {});
      await assert.rejects(runTask(ctx));
      assert.deepEqual(api.calls.abort.map((a) => a.reason), ["agent_error"], "no transaction is left holding leases");
    });

    it("cancels the job and aborts when following it fails", async () => {
      const api = ledger();
      const { runner, ctx } = await ctxFor(api, { ...runnerRoutes({}), "GET /v1/jobs/j_1": () => [500, { error: { message: "runner exploded" } }] });
      await assert.rejects(runTask(ctx), /runner exploded/);
      assert.equal(runner.of("DELETE /v1/jobs/j_1").length, 1);
      assert.deepEqual(api.calls.abort.map((a) => a.reason), ["agent_error"]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// swarm.sh: the in-platform demo job (PLAN.md §11.2)
// ---------------------------------------------------------------------------------------------

describe("swarm.sh", () => {
  const SWARM_SH = join(ROOT, "containers/runner/bin/swarm.sh");

  it("hands the admin token to swarm.mjs through the environment, never through its argument list", async () => {
    // `ps` shows every process's arguments to every user; the environment of another user's process is private.
    const shim = fresh("node-shim");
    mkdirSync(shim);
    const seen = join(shim, "seen.json");
    writeFileSync(join(shim, "node"), `#!/bin/sh\nprintf '%s\\n' "$*" > ${seen}.argv\nprintf '%s' "$RYKE_TOKEN" > ${seen}.token\n`, { mode: 0o755 });
    const r = await exec("bash", [SWARM_SH, "--repo", "demo", "--mode", "scripted", "--agents", "3"], {
      env: { ...BASE_ENV, PATH: `${shim}:${process.env.PATH}`, RYKE_ROOT: ROOT, RYKE_API_URL: "http://api.test", RYKE_TOKEN: "admin-secret-token" },
    });
    assert.equal(r.stderr, "");
    const argv = readFileSync(`${seen}.argv`, "utf8").trim();
    assert.equal(argv, `${join(ROOT, "harness/swarm.mjs")} --api http://api.test --repo demo --mode scripted --agents 3`);
    assert.ok(!argv.includes("admin-secret-token") && !argv.includes("--token"));
    assert.equal(readFileSync(`${seen}.token`, "utf8"), "admin-secret-token", "swarm.mjs gets it from RYKE_TOKEN");
  });

  it("swarm.mjs takes the token from RYKE_TOKEN when --token is absent, and --token still wins", () => {
    assert.equal(parseSwarmArgs([], { RYKE_TOKEN: "from-env" }).token, "from-env");
    assert.equal(parseSwarmArgs(["--token", "from-flag"], { RYKE_TOKEN: "from-env" }).token, "from-flag");
    assert.equal(parseSwarmArgs([], {}).token, "dev");
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: the stub through the real runner, API, Ledger, landing and hooks
// ---------------------------------------------------------------------------------------------

describe("claude mode against a real local stack", { timeout: 270_000 }, () => {
  let stack;
  let api;
  let catalogue;
  let common;
  const out = [];

  before(async () => {
    // The evidence gate's judgement calls have their own tests; this run checks the agent path.
    process.env.RYKE_JEV = "off";
    stack = await startStack({ offset: 220 + 3 * Number(process.env.RYKE_PORT_OFFSET ?? 0), fresh: true, quiet: true });
    api = client(stack.apiUrl, stack.token);
    await api.createRepo("convert", "convert", true);
    catalogue = await loadCatalogue("convert");
    common = {
      api,
      repo: "convert",
      dir: catalogue.dir,
      contention: true,
      stub: true,
      apiUrl: stack.apiUrl,
      token: stack.token,
      runnerUrl: `http://127.0.0.1:${stack.runnerPort}`,
      log: (agent, line) => out.push(`${agent} ${line}`),
    };
  });
  after(async () => {
    await stack?.close();
  });

  const task = (id) => catalogue.tasks.find((t) => t.id === id);
  const txnOf = (id) => out.map((l) => new RegExp(`${id}  begin (t_\\w+)`).exec(l)?.[1]).find(Boolean);

  it("lands tasks, reports their reads through the hooks, warns the parked agent early, moves its change onto the new trunk and re-runs it with the failing tests", async () => {
    const gates = fresh("gates");
    const logs = fresh("stub-logs");
    const env = { RYKE_STUB_LOG_DIR: logs };

    // cat-area reads format.ts and then parks, like an agent that is still thinking.
    const parked = runTask({ ...common, task: task("cat-area"), worker: "agent-01", env: { ...env, RYKE_STUB_GATE_DIR: gates } });
    await until(() => existsSync(join(gates, "cat-area.waiting")), 60_000, "cat-area to read its files");
    const parkedTxn = await until(() => txnOf("cat-area"), 5000, "cat-area's transaction id");

    // The reads reached the Ledger through the PostToolUse hook while the agent was still working.
    const open = await api.txn(parkedTxn);
    assert.equal(open.txn.state, "open");
    assert.deepEqual(open.attempts.at(-1).reads, ["src/format.ts", "src/registry.ts", "src/ui/layout.ts", "src/units/length.ts"]);
    assert.deepEqual(open.attempts.at(-1).writes, [], "the write set is only known from git, at submit");

    // Meanwhile the cross-cutting change lands, and an independent task lands next to it.
    const [pre, kelvin] = await Promise.all([runTask({ ...common, task: task("t-precision"), worker: "agent-02", env }), runTask({ ...common, task: task("kelvin-first"), worker: "agent-03", env })]);
    assert.deepEqual([pre.outcome, pre.attempts, kelvin.outcome, kelvin.attempts], ["landed", 1, "landed", 1], out.join("\n"));
    assert.equal(pre.model, STUB_MODEL);

    // The Ledger warned the parked transaction as soon as trunk moved.
    const ops = (await api.ops("convert", 0, 5000)).ops;
    const warned = ops.find((o) => o.kind === "stale.warning" && o.txn === parkedTxn);
    assert.ok(warned, "stale.warning for the parked transaction");
    assert.ok(warned.data.paths.some((p) => (p.path ?? p) === "src/format.ts"));

    // Open the gate: the next edit tells the agent through the hook. When it stops, trunk has moved under
    // what it read, so Ryke moves its change onto the new trunk (a clean rebase) and submits it there.
    // Nothing goes stale. What the stale rule exists to catch, a change written against the old rounding,
    // is caught by trunk's own verification instead, and the agent is re-run with the failing tests.
    writeFileSync(join(gates, "cat-area.go"), "");
    const area = await parked;
    assert.deepEqual([area.outcome, area.attempts], ["landed", 2], out.join("\n"));
    assert.equal(area.txn, parkedTxn);

    const runs = readFileSync(join(logs, "cat-area.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(runs.length, 2);
    assert.equal(runs[0].variant, "v1");
    assert.ok(runs[0].contexts.some((c) => c.includes("src/format.ts") && c.includes(pre.txn)), `the warning reached the agent: ${JSON.stringify(runs[0].contexts)}`);
    assert.ok(runs[0].contexts.some((c) => /^\+export function formatValue\(n: number, digits = 3\)/m.test(c)), "with the change itself");
    assert.ok(runs[0].contexts.every((c) => /Ryke moves your change onto the current trunk and submits it there/.test(c)), "and says what will happen to its work");
    assert.ok(!runs[0].prompt.includes(RETRY_STALE));
    assert.equal(runs[1].variant, "v2");
    assert.ok(runs[1].prompt.includes(RETRY_FAILED), "the second run is told which tests failed on the new trunk");

    // What the Ledger saw: the transaction was refreshed onto the new trunk, not aborted as stale, and
    // verification failed the first attempt.
    const detail = await api.txn(parkedTxn);
    assert.equal(detail.txn.state, "landed");
    assert.equal(detail.txn.model, STUB_MODEL);
    assert.deepEqual(detail.attempts.map((a) => a.attempt), [1, 2]);
    const refreshed = detail.ops.find((o) => o.kind === "txn.open" && o.data.refresh === true);
    assert.ok(refreshed, "the transaction was moved onto the new trunk");
    assert.ok(!detail.ops.some((o) => o.kind === "txn.stale"), "and never went stale");
    assert.ok(detail.ops.some((o) => o.kind === "txn.failed"), "the area tests expect the old rounding");
    assert.ok(detail.ops.some((o) => o.kind === "lease.granted"), "the PreToolUse hook asked for leases");
    const shots = detail.evidence.filter((e) => e.kind === "screenshot").map((e) => e.summary);
    assert.deepEqual(shots, [task("cat-area").screenshot_description, task("cat-area").screenshot_description]);
    assert.ok(detail.evidence.some((e) => e.kind === "log" && /attempt 2: Applied v2 of cat-area/.test(e.summary)));

    // Every landed commit is one transaction by the agent that made it.
    const summary = await api.repo("convert");
    assert.equal(summary.counts.landed, 3);
  });

  it("re-runs the agent with the failing tests when trunk's verification fails the first attempt", async () => {
    const logs = fresh("stub-logs");
    // t-precision is on trunk, so cat-speed's v1 patch (written against the old format) fails its own tests there.
    const r = await runTask({ ...common, task: task("cat-speed"), worker: "agent-04", env: { RYKE_STUB_LOG_DIR: logs } });
    assert.deepEqual([r.outcome, r.attempts], ["landed", 2], out.join("\n"));
    const runs = readFileSync(join(logs, "cat-speed.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(runs.map((x) => x.variant), ["v1", "v2"]);
    assert.ok(runs[1].prompt.includes(RETRY_FAILED), "the retry prompt lists the failing tests");
    assert.match(runs[1].prompt, /\n- .+/);
    const detail = await api.txn(r.txn);
    assert.ok(detail.ops.some((o) => o.kind === "txn.failed"));
  });

  it("rejects a tampering task at submit and reports it like the scripted agent", async () => {
    const r = await runTask({ ...common, task: task("tamper-routes"), worker: "agent-05", env: { RYKE_STUB_LOG_DIR: fresh("stub-logs") } });
    assert.deepEqual([r.outcome, r.reason], ["rejected", "protected"], out.join("\n"));
    assert.equal(r.attempts, 1);
  });

  it("leaves the final trunk's tests green", async () => {
    const summary = await api.repo("convert");
    // Async on purpose: the store runs in this process, and a synchronous git call would wait on a server that cannot answer.
    // The store's control API wants the internal secret the stack was started with.
    const internal = { "x-ryke-internal": stack.internalSecret };
    const token = (await (await fetch(`http://127.0.0.1:${stack.storePort}/v1/repos/convert/tokens`, { method: "POST", headers: internal, body: JSON.stringify({ scope: "read", ttl: 600 }) })).json()).token;
    const remote = (await (await fetch(`http://127.0.0.1:${stack.storePort}/v1/repos/convert`, { headers: internal })).json()).remote;
    const ws = await Workspace.create("checker", tmp);
    try {
      const head = await ws.fetch(remote, token, "main");
      assert.equal(head, summary.head);
      await ws.checkout(head);
      await exec("sh", ["-c", summary.policy.verify], { cwd: ws.dir, env: BASE_ENV });
    } finally {
      await ws.remove();
    }
  });
});
