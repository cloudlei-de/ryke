// Runner job `agent` (PLAN.md §10.4): one Claude Code session per transaction attempt, speaking only
// the public HTTP API and git, exactly like an outside agent would. The harness has already begun
// the transaction; this script clones the fork, lets Claude work with the lease and read-tracking
// hooks installed, commits, pushes, submits, waits, and on stale or failed re-runs Claude against
// the new snapshot with the delta (or the failing tests) added to the prompt.
//
//   agent.sh --repo convert --txn t_… --agent agent-01 --intent "…" --criteria '["…"]' \
//            --remote <fork url> --snapshot <sha> [--model claude-sonnet-5-5] [--max-attempts 3]
//   env: RYKE_API_URL RYKE_TOKEN RYKE_FORK_TOKEN CLAUDE_BIN ANTHROPIC_API_KEY RYKE_CONTENTION
//        RYKE_CLAUDE_TIMEOUT_S RYKE_WAIT_S RYKE_CLAUDE_STUB
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiCall, isMain, loadConfig, READS_BATCH, readLines, rykeDir } from "../hooks/common.mjs";
import { git as run, main } from "./common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// containers/runner/lib → the repo root in process mode, /opt/ryke in the image.
export const ROOT = resolve(HERE, "../../..");
const RUNNER_DIR = resolve(HERE, "..");

export const DEFAULT_MODEL = "claude-sonnet-5-5";
// The Outbound gateway swaps this for the real key (docs/platform-notes.md), so Claude Code starts.
export const PLACEHOLDER_KEY = "sk-ant-api03-ryke-gateway-placeholder";
const CONTAINER_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

// The words the stub and a human reading a transcript can rely on in a retry prompt.
export const RETRY_STALE = "files you read changed on trunk";
export const RETRY_FAILED = "failed these tests";

const PATCH_MAX = 6000;
const NOTICE_MAX = 24_000;
const SETTLING = new Set(["submitted", "ready", "verifying"]);

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

export function inputsFrom(a, env = process.env) {
  const need = (key) => {
    if (!a[key]) throw new Error(`--${key} is required`);
    return a[key];
  };
  const positive = (raw, fallback, name) => {
    if (raw === undefined || raw === "") return fallback;
    if (!(Number(raw) > 0)) throw new Error(`${name} must be a positive number, got ${raw}`);
    return Number(raw);
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
    maxAttempts: positive(a["max-attempts"], 3, "--max-attempts"),
    apiUrl: env.RYKE_API_URL || a.api || "",
    token: env.RYKE_TOKEN || "",
    forkToken: env.RYKE_FORK_TOKEN || "",
    claudeBin: env.CLAUDE_BIN || "claude",
    stub: env.RYKE_CLAUDE_STUB === "1",
    contention: env.RYKE_CONTENTION !== "off",
    claudeTimeoutMs: positive(env.RYKE_CLAUDE_TIMEOUT_S, 1500, "RYKE_CLAUDE_TIMEOUT_S") * 1000,
    waitMs: positive(env.RYKE_WAIT_S, 900, "RYKE_WAIT_S") * 1000,
  };
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
    body = `The previous attempt was aborted before it landed because ${RETRY_STALE} after your snapshot (${reason ?? "stale"}). The changes on trunk:\n\n${patches || "(no delta was recorded)"}`;
  }
  return clip(`\n\n${head}\n${body}\n\n${tail}`, NOTICE_MAX);
}

// ---------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------

export function claudeArgs(model, prompt) {
  return ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence", "--model", model, "--", prompt];
}

// What the hooks and the CLI need. Secrets for git stay out of it: Claude's Bash tool inherits this
// environment.
export function claudeEnv(inp, dir, { base = process.env, container = existsSync(CONTAINER_CA) } = {}) {
  const env = { ...base };
  // A nested `node --test` that inherits this reports to its parent and exits 0 even when tests fail.
  delete env.NODE_TEST_CONTEXT;
  delete env.RYKE_FORK_TOKEN;
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
// .ryke/claude-<n>.jsonl either way.
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

export function runClaude({ bin, model, prompt, cwd, env, timeoutMs, streamFile, verbose = env.RYKE_AGENT_VERBOSE === "1" }) {
  return new Promise((resolveRun) => {
    const child = spawn(bin, claudeArgs(model, prompt), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const lines = [];
    let buffer = "";
    let timedOut = false;
    let settled = false;
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
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
      take(buffer);
      // Whatever the session left running (a dev server, a watcher) must not outlive the attempt.
      kill("SIGKILL");
      if (error) say(`claude could not start: ${error.message}`);
      resolveRun({ ...outcomeOf(lines, exitCode, timedOut), exitCode });
    };
    child.once("error", (e) => done(127, e));
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

// Moves the previous attempt's tracking files aside; the Ledger's read set is per attempt, so ours is too.
function archiveAttempt(dir, attempt) {
  const ryke = join(dir, ".ryke");
  const keep = join(ryke, `attempt-${attempt}`);
  mkdirSync(keep, { recursive: true });
  for (const name of ["reads.jsonl", "writes.jsonl", "announced.jsonl", "screenshot.txt"]) {
    if (existsSync(join(ryke, name))) renameSync(join(ryke, name), join(keep, name));
  }
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
async function flushReads(inp, cfg, ledger) {
  const paths = [...new Set(readLines(rykeDir(cfg), "reads.jsonl").flatMap((l) => l.paths ?? []))];
  for (let i = 0; i < paths.length; i += READS_BATCH) {
    const r = await ledger("POST", `/api/txns/${inp.txn}/reads`, { paths: paths.slice(i, i + READS_BATCH) });
    for (const w of r?.staleWarnings ?? []) say(`stale read: ${w.path} changed on trunk at seq ${w.seq}${w.by ? ` (${w.by})` : ""}`);
  }
  return paths.length;
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

export async function runAgent(inp, { dir = resolve("checkout"), template, settings } = {}) {
  template ??= readFileSync(join(RUNNER_DIR, "prompt.md"), "utf8");
  settings ??= JSON.parse(readFileSync(join(RUNNER_DIR, "claude", "settings.json"), "utf8"));
  const cfg = loadConfig({ RYKE_CHECKOUT: dir, RYKE_API_URL: inp.apiUrl, RYKE_TXN: inp.txn });
  const ledger = (method, path, body) => apiCall({ ...cfg, token: inp.token, timeoutMs: 60_000 }, method, path, body);
  const result = (state, extra = {}) => ({ ok: true, txn: inp.txn, state, attempts: attempt, landed: state === "landed", ...extra });

  let attempt = 1;
  let from = { remote: inp.remote, token: inp.forkToken, ref: "main" };
  let fork = { remote: inp.remote, token: inp.forkToken };
  let notice = "";
  let previous = null;

  try {
    for (;;) {
      say(`attempt ${attempt} of ${inp.maxAttempts}: ${inp.stub ? "stub " : ""}${inp.claudeBin} --model ${inp.model}`);
      if (attempt > 1) archiveAttempt(dir, attempt - 1);
      const snapshot = await checkout(dir, from);
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
        streamFile: join(dir, ".ryke", `claude-${attempt}.jsonl`),
      });
      if (ran.isError) {
        say(`claude failed: ${ran.text.slice(0, 300)}`);
        await ledger("POST", `/api/txns/${inp.txn}/abort`, { reason: "agent_error" }).catch((e) => say(`abort failed: ${e.message}`));
        return result("aborted", { ok: false, reason: "agent_error", error: ran.text.slice(0, 300) });
      }

      const sent = await flushReads(inp, cfg, ledger);
      say(`reads reported: ${sent} file${sent === 1 ? "" : "s"}`);

      // The harness commits, not Claude (prompt.md), so the author is the agent and the write set is whatever git says.
      await run(dir, ["add", "-A"]);
      const changed = (await out(dir, ["status", "--porcelain"])) !== "";
      let head = snapshot;
      if (changed) {
        await run(dir, ["commit", "-q", "-m", inp.intent], { env: agentIdentity(inp.agent) });
        head = await out(dir, ["rev-parse", "HEAD"]);
        await run(dir, ["push", "-q", "--force", fork.remote, `${head}:refs/heads/main`], { env: authEnv(fork.token) });
      } else {
        say("no changes were made; submitting the snapshot itself, which the Ledger rejects as empty");
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
      if (attempt >= inp.maxAttempts) {
        await ledger("POST", `/api/txns/${inp.txn}/abort`, { reason: "max_attempts" }).catch(() => {});
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
        attempt: next.attempt,
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
    await ledger("POST", `/api/txns/${inp.txn}/abort`, { reason: "agent_error" }).catch(() => {});
    throw e;
  }
}

if (isMain(import.meta.url)) await main((a) => runAgent(inputsFrom(a)));
