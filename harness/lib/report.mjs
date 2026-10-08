// The end-of-run report (PLAN.md §11.1, §13 M3): everything is derived from the repo's op log and
// summary, so the same numbers can be recomputed from a recorded log. Only `verifyTrunk` and
// `checkPreview` look at anything else, and they say so in their results.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Workspace } from "./gitops.mjs";
import { categoryName } from "./tasks.mjs";

const run = promisify(execFile);
const TERMINAL = new Set(["landed", "recalled", "aborted", "rejected"]);
// Reasons Ryke gives when a transaction failed because the merged tree did not pass.
const VERIFY_FAILURES = new Set(["tests", "verify_failed", "tests_failed", "test_tamper"]);

// ---------------------------------------------------------------------------------------------
// Op log -> per-transaction view. Also what `ryke txns` prints.
// ---------------------------------------------------------------------------------------------

export function foldTxns(ops) {
  const txns = new Map();
  for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
    if (!op.txn) continue;
    let t = txns.get(op.txn);
    if (!t) {
      t = { id: op.txn, agent: op.agent, model: null, intent: "", state: "open", reason: null, attempt: 1, openedAt: op.at, endedAt: null, landedAt: null, seq: null, train: null, stale: [], dupWarnings: 0, conflictWarnings: 0, lastSeq: op.seq };
      txns.set(op.txn, t);
    }
    t.lastSeq = op.seq;
    if (op.kind === "dup.warning") t.dupWarnings++;
    else if (op.kind === "conflict.warning") t.conflictWarnings++;
    if (!op.kind.startsWith("txn.")) continue;
    const state = op.kind.slice(4);
    t.state = state;
    t.reason = op.data.reason ?? null;
    t.attempt = op.data.attempt ?? t.attempt;
    t.endedAt = TERMINAL.has(state) ? op.at : null;
    if (op.kind === "txn.open") {
      t.intent = op.data.intent ?? t.intent;
      t.model = op.data.model ?? t.model;
    }
    if (state === "landed") {
      t.landedAt = op.at;
      t.seq = op.data.seq ?? null;
      t.train = op.data.train ?? null;
    }
    // A third stale attempt is recorded as an abort whose `cause` says what it really was.
    const cause = state === "stale" ? { state, reason: op.data.reason } : state === "aborted" ? op.data.cause : null;
    if (cause?.state === "stale") t.stale.push({ seq: op.seq, at: op.at, attempt: op.data.attempt ?? null, reason: cause.reason ?? "stale_read", paths: op.data.paths ?? [] });
  }
  return txns;
}

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------

const bump = (map, key, n = 1) => {
  map[key] = (map[key] ?? 0) + n;
};

function abortsByCause(ops) {
  const out = { stale_read: 0, text_conflict: 0, failed_verify: 0, duplicate: 0, protected: 0, max_attempts: 0, agent: {}, other: {} };
  for (const op of ops) {
    const reason = op.data?.reason ?? null;
    if (op.kind === "txn.stale") bump(out, reason === "text_conflict" ? "text_conflict" : "stale_read");
    else if (op.kind === "txn.failed") {
      if (VERIFY_FAILURES.has(reason)) out.failed_verify++;
      else bump(out.other, reason ?? "failed");
    } else if (op.kind === "txn.rejected") {
      if (typeof reason === "string" && reason.startsWith("duplicate_of")) out.duplicate++;
      else if (reason === "protected") out.protected++;
      else bump(out.other, reason ?? "rejected");
    } else if (op.kind === "txn.aborted") {
      if (reason === "max_attempts") {
        out.max_attempts++;
        // The attempt that ran out of tries still ended for a reason of its own.
        const cause = op.data.cause;
        if (cause?.state === "stale") bump(out, cause.reason === "text_conflict" ? "text_conflict" : "stale_read");
        else if (cause?.state === "failed") {
          if (VERIFY_FAILURES.has(cause.reason)) out.failed_verify++;
          else bump(out.other, cause.reason ?? "failed");
        }
      } else bump(out.agent, reason ?? "agent_abort");
    }
  }
  return out;
}

// Speculative trains (PLAN.md §5.6) are ordinary trains in `formed` and `sizes`; `speculative` counts the ones
// built on another train's candidate, and how those ended: confirmed (their turn came) or discarded.
function trainStats(ops) {
  const sizes = {};
  let formed = 0;
  const bisected = new Set();
  const speculative = { formed: 0, confirmed: 0, discarded: 0 };
  for (const op of ops) {
    if (op.kind === "train.formed") {
      formed++;
      bump(sizes, String(op.data.txns?.length ?? 0));
      if (op.data.after) speculative.formed++;
    } else if (op.kind === "train.bisect") bisected.add(op.data.train);
    else if (op.kind === "train.confirmed") speculative.confirmed++;
    else if (op.kind === "train.done" && op.data.outcome === "discarded") speculative.discarded++;
  }
  const max = Math.max(0, ...Object.keys(sizes).map(Number));
  return { formed, sizes, max, bisected: bisected.size, speculative };
}

// t-precision rewrites the hottest file, so the stale aborts it causes are the demo's headline number.
function precisionStats(txns, precisionTxn) {
  if (!precisionTxn) return null;
  const caused = [];
  for (const t of txns) {
    for (const s of t.stale) {
      if (s.paths.some((p) => p.by === precisionTxn)) caused.push({ txn: t.id, task: t.task, at: s.at, landedAfter: t.state === "landed" && t.landedAt >= s.at });
    }
  }
  return { txn: precisionTxn, staleAborts: caused.length, landedAfterRetry: caused.filter((c) => c.landedAfter).length, caused };
}

export function buildReport({ ops, summary = null, tasks = [], repo = summary?.repo ?? null }) {
  const sorted = [...ops].sort((a, b) => a.seq - b.seq);
  const byIntent = new Map(tasks.map((t) => [t.intent, t]));
  const folded = [...foldTxns(sorted).values()];
  for (const t of folded) t.task = byIntent.get(t.intent)?.id ?? null;

  const final = {};
  for (const t of folded) bump(final, t.state);

  const landed = folded.filter((t) => t.state === "landed").sort((a, b) => a.seq - b.seq);
  const landedTasks = landed.map((t) => t.task ?? t.id);

  // One row per catalogue task: the best transaction it got (landed beats everything, otherwise the last one).
  const outcomes = tasks.map((task) => {
    const mine = folded.filter((t) => t.task === task.id);
    const t = mine.find((x) => x.state === "landed") ?? mine.at(-1) ?? null;
    return {
      task: task.id,
      group: task.group,
      expect: task.expect ?? null,
      txn: t?.id ?? null,
      state: t?.state ?? "not_run",
      reason: t?.reason ?? null,
      attempts: t?.attempt ?? 0,
      dupWarned: (t?.dupWarnings ?? 0) > 0,
      conflictWarned: (t?.conflictWarnings ?? 0) > 0,
    };
  });

  const opened = folded.map((t) => t.openedAt);
  const ended = folded.filter((t) => t.endedAt !== null).map((t) => t.endedAt);
  const startedAt = opened.length ? Math.min(...opened) : null;
  const endedAt = ended.length ? Math.max(...ended) : startedAt;
  const durationMs = startedAt === null ? 0 : endedAt - startedAt;
  const perMinute = [];
  for (const t of landed) {
    const minute = Math.floor((t.landedAt - startedAt) / 60_000);
    perMinute[minute] = (perMinute[minute] ?? 0) + 1;
  }
  for (let i = 0; i < perMinute.length; i++) perMinute[i] ??= 0;

  const precisionTxn = folded.find((t) => t.task === "t-precision")?.id ?? null;
  return {
    repo,
    head: summary?.head ?? null,
    seq: summary?.seq ?? null,
    txns: folded.length,
    final,
    landedTasks,
    outcomes,
    durationMs,
    // Floor of one second so a run that finished instantly does not report an infinite rate.
    landedPerMinute: landed.length / (Math.max(durationMs, 1000) / 60_000),
    landedPerMinuteBuckets: perMinute,
    aborts: abortsByCause(sorted),
    trains: trainStats(sorted),
    precision: precisionStats(folded, precisionTxn),
    trunk: null,
    preview: null,
  };
}

// ---------------------------------------------------------------------------------------------
// The M3 criteria (PLAN.md §13). `pass: null` means the run did not contain what the criterion is about.
// ---------------------------------------------------------------------------------------------

export function evaluateCriteria(report) {
  const group = (g) => report.outcomes.filter((o) => o.group === g);
  const g3 = group("G3");
  const g5 = group("G5");
  const precision = report.precision;
  const landed = report.landedTasks.length;
  const list = (rows) => rows.map((o) => `${o.task} ${o.state}${o.reason ? ` (${o.reason})` : ""}${o.dupWarned ? " warned" : ""}`).join("; ");
  const caught = (o) => (o.state === "rejected" && String(o.reason).startsWith("duplicate_of")) || o.dupWarned;
  const preview = report.preview;
  return [
    { id: "landed", text: ">= 34 tasks landed", pass: landed >= 34, detail: `${landed} landed` },
    {
      id: "g3",
      text: "G3 duplicates rejected or warned",
      pass: g3.length === 0 ? null : g3.every(caught),
      detail: g3.length === 0 ? "no G3 task in this run" : list(g3),
    },
    {
      id: "g5",
      text: "G5 tamper rejected as protected",
      pass: g5.length === 0 ? null : g5.every((o) => o.state === "rejected" && o.reason === "protected"),
      detail: g5.length === 0 ? "no G5 task in this run" : list(g5),
    },
    {
      id: "precision",
      text: ">= 5 stale aborts caused by t-precision, each followed by a landed retry",
      pass: precision ? precision.landedAfterRetry >= 5 : null,
      detail: precision ? `${precision.staleAborts} stale aborts by ${precision.txn}, ${precision.landedAfterRetry} landed after the retry` : "no t-precision transaction in this run",
    },
    {
      id: "trunk",
      text: "final trunk tests green",
      pass: report.trunk ? report.trunk.pass : null,
      detail: report.trunk ? (report.trunk.pass ? `${report.trunk.tests ?? "?"} tests pass at ${report.trunk.head?.slice(0, 8)}` : `fails at ${report.trunk.head?.slice(0, 8)}: ${report.trunk.failing?.join("; ") || report.trunk.error || "see output"}`) : "not checked",
    },
    {
      id: "preview",
      text: "preview renders all landed categories",
      pass: !preview ? null : preview.status === "ok" ? true : preview.status === "unavailable" ? null : false,
      detail: !preview ? "not checked" : preview.detail,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Checks that look outside the op log
// ---------------------------------------------------------------------------------------------

// Clones trunk through the store (the swarm runs next to it) and runs the repo's own verify command.
// The store's control API wants the internal secret; the default is the dev stack's.
export async function verifyTrunk({ storeUrl, repo, head, verify, timeoutSeconds = 120, fetchImpl = fetch, secret = process.env.RYKE_INTERNAL_SECRET || "dev" }) {
  const ws = await Workspace.create("checker");
  const internal = { "x-ryke-internal": secret };
  try {
    const info = await (await fetchImpl(`${storeUrl}/v1/repos/${repo}`, { headers: internal })).json();
    const grant = await (await fetchImpl(`${storeUrl}/v1/repos/${repo}/tokens`, { method: "POST", headers: internal, body: JSON.stringify({ scope: "read", ttl: 600 }) })).json();
    const sha = await ws.fetch(info.remote, grant.token, "main");
    if (head && sha !== head) return { pass: false, head: sha, error: `store head ${sha} differs from the ledger head ${head}` };
    await ws.checkout(sha);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    try {
      const { stdout } = await run("sh", ["-c", verify], { cwd: ws.dir, env, timeout: timeoutSeconds * 1000, maxBuffer: 32 * 1024 * 1024 });
      const n = /^(?:#|ℹ) pass (\d+)/m.exec(stdout);
      return { pass: true, head: sha, tests: n ? Number(n[1]) : null };
    } catch (e) {
      const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
      const failing = [...new Set([...out.matchAll(/^\s*not ok \d+ - (.*?)(?: # .*)?$/gm), ...out.matchAll(/^\s*✖ (.*?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)].map((m) => m[1]))];
      return { pass: false, head: sha, failing: failing.slice(0, 5), error: failing.length ? null : out.trim().split("\n").slice(-3).join(" | ") };
    }
  } catch (e) {
    return { pass: false, head, error: e.message };
  } finally {
    await ws.remove();
  }
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// GET /preview/<repo>/<head>/ must answer 200 and show every landed category. A 404 means this
// deployment has no preview route (yet), which is reported, not failed.
export async function checkPreview({ apiUrl, repo, head, categories, fetchImpl = fetch, timeoutMs = 120_000 }) {
  const url = `${apiUrl}/preview/${repo}/${head}/`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return { status: "unavailable", url, detail: "preview: unavailable (404)" };
    const html = await res.text();
    if (res.status !== 200) return { status: "error", url, httpStatus: res.status, detail: `preview answered ${res.status}: ${html.slice(0, 200).replace(/\s+/g, " ")}` };
    const missing = categories.filter((name) => !html.includes(name) && !html.includes(escapeHtml(name)));
    if (missing.length > 0) return { status: "incomplete", url, httpStatus: 200, missing, detail: `preview is missing ${missing.length} of ${categories.length} categories: ${missing.join(", ")}` };
    return { status: "ok", url, httpStatus: 200, categories: categories.length, detail: `200, all ${categories.length} landed categories present` };
  } catch (e) {
    return { status: "error", url, detail: `preview request failed: ${e.message}` };
  }
}

export function landedCategories(report, tasks) {
  const landed = new Set(report.landedTasks);
  return tasks.filter((t) => landed.has(t.id)).map(categoryName).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

const duration = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

export function formatReport(report) {
  const lines = [];
  const line = (s = "") => lines.push(s);
  const a = report.aborts;
  line(`Swarm report: ${report.repo ?? "repo"}  head ${report.head?.slice(0, 8) ?? "?"}  seq ${report.seq ?? "?"}  ${duration(report.durationMs)}`);
  line();
  line(`transactions   ${report.txns}   ${Object.entries(report.final).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  line(`landed         ${report.landedTasks.length} tasks: ${report.landedTasks.join(", ") || "none"}`);
  const missing = report.outcomes.filter((o) => o.state !== "landed");
  if (missing.length > 0) line(`not landed     ${missing.map((o) => `${o.task} ${o.state}${o.reason ? ` (${o.reason})` : ""}`).join("; ")}`);
  line(`landed/minute  ${report.landedPerMinute.toFixed(1)} over ${duration(report.durationMs)}   per minute: ${report.landedPerMinuteBuckets.join(", ") || "none"}`);
  const agent = Object.entries(a.agent).map(([k, v]) => `${k} ${v}`).join(", ");
  const other = Object.entries(a.other).map(([k, v]) => `${k} ${v}`).join(", ");
  line(
    `aborts         stale_read ${a.stale_read}, text_conflict ${a.text_conflict}, failed_verify ${a.failed_verify}, duplicate ${a.duplicate}, protected ${a.protected}, max_attempts ${a.max_attempts}` +
      `${agent ? `; agent aborts: ${agent}` : ""}${other ? `; other: ${other}` : ""}`,
  );
  const sizes = Object.entries(report.trains.sizes).sort((x, y) => Number(x[0]) - Number(y[0])).map(([k, v]) => `${v}x${k}`).join(" ");
  // Only when pipelining formed something, so a run without it prints the line it always did.
  const spec = report.trains.speculative;
  const pipelined = spec.formed > 0 ? `; ${spec.formed} speculative: ${spec.confirmed} confirmed, ${spec.discarded} discarded` : "";
  line(`trains         ${report.trains.formed} formed (count x size: ${sizes || "none"}), largest ${report.trains.max}, ${report.trains.bisected} bisected${pipelined}`);
  if (report.precision) line(`t-precision    ${report.precision.txn}: ${report.precision.staleAborts} stale aborts caused, ${report.precision.landedAfterRetry} landed after the retry`);
  for (const g of ["G3", "G4", "G5", "G6"]) {
    const rows = report.outcomes.filter((o) => o.group === g);
    if (rows.length === 0) continue;
    line(`${g}             ${rows.map((o) => `${o.task} ${o.state}${o.reason ? ` (${o.reason})` : ""}${o.dupWarned ? ", dup-warned" : ""}${o.conflictWarned ? ", conflict-warned" : ""}`).join("; ")}`);
  }
  if (report.trunk) line(`final trunk    ${report.trunk.head?.slice(0, 8)} tests ${report.trunk.pass ? `pass (${report.trunk.tests ?? "?"})` : `FAIL ${report.trunk.failing?.join("; ") || report.trunk.error || ""}`}`);
  if (report.preview) line(`preview        ${report.preview.detail}`);
  line();
  line("M3 criteria");
  for (const c of evaluateCriteria(report)) line(`  [${c.pass === null ? "n/a " : c.pass ? "PASS" : "FAIL"}] ${c.text}: ${c.detail}`);
  return lines.join("\n");
}
