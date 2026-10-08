// Shared by the runner job scripts. Every input arrives as `--key value` arguments or env vars and
// every result leaves as one JSON line on stdout, so the same files run as host processes
// (dev/runner) and inside the Runner container.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export function args(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = "true";
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

export const LANDER = { name: "Ryke", email: "lander@ryke.ai" };

export function gitEnv(extra = {}) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: LANDER.name,
    GIT_AUTHOR_EMAIL: LANDER.email,
    GIT_COMMITTER_NAME: LANDER.name,
    GIT_COMMITTER_EMAIL: LANDER.email,
    ...extra,
  };
}

export async function git(cwd, argv, { env = {}, input, allowFail = false } = {}) {
  try {
    const p = run("git", argv, { cwd, env: gitEnv(env), maxBuffer: 64 * 1024 * 1024 });
    if (input !== undefined) {
      p.child.stdin.end(input);
    }
    const { stdout } = await p;
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    if (!allowFail) throw new Error(`git ${argv.join(" ")} failed (${e.code}): ${e.stderr || e.message}`);
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

export function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function redact(text) {
  return String(text).replace(/\/\/[^/@\s]*:[^/@\s]*@/g, "//***@");
}

export async function main(fn) {
  try {
    const result = await fn(args());
    emit(result);
    process.exit(result && result.ok === false ? 1 : 0);
  } catch (e) {
    emit({ ok: false, error: redact(e.message) });
    process.exit(1);
  }
}
