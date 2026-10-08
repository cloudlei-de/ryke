// verify job (PLAN.md §5.3 step 2): checks out a candidate, runs the policy's verify command under a
// timeout and reports the test results. With --screenshot it also saves a 1280x800 picture of the
// demo app's preview route as evidence.
//
//   verify.sh --remote <url> --ref <sha|ref> --command <shell> --timeout <seconds>
//             [--screenshot <route> --preview-main <path in the tree>] [--txn-files <json>]
//
// --txn-files is accepted and ignored: the Land Workflow passes it, but nothing here consumes it.
// Stdout is one JSON line. `ok: false` means the job itself broke (checkout failed, bad arguments);
// failing tests are `ok: true, pass: false`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { git, main } from "./common.mjs";
import { stripAnsi, summarizeTests } from "./testsum.mjs";

const ROOT = process.env.RYKE_ROOT ?? resolve(import.meta.dirname, "../../..");
const SERVE_APP = join(import.meta.dirname, "serve-app.mjs");

const OUTPUT_CAP_BYTES = 2 * 1024 * 1024;
const LOG_CHARS = 4000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout wraps around beyond this
// SIGTERM first so the command can clean up; SIGKILL if it ignores it.
const KILL_GRACE_MS = 1000;
// A descendant that left the process group can hold the output pipes open forever.
const DRAIN_MS = 1000;
const FETCH_STALL_SECONDS = 30;
const APP_START_MS = 15_000;
const PAGE_MS = 15_000;
const BROWSERS_PATH = "/opt/pw-browsers";

// Every child runs in its own process group (so a timeout can kill the command and everything it
// started), which also puts it outside the group the runner signals on cancel. Cancel therefore
// reaches only this process, and it has to take the children down itself.
const live = new Set();
const killGroup = (child, signal) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
};
const killLive = () => {
  for (const child of live) killGroup(child, "SIGKILL");
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    killLive();
    process.exit(128 + osConstants.signals[signal]);
  });
}
process.on("exit", killLive);
// The log tee must not crash the job when the runner has already closed its end of the pipe.
process.stderr.on("error", () => {});

function spawnGroup(file, argv, options) {
  const child = spawn(file, argv, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  live.add(child);
  return child;
}

function stopGroup(child) {
  killGroup(child, "SIGKILL");
  live.delete(child);
}

// Remotes carry basic-auth credentials and git echoes the URL in its errors.
const scrub = (text) => String(text).replace(/\/\/[^/@\s]*@/g, "//***@");
const describe = (err) => scrub(err.message).slice(0, 800);

// Keeps the end of the stream: the summary and the last failures are what matter.
function tailBuffer(capBytes) {
  const chunks = [];
  let size = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      while (chunks.length > 1 && size - chunks[0].length >= capBytes) size -= chunks.shift().length;
    },
    text: () => Buffer.concat(chunks).subarray(-capBytes).toString("utf8"),
  };
}

async function checkout(tree, remote, ref) {
  try {
    await mkdir(tree, { recursive: true });
    await git(tree, ["init", "-q", "--template="]);
    // `--` because the ref and remote come from outside and must never parse as options. The URL is
    // passed directly so credentials are not written to .git/config, and a stalled transfer aborts.
    await git(tree, ["fetch", "-q", "--no-tags", "--", remote, ref], {
      env: { GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: String(FETCH_STALL_SECONDS) },
    });
    await git(tree, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
  } catch (err) {
    throw new Error(`could not check out ${ref}: ${scrub(err.message)}`);
  }
}

// The command runs the repo's own `verify` line over code an agent wrote, so it starts from nothing:
// the job's environment holds the runner's and the API's credentials, and a test that prints
// process.env would put them in the log the agent reads. Only what a build needs to find its tools.
const PASSED_ON = ["PATH", "HOME", "LANG", "TMPDIR"];

function commandEnv(command) {
  const env = { NO_COLOR: "1" };
  for (const name of PASSED_ON) if (process.env[name] !== undefined) env[name] = process.env[name];
  // TAP is the reporter whose summary and failure details are easiest to parse reliably. A second
  // --test-reporter (the command's own) makes node throw because the destinations no longer match,
  // so in that case the output is parsed as it comes. NODE_OPTIONS of the job is not inherited: it
  // is the runner's configuration, and `--require` in it would run inside the candidate's tests.
  if (process.allowedNodeEnvironmentFlags.has("--test-reporter") && !/test-reporter/.test(command)) {
    env.NODE_OPTIONS = "--test-reporter=tap";
  }
  return env;
}

async function runCommand(command, cwd, timeoutMs) {
  const out = tailBuffer(OUTPUT_CAP_BYTES);
  let streamed = 0;
  // Tee to stderr for the runner's live log, bounded so a runaway command cannot fill the disk.
  const onData = (chunk) => {
    out.push(chunk);
    if (streamed < OUTPUT_CAP_BYTES) {
      streamed += chunk.length;
      process.stderr.write(chunk);
    }
  };
  const child = spawnGroup("bash", ["-c", command], { cwd, env: commandEnv(command) });
  const closed = new Promise((resolveClosed) => child.once("close", resolveClosed));
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const started = Date.now();
  let timedOut = false;
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child, "SIGTERM");
    killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
  }, Math.min(timeoutMs, MAX_TIMEOUT_MS));

  try {
    const [code, signal] = await new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (c, s) => resolveExit([c, s]));
    });
    const durationMs = Date.now() - started;
    // Sweep what the command left running, e.g. a server it backgrounded.
    killGroup(child, "SIGKILL");
    await Promise.race([closed, sleep(DRAIN_MS, undefined, { ref: false })]);
    return { exitCode: code ?? 128 + (osConstants.signals[signal] ?? 0), durationMs, timedOut, output: out.text() };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    child.stdout.destroy();
    child.stderr.destroy();
    stopGroup(child);
  }
}

// ---- screenshot ------------------------------------------------------------------------------

function loadPlaywright() {
  // Playwright reads this once, at load.
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(BROWSERS_PATH)) process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;
  return createRequire(join(ROOT, "package.json"))("playwright");
}

function startApp(tree, entry) {
  const child = spawnGroup(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", SERVE_APP, entry],
    // Candidate code, so no job env: the preview is a Worker without bindings or secrets.
    { cwd: tree, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  return new Promise((resolveApp, rejectApp) => {
    let stdout = "";
    let stderr = "";
    const fail = (message) => {
      clearTimeout(timer);
      stopGroup(child);
      rejectApp(new Error(message));
    };
    const timer = setTimeout(() => fail(`the preview app did not start within ${APP_START_MS / 1000}s`), APP_START_MS);
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4096)));
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /\{"port":(\d+)\}/.exec(stdout);
      if (match === null) return;
      clearTimeout(timer);
      resolveApp({ child, port: Number(match[1]) });
    });
    child.once("error", (err) => fail(`could not start the preview app: ${err.message}`));
    child.once("exit", (code) => fail(`the preview app exited with code ${code} before listening: ${stderr.trim().slice(-800)}`));
  });
}

async function takeScreenshot({ tree, route, previewMain }) {
  const { RYKE_EVIDENCE_DIR: evidenceDir, RYKE_JOB_ID: jobId } = process.env;
  if (!evidenceDir || !jobId) throw new Error("RYKE_EVIDENCE_DIR and RYKE_JOB_ID must be set to save a screenshot");
  if (!previewMain) throw new Error("--preview-main is required with --screenshot");
  const entry = resolve(tree, previewMain);
  if (!entry.startsWith(`${tree}${sep}`)) throw new Error(`--preview-main must stay inside the checkout: ${previewMain}`);

  const { chromium } = loadPlaywright();
  const app = await startApp(tree, entry);
  let browser;
  try {
    // Chromium refuses to start as root (the container user) with its sandbox on.
    browser = await chromium.launch({ args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${app.port}${route.startsWith("/") ? route : `/${route}`}`, {
      waitUntil: "load",
      timeout: PAGE_MS,
    });
    await mkdir(evidenceDir, { recursive: true });
    const file = `${jobId}.png`;
    await page.screenshot({ path: join(evidenceDir, file), timeout: PAGE_MS });
    return file;
  } finally {
    await browser?.close().catch(() => {});
    stopGroup(app.child);
  }
}

// ---- job -------------------------------------------------------------------------------------

main(async (a) => {
  const { remote, ref, command } = a;
  for (const [flag, value] of [["remote", remote], ["ref", ref], ["command", command]]) {
    if (!value) throw new Error(`--${flag} is required`);
  }
  const timeoutSeconds = Number(a.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout must be a positive number of seconds");

  const tree = resolve("tree");
  await checkout(tree, remote, ref);

  const run = await runCommand(command, tree, timeoutSeconds * 1000);
  const tests = summarizeTests(run.output, { exitCode: run.exitCode, timedOut: run.timedOut, timeoutSeconds });
  const result = {
    ok: true,
    pass: run.exitCode === 0 && tests.failed === 0 && !run.timedOut,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    timedOut: run.timedOut,
    tests,
    log: stripAnsi(run.output).slice(-LOG_CHARS),
  };

  // Evidence only: a missing picture must not fail a verify whose tests passed. It is taken even
  // when the tests failed, since the Workflow decides by arguments whether it wants one.
  if (a.screenshot) {
    try {
      result.screenshot = await takeScreenshot({ tree, route: a.screenshot, previewMain: a["preview-main"] });
    } catch (err) {
      result.screenshotError = describe(err);
    }
  }
  return result;
});
