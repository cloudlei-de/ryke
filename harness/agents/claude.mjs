// The claude agent (PLAN.md §10.4): same entry point and result record as the scripted agent, so
// `swarm.mjs --mode claude` swaps it in. It begins the transaction through the public API, then hands
// the work to a runner job of kind `agent` (containers/runner/bin/agent.sh), which runs Claude Code in
// a fresh checkout with the hooks installed, and follows that job to the transaction's outcome. With
// ctx.cli = "codex" the same job runs `codex exec` instead (harness/agents/codex.mjs, `--mode codex`).
//
// Whose credentials the CLI runs on is ctx.auth: "api-key" (ANTHROPIC_API_KEY, or CODEX_API_KEY /
// OPENAI_API_KEY for Codex), "subscription" (the person's own login of the CLI on this machine: claude
// /login or `claude setup-token`, `codex login` with ChatGPT), or "auto", which takes the key when one is
// set. Ryke never reads, stores or forwards a login; the official CLI uses its own. With --stub /
// RYKE_AGENT_STUB=1 the job runs the fake CLI under harness/agents/<cli>-stub instead.
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_MODES, budgetsFrom, CLIS, credentialsFor, DEFAULT_MAX_ATTEMPTS, isCredential, KEY_NAMES, keyOf, worstCaseMs } from "../../containers/runner/lib/agent.mjs";
import { identityFor } from "../lib/tasks.mjs";
import { brief, describeWarnings } from "./scripted.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STUB_BINS = { claude: join(HERE, "claude-stub", "claude"), codex: join(HERE, "codex-stub", "codex") };
export const STUB_BIN = STUB_BINS.claude;
export const DEFAULT_MODEL = "claude-sonnet-5-5";
// What the Ledger records for a stubbed run, so `ryke recall --model claude-sonnet-5-5` never sweeps
// up runs that no model produced (PLAN.md §0.10).
export const STUB_MODELS = { claude: "claude-stub", codex: "codex-stub" };
export const STUB_MODEL = STUB_MODELS.claude;
// Codex without --model runs its own default, which the harness cannot know at begin; the run is
// labelled with the CLI rather than with a model name that may be wrong.
export const CODEX_LABEL = "codex";

const POLL_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// The runner's HTTP API (PLAN.md §3.3)
// ---------------------------------------------------------------------------------------------

export function runnerClient(base) {
  async function call(method, path, body) {
    const res = await fetch(base + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error(`runner ${method} ${path} -> ${res.status}: ${typeof data === "object" && data ? (data.error?.message ?? JSON.stringify(data)) : data}`);
    return data;
  }
  return {
    start: async (kind, args, env) => (await call("POST", "/v1/jobs", { kind, args, env })).id,
    status: (id) => call("GET", `/v1/jobs/${id}`),
    cancel: (id) => call("DELETE", `/v1/jobs/${id}`),
    async log(id, offset) {
      const res = await fetch(`${base}/v1/jobs/${id}/log?offset=${offset}`);
      if (!res.ok) throw new Error(`runner log ${id} -> ${res.status}`);
      return { text: await res.text(), next: Number(res.headers.get("x-ryke-next-offset") ?? offset) };
    },
  };
}

// Streams the job's log to `onLine` until the job ends, then returns its final status. Status is read
// before the log, so a job that ends between the two calls still has its last lines delivered.
export async function follow(runner, id, onLine, { timeoutMs = jobTimeoutMs(), pollMs = POLL_MS } = {}) {
  const until = Date.now() + timeoutMs;
  let offset = 0;
  let pending = "";
  for (;;) {
    const status = await runner.status(id);
    const log = await runner.log(id, offset);
    offset = log.next;
    const lines = (pending + log.text).split("\n");
    pending = lines.pop();
    lines.forEach(onLine);
    if (status.state === "done" || status.state === "failed") {
      if (pending !== "") onLine(pending);
      return status;
    }
    if (Date.now() > until) {
      await runner.cancel(id).catch(() => {});
      throw new Error(`agent job ${id} still ${status.state} after ${Math.round(timeoutMs / 1000)} s; cancelled`);
    }
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------------------------
// The credentials
// ---------------------------------------------------------------------------------------------

// Each check runs once per process: a swarm starts a dozen tasks, and the answer does not change.
const checked = new Map();
const once = (key, check) => {
  if (!checked.has(key)) checked.set(key, check());
  return checked.get(key);
};

// The HTTP status a free call answers with, or 0 when it does not get through: unreachable from here is
// not the same as rejected, and the CLI will say if it really is.
async function statusOf(url, headers) {
  try {
    return (await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })).status;
  } catch {
    return 0;
  }
}

// A bad key takes about three minutes to fail inside Claude Code, which retries ten times
// (docs/platform-notes.md), so it is checked once per process with a free call instead.
export function validateKey(key, base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") {
  return once(`anthropic\n${base}\n${key}`, async () => {
    const status = await statusOf(`${base}/v1/models?limit=1`, { "x-api-key": key, "anthropic-version": "2023-06-01" });
    if (status === 401 || status === 403) throw new AccessError(`ANTHROPIC_API_KEY was rejected by ${base} (HTTP ${status}); fix the key or run with --stub`);
  });
}

// Codex retries a rejected key too, and only says so in its event stream.
export function validateOpenAIKey(key, base = "https://api.openai.com") {
  return once(`openai\n${base}\n${key}`, async () => {
    const status = await statusOf(`${base}/v1/models`, { authorization: `Bearer ${key}` });
    if (status === 401 || status === 403) throw new AccessError(`${KEY_NAMES.codex} was rejected by ${base} (HTTP ${status}); fix the key or run with --stub`);
  });
}

// The login each CLI reports for itself: `claude auth status` prints JSON (authMethod claude.ai or
// oauth_token for a subscription, api_key or api_key_helper for a key), `codex login status` one line on
// stderr. Ryke reads only this verdict, never the credentials behind it.
const CLAUDE_METHODS = { "claude.ai": "subscription", oauth_token: "subscription", api_key: "api-key", api_key_helper: "api-key", none: "none" };
export function loginOf(cli, { code, stdout = "", stderr = "" }) {
  const text = `${stdout}\n${stderr}`.replace(/\s+/g, " ").trim().slice(0, 200);
  if (cli === "claude") {
    let status = null;
    try {
      status = JSON.parse(stdout);
    } catch {
      // An older or newer CLI that prints something else: its exit code is all there is.
    }
    if (!status) return { loggedIn: code === 0, method: code === 0 ? "unknown" : "none", detail: text };
    const method = CLAUDE_METHODS[status.authMethod] ?? "unknown";
    return { loggedIn: status.loggedIn === true && method !== "none", method, detail: String(status.authMethod ?? "") };
  }
  if (code !== 0 || /not logged in/i.test(text)) return { loggedIn: false, method: "none", detail: text };
  if (/chatgpt/i.test(text)) return { loggedIn: true, method: "subscription", detail: "ChatGPT" };
  if (/api key/i.test(text)) return { loggedIn: true, method: "api-key", detail: "API key" };
  return { loggedIn: true, method: "unknown", detail: text };
}

const STATUS_ARGS = { claude: ["auth", "status"], codex: ["login", "status"] };
const LOGIN_HINT = {
  claude: "run `claude` and /login with your Claude Pro or Max account (or `claude setup-token`)",
  codex: "run `codex login` with your ChatGPT account",
};

// Asks the CLI with exactly the credentials a subscription job would give it, so a key in this shell
// cannot make a missing login look present.
export function checkLogin(cli, bin, env = process.env) {
  const child = Object.fromEntries(Object.entries(env).filter(([k]) => !isCredential(k)));
  Object.assign(child, credentialsFor(cli, "subscription", env));
  const where = [env.HOME, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.RYKE_STUB_LOGIN, Boolean(env.CLAUDE_CODE_OAUTH_TOKEN)].join("\n");
  return once(`login\n${cli}\n${bin}\n${where}`, () =>
    new Promise((resolveCheck) => {
      execFile(bin, STATUS_ARGS[cli], { env: child, timeout: 30_000, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") resolveCheck({ loggedIn: false, method: "none", detail: `${bin} could not be run: ${error.message}` });
        else resolveCheck(loginOf(cli, { code: error ? error.code : 0, stdout, stderr }));
      });
    }),
  );
}

// The run cannot start as configured; the message says what to change, so no stack goes with it.
export class AccessError extends Error {
  name = "AccessError";
}

export const isLoopback = (url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);

// Decides, before begin, whose credentials the job's CLI runs on, and returns the mode and the job env
// that carries them. Everything that would make the run fail late fails here instead: a missing or
// rejected key, a subscription asked for on a runner that is not this machine, a CLI that is not logged in.
export async function checkAccess({ cli, auth, stub, bin, runnerUrl, env = process.env }) {
  const key = keyOf(cli, env);
  const mode = auth === "auto" ? (key ? "api-key" : "subscription") : auth;
  if (mode === "api-key") {
    if (!key) throw new AccessError(`--auth api-key needs ${KEY_NAMES[cli]} in the environment`);
    // The fake CLI never calls a model, so a stubbed run does not spend a call on the key either.
    if (!stub) await (cli === "codex" ? validateOpenAIKey(key) : validateKey(key));
    return { mode, how: "an API key", env: credentialsFor(cli, mode, env) };
  }
  // A login lives on the machine it was made on, and is its owner's: the CLI has to run there.
  if (!isLoopback(runnerUrl)) throw new AccessError(`--auth subscription runs ${cli} on your own login, so the runner must be on this machine; ${runnerUrl} is not`);
  const login = await checkLogin(cli, bin, env);
  if (!login.loggedIn) throw new AccessError(`${cli} is not logged in on this machine (${login.detail || "no login"}); ${LOGIN_HINT[cli]}, or pass ${KEY_NAMES[cli]} with --auth api-key`);
  if (auth === "subscription" && login.method === "api-key") {
    throw new AccessError(`${cli} is logged in with an API key (${login.detail}), not a subscription; ${LOGIN_HINT[cli]}, or use --auth api-key`);
  }
  return { mode, how: `your own login (${login.detail || login.method})`, env: credentialsFor(cli, mode, env) };
}

// ---------------------------------------------------------------------------------------------
// One task
// ---------------------------------------------------------------------------------------------

// The job's last stdout line is its JSON result, which runTask reads from the status instead. Node's
// proxy warning appears once per process of a job (agent.mjs, every hook) when NODE_USE_ENV_PROXY is set,
// and a swarm log with twelve agents has no room for it.
const NOISE = /^\(node:\d+\) \[UNDICI-EHPA\]|^\(Use `node --trace-warnings/;
export const relayable = (line) => line.trim() !== "" && !line.startsWith('{"ok"') && !NOISE.test(line);

const TERMINAL = new Set(["landed", "rejected", "aborted", "recalled", "needs_human"]);

// How long the harness follows a job before it cancels it. The job ends by itself after at most every
// Claude session and wait it is allowed (agent.mjs worstCaseMs); cutting it off earlier would abort a
// transaction that was about to land, so this is that worst case plus time to see the result.
const JOB_GRACE_MS = 5 * 60_000;
const TIMEOUT_VARS = ["RYKE_CLAUDE_TIMEOUT_S", "RYKE_WAIT_S"];
export const jobTimeoutMs = (env = process.env) => worstCaseMs({ maxAttempts: DEFAULT_MAX_ATTEMPTS, ...budgetsFrom(env) }) + JOB_GRACE_MS;

// ctx: as the scripted agent's ({ api, repo, task, dir, worker, contention, log(agent, line), … }) plus,
// all optional: cli (claude), auth (auto), stub, model, apiUrl, runnerUrl, env (extra job env),
// jobTimeoutMs (default: jobTimeoutMs()).
// Resolves with the same record the scripted agent returns; throws only for things the agent cannot handle.
// What a task's ctx resolves to; the swarm's preflight and every task read it the same way.
function settingsOf(ctx) {
  const cli = ctx.cli ?? "claude";
  const auth = ctx.auth ?? "auto";
  if (!CLIS.includes(cli)) throw new Error(`cli must be ${CLIS.join(" or ")}, got ${cli}`);
  if (!AUTH_MODES.includes(auth)) throw new Error(`auth must be ${AUTH_MODES.join(" or ")}, got ${auth}`);
  const offset = Number(process.env.RYKE_PORT_OFFSET ?? 0);
  const stub = ctx.stub ?? process.env.RYKE_AGENT_STUB === "1";
  const binVar = cli === "codex" ? "CODEX_BIN" : "CLAUDE_BIN";
  return {
    cli,
    auth,
    stub,
    binVar,
    bin: stub ? STUB_BINS[cli] : process.env[binVar] || cli,
    apiUrl: ctx.apiUrl ?? process.env.RYKE_API_URL ?? `http://127.0.0.1:${5173 + offset}`,
    runnerUrl: ctx.runnerUrl ?? process.env.RYKE_RUNNER_URL ?? `http://127.0.0.1:${8789 + offset}`,
    cliModel: ctx.model ?? (cli === "codex" ? (process.env.RYKE_CODEX_MODEL ?? "") : (process.env.RYKE_CLAUDE_MODEL ?? DEFAULT_MODEL)),
  };
}

// The swarm calls this once before it touches the repo, so a run that cannot work fails before any
// task begins; each task asks again, which the caches answer.
export const preflight = (ctx) => checkAccess(settingsOf(ctx));

export async function runTask(ctx) {
  const { api, repo, task, dir, worker, contention = false, log } = ctx;
  const { cli, stub, binVar, bin, apiUrl, runnerUrl, cliModel } = settingsOf(ctx);
  // The job must run with the timeouts the harness computed its own from, so they are passed on rather
  // than left to whatever the runner's environment holds. Unset means the job's defaults, as computed.
  const timeouts = Object.fromEntries(TIMEOUT_VARS.map((k) => [k, ctx.env?.[k] ?? process.env[k]]).filter(([, v]) => v !== undefined && v !== ""));
  const jobTimeout = ctx.jobTimeoutMs ?? jobTimeoutMs(timeouts);

  // The sloppy pair keeps its identity so a recall by agent or model still finds it; everything else
  // is labelled with what really produced it.
  const { agent } = identityFor(task, worker);
  const model = task.model ?? (stub ? STUB_MODELS[cli] : cliModel || CODEX_LABEL);
  const say = (line) => log(agent, `${task.id}  ${line}`);

  // Ahead of begin, so a bad key, a missing login or a timeout leaves no half-open transactions behind.
  const access = await preflight(ctx);
  const result = { task: task.id, agent, model, txn: null, outcome: "error", reason: null, attempts: 0, variants: [], warnings: 0 };

  const b = await api.begin(repo, { agent, model, intent: task.intent, criteria: task.criteria });
  if (!b?.txn) throw new Error(`begin failed: ${b?.error ?? JSON.stringify(b)}`);
  result.txn = b.txn;
  result.warnings = (b.warnings ?? []).length;
  for (const line of describeWarnings(b.warnings ?? [])) say(line);
  if (b.state === "rejected") {
    say(`rejected at begin: ${b.reason}`);
    return { ...result, outcome: "rejected", reason: b.reason };
  }
  say(`begin ${b.txn} at ${b.snapshot.slice(0, 8)}`);

  const runner = runnerClient(runnerUrl);
  let job = null;
  try {
    // The CLI's shell sees part of the job's environment, so the job carries the transaction's own token,
    // which cannot approve, reject, recall or touch other transactions (src/worker/service.ts). A
    // subscription job carries no credential at all: the CLI uses the login it already has.
    if (!b.agentToken) throw new Error(`begin returned no agentToken for ${b.txn}; an agent job never gets the admin token`);
    job = await runner.start(
      "agent",
      { repo, txn: b.txn, agent, intent: task.intent, criteria: JSON.stringify(task.criteria ?? []), cli, auth: access.mode, ...(cliModel ? { model: cliModel } : {}), remote: b.remote, snapshot: b.snapshot },
      {
        RYKE_API_URL: apiUrl,
        RYKE_TOKEN: b.agentToken,
        RYKE_FORK_TOKEN: b.token,
        RYKE_CONTENTION: contention ? "on" : "off",
        ...timeouts,
        RYKE_AGENT_STUB: stub ? "1" : "0",
        [binVar]: bin,
        // The fake CLI's knobs (RYKE_STUB_LOGIN above all, which the preflight has just read here) reach
        // its job too; the runner passes nothing of its own environment on.
        ...(stub ? { RYKE_CATALOGUE_DIR: dir, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("RYKE_STUB_"))) } : {}),
        ...access.env,
        ...ctx.env,
      },
    );
    say(`${stub ? "stub " : ""}${cli} job ${job} started (${cliModel || "its default model"}, ${access.mode})`);
    const status = await follow(runner, job, (line) => relayable(line) && say(line), { timeoutMs: jobTimeout });
    const r = status.result && typeof status.result === "object" ? status.result : null;
    let t = (await api.txn(b.txn)).txn;
    result.attempts = r?.attempts ?? t.attempt ?? 0;
    if (!r) {
      say(`agent job ${job} ${status.state} (exit ${status.exitCode ?? "?"}) without a result`);
      if (!TERMINAL.has(t.state)) await api.abort(b.txn, "agent_error").catch(() => {});
      return { ...result, outcome: "error", reason: "no_result", error: `agent job ${job} ended ${status.state} without a result line` };
    }
    if (r.ok === false && !TERMINAL.has(t.state)) {
      // The Ledger may refuse (409 while the train is verifying it), so what is reported is what it says
      // afterwards, not what was asked for.
      await api.abort(b.txn, "agent_error").catch(() => {});
      t = (await api.txn(b.txn)).txn;
    }
    say(`${t.state}${t.reason ? ` (${t.reason})` : ""} after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}${t.landedSeq != null ? `, seq ${t.landedSeq}` : ""}`);
    return {
      ...result,
      outcome: t.state,
      reason: t.reason ?? null,
      seq: t.landedSeq ?? undefined,
      train: t.train ?? undefined,
      ...(r.ok === false ? { error: brief(r.error ?? r.reason ?? "agent job failed") } : {}),
    };
  } catch (e) {
    // Do not leave a half-finished transaction holding leases and a footprint, nor a job running.
    if (job) await runner.cancel(job).catch(() => {});
    await api.abort(b.txn, "agent_error").catch(() => {});
    throw e;
  }
}
