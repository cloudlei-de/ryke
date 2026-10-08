// Jev calls (PLAN.md §9): live, recorded fixtures, or off. Hard checks run in code first; agent text
// is untrusted state and never decides alone. Wording and thresholds live in judge-questions.ts.
import { TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import {
  gateDecision,
  hardChecks,
  evidenceQuestions,
  MODEL,
  screenDecision,
  screenQuestions,
  type Answer,
  type GateInput,
  type GateResult,
} from "../shared/judge-questions";
import { matchesAny } from "../shared/policy";
import type { Policy, Warning } from "../shared/types";
import type { Screen } from "./ledger/ledger";
import { topSimilar } from "./ledger/similar";

export type { GateInput, GateResult, Verdict } from "../shared/judge-questions";
export type Asked = { answers: Record<string, Answer>; source: "live" | "recorded" | "neutral" | "off" };

type Fixture = { state: unknown; questions: Questions; answers: Record<string, Answer> };
const FIXTURES = Object.values(
  import.meta.glob<Fixture>(["../../test/fixtures/jev/*.json", "!../../test/fixtures/jev/requests.json"], { eager: true, import: "default" }),
);

export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
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
export function neutral(questions: Questions): Record<string, Answer> {
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

// §7.3 screening at begin: trigram prefilter in code, then one Jev request for all candidates.
export async function screenIntent(env: Env, intent: string, live: { id: string; intent: string; footprint: string[] }[]): Promise<Screen> {
  const candidates = topSimilar(intent, live);
  if (candidates.length === 0) return { warnings: [] };
  const { state, questions } = screenQuestions(intent, candidates);
  const { answers } = await ask(env, state, questions);
  const warnings: Warning[] = [];
  let reject: Screen["reject"];
  candidates.forEach((c, i) => {
    const footprint = live.find((l) => l.id === c.id)?.footprint ?? [];
    const d = screenDecision(answers, i);
    if (d.reject && (!reject || d.dup > reject.value)) reject = { other: c.id, value: d.dup };
    if (d.warnDuplicate) warnings.push({ kind: "duplicate", other: c.id, intent: c.intent, footprint, value: d.dup });
    if (d.warnConflict) warnings.push({ kind: "conflict", other: c.id, intent: c.intent, footprint, score: d.conflict, confidence: d.confidence });
  });
  return reject ? { reject, warnings } : { warnings };
}

// §9.3 evidence gate for one transaction after its train verified.
export async function evidenceGate(env: Env, g: GateInput, policy: Policy): Promise<GateResult> {
  const hard = hardChecks(g);
  if (hard) return hard;
  if (env.RYKE_JEV === "off") {
    const human = g.writes.some((w) => matchesAny(policy.human, w));
    return {
      decision: human ? "needs_human" : "land",
      reason: human ? "human_path" : null,
      verdicts: [{ question: "judge", value: 1, confidence: null, detail: "judge off: hard checks only" }],
    };
  }
  const { state, questions } = evidenceQuestions(g);
  const { answers, source } = await ask(env, state, questions);
  return gateDecision(g, policy, answers, questions, source);
}
