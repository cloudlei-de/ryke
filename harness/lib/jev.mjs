// Node-side Jev helpers shared by `npm run jev:record` and `npm run jev:calibrate` (PLAN.md §9).
// The fixture key and the question builders must be the Worker's own: a fixture recorded here is
// only found by judge.ts when both sides hash the identical `stable({state, questions})`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { scanTestDiff } from "../../containers/runner/lib/land.mjs";
import { jaccard, topSimilar, trigrams } from "../../src/worker/ledger/similar.ts";
import * as defaultQuestions from "../../src/shared/judge-questions.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Same canonical JSON as stable() in src/worker/judge.ts: sorted keys, `undefined` members dropped.
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

export function fixtureKey(state, questions) {
  return createHash("sha256").update(stable({ state, questions })).digest("hex");
}

// Fixtures keep what the Worker reads (judge-questions.ts `Answer`), not the full legend and
// probability tables, so a re-record produces small, reviewable diffs.
export function trimAnswers(answers) {
  const out = {};
  for (const [name, a] of Object.entries(answers)) {
    if (a?.type === "noul") out[name] = { type: "noul", noul: a.noul };
    else if (a?.type === "score") out[name] = { type: "score", score: a.score, confidence: a.confidence };
    else throw new Error(`unsupported answer type for ${name}: ${a?.type}`);
  }
  return out;
}

// The question builders under test. `--questions <file>` swaps in another module (a copy of the
// original wording, say) so a before/after comparison needs no edit of the real file.
export async function loadQuestions(path) {
  if (!path) return defaultQuestions;
  return import(pathToFileURL(resolve(path)).href);
}

export function liveClient({ apiKey = process.env.TYPESAFE_API_KEY, model = defaultQuestions.MODEL, timeout = 30_000 } = {}) {
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set; the live Jev API is needed for this command");
  const client = new TypeSafeClient({ apiKey, defaultModel: model, timeout });
  const live = {
    requests: 0,
    async ask(state, questions) {
      live.requests++;
      const res = await client.systemOne({ model, state, questions });
      return trimAnswers(res.answers);
    },
  };
  return live;
}

// Bounded concurrency keeps a calibration run far below the 80 req/s rate limit.
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- case → request ---------------------------------------------------------------------------

// Cases carry the new intent as `a` and the in-flight one as `b`, the way begin sees them. A
// duplicate case may name further in-flight intents (`others`): begin asks about all candidates in
// one request, and Jev answered differently when similar ones sat side by side. The label is about
// the first candidate, which is why it stays first whatever the prefilter's ranking would be.
export function duplicateRequest(q, c) {
  return q.screenQuestions(c.newIntent, [{ intent: c.existingIntent }, ...(c.others ?? []).map((intent) => ({ intent }))]);
}

export function conflictRequest(q, c) {
  return q.screenQuestions(c.a, [{ intent: c.b }]);
}

export function gateInputOf(c) {
  return {
    intent: c.intent,
    criteria: c.criteria,
    writes: [],
    verify: { exitCode: 0, pass: true, tests: { passed: c.tests.passed, failed: 0, failures: [] } },
    tamper: false,
    newTests: c.newTests,
    diffstat: c.diffstat,
    screenshot: c.screenshot,
  };
}

export function evidenceRequest(q, c) {
  return q.evidenceQuestions(gateInputOf(c));
}

export function requestOf(q, c) {
  if (c.kind === "duplicate") return duplicateRequest(q, c);
  if (c.kind === "conflict") return conflictRequest(q, c);
  if (c.kind === "evidence") return evidenceRequest(q, c);
  throw new Error(`unknown case kind: ${c.kind}`);
}

// The §7.3 path: begin only asks Jev about candidates the trigram prefilter keeps.
export function prefilter(c) {
  const [intent, other] = c.kind === "duplicate" ? [c.newIntent, c.existingIntent] : [c.a, c.b];
  return {
    passes: topSimilar(intent, [{ id: "other", intent: other }]).length > 0,
    similarity: jaccard(trigrams(intent), trigrams(other)),
  };
}

// ---- requests the vitest suite replays ---------------------------------------------------------

// Rebuild state and questions of every recorded request from its `input` with the current builders,
// so a wording change only needs `npm run jev:record` and never a hand edit of requests.json.
export function rebuildRequests(q, entries) {
  return entries.map((e) => {
    if (e.kind === "screen") {
      const candidates = topSimilar(e.input.intent, e.input.live);
      const { state, questions } = q.screenQuestions(e.input.intent, candidates);
      return { ...e, state, questions };
    }
    if (e.kind === "evidence") {
      const { state, questions } = q.evidenceQuestions(e.input.gate);
      return { ...e, state, questions };
    }
    return e;
  });
}

// ---- the demo catalogue as evidence ------------------------------------------------------------

// What the gate would see for a task's reference patch: the diff stat and the test names the land
// job extracts (the same scanTestDiff), with the catalogue's screenshot line as the agent-provided
// one, as in scripted mode (PLAN.md §9.3). Every such task is meant to land, so each criterion is
// "met" by construction.
export function catalogueGate(task, patch, diffstat) {
  // land.mjs scans only the test/ part of the diff, so cut the patch the same way.
  const testPart = patch
    .split(/^(?=diff --git )/m)
    .filter((chunk) => /^diff --git a\/\S+ b\/test\//.test(chunk))
    .join("");
  const { newTests } = scanTestDiff(testPart);
  return {
    intent: task.intent,
    criteria: task.criteria,
    writes: [],
    // The seed has 65 tests; the new ones add roughly their own count, which is all Jev reads.
    verify: { exitCode: 0, pass: true, tests: { passed: 65 + newTests.length, failed: 0, failures: [] } },
    tamper: false,
    newTests,
    diffstat,
    screenshot: task.screenshot_description,
  };
}

// `git apply --stat` pads the counts wider than `git diff --stat` does, and the land job records the
// latter. Re-pad so the calibration sees the shape the Worker sees.
export function normaliseDiffstat(text) {
  const lines = text.trim().split("\n");
  const summary = lines.pop().trim();
  const rows = lines.map((l) => l.match(/^\s*(\S+)\s*\|\s*(\d+) (.*)$/));
  if (rows.some((m) => m === null)) throw new Error(`not a diff stat: ${text}`);
  const name = Math.max(...rows.map((m) => m[1].length));
  const count = Math.max(...rows.map((m) => m[2].length));
  return [...rows.map((m) => ` ${m[1].padEnd(name)} | ${m[2].padStart(count)} ${m[3]}`), ` ${summary}`].join("\n");
}

// Tasks that are expected to reach the gate: not the protected-file tamper, which V1 rejects first.
export function catalogueTasks(root = REPO_ROOT) {
  const dir = resolve(root, "demo/convert");
  const tasks = JSON.parse(readFileSync(resolve(dir, "tasks.json"), "utf8"));
  return tasks
    .filter((t) => t.expect !== "reject_protected")
    .map((t) => {
      const file = resolve(dir, t.solution);
      // `git apply --stat` outside a work tree counts the patch itself, whatever the cwd holds.
      const diffstat = normaliseDiffstat(execFileSync("git", ["apply", "--stat", file], { cwd: tmpdir(), encoding: "utf8" }));
      return { task: t, gate: catalogueGate(t, readFileSync(file, "utf8"), diffstat) };
    });
}
