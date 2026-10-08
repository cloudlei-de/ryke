// The MCP endpoint (PLAN.md §6.2) spoken the way a client does: JSON-RPC over Streamable HTTP to
// /mcp with the bearer token. Every tool: success, 404 for an unknown transaction, 409 for a wrong
// state and a refusal of invalid input, either by the input schema or by the Ledger's 422.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { apiBegin, AUTH, commitToFork, http, landOnTrunk, lazy, newRepo, ok, unique, type Json, type TestRepo } from "./helpers";

const PROTOCOL = "2025-06-18";
const TOOLS = ["ryke_repo", "ryke_begin", "ryke_read", "ryke_reads", "ryke_submit", "ryke_status", "ryke_wait", "ryke_retry", "ryke_abort"];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Rpc = { jsonrpc: "2.0"; id?: number | null; result?: Json; error?: { code: number; message: string } };
type ToolOut = { isError: boolean; text: string; json: Json };

// The handler answers with SSE or plain JSON depending on the request; both are valid, so both parse.
function parseRpc(text: string, contentType: string): Rpc[] {
  if (text.trim() === "") return [];
  if (contentType.includes("text/event-stream"))
    return text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()) as Rpc);
  const parsed = JSON.parse(text) as Rpc | Rpc[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

class McpClient {
  private nextId = 1;
  private session: string | null = null;
  version: string | null = null;
  serverInfo: Json = null;
  capabilities: Json = null;

  static async connect(): Promise<McpClient> {
    const c = new McpClient();
    const init = await c.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "ryke-test", version: "0.0.0" } });
    expect(init.error).toBeUndefined();
    c.version = init.result.protocolVersion;
    c.serverInfo = init.result.serverInfo;
    c.capabilities = init.result.capabilities;
    const ack = await c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(ack.status).toBe(202);
    return c;
  }

  // Sends one JSON-RPC message with the headers a client sends after the handshake.
  async send(message: unknown, opts: { auth?: boolean | string; headers?: Record<string, string>; method?: string; raw?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json, text/event-stream", ...opts.headers };
    const auth = opts.auth ?? true;
    if (auth === true) headers.authorization = AUTH.authorization;
    else if (typeof auth === "string") headers.authorization = auth;
    if (this.version) headers["mcp-protocol-version"] = this.version;
    if (this.session) headers["mcp-session-id"] = this.session;
    const method = opts.method ?? "POST";
    const body = method === "POST" ? (opts.raw ?? JSON.stringify(message)) : undefined;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await exports.default.fetch("http://ryke.test/mcp", { method, headers, body });
    // A server that keeps sessions says so on the first answer; reuse its id from then on.
    this.session = res.headers.get("mcp-session-id") ?? this.session;
    return res;
  }

  async request(method: string, params?: unknown): Promise<Rpc> {
    const id = this.nextId++;
    const res = await this.send({ jsonrpc: "2.0", id, method, params });
    expect(res.status, method).toBe(200);
    const replies = parseRpc(await res.text(), res.headers.get("content-type") ?? "");
    const mine = replies.find((r) => r.id === id);
    if (!mine) throw new Error(`no reply to ${method} #${id} in ${JSON.stringify(replies)}`);
    return mine;
  }

  async tools(): Promise<Json[]> {
    const r = await this.request("tools/list", {});
    expect(r.error).toBeUndefined();
    return r.result.tools;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
    const r = await this.request("tools/call", { name, arguments: args });
    expect(r.error, `${name} answered a protocol error`).toBeUndefined();
    const text: string = r.result.content?.[0]?.text ?? "";
    let json: Json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Input-validation refusals are plain text, not JSON.
    }
    return { isError: r.result.isError === true, text, json };
  }
}

// Calls a tool and requires success, returning its JSON payload.
async function okCall(c: McpClient, name: string, args: Record<string, unknown>): Promise<Json> {
  const out = await c.call(name, args);
  expect(out.isError, out.text).toBe(false);
  return out.json;
}

const txnOf = async (id: string): Promise<Json> => {
  const r = await http("GET", `/api/txns/${id}`);
  expect(r.status).toBe(200);
  return r.body;
};

// A transaction that pushed `files` to its fork, still open (not submitted).
async function pushed(t: TestRepo, files: Record<string, string | null>, reads: string[] = ["src/a.ts"]) {
  const b = await apiBegin(t.name);
  if (reads.length) expect((await http("POST", `/api/txns/${b.txn}/reads`, { body: { paths: reads } })).status).toBe(200);
  const sha = await commitToFork(b, files);
  return { b, sha };
}

// An open transaction that read src/format.ts, which another transaction then landed, then submitted: stale.
async function staleTxn(t: TestRepo) {
  const b = await apiBegin(t.name, "agent-b");
  const lander = await landOnTrunk(t, { "src/format.ts": "export const digits = 3;\n" }, "agent-a");
  expect((await http("POST", `/api/txns/${b.txn}/reads`, { body: { paths: ["src/format.ts"] } })).status).toBe(200);
  const sha = await commitToFork(b, { "test/rounding.test.ts": "// expects 2 digits\n" });
  const s = await http("POST", `/api/txns/${b.txn}/submit`, { body: { head: sha } });
  expect(s.body.state).toBe("stale");
  return { b, lander, sha };
}

describe("authentication", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t", version: "0" } } };

  it.each([
    ["no header", false],
    ["a wrong token", "Bearer not-the-token"],
    ["the token without a scheme", AUTH.authorization.slice("Bearer ".length)],
    ["a lower-case scheme", AUTH.authorization.toLowerCase()],
  ])("is 401 with %s", async (_label, auth) => {
    const c = new McpClient();
    for (const method of ["POST", "GET", "DELETE"]) {
      const res = await c.send(init, { auth, method });
      expect(res.status, method).toBe(401);
      expect(await res.json(), method).toEqual({ error: "unauthorized" });
    }
  });

  it("does not run a tool without the token", async () => {
    const t = await newRepo();
    const c = new McpClient();
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ryke_begin", arguments: { repo: t.name, agent: "a", intent: "x" } } };
    expect((await c.send(call, { auth: false })).status).toBe(401);
    expect((await http("GET", `/api/repos/${t.name}`)).body.counts).toEqual({});
  });

  it("accepts the token", async () => {
    const c = new McpClient();
    expect((await c.send(init)).status).toBe(200);
  });
});

describe("protocol", () => {
  it("answers initialize with the server info, the tools capability and the requested version", async () => {
    const c = await McpClient.connect();
    expect(c.version).toBe(PROTOCOL);
    expect(c.serverInfo).toMatchObject({ name: "ryke", version: "0.1.0" });
    expect(c.capabilities.tools).toBeDefined();
  });

  it("answers ping", async () => {
    const c = await McpClient.connect();
    const r = await c.request("ping");
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({});
  });

  it("answers a call to a tool that does not exist with a protocol error", async () => {
    const c = await McpClient.connect();
    const r = await c.request("tools/call", { name: "ryke_land", arguments: {} });
    expect(r.result).toBeUndefined();
    expect(r.error).toMatchObject({ code: -32602, message: expect.stringContaining("ryke_land") });
  });

  it("answers a method it does not know with method-not-found", async () => {
    const c = await McpClient.connect();
    const r = await c.request("resources/list", {});
    expect(r.error?.code).toBe(-32601);
  });

  it("is 400 for a body that is not JSON", async () => {
    const c = await McpClient.connect();
    const res = await c.send(null, { raw: "{" });
    expect(res.status).toBe(400);
    const [reply] = parseRpc(await res.text(), res.headers.get("content-type") ?? "");
    expect(reply?.error?.code).toBe(-32700);
  });
});

describe("tools/list", () => {
  it("lists exactly the nine Ryke tools", async () => {
    const c = await McpClient.connect();
    const tools = await c.tools();
    expect(tools).toHaveLength(TOOLS.length);
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
  });

  it("describes every tool for an agent reader", async () => {
    const tools = await (await McpClient.connect()).tools();
    for (const t of tools) {
      expect(t.description, t.name).toEqual(expect.any(String));
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });

  // §6.2: each tool says when to call it, and the tools that open or extend the read set say that
  // unreported reads serialise the transaction against everything.
  it.each(["ryke_begin", "ryke_read", "ryke_reads"])("%s tells the agent to report every read", async (name) => {
    const tools = await (await McpClient.connect()).tools();
    const d: string = tools.find((t) => t.name === name)!.description;
    expect(d).toContain("report every file you read");
    expect(d).toContain("serialises it against much more work");
  });

  it.each([
    ["ryke_repo", /before/i],
    ["ryke_begin", /open a transaction/i],
    ["ryke_read", /snapshot/i],
    ["ryke_reads", /staleWarnings/],
    ["ryke_submit", /ryke_retry/],
    ["ryke_status", /stale/i],
    ["ryke_wait", /60 s/],
    ["ryke_retry", /delta/i],
    ["ryke_abort", /give up/i],
  ])("%s says when and why to call it", async (name, pattern) => {
    const tools = await (await McpClient.connect()).tools();
    expect(tools.find((t) => t.name === name)!.description).toMatch(pattern);
  });

  it.each([
    ["ryke_repo", ["repo"]],
    ["ryke_begin", ["repo", "intent", "agent"]],
    ["ryke_read", ["txn", "path"]],
    ["ryke_reads", ["txn", "paths"]],
    ["ryke_submit", ["txn"]],
    ["ryke_status", ["txn"]],
    ["ryke_wait", ["txn"]],
    ["ryke_retry", ["txn"]],
    ["ryke_abort", ["txn", "reason"]],
  ])("%s requires %j", async (name, required) => {
    const tools = await (await McpClient.connect()).tools();
    const schema = tools.find((t) => t.name === name)!.inputSchema;
    expect([...schema.required].sort()).toEqual([...required].sort());
  });

  it("bounds ryke_wait's timeout to 0-60 seconds and defaults it to 30", async () => {
    const tools = await (await McpClient.connect()).tools();
    expect(tools.find((t) => t.name === "ryke_wait")!.inputSchema.properties.timeoutSeconds).toMatchObject({ type: "number", minimum: 0, maximum: 60, default: 30 });
  });
});

describe("ryke_repo", () => {
  it("returns the trunk, the policy and what is in flight", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const b = await apiBegin(t.name, "agent-r", "add r");
    await http("POST", `/api/txns/${b.txn}/reads`, { body: { paths: ["src/b.ts", "src/a.ts"] } });
    const s = await okCall(c, "ryke_repo", { repo: t.name });
    expect(s).toMatchObject({ repo: t.name, head: t.head, seq: 0, counts: { open: 1 }, heat: [], train: null });
    expect(s.policy.protected).toContain("test/**");
    expect(s.inflight).toEqual([{ txn: b.txn, agent: "agent-r", intent: "add r", state: "open", footprint: ["src/a.ts", "src/b.ts"] }]);
  });

  it("is 404 for a repo that was never initialised", async () => {
    const out = await (await McpClient.connect()).call("ryke_repo", { repo: unique("never") });
    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({ error: "repo is not initialised", status: 404 });
  });

  it("refuses input that does not match the schema", async () => {
    const c = await McpClient.connect();
    for (const args of [{}, { repo: 7 }, { repo: null }]) {
      const out = await c.call("ryke_repo", args);
      expect(out.isError, JSON.stringify(args)).toBe(true);
      expect(out.text, JSON.stringify(args)).toContain("repo");
    }
  });
});

describe("ryke_begin", () => {
  // No test in this block that uses it opens a transaction here, so its counts stay empty.
  const untouched = lazy(() => newRepo());

  it("lists the tools and opens a transaction that the HTTP API can see", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    expect((await c.tools()).map((x) => x.name)).toContain("ryke_begin");
    const b = await okCall(c, "ryke_begin", { repo: t.name, agent: "agent-07", intent: "add a unit", criteria: ["shows the unit"], model: "m-1" });
    expect(b).toMatchObject({ state: "open", attempt: 1, snapshot: t.head, warnings: [] });
    expect(b.txn).toMatch(/^t_[0-9a-z]+$/);
    expect(b.remote).toMatch(new RegExp(`/${t.name}--${b.txn}\\.git$`));
    expect(b.token).toMatch(/^art_v1_/);
    expect(b.trunk).toEqual({ remote: expect.stringContaining(`/${t.name}.git`), token: expect.stringMatching(/^art_v1_/) });
    expect(b.policy.protected).toContain("test/**");
    const d = await txnOf(b.txn);
    expect(d.txn).toMatchObject({ id: b.txn, repo: t.name, state: "open", agent: "agent-07", model: "m-1", intent: "add a unit", criteria: ["shows the unit"] });
    expect((await http("GET", `/api/repos/${t.name}`)).body.counts).toEqual({ open: 1 });
  });

  it("takes the optional fields as absent", async () => {
    const t = await newRepo();
    const b = await okCall(await McpClient.connect(), "ryke_begin", { repo: t.name, agent: "a", intent: Math.random().toString(36).slice(2, 14) });
    const d = await txnOf(b.txn);
    expect(d.txn).toMatchObject({ model: null, criteria: [] });
  });

  it("returns the judge's warnings about similar work in flight", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const first = await okCall(c, "ryke_begin", { repo: t.name, agent: "a1", intent: "add a velocity converter to the tiles page" });
    const second = await okCall(c, "ryke_begin", { repo: t.name, agent: "a2", intent: "add a velocity converter to the home page" });
    expect(second.state).toBe("open");
    expect(second.warnings.length).toBeGreaterThan(0);
    for (const w of second.warnings) expect(w).toMatchObject({ other: first.txn });
  });

  it.each([
    ["a blank agent", { agent: "  ", intent: "x" }, "agent"],
    ["a blank intent", { agent: "a", intent: "" }, "intent"],
  ])("is 422 for %s", async (_label, args, word) => {
    const t = await untouched();
    const out = await (await McpClient.connect()).call("ryke_begin", { repo: t.name, ...args });
    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({ status: 422, error: expect.stringContaining(word) });
    expect((await http("GET", `/api/repos/${t.name}`)).body.counts).toEqual({});
  });

  it("is 404 for a repo that was never initialised", async () => {
    const out = await (await McpClient.connect()).call("ryke_begin", { repo: unique("never"), agent: "a", intent: "x" });
    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({ status: 404, error: "repo is not initialised" });
  });

  it.each([
    ["no repo", { agent: "a", intent: "x" }, "repo"],
    ["no agent", { repo: "r", intent: "x" }, "agent"],
    ["no intent", { repo: "r", agent: "a" }, "intent"],
    ["a numeric intent", { repo: "r", agent: "a", intent: 5 }, "intent"],
    ["criteria that is not a list", { repo: "r", agent: "a", intent: "x", criteria: "c" }, "criteria"],
    ["criteria with a non-string", { repo: "r", agent: "a", intent: "x", criteria: [1] }, "criteria"],
    ["a numeric model", { repo: "r", agent: "a", intent: "x", model: 3 }, "model"],
  ])("refuses %s before it reaches the Ledger", async (_label, args, word) => {
    const out = await (await McpClient.connect()).call("ryke_begin", args);
    expect(out.isError).toBe(true);
    expect(out.json).toBeNull();
    expect(out.text).toContain(word);
  });
});

describe("ryke_read", () => {
  it("returns the file as of the snapshot and records the read", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const r = await okCall(await McpClient.connect(), "ryke_read", { txn: b.txn, path: "src/a.ts" });
    expect(r).toEqual({ path: "src/a.ts", content: "export const a = 2;\n", staleWarnings: [] });
    expect((await txnOf(b.txn)).attempts[0].reads).toEqual(["src/a.ts"]);
  });

  it("reads the snapshot, not trunk, and warns that the file changed since", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const lander = await landOnTrunk(t, { "src/a.ts": "export const a = 9;\n" });
    const r = await okCall(await McpClient.connect(), "ryke_read", { txn: b.txn, path: "src/a.ts" });
    expect(r.content).toBe("export const a = 2;\n");
    expect(r.staleWarnings).toEqual([{ path: "src/a.ts", seq: 1, by: lander.txn }]);
  });

  it("returns null for a file that does not exist at the snapshot, and still records the read", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const r = await okCall(await McpClient.connect(), "ryke_read", { txn: b.txn, path: "src/b.ts" });
    expect(r).toEqual({ path: "src/b.ts", content: null, staleWarnings: [] });
    expect((await txnOf(b.txn)).attempts[0].reads).toEqual(["src/b.ts"]);
  });

  it("returns the same file for the same path spelled with ./", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const r = await okCall(await McpClient.connect(), "ryke_read", { txn: b.txn, path: "./src/a.ts" });
    expect(r.content).toBe("export const a = 2;\n");
    expect((await txnOf(b.txn)).attempts[0].reads).toEqual(["src/a.ts"]);
  });

  it("is 422 for a path that escapes the repo, and records nothing", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const out = await (await McpClient.connect()).call("ryke_read", { txn: b.txn, path: "../../etc/passwd" });
    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({ status: 422 });
    expect((await txnOf(b.txn)).attempts[0].reads).toEqual([]);
  });

  it("is 404 for an unknown transaction and 409 once the transaction left open", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const unknown = await c.call("ryke_read", { txn: "t_nope", path: "src/a.ts" });
    expect(unknown.isError).toBe(true);
    expect(unknown.json).toEqual({ error: "unknown transaction t_nope", status: 404 });
    const { b, sha } = await pushed(t, { "src/x.ts": "x\n" });
    await http("POST", `/api/txns/${b.txn}/submit`, { body: { head: sha } });
    const wrong = await c.call("ryke_read", { txn: b.txn, path: "src/b.ts" });
    expect(wrong.isError).toBe(true);
    expect(wrong.json).toMatchObject({ status: 409, error: expect.stringContaining("ready") });
    expect((await txnOf(b.txn)).attempts[0].reads).toEqual(["src/a.ts"]);
  });

  it.each([
    ["no txn", { path: "src/a.ts" }, "txn"],
    ["no path", { txn: "t_x" }, "path"],
    ["a numeric path", { txn: "t_x", path: 3 }, "path"],
  ])("refuses %s before it reaches the Ledger", async (_label, args, word) => {
    const out = await (await McpClient.connect()).call("ryke_read", args);
    expect(out.isError).toBe(true);
    expect(out.json).toBeNull();
    expect(out.text).toContain(word);
  });
});

describe("ryke_reads", () => {
  // A refused batch records nothing, so one open transaction serves every row of the 422 table.
  const refused = lazy(async () => apiBegin((await newRepo()).name));

  it("records a batch and normalises the paths", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const r = await okCall(await McpClient.connect(), "ryke_reads", { txn: b.txn, paths: ["src/b.ts", "./src/a.ts", "src/a.ts", "src\\format.ts"] });
    expect(r).toEqual({ recorded: 3, staleWarnings: [] });
    expect((await txnOf(b.txn)).attempts[0].reads).toEqual(["src/a.ts", "src/b.ts", "src/format.ts"]);
  });

  it("returns the reads that are already stale", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const lander = await landOnTrunk(t, { "src/a.ts": "export const a = 9;\n" });
    const r = await okCall(await McpClient.connect(), "ryke_reads", { txn: b.txn, paths: ["src/a.ts", "src/format.ts"] });
    expect(r.staleWarnings).toEqual([{ path: "src/a.ts", seq: 1, by: lander.txn }]);
  });

  it("accepts an empty batch and 500 paths", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const c = await McpClient.connect();
    expect((await okCall(c, "ryke_reads", { txn: b.txn, paths: [] })).recorded).toBe(0);
    const many = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`);
    expect((await okCall(c, "ryke_reads", { txn: b.txn, paths: many })).recorded).toBe(500);
  });

  it.each([
    ["a path that escapes the repo", ["../x"]],
    ["an empty path", [""]],
    ["501 paths", Array.from({ length: 501 }, (_, i) => `f${i}`)],
  ])("is 422 for %s", async (_label, paths) => {
    const b = await refused();
    const out = await (await McpClient.connect()).call("ryke_reads", { txn: b.txn, paths });
    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({ status: 422 });
    expect((await txnOf(b.txn)).attempts[0].reads).toEqual([]);
  });

  it("is 404 for an unknown transaction and 409 once the transaction left open", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const unknown = await c.call("ryke_reads", { txn: "t_nope", paths: ["src/a.ts"] });
    expect(unknown.json).toEqual({ error: "unknown transaction t_nope", status: 404 });
    const { b } = await pushed(t, { "src/x.ts": "x\n" });
    await http("POST", `/api/txns/${b.txn}/abort`, { body: { reason: "x" } });
    const wrong = await c.call("ryke_reads", { txn: b.txn, paths: ["src/b.ts"] });
    expect(wrong.isError).toBe(true);
    expect(wrong.json).toMatchObject({ status: 409, error: expect.stringContaining("aborted") });
  });

  it.each([
    ["no paths", { txn: "t_x" }],
    ["paths that is a string", { txn: "t_x", paths: "src/a.ts" }],
    ["paths with a non-string", { txn: "t_x", paths: ["a", 1] }],
    ["no txn", { paths: [] }],
  ])("refuses %s before it reaches the Ledger", async (_label, args) => {
    const out = await (await McpClient.connect()).call("ryke_reads", args);
    expect(out.isError).toBe(true);
    expect(out.json).toBeNull();
    expect(out.text).toMatch(/paths|txn/);
  });
});

describe("ryke_submit", () => {
  it("moves a pushed change to ready", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const { b, sha } = await pushed(t, { "src/new.ts": "export const n = 1;\n" });
    expect(await okCall(c, "ryke_submit", { txn: b.txn, head: sha })).toEqual({ state: "ready" });
    const d = await txnOf(b.txn);
    expect(d.txn).toMatchObject({ state: "ready", head: sha });
    expect(d.attempts[0]).toEqual({ attempt: 1, reads: ["src/a.ts"], writes: ["src/new.ts"] });
  });

  it("finds the pushed head itself when the agent gives none", async () => {
    const t = await newRepo();
    const { b, sha } = await pushed(t, { "src/x.ts": "x\n" });
    expect(await okCall(await McpClient.connect(), "ryke_submit", { txn: b.txn })).toEqual({ state: "ready" });
    expect((await txnOf(b.txn)).txn.head).toBe(sha);
  });

  it("keeps the agent's summary and screenshot as evidence", async () => {
    const t = await newRepo();
    const { b, sha } = await pushed(t, { "src/x.ts": "x\n" });
    await okCall(await McpClient.connect(), "ryke_submit", { txn: b.txn, head: sha, summary: "added x, ran the tests", screenshot: "the page shows x" });
    expect((await txnOf(b.txn)).evidence).toEqual([
      { attempt: 1, kind: "log", summary: "added x, ran the tests", ref: "agent" },
      { attempt: 1, kind: "screenshot", summary: "the page shows x", ref: "agent" },
    ]);
  });

  it("keeps a summary on its own", async () => {
    const t = await newRepo();
    const { b, sha } = await pushed(t, { "src/x.ts": "x\n" });
    await okCall(await McpClient.connect(), "ryke_submit", { txn: b.txn, head: sha, summary: "only a summary" });
    expect((await txnOf(b.txn)).evidence).toEqual([{ attempt: 1, kind: "log", summary: "only a summary", ref: "agent" }]);
  });

  it("answers a repeated submit with the current state", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const { b, sha } = await pushed(t, { "src/x.ts": "x\n" });
    await okCall(c, "ryke_submit", { txn: b.txn, head: sha });
    const before = (await txnOf(b.txn)).ops.length;
    expect(await okCall(c, "ryke_submit", { txn: b.txn, head: sha })).toMatchObject({ state: "ready" });
    expect((await txnOf(b.txn)).ops).toHaveLength(before);
  });

  it("rejects an empty change and a change to a protected file", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const empty = await apiBegin(t.name);
    expect(await okCall(c, "ryke_submit", { txn: empty.txn })).toEqual({ state: "rejected", reason: "empty" });
    const { b, sha } = await pushed(t, { "test/a.test.ts": "// tampered\n" });
    expect(await okCall(c, "ryke_submit", { txn: b.txn, head: sha })).toEqual({ state: "rejected", reason: "protected", paths: ["test/a.test.ts"] });
  });

  it("answers stale when something the transaction read changed on trunk", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const lander = await landOnTrunk(t, { "src/format.ts": "export const digits = 3;\n" });
    await http("POST", `/api/txns/${b.txn}/reads`, { body: { paths: ["src/format.ts"] } });
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    const r = await okCall(await McpClient.connect(), "ryke_submit", { txn: b.txn, head: sha });
    expect(r).toEqual({ state: "stale", reason: "stale_read", paths: [{ path: "src/format.ts", seq: 1, by: lander.txn }] });
  });

  it("is 422 for a head that is not a sha or not in the fork, and the transaction stays open", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const b = await apiBegin(t.name);
    const bad = await c.call("ryke_submit", { txn: b.txn, head: "nope" });
    expect(bad.isError).toBe(true);
    expect(bad.json).toMatchObject({ status: 422, error: expect.stringContaining("head") });
    const missing = await c.call("ryke_submit", { txn: b.txn, head: "c".repeat(40) });
    expect(missing.json).toMatchObject({ status: 422, error: expect.stringContaining("not in fork") });
    expect((await txnOf(b.txn)).txn.state).toBe("open");
  });

  it("is 404 for an unknown transaction and 409 for an aborted one", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    expect((await c.call("ryke_submit", { txn: "t_nope" })).json).toEqual({ error: "unknown transaction t_nope", status: 404 });
    const b = await apiBegin(t.name);
    await http("POST", `/api/txns/${b.txn}/abort`, { body: { reason: "x" } });
    const wrong = await c.call("ryke_submit", { txn: b.txn });
    expect(wrong.isError).toBe(true);
    expect(wrong.json).toMatchObject({ status: 409, error: expect.stringContaining("aborted") });
  });

  it.each([
    ["no txn", {}, "txn"],
    ["a numeric head", { txn: "t_x", head: 4 }, "head"],
    ["a numeric summary", { txn: "t_x", summary: 4 }, "summary"],
    ["a boolean screenshot", { txn: "t_x", screenshot: true }, "screenshot"],
  ])("refuses %s before it reaches the Ledger", async (_label, args, word) => {
    const out = await (await McpClient.connect()).call("ryke_submit", args);
    expect(out.isError).toBe(true);
    expect(out.json).toBeNull();
    expect(out.text).toContain(word);
  });
});

describe("ryke_status", () => {
  it("reports an open transaction", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name, "agent-s", "do s");
    const r = await okCall(await McpClient.connect(), "ryke_status", { txn: b.txn });
    expect(r).toMatchObject({ txn: { id: b.txn, repo: t.name, agent: "agent-s", intent: "do s", state: "open", attempt: 1, snapshot: t.head }, staleWarnings: [], detail: {} });
  });

  it("follows the transaction through submit", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const { b, sha } = await pushed(t, { "src/x.ts": "x\n" });
    await okCall(c, "ryke_submit", { txn: b.txn, head: sha });
    expect((await okCall(c, "ryke_status", { txn: b.txn })).txn).toMatchObject({ state: "ready", head: sha });
  });

  it("returns stale warnings for reads that changed on trunk", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    await http("POST", `/api/txns/${b.txn}/reads`, { body: { paths: ["src/format.ts", "src/b.ts"] } });
    const lander = await landOnTrunk(t, { "src/format.ts": "export const digits = 4;\n" });
    const r = await okCall(await McpClient.connect(), "ryke_status", { txn: b.txn });
    expect(r.staleWarnings).toEqual([{ path: "src/format.ts", seq: 1, by: lander.txn }]);
  });

  it("reports the stale paths once the transaction is stale", async () => {
    const t = await newRepo();
    const { b, lander } = await staleTxn(t);
    const r = await okCall(await McpClient.connect(), "ryke_status", { txn: b.txn });
    expect(r.txn).toMatchObject({ state: "stale", reason: "stale_read" });
    expect(r.detail.stale).toEqual([{ path: "src/format.ts", seq: 1, by: lander.txn }]);
    expect(r.staleWarnings).toEqual([]);
  });

  it("is 404 for an unknown transaction and refuses a missing txn", async () => {
    const c = await McpClient.connect();
    const unknown = await c.call("ryke_status", { txn: "t_nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.json).toEqual({ error: "unknown transaction t_nope", status: 404 });
    const none = await c.call("ryke_status", {});
    expect(none.isError).toBe(true);
    expect(none.text).toContain("txn");
  });
});

describe("ryke_wait", () => {
  it("returns after a short timeout with changed: false", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const started = Date.now();
    const r = await okCall(await McpClient.connect(), "ryke_wait", { txn: b.txn, timeoutSeconds: 0.3 });
    expect(r).toMatchObject({ changed: false, staleWarnings: [], txn: { id: b.txn, state: "open" } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("returns at once for timeoutSeconds 0", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const started = Date.now();
    expect((await okCall(await McpClient.connect(), "ryke_wait", { txn: b.txn, timeoutSeconds: 0 })).changed).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("wakes as soon as the transaction changes state", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const waiter = await McpClient.connect();
    const other = await McpClient.connect();
    const started = Date.now();
    const waiting = okCall(waiter, "ryke_wait", { txn: b.txn, timeoutSeconds: 20 });
    await sleep(500);
    expect(await okCall(other, "ryke_abort", { txn: b.txn, reason: "enough" })).toEqual({ state: "aborted" });
    const r = await waiting;
    expect(r).toMatchObject({ changed: true, txn: { state: "aborted", reason: "enough" } });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("wakes when a landing makes a file the transaction read stale", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    await http("POST", `/api/txns/${b.txn}/reads`, { body: { paths: ["src/format.ts"] } });
    const waiting = okCall(await McpClient.connect(), "ryke_wait", { txn: b.txn, timeoutSeconds: 20 });
    await sleep(500);
    const lander = await landOnTrunk(t, { "src/format.ts": "export const digits = 5;\n" });
    const r = await waiting;
    expect(r.changed).toBe(false);
    expect(r.staleWarnings).toEqual([{ path: "src/format.ts", seq: 1, by: lander.txn }]);
  });

  it("defaults to 30 seconds but returns at once when the transaction can no longer change", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const b = await apiBegin(t.name);
    await okCall(c, "ryke_abort", { txn: b.txn, reason: "x" });
    const started = Date.now();
    const r = await okCall(c, "ryke_wait", { txn: b.txn });
    expect(r).toMatchObject({ changed: false, txn: { state: "aborted" } });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each([
    ["more than 60 seconds", 61],
    ["a negative timeout", -1],
    ["a string", "30"],
    ["null", null],
  ])("refuses %s before it reaches the Ledger", async (_label, timeoutSeconds) => {
    const out = await (await McpClient.connect()).call("ryke_wait", { txn: "t_x", timeoutSeconds });
    expect(out.isError).toBe(true);
    expect(out.json).toBeNull();
    expect(out.text).toContain("timeoutSeconds");
  });

  it("is 404 for an unknown transaction", async () => {
    const out = await (await McpClient.connect()).call("ryke_wait", { txn: "t_nope", timeoutSeconds: 0 });
    expect(out.isError).toBe(true);
    expect(out.json).toEqual({ error: "unknown transaction t_nope", status: 404 });
  });
});

describe("ryke_retry", () => {
  it("opens a new attempt on the current trunk and returns the delta of the stale paths", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const { b, lander } = await staleTxn(t);
    const r = await okCall(c, "ryke_retry", { txn: b.txn });
    expect(r).toMatchObject({ snapshot: lander.sha, attempt: 2, failures: null, remote: b.remote });
    expect(r.delta).toEqual([{ path: "src/format.ts", patch: expect.stringContaining("-export const digits = 2;\n+export const digits = 3;") }]);
    expect(r.trunk).toEqual({ remote: expect.stringContaining(`/${t.name}.git`), token: expect.stringMatching(/^art_v1_/) });
    expect(r.token).toMatch(/^art_v1_/);
    expect((await okCall(c, "ryke_status", { txn: b.txn })).txn).toMatchObject({ state: "open", attempt: 2, snapshot: lander.sha, head: null });
    // The new attempt reads the new snapshot.
    expect((await okCall(c, "ryke_read", { txn: b.txn, path: "src/format.ts" })).content).toBe("export const digits = 3;\n");
  });

  it("retries a failed transaction and returns its failures", async () => {
    const t = await newRepo();
    const { b, sha } = await pushed(t, { "src/x.ts": "x\n" });
    await http("POST", `/api/txns/${b.txn}/submit`, { body: { head: sha } });
    const train = ok(await t.L.formTrain()).train!;
    ok(await t.L.trainOutcome(train, b.txn, "failed", "tests", { failures: [{ name: "t1", message: "no" }] }));
    ok(await t.L.trainDone(train, "failed"));
    const r = await okCall(await McpClient.connect(), "ryke_retry", { txn: b.txn });
    expect(r).toMatchObject({ attempt: 2, delta: [], failures: [{ name: "t1", message: "no" }] });
  });

  it("is 409 for a transaction that is not stale or failed, and leaves it as it was", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const open = await apiBegin(t.name);
    const out = await c.call("ryke_retry", { txn: open.txn });
    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({ status: 409, error: expect.stringContaining("only stale or failed") });
    expect((await txnOf(open.txn)).txn).toMatchObject({ state: "open", attempt: 1 });
  });

  it("is 404 for an unknown transaction and refuses a missing txn", async () => {
    const c = await McpClient.connect();
    expect((await c.call("ryke_retry", { txn: "t_nope" })).json).toEqual({ error: "unknown transaction t_nope", status: 404 });
    const none = await c.call("ryke_retry", {});
    expect(none.isError).toBe(true);
    expect(none.text).toContain("txn");
  });
});

describe("ryke_abort", () => {
  it("gives up the transaction and keeps the reason", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    expect(await okCall(await McpClient.connect(), "ryke_abort", { txn: b.txn, reason: "changed my mind" })).toEqual({ state: "aborted" });
    expect((await txnOf(b.txn)).txn).toMatchObject({ state: "aborted", reason: "changed my mind" });
    expect((await http("GET", `/api/repos/${t.name}`)).body.inflight).toEqual([]);
  });

  it("falls back to agent_abort for an empty reason", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    await okCall(await McpClient.connect(), "ryke_abort", { txn: b.txn, reason: "" });
    expect((await txnOf(b.txn)).txn.reason).toBe("agent_abort");
  });

  it("is 409 for a transaction that is already aborted", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const b = await apiBegin(t.name);
    await okCall(c, "ryke_abort", { txn: b.txn, reason: "once" });
    const again = await c.call("ryke_abort", { txn: b.txn, reason: "twice" });
    expect(again.isError).toBe(true);
    expect(again.json).toMatchObject({ status: 409, error: expect.stringContaining("aborted") });
    expect((await txnOf(b.txn)).txn.reason).toBe("once");
  });

  it("is 409 while the transaction is verifying in a train", async () => {
    const t = await newRepo();
    const { b, sha } = await pushed(t, { "src/x.ts": "x\n" });
    await http("POST", `/api/txns/${b.txn}/submit`, { body: { head: sha } });
    const train = ok(await t.L.formTrain()).train!;
    const out = await (await McpClient.connect()).call("ryke_abort", { txn: b.txn, reason: "x" });
    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({ status: 409, error: expect.stringContaining(`verifying in train ${train}`) });
    expect((await txnOf(b.txn)).txn.state).toBe("verifying");
  });

  it("is 404 for an unknown transaction", async () => {
    const out = await (await McpClient.connect()).call("ryke_abort", { txn: "t_nope", reason: "x" });
    expect(out.isError).toBe(true);
    expect(out.json).toEqual({ error: "unknown transaction t_nope", status: 404 });
  });

  it.each([
    ["no reason", { txn: "t_x" }, "reason"],
    ["a numeric reason", { txn: "t_x", reason: 42 }, "reason"],
    ["no txn", { reason: "x" }, "txn"],
  ])("refuses %s before it reaches the Ledger", async (_label, args, word) => {
    const out = await (await McpClient.connect()).call("ryke_abort", args);
    expect(out.isError).toBe(true);
    expect(out.json).toBeNull();
    expect(out.text).toContain(word);
  });
});

describe("every transaction tool", () => {
  const withTxn: [string, Record<string, unknown>][] = [
    ["ryke_read", { path: "src/a.ts" }],
    ["ryke_reads", { paths: ["src/a.ts"] }],
    ["ryke_submit", {}],
    ["ryke_status", {}],
    ["ryke_wait", { timeoutSeconds: 0 }],
    ["ryke_retry", {}],
    ["ryke_abort", { reason: "x" }],
  ];

  it.each(withTxn)("%s names the unknown transaction in a 404", async (name, rest) => {
    const out = await (await McpClient.connect()).call(name, { txn: "t_doesnotexist", ...rest });
    expect(out.isError).toBe(true);
    expect(out.json).toEqual({ error: "unknown transaction t_doesnotexist", status: 404 });
  });

  it.each(withTxn)("%s refuses a call without txn", async (name, rest) => {
    const out = await (await McpClient.connect()).call(name, rest);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("txn");
  });

  it("works for transactions opened over HTTP and over MCP alike, in one repo", async () => {
    const t = await newRepo();
    const c = await McpClient.connect();
    const viaHttp = await apiBegin(t.name);
    const viaMcp = await okCall(c, "ryke_begin", { repo: t.name, agent: "a", intent: Math.random().toString(36).slice(2, 14) });
    for (const id of [viaHttp.txn, viaMcp.txn]) expect((await okCall(c, "ryke_status", { txn: id })).txn.state).toBe("open");
    expect((await okCall(c, "ryke_repo", { repo: t.name })).counts).toEqual({ open: 2 });
  });
});
