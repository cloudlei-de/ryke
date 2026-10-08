// GET /api/evidence/:file: the verify screenshots the Transaction view embeds (PLAN.md §12 view 2). The local
// runner keeps them on disk; the Worker validates the name, asks the runner for the bytes and serves them as an
// image that can never be sniffed into anything else. The runner's origin is answered by a stub here.
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/worker/api";
import { evidenceUrl } from "../src/web/views/txn/format";
import { http } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const RUNNER = new URL(env.RYKE_RUNNER_URL).origin;
// The eight-byte PNG signature plus a few bytes: the route must pass bytes through untouched.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 250, 251, 252, 253]);

// Answers the runner's origin and lets every other URL through, so the test needs no second server.
function stubRunner(answer: (path: string, init: Request) => Response | Promise<Response>) {
  const real = globalThis.fetch;
  const calls: { path: string; method: string; headers: Headers }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin !== RUNNER) return real(input as RequestInfo, init);
    calls.push({ path: url.pathname + url.search, method: req.method, headers: req.headers });
    return answer(url.pathname, req);
  });
  return calls;
}

const png = (type = "image/png") => new Response(PNG, { status: 200, headers: { "content-type": type, "content-length": String(PNG.length) } });
const get = (file: string) => http("GET", `/api/evidence/${file}`, { auth: false });
// Where the answer is an image, `http` would read it as text: read the bytes instead.
const getImage = async (file: string, init?: RequestInit) => {
  const res = await exports.default.fetch(`http://ryke.test/api/evidence/${file}`, init);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
};

// The Worker's own router with an Env that differs from the test binding, e.g. the production runner mode.
const callWith = (over: Record<string, unknown>, file: string) =>
  api.fetch(
    new Request(`http://ryke.test/api/evidence/${file}`),
    Object.create(env, Object.fromEntries(Object.entries(over).map(([k, value]) => [k, { value }]))) as Env,
  );

describe("GET /api/evidence/:file in process mode", () => {
  it("serves the runner's screenshot as an immutable image, to anyone", async () => {
    const calls = stubRunner(() => png());
    const { res, bytes } = await getImage("j_mq3f0k1a.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(bytes).toEqual(PNG);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/v1/evidence/j_mq3f0k1a.png", method: "GET" });
  });

  it("sends the runner nothing that identifies the caller", async () => {
    const calls = stubRunner(() => png());
    await getImage("j_1.png", { headers: { authorization: `Bearer ${env.RYKE_TOKEN}`, cookie: "a=b" } });
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect(calls[0]!.headers.get("cookie")).toBeNull();
  });

  it("labels the bytes image/png whatever the runner said, so a planted file is never served as a page", async () => {
    stubRunner(() => png("text/html"));
    const { res } = await getImage("j_1.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 404 when the runner has no such file, and does not cache the miss", async () => {
    stubRunner(() => Response.json({ error: { code: "NOT_FOUND", message: "no such evidence file" } }, { status: 404 }));
    const res = await get("j_gone.png");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "no such evidence file" });
    expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
  });

  it.each([
    ["the runner fails", () => new Response("boom", { status: 500 })],
    ["the runner answers with something unexpected", () => new Response("", { status: 302, headers: { location: "http://evil.test/" } })],
    ["the runner is down", () => Promise.reject(new TypeError("fetch failed"))],
  ])("answers 503 when %s", async (_name, answer) => {
    stubRunner(answer);
    const res = await get("j_1.png");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "the runner did not serve the screenshot" });
    expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
  });

  it("is a public read like every other GET: no token needed", async () => {
    stubRunner(() => png());
    expect((await getImage("j_1.png")).res.status).toBe(200);
  });

  it("does not take other methods: writes still need the token", async () => {
    stubRunner(() => png());
    const res = await http("POST", "/api/evidence/j_1.png", { auth: false, body: {} });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/evidence/:file rejects names that are not a runner screenshot", () => {
  const bad: [string, string][] = [
    ["a path traversal", "..%2Fsecret.png"],
    ["a path traversal further up", "..%2F..%2F..%2Fetc%2Fpasswd.png"],
    ["a subdirectory", "dir%2Fshot.png"],
    ["a backslash", "dir%5Cshot.png"],
    ["an absolute path", "%2Fetc%2Fpasswd.png"],
    ["the wrong extension", "shot.jpg"],
    ["no extension", "shot"],
    ["a second extension", "shot.png.html"],
    ["an extension in the middle", "shot.png.sh"],
    ["a leading dot", ".hidden.png"],
    ["a space", "a%20b.png"],
    ["a query smuggled into the name", "shot.png%3Fx%3D1"],
    ["a NUL byte", "shot%00.png"],
    ["a percent sign", "100%25.png"],
    ["a name that is only the extension", ".png"],
  ];
  it.each(bad)("answers 422 for %s (%s)", async (_name, file) => {
    const calls = stubRunner(() => png());
    const res = await get(file);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "evidence file names look like <id>.png" });
    // The runner is never asked: its own containment check is the second line of defence, not the first.
    expect(calls).toEqual([]);
  });

  it("accepts exactly the names the Transaction view links to", async () => {
    stubRunner(() => png());
    const refs = ["j_1.png", "abc-123.PNG", "a.b.png", "j_mq3f0k1aXyz987.png", "-lead.png", "_lead.png", "shot.jpg", "dir/shot.png", ".hidden.png", "a b.png", "agent", "../x.png"];
    for (const ref of refs) {
      const linked = evidenceUrl(ref) !== null;
      const served = (await getImage(encodeURIComponent(ref))).res.status !== 422;
      expect(served, ref).toBe(linked);
    }
  });
});

describe("GET /api/evidence/:file in container mode", () => {
  it("answers 404 and never asks a runner: screenshots are written to the local runner's disk only", async () => {
    const calls = stubRunner(() => png());
    const res = await callWith({ RYKE_RUNNER: "container" }, "j_1.png");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "evidence screenshots are served only by the local runner" });
    expect(calls).toEqual([]);
  });

  it("still validates the name first", async () => {
    const res = await callWith({ RYKE_RUNNER: "container" }, "..%2Fx.png");
    expect(res.status).toBe(422);
  });

  it("uses the same test as the job runner: only container mode answers 404, any other value is the local runner", async () => {
    stubRunner(() => png());
    expect((await callWith({ RYKE_RUNNER: "process" }, "j_1.png")).status).toBe(200);
    expect((await callWith({ RYKE_RUNNER: "" }, "j_1.png")).status).toBe(200);
  });
});
