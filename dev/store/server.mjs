// Local stand-in for Cloudflare Artifacts (PLAN.md §3.2): bare git repos on disk, a small
// JSON control API that mirrors the binding, and git smart HTTP via `git http-backend`.
// Node built-ins and the real git CLI only. One instance per state dir: tokens.json and
// the .tmp scratch directory are not safe to share between two running stores.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_FORMAT, parseLog } from "./commits.mjs";

const HOOK_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook.mjs");

const STATUS = { NOT_FOUND: 404, ALREADY_EXISTS: 409, INVALID: 400, UNAVAILABLE: 503 };
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TOKEN_SECRET_RE = /^art_v1_[0-9a-f]{40}$/;
const MAX_TTL_SECONDS = 31_536_000;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 1000;
const MAX_JSON_BYTES = 1024 * 1024;

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const validName = (name) => typeof name === "string" && NAME_RE.test(name) && !name.endsWith(".git");

function assertName(name) {
  if (!validName(name)) {
    throw new ApiError("INVALID", `invalid repo name: ${JSON.stringify(name)}`);
  }
}

// Every git process the store starts ignores the developer's global and system config:
// a global core.hooksPath, for one, would silently replace our post-receive hook.
function gitEnv(extra = {}) {
  const env = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

function runGit(args, gitDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", gitDir ? ["--git-dir", gitDir, ...args] : args, {
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (e) => reject(new ApiError("UNAVAILABLE", `cannot run git: ${e.message}`)));
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
}

async function gitOk(args, gitDir) {
  const result = await runGit(args, gitDir);
  if (result.code !== 0) {
    throw new ApiError("UNAVAILABLE", `git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// Resolves to a full sha, or null. Refs starting with "-" are refused outright so a
// query parameter can never be read as a git option.
async function resolveCommit(gitDir, ref) {
  if (ref.startsWith("-")) return null;
  const result = await runGit(["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`], gitDir);
  return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
}

const shQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

const CONFIG_APPEND = `[http]
\treceivepack = true
[uploadpack]
\tallowAnySHA1InWant = true
\tallowReachableSHA1InWant = true
`;

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendError(res, status, code, message, headers) {
  sendJson(res, status, { error: { code, message } }, headers);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new ApiError("INVALID", "request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError("INVALID", "request body is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID", "request body must be a JSON object");
  }
  return value;
}

// Index of the blank line that ends a CGI header block, with its length.
function findHeaderEnd(buf) {
  const crlf = buf.indexOf("\r\n\r\n");
  const lf = buf.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { at: crlf, length: 4 };
  if (lf !== -1) return { at: lf, length: 2 };
  return null;
}

function parseCgiHeaders(text) {
  let status = 200;
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
    else headers[key] = value;
  }
  return { status, headers };
}

async function writeWithBackpressure(res, chunk) {
  if (res.write(chunk)) return;
  await new Promise((resolve) => {
    res.once("drain", resolve);
    res.once("close", resolve);
  });
}

function parseCredentialSecret(raw) {
  const [secret, query] = raw.split("?");
  const match = query === undefined ? null : /^expires=(\d+)$/.exec(query);
  return { secret, expires: match ? Number(match[1]) : null, malformed: query !== undefined && !match };
}

export async function startStore({
  port = 8788,
  host = "127.0.0.1",
  stateDir = ".ryke",
  namespace = "ryke",
  eventsUrl = "",
  internalSecret = "dev",
} = {}) {
  if (!NAME_RE.test(namespace)) throw new Error(`invalid namespace: ${JSON.stringify(namespace)}`);

  const storeRoot = path.resolve(stateDir, "store");
  const nsDir = path.join(storeRoot, namespace);
  const tmpRoot = path.join(storeRoot, ".tmp");
  const tokensFile = path.join(storeRoot, "tokens.json");
  await fs.mkdir(nsDir, { recursive: true });
  // Leftovers from a store that was killed mid-create or mid-delete.
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });

  const repoDir = (name) => path.join(nsDir, `${name}.git`);
  let baseUrl = "";
  const remoteFor = (name) => `${baseUrl}/git/${namespace}/${name}.git`;

  async function repoExists(name) {
    try {
      return (await fs.stat(repoDir(name))).isDirectory();
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }

  async function requireRepo(name) {
    assertName(name);
    if (!(await repoExists(name))) throw new ApiError("NOT_FOUND", `repo not found: ${name}`);
    return repoDir(name);
  }

  // ---- tokens -------------------------------------------------------------------------

  // secret -> { namespace, repo, scope, expires (unix seconds) }. A Map, because the keys
  // come from request headers.
  const tokens = new Map();
  try {
    const stored = JSON.parse(await fs.readFile(tokensFile, "utf8"));
    for (const [secret, entry] of Object.entries(stored)) tokens.set(secret, entry);
  } catch (e) {
    if (e.code !== "ENOENT") {
      throw new Error(`cannot load ${tokensFile}: ${e.message}. Delete it to start without tokens.`);
    }
  }

  let tokenWrites = Promise.resolve();
  function persistTokens() {
    const run = tokenWrites.then(async () => {
      const now = Date.now() / 1000;
      for (const [secret, entry] of tokens) if (entry.expires <= now) tokens.delete(secret);
      // Write-then-rename so a crash never leaves a half-written file behind.
      const tmp = `${tokensFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(tokens), null, 2));
      await fs.rename(tmp, tokensFile);
    });
    tokenWrites = run.catch(() => {});
    return run;
  }

  // Returns the token's scope for `repo`, or null when the request must be refused with 401.
  function authenticate(req, repo) {
    const header = req.headers.authorization ?? "";
    let credential;
    let viaBearer = false;
    const bearer = /^Bearer\s+(\S+)$/i.exec(header);
    const basic = /^Basic\s+(\S+)$/i.exec(header);
    if (bearer) {
      credential = parseCredentialSecret(bearer[1]);
      viaBearer = true;
    } else if (basic) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      // The username is ignored, as on Artifacts.
      credential = parseCredentialSecret(decoded.slice(decoded.indexOf(":") + 1));
    } else {
      return null;
    }
    if (credential.malformed || !TOKEN_SECRET_RE.test(credential.secret)) return null;
    const entry = tokens.get(credential.secret);
    if (!entry || entry.namespace !== namespace || entry.repo !== repo) return null;
    // A bearer token is the whole string; Basic carries only the secret half.
    if (viaBearer && credential.expires === null) return null;
    if (credential.expires !== null && credential.expires !== entry.expires) return null;
    if (Date.now() >= entry.expires * 1000) return null;
    return entry.scope;
  }

  // ---- repo lifecycle -----------------------------------------------------------------

  // Builds a repo in scratch space and renames it into place, so a half-built repo is never
  // visible to http-backend and two concurrent creators of one name cannot both win.
  async function buildRepo(name, populate) {
    const tmp = await fs.mkdtemp(path.join(tmpRoot, "new-"));
    try {
      await populate(tmp);
      await fs.appendFile(path.join(tmp, "config"), CONFIG_APPEND);
      await fs.mkdir(path.join(tmp, "hooks"), { recursive: true });
      const hook = path.join(tmp, "hooks", "post-receive");
      // RYKE_NODE is the node running this store, so the hook works when PATH has no node.
      await fs.writeFile(hook, `#!/bin/sh\nexec "\${RYKE_NODE:-node}" ${shQuote(HOOK_JS)}\n`);
      await fs.chmod(hook, 0o755);
      await fs.rename(tmp, repoDir(name));
    } catch (e) {
      await fs.rm(tmp, { recursive: true, force: true });
      if (e.code === "ENOTEMPTY" || e.code === "EEXIST") {
        throw new ApiError("ALREADY_EXISTS", `repo already exists: ${name}`);
      }
      throw e;
    }
    return { name, remote: remoteFor(name), defaultBranch: "main" };
  }

  // --template= keeps git from copying its sample hooks into every repo.
  const initEmpty = (dir) => gitOk(["init", "--bare", "-q", "-b", "main", "--template=", dir]);

  async function createRepo(name, description) {
    if (await repoExists(name)) throw new ApiError("ALREADY_EXISTS", `repo already exists: ${name}`);
    return buildRepo(name, async (dir) => {
      await initEmpty(dir);
      if (description) await fs.writeFile(path.join(dir, "description"), `${description}\n`);
    });
  }

  async function forkRepo(source, name) {
    const src = await requireRepo(source);
    if (await repoExists(name)) throw new ApiError("ALREADY_EXISTS", `repo already exists: ${name}`);
    const hasMain = (await runGit(["rev-parse", "--verify", "-q", "refs/heads/main"], src)).code === 0;
    return buildRepo(name, async (dir) => {
      if (!hasMain) return initEmpty(dir);
      // --no-tags: a fork carries the default branch only, nothing else the source has accumulated.
      await gitOk([
        "clone", "--bare", "--single-branch", "--no-tags", "--branch", "main", "--template=", "-q", src, dir,
      ]);
      // The source may be deleted later; the fork must not point back at it.
      await runGit(["config", "--remove-section", "remote.origin"], dir);
    });
  }

  async function removeRepo(name) {
    assertName(name);
    const doomed = await fs.mkdtemp(path.join(tmpRoot, "del-"));
    try {
      await fs.rename(repoDir(name), path.join(doomed, "repo"));
    } catch (e) {
      await fs.rm(doomed, { recursive: true, force: true });
      if (e.code === "ENOENT") return false;
      throw e;
    }
    await fs.rm(doomed, { recursive: true, force: true });
    // A repo recreated under the same name must not honour the old repo's tokens.
    let dropped = false;
    for (const [secret, entry] of tokens) {
      if (entry.namespace === namespace && entry.repo === name) {
        tokens.delete(secret);
        dropped = true;
      }
    }
    if (dropped) await persistTokens();
    return true;
  }

  async function headOf(dir) {
    const result = await runGit(["rev-parse", "--verify", "-q", "refs/heads/main"], dir);
    return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
  }

  // ---- control API --------------------------------------------------------------------

  async function createToken(name, body) {
    await requireRepo(name);
    const { scope, ttl } = body;
    if (scope !== "read" && scope !== "write") {
      throw new ApiError("INVALID", 'scope must be "read" or "write"');
    }
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
      throw new ApiError("INVALID", `ttl must be an integer between 1 and ${MAX_TTL_SECONDS} seconds`);
    }
    // Rounded up so a token is valid for at least `ttl` seconds, however late in a second it is made.
    const expires = Math.ceil(Date.now() / 1000 + ttl);
    const secret = `art_v1_${randomBytes(20).toString("hex")}`;
    tokens.set(secret, { namespace, repo: name, scope, expires });
    await persistTokens();
    return { token: `${secret}?expires=${expires}`, scope, expiresAt: new Date(expires * 1000).toISOString() };
  }

  async function readLog(name, params) {
    const dir = await requireRepo(name);
    const ref = params.get("ref") || "main";
    let limit = DEFAULT_LOG_LIMIT;
    if (params.has("limit")) {
      limit = Number(params.get("limit"));
      if (!Number.isInteger(limit) || limit < 1) throw new ApiError("INVALID", "limit must be a positive integer");
      limit = Math.min(limit, MAX_LOG_LIMIT);
    }
    const sha = await resolveCommit(dir, ref);
    if (!sha) return { commits: [] };
    const out = await gitOk(["log", "--first-parent", "-n", String(limit), `--format=${LOG_FORMAT}`, sha, "--"], dir);
    return { commits: parseLog(out.toString("utf8")) };
  }

  async function readFile(name, params) {
    const dir = await requireRepo(name);
    const ref = params.get("ref");
    const filePath = params.get("path");
    if (!ref) throw new ApiError("INVALID", "ref is required");
    if (!filePath) throw new ApiError("INVALID", "path is required");
    const sha = await resolveCommit(dir, ref);
    if (!sha) return { content: null };
    // cat-file fails for a missing path and for a directory alike: both are "no such blob".
    const result = await runGit(["cat-file", "blob", `${sha}:${filePath}`], dir);
    return { content: result.code === 0 ? result.stdout.toString("utf8") : null };
  }

  async function listFiles(name, params) {
    const dir = await requireRepo(name);
    const ref = params.get("ref") || "main";
    const sha = await resolveCommit(dir, ref);
    if (!sha) {
      const anyRef = await gitOk(["for-each-ref", "--count=1", "--format=%(refname)"], dir);
      if (anyRef.length === 0) return { files: [] };
      throw new ApiError("NOT_FOUND", `ref not found: ${ref}`);
    }
    const out = await gitOk(["ls-tree", "-r", "-z", sha], dir);
    const files = [];
    for (const entry of out.toString("utf8").split("\0")) {
      if (entry === "") continue;
      const tab = entry.indexOf("\t");
      // "<mode> <type> <sha>": submodules are type "commit" and are not files.
      if (entry.slice(0, tab).split(" ")[1] === "blob") files.push(entry.slice(tab + 1));
    }
    return { files: files.sort() };
  }

  async function diffCommits(name, params) {
    const dir = await requireRepo(name);
    const base = params.get("base");
    const head = params.get("head");
    if (!base || !head) throw new ApiError("INVALID", "base and head are required");
    const [baseSha, headSha] = await Promise.all([resolveCommit(dir, base), resolveCommit(dir, head)]);
    if (!baseSha) throw new ApiError("NOT_FOUND", `unknown commit: ${base}`);
    if (!headSha) throw new ApiError("NOT_FOUND", `unknown commit: ${head}`);
    const out = await gitOk(["diff", "--name-status", "--no-renames", "--no-ext-diff", "-z", baseSha, headSha, "--"], dir);
    const parts = out.toString("utf8").split("\0");
    const changes = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i];
      // A file turning into a symlink (or back) is a modification as far as Ryke is concerned.
      changes.push({ path: parts[i + 1], status: status === "T" ? "M" : status });
    }
    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { changes };
  }

  async function control(req, res, url) {
    const segments = url.pathname.split("/").filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw new ApiError("INVALID", "malformed URL encoding");
      }
    });
    const method = req.method;
    const [v1, section, name, action, ...extra] = segments;
    const notFound = () => {
      throw new ApiError("NOT_FOUND", `no route for ${method} ${url.pathname}`);
    };
    if (v1 !== "v1") notFound();

    if (section === "health" && name === undefined && method === "GET") {
      return sendJson(res, 200, { ok: true });
    }
    if (section !== "repos" || extra.length > 0) notFound();

    if (name === undefined) {
      if (method !== "POST") notFound();
      const body = await readJson(req);
      assertName(body.name);
      if (body.description !== undefined && typeof body.description !== "string") {
        throw new ApiError("INVALID", "description must be a string");
      }
      return sendJson(res, 201, await createRepo(body.name, body.description));
    }

    if (action === undefined) {
      if (method === "GET") {
        const dir = await requireRepo(name);
        return sendJson(res, 200, {
          name,
          remote: remoteFor(name),
          defaultBranch: "main",
          head: await headOf(dir),
        });
      }
      if (method === "DELETE") return sendJson(res, 200, { deleted: await removeRepo(name) });
      notFound();
    }

    if (method === "POST" && action === "fork") {
      const body = await readJson(req);
      assertName(name);
      assertName(body.name);
      return sendJson(res, 201, await forkRepo(name, body.name));
    }
    if (method === "POST" && action === "tokens") {
      return sendJson(res, 201, await createToken(name, await readJson(req)));
    }
    if (method === "GET" && action === "log") return sendJson(res, 200, await readLog(name, url.searchParams));
    if (method === "GET" && action === "file") return sendJson(res, 200, await readFile(name, url.searchParams));
    if (method === "GET" && action === "files") return sendJson(res, 200, await listFiles(name, url.searchParams));
    if (method === "GET" && action === "diff") return sendJson(res, 200, await diffCommits(name, url.searchParams));
    return notFound();
  }

  // ---- git smart HTTP -----------------------------------------------------------------

  const cgiChildren = new Set();

  async function gitHttp(req, res, url) {
    const match = /^\/git\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
    // Unknown namespaces and unusable names are indistinguishable from a missing repo.
    if (!match || match[1] !== namespace || !validName(match[2]) || !(await repoExists(match[2]))) {
      req.resume();
      return sendError(res, 404, "NOT_FOUND", "repo not found");
    }
    const name = match[2];
    let rest;
    try {
      rest = decodeURIComponent((match[3] ?? "/").slice(1));
    } catch {
      req.resume();
      return sendError(res, 404, "NOT_FOUND", "malformed path");
    }

    const scope = authenticate(req, name);
    if (scope === null) {
      req.resume();
      return sendError(res, 401, "UNAUTHORIZED", "a valid repo token is required", {
        "www-authenticate": 'Basic realm="ryke"',
      });
    }
    const writes =
      rest === "git-receive-pack" ||
      (rest === "info/refs" && url.searchParams.get("service") === "git-receive-pack");
    if (writes && scope !== "write") {
      req.resume();
      return sendError(res, 403, "FORBIDDEN", "this token is read-only");
    }

    const env = gitEnv({
      GIT_PROJECT_ROOT: nsDir,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${name}.git/${rest}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1),
      REMOTE_USER: "ryke",
      REMOTE_ADDR: req.socket.remoteAddress ?? "",
      RYKE_NODE: process.execPath,
      RYKE_EVENTS_URL: eventsUrl,
      RYKE_INTERNAL_SECRET: internalSecret,
      RYKE_NAMESPACE: namespace,
      RYKE_REPO_NAME: name,
    });
    if (req.headers["content-type"]) env.CONTENT_TYPE = req.headers["content-type"];
    // Chunked pushes have no length; http-backend then reads stdin to EOF.
    if (req.headers["content-length"]) env.CONTENT_LENGTH = req.headers["content-length"];
    // git gzips large upload-pack requests and relies on http-backend to inflate them.
    if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"];
    if (req.headers["git-protocol"]) env.GIT_PROTOCOL = req.headers["git-protocol"];

    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    cgiChildren.add(child);
    // "close" comes after stdout and stderr have both been drained, unlike the end of stdout alone.
    const closed = new Promise((resolve) => child.on("close", resolve));
    closed.then(() => cgiChildren.delete(child));
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    // http-backend may answer (a 403, say) without reading the whole body.
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    req.pipe(child.stdin);
    res.on("close", () => {
      if (!res.writableFinished) child.kill();
    });

    let head = Buffer.alloc(0);
    let started = false;
    for await (const chunk of child.stdout) {
      if (started) {
        await writeWithBackpressure(res, chunk);
        continue;
      }
      head = Buffer.concat([head, chunk]);
      const end = findHeaderEnd(head);
      if (!end) continue;
      const { status, headers } = parseCgiHeaders(head.subarray(0, end.at).toString("utf8"));
      res.writeHead(status, headers);
      started = true;
      const body = head.subarray(end.at + end.length);
      if (body.length > 0) await writeWithBackpressure(res, body);
    }
    if (!started) {
      await closed;
      if (res.writableEnded || res.destroyed) return;
      return sendError(res, 503, "UNAVAILABLE", `git http-backend failed: ${Buffer.concat(stderr).toString("utf8").trim()}`);
    }
    res.end();
  }

  // ---- server -------------------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://store.local");
      if (url.pathname.startsWith("/git/")) return await gitHttp(req, res, url);
      return await control(req, res, url);
    } catch (e) {
      req.resume();
      if (res.headersSent) return res.destroy();
      if (e instanceof ApiError) return sendError(res, STATUS[e.code], e.code, e.message);
      console.error("ryke store: unexpected error", e);
      return sendError(res, 503, "UNAVAILABLE", "internal error");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let closing;
  const boundPort = server.address().port;
  // A wildcard bind is reached through loopback; IPv6 literals need brackets in a URL.
  const urlHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
  baseUrl = `http://${urlHost}:${boundPort}`;

  return {
    url: baseUrl,
    port: boundPort,
    // Idempotent: dev/all.mjs and a signal handler may both ask for a shutdown.
    close() {
      closing ??= (async () => {
        for (const child of cgiChildren) child.kill();
        server.close();
        server.closeAllConnections();
        await once(server, "close");
        await tokenWrites;
      })();
      return closing;
    },
  };
}
