// Jev questions (PLAN.md §9): duplicate and conflict screening at begin, the evidence gate after
// verify. Hard checks run in code first; agent text is untrusted state and never decides alone.
import { noul, score, TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import { matchesAny } from "../shared/policy";
import type { Policy, TestSummary, Warning } from "../shared/types";
import type { Screen } from "./ledger/ledger";
import { topSimilar } from "./ledger/similar";

export const MODEL = "jev-1.13.0";

export type Answer = { type: "noul"; noul: number } | { type: "score"; score: number; confidence: number };
export type Asked = { answers: Record<string, Answer>; source: "live" | "recorded" | "neutral" | "off" };

type Fixture = { state: unknown; questions: Questions; answers: Record<string, Answer> };
const FIXTURES = Object.values(import.meta.glob<Fixture>("../../test/fixtures/jev/*.json", { eager: true, import: "default" }));

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

export async function fixtureKey(state: unknown, questions: Questions): Promise<string> {
  const bytes = new TextEncoder().encode(stable({ state, questions }));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const fixtures = new Map<string, Record<string, Answer>>();
async function recorded(key: string): Promise<Record<string, Answer> | undefined> {
  if (fixtures.size === 0) for (const f of FIXTURES) fixtures.set(await fixtureKey(f.state, f.questions), f.answers);
  return fixtures.get(key);
}

// "I don't know": the gate escalates such answers to a human instead of guessing.
function neutral(questions: Questions): Record<string, Answer> {
  return Object.fromEntries(
    Object.entries(questions).map(([k, q]) => [
      k,
      q.type === "score" ? { type: "score" as const, score: (q.criteria.length - 1) / 2, confidence: 0 } : { type: "noul" as const, noul: 0.5 },
    ]),
  );
}

export async function ask(env: Env, state: Record<string, unknown>, questions: Questions): Promise<Asked> {
  if (env.RYKE_JEV === "off") return { answers: neutral(questions), source: "off" };
  if (env.RYKE_JEV === "live" && env.TYPESAFE_API_KEY) {
    try {
      const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY, defaultModel: MODEL, timeout: 3000 });
      const res = await client.systemOne({ model: MODEL, state: state as never, questions });
      return { answers: res.answers as unknown as Record<string, Answer>, source: "live" };
    } catch (e) {
      console.warn(`jev live call failed, answering neutral: ${(e as Error).message}`);
      return { answers: neutral(questions), source: "neutral" };
    }
  }
  const key = await fixtureKey(state, questions);
  const hit = await recorded(key);
  if (hit) return { answers: hit, source: "recorded" };
  console.warn(`jev fixture ${key} missing, answering neutral; request: ${stable({ state, questions })}`);
  return { answers: neutral(questions), source: "neutral" };
}

const noulOf = (a: Answer | undefined) => (a?.type === "noul" ? a.noul : 0.5);
const scoreOf = (a: Answer | undefined) => (a?.type === "score" ? a : { score: 1, confidence: 0 });

// ---------------------------------------------------------------- §7.3 screening at begin

const CONFLICT_LEVELS = [
  "Independent: they change different code and different behaviour",
  "Overlapping but compatible: they touch the same code and both can be satisfied together",
  "Conflicting: completing one breaks, undoes or contradicts what the other requires",
] as const;

export function screenQuestions(intent: string, candidates: { id: string; intent: string }[]) {
  const state: Record<string, string> = { new_intent: intent };
  const questions: Questions = {};
  candidates.forEach((c, i) => {
    const k = `existing_${i + 1}`;
    state[k] = c.intent;
    questions[`dup_${i + 1}`] = noul(`Would completing \`new_intent\` produce essentially the same change to the codebase as completing \`${k}\`?`, {
      true: "Both intents ask for the same feature, fix or refactor, even if worded differently",
      false: "They ask for different features, fixes or refactors, even if they touch the same area",
    });
    questions[`conflict_${i + 1}_ab`] = score(`How do \`new_intent\` and \`${k}\` interact if two agents implement them at the same time on the same codebase?`, CONFLICT_LEVELS);
    questions[`conflict_${i + 1}_ba`] = score(`How do \`${k}\` and \`new_intent\` interact if two agents implement them at the same time on the same codebase?`, CONFLICT_LEVELS);
  });
  return { state, questions };
}

export async function screenIntent(env: Env, intent: string, live: { id: string; intent: string; footprint: string[] }[]): Promise<Screen> {
  const candidates = topSimilar(intent, live);
  if (candidates.length === 0) return { warnings: [] };
  const { state, questions } = screenQuestions(intent, candidates);
  const { answers } = await ask(env, state, questions);
  const warnings: Warning[] = [];
  let reject: Screen["reject"];
  candidates.forEach((c, i) => {
    const footprint = live.find((l) => l.id === c.id)?.footprint ?? [];
    const dup = noulOf(answers[`dup_${i + 1}`]);
    const ab = scoreOf(answers[`conflict_${i + 1}_ab`]);
    const ba = scoreOf(answers[`conflict_${i + 1}_ba`]);
    const conflict = (ab.score + ba.score) / 2;
    const confidence = (ab.confidence + ba.confidence) / 2;
    if (dup >= 0.8 && (!reject || dup > reject.value)) reject = { other: c.id, value: dup };
    if (dup >= 0.35) warnings.push({ kind: "duplicate", other: c.id, intent: c.intent, footprint, value: dup });
    if (conflict >= 1.5 || confidence < 0.3) warnings.push({ kind: "conflict", other: c.id, intent: c.intent, footprint, score: conflict, confidence });
  });
  return reject ? { reject, warnings } : { warnings };
}

// ---------------------------------------------------------------- §9.3 evidence gate

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
    questions[`criterion_${i + 1}`] = noul(`Does the evidence show that \`criterion_${i + 1}\` is met?`);
  });
  questions.scope_creep = noul("Does `diff_stat` show changes outside what `intent` needs?");
  return { state, questions };
}

export async function evidenceGate(env: Env, g: GateInput, policy: Policy): Promise<GateResult> {
  if (g.verify.exitCode !== 0 || !g.verify.pass) return { decision: "failed", reason: "verify_failed", verdicts: [] };
  if (g.verify.tests.failed > 0) return { decision: "failed", reason: "tests_failed", verdicts: [] };
  if (g.tamper) return { decision: "failed", reason: "test_tamper", verdicts: [] };
  if (g.approved) return { decision: "land", reason: "approved", verdicts: [] };
  const human = g.writes.some((w) => matchesAny(policy.human, w));
  const { state, questions } = evidenceQuestions(g);
  const { answers, source } = await ask(env, state, questions);
  if (source === "off") {
    return { decision: human ? "needs_human" : "land", reason: human ? "human_path" : null, verdicts: [{ question: "judge", value: 1, confidence: null, detail: "judge off: hard checks only" }] };
  }
  const verdicts: Verdict[] = Object.keys(questions).map((q) => ({ question: q, value: noulOf(answers[q]), confidence: null, detail: source }));
  const criteria = verdicts.filter((v) => v.question.startsWith("criterion_"));
  const scope = verdicts.find((v) => v.question === "scope_creep")!.value;
  if (criteria.some((v) => v.value < 0.35)) return { decision: "failed", reason: "criterion_unmet", verdicts };
  if (human) return { decision: "needs_human", reason: "human_path", verdicts };
  if (criteria.some((v) => v.value < 0.7)) return { decision: "needs_human", reason: "criterion_uncertain", verdicts };
  if (scope >= 0.7) return { decision: "needs_human", reason: "scope_creep", verdicts };
  return { decision: "land", reason: null, verdicts };
}
