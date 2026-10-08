import { Hono } from "hono";
import { api, authorized } from "./api";
import { mcpFetch } from "./mcp";
import { previewFetch } from "./preview";
import { ingestPush, isPushEvent } from "./ingest";
import { sameText } from "./service";

export { Ingest } from "./ingest";
export { Land } from "./land";
export { Ledger } from "./ledger/ledger";
// Bound only in env.production (wrangler.jsonc); exporting them locally costs nothing.
export { Outbound, Runner } from "./runner/container";

const app = new Hono<{ Bindings: Env }>();

app.route("/", api);

app.all("/mcp", async (c) => {
  if (!authorized(c.env, c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
  return mcpFetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

app.all("/preview/:repo/:sha/*", (c) => previewFetch(c.req.raw, c.env));

// Local push events from dev/store (PLAN.md §5.5); production gets them through the ryke-ingest workflow.
app.post("/internal/events", async (c) => {
  if (!c.env.RYKE_INTERNAL_SECRET || !sameText(c.req.header("x-ryke-internal") ?? "", c.env.RYKE_INTERNAL_SECRET)) return c.json({ error: "unauthorized" }, 401);
  const ev = (await c.req.json().catch(() => null)) as unknown;
  if (!isPushEvent(ev)) return c.json({ error: "not a push event" }, 422);
  return c.json(await ingestPush(c.env, ev));
});

export default app;
