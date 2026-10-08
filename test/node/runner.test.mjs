// Integration suite for dev/runner: every test boots a real runner on port 0 with its own state dir
// and drives it over HTTP against small bash scripts written below.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { inheritedEnv, isLoopbackHost, startRunner } from "../../dev/runner/server.mjs";
import { runnerEnv, stackConfig } from "../../dev/stack.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(REPO_ROOT, "dev/runner/index.mjs");
// realpath: on macOS tmpdir() is a symlink and the scripts print their resolved cwd.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "ryke-runner-test-")));
const SCRIPTS = join(ROOT, "scripts");
after(() => rmSync(ROOT, { recursive: true, force: true }));

// String.raw keeps the backslashes that printf in the scripts needs. Scripts never use a dollar
// followed by a brace, which a template literal would try to interpolate.
const SCRIPT_SOURCES = {
  // Prints what the runner handed to the script as one JSON line.
  echo: String.raw`
exec "$NODE_BIN" -e '
const fs = require("fs");
const keys = ["RYKE_JOB_ID", "RYKE_JOB_DIR", "RYKE_EVIDENCE_DIR", "RYKE_ROOT", "RYKE_RUNNER_LOCAL", "RYKE_TEST_HOST", "LC_RYKE_TEST_P", "LC_RYKE_TEST_PO", "RYKE_TEST_OJ", "LC_RYKE_TEST_POJ"];
console.log(JSON.stringify({
  argv: process.argv.slice(1),
  env: Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null])),
  cwd: fs.realpathSync(process.cwd()),
  entries: fs.readdirSync("."),
}));
' -- "$@"
`,
  // Prints the whole environment the job was started with, from process.env and, where Linux has
  // it, from the kernel's copy of the exec-time block (what `cat /proc/self/environ` would show).
  envdump: String.raw`
exec "$NODE_BIN" -e '
const fs = require("fs");
let block = null;
try {
  block = fs.readFileSync("/proc/self/environ", "utf8").split("\0").filter(Boolean);
} catch {}
console.log(JSON.stringify({ env: process.env, block }));
'
`,
  // Stays running until the test creates <job dir>/gate, so tests can observe the running state.
  gated: String.raw`
echo started
while [ ! -e "$RYKE_JOB_DIR/gate" ]; do sleep 0.05; done
echo '{"ok":true,"n":1}'
`,
  sleep: String.raw`
sleep 30 &
echo "$!" > "$RYKE_JOB_DIR/child.pid"
wait
`,
  // Ignores SIGTERM (and so do its children), so only SIGKILL stops it.
  stubborn: String.raw`
trap '' TERM
sleep 30 &
echo "$!" > "$RYKE_JOB_DIR/child.pid"
wait
`,
  fail: String.raw`
echo '{"why":"boom"}'
exit 3
`,
  plain: String.raw`
echo '{"early":true}'
echo "all done"
`,
  selfkill: String.raw`
kill -9 $$
`,
  emit: String.raw`
text=""; code=0
while [ $# -gt 0 ]; do
  case "$1" in
    --text) text="$2"; shift 2 ;;
    --exit) code="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$text"
exit "$code"
`,
  bulk: String.raw`
case "$2" in
  filler) head -c 3000000 /dev/zero | tr '\0' x; echo; echo '{"big":true}' ;;
  hugeline) head -c 1100000 /dev/zero | tr '\0' 1; echo ;;
esac
`,
  stderr: String.raw`
echo out1
sleep 0.15
echo err1 >&2
sleep 0.15
echo out2
echo '{"ok":1}'
`,
  work: String.raw`
echo data > artifact.txt
echo '{"ok":1}'
`,
  evidence: String.raw`
printf 'proof' > "$RYKE_EVIDENCE_DIR/proof.txt"
echo '{"saved":true}'
`,
  marker: String.raw`
touch "$RYKE_TEST_MARKER"
`,
  // Writes the bytes given as printf escapes, then waits for the gate.
  partial: String.raw`
printf '%b' "$2"
while [ ! -e "$RYKE_JOB_DIR/gate" ]; do sleep 0.05; done
`,
  // `set -m` moves the sleeper into its own process group, out of reach of the group sweep, while
  // it still holds the job's stdout pipe open.
  escape: String.raw`
set -m
sleep 5 &
echo "{\"pid\":$!}"
`,
  leaves: String.raw`
sleep 30 &
echo "{\"pid\":$!}"
`,
};
mkdirSync(SCRIPTS);
for (const [kind, source] of Object.entries(SCRIPT_SOURCES)) writeFileSync(join(SCRIPTS, `${kind}.sh`), source);
mkdirSync(join(SCRIPTS, "dirkind.sh")); // matches the kind syntax but is not a script
// A script exists behind every kind in BAD_SUBMISSIONS that is rejected for its syntax, so nothing
// but the syntax check can turn them away.
for (const name of ["Echo", "1echo", "echo_x", "echo.sh", "echo x"]) writeFileSync(join(SCRIPTS, `${name}.sh`), "echo hi\n");
writeFileSync(join(ROOT, "echo.sh"), "echo hi\n"); // what kind "../echo" would resolve to

const it = (name, fn) => test(name, { timeout: 30_000 }, fn);

async function waitFor(fn, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// A killed orphan stays a zombie until its new parent reaps it, and signal 0 still succeeds on a
// zombie. Where the VM's PID 1 never reaps, "gone" has to include state Z.
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

async function expectGone(pid) {
  await waitFor(() => !alive(pid), `process ${pid} to be gone`);
  assert.equal(alive(pid), false);
}

async function childPid(dir) {
  const file = join(dir, "child.pid");
  const text = await waitFor(() => {
    try {
      const s = readFileSync(file, "utf8");
      return /^\d+\n$/.test(s) ? s : undefined;
    } catch {
      return undefined;
    }
  }, "child.pid");
  return Number(text);
}

function client(base) {
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString("utf8");
    const json = (res.headers.get("content-type") ?? "").startsWith("application/json") ? JSON.parse(text) : undefined;
    return { status: res.status, headers: res.headers, bytes, text, json };
  }
  async function submit(kind, args, env) {
    const res = await call("POST", "/v1/jobs", { kind, ...(args && { args }), ...(env && { env }) });
    assert.equal(res.status, 201, res.text);
    return res.json.id;
  }
  const status = async (id) => (await call("GET", `/v1/jobs/${id}`)).json;
  const cancel = async (id) => {
    const res = await call("DELETE", `/v1/jobs/${id}`);
    assert.equal(res.status, 200, res.text);
    return res.json;
  };
  const health = async () => (await call("GET", "/v1/health")).json;
  const log = (id, offset) => call("GET", `/v1/jobs/${id}/log${offset === undefined ? "" : `?offset=${offset}`}`);
  const until = (id, state) => waitFor(async () => ((await status(id)).state === state ? status(id) : undefined), `${id} to be ${state}`);
  const finished = (id) =>
    waitFor(async () => {
      const s = await status(id);
      return s.state === "done" || s.state === "failed" ? s : undefined;
    }, `${id} to finish`);
  return { call, submit, status, cancel, health, log, until, finished };
}

async function boot(t, opts = {}) {
  const stateDir = mkdtempSync(join(ROOT, "state-"));
  const runner = await startRunner({
    port: 0,
    stateDir,
    scriptsDir: SCRIPTS,
    env: { NODE_BIN: process.execPath },
    ...opts,
  });
  t.after(() => runner.close());
  const open = (id) => writeFileSync(join(stateDir, "jobs", id, "gate"), "");
  return { runner, stateDir, jobDir: (id) => join(stateDir, "jobs", id), open, ...client(runner.url) };
}

function rawGet(base, path) {
  return new Promise((resolveGet, rejectGet) => {
    const { hostname, port } = new URL(base);
    const req = http.request({ hostname, port, path, method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolveGet({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", rejectGet);
    req.end();
  });
}

function assertError(res, status, code, label = "") {
  assert.equal(res.status, status, `${label} ${res.text}`);
  assert.equal(res.json?.error?.code, code, `${label} ${res.text}`);
  assert.equal(typeof res.json.error.message, "string", label);
  assert.notEqual(res.json.error.message, "", label);
}

// ---------------------------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------------------------

it("a job moves queued -> running -> done and reports its exit code and parsed result", async (t) => {
  const { submit, status, finished, until, open, log, health } = await boot(t, { concurrency: 1 });
  const a = await submit("gated");
  const b = await submit("echo");

  const running = await until(a, "running");
  assert.deepEqual(Object.keys(running).sort(), ["id", "kind", "startedAt", "state"]);
  assert.equal(running.kind, "gated");
  assert.equal(typeof running.startedAt, "number");

  const queued = await status(b);
  assert.deepEqual(queued, { id: b, kind: "echo", state: "queued" });
  assert.deepEqual(await health(), { ok: true, running: 1, queued: 1 });
  const queuedLog = await log(b);
  assert.equal(queuedLog.status, 200);
  assert.equal(queuedLog.text, "");
  assert.equal(queuedLog.headers.get("x-ryke-next-offset"), "0");

  open(a);
  const doneA = await finished(a);
  assert.equal(doneA.state, "done");
  assert.equal(doneA.exitCode, 0);
  assert.deepEqual(doneA.result, { ok: true, n: 1 });
  assert.ok(doneA.startedAt <= doneA.endedAt);

  const doneB = await finished(b);
  assert.equal(doneB.state, "done");
  assert.ok(doneB.startedAt >= doneA.endedAt, "the queued job starts only after the running one ended");
  assert.deepEqual(await health(), { ok: true, running: 0, queued: 0 });
});

it("args become --key value entries in insertion order and env layers host < runner < job", async (t) => {
  // LC_* is the one host family a job inherits whose names a test can invent; RYKE_TEST_HOST is not
  // in the allow-list, so it shows that the host layer is filtered and not just ordered.
  Object.assign(process.env, { RYKE_TEST_HOST: "host", LC_RYKE_TEST_P: "host", LC_RYKE_TEST_PO: "host", LC_RYKE_TEST_POJ: "host" });
  t.after(() => {
    for (const k of ["RYKE_TEST_HOST", "LC_RYKE_TEST_P", "LC_RYKE_TEST_PO", "LC_RYKE_TEST_POJ"]) delete process.env[k];
  });
  const { submit, finished, stateDir, jobDir } = await boot(t, {
    env: { NODE_BIN: process.execPath, LC_RYKE_TEST_PO: "runner", RYKE_TEST_OJ: "runner", LC_RYKE_TEST_POJ: "runner" },
  });
  const tricky = `$HOME; echo 'x' "q" \`id\``;
  const id = await submit(
    "echo",
    { zeta: "1", alpha: "two words", mid: tricky, empty: "" },
    // The RYKE_* names are the runner's to set, so a job cannot claim another identity.
    { RYKE_TEST_OJ: "job", LC_RYKE_TEST_POJ: "job", RYKE_JOB_ID: "spoofed", RYKE_ROOT: "/spoofed", RYKE_RUNNER_LOCAL: "spoofed" },
  );
  const job = await finished(id);

  assert.equal(job.state, "done");
  assert.deepEqual(job.result.argv, ["--zeta", "1", "--alpha", "two words", "--mid", tricky, "--empty", ""]);
  assert.deepEqual(job.result.env, {
    RYKE_JOB_ID: id,
    RYKE_JOB_DIR: jobDir(id),
    RYKE_EVIDENCE_DIR: join(stateDir, "evidence"),
    RYKE_ROOT: REPO_ROOT,
    // boot() binds to 127.0.0.1, so a subscription agent job may run here; the job could not claim it.
    RYKE_RUNNER_LOCAL: "1",
    RYKE_TEST_HOST: null,
    LC_RYKE_TEST_P: "host",
    LC_RYKE_TEST_PO: "runner",
    RYKE_TEST_OJ: "job",
    LC_RYKE_TEST_POJ: "job",
  });
});

// A job runs candidate code (the verify command, Claude's tools), so what it inherits from the host
// is a list of names that cannot hold a credential. Everything else, including every name nobody
// thought of yet, is left out.
const HOST_NAMES = ["PATH", "HOME", "USER", "LANG", "TZ", "TMPDIR", "TERM", "SHELL"];
const PROXY_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_USE_ENV_PROXY",
];
test("isLoopbackHost: only an address no other machine can reach", () => {
  for (const [host, want] of [["127.0.0.1", true], ["127.1.2.3", true], ["localhost", true], ["::1", true], ["0.0.0.0", false], ["::", false], ["192.168.1.5", false], ["127.0.0.1.example.com", false], ["", false]]) {
    assert.equal(isLoopbackHost(host), want, host);
  }
});

test("inheritedEnv keeps exactly the allow-listed host variables", () => {
  const everything = Object.fromEntries([...HOST_NAMES, ...PROXY_NAMES, "LC_ALL", "LC_CTYPE", "LC_RYKE_ANY"].map((k) => [k, `v:${k}`]));
  assert.deepEqual(inheritedEnv(everything), everything);

  for (const name of [
    "TYPESAFE_API_KEY",
    "RYKE_INTERNAL_SECRET",
    "RYKE_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    // The harness passes the CLIs' login dirs with the job, so the job looks where its preflight looked.
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "RYKE_RUNNER_LOCAL",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "NPM_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "SSH_AUTH_SOCK",
    "NODE_TEST_CONTEXT",
    "GIT_ASKPASS",
    "PWD",
    "LOGNAME",
    "LC", // not LC_
    "LCX_ALL",
    "lc_all", // names are case sensitive; only the proxy variables have a lower-case spelling listed
    "path",
    "XPATH",
    "PATH_EXTRA",
    "ALL_PROXY",
    "NODE_PATH",
  ]) {
    assert.deepEqual(inheritedEnv({ PATH: "/bin", [name]: "x" }), { PATH: "/bin" }, name);
  }
  assert.deepEqual(inheritedEnv({}), {});
});

test("inheritedEnv passes NODE_OPTIONS only when it carries no --test flag", () => {
  for (const [options, kept] of [
    ["--max-old-space-size=4096", true],
    ["--require ./x.js --enable-source-maps", true],
    ["--experimental-strip-types", true],
    ["--no-warnings", true],
    ["", true],
    ["--test", false],
    ["--test-only", false],
    ["--test-reporter=spec", false],
    ["--test-reporter spec", false],
    ["--max-old-space-size=4096 --test-name-pattern=x", false],
    ["  --test-concurrency=2", false],
    ["--test=1", false],
    ["--require x --test", false],
    ["--no-test-isolation", true], // contains the letters, but is another flag
    ["--contest", true],
    ["--require=./test-helper.js", true],
  ]) {
    assert.deepEqual(inheritedEnv({ NODE_OPTIONS: options }), kept ? { NODE_OPTIONS: options } : {}, JSON.stringify(options));
  }
});

it("a job inherits the allow-listed host variables, the proxy settings and a NODE_OPTIONS without --test", async (t) => {
  const saved = Object.fromEntries(Object.keys({ ...Object.fromEntries(PROXY_NAMES.map((k) => [k])), NODE_OPTIONS: 1, LC_ALL: 1 }).map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  for (const name of PROXY_NAMES) process.env[name] = `proxy-setting:${name}`;
  process.env.LC_ALL = "C";
  process.env.NODE_OPTIONS = "--max-old-space-size=512";
  const { submit, finished } = await boot(t);
  const job = await finished(await submit("envdump"));
  assert.equal(job.state, "done");
  assert.equal(job.result.env.PATH, process.env.PATH);
  assert.equal(job.result.env.HOME, process.env.HOME);
  for (const name of PROXY_NAMES) assert.equal(job.result.env[name], `proxy-setting:${name}`, name);
  assert.equal(job.result.env.LC_ALL, "C");
  assert.equal(job.result.env.NODE_OPTIONS, "--max-old-space-size=512");

  process.env.NODE_OPTIONS = "--test-reporter=spec --max-old-space-size=512";
  const dropped = await finished(await submit("envdump"));
  assert.equal(dropped.state, "done");
  assert.equal(dropped.result.env.NODE_OPTIONS, undefined);
});

it("a job does not see the credentials in the runner host's environment", async (t) => {
  // A separate host process, as in production: the secrets are in its environment from the start,
  // and the job is the child of that process.
  const stateDir = mkdtempSync(join(ROOT, "cli-"));
  const port = await freePort();
  const secrets = {
    TYPESAFE_API_KEY: "fake-typesafe-key-4f3a",
    RYKE_INTERNAL_SECRET: "fake-internal-secret-9c1d",
    RYKE_TOKEN: "fake-admin-token-77aa",
    ANTHROPIC_API_KEY: "fake-anthropic-key-02ee",
    GITHUB_TOKEN: "fake-github-token-31bc",
  };
  const cli = runCli(t, {
    ...secrets,
    HTTPS_PROXY: "http://proxy.invalid:3128",
    RYKE_RUNNER_PORT: String(port),
    RYKE_RUNNER_HOST: "127.0.0.1",
    RYKE_STATE_DIR: stateDir,
    RYKE_SCRIPTS_DIR: SCRIPTS,
  });
  await waitFor(() => cli.out().includes("\n"), "the startup line");
  const { submit, finished } = client(`http://127.0.0.1:${port}`);
  const job = await finished(await submit("envdump", {}, { NODE_BIN: process.execPath }));
  assert.equal(job.state, "done", JSON.stringify(job));

  const seen = JSON.stringify(job.result);
  for (const [name, value] of Object.entries(secrets)) {
    assert.equal(job.result.env[name], undefined, name);
    assert.ok(!seen.includes(value), `${name} appears somewhere in the job's environment`);
  }
  // What the kernel recorded when it exec'd the job, which is what /proc/self/environ shows.
  if (job.result.block !== null) {
    for (const name of Object.keys(secrets)) assert.ok(!job.result.block.some((entry) => entry.startsWith(`${name}=`)), `${name} in /proc/self/environ`);
  }
  assert.equal(job.result.env.PATH, process.env.PATH);
  assert.equal(job.result.env.HTTPS_PROXY, "http://proxy.invalid:3128");
  // Nothing outside the allow-list, the runner's own variables and what bash adds to every script.
  const allowed = new RegExp(`^(${[...HOST_NAMES, ...PROXY_NAMES, "NODE_OPTIONS", "NODE_BIN", "PWD", "OLDPWD", "SHLVL", "_"].join("|")}|LC_.*|RYKE_(JOB_ID|JOB_DIR|EVIDENCE_DIR|ROOT|RUNNER_LOCAL))$`);
  assert.deepEqual(
    Object.keys(job.result.env).filter((name) => !allowed.test(name)),
    [],
  );
});

it("each job gets a fresh empty cwd, removed when the job ends", async (t) => {
  const { submit, finished, jobDir } = await boot(t);
  const first = await submit("work");
  const second = await submit("echo");
  const third = await submit("echo");
  await finished(first);
  const echoed = [await finished(second), await finished(third)];

  for (const job of echoed) {
    assert.equal(job.result.cwd, join(jobDir(job.id), "work"));
    assert.deepEqual(job.result.entries, []);
  }
  assert.notEqual(echoed[0].result.cwd, echoed[1].result.cwd);
  for (const id of [first, second, third]) {
    assert.equal(existsSync(join(jobDir(id), "work")), false);
    assert.equal(existsSync(join(jobDir(id), "log.txt")), true);
    assert.equal(existsSync(join(jobDir(id), "stdout.log")), true);
  }
});

it("keepJobs leaves the cwd and what the job wrote into it", async (t) => {
  const { submit, finished, jobDir } = await boot(t, { keepJobs: true });
  const id = await submit("work");
  await finished(id);
  assert.equal(readFileSync(join(jobDir(id), "work", "artifact.txt"), "utf8"), "data\n");
});

// [label, stdout text, exit code, expected result or NONE]
const NONE = Symbol("no result");
const RESULT_ROWS = [
  ["a single JSON line", '{"a":1}\n', 0, { a: 1 }],
  ["trailing blank lines", 'log line\n{"a":1}\n\n\n', 0, { a: 1 }],
  ["no trailing newline", 'first\n{"a":1}', 0, { a: 1 }],
  ["indented line", '  {"a":1}  \n', 0, { a: 1 }],
  ["CRLF line ending", '{"a":1}\r\n', 0, { a: 1 }],
  ["an array", "[1,2,3]\n", 0, [1, 2, 3]],
  ["a bare number", "42", 0, 42],
  ["a bare string", '"text"\n', 0, "text"],
  ["JSON null is a result", "null\n", 0, null],
  ["JSON only on an earlier line", '{"a":1}\nlog line\n', 0, NONE],
  ["a truncated object", '{"a":1\n', 0, NONE],
  ["no output", "", 0, NONE],
  ["blank output", "   \n\n", 0, NONE],
  ["result is kept when the job fails", '{"a":2}\n', 4, { a: 2 }],
  ["no result and a failure", "oops\n", 1, NONE],
];

it("the result is the last non-empty stdout line when it parses, whatever the exit code", async (t) => {
  const { submit, finished } = await boot(t);
  const ids = await Promise.all(RESULT_ROWS.map(([, text, code]) => submit("emit", { text, exit: String(code) })));
  for (const [i, [label, , code, expected]] of RESULT_ROWS.entries()) {
    const job = await finished(ids[i]);
    assert.equal(job.state, code === 0 ? "done" : "failed", label);
    assert.equal(job.exitCode, code, label);
    if (expected === NONE) assert.equal("result" in job, false, label);
    else assert.deepEqual(job.result, expected, label);
  }
});

it("a non-zero exit is failed, keeps its exit code and still has its parsed result", async (t) => {
  const { submit, finished } = await boot(t);
  const job = await finished(await submit("fail"));
  assert.equal(job.state, "failed");
  assert.equal(job.exitCode, 3);
  assert.deepEqual(job.result, { why: "boom" });
  assert.equal(typeof job.endedAt, "number");
});

it("a last line that is not JSON gives no result even when an earlier line was", async (t) => {
  const { submit, finished } = await boot(t);
  const job = await finished(await submit("plain"));
  assert.equal(job.state, "done");
  assert.equal("result" in job, false);
});

it("a job killed by a signal fails with the shell convention 128 + signal", async (t) => {
  const { submit, finished } = await boot(t);
  const job = await finished(await submit("selfkill"));
  assert.equal(job.state, "failed");
  assert.equal(job.exitCode, 137);
});

it("only the tail of stdout is searched for the result", async (t) => {
  const { submit, finished } = await boot(t);
  const filler = await finished(await submit("bulk", { mode: "filler" }));
  assert.deepEqual(filler.result, { big: true }, "a 3 MB log still yields its complete last line");
  const huge = await finished(await submit("bulk", { mode: "hugeline" }));
  assert.equal(huge.state, "done");
  // Its last 1 MiB alone is a valid JSON number, which is exactly why a cut-off line is not trusted.
  assert.equal("result" in huge, false, "a last line longer than the search window is not trusted");
});

// ---------------------------------------------------------------------------------------------
// launch failures
// ---------------------------------------------------------------------------------------------

it("a job whose shell cannot be started fails with 127, says why in its log and frees its slot", async (t) => {
  const { submit, finished, log } = await boot(t, { concurrency: 1 });
  const id = await submit("echo", undefined, { PATH: "/nonexistent" });
  const job = await finished(id);
  assert.equal(job.state, "failed");
  assert.equal(job.exitCode, 127);
  assert.match((await log(id)).text, /could not start job: .*bash/);
  assert.equal((await finished(await submit("plain"))).state, "done");
});

it("a job whose directory cannot be created fails with 127 and an empty log", async (t) => {
  const { submit, finished, log, stateDir } = await boot(t, { concurrency: 1 });
  writeFileSync(join(stateDir, "jobs"), "a file where the jobs directory should be");
  const id = await submit("echo");
  const job = await finished(id);
  assert.equal(job.state, "failed");
  assert.equal(job.exitCode, 127);
  assert.equal(typeof job.startedAt, "number");
  const res = await log(id);
  assert.equal(res.status, 200);
  assert.equal(res.text, "");
  assert.equal(res.headers.get("x-ryke-next-offset"), "0");
});

// ---------------------------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------------------------

it("the log is served from a byte offset with the next offset in a header", async (t) => {
  const { submit, finished, log, open, until } = await boot(t);
  const id = await submit("gated");
  await until(id, "running");
  await waitFor(async () => (await log(id)).text === "started\n", "first log line");

  const cases = [
    [undefined, "started\n", "8"],
    [0, "started\n", "8"],
    [3, "rted\n", "8"],
    [8, "", "8"],
    [999, "", "8"], // a stale offset is clamped so no later bytes are skipped
  ];
  for (const [offset, text, next] of cases) {
    const res = await log(id, offset);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/plain/);
    assert.equal(res.text, text, `offset ${offset}`);
    assert.equal(res.headers.get("x-ryke-next-offset"), next, `offset ${offset}`);
  }

  open(id);
  await finished(id);
  const rest = await log(id, 8);
  assert.equal(rest.text, '{"ok":true,"n":1}\n');
  assert.equal(rest.headers.get("x-ryke-next-offset"), String(8 + rest.text.length));
  assert.equal((await log(id)).text, 'started\n{"ok":true,"n":1}\n');
});

it("an offset that is not a non-negative integer is rejected", async (t) => {
  const { submit, finished, call } = await boot(t);
  const id = await submit("plain");
  await finished(id);
  for (const offset of ["abc", "-1", "1.5", "", "1e3", "99999999999999999999"]) {
    assertError(await call("GET", `/v1/jobs/${id}/log?offset=${offset}`), 400, "INVALID");
  }
});

it("the log interleaves stderr with stdout while stdout.log holds stdout only", async (t) => {
  const { submit, finished, log, jobDir } = await boot(t);
  const id = await submit("stderr");
  const job = await finished(id);
  assert.deepEqual(job.result, { ok: 1 });
  assert.equal((await log(id)).text, 'out1\nerr1\nout2\n{"ok":1}\n');
  assert.equal(readFileSync(join(jobDir(id), "stdout.log"), "utf8"), 'out1\nout2\n{"ok":1}\n');
});

// [label, bytes, how many bytes a running job's log may expose]
const UTF8_ROWS = [
  ["ascii", [0x61, 0x62], 2],
  ["a 2-byte lead alone", [0x61, 0xc3], 1],
  ["a lone 3-byte lead", [0x61, 0xe2], 1],
  ["a 3-byte sequence missing its last byte", [0x61, 0xe2, 0x82], 1],
  ["a lone 4-byte lead", [0x61, 0xf0], 1],
  ["a 4-byte sequence missing two bytes", [0x61, 0xf0, 0x9f], 1],
  ["a 4-byte sequence missing its last byte", [0x61, 0xf0, 0x9f, 0x98], 1],
  ["a complete 3-byte character", [0xe2, 0x82, 0xac], 3],
  ["a complete 4-byte character", [0xf0, 0x9f, 0x98, 0x80], 4],
  ["a stray continuation byte", [0x61, 0x80], 2],
  ["only a partial character", [0xe2], 0],
];

it("a running job's log never ends inside a multi-byte character, a finished job's log is complete", async (t) => {
  const { submit, finished, log, open, jobDir } = await boot(t, { concurrency: UTF8_ROWS.length });
  const escape = (bytes) => bytes.map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
  const ids = await Promise.all(UTF8_ROWS.map(([, bytes]) => submit("partial", { bytes: escape(bytes) })));

  for (const [i, [label, bytes, visible]] of UTF8_ROWS.entries()) {
    const file = join(jobDir(ids[i]), "log.txt");
    await waitFor(() => existsSync(file) && statSync(file).size === bytes.length, `${label} to be written`);
    const res = await log(ids[i]);
    assert.deepEqual([...res.bytes], bytes.slice(0, visible), label);
    assert.equal(res.headers.get("x-ryke-next-offset"), String(visible), label);
  }

  for (const id of ids) open(id);
  for (const [i, [label, bytes, visible]] of UTF8_ROWS.entries()) {
    await finished(ids[i]);
    const res = await log(ids[i], visible);
    assert.deepEqual([...res.bytes], bytes.slice(visible), label);
    assert.equal(res.headers.get("x-ryke-next-offset"), String(bytes.length), label);
  }
});

it("a log that cannot be read is an INTERNAL error rather than a hang", async (t) => {
  const { submit, finished, call, jobDir } = await boot(t);
  const id = await submit("plain");
  await finished(id);
  rmSync(join(jobDir(id), "log.txt"));
  mkdirSync(join(jobDir(id), "log.txt"));
  assertError(await call("GET", `/v1/jobs/${id}/log`), 500, "INTERNAL");
});

// ---------------------------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------------------------

it("cancelling a running job kills its whole process group and ends it as failed/143", async (t) => {
  const { submit, status, cancel, until, jobDir } = await boot(t);
  const id = await submit("sleep");
  await until(id, "running");
  const child = await childPid(jobDir(id));
  assert.equal(alive(child), true);

  assert.deepEqual(await cancel(id), { cancelled: true });
  const job = await status(id);
  assert.equal(job.state, "failed");
  assert.equal(job.exitCode, 143);
  assert.equal(typeof job.endedAt, "number");
  await expectGone(child);
  assert.equal(existsSync(join(jobDir(id), "work")), false);
});

it("a job that ignores SIGTERM is killed after the 2 s grace period, and concurrent cancels agree", async (t) => {
  const { submit, status, cancel, until, jobDir } = await boot(t);
  const id = await submit("stubborn");
  await until(id, "running");
  const child = await childPid(jobDir(id));

  const started = Date.now();
  const results = await Promise.all([cancel(id), cancel(id)]);
  assert.deepEqual(results, [{ cancelled: true }, { cancelled: true }]);
  assert.ok(Date.now() - started >= 1900, "SIGKILL must wait for the grace period");
  const job = await status(id);
  assert.equal(job.state, "failed");
  assert.equal(job.exitCode, 143);
  await expectGone(child);
});

it("cancelling a queued job dequeues it, and it never runs", async (t) => {
  const { submit, status, cancel, health, until, finished } = await boot(t, { concurrency: 1 });
  const marker = join(ROOT, "marker-queued");
  const blocker = await submit("sleep");
  const queued = await submit("marker", undefined, { RYKE_TEST_MARKER: marker });
  await until(blocker, "running");
  assert.equal((await status(queued)).state, "queued");

  assert.deepEqual(await cancel(queued), { cancelled: true });
  assert.deepEqual(await status(queued), {
    id: queued,
    kind: "marker",
    state: "failed",
    exitCode: 143,
    endedAt: (await status(queued)).endedAt,
  });
  assert.deepEqual(await health(), { ok: true, running: 1, queued: 0 });

  assert.deepEqual(await cancel(blocker), { cancelled: true });
  await finished(blocker);
  await sleep(150); // time for a wrongly kept queue entry to start
  assert.equal(existsSync(marker), false);
  assert.deepEqual(await health(), { ok: true, running: 0, queued: 0 });
});

it("cancelling a finished job, cancelled or not, changes nothing", async (t) => {
  const { submit, status, cancel, finished, until } = await boot(t);
  const ok = await submit("plain");
  const before = await finished(ok);
  assert.deepEqual(await cancel(ok), { cancelled: false });
  assert.deepEqual(await status(ok), before);

  const killed = await submit("sleep");
  await until(killed, "running");
  await cancel(killed);
  const after = await status(killed);
  assert.deepEqual(await cancel(killed), { cancelled: false });
  assert.deepEqual(await status(killed), after);
});

it("a job whose script already exited is not cancelled while its descendants hold the pipes open", async (t) => {
  const { submit, status, cancel, log, finished } = await boot(t);
  const id = await submit("escape");
  const { pid } = await waitFor(async () => {
    const text = (await log(id)).text;
    return text ? JSON.parse(text) : undefined;
  }, "the sleeper's pid");
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  });
  await sleep(300); // the script exits within milliseconds; finishing then waits for the pipes

  assert.deepEqual(await cancel(id), { cancelled: false });
  const job = await finished(id);
  assert.equal(job.state, "done");
  assert.equal(job.exitCode, 0);
  assert.deepEqual(job.result, { pid });
  assert.ok(job.endedAt - job.startedAt < 4000, "the job must not wait for the 5 s sleeper");
  assert.equal(alive(pid), true, "a process that left the group is not the runner's to kill");
  assert.equal((await status(id)).state, "done");
});

it("processes a script leaves behind in its group are killed when it exits", async (t) => {
  const { submit, finished } = await boot(t);
  const job = await finished(await submit("leaves"));
  assert.equal(job.state, "done");
  await expectGone(job.result.pid);
});

// ---------------------------------------------------------------------------------------------
// concurrency, health, close
// ---------------------------------------------------------------------------------------------

it("with concurrency 2 and three sleepers exactly one stays queued until another is cancelled", async (t) => {
  const { submit, status, cancel, until } = await boot(t, { concurrency: 2 });
  const [a, b, c] = [await submit("sleep"), await submit("sleep"), await submit("sleep")];
  await until(a, "running");
  await until(b, "running");

  await sleep(100); // a third job that wrongly started would be running by now
  assert.deepEqual([(await status(a)).state, (await status(b)).state, (await status(c)).state], ["running", "running", "queued"]);

  await cancel(a);
  await until(c, "running");
  assert.deepEqual([(await status(b)).state, (await status(c)).state], ["running", "running"]);
});

it("queued jobs start in submission order", async (t) => {
  const { submit, status, until, open } = await boot(t, { concurrency: 1 });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await submit("gated"));
  for (const [i, id] of ids.entries()) {
    await until(id, "running");
    const states = await Promise.all(ids.map(async (other) => (await status(other)).state));
    assert.deepEqual(states, ids.map((_, k) => (k < i ? "done" : k === i ? "running" : "queued")));
    open(id);
  }
  assert.equal((await until(ids[3], "done")).exitCode, 0);
});

it("health counts running and queued jobs", async (t) => {
  const { runner, submit, cancel, health, until } = await boot(t, { concurrency: 1 });
  assert.match(runner.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(runner.port, Number(new URL(runner.url).port));
  assert.deepEqual(await health(), { ok: true, running: 0, queued: 0 });

  const [a, b, c] = [await submit("sleep"), await submit("sleep"), await submit("sleep")];
  await until(a, "running");
  assert.deepEqual(await health(), { ok: true, running: 1, queued: 2 });
  await cancel(b);
  assert.deepEqual(await health(), { ok: true, running: 1, queued: 1 });
  await cancel(a);
  await until(c, "running");
  assert.deepEqual(await health(), { ok: true, running: 1, queued: 0 });
  await cancel(c);
  assert.deepEqual(await health(), { ok: true, running: 0, queued: 0 });
});

it("close kills running jobs, never starts queued ones and is idempotent", async (t) => {
  const { runner, submit, until, jobDir, call } = await boot(t, { concurrency: 1 });
  const marker = join(ROOT, "marker-close");
  const running = await submit("sleep");
  const queued = await submit("marker", undefined, { RYKE_TEST_MARKER: marker });
  await until(running, "running");
  const child = await childPid(jobDir(running));

  await Promise.all([runner.close(), runner.close()]);
  await runner.close();

  await expectGone(child);
  await sleep(150);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(jobDir(queued)), false);
  await assert.rejects(call("GET", "/v1/health"), "the port must be closed");
});

it("a submission that arrives while the runner is shutting down never starts", async (t) => {
  const { runner, submit, until, jobDir } = await boot(t, { concurrency: 2 });
  const marker = join(ROOT, "marker-shutdown");
  const stubborn = await submit("stubborn"); // ignores SIGTERM, so close() stays busy for the 2 s grace
  await until(stubborn, "running");
  await childPid(jobDir(stubborn));

  // Half a request on a raw socket keeps the connection busy, so close() cannot drop it as idle.
  const body = JSON.stringify({ kind: "marker", env: { RYKE_TEST_MARKER: marker } });
  const socket = connect(runner.port, "127.0.0.1");
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write(`POST /v1/jobs HTTP/1.1\r\nhost: runner\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body.slice(0, 5)}`);
  await sleep(100);
  const closing = runner.close();
  await sleep(100);
  socket.write(body.slice(5));
  const [reply] = await once(socket, "data");
  assert.match(reply.toString(), /^HTTP\/1\.1 201 /);

  await sleep(300); // a job that wrongly started would have touched the marker by now
  assert.equal(existsSync(marker), false);
  await closing;
  assert.equal(existsSync(marker), false);
});

it("invalid concurrency and a taken port are startup errors", async (t) => {
  for (const concurrency of [0, -1, 1.5, Number.NaN, "2"]) {
    await assert.rejects(startRunner({ port: 0, stateDir: join(ROOT, "x"), concurrency }), RangeError, String(concurrency));
  }
  const { runner } = await boot(t);
  await assert.rejects(
    startRunner({ port: runner.port, stateDir: mkdtempSync(join(ROOT, "state-")), scriptsDir: SCRIPTS }),
    { code: "EADDRINUSE" },
  );
});

it("job ids are j_ plus a base36 timestamp plus six random characters, and unique", async (t) => {
  const { submit } = await boot(t, { concurrency: 20 });
  const before = Date.now();
  const ids = await Promise.all(Array.from({ length: 20 }, () => submit("plain")));
  const after = Date.now();
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^j_[0-9a-z]{7,}$/);
    const issued = parseInt(id.slice(2, -6), 36);
    assert.ok(issued >= before - 1 && issued <= after, `${id} encodes ${issued}, expected within ${before}..${after}`);
  }
});

it("only the newest maxJobs records are kept, their directories go with them, and live jobs stay", async (t) => {
  const { submit, status, finished, call, jobDir, stateDir } = await boot(t, { maxJobs: 3, concurrency: 2 });
  const sleeper = await submit("sleep"); // oldest, but still running
  const done = [];
  for (let i = 0; i < 4; i++) {
    const id = await submit("work");
    await finished(id);
    done.push(id);
  }

  for (const id of done.slice(0, 2)) {
    assertError(await call("GET", `/v1/jobs/${id}`), 404, "NOT_FOUND");
    assertError(await call("GET", `/v1/jobs/${id}/log`), 404, "NOT_FOUND");
    assert.equal(existsSync(jobDir(id)), false, `${id} directory removed`);
  }
  for (const id of done.slice(2)) {
    assert.equal((await status(id)).state, "done");
    assert.equal(existsSync(jobDir(id)), true);
  }
  assert.equal((await status(sleeper)).state, "running");
  assert.deepEqual(readdirSync(join(stateDir, "jobs")).sort(), [sleeper, ...done.slice(2)].sort());
});

// ---------------------------------------------------------------------------------------------
// request validation and errors
// ---------------------------------------------------------------------------------------------

const BAD_SUBMISSIONS = [
  ["body that is not JSON", "{nope"],
  ["empty body", ""],
  ["JSON null", "null"],
  ["JSON string", '"echo"'],
  ["JSON array", []],
  ["no kind", {}],
  ["numeric kind", { kind: 5 }],
  ["empty kind", { kind: "" }],
  ["upper case kind", { kind: "Echo" }],
  ["kind starting with a digit", { kind: "1echo" }],
  ["kind with an underscore", { kind: "echo_x" }],
  ["kind with an extension", { kind: "echo.sh" }],
  ["kind that climbs out of the scripts dir", { kind: "../echo" }],
  ["kind with a space", { kind: "echo x" }],
  ["kind without a script", { kind: "nope" }],
  ["kind whose script is a directory", { kind: "dirkind" }],
  ["args as an array", { kind: "echo", args: [] }],
  ["args as a string", { kind: "echo", args: "x" }],
  ["args as null", { kind: "echo", args: null }],
  ["numeric arg value", { kind: "echo", args: { n: 1 } }],
  ["boolean arg value", { kind: "echo", args: { n: true } }],
  ["null arg value", { kind: "echo", args: { n: null } }],
  ["nested arg value", { kind: "echo", args: { n: { a: "b" } } }],
  ["NUL in an arg value", { kind: "echo", args: { n: "a\u0000b" } }],
  ["empty arg name", { kind: "echo", args: { "": "x" } }],
  ["env as an array", { kind: "echo", env: [] }],
  ["env as a number", { kind: "echo", env: 5 }],
  ["env as null", { kind: "echo", env: null }],
  ["numeric env value", { kind: "echo", env: { A: 1 } }],
  ["null env value", { kind: "echo", env: { A: null } }],
  ["NUL in an env value", { kind: "echo", env: { A: "a\u0000b" } }],
  ["empty env name", { kind: "echo", env: { "": "x" } }],
  ["env name containing =", { kind: "echo", env: { "A=B": "x" } }],
];

it("a malformed submission is 400 INVALID and creates nothing", async (t) => {
  const { call, health, stateDir } = await boot(t);
  for (const [label, body] of BAD_SUBMISSIONS) {
    assertError(await call("POST", "/v1/jobs", body), 400, "INVALID", label);
  }
  assert.deepEqual(await health(), { ok: true, running: 0, queued: 0 });
  assert.equal(existsSync(join(stateDir, "jobs")), false);
});

it("a body over 1 MiB is rejected", async (t) => {
  const { call } = await boot(t);
  const res = await call("POST", "/v1/jobs", { kind: "echo", args: { big: "x".repeat(1024 * 1024 + 1) } });
  assertError(res, 413, "INVALID");
});

it("optional args and env, and an arg name containing =, are accepted", async (t) => {
  const { submit, finished } = await boot(t);
  const bare = await finished(await submit("echo"));
  assert.deepEqual(bare.result.argv, []);
  const named = await finished(await submit("echo", { "a=b": "c" }, {}));
  assert.deepEqual(named.result.argv, ["--a=b", "c"]);
});

it("unknown jobs and unknown routes are 404 NOT_FOUND", async (t) => {
  const { call, submit, finished } = await boot(t);
  const id = await submit("plain");
  await finished(id);
  const rows = [
    ["GET", "/v1/jobs/j_nope"],
    ["GET", "/v1/jobs/j_nope/log"],
    ["DELETE", "/v1/jobs/j_nope"],
    ["GET", "/v1/nope"],
    ["GET", "/"],
    ["GET", "/v1/jobs"],
    ["POST", "/v1/health"],
    ["PUT", `/v1/jobs/${id}`],
    ["DELETE", `/v1/jobs/${id}/log`],
    ["POST", `/v1/jobs/${id}/log`],
    ["POST", "/v1/evidence/x.txt"],
  ];
  for (const [method, path] of rows) assertError(await call(method, path), 404, "NOT_FOUND", `${method} ${path}`);
});

// ---------------------------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------------------------

const EVIDENCE_FILES = [
  ["shot.png", "image/png"],
  ["photo.jpg", "image/jpeg"],
  ["photo2.jpeg", "image/jpeg"],
  ["report.json", "application/json"],
  ["note.txt", "text/plain; charset=utf-8"],
  ["page.html", "text/html; charset=utf-8"],
  ["blob.bin", "application/octet-stream"],
  ["noextension", "application/octet-stream"],
  ["UPPER.PNG", "image/png"],
  ["deep/dir/file.txt", "text/plain; charset=utf-8"],
  ["with space.txt", "text/plain; charset=utf-8"],
];

it("evidence is served from the evidence dir with a content type by extension", async (t) => {
  const { stateDir, call } = await boot(t);
  const evidence = join(stateDir, "evidence");
  mkdirSync(join(evidence, "deep/dir"), { recursive: true });
  for (const [name] of EVIDENCE_FILES) writeFileSync(join(evidence, name), Buffer.from([0x00, 0xff, 0x10, ...Buffer.from(name)]));
  writeFileSync(join(evidence, "report.json"), '{"verdict":"pass"}');
  symlinkSync("note.txt", join(evidence, "alias.txt")); // a link that stays inside is fine

  for (const [name, type] of EVIDENCE_FILES) {
    const res = await call("GET", `/v1/evidence/${name.split("/").map(encodeURIComponent).join("/")}`);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get("content-type"), type, name);
    if (name !== "report.json") assert.deepEqual([...res.bytes], [0x00, 0xff, 0x10, ...Buffer.from(name)], name);
  }
  assert.deepEqual((await call("GET", "/v1/evidence/report.json")).json, { verdict: "pass" });
  assert.equal((await call("GET", "/v1/evidence/alias.txt")).status, 200);
});

it("evidence a job wrote through RYKE_EVIDENCE_DIR can be fetched", async (t) => {
  const { submit, finished, call } = await boot(t);
  assert.equal((await call("GET", "/v1/evidence/proof.txt")).status, 404);
  await finished(await submit("evidence"));
  const res = await call("GET", "/v1/evidence/proof.txt");
  assert.equal(res.status, 200);
  assert.equal(res.text, "proof");
});

it("missing evidence, directories and every path out of the evidence dir are 404", async (t) => {
  const { stateDir, runner } = await boot(t);
  const evidence = join(stateDir, "evidence");
  mkdirSync(join(evidence, "deep"));
  mkdirSync(join(stateDir, "evidence-other")); // shares the name prefix of the evidence dir
  writeFileSync(join(evidence, "shot.png"), "png");
  writeFileSync(join(stateDir, "secret.txt"), "TOP SECRET");
  writeFileSync(join(stateDir, "evidence-other", "leak.txt"), "TOP SECRET");
  symlinkSync("../secret.txt", join(evidence, "link.txt"));

  const paths = [
    "/v1/evidence/missing.png",
    "/v1/evidence/deep", // a directory
    "/v1/evidence/",
    "/v1/evidence/../secret.txt",
    "/v1/evidence/%2e%2e/secret.txt",
    "/v1/evidence/..%2Fsecret.txt",
    "/v1/evidence/%2E%2E%2Fsecret.txt",
    "/v1/evidence/deep/../../secret.txt",
    "/v1/evidence/../evidence-other/leak.txt",
    "/v1/evidence//etc/hostname",
    "/v1/evidence/%2Fetc%2Fhostname",
    "/v1/evidence/link.txt", // a symlink leading out of the dir
    "/v1/evidence/shot.png%00.txt",
    "/v1/evidence/%zz", // not valid percent-encoding
  ];
  for (const path of paths) {
    const res = await rawGet(runner.url, path);
    assert.equal(res.status, 404, path);
    assert.equal(JSON.parse(res.body.toString()).error.code, "NOT_FOUND", path);
    assert.doesNotMatch(res.body.toString(), /TOP SECRET/, path);
  }
  assert.equal((await rawGet(runner.url, "/v1/evidence/shot.png")).status, 200);
});

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

function runCli(t, env) {
  const childEnv = { ...process.env, NODE_BIN: process.execPath, ...env };
  delete childEnv.NODE_TEST_CONTEXT; // the node test runner's own marker must not leak into the CLI
  const proc = spawn(process.execPath, [CLI], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => proc.kill("SIGKILL"));
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => (stdout += d));
  proc.stderr.on("data", (d) => (stderr += d));
  return { proc, out: () => stdout, err: () => stderr };
}

it("the CLI reads RYKE_* settings, announces its URL and stops its jobs on SIGTERM", async (t) => {
  const stateDir = mkdtempSync(join(ROOT, "cli-"));
  const port = await freePort();
  const cli = runCli(t, {
    RYKE_RUNNER_PORT: String(port),
    RYKE_RUNNER_HOST: "localhost",
    RYKE_STATE_DIR: stateDir,
    RYKE_SCRIPTS_DIR: SCRIPTS,
    RYKE_RUNNER_CONCURRENCY: "1",
    RYKE_KEEP_JOBS: "1",
  });
  await waitFor(() => cli.out().includes("\n"), "the startup line");
  assert.equal(cli.out(), `ryke runner listening on http://localhost:${port}\n`);

  const { submit, finished, until, health } = client(`http://localhost:${port}`);
  const job = await finished(await submit("work"));
  assert.equal(job.state, "done");
  assert.equal(readFileSync(join(stateDir, "jobs", job.id, "work", "artifact.txt"), "utf8"), "data\n", "RYKE_KEEP_JOBS=1");

  const running = await submit("sleep");
  const queued = await submit("sleep");
  await until(running, "running");
  assert.deepEqual(await health(), { ok: true, running: 1, queued: 1 }, "RYKE_RUNNER_CONCURRENCY=1");
  const child = await childPid(join(stateDir, "jobs", running));

  cli.proc.kill("SIGTERM");
  const [code, signal] = await once(cli.proc, "exit");
  assert.deepEqual([code, signal], [0, null]);
  await expectGone(child);
  assert.equal(existsSync(join(stateDir, "jobs", queued)), false);
});

it("the CLI defaults to 127.0.0.1, .ryke in the cwd and <repo>/containers/runner/bin", async (t) => {
  // A copy of the runner inside a fake repo shows where the defaults point without touching the
  // real containers/ directory: they are derived from the location of the files.
  const repo = mkdtempSync(join(ROOT, "fake-repo-"));
  mkdirSync(join(repo, "dev/runner"), { recursive: true });
  mkdirSync(join(repo, "containers/runner/bin"), { recursive: true });
  for (const file of ["index.mjs", "server.mjs"]) copyFileSync(join(REPO_ROOT, "dev/runner", file), join(repo, "dev/runner", file));
  writeFileSync(join(repo, "containers/runner/bin/hello.sh"), 'echo "{\\"root\\":\\"$RYKE_ROOT\\"}"\n');
  const cwd = mkdtempSync(join(ROOT, "cli-cwd-"));

  const childEnv = { ...process.env, RYKE_RUNNER_PORT: "0" };
  for (const k of ["NODE_TEST_CONTEXT", "RYKE_RUNNER_HOST", "RYKE_STATE_DIR", "RYKE_SCRIPTS_DIR", "RYKE_RUNNER_CONCURRENCY", "RYKE_KEEP_JOBS"]) {
    delete childEnv[k];
  }
  const proc = spawn(process.execPath, [join(repo, "dev/runner/index.mjs")], { cwd, env: childEnv, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => proc.kill("SIGKILL"));
  let stdout = "";
  proc.stdout.on("data", (d) => (stdout += d));
  const url = await waitFor(() => /^ryke runner listening on (http:\/\/127\.0\.0\.1:\d+)$/m.exec(stdout)?.[1], "the startup line");

  const { submit, finished } = client(url);
  const job = await finished(await submit("hello"));
  assert.equal(job.state, "done");
  assert.deepEqual(job.result, { root: repo });
  assert.equal(existsSync(join(cwd, ".ryke", "evidence")), true);
  assert.equal(existsSync(join(cwd, ".ryke", "jobs", job.id, "log.txt")), true);
  proc.kill("SIGTERM");
  assert.deepEqual(await once(proc, "exit"), [0, null]);
});

it("the CLI exits non-zero when its configuration is invalid", async (t) => {
  const cli = runCli(t, { RYKE_RUNNER_PORT: "0", RYKE_RUNNER_CONCURRENCY: "abc", RYKE_STATE_DIR: mkdtempSync(join(ROOT, "cli-")) });
  const [code] = await once(cli.proc, "exit");
  assert.notEqual(code, 0);
  assert.match(cli.err(), /concurrency must be a positive integer/);
});

// Jobs run candidate code (the verify command, the agent's tools) in processes the runner starts, and
// whatever is in the runner's own environment is in theirs. The stack therefore hands it no credential;
// jobs that need the API token get it from the Worker with the job (api.ts, agent jobs).
test("the dev stack gives the runner an environment without credentials", () => {
  const cfg = { ...stackConfig(7), token: "sekret-token", internalSecret: "sekret-internal" };
  const env = runnerEnv(cfg);
  assert.deepEqual(env, { RYKE_API_URL: cfg.apiUrl, RYKE_PORT_OFFSET: "7" });
  for (const [name, value] of Object.entries(env)) {
    assert.doesNotMatch(name, /TOKEN|KEY|SECRET|PASSWORD/i);
    assert.doesNotMatch(value, /sekret/);
  }
});
