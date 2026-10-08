// The HTTP API (PLAN.md §6.1) through the Worker's own fetch: every route's success, 401 without the
// bearer token, 404 for unknown ids, 409 for wrong states and 422 for invalid input.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PushEvent } from "../src/shared/types";
import type { Context } from "hono";
import { api, authorized, respond } from "../src/worker/api";
import { ledger } from "../src/worker/service";
import { apiBegin, AUTH, commitToFork, fixture, http, landOnTrunk, lazy, newRepo, ok, opsOf, store, unique, type Json, type TestRepo } from "./helpers";

const SHA = /^[0-9a-f]{40}$/;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const post = (path: string, body: unknown = {}, opts: { auth?: boolean | string } = {}) => http("POST", path, { body, ...opts });
const txnState = async (id: string) => (await http("GET", `/api/txns/${id}`)).body.txn.state as string;

// A transaction that read `reads`, pushed `files` to its fork and was submitted over HTTP.
async function submitted(t: TestRepo, files: Record<string, string | null>, reads: string[] = ["src/a.ts"], agent = "agent-01") {
  const b = await apiBegin(t.name, agent);
  if (reads.length) expect((await post(`/api/txns/${b.txn}/reads`, { paths: reads })).status).toBe(200);
  const sha = await commitToFork(b, files);
  const s = await post(`/api/txns/${b.txn}/submit`, { head: sha });
  return { b, sha, s };
}

// An open transaction that read src/format.ts, which another transaction then landed, submitted: stale.
async function staleTxn(t: TestRepo) {
  const b = await apiBegin(t.name, "agent-b");
  const lander = await landOnTrunk(t, { "src/format.ts": "export const digits = 3;\n" }, "agent-a");
  expect((await post(`/api/txns/${b.txn}/reads`, { paths: ["src/format.ts"] })).status).toBe(200);
  const sha = await commitToFork(b, { "test/rounding.test.ts": "// expects 2 digits\n" });
  const s = await post(`/api/txns/${b.txn}/submit`, { head: sha });
  expect(s.body.state).toBe("stale");
  return { b, lander, sha };
}

async function needsHuman() {
  const t = await newRepo();
  const h = await submitted(t, { "src/p.ts": "p\n" });
  expect(h.s.body.state).toBe("ready");
  const train = ok(await t.L.formTrain()).train!;
  ok(await t.L.trainOutcome(train, h.b.txn, "needs_human", "human_path"));
  ok(await t.L.trainDone(train, "landed"));
  return { t, id: h.b.txn };
}

const pushEvent = (repoName: string, after: string, ref = "refs/heads/main"): PushEvent => ({
  type: "cf.artifacts.repo.pushed",
  source: { type: "artifacts.repo", namespace: "ryke", repoName },
  payload: { ref, before: "0".repeat(40), after, commits: [], totalCommitsCount: 1, commitsTruncated: false },
  metadata: { eventTimestamp: new Date().toISOString() },
});

const internal = (body: unknown, secret: string | null = env.RYKE_INTERNAL_SECRET) =>
  http("POST", "/internal/events", { body, auth: false, headers: secret === null ? {} : { "x-ryke-internal": secret } });

describe("authentication and routing", () => {
  it("answers health to anyone", async () => {
    const r = await http("GET", "/api/health", { auth: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  const writes: [string, string][] = [
    ["POST", "/api/repos"],
    ["DELETE", "/api/repos/some-repo"],
    ["POST", "/api/repos/some-repo/txns"],
    ["POST", "/api/txns/t_x/reads"],
    ["POST", "/api/txns/t_x/intend-write"],
    ["POST", "/api/txns/t_x/submit"],
    ["POST", "/api/txns/t_x/retry"],
    ["POST", "/api/txns/t_x/abort"],
    ["POST", "/api/txns/t_x/approve"],
    ["POST", "/api/txns/t_x/reject"],
  ];

  // Without a header, with a wrong token, and with the right token in the wrong shape: the bearer
  // check is exact, so none of these reaches a handler.
  const credentials: [string, boolean | string][] = [
    ["no header", false],
    ["wrong token", "Bearer not-the-token"],
    ["token without scheme", env.RYKE_TOKEN],
    ["basic scheme", `Basic ${env.RYKE_TOKEN}`],
    ["lower-case scheme", `bearer ${env.RYKE_TOKEN}`],
    ["token with a character appended", `Bearer ${env.RYKE_TOKEN}x`],
    ["empty bearer", "Bearer "],
  ];

  describe.each(writes)("%s %s", (method, path) => {
    it.each(credentials)("is 401 with %s", async (_label, auth) => {
      const r = await http(method, path, { body: method === "DELETE" ? undefined : {}, auth });
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: "unauthorized" });
    });
  });

  it("changes nothing when a write is refused", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    expect((await post(`/api/txns/${b.txn}/abort`, { reason: "x" }, { auth: false })).status).toBe(401);
    expect(await txnState(b.txn)).toBe("open");
    expect((await http("DELETE", `/api/repos/${t.name}`, { auth: false })).status).toBe(401);
    expect((await http("GET", `/api/repos/${t.name}`)).status).toBe(200);
  });

  it("keeps every read public", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const reads = [
      `/api/repos/${t.name}`,
      `/api/repos/${t.name}/ops`,
      `/api/repos/${t.name}/files`,
      `/api/repos/${t.name}/files?path=src/a.ts`,
      `/api/txns/${b.txn}`,
      `/api/txns/${b.txn}/wait?timeout=0`,
    ];
    for (const path of reads) expect((await http("GET", path, { auth: false })).status, path).toBe(200);
  });

  // `authorized` is what /api and /mcp share; an unset token must never match, even the header "Bearer ".
  it.each([
    ["exact match", "secret", "Bearer secret", true],
    ["wrong token", "secret", "Bearer other", false],
    ["no header", "secret", undefined, false],
    ["prefix of the token", "secret", "Bearer secre", false],
    ["token is a prefix of the header", "secret", "Bearer secrets", false],
    ["unset token and empty bearer", "", "Bearer ", false],
    ["unset token and no header", "", undefined, false],
    ["unset token and some bearer", "", "Bearer x", false],
  ] as const)("authorized(): %s", (_label, token, header, expected) => {
    expect(authorized({ RYKE_TOKEN: token } as Env, header)).toBe(expected);
  });

  it("answers 404 for an unknown route under /api", async () => {
    expect((await http("GET", "/api/does-not-exist")).status).toBe(404);
    expect((await http("GET", "/api/txns/t_x/does-not-exist")).status).toBe(404);
    expect((await http("GET", "/api/repos/x/nothing/here")).status).toBe(404);
    expect((await post("/api/does-not-exist")).status).toBe(404);
    expect((await http("PUT", "/api/repos/x")).status).toBe(404);
  });

  it("checks the token before the route exists, so an unknown write route is 401 without it", async () => {
    expect((await post("/api/does-not-exist", {}, { auth: false })).status).toBe(401);
  });
});

describe("POST /api/repos and DELETE /api/repos/:repo", () => {
  it("creates a seeded trunk, initialises the ledger and answers 201 with the head", async () => {
    const name = unique("api");
    const r = await post("/api/repos", { name });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ repo: name, head: expect.stringMatching(SHA) });
    expect((await store.info(name)).head).toBe(r.body.head);
    const s = await http("GET", `/api/repos/${name}`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ repo: name, head: r.body.head, seq: 0, counts: {}, inflight: [], heat: [], train: null });
    // The policy in the seed's ryke.json reaches the ledger, whatever the default seed protects.
    expect(s.body.policy.protected).toContain("ryke.json");
    expect(s.body.policy.protected).not.toContain("test/**");
    expect((await http("GET", `/api/repos/${name}/files`)).body.files).toEqual(expect.arrayContaining(["ryke.json"]));
  });

  it("seeds the trunk from a directory under demo/", async () => {
    const name = unique("api");
    const r = await post("/api/repos", { name, seedFrom: "convert" });
    expect(r.status).toBe(201);
    const files = (await http("GET", `/api/repos/${name}/files`)).body.files as string[];
    expect(files).toContain("ryke.json");
    expect(files.length).toBeGreaterThan(2);
    // The demo's own policy, not the default one, is what the ledger enforces.
    expect((await http("GET", `/api/repos/${name}`)).body.policy.protected).toContain("test/**");
  });

  it("is 409 for a name that exists and leaves the first repo intact", async () => {
    const name = unique("api");
    const first = await post("/api/repos", { name });
    const second = await post("/api/repos", { name });
    expect(second.status).toBe(409);
    expect(second.body.error).toEqual(expect.any(String));
    expect((await http("GET", `/api/repos/${name}`)).body.head).toBe(first.body.head);
  });

  it.each([
    ["missing", {}],
    ["empty", { name: "" }],
    ["upper case", { name: "Repo" }],
    ["leading hyphen", { name: "-repo" }],
    ["underscore", { name: "re_po" }],
    ["slash", { name: "a/b" }],
    ["space", { name: "re po" }],
    ["too long (42 characters)", { name: "a".repeat(42) }],
    ["a number", { name: 7 }],
    ["null", { name: null }],
    ["the reserved index name", { name: "__index" }],
  ])("is 422 for a bad name: %s", async (_label, body) => {
    const r = await post("/api/repos", body);
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("name");
  });

  // fresh: true keeps the fixed names usable if a store outlives one run.
  it.each([["a single character", "q"], ["41 characters", unique("m").padEnd(41, "z")], ["digits first", `9${unique("l")}`]])("accepts %s as a name", async (_label, name) => {
    const r = await post("/api/repos", { name, fresh: true });
    expect(r.status).toBe(201);
    expect(r.body.repo).toBe(name);
  });

  it.each([
    ["a number", 5],
    ["upper case", "Convert"],
    ["a path", "../convert"],
    ["a slash", "a/b"],
    ["an empty string", ""],
    ["null", null],
  ])("is 422 for seedFrom %s, before anything is created", async (_label, seedFrom) => {
    const name = unique("api");
    const r = await post("/api/repos", { name, seedFrom });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("seedFrom");
    expect((await http("GET", `/api/repos/${name}`)).status).toBe(404);
    await expect(store.info(name)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is 422 for a seed directory that does not exist and removes the half-made repo", async () => {
    const name = unique("api");
    const r = await post("/api/repos", { name, seedFrom: "no-such-demo" });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("seeding failed");
    await expect(store.info(name)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The name is free again.
    expect((await post("/api/repos", { name })).status).toBe(201);
  });

  it.each([
    ["an array", "[]"],
    ["a string", '"repo"'],
    ["a number", "5"],
    ["null", "null"],
    ["invalid JSON", "{"],
  ])("is 422 for a body that is %s", async (_label, raw) => {
    const r = await http("POST", "/api/repos", { raw });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: "body must be a JSON object" });
  });

  it("treats an empty body as no name", async () => {
    const r = await http("POST", "/api/repos", { raw: "" });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("name");
  });

  it("recreates an existing repo with fresh: true, dropping its transactions", async () => {
    const name = unique("api");
    expect((await post("/api/repos", { name })).status).toBe(201);
    const b = await apiBegin(name);
    expect((await http("GET", `/api/txns/${b.txn}`)).status).toBe(200);
    expect((await http("GET", `/api/repos/${name}`)).body.counts).toEqual({ open: 1 });
    const again = await post("/api/repos", { name, fresh: true });
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ repo: name, head: expect.stringMatching(SHA) });
    const s = await http("GET", `/api/repos/${name}`);
    expect(s.body).toMatchObject({ seq: 0, counts: {}, inflight: [] });
    expect((await http("GET", `/api/txns/${b.txn}`)).status).toBe(404);
  });

  it("creates the repo when fresh: true names one that does not exist", async () => {
    const name = unique("api");
    const r = await post("/api/repos", { name, fresh: true });
    expect(r.status).toBe(201);
    expect((await http("GET", `/api/repos/${name}`)).status).toBe(200);
  });

  it("ignores fresh unless it is exactly true", async () => {
    const name = unique("api");
    expect((await post("/api/repos", { name })).status).toBe(201);
    for (const fresh of ["true", 1, false, null]) expect((await post("/api/repos", { name, fresh })).status).toBe(409);
  });

  it("deletes a repo with its ledger, and again is a no-op", async () => {
    const name = unique("api");
    expect((await post("/api/repos", { name })).status).toBe(201);
    const b = await apiBegin(name);
    const del = await http("DELETE", `/api/repos/${name}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
    expect((await http("GET", `/api/repos/${name}`)).status).toBe(404);
    expect((await http("GET", `/api/txns/${b.txn}`)).status).toBe(404);
    await expect(store.info(name)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const again = await http("DELETE", `/api/repos/${name}`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ deleted: false });
  });

  it("deletes a repo that was never created without an error", async () => {
    const r = await http("DELETE", `/api/repos/${unique("never")}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: false });
  });
});

describe("respond", () => {
  const capture = () => {
    const out: [unknown, number][] = [];
    const c = { json: (body: unknown, status: number) => (out.push([body, status]), new Response()) } as unknown as Context<{ Bindings: Env }>;
    return { c, out };
  };

  it.each([
    ["a value with the default status", { ok: true, value: { a: 1 } }, undefined, [{ a: 1 }, 200]],
    ["a value with the status the route asks for", { ok: true, value: { a: 1 } }, 201, [{ a: 1 }, 201]],
    ["an error without detail", { ok: false, status: 409, error: "nope" }, undefined, [{ error: "nope" }, 409]],
    ["an error with detail", { ok: false, status: 422, error: "bad", detail: { path: "x" } }, 201, [{ error: "bad", detail: { path: "x" } }, 422]],
  ] as const)("answers %s", (_label, res, okStatus, expected) => {
    const { c, out } = capture();
    respond(c, res as never, okStatus);
    expect(out).toEqual([expected]);
  });
});

// The store sits behind every repo operation; when it fails the API says 503 rather than failing
// with an unhandled error. "Fails" is simulated by pointing the store URL at the git helper, which
// answers 404 without the store's error envelope, the way a broken or wrong upstream would. The
// ledger is a stub because the real one would need the store too.
describe("when the store fails", () => {
  const down = (stub: Record<string, unknown>) =>
    ({ RYKE_TOKEN: env.RYKE_TOKEN, RYKE_STORE: "local", RYKE_STORE_URL: env.RYKE_TEST_GIT_URL, LEDGER: { idFromName: (n: string) => n, get: () => stub } }) as unknown as Env;
  const call = (path: string, init: RequestInit, stub: Record<string, unknown> = {}) =>
    api.fetch(new Request(`http://ryke.test${path}`, { ...init, headers: { ...AUTH, "content-type": "application/json" } }), down(stub));

  it("is 503 for POST /api/repos", async () => {
    const res = await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "anything" }) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as Json).error).toContain("store answered 404");
  });

  it("is 503 for DELETE /api/repos/:repo, after the ledger was reset", async () => {
    let resets = 0;
    const res = await call("/api/repos/anything", { method: "DELETE" }, { reset: async () => (resets++, { ok: true, value: { reset: true } }) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as Json).error).toContain("store answered 404");
    expect(resets).toBe(1);
  });

  it("is 503 for GET /api/repos/:repo/files, listing or reading", async () => {
    const summary = async () => ({ ok: true, value: { head: "a".repeat(40) } });
    for (const query of ["", "?path=src/a.ts"]) {
      const res = await call(`/api/repos/anything/files${query}`, { method: "GET" }, { summary });
      expect(res.status, query).toBe(503);
      expect(((await res.json()) as Json).error, query).toContain("store answered 404");
    }
  });
});

describe("GET /api/repos/:repo", () => {
  it("summarises the trunk, counts, in-flight footprints and heat", async () => {
    const t = await newRepo();
    const s0 = await http("GET", `/api/repos/${t.name}`);
    expect(s0.status).toBe(200);
    expect(s0.body).toEqual({
      repo: t.name,
      head: t.head,
      seq: 0,
      policy: expect.objectContaining({ protected: ["test/**", "ryke.json"], union: ["src/registry.ts", "CHANGELOG.md"], verify: "true", trainMax: 4 }),
      counts: {},
      inflight: [],
      heat: [],
      train: null,
    });
    const b = await apiBegin(t.name, "agent-s", "add s");
    await post(`/api/txns/${b.txn}/reads`, { paths: ["src/b.ts", "src/a.ts"] });
    const s1 = await http("GET", `/api/repos/${t.name}`);
    expect(s1.body.counts).toEqual({ open: 1 });
    expect(s1.body.inflight).toEqual([{ txn: b.txn, agent: "agent-s", intent: "add s", state: "open", footprint: ["src/a.ts", "src/b.ts"] }]);
  });

  it("is 404 for a repo that was never initialised", async () => {
    const r = await http("GET", `/api/repos/${unique("never")}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "repo is not initialised" });
  });
});

describe("POST /api/repos/:repo/txns", () => {
  // No test in this block that uses it opens a transaction here, so its counts stay empty.
  const untouched = lazy(() => newRepo());

  it("opens a transaction on a fresh fork and answers 201", async () => {
    const t = await newRepo();
    const r = await post(`/api/repos/${t.name}/txns`, { agent: "agent-07", intent: "add a unit", model: "m-1", criteria: ["shows the unit"] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: "open", attempt: 1, snapshot: t.head, warnings: [] });
    expect(r.body.txn).toMatch(/^t_[0-9a-z]+$/);
    expect(r.body.remote).toMatch(new RegExp(`/${t.name}--${r.body.txn}\\.git$`));
    expect(r.body.token).toMatch(/^art_v1_/);
    expect(r.body.trunk.remote).toMatch(new RegExp(`/${t.name}\\.git$`));
    expect(r.body.trunk.token).toMatch(/^art_v1_/);
    expect(r.body.policy.protected).toContain("test/**");
    expect((await store.info(`${t.name}--${r.body.txn}`)).head).toBe(t.head);
    const d = await http("GET", `/api/txns/${r.body.txn}`);
    expect(d.body.txn).toMatchObject({ agent: "agent-07", model: "m-1", intent: "add a unit", criteria: ["shows the unit"], repo: t.name });
  });

  it("returns the judge's warnings about similar work already in flight", async () => {
    // The judge answers "unsure" in tests (no recorded fixture for these texts), which still warns.
    const t = await newRepo();
    const first = await apiBegin(t.name, "agent-1", "add a velocity converter to the tiles page");
    const second = await post(`/api/repos/${t.name}/txns`, { agent: "agent-2", intent: "add a velocity converter to the home page" });
    expect(second.status).toBe(201);
    expect(second.body.state).toBe("open");
    expect(second.body.warnings.length).toBeGreaterThan(0);
    for (const w of second.body.warnings) expect(w).toMatchObject({ other: first.txn, intent: "add a velocity converter to the tiles page" });
    const kinds = (await opsOf(t)).filter((o) => o.txn === second.body.txn).map((o) => o.kind);
    for (const w of second.body.warnings) expect(kinds).toContain(w.kind === "duplicate" ? "dup.warning" : "conflict.warning");
  });

  it("answers 409 when begin rejects the intent as a duplicate", async () => {
    // Producing a real duplicate needs a recorded judge answer, so this drives the route with a
    // ledger stub that returns what Ledger.begin returns for a rejection.
    const rejected = {
      txn: "t_dup",
      state: "rejected",
      reason: "duplicate_of:t_other",
      attempt: 1,
      snapshot: "a".repeat(40),
      remote: "",
      token: "",
      trunk: { remote: "http://store/x.git", token: "art_v1_x" },
      policy: {},
      warnings: [{ kind: "duplicate", other: "t_other", intent: "same", footprint: [], value: 0.9 }],
    };
    const calls: string[] = [];
    const stub = {
      screenCandidates: async () => ({ ok: true, value: [] }),
      begin: async () => ({ ok: true, value: rejected }),
      indexPut: async (txn: string) => void calls.push(txn),
    };
    const ns = { idFromName: (n: string) => n, get: () => stub };
    const fake = { RYKE_TOKEN: env.RYKE_TOKEN, LEDGER: ns } as unknown as Env;
    const res = await api.fetch(
      new Request("http://ryke.test/api/repos/any/txns", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ agent: "a", intent: "same" }) }),
      fake,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(rejected);
    expect(calls).toEqual(["t_dup"]);
  });

  it("opens independent transactions with distinct ids and forks", async () => {
    const t = await newRepo();
    const [a, b] = await Promise.all([apiBegin(t.name, "a"), apiBegin(t.name, "b")]);
    expect(a.txn).not.toBe(b.txn);
    expect(a.remote).not.toBe(b.remote);
    expect((await http("GET", `/api/repos/${t.name}`)).body.counts).toEqual({ open: 2 });
  });

  it.each([
    ["no agent", { intent: "x" }, "agent"],
    ["a blank agent", { agent: "  ", intent: "x" }, "agent"],
    ["a numeric agent", { agent: 4, intent: "x" }, "agent"],
    ["no intent", { agent: "a" }, "intent"],
    ["a numeric intent", { agent: "a", intent: 5 }, "intent"],
    ["a blank intent", { agent: "a", intent: "" }, "intent"],
    ["criteria that is not a list", { agent: "a", intent: "x", criteria: "nope" }, "criteria"],
    ["criteria with a non-string", { agent: "a", intent: "x", criteria: ["ok", 3] }, "criteria"],
    ["a numeric model", { agent: "a", intent: "x", model: 3 }, "model"],
    ["an empty object", {}, "agent"],
  ])("is 422 for %s", async (_label, body, word) => {
    const t = await untouched();
    const r = await post(`/api/repos/${t.name}/txns`, body);
    expect(r.status).toBe(422);
    expect(r.body.error).toContain(word);
    expect((await http("GET", `/api/repos/${t.name}`)).body.counts).toEqual({});
  });

  it.each([["an array", "[]"], ["a string", '"x"'], ["invalid JSON", "{"]])("is 422 for a body that is %s", async (_label, raw) => {
    const t = await untouched();
    const r = await http("POST", `/api/repos/${t.name}/txns`, { raw });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: "body must be a JSON object" });
  });

  it("is 404 for a repo that was never initialised", async () => {
    const r = await post(`/api/repos/${unique("never")}/txns`, { agent: "a", intent: "x" });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "repo is not initialised" });
  });
});

describe("POST /api/txns/:id/reads", () => {
  // Refused batches record nothing, so one open transaction serves every row of the 422 table.
  const refused = lazy(async () => apiBegin((await newRepo()).name));

  it("records a batch, normalises paths and reports reads that are already stale", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const lander = await landOnTrunk(t, { "src/a.ts": "export const a = 3;\n" });
    const r = await post(`/api/txns/${b.txn}/reads`, { paths: ["./src/a.ts", "src\\format.ts", "src/a.ts"] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recorded: 2, staleWarnings: [{ path: "src/a.ts", seq: 1, by: lander.txn }] });
    expect((await http("GET", `/api/txns/${b.txn}`)).body.attempts[0].reads).toEqual(["src/a.ts", "src/format.ts"]);
  });

  it("accepts an empty batch and the 500-path maximum", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    expect((await post(`/api/txns/${b.txn}/reads`, { paths: [] })).body).toEqual({ recorded: 0, staleWarnings: [] });
    const many = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`);
    expect((await post(`/api/txns/${b.txn}/reads`, { paths: many })).body.recorded).toBe(500);
  });

  it.each([
    ["no paths", {}],
    ["paths that is a string", { paths: "src/a.ts" }],
    ["paths with a non-string", { paths: ["src/a.ts", 1] }],
    ["a path that escapes the repo", { paths: ["../x"] }],
    ["an empty path", { paths: [""] }],
    ["501 paths", { paths: Array.from({ length: 501 }, (_, i) => `f${i}`) }],
  ])("is 422 for %s", async (_label, body) => {
    const b = await refused();
    const r = await post(`/api/txns/${b.txn}/reads`, body);
    expect(r.status).toBe(422);
    expect(r.body.error).toEqual(expect.any(String));
    expect((await http("GET", `/api/txns/${b.txn}`)).body.attempts[0].reads).toEqual([]);
  });

  it("is 409 once the transaction left open, and the read set stays as it was", async () => {
    const t = await newRepo();
    const { b, s } = await submitted(t, { "src/x.ts": "x\n" });
    expect(s.body.state).toBe("ready");
    const r = await post(`/api/txns/${b.txn}/reads`, { paths: ["src/b.ts"] });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("ready");
    expect((await http("GET", `/api/txns/${b.txn}`)).body.attempts[0].reads).toEqual(["src/a.ts"]);
  });
});

describe("POST /api/txns/:id/intend-write", () => {
  const refused = lazy(async () => apiBegin((await newRepo()).name));

  it("grants a cool file and renews the lease for the same transaction", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const first = await post(`/api/txns/${b.txn}/intend-write`, { path: "src/a.ts" });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ go: true });
    expect((await post(`/api/txns/${b.txn}/intend-write`, { path: "./src/a.ts" })).body).toEqual({ go: true });
    expect((await opsOf(t, "lease.granted")).filter((o) => o.txn === b.txn)).toHaveLength(1);
  });

  it("lets two transactions write the same cool file", async () => {
    const t = await newRepo();
    const [one, two] = [await apiBegin(t.name, "one"), await apiBegin(t.name, "two")];
    expect((await post(`/api/txns/${one.txn}/intend-write`, { path: "src/a.ts" })).body).toEqual({ go: true });
    expect((await post(`/api/txns/${two.txn}/intend-write`, { path: "src/a.ts" })).body).toEqual({ go: true });
  });

  it.each([
    ["no path", {}],
    ["a numeric path", { path: 5 }],
    ["a list of paths", { path: ["src/a.ts"] }],
    ["a path that escapes the repo", { path: "../x" }],
    ["an empty path", { path: "" }],
  ])("is 422 for %s", async (_label, body) => {
    const b = await refused();
    const r = await post(`/api/txns/${b.txn}/intend-write`, body);
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("path");
  });

  it("is 409 once the transaction left open", async () => {
    const t = await newRepo();
    const { b } = await submitted(t, { "src/x.ts": "x\n" });
    const r = await post(`/api/txns/${b.txn}/intend-write`, { path: "src/x.ts" });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("open");
  });
});

describe("POST /api/txns/:id/submit", () => {
  // A refused submit leaves the transaction open, so one transaction serves every row of the 422 table.
  const refused = lazy(async () => apiBegin((await newRepo()).name));

  it("moves a clean change to ready and records the writes", async () => {
    const t = await newRepo();
    const { b, sha, s } = await submitted(t, { "src/new.ts": "export const n = 1;\n" });
    expect(s.status).toBe(200);
    expect(s.body).toEqual({ state: "ready" });
    const d = await http("GET", `/api/txns/${b.txn}`);
    expect(d.body.txn).toMatchObject({ state: "ready", head: sha });
    expect(d.body.attempts[0]).toEqual({ attempt: 1, reads: ["src/a.ts"], writes: ["src/new.ts"] });
    expect(d.body.ops.map((o: Json) => o.kind)).toEqual(["txn.open", "txn.submitted", "txn.ready"]);
  });

  it("finds the head through the store when the body names none", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    expect((await post(`/api/txns/${b.txn}/submit`)).body).toEqual({ state: "ready" });
    expect((await http("GET", `/api/txns/${b.txn}`)).body.txn.head).toBe(sha);
  });

  it("answers a repeated submit with the current state and no new ops", async () => {
    const t = await newRepo();
    const { b, sha } = await submitted(t, { "src/x.ts": "x\n" });
    const before = (await http("GET", `/api/txns/${b.txn}`)).body.ops.length;
    expect((await post(`/api/txns/${b.txn}/submit`, { head: sha })).body).toMatchObject({ state: "ready" });
    expect((await post(`/api/txns/${b.txn}/submit`)).body).toMatchObject({ state: "ready" });
    expect((await http("GET", `/api/txns/${b.txn}`)).body.ops).toHaveLength(before);
  });

  it("stores the agent's evidence", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    await post(`/api/txns/${b.txn}/reads`, { paths: ["src/a.ts"] });
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    const r = await post(`/api/txns/${b.txn}/submit`, { head: sha, evidence: { summary: "added x", screenshot: "page shows x" } });
    expect(r.body.state).toBe("ready");
    expect((await http("GET", `/api/txns/${b.txn}`)).body.evidence).toEqual([
      { attempt: 1, kind: "log", summary: "added x", ref: "agent" },
      { attempt: 1, kind: "screenshot", summary: "page shows x", ref: "agent" },
    ]);
  });

  it("rejects an empty change with 200 and reason empty", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const r = await post(`/api/txns/${b.txn}/submit`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ state: "rejected", reason: "empty" });
    expect(await txnState(b.txn)).toBe("rejected");
  });

  it("rejects a change to a protected file but allows a new file under a protected directory", async () => {
    const t = await newRepo();
    const bad = await submitted(t, { "test/a.test.ts": "// tampered\n" });
    expect(bad.s.status).toBe(200);
    expect(bad.s.body).toEqual({ state: "rejected", reason: "protected", paths: ["test/a.test.ts"] });
    const fine = await submitted(t, { "test/new.test.ts": "// new\n" });
    expect(fine.s.body).toEqual({ state: "ready" });
  });

  it("answers stale with the paths that changed and who changed them", async () => {
    const t = await newRepo();
    const { b, lander } = await staleTxn(t);
    const d = await http("GET", `/api/txns/${b.txn}`);
    expect(d.body.txn).toMatchObject({ state: "stale", reason: "stale_read" });
    expect(d.body.detail.stale).toEqual([{ path: "src/format.ts", seq: 1, by: lander.txn }]);
  });

  it("answers stale for a repeated submit without new ops", async () => {
    const t = await newRepo();
    const { b, sha } = await staleTxn(t);
    const before = (await http("GET", `/api/txns/${b.txn}`)).body.ops.length;
    const again = await post(`/api/txns/${b.txn}/submit`, { head: sha });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ state: "stale", reason: "stale_read" });
    expect((await http("GET", `/api/txns/${b.txn}`)).body.ops).toHaveLength(before);
  });

  it.each([
    ["a head that is not a sha", { head: "nope" }, "head"],
    ["a numeric head", { head: 7 }, "head"],
    ["a short sha", { head: "abc123" }, "head"],
    ["an upper-case sha", { head: "A".repeat(40) }, "head"],
    ["evidence that is a string", { evidence: "x" }, "evidence"],
    ["evidence.summary that is a number", { evidence: { summary: 3 } }, "summary"],
    ["evidence.screenshot that is a boolean", { evidence: { screenshot: false } }, "screenshot"],
    ["a head that is not in the fork", { head: "c".repeat(40) }, "not in fork"],
  ])("is 422 for %s", async (_label, body, word) => {
    const b = await refused();
    const r = await post(`/api/txns/${b.txn}/submit`, body);
    expect(r.status).toBe(422);
    expect(r.body.error).toContain(word);
    expect(await txnState(b.txn)).toBe("open");
  });

  it("is 409 for an aborted transaction and for a different head after submitting", async () => {
    const t = await newRepo();
    const aborted = await apiBegin(t.name);
    await post(`/api/txns/${aborted.txn}/abort`, { reason: "x" });
    const a = await post(`/api/txns/${aborted.txn}/submit`);
    expect(a.status).toBe(409);
    expect(a.body.error).toContain("aborted");
    const { b } = await submitted(t, { "src/x.ts": "x\n" });
    const other = await post(`/api/txns/${b.txn}/submit`, { head: "b".repeat(40) });
    expect(other.status).toBe(409);
    expect(await txnState(b.txn)).toBe("ready");
  });
});

describe("POST /api/txns/:id/retry", () => {
  it("opens a new attempt on the current trunk and hands over the delta of the stale paths", async () => {
    const t = await newRepo();
    const { b, lander } = await staleTxn(t);
    const r = await post(`/api/txns/${b.txn}/retry`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ snapshot: lander.sha, attempt: 2, failures: null });
    expect(r.body.delta).toEqual([{ path: "src/format.ts", patch: expect.stringContaining("-export const digits = 2;\n+export const digits = 3;") }]);
    expect(r.body.trunk).toEqual({ remote: expect.stringContaining(`/${t.name}.git`), token: expect.stringMatching(/^art_v1_/) });
    expect(r.body.remote).toBe(b.remote);
    expect(r.body.token).toMatch(/^art_v1_/);
    const d = await http("GET", `/api/txns/${b.txn}`);
    expect(d.body.txn).toMatchObject({ state: "open", attempt: 2, snapshot: lander.sha, snapshotSeq: 1, head: null, reason: null });
    expect(d.body.delta).toEqual([]);
  });

  it("retries a failed transaction and returns the failures", async () => {
    const t = await newRepo();
    const { b } = await submitted(t, { "src/x.ts": "x\n" });
    const train = ok(await t.L.formTrain()).train!;
    ok(await t.L.trainOutcome(train, b.txn, "failed", "tests", { failures: [{ name: "t1", message: "no" }] }));
    ok(await t.L.trainDone(train, "failed"));
    expect(await txnState(b.txn)).toBe("failed");
    const r = await post(`/api/txns/${b.txn}/retry`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ attempt: 2, delta: [], failures: [{ name: "t1", message: "no" }] });
  });

  it.each([
    ["open", async () => ({ id: (await apiBegin((await newRepo()).name)).txn })],
    ["ready", async () => ({ id: (await submitted(await newRepo(), { "src/x.ts": "x\n" })).b.txn })],
    ["aborted", async () => {
      const b = await apiBegin((await newRepo()).name);
      await post(`/api/txns/${b.txn}/abort`, { reason: "x" });
      return { id: b.txn };
    }],
  ])("is 409 for a transaction that is %s", async (state, setup) => {
    const { id } = await setup();
    const r = await post(`/api/txns/${id}/retry`);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(state);
    expect(await txnState(id)).toBe(state);
  });
});

describe("POST /api/txns/:id/abort", () => {
  it("gives up an open transaction and keeps the reason", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const r = await post(`/api/txns/${b.txn}/abort`, { reason: "changed my mind" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ state: "aborted" });
    expect((await http("GET", `/api/txns/${b.txn}`)).body.txn).toMatchObject({ state: "aborted", reason: "changed my mind" });
    expect((await http("GET", `/api/repos/${t.name}`)).body.inflight).toEqual([]);
  });

  it.each([
    ["no reason", {}],
    ["an empty reason", { reason: "" }],
  ])("falls back to agent_abort for %s", async (_label, body) => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    expect((await post(`/api/txns/${b.txn}/abort`, body)).body).toEqual({ state: "aborted" });
    expect((await http("GET", `/api/txns/${b.txn}`)).body.txn.reason).toBe("agent_abort");
  });

  it("aborts from ready and from stale", async () => {
    const t = await newRepo();
    const { b } = await submitted(t, { "src/q.ts": "q\n" });
    expect((await post(`/api/txns/${b.txn}/abort`, { reason: "x" })).body).toEqual({ state: "aborted" });
    const stale = await staleTxn(t);
    expect((await post(`/api/txns/${stale.b.txn}/abort`, { reason: "x" })).body).toEqual({ state: "aborted" });
  });

  it("is 422 for a reason that is not a string", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const r = await post(`/api/txns/${b.txn}/abort`, { reason: 42 });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("reason");
    expect(await txnState(b.txn)).toBe("open");
  });

  it("is 409 for a transaction that is already aborted or rejected", async () => {
    const t = await newRepo();
    const aborted = await apiBegin(t.name);
    await post(`/api/txns/${aborted.txn}/abort`, { reason: "once" });
    const again = await post(`/api/txns/${aborted.txn}/abort`, { reason: "twice" });
    expect(again.status).toBe(409);
    expect((await http("GET", `/api/txns/${aborted.txn}`)).body.txn.reason).toBe("once");
    const rejected = await apiBegin(t.name);
    await post(`/api/txns/${rejected.txn}/submit`);
    expect((await post(`/api/txns/${rejected.txn}/abort`, { reason: "x" })).status).toBe(409);
  });

  it("is 409 while the transaction is verifying in a train", async () => {
    const t = await newRepo();
    const { b } = await submitted(t, { "src/x.ts": "x\n" });
    const train = ok(await t.L.formTrain()).train!;
    const r = await post(`/api/txns/${b.txn}/abort`, { reason: "x" });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(`verifying in train ${train}`);
    expect(await txnState(b.txn)).toBe("verifying");
  });
});

describe("POST /api/txns/:id/approve and /reject", () => {
  it("approve sends a needs_human transaction back through a train, flagged approved", async () => {
    const { id } = await needsHuman();
    expect(await txnState(id)).toBe("needs_human");
    const r = await post(`/api/txns/${id}/approve`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ state: "ready" });
    const d = await http("GET", `/api/txns/${id}`);
    expect(d.body.txn.state).toBe("ready");
    expect(d.body.detail.approved).toBe(true);
    expect((await post(`/api/txns/${id}/approve`)).status).toBe(409);
  });

  it("reject fails a needs_human transaction", async () => {
    const { id } = await needsHuman();
    const r = await post(`/api/txns/${id}/reject`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ state: "failed" });
    expect((await http("GET", `/api/txns/${id}`)).body.txn).toMatchObject({ state: "failed", reason: "rejected_by_human" });
    expect((await post(`/api/txns/${id}/reject`)).status).toBe(409);
    expect((await post(`/api/txns/${id}/approve`)).status).toBe(409);
  });

  it.each(["approve", "reject"])("%s is 409 for a transaction in any other state", async (action) => {
    const t = await newRepo();
    const open = await apiBegin(t.name);
    const r = await post(`/api/txns/${open.txn}/${action}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("needs_human");
    const { b } = await submitted(t, { "src/x.ts": "x\n" });
    expect((await post(`/api/txns/${b.txn}/${action}`)).status).toBe(409);
    expect(await txnState(b.txn)).toBe("ready");
  });
});

describe("unknown transactions and malformed bodies", () => {
  const ghost = "t_doesnotexist";
  const routes: [string, string, unknown][] = [
    ["GET", "", undefined],
    ["GET", "/wait?timeout=0", undefined],
    ["POST", "/reads", { paths: ["src/a.ts"] }],
    ["POST", "/intend-write", { path: "src/a.ts" }],
    ["POST", "/submit", {}],
    ["POST", "/retry", {}],
    ["POST", "/abort", { reason: "x" }],
    ["POST", "/approve", {}],
    ["POST", "/reject", {}],
  ];

  it.each(routes)("%s /api/txns/:id%s is 404 for an unknown transaction", async (method, suffix, body) => {
    const r = await http(method, `/api/txns/${ghost}${suffix}`, { body });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: `unknown transaction ${ghost}` });
  });

  it("matches transaction ids exactly", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    expect((await http("GET", `/api/txns/${b.txn}x`)).status).toBe(404);
    expect((await http("GET", `/api/txns/${b.txn.toUpperCase()}`)).status).toBe(404);
  });

  // The body is checked before the transaction is looked up, and a refused body changes nothing.
  it.each(["reads", "intend-write", "submit", "retry", "abort", "approve", "reject"])("POST /api/txns/:id/%s is 422 for a body that is not a JSON object", async (route) => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    for (const raw of ["[]", '"x"', "5", "null", "{"]) {
      const r = await http("POST", `/api/txns/${b.txn}/${route}`, { raw });
      expect(r.status, raw).toBe(422);
      expect(r.body, raw).toEqual({ error: "body must be a JSON object" });
    }
    expect(await txnState(b.txn)).toBe("open");
  });
});

describe("GET /api/txns/:id", () => {
  it("returns the full detail of an open transaction", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name, "agent-d", "do d", { criteria: ["c1"] });
    await post(`/api/txns/${b.txn}/reads`, { paths: ["src/a.ts"] });
    const r = await http("GET", `/api/txns/${b.txn}`, { auth: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      txn: {
        id: b.txn,
        repo: t.name,
        agent: "agent-d",
        model: "test-model",
        intent: "do d",
        criteria: ["c1"],
        state: "open",
        attempt: 1,
        snapshot: t.head,
        snapshotSeq: 0,
        fork: `${t.name}--${b.txn}`,
        head: null,
        train: null,
        landedSeq: null,
        reason: null,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        submittedAt: null,
      },
      detail: {},
      commit: null,
      attempts: [{ attempt: 1, reads: ["src/a.ts"], writes: [] }],
      verdicts: [],
      evidence: [],
      ops: [{ seq: expect.any(Number), at: expect.any(Number), kind: "txn.open", data: expect.objectContaining({ attempt: 1, snapshot: t.head, intent: "do d" }) }],
      delta: [],
      staleWarnings: [],
    });
  });

  it("includes the delta of the stale paths once the transaction is stale", async () => {
    const t = await newRepo();
    const { b, lander } = await staleTxn(t);
    const d = await http("GET", `/api/txns/${b.txn}`);
    expect(d.body.txn.state).toBe("stale");
    expect(d.body.delta).toEqual([{ path: "src/format.ts", patch: expect.stringContaining("-export const digits = 2;\n+export const digits = 3;") }]);
    expect(d.body.attempts[0]).toMatchObject({ reads: ["src/format.ts"], writes: ["test/rounding.test.ts"] });
    // Early warnings are for open transactions only; a stale one is past them.
    expect(d.body.staleWarnings).toEqual([]);
    expect(d.body.ops.map((o: Json) => o.kind)).toEqual(["txn.open", "txn.submitted", "txn.stale"]);
    expect(d.body.ops[2].data.paths).toEqual([{ path: "src/format.ts", seq: 1, by: lander.txn }]);
  });

  it("lists the stale warnings of an open transaction whose reads changed on trunk", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    await post(`/api/txns/${b.txn}/reads`, { paths: ["src/format.ts", "src/b.ts"] });
    const lander = await landOnTrunk(t, { "src/format.ts": "export const digits = 4;\n" });
    const d = await http("GET", `/api/txns/${b.txn}`);
    expect(d.body.staleWarnings).toEqual([{ path: "src/format.ts", seq: 1, by: lander.txn }]);
    expect(d.body.ops.map((o: Json) => o.kind)).toEqual(["txn.open", "stale.warning"]);
  });

  it("shows the landed commit and sequence", async () => {
    const t = await newRepo();
    const { b, sha } = await submitted(t, { "src/x.ts": "x\n" });
    const train = ok(await t.L.formTrain()).train!;
    ok(await t.L.commitTrain(train, sha, [{ txn: b.txn, sha, paths: ["src/x.ts"] }]));
    ok(await t.L.trainDone(train, "landed"));
    const d = await http("GET", `/api/txns/${b.txn}`);
    expect(d.body.txn).toMatchObject({ state: "landed", landedSeq: 1 });
    expect(d.body.commit).toBe(sha);
  });
});

describe("GET /api/txns/:id/wait", () => {
  it("times out without a change and says so", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const started = Date.now();
    const r = await http("GET", `/api/txns/${b.txn}/wait?timeout=0.3`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: false, staleWarnings: [], txn: { id: b.txn, state: "open" }, detail: {} });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("returns at once for timeout=0, and for a timeout that is negative", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    for (const q of ["0", "-5", ""]) {
      const started = Date.now();
      const r = await http("GET", `/api/txns/${b.txn}/wait?timeout=${q}`);
      expect(r.body.changed, q).toBe(false);
      expect(Date.now() - started, q).toBeLessThan(2000);
    }
  });

  it("wakes as soon as the transaction changes state", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const started = Date.now();
    const waiting = http("GET", `/api/txns/${b.txn}/wait?timeout=20`);
    await sleep(500);
    expect((await post(`/api/txns/${b.txn}/abort`, { reason: "enough" })).status).toBe(200);
    const r = await waiting;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: true, txn: { state: "aborted", reason: "enough" } });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("wakes when a landing makes something the transaction read stale", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    await post(`/api/txns/${b.txn}/reads`, { paths: ["src/format.ts"] });
    const waiting = http("GET", `/api/txns/${b.txn}/wait?timeout=20`);
    await sleep(500);
    const lander = await landOnTrunk(t, { "src/format.ts": "export const digits = 5;\n" });
    const r = await waiting;
    expect(r.body.changed).toBe(false);
    expect(r.body.txn.state).toBe("open");
    expect(r.body.staleWarnings).toEqual([{ path: "src/format.ts", seq: 1, by: lander.txn }]);
  });

  it("returns at once when a stale warning is already waiting", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    await landOnTrunk(t, { "src/format.ts": "export const digits = 6;\n" });
    await post(`/api/txns/${b.txn}/reads`, { paths: ["src/format.ts"] });
    const started = Date.now();
    const r = await http("GET", `/api/txns/${b.txn}/wait?timeout=30`);
    expect(r.body.staleWarnings).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("returns at once for a transaction that can no longer change, whatever the timeout says", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    await post(`/api/txns/${b.txn}/abort`, { reason: "x" });
    for (const q of ["30", "9999", "abc"]) {
      const started = Date.now();
      const r = await http("GET", `/api/txns/${b.txn}/wait?timeout=${q}`);
      expect(r.status, q).toBe(200);
      expect(r.body, q).toMatchObject({ changed: false, txn: { state: "aborted" } });
      expect(Date.now() - started, q).toBeLessThan(2000);
    }
  });
});

describe("GET /api/repos/:repo/ops", () => {
  // Two seed ops and one txn.open: the same three ops for every row of the query table.
  const withOneTxn = lazy(async () => {
    const t = await newRepo();
    await apiBegin(t.name);
    return t;
  });

  it("pages the op log with after and limit", async () => {
    const t = await newRepo();
    const txns = [await apiBegin(t.name, "a"), await apiBegin(t.name, "b"), await apiBegin(t.name, "c")];
    const p1 = await http("GET", `/api/repos/${t.name}/ops?after=0&limit=2`);
    expect(p1.status).toBe(200);
    expect(p1.body.ops.map((o: Json) => o.kind)).toEqual(["trunk.advanced", "policy.updated"]);
    expect(p1.body.last).toBe(p1.body.ops[1].seq);
    const p2 = await http("GET", `/api/repos/${t.name}/ops?after=${p1.body.last}&limit=2`);
    expect(p2.body.ops.map((o: Json) => [o.kind, o.txn])).toEqual([["txn.open", txns[0]!.txn], ["txn.open", txns[1]!.txn]]);
    const p3 = await http("GET", `/api/repos/${t.name}/ops?after=${p2.body.last}&limit=2`);
    expect(p3.body.ops.map((o: Json) => o.txn)).toEqual([txns[2]!.txn]);
    const p4 = await http("GET", `/api/repos/${t.name}/ops?after=${p3.body.last}&limit=2`);
    expect(p4.body).toEqual({ ops: [], last: p3.body.last });
    const all = [...p1.body.ops, ...p2.body.ops, ...p3.body.ops].map((o: Json) => o.seq);
    expect(all).toEqual([...all].sort((a, b) => a - b));
    expect(new Set(all).size).toBe(all.length);
  });

  it("returns every op by default, in order, with the shape the dashboard replays", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name, "agent-o");
    const r = await http("GET", `/api/repos/${t.name}/ops`, { auth: false });
    expect(r.body.ops).toEqual([
      { seq: 1, at: expect.any(Number), kind: "trunk.advanced", txn: null, agent: null, data: { seq: 0, sha: t.head, txns: [], train: null } },
      { seq: 2, at: expect.any(Number), kind: "policy.updated", txn: null, agent: null, data: { policy: expect.any(Object) } },
      { seq: 3, at: expect.any(Number), kind: "txn.open", txn: b.txn, agent: "agent-o", data: expect.objectContaining({ attempt: 1, snapshot: t.head }) },
    ]);
    expect(r.body.last).toBe(3);
  });

  it.each([
    ["limit=0 is raised to 1", "limit=0", 1],
    ["a negative limit is raised to 1", "limit=-4", 1],
    ["a limit that is not a number falls back to the default", "limit=abc", 3],
    ["an after that is not a number starts at the beginning", "after=abc", 3],
    ["a negative after starts at the beginning", "after=-7", 3],
    ["an after past the end is empty", "after=999", 0],
  ])("%s", async (_label, query, count) => {
    const t = await withOneTxn();
    const r = await http("GET", `/api/repos/${t.name}/ops?${query}`);
    expect(r.status).toBe(200);
    expect(r.body.ops).toHaveLength(count);
  });

  it("is 404 for a repo that was never initialised", async () => {
    const r = await http("GET", `/api/repos/${unique("never")}/ops`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "repo is not initialised" });
  });
});

describe("GET /api/repos/:repo/stream", () => {
  type Frame = { ops: { seq: number; kind: string; txn: string | null }[] };

  async function open(repo: string, after?: number) {
    const query = after === undefined ? "" : `?after=${after}`;
    const res = await exports.default.fetch(`http://ryke.test/api/repos/${repo}/stream${query}`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const frames: Frame[] = [];
    ws.accept();
    ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data as string) as Frame));
    const until = async (pred: (ops: Frame["ops"]) => boolean) => {
      for (let i = 0; i < 150; i++) {
        const ops = frames.flatMap((f) => f.ops);
        if (pred(ops)) return ops;
        await sleep(20);
      }
      throw new Error(`no matching frame in ${JSON.stringify(frames)}`);
    };
    return { ws, frames, until };
  }

  it("is 426 without a WebSocket upgrade, whether or not the repo exists", async () => {
    const t = await newRepo();
    for (const repo of [t.name, unique("never")]) {
      const r = await http("GET", `/api/repos/${repo}/stream`);
      expect(r.status).toBe(426);
      expect(r.body).toEqual({ error: "expected a websocket upgrade" });
    }
  });

  it("is 404 for an upgrade to a repo that was never initialised", async () => {
    const res = await exports.default.fetch(`http://ryke.test/api/repos/${unique("never")}/stream`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(404);
    expect(res.webSocket).toBeNull();
    expect(await res.json()).toEqual({ error: "repo is not initialised" });
  });

  it("replays the backlog, then streams live ops as {ops: [...]} frames", async () => {
    const t = await newRepo();
    const { ws, frames, until } = await open(t.name);
    const backlog = await until((ops) => ops.length >= 2);
    expect(backlog.map((o) => o.kind)).toEqual(["trunk.advanced", "policy.updated"]);
    expect(frames[0]).toEqual({ ops: expect.any(Array) });
    const b = await apiBegin(t.name, "agent-w");
    const live = await until((ops) => ops.some((o) => o.txn === b.txn));
    expect(live.at(-1)).toMatchObject({ kind: "txn.open", txn: b.txn, agent: "agent-w" });
    await post(`/api/txns/${b.txn}/abort`, { reason: "x" });
    const more = await until((ops) => ops.some((o) => o.kind === "txn.aborted"));
    expect(more.at(-1)).toMatchObject({ kind: "txn.aborted", txn: b.txn });
    ws.close();
  });

  it("skips the ops up to ?after=", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const { ws, until } = await open(t.name, 2);
    const ops = await until((o) => o.length >= 1);
    expect(ops.map((o) => [o.kind, o.txn])).toEqual([["txn.open", b.txn]]);
    ws.close();
  });

  it("sends nothing at all when the client is already up to date", async () => {
    const t = await newRepo();
    const last = (await http("GET", `/api/repos/${t.name}/ops`)).body.last as number;
    const { ws, frames } = await open(t.name, last);
    await sleep(100);
    expect(frames).toEqual([]);
    ws.close();
  });
});

describe("GET /api/repos/:repo/files", () => {
  const trunk = lazy(() => newRepo());
  const HEAD_FILES = ["CHANGELOG.md", "ryke.json", "src/a.ts", "src/c/d.ts", "src/format.ts", "src/registry.ts", "test/a.test.ts"];

  it("lists the files at the trunk head", async () => {
    const t = await newRepo();
    const r = await http("GET", `/api/repos/${t.name}/files`, { auth: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ref: t.head, files: HEAD_FILES });
  });

  it("returns a file's content at the head", async () => {
    const t = await newRepo();
    const r = await http("GET", `/api/repos/${t.name}/files?path=src/a.ts`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ref: t.head, path: "src/a.ts", content: "export const a = 2;\n" });
  });

  it("reads another ref when ?ref= names one", async () => {
    const t = await newRepo();
    const [first] = fixture.commits;
    const list = await http("GET", `/api/repos/${t.name}/files?ref=${first}`);
    expect(list.body.ref).toBe(first);
    expect(list.body.files).toContain("src/b.ts");
    expect(list.body.files).not.toContain("src/c/d.ts");
    const file = await http("GET", `/api/repos/${t.name}/files?ref=${first}&path=src/a.ts`);
    expect(file.body).toEqual({ ref: first, path: "src/a.ts", content: "export const a = 1;\n" });
  });

  it("follows the trunk head after a landing", async () => {
    const t = await newRepo();
    const landed = await landOnTrunk(t, { "src/a.ts": "export const a = 9;\n" });
    const r = await http("GET", `/api/repos/${t.name}/files?path=src/a.ts`);
    expect(r.body).toEqual({ ref: landed.sha, path: "src/a.ts", content: "export const a = 9;\n" });
  });

  it.each([
    ["a file that does not exist", "src/nope.ts"],
    ["a directory", "src"],
    ["a path that climbs out of the repo", "../../etc/passwd"],
    ["a file deleted by a later commit", "src/b.ts"],
  ])("is 404 for %s", async (_label, path) => {
    const t = await trunk();
    const r = await http("GET", `/api/repos/${t.name}/files?path=${encodeURIComponent(path)}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: `no file ${path} at ${t.head}` });
  });

  it("is 404 for a ref that does not exist, listing or reading", async () => {
    const t = await newRepo();
    const unknown = "e".repeat(40);
    expect((await http("GET", `/api/repos/${t.name}/files?ref=${unknown}`)).status).toBe(404);
    const read = await http("GET", `/api/repos/${t.name}/files?ref=${unknown}&path=src/a.ts`);
    expect(read.status).toBe(404);
    expect((await http("GET", `/api/repos/${t.name}/files?ref=--upload-pack=x&path=src/a.ts`)).status).toBe(404);
  });

  it("is 404 for a repo that was never initialised", async () => {
    const r = await http("GET", `/api/repos/${unique("never")}/files`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "repo is not initialised" });
  });
});

describe("POST /internal/events", () => {
  it("is 401 without the right secret and records nothing", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    const wrong: [string, string | null][] = [
      ["no secret header", null],
      ["an empty secret", ""],
      ["a wrong secret", "wrong-secret"],
      ["the secret with a character appended", `${env.RYKE_INTERNAL_SECRET}x`],
      ["a prefix of the secret", env.RYKE_INTERNAL_SECRET.slice(0, -1)],
    ];
    for (const [label, secret] of wrong) {
      const r = await internal(pushEvent(`${t.name}--${b.txn}`, sha), secret);
      expect(r.status, label).toBe(401);
      expect(r.body, label).toEqual({ error: "unauthorized" });
    }
    expect((await http("GET", `/api/txns/${b.txn}`)).body.txn.head).toBeNull();
  });

  it("is not opened by the API bearer token", async () => {
    const r = await http("POST", "/internal/events", { body: pushEvent("x--t_y", "a".repeat(40)), auth: true });
    expect(r.status).toBe(401);
  });

  it.each([
    ["an empty object", "{}"],
    ["another event type", JSON.stringify({ type: "cf.artifacts.repo.created", source: { repoName: "x" } })],
    ["a push with no source", JSON.stringify({ type: "cf.artifacts.repo.pushed" })],
    ["a push whose repoName is not a string", JSON.stringify({ type: "cf.artifacts.repo.pushed", source: { repoName: 5 } })],
    ["an array", "[]"],
    ["null", "null"],
    ["invalid JSON", "{"],
    ["an empty body", ""],
  ])("is 422 for %s", async (_label, raw) => {
    const r = await http("POST", "/internal/events", { raw, auth: false, headers: { "x-ryke-internal": env.RYKE_INTERNAL_SECRET } });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: "not a push event" });
  });

  it("records the pushed head of a fork, so a following submit needs no head", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    expect((await http("GET", `/api/txns/${b.txn}`)).body.txn.head).toBeNull();
    const r = await internal(pushEvent(`${t.name}--${b.txn}`, sha));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ txn: b.txn });
    const d = await http("GET", `/api/txns/${b.txn}`);
    expect(d.body.txn).toMatchObject({ state: "open", head: sha });
    const s = await post(`/api/txns/${b.txn}/submit`);
    expect(s.body).toEqual({ state: "ready" });
    expect((await http("GET", `/api/txns/${b.txn}`)).body.attempts[0].writes).toEqual(["src/x.ts"]);
  });

  it("is idempotent: the same event twice changes nothing the second time", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    const ev = pushEvent(`${t.name}--${b.txn}`, sha);
    expect((await internal(ev)).body).toEqual({ txn: b.txn });
    const before = (await http("GET", `/api/txns/${b.txn}`)).body;
    expect((await internal(ev)).body).toEqual({ txn: b.txn });
    const after = (await http("GET", `/api/txns/${b.txn}`)).body;
    expect(after.txn.head).toBe(sha);
    expect(after.ops).toEqual(before.ops);
  });

  it("follows the fork when a later push moves its head", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const first = await commitToFork(b, { "src/x.ts": "x\n" });
    await internal(pushEvent(`${t.name}--${b.txn}`, first));
    const second = await commitToFork(b, { "src/y.ts": "y\n" }, { force: true });
    expect((await internal(pushEvent(`${t.name}--${b.txn}`, second))).body).toEqual({ txn: b.txn });
    expect((await http("GET", `/api/txns/${b.txn}`)).body.txn.head).toBe(second);
    expect((await post(`/api/txns/${b.txn}/submit`)).body).toEqual({ state: "ready" });
    expect((await http("GET", `/api/txns/${b.txn}`)).body.attempts[0].writes).toEqual(["src/y.ts"]);
  });

  it("answers {txn: null} for pushes that belong to no open transaction", async () => {
    const t = await newRepo();
    const b = await apiBegin(t.name);
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    const done = await apiBegin(t.name);
    await post(`/api/txns/${done.txn}/abort`, { reason: "x" });
    const cases: [string, PushEvent][] = [
      ["the trunk itself", pushEvent(t.name, sha)],
      ["a fork nobody opened", pushEvent(`${t.name}--t_unknown`, sha)],
      ["a branch other than main", pushEvent(`${t.name}--${b.txn}`, sha, "refs/heads/other")],
      ["a branch deletion", pushEvent(`${t.name}--${b.txn}`, "0".repeat(40))],
      ["an after that is not a sha", pushEvent(`${t.name}--${b.txn}`, "abc")],
      ["a repo that was never initialised", pushEvent(`${unique("never")}--t_abc`, sha)],
      ["a transaction that is no longer open", pushEvent(`${t.name}--${done.txn}`, sha)],
    ];
    for (const [label, ev] of cases) {
      const r = await internal(ev);
      expect(r.status, label).toBe(200);
      expect(r.body, label).toEqual({ txn: null });
    }
    expect((await http("GET", `/api/txns/${b.txn}`)).body.txn.head).toBeNull();
    expect((await http("GET", `/api/txns/${done.txn}`)).body.txn.head).toBeNull();
  });
});

// These fail until the code under test is fixed. Where: /internal/events derives the repo with the
// first "--" and reads payload.ref unchecked (src/worker/index.ts); deleteRepo resets whatever ledger
// it is named, including the reserved index (src/worker/service.ts).
describe("known defects", () => {
  it("routes a push for a repo whose name contains -- to that repo's ledger", async () => {
    // [a-z0-9][a-z0-9-]{0,40} allows "--", but the event handler cuts the repo name at its first "--".
    const name = `${unique("dd")}--dd`;
    await store.fork(fixture.name, name);
    const head = (await store.info(name)).head!;
    ok(await ledger(env, name).init(name, head, null, { autoland: false }));
    const b = await apiBegin(name);
    const sha = await commitToFork(b, { "src/x.ts": "x\n" });
    const r = await internal(pushEvent(`${name}--${b.txn}`, sha));
    expect(r.body).toEqual({ txn: b.txn });
  });

  it("answers 422, not 500, for a push event without a payload", async () => {
    const r = await internal({ type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: "ryke", repoName: "x--t_y" } });
    expect(r.status).toBe(422);
  });

  it("refuses to delete the reserved __index repo instead of wiping the txn index", async () => {
    // A transaction known only to the index DO, as after a Worker restart (the in-memory cache is empty).
    const t = await newRepo();
    const txn = ok(await t.L.begin({ agent: "a", intent: "x" })).txn;
    await ledger(env, "__index").indexPut(txn, t.name);
    const del = await http("DELETE", "/api/repos/__index");
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect(await ledger(env, "__index").indexGet(txn)).toBe(t.name);
    expect((await http("GET", `/api/txns/${txn}`)).status).toBe(200);
  });
});
