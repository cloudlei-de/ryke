// Shared by the Claude Code hooks of agent mode (PLAN.md §7.2, §10.4) and by lib/agent.mjs.
// Hooks run inside the agent's checkout, once per tool call, as separate short-lived processes, so
// everything they share lives in files under .ryke/ and in environment variables set by agent.mjs.
// A hook must never get in the agent's way: every failure ends in a stderr line and exit 0.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// §7.2: a lease never blocks an agent for longer than this.
export const LEASE_PATIENCE_MS = 90_000;
// POST /reads takes at most this many paths per call (§6.1).
export const READS_BATCH = 500;
// Claude Code truncates a hook's additionalContext at 10,000 characters and replaces it with a file path.
const CONTEXT_MAX = 9000;
const DIFF_FILE_MAX = 3000;
const DIFF_TOTAL_MAX = 8000;
const DIFFS_MAX = 5;

// Not part of the repo, or not something trunk could ever change: reading them says nothing about conflicts.
const NOT_REPO = [".git", ".claude", ".ryke", "node_modules"];

export const log = (line) => process.stderr.write(`ryke-hook: ${line}\n`);

const number = (raw, fallback) => (Number.isFinite(Number(raw)) && raw !== undefined && raw !== "" ? Number(raw) : fallback);

// `input` is the hook's stdin payload; its `cwd` is only a fallback because agent.mjs always sets RYKE_CHECKOUT.
export function loadConfig(env = process.env, input = {}) {
  const checkout = resolve(env.RYKE_CHECKOUT || env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  return {
    api: (env.RYKE_API_URL ?? "").replace(/\/+$/, ""),
    token: env.RYKE_TOKEN ?? "",
    txn: env.RYKE_TXN ?? "",
    repo: env.RYKE_REPO ?? "",
    checkout,
    cwd: input.cwd ?? checkout,
    snapshot: env.RYKE_SNAPSHOT || "HEAD",
    patienceMs: number(env.RYKE_LEASE_PATIENCE_MS, LEASE_PATIENCE_MS),
    timeoutMs: number(env.RYKE_HOOK_TIMEOUT_MS, 10_000),
    contention: env.RYKE_CONTENTION !== "off",
  };
}

export const hasApi = (cfg) => cfg.api !== "" && cfg.txn !== "";

export async function apiCall(cfg, method, path, body) {
  const res = await fetch(cfg.api + path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const e = new Error(`${method} ${path} -> ${res.status} ${String(typeof data === "object" && data !== null ? (data.error ?? JSON.stringify(data)) : data).slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

// ---------------------------------------------------------------------------------------------
// Paths: what a tool touched, as the repo-relative posix path the Ledger keys its sets on (V6).
// ---------------------------------------------------------------------------------------------

function rootsOf(cfg) {
  const roots = [cfg.checkout];
  try {
    const real = realpathSync(cfg.checkout);
    if (real !== cfg.checkout) roots.push(real);
  } catch {
    // The checkout vanished; the plain path still gives a sensible answer for paths under it.
  }
  return roots;
}

// The path as given and, when the file exists, as the filesystem spells it: either side of the
// comparison may reach the checkout through a symlink.
function spellings(raw, cfg) {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(cfg.cwd, raw);
  try {
    const real = realpathSync(abs);
    return real === abs ? [abs] : [abs, real];
  } catch {
    return [abs];
  }
}

// null for anything that is not a file of this checkout.
export function repoPath(raw, cfg) {
  if (typeof raw !== "string" || raw === "") return null;
  for (const abs of spellings(raw, cfg)) {
    for (const root of rootsOf(cfg)) {
      const rel = relative(root, abs);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      const posix = rel.split(sep).join("/");
      if (NOT_REPO.some((dir) => posix === dir || posix.startsWith(`${dir}/`))) return null;
      return posix;
    }
  }
  return null;
}

// Ripgrep's content mode prints `path:line:text`; with a single file it prints `line:text` and the
// path is only in tool_input.path. Lines that are not an existing file are code, not paths.
function grepContentFiles(content, cfg) {
  const out = [];
  for (const line of String(content).split("\n")) {
    const m = /^(.+?):\d+:/.exec(line);
    if (!m) continue;
    const abs = isAbsolute(m[1]) ? m[1] : resolve(cfg.cwd, m[1]);
    if (existsSync(abs) && statSync(abs).isFile()) out.push(m[1]);
  }
  return out;
}

// V7: a Grep or Glob counts as reads of the files it matched, never of its pattern.
export function touchedPaths(input, cfg) {
  const { tool_name: tool, tool_input: given = {}, tool_response: res } = input;
  const raw = [];
  if (tool === "Read") raw.push(given.file_path ?? res?.file?.filePath);
  else if (tool === "Glob") raw.push(...(res?.filenames ?? []));
  else if (tool === "Grep") {
    raw.push(...(res?.filenames ?? []));
    if (res?.mode === "content" || (res?.filenames ?? []).length === 0) raw.push(...grepContentFiles(res?.content ?? "", cfg));
    // Content mode on one file prints no file names; the file is the one the agent pointed at, but only if it matched.
    const matched = (res?.numFiles ?? 0) > 0 || String(res?.content ?? "").trim() !== "";
    if (matched && typeof given.path === "string") {
      const abs = isAbsolute(given.path) ? given.path : resolve(cfg.cwd, given.path);
      if (existsSync(abs) && statSync(abs).isFile()) raw.push(given.path);
    }
  }
  return [...new Set(raw.map((p) => repoPath(p, cfg)).filter(Boolean))];
}

// ---------------------------------------------------------------------------------------------
// .ryke/ state shared by the hooks of one attempt: reads.jsonl, writes.jsonl, announced.jsonl.
// ---------------------------------------------------------------------------------------------

export const rykeDir = (cfg) => join(cfg.checkout, ".ryke");

export function appendLine(cfg, name, value) {
  mkdirSync(rykeDir(cfg), { recursive: true });
  appendFileSync(join(rykeDir(cfg), name), `${JSON.stringify(value)}\n`);
}

export function readLines(dir, name) {
  try {
    return readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Early stale warnings (PLAN.md §4.4) as text for the agent.
// ---------------------------------------------------------------------------------------------

function git(cfg, argv, options = {}) {
  return spawnSync("git", argv, { cwd: cfg.checkout, encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024, ...options });
}

// A Read in the checkout shows the snapshot, not trunk, so the warning has to carry the change
// itself or "re-read it and adapt" would send the agent back to the file it already knows.
function unified(path, before, after) {
  const dir = mkdtempSync(join(tmpdir(), "ryke-diff-"));
  try {
    writeFileSync(join(dir, "a"), before);
    writeFileSync(join(dir, "b"), after);
    const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--unified=3", "--", "a", "b"], { cwd: dir, encoding: "utf8", timeout: 10_000 });
    const at = r.stdout.indexOf("\n@@");
    return at < 0 ? null : `--- a/${path}\n+++ b/${path}${r.stdout.slice(at)}`.trimEnd();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function trunkDiff(cfg, path) {
  try {
    const old = git(cfg, ["show", `${cfg.snapshot}:${path}`]);
    const before = old.status === 0 ? old.stdout : "";
    let after = "";
    try {
      after = (await apiCall(cfg, "GET", `/api/repos/${encodeURIComponent(cfg.repo)}/files?path=${encodeURIComponent(path)}`)).content ?? "";
    } catch (e) {
      if (e.status !== 404) throw e; // 404: trunk deleted the file
    }
    if (before === after) return null;
    return unified(path, before, after);
  } catch (e) {
    log(`no diff for ${path}: ${e.message}`);
    return null;
  }
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}\n... (cut)` : text);

export const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

// Each (path, seq) is announced once per attempt: a warning that repeats on every Read teaches the
// agent to ignore it. The next change to the same path has a new seq and is announced again.
// `waited` ({ path, owner, ms }) is set when the agent has just sat out a write lease: what changed on
// trunk meanwhile is then the news, and it is told that its edits will be rebased.
export async function staleContext(cfg, warnings, { waited = null } = {}) {
  const seen = new Set(readLines(rykeDir(cfg), "announced.jsonl").map((a) => `${a.path}@${a.seq}`));
  const fresh = warnings.filter((w) => !seen.has(`${w.path}@${w.seq}`));
  if (fresh.length === 0) return null;
  for (const w of fresh) appendLine(cfg, "announced.jsonl", { path: w.path, seq: w.seq });
  const list = fresh.map((w) => `- ${w.path}${w.by ? `, changed by ${w.by}` : ""} at trunk seq ${w.seq}`).join("\n");
  const diffs = [];
  let budget = DIFF_TOTAL_MAX;
  for (const w of fresh.slice(0, DIFFS_MAX)) {
    const d = await trunkDiff(cfg, w.path);
    if (!d || budget <= 0) continue;
    const text = cut(d, Math.min(DIFF_FILE_MAX, budget));
    budget -= text.length;
    diffs.push(text);
  }
  const files = fresh.length === 1 ? "a file" : `${fresh.length} files`;
  const lead = waited
    ? `Ryke: you waited ${seconds(waited.ms)} for the write lease on ${waited.path}${waited.owner ? `, held by ${waited.owner}` : ""}. While you waited, ${files} you read changed on trunk after your snapshot ${cfg.snapshot.slice(0, 8)}:\n${list}`
    : `Ryke: ${files} you read changed on trunk after your snapshot ${cfg.snapshot.slice(0, 8)}:\n${list}`;
  const body = diffs.length
    ? `\nYour checkout is still at the snapshot, so Read, Grep and Glob show the old version. The change on trunk:\n\n${diffs.join("\n\n")}`
    : "\nYour checkout is still at the snapshot, so Read, Grep and Glob show the old version.";
  const tail = waited
    ? "\nYour edits will be rebased onto the new trunk: the transaction is retried against it if these reads are still out of date when you submit, so adapt your change to the new version now where you can."
    : "\nSubmitting while these reads are out of date aborts the transaction as stale, so adapt your change to the new version before you finish.";
  return cut(`${lead}${body}\n${tail}`, CONTEXT_MAX);
}

// POST /reads answers with the warnings for the whole read set, so it doubles as a poll for "did trunk
// move under what I read". With no paths it asks about what the Ledger already holds; with `resend` it
// first states again everything the hooks logged, so a read lost to an API blip is part of the answer.
export async function pollStale(cfg, { resend = false, waited = null } = {}) {
  const paths = resend ? [...new Set(readLines(rykeDir(cfg), "reads.jsonl").flatMap((l) => l.paths ?? []))] : [];
  const warnings = new Map();
  for (let i = 0; i === 0 || i < paths.length; i += READS_BATCH) {
    const r = await apiCall(cfg, "POST", `/api/txns/${cfg.txn}/reads`, { paths: paths.slice(i, i + READS_BATCH) });
    for (const w of r?.staleWarnings ?? []) warnings.set(`${w.path}@${w.seq}`, w);
  }
  return staleContext(cfg, [...warnings.values()], { waited });
}

// ---------------------------------------------------------------------------------------------
// Replies in the documented shapes (https://code.claude.com/docs/en/hooks, "JSON output").
// ---------------------------------------------------------------------------------------------

export const postToolUseReply = (additionalContext) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } });

// "allow" skips no safety net: agent mode runs with --dangerously-skip-permissions, and deny and
// ask rules are still evaluated. The reason lands in Claude Code's debug log, which is where a
// swarm operator looks to see why an edit waited.
export const preToolUseReply = (permissionDecisionReason, additionalContext) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason,
      ...(additionalContext ? { additionalContext } : {}),
    },
  });

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

// stdin payload in, optional reply on stdout, always exit 0 (fail open).
export async function runHook(handle, { stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  try {
    const raw = await readAll(stdin);
    const input = raw.trim() ? JSON.parse(raw) : {};
    const reply = await handle(input, loadConfig(env, input));
    if (reply) stdout.write(reply);
  } catch (e) {
    log(`failed open: ${e.message}`);
  }
}

export const isMain = (metaUrl) => process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href;
