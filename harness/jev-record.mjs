// `npm run jev:record` (PLAN.md §9): record the live Jev answers the vitest suite replays.
//
//   test/fixtures/jev/requests.json   what to record: {name, kind, input, state, questions}
//   test/fixtures/jev/<key>.json      the recording: {state, questions, answers}, key = sha256 of
//                                     stable({state, questions}), the same hash judge.ts looks up
//
// Each request is rebuilt from its `input` first, so after a wording change in
// src/shared/judge-questions.ts this one command refreshes requests and fixtures together.
//
//   node harness/jev-record.mjs [--only-missing] [--prune] [--questions <module>]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureKey, liveClient, loadQuestions, mapPool, rebuildRequests, REPO_ROOT } from "./lib/jev.mjs";

const DIR = resolve(REPO_ROOT, "test/fixtures/jev");

// Pure: which fixtures to record, which to keep, and which files no request names any more.
export function plan(requests, existing, { onlyMissing = false } = {}) {
  const wanted = new Map(requests.map((r) => [fixtureKey(r.state, r.questions), r]));
  const have = new Set(existing);
  const toRecord = [];
  const kept = [];
  for (const [key, request] of wanted) (onlyMissing && have.has(key) ? kept : toRecord).push({ key, request });
  const orphans = [...have].filter((key) => !wanted.has(key));
  return { toRecord, kept, orphans };
}

export const fixtureText = (state, questions, answers) => `${JSON.stringify({ state, questions, answers }, null, 2)}\n`;

function existingKeys(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
    .map((f) => f.slice(0, -".json".length));
}

// `live` is anything with `ask(state, questions)`, so tests can record against a fake.
export async function record({ dir = DIR, q, live, onlyMissing = false, prune = false }) {
  const requests = rebuildRequests(q, JSON.parse(readFileSync(join(dir, "requests.json"), "utf8")));
  const { toRecord, kept, orphans } = plan(requests, existingKeys(dir), { onlyMissing });
  // Ask everything before writing anything, so a failed request leaves the fixtures as they were.
  const answers = await mapPool(toRecord, 4, ({ request }) => live.ask(request.state, request.questions));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requests.json"), `${JSON.stringify(requests, null, 2)}\n`);
  toRecord.forEach(({ key, request }, i) => writeFileSync(join(dir, `${key}.json`), fixtureText(request.state, request.questions, answers[i])));
  if (prune) for (const key of orphans) rmSync(join(dir, `${key}.json`));
  return { recorded: toRecord.length, kept: kept.length, orphans, pruned: prune };
}

async function main() {
  const flag = process.argv.indexOf("--questions");
  const q = await loadQuestions(flag >= 0 ? process.argv[flag + 1] : undefined);
  const live = liveClient({ model: q.MODEL });
  const r = await record({ q, live, onlyMissing: process.argv.includes("--only-missing"), prune: process.argv.includes("--prune") });
  console.log(`recorded ${r.recorded} fixtures (${live.requests} live requests), kept ${r.kept}`);
  if (r.orphans.length > 0) console.log(`${r.pruned ? "pruned" : "stale, rerun with --prune to delete"}: ${r.orphans.map((k) => k.slice(0, 12)).join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
