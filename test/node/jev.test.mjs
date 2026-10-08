// The Node side of Jev (PLAN.md §9): the labelled case file, the fixture key shared with the Worker, the
// calibration scorer and report, and the recorder. Nothing here touches the network: the live API is
// replaced by a fake fetch where a client is needed at all.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { noul } from "@typesafe-ai/sdk";
import * as q from "../../src/shared/judge-questions.ts";
import {
  CONFLICT_WARN,
  DUP_CUT,
  END,
  MET,
  START,
  UNMET,
  calibrate,
  catalogueRow,
  histogram,
  renderReport,
  scoreCase,
  spliceDoc,
  summarize,
  summarizeCatalogue,
  verdictOf,
} from "../../harness/jev-calibrate.mjs";
import {
  REPO_ROOT,
  catalogueGate,
  catalogueTasks,
  conflictRequest,
  duplicateRequest,
  evidenceRequest,
  fixtureKey,
  gateInputOf,
  liveClient,
  loadQuestions,
  mapPool,
  normaliseDiffstat,
  prefilter,
  rebuildRequests,
  requestOf,
  stable,
  trimAnswers,
} from "../../harness/lib/jev.mjs";
import { fixtureText, plan, record } from "../../harness/jev-record.mjs";

const read = (path) => JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf8"));
const cases = read("harness/jev-cases.json");
const tasks = new Map(read("demo/convert/tasks.json").map((t) => [t.id, t]));
const ROOT = mkdtempSync(join(tmpdir(), "ryke-jev-test-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

// 39 reference patches turned into evidence; built once, it shells out to git for each diff stat.
const catalogue = catalogueTasks();

const yes = (v) => ({ type: "noul", noul: v });
const level = (s, confidence) => ({ type: "score", score: s, confidence });

// ---- the case file -----------------------------------------------------------------------------

describe("harness/jev-cases.json", () => {
  const of = (kind) => cases.filter((c) => c.kind === kind);

  test("holds at least 24 cases and at least 8 of each kind", () => {
    assert.ok(Array.isArray(cases));
    assert.ok(cases.length >= 24, `only ${cases.length} cases`);
    for (const kind of ["duplicate", "conflict", "evidence"]) assert.ok(of(kind).length >= 8, `only ${of(kind).length} ${kind} cases`);
  });

  test("has unique non-empty ids and only known kinds", () => {
    const ids = cases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of cases) {
      assert.ok(typeof c.id === "string" && c.id.length > 0);
      assert.ok(["duplicate", "conflict", "evidence"].includes(c.kind), `${c.id}: kind ${c.kind}`);
    }
  });

  test("marks the holdout cases with a boolean and keeps some of every kind unseen by tuning", () => {
    for (const c of cases) assert.ok(c.holdout === undefined || c.holdout === true, `${c.id}: holdout`);
    for (const kind of ["duplicate", "conflict", "evidence"]) {
      assert.ok(of(kind).some((c) => c.holdout), `no holdout ${kind} case`);
      assert.ok(of(kind).some((c) => !c.holdout), `no tuning ${kind} case`);
    }
  });

  test("has valid duplicate cases with both labels well represented", () => {
    for (const c of of("duplicate")) {
      assert.ok(typeof c.newIntent === "string" && c.newIntent.length > 0, c.id);
      assert.ok(typeof c.existingIntent === "string" && c.existingIntent.length > 0, c.id);
      assert.notEqual(c.newIntent, c.existingIntent, c.id);
      assert.equal(typeof c.label, "boolean", c.id);
      assert.ok(c.others === undefined || (Array.isArray(c.others) && c.others.length > 0 && c.others.every((o) => typeof o === "string" && o.length > 0)), `${c.id}: others`);
      if (c.others) assert.equal(c.tasks.others?.length, c.others.length, `${c.id}: tasks.others must line up with others`);
    }
    assert.ok(of("duplicate").filter((c) => c.others).length >= 3, "some duplicate cases need company in flight");
    assert.ok(of("duplicate").filter((c) => c.label).length >= 4);
    assert.ok(of("duplicate").filter((c) => !c.label).length >= 4);
  });

  test("has valid conflict cases covering all three levels", () => {
    for (const c of of("conflict")) {
      assert.ok(typeof c.a === "string" && c.a.length > 0, c.id);
      assert.ok(typeof c.b === "string" && c.b.length > 0, c.id);
      assert.ok([0, 1, 2].includes(c.label), `${c.id}: label ${c.label}`);
    }
    for (const label of [0, 1, 2]) assert.ok(of("conflict").filter((c) => c.label === label).length >= 3, `label ${label}`);
  });

  test("has valid evidence cases with both labels and a scope label that is yes, no or unlabelled", () => {
    for (const c of of("evidence")) {
      assert.ok(typeof c.intent === "string" && c.intent.length > 0, c.id);
      assert.ok(Array.isArray(c.criteria) && c.criteria.length <= 1, `${c.id}: one criterion per case`);
      for (const x of c.criteria) assert.ok(typeof x === "string" && x.length > 0, c.id);
      assert.ok(Number.isInteger(c.tests.passed) && c.tests.passed >= 0, c.id);
      assert.ok(Array.isArray(c.newTests) && c.newTests.every((t) => typeof t === "string" && t.length > 0), c.id);
      assert.match(c.diffstat, /\d+ files? changed/, c.id);
      assert.ok(["met", "unmet"].includes(c.label), `${c.id}: label ${c.label}`);
      assert.ok([true, false, null].includes(c.scopeCreep), `${c.id}: scopeCreep ${c.scopeCreep}`);
      assert.ok(c.screenshot === undefined || (typeof c.screenshot === "string" && c.screenshot.length > 0), c.id);
    }
    assert.ok(of("evidence").filter((c) => c.label === "met").length >= 4);
    assert.ok(of("evidence").filter((c) => c.label === "unmet").length >= 4);
    assert.ok(of("evidence").some((c) => c.scopeCreep === true) && of("evidence").some((c) => c.scopeCreep === false));
  });

  test("builds from the demo tasks: every task it names exists and its intent is the task's own", () => {
    const named = (id, text, where) => {
      if (id === null) return;
      assert.ok(tasks.has(id), `${where}: unknown task ${id}`);
      assert.equal(text, tasks.get(id).intent, `${where}: intent differs from task ${id}`);
    };
    for (const c of of("duplicate")) {
      named(c.tasks.new, c.newIntent, c.id);
      named(c.tasks.existing, c.existingIntent, c.id);
      (c.others ?? []).forEach((text, i) => named(c.tasks.others[i], text, c.id));
    }
    for (const c of of("conflict")) {
      named(c.tasks.a, c.a, c.id);
      named(c.tasks.b, c.b, c.id);
    }
    for (const c of of("evidence")) {
      assert.ok(tasks.has(c.task), `${c.id}: unknown task ${c.task}`);
      assert.equal(c.intent, tasks.get(c.task).intent, c.id);
      for (const x of c.criteria) assert.ok(tasks.get(c.task).criteria.includes(x), `${c.id}: criterion is not one of ${c.task}'s`);
    }
  });

  test("never uses a task's spec", () => {
    const text = readFileSync(resolve(REPO_ROOT, "harness/jev-cases.json"), "utf8");
    for (const t of tasks.values()) assert.ok(!text.includes(t.spec.slice(0, 60)), `${t.id}: spec text found`);
  });
});

// ---- the fixture key ---------------------------------------------------------------------------

describe("stable and fixtureKey", () => {
  // The same input and key as test/judge.test.ts asserts for judge.ts, so both implementations are
  // pinned to one value. The key was also computed independently with Python's hashlib.
  const state = { new_intent: "Add a speed category", note: "m² café", n: 2, list: ["a", "b"], skipped: undefined };
  const questions = {
    dup_1: { type: "noul", instructions: "Q?", criteria: { true: "yes", false: "no" } },
    s: { type: "score", instructions: "S?", criteria: ["a", "b", "c"], extra: undefined },
  };
  const KEY = "59cdbed3f03e1fd06fb6658cfbcfcfbf833c04a7d8f4671e00d25bce7b196911";

  test("the key of a known request is the one the Worker test asserts", () => {
    assert.equal(fixtureKey(state, questions), KEY);
  });

  test("stable writes sorted keys, drops undefined and keeps unicode", () => {
    assert.equal(
      stable({ state, questions }),
      '{"questions":{"dup_1":{"criteria":{"false":"no","true":"yes"},"instructions":"Q?","type":"noul"},"s":{"criteria":["a","b","c"],"instructions":"S?","type":"score"}},"state":{"list":["a","b"],"n":2,"new_intent":"Add a speed category","note":"m² café"}}',
    );
  });

  for (const [name, value, expected] of [
    ["a string", "a", '"a"'],
    ["null", null, "null"],
    ["an empty array", [], "[]"],
    ["an empty object", {}, "{}"],
    ["undefined members", { a: 1, b: undefined }, '{"a":1}'],
    ["nested order", { z: { b: [{ y: 1, x: 2 }], a: null } }, '{"z":{"a":null,"b":[{"x":2,"y":1}]}}'],
  ]) {
    test(`stable of ${name}`, () => assert.equal(stable(value), expected));
  }

  test("the key ignores property order and changes with any wording", () => {
    assert.equal(fixtureKey({ b: 1, a: 2 }, {}), fixtureKey({ a: 2, b: 1 }, {}));
    assert.notEqual(fixtureKey({ a: 1 }, {}), fixtureKey({ a: 2 }, {}));
    assert.notEqual(fixtureKey(state, questions), fixtureKey(state, { ...questions, dup_1: { ...questions.dup_1, instructions: "Q??" } }));
    assert.match(fixtureKey({}, {}), /^[0-9a-f]{64}$/);
  });
});

// ---- the recorded fixtures ---------------------------------------------------------------------

describe("test/fixtures/jev", () => {
  const dir = resolve(REPO_ROOT, "test/fixtures/jev");
  const files = readdirSync(dir).filter((f) => f !== "requests.json");
  const requests = JSON.parse(readFileSync(join(dir, "requests.json"), "utf8"));

  test("names each fixture after the key of its own request", () => {
    assert.ok(files.length > 0);
    for (const f of files) {
      const fixture = JSON.parse(readFileSync(join(dir, f), "utf8"));
      assert.deepEqual(Object.keys(fixture).sort(), ["answers", "questions", "state"], f);
      assert.equal(f, `${fixtureKey(fixture.state, fixture.questions)}.json`);
    }
  });

  test("has a fixture for every request, and no fixture without a request", () => {
    const keys = requests.map((r) => `${fixtureKey(r.state, r.questions)}.json`);
    assert.deepEqual([...keys].sort(), [...files].sort());
  });

  test("has requests the current builders reproduce, so a wording change shows up here before it breaks the Worker suite", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(rebuildRequests(q, requests))), requests, "run npm run jev:record");
  });

  test("answers every question with the right kind of answer inside its range", () => {
    for (const f of files) {
      const { questions, answers } = JSON.parse(readFileSync(join(dir, f), "utf8"));
      assert.deepEqual(Object.keys(answers).sort(), Object.keys(questions).sort(), f);
      for (const [name, question] of Object.entries(questions)) {
        const a = answers[name];
        assert.equal(a.type, question.type, `${f} ${name}`);
        if (a.type === "noul") assert.ok(a.noul >= 0 && a.noul <= 1);
        else assert.ok(a.score >= 0 && a.score <= question.criteria.length - 1 && a.confidence >= 0 && a.confidence <= 1);
      }
    }
  });
});

// ---- helpers -----------------------------------------------------------------------------------

describe("trimAnswers", () => {
  test("keeps what the Worker reads and drops the probability tables", () => {
    const full = {
      a: { type: "noul", noul: 0.4, extra: 1 },
      b: { type: "score", score: 1.5, confidence: 0.8, legend: { 0: "x" }, probabilities: { 0: 0.1 } },
    };
    assert.deepEqual(trimAnswers(full), { a: yes(0.4), b: level(1.5, 0.8) });
  });

  test("refuses an answer type the judge never asks for", () => {
    assert.throws(() => trimAnswers({ c: { type: "choice", choice: "x" } }), /unsupported answer type for c: choice/);
    assert.throws(() => trimAnswers({ c: undefined }), /unsupported/);
  });
});

describe("mapPool", () => {
  test("keeps the result order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapPool([30, 5, 20, 1, 10, 2], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return `${i}:${ms}`;
    });
    assert.deepEqual(out, ["0:30", "1:5", "2:20", "3:1", "4:10", "5:2"]);
    assert.equal(peak, 2);
  });

  test("handles no items and a limit above the item count", async () => {
    assert.deepEqual(await mapPool([], 4, async () => 1), []);
    assert.deepEqual(await mapPool([1, 2], 10, async (x) => x * 2), [2, 4]);
  });

  test("rejects when one task rejects", async () => {
    await assert.rejects(mapPool([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error("boom"); return x; }), /boom/);
  });
});

describe("normaliseDiffstat", () => {
  test("re-pads `git apply --stat` to the width `git diff --stat` uses", () => {
    const wide = " a.md   |    1 +\n src/x.ts |   18 ++++++++++++++++++\n 2 files changed, 19 insertions(+)";
    assert.equal(normaliseDiffstat(wide), " a.md     |  1 +\n src/x.ts | 18 ++++++++++++++++++\n 2 files changed, 19 insertions(+)");
  });

  test("keeps deletions and a single row", () => {
    assert.equal(normaliseDiffstat(" f.ts |   2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n"), " f.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)");
  });

  test("refuses text that is not a diff stat", () => {
    assert.throws(() => normaliseDiffstat("not a stat\nat all"), /not a diff stat/);
  });
});

describe("liveClient and loadQuestions", () => {
  test("refuses to start without an API key", () => {
    assert.throws(() => liveClient({ apiKey: "" }), /TYPESAFE_API_KEY/);
  });

  test("loads the Worker's own builders by default and another module on request", async () => {
    assert.equal((await loadQuestions()).screenQuestions, q.screenQuestions);
    const other = await loadQuestions(resolve(REPO_ROOT, "src/shared/judge-questions.ts"));
    assert.equal(typeof other.screenQuestions, "function");
  });
});

describe("prefilter (PLAN.md §7.3 step 1)", () => {
  const get = (id) => cases.find((c) => c.id === id);

  test("passes a pair that shares its wording", () => {
    const p = prefilter(get("dup-speed~cat-speed"));
    assert.equal(p.passes, true);
    assert.ok(p.similarity >= 0.15 && p.similarity < 1);
  });

  test("drops the pairs whose wording differs, which is the finding the calibration reports", () => {
    for (const id of ["dup-velocity~cat-speed", "dup-kmh~cat-speed"]) {
      const p = prefilter(get(id));
      assert.equal(p.passes, false, id);
      assert.ok(p.similarity < 0.15, id);
    }
  });

  test("uses a conflict case's two intents in either role", () => {
    assert.equal(prefilter(get("kelvin-first~kelvin-remove")).passes, true);
    assert.equal(prefilter(get("cat-area~t-dark")).passes, false);
  });
});

// ---- request builders --------------------------------------------------------------------------

describe("case to request", () => {
  test("a duplicate case asks the Worker's screen questions with the existing intent as the one candidate", () => {
    const c = cases.find((x) => x.kind === "duplicate");
    assert.deepEqual(duplicateRequest(q, c), q.screenQuestions(c.newIntent, [{ intent: c.existingIntent }]));
    assert.deepEqual(requestOf(q, c), duplicateRequest(q, c));
  });

  test("a duplicate case with company asks about every in-flight intent in one request, the labelled one first", () => {
    const c = cases.find((x) => x.kind === "duplicate" && x.others?.length === 2);
    const { state, questions } = duplicateRequest(q, c);
    assert.deepEqual(state, { new_intent: c.newIntent, existing_1: c.existingIntent, existing_2: c.others[0], existing_3: c.others[1] });
    assert.equal(Object.keys(questions).length, 9);
    assert.deepEqual(requestOf(q, c), { state, questions });
  });

  test("a conflict case asks the same questions with a as the new intent", () => {
    const c = cases.find((x) => x.kind === "conflict");
    assert.deepEqual(conflictRequest(q, c), q.screenQuestions(c.a, [{ intent: c.b }]));
    assert.deepEqual(requestOf(q, c), conflictRequest(q, c));
  });

  test("an evidence case asks the evidence questions for a passing run", () => {
    const c = cases.find((x) => x.kind === "evidence" && x.screenshot);
    const g = gateInputOf(c);
    assert.equal(g.verify.exitCode, 0);
    assert.equal(g.verify.pass, true);
    assert.equal(g.verify.tests.failed, 0);
    assert.equal(g.tamper, false);
    assert.equal(g.screenshot, c.screenshot);
    assert.deepEqual(evidenceRequest(q, c), q.evidenceQuestions(g));
    assert.equal(evidenceRequest(q, c).state.screenshot_description, `(agent-provided) ${c.screenshot}`);
    assert.deepEqual(requestOf(q, c), evidenceRequest(q, c));
  });

  test("an unknown kind is an error, not a silent skip", () => {
    assert.throws(() => requestOf(q, { kind: "mystery" }), /unknown case kind/);
  });

  test("every case builds a request whose questions can be answered by the scorer", () => {
    for (const c of cases) {
      const { state, questions } = requestOf(q, c);
      assert.ok(Object.keys(questions).length > 0, c.id);
      assert.ok(Object.keys(state).length > 0, c.id);
    }
  });

  test("rebuildRequests refreshes screen and evidence requests from their inputs and leaves others alone", () => {
    const stale = { name: "x", kind: "screen", input: { intent: "Add a speed category", live: [{ id: "t", intent: "Add the Speed category", footprint: [] }] }, state: { old: 1 }, questions: {} };
    const evidence = { name: "e", kind: "evidence", input: { gate: gateInputOf(cases.find((x) => x.kind === "evidence")) }, state: {}, questions: {} };
    const other = { name: "o", kind: "raw", state: { s: 1 }, questions: { q: noul("?") } };
    const [a, b, c] = rebuildRequests(q, [stale, evidence, other]);
    assert.deepEqual(JSON.parse(JSON.stringify({ state: a.state, questions: a.questions })), JSON.parse(JSON.stringify(q.screenQuestions(stale.input.intent, [{ id: "t", intent: "Add the Speed category", similarity: 0 }]))));
    assert.ok(b.questions.scope_creep);
    assert.equal(c, other);
    assert.equal(a.name, "x");
  });

  test("rebuildRequests asks only about candidates that pass the prefilter, ranked by similarity", () => {
    const live = [
      { id: "far", intent: "Remove the footer", footprint: [] },
      { id: "near", intent: "Add a speed category with units", footprint: [] },
    ];
    const [r] = rebuildRequests(q, [{ name: "n", kind: "screen", input: { intent: "Add a speed category", live }, state: {}, questions: {} }]);
    assert.deepEqual(r.state, { new_intent: "Add a speed category", existing_1: "Add a speed category with units" });
  });
});

// ---- the scorer --------------------------------------------------------------------------------

const dupCase = (label, over = {}) => ({ id: "d", kind: "duplicate", newIntent: "Add a speed category", existingIntent: 'Add the "Speed" converter category with 6 units', label, ...over });
// The catalogue's own G3 duplicate whose wording the trigram prefilter cannot connect to the original.
const farDup = (label) => {
  const real = cases.find((c) => c.id === "dup-velocity~cat-speed");
  return dupCase(label, { newIntent: real.newIntent, existingIntent: real.existingIntent });
};
const conCase = (label, over = {}) => ({ id: "c", kind: "conflict", a: "Show Kelvin first in the temperature units", b: "Remove Kelvin from temperature", label, ...over });
const evCase = (label, over = {}) => ({ id: "e", kind: "evidence", intent: "Add a Speed category", criteria: ["Speed is listed"], tests: { passed: 70 }, newTests: ["speed has a page"], diffstat: " a | 1 +\n 1 file changed, 1 insertion(+)", label, scopeCreep: false, ...over });
const dupAnswers = (v) => ({ dup_1: yes(v), conflict_1_ab: level(0, 1), conflict_1_ba: level(0, 1) });
const conAnswers = (ab, ba, c1 = 1, c2 = 1) => ({ dup_1: yes(0), conflict_1_ab: level(ab, c1), conflict_1_ba: level(ba, c2) });
const evAnswers = (criterion, scope = 0) => ({ criterion_1: yes(criterion), scope_creep: yes(scope) });

describe("scoreCase: duplicate", () => {
  for (const [dup, label, predicted] of [
    [0.49, true, false],
    [0.5, true, true],
    [0.95, true, true],
    [0.49, false, false],
    [0.5, false, true],
    [0, false, false],
  ]) {
    test(`dup ${dup} against label ${label}`, () => {
      const r = scoreCase(q, dupCase(label), dupAnswers(dup));
      assert.equal(r.predicted, predicted);
      assert.equal(r.correct, predicted === label);
      assert.equal(r.dup, dup);
    });
  }

  test("uses the cut-off of 0.5", () => assert.equal(DUP_CUT, 0.5));

  test("end to end, a pair the prefilter drops is never asked, so a true duplicate is missed even when Jev says yes", () => {
    const dropped = scoreCase(q, farDup(true), dupAnswers(0.9));
    assert.equal(dropped.prefilter.passes, false);
    assert.equal(dropped.correct, true);
    assert.equal(dropped.e2e, false);
  });

  test("end to end, a non-duplicate the prefilter drops counts as right whatever Jev would say", () => {
    const r = scoreCase(q, farDup(false), dupAnswers(0.9));
    assert.equal(r.correct, false);
    assert.equal(r.e2e, true);
  });

  test("end to end, a pair that passes is as right as the answer", () => {
    assert.equal(scoreCase(q, dupCase(true), dupAnswers(0.9)).e2e, true);
    assert.equal(scoreCase(q, dupCase(true), dupAnswers(0.1)).e2e, false);
    assert.equal(scoreCase(q, dupCase(false), dupAnswers(0.1)).e2e, true);
  });

  test("carries the set the case belongs to", () => {
    assert.equal(scoreCase(q, dupCase(true, { holdout: true }), dupAnswers(0.9)).holdout, true);
    assert.equal(scoreCase(q, dupCase(true), dupAnswers(0.9)).holdout, false);
  });
});

describe("scoreCase: conflict", () => {
  for (const [ab, ba, predicted] of [
    [0, 0, 0],
    [0.49, 0.49, 0],
    [0.5, 0.5, 1],
    [1, 1, 1],
    [1.49, 1.49, 1],
    [1.5, 1.5, 2],
    [2, 2, 2],
    [2, 1, 2],
    [2, 0, 1],
    [0, 1, 1],
  ]) {
    test(`scores ${ab} and ${ba} round to ${predicted}`, () => {
      const r = scoreCase(q, conCase(predicted), conAnswers(ab, ba));
      assert.equal(r.predicted, predicted);
      assert.equal(r.correct, true);
      assert.equal(scoreCase(q, conCase((predicted + 1) % 3), conAnswers(ab, ba)).correct, false);
    });
  }

  for (const [ab, ba, label, ok] of [
    [2, 2, 2, true],
    [1.5, 1.5, 2, true],
    [1.49, 1.49, 2, false],
    [1.5, 1.5, 1, false],
    [1, 1, 1, true],
    [0, 0, 0, true],
    [2, 2, 0, false],
  ]) {
    test(`warn rule: mean ${(ab + ba) / 2} against label ${label}`, () => {
      assert.equal(scoreCase(q, conCase(label), conAnswers(ab, ba)).warnOk, ok);
      assert.equal(CONFLICT_WARN, 1.5);
    });
  }

  test("reports the mean confidence and flags a low-confidence answer that would not warn on score", () => {
    const r = scoreCase(q, conCase(1), conAnswers(1, 1, 0.1, 0.3));
    assert.ok(Math.abs(r.confidence - 0.2) < 1e-9);
    assert.equal(r.lowConfidence, true);
    assert.equal(scoreCase(q, conCase(1), conAnswers(1, 1, 0.3, 0.3)).lowConfidence, false);
    assert.equal(scoreCase(q, conCase(2), conAnswers(2, 2, 0, 0)).lowConfidence, false);
  });

  test("end to end, a dropped conflicting pair reads as independent", () => {
    const far = conCase(2, { a: "Remove the footer", b: "Add search to the header" });
    const dropped = scoreCase(q, far, conAnswers(2, 2));
    assert.equal(dropped.prefilter.passes, false);
    assert.equal(dropped.correct, true);
    assert.equal(dropped.e2e, false);
    assert.equal(scoreCase(q, { ...far, label: 0 }, conAnswers(2, 2)).e2e, true);
  });

  test("clamps a score outside the rubric", () => {
    assert.equal(scoreCase(q, conCase(2), conAnswers(3, 3)).predicted, 2);
    assert.equal(scoreCase(q, conCase(0), conAnswers(-1, -1)).predicted, 0);
  });
});

describe("scoreCase: evidence", () => {
  for (const [value, verdict] of [
    [0, "unmet"],
    [0.3499, "unmet"],
    [0.35, "uncertain"],
    [0.5, "uncertain"],
    [0.6999, "uncertain"],
    [0.7, "met"],
    [1, "met"],
  ]) {
    test(`a criterion of ${value} is ${verdict}`, () => {
      assert.equal(verdictOf(value), verdict);
      assert.equal(scoreCase(q, evCase("met"), evAnswers(value)).verdict, verdict);
    });
  }

  test("thresholds match the gate", () => {
    assert.equal(MET, 0.7);
    assert.equal(UNMET, 0.35);
  });

  for (const [value, label, correct] of [
    [0.9, "met", true],
    [0.9, "unmet", false],
    [0.1, "unmet", true],
    [0.1, "met", false],
    [0.5, "met", false],
    [0.5, "unmet", false],
  ]) {
    test(`criterion ${value} against label ${label}: ${correct ? "right" : "wrong"} (uncertain counts as wrong)`, () => {
      assert.equal(scoreCase(q, evCase(label), evAnswers(value)).correct, correct);
    });
  }

  for (const [scope, label, ok] of [
    [0.7, true, true],
    [0.69, true, false],
    [0.69, false, true],
    [0.7, false, false],
    [0.9, null, null],
    [0.1, null, null],
  ]) {
    test(`scope creep ${scope} against label ${label}`, () => {
      const r = scoreCase(q, evCase("met", { scopeCreep: label }), evAnswers(0.9, scope));
      assert.equal(r.scopeCorrect, ok);
      assert.equal(r.scope, scope);
    });
  }

  test("a missing answer is a coin flip, so uncertain", () => {
    assert.equal(scoreCase(q, evCase("met"), {}).verdict, "uncertain");
  });

  test("an evidence case without criteria is scored on the intent as the criterion", () => {
    const c = evCase("met", { criteria: [] });
    assert.deepEqual(Object.keys(requestOf(q, c).questions), ["criterion_1", "scope_creep"]);
    assert.equal(scoreCase(q, c, evAnswers(0.9)).correct, true);
  });
});

describe("histogram", () => {
  test("puts 0 in the first bucket and 1 in the last", () => {
    assert.deepEqual(histogram([0, 1]), [1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  test("buckets by tenths, lower bound inclusive", () => {
    assert.deepEqual(histogram([0.05, 0.1, 0.19, 0.5, 0.95, 0.999]), [1, 2, 0, 0, 0, 1, 0, 0, 0, 2]);
  });

  test("is empty for no values and clamps strays", () => {
    assert.deepEqual(histogram([]), Array(10).fill(0));
    assert.deepEqual(histogram([-1, 2]), [1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });
});

describe("summarize", () => {
  const rows = [
    scoreCase(q, dupCase(true), dupAnswers(0.9)),
    scoreCase(q, dupCase(true, { holdout: true }), dupAnswers(0.4)),
    scoreCase(q, dupCase(false), dupAnswers(0.85)),
    scoreCase(q, dupCase(false), dupAnswers(0.5)),
    scoreCase(q, dupCase(false), dupAnswers(0.1)),
    scoreCase(q, conCase(2), conAnswers(2, 2)),
    scoreCase(q, conCase(0, { holdout: true }), conAnswers(1, 1, 0.1, 0.1)),
    scoreCase(q, evCase("met"), evAnswers(0.9, 0.8)),
    scoreCase(q, evCase("unmet", { scopeCreep: true }), evAnswers(0.1, 0.9)),
    scoreCase(q, evCase("met", { scopeCreep: null, holdout: true }), evAnswers(0.5, 0.2)),
  ];
  const s = summarize(rows);

  test("counts correct answers per kind and overall", () => {
    assert.deepEqual(s.duplicate, { n: 5, correct: 2 });
    assert.deepEqual(s.conflict, { n: 2, correct: 1 });
    assert.deepEqual(s.evidence, { n: 3, correct: 2 });
    assert.deepEqual(s.overall, { n: 10, correct: 5 });
  });

  test("splits the tune and holdout cases", () => {
    assert.deepEqual(s.holdout.overall, { n: 3, correct: 0 });
    assert.deepEqual(s.tune.overall, { n: 7, correct: 5 });
    assert.deepEqual(s.holdout.duplicate, { n: 1, correct: 0 });
    assert.deepEqual(s.tune.evidence, { n: 2, correct: 2 });
  });

  test("counts the warn rule and the scope creep rule separately and skips unlabelled scope", () => {
    assert.deepEqual(s.conflictWarn, { n: 2, correct: 2 });
    assert.deepEqual(s.scope, { n: 2, correct: 1 });
  });

  test("counts true duplicates and non-duplicates in the reject, warn and silent bands", () => {
    assert.deepEqual(s.bands.trueDuplicates, { reject: 1, warn: 1, silent: 0 });
    assert.deepEqual(s.bands.nonDuplicates, { reject: 1, warn: 1, silent: 1 });
  });

  test("puts exactly 0.8 in the reject band and exactly 0.35 in the warn band, as the Ledger does", () => {
    const edge = summarize([0.8, 0.7999, 0.35, 0.3499, 0].map((v) => scoreCase(q, dupCase(true), dupAnswers(v))));
    assert.deepEqual(edge.bands.trueDuplicates, { reject: 1, warn: 2, silent: 2 });
    assert.equal(edge.uncertain.duplicate, 2);
  });

  test("reports the verdicts per label", () => {
    assert.deepEqual(s.verdicts, { met: ["met", "uncertain"], unmet: ["unmet"] });
  });

  test("counts what the prefilter keeps", () => {
    assert.deepEqual(s.prefilter.trueDuplicates, { n: 2, correct: 2 });
    assert.deepEqual(s.prefilter.nonDuplicates, { n: 3, correct: 3 });
    assert.deepEqual(s.prefilter.conflicts, { n: 1, correct: 1 });
  });

  test("builds the histograms and the uncertain-band counts", () => {
    assert.equal(s.histograms.duplicate.reduce((a, b) => a + b, 0), 5);
    assert.equal(s.histograms.criterion.reduce((a, b) => a + b, 0), 3);
    assert.equal(s.histograms.conflictConfidence.reduce((a, b) => a + b, 0), 2);
    assert.deepEqual(s.uncertain, { duplicate: 2, criterion: 1, lowConfidence: 1 });
  });

  test("copes with no results at all", () => {
    const empty = summarize([]);
    assert.deepEqual(empty.overall, { n: 0, correct: 0 });
    assert.deepEqual(empty.bands.trueDuplicates, { reject: 0, warn: 0, silent: 0 });
  });
});

// ---- the catalogue sweep -----------------------------------------------------------------------

describe("catalogue", () => {
  test("covers every task that reaches the gate and skips the protected-file tamper", () => {
    const ids = catalogue.map((e) => e.task.id);
    assert.ok(!ids.includes("tamper-routes"));
    assert.equal(ids.length, tasks.size - 1);
    assert.ok(ids.includes("cat-area") && ids.includes("t-dark") && ids.includes("kelvin-first"));
  });

  test("builds the evidence the land job would: test names from the test files only, a normalised diff stat, the catalogue screenshot", () => {
    const area = catalogue.find((e) => e.task.id === "cat-area").gate;
    assert.deepEqual(area.newTests, [
      "area: ${c.v} ${c.from} is ${c.result} ${c.to}",
      "area: ${c.v} ${c.from} to ${c.to} displays as ${c.display}",
      "area has a converter page",
    ]);
    assert.match(area.diffstat, /^ CHANGELOG\.md {6}\|  1 \+\n/);
    assert.match(area.diffstat, / 4 files changed, 54 insertions\(\+\)$/);
    assert.equal(area.screenshot, tasks.get("cat-area").screenshot_description);
    assert.deepEqual(area.criteria, tasks.get("cat-area").criteria);
    assert.equal(area.verify.tests.passed, 65 + 3);
    assert.equal(area.verify.tests.failed, 0);
  });

  test("ignores test-like calls outside test/ in a patch", () => {
    const patch = [
      "diff --git a/src/x.ts b/src/x.ts",
      "+++ b/src/x.ts",
      '+  it("not a test", () => {})',
      "diff --git a/test/x.test.ts b/test/x.test.ts",
      "+++ b/test/x.test.ts",
      '+test("a real test", () => {})',
    ].join("\n");
    const g = catalogueGate({ intent: "i", criteria: [], screenshot: "s" }, patch, " d");
    assert.deepEqual(g.newTests, ["a real test"]);
  });

  const task = { id: "t", expect: "land" };
  const gate = { ...gateInputOf(cases.find((c) => c.kind === "evidence")), criteria: ["a", "b"] };
  const answers = (c1, c2, scope) => ({ criterion_1: yes(c1), criterion_2: yes(c2), scope_creep: yes(scope) });

  for (const [name, c1, c2, scope, decision, reason] of [
    ["lands when every criterion is met", 0.9, 0.8, 0.1, "land", null],
    ["goes to a human on an uncertain criterion", 0.9, 0.6, 0.1, "needs_human", "criterion_uncertain"],
    ["goes to a human on scope creep", 0.9, 0.9, 0.8, "needs_human", "scope_creep"],
    ["fails on an unmet criterion", 0.9, 0.2, 0.1, "failed", "criterion_unmet"],
  ]) {
    test(`a task ${name}`, () => {
      const row = catalogueRow(q, { task, gate }, answers(c1, c2, scope));
      assert.equal(row.decision, decision);
      assert.equal(row.reason, reason);
      assert.deepEqual(row.criteria, [c1, c2]);
      assert.equal(row.scope, scope);
      assert.equal(row.id, "t");
    });
  }

  test("summarizes the sweep", () => {
    const rows = [
      { decision: "land", criteria: [0.9, 0.8] },
      { decision: "land", criteria: [0.7, 0.95] },
      { decision: "needs_human", criteria: [0.6, 0.9] },
      { decision: "failed", criteria: [0.1, 0.9] },
    ];
    assert.deepEqual(summarizeCatalogue(rows), { tasks: 4, land: 2, needsHuman: 1, failed: 1, criteria: 8, criteriaMet: 6 });
    assert.deepEqual(summarizeCatalogue([]), { tasks: 0, land: 0, needsHuman: 0, failed: 0, criteria: 0, criteriaMet: 0 });
  });
});

// ---- the report --------------------------------------------------------------------------------

describe("renderReport and spliceDoc", () => {
  const results = [
    scoreCase(q, dupCase(true), dupAnswers(0.9)),
    scoreCase(q, farDup(true), dupAnswers(0.9)),
    scoreCase(q, dupCase(false, { id: "d2|pipe" }), dupAnswers(0.1)),
    scoreCase(q, conCase(2), conAnswers(2, 2)),
    scoreCase(q, evCase("met"), evAnswers(0.9)),
  ];
  const meta = { date: "2026-10-08", model: "jev-test", wordingId: "abc123", cases: 5, requests: 5 };
  const sweep = [
    { id: "ok", decision: "land", reason: null, criteria: [0.9], scope: 0.1 },
    { id: "held", decision: "needs_human", reason: "criterion_uncertain", criteria: [0.5], scope: 0.2 },
  ];
  const report = renderReport({ results, summary: summarize(results), sweep, meta });

  test("is delimited by the markers and says what it ran against", () => {
    assert.ok(report.startsWith(START));
    assert.ok(report.endsWith(END));
    assert.match(report, /Run 2026-10-08 against `jev-test`, wording id `abc123`, 5 cases, 5 live requests/);
  });

  test("reports accuracy per kind with the rule used", () => {
    assert.match(report, /\| duplicate \| dup >= 0\.5 against the label \| /);
    assert.match(report, /\| conflict \| round\(mean score\) equals the 0\/1\/2 label \| /);
    assert.match(report, /\| evidence \| criterion >= 0\.7 is met, < 0\.35 is unmet, in between counts as wrong \| /);
    assert.match(report, /\*\*overall\*\*/);
    assert.match(report, /Conflict warn rule/);
    assert.match(report, /Scope creep/);
  });

  test("names a true duplicate the prefilter drops as a finding", () => {
    assert.match(report, /\*\*Finding\.\*\* 1 true duplicate never reaches Jev/);
    assert.match(report, /`d` \(0\.\d{3}\)|`[^`]+` \(0\.\d{3}\)/);
  });

  test("names a conflicting pair the prefilter drops as a finding of its own", () => {
    const far = conCase(2, { id: "far", a: "Remove the footer", b: "Add search to the header" });
    const rows = [scoreCase(q, far, conAnswers(2, 2)), scoreCase(q, conCase(2), conAnswers(2, 2))];
    const text = renderReport({ results: rows, summary: summarize(rows), meta });
    assert.match(text, /\*\*Finding\.\*\* 1 conflicting pair \(label 2\) never reaches Jev either: `far` \(0\.\d{3}\)/);
    assert.doesNotMatch(text, /true duplicates? never reach/);
  });

  test("has no finding when the prefilter keeps every true duplicate and every conflicting pair", () => {
    const ok = [scoreCase(q, dupCase(true), dupAnswers(0.9)), scoreCase(q, conCase(2), conAnswers(2, 2)), scoreCase(q, conCase(0, { a: "Remove the footer", b: "Add search to the header" }), conAnswers(0, 0))];
    assert.doesNotMatch(renderReport({ results: ok, summary: summarize(ok), meta }), /Finding/);
  });

  test("lists every case with its answers, escaping pipes in ids", () => {
    assert.match(report, /\| d2\\\|pipe \| tune \| different \| 0\.10 \| different \| yes \| /);
    assert.match(report, /#### Duplicate/);
    assert.match(report, /#### Conflict/);
    assert.match(report, /#### Evidence/);
  });

  test("shows the confidence distribution as four histograms", () => {
    for (const title of ["Duplicate answers", "Criterion answers", "Scope creep answers", "Conflict confidence"]) assert.match(report, new RegExp(title));
    assert.equal((report.match(/0\.9-1\.0/g) ?? []).length, 4);
  });

  test("shows the catalogue sweep with the tasks the gate would hold back", () => {
    assert.match(report, /### Demo catalogue sweep/);
    assert.match(report, /Land without a human: \*\*1\/2\*\*/);
    assert.match(report, /\| held \| needs_human \| criterion_uncertain \| 0\.50 \| 0\.20 \|/);
    assert.doesNotMatch(report, /\| ok \|/);
  });

  test("omits the sweep section when there is no sweep", () => {
    assert.doesNotMatch(renderReport({ results, summary: summarize(results), meta }), /Demo catalogue sweep/);
  });

  test("replaces only the generated region and keeps the hand-written text around it", () => {
    const doc = `# Title\n\nIntro written by hand.\n\n${START}\nold results\n${END}\n\n## History\n\nKept.\n`;
    const out = spliceDoc(doc, report);
    assert.ok(out.startsWith("# Title\n\nIntro written by hand.\n\n"));
    assert.ok(out.endsWith("\n\n## History\n\nKept.\n"));
    assert.ok(!out.includes("old results"));
    assert.equal(out.split(START).length, 2);
  });

  test("is idempotent", () => {
    const once = spliceDoc("# T\n", report);
    assert.equal(spliceDoc(once, report), once);
  });

  test("starts a document when there is none, or when the markers are missing", () => {
    for (const existing of ["", "# Old\n\nno markers here\n"]) {
      const out = spliceDoc(existing, report);
      assert.ok(out.startsWith("# Jev calibration\n\n"));
      assert.ok(out.includes(START) && out.includes(END));
    }
  });
});

// ---- the whole calibration run against a fake API ----------------------------------------------

describe("calibrate against a fake System One", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.TYPESAFE_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = realKey;
  });

  // Answers by question type: duplicates 0.9, conflicts at 1.5 (confident), criteria 0.8, scope 0.1.
  function fakeApi() {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ url, body, auth: new Headers(init.headers).get("authorization") });
      const answers = {};
      for (const [name, question] of Object.entries(body.questions)) {
        if (question.type === "score") answers[name] = { type: "score", score: 1.5, confidence: 0.9, legend: {}, probabilities: {} };
        else answers[name] = { type: "noul", noul: name.startsWith("dup_") ? 0.9 : name === "scope_creep" ? 0.1 : 0.8 };
      }
      return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    process.env.TYPESAFE_API_KEY = "test-key";
    return seen;
  }

  test("asks every case once, with the Worker's own questions, and scores the answers", async () => {
    const seen = fakeApi();
    const subset = [...cases.filter((c) => c.kind === "duplicate").slice(0, 3), ...cases.filter((c) => c.kind === "conflict").slice(0, 3), ...cases.filter((c) => c.kind === "evidence").slice(0, 3)];
    const run = await calibrate({ cases: subset });
    assert.equal(run.requests, 9);
    assert.equal(run.results.length, 9);
    assert.equal(run.model, "jev-1.13.0");
    assert.match(run.wordingId, /^[0-9a-f]{12}$/);
    assert.deepEqual(seen.map((s) => s.url), Array(9).fill("https://api.typesafe.ai/v1/systemone"));
    assert.ok(seen.every((s) => s.auth === "Bearer test-key" && s.body.model === "jev-1.13.0"));
    const asked = new Set(seen.map((s) => fixtureKey(s.body.state, s.body.questions)));
    for (const c of subset) {
      const { state, questions } = requestOf(q, c);
      assert.ok(asked.has(fixtureKey(state, questions)), `${c.id}: request not sent as built`);
    }
    assert.deepEqual(run.results.map((r) => r.id), subset.map((c) => c.id));
    assert.ok(run.results.filter((r) => r.kind === "duplicate").every((r) => r.dup === 0.9));
    assert.ok(run.results.filter((r) => r.kind === "conflict").every((r) => r.conflict === 1.5 && r.predicted === 2));
    assert.ok(run.results.filter((r) => r.kind === "evidence").every((r) => r.criterion === 0.8 && r.verdict === "met"));
    assert.equal(run.summary.overall.n, 9);
  });

  test("adds one request per catalogue task and decides each with the gate's rule", async () => {
    const seen = fakeApi();
    const run = await calibrate({ cases: [], catalogue });
    assert.equal(run.sweep.length, tasks.size - 1);
    assert.equal(seen.length, tasks.size - 1);
    assert.ok(run.sweep.every((r) => r.decision === "land" && r.reason === null));
    assert.ok(run.sweep.every((r) => r.criteria.every((v) => v === 0.8) && r.scope === 0.1));
  });

  test("fails loudly when the API refuses, so a doc is never written from half a run", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "no" }), { status: 401, headers: { "content-type": "application/json" } });
    process.env.TYPESAFE_API_KEY = "bad-key";
    await assert.rejects(calibrate({ cases: cases.slice(0, 2) }), /401/);
  });
});

// ---- the recorder ------------------------------------------------------------------------------

describe("jev:record", () => {
  const screen = (intent) => ({ name: intent, kind: "screen", input: { intent, live: [{ id: "t_1", intent: "Add the Speed converter category", footprint: [] }] }, state: {}, questions: {} });
  let n = 0;
  const workDir = (entries) => {
    const dir = join(ROOT, `rec-${++n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "requests.json"), JSON.stringify(entries));
    return dir;
  };
  const files = (dir) => readdirSync(dir).sort();
  const fake = () => {
    const calls = [];
    return { calls, async ask(state, questions) { calls.push(state); return Object.fromEntries(Object.entries(questions).map(([k, v]) => [k, v.type === "noul" ? yes(0.25) : level(1, 0.5)])); } };
  };

  test("plan separates what to record, what to keep and what is stale", () => {
    const a = { state: { n: 1 }, questions: { q: noul("a") } };
    const b = { state: { n: 2 }, questions: { q: noul("b") } };
    const [ka, kb] = [fixtureKey(a.state, a.questions), fixtureKey(b.state, b.questions)];
    const stale = "f".repeat(64);
    const all = plan([a, b], [ka, stale]);
    assert.deepEqual(all.toRecord.map((r) => r.key), [ka, kb]);
    assert.deepEqual(all.kept, []);
    assert.deepEqual(all.orphans, [stale]);
    const missing = plan([a, b], [ka, stale], { onlyMissing: true });
    assert.deepEqual(missing.toRecord.map((r) => r.key), [kb]);
    assert.deepEqual(missing.kept.map((r) => r.key), [ka]);
    assert.deepEqual(plan([], []), { toRecord: [], kept: [], orphans: [] });
  });

  test("writes one fixture per request, named by its key, and refreshes requests.json from the inputs", async () => {
    const dir = workDir([screen("Add a speed category"), screen("Add a tax category")]);
    const live = fake();
    const r = await record({ dir, q, live });
    assert.deepEqual({ recorded: r.recorded, kept: r.kept }, { recorded: 2, kept: 0 });
    assert.equal(live.calls.length, 2);
    const requests = JSON.parse(readFileSync(join(dir, "requests.json"), "utf8"));
    assert.deepEqual(Object.keys(requests[0].questions), ["dup_1", "conflict_1_ab", "conflict_1_ba"]);
    assert.deepEqual(files(dir), [...requests.map((x) => `${fixtureKey(x.state, x.questions)}.json`), "requests.json"].sort());
    for (const x of requests) {
      const text = readFileSync(join(dir, `${fixtureKey(x.state, x.questions)}.json`), "utf8");
      assert.equal(text, fixtureText(x.state, x.questions, { dup_1: yes(0.25), conflict_1_ab: level(1, 0.5), conflict_1_ba: level(1, 0.5) }));
      assert.ok(text.endsWith("\n"));
    }
  });

  test("with --only-missing records only what has no fixture yet", async () => {
    const dir = workDir([screen("Add a speed category")]);
    await record({ dir, q, live: fake() });
    writeFileSync(join(dir, "requests.json"), JSON.stringify([screen("Add a speed category"), screen("Add a tax category")]));
    const live = fake();
    const r = await record({ dir, q, live, onlyMissing: true });
    assert.deepEqual({ recorded: r.recorded, kept: r.kept }, { recorded: 1, kept: 1 });
    assert.equal(live.calls.length, 1);
    assert.equal(files(dir).length, 3);
  });

  test("reports stale fixtures and deletes them only with --prune", async () => {
    const dir = workDir([screen("Add a speed category")]);
    await record({ dir, q, live: fake() });
    const stale = `${"a".repeat(64)}.json`;
    writeFileSync(join(dir, stale), "{}");
    const kept = await record({ dir, q, live: fake() });
    assert.deepEqual(kept.orphans, ["a".repeat(64)]);
    assert.ok(files(dir).includes(stale));
    const pruned = await record({ dir, q, live: fake(), prune: true });
    assert.equal(pruned.pruned, true);
    assert.ok(!files(dir).includes(stale));
    assert.equal(files(dir).length, 2);
  });

  test("leaves the directory as it was when a live request fails", async () => {
    const dir = workDir([screen("Add a speed category"), screen("Add a tax category")]);
    const before = readFileSync(join(dir, "requests.json"), "utf8");
    let n2 = 0;
    const failing = { async ask() { if (++n2 === 2) throw new Error("rate limited"); return {}; } };
    await assert.rejects(record({ dir, q, live: failing }), /rate limited/);
    assert.deepEqual(files(dir), ["requests.json"]);
    assert.equal(readFileSync(join(dir, "requests.json"), "utf8"), before);
  });

  test("an unreadable request list is an error", async () => {
    const dir = join(ROOT, "rec-missing");
    mkdirSync(dir);
    await assert.rejects(record({ dir, q, live: fake() }), /ENOENT/);
  });
});

test("the module paths the npm scripts use exist", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const pkg = JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8"));
  assert.equal(pkg.scripts["jev:record"], "node harness/jev-record.mjs");
  assert.equal(pkg.scripts["jev:calibrate"], "node harness/jev-calibrate.mjs");
  for (const f of ["harness/jev-record.mjs", "harness/jev-calibrate.mjs", "harness/lib/jev.mjs"]) assert.ok(readFileSync(resolve(REPO_ROOT, f), "utf8").length > 0);
});
