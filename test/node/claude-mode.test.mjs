// Claude agent mode (PLAN.md §10.4, §7.2, §4.4, M8): the three Claude Code hooks, the settings and prompt
// they ship with, agent.sh (the runner job), the fake `claude`, the harness side that starts the job,
// and one end-to-end run of the stub against a real local stack.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startStack } from "../../dev/stack.mjs";
import { acquire, handle as intendWrite } from "../../containers/runner/hooks/intend-write.mjs";
import { handle as recordWrite } from "../../containers/runner/hooks/record-write.mjs";
import { handle as readsHook } from "../../containers/runner/hooks/reads.mjs";
import { LEASE_PATIENCE_MS, loadConfig, repoPath, runHook, touchedPaths } from "../../containers/runner/hooks/common.mjs";
import {
  claudeArgs,
  claudeEnv,
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
import { follow, relayable, runnerClient, runTask, STUB_BIN, STUB_MODEL, validateKey } from "../../harness/agents/claude.mjs";
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
        const cfg = { ...loadConfig({ RYKE_API_URL: api.url, RYKE_TXN: "t_1", RYKE_TOKEN: "tok" }), patienceMs };
        const got = await acquire(cfg, "src/format.ts", { now: () => clock, wait: async (ms) => ((clock += ms), waits.push(ms)) });
        assert.deepEqual({ requests: api.calls.length, waits, gaveUp: got.gaveUp, waitedMs: got.waitedMs }, want);
        assert.equal(got.denied, want.requests - (want.gaveUp ? 0 : 1), "every answer but a final grant was a denial");
        assert.deepEqual(api.calls[0].body, { path: "src/format.ts" });
        if (want.requests > 1) assert.equal(got.owner, "t_a");
      });
    }
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
      assert.match(out.additionalContext, /Your edits will be rebased onto the new trunk/);
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
      writeFileSync(join(co.dir, ".ryke/announced.jsonl"), `${JSON.stringify({ path: "src/ui/layout.ts", seq: 3 })}\n`);
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
        model: "claude-sonnet-5-5",
        maxAttempts: 3,
        apiUrl: "http://api",
        token: "tok",
        forkToken: "fork",
        claudeBin: "claude",
        stub: false,
        contention: true,
        claudeTimeoutMs: 1_500_000,
        waitMs: 900_000,
      },
    );
    assert.deepEqual(inp.criteria, []);
  });

  it("reads the overrides", () => {
    const inp = inputsFrom(
      { ...ARGS, model: "claude-opus-5", "max-attempts": "2", criteria: '["a","b"]', api: "http://flag" },
      { CLAUDE_BIN: "/x/claude", RYKE_CLAUDE_STUB: "1", RYKE_CONTENTION: "off", RYKE_CLAUDE_TIMEOUT_S: "2.5", RYKE_WAIT_S: "30" },
    );
    assert.deepEqual([inp.model, inp.maxAttempts, inp.criteria, inp.apiUrl, inp.claudeBin, inp.stub, inp.contention, inp.claudeTimeoutMs, inp.waitMs], ["claude-opus-5", 2, ["a", "b"], "http://flag", "/x/claude", true, false, 2500, 30_000]);
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
    const env = claudeEnv(inp, "/w/checkout", { base: { PATH: "/bin", RYKE_FORK_TOKEN: "fork-secret", NODE_TEST_CONTEXT: "child-v8", ANTHROPIC_API_KEY: "sk-real" }, container: false });
    assert.equal(env.IS_SANDBOX, "1");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.deepEqual([env.RYKE_API_URL, env.RYKE_TOKEN, env.RYKE_TXN, env.RYKE_REPO, env.RYKE_CHECKOUT, env.RYKE_SNAPSHOT, env.RYKE_CONTENTION], ["http://api", "tok", "t_1", "convert", "/w/checkout", "abc", "on"]);
    assert.equal(env.RYKE_ROOT, ROOT);
    assert.equal(env.ANTHROPIC_API_KEY, "sk-real");
    assert.equal(env.PATH, "/bin");
  });

  it("keeps the fork's git token and the test runner's context out of Claude's environment", () => {
    const env = claudeEnv(inp, "/w", { base: { RYKE_FORK_TOKEN: "fork-secret", NODE_TEST_CONTEXT: "child-v8" }, container: false });
    assert.equal("RYKE_FORK_TOKEN" in env, false);
    assert.equal("NODE_TEST_CONTEXT" in env, false);
  });

  it("uses a placeholder key only inside the container, where the gateway swaps it", () => {
    assert.equal(claudeEnv(inp, "/w", { base: {}, container: true }).ANTHROPIC_API_KEY, PLACEHOLDER_KEY);
    assert.equal(claudeEnv(inp, "/w", { base: {}, container: false }).ANTHROPIC_API_KEY, undefined);
    assert.equal(claudeEnv(inp, "/w", { base: { ANTHROPIC_API_KEY: "sk-real" }, container: true }).ANTHROPIC_API_KEY, "sk-real");
  });

  it("turns contention off for the hooks when asked", () => {
    assert.equal(claudeEnv({ ...inp, contention: false }, "/w", { base: {}, container: false }).RYKE_CONTENTION, "off");
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

  // Runs bin/agent.sh as the runner does: arguments plus environment, in a fresh working directory.
  async function job(api, fork, taskId, { env = {}, args = {} } = {}) {
    const task = byId(taskId);
    const cwd = fresh("job");
    mkdirSync(cwd);
    const logDir = fresh("stub-log");
    const argv = ["--repo", "convert", "--txn", TXN, "--agent", "agent-07", "--intent", task.intent, "--criteria", JSON.stringify(task.criteria), "--remote", fork, "--snapshot", git(fork, "rev-parse", "refs/heads/main"), "--model", "claude-sonnet-5-5"];
    for (const [k, v] of Object.entries(args)) argv.push(`--${k}`, v);
    const child = spawn("bash", [AGENT_SH, ...argv], {
      cwd,
      env: { ...BASE_ENV, RYKE_API_URL: api.url, RYKE_TOKEN: "dev-token", RYKE_FORK_TOKEN: "fork-secret", CLAUDE_BIN: STUB_BIN, RYKE_CLAUDE_STUB: "1", RYKE_CATALOGUE_DIR: DEMO, RYKE_STUB_LOG_DIR: logDir, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise((r) => child.on("close", r));
    const last = stdout.trim().split("\n").at(-1);
    const stubRuns = existsSync(join(logDir, `${taskId}.jsonl`)) ? lines(readFileSync(join(logDir, `${taskId}.jsonl`), "utf8")) : [];
    return { code, result: JSON.parse(last), stdout, stderr, cwd, checkout: join(cwd, "checkout"), stubRuns };
  }

  const submitBodies = (api) => api.of(`POST /api/txns/${TXN}/submit`).map((c) => c.body);

  it("runs one attempt: clones, lets claude work, commits as the agent, pushes, submits with evidence, waits", async () => {
    const api = await s.start(baseRoutes());
    const fork = cloneBare("fork");
    const snapshot = git(fork, "rev-parse", "refs/heads/main");
    const task = byId("cat-area");
    const r = await job(api, fork, "cat-area");
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
    const r = await job(api, fork, "cat-area");
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
    const r = await job(api, fork, "cat-area", { env: { CLAUDE_BIN: idle, RYKE_CLAUDE_STUB: "0" } });
    assert.deepEqual([r.code, r.result.ok, r.result.state, r.result.reason], [0, true, "rejected", "empty"]);
    assert.equal(submitBodies(api)[0].head, snapshot);
    assert.equal(git(fork, "rev-parse", "refs/heads/main"), snapshot, "nothing was pushed");
    assert.equal("screenshot" in submitBodies(api)[0].evidence, false, "no screenshot.txt, no screenshot");
    assert.match(submitBodies(api)[0].evidence.summary, /^claude attempt 1: nothing to change/, "a real run is not labelled as the stub");
  });

  describe("when claude fails", () => {
    const abortBodies = (api) => api.of(`POST /api/txns/${TXN}/abort`).map((c) => c.body);

    it("aborts the transaction on a result line with is_error", async () => {
      const api = await s.start(baseRoutes());
      const task = byId("cat-area");
      const bad = join(tmp, `bad-claude-${++counter}`);
      writeFileSync(bad, '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key"}\\n\'\nexit 1\n', { mode: 0o755 });
      const r = await job(api, cloneBare("fork"), task.id, { env: { CLAUDE_BIN: bad, RYKE_CLAUDE_STUB: "0" } });
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
      const r = await job(api, cloneBare("fork"), "cat-area", { env: { CLAUDE_BIN: mute, RYKE_CLAUDE_STUB: "0" } });
      assert.deepEqual([r.result.ok, r.result.state], [false, "aborted"]);
      assert.match(r.result.error, /exited with code 3 without a result line/);
      assert.deepEqual(abortBodies(api), [{ reason: "agent_error" }]);
    });

    it("aborts when the claude binary does not exist", async () => {
      const api = await s.start(baseRoutes());
      const r = await job(api, cloneBare("fork"), "cat-area", { env: { CLAUDE_BIN: "/nonexistent/claude", RYKE_CLAUDE_STUB: "0" } });
      assert.deepEqual([r.result.ok, r.result.state], [false, "aborted"]);
      assert.match(r.stderr, /claude could not start/);
    });

    it("kills claude and everything it started when it runs past the timeout", async () => {
      const api = await s.start(baseRoutes());
      const pidFile = join(tmp, `child-pid-${++counter}`);
      const slow = join(tmp, `slow-claude-${++counter}`);
      writeFileSync(slow, `#!/bin/sh\nsleep 60 &\necho $! > ${pidFile}\nwait\n`, { mode: 0o755 });
      const started = Date.now();
      const r = await job(api, cloneBare("fork"), "cat-area", { env: { CLAUDE_BIN: slow, RYKE_CLAUDE_STUB: "0", RYKE_CLAUDE_TIMEOUT_S: "0.5" } });
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

    // A fake of the client the swarm passes in, recording what the agent calls.
    function ledger({ begin = BEGIN, txn = { id: "t_9", state: "landed", attempt: 1, landedSeq: 7, train: "tr_1", reason: null } } = {}) {
      const calls = { begin: [], abort: [] };
      return {
        calls,
        begin: async (repo, input) => (calls.begin.push({ repo, input }), begin),
        txn: async () => ({ txn }),
        abort: async (id, reason) => (calls.abort.push({ id, reason }), { state: "aborted" }),
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
      return { runner, out, ctx: { api, repo: "convert", task, dir: DEMO, worker: "agent-03", contention: true, log: (a, l) => out.push(`${a}|${l}`), stub: true, apiUrl: "http://api.test", token: "api-token", runnerUrl: runner.url, ...over } };
    };

    it("begins the transaction, starts the agent job with everything it needs and returns the scripted agent's record", async () => {
      const api = ledger();
      const { runner, ctx, out } = await ctxFor(api, runnerRoutes({ ok: true, txn: "t_9", state: "landed", attempts: 2, landed: true }, { log: "attempt 1 of 3\nattempt 2 of 3\n{\"ok\":true}\n" }));
      const r = await runTask(ctx);
      assert.deepEqual(r, { task: "cat-area", agent: "agent-03", model: STUB_MODEL, txn: "t_9", outcome: "landed", reason: null, attempts: 2, variants: [], warnings: 0, seq: 7, train: "tr_1" });
      assert.deepEqual(api.calls.begin, [{ repo: "convert", input: { agent: "agent-03", model: "claude-stub", intent: task.intent, criteria: task.criteria } }]);

      const [start] = runner.of("POST /v1/jobs");
      assert.equal(start.body.kind, "agent");
      assert.deepEqual(start.body.args, { repo: "convert", txn: "t_9", agent: "agent-03", intent: task.intent, criteria: JSON.stringify(task.criteria), model: "claude-sonnet-5-5", remote: BEGIN.remote, snapshot: BEGIN.snapshot });
      assert.deepEqual(start.body.env, {
        RYKE_API_URL: "http://api.test",
        RYKE_TOKEN: "rtx.t_9.agent",
        RYKE_FORK_TOKEN: "fork-token",
        RYKE_CONTENTION: "on",
        RYKE_CLAUDE_STUB: "1",
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
        const { runner, ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { stub: false, model: "claude-opus-5", contention: false });
        const r = await runTask(ctx);
        assert.equal(r.model, "claude-opus-5");
        assert.equal(api.calls.begin[0].input.model, "claude-opus-5");
        const [start] = runner.of("POST /v1/jobs");
        assert.equal(start.body.args.model, "claude-opus-5");
        assert.deepEqual(start.body.env, {
          RYKE_API_URL: "http://api.test",
          RYKE_TOKEN: "rtx.t_9.agent",
          RYKE_FORK_TOKEN: "fork-token",
          RYKE_CONTENTION: "off",
          RYKE_CLAUDE_STUB: "0",
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
        const { runner, ctx } = await ctxFor(api, runnerRoutes({}), { stub: false });
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

    it("lets a test or a caller add to the job's environment", async () => {
      const api = ledger();
      const { runner, ctx } = await ctxFor(api, runnerRoutes({ ok: true, state: "landed", attempts: 1 }), { env: { RYKE_STUB_GATE_DIR: "/gates", RYKE_CONTENTION: "off" } });
      await runTask(ctx);
      const env = runner.of("POST /v1/jobs")[0].body.env;
      assert.equal(env.RYKE_STUB_GATE_DIR, "/gates");
      assert.equal(env.RYKE_CONTENTION, "off", "the caller's value wins");
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

  it("lands tasks, reports their reads through the hooks, warns the parked agent early, and re-runs it with the delta after a stale abort", async () => {
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

    // Open the gate: the next edit tells the agent through the hook, then it submits, goes stale, retries and lands.
    writeFileSync(join(gates, "cat-area.go"), "");
    const area = await parked;
    assert.deepEqual([area.outcome, area.attempts], ["landed", 2], out.join("\n"));
    assert.equal(area.txn, parkedTxn);

    const runs = readFileSync(join(logs, "cat-area.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(runs.length, 2);
    assert.equal(runs[0].variant, "v1");
    assert.ok(runs[0].contexts.some((c) => c.includes("src/format.ts") && c.includes(pre.txn)), `the warning reached the agent: ${JSON.stringify(runs[0].contexts)}`);
    assert.ok(runs[0].contexts.some((c) => /^\+export function formatValue\(n: number, digits = 3\)/m.test(c)), "with the change itself");
    assert.ok(!runs[0].prompt.includes(RETRY_STALE));
    assert.equal(runs[1].variant, "v2");
    assert.ok(runs[1].prompt.includes(RETRY_STALE), "the second run is told why");
    assert.match(runs[1].prompt, /\+export function formatValue\(n: number, digits = 3\): string \{/, "and gets the delta");

    // What the Ledger saw: two attempts, the first one stale on format.ts through t-precision.
    const detail = await api.txn(parkedTxn);
    assert.equal(detail.txn.state, "landed");
    assert.equal(detail.txn.model, STUB_MODEL);
    assert.deepEqual(detail.attempts.map((a) => a.attempt), [1, 2]);
    const stale = detail.ops.find((o) => o.kind === "txn.stale");
    assert.ok(stale, "the first attempt went stale");
    assert.deepEqual(stale.data.paths.map((p) => [p.path, p.by]), [["src/format.ts", pre.txn]]);
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
