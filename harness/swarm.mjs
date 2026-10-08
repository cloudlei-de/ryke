#!/usr/bin/env node
// `npm run swarm -- --mode scripted --agents 12 --repo convert [--speed 4] [--fresh]` (PLAN.md §11.1):
// N concurrent agents work through the task catalogue against a running Ryke, then the end-of-run
// report is printed from the op log.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { availableParallelism } from "node:os";
import { AUTH_MODES } from "../containers/runner/lib/agent.mjs";
import { brief, localVerify, runTask as scripted } from "./agents/scripted.mjs";
import { ApiError, client } from "./lib/client.mjs";
import { buildReport, checkPreview, evaluateCriteria, formatReport, landedCategories, verifyTrunk } from "./lib/report.mjs";
import { loadCatalogue, makeRng, orderTasks, seedFor, selectTasks, startGates } from "./lib/tasks.mjs";

const USAGE = `usage: swarm.mjs [--mode scripted|claude|codex] [--agents N] [--repo convert] [--speed 4 (default)] [--fresh]
                 [--contention on|off] [--tasks id,id] [--seed 42] [--json out.json] [--verify-slots 2]
                 [--api URL] [--token T] [--stack] [--demo convert] [--stub] [--model M]
                 [--auth subscription|api-key|auto]
  --stub, --model   claude and codex modes: run the recorded stub instead of the real CLI, or name the model
  --auth   claude and codex modes: subscription runs the CLI on your own login on this machine (claude
           /login or setup-token, codex login with ChatGPT); api-key on ANTHROPIC_API_KEY, or CODEX_API_KEY /
           OPENAI_API_KEY; auto (default) takes the key when one is set
  --verify-slots   how many agents may run their local tests at once (default half the CPUs)
  --stack   start a private local stack (store, runner, worker) for this run and stop it at the end
  --api     default $RYKE_API_URL, else http://127.0.0.1:<5173 + RYKE_PORT_OFFSET>
  --token   default $RYKE_TOKEN, else "dev"`;

export class UsageError extends Error {}

const MODES = ["scripted", "claude", "codex"];

export function parseSwarmArgs(argv, env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        mode: { type: "string", default: "scripted" },
        agents: { type: "string", default: "12" },
        repo: { type: "string", default: "convert" },
        // The README quickstart passes no --speed: at 1, twelve agents think long enough for several trunk
        // moves to overlap each change, and late categories ran out of attempts. 4 is the M3 run's speed.
        speed: { type: "string", default: "4" },
        fresh: { type: "boolean", default: false },
        contention: { type: "string", default: "on" },
        stack: { type: "boolean", default: false },
        tasks: { type: "string" },
        json: { type: "string" },
        api: { type: "string" },
        token: { type: "string" },
        seed: { type: "string", default: "42" },
        demo: { type: "string" },
        "verify-slots": { type: "string" },
        stub: { type: "boolean", default: false },
        model: { type: "string" },
        auth: { type: "string", default: "auto" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    throw new UsageError(e.message);
  }
  const offset = Number(env.RYKE_PORT_OFFSET ?? 0);
  const agents = Number(values.agents);
  const speed = Number(values.speed);
  const seed = Number(values.seed);
  if (!MODES.includes(values.mode)) throw new UsageError(`--mode must be scripted, claude or codex, got ${values.mode}`);
  if (!AUTH_MODES.includes(values.auth)) throw new UsageError(`--auth must be subscription, api-key or auto, got ${values.auth}`);
  if (!Number.isInteger(agents) || agents < 1 || agents > 50) throw new UsageError(`--agents must be an integer from 1 to 50, got ${values.agents}`);
  if (!(speed > 0) || !Number.isFinite(speed)) throw new UsageError(`--speed must be a positive number, got ${values.speed}`);
  const verifySlots = values["verify-slots"] === undefined ? Math.max(1, Math.floor(availableParallelism() / 2)) : Number(values["verify-slots"]);
  if (!Number.isInteger(verifySlots) || verifySlots < 1) throw new UsageError(`--verify-slots must be a positive integer, got ${values["verify-slots"]}`);
  if (!Number.isInteger(seed)) throw new UsageError(`--seed must be an integer, got ${values.seed}`);
  if (!["on", "off"].includes(values.contention)) throw new UsageError(`--contention must be on or off, got ${values.contention}`);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(values.repo)) throw new UsageError(`--repo must match [a-z0-9][a-z0-9-]{0,40}, got ${values.repo}`);
  return {
    mode: values.mode,
    agents,
    repo: values.repo,
    speed,
    fresh: values.fresh,
    contention: values.contention === "on",
    stack: values.stack,
    tasks: values.tasks ? values.tasks.split(",").map((s) => s.trim()).filter(Boolean) : null,
    json: values.json ?? null,
    api: values.api ?? env.RYKE_API_URL ?? `http://127.0.0.1:${5173 + offset}`,
    token: values.token ?? env.RYKE_TOKEN ?? "dev",
    seed,
    demo: values.demo ?? null,
    stub: values.stub,
    model: values.model ?? null,
    auth: values.auth,
    verifySlots,
    offset,
    help: values.help,
  };
}

const stamp = () => new Date().toISOString().slice(11, 23);

// At most `n` jobs at a time. Twelve agents running `node --test` at once starve the machine that
// also hosts the platform, and every run then takes a minute instead of two seconds.
export function limiter(n) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    // A finishing job hands its slot straight to the next waiter, so the count never exceeds n.
    if (active >= n) await new Promise((r) => waiting.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// Calls whose repetition is harmless are retried once the platform answers 5xx or the connection drops
// (a busy dev machine does both). begin and retry are not repeatable, so they are not wrapped.
const REPEATABLE = ["repo", "reads", "intendWrite", "submit", "txn", "wait", "ops", "files"];
export function resilient(api, { tries = 4, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const wrapped = { ...api };
  for (const name of REPEATABLE) {
    wrapped[name] = async (...args) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await api[name](...args);
        } catch (e) {
          const transient = e instanceof ApiError ? e.status >= 500 : e instanceof TypeError;
          if (!transient || attempt >= tries) throw e;
          await pause(300 * attempt);
        }
      }
    };
  }
  return wrapped;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

async function allOps(api, repo, after = 0) {
  const out = [];
  for (;;) {
    const page = await api.ops(repo, after, 1000);
    out.push(...page.ops);
    if (page.ops.length < 1000) return out;
    after = page.last;
  }
}

// The check a CLI mode makes once before any task begins (agents/claude.mjs preflight), or null.
async function preflightFor(mode, dir = import.meta.dirname) {
  return mode === "scripted" ? null : ((await import(`${dir}/agents/${mode}.mjs`)).preflight ?? null);
}

// `dir` is where agents/<mode>.mjs is looked up; only tests change it.
export async function agentFor(mode, dir = import.meta.dirname) {
  if (mode === "scripted") return scripted;
  const file = `${dir}/agents/${mode}.mjs`;
  try {
    return (await import(file)).runTask;
  } catch (e) {
    // The message names the module that is missing; one the agent file imports must not pass for "no agent file".
    if (e.code === "ERR_MODULE_NOT_FOUND" && e.message.startsWith(`Cannot find module '${file}'`)) throw new UsageError(`mode ${mode} is not built yet (harness/agents/${mode}.mjs is missing)`);
    throw e;
  }
}

async function ensureRepo(api, opts, seedFrom, say) {
  if (opts.fresh) {
    const r = await api.createRepo(opts.repo, seedFrom, true);
    say(`repo ${opts.repo} recreated from demo/${seedFrom} at ${r.head.slice(0, 8)}`);
    return;
  }
  try {
    await api.repo(opts.repo);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
    const r = await api.createRepo(opts.repo, seedFrom);
    say(`repo ${opts.repo} created from demo/${seedFrom} at ${r.head.slice(0, 8)}`);
  }
}

// The catalogue lives under demo/<repo>; a repo with another name still plays the Convert demo.
async function loadDemo(opts) {
  try {
    return await loadCatalogue(opts.demo ?? opts.repo);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    if (opts.demo) throw new UsageError(`no catalogue at demo/${opts.demo}/tasks.json`);
    return loadCatalogue("convert");
  }
}

async function reachable(apiUrl) {
  try {
    return (await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

// Runs the swarm against an API that is already up and returns the report; the CLI wraps it with the
// optional stack and the printing. Tests call it directly.
export async function runSwarm(opts, { log = console.log, runAgent: injected } = {}) {
  const say = (line) => log(`${stamp()}  swarm     ${line}`);
  const api = resilient(client(opts.api, opts.token));
  if (!(await reachable(opts.api))) {
    throw new UsageError(`no Ryke API answers at ${opts.api}/api/health. Start the platform with \`npm run dev:all\`, or pass --stack to start a private one.`);
  }

  const catalogue = await loadDemo(opts);
  let selected = catalogue.tasks;
  if (opts.tasks) {
    try {
      selected = selectTasks(catalogue.tasks, opts.tasks);
    } catch (e) {
      throw new UsageError(e.message);
    }
  }
  const queue = orderTasks(selected);
  const gates = startGates(queue);
  const position = new Map(queue.map((t, i) => [t.id, i]));
  const finished = new Map(queue.map((t) => [t.id, deferred()]));

  const cliMode = opts.mode !== "scripted";
  say(`repo=${opts.repo} mode=${opts.mode}${cliMode ? ` auth=${opts.auth}` : ""} agents=${opts.agents} speed=${opts.speed} contention=${opts.contention ? "on" : "off"} seed=${opts.seed} tasks=${queue.length} api=${opts.api}`);
  // Before the repo is touched, so a mode that is not built, a CLI that is not logged in or a key that is
  // rejected fails without side effects.
  const runAgent = injected ?? (await agentFor(opts.mode));
  const preflight = injected ? null : await preflightFor(opts.mode);
  if (preflight) {
    const access = await preflight({ auth: opts.auth, stub: opts.stub || undefined, model: opts.model ?? undefined });
    say(`${opts.mode} runs on ${access.how}${access.mode === "subscription" && opts.agents > 1 ? `; all ${opts.agents} agents draw on that one plan's usage limits` : ""}`);
  }
  await ensureRepo(api, opts, catalogue.demo, say);
  const baseline = (await allOps(api, opts.repo)).at(-1)?.seq ?? 0;

  const localSlots = limiter(opts.verifySlots);
  const width = Math.max(2, String(opts.agents).length);
  const results = [];
  let next = 0;
  const startedAt = Date.now();
  const agentLog = (agent, line) => log(`${stamp()}  ${agent.padEnd(8)}  ${line}`);

  async function worker(n) {
    const id = `agent-${String(n).padStart(width, "0")}`;
    for (;;) {
      const i = next++;
      const task = queue[i];
      if (!task) return;
      const waitFor = (gates[task.id] ?? []).filter((g) => position.get(g) < i);
      if (waitFor.length > 0) {
        agentLog(id, `${task.id}  waiting for ${waitFor.join(", ")} to finish`);
        await Promise.all(waitFor.map((g) => finished.get(g).promise));
      }
      try {
        results.push(
          await runAgent({
            api,
            repo: opts.repo,
            task,
            dir: catalogue.dir,
            worker: id,
            rng: makeRng(seedFor(opts.seed, task.id)),
            speed: opts.speed,
            contention: opts.contention,
            log: agentLog,
            // Only the claude and codex agents read these; they are how --stub, --model, --auth, --api and
            // --token reach their runner job.
            stub: opts.stub || undefined,
            model: opts.model ?? undefined,
            auth: opts.auth,
            apiUrl: opts.api,
            token: opts.token,
            verify: (dir, policy) => localSlots(() => localVerify(dir, policy)),
          }),
        );
      } catch (e) {
        agentLog(id, `${task.id}  error: ${brief(e)}`);
        results.push({ task: task.id, agent: id, outcome: "error", error: brief(e), txn: null, attempts: 0, variants: [] });
      }
      finished.get(task.id).resolve();
    }
  }
  await Promise.all(Array.from({ length: opts.agents }, (_, i) => worker(i + 1)));
  const finishedAt = Date.now();
  say(`all ${queue.length} tasks finished in ${((finishedAt - startedAt) / 1000).toFixed(1)} s`);

  const [ops, summary] = await Promise.all([allOps(api, opts.repo, baseline), api.repo(opts.repo)]);
  const report = buildReport({ ops, summary, tasks: selected, repo: opts.repo });
  const storeUrl = process.env.RYKE_STORE_URL ?? `http://127.0.0.1:${8788 + opts.offset}`;
  report.trunk = checksTrunk(opts.api, process.env)
    ? await verifyTrunk({ storeUrl, repo: opts.repo, head: summary.head, verify: summary.policy.verify, timeoutSeconds: summary.policy.verifyTimeoutSeconds })
    : null;
  report.preview = await checkPreview({ apiUrl: opts.api, repo: opts.repo, head: summary.head, categories: landedCategories(report, selected) });
  report.criteria = evaluateCriteria(report);
  return { report, results, startedAt, finishedAt, text: formatReport(report) };
}

// The trunk check clones through the local store. A swarm against a deployed Ryke has no store to
// reach, so the check reads "not checked" there instead of a false failure.
export function checksTrunk(api, env) {
  return Boolean(env.RYKE_STORE_URL) || ["127.0.0.1", "localhost", "[::1]"].includes(new URL(api).hostname);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseSwarmArgs(argv, env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  let stack = null;
  const stop = async () => {
    await stack?.close();
    process.exit(130);
  };
  try {
    if (opts.stack) {
      const { startStack } = await import("../dev/stack.mjs");
      stack = await startStack({ offset: opts.offset, fresh: true, quiet: true });
      opts = { ...opts, api: stack.apiUrl, token: stack.token };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
    const { report, results, startedAt, finishedAt, text } = await runSwarm(opts);
    console.log(`\n${text}`);
    if (opts.json) {
      await mkdir(dirname(opts.json), { recursive: true });
      const { token: _token, ...safe } = opts;
      await writeFile(opts.json, `${JSON.stringify({ opts: safe, startedAt, finishedAt, report, results }, null, 2)}\n`);
      console.log(`\nreport written to ${opts.json}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) console.error(`${e.message}\n${USAGE}`);
    else if (e.name === "AccessError") console.error(`swarm failed: ${e.message}`);
    else console.error(`swarm failed: ${e.stack ?? e.message}`);
    return e instanceof UsageError ? 2 : 1;
  } finally {
    await stack?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
