// Runner job `agent` (PLAN.md §10.4): one Claude Code session per transaction attempt, speaking only
// the public HTTP API and git, exactly like an outside agent would. The harness has already begun
// the transaction; this script clones the fork, lets Claude work with the lease and read-tracking
// hooks installed, commits, pushes, submits, waits, and on stale or failed re-runs Claude against
// the new snapshot with the delta (or the failing tests) added to the prompt.
//
//   agent.sh --repo convert --txn t_… --agent agent-01 --intent "…" --criteria '["…"]' \
//            --remote <fork url> --snapshot <sha> [--model claude-sonnet-5-5] [--max-attempts 3]
//   env: RYKE_API_URL RYKE_TOKEN RYKE_FORK_TOKEN CLAUDE_BIN ANTHROPIC_API_KEY RYKE_CONTENTION
//        RYKE_CLAUDE_TIMEOUT_S RYKE_WAIT_S RYKE_CLAUDE_STUB RYKE_KEEP_CHECKOUT
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiCallRetrying, isMain, loadConfig, READS_BATCH, readLines, rykeDir } from "../hooks/common.mjs";
import { git as run, main } from "./common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// containers/runner/lib → the repo root in process mode, /opt/ryke in the image.
export const ROOT = resolve(HERE, "../../..");
const RUNNER_DIR = resolve(HERE, "..");

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_MAX_ATTEMPTS = 3;
// The Outbound gateway swaps this for the real key (docs/platform-notes.md), so Claude Code starts.
export const PLACEHOLDER_KEY = "sk-ant-api03-ryke-gateway-placeholder";
const CONTAINER_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

// The words the stub and a human reading a transcript can rely on in a retry prompt.
export const RETRY_STALE = "files you read changed on trunk";
export const RETRY_FAILED = "failed these tests";

const PATCH_MAX = 6000;
const NOTICE_MAX = 24_000;
const SETTLING = new Set(["submitted", "ready", "verifying"]);
// How often, after a stale warning, the agent asks the Ledger to move its transaction onto the new trunk
// before it gives up and lets the Ledger say stale. Trunk can keep moving while the agent rebases.
const REFRESH_ROUNDS = 3;

const say = (line) => process.stderr.write(`${line}\n`);

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

function criteriaFrom(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    return [String(parsed)];
  } catch {
    return [raw];
  }
}

const positive = (raw, fallback, name) => {
  if (raw === undefined || raw === "") return fallback;
  if (!(Number(raw) > 0)) throw new Error(`${name} must be a positive number, got ${raw}`);
  return Number(raw);
};

// Seconds in the environment, milliseconds out. The harness reads the same numbers to know how long a
// job may legitimately take (harness/agents/claude.mjs).
export function budgetsFrom(env) {
  return {
    claudeTimeoutMs: positive(env.RYKE_CLAUDE_TIMEOUT_S, 1500, "RYKE_CLAUDE_TIMEOUT_S") * 1000,
    waitMs: positive(env.RYKE_WAIT_S, 900, "RYKE_WAIT_S") * 1000,
  };
}

// What a run costs besides Claude and the wait: git, and the API calls that each may retry for 30 s
// (apiCallRetrying), several per run.
export const ATTEMPT_OVERHEAD_MS = 5 * 60_000;

// Every Claude run is followed by at most one wait, and the number of runs is capped by maxAttempts
// whether they follow a stale outcome or a refresh that could not move the change.
export const worstCaseMs = ({ maxAttempts, claudeTimeoutMs, waitMs }) => maxAttempts * (claudeTimeoutMs + waitMs + ATTEMPT_OVERHEAD_MS);

export function inputsFrom(a, env = process.env) {
  const need = (key) => {
    if (!a[key]) throw new Error(`--${key} is required`);
    return a[key];
  };
  return {
    repo: need("repo"),
    txn: need("txn"),
    agent: need("agent"),
    intent: need("intent"),
    remote: need("remote"),
    snapshot: need("snapshot"),
    criteria: criteriaFrom(a.criteria),
    model: a.model || DEFAULT_MODEL,
    maxAttempts: positive(a["max-attempts"], DEFAULT_MAX_ATTEMPTS, "--max-attempts"),
    apiUrl: env.RYKE_API_URL || a.api || "",
    token: env.RYKE_TOKEN || "",
    forkToken: env.RYKE_FORK_TOKEN || "",
    claudeBin: env.CLAUDE_BIN || "claude",
    stub: env.RYKE_CLAUDE_STUB === "1",
    contention: env.RYKE_CONTENTION !== "off",
    keepCheckout: env.RYKE_KEEP_CHECKOUT === "1",
    ...budgetsFrom(env),
  };
}

// The entry point's version: the fork token is read once and removed from this process's environment, so
// nothing started from here (git, whatever a hook or a script spawns) inherits it. It stays in
// /proc/<pid>/environ, which records the environment of the original exec, so another process of the same
// user can still read it there; what keeps it from Claude is that Claude gets an allow-listed
// environment (claudeEnv), not this one.
export function takeInputs(a, env = process.env) {
  const inp = inputsFrom(a, env);
  delete env.RYKE_FORK_TOKEN;
  return inp;
}

// ---------------------------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------------------------

export function fillPrompt(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`prompt.md uses {{${key}}}, which agent.mjs does not fill`);
    return vars[key];
  });
}

export function renderCriteria(criteria) {
  if (criteria.length === 0) return "none given; the intent is the criterion";
  if (criteria.length === 1) return criteria[0];
  return criteria.map((c, i) => `\n${i + 1}. ${c}`).join("");
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n... (cut)` : text);

// What the agent is told when a transaction comes back: the delta of what changed on trunk, or the
// failing tests. Both end with where the previous attempt's diff is, because the fresh checkout no
// longer holds it.
export function retryNotice({ state, reason, attempt, max, snapshot, delta = [], failures = null, hasPrevious }) {
  const head = `---\nRyke retry, attempt ${attempt} of ${max}.`;
  const tail = `Your checkout is a fresh copy of trunk at ${snapshot.slice(0, 8)}${hasPrevious ? "; the diff of your previous attempt is saved at .ryke/previous.patch, so you can reuse what still applies" : ""}. Make sure the tests pass again, then write .ryke/screenshot.txt and stop.`;
  let body;
  if (state === "failed") {
    const list = (failures ?? []).map((f) => `- ${f.name}${f.message ? `: ${f.message}` : ""}`).join("\n") || "- (no test names were recorded)";
    body = `The previous attempt reached trunk's verification and ${RETRY_FAILED}:\n${list}`;
  } else {
    const patches = delta.map((d) => `### ${d.path}\n\`\`\`diff\n${clip(d.patch, PATCH_MAX)}\n\`\`\``).join("\n\n");
    // "conflict": nothing was aborted; the finished change could not be moved onto the trunk that moved under it.
    body =
      state === "conflict"
        ? `While you worked, ${RETRY_STALE} after your snapshot, and your change does not apply cleanly on the new trunk, so Ryke started you again from it. The changes on trunk:\n\n${patches || "(no delta was recorded)"}`
        : `The previous attempt was aborted before it landed because ${RETRY_STALE} after your snapshot (${reason ?? "stale"}). The changes on trunk:\n\n${patches || "(no delta was recorded)"}`;
  }
  return clip(`\n\n${head}\n${body}\n\n${tail}`, NOTICE_MAX);
}

// ---------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------

export function claudeArgs(model, prompt) {
  return ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence", "--model", model, "--", prompt];
}

// Claude's Bash tool, and every hook, sees exactly this environment, so it is an allow-list: a job
// inherits whatever its runner has (in process mode the developer's shell, with API keys in it), and
// none of that is Claude's business. What is named is what Claude Code, git, node and the hooks need to
// run and to reach the network, plus the model credentials the operator chose to give the job.
const PASS_EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TERM", "SHELL",
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
  // Diagnostics and the fake claude's test knobs; none of them is a credential.
  "RYKE_AGENT_VERBOSE", "RYKE_LEASE_PATIENCE_MS", "RYKE_HOOK_TIMEOUT_MS", "RYKE_HOOK_BUDGET_MS", "RYKE_CATALOGUE_DIR",
]);
const PASS_PATTERN = /^(LC_\w+|CLAUDE_\w+|RYKE_STUB_\w+)$/;

// RYKE_TOKEN here is the transaction's own token (service.ts), set below from the inputs; the git token
// for the fork and the admin and internal secrets are never part of it.
export function claudeEnv(inp, dir, { base = process.env, container = existsSync(CONTAINER_CA) } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && (PASS_EXACT.has(key) || PASS_PATTERN.test(key))) env[key] = value;
  }
  Object.assign(env, {
    IS_SANDBOX: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    RYKE_API_URL: inp.apiUrl,
    RYKE_TOKEN: inp.token,
    RYKE_TXN: inp.txn,
    RYKE_REPO: inp.repo,
    RYKE_CHECKOUT: dir,
    RYKE_SNAPSHOT: inp.snapshot,
    RYKE_ROOT: ROOT,
    RYKE_CONTENTION: inp.contention ? "on" : "off",
  });
  if (!env.ANTHROPIC_API_KEY && container) env.ANTHROPIC_API_KEY = PLACEHOLDER_KEY;
  return env;
}

// A swarm runs a dozen of these at once, so by default the job log keeps only what changes the
// checkout and the final result; RYKE_AGENT_VERBOSE=1 adds every tool call. The whole stream goes to
// transcripts/claude-<run>.jsonl in the job's directory either way (the checkout is deleted at the end).
const QUIET_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
export function describeEvent(ev, { cwd = "", verbose = false } = {}) {
  if (ev?.type === "assistant") {
    for (const c of ev.message?.content ?? []) {
      if (c.type === "tool_use" && (verbose || QUIET_TOOLS.has(c.name))) {
        const i = c.input ?? {};
        const what = String(i.file_path ?? i.path ?? i.pattern ?? i.command ?? "").replace(cwd ? `${cwd}/` : "\0", "");
        return `claude: ${c.name} ${what.replace(/\s+/g, " ").slice(0, 100)}`.trimEnd();
      }
      if (verbose && c.type === "text" && c.text?.trim()) return `claude: ${c.text.replace(/\s+/g, " ").slice(0, 140)}`;
    }
    return null;
  }
  if (ev?.type === "result") return `claude: result is_error=${ev.is_error} ${String(ev.result ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
  return null;
}

// Reads the outcome from the last {"type":"result"} line using is_error, not subtype (docs/platform-notes.md).
export function outcomeOf(lines, exitCode, timedOut) {
  const last = [...lines].reverse().find((l) => l?.type === "result");
  if (timedOut) return { isError: true, text: "claude timed out", result: last ?? null };
  if (!last) return { isError: true, text: `claude exited with code ${exitCode} without a result line`, result: null };
  return { isError: last.is_error !== false, text: String(last.result ?? ""), result: last };
}

// ---------------------------------------------------------------------------------------------
// Processes Claude left behind
// ---------------------------------------------------------------------------------------------

// Claude Code starts the commands of its Bash tool, and the dev servers and watchers they launch, in
// processes of their own, often in a session or process group of their own, which a kill of Claude's
// group never reaches. Their parent chain still leads back to Claude while they run, so on Linux
// /proc is how they are found. Elsewhere there is no /proc, the table is empty, and only the process
// group is killed: a detached grandchild can then outlive the attempt.
export function procTable(procDir = "/proc") {
  const table = new Map();
  let names;
  try {
    names = readdirSync(procDir);
  } catch {
    return table;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(join(procDir, name, "stat"), "utf8");
      // The command name is in parentheses and may itself contain spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") continue; // already dead; nothing to kill, and its children were reparented
      table.set(Number(name), { ppid: Number(fields[1]), start: fields[19] });
    } catch {
      // Gone between the listing and the read.
    }
  }
  return table;
}

// [pid, start time] of everything below `root`, children of children included.
export function descendantsOf(table, root) {
  const children = new Map();
  for (const [pid, { ppid }] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const found = [];
  for (const queue = [root]; queue.length > 0; ) {
    for (const pid of children.get(queue.shift()) ?? []) {
      found.push([pid, table.get(pid).start]);
      queue.push(pid);
    }
  }
  return found;
}

const SAMPLE_MS = 1000;
// A process that outlives the `exit` of Claude while holding its output open keeps `close` from firing.
const EXIT_DRAIN_MS = 2000;

// Remembers every descendant of `root` it has seen. A parent that dies first (Claude on SIGTERM) leaves
// its children reparented to init, where the parent chain no longer finds them, so what was seen while
// the tree was whole is what gets killed. The start time guards against a recycled pid.
export function treeTracker(root, { table = procTable, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  const seen = new Map();
  const sample = () => {
    if (root === undefined) return;
    for (const [pid, start] of descendantsOf(table(), root)) seen.set(pid, start);
  };
  const killAll = (signal = "SIGKILL") => {
    sample();
    const alive = table();
    for (const [pid, start] of seen) {
      if (alive.get(pid)?.start !== start) continue;
      try {
        kill(pid, signal);
      } catch {
        // Gone already.
      }
    }
  };
  return { sample, killAll };
}

// The Claude session being run, so a signal to this process can end it too (it has its own process group
// and would otherwise outlive a cancelled job).
let stopActive = null;
export const stopActiveClaude = () => stopActive?.();

export function runClaude({ bin, model, prompt, cwd, env, timeoutMs, streamFile, verbose = env.RYKE_AGENT_VERBOSE === "1" }) {
  return new Promise((resolveRun) => {
    const child = spawn(bin, claudeArgs(model, prompt), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const tree = treeTracker(child.pid);
    const lines = [];
    let buffer = "";
    let timedOut = false;
    let settled = false;
    let drain;
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    // Descendants first, so nothing starts anew while the group is being killed.
    const killAll = () => {
      tree.killAll();
      killGroup("SIGKILL");
    };
    stopActive = killAll;
    const sampler = setInterval(tree.sample, SAMPLE_MS);
    sampler.unref();
    const timer = setTimeout(() => {
      timedOut = true;
      tree.sample();
      killGroup("SIGTERM");
      setTimeout(() => {
        if (!settled) killAll();
      }, 5000).unref();
    }, timeoutMs);
    const take = (line) => {
      if (line.trim() === "") return;
      appendFileSync(streamFile, `${line}\n`);
      try {
        const ev = JSON.parse(line);
        lines.push(ev);
        const text = describeEvent(ev, { cwd, verbose });
        if (text) say(text);
      } catch {
        say(`claude (not json): ${line.slice(0, 200)}`);
      }
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop();
      parts.forEach(take);
    });
    child.stderr.on("data", (chunk) => say(`claude stderr: ${chunk.toString("utf8").trimEnd().slice(0, 400)}`));
    const done = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      clearInterval(sampler);
      if (stopActive === killAll) stopActive = null;
      take(buffer);
      // Whatever the session left running (a dev server, a watcher) must not outlive the attempt.
      killAll();
      if (error) say(`claude could not start: ${error.message}`);
      resolveRun({ ...outcomeOf(lines, exitCode, timedOut), exitCode });
    };
    child.once("error", (e) => done(127, e));
    child.once("exit", (code) => {
      drain = setTimeout(() => done(code), EXIT_DRAIN_MS);
    });
    child.once("close", (code) => done(code));
  });
}

// ---------------------------------------------------------------------------------------------
// The checkout
// ---------------------------------------------------------------------------------------------

// Bearer auth as the store and Artifacts expect it, through git's environment so the token never
// shows up in an argument list, a process listing or an error message.
const authEnv = (token) =>
  token ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` } : {};

function agentIdentity(agent) {
  return { GIT_AUTHOR_NAME: agent, GIT_AUTHOR_EMAIL: `${agent}@agents.ryke.ai`, GIT_COMMITTER_NAME: agent, GIT_COMMITTER_EMAIL: `${agent}@agents.ryke.ai` };
}

const out = async (dir, argv, opts) => (await run(dir, argv, opts)).stdout.trim();

// Idempotent: re-installing on a later attempt must not stack a second copy of our hooks.
export function mergeHooks(current = {}, ours = {}) {
  const commands = new Set(Object.values(ours).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command))));
  const merged = { ...current };
  for (const [event, groups] of Object.entries(ours)) {
    const kept = (current[event] ?? []).filter((g) => !(g.hooks ?? []).some((h) => commands.has(h.command)));
    merged[event] = [...kept, ...groups];
  }
  return merged;
}

export async function installHooks(dir, template) {
  const file = join(dir, ".claude", "settings.json");
  let current = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      say("the checkout's .claude/settings.json is not valid JSON; replacing it");
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...current, hooks: mergeHooks(current.hooks, template.hooks) }, null, 2)}\n`);
  // A settings file the repo tracks must not turn into part of the agent's change.
  if ((await run(dir, ["ls-files", "--error-unmatch", ".claude/settings.json"], { allowFail: true })).code === 0) {
    await run(dir, ["update-index", "--skip-worktree", ".claude/settings.json"]);
  }
}

// Moves the previous run's tracking files aside; the Ledger's read set is per attempt, so ours is too
// (and so is what the hooks remember about warnings and lease waits).
const ATTEMPT_FILES = ["reads.jsonl", "writes.jsonl", "screenshot.txt", "previous.patch", "announced", "gaveup"];
export function archiveAttempt(dir, n) {
  const ryke = join(dir, ".ryke");
  const keep = join(ryke, `attempt-${n}`);
  mkdirSync(keep, { recursive: true });
  for (const name of ATTEMPT_FILES) {
    if (existsSync(join(ryke, name))) renameSync(join(ryke, name), join(keep, name));
  }
}

// Claude Code loads the CLAUDE.md of its working directory and of every ancestor, so a checkout inside a
// project would run under that project's rules. In process mode the job's own directory is inside the
// Ryke repo (<repo>/.ryke/jobs/<id>/work), whose CLAUDE.md is the build brief for the platform and whose
// demo/convert/solutions holds the answers to the tasks. The checkout therefore lives under TMPDIR.
// This is no sandbox: Claude can still read any path it names. It stops the accidental loading.
const MEMORY_FILES = ["CLAUDE.md", "CLAUDE.local.md", join(".claude", "CLAUDE.md")];

// The first memory file in an ancestor of `dir` (not in `dir`: a repo's own is the repo's business).
export function memoryAbove(dir) {
  for (let d = dirname(dir); ; d = dirname(d)) {
    for (const name of MEMORY_FILES) {
      if (existsSync(join(d, name))) return join(d, name);
    }
    if (dirname(d) === d) return null;
  }
}

export function makeCheckoutDir(base = tmpdir()) {
  const dir = mkdtempSync(join(realpathSync(base), "ryke-agent-"));
  const memory = memoryAbove(dir);
  if (memory) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`${memory} would be loaded into claude's context as the memory of an ancestor of its checkout; set TMPDIR to a directory outside any project`);
  }
  return dir;
}

async function checkout(dir, from, union) {
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    await run(dir, ["init", "-q", "-b", "main"]);
  }
  await run(dir, ["fetch", "-q", from.remote, from.ref], { env: authEnv(from.token) });
  const sha = await out(dir, ["rev-parse", "FETCH_HEAD"]);
  await run(dir, ["checkout", "-q", "--detach", "-f", sha]);
  await run(dir, ["clean", "-fdq"]);
  // .ryke and .claude are scaffolding, never part of the change.
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "info", "exclude"), ".ryke/\n.claude/\n");
  const patterns = union ?? policyOf(dir).union ?? [];
  writeFileSync(join(dir, ".git", "info", "attributes"), patterns.map((p) => `${p} merge=union\n`).join(""));
  return sha;
}

function policyOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "ryke.json"), "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// The Ledger
// ---------------------------------------------------------------------------------------------

async function settled(inp, ledger, until) {
  for (;;) {
    const w = await ledger("GET", `/api/txns/${inp.txn}/wait?timeout=20`);
    if (!SETTLING.has(w.txn.state)) return w.txn;
    if (Date.now() > until) return { ...w.txn, timedOut: true };
  }
}

// Re-sends every read the hooks saw. A hook that failed open (API blip) has still logged its paths.
// The Ledger answers each batch with the stale warnings of the whole read set, so the union of the
// answers says whether anything Claude read has changed on trunk since the snapshot.
async function flushReads(inp, cfg, ledger) {
  const paths = [...new Set(readLines(rykeDir(cfg), "reads.jsonl").flatMap((l) => l.paths ?? []))];
  const stale = new Map();
  for (let i = 0; i < paths.length; i += READS_BATCH) {
    const r = await ledger("POST", `/api/txns/${inp.txn}/reads`, { paths: paths.slice(i, i + READS_BATCH) });
    for (const w of r?.staleWarnings ?? []) stale.set(`${w.path}@${w.seq}`, w);
  }
  for (const w of stale.values()) say(`stale read: ${w.path} changed on trunk at seq ${w.seq}${w.by ? ` (${w.by})` : ""}`);
  return { count: paths.length, stale: [...stale.values()] };
}

function screenshotOf(dir) {
  try {
    return readFileSync(join(dir, ".ryke", "screenshot.txt"), "utf8").trim().split("\n")[0].slice(0, 500);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------------------------

// `dir` is for a caller that owns the checkout; without it the checkout is made under TMPDIR and removed
// at the end. `logDir` keeps Claude's transcripts, which would not survive the checkout.
export async function runAgent(inp, { dir: given, template, settings, logDir = resolve("transcripts") } = {}) {
  template ??= readFileSync(join(RUNNER_DIR, "prompt.md"), "utf8");
  settings ??= JSON.parse(readFileSync(join(RUNNER_DIR, "claude", "settings.json"), "utf8"));
  const base = loadConfig({ RYKE_API_URL: inp.apiUrl, RYKE_TXN: inp.txn });
  // Everything but retry may be sent again: reads, submit, wait, refresh, abort and the lookups are
  // idempotent in the Ledger, and retry would open one attempt more each time it arrived.
  const ledger = (method, path, body) =>
    apiCallRetrying({ ...base, token: inp.token, timeoutMs: 60_000 }, method, path, body, { retry: !path.endsWith("/retry"), onRetry: say });
  const result = (state, extra = {}) => ({ ok: true, txn: inp.txn, state, attempts: attempt, landed: state === "landed", ...extra });
  const abort = (reason) => ledger("POST", `/api/txns/${inp.txn}/abort`, { reason });

  let attempt = 1; // the Ledger's attempt number
  // Claude sessions started. A change that cannot be moved onto a moved trunk starts a new session in the
  // same Ledger attempt, so this, not `attempt`, is what the budget of --max-attempts counts.
  let runs = 0;
  let from = { remote: inp.remote, token: inp.forkToken, ref: "main" };
  let fork = { remote: inp.remote, token: inp.forkToken };
  let notice = "";
  let previous = null;

  let dir = given;
  const removeCheckout = () => {
    if (given !== undefined || dir === undefined) return;
    if (inp.keepCheckout) say(`checkout kept at ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  };
  // A cancelled job (SIGTERM from the runner) must not leave Claude running in a directory that is gone.
  const onSignal = (signal) => {
    stopActiveClaude();
    removeCheckout();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  // Moves the agent's commit onto the trunk the Ledger now holds the transaction on. Refresh changes the
  // transaction's snapshot, and the Ledger works out the write set as the difference between that
  // snapshot and the submitted head, so a head that stays on the old snapshot would read as an undo of
  // everything trunk gained since. The change is therefore rebased onto exactly the snapshot refresh
  // returned, or not submitted at all.
  //   null: nothing to move (the Ledger would not refresh, or trunk had not moved)
  //   { snapshot, head }: moved, pushed, ready to submit
  //   { conflict }: it does not apply there
  async function moveOntoTrunk(at, head, snapshot) {
    let moved;
    try {
      moved = await ledger("POST", `/api/txns/${inp.txn}/refresh`, {});
    } catch (e) {
      if (e.status !== 409) throw e;
      say(`refresh refused, submitting where the change stands: ${e.message}`);
      return null;
    }
    if (moved.snapshot === snapshot) return null;
    await run(at, ["fetch", "-q", moved.trunk.remote, moved.snapshot], { env: authEnv(moved.trunk.token) });
    // Nothing is uncommitted any more, and Claude is done with the hooks file this may overwrite.
    await run(at, ["checkout", "-q", "-f", "--detach", moved.snapshot]);
    const pick = await run(at, ["cherry-pick", "--keep-redundant-commits", head], { env: agentIdentity(inp.agent), allowFail: true });
    if (pick.code !== 0) {
      await run(at, ["cherry-pick", "--abort"], { allowFail: true });
      say(`your change does not apply on trunk ${moved.snapshot.slice(0, 8)}: ${pick.stderr.trim().split("\n").at(-1)}`);
      return { conflict: moved };
    }
    const next = await out(at, ["rev-parse", "HEAD"]);
    await run(at, ["push", "-q", "--force", fork.remote, `${next}:refs/heads/main`], { env: authEnv(fork.token) });
    say(`moved onto trunk ${moved.snapshot.slice(0, 8)}: ${next.slice(0, 8)}`);
    return { snapshot: moved.snapshot, head: next };
  }

  try {
    dir ??= makeCheckoutDir();
    const cfg = { ...base, checkout: dir };
    mkdirSync(logDir, { recursive: true });

    session: for (;;) {
      runs++;
      say(`attempt ${runs} of ${inp.maxAttempts}: ${inp.stub ? "stub " : ""}${inp.claudeBin} --model ${inp.model}`);
      if (runs > 1) archiveAttempt(dir, runs - 1);
      let snapshot = await checkout(dir, from);
      inp.snapshot = snapshot;
      await installHooks(dir, settings);
      mkdirSync(join(dir, ".ryke"), { recursive: true });
      if (previous?.patch) writeFileSync(join(dir, ".ryke", "previous.patch"), previous.patch);

      const verify = policyOf(dir).verify ?? "the repo's tests";
      const prompt =
        fillPrompt(template, { agent: inp.agent, repo: inp.repo, intent: inp.intent, criteria: renderCriteria(inp.criteria), verify }) + notice;
      const ran = await runClaude({
        bin: inp.claudeBin,
        model: inp.model,
        prompt,
        cwd: dir,
        env: claudeEnv(inp, dir),
        timeoutMs: inp.claudeTimeoutMs,
        streamFile: join(logDir, `claude-${runs}.jsonl`),
      });
      if (ran.isError) {
        say(`claude failed: ${ran.text.slice(0, 300)}`);
        await abort("agent_error").catch((e) => say(`abort failed: ${e.message}`));
        return result("aborted", { ok: false, reason: "agent_error", error: ran.text.slice(0, 300) });
      }

      let reads = await flushReads(inp, cfg, ledger);
      say(`reads reported: ${reads.count} file${reads.count === 1 ? "" : "s"}`);

      // The harness commits, not Claude (prompt.md), so the author is the agent and the write set is whatever
      // git says. Claude often commits anyway: its commits are dropped (they sit on the snapshot, so the
      // soft reset only moves HEAD back) and the tree it left is what gets committed, which also keeps the
      // Ledger from seeing a clean tree and rejecting the snapshot as empty.
      await run(dir, ["reset", "-q", "--soft", snapshot]);
      await run(dir, ["add", "-A"]);
      const changed = (await out(dir, ["status", "--porcelain"])) !== "";
      let head = snapshot;
      if (changed) {
        await run(dir, ["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", inp.intent], { env: agentIdentity(inp.agent) });
        head = await out(dir, ["rev-parse", "HEAD"]);
        await run(dir, ["push", "-q", "--force", fork.remote, `${head}:refs/heads/main`], { env: authEnv(fork.token) });
      } else {
        say("no changes were made; submitting the snapshot itself, which the Ledger rejects as empty");
      }

      // Trunk moved under what Claude read. Its checkout could not follow (it held uncommitted work), so
      // the finished change is moved now: the Ledger refreshes the transaction onto the current trunk, the
      // change is rebased onto that, and the reads, which the Ledger forgets at a refresh, are sent again.
      for (let round = 0; changed && reads.stale.length > 0 && round < REFRESH_ROUNDS; round++) {
        const moved = await moveOntoTrunk(dir, head, snapshot);
        if (moved === null) break;
        if (moved.conflict) {
          if (runs >= inp.maxAttempts) {
            await abort("max_attempts").catch(() => {});
            return result("aborted", { reason: "max_attempts" });
          }
          const diff = (await run(dir, ["diff", "--binary", snapshot, head])).stdout;
          previous = { patch: diff };
          notice = retryNotice({ state: "conflict", attempt: runs + 1, max: inp.maxAttempts, snapshot: moved.conflict.snapshot, delta: moved.conflict.delta, hasPrevious: diff !== "" });
          from = { remote: moved.conflict.trunk.remote, token: moved.conflict.trunk.token, ref: moved.conflict.snapshot };
          continue session;
        }
        ({ snapshot, head } = moved);
        inp.snapshot = snapshot;
        reads = await flushReads(inp, cfg, ledger);
      }

      const screenshot = screenshotOf(dir);
      const evidence = { summary: `claude ${inp.stub ? "(stub) " : ""}attempt ${attempt}: ${ran.text.replace(/\s+/g, " ").slice(0, 400)}` };
      if (screenshot) evidence.screenshot = screenshot;
      let end = await ledger("POST", `/api/txns/${inp.txn}/submit`, { head, evidence });
      say(`submitted ${head.slice(0, 8)}: ${end.state}${end.reason ? ` (${end.reason})` : ""}`);
      if (SETTLING.has(end.state)) {
        const t = await settled(inp, ledger, Date.now() + inp.waitMs);
        if (t.timedOut) return result(t.state, { ok: false, reason: "wait_timeout" });
        end = { state: t.state, reason: t.reason, seq: t.landedSeq, train: t.train };
        say(`${t.state}${t.reason ? ` (${t.reason})` : ""}`);
      }

      if (end.state !== "stale" && end.state !== "failed") return result(end.state, { reason: end.reason ?? null, seq: end.seq ?? null, train: end.train ?? null });
      if (runs >= inp.maxAttempts) {
        await abort("max_attempts").catch(() => {});
        return result("aborted", { reason: "max_attempts" });
      }

      const diff = changed ? (await run(dir, ["diff", "--binary", snapshot, head])).stdout : "";
      let next;
      try {
        next = await ledger("POST", `/api/txns/${inp.txn}/retry`, {});
      } catch (e) {
        // The transaction moved on while we were deciding, for example it hit max_attempts.
        if (e.status !== 409) throw e;
        const t = (await ledger("GET", `/api/txns/${inp.txn}`)).txn;
        return result(t.state, { reason: t.reason ?? null });
      }
      say(`retry: attempt ${next.attempt} at ${next.snapshot.slice(0, 8)}${next.delta.length ? `, delta on ${next.delta.map((d) => d.path).join(", ")}` : ""}`);
      previous = { patch: diff };
      notice = retryNotice({
        state: end.state,
        reason: end.reason,
        attempt: runs + 1,
        max: inp.maxAttempts,
        snapshot: next.snapshot,
        delta: next.delta,
        failures: next.failures,
        hasPrevious: diff !== "",
      });
      attempt = next.attempt;
      fork = { remote: next.remote, token: next.token };
      from = { remote: next.trunk.remote, token: next.trunk.token, ref: next.snapshot };
    }
  } catch (e) {
    // A half-finished transaction would keep its leases and footprint on the dashboard.
    await abort("agent_error").catch(() => {});
    throw e;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    removeCheckout();
  }
}

if (isMain(import.meta.url)) await main((a) => runAgent(takeInputs(a)));
