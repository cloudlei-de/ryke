// Local process runner: runs containers/runner/bin/<kind>.sh as host processes behind the same job
// API the container Runner DO offers (PLAN.md §3.3, §3.4). POSIX only: cancel needs process groups.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { constants as osConstants } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const KIND_RE = /^[a-z][a-z0-9-]*$/;
const MAX_BODY_BYTES = 1024 * 1024;
// The job result is the last stdout line; only this much of the file tail is searched for it.
const RESULT_WINDOW_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2000;
// After the script exits we wait this long for its stdio pipes to close. A descendant that moved
// to its own process group can hold them open forever, and that must not keep the job "running".
const DRAIN_MS = 1000;
// Shell convention for "killed by SIGTERM"; also the exit code every cancelled job reports.
const CANCELLED_EXIT_CODE = 143;
const LAUNCH_FAILED_EXIT_CODE = 127;
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message) => new ApiError(400, "INVALID", message);
const notFound = (message) => new ApiError(404, "NOT_FOUND", message);

const isTerminal = (job) => job.state === "done" || job.state === "failed";

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": payload.length });
  res.end(payload);
}

// `args` and `env` share their shape rules. Env names are stricter because a name containing `=`
// corrupts the child's environment block instead of failing loudly.
function stringMap(value, field, { env }) {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${field} must be an object of strings`);
  }
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== "string") throw invalid(`${field}.${key} must be a string`);
    if (key === "" || key.includes("\0") || val.includes("\0") || (env && key.includes("="))) {
      throw invalid(`${field} has an invalid name or value (empty name, NUL byte${env ? ", or '='" : ""})`);
    }
  }
  return value;
}

// Reads the last non-empty line of the stdout log and parses it. A window smaller than the file can
// start mid-line, so a candidate that is the window's first line is only trusted when the window
// starts at byte 0.
async function readResult(stdoutLog) {
  let handle;
  try {
    handle = await open(stdoutLog, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - RESULT_WINDOW_BYTES);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "") continue;
      if (i === 0 && start > 0) return undefined;
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    }
    return undefined;
  } catch {
    return undefined; // no stdout.log: the job never started
  } finally {
    await handle?.close();
  }
}

// A byte-offset log is polled in arbitrary slices, so a slice must not end inside a multi-byte
// character or the client would decode garbage at every boundary.
function completeUtf8Length(buf) {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const byte = buf[buf.length - back];
    if ((byte & 0xc0) === 0x80) continue; // continuation byte, keep looking for its lead byte
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? buf.length - back : buf.length;
  }
  return buf.length;
}

export async function startRunner({
  port = 8789,
  host = "127.0.0.1",
  stateDir = ".ryke",
  scriptsDir = join(REPO_ROOT, "containers/runner/bin"),
  concurrency = 6,
  env = {},
  keepJobs = false,
  // Only tests lower this; the plan fixes it at 2000.
  maxJobs = 2000,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
  const stateRoot = resolve(stateDir);
  const scripts = resolve(scriptsDir);
  const jobsRoot = join(stateRoot, "jobs");
  const evidenceDir = join(stateRoot, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const realEvidenceDir = await realpath(evidenceDir);

  const jobs = new Map(); // insertion order = creation order, which eviction relies on
  const queue = [];
  const running = new Set();
  let closing = false;

  function newJob(kind, args, jobEnv) {
    let id;
    do {
      const random = Array.from(randomBytes(6), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
      id = `j_${Date.now().toString(36)}${random}`;
    } while (jobs.has(id));
    const job = {
      id,
      kind,
      args,
      env: jobEnv,
      dir: join(jobsRoot, id),
      state: "queued",
      cancelled: false,
      exited: false, // the script process is gone; the job is only finishing its bookkeeping
      finishing: false,
    };
    job.work = join(job.dir, "work");
    job.finished = new Promise((resolveFinished) => (job.resolveFinished = resolveFinished));
    return job;
  }

  const publicView = (job) => ({
    id: job.id,
    kind: job.kind,
    state: job.state,
    exitCode: job.exitCode,
    result: job.result,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  });

  function appendLog(job, chunk, isStdout) {
    if (job.logFd === undefined) return;
    for (const fd of isStdout ? [job.stdoutFd, job.logFd] : [job.logFd]) {
      for (let offset = 0; offset < chunk.length; ) offset += writeSync(fd, chunk, offset);
    }
  }

  function killGroup(job, signal) {
    if (job.child?.pid === undefined) return;
    try {
      process.kill(-job.child.pid, signal);
    } catch {
      // ESRCH: the whole group is already gone.
    }
  }

  function terminate(job) {
    killGroup(job, "SIGTERM");
    job.killTimer = setTimeout(() => killGroup(job, "SIGKILL"), KILL_GRACE_MS);
  }

  // The single place a job reaches done/failed, so work-dir cleanup, state and queue progress cannot
  // drift apart between the normal, cancelled, queued and could-not-start paths.
  async function finish(job, exitCode, note) {
    if (job.finishing) return;
    job.finishing = true;
    clearTimeout(job.killTimer);
    try {
      if (note) appendLog(job, Buffer.from(`${note}\n`), false);
      for (const fd of [job.logFd, job.stdoutFd]) if (fd !== undefined) closeSync(fd);
      job.logFd = job.stdoutFd = undefined;
      job.child?.stdout?.destroy();
      job.child?.stderr?.destroy();
      job.result = await readResult(join(job.dir, "stdout.log"));
      // Best effort: a stuck cleanup must not leave the job "running" and block its queue slot.
      if (!keepJobs) await rm(job.work, { recursive: true, force: true }).catch(() => {});
    } finally {
      job.exitCode = exitCode;
      job.endedAt = Date.now();
      job.state = exitCode === 0 ? "done" : "failed";
      running.delete(job);
      job.resolveFinished();
      pump();
    }
  }

  function launch(job) {
    running.add(job);
    job.state = "running";
    job.startedAt = Date.now();
    let child;
    try {
      mkdirSync(job.work, { recursive: true });
      mkdirSync(evidenceDir, { recursive: true });
      job.logFd = openSync(join(job.dir, "log.txt"), "a");
      job.stdoutFd = openSync(join(job.dir, "stdout.log"), "a");
      child = spawn("bash", [join(scripts, `${job.kind}.sh`), ...Object.entries(job.args).flatMap(([k, v]) => [`--${k}`, v])], {
        cwd: job.work,
        // Job env goes before the RYKE_* variables so a job cannot spoof its own identity or dirs.
        env: {
          ...process.env,
          ...env,
          ...job.env,
          RYKE_JOB_ID: job.id,
          RYKE_JOB_DIR: job.dir,
          RYKE_EVIDENCE_DIR: evidenceDir,
          RYKE_ROOT: REPO_ROOT,
        },
        // Own process group, so cancel can signal the script and everything it started.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      void finish(job, LAUNCH_FAILED_EXIT_CODE, `ryke runner: could not start job: ${err.message}`);
      return;
    }
    job.child = child;
    const closed = new Promise((resolveClosed) => child.once("close", resolveClosed));
    child.stdout.on("data", (chunk) => appendLog(job, chunk, true));
    child.stderr.on("data", (chunk) => appendLog(job, chunk, false));
    // A failed spawn (no bash on PATH) emits `error` and `close` but never `exit`.
    child.once("error", (err) => {
      if (child.pid === undefined) void finish(job, LAUNCH_FAILED_EXIT_CODE, `ryke runner: could not start job: ${err.message}`);
    });
    child.once("exit", async (code, signal) => {
      job.exited = true;
      // Sweep anything the script left behind in its group; otherwise it would outlive the job.
      killGroup(job, "SIGKILL");
      const exitCode = job.cancelled ? CANCELLED_EXIT_CODE : (code ?? 128 + (osConstants.signals[signal] ?? 0));
      let drainTimer;
      await Promise.race([closed, new Promise((r) => (drainTimer = setTimeout(r, DRAIN_MS)))]);
      clearTimeout(drainTimer);
      await finish(job, exitCode);
    });
  }

  function pump() {
    while (!closing && running.size < concurrency && queue.length > 0) launch(queue.shift());
  }

  // Resolves true when this call (or an earlier DELETE still in progress) cancelled the job, false
  // when it had already finished or its script had already exited by itself.
  async function cancel(job) {
    if (isTerminal(job)) return false;
    if (!job.finishing && !job.exited && !job.cancelled) {
      job.cancelled = true;
      if (job.state === "queued") {
        queue.splice(queue.indexOf(job), 1);
        void finish(job, CANCELLED_EXIT_CODE);
      } else {
        terminate(job);
      }
    }
    await job.finished;
    return job.cancelled;
  }

  async function evict() {
    const doomed = [];
    for (const job of jobs.values()) {
      if (jobs.size - doomed.length <= maxJobs) break;
      if (isTerminal(job)) doomed.push(job); // never drop a job somebody is still waiting on
    }
    for (const job of doomed) jobs.delete(job.id);
    await Promise.all(doomed.map((job) => rm(job.dir, { recursive: true, force: true }).catch(() => {})));
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    // Keep draining an oversized body so the 413 reaches a client that is still writing.
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    }
    if (tooLarge) throw new ApiError(413, "INVALID", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    return Buffer.concat(chunks).toString("utf8");
  }

  async function submit(req, res) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw invalid("request body must be JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("request body must be a JSON object");
    const { kind } = body;
    if (typeof kind !== "string" || !KIND_RE.test(kind)) throw invalid("kind must match ^[a-z][a-z0-9-]*$");
    const script = await stat(join(scripts, `${kind}.sh`)).catch(() => undefined);
    if (!script?.isFile()) throw invalid(`unknown kind "${kind}"`);
    const args = stringMap(body.args, "args", { env: false });
    const jobEnv = stringMap(body.env, "env", { env: true });

    const job = newJob(kind, args, jobEnv);
    jobs.set(job.id, job);
    queue.push(job);
    pump();
    await evict();
    sendJson(res, 201, { id: job.id });
  }

  async function readLog(job, res, rawOffset) {
    if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset))) throw invalid("offset must be a non-negative integer");
    let body = Buffer.alloc(0);
    let start = Number(rawOffset);
    let handle;
    try {
      handle = await open(join(job.dir, "log.txt"), "r");
      const { size } = await handle.stat();
      // Clamp so a stale offset past the end cannot make the client skip bytes written later.
      start = Math.min(start, size);
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      body = buf.subarray(0, bytesRead);
    } catch (err) {
      // A queued job has no log yet, and a job that could not even create its directory never will.
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      start = 0;
    } finally {
      await handle?.close();
    }
    // Once the job is over nothing will complete a dangling character, so hand it over as is.
    if (!isTerminal(job)) body = body.subarray(0, completeUtf8Length(body));
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": body.length,
      "x-ryke-next-offset": String(start + body.length),
    });
    res.end(body);
  }

  async function serveEvidence(rawPath, res) {
    let file;
    try {
      // An absolute `rawPath` makes resolve() ignore the evidence dir, and `..` or a symlink can
      // lead out of it, so only the fully resolved path is compared with the dir. `evidence-other`
      // shares the prefix of `evidence`, hence the trailing separator.
      const real = await realpath(resolve(realEvidenceDir, decodeURIComponent(rawPath)));
      if (!real.startsWith(realEvidenceDir + sep) || !(await stat(real)).isFile()) throw new Error("not a file");
      file = { path: real, bytes: await readFile(real) };
    } catch {
      throw notFound("no such evidence file");
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream",
      "content-length": file.bytes.length,
    });
    res.end(file.bytes);
  }

  async function route(req, res) {
    const url = req.url ?? "/";
    const queryAt = url.indexOf("?");
    // Not `new URL()`: it would normalise `..` away before the evidence containment check sees it.
    const pathname = queryAt < 0 ? url : url.slice(0, queryAt);
    const query = new URLSearchParams(queryAt < 0 ? "" : url.slice(queryAt + 1));
    const { method } = req;

    if (method === "POST" && pathname === "/v1/jobs") return submit(req, res);
    if (method === "GET" && pathname === "/v1/health") {
      return sendJson(res, 200, { ok: true, running: running.size, queued: queue.length });
    }
    if (method === "GET" && pathname.startsWith("/v1/evidence/")) {
      return serveEvidence(pathname.slice("/v1/evidence/".length), res);
    }
    const match = /^\/v1\/jobs\/([^/]+)(\/log)?$/.exec(pathname);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) throw notFound(`no such job "${match[1]}"`);
      if (match[2] === undefined && method === "GET") return sendJson(res, 200, publicView(job));
      if (match[2] === undefined && method === "DELETE") return sendJson(res, 200, { cancelled: await cancel(job) });
      if (match[2] !== undefined && method === "GET") return readLog(job, res, query.get("offset") ?? "0");
    }
    throw notFound(`no route for ${method} ${pathname}`);
  }

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (err instanceof ApiError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      sendJson(res, 500, { error: { code: "INTERNAL", message: String(err?.message ?? err) } });
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const boundPort = server.address().port;

  let closePromise;
  async function shutdown() {
    closing = true; // queued jobs must not start while their predecessors are being killed
    const stopped = new Promise((resolveStopped) => server.close(resolveStopped));
    server.closeIdleConnections();
    await Promise.all([...jobs.values()].map(cancel));
    server.closeAllConnections();
    await stopped;
  }

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    close: () => (closePromise ??= shutdown()),
  };
}
