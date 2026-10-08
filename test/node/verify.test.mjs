// verify runner job (containers/runner/bin/verify.sh, PLAN.md §5.3 step 2). The job tests run the real
// script against a real bare git repo and assert on its one JSON result line; the parser tests feed
// fixed node:test output (TAP and spec, captured from Node 22.22) to testsum.mjs.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { parseTestOutput, stripAnsi, summarizeTests, tailLines } from "../../containers/runner/lib/testsum.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VERIFY = join(REPO_ROOT, "containers/runner/bin/verify.sh");
// realpath: on macOS tmpdir() is a symlink and git prints resolved paths.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "ryke-verify-test-")));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let counter = 0;
function freshDir(label) {
  const dir = join(ROOT, `${label}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- git fixtures -----------------------------------------------------------------------------

// No developer config: the machine's global git config may sign commits through an agent.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A bare "trunk" plus a work clone to build its history with.
function newRepo() {
  const dir = freshDir("repo");
  const remote = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  // The local store sets this too, and the candidate sha is not a branch head.
  git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  return { remote, work };
}

function commit(repo, files, { branch = "main", message = "commit" } = {}) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.work, path)), { recursive: true });
    writeFileSync(join(repo.work, path), content);
  }
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", message);
  git(repo.work, "push", "-q", repo.remote, `HEAD:refs/heads/${branch}`);
  return git(repo.work, "rev-parse", "HEAD");
}

// ---- projects under test ----------------------------------------------------------------------

const HEADER = 'import { describe, it, test } from "node:test";\nimport assert from "node:assert/strict";\n';

const PASSING = {
  "test/math.test.mjs": `${HEADER}
test("adds", () => assert.equal(1 + 1, 2));
test("subtracts", () => assert.equal(3 - 1, 2));
describe("group", () => {
  it("first", () => assert.ok(true));
  it("second", () => assert.ok(true));
});
`,
};

const ONE_FAILING = {
  "test/math.test.mjs": `${HEADER}
test("adds", () => assert.equal(1 + 1, 2));
test("broken", () => assert.equal(1, 2));
`,
};

const NESTED_FAILING = {
  "test/nested.test.mjs": `${HEADER}
describe("outer", () => {
  describe("inner", () => {
    it("deep", () => { throw new Error("deep boom"); });
    it("fine", () => {});
  });
});
test("parent", async (t) => {
  await t.test("child ok", () => {});
  await t.test("child bad", () => assert.equal("a", "b"));
});
`,
};

// TypeScript syntax on purpose: the preview loads the app with node's type stripping. It records
// its pid and every requested path in the verify job's working directory (the checkout's parent).
const APP = {
  "src/index.ts": `import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync("../app.pid", String(process.pid));
export default {
  fetch(request: Request, _env: object): Response {
    appendFileSync("../requests.log", new URL(request.url).pathname + "\\n");
    return new Response("<!doctype html><title>Convert</title><h1 style='font: 48px sans-serif'>Hello preview</h1>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
`,
  "src/nofetch.ts": "export default {};\n",
};

const TEST_COMMAND = "node --test test/*.test.mjs";

// ---- running the job --------------------------------------------------------------------------

let jobCounter = 0;

// Starts verify.sh the way the local runner does: a fresh cwd, RYKE_* in the env, flags as arguments.
function startVerify(args, { env = {} } = {}) {
  const cwd = freshDir("job");
  const evidence = freshDir("evidence");
  const jobId = `j_test${++jobCounter}`;
  const argv = Object.entries(args).flatMap(([key, value]) => [`--${key}`, String(value)]);
  const child = spawn("bash", [VERIFY, ...argv], {
    cwd,
    // process.env on purpose: under `node --test` it carries NODE_TEST_CONTEXT, which the job must
    // keep away from the command it runs.
    env: { ...process.env, RYKE_ROOT: REPO_ROOT, RYKE_JOB_ID: jobId, RYKE_EVIDENCE_DIR: evidence, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const started = Date.now();
  const done = new Promise((resolveDone, rejectDone) => {
    child.on("error", rejectDone);
    child.on("close", (code, signal) => {
      const last = stdout.trim().split("\n").at(-1);
      let result;
      try {
        result = JSON.parse(last);
      } catch {
        result = undefined;
      }
      resolveDone({ code, signal, result, stdout, stderr, cwd, evidence, jobId, elapsedMs: Date.now() - started });
    });
  });
  return { child, done, cwd };
}

const runVerify = (args, options) => startVerify(args, options).done;

function verifyArgs(repo, ref, extra = {}) {
  return { remote: repo.remote, ref, command: TEST_COMMAND, timeout: 60, ...extra };
}

// A zombie (exited, not yet reaped) is gone for our purposes.
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true; // no /proc on this platform
  }
}

async function waitForFile(path) {
  for (let i = 0; i < 100 && !existsSync(path); i++) await sleep(50);
  assert.ok(existsSync(path), `${path} was never written`);
}

// ---- verify.sh --------------------------------------------------------------------------------

describe("verify.sh: running the command", () => {
  test("reports passing tests with counts and no screenshot keys", async () => {
    const repo = newRepo();
    const sha = commit(repo, PASSING);
    const run = await runVerify(verifyArgs(repo, sha));

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.result.ok, true);
    assert.equal(run.result.pass, true);
    assert.equal(run.result.exitCode, 0);
    assert.equal(run.result.timedOut, false);
    assert.deepEqual(run.result.tests, { passed: 4, failed: 0, failures: [] });
    assert.equal(typeof run.result.durationMs, "number");
    assert.match(run.result.log, /pass 4/);
    assert.equal("screenshot" in run.result, false);
    assert.equal("screenshotError" in run.result, false);
  });

  test("reports one failing test by name with its message", async () => {
    const repo = newRepo();
    const sha = commit(repo, ONE_FAILING);
    const run = await runVerify(verifyArgs(repo, sha));

    assert.equal(run.code, 0, "failing tests are a result, not a job error");
    assert.equal(run.result.ok, true);
    assert.equal(run.result.pass, false);
    assert.equal(run.result.exitCode, 1);
    assert.equal(run.result.tests.passed, 1);
    assert.equal(run.result.tests.failed, 1);
    assert.equal(run.result.tests.failures.length, 1);
    assert.equal(run.result.tests.failures[0].name, "broken");
    assert.match(run.result.tests.failures[0].message, /1 !== 2/);
  });

  test("names nested failures by their full path and counts a failing parent once", async () => {
    const repo = newRepo();
    const sha = commit(repo, NESTED_FAILING);
    const run = await runVerify(verifyArgs(repo, sha));

    assert.equal(run.result.pass, false);
    assert.deepEqual(
      run.result.tests.failures.map((f) => f.name),
      ["outer > inner > deep", "parent > child bad"],
    );
    assert.match(run.result.tests.failures[0].message, /deep boom/);
    assert.equal(run.result.tests.failed, 2);
    assert.equal(run.result.tests.passed, 2);
  });

  test("parses the spec reporter when the command picks its own reporter", async () => {
    const repo = newRepo();
    const sha = commit(repo, NESTED_FAILING);
    const run = await runVerify(verifyArgs(repo, sha, { command: "node --test --test-reporter=spec test/*.test.mjs" }));

    // Had the job added its own reporter, node would have refused to start.
    assert.equal(run.result.ok, true);
    assert.deepEqual(
      run.result.tests.failures.map((f) => f.name),
      ["outer > inner > deep", "parent > child bad"],
    );
    assert.match(run.result.tests.failures[0].message, /deep boom/);
    assert.equal(run.result.tests.passed, 2);
  });

  // Each case: [title, command, expected result fields].
  const COMMAND_CASES = [
    [
      "a command that exits non-zero without tests fails with the output as evidence",
      "echo building; echo oops >&2; exit 3",
      { pass: false, exitCode: 3, passed: 0, failed: 1, failureNames: ["verify"], messageIncludes: ["building", "oops"] },
    ],
    ["a command that exits 0 without tests passes", "echo hello", { pass: true, exitCode: 0, passed: 0, failed: 0, failureNames: [] }],
    [
      "passing tests followed by a non-zero exit still fail",
      `${TEST_COMMAND}; exit 7`,
      { pass: false, exitCode: 7, passed: 4, failed: 1, failureNames: ["verify"] },
    ],
    [
      "failing tests fail even when the command swallows the exit code",
      `${TEST_COMMAND} || true`,
      { pass: false, exitCode: 0, passed: 1, failed: 1, failureNames: ["broken"] },
    ],
  ];
  for (const [title, command, expected] of COMMAND_CASES) {
    test(title, async () => {
      const repo = newRepo();
      const sha = commit(repo, expected.passed === 1 ? ONE_FAILING : PASSING);
      const run = await runVerify(verifyArgs(repo, sha, { command }));

      assert.equal(run.result.ok, true, run.stderr);
      assert.equal(run.result.pass, expected.pass);
      assert.equal(run.result.exitCode, expected.exitCode);
      assert.equal(run.result.tests.passed, expected.passed);
      assert.equal(run.result.tests.failed, expected.failed);
      assert.deepEqual(
        run.result.tests.failures.map((f) => f.name),
        expected.failureNames,
      );
      for (const text of expected.messageIncludes ?? []) assert.ok(run.result.tests.failures[0].message.includes(text), text);
    });
  }

  test("keeps only the tail of very large output and still reads its summary", async () => {
    const repo = newRepo();
    const sha = commit(repo, PASSING);
    // 3 MB of noise, then a summary: the 2 MB cap drops the start, the summary survives.
    const command = "head -c 3000000 /dev/zero | tr '\\0' x; echo; echo '# pass 5'; echo '# fail 0'";
    const run = await runVerify(verifyArgs(repo, sha, { command }));

    assert.equal(run.result.pass, true);
    assert.equal(run.result.tests.passed, 5);
    assert.equal(run.result.log.length, 4000);
    assert.ok(run.result.log.endsWith("# pass 5\n# fail 0\n"));
    // The live-log tee is bounded too, so a runaway command cannot fill the runner's disk.
    assert.ok(run.stderr.length < 2.5 * 1024 * 1024, `stderr was ${run.stderr.length} bytes`);
  });
});

// The command is the repo's own `verify` line, run over code an agent wrote, so it must not inherit the
// runner's credentials: a test that prints process.env would hand them to the agent through the log.
describe("verify.sh: what the command can see", () => {
  const CREDENTIALS = {
    RYKE_TOKEN: "tok-ryke-aaa",
    RYKE_INTERNAL_SECRET: "int-secret-bbb",
    RYKE_FORK_TOKEN: "art_v1_fork-ccc",
    TYPESAFE_API_KEY: "typesafe-key-ddd",
    ANTHROPIC_API_KEY: "sk-ant-eee",
    GITHUB_TOKEN: "ghp-fff",
    CLOUDFLARE_API_TOKEN: "cf-ggg",
    AWS_SECRET_ACCESS_KEY: "aws-hhh",
    DATABASE_PASSWORD: "pw-iii",
  };
  // What bash itself adds to an environment it is given.
  const BASH_OWN = ["PWD", "OLDPWD", "SHLVL", "_"];
  const ALLOWED = ["PATH", "HOME", "NO_COLOR", "LANG", "TMPDIR", "NODE_OPTIONS", ...BASH_OWN];

  function envSeenBy(run) {
    const seen = {};
    for (const line of readFileSync(join(run.cwd, "seen.env"), "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) seen[line.slice(0, at)] = line.slice(at + 1);
    }
    return seen;
  }

  test("a command sees PATH, HOME, NO_COLOR, LANG, TMPDIR and the reporter flag, and nothing else", async () => {
    const repo = newRepo();
    const sha = commit(repo, PASSING);
    const run = await runVerify(verifyArgs(repo, sha, { command: "env > ../seen.env" }), {
      env: { ...CREDENTIALS, LANG: "C.UTF-8", TMPDIR: "/var/tmp", FORCE_COLOR: "1", RYKE_API_URL: "http://api.test", SOME_SETTING: "x" },
    });
    assert.equal(run.result.ok, true, run.stderr);
    const seen = envSeenBy(run);
    assert.deepEqual(
      Object.keys(seen).filter((name) => !ALLOWED.includes(name)),
      [],
    );
    assert.equal(seen.PATH, process.env.PATH);
    assert.equal(seen.HOME, process.env.HOME);
    assert.equal(seen.NO_COLOR, "1");
    assert.equal(seen.LANG, "C.UTF-8");
    assert.equal(seen.TMPDIR, "/var/tmp");
    assert.equal(seen.NODE_OPTIONS, "--test-reporter=tap");
  });

  test("a command never sees a credential, by name or by value", async () => {
    const repo = newRepo();
    const sha = commit(repo, PASSING);
    const run = await runVerify(verifyArgs(repo, sha, { command: "env > ../seen.env; echo \"$RYKE_TOKEN|$TYPESAFE_API_KEY|$ANTHROPIC_API_KEY\"" }), { env: CREDENTIALS });
    const seen = envSeenBy(run);
    for (const name of Object.keys(seen)) assert.doesNotMatch(name, /TOKEN|KEY|SECRET|PASSWORD/i, name);
    const everything = readFileSync(join(run.cwd, "seen.env"), "utf8") + run.result.log;
    for (const value of Object.values(CREDENTIALS)) assert.equal(everything.includes(value), false, value);
    assert.match(run.result.log, /^\|\|$/m);
  });

  test("a test file that inspects process.env finds no credentials either", async () => {
    const repo = newRepo();
    const sha = commit(repo, {
      "test/env.test.mjs": `${HEADER}
test("no credential in the environment", () => {
  const names = Object.keys(process.env).filter((n) => /TOKEN|KEY|SECRET|PASSWORD/i.test(n));
  assert.deepEqual(names, []);
  assert.equal(process.env.RYKE_TOKEN, undefined);
});
`,
    });
    const run = await runVerify(verifyArgs(repo, sha), { env: CREDENTIALS });
    assert.equal(run.result.pass, true, JSON.stringify(run.result.tests));
    assert.deepEqual(run.result.tests, { passed: 1, failed: 0, failures: [] });
  });

  // The runner's own NODE_OPTIONS configures the job (this one runs under it); a `--require` there would
  // otherwise run inside every test of the candidate.
  test("NODE_OPTIONS from the job's own environment does not reach the command", async () => {
    const repo = newRepo();
    const sha = commit(repo, PASSING);
    const run = await runVerify(verifyArgs(repo, sha, { command: "env > ../seen.env" }), { env: { NODE_OPTIONS: "--max-old-space-size=256 --stack-trace-limit=7" } });
    assert.equal(run.result.ok, true, run.stderr);
    assert.equal(envSeenBy(run).NODE_OPTIONS, "--test-reporter=tap");
  });

  test("a command that picks its own reporter gets no NODE_OPTIONS at all", async () => {
    const repo = newRepo();
    const sha = commit(repo, PASSING);
    const run = await runVerify(verifyArgs(repo, sha, { command: "env > ../seen.env; node --test --test-reporter=spec test/*.test.mjs" }));
    assert.equal(run.result.ok, true, run.stderr);
    assert.equal("NODE_OPTIONS" in envSeenBy(run), false);
    assert.equal(run.result.tests.passed, 4);
  });

  test("variables the job does not have are not made up", async () => {
    const repo = newRepo();
    const sha = commit(repo, PASSING);
    const run = await runVerify(verifyArgs(repo, sha, { command: "env > ../seen.env" }), { env: { LANG: undefined, TMPDIR: undefined } });
    const seen = envSeenBy(run);
    assert.equal("LANG" in seen, false);
    assert.equal("TMPDIR" in seen, false);
  });
});

describe("verify.sh: timeout and termination", () => {
  test("a timeout kills the command's whole process group", async () => {
    const repo = newRepo();
    const sha = commit(repo, PASSING);
    const run = await runVerify(verifyArgs(repo, sha, { command: "sleep 30 & echo $! > ../child.pid; wait", timeout: 1 }));

    assert.equal(run.result.ok, true);
    assert.equal(run.result.timedOut, true);
    assert.equal(run.result.pass, false);
    assert.equal(run.result.exitCode, 143);
    assert.ok(run.elapsedMs < 20_000, `took ${run.elapsedMs} ms (the command sleeps 30 s)`);
    assert.equal(run.result.tests.failed, 1);
    assert.equal(run.result.tests.failures[0].name, "verify");
    assert.match(run.result.tests.failures[0].message, /^timed out after 1s/);
    const pid = Number(readFileSync(join(run.cwd, "child.pid"), "utf8"));
    assert.equal(alive(pid), false, "the backgrounded sleep survived the timeout");
  });

  test("a command that ignores SIGTERM is killed after the grace period", async () => {
    const repo = newRepo();
    const sha = commit(repo, PASSING);
    const run = await runVerify(verifyArgs(repo, sha, { command: "trap '' TERM; while true; do sleep 0.2; done", timeout: 1 }));

    assert.equal(run.result.timedOut, true);
    assert.equal(run.result.pass, false);
    assert.equal(run.result.exitCode, 137);
    assert.ok(run.elapsedMs < 20_000, `took ${run.elapsedMs} ms (the command sleeps 30 s)`);
  });

  test("terminating the job kills the command it started", async () => {
    const repo = newRepo();
    const sha = commit(repo, PASSING);
    const job = startVerify(verifyArgs(repo, sha, { command: "sleep 30 & echo $! > ../child.pid; wait" }));
    const pidFile = join(job.cwd, "child.pid");
    await waitForFile(pidFile);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(alive(pid), true);

    // The runner signals only the script's own group, and the command lives in another one.
    job.child.kill("SIGTERM");
    const run = await job.done;

    assert.equal(run.code, 143);
    assert.equal(alive(pid), false, "the command outlived its cancelled job");
  });
});

describe("verify.sh: checkout", () => {
  test("checks out the exact sha, which need not be a branch head", async () => {
    const repo = newRepo();
    const good = commit(repo, PASSING, { message: "good" });
    commit(repo, ONE_FAILING, { message: "head is broken" });

    const atSha = await runVerify(verifyArgs(repo, good));
    assert.equal(atSha.result.pass, true, "the older sha must be verified, not the branch head");

    const atBranch = await runVerify(verifyArgs(repo, "main"));
    assert.equal(atBranch.result.pass, false);
    assert.deepEqual(
      atBranch.result.tests.failures.map((f) => f.name),
      ["broken"],
    );

    const atFullRef = await runVerify(verifyArgs(repo, "refs/heads/main"));
    assert.equal(atFullRef.result.pass, false);
  });

  test("checks out a sha that no ref points to any more", async () => {
    const repo = newRepo();
    commit(repo, ONE_FAILING, { message: "trunk" });
    const candidate = commit(repo, PASSING, { branch: "scratch", message: "candidate" });
    git(repo.work, "push", "-q", repo.remote, ":refs/heads/scratch");

    const run = await runVerify(verifyArgs(repo, candidate));
    assert.equal(run.result.ok, true, JSON.stringify(run.result));
    assert.equal(run.result.pass, true);
  });
});

async function closedPort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

describe("verify.sh: infrastructure errors", () => {
  // The store hands out basic-auth tokens; the local flavour has a user part, a bare token does not.
  for (const userinfo of ["agent:s3cr3t-token", "s3cr3t-token"]) {
    test(`an unreachable remote is ok:false and never echoes its credentials (${userinfo.includes(":") ? "user:token" : "token only"})`, async () => {
      const port = await closedPort();
      const run = await runVerify({
        remote: `http://${userinfo}@127.0.0.1:${port}/git/ryke/convert.git`,
        ref: "a".repeat(40),
        command: "true",
        timeout: 5,
      });

      assert.equal(run.code, 1);
      assert.equal(run.result.ok, false);
      assert.match(run.result.error, /^could not check out a{40}/);
      assert.ok(!run.stdout.includes("s3cr3t-token"), "the token leaked into the result");
      assert.ok(!run.stderr.includes("s3cr3t-token"), "the token leaked into the job log");
      assert.ok(run.result.error.includes("//***@"), run.result.error);
      assert.equal("tests" in run.result, false);
    });
  }

  test("a missing remote path and an unknown sha are ok:false", async () => {
    const missing = await runVerify({ remote: join(ROOT, "no-such-repo.git"), ref: "main", command: "true", timeout: 5 });
    assert.equal(missing.result.ok, false);
    assert.equal(missing.code, 1);

    const repo = newRepo();
    commit(repo, PASSING);
    const unknownSha = await runVerify(verifyArgs(repo, "1".repeat(40)));
    assert.equal(unknownSha.result.ok, false);
    assert.match(unknownSha.result.error, /could not check out 1{40}/);
  });

  // Each case: [title, args to remove or replace, error pattern].
  const BAD_ARGS = [
    ["no --remote", { remote: undefined }, /--remote is required/],
    ["no --ref", { ref: undefined }, /--ref is required/],
    ["no --command", { command: undefined }, /--command is required/],
    ["no --timeout", { timeout: undefined }, /--timeout must be a positive number/],
    ["a zero --timeout", { timeout: 0 }, /--timeout must be a positive number/],
    ["a negative --timeout", { timeout: -3 }, /--timeout must be a positive number/],
    ["a non-numeric --timeout", { timeout: "soon" }, /--timeout must be a positive number/],
  ];
  for (const [title, override, pattern] of BAD_ARGS) {
    test(`rejects ${title}`, async () => {
      const args = { remote: join(ROOT, "unused.git"), ref: "main", command: "true", timeout: 5, ...override };
      for (const key of Object.keys(args)) if (args[key] === undefined) delete args[key];
      const run = await runVerify(args);

      assert.equal(run.code, 1);
      assert.equal(run.result.ok, false);
      assert.match(run.result.error, pattern);
    });
  }
});

describe("verify.sh: screenshot", () => {
  test("saves a 1280x800 png as evidence and stops the app", async () => {
    const repo = newRepo();
    const sha = commit(repo, { ...PASSING, ...APP });
    const run = await runVerify(verifyArgs(repo, sha, { screenshot: "/hello", "preview-main": "src/index.ts" }));

    assert.equal(run.result.ok, true, JSON.stringify(run.result));
    assert.equal(run.result.pass, true);
    assert.equal(run.result.screenshotError, undefined);
    assert.equal(run.result.screenshot, `${run.jobId}.png`);
    const file = join(run.evidence, run.result.screenshot);
    assert.ok(existsSync(file), "no screenshot file");
    assert.ok(statSync(file).size > 1000, "the screenshot is empty");
    const png = readFileSync(file);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 1280);
    assert.equal(png.readUInt32BE(20), 800);

    assert.match(readFileSync(join(run.cwd, "requests.log"), "utf8"), /^\/hello$/m, "the requested route reached the app");
    const appPid = Number(readFileSync(join(run.cwd, "app.pid"), "utf8"));
    assert.equal(alive(appPid), false, "the preview app was left running");
  });

  test("takes the screenshot of a route without a leading slash", async () => {
    const repo = newRepo();
    const sha = commit(repo, { ...PASSING, ...APP });
    const run = await runVerify(verifyArgs(repo, sha, { screenshot: "c/length", "preview-main": "src/index.ts" }));

    assert.equal(run.result.screenshot, `${run.jobId}.png`, JSON.stringify(run.result));
    assert.match(readFileSync(join(run.cwd, "requests.log"), "utf8"), /^\/c\/length$/m);
  });

  // The verify itself must still succeed: a missing picture is not a failed candidate.
  // Each case: [title, extra args, env override, error pattern].
  const SCREENSHOT_FAILURES = [
    ["a missing app module", { screenshot: "/", "preview-main": "src/missing.ts" }, {}, /preview app exited.*missing\.ts/s],
    ["a default export without fetch", { screenshot: "/", "preview-main": "src/nofetch.ts" }, {}, /fetch\(request, env, ctx\)/],
    ["no --preview-main", { screenshot: "/" }, {}, /--preview-main is required/],
    ["a --preview-main outside the checkout", { screenshot: "/", "preview-main": "../outside.mjs" }, {}, /must stay inside the checkout/],
    ["no evidence directory", { screenshot: "/", "preview-main": "src/index.ts" }, { RYKE_EVIDENCE_DIR: "" }, /RYKE_EVIDENCE_DIR/],
  ];
  for (const [title, extra, env, pattern] of SCREENSHOT_FAILURES) {
    test(`records screenshotError for ${title} and still reports the tests`, async () => {
      const repo = newRepo();
      const sha = commit(repo, { ...PASSING, ...APP });
      const run = await runVerify(verifyArgs(repo, sha, extra), { env });

      assert.equal(run.code, 0);
      assert.equal(run.result.ok, true);
      assert.equal(run.result.pass, true);
      assert.deepEqual(run.result.tests, { passed: 4, failed: 0, failures: [] });
      assert.equal("screenshot" in run.result, false);
      assert.match(run.result.screenshotError, pattern);
    });
  }
});

// ---- testsum.mjs ------------------------------------------------------------------------------

const lines = (...rows) => `${rows.join("\n")}\n`;

const TAP_NESTED = lines(
  "TAP version 13",
  "# Subtest: top ok",
  "ok 1 - top ok",
  "  ---",
  "  duration_ms: 0.675853",
  "  type: 'test'",
  "  ...",
  "# Subtest: suite A",
  "    # Subtest: passes",
  "    ok 1 - passes",
  "      ---",
  "      duration_ms: 1.647912",
  "      type: 'test'",
  "      ...",
  "    # Subtest: fails here",
  "    not ok 2 - fails here",
  "      ---",
  "      duration_ms: 1.089279",
  "      type: 'test'",
  "      location: '/x/a.test.mjs:6:3'",
  "      failureType: 'testCodeFailure'",
  "      error: |-",
  "        Expected values to be strictly equal:",
  "        ",
  "        1 !== 2",
  "        ",
  "      code: 'ERR_ASSERTION'",
  "      name: 'AssertionError'",
  "      expected: 2",
  "      actual: 1",
  "      operator: 'strictEqual'",
  "      stack: |-",
  "        TestContext.<anonymous> (file:///x/a.test.mjs:6:33)",
  "        Test.run (node:internal/test_runner/test:1047:25)",
  "      ...",
  "    # Subtest: inner",
  "        # Subtest: deep fail",
  "        not ok 1 - deep fail",
  "          ---",
  "          duration_ms: 0.132923",
  "          type: 'test'",
  "          failureType: 'testCodeFailure'",
  "          error: |-",
  "            boom",
  "            second line",
  "          code: 'ERR_TEST_FAILURE'",
  "          ...",
  "        1..1",
  "    not ok 3 - inner",
  "      ---",
  "      type: 'suite'",
  "      failureType: 'subtestsFailed'",
  "      error: '1 subtest failed'",
  "      code: 'ERR_TEST_FAILURE'",
  "      ...",
  "    1..3",
  "not ok 2 - suite A",
  "  ---",
  "  type: 'suite'",
  "  failureType: 'subtestsFailed'",
  "  error: '2 subtests failed'",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
  "# Subtest: parent",
  "    # Subtest: child ok",
  "    ok 1 - child ok",
  "      ---",
  "      type: 'test'",
  "      ...",
  "    # Subtest: child bad",
  "    not ok 2 - child bad",
  "      ---",
  "      type: 'test'",
  "      failureType: 'testCodeFailure'",
  "      error: |-",
  "        Expected values to be strictly deep-equal:",
  "        + actual - expected",
  "        ",
  "          {",
  "        +   a: 1",
  "        -   a: 2",
  "          }",
  "        ",
  "      code: 'ERR_ASSERTION'",
  "      ...",
  "    1..2",
  "not ok 3 - parent",
  "  ---",
  "  type: 'test'",
  "  failureType: 'subtestsFailed'",
  "  error: '1 subtest failed'",
  "  ...",
  "1..3",
  "# tests 7",
  "# suites 2",
  "# pass 3",
  "# fail 4",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 144.154304",
);

const SPEC_NESTED = lines(
  "✔ top ok (0.759521ms)",
  "▶ suite A",
  "  ✔ passes (1.190014ms)",
  "  ✖ fails here (0.955666ms)",
  "  ▶ inner",
  "    ✖ deep fail (0.116665ms)",
  "  ✖ inner (0.244555ms)",
  "✖ suite A (2.966176ms)",
  "▶ parent",
  "  ✔ child ok (0.131536ms)",
  "  ✖ child bad (2.097154ms)",
  "✖ parent (2.973063ms)",
  "ℹ tests 7",
  "ℹ suites 2",
  "ℹ pass 3",
  "ℹ fail 4",
  "ℹ cancelled 0",
  "ℹ skipped 0",
  "ℹ todo 0",
  "ℹ duration_ms 156.176612",
  "",
  "✖ failing tests:",
  "",
  "test at a.test.mjs:6:3",
  "✖ fails here (0.955666ms)",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "  ",
  "  1 !== 2",
  "  ",
  "      at TestContext.<anonymous> (file:///x/a.test.mjs:6:33)",
  "      at Test.run (node:internal/test_runner/test:1047:25) {",
  "    generatedMessage: true,",
  "    code: 'ERR_ASSERTION',",
  "    operator: 'strictEqual'",
  "  }",
  "",
  "test at a.test.mjs:8:5",
  "✖ deep fail (0.116665ms)",
  "  Error: boom",
  "  second line",
  "      at TestContext.<anonymous> (file:///x/a.test.mjs:8:35)",
  "",
  "test at a.test.mjs:13:11",
  "✖ child bad (2.097154ms)",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:",
  "  + actual - expected",
  "  ",
  "    {",
  "  +   a: 1",
  "  -   a: 2",
  "    }",
  "  ",
  "      at TestContext.<anonymous> (file:///x/a.test.mjs:13:42)",
);

const NESTED_FAILURES = [
  ["suite A > fails here", /^(AssertionError \[ERR_ASSERTION\]: )?Expected values to be strictly equal:\n\n1 !== 2$/],
  ["suite A > inner > deep fail", /^(Error: )?boom\nsecond line$/],
  ["parent > child bad", /Expected values to be strictly deep-equal:\n\+ actual - expected\n\n {2}\{\n\+ {3}a: 1\n- {3}a: 2\n {2}\}$/],
];

// Each case: [title, output, expected passed, expected failed, expected [name, message] pairs
// (a RegExp message is matched, a string is compared exactly), or undefined for unrecognised output].
const PARSE_CASES = [
  ["TAP: nested failures list leaves only, with full paths", TAP_NESTED, 3, 3, NESTED_FAILURES],
  ["spec: nested failures list leaves only, with full paths", SPEC_NESTED, 3, 3, NESTED_FAILURES],
  [
    "TAP: all passing, suites not counted",
    lines(
      "TAP version 13",
      "# Subtest: adds",
      "ok 1 - adds",
      "  ---",
      "  type: 'test'",
      "  ...",
      "# Subtest: group",
      "    # Subtest: first",
      "    ok 1 - first",
      "      ---",
      "      type: 'test'",
      "      ...",
      "    1..1",
      "ok 2 - group",
      "  ---",
      "  type: 'suite'",
      "  ...",
      "1..2",
      "# tests 2",
      "# suites 1",
      "# pass 2",
      "# fail 0",
    ),
    2,
    0,
    [],
  ],
  [
    "spec: all passing, suites not counted",
    lines("✔ adds (0.4ms)", "▶ group", "  ✔ first (0.1ms)", "✔ group (0.5ms)", "ℹ tests 2", "ℹ suites 1", "ℹ pass 2", "ℹ fail 0"),
    2,
    0,
    [],
  ],
  [
    "TAP: a passing parent test counts once through its leaves",
    lines(
      "# Subtest: parent",
      "    # Subtest: a",
      "    ok 1 - a",
      "      ---",
      "      type: 'test'",
      "      ...",
      "    # Subtest: b",
      "    ok 2 - b",
      "      ---",
      "      type: 'test'",
      "      ...",
      "    1..2",
      "ok 1 - parent",
      "  ---",
      "  type: 'test'",
      "  ...",
      "1..1",
      "# pass 3",
      "# fail 0",
    ),
    2,
    0,
    [],
  ],
  [
    "TAP: a parent that fails on its own, with passing children, is a failure",
    lines(
      "# Subtest: parent",
      "    # Subtest: a",
      "    ok 1 - a",
      "      ---",
      "      type: 'test'",
      "      ...",
      "    1..1",
      "not ok 1 - parent",
      "  ---",
      "  type: 'test'",
      "  failureType: 'testCodeFailure'",
      "  error: 'late throw'",
      "  ...",
      "1..1",
      "# pass 1",
      "# fail 1",
    ),
    1,
    1,
    [["parent", "late throw"]],
  ],
  [
    "spec: a parent that fails on its own, with passing children, is a failure",
    lines(
      "▶ parent",
      "  ✔ a (0.1ms)",
      "✖ parent (0.3ms)",
      "ℹ pass 1",
      "ℹ fail 1",
      "",
      "✖ failing tests:",
      "",
      "test at t.test.mjs:1:1",
      "✖ parent (0.3ms)",
      "  Error: late throw",
      "      at t.test.mjs:3:9",
    ),
    1,
    1,
    [["parent", "Error: late throw"]],
  ],
  [
    "TAP: skipped and todo entries are neither passes nor failures",
    lines(
      "# Subtest: later",
      "ok 1 - later # SKIP",
      "# Subtest: wip",
      "not ok 2 - wip # TODO",
      "# Subtest: real",
      "ok 3 - real",
      "1..3",
      "# pass 1",
      "# fail 0",
    ),
    1,
    0,
    [],
  ],
  [
    "spec: skipped and todo entries are neither passes nor failures",
    lines("﹣ later (0.1ms) # SKIP", "✖ wip (0.1ms) # TODO", "✔ real (0.2ms)", "ℹ pass 1", "ℹ fail 0"),
    1,
    0,
    [],
  ],
  [
    "TAP: escaped names are restored",
    lines("# Subtest: issue \\#42 \\\\ done", "not ok 1 - issue \\#42 \\\\ done", "  ---", "  error: 'nope'", "  ...", "1..1", "# pass 0", "# fail 1"),
    0,
    1,
    [["issue #42 \\ done", "nope"]],
  ],
  [
    "TAP: output quoted inside an error block is not parsed as results",
    lines(
      "# Subtest: runs a child suite",
      "not ok 1 - runs a child suite",
      "  ---",
      "  type: 'test'",
      "  error: |-",
      "    expected the child to pass:",
      "    ok 9 - fake pass",
      "    not ok 10 - fake fail",
      "    # fail 99",
      "  ...",
      "1..1",
      "# pass 0",
      "# fail 1",
    ),
    0,
    1,
    [["runs a child suite", "expected the child to pass:\nok 9 - fake pass\nnot ok 10 - fake fail\n# fail 99"]],
  ],
  [
    "TAP: a test file that cannot load is a failure named after the file",
    lines(
      "TAP version 13",
      "# Error: Cannot find module '/work/tree/test'",
      "# Subtest: test",
      "not ok 1 - test",
      "  ---",
      "  type: 'test'",
      "  failureType: 'testCodeFailure'",
      "  exitCode: 1",
      "  signal: ~",
      "  error: 'test failed'",
      "  code: 'ERR_TEST_FAILURE'",
      "  ...",
      "1..1",
      "# pass 0",
      "# fail 1",
    ),
    0,
    1,
    [["test", "test failed"]],
  ],
  [
    "TAP: an empty suite is not a passing test",
    lines("# Subtest: empty", "ok 1 - empty", "  ---", "  type: 'suite'", "  ...", "1..1", "# pass 0", "# fail 0"),
    0,
    0,
    [],
  ],
  [
    "TAP: a log cut at the start still reports the summary counts",
    lines(
      "    # Subtest: late",
      "    not ok 4 - late",
      "      ---",
      "      error: 'only this one is visible'",
      "      ...",
      "# tests 12",
      "# pass 9",
      "# fail 3",
    ),
    9,
    3,
    [["late", "only this one is visible"]],
  ],
  [
    "spec: two leaves with the same name get their own messages in order",
    lines(
      "▶ a",
      "  ✖ same (0.1ms)",
      "✖ a (0.2ms)",
      "▶ b",
      "  ✖ same (0.1ms)",
      "✖ b (0.2ms)",
      "ℹ pass 0",
      "ℹ fail 4",
      "",
      "✖ failing tests:",
      "",
      "test at x.test.mjs:2:3",
      "✖ same (0.1ms)",
      "  Error: first",
      "      at x.test.mjs:2:3",
      "",
      "test at x.test.mjs:5:3",
      "✖ same (0.1ms)",
      "  Error: second",
      "      at x.test.mjs:5:3",
    ),
    0,
    2,
    [
      ["a > same", "Error: first"],
      ["b > same", "Error: second"],
    ],
  ],
  [
    "spec: a failure without a details block keeps an empty message",
    lines("✖ lonely (0.1ms)", "ℹ pass 0", "ℹ fail 1"),
    0,
    1,
    [["lonely", ""]],
  ],
  [
    "spec: ansi colours are ignored",
    lines("\u001b[32m✔ green (0.1ms)\u001b[39m", "\u001b[31m✖ red (0.2ms)\u001b[39m", "\u001b[34mℹ pass 1\u001b[39m", "\u001b[34mℹ fail 1\u001b[39m"),
    1,
    1,
    [["red", ""]],
  ],
  ["summary lines alone are enough", lines("# pass 2", "# fail 0"), 2, 0, []],
  ["unrecognised output", lines("building...", "ok done", "all good"), undefined],
  ["empty output", "", undefined],
];

describe("testsum: parseTestOutput", () => {
  for (const [title, output, passed, failed, failures] of PARSE_CASES) {
    test(title, () => {
      const summary = parseTestOutput(output);
      if (passed === undefined) {
        assert.equal(summary, undefined);
        return;
      }
      assert.equal(summary.passed, passed);
      assert.equal(summary.failed, failed);
      assert.equal(summary.failures.length, failures.length);
      failures.forEach(([name, message], i) => {
        assert.equal(summary.failures[i].name, name);
        if (message instanceof RegExp) assert.match(summary.failures[i].message, message);
        else assert.equal(summary.failures[i].message, message);
      });
    });
  }
});

describe("testsum: summarizeTests", () => {
  const thirty = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const lastTwenty = Array.from({ length: 20 }, (_, i) => `line ${i + 11}`).join("\n");

  // Each case: [title, output, options, expected passed, expected failed, expected failures].
  const CASES = [
    ["unknown output with exit 0 is an empty pass", thirty, { exitCode: 0 }, 0, 0, []],
    [
      "unknown output with a non-zero exit names verify and quotes the last 20 lines",
      thirty,
      { exitCode: 1 },
      0,
      1,
      [{ name: "verify", message: lastTwenty }],
    ],
    ["a timeout with no output says so", "", { exitCode: 143, timedOut: true, timeoutSeconds: 5 }, 0, 1, [{ name: "verify", message: "timed out after 5s" }]],
    [
      "a timeout keeps the output after the note",
      "still running",
      { exitCode: 143, timedOut: true, timeoutSeconds: 2 },
      0,
      1,
      [{ name: "verify", message: "timed out after 2s\nstill running" }],
    ],
    [
      "recognised passes with a non-zero exit add a verify failure",
      lines("# pass 4", "# fail 0"),
      { exitCode: 2 },
      4,
      1,
      [{ name: "verify", message: "# pass 4\n# fail 0" }],
    ],
    [
      "recognised failures are not joined by a verify failure",
      lines("✔ ok (1ms)", "✖ bad (1ms)", "ℹ pass 1", "ℹ fail 1"),
      { exitCode: 1 },
      1,
      1,
      [{ name: "bad", message: "" }],
    ],
    [
      "a summary that counts failures with no entries to name them gets a verify failure",
      lines("# pass 2", "# fail 3"),
      { exitCode: 1 },
      2,
      3,
      [{ name: "verify", message: "# pass 2\n# fail 3" }],
    ],
  ];
  for (const [title, output, options, passed, failed, failures] of CASES) {
    test(title, () => {
      assert.deepEqual(summarizeTests(output, options), { passed, failed, failures });
    });
  }

  test("lists at most 50 failures but still counts all of them", () => {
    const output = lines(
      ...Array.from({ length: 60 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`),
      "# pass 0",
      "# fail 60",
    );
    const summary = summarizeTests(output, { exitCode: 1 });
    assert.equal(summary.failed, 60);
    assert.equal(summary.failures.length, 50);
    assert.equal(summary.failures[0].name, "case 1");
    assert.equal(summary.failures[49].name, "case 50");
  });

  test("clips long failure messages", () => {
    const output = lines("not ok 1 - huge", "  ---", `  error: '${"x".repeat(5000)}'`, "  ...", "# pass 0", "# fail 1");
    const [failure] = summarizeTests(output, { exitCode: 1 }).failures;
    assert.equal(failure.message.length, 1001);
    assert.ok(failure.message.endsWith("…"));
  });

  test("the fallback message is capped and keeps the end of enormous output", () => {
    const summary = summarizeTests(`${"y".repeat(10_000)}THE END`, { exitCode: 1 });
    assert.equal(summary.failures[0].message.length, 1000);
    assert.ok(summary.failures[0].message.endsWith("yyyTHE END"));
  });

  test("a timeout note and a long tail together still fit the cap", () => {
    const summary = summarizeTests(`${"y".repeat(10_000)}THE END`, { exitCode: 143, timedOut: true, timeoutSeconds: 9 });
    assert.equal(summary.failures[0].message.length, 1000);
    assert.ok(summary.failures[0].message.startsWith("timed out after 9s\n"));
    assert.ok(summary.failures[0].message.endsWith("THE END"));
  });
});

describe("testsum: helpers", () => {
  // Each case: [text, count, expected].
  const TAIL_CASES = [
    ["a\nb\nc\n", 2, "b\nc"],
    ["a\nb\n", 5, "a\nb"],
    ["a\r\nb\r\n", 1, "b"],
    ["", 3, ""],
    ["a\n\n\n", 2, "a"],
  ];
  for (const [text, count, expected] of TAIL_CASES) {
    test(`tailLines(${JSON.stringify(text)}, ${count})`, () => {
      assert.equal(tailLines(text, count), expected);
    });
  }

  test("stripAnsi removes colour codes and keeps the text", () => {
    assert.equal(stripAnsi("\u001b[1;31mred\u001b[0m plain"), "red plain");
  });
});
