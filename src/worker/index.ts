import { Hono } from "hono";
import { api, authorized } from "./api";
import { mcpFetch } from "./mcp";
import { ledger } from "./service";
import type { PushEvent } from "../shared/types";

export { Land } from "./land";
export { Ledger } from "./ledger/ledger";

const app = new Hono<{ Bindings: Env }>();

app.route("/", api);

app.all("/mcp", async (c) => {
  if (!authorized(c.env, c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
  return mcpFetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Local push events from dev/store (PLAN.md §5.5); production gets them through the ryke-ingest workflow.
app.post("/internal/events", async (c) => {
  if (!c.env.RYKE_INTERNAL_SECRET || c.req.header("x-ryke-internal") !== c.env.RYKE_INTERNAL_SECRET) return c.json({ error: "unauthorized" }, 401);
  const ev = (await c.req.json().catch(() => null)) as PushEvent | null;
  if (ev?.type !== "cf.artifacts.repo.pushed" || typeof ev.source?.repoName !== "string") return c.json({ error: "not a push event" }, 422);
  const name = ev.source.repoName;
  const repo = name.includes("--") ? name.slice(0, name.indexOf("--")) : name;
  const res = await ledger(c.env, repo).onPush(name, ev.payload.ref, ev.payload.after);
  return c.json(res.ok ? res.value : { txn: null });
});

export default app;
