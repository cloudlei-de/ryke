// Per-commit previews (PLAN.md §10.3, M3 Accept "/preview/convert/<head>/ renders all landed
// categories"): the real demo app is seeded through the API, bundled by @cloudflare/worker-bundler
// and run as a Dynamic Worker, all inside workerd. Small probe apps cover forwarding, link rewriting
// and failure modes that the Convert app does not exercise.
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_BUNDLES, bundleCount, previewFetch } from "../src/worker/preview";
import { registerRepo } from "../src/worker/service";
import { fixture, gitHelper, http, store, unique, type Json } from "./helpers";

type Got = { status: number; headers: Headers; text: string };

// Redirects stay unfollowed so the bare-path 302 can be asserted.
async function get(path: string, init: RequestInit = {}): Promise<Got> {
  const res = await exports.default.fetch(`http://ryke.test${path}`, { redirect: "manual", ...init });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const json = (g: Got): Json => JSON.parse(g.text);

// Pushes a commit straight onto trunk's main, bypassing the Ledger, the way a landed train would.
async function commitTo(repo: string, files: Record<string, string | null>): Promise<string> {
  const [info, token] = await Promise.all([store.info(repo), store.token(repo, "write", 600)]);
  return (await gitHelper<{ sha: string }>("/commit", { remote: info.remote, token, files })).sha;
}

// Previews are served only for repos Ryke knows, so the planted store repo is registered like a created one.
async function plant(files: Record<string, string>): Promise<{ name: string; sha: string }> {
  const name = unique("pv");
  await store.create(name);
  await registerRepo(env, name);
  return { name, sha: await commitTo(name, files) };
}

// The suite shares the machine with other workerd runs; seeding and 32 forks need more than the defaults.
const SLOW = 120_000;
const convert = { name: unique("pv"), head: "" };

beforeAll(async () => {
  const r = await http("POST", "/api/repos", { body: { name: convert.name, seedFrom: "convert" } });
  expect(r.status).toBe(201);
  convert.head = r.body.head;
}, SLOW);

describe("the Convert demo app at a commit", () => {
  it("renders every category of the commit and says which commit it ran", async () => {
    const r = await get(`/preview/${convert.name}/${convert.head}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("x-ryke-preview")).toBe(`${convert.name}@${convert.head}`);
    // agent code runs sandboxed, with an opaque origin that cannot read the dashboard's storage
    expect(r.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-popups allow-modals");
    for (const name of ["Length", "Mass", "Temperature"]) expect(r.text).toContain(name);
  });

  it("serves the Ledger's trunk head under the literal `head`, with links pinned to that commit", async () => {
    const r = await get(`/preview/${convert.name}/head/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-ryke-preview")).toBe(`${convert.name}@${convert.head}`);
    expect(r.text).toContain("Temperature");
    expect(r.text).toContain(`href="/preview/${convert.name}/${convert.head}/c/length"`);
    expect(r.text).not.toContain("/head/");
  });

  it("needs no credentials", async () => {
    const r = await http("GET", `/preview/${convert.name}/${convert.head}/`, { auth: false });
    expect(r.status).toBe(200);
  });

  it("keeps the links of a converter page under the preview prefix", async () => {
    const prefix = `/preview/${convert.name}/${convert.head}`;
    const r = await get(`${prefix}/c/length`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Metre");
    expect(r.text).toContain(`<a class="brand" href="${prefix}/">`);
    expect(r.text).toContain(`<a href="${prefix}/">Categories</a>`);
    // The layout writes this href with &amp;; the rewrite must not double- or un-escape it.
    expect(r.text).toContain(`href="${prefix}/api/convert?c=length&amp;from=km&amp;to=m&amp;v=1"`);
    expect(r.text).toContain(`action="${prefix}/api/convert"`);
    expect(r.text).not.toMatch(/(href|src|action)="\/(?!preview\/)/);
  });

  it("rewrites the category tiles of the home page", async () => {
    const r = await get(`/preview/${convert.name}/${convert.head}/`);
    for (const id of ["length", "mass", "temperature"]) expect(r.text).toContain(`href="/preview/${convert.name}/${convert.head}/c/${id}"`);
  });

  it("answers the JSON API untouched", async () => {
    const r = await get(`/preview/${convert.name}/${convert.head}/api/convert?c=length&from=km&to=m&v=1`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("x-ryke-preview")).toBe(`${convert.name}@${convert.head}`);
    expect(json(r)).toMatchObject({ category: "length", from: "km", to: "m", value: 1, result: 1000 });
  });

  it("passes the app's own 404s and 400s through", async () => {
    const missing = await get(`/preview/${convert.name}/${convert.head}/nope`);
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("That page does not exist");
    expect(missing.headers.get("x-ryke-preview")).toBe(`${convert.name}@${convert.head}`);
    const bad = await get(`/preview/${convert.name}/${convert.head}/api/convert?c=length&from=km&to=m&v=x`);
    expect(bad.status).toBe(400);
  });

  it("shows a category added on trunk only from the commit that added it", async () => {
    const registry = (await store.readFile(convert.name, convert.head, "src/registry.ts"))!;
    const area = `import type { Category } from "../types.ts";

export const area: Category = {
  id: "area",
  name: "Area",
  base: "m2",
  units: [
    { id: "m2", name: "Square metre", symbol: "m²", toBase: (v) => v, fromBase: (v) => v },
    { id: "ha", name: "Hectare", symbol: "ha", toBase: (v) => v * 10000, fromBase: (v) => v / 10000 },
  ],
};
`;
    const next = await commitTo(convert.name, {
      "src/registry.ts": `${registry}export { area } from "./units/area.ts";\n`,
      "src/units/area.ts": area,
    });
    expect(next).not.toBe(convert.head);

    const added = await get(`/preview/${convert.name}/${next}/`);
    expect(added.status).toBe(200);
    for (const name of ["Area", "Length", "Mass", "Temperature"]) expect(added.text).toContain(name);
    const page = await get(`/preview/${convert.name}/${next}/c/area`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Square metre");
    expect(json(await get(`/preview/${convert.name}/${next}/api/convert?c=area&from=ha&to=m2&v=2`)).result).toBe(20000);

    const before = await get(`/preview/${convert.name}/${convert.head}/`);
    expect(before.text).not.toContain("Area");
    expect((await get(`/preview/${convert.name}/${convert.head}/c/area`)).status).toBe(404);
    // The Ledger has not seen this push, so `head` still means the seed.
    expect((await get(`/preview/${convert.name}/head/`)).headers.get("x-ryke-preview")).toBe(`${convert.name}@${convert.head}`);
  });
});

// One app that answers differently per path, so each behaviour of the proxy has a probe.
const PROBE = `
export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const frag = url.searchParams.get("frag") ?? "";
    const path = url.pathname;
    if (path.startsWith("/echo"))
      return Response.json({
        method: req.method,
        path,
        search: url.search,
        host: url.host,
        auth: req.headers.get("authorization"),
        probe: req.headers.get("x-probe"),
        body: await req.text(),
      });
    if (path === "/html") return new Response("<!doctype html><body>" + frag + "</body>", { headers: { "content-type": "text/html; charset=utf-8" } });
    if (path === "/text") return new Response(frag, { headers: { "content-type": "text/plain" } });
    if (path === "/redirect") return new Response(null, { status: 302, headers: { location: frag } });
    if (path === "/sized") {
      const body = '<a href="/long/path/that/grows">x</a>';
      return new Response(body, { headers: { "content-type": "text/html", "content-length": String(body.length) } });
    }
    if (path === "/empty") return new Response(null, { status: 204 });
    // Headers an app must not be able to use against the dashboard it is served next to.
    if (path === "/headers")
      return new Response(url.searchParams.has("html") ? '<a href="/x">x</a>' : "h", {
        headers: [
          ["content-type", url.searchParams.has("html") ? "text/html" : "text/plain"],
          ["set-cookie", "session=stolen; Path=/"],
          ["set-cookie", "second=1; Path=/"],
          ["clear-site-data", '"cache", "cookies", "storage"'],
          ["service-worker-allowed", "/"],
          ["x-app", "kept"],
        ],
      });
    if (path === "/outbound") {
      try {
        return Response.json({ reached: (await fetch("http://example.com")).status });
      } catch (e) {
        return Response.json({ blocked: String(e) });
      }
    }
    if (path === "/throw") throw new Error("handler blew up");
    return new Response("probe", { status: 201, headers: { "x-app": "kept" } });
  },
};
`;

describe("forwarding to the app", () => {
  let probe: { name: string; sha: string };
  let base: string;
  beforeAll(async () => {
    probe = await plant({ "src/index.ts": PROBE });
    base = `/preview/${probe.name}/${probe.sha}`;
  }, SLOW);

  it("rewrites the path to /<rest>, keeps method, query, headers and body, and strips the bearer token", async () => {
    const r = await get(`${base}/echo/deep/path?a=1&b=two%20words`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RYKE_TOKEN}`, "x-probe": "yes" },
      body: "hello",
    });
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ method: "POST", path: "/echo/deep/path", search: "?a=1&b=two%20words", host: "ryke.test", auth: null, probe: "yes", body: "hello" });
  });

  it("sees `/` for the preview root and keeps the app's status and headers", async () => {
    const r = await get(`${base}/`);
    expect(r.status).toBe(201);
    expect(r.text).toBe("probe");
    expect(r.headers.get("x-app")).toBe("kept");
    expect(r.headers.get("x-ryke-preview")).toBe(`${probe.name}@${probe.sha}`);
  });

  it("sends the whole rewritten body when the app declared the length of the original", async () => {
    const r = await get(`${base}/sized`);
    expect(r.status).toBe(200);
    expect(r.text).toBe(`<a href="${base}/long/path/that/grows">x</a>`);
    const declared = r.headers.get("content-length");
    if (declared !== null) expect(Number(declared)).toBe(new TextEncoder().encode(r.text).length);
  });

  it("passes an empty 204 answer through", async () => {
    const r = await get(`${base}/empty`);
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    expect(r.headers.get("x-ryke-preview")).toBe(`${probe.name}@${probe.sha}`);
  });

  // [attribute as the app writes it, what the preview must send]; %P is the preview prefix.
  const links: [string, string, string][] = [
    ["an absolute href", '<a href="/c/length">x</a>', 'href="%P/c/length"'],
    ["the root href", '<a href="/">x</a>', 'href="%P/"'],
    ["a query string with an escaped ampersand", '<a href="/q?x=1&amp;y=2">x</a>', 'href="%P/q?x=1&amp;y=2"'],
    ["an img src", '<img src="/logo.png">', 'src="%P/logo.png"'],
    ["a script src", '<script src="/app.js"></script>', 'src="%P/app.js"'],
    ["a stylesheet link", '<link rel="stylesheet" href="/s.css">', 'href="%P/s.css"'],
    ["a form action", '<form action="/submit" method="post"></form>', 'action="%P/submit"'],
    ["a single-quoted attribute", "<a href='/x'>x</a>", 'href="%P/x"'],
    ["one of several attributes", '<a class="k" href="/a" data-x="1">x</a>', 'class="k" href="%P/a" data-x="1"'],
    ["a protocol-relative URL", '<a href="//cdn.example/x">x</a>', 'href="//cdn.example/x"'],
    ["an absolute URL", '<a href="https://example.com/x">x</a>', 'href="https://example.com/x"'],
    ["a relative path", '<a href="rel/path">x</a>', 'href="rel/path"'],
    ["a fragment", '<a href="#top">x</a>', 'href="#top"'],
    ["an empty href", '<a href="">x</a>', 'href=""'],
    ["a mailto link", '<a href="mailto:a@b.c">x</a>', 'href="mailto:a@b.c"'],
    ["an element with none of the attributes", '<p class="/c">x</p>', 'class="/c"'],
  ];
  it.each(links)("HTML: %s", async (_label, snippet, expected) => {
    const r = await get(`${base}/html?frag=${encodeURIComponent(snippet)}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain(expected.replaceAll("%P", base));
  });

  it("leaves non-HTML bodies alone even when they look like links", async () => {
    const r = await get(`${base}/text?frag=${encodeURIComponent('<a href="/x">')}`);
    expect(r.text).toBe('<a href="/x">');
  });

  const redirects: [string, string, string][] = [
    ["an absolute path", "/c/length", "%P/c/length"],
    ["the root", "/", "%P/"],
    ["a protocol-relative URL", "//evil.example/x", "//evil.example/x"],
    ["an absolute URL", "https://example.com/x", "https://example.com/x"],
    ["a relative path", "next/page", "next/page"],
  ];
  it.each(redirects)("redirect to %s", async (_label, to, expected) => {
    const r = await get(`${base}/redirect?frag=${encodeURIComponent(to)}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(expected.replaceAll("%P", base));
  });

  it.each([
    ["a plain answer", "/headers"],
    ["an HTML answer, which is rewritten on the way out", "/headers?html=1"],
  ])("drops the cookie, site-data and service-worker headers of %s and keeps the others", async (_label, path) => {
    const r = await get(`${base}${path}`);
    expect(r.status).toBe(200);
    // The app shares the dashboard's origin: a cookie, a Clear-Site-Data or a wider worker scope would reach the dashboard.
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("clear-site-data")).toBeNull();
    expect(r.headers.get("service-worker-allowed")).toBeNull();
    expect(r.headers.get("x-app")).toBe("kept");
    expect(r.headers.get("x-ryke-preview")).toBe(`${probe.name}@${probe.sha}`);
    expect(r.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-popups allow-modals");
  });

  it("gives the app no way out to the network", async () => {
    const r = await get(`${base}/outbound`);
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ blocked: expect.any(String) });
  });

  it("answers 502 text when the app throws inside its handler", async () => {
    const r = await get(`${base}/throw`);
    expect(r.status).toBe(502);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(r.text).toContain(`${probe.name}@${probe.sha.slice(0, 7)}`);
    expect(r.text).toContain("handler blew up");
  });
});

describe("the bare path", () => {
  it.each([
    ["without a query", "", ""],
    ["with a query", "?x=1&y=2", "?x=1&y=2"],
  ])("redirects to the trailing-slash form %s", async (_label, search, keep) => {
    const r = await get(`/preview/${convert.name}/${convert.head}${search}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`http://ryke.test/preview/${convert.name}/${convert.head}/${keep}`);
    const head = await get(`/preview/${convert.name}/head${search}`);
    expect(head.status).toBe(302);
    expect(head.headers.get("location")).toBe(`http://ryke.test/preview/${convert.name}/head/${keep}`);
  });
});

// Every train candidate is a fork `<repo>--<txn>`, and forks are never registered themselves: the
// repo they belong to decides whether they may be previewed.
describe("previews of forks", () => {
  const APP = 'export default { fetch: () => new Response("fork app") };';

  it("serves a fork of a known repo by sha", async () => {
    const app = await plant({ "src/index.ts": APP });
    const fork = `${app.name}--t_abc123`;
    await store.fork(app.name, fork);
    const r = await get(`/preview/${fork}/${app.sha}/`);
    expect(r.status).toBe(200);
    expect(r.text).toBe("fork app");
    expect(r.headers.get("x-ryke-preview")).toBe(`${fork}@${app.sha}`);
  });

  it("is 404 for a fork of a repo Ryke does not know", async () => {
    const stray = unique("pv");
    await store.create(stray);
    const sha = await commitTo(stray, { "src/index.ts": APP });
    const fork = `${stray}--t_abc123`;
    await store.fork(stray, fork);
    const r = await get(`/preview/${fork}/${sha}/`);
    expect(r.status).toBe(404);
    expect(json(r).error).toContain("not initialised");
  });

  it("has no `head` for a fork, only the trunk has one", async () => {
    const app = await plant({ "src/index.ts": APP });
    const fork = `${app.name}--t_abc123`;
    await store.fork(app.name, fork);
    const r = await get(`/preview/${fork}/head/`);
    expect(r.status).toBe(404);
    expect(json(r).error).toContain("trunk");
  });

  it("takes a repo whose own name contains -- for a repo, not a fork", async () => {
    const name = `${unique("pv")}--dd`;
    await store.create(name);
    await registerRepo(env, name);
    const sha = await commitTo(name, { "src/index.ts": APP });
    const r = await get(`/preview/${name}/${sha}/`);
    expect(r.status).toBe(200);
    expect(r.text).toBe("fork app");
  });
});

describe("what is not a preview", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const malformed: [string, string][] = [
    ["a short sha", "abc"],
    ["39 hex digits", sha.slice(1)],
    ["41 hex digits", `${sha}0`],
    ["40 characters that are not all hex", `${sha.slice(0, 39)}g`],
    ["upper-case hex", sha.toUpperCase()],
    ["the word HEAD in capitals", "HEAD"],
    ["a branch name", "main"],
  ];
  it.each(malformed)("404 for a malformed sha: %s", async (_label, ref) => {
    const r = await get(`/preview/${convert.name}/${ref}/`);
    expect(r.status).toBe(404);
    expect(json(r).error).toContain("40-hex");
    expect(r.headers.get("x-ryke-preview")).toBeNull();
  });

  it.each([
    ["upper case", "Convert"],
    ["a dot", "a.b"],
    ["a leading dash", "-x"],
    ["an encoded slash", "a%2Fb"],
    ["an underscore outside a fork suffix", "re_po"],
    ["the reserved index", "__index"],
    ["41 characters plus a fork suffix that is too long", `${"a".repeat(42)}--t_abc`],
    ["a fork of an invalid repo", "Bad--t_abc"],
    ["a fork suffix with nothing before it", "--t_abc"],
  ])("422 for a malformed repo name, touching no Ledger: %s", async (_label, repo) => {
    const touched: string[] = [];
    const e = Object.create(env, { LEDGER: { value: { idFromName: (n: string) => n, get: (n: string) => (touched.push(n), {}) } } }) as Env;
    for (const ref of [sha, "head"]) {
      const r = await previewFetch(new Request(`http://ryke.test/preview/${repo}/${ref}/`), e);
      expect(r.status, ref).toBe(422);
      expect(((await r.json()) as Json).error, ref).toContain("repo name");
    }
    expect(touched).toEqual([]);
  });

  it("404 for paths with no sha segment", async () => {
    for (const path of ["/preview", "/preview/", `/preview/${convert.name}`, `/preview/${convert.name}/`]) {
      const r = await previewFetch(new Request(`http://ryke.test${path}`), env);
      expect(r.status).toBe(404);
      expect(((await r.json()) as { error: string }).error).toContain("preview path");
    }
  });

  it("404 for an unknown repo, by sha and by head, without touching its Ledger or the store", async () => {
    const name = unique("nope");
    const touched: string[] = [];
    const registry = { indexGet: async () => null };
    const e = Object.create(env, {
      LEDGER: { value: { idFromName: (n: string) => n, get: (n: string) => (touched.push(n), n === "__index" ? registry : {}) } },
      RYKE_STORE_URL: { value: env.RYKE_TEST_GIT_URL },
    }) as Env;
    for (const ref of [sha, "head"]) {
      const r = await previewFetch(new Request(`http://ryke.test/preview/${name}/${ref}/`), e);
      expect(r.status, ref).toBe(404);
      const error = ((await r.json()) as Json).error as string;
      expect(error, ref).toContain(name);
      expect(error, ref).toContain("not initialised");
    }
    expect(new Set(touched)).toEqual(new Set(["__index"]));
  });

  it("404 for a repo that exists in the store but that Ryke does not know, by sha as well", async () => {
    const stray = unique("pv");
    await store.create(stray);
    const straySha = await commitTo(stray, { "src/index.ts": 'export default { fetch: () => new Response("stray") };' });
    for (const ref of [straySha, "head"]) {
      const r = await get(`/preview/${stray}/${ref}/`);
      expect(r.status, ref).toBe(404);
      expect(json(r).error, ref).toContain("not initialised");
    }
  });

  it("404 for a repo that is registered but has no Ledger when asked for head", async () => {
    const name = unique("pv");
    await store.create(name);
    await registerRepo(env, name);
    const r = await get(`/preview/${name}/head/`);
    expect(r.status).toBe(404);
    expect(json(r).error).toContain("not initialised");
  });

  it("404 for a repo that has a store but no Ledger when asked for head", async () => {
    const r = await get(`/preview/${fixture.name}/head/`);
    expect(r.status).toBe(404);
  });

  it("404 for a sha that is not in the repo", async () => {
    const r = await get(`/preview/${convert.name}/${sha}/`);
    expect(r.status).toBe(404);
    expect(json(r).error).toBeTruthy();
    expect(r.headers.get("x-ryke-preview")).toBeNull();
  });

  it("404 for a commit that has no entry point", async () => {
    await registerRepo(env, fixture.name);
    const r = await get(`/preview/${fixture.name}/${fixture.commits[0]}/`);
    expect(r.status).toBe(404);
    expect(json(r).error).toContain("no preview entry point src/index.ts");
  });

  it("503 when the store fails and the commit is not cached", async () => {
    // The git helper listens on a port that is up but is not a store, so every store call fails.
    const down = Object.create(env, { RYKE_STORE_URL: { value: env.RYKE_TEST_GIT_URL } }) as Env;
    const r = await previewFetch(new Request(`http://ryke.test/preview/${convert.name}/${sha}/`), down);
    expect(r.status).toBe(503);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(await r.text()).error).toContain("store answered");
  });

  it("502 text, not a thrown error, when something unexpected fails", async () => {
    const broken = Object.create(env, { LOADER: { value: undefined } }) as Env;
    const r = await previewFetch(new Request(`http://ryke.test/preview/${convert.name}/${convert.head}/`), broken);
    expect(r.status).toBe(502);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(await r.text()).toContain(`${convert.name}@${convert.head.slice(0, 7)}`);
  });
});

describe("which files make the app and where it starts", () => {
  const index = (what: string) => `export default { fetch: () => new Response(${JSON.stringify(what)}) };`;
  type Row = [label: string, files: Record<string, string>, status: number, contains: string];
  const rows: Row[] = [
    ["src/index.ts by default", { "src/index.ts": index("default") }, 200, "default"],
    ["preview.main from ryke.json", { "ryke.json": '{"preview":{"main":"src/app.ts"}}', "src/index.ts": index("default"), "src/app.ts": index("app") }, 200, "app"],
    ["a main outside src/", { "ryke.json": '{"preview":{"main":"server.ts"}}', "server.ts": index("root") }, 200, "root"],
    ["a ryke.json with no preview section", { "ryke.json": '{"verify":"true"}', "src/index.ts": index("default") }, 200, "default"],
    ["a ryke.json that is not JSON", { "ryke.json": "{ nope", "src/index.ts": index("default") }, 200, "default"],
    ["a preview.main that is not a string", { "ryke.json": '{"preview":{"main":7}}', "src/index.ts": index("default") }, 200, "default"],
    ["a preview.main that escapes the repo", { "ryke.json": '{"preview":{"main":"../x.ts"}}', "src/index.ts": index("default") }, 200, "default"],
    ["a ryke.json that is JSON null", { "ryke.json": "null", "src/index.ts": index("default") }, 200, "default"],
    ["package.json as an import", { "package.json": '{"name":"from-package"}', "src/index.ts": 'import pkg from "../package.json";\nexport default { fetch: () => new Response(pkg.name) };' }, 200, "from-package"],
    ["a preview.main that is missing", { "ryke.json": '{"preview":{"main":"src/missing.ts"}}', "src/index.ts": index("default") }, 404, "no preview entry point src/missing.ts"],
    ["no src/index.ts and no config", { "src/other.ts": index("other") }, 404, "no preview entry point src/index.ts"],
    // The bundler leaves a specifier it cannot resolve for the runtime to reject, so these surface as load failures.
    ["an import of a file outside src/", { "lib/x.ts": "export const x = 1;", "src/index.ts": 'import { x } from "../lib/x.ts";\nexport default { fetch: () => new Response(String(x)) };' }, 502, "../lib/x.ts"],
    ["an import of a file that does not exist", { "src/index.ts": 'import "./nope.ts";\nexport default { fetch: () => new Response("x") };' }, 502, "nope.ts"],
    ["a syntax error", { "src/index.ts": "export default { fetch( {" }, 502, "could not be bundled"],
    ["an error while the Worker starts", { "src/index.ts": 'throw new Error("boom at load");\nexport default { fetch: () => new Response("x") };' }, 502, "failed to run"],
  ];
  it.each(rows)("%s", async (_label, files, status, contains) => {
    const app = await plant(files);
    const r = await get(`/preview/${app.name}/${app.sha}/`);
    expect(r.status).toBe(status);
    expect(r.text).toContain(contains);
    if (status === 200) expect(r.headers.get("x-ryke-preview")).toBe(`${app.name}@${app.sha}`);
    if (status === 502) expect(r.headers.get("content-type")).toContain("text/plain");
    if (status === 404) expect(r.headers.get("content-type")).toContain("application/json");
  });

  it("names the bundler's complaint in the 502 so an agent can fix it", async () => {
    const app = await plant({ "src/index.ts": "export default { fetch( {" });
    const r = await get(`/preview/${app.name}/${app.sha}/`);
    expect(r.status).toBe(502);
    expect(r.text).toContain(`${app.name}@${app.sha.slice(0, 7)}`);
    expect(r.text).toContain("src/index.ts:1");
  });

  it("serves the fixed commit after a broken one, because each commit has its own bundle", async () => {
    const app = await plant({ "src/index.ts": "export default { fetch( {" });
    const fixed = await commitTo(app.name, { "src/index.ts": index("fixed") });
    expect((await get(`/preview/${app.name}/${app.sha}/`)).status).toBe(502);
    const r = await get(`/preview/${app.name}/${fixed}/`);
    expect(r.status).toBe(200);
    expect(r.text).toBe("fixed");
  });
});

describe("the bundle cache", () => {
  it("bundles a commit once and serves later requests from memory", async () => {
    const app = await plant({ "src/index.ts": 'export default { fetch: () => new Response("cached") };' });
    const path = `/preview/${app.name}/${app.sha}/`;
    const start = bundleCount();
    expect((await get(path)).text).toBe("cached");
    expect(bundleCount()).toBe(start + 1);
    expect((await get(path)).text).toBe("cached");
    expect((await get(`${path}other`)).text).toBe("cached");
    expect(bundleCount()).toBe(start + 1);
  });

  it("keys by repo and commit: another commit of the same repo is another bundle", async () => {
    const app = await plant({ "src/index.ts": 'export default { fetch: () => new Response("one") };' });
    const next = await commitTo(app.name, { "src/index.ts": 'export default { fetch: () => new Response("two") };' });
    const start = bundleCount();
    expect((await get(`/preview/${app.name}/${app.sha}/`)).text).toBe("one");
    expect((await get(`/preview/${app.name}/${next}/`)).text).toBe("two");
    expect(bundleCount()).toBe(start + 2);
  });

  it("resolves `head` to a commit first, so it shares the bundle of that commit", async () => {
    const start = bundleCount();
    await get(`/preview/${convert.name}/${convert.head}/`);
    await get(`/preview/${convert.name}/head/`);
    expect(bundleCount()).toBeLessThanOrEqual(start + 1);
    const settled = bundleCount();
    await get(`/preview/${convert.name}/head/c/mass`);
    expect(bundleCount()).toBe(settled);
  });

  it(`keeps ${MAX_BUNDLES} bundles and drops the oldest first`, async () => {
    const tiny = await plant({ "src/index.ts": 'export default { fetch: () => new Response("tiny") };' });
    const open = async (repo: string) => {
      const r = await get(`/preview/${repo}/${tiny.sha}/`);
      expect(r.text).toBe("tiny");
    };
    // Forks carry the same commit, so each one is a new cache key without a new bundle to write.
    const fork = async () => {
      const name = unique("pv");
      await store.fork(tiny.name, name);
      await registerRepo(env, name);
      return name;
    };
    await open(tiny.name);
    const afterFirst = bundleCount();
    for (let i = 0; i < MAX_BUNDLES - 1; i++) await open(await fork());
    expect(bundleCount()).toBe(afterFirst + MAX_BUNDLES - 1);

    // 32 entries are held, and the first is still among them: a hit does not move it.
    await open(tiny.name);
    expect(bundleCount()).toBe(afterFirst + MAX_BUNDLES - 1);

    // One more key pushes out the oldest, which is the first.
    const last = await fork();
    await open(last);
    expect(bundleCount()).toBe(afterFirst + MAX_BUNDLES);
    await open(last);
    expect(bundleCount()).toBe(afterFirst + MAX_BUNDLES);
    await open(tiny.name);
    expect(bundleCount()).toBe(afterFirst + MAX_BUNDLES + 1);
  }, SLOW);
});
