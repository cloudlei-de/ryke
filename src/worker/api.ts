import { Hono, type Context } from "hono";
import latestBench from "../../bench/results/latest.json";
import type { Res } from "./ledger/ledger";
import { runnerFor, RunnerError } from "./runner/runner";
import { begin, createRepo, deleteRepo, ledger, txnLedger, validRepoName } from "./service";
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
  return Boolean(env.RYKE_TOKEN) && header === `Bearer ${env.RYKE_TOKEN}`;
}

export const api = new Hono<App>().basePath("/api");

// Reads are public; every write needs the bearer token (PLAN.md §6.1).
api.use("*", async (c, next) => {
  if (c.req.method !== "GET" && !authorized(c.env, c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
  await next();
});

api.get("/health", (c) => c.json({ ok: true }));

// Bundled at build time: the bench runs on a developer machine and its committed JSON ships with the Worker.
api.get("/bench", (c) => c.json(latestBench));

api.post("/repos", async (c) => {
  const b = await body(c);
  if (!b) return c.json({ error: "body must be a JSON object" }, 422);
  if (b.fresh === true && validRepoName(b.name)) await deleteRepo(c.env, b.name);
  return respond(c, await createRepo(c.env, b.name, b.seedFrom), 201);
});

api.delete("/repos/:repo", async (c) => respond(c, await deleteRepo(c.env, c.req.param("repo"))));

api.get("/repos/:repo", async (c) => respond(c, await ledger(c.env, c.req.param("repo")).summary()));

api.post("/repos/:repo/txns", async (c) => {
  const b = await body(c);
  if (!b) return c.json({ error: "body must be a JSON object" }, 422);
  const res = await begin(c.env, c.req.param("repo"), b as never);
  return respond(c, res, res.ok && res.value.state === "rejected" ? 409 : 201);
});

api.get("/repos/:repo/ops", async (c) =>
  respond(c, await ledger(c.env, c.req.param("repo")).ops(Number(c.req.query("after") ?? 0), Number(c.req.query("limit") ?? 500))),
);

api.get("/repos/:repo/stream", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected a websocket upgrade" }, 426);
  const summary = await ledger(c.env, c.req.param("repo")).summary();
  if (!summary.ok) return respond(c, summary);
  return ledger(c.env, c.req.param("repo")).fetch(c.req.raw);
});

api.post("/repos/:repo/recall", async (c) => {
  const b = await body(c);
  if (!b) return c.json({ error: "body must be a JSON object" }, 422);
  const repo = c.req.param("repo");
  const res = await ledger(c.env, repo).recall(b.selector, b.dryRun !== false);
  // Re-queued transactions are new, so the txn → repo index has to learn them like any begin.
  if (res.ok) for (const q of res.value.requeued ?? []) await ledger(c.env, "__index").indexPut(q.txn, repo);
  return respond(c, res);
});

// The dashboard's "Run demo" button (PLAN.md §11.2): runs harness/swarm.mjs as a runner job that
// talks to this very API, so the demo drives the platform the way any outside agent would.
api.post("/demo/:repo/start", async (c) => {
  const b = await body(c);
  if (!b) return c.json({ error: "body must be a JSON object" }, 422);
  const repo = c.req.param("repo");
  const { mode, agents, speed = 4 } = b;
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(repo)) return c.json({ error: "repo must match [a-z0-9][a-z0-9-]{0,40}" }, 422);
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
txnRoute("post", "/abort", (s, id, b) => s.abort(id, b.reason));
txnRoute("post", "/approve", (s, id) => s.approve(id));
txnRoute("post", "/reject", (s, id) => s.reject(id));
