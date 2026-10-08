// Integration suite for dev/store: a real store on an ephemeral port, the real git CLI as the
// client, and a capture server standing in for the Ryke worker's /internal/events.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startStore } from "../../dev/store/server.mjs";
import { verifyTrunk } from "../../harness/lib/report.mjs";

const INDEX_MJS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../dev/store/index.mjs");
const SECRET = "test-internal-secret";
const ZEROS = "0".repeat(40);
const HASH = /^[0-9a-f]{40}$/;
const AUTHOR = "Ada Lovelace <ada@example.com>";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ryke-store-test-"));
const gitHome = path.join(root, "home");
await fs.mkdir(gitHome);
after(() => fs.rm(root, { recursive: true, force: true }));

let counter = 0;
const uniq = (prefix) => `${prefix}${++counter}`;
const freshDir = (label) => fs.mkdtemp(path.join(root, `${label}-`));

// ---- git client helpers ----------------------------------------------------------------

// A clean environment: no developer config, no proxy variables, no prompts.
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: gitHome,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

// Async on purpose: the store runs in this process, so a blocking git call would deadlock it.
function git(args, { cwd, env = {}, config = [], input } = {}) {
  const full = [
    "-c", "user.name=Ada Lovelace",
    "-c", "user.email=ada@example.com",
    "-c", "commit.gpgsign=false",
    ...config.flatMap((c) => ["-c", c]),
    ...args,
  ];
  return new Promise((resolve) => {
    const child = spawn("git", full, { cwd, env: { ...GIT_ENV, ...env } });
    // A wedged git must fail the test, not hang the run.
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("close", (code) => {
      clearTimeout(watchdog);
      resolve({
        ok: code === 0,
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}

async function gitOk(args, opts) {
  const result = await git(args, opts);
  assert.ok(result.ok, `git ${args.join(" ")} failed (${result.code}): ${result.stderr}`);
  return result.stdout.trim();
}

async function newWork(label) {
  const dir = await freshDir(label);
  await gitOk(["init", "-q", "-b", "main", dir]);
  return dir;
}

// files: path -> content, or null to delete. Dates are fixed so tests can assert `at`.
async function commit(dir, files, message, date = 1_700_000_000) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    if (content === null) {
      await fs.rm(target);
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  await gitOk(["add", "-A"], { cwd: dir });
  const stamp = `${date} +0000`;
  await gitOk(["commit", "-q", "-m", message], { cwd: dir, env: { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } });
  return gitOk(["rev-parse", "HEAD"], { cwd: dir });
}

// `git fast-import` stream of `count` linear commits on `ref`, messages c1..cN.
function fastImportStream({ ref, count, from, time = 1_700_000_000 }) {
  let stream = "";
  for (let i = 1; i <= count; i++) {
    const message = `c${i}`;
    const content = `v${i}\n`;
    stream += `commit ${ref}\nmark :${i}\ncommitter Bot <bot@example.com> ${time + i} +0000\n`;
    stream += `data ${message.length}\n${message}\n`;
    if (i === 1 && from) stream += `from ${from}\n`;
    if (i > 1) stream += `from :${i - 1}\n`;
    stream += `M 100644 inline f.txt\ndata ${content.length}\n${content}\n\n`;
  }
  return stream;
}

const fastImport = (dir, options) =>
  gitOk(["fast-import", "--quiet"], { cwd: dir, input: fastImportStream(options) });

const secretOf = (token) => token.split("?")[0];
// Basic auth: the username is ignored, the password is the token without ?expires.
const withBasic = (remote, token, user = "git") => remote.replace("http://", `http://${user}:${secretOf(token)}@`);
const bearer = (token) => `http.extraHeader=Authorization: Bearer ${token}`;

// ---- HTTP helpers ----------------------------------------------------------------------

// node:http with a throwaway agent: no keep-alive sockets and no environment proxy.
function request(baseUrl, method, target, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(target, baseUrl), { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${target} timed out`)));
    req.end(body);
  });
}

function controlApi(store, secret = SECRET) {
  return (method, target, body) =>
    request(store.url, method, target, {
      headers: { "content-type": "application/json", "x-ryke-internal": secret },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
}

// Stands in for the worker's /internal/events. `hang` accepts the request and never answers.
async function startCapture({ hang = false } = {}) {
  const events = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      events.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      if (!hang) {
        res.writeHead(200);
        res.end("ok");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    events,
    url: `http://127.0.0.1:${server.address().port}/internal/events`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withStore(options, fn) {
  const store = await startStore({ port: 0, internalSecret: SECRET, ...options });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

const sortedKeys = (o) => Object.keys(o).sort();

// ---- shared fixtures -------------------------------------------------------------------

const sharedState = await freshDir("state-shared");
const capture = await startCapture();
const events = capture.events;
const store = await startStore({ port: 0, stateDir: sharedState, eventsUrl: capture.url, internalSecret: SECRET });
const api = controlApi(store);
after(async () => {
  await store.close();
  await capture.close();
});

const remoteOf = (name) => `${store.url}/git/ryke/${name}.git`;
const repoPath = (name) => path.join(sharedState, "store", "ryke", `${name}.git`);

async function makeRepo(name) {
  const res = await api("POST", "/v1/repos", { name });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function getToken(name, scope = "write", ttl = 600) {
  const res = await api("POST", `/v1/repos/${name}/tokens`, { scope, ttl });
  assert.equal(res.status, 201, res.text);
  return res.json.token;
}

async function pushTo(work, name, token, refspecs, extra = []) {
  return git(["push", ...extra, withBasic(remoteOf(name), token), ...refspecs], { cwd: work });
}

async function pushOk(work, name, token, refspecs, extra) {
  const result = await pushTo(work, name, token, refspecs, extra);
  assert.ok(result.ok, `push failed: ${result.stderr}`);
  return result;
}

// A repo with one pushed commit; returns everything a test needs to keep going.
async function repoWithCommit(prefix, files = { "a.txt": "one\n" }) {
  const name = uniq(prefix);
  await makeRepo(name);
  const token = await getToken(name);
  const work = await newWork(name);
  const sha = await commit(work, files, "first");
  await pushOk(work, name, token, ["main"]);
  return { name, token, work, sha };
}

// =========================================================================================
// Control API
// =========================================================================================

describe("startStore", () => {
  test("returns the real url and port of an ephemeral listener", async () => {
    assert.ok(store.port > 0);
    assert.equal(store.url, `http://127.0.0.1:${store.port}`);
    const res = await request(store.url, "GET", "/v1/health");
    assert.equal(res.status, 200);
  });

  test("resolves a relative stateDir against the working directory", async () => {
    const dir = await freshDir("state-relative");
    const relative = path.relative(process.cwd(), dir);
    assert.ok(!path.isAbsolute(relative));
    await withStore({ stateDir: relative }, async (s) => {
      const res = await controlApi(s)("POST", "/v1/repos", { name: "rel" });
      assert.equal(res.status, 201);
    });
    const stat = await fs.stat(path.join(dir, "store", "ryke", "rel.git", "HEAD"));
    assert.ok(stat.isFile());
  });

  test("honours a custom namespace in repo paths and remotes", async () => {
    const dir = await freshDir("state-ns");
    await withStore({ stateDir: dir, namespace: "other" }, async (s) => {
      const res = await controlApi(s)("POST", "/v1/repos", { name: "x" });
      assert.equal(res.json.remote, `${s.url}/git/other/x.git`);
    });
    assert.ok((await fs.stat(path.join(dir, "store", "other", "x.git"))).isDirectory());
  });

  test("rejects a namespace that cannot be a path segment", async () => {
    await assert.rejects(startStore({ port: 0, stateDir: await freshDir("state-badns"), namespace: "a/b" }), /invalid namespace/);
  });

  test("fails to start when the port is taken", async () => {
    await assert.rejects(startStore({ port: store.port, stateDir: await freshDir("state-busy") }), /EADDRINUSE/);
  });

  test("refuses to start on a corrupt tokens.json instead of silently dropping tokens", async () => {
    const dir = await freshDir("state-corrupt");
    await fs.mkdir(path.join(dir, "store"), { recursive: true });
    await fs.writeFile(path.join(dir, "store", "tokens.json"), "{not json");
    await assert.rejects(startStore({ port: 0, stateDir: dir }), /cannot load .*tokens\.json/);
  });

  test("close stops listening and may be called twice", async () => {
    const s = await startStore({ port: 0, stateDir: await freshDir("state-close") });
    try {
      assert.equal((await request(s.url, "GET", "/v1/health")).status, 200);
    } finally {
      await Promise.all([s.close(), s.close()]);
    }
    await assert.rejects(request(s.url, "GET", "/v1/health"), /ECONNREFUSED/);
    await s.close();
  });
});

describe("control API: health and routing", () => {
  test("GET /v1/health", async () => {
    const res = await api("GET", "/v1/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  });

  test("unknown routes and wrong methods are 404 NOT_FOUND", async () => {
    const cases = [
      ["GET", "/"],
      ["GET", "/v2/repos"],
      ["GET", "/v1/nothing"],
      ["GET", "/v1/repos"],
      ["POST", "/v1/health"],
      ["PUT", "/v1/repos/x"],
      ["GET", "/v1/repos/x/unknown"],
      ["POST", "/v1/repos/x/log"],
      ["GET", "/v1/repos/x/log/extra"],
    ];
    for (const [method, target] of cases) {
      const res = await api(method, target);
      assert.equal(res.status, 404, `${method} ${target}`);
      assert.equal(res.json.error.code, "NOT_FOUND", `${method} ${target}`);
      assert.equal(typeof res.json.error.message, "string");
    }
  });

  test("malformed percent-encoding is 400 INVALID", async () => {
    const res = await api("GET", "/v1/repos/%E0%A4%A");
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "INVALID");
  });
});

// The control API creates repos, mints push tokens and deletes repos. Process-mode jobs run candidate
// code on the same host and can reach this port, so it takes the internal secret that only the Worker
// (and the harness, which the operator starts) holds.
describe("control API: internal secret", () => {
  const authFailures = {
    "no header": {},
    "an empty header": { "x-ryke-internal": "" },
    "a wrong secret": { "x-ryke-internal": "wrong-secret" },
    "the secret with a character appended": { "x-ryke-internal": `${SECRET}x` },
    "a prefix of the secret": { "x-ryke-internal": SECRET.slice(0, -1) },
    "the secret in another case": { "x-ryke-internal": SECRET.toUpperCase() },
    "the secret as a bearer token": { authorization: `Bearer ${SECRET}` },
    "the secret as basic auth": { authorization: `Basic ${Buffer.from(`git:${SECRET}`).toString("base64")}` },
  };
  const routes = [
    ["POST", "/v1/repos", { name: "x" }],
    ["GET", "/v1/repos/x"],
    ["DELETE", "/v1/repos/x"],
    ["POST", "/v1/repos/x/fork", { name: "y" }],
    ["POST", "/v1/repos/x/tokens", { scope: "read", ttl: 60 }],
    ["GET", "/v1/repos/x/log"],
    ["GET", "/v1/repos/x/file?ref=main&path=a"],
    ["GET", "/v1/repos/x/files"],
    ["GET", "/v1/repos/x/diff?base=a&head=b"],
    // Unknown routes and wrong methods are refused before they are told apart from real ones.
    ["GET", "/v1/nothing"],
    ["POST", "/v1/health"],
    ["PUT", "/v1/repos/x"],
  ];

  test("every /v1 route except GET /v1/health answers 401 UNAUTHORIZED without the secret", async () => {
    for (const [method, target, body] of routes) {
      for (const [label, extra] of Object.entries(authFailures)) {
        const res = await request(store.url, method, target, {
          headers: { "content-type": "application/json", ...extra },
          body: body && JSON.stringify(body),
        });
        assert.equal(res.status, 401, `${method} ${target} with ${label}`);
        assert.equal(res.json.error.code, "UNAUTHORIZED", `${method} ${target} with ${label}`);
        assert.match(res.json.error.message, /internal secret/, `${method} ${target} with ${label}`);
      }
    }
  });

  test("a refused call changes nothing", async () => {
    const name = uniq("sec");
    await makeRepo(name);
    const before = (await getToken(name, "read")).split("?")[0];
    const stored = async () => JSON.parse(await fs.readFile(path.join(sharedState, "store", "tokens.json"), "utf8"));
    const tokensBefore = Object.keys(await stored()).length;

    const created = await request(store.url, "POST", "/v1/repos", { headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `${name}-new` }) });
    assert.equal(created.status, 401);
    await assert.rejects(fs.stat(repoPath(`${name}-new`)), { code: "ENOENT" });

    const minted = await request(store.url, "POST", `/v1/repos/${name}/tokens`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "write", ttl: 600 }) });
    assert.equal(minted.status, 401);
    assert.equal(Object.keys(await stored()).length, tokensBefore);
    assert.ok((await stored())[before]);

    const forked = await request(store.url, "POST", `/v1/repos/${name}/fork`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `${name}-fork` }) });
    assert.equal(forked.status, 401);
    await assert.rejects(fs.stat(repoPath(`${name}-fork`)), { code: "ENOENT" });

    assert.equal((await request(store.url, "DELETE", `/v1/repos/${name}`)).status, 401);
    assert.ok((await fs.stat(repoPath(name))).isDirectory());
  });

  test("the right secret opens the routes", async () => {
    for (const [method, target, body] of routes) {
      const res = await request(store.url, method, target, {
        headers: { "content-type": "application/json", "x-ryke-internal": SECRET },
        body: body && JSON.stringify(body),
      });
      assert.notEqual(res.status, 401, `${method} ${target}`);
    }
  });

  test("GET /v1/health needs no secret, so supervisors can probe the store", async () => {
    const res = await request(store.url, "GET", "/v1/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  });

  test("the secret is not a repo token: git smart HTTP still wants a token", async () => {
    const { name } = await repoWithCommit("secgit");
    for (const headers of [{ "x-ryke-internal": SECRET }, { authorization: `Bearer ${SECRET}` }]) {
      const res = await request(store.url, "GET", `/git/ryke/${name}.git/info/refs?service=git-upload-pack`, { headers });
      assert.equal(res.status, 401, JSON.stringify(headers));
    }
  });

  // The swarm's closing trunk check reads the store directly; without the header its report said the
  // trunk tests failed although the trunk was green.
  test("the harness's trunk check carries the secret, the dev default or the one it is given", async () => {
    const { name } = await repoWithCommit("trunkcheck", { "a.txt": "one\n" });
    for (const [secret, expected] of [[undefined, "dev"], ["given-secret", "given-secret"]]) {
      const seen = [];
      const spy = (url, init) => {
        seen.push([init?.method ?? "GET", new URL(url).pathname, init?.headers?.["x-ryke-internal"]]);
        return Promise.resolve(Response.json({ token: "x" }));
      };
      const saved = process.env.RYKE_INTERNAL_SECRET;
      delete process.env.RYKE_INTERNAL_SECRET;
      try {
        await verifyTrunk({ storeUrl: store.url, repo: name, head: null, verify: "true", fetchImpl: spy, ...(secret ? { secret } : {}) });
      } finally {
        if (saved !== undefined) process.env.RYKE_INTERNAL_SECRET = saved;
      }
      assert.deepEqual(seen, [
        ["GET", `/v1/repos/${name}`, expected],
        ["POST", `/v1/repos/${name}/tokens`, expected],
      ]);
    }
  });

  test("a store started with another secret wants that one", async () => {
    await withStore({ stateDir: await freshDir("state-secret"), internalSecret: "other-secret" }, async (s) => {
      const body = JSON.stringify({ name: "x" });
      const headers = (secret) => ({ "content-type": "application/json", "x-ryke-internal": secret });
      assert.equal((await request(s.url, "POST", "/v1/repos", { headers: headers(SECRET), body })).status, 401);
      assert.equal((await request(s.url, "POST", "/v1/repos", { headers: headers("other-secret"), body })).status, 201);
    });
  });
});

describe("control API: create", () => {
  test("201 with name, remote and default branch; the repo is bare, configured and hooked", async () => {
    const name = uniq("create");
    const res = await api("POST", "/v1/repos", { name, description: "a test repo" });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { name, remote: `${store.url}/git/ryke/${name}.git`, defaultBranch: "main" });

    const dir = repoPath(name);
    assert.equal(await gitOk(["--git-dir", dir, "config", "--get", "core.bare"]), "true");
    assert.equal((await fs.readFile(path.join(dir, "HEAD"), "utf8")).trim(), "ref: refs/heads/main");
    assert.equal(await gitOk(["--git-dir", dir, "config", "--get", "http.receivepack"]), "true");
    assert.equal(await gitOk(["--git-dir", dir, "config", "--get", "uploadpack.allowanysha1inwant"]), "true");
    assert.equal(await gitOk(["--git-dir", dir, "config", "--get", "uploadpack.allowreachablesha1inwant"]), "true");
    assert.equal((await fs.readFile(path.join(dir, "description"), "utf8")).trim(), "a test repo");

    const hook = path.join(dir, "hooks", "post-receive");
    const script = await fs.readFile(hook, "utf8");
    assert.ok((await fs.stat(hook)).mode & 0o100, "hook must be executable");
    assert.match(script, /^#!\/bin\/sh\n/);
    assert.ok(script.includes("dev/store/hook.mjs"), script);
    // No sample hooks were copied from git's template.
    assert.deepEqual(await fs.readdir(path.join(dir, "hooks")), ["post-receive"]);
  });

  test("a second create of the same name is 409 ALREADY_EXISTS", async () => {
    const name = uniq("dup");
    await makeRepo(name);
    const res = await api("POST", "/v1/repos", { name });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "ALREADY_EXISTS");
  });

  test("names are case sensitive", async () => {
    const lower = uniq("case");
    await makeRepo(lower);
    const res = await api("POST", "/v1/repos", { name: lower.toUpperCase() });
    assert.equal(res.status, 201);
  });

  test("concurrent creates of one name produce exactly one winner", async () => {
    const name = uniq("race");
    const results = await Promise.all(Array.from({ length: 6 }, () => api("POST", "/v1/repos", { name })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
    assert.deepEqual(await fs.readdir(path.join(sharedState, "store", ".tmp")), [], "losers clean up their scratch dirs");
  });

  test("valid name edge cases are accepted", async () => {
    const valid = ["a", "A1", "0abc", "a.b_c-d", "my.git.bak", "a..b", `x${"y".repeat(99)}`];
    for (const name of valid) {
      const res = await api("POST", "/v1/repos", { name });
      assert.equal(res.status, 201, name);
      assert.equal(res.json.name, name);
    }
    assert.equal(valid.at(-1).length, 100, "the longest accepted name is 100 characters");
  });

  test("invalid names are 400 INVALID", async () => {
    const invalid = [
      "", ".hidden", "-lead", "_lead", "a/b", "a b", "a\\b", "x.git", "foo.git", "..", ".", "ünï", "a".repeat(101),
      "a?b", "a#b", "a%2fb",
    ];
    for (const name of invalid) {
      const res = await api("POST", "/v1/repos", { name });
      assert.equal(res.status, 400, JSON.stringify(name));
      assert.equal(res.json.error.code, "INVALID", JSON.stringify(name));
    }
    for (const name of [undefined, null, 123, ["a"], { a: 1 }, true]) {
      const res = await api("POST", "/v1/repos", { name });
      assert.equal(res.status, 400, JSON.stringify(name));
    }
  });

  test("malformed bodies are 400 INVALID", async () => {
    const bodies = ["{not json", "[]", "null", "3", `{"name":"ok","description":5}`, `{"name":"ok","description":["x"]}`];
    for (const body of bodies) {
      const res = await api("POST", "/v1/repos", body);
      assert.equal(res.status, 400, body);
      assert.equal(res.json.error.code, "INVALID", body);
    }
    const empty = await api("POST", "/v1/repos");
    assert.equal(empty.status, 400, "an empty body has no name");
  });

  test("an oversized body is 400 INVALID", async () => {
    const res = await api("POST", "/v1/repos", JSON.stringify({ name: "big", description: "x".repeat(1_200_000) }));
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "INVALID");
  });
});

describe("control API: info", () => {
  test("head is null for an empty repo", async () => {
    const name = uniq("empty");
    const created = await makeRepo(name);
    const res = await api("GET", `/v1/repos/${name}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { name, remote: created.remote, defaultBranch: "main", head: null });
  });

  test("head is the sha of refs/heads/main after a push", async () => {
    const { name, sha } = await repoWithCommit("info");
    const res = await api("GET", `/v1/repos/${name}`);
    assert.equal(res.json.head, sha);
    assert.match(res.json.head, HASH);
  });

  test("head ignores other branches", async () => {
    const name = uniq("branchonly");
    await makeRepo(name);
    const token = await getToken(name);
    const work = await newWork(name);
    await commit(work, { "a.txt": "x" }, "only on side");
    await pushOk(work, name, token, ["main:refs/heads/side"]);
    assert.equal((await api("GET", `/v1/repos/${name}`)).json.head, null);
  });

  test("404 NOT_FOUND for a missing repo, 400 for an invalid name", async () => {
    const missing = await api("GET", "/v1/repos/nope");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "NOT_FOUND");
    const invalid = await api("GET", "/v1/repos/bad.git");
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, "INVALID");
  });
});

describe("control API: remove", () => {
  test("deleted true once, then false; the repo is gone from disk and the API", async () => {
    const name = uniq("rm");
    await makeRepo(name);
    const first = await api("DELETE", `/v1/repos/${name}`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { deleted: true });
    const second = await api("DELETE", `/v1/repos/${name}`);
    assert.equal(second.status, 200);
    assert.deepEqual(second.json, { deleted: false });
    assert.equal((await api("GET", `/v1/repos/${name}`)).status, 404);
    await assert.rejects(fs.stat(repoPath(name)), { code: "ENOENT" });
  });

  test("deleting an unknown name is deleted:false; an invalid name is 400", async () => {
    assert.deepEqual((await api("DELETE", "/v1/repos/never-existed")).json, { deleted: false });
    assert.equal((await api("DELETE", "/v1/repos/x.git")).status, 400);
  });

  test("a removed repo is gone for git clients too", async () => {
    const { name, token } = await repoWithCommit("rmclone");
    await api("DELETE", `/v1/repos/${name}`);
    const dest = path.join(await freshDir("rmclone"), "c");
    const result = await git(["clone", withBasic(remoteOf(name), token), dest]);
    assert.equal(result.ok, false);
    assert.match(result.stderr, /not found/);
  });

  test("tokens of a removed repo do not work on a repo recreated under the same name", async () => {
    const name = uniq("recreate");
    await makeRepo(name);
    const token = await getToken(name);
    await api("DELETE", `/v1/repos/${name}`);
    await makeRepo(name);
    const probe = await request(store.url, "GET", `/git/ryke/${name}.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(probe.status, 401);
    const persisted = JSON.parse(await fs.readFile(path.join(sharedState, "store", "tokens.json"), "utf8"));
    assert.equal(persisted[secretOf(token)], undefined);
  });
});

describe("control API: tokens", () => {
  test("read and write tokens have the Artifacts shape and are persisted", async () => {
    const name = uniq("tok");
    await makeRepo(name);
    for (const scope of ["read", "write"]) {
      const issuedAt = Math.floor(Date.now() / 1000);
      const res = await api("POST", `/v1/repos/${name}/tokens`, { scope, ttl: 3600 });
      assert.equal(res.status, 201);
      assert.deepEqual(sortedKeys(res.json), ["expiresAt", "scope", "token"]);
      assert.equal(res.json.scope, scope);
      const match = /^(art_v1_[0-9a-f]{40})\?expires=(\d+)$/.exec(res.json.token);
      assert.ok(match, res.json.token);
      const expires = Number(match[2]);
      assert.ok(expires >= issuedAt + 3600 && expires <= issuedAt + 3602, `expires ${expires} vs ${issuedAt}`);
      assert.equal(res.json.expiresAt, new Date(expires * 1000).toISOString());

      const persisted = JSON.parse(await fs.readFile(path.join(sharedState, "store", "tokens.json"), "utf8"));
      assert.deepEqual(persisted[match[1]], { namespace: "ryke", repo: name, scope, expires });
    }
  });

  test("every token is distinct", async () => {
    const name = uniq("tokdistinct");
    await makeRepo(name);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => getToken(name)));
    assert.equal(new Set(tokens.map(secretOf)).size, 5);
  });

  test("ttl bounds: 1 and 31536000 are accepted", async () => {
    const name = uniq("tokttl");
    await makeRepo(name);
    for (const ttl of [1, 60, 31_536_000]) {
      const res = await api("POST", `/v1/repos/${name}/tokens`, { scope: "read", ttl });
      assert.equal(res.status, 201, String(ttl));
    }
  });

  test("bad scope is 400 INVALID", async () => {
    const name = uniq("tokscope");
    await makeRepo(name);
    for (const scope of ["admin", "", "READ", "Write", undefined, null, 1, ["read"]]) {
      const res = await api("POST", `/v1/repos/${name}/tokens`, { scope, ttl: 60 });
      assert.equal(res.status, 400, JSON.stringify(scope));
      assert.equal(res.json.error.code, "INVALID", JSON.stringify(scope));
    }
  });

  test("bad ttl is 400 INVALID", async () => {
    const name = uniq("tokbadttl");
    await makeRepo(name);
    for (const ttl of [0, -5, 1.5, "60", 31_536_001, null, undefined, [], {}, true]) {
      const res = await api("POST", `/v1/repos/${name}/tokens`, { scope: "read", ttl });
      assert.equal(res.status, 400, JSON.stringify(ttl));
      assert.equal(res.json.error.code, "INVALID", JSON.stringify(ttl));
    }
    assert.equal((await api("POST", `/v1/repos/${name}/tokens`, "{bad")).status, 400);
  });

  test("a missing repo is 404 NOT_FOUND", async () => {
    const res = await api("POST", "/v1/repos/ghost/tokens", { scope: "read", ttl: 60 });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, "NOT_FOUND");
  });
});

// =========================================================================================
// Git smart HTTP: auth
// =========================================================================================

describe("git smart HTTP: authentication", () => {
  let repo;
  let readToken;
  let writeToken;
  let otherRepo;
  let otherToken;
  const advert = (name, headers = {}, service = "git-upload-pack") =>
    request(store.url, "GET", `/git/ryke/${name}.git/info/refs?service=${service}`, { headers });
  const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

  before(async () => {
    ({ name: repo } = await repoWithCommit("auth"));
    readToken = await getToken(repo, "read");
    writeToken = await getToken(repo, "write");
    ({ name: otherRepo, token: otherToken } = await repoWithCommit("authother"));
  });

  test("no credentials: 401 with the Basic challenge", async () => {
    const res = await advert(repo);
    assert.equal(res.status, 401);
    assert.equal(res.headers["www-authenticate"], 'Basic realm="ryke"');
    assert.equal(res.json.error.code, "UNAUTHORIZED");
  });

  test("bad credentials are all 401", async () => {
    const goodSecret = secretOf(readToken);
    const expires = readToken.split("=")[1];
    const unknown = `art_v1_${"a".repeat(40)}`;
    const cases = {
      "unsupported scheme": { authorization: `Digest ${goodSecret}` },
      "bearer with no value": { authorization: "Bearer " },
      "unknown token": { authorization: `Bearer ${unknown}?expires=${expires}` },
      "malformed token": { authorization: "Bearer not-a-token" },
      "uppercase hex": { authorization: `Bearer ${goodSecret.toUpperCase()}?expires=${expires}` },
      "bearer without the expires suffix": { authorization: `Bearer ${goodSecret}` },
      "bearer with a tampered expires": { authorization: `Bearer ${goodSecret}?expires=${Number(expires) + 1000}` },
      "bearer with a malformed query": { authorization: `Bearer ${goodSecret}?foo=1` },
      "bearer with a non-numeric expires": { authorization: `Bearer ${goodSecret}?expires=soon` },
      "token of another repo (bearer)": { authorization: `Bearer ${otherToken}` },
      "token of another repo (basic)": { authorization: basic("git", secretOf(otherToken)) },
      "basic with an empty password": { authorization: basic("git", "") },
      "basic without a colon": { authorization: `Basic ${Buffer.from("nocolon").toString("base64")}` },
      "basic that is not base64": { authorization: "Basic !!!" },
      "basic with a tampered expires": { authorization: basic("git", `${goodSecret}?expires=${Number(expires) + 1000}`) },
    };
    for (const [label, headers] of Object.entries(cases)) {
      const res = await advert(repo, headers);
      assert.equal(res.status, 401, label);
      assert.equal(res.headers["www-authenticate"], 'Basic realm="ryke"', label);
    }
  });

  test("valid tokens are accepted as Bearer, as Basic with any username, and as Basic with the full token", async () => {
    const goodSecret = secretOf(readToken);
    for (const headers of [
      { authorization: `Bearer ${readToken}` },
      { authorization: basic("git", goodSecret) },
      { authorization: basic("whatever-user", goodSecret) },
      { authorization: basic("", goodSecret) },
      { authorization: basic("git", readToken) },
    ]) {
      const res = await advert(repo, headers);
      assert.equal(res.status, 200, headers.authorization);
      assert.equal(res.headers["content-type"], "application/x-git-upload-pack-advertisement");
    }
  });

  test("a read token may not use receive-pack: 403 for the advertisement and for the POST", async () => {
    const headers = { authorization: `Bearer ${readToken}` };
    const adv = await advert(repo, headers, "git-receive-pack");
    assert.equal(adv.status, 403);
    assert.equal(adv.json.error.code, "FORBIDDEN");
    const post = await request(store.url, "POST", `/git/ryke/${repo}.git/git-receive-pack`, {
      headers: { ...headers, "content-type": "application/x-git-receive-pack-request" },
      body: "0000",
    });
    assert.equal(post.status, 403);
  });

  // git http-backend honours the last `service` parameter, so a check that reads the first one lets a
  // read token ask for the receive-pack advertisement (and with it the push protocol's ref list).
  test("a read token may not get the receive-pack advertisement through a repeated service parameter", async () => {
    const headers = { authorization: `Bearer ${readToken}` };
    for (const query of [
      "service=git-upload-pack&service=git-receive-pack",
      "service=git-receive-pack&service=git-upload-pack",
      "service=git-upload-pack&service=git-upload-pack&service=git-receive-pack",
      "service=git-upload-pack&service=git%2Dreceive-pack",
    ]) {
      const res = await request(store.url, "GET", `/git/ryke/${repo}.git/info/refs?${query}`, { headers });
      assert.equal(res.status, 403, query);
      assert.equal(res.json.error.code, "FORBIDDEN", query);
      assert.notEqual(res.headers["content-type"], "application/x-git-receive-pack-advertisement", query);
    }
  });

  test("a repeated upload-pack service parameter is still fine for a read token", async () => {
    const res = await request(store.url, "GET", `/git/ryke/${repo}.git/info/refs?service=git-upload-pack&service=git-upload-pack`, {
      headers: { authorization: `Bearer ${readToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/x-git-upload-pack-advertisement");
  });

  test("a write token may use both services", async () => {
    const headers = { authorization: `Bearer ${writeToken}` };
    const receive = await advert(repo, headers, "git-receive-pack");
    assert.equal(receive.status, 200);
    assert.equal(receive.headers["content-type"], "application/x-git-receive-pack-advertisement");
    assert.equal((await advert(repo, headers)).status, 200);
  });

  test("git: clone with a read token over Basic and over Bearer", async () => {
    const basicDest = path.join(await freshDir("clone"), "c");
    const basicResult = await git(["clone", "-q", withBasic(remoteOf(repo), readToken), basicDest]);
    assert.ok(basicResult.ok, basicResult.stderr);
    assert.equal(await fs.readFile(path.join(basicDest, "a.txt"), "utf8"), "one\n");

    const bearerDest = path.join(await freshDir("clone"), "c");
    const bearerResult = await git(["clone", "-q", remoteOf(repo), bearerDest], { config: [bearer(readToken)] });
    assert.ok(bearerResult.ok, bearerResult.stderr);
    assert.equal(await fs.readFile(path.join(bearerDest, "a.txt"), "utf8"), "one\n");
  });

  test("git: push with a read token is rejected over Basic and over Bearer and changes nothing", async () => {
    const name = uniq("ro");
    await makeRepo(name);
    const token = await getToken(name, "read");
    const work = await newWork(name);
    await commit(work, { "a.txt": "x" }, "nope");
    const viaBasic = await pushTo(work, name, token, ["main"]);
    assert.equal(viaBasic.ok, false);
    assert.match(viaBasic.stderr, /403/);
    const viaBearer = await git(["push", remoteOf(name), "main"], { cwd: work, config: [bearer(token)] });
    assert.equal(viaBearer.ok, false);
    assert.match(viaBearer.stderr, /403/);
    assert.equal((await api("GET", `/v1/repos/${name}`)).json.head, null);
  });

  test("git: no credentials and a token for another repo are rejected", async () => {
    const dest = await freshDir("noauth");
    const anonymous = await git(["clone", "-q", remoteOf(repo), path.join(dest, "a")]);
    assert.equal(anonymous.ok, false);
    assert.match(anonymous.stderr, /terminal prompts disabled|401|Authentication failed/);

    const wrongRepo = await git(["clone", "-q", withBasic(remoteOf(repo), otherToken), path.join(dest, "b")]);
    assert.equal(wrongRepo.ok, false);
    assert.match(wrongRepo.stderr, /401|Authentication failed/);

    const headBefore = (await api("GET", `/v1/repos/${repo}`)).json.head;
    const work = await newWork("noauth-push");
    await commit(work, { "x.txt": "x" }, "x");
    const push = await git(["push", remoteOf(repo), "main"], { cwd: work });
    assert.equal(push.ok, false);
    assert.equal((await api("GET", `/v1/repos/${repo}`)).json.head, headBefore);
  });

  test("an expired token is 401 over Basic, Bearer and git; the same token worked before it expired", async () => {
    const name = uniq("exp");
    await makeRepo(name);
    const token = await getToken(name, "write", 1);
    const live = await advert(name, { authorization: `Bearer ${token}` });
    assert.equal(live.status, 200, "ttl 1 must be usable at once");

    await new Promise((resolve) => setTimeout(resolve, 2200));

    assert.equal((await advert(name, { authorization: `Bearer ${token}` })).status, 401);
    assert.equal((await advert(name, { authorization: basic("git", secretOf(token)) })).status, 401);
    const clone = await git(["clone", "-q", withBasic(remoteOf(name), token), path.join(await freshDir("exp"), "c")]);
    assert.equal(clone.ok, false);
    assert.match(clone.stderr, /401|Authentication failed/);
  });

  test("unknown repos, namespaces and malformed paths are 404 before auth is considered", async () => {
    const headers = { authorization: `Bearer ${readToken}` };
    const paths = [
      "/git/ryke/ghost.git/info/refs?service=git-upload-pack",
      `/git/other-ns/${repo}.git/info/refs?service=git-upload-pack`,
      "/git/ryke/bad.git.git/info/refs?service=git-upload-pack",
      "/git/ryke/-bad.git/info/refs?service=git-upload-pack",
      `/git/ryke/${repo}/info/refs?service=git-upload-pack`,
      "/git/ryke/",
      "/git/",
      `/git/ryke/${repo}.git/%E0%A4%A`,
    ];
    for (const target of paths) {
      for (const h of [headers, {}]) {
        const res = await request(store.url, "GET", target, { headers: h });
        assert.equal(res.status, 404, target);
        assert.equal(res.json.error.code, "NOT_FOUND", target);
      }
    }
  });

  test("other git-http-backend paths need a token too and pass through its status codes", async () => {
    const anonymous = await request(store.url, "GET", `/git/ryke/${repo}.git/HEAD`);
    assert.equal(anonymous.status, 401);
    const head = await request(store.url, "GET", `/git/ryke/${repo}.git/HEAD`, { headers: { authorization: `Bearer ${readToken}` } });
    assert.equal(head.status, 200);
    assert.equal(head.text.trim(), "ref: refs/heads/main");
    // A loose object that does not exist: http-backend's own 404 reaches the client unchanged.
    const missingObject = await request(store.url, "GET", `/git/ryke/${repo}.git/objects/00/${"0".repeat(38)}`, {
      headers: { authorization: `Bearer ${readToken}` },
    });
    assert.equal(missingObject.status, 404);
  });

  test("a damaged repo: http-backend's 500 reaches the client and the control API says 503", async () => {
    const name = uniq("damaged");
    await makeRepo(name);
    const token = await getToken(name, "read");
    await fs.writeFile(path.join(repoPath(name), "config"), "[[[ not a config");
    const smart = await request(store.url, "GET", `/git/ryke/${name}.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(smart.status, 500);
    const control = await api("GET", `/v1/repos/${name}/files`);
    assert.equal(control.status, 503);
    assert.equal(control.json.error.code, "UNAVAILABLE");
  });

  test("a git http-backend that dies without answering is 503 with its stderr", async () => {
    const name = uniq("dies");
    await makeRepo(name);
    const token = await getToken(name, "read");
    // A shim earlier on PATH that behaves like git except for http-backend. The store reads
    // process.env.PATH at every spawn, so this affects the store only, not the git client helper.
    const realGit = (await Promise.all(
      process.env.PATH.split(path.delimiter).map(async (dir) => {
        const candidate = path.join(dir, "git");
        return (await fs.stat(candidate).then((s) => s.isFile(), () => false)) ? candidate : null;
      }),
    )).find(Boolean);
    const shimDir = await freshDir("shim");
    await fs.writeFile(
      path.join(shimDir, "git"),
      `#!/bin/sh\nif [ "$1" = "http-backend" ]; then echo "backend exploded" >&2; exit 1; fi\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
    try {
      const res = await request(store.url, "GET", `/git/ryke/${name}.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, "UNAVAILABLE");
      assert.match(res.json.error.message, /backend exploded/);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// =========================================================================================
// Git smart HTTP: protocol coverage
// =========================================================================================

describe("git smart HTTP: protocol", () => {
  test("clone and fetch work over protocol v0 and v2", async () => {
    const { name, token, work } = await repoWithCommit("proto");
    for (const version of ["0", "2"]) {
      const dest = path.join(await freshDir(`proto${version}`), "c");
      const config = [`protocol.version=${version}`];
      const clone = await git(["clone", "-q", withBasic(remoteOf(name), token), dest], { config, env: { GIT_TRACE_PACKET: "1" } });
      assert.ok(clone.ok, clone.stderr);
      assert.equal(clone.stderr.includes("git< version 2"), version === "2", `v${version} negotiation`);
      assert.equal(await fs.readFile(path.join(dest, "a.txt"), "utf8"), "one\n");

      const sha = await commit(work, { [`next${version}.txt`]: version }, `next ${version}`);
      await pushOk(work, name, token, ["main"]);
      const fetch = await git(["fetch", "-q", "origin"], { cwd: dest, config });
      assert.ok(fetch.ok, fetch.stderr);
      assert.equal(await gitOk(["rev-parse", "origin/main"], { cwd: dest }), sha);
    }
  });

  test("a shallow clone has the requested depth and can be unshallowed", async () => {
    const name = uniq("shallow");
    await makeRepo(name);
    const token = await getToken(name);
    const work = await newWork(name);
    for (let i = 1; i <= 4; i++) await commit(work, { "f.txt": `${i}` }, `c${i}`);
    await pushOk(work, name, token, ["main"]);
    const dest = path.join(await freshDir("shallow"), "c");
    const clone = await git(["clone", "-q", "--depth", "1", withBasic(remoteOf(name), token), dest]);
    assert.ok(clone.ok, clone.stderr);
    assert.equal(await gitOk(["rev-list", "--count", "HEAD"], { cwd: dest }), "1");
    assert.equal(await gitOk(["rev-parse", "--is-shallow-repository"], { cwd: dest }), "true");
    await gitOk(["fetch", "-q", "--unshallow"], { cwd: dest });
    assert.equal(await gitOk(["rev-list", "--count", "HEAD"], { cwd: dest }), "4");
  });

  test("a specific unreachable sha can be fetched on both protocol versions", async () => {
    const name = uniq("anysha");
    await makeRepo(name);
    const token = await getToken(name);
    const work = await newWork(name);
    await commit(work, { "f.txt": "1" }, "base");
    const orphaned = await commit(work, { "f.txt": "2" }, "will be orphaned");
    await pushOk(work, name, token, ["main"]);
    await gitOk(["reset", "-q", "--hard", "HEAD~1"], { cwd: work });
    await commit(work, { "f.txt": "3" }, "replacement");
    await pushOk(work, name, token, ["main"], ["--force"]);

    for (const version of ["0", "2"]) {
      const dir = await freshDir(`anysha${version}`);
      await gitOk(["init", "-q", "-b", "main", dir]);
      const fetch = await git(["fetch", "-q", withBasic(remoteOf(name), token), orphaned], { cwd: dir, config: [`protocol.version=${version}`] });
      assert.ok(fetch.ok, `v${version}: ${fetch.stderr}`);
      assert.equal(await gitOk(["cat-file", "-t", orphaned], { cwd: dir }), "commit");
    }
  });

  test("push: new branches, force push, arbitrary refs, deletes and notes", async () => {
    const name = uniq("pushes");
    await makeRepo(name);
    const token = await getToken(name);
    const work = await newWork(name);
    const c1 = await commit(work, { "a.txt": "1" }, "one");
    const c2 = await commit(work, { "a.txt": "2" }, "two");
    await pushOk(work, name, token, ["main", "main:refs/heads/feature/x", `main:refs/ryke/candidates/x`]);

    const remoteRefs = async () => {
      const out = await gitOk(["ls-remote", withBasic(remoteOf(name), token)]);
      return Object.fromEntries(out.split("\n").map((l) => l.split("\t").reverse()));
    };
    let refs = await remoteRefs();
    assert.equal(refs["refs/heads/main"], c2);
    assert.equal(refs["refs/heads/feature/x"], c2);
    assert.equal(refs["refs/ryke/candidates/x"], c2);

    // Non fast-forward: rewrite history and force it.
    await gitOk(["reset", "-q", "--hard", c1], { cwd: work });
    const rewritten = await commit(work, { "a.txt": "rewritten" }, "rewritten");
    const rejected = await pushTo(work, name, token, ["main"]);
    assert.equal(rejected.ok, false, "a plain non-fast-forward push is refused by git itself");
    await pushOk(work, name, token, ["main"], ["--force"]);
    refs = await remoteRefs();
    assert.equal(refs["refs/heads/main"], rewritten);
    assert.equal((await api("GET", `/v1/repos/${name}`)).json.head, rewritten);

    // Notes live under refs/notes and travel like any other ref.
    await gitOk(["notes", "--ref=ryke", "add", "-m", '{"reads":["a.txt"]}', rewritten], { cwd: work });
    await pushOk(work, name, token, ["refs/notes/ryke"]);
    const reader = path.join(await freshDir("notes"), "c");
    await gitOk(["clone", "-q", withBasic(remoteOf(name), token), reader]);
    await gitOk(["fetch", "-q", "origin", "refs/notes/ryke:refs/notes/ryke"], { cwd: reader });
    assert.equal(await gitOk(["notes", "--ref=ryke", "show", rewritten], { cwd: reader }), '{"reads":["a.txt"]}');

    // Deleting a ref.
    await pushOk(work, name, token, [":refs/ryke/candidates/x"]);
    refs = await remoteRefs();
    assert.equal(refs["refs/ryke/candidates/x"], undefined);
  });

  test("a push larger than git's post buffer is streamed chunked", async () => {
    const name = uniq("large");
    await makeRepo(name);
    const token = await getToken(name);
    const work = await newWork(name);
    // Base64 of random bytes: text, and still ~1.3 MB after zlib, which is over http.postBuffer (1 MB).
    const blob = randomBytes(1_800_000).toString("base64");
    const sha = await commit(work, { "blob.txt": blob }, "large");
    const push = await git(["push", withBasic(remoteOf(name), token), "main"], { cwd: work, env: { GIT_TRACE_CURL: "1" } });
    assert.ok(push.ok, push.stderr);
    assert.match(push.stderr, /Send header: Transfer-Encoding: chunked/, "no Content-Length reaches the store");
    assert.equal((await api("GET", `/v1/repos/${name}`)).json.head, sha);
    const file = await api("GET", `/v1/repos/${name}/file?ref=main&path=blob.txt`);
    assert.equal(file.json.content, blob);
    const dest = path.join(await freshDir("large"), "c");
    await gitOk(["clone", "-q", withBasic(remoteOf(name), token), dest]);
    assert.equal(await fs.readFile(path.join(dest, "blob.txt"), "utf8"), blob);
  });
});

// =========================================================================================
// Push events
// =========================================================================================

describe("push events", () => {
  test("the first push emits the exact Artifacts envelope", async () => {
    const name = uniq("evt");
    await makeRepo(name);
    const token = await getToken(name);
    const work = await newWork(name);
    const c1 = await commit(work, { "a.txt": "1" }, "first", 1_700_000_000);
    const c2 = await commit(work, { "a.txt": "2" }, "second\n\nwith detail", 1_700_000_100);

    events.length = 0;
    const startedAt = Date.now();
    await pushOk(work, name, token, ["main"]);
    assert.equal(events.length, 1);
    const [event] = events;

    assert.equal(event.method, "POST");
    assert.equal(event.url, "/internal/events");
    assert.equal(event.headers["content-type"], "application/json");
    assert.equal(event.headers["x-ryke-internal"], SECRET);

    const body = event.body;
    assert.deepEqual(sortedKeys(body), ["metadata", "payload", "source", "type"]);
    assert.equal(body.type, "cf.artifacts.repo.pushed");
    assert.deepEqual(body.source, { type: "artifacts.repo", namespace: "ryke", repoName: name });
    assert.deepEqual(sortedKeys(body.payload), ["after", "before", "commits", "commitsTruncated", "ref", "totalCommitsCount"]);
    assert.equal(body.payload.ref, "refs/heads/main");
    assert.equal(body.payload.before, ZEROS);
    assert.equal(body.payload.after, c2);
    assert.equal(body.payload.totalCommitsCount, 2);
    assert.equal(body.payload.commitsTruncated, false);
    assert.deepEqual(body.payload.commits, [
      { sha: c2, message: "second\n\nwith detail", author: AUTHOR, at: 1_700_000_100_000 },
      { sha: c1, message: "first", author: AUTHOR, at: 1_700_000_000_000 },
    ]);
    for (const commitEntry of body.payload.commits) {
      assert.deepEqual(sortedKeys(commitEntry), ["at", "author", "message", "sha"]);
    }
    assert.deepEqual(Object.keys(body.metadata), ["eventTimestamp"]);
    const stamp = body.metadata.eventTimestamp;
    assert.equal(new Date(stamp).toISOString(), stamp, "ISO 8601");
    assert.ok(Date.parse(stamp) >= startedAt - 1000 && Date.parse(stamp) <= Date.now() + 1000);
  });

  test("a second push reports only the commits since `before`, newest first", async () => {
    const { name, token, work, sha: c1 } = await repoWithCommit("evt2");
    const c2 = await commit(work, { "b.txt": "b" }, "second", 1_700_000_200);
    const c3 = await commit(work, { "c.txt": "c" }, "third", 1_700_000_300);
    events.length = 0;
    await pushOk(work, name, token, ["main"]);
    assert.equal(events.length, 1);
    const { payload, source } = events[0].body;
    assert.equal(source.repoName, name);
    assert.equal(payload.ref, "refs/heads/main");
    assert.equal(payload.before, c1);
    assert.equal(payload.after, c3);
    assert.deepEqual(payload.commits.map((c) => c.sha), [c3, c2]);
    assert.deepEqual(payload.commits.map((c) => c.message), ["third", "second"]);
    assert.equal(payload.totalCommitsCount, 2);
    assert.equal(payload.commitsTruncated, false);
  });

  test("a force push reports only the commits that were not already reachable from `before`", async () => {
    const { name, token, work, sha: c1 } = await repoWithCommit("evtforce");
    const c2 = await commit(work, { "b.txt": "b" }, "second");
    await pushOk(work, name, token, ["main"]);
    await gitOk(["reset", "-q", "--hard", c1], { cwd: work });
    const replacement = await commit(work, { "b.txt": "other" }, "replacement");
    events.length = 0;
    await pushOk(work, name, token, ["main"], ["--force"]);
    assert.equal(events.length, 1);
    const { payload } = events[0].body;
    assert.equal(payload.before, c2);
    assert.equal(payload.after, replacement);
    assert.deepEqual(payload.commits.map((c) => c.sha), [replacement]);
    assert.equal(payload.totalCommitsCount, 1);
  });

  test("candidate refs and notes refs are announced like branches", async () => {
    const { name, token, work, sha } = await repoWithCommit("evtrefs");
    events.length = 0;
    await pushOk(work, name, token, ["main:refs/ryke/candidates/x"]);
    assert.equal(events.length, 1);
    assert.equal(events[0].body.payload.ref, "refs/ryke/candidates/x");
    assert.equal(events[0].body.payload.before, ZEROS);
    assert.equal(events[0].body.payload.after, sha);

    await gitOk(["notes", "--ref=ryke", "add", "-m", "note", sha], { cwd: work });
    const notesCommit = await gitOk(["rev-parse", "refs/notes/ryke"], { cwd: work });
    events.length = 0;
    await pushOk(work, name, token, ["refs/notes/ryke"]);
    assert.equal(events.length, 1);
    const { payload } = events[0].body;
    assert.equal(payload.ref, "refs/notes/ryke");
    assert.equal(payload.after, notesCommit);
    assert.deepEqual(payload.commits.map((c) => c.sha), [notesCommit]);
    assert.equal(payload.totalCommitsCount, 1);
  });

  test("deleting a ref sends after = 40 zeros and no commits", async () => {
    const { name, token, work, sha } = await repoWithCommit("evtdel");
    await pushOk(work, name, token, ["main:refs/ryke/candidates/gone"]);
    events.length = 0;
    await pushOk(work, name, token, [":refs/ryke/candidates/gone"]);
    assert.equal(events.length, 1);
    const { payload } = events[0].body;
    assert.equal(payload.ref, "refs/ryke/candidates/gone");
    assert.equal(payload.before, sha);
    assert.equal(payload.after, ZEROS);
    assert.deepEqual(payload.commits, []);
    assert.equal(payload.totalCommitsCount, 0);
    assert.equal(payload.commitsTruncated, false);
  });

  test("a new branch reports every commit reachable from its tip", async () => {
    const { name, token, work } = await repoWithCommit("evtbranch");
    const tip = await commit(work, { "b.txt": "b" }, "second");
    await pushOk(work, name, token, ["main"]);
    events.length = 0;
    await pushOk(work, name, token, ["main:refs/heads/copy"]);
    assert.equal(events.length, 1);
    const { payload } = events[0].body;
    assert.equal(payload.before, ZEROS);
    assert.equal(payload.after, tip);
    assert.equal(payload.totalCommitsCount, 2);
    assert.equal(payload.commits.length, 2);
  });

  test("one push of several refs sends one event per ref", async () => {
    const { name, token, work, sha } = await repoWithCommit("evtmulti");
    events.length = 0;
    await pushOk(work, name, token, ["main:refs/heads/one", "main:refs/heads/two", "main:refs/ryke/candidates/three"]);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.body.payload.ref).sort(), [
      "refs/heads/one",
      "refs/heads/two",
      "refs/ryke/candidates/three",
    ]);
    for (const e of events) assert.equal(e.body.payload.after, sha);
  });

  test("a push that is refused emits nothing", async () => {
    const name = uniq("evtnone");
    await makeRepo(name);
    const readToken = await getToken(name, "read");
    const work = await newWork(name);
    await commit(work, { "a.txt": "a" }, "a");
    events.length = 0;
    const result = await pushTo(work, name, readToken, ["main"]);
    assert.equal(result.ok, false);
    assert.equal(events.length, 0);
  });

  test("the hook never fails a push: events disabled, worker down or worker hanging", async () => {
    // Events disabled: skipped silently.
    await withStore({ stateDir: await freshDir("state-noevents"), eventsUrl: "" }, async (s) => {
      const call = controlApi(s);
      assert.equal((await call("POST", "/v1/repos", { name: "quiet" })).status, 201);
      const token = (await call("POST", "/v1/repos/quiet/tokens", { scope: "write", ttl: 60 })).json.token;
      const work = await newWork("quiet");
      await commit(work, { "a.txt": "a" }, "a");
      const result = await git(["push", withBasic(`${s.url}/git/ryke/quiet.git`, token), "main"], { cwd: work });
      assert.ok(result.ok, result.stderr);
      assert.equal(result.stderr.includes("error"), false, result.stderr);
      assert.equal((await call("GET", "/v1/repos/quiet")).json.head, await gitOk(["rev-parse", "HEAD"], { cwd: work }));
    });

    // Worker down: connection refused.
    const dead = await startCapture();
    const deadUrl = dead.url;
    await dead.close();
    await withStore({ stateDir: await freshDir("state-dead"), eventsUrl: deadUrl }, async (s) => {
      const call = controlApi(s);
      await call("POST", "/v1/repos", { name: "dead" });
      const token = (await call("POST", "/v1/repos/dead/tokens", { scope: "write", ttl: 60 })).json.token;
      const work = await newWork("dead");
      const sha = await commit(work, { "a.txt": "a" }, "a");
      const result = await git(["push", withBasic(`${s.url}/git/ryke/dead.git`, token), "main"], { cwd: work });
      assert.ok(result.ok, result.stderr);
      assert.equal((await call("GET", "/v1/repos/dead")).json.head, sha);
    });

    // Worker hangs: the push waits for the 3 s timeout, then succeeds.
    const hung = await startCapture({ hang: true });
    try {
      await withStore({ stateDir: await freshDir("state-hung"), eventsUrl: hung.url }, async (s) => {
        const call = controlApi(s);
        await call("POST", "/v1/repos", { name: "hung" });
        const token = (await call("POST", "/v1/repos/hung/tokens", { scope: "write", ttl: 60 })).json.token;
        const work = await newWork("hung");
        const sha = await commit(work, { "a.txt": "a" }, "a");
        const startedAt = Date.now();
        const result = await git(["push", withBasic(`${s.url}/git/ryke/hung.git`, token), "main"], { cwd: work });
        const elapsed = Date.now() - startedAt;
        assert.ok(result.ok, result.stderr);
        assert.ok(elapsed >= 2900, `push returned after ${elapsed} ms, before the 3 s POST timeout`);
        assert.ok(elapsed < 8000, `push took ${elapsed} ms`);
        assert.equal((await call("GET", "/v1/repos/hung")).json.head, sha);
        assert.equal(hung.events.length, 1, "the event was still delivered to the hung server");
      });
    } finally {
      await hung.close();
    }
  });

  test("the push does not return before the event has been delivered", async () => {
    const slow = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => setTimeout(() => res.end("ok"), 800));
    });
    await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
    try {
      await withStore(
        { stateDir: await freshDir("state-slow"), eventsUrl: `http://127.0.0.1:${slow.address().port}/e` },
        async (s) => {
          const call = controlApi(s);
          await call("POST", "/v1/repos", { name: "slow" });
          const token = (await call("POST", "/v1/repos/slow/tokens", { scope: "write", ttl: 60 })).json.token;
          const work = await newWork("slow");
          await commit(work, { "a.txt": "a" }, "a");
          const startedAt = Date.now();
          const result = await git(["push", withBasic(`${s.url}/git/ryke/slow.git`, token), "main"], { cwd: work });
          assert.ok(result.ok, result.stderr);
          assert.ok(Date.now() - startedAt >= 750, "push returned before the 800 ms POST finished");
        },
      );
    } finally {
      slow.closeAllConnections();
      await new Promise((resolve) => slow.close(resolve));
    }
  });
});

// =========================================================================================
// Fork
// =========================================================================================

describe("fork", () => {
  test("copies the default branch and its history, and nothing else", async () => {
    const { name: source, token, work, sha: c1 } = await repoWithCommit("fsrc");
    const c2 = await commit(work, { "b.txt": "b" }, "second");
    await gitOk(["tag", "v1"], { cwd: work });
    await gitOk(["branch", "extra"], { cwd: work });
    await gitOk(["notes", "--ref=ryke", "add", "-m", "n", c2], { cwd: work });
    await pushOk(work, source, token, ["main", "extra", "refs/tags/v1", "main:refs/ryke/candidates/x", "refs/notes/ryke"]);

    const target = uniq("fdst");
    const res = await api("POST", `/v1/repos/${source}/fork`, { name: target });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { name: target, remote: remoteOf(target), defaultBranch: "main" });

    const info = await api("GET", `/v1/repos/${target}`);
    assert.equal(info.json.head, c2);
    const log = await api("GET", `/v1/repos/${target}/log`);
    assert.deepEqual(log.json.commits.map((c) => c.sha), [c2, c1]);

    const dir = repoPath(target);
    assert.equal(await gitOk(["--git-dir", dir, "for-each-ref", "--format=%(refname)"]), "refs/heads/main");
    assert.equal((await fs.readFile(path.join(dir, "HEAD"), "utf8")).trim(), "ref: refs/heads/main");
    assert.equal((await fs.readFile(path.join(dir, "config"), "utf8")).includes("[remote"), false, "no link back to the source");
    assert.equal(await gitOk(["--git-dir", dir, "config", "--get", "http.receivepack"]), "true");
    assert.equal(await gitOk(["--git-dir", dir, "config", "--get", "uploadpack.allowanysha1inwant"]), "true");
    assert.ok((await fs.stat(path.join(dir, "hooks", "post-receive"))).mode & 0o100);
    assert.deepEqual(await fs.readdir(path.join(dir, "hooks")), ["post-receive"]);

    const forkToken = await getToken(target, "read");
    const clone = path.join(await freshDir("fork"), "c");
    await gitOk(["clone", "-q", withBasic(remoteOf(target), forkToken), clone]);
    assert.equal(await fs.readFile(path.join(clone, "b.txt"), "utf8"), "b");
    assert.equal(
      await gitOk(["for-each-ref", "--format=%(refname)", "refs/remotes"], { cwd: clone }),
      "refs/remotes/origin/HEAD\nrefs/remotes/origin/main",
    );
  });

  test("the fork accepts pushes with its own token and emits events under its own name", async () => {
    const { name: source, work, sha: base } = await repoWithCommit("fpush");
    const target = uniq("fpushdst");
    assert.equal((await api("POST", `/v1/repos/${source}/fork`, { name: target })).status, 201);
    const forkToken = await getToken(target);
    const next = await commit(work, { "agent.txt": "work" }, "agent change");

    events.length = 0;
    await pushOk(work, target, forkToken, ["main"]);
    assert.equal(events.length, 1);
    const { source: envelopeSource, payload } = events[0].body;
    assert.deepEqual(envelopeSource, { type: "artifacts.repo", namespace: "ryke", repoName: target });
    assert.equal(payload.ref, "refs/heads/main");
    assert.equal(payload.before, base);
    assert.equal(payload.after, next);
    assert.deepEqual(payload.commits.map((c) => c.sha), [next]);

    assert.equal((await api("GET", `/v1/repos/${target}`)).json.head, next);
    assert.equal((await api("GET", `/v1/repos/${source}`)).json.head, base, "the source is untouched");
  });

  test("a source token does not work on the fork", async () => {
    const { name: source, token } = await repoWithCommit("ftok");
    const target = uniq("ftokdst");
    await api("POST", `/v1/repos/${source}/fork`, { name: target });
    const res = await request(store.url, "GET", `/git/ryke/${target}.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
  });

  test("the fork keeps working after the source is deleted", async () => {
    const { name: source, sha } = await repoWithCommit("fdel");
    const target = uniq("fdeldst");
    await api("POST", `/v1/repos/${source}/fork`, { name: target });
    assert.deepEqual((await api("DELETE", `/v1/repos/${source}`)).json, { deleted: true });
    assert.equal((await api("GET", `/v1/repos/${target}`)).json.head, sha);
    const token = await getToken(target, "read");
    const clone = await git(["clone", "-q", withBasic(remoteOf(target), token), path.join(await freshDir("fdel"), "c")]);
    assert.ok(clone.ok, clone.stderr);
  });

  test("an empty source forks to an empty repo that can be pushed to", async () => {
    const source = uniq("fempty");
    await makeRepo(source);
    const target = uniq("femptydst");
    const res = await api("POST", `/v1/repos/${source}/fork`, { name: target });
    assert.equal(res.status, 201);
    assert.equal((await api("GET", `/v1/repos/${target}`)).json.head, null);
    const token = await getToken(target);
    const work = await newWork(target);
    const sha = await commit(work, { "a.txt": "a" }, "a");
    await pushOk(work, target, token, ["main"]);
    assert.equal((await api("GET", `/v1/repos/${target}`)).json.head, sha);
  });

  test("a source that has branches but no main forks to an empty repo", async () => {
    const name = uniq("fnomain");
    await makeRepo(name);
    const token = await getToken(name);
    const work = await newWork(name);
    await commit(work, { "a.txt": "a" }, "a");
    await pushOk(work, name, token, ["main:refs/heads/side"]);
    const target = uniq("fnomaindst");
    assert.equal((await api("POST", `/v1/repos/${name}/fork`, { name: target })).status, 201);
    assert.equal((await api("GET", `/v1/repos/${target}`)).json.head, null);
    assert.equal(await gitOk(["--git-dir", repoPath(target), "for-each-ref"]), "");
  });

  test("concurrent forks of one source all succeed and each has the history", async () => {
    const { name: source, sha } = await repoWithCommit("fmany");
    const targets = Array.from({ length: 6 }, () => uniq("fmanydst"));
    const results = await Promise.all(targets.map((name) => api("POST", `/v1/repos/${source}/fork`, { name })));
    assert.deepEqual(results.map((r) => r.status), targets.map(() => 201));
    const infos = await Promise.all(targets.map((name) => api("GET", `/v1/repos/${name}`)));
    assert.deepEqual(infos.map((r) => r.json.head), targets.map(() => sha));
  });

  test("concurrent forks to one target produce one winner", async () => {
    const { name: source } = await repoWithCommit("fsame");
    const target = uniq("fsamedst");
    const results = await Promise.all(Array.from({ length: 4 }, () => api("POST", `/v1/repos/${source}/fork`, { name: target })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409]);
    assert.deepEqual(await fs.readdir(path.join(sharedState, "store", ".tmp")), [], "losers clean up their scratch dirs");
  });

  test("errors: missing source 404, existing target 409, bad names 400", async () => {
    const { name: source } = await repoWithCommit("ferr");
    const taken = uniq("ferrtaken");
    await makeRepo(taken);

    const missing = await api("POST", "/v1/repos/ghost/fork", { name: uniq("ghostdst") });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "NOT_FOUND");

    const exists = await api("POST", `/v1/repos/${source}/fork`, { name: taken });
    assert.equal(exists.status, 409);
    assert.equal(exists.json.error.code, "ALREADY_EXISTS");

    const ontoItself = await api("POST", `/v1/repos/${source}/fork`, { name: source });
    assert.equal(ontoItself.status, 409);

    for (const body of [{ name: "bad name" }, { name: "x.git" }, {}, { name: 5 }, "[]", "{oops"]) {
      const res = await api("POST", `/v1/repos/${source}/fork`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.error.code, "INVALID", JSON.stringify(body));
    }
    assert.equal((await api("POST", "/v1/repos/bad.git/fork", { name: uniq("x") })).status, 400);
    assert.deepEqual(await fs.readdir(path.join(sharedState, "store", ".tmp")), [], "no scratch dirs left behind");
  });
});

// =========================================================================================
// Read endpoints
// =========================================================================================

describe("log, file, files and diff", () => {
  // main: c1 <- change <- rename <- merge, where merge also has the feature commit f1 as a parent.
  let name;
  let token;
  let c1;
  let change;
  let rename;
  let f1;
  let merge;
  let typeChange;

  before(async () => {
    name = uniq("hist");
    await makeRepo(name);
    token = await getToken(name);
    const work = await newWork(name);
    c1 = await commit(
      work,
      { "README.md": "# hello\n", "src/a.txt": "a1\n", "src/b.txt": "b1\n", "docs/old.md": "old\n", "utf8.txt": "héllo ✓\n" },
      "c1: init",
      1_700_000_000,
    );
    await gitOk(["checkout", "-q", "-b", "feature"], { cwd: work });
    f1 = await commit(work, { "feature.txt": "f\n" }, "f1: feature work", 1_700_000_050);
    // A side branch where src/a.txt turns into a symlink, to get a git "T" status.
    await gitOk(["checkout", "-q", "-b", "typechange", c1], { cwd: work });
    await fs.rm(path.join(work, "src/a.txt"));
    await fs.symlink("b.txt", path.join(work, "src/a.txt"));
    await gitOk(["add", "-A"], { cwd: work });
    await gitOk(["commit", "-q", "-m", "a becomes a link"], { cwd: work });
    typeChange = await gitOk(["rev-parse", "HEAD"], { cwd: work });
    await gitOk(["checkout", "-q", "main"], { cwd: work });
    change = await commit(
      work,
      { "src/a.txt": "a2\n", "src/dir/c.txt": "c\n", "docs/old.md": null },
      "c2: change\n\nwith a body\nover lines",
      1_700_000_100,
    );
    await gitOk(["mv", "src/b.txt", "src/b2.txt"], { cwd: work });
    const renamedAt = { GIT_AUTHOR_DATE: "1700000150 +0000", GIT_COMMITTER_DATE: "1700000150 +0000" };
    await gitOk(["commit", "-q", "-m", "rename b"], { cwd: work, env: renamedAt });
    rename = await gitOk(["rev-parse", "HEAD"], { cwd: work });
    const mergedAt = { GIT_AUTHOR_DATE: "1700000200 +0000", GIT_COMMITTER_DATE: "1700000200 +0000" };
    await gitOk(["merge", "-q", "--no-ff", "-m", "c3: merge feature", "feature"], { cwd: work, env: mergedAt });
    merge = await gitOk(["rev-parse", "HEAD"], { cwd: work });
    await pushOk(work, name, token, ["main", "feature", "typechange", "feature:refs/ryke/candidates/x"]);
  });

  describe("log", () => {
    test("is the first-parent chain, newest first, with parents, author and committer time in ms", async () => {
      const res = await api("GET", `/v1/repos/${name}/log`);
      assert.equal(res.status, 200);
      assert.deepEqual(sortedKeys(res.json), ["commits"]);
      const commits = res.json.commits;
      assert.deepEqual(
        commits.map((c) => c.sha),
        [merge, rename, change, c1],
        "the feature commit is a second parent, not on the first-parent chain",
      );
      for (const entry of commits) assert.deepEqual(sortedKeys(entry), ["at", "author", "message", "parents", "sha"]);
      assert.deepEqual(commits.map((c) => c.parents), [[rename, f1], [change], [c1], []]);
      assert.deepEqual(commits.map((c) => c.message), [
        "c3: merge feature",
        "rename b",
        "c2: change\n\nwith a body\nover lines",
        "c1: init",
      ]);
      assert.deepEqual(commits.map((c) => c.author), [AUTHOR, AUTHOR, AUTHOR, AUTHOR]);
      assert.deepEqual(commits.map((c) => c.at), [1_700_000_200_000, 1_700_000_150_000, 1_700_000_100_000, 1_700_000_000_000]);
    });

    test("limit and ref", async () => {
      const limited = await api("GET", `/v1/repos/${name}/log?limit=2`);
      assert.deepEqual(limited.json.commits.map((c) => c.sha), [merge, rename]);
      const feature = await api("GET", `/v1/repos/${name}/log?ref=feature`);
      assert.deepEqual(feature.json.commits.map((c) => c.sha), [f1, c1]);
      const candidate = await api("GET", `/v1/repos/${name}/log?ref=refs/ryke/candidates/x`);
      assert.deepEqual(candidate.json.commits.map((c) => c.sha), [f1, c1]);
      const bySha = await api("GET", `/v1/repos/${name}/log?ref=${c1}`);
      assert.deepEqual(bySha.json.commits.map((c) => c.sha), [c1]);
      const explicitMain = await api("GET", `/v1/repos/${name}/log?ref=main&limit=1`);
      assert.deepEqual(explicitMain.json.commits.map((c) => c.sha), [merge]);
      const emptyRef = await api("GET", `/v1/repos/${name}/log?ref=&limit=1`);
      assert.deepEqual(emptyRef.json.commits.map((c) => c.sha), [merge], "an empty ref means main");
    });

    test("an unresolvable ref, an option-looking ref and an empty repo give an empty list", async () => {
      for (const ref of ["nope", "refs/heads/missing", "--all", "-n1", "0".repeat(40)]) {
        const res = await api("GET", `/v1/repos/${name}/log?ref=${encodeURIComponent(ref)}`);
        assert.equal(res.status, 200, ref);
        assert.deepEqual(res.json, { commits: [] }, ref);
      }
      const empty = uniq("logempty");
      await makeRepo(empty);
      assert.deepEqual((await api("GET", `/v1/repos/${empty}/log`)).json, { commits: [] });
    });

    test("an invalid limit is 400, a missing repo is 404", async () => {
      for (const limit of ["0", "-1", "abc", "1.5", ""]) {
        const res = await api("GET", `/v1/repos/${name}/log?limit=${limit}`);
        assert.equal(res.status, 400, `limit=${limit}`);
        assert.equal(res.json.error.code, "INVALID", `limit=${limit}`);
      }
      const missing = await api("GET", "/v1/repos/ghost/log");
      assert.equal(missing.status, 404);
      assert.equal(missing.json.error.code, "NOT_FOUND");
    });
  });

  describe("file", () => {
    const file = (ref, filePath) =>
      api("GET", `/v1/repos/${name}/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(filePath)}`);

    test("returns UTF-8 text at a branch, a sha and a nested path", async () => {
      assert.deepEqual((await file("main", "README.md")).json, { content: "# hello\n" });
      assert.deepEqual((await file("main", "src/a.txt")).json, { content: "a2\n" });
      assert.deepEqual((await file(c1, "src/a.txt")).json, { content: "a1\n" });
      assert.deepEqual((await file("main", "src/dir/c.txt")).json, { content: "c\n" });
      assert.deepEqual((await file("feature", "feature.txt")).json, { content: "f\n" });
      assert.deepEqual((await file("refs/ryke/candidates/x", "feature.txt")).json, { content: "f\n" });
      assert.deepEqual((await file("main", "utf8.txt")).json, { content: "héllo ✓\n" });
    });

    test("null for a missing path, a deleted path, a directory, an unknown ref or an option-looking ref", async () => {
      const cases = [
        ["main", "nope.txt"],
        ["main", "docs/old.md"],
        ["main", "src"],
        ["main", "src/"],
        ["main", "../README.md"],
        ["main", "/README.md"],
        ["nope", "README.md"],
        ["--help", "README.md"],
        [f1, "src/dir/c.txt"],
      ];
      for (const [ref, filePath] of cases) {
        const res = await file(ref, filePath);
        assert.equal(res.status, 200, `${ref}:${filePath}`);
        assert.deepEqual(res.json, { content: null }, `${ref}:${filePath}`);
      }
      assert.deepEqual((await file(c1, "docs/old.md")).json, { content: "old\n" }, "still there at the older commit");
    });

    test("400 for an empty or missing ref or path, 404 for a missing repo", async () => {
      for (const query of ["ref=main&path=", "ref=&path=README.md", "ref=&path=", "", "ref=main", "path=README.md"]) {
        const res = await api("GET", `/v1/repos/${name}/file?${query}`);
        assert.equal(res.status, 400, query);
        assert.equal(res.json.error.code, "INVALID", query);
      }
      const missing = await api("GET", "/v1/repos/ghost/file?ref=main&path=a");
      assert.equal(missing.status, 404);
      assert.equal(missing.json.error.code, "NOT_FOUND");
    });
  });

  describe("files", () => {
    test("lists every blob recursively, sorted", async () => {
      const res = await api("GET", `/v1/repos/${name}/files`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.files, ["README.md", "feature.txt", "src/a.txt", "src/b2.txt", "src/dir/c.txt", "utf8.txt"]);
      const explicit = await api("GET", `/v1/repos/${name}/files?ref=main`);
      assert.deepEqual(explicit.json, res.json);
    });

    test("takes a ref: a sha, a branch, a candidate ref", async () => {
      const atC1 = await api("GET", `/v1/repos/${name}/files?ref=${c1}`);
      assert.deepEqual(atC1.json.files, ["README.md", "docs/old.md", "src/a.txt", "src/b.txt", "utf8.txt"]);
      const feature = await api("GET", `/v1/repos/${name}/files?ref=feature`);
      assert.deepEqual(feature.json.files, ["README.md", "docs/old.md", "feature.txt", "src/a.txt", "src/b.txt", "utf8.txt"]);
      const candidate = await api("GET", `/v1/repos/${name}/files?ref=refs/ryke/candidates/x`);
      assert.deepEqual(candidate.json, feature.json);
    });

    test("an empty repo has no files, an unknown ref in a populated repo is 404", async () => {
      const empty = uniq("filesempty");
      await makeRepo(empty);
      assert.deepEqual((await api("GET", `/v1/repos/${empty}/files`)).json, { files: [] });
      assert.deepEqual((await api("GET", `/v1/repos/${empty}/files?ref=main`)).json, { files: [] });

      for (const ref of ["nope", "--all"]) {
        const res = await api("GET", `/v1/repos/${name}/files?ref=${encodeURIComponent(ref)}`);
        assert.equal(res.status, 404, ref);
        assert.equal(res.json.error.code, "NOT_FOUND", ref);
      }
      assert.equal((await api("GET", "/v1/repos/ghost/files")).status, 404);
    });

    test("submodule entries are not files", async () => {
      const sub = uniq("filessub");
      await makeRepo(sub);
      const subToken = await getToken(sub);
      const work = await newWork(sub);
      await commit(work, { "a.txt": "a" }, "a");
      const blobSha = await gitOk(["rev-parse", "HEAD"], { cwd: work });
      await gitOk(["update-index", "--add", "--cacheinfo", `160000,${blobSha},vendor/lib`], { cwd: work });
      await gitOk(["commit", "-q", "-m", "gitlink"], { cwd: work });
      await pushOk(work, sub, subToken, ["main"]);
      assert.deepEqual((await api("GET", `/v1/repos/${sub}/files`)).json.files, ["a.txt"]);
    });
  });

  describe("diff", () => {
    const diff = (base, head) =>
      api("GET", `/v1/repos/${name}/diff?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`);

    test("reports A, M and D sorted by path, with renames as a delete and an add", async () => {
      const res = await diff(c1, "main");
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.changes, [
        { path: "docs/old.md", status: "D" },
        { path: "feature.txt", status: "A" },
        { path: "src/a.txt", status: "M" },
        { path: "src/b.txt", status: "D" },
        { path: "src/b2.txt", status: "A" },
        { path: "src/dir/c.txt", status: "A" },
      ]);
    });

    test("is directional", async () => {
      const res = await diff("main", c1);
      assert.deepEqual(res.json.changes, [
        { path: "docs/old.md", status: "A" },
        { path: "feature.txt", status: "D" },
        { path: "src/a.txt", status: "M" },
        { path: "src/b.txt", status: "A" },
        { path: "src/b2.txt", status: "D" },
        { path: "src/dir/c.txt", status: "D" },
      ]);
    });

    test("identical commits have no changes", async () => {
      assert.deepEqual((await diff(c1, c1)).json, { changes: [] });
      assert.deepEqual((await diff("main", merge)).json, { changes: [] });
    });

    test("a type change counts as a modification", async () => {
      const res = await diff(c1, typeChange);
      assert.deepEqual(res.json.changes, [{ path: "src/a.txt", status: "M" }]);
    });

    test("unknown commits are 404, missing parameters are 400", async () => {
      for (const [base, head] of [["nope", "main"], ["main", "nope"], [c1, "f".repeat(40)], ["--cached", "main"], ["main", "--cached"]]) {
        const res = await diff(base, head);
        assert.equal(res.status, 404, `${base}..${head}`);
        assert.equal(res.json.error.code, "NOT_FOUND", `${base}..${head}`);
      }
      for (const query of ["", "base=main", "head=main", "base=&head=main", "base=main&head="]) {
        const res = await api("GET", `/v1/repos/${name}/diff?${query}`);
        assert.equal(res.status, 400, query);
        assert.equal(res.json.error.code, "INVALID", query);
      }
      assert.equal((await api("GET", "/v1/repos/ghost/diff?base=a&head=b")).status, 404);
    });
  });
});

// =========================================================================================
// A long history: truncation, limit caps, negotiation with gzip request bodies
// =========================================================================================

describe("a repo with 1005 commits", () => {
  let name;
  let token;
  let work;
  let pushEvent;

  before(async () => {
    name = uniq("big");
    await makeRepo(name);
    token = await getToken(name);
    work = await newWork(name);
    await fastImport(work, { ref: "refs/heads/main", count: 1005 });
    await gitOk(["reset", "-q", "--hard", "main"], { cwd: work });
    events.length = 0;
    await pushOk(work, name, token, ["main"]);
    pushEvent = events.find((e) => e.body.source.repoName === name);
  });

  test("the push event carries 100 commits, newest first, and says it was truncated", () => {
    assert.ok(pushEvent, "event received");
    const { payload } = pushEvent.body;
    assert.equal(payload.totalCommitsCount, 1005);
    assert.equal(payload.commitsTruncated, true);
    assert.equal(payload.commits.length, 100);
    assert.equal(payload.commits[0].message, "c1005");
    assert.equal(payload.commits[99].message, "c906");
  });

  test("log defaults to 50 commits and caps limit at 1000", async () => {
    const fiftyDefault = await api("GET", `/v1/repos/${name}/log`);
    assert.equal(fiftyDefault.json.commits.length, 50);
    assert.equal(fiftyDefault.json.commits[0].message, "c1005");
    const capped = await api("GET", `/v1/repos/${name}/log?limit=5000`);
    assert.equal(capped.json.commits.length, 1000);
    assert.equal(capped.json.commits[999].message, "c6");
    assert.equal((await api("GET", `/v1/repos/${name}/log?limit=1000`)).json.commits.length, 1000);
    assert.equal((await api("GET", `/v1/repos/${name}/log?limit=3`)).json.commits.length, 3);
  });

  test("an incremental fetch with a long negotiation sends gzip bodies that http-backend inflates", async () => {
    for (const version of ["0", "2"]) {
      const dest = path.join(await freshDir(`gzip${version}`), "c");
      const config = [`protocol.version=${version}`];
      await gitOk(["clone", "-q", withBasic(remoteOf(name), token), dest], { config });
      // Local commits the server has never seen make the client advertise hundreds of haves.
      // They are newer than anything on the server, so the client offers them first.
      await fastImport(dest, { ref: "refs/heads/local", count: 400, from: "refs/heads/main", time: 1_800_000_000 });
      const sha = await commit(work, { [`g${version}.txt`]: version }, `server side ${version}`);
      await pushOk(work, name, token, ["main"]);
      const fetch = await git(["fetch", "-q", "origin"], { cwd: dest, config, env: { GIT_TRACE_CURL: "1" } });
      assert.ok(fetch.ok, fetch.stderr);
      assert.match(fetch.stderr, /Send header: Content-Encoding: gzip/, `v${version} request body was gzipped`);
      assert.equal(await gitOk(["rev-parse", "origin/main"], { cwd: dest }), sha);
    }
  });
});

// =========================================================================================
// Persistence and the CLI
// =========================================================================================

describe("restart", () => {
  test("repos and tokens survive a restart on the same state dir", async () => {
    const stateDir = await freshDir("state-restart");
    const options = { stateDir, eventsUrl: capture.url };
    const first = await startStore({ port: 0, internalSecret: SECRET, ...options });
    let write;
    let read;
    let sha;
    const work = await newWork("persist");
    try {
      const call1 = controlApi(first);
      await call1("POST", "/v1/repos", { name: "persist" });
      write = (await call1("POST", "/v1/repos/persist/tokens", { scope: "write", ttl: 600 })).json.token;
      read = (await call1("POST", "/v1/repos/persist/tokens", { scope: "read", ttl: 600 })).json.token;
      sha = await commit(work, { "a.txt": "kept\n" }, "kept");
      await gitOk(["push", "-q", withBasic(`${first.url}/git/ryke/persist.git`, write), "main"], { cwd: work });
    } finally {
      await first.close();
    }

    const onDisk = JSON.parse(await fs.readFile(path.join(stateDir, "store", "tokens.json"), "utf8"));
    assert.equal(onDisk[secretOf(write)].scope, "write");
    assert.equal(onDisk[secretOf(read)].scope, "read");

    const second = await startStore({ port: 0, internalSecret: SECRET, ...options });
    try {
      const call2 = controlApi(second);
      const info = await call2("GET", "/v1/repos/persist");
      assert.equal(info.json.head, sha);
      assert.equal(info.json.remote, `${second.url}/git/ryke/persist.git`, "remote follows the new port");

      const clone = path.join(await freshDir("restart"), "c");
      await gitOk(["clone", "-q", withBasic(info.json.remote, read), clone]);
      assert.equal(await fs.readFile(path.join(clone, "a.txt"), "utf8"), "kept\n");

      // The old write token still pushes, over Bearer this time.
      await commit(work, { "b.txt": "more\n" }, "more");
      const push = await git(["push", `${second.url}/git/ryke/persist.git`, "main"], { cwd: work, config: [bearer(write)] });
      assert.ok(push.ok, push.stderr);
      // And the read token is still read-only.
      const denied = await request(second.url, "GET", "/git/ryke/persist.git/info/refs?service=git-receive-pack", {
        headers: { authorization: `Bearer ${read}` },
      });
      assert.equal(denied.status, 403);
    } finally {
      await second.close();
    }
  });

  test("expired tokens are dropped from tokens.json the next time it is written", async () => {
    const stateDir = await freshDir("state-prune");
    await withStore({ stateDir }, async (s) => {
      const call = controlApi(s);
      await call("POST", "/v1/repos", { name: "prune" });
      const short = (await call("POST", "/v1/repos/prune/tokens", { scope: "read", ttl: 1 })).json.token;
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const long = (await call("POST", "/v1/repos/prune/tokens", { scope: "read", ttl: 600 })).json.token;
      const onDisk = JSON.parse(await fs.readFile(path.join(stateDir, "store", "tokens.json"), "utf8"));
      assert.equal(onDisk[secretOf(short)], undefined);
      assert.ok(onDisk[secretOf(long)]);
    });
  });
});

describe("CLI (dev/store/index.mjs)", () => {
  function startCli(env) {
    const child = spawn(process.execPath, [INDEX_MJS], {
      env: { PATH: process.env.PATH, HOME: gitHome, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const listening = new Promise((resolve, reject) => {
      child.stdout.on("data", (c) => {
        stdout += c;
        const match = /^ryke store listening on (http:\/\/\S+)$/m.exec(stdout);
        if (match) resolve(match[1]);
      });
      child.on("close", (code) => reject(new Error(`cli exited early (${code}): ${stderr}`)));
    });
    const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    return { child, listening, exited, output: () => ({ stdout, stderr }) };
  }

  test("prints its url, reads the environment, forwards events and exits cleanly on SIGTERM", async () => {
    const stateDir = await freshDir("state-cli");
    const cliCapture = await startCapture();
    const cli = startCli({
      RYKE_STORE_PORT: "0",
      RYKE_STATE_DIR: stateDir,
      RYKE_NAMESPACE: "cli",
      RYKE_EVENTS_URL: cliCapture.url,
      RYKE_INTERNAL_SECRET: "cli-secret",
      RYKE_STORE_HOST: "127.0.0.1",
    });
    try {
      const url = await cli.listening;
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(cli.output().stdout.trim(), `ryke store listening on ${url}`);

      const call = (method, target, body) =>
        request(url, method, target, { headers: { "content-type": "application/json", "x-ryke-internal": "cli-secret" }, body: body && JSON.stringify(body) });
      assert.deepEqual((await call("GET", "/v1/health")).json, { ok: true });
      // The control API wants the secret from RYKE_INTERNAL_SECRET, not the default.
      const refused = await request(url, "POST", "/v1/repos", { headers: { "content-type": "application/json", "x-ryke-internal": "dev" }, body: JSON.stringify({ name: "nope" }) });
      assert.equal(refused.status, 401);
      const created = await call("POST", "/v1/repos", { name: "viacli" });
      assert.equal(created.json.remote, `${url}/git/cli/viacli.git`);
      assert.ok((await fs.stat(path.join(stateDir, "store", "cli", "viacli.git"))).isDirectory());

      const token = (await call("POST", "/v1/repos/viacli/tokens", { scope: "write", ttl: 60 })).json.token;
      const work = await newWork("cli");
      const sha = await commit(work, { "a.txt": "a" }, "a");
      await gitOk(["push", "-q", withBasic(created.json.remote, token), "main"], { cwd: work });
      assert.equal(cliCapture.events.length, 1);
      assert.equal(cliCapture.events[0].headers["x-ryke-internal"], "cli-secret");
      assert.deepEqual(cliCapture.events[0].body.source, { type: "artifacts.repo", namespace: "cli", repoName: "viacli" });
      assert.equal(cliCapture.events[0].body.payload.after, sha);

      cli.child.kill("SIGTERM");
      assert.deepEqual(await cli.exited, { code: 0, signal: null });
    } finally {
      cli.child.kill("SIGKILL");
      await cliCapture.close();
    }
  });

  test("an empty RYKE_EVENTS_URL disables events", async () => {
    const stateDir = await freshDir("state-cli-noevents");
    const cli = startCli({ RYKE_STORE_PORT: "0", RYKE_STATE_DIR: stateDir, RYKE_EVENTS_URL: "" });
    try {
      const url = await cli.listening;
      // No RYKE_INTERNAL_SECRET in the environment: the store falls back to "dev", as dev/stack.mjs does.
      const call = (method, target, body) =>
        request(url, method, target, { headers: { "content-type": "application/json", "x-ryke-internal": "dev" }, body: body && JSON.stringify(body) });
      await call("POST", "/v1/repos", { name: "quiet" });
      const token = (await call("POST", "/v1/repos/quiet/tokens", { scope: "write", ttl: 60 })).json.token;
      const work = await newWork("cli-quiet");
      await commit(work, { "a.txt": "a" }, "a");
      // The default events URL is localhost:5173; with the variable empty, nothing may try it.
      const result = await git(["push", withBasic(`${url}/git/ryke/quiet.git`, token), "main"], { cwd: work });
      assert.ok(result.ok, result.stderr);
      assert.equal(result.stderr.includes("error"), false, result.stderr);
    } finally {
      cli.child.kill("SIGKILL");
    }
  });

  test("an invalid RYKE_STORE_PORT exits 1 with a message", async () => {
    for (const port of ["abc", "-1", "70000"]) {
      const cli = startCli({ RYKE_STORE_PORT: port, RYKE_STATE_DIR: await freshDir("state-cli-badport") });
      cli.listening.catch(() => {});
      const { code } = await cli.exited;
      assert.equal(code, 1, port);
      assert.match(cli.output().stderr, /invalid RYKE_STORE_PORT/, port);
    }
  });
});
