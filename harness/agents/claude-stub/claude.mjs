#!/usr/bin/env node
// A fake `claude` for tests and `--stub` swarm runs (PLAN.md §10.4): no network, no key. It plays one
// session of the demo catalogue: it finds its task from the prompt, "reads" the files the task reads,
// applies the task's solution patch, writes .ryke/screenshot.txt and ends with a stream-json result line.
//
// What it keeps real is the part Ryke depends on: it takes the same command line, reads the hooks
// from the checkout's .claude/settings.json and runs them with the payloads and in the order Claude
// Code uses, so the hooks, their replies and the retry prompts are exercised end to end.
//
// Test knobs (env): RYKE_CATALOGUE_DIR (default demo/convert), RYKE_STUB_DELAY_MS between tool calls,
// RYKE_STUB_GATE_DIR (park after the reads until <dir>/<task>.go exists, and touch <task>.waiting),
// RYKE_STUB_LOG_DIR (append what each run saw to <dir>/<task>.jsonl: prompt, cwd, the hooks' contexts and the
// names of the environment variables it was given, which is how a test sees what agent.mjs let through).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isMain } from "../../../containers/runner/hooks/common.mjs";
import { RETRY_FAILED, RETRY_STALE } from "../../../containers/runner/lib/agent.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES = join(ROOT, "test/fixtures/claude");
const GATE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------------------------
// The command line: exactly what agent.mjs must send (docs/platform-notes.md §Claude Code inside a container).
// ---------------------------------------------------------------------------------------------

const REQUIRED_FLAGS = ["--print", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence"];

export function parseArgv(argv) {
  const dash = argv.indexOf("--");
  if (dash < 0 || argv.length !== dash + 2) throw new Error("expected the prompt after `--` as the last argument");
  const flags = argv.slice(0, dash);
  const seen = new Set();
  let model = null;
  let format = null;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (REQUIRED_FLAGS.includes(f)) seen.add(f);
    else if (f === "--output-format") format = flags[++i];
    else if (f === "--model") model = flags[++i];
    else throw new Error(`unexpected argument ${f}`);
  }
  const missing = REQUIRED_FLAGS.filter((f) => !seen.has(f));
  if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  if (format !== "stream-json") throw new Error(`--output-format must be stream-json, got ${format}`);
  if (!model) throw new Error("--model is required");
  return { model, prompt: argv[dash + 1] };
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

// A string that is exactly `{{key}}` takes the value's own type (numbers, null, objects); a string
// that merely contains one gets text substituted.
export function fill(node, vars) {
  if (typeof node === "string") {
    const whole = /^\{\{(\w+)\}\}$/.exec(node);
    if (whole) return resolveVar(vars, whole[1]);
    return node.replace(/\{\{(\w+)\}\}/g, (_, key) => String(resolveVar(vars, key)));
  }
  if (Array.isArray(node)) return node.map((n) => fill(n, vars));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, vars)]));
  return node;
}

function resolveVar(vars, key) {
  if (!(key in vars)) throw new Error(`fixture uses {{${key}}}, which the stub does not provide`);
  return vars[key];
}

const templates = new Map();
function template(name) {
  if (!templates.has(name)) {
    templates.set(
      name,
      readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
  }
  return templates.get(name);
}

export const render = (name, vars) => template(name).map((t) => fill(t, vars));

// ---------------------------------------------------------------------------------------------
// Hooks, as Claude Code resolves them (https://code.claude.com/docs/en/hooks, "Matcher patterns")
// ---------------------------------------------------------------------------------------------

export function matches(matcher, tool) {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (/^[\w\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).map((m) => m.trim()).includes(tool);
  return new RegExp(matcher).test(tool);
}

export function hooksFor(settings, event, tool) {
  return (settings.hooks?.[event] ?? [])
    .filter((group) => matches(group.matcher, tool))
    .flatMap((group) => (group.hooks ?? []).filter((h) => h.type === "command"));
}

// ---------------------------------------------------------------------------------------------
// Patches: which files they touch and what an Edit or Write of them would have carried
// ---------------------------------------------------------------------------------------------

export function describePatch(text) {
  return text
    .split(/^diff --git /m)
    .slice(1)
    .map((chunk) => {
      const path = /^a\/(\S+) b\//.exec(chunk)?.[1];
      const body = chunk.split("\n").filter((l) => !/^(\+\+\+|---) /.test(l));
      return {
        path,
        isNew: /^new file mode/m.test(chunk),
        added: body.filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n"),
        removed: body.filter((l) => l.startsWith("-")).map((l) => l.slice(1)).join("\n"),
      };
    })
    .filter((f) => f.path);
}

// The lander's commit subject for an intent (containers/runner/lib/land.mjs): first line, cut at 72.
export const subjectOf = (intent) => {
  const first = intent.split("\n")[0];
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
};

// v2 patches are written against a trunk that already holds the tasks in `v2_after`; on any other
// trunk the v1 patch is the one that fits.
export function chooseVariant(task, tasks, prompt, subjects) {
  const retry = prompt.includes(RETRY_STALE) || prompt.includes(RETRY_FAILED);
  if (!retry || !task.v2) return "v1";
  const landed = (id) => {
    const other = tasks.find((t) => t.id === id);
    return other !== undefined && subjects.includes(subjectOf(other.intent));
  };
  return (task.v2_after ?? []).every(landed) ? "v2" : "v1";
}

// ---------------------------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------------------------

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function git(cwd, argv, input) {
  return spawnSync("git", argv, { cwd, input, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

export async function session(argv, env = process.env, cwd = process.cwd()) {
  const started = Date.now();
  const id = { session_id: crypto.randomUUID(), model: "claude-sonnet-5-5", cwd, api_key_source: env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "none" };
  const vars = (extra = {}) => ({ ...id, uuid: crypto.randomUUID(), message_id: `msg_${crypto.randomUUID().slice(0, 12)}`, ...extra });
  let turns = 0;
  const fail = (result, code = 1) => {
    for (const e of render("error", vars({ result, status: null, duration_ms: Date.now() - started, num_turns: turns }))) out(e);
    return code;
  };

  let args;
  try {
    args = parseArgv(argv);
    id.model = args.model;
    for (const key of ["IS_SANDBOX", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
      if (env[key] !== "1") throw new Error(`${key}=1 is not set`);
    }
  } catch (e) {
    return fail(`stub: unexpected invocation: ${e.message}`, 2);
  }

  const catalogue = env.RYKE_CATALOGUE_DIR ?? join(ROOT, "demo/convert");
  const tasks = JSON.parse(readFileSync(join(catalogue, "tasks.json"), "utf8"));
  const intent = /^Intent: (.*)$/m.exec(args.prompt)?.[1];
  const task = tasks.find((t) => t.intent === intent);
  if (!task) return fail(`stub: no task in ${catalogue}/tasks.json has the intent ${JSON.stringify(intent)}`);

  let settings = {};
  try {
    settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
  } catch {
    // Without hooks the session still runs; the tests that care assert on the hooks' effects.
  }
  const delay = Number(env.RYKE_STUB_DELAY_MS ?? 0);
  const contexts = [];
  const hookRuns = [];

  // Runs the hooks of one event like Claude Code does and returns what they decided.
  function hooks(event, tool, payload) {
    const verdict = { deny: null };
    for (const hook of hooksFor(settings, event, tool)) {
      const r = spawnSync("sh", ["-c", hook.command], {
        cwd,
        env,
        input: JSON.stringify({ session_id: id.session_id, transcript_path: "", cwd, permission_mode: "bypassPermissions", hook_event_name: event, tool_name: tool, tool_use_id: payload.tool_use_id, ...payload }),
        encoding: "utf8",
        timeout: (hook.timeout ?? 600) * 1000,
      });
      let parsed = null;
      try {
        parsed = r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null;
      } catch {
        // Plain text on stdout is ignored for tool events.
      }
      const special = parsed?.hookSpecificOutput;
      if (special?.additionalContext) contexts.push(special.additionalContext);
      if (special?.permissionDecision === "deny" || r.status === 2) verdict.deny = special?.permissionDecisionReason ?? r.stderr.trim();
      hookRuns.push({ event, tool, status: r.status });
      for (const e of render("hook", vars({ hook_id: crypto.randomUUID(), event, tool, output: r.stdout + r.stderr, stdout: r.stdout, stderr: r.stderr, exit_code: r.status, outcome: r.status === 0 ? "success" : r.status === 2 ? "blocking" : "error" }))) out(e);
    }
    return verdict;
  }

  const call = (tool, input) => ({ tool, input, tool_use_id: `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}` });
  const announce = (c) => {
    turns++;
    const [use] = render("tool", vars({ tool: c.tool, tool_use_id: c.tool_use_id, input: c.input, result_text: "", tool_use_result: null }));
    out(use);
  };
  const finish = async (c, resultText, response) => {
    const [, result] = render("tool", vars({ tool: c.tool, tool_use_id: c.tool_use_id, input: c.input, result_text: resultText, tool_use_result: response }));
    out(result);
    if (delay > 0) await sleep(delay);
  };
  const post = (c, response) => hooks("PostToolUse", c.tool, { tool_use_id: c.tool_use_id, tool_input: c.input, tool_response: response, duration_ms: 3 });

  for (const e of render("init", vars())) out(e);
  for (const e of render("text", vars({ text: `I'll work on this: ${task.intent}`.slice(0, 200) }))) out(e);

  // Reads: the files the task reads, one Read each, plus a Glob and a Grep that match only one of
  // them, so every tool the read hook handles is exercised without widening the footprint.
  const readable = task.reads.filter((p) => existsSync(join(cwd, p)));
  for (const rel of readable) {
    const content = readFileSync(join(cwd, rel), "utf8");
    const c = call("Read", { file_path: join(cwd, rel) });
    announce(c);
    hooks("PreToolUse", "Read", { tool_use_id: c.tool_use_id, tool_input: c.input });
    const response = { type: "text", file: { filePath: join(cwd, rel), content, numLines: content.split("\n").length, startLine: 1, totalLines: content.split("\n").length } };
    post(c, response);
    await finish(c, content.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n"), response);
  }
  if (readable.length > 0) {
    const first = readable[0];
    const glob = call("Glob", { pattern: `**/${first.split("/").at(-1)}` });
    announce(glob);
    const globResponse = { durationMs: 4, numFiles: 1, filenames: [first], truncated: false };
    post(glob, globResponse);
    await finish(glob, first, globResponse);
    const grep = call("Grep", { pattern: "export", path: join(cwd, first), output_mode: "files_with_matches" });
    announce(grep);
    const grepResponse = { mode: "files_with_matches", numFiles: 1, filenames: [join(cwd, first)] };
    post(grep, grepResponse);
    await finish(grep, `Found 1 file\n${join(cwd, first)}`, grepResponse);
  }

  // Parked here, the stub is an agent that has read and is still thinking: other transactions can
  // land meanwhile, which is how the tests make a read go stale.
  if (env.RYKE_STUB_GATE_DIR) {
    mkdirSync(env.RYKE_STUB_GATE_DIR, { recursive: true });
    writeFileSync(join(env.RYKE_STUB_GATE_DIR, `${task.id}.waiting`), "");
    const until = Date.now() + GATE_TIMEOUT_MS;
    while (!existsSync(join(env.RYKE_STUB_GATE_DIR, `${task.id}.go`))) {
      if (Date.now() > until) return fail(`stub: gate ${task.id}.go never opened`);
      await sleep(50);
    }
  }

  const subjects = git(cwd, ["log", "--format=%s"]).stdout.split("\n");
  const preferred = chooseVariant(task, tasks, args.prompt, subjects);
  const order = preferred === "v2" ? ["v2", "v1"] : task.v2 ? ["v1", "v2"] : ["v1"];
  let applied = null;
  let files = [];
  for (const variant of order) {
    const rel = variant === "v2" ? task.v2 : task.solution;
    if (!rel) continue;
    const patch = readFileSync(join(catalogue, rel), "utf8");
    files = describePatch(patch);
    // Intents first, then the writes: the hook may make this wait for a lease.
    const calls = files.map((f) =>
      f.isNew && !existsSync(join(cwd, f.path))
        ? call("Write", { file_path: join(cwd, f.path), content: f.added })
        : call("Edit", { file_path: join(cwd, f.path), old_string: f.removed, new_string: f.added, replace_all: false }),
    );
    for (const c of calls) {
      announce(c);
      const verdict = hooks("PreToolUse", c.tool, { tool_use_id: c.tool_use_id, tool_input: c.input });
      if (verdict.deny) return fail(`stub: a hook blocked ${c.tool} of ${c.input.file_path}: ${verdict.deny}`);
    }
    const r = git(cwd, ["apply", "--3way", "-"], patch);
    if (r.status !== 0) {
      git(cwd, ["reset", "-q", "--hard", "HEAD"]);
      git(cwd, ["clean", "-fdq"]);
      continue;
    }
    for (const c of calls) {
      const response =
        c.tool === "Write"
          ? { type: "create", filePath: c.input.file_path, content: c.input.content, structuredPatch: [], originalFile: null }
          : { filePath: c.input.file_path, oldString: c.input.old_string, newString: c.input.new_string, replaceAll: false, userModified: false };
      post(c, response);
      await finish(c, `The file ${c.input.file_path} has been updated successfully.`, response);
    }
    applied = variant;
    break;
  }
  if (!applied) return fail(`stub: neither patch of ${task.id} applies to this checkout`);

  mkdirSync(join(cwd, ".ryke"), { recursive: true });
  writeFileSync(join(cwd, ".ryke", "screenshot.txt"), `${task.screenshot_description}\n`);

  if (env.RYKE_STUB_LOG_DIR) {
    mkdirSync(env.RYKE_STUB_LOG_DIR, { recursive: true });
    appendFileSync(
      join(env.RYKE_STUB_LOG_DIR, `${task.id}.jsonl`),
      `${JSON.stringify({ task: task.id, variant: applied, prompt: args.prompt, model: args.model, cwd, files: files.map((f) => f.path), contexts, hooks: hookRuns, env: { RYKE_FORK_TOKEN: env.RYKE_FORK_TOKEN ?? null, RYKE_TOKEN: env.RYKE_TOKEN ?? null }, envNames: Object.keys(env).sort() })}\n`,
    );
  }

  const text = `Applied ${applied} of ${task.id}; ${files.length} files changed. The tests pass.`;
  for (const e of render("text", vars({ text }))) out(e);
  for (const e of render("result", vars({ result: text, duration_ms: Date.now() - started, num_turns: turns + 1 }))) out(e);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await session(process.argv.slice(2));
