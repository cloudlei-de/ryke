// The claude agent (PLAN.md §10.4): same entry point and result record as the scripted agent, so
// `swarm.mjs --mode claude` swaps it in. It begins the transaction through the public API, then hands
// the work to a runner job of kind `agent` (containers/runner/bin/agent.sh), which runs Claude Code in
// a fresh checkout with the hooks installed, and follows that job to the transaction's outcome.
//
// Without --stub / RYKE_CLAUDE_STUB=1 it runs the real `claude` and needs ANTHROPIC_API_KEY (or a
// Claude Code login on the runner's machine). With it, the job runs harness/agents/claude-stub instead.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { identityFor } from "../lib/tasks.mjs";
import { brief, describeWarnings } from "./scripted.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STUB_BIN = join(HERE, "claude-stub", "claude");
export const DEFAULT_MODEL = "claude-sonnet-5-5";
// What the Ledger records for a stubbed run, so `ryke recall --model claude-sonnet-5-5` never sweeps
// up runs that no model produced (PLAN.md §0.10).
export const STUB_MODEL = "claude-stub";

const JOB_TIMEOUT_MS = 60 * 60_000;
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
export async function follow(runner, id, onLine, { timeoutMs = JOB_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
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
// The key
// ---------------------------------------------------------------------------------------------

// A bad key takes about three minutes to fail inside Claude Code, which retries ten times
// (docs/platform-notes.md), so it is checked once per process with a free call instead.
const checked = new Map();
export function validateKey(key, base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") {
  const cacheKey = `${base}\n${key}`;
  if (!checked.has(cacheKey)) {
    checked.set(
      cacheKey,
      (async () => {
        let res;
        try {
          res = await fetch(`${base}/v1/models?limit=1`, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(10_000) });
        } catch {
          return; // Unreachable from here is not the same as rejected; Claude Code will say if it really is.
        }
        if (res.status === 401 || res.status === 403) throw new Error(`ANTHROPIC_API_KEY was rejected by ${base} (HTTP ${res.status}); fix the key or run with --stub`);
      })(),
    );
  }
  return checked.get(cacheKey);
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

// ctx: as the scripted agent's ({ api, repo, task, dir, worker, contention, log(agent, line), … }) plus,
// all optional: stub, model, apiUrl, runnerUrl, env (extra job env), jobTimeoutMs.
// Resolves with the same record the scripted agent returns; throws only for things the agent cannot handle.
export async function runTask(ctx) {
  const { api, repo, task, dir, worker, contention = false, log } = ctx;
  const offset = Number(process.env.RYKE_PORT_OFFSET ?? 0);
  const stub = ctx.stub ?? process.env.RYKE_CLAUDE_STUB === "1";
  const apiUrl = ctx.apiUrl ?? process.env.RYKE_API_URL ?? `http://127.0.0.1:${5173 + offset}`;
  const runnerUrl = ctx.runnerUrl ?? process.env.RYKE_RUNNER_URL ?? `http://127.0.0.1:${8789 + offset}`;
  const claudeModel = ctx.model ?? process.env.RYKE_CLAUDE_MODEL ?? DEFAULT_MODEL;
  const key = process.env.ANTHROPIC_API_KEY;

  // Ahead of begin, so a bad key leaves no half-open transactions behind.
  if (!stub && key) await validateKey(key);

  // The sloppy pair keeps its identity so a recall by agent or model still finds it; everything else
  // is labelled with what really produced it.
  const { agent } = identityFor(task, worker);
  const model = task.model ?? (stub ? STUB_MODEL : claudeModel);
  const say = (line) => log(agent, `${task.id}  ${line}`);
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
    // Claude's Bash tool sees the job's environment, so the job carries the transaction's own token,
    // which cannot approve, reject, recall or touch other transactions (src/worker/service.ts).
    if (!b.agentToken) throw new Error(`begin returned no agentToken for ${b.txn}; an agent job never gets the admin token`);
    job = await runner.start(
      "agent",
      { repo, txn: b.txn, agent, intent: task.intent, criteria: JSON.stringify(task.criteria ?? []), model: claudeModel, remote: b.remote, snapshot: b.snapshot },
      {
        RYKE_API_URL: apiUrl,
        RYKE_TOKEN: b.agentToken,
        RYKE_FORK_TOKEN: b.token,
        RYKE_CONTENTION: contention ? "on" : "off",
        RYKE_CLAUDE_STUB: stub ? "1" : "0",
        CLAUDE_BIN: stub ? STUB_BIN : process.env.CLAUDE_BIN || "claude",
        ...(stub ? { RYKE_CATALOGUE_DIR: dir } : { ...(key ? { ANTHROPIC_API_KEY: key } : {}), ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}) }),
        ...ctx.env,
      },
    );
    say(`${stub ? "stub " : ""}claude job ${job} started (${claudeModel})`);
    const status = await follow(runner, job, (line) => relayable(line) && say(line), { timeoutMs: ctx.jobTimeoutMs });
    const r = status.result && typeof status.result === "object" ? status.result : null;
    const t = (await api.txn(b.txn)).txn;
    result.attempts = r?.attempts ?? t.attempt ?? 0;
    if (!r) {
      say(`agent job ${job} ${status.state} (exit ${status.exitCode ?? "?"}) without a result`);
      if (!TERMINAL.has(t.state)) await api.abort(b.txn, "agent_error").catch(() => {});
      return { ...result, outcome: "error", reason: "no_result", error: `agent job ${job} ended ${status.state} without a result line` };
    }
    if (r.ok === false && !TERMINAL.has(t.state)) await api.abort(b.txn, "agent_error").catch(() => {});
    const final = r.ok === false && !TERMINAL.has(t.state) ? "aborted" : t.state;
    say(`${final}${t.reason ? ` (${t.reason})` : ""} after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}${t.landedSeq != null ? `, seq ${t.landedSeq}` : ""}`);
    return {
      ...result,
      outcome: final,
      reason: final === t.state ? (t.reason ?? null) : "agent_error",
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
