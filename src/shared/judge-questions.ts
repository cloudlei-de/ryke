// Jev question wording and the evidence-gate decision rule (PLAN.md §7.3, §9). Shared by the Worker
// (src/worker/judge.ts) and the Node calibration harness, so the questions calibrated are the
// questions asked. Imports carry .ts extensions because Node loads this file directly.
import { noul, score, type Questions } from "@typesafe-ai/sdk";
import { matchesAny } from "./policy.ts";
import type { Policy, TestSummary } from "./types.ts";

export const MODEL = "jev-1.13.0";

export type Answer = { type: "noul"; noul: number } | { type: "score"; score: number; confidence: number };

// Wording rules (docs/platform-notes.md §Jev): one condition per question, each level a concrete
// situation, high means yes, text only. docs/jev-calibration.md records what each change did to the
// accuracy; re-run `npm run jev:calibrate` and `npm run jev:record` after touching any string here.
export const CONFLICT_LEVELS = [
  "Independent: they add or change separate things, neither needs the other, and either can land first",
  "Overlapping but compatible: they edit the same file or function, and the result of landing both still does what both asked",
  "Conflicting: one asks to remove, reverse or contradict something the other adds or requires, so both cannot be satisfied together",
] as const;

// The "contained in" clause is one-way on purpose: when the new intent is the larger one it still
// has work to do, and a symmetric "one is part of the other" scored such pairs 0.55 to 0.6, which
// warns about a duplicate that is not one.
export const DUPLICATE_CRITERIA = {
  true: "Both intents ask for the same feature, fix or refactor, even if worded differently, or the new intent asks for nothing more than the existing intent already delivers",
  false: "They ask for different features, fixes or refactors, even if they touch the same area or have similar names or wording",
};

// The gate only sees test names, a diff stat and one screenshot line, so the exact numbers a
// criterion quotes live in the test file and cannot be checked here. The tests pass (a hard check
// already ran), so a new test that describes the behaviour counts; without this sentence most
// reference solutions of the demo catalogue scored 0.6 to 0.7 and went to a human.
export const EVIDENCE_CRITERIA = {
  true: "The tests pass and a new test name, the diff stat or the screenshot description describes the behaviour the criterion asks for; exact values need not be shown, because the tests pass",
  false: "The new tests and the diff stat are about something else, are missing, or contradict the criterion",
};

export const SCOPE_CRITERIA = {
  true: "The diff stat lists files that have no reason to change for this intent, such as other features, unrelated pages or configuration",
  false: "Every file in the diff stat is one the intent needs, apart from its tests and a changelog entry",
};

export function screenQuestions(intent: string, candidates: { intent: string }[]) {
  const state: Record<string, string> = { new_intent: intent };
  const questions: Questions = {};
  candidates.forEach((c, i) => {
    const k = `existing_${i + 1}`;
    state[k] = c.intent;
    questions[`dup_${i + 1}`] = noul(`Would completing \`new_intent\` produce essentially the same change to the codebase as completing \`${k}\`?`, DUPLICATE_CRITERIA);
    questions[`conflict_${i + 1}_ab`] = score(`How do \`new_intent\` and \`${k}\` interact if two agents implement them at the same time on the same codebase?`, CONFLICT_LEVELS);
    questions[`conflict_${i + 1}_ba`] = score(`How do \`${k}\` and \`new_intent\` interact if two agents implement them at the same time on the same codebase?`, CONFLICT_LEVELS);
  });
  return { state, questions };
}

export const noulOf = (a: Answer | undefined) => (a?.type === "noul" ? a.noul : 0.5);
export const scoreOf = (a: Answer | undefined) => (a?.type === "score" ? a : { score: 1, confidence: 0 });

// §7.3 decision per candidate: reject a duplicate, or warn so the agents coordinate.
export function screenDecision(answers: Record<string, Answer>, i: number) {
  const dup = noulOf(answers[`dup_${i + 1}`]);
  const ab = scoreOf(answers[`conflict_${i + 1}_ab`]);
  const ba = scoreOf(answers[`conflict_${i + 1}_ba`]);
  const conflict = (ab.score + ba.score) / 2;
  const confidence = (ab.confidence + ba.confidence) / 2;
  return { dup, conflict, confidence, reject: dup >= 0.8, warnDuplicate: dup >= 0.35, warnConflict: conflict >= 1.5 || confidence < 0.3 };
}

export type GateInput = {
  intent: string;
  criteria: string[];
  writes: string[];
  verify: { exitCode: number; pass: boolean; tests: TestSummary };
  tamper: boolean;
  newTests: string[];
  diffstat: string;
  screenshot?: string | null;
  approved?: boolean;
};
export type Verdict = { question: string; value: number; confidence: number | null; detail: string | null };
export type GateResult = { decision: "land" | "failed" | "needs_human"; reason: string | null; verdicts: Verdict[] };

export function evidenceQuestions(g: GateInput) {
  const criteria = g.criteria.length > 0 ? g.criteria : [g.intent];
  const state: Record<string, unknown> = {
    intent: g.intent,
    test_summary: `${g.verify.tests.passed} passed, ${g.verify.tests.failed} failed`,
    new_tests: g.newTests,
    diff_stat: g.diffstat,
  };
  if (g.screenshot) state.screenshot_description = `(agent-provided) ${g.screenshot}`;
  const questions: Questions = {};
  criteria.forEach((c, i) => {
    state[`criterion_${i + 1}`] = c;
    questions[`criterion_${i + 1}`] = noul(
      `Do \`test_summary\`, \`new_tests\`, \`diff_stat\` and \`screenshot_description\` (when present) show that \`criterion_${i + 1}\` is met?`,
      EVIDENCE_CRITERIA,
    );
  });
  questions.scope_creep = noul("Does `diff_stat` show changes outside what `intent` needs?", SCOPE_CRITERIA);
  return { state, questions };
}

// The hard checks of §9.3, in code: any failure decides without asking Jev.
export function hardChecks(g: GateInput): GateResult | null {
  if (g.verify.exitCode !== 0 || !g.verify.pass) return { decision: "failed", reason: "verify_failed", verdicts: [] };
  if (g.verify.tests.failed > 0) return { decision: "failed", reason: "tests_failed", verdicts: [] };
  if (g.tamper) return { decision: "failed", reason: "test_tamper", verdicts: [] };
  if (g.approved) return { decision: "land", reason: "approved", verdicts: [] };
  return null;
}

// §9.3 decision from Jev's answers: unmet → failed; uncertain, scope creep or a human path → human.
export function gateDecision(g: GateInput, policy: Policy, answers: Record<string, Answer>, questions: Questions, source: string): GateResult {
  const human = g.writes.some((w) => matchesAny(policy.human, w));
  const verdicts: Verdict[] = Object.keys(questions).map((q) => ({ question: q, value: noulOf(answers[q]), confidence: null, detail: source }));
  const criteria = verdicts.filter((v) => v.question.startsWith("criterion_"));
  const scope = verdicts.find((v) => v.question === "scope_creep")?.value ?? 0;
  if (criteria.some((v) => v.value < 0.35)) return { decision: "failed", reason: "criterion_unmet", verdicts };
  if (human) return { decision: "needs_human", reason: "human_path", verdicts };
  if (criteria.some((v) => v.value < 0.7)) return { decision: "needs_human", reason: "criterion_uncertain", verdicts };
  if (scope >= 0.7) return { decision: "needs_human", reason: "scope_creep", verdicts };
  return { decision: "land", reason: null, verdicts };
}
