#!/usr/bin/env node
// A fake `codex` for tests and `--stub` swarm runs: no network, no login. `codex exec` plays one task of
// the demo catalogue like the Claude stub does (harness/agents/claude-stub), but speaks Codex: it takes
// the command line agent.mjs builds (codexArgs), "reads" the task's files through shell commands, applies
// the solution patch as a file_change, and prints the JSONL events of `codex exec --json`. Codex runs no
// Ryke hooks, so what is exercised end to end is how agent.mjs reads those events: the reads it takes
// from the commands and their output, the write intents from the patches, the outcome from the turn.
//
// `codex login status` answers as the real one does, from RYKE_STUB_LOGIN: chatgpt (default), api-key,
// or none. Without CODEX_API_KEY and with no login, `codex exec` fails before its turn starts.
// The other knobs are the Claude stub's: RYKE_CATALOGUE_DIR, RYKE_STUB_DELAY_MS, RYKE_STUB_GATE_DIR,
// RYKE_STUB_LOG_DIR.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isMain } from "../../../containers/runner/hooks/common.mjs";
import { applyPatch, findTask, finishTask, variantsFor, waitAtGate } from "../claude-stub/claude.mjs";

const REQUIRED_FLAGS = ["--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];

export function parseExecArgv(argv) {
  if (argv[0] !== "exec") throw new Error(`expected the exec subcommand, got ${argv[0]}`);
  const dash = argv.indexOf("--");
  if (dash < 0 || argv.length !== dash + 2) throw new Error("expected the prompt after `--` as the last argument");
  const flags = argv.slice(1, dash);
  const seen = new Set();
  let cd = null;
  let model = null;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (REQUIRED_FLAGS.includes(f)) seen.add(f);
    else if (f === "--cd") cd = flags[++i];
    else if (f === "--model") model = flags[++i];
    else throw new Error(`unexpected argument ${f}`);
  }
  const missing = REQUIRED_FLAGS.filter((f) => !seen.has(f));
  if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  if (!cd) throw new Error("--cd is required");
  return { cd, model, prompt: argv[dash + 1] };
}

// What `codex login status` prints (codex-rs/cli, login.rs): to stderr, exit 1 when logged out. It
// reports the stored login only; CODEX_API_KEY in the environment does not change it.
export function loginStatus(env) {
  const login = env.RYKE_STUB_LOGIN ?? "chatgpt";
  if (login === "none") return { code: 1, stderr: "Not logged in\n" };
  if (login === "api-key") return { code: 0, stderr: "Logged in using an API key - sk-proj-***stub\n" };
  return { code: 0, stderr: "Logged in using ChatGPT\n" };
}

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

export async function exec(argv, env = process.env) {
  let args;
  try {
    args = parseExecArgv(argv);
  } catch (e) {
    process.stderr.write(`stub: unexpected invocation: ${e.message}\n`);
    return 2;
  }
  if (!env.CODEX_API_KEY && (env.RYKE_STUB_LOGIN ?? "chatgpt") === "none") {
    out({ type: "error", message: "Not logged in. Run `codex login` or set CODEX_API_KEY." });
    return 1;
  }
  const cwd = resolve(args.cd);
  const delay = Number(env.RYKE_STUB_DELAY_MS ?? 0);
  let n = 0;
  const item = async (details, { started = false } = {}) => {
    const it = { id: `item_${n++}`, ...details };
    if (started) out({ type: "item.started", item: { ...it, ...(it.type === "command_execution" ? { aggregated_output: "", exit_code: null } : {}), status: "in_progress" } });
    out({ type: "item.completed", item: it });
    if (delay > 0) await sleep(delay);
    return it;
  };
  const failTurn = (message) => {
    out({ type: "turn.failed", error: { message } });
    return 1;
  };

  out({ type: "thread.started", thread_id: crypto.randomUUID() });
  out({ type: "turn.started" });
  const found = findTask(env, args.prompt);
  if (found.error) return failTurn(found.error);
  const { task } = found;
  await item({ type: "reasoning", text: `**Planning** ${task.intent}`.slice(0, 200) });

  // The reads: one `cat` per file the task reads, then a search whose only hit is the first of them, so
  // both ways agent.mjs takes reads from a command (its arguments, its output) are used.
  const readable = task.reads.filter((p) => existsSync(join(cwd, p)));
  for (const rel of readable) {
    await item({ type: "command_execution", command: `/bin/bash -lc 'cat ${rel}'`, aggregated_output: readFileSync(join(cwd, rel), "utf8"), exit_code: 0, status: "completed" }, { started: true });
  }
  if (readable.length > 0) {
    const first = readable[0];
    await item({ type: "command_execution", command: `/bin/bash -lc "rg --files -g '${first.split("/").at(-1)}'"`, aggregated_output: `${first}\n`, exit_code: 0, status: "completed" }, { started: true });
  }

  const gated = await waitAtGate(env, task);
  if (gated) return failTurn(gated);

  let applied = null;
  let files = [];
  for (const v of variantsFor(found, args.prompt, cwd)) {
    files = v.files;
    const changes = files.map((f) => ({ path: join(cwd, f.path), kind: f.isNew && !existsSync(join(cwd, f.path)) ? "add" : "update" }));
    out({ type: "item.started", item: { id: `item_${n}`, type: "file_change", changes, status: "in_progress" } });
    const ok = applyPatch(cwd, v.patch);
    await item({ type: "file_change", changes, status: ok ? "completed" : "failed" });
    if (ok) {
      applied = v.variant;
      break;
    }
  }
  if (!applied) return failTurn(`stub: neither patch of ${task.id} applies to this checkout`);

  finishTask(cwd, env, task, { variant: applied, prompt: args.prompt, model: args.model, files: files.map((f) => f.path) });
  await item({ type: "agent_message", text: `Applied ${applied} of ${task.id}; ${files.length} files changed. The tests pass.` });
  out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300, reasoning_output_tokens: 120 } });
  return 0;
}

async function cli(argv) {
  if (argv[0] === "login" && argv[1] === "status") {
    const { code, stderr } = loginStatus(process.env);
    process.stderr.write(stderr);
    return code;
  }
  return exec(argv);
}

if (isMain(import.meta.url)) process.exitCode = await cli(process.argv.slice(2));
