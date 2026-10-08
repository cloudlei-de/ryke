import { Hono, type Context, type MiddlewareHandler } from "hono";
import latestBench from "../../bench/results/latest.json";
import type { Res } from "./ledger/ledger";
import { runnerFor, RunnerError } from "./runner/runner";
import { agentToken, agentTokenTxn, begin, sameText, createRepo, deleteRepo, ledger, NAME_ERROR, repoKnown, txnLedger, validRepoName } from "./service";
import { storeFor, StoreError } from "./store/store";

type App = { Bindings: Env };

export function respond<T>(c: Context<App>, res: Res<T>, okStatus = 200): Response {
  if (res.ok) return c.json(res.value as object, okStatus as 200);
  return c.json({ error: res.error, ...(res.detail === undefined ? {} : { detail: res.detail }) }, res.status as 400);
}

async function body(c: Context<App>): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function authorized(env: Env, header: string | undefined): boolean {
  return Boolean(env.RYKE_TOKEN) && header !== undefined && sameText(header, `Bearer ${env.RYKE_TOKEN}`);
}

export const api = new Hono<App>().basePath("/api");

// What an agent job may do with its transaction's agent token (service.ts): work on that transaction,
// never approve or reject it, and nothing else.
const AGENT_ROUTE = /^\/api\/txns\/([^/]+)\/(reads|intend-write|submit|retry|refresh|abort)$/;

// Reads are public; every write needs the bearer token (PLAN.md §6.1) or, on AGENT_ROUTE, the agent token.
api.use("*", async (c, next) => {
  const header = c.req.header("authorization");
  // Hono answers HEAD with the GET handler, so HEAD is a read too.
  if (c.req.method === "GET" || c.req.method === "HEAD" || authorized(c.env, header)) return next();
  const route = AGENT_ROUTE.exec(c.req.path);
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (route && bearer && (await agentTokenTxn(c.env, bearer)) === route[1]) return next();
  return c.json({ error: "unauthorized" }, 401);
});

// Every /api/repos/:repo… route takes the repo name from the URL, and a Durable Object exists for any
// name it is asked for. A malformed name therefore stops here, before there is anything to ask.
const checkRepoName: MiddlewareHandler<App> = async (c, next) => {
  if (!validRepoName(c.req.param("repo"))) return c.json({ error: NAME_ERROR }, 422);
  await next();
};
api.use("/repos/:repo", checkRepoName);
api.use("/repos/:repo/*", checkRepoName);

// Public reads of a repo nobody created answer 404 from the registry (service.ts), so a made-up name
// never reaches, and never creates, that name's Ledger.
async function unknownRepo(c: Context<App>, repo: string): Promise<Response | null> {
  return (await repoKnown(c.env, repo)) ? null : c.json({ error: "repo is not initialised" }, 404);
}

api.get("/health", (c) => c.json({ ok: true }));

// Bundled at build time: the bench runs on a developer machine and its committed JSON ships with the Worker.
api.get("/bench", (c) => c.json(latestBench));

// Same pattern as `evidenceUrl` in src/web/views/txn/format.ts, which builds the links to this route: a name
// with a separator or a leading dot never reaches the runner.
const EVIDENCE_FILE = /^[A-Za-z0-9_-][\w.-]*\.png$/i;

// Verify screenshots (§12 view 2) live on the local runner's disk. The container runner has no store for them
// yet (DECISIONS.md, M2), so there the route says so instead of pretending. The bytes are served as an image
// the browser may not sniff into anything else, because a verify job writes them and runs agent-written code.
api.get("/evidence/:file", async (c) => {
  const file = c.req.param("file");
  if (!EVIDENCE_FILE.test(file)) return c.json({ error: "evidence file names look like <id>.png" }, 422);
  if (c.env.RYKE_RUNNER === "container") return c.json({ error: "evidence screenshots are served only by the local runner" }, 404);
  let upstream: Response;
  try {
    // A runner has no reason to redirect; following one would send this request wherever it points.
    upstream = await fetch(`${c.env.RYKE_RUNNER_URL}/v1/evidence/${encodeURIComponent(file)}`, { redirect: "manual" });
  } catch {
    return c.json({ error: "the runner did not serve the screenshot" }, 503);
  }
  if (upstream.status === 404) return c.json({ error: "no such evidence file" }, 404);
  if (upstream.status !== 200) return c.json({ error: "the runner did not serve the screenshot" }, 503);
  // A job id is never reused, so the file behind this name never changes.
  return new Response(upstream.body, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
});

api.post("/repos", async (c) => {
  const b = await body(c);
  if (!b) return c.json({ error: "body must be a JSON object" }, 422);
  if (b.fresh === true && validRepoName(b.name)) await deleteRepo(c.env, b.name);
  return respond(c, await createRepo(c.env, b.name, b.seedFrom, b.policy), 201);
});

api.delete("/repos/:repo", async (c) => respond(c, await deleteRepo(c.env, c.req.param("repo"))));

api.get("/repos/:repo", async (c) => {
  const repo = c.req.param("repo");
  return (await unknownRepo(c, repo)) ?? respond(c, await ledger(c.env, repo).summary());
});

api.post("/repos/:repo/txns", async (c) => {
  const b = await body(c);
  if (!b) return c.json({ error: "body must be a JSON object" }, 422);
  const res = await begin(c.env, c.req.param("repo"), b as never);
  return respond(c, res, res.ok && res.value.state === "rejected" ? 409 : 201);
});

api.get("/repos/:repo/ops", async (c) => {
  const repo = c.req.param("repo");
  return (await unknownRepo(c, repo)) ?? respond(c, await ledger(c.env, repo).ops(Number(c.req.query("after") ?? 0), Number(c.req.query("limit") ?? 500)));
});

api.get("/repos/:repo/stream", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected a websocket upgrade" }, 426);
  const repo = c.req.param("repo");
  const unknown = await unknownRepo(c, repo);
  if (unknown) return unknown;
  const summary = await ledger(c.env, repo).summary();
  if (!summary.ok) return respond(c, summary);
  return ledger(c.env, repo).fetch(c.req.raw);
});

api.post("/repos/:repo/recall", async (c) => {
  const b = await body(c);
  if (!b) return c.json({ error: "body must be a JSON object" }, 422);
  const repo = c.req.param("repo");
  const res = await ledger(c.env, repo).recall(b.selector, b.dryRun !== false);
  // Re-queued transactions are new, so the txn → repo index has to learn them like any begin.
  if (!res.ok || !res.value.requeued) return respond(c, res);
  const requeued = [];
  for (const q of res.value.requeued) {
    await ledger(c.env, "__index").indexPut(q.txn, repo);
    requeued.push({ ...q, agentToken: await agentToken(c.env, q.txn) });
  }
  return respond(c, { ...res, value: { ...res.value, requeued } });
});

// The dashboard's "Run demo" button (PLAN.md §11.2): runs harness/swarm.mjs as a runner job that
// talks to this very API, so the demo drives the platform the way any outside agent would.
api.post("/demo/:repo/start", async (c) => {
  const b = await body(c);
  if (!b) return c.json({ error: "body must be a JSON object" }, 422);
  const repo = c.req.param("repo");
  const { mode, agents, speed = 4 } = b;
  if (!validRepoName(repo)) return c.json({ error: "repo must match [a-z0-9][a-z0-9-]{0,40}" }, 422);
  if (mode !== "scripted" && mode !== "claude") return c.json({ error: "mode must be scripted or claude" }, 422);
  if (typeof agents !== "number" || !Number.isInteger(agents) || agents < 1 || agents > 50) return c.json({ error: "agents must be an integer from 1 to 50" }, 422);
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) return c.json({ error: "speed must be a number greater than 0" }, 422);
  try {
    const job = await runnerFor(c.env).start(
      "swarm",
      { repo, mode, agents: String(agents), speed: String(speed) },
      { RYKE_API_URL: new URL(c.req.url).origin, RYKE_TOKEN: c.env.RYKE_TOKEN },
    );
    return c.json({ job }, 202);
  } catch (e) {
    // Container mode has no swarm job kind; the runner being down is the other way this fails.
    if (e instanceof RunnerError) return c.json({ error: e.message }, 503);
    throw e;
  }
});

api.get("/repos/:repo/files", async (c) => {
  const repo = c.req.param("repo");
  const unknown = await unknownRepo(c, repo);
  if (unknown) return unknown;
  const summary = await ledger(c.env, repo).summary();
  if (!summary.ok) return respond(c, summary);
  const ref: string = c.req.query("ref") || String(summary.value.head);
  const path = c.req.query("path");
  try {
    const store = storeFor(c.env);
    if (!path) return c.json({ ref, files: await store.files(repo, ref) });
    const content = await store.readFile(repo, ref, path);
    return content === null ? c.json({ error: `no file ${path} at ${ref}` }, 404) : c.json({ ref, path, content });
  } catch (e) {
    if (e instanceof StoreError) return c.json({ error: e.message }, e.code === "NOT_FOUND" ? 404 : 503);
    throw e;
  }
});

type TxnHandler = (stub: NonNullable<Awaited<ReturnType<typeof txnLedger>>>, id: string, b: Record<string, unknown>) => Promise<Res<unknown>>;

function txnRoute(method: "get" | "post", path: string, handler: TxnHandler) {
  api[method](`/txns/:id${path}`, async (c) => {
    const id = c.req.param("id");
    const b = method === "post" ? await body(c) : {};
    if (!b) return c.json({ error: "body must be a JSON object" }, 422);
    const stub = await txnLedger(c.env, id);
    if (!stub) return c.json({ error: `unknown transaction ${id}` }, 404);
    return respond(c, await handler(stub, id, method === "get" ? c.req.query() : b));
  });
}

txnRoute("get", "", (s, id) => s.detail(id));
txnRoute("get", "/wait", (s, id, q) => s.wait(id, Number(q.timeout ?? 30) * 1000));
txnRoute("post", "/reads", (s, id, b) => s.reads(id, b.paths));
txnRoute("post", "/intend-write", (s, id, b) => s.intendWrite(id, b.path));
txnRoute("post", "/submit", (s, id, b) => s.submit(id, { head: b.head, evidence: b.evidence }));
txnRoute("post", "/retry", (s, id) => s.retry(id));
txnRoute("post", "/refresh", (s, id) => s.refresh(id));
txnRoute("post", "/abort", (s, id, b) => s.abort(id, b.reason));
txnRoute("post", "/approve", (s, id) => s.approve(id));
txnRoute("post", "/reject", (s, id) => s.reject(id));
