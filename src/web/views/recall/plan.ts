// Pure helpers behind the Recall dialog (PLAN.md §8 and §12 view 4): what the op log offers to recall,
// what the plan and the outcome say, and the dialog's own state machine. The component only renders these.
import type { TxnView } from "../../../shared/reducers";
import { clipText, shortSha } from "../line/geometry";

export type SelectorKind = "agent" | "model" | "txns";
export type Selector = { agent: string } | { model: string } | { txns: string[] };
export type Candidate = { value: string; count: number };
export type Plan = { targets: string[]; dependents: string[]; order: string[] };
export type Outcome = {
  id: string | null;
  outcome: string;
  head: string | null;
  plan: Plan | null;
  cascade: string[];
  requeued: { from: string; txn: string }[];
  failures: { name: string; message: string }[];
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- what can be recalled

// Only landed transactions can be recalled (the server plans from the same set), so the dialog offers
// the agents and models of exactly those. A transaction without a model has nothing to select by.
export function candidates(txns: Iterable<Pick<TxnView, "agent" | "model" | "state">>): { agents: Candidate[]; models: Candidate[]; landed: number } {
  const agents = new Map<string, number>();
  const models = new Map<string, number>();
  let landed = 0;
  for (const t of txns) {
    if (t.state !== "landed") continue;
    landed++;
    agents.set(t.agent, (agents.get(t.agent) ?? 0) + 1);
    if (t.model) models.set(t.model, (models.get(t.model) ?? 0) + 1);
  }
  const list = (m: Map<string, number>): Candidate[] => [...m].map(([value, n]) => ({ value, count: n })).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return { agents: list(agents), models: list(models), landed };
}

// Ids come from the ledger's newId ("t_" + base 36), so anything else pasted in is a typo to flag, not to send.
const TXN_ID = /^t_[0-9a-z]+$/;

export function parseTxnIds(text: string): { ids: string[]; bad: string[] } {
  const ids: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    if (raw === "") continue;
    const into = TXN_ID.test(raw) ? ids : bad;
    if (!into.includes(raw)) into.push(raw);
  }
  return { ids, bad };
}

// null while the choice is incomplete: nothing picked, no ids, or an id that cannot be one.
export function buildSelector(kind: SelectorKind, pick: string, pasted: string): Selector | null {
  if (kind === "txns") {
    const { ids, bad } = parseTxnIds(pasted);
    return ids.length > 0 && bad.length === 0 ? { txns: ids } : null;
  }
  if (pick === "") return null;
  return kind === "agent" ? { agent: pick } : { model: pick };
}

export const selectorKey = (s: Selector | null): string => (s ? JSON.stringify(s) : "");

export function describeSelector(s: Selector): string {
  if ("agent" in s) return `agent = ${s.agent}`;
  if ("model" in s) return `model = ${s.model}`;
  return `txns = ${clipText(s.txns.join(", "), 48)}`;
}

// ---------------------------------------------------------------- answers

function object(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parsePlan(v: unknown): Plan | null {
  const o = object(v);
  if (!o) return null;
  const targets = strings(o.targets);
  const dependents = strings(o.dependents);
  const order = strings(o.order);
  return targets && dependents && order ? { targets, dependents, order } : null;
}

export function parseDryRun(body: unknown): Plan | null {
  const o = object(body);
  return o && o.dryRun === true ? parsePlan(o.plan) : null;
}

// The execute answer also carries one-off credentials for each re-queued transaction's fork. Only the two
// ids the dashboard shows are copied out, so a token can never reach the page through this path.
export function parseExecuted(body: unknown): Outcome | null {
  const o = object(body);
  if (!o || o.dryRun === true || typeof o.outcome !== "string") return null;
  const requeued = Array.isArray(o.requeued)
    ? o.requeued.flatMap((q) => {
        const r = object(q);
        return r && typeof r.from === "string" && typeof r.txn === "string" ? [{ from: r.from, txn: r.txn }] : [];
      })
    : [];
  const failures = Array.isArray(o.failures)
    ? o.failures.flatMap((f) => {
        if (typeof f === "string") return [{ name: f, message: "" }];
        const r = object(f);
        return r && typeof r.name === "string" ? [{ name: r.name, message: typeof r.message === "string" ? r.message : "" }] : [];
      })
    : [];
  return {
    id: typeof o.recall === "string" ? o.recall : null,
    outcome: o.outcome,
    head: typeof o.head === "string" ? o.head : null,
    plan: parsePlan(o.plan),
    cascade: strings(o.cascade) ?? [],
    requeued,
    failures,
  };
}

// An HTTP failure in words. 401 means the stored token is wrong, so the dialog asks for it again.
export function requestProblem(status: number, body: string): { text: string; needsToken: boolean } {
  if (status === 401) return { text: "The admin token was rejected. Enter it again.", needsToken: true };
  const error = object(parseJson(body))?.error;
  const text = typeof error === "string" && error !== "" ? `${error} (HTTP ${status})` : `The platform answered HTTP ${status}.`;
  return { text: clipText(text, 200), needsToken: false };
}

// ---------------------------------------------------------------- the plan, as rows

export type PlanRow = {
  id: string;
  role: "target" | "dependent";
  // 1-based position in the revert order; dependents are not reverted unless a conflict drags them in.
  order: number | null;
  seq: number | null;
  sha: string;
  agent: string | null;
  model: string | null;
  intent: string | null;
};

type Known = Pick<TxnView, "agent" | "model" | "intent" | "sha" | "landedSeq">;

// Newest first, which is the revert order read top to bottom: targets numbered, dependents between them
// where they landed. A transaction this page never saw keeps the plan's own order instead of a guess.
export function planRows(plan: Plan, txns: ReadonlyMap<string, Known>): PlanRow[] {
  const targetIds = [...plan.order, ...plan.targets.filter((t) => !plan.order.includes(t))];
  const rows: PlanRow[] = [
    ...targetIds.map((id) => ({ id, role: "target" as const, order: plan.order.includes(id) ? plan.order.indexOf(id) + 1 : null })),
    ...[...plan.dependents].reverse().map((id) => ({ id, role: "dependent" as const, order: null })),
  ].map((r) => {
    const t = txns.get(r.id);
    return { ...r, seq: t?.landedSeq ?? null, sha: shortSha(t?.sha), agent: t?.agent ?? null, model: t?.model ?? null, intent: t?.intent ?? null };
  });
  if (rows.every((r) => r.seq !== null)) rows.sort((a, b) => b.seq! - a.seq!);
  return rows;
}

export type OutcomeRow = PlanRow & {
  // recalled: a target. cascaded: a dependent whose revert conflicted, so it went too. stayed: a dependent
  // that the revert left on trunk and the tests revalidated.
  fate: "recalled" | "cascaded" | "stayed";
  requeuedAs: string | null;
};

// The plan's rows again, now with what happened to each. Without a plan in the answer the cascade alone is
// listed, so a re-queued transaction never goes unmentioned.
export function outcomeRows(o: Outcome, txns: ReadonlyMap<string, Known>): OutcomeRow[] {
  const requeued = new Map(o.requeued.map((q) => [q.from, q.txn]));
  return planRows(o.plan ?? { targets: [], dependents: o.cascade, order: [] }, txns).map((r) => ({
    ...r,
    fate: r.role === "target" ? "recalled" : o.cascade.includes(r.id) ? "cascaded" : "stayed",
    requeuedAs: requeued.get(r.id) ?? null,
  }));
}

export function planSentence(plan: Plan): string {
  const n = plan.targets.length;
  const m = plan.dependents.length;
  if (n === 0) return "No landed transaction matches this selector, so there is nothing to revert.";
  const head = `Reverting ${count(n, "transaction")}`;
  if (m === 0) return `${head}; nothing that landed later depends on ${n === 1 ? "it" : "them"}.`;
  if (m === 1) return `${head}; 1 dependent will be revalidated; if its revert conflicts it is recalled too and re-queued.`;
  return `${head}; ${m} dependents will be revalidated; any whose revert conflicts are recalled too and re-queued.`;
}

// ---------------------------------------------------------------- the outcome, in words

// What each non-pass outcome of the Ledger's recall means for trunk. Only claims the code backs up:
// nothing is pushed unless the reverted trunk verified and the compare-and-swap push succeeded.
const NOT_LANDED: Record<string, string> = {
  conflict: "A revert conflicted and no later dependent explains the conflict. Nothing was pushed.",
  verify_failed: "The tests failed on the reverted trunk, even with every dependent recalled too. Nothing was pushed.",
  cas_rejected: "Trunk moved while the recall was landing. Nothing was pushed; plan again.",
  prepared: "The reverts changed nothing on trunk. Nothing was pushed.",
};

export function summarizeOutcome(o: Outcome): { tone: "go" | "stop"; headline: string; detail: string } {
  if (o.outcome !== "pass") {
    return { tone: "stop", headline: "Recall did not land", detail: NOT_LANDED[o.outcome] ?? `The recall ended with "${o.outcome}".` };
  }
  const n = o.plan?.targets.length ?? 0;
  const d = o.plan?.dependents.length ?? 0;
  const c = o.cascade.length;
  const parts: string[] = [];
  if (c > 0) parts.push(`${count(c, "dependent")} cascaded and ${c === 1 ? "was" : "were"} re-queued as ${c === 1 ? "a new transaction" : "new transactions"}`);
  if (d - c > 0) parts.push(`${count(d - c, "dependent")} stayed landed after revalidation`);
  if (parts.length === 0) parts.push(`nothing that landed later depended on ${n === 1 ? "it" : "them"}`);
  const detail = parts.join("; ");
  return { tone: "go", headline: n > 0 ? `Recalled ${count(n, "transaction")}` : "Recalled", detail: `${detail[0]!.toUpperCase()}${detail.slice(1)}.` };
}

// ---------------------------------------------------------------- the dialog's flow

// pick -> planning -> planned -> executing -> done. A plan belongs to the selector it was made for: change
// the selector and the plan is gone, so Execute can never run something other than what was shown.
export type Flow =
  | { phase: "pick"; error: string | null }
  | { phase: "planning"; selector: Selector; error: null }
  | { phase: "planned"; selector: Selector; plan: Plan; error: string | null }
  | { phase: "executing"; selector: Selector; plan: Plan; error: null }
  | { phase: "done"; outcome: Outcome; error: null };

export type FlowEvent =
  | { type: "select"; selector: Selector | null }
  | { type: "plan"; selector: Selector }
  | { type: "planned"; selector: Selector; plan: Plan }
  | { type: "execute" }
  | { type: "executed"; outcome: Outcome }
  | { type: "failed"; text: string };

export const initialFlow: Flow = { phase: "pick", error: null };

export function flowStep(flow: Flow, ev: FlowEvent): Flow {
  switch (ev.type) {
    case "select": {
      // Picking again while a plan is up drops it; during execution the controls are locked, so this is ignored.
      if (flow.phase === "executing") return flow;
      if ((flow.phase === "planned" || flow.phase === "planning") && selectorKey(flow.selector) === selectorKey(ev.selector)) return flow;
      return initialFlow;
    }
    case "plan":
      return flow.phase === "planning" || flow.phase === "executing" ? flow : { phase: "planning", selector: ev.selector, error: null };
    case "planned":
      // An answer for a selector the user has since left is dropped.
      return flow.phase === "planning" && selectorKey(flow.selector) === selectorKey(ev.selector) ? { phase: "planned", selector: ev.selector, plan: ev.plan, error: null } : flow;
    case "execute":
      return flow.phase === "planned" && flow.plan.targets.length > 0 ? { phase: "executing", selector: flow.selector, plan: flow.plan, error: null } : flow;
    case "executed":
      return flow.phase === "executing" ? { phase: "done", outcome: ev.outcome, error: null } : flow;
    case "failed":
      // A failed execute keeps its plan so the same Execute can be tried again (a train may just be landing).
      if (flow.phase === "executing") return { phase: "planned", selector: flow.selector, plan: flow.plan, error: ev.text };
      if (flow.phase === "planning") return { phase: "pick", error: ev.text };
      return flow;
  }
}

// ---------------------------------------------------------------- focus trap

// Tab inside a modal: the browser moves focus naturally except at the two ends, where it would leave the
// dialog. Returns the index to force focus to, or null to let the browser do it. `index` is -1 when focus
// is outside the dialog's controls (on the backdrop, say), which pulls it back in.
export function wrapTarget(count: number, index: number, backwards: boolean): number | null {
  if (count <= 0) return null;
  if (index < 0) return backwards ? count - 1 : 0;
  if (!backwards && index === count - 1) return 0;
  if (backwards && index === 0) return count - 1;
  return null;
}
