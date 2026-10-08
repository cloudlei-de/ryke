import { describe, expect, it } from "vitest";
import { fold } from "../src/shared/reducers";
import {
  buildSelector,
  candidates,
  describeSelector,
  flowStep,
  initialFlow,
  parseDryRun,
  parseExecuted,
  parseJson,
  outcomeRows,
  parsePlan,
  parseTxnIds,
  planRows,
  planSentence,
  requestProblem,
  selectorKey,
  summarizeOutcome,
  wrapTarget,
  type Flow,
  type FlowEvent,
  type Outcome,
  type Plan,
  type Selector,
} from "../src/web/views/recall/plan";
import { commitToFork, http, landAlone, newRepo, ok, opsOf, type TestRepo } from "./helpers";

const plan = (targets: string[], dependents: string[] = [], order = [...targets].reverse()): Plan => ({ targets, dependents, order });
const outcome = (over: Partial<Outcome> = {}): Outcome => ({ id: "rc_1", outcome: "pass", head: null, plan: plan(["t_a"]), cascade: [], requeued: [], failures: [], ...over });

describe("recall dialog: what the op log offers", () => {
  const t = (agent: string, model: string | null, state: string) => ({ agent, model, state: state as never });

  it.each([
    ["no transactions", [], { agents: [], models: [], landed: 0 }],
    ["only landed transactions count", [t("a1", "m1", "open"), t("a1", "m1", "recalled"), t("a2", "m2", "stale"), t("a3", "m3", "failed")], { agents: [], models: [], landed: 0 }],
    [
      "counts per agent and per model, sorted by name",
      [t("agent-02", "sloppy-v0", "landed"), t("agent-01", "m-b", "landed"), t("agent-02", "m-b", "landed"), t("agent-03", "sloppy-v0", "landed")],
      {
        agents: [
          { value: "agent-01", count: 1 },
          { value: "agent-02", count: 2 },
          { value: "agent-03", count: 1 },
        ],
        models: [
          { value: "m-b", count: 2 },
          { value: "sloppy-v0", count: 2 },
        ],
        landed: 4,
      },
    ],
    ["a landed transaction without a model has an agent but no model to select by", [t("a1", null, "landed")], { agents: [{ value: "a1", count: 1 }], models: [], landed: 1 }],
    ["an empty model string is not a model either", [t("a1", "", "landed")], { agents: [{ value: "a1", count: 1 }], models: [], landed: 1 }],
  ])("candidates: %s", (_name, txns, want) => {
    expect(candidates(txns)).toEqual(want);
  });

  it.each([
    ["empty", "", [], []],
    ["blank", "  \n\t ", [], []],
    ["one id", "t_mq3f0k1a", ["t_mq3f0k1a"], []],
    ["spaces, commas, semicolons and newlines separate ids", "t_a1 t_b2,t_c3;t_d4\nt_e5", ["t_a1", "t_b2", "t_c3", "t_d4", "t_e5"], []],
    ["a repeated id is kept once", "t_a1 t_a1, t_a1", ["t_a1"], []],
    ["anything that is not an id is reported, not sent", "t_a1 abc T_X t_ \"t_b2\"", ["t_a1"], ["abc", "T_X", "t_", "\"t_b2\""]],
    ["a repeated bad token is reported once", "x x", [], ["x"]],
  ])("parseTxnIds: %s", (_name, text, ids, bad) => {
    expect(parseTxnIds(text)).toEqual({ ids, bad });
  });

  it.each([
    ["model", "model", "sloppy-v0", "", { model: "sloppy-v0" }],
    ["agent", "agent", "agent-03", "ignored", { agent: "agent-03" }],
    ["nothing picked (model)", "model", "", "", null],
    ["nothing picked (agent)", "agent", "", "t_a1", null],
    ["pasted ids", "txns", "ignored", "t_a1, t_b2", { txns: ["t_a1", "t_b2"] }],
    ["no ids pasted", "txns", "", "", null],
    ["one bad id blocks the whole paste", "txns", "", "t_a1 oops", null],
  ] as const)("buildSelector: %s", (_name, kind, pick, pasted, want) => {
    expect(buildSelector(kind, pick, pasted)).toEqual(want);
  });

  it("keys a selector by its content, and describes it", () => {
    const sel: Selector[] = [{ agent: "a" }, { model: "a" }, { txns: ["t_a"] }];
    expect(new Set(sel.map(selectorKey)).size).toBe(3);
    expect(selectorKey({ model: "m" })).toBe(selectorKey({ model: "m" }));
    expect(selectorKey(null)).toBe("");
    expect(describeSelector({ model: "sloppy-v0" })).toBe("model = sloppy-v0");
    expect(describeSelector({ agent: "agent-03" })).toBe("agent = agent-03");
    expect(describeSelector({ txns: ["t_a", "t_b"] })).toBe("txns = t_a, t_b");
    expect(describeSelector({ txns: Array.from({ length: 12 }, (_, i) => `t_abcdef${i}`) }).length).toBeLessThanOrEqual("txns = ".length + 48);
  });
});

describe("recall dialog: reading the API's answers", () => {
  it.each([
    ["a valid plan", { targets: ["t_a"], dependents: ["t_b"], order: ["t_a"] }, plan(["t_a"], ["t_b"])],
    ["an empty plan", { targets: [], dependents: [], order: [] }, plan([])],
    ["extra fields are ignored", { targets: ["t_a"], dependents: [], order: ["t_a"], cascadeCandidates: {} }, plan(["t_a"])],
    ["a missing list", { targets: ["t_a"], dependents: [] }, null],
    ["a list of non-strings", { targets: [1], dependents: [], order: [] }, null],
    ["not an object", "plan", null],
    ["an array", [], null],
    ["null", null, null],
  ])("parsePlan: %s", (_name, body, want) => {
    expect(parsePlan(body)).toEqual(want);
  });

  it.each([
    ["a dry-run answer", { dryRun: true, plan: { targets: ["t_a"], dependents: [], order: ["t_a"] } }, plan(["t_a"])],
    ["an execute answer is not a plan", { dryRun: false, plan: { targets: ["t_a"], dependents: [], order: ["t_a"] } }, null],
    ["no dryRun flag", { plan: { targets: [], dependents: [], order: [] } }, null],
    ["no plan", { dryRun: true }, null],
    ["not JSON", parseJson("<html>"), null],
  ])("parseDryRun: %s", (_name, body, want) => {
    expect(parseDryRun(body)).toEqual(want);
  });

  it("parseJson returns null for text that is not JSON", () => {
    expect(parseJson("{")).toBeNull();
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  const secret = "art_v1_SECRET";
  const executed = {
    dryRun: false,
    recall: "rc_9",
    plan: { targets: ["t_a"], dependents: ["t_b", "t_c"], order: ["t_a"] },
    outcome: "pass",
    head: "0123456789abcdef",
    cascade: ["t_b"],
    requeued: [{ from: "t_b", txn: "t_n", remote: "http://x", token: secret, trunk: { remote: "http://y", token: secret }, snapshot: "abc" }],
    failures: [],
  };

  it("parseExecuted keeps only the ids of re-queued work, never the fork credentials", () => {
    const o = parseExecuted(executed)!;
    expect(o).toEqual({
      id: "rc_9",
      outcome: "pass",
      head: "0123456789abcdef",
      plan: plan(["t_a"], ["t_b", "t_c"]),
      cascade: ["t_b"],
      requeued: [{ from: "t_b", txn: "t_n" }],
      failures: [],
    });
    expect(JSON.stringify(o)).not.toContain(secret);
  });

  it.each([
    ["a bare failure outcome", { dryRun: false, outcome: "verify_failed" }, outcome({ id: null, outcome: "verify_failed", plan: null })],
    [
      "failures as objects, and as bare strings",
      { dryRun: false, outcome: "verify_failed", failures: [{ name: "convert length", message: "expected 1 got 2" }, "bare", { name: "no message" }, { message: "no name" }, 7] },
      outcome({
        id: null,
        outcome: "verify_failed",
        plan: null,
        failures: [
          { name: "convert length", message: "expected 1 got 2" },
          { name: "bare", message: "" },
          { name: "no message", message: "" },
        ],
      }),
    ],
    ["re-queued entries without both ids are dropped", { outcome: "pass", requeued: [{ from: "t_a" }, { txn: "t_b" }, null, "x"] }, outcome({ id: null, plan: null })],
    ["lists of the wrong type are empty", { outcome: "pass", cascade: "t_a", requeued: 1, failures: {} }, outcome({ id: null, plan: null })],
  ])("parseExecuted: %s", (_name, body, want) => {
    expect(parseExecuted(body)).toEqual(want);
  });

  it.each([
    ["a dry-run answer", { dryRun: true, plan: { targets: [], dependents: [], order: [] } }],
    ["no outcome", { dryRun: false }],
    ["an outcome that is not text", { outcome: 1 }],
    ["not an object", "pass"],
    ["null", null],
  ])("parseExecuted rejects %s", (_name, body) => {
    expect(parseExecuted(body)).toBeNull();
  });

  it.each([
    [401, "", true, "The admin token was rejected. Enter it again."],
    [401, '{"error":"unauthorized"}', true, "The admin token was rejected. Enter it again."],
    [409, '{"error":"a train is still landing; try again"}', false, "a train is still landing; try again (HTTP 409)"],
    [422, '{"error":"the selector matches no landed transaction"}', false, "the selector matches no landed transaction (HTTP 422)"],
    [503, "upstream down", false, "The platform answered HTTP 503."],
    [500, "", false, "The platform answered HTTP 500."],
    [422, '{"error":""}', false, "The platform answered HTTP 422."],
    [422, '{"error":7}', false, "The platform answered HTTP 422."],
  ])("requestProblem(%i, %j)", (status, body, needsToken, text) => {
    expect(requestProblem(status, body)).toEqual({ text, needsToken });
  });

  it("clips a very long server message", () => {
    const p = requestProblem(500, JSON.stringify({ error: "x".repeat(500) }));
    expect(p.text.length).toBe(200);
    expect(p.text.endsWith("…")).toBe(true);
  });
});

describe("recall dialog: the plan, shown", () => {
  const known = (id: string, seq: number, agent = "agent-01", model: string | null = "m", intent = `intent ${id}`) =>
    [id, { agent, model, intent, sha: `${id}0123456789`, landedSeq: seq }] as const;

  it("lists targets numbered in revert order with dependents between them where they landed, newest first", () => {
    const txns = new Map([known("t_a", 3, "agent-13", "sloppy-v0"), known("t_b", 4), known("t_c", 6, "agent-13", "sloppy-v0"), known("t_d", 8)]);
    const rows = planRows(plan(["t_a", "t_c"], ["t_b", "t_d"]), txns);
    expect(rows.map((r) => [r.id, r.role, r.order, r.seq])).toEqual([
      ["t_d", "dependent", null, 8],
      ["t_c", "target", 1, 6],
      ["t_b", "dependent", null, 4],
      ["t_a", "target", 2, 3],
    ]);
    expect(rows[1]).toMatchObject({ agent: "agent-13", model: "sloppy-v0", intent: "intent t_c", sha: "t_c01234" });
  });

  it("keeps the plan's order, targets first, when a transaction is not known to this page", () => {
    const txns = new Map([known("t_a", 3), known("t_c", 6)]);
    const rows = planRows(plan(["t_a", "t_c"], ["t_b", "t_d"]), txns);
    expect(rows.map((r) => r.id)).toEqual(["t_c", "t_a", "t_d", "t_b"]);
    expect(rows.find((r) => r.id === "t_b")).toMatchObject({ seq: null, sha: "", agent: null, model: null, intent: null });
  });

  it("numbers by the plan's own revert order, not by landing time", () => {
    const rows = planRows({ targets: ["t_a", "t_c"], dependents: [], order: ["t_a", "t_c"] }, new Map([known("t_a", 3), known("t_c", 6)]));
    expect(rows.map((r) => [r.id, r.order])).toEqual([
      ["t_c", 2],
      ["t_a", 1],
    ]);
  });

  it("still lists a target the order leaves out, unnumbered", () => {
    const rows = planRows({ targets: ["t_a", "t_c"], dependents: [], order: ["t_c"] }, new Map());
    expect(rows.map((r) => [r.id, r.order])).toEqual([
      ["t_c", 1],
      ["t_a", null],
    ]);
  });

  it("an empty plan has no rows", () => {
    expect(planRows(plan([]), new Map())).toEqual([]);
  });

  it("marks what happened to each row: targets recalled, cascaded dependents re-queued, the rest stayed", () => {
    const txns = new Map([known("t_a", 3), known("t_b", 4), known("t_c", 6), known("t_d", 8)]);
    const o = outcome({ plan: plan(["t_a"], ["t_b", "t_c", "t_d"]), cascade: ["t_c"], requeued: [{ from: "t_c", txn: "t_n" }] });
    expect(outcomeRows(o, txns).map((r) => [r.id, r.role, r.fate, r.requeuedAs])).toEqual([
      ["t_d", "dependent", "stayed", null],
      ["t_c", "dependent", "cascaded", "t_n"],
      ["t_b", "dependent", "stayed", null],
      ["t_a", "target", "recalled", null],
    ]);
  });

  it("a cascaded dependent whose re-queue failed has no new id", () => {
    const txns = new Map([known("t_a", 3), known("t_b", 4)]);
    const rows = outcomeRows(outcome({ plan: plan(["t_a"], ["t_b"]), cascade: ["t_b"] }), txns);
    expect(rows.map((r) => [r.id, r.fate, r.requeuedAs])).toEqual([
      ["t_b", "cascaded", null],
      ["t_a", "recalled", null],
    ]);
  });

  it("without a plan in the answer, lists the cascade alone", () => {
    const rows = outcomeRows(outcome({ plan: null, cascade: ["t_x"], requeued: [{ from: "t_x", txn: "t_y" }] }), new Map());
    expect(rows.map((r) => [r.id, r.fate, r.requeuedAs])).toEqual([["t_x", "cascaded", "t_y"]]);
  });

  it.each([
    [plan([]), "No landed transaction matches this selector, so there is nothing to revert."],
    [plan(["t_a"]), "Reverting 1 transaction; nothing that landed later depends on it."],
    [plan(["t_a", "t_b"]), "Reverting 2 transactions; nothing that landed later depends on them."],
    [plan(["t_a"], ["t_x"]), "Reverting 1 transaction; 1 dependent will be revalidated; if its revert conflicts it is recalled too and re-queued."],
    [plan(["t_a", "t_b"], ["t_x", "t_y", "t_z"]), "Reverting 2 transactions; 3 dependents will be revalidated; any whose revert conflicts are recalled too and re-queued."],
  ])("planSentence %#", (p, want) => {
    expect(planSentence(p)).toBe(want);
  });
});

describe("recall dialog: the outcome, in words", () => {
  it.each([
    [
      "targets only, nothing depended on them",
      outcome({ plan: plan(["t_a", "t_b"]) }),
      { tone: "go", headline: "Recalled 2 transactions", detail: "Nothing that landed later depended on them." },
    ],
    ["one target, nothing depended on it", outcome(), { tone: "go", headline: "Recalled 1 transaction", detail: "Nothing that landed later depended on it." }],
    [
      "dependents that stayed",
      outcome({ plan: plan(["t_a"], ["t_b", "t_c"]) }),
      { tone: "go", headline: "Recalled 1 transaction", detail: "2 dependents stayed landed after revalidation." },
    ],
    [
      "one cascaded and re-queued, one stayed",
      outcome({ plan: plan(["t_a"], ["t_b", "t_c"]), cascade: ["t_b"], requeued: [{ from: "t_b", txn: "t_n" }] }),
      { tone: "go", headline: "Recalled 1 transaction", detail: "1 dependent cascaded and was re-queued as a new transaction; 1 dependent stayed landed after revalidation." },
    ],
    [
      "every dependent cascaded",
      outcome({ plan: plan(["t_a"], ["t_b", "t_c"]), cascade: ["t_b", "t_c"] }),
      { tone: "go", headline: "Recalled 1 transaction", detail: "2 dependents cascaded and were re-queued as new transactions." },
    ],
    ["a pass without a plan summary", outcome({ plan: null, cascade: ["t_b"] }), { tone: "go", headline: "Recalled", detail: "1 dependent cascaded and was re-queued as a new transaction." }],
    ["a conflict", outcome({ outcome: "conflict" }), { tone: "stop", headline: "Recall did not land", detail: "A revert conflicted and no later dependent explains the conflict. Nothing was pushed." }],
    [
      "failing tests",
      outcome({ outcome: "verify_failed" }),
      { tone: "stop", headline: "Recall did not land", detail: "The tests failed on the reverted trunk, even with every dependent recalled too. Nothing was pushed." },
    ],
    ["a rejected push", outcome({ outcome: "cas_rejected" }), { tone: "stop", headline: "Recall did not land", detail: "Trunk moved while the recall was landing. Nothing was pushed; plan again." }],
    ["reverts that change nothing", outcome({ outcome: "prepared" }), { tone: "stop", headline: "Recall did not land", detail: "The reverts changed nothing on trunk. Nothing was pushed." }],
    ["an outcome it does not know", outcome({ outcome: "weird" }), { tone: "stop", headline: "Recall did not land", detail: 'The recall ended with "weird".' }],
  ])("summarizeOutcome: %s", (_name, o, want) => {
    expect(summarizeOutcome(o)).toEqual(want);
  });
});

describe("recall dialog: the flow", () => {
  const sel: Selector = { model: "sloppy-v0" };
  const other: Selector = { agent: "agent-01" };
  const p = plan(["t_a"], ["t_b"]);
  const flows: Record<string, Flow> = {
    pick: initialFlow,
    pickError: { phase: "pick", error: "boom" },
    planning: { phase: "planning", selector: sel, error: null },
    planned: { phase: "planned", selector: sel, plan: p, error: null },
    plannedEmpty: { phase: "planned", selector: sel, plan: plan([]), error: null },
    executing: { phase: "executing", selector: sel, plan: p, error: null },
    done: { phase: "done", outcome: outcome(), error: null },
  };
  const run = (flow: keyof typeof flows, ev: FlowEvent): Flow => flowStep(flows[flow]!, ev);

  it.each<[string, keyof typeof flows, FlowEvent, Flow]>([
    // plan
    ["plan from pick", "pick", { type: "plan", selector: sel }, flows.planning!],
    ["plan clears an old error", "pickError", { type: "plan", selector: sel }, flows.planning!],
    ["plan again from a plan", "planned", { type: "plan", selector: other }, { phase: "planning", selector: other, error: null }],
    ["plan again after an outcome", "done", { type: "plan", selector: sel }, flows.planning!],
    ["plan is ignored while planning", "planning", { type: "plan", selector: other }, flows.planning!],
    ["plan is ignored while executing", "executing", { type: "plan", selector: other }, flows.executing!],
    // planned
    ["the answer for the selector in flight", "planning", { type: "planned", selector: sel, plan: p }, flows.planned!],
    ["an answer for a selector since left is dropped", "planning", { type: "planned", selector: other, plan: p }, flows.planning!],
    ["an answer that arrives after the user moved on is dropped", "pick", { type: "planned", selector: sel, plan: p }, flows.pick!],
    ["an answer while a plan is already shown is dropped", "planned", { type: "planned", selector: sel, plan: plan(["t_z"]) }, flows.planned!],
    // execute
    ["execute from a plan", "planned", { type: "execute" }, flows.executing!],
    ["execute is refused for an empty plan", "plannedEmpty", { type: "execute" }, flows.plannedEmpty!],
    ["execute is refused without a plan", "pick", { type: "execute" }, flows.pick!],
    ["execute is refused while planning", "planning", { type: "execute" }, flows.planning!],
    ["execute is refused twice", "executing", { type: "execute" }, flows.executing!],
    ["execute is refused after an outcome", "done", { type: "execute" }, flows.done!],
    // executed
    ["outcome while executing", "executing", { type: "executed", outcome: outcome() }, flows.done!],
    ["outcome without an execute is dropped", "planned", { type: "executed", outcome: outcome() }, flows.planned!],
    ["outcome from pick is dropped", "pick", { type: "executed", outcome: outcome() }, flows.pick!],
    // failed
    ["a failed plan goes back to pick with the reason", "planning", { type: "failed", text: "nope" }, { phase: "pick", error: "nope" }],
    ["a failed execute keeps the plan so it can be tried again", "executing", { type: "failed", text: "train" }, { phase: "planned", selector: sel, plan: p, error: "train" }],
    ["a failure with nothing in flight changes nothing", "planned", { type: "failed", text: "late" }, flows.planned!],
    ["a failure after an outcome changes nothing", "done", { type: "failed", text: "late" }, flows.done!],
    ["a failure at pick changes nothing", "pick", { type: "failed", text: "late" }, flows.pick!],
    // select
    ["choosing the same selector keeps the plan", "planned", { type: "select", selector: sel }, flows.planned!],
    ["choosing another selector drops the plan", "planned", { type: "select", selector: other }, flows.pick!],
    ["clearing the selector drops the plan", "planned", { type: "select", selector: null }, flows.pick!],
    ["choosing another selector abandons the plan in flight", "planning", { type: "select", selector: other }, flows.pick!],
    ["choosing the same selector keeps the plan in flight", "planning", { type: "select", selector: sel }, flows.planning!],
    ["choosing during an execute is ignored", "executing", { type: "select", selector: other }, flows.executing!],
    ["choosing after an outcome clears it", "done", { type: "select", selector: other }, flows.pick!],
    ["choosing clears an error", "pickError", { type: "select", selector: sel }, flows.pick!],
  ])("%s", (_name, from, ev, want) => {
    expect(run(from, ev)).toEqual(want);
  });

  it("walks the whole path pick -> planning -> planned -> executing -> done", () => {
    let f = initialFlow;
    for (const ev of [{ type: "plan", selector: sel }, { type: "planned", selector: sel, plan: p }, { type: "execute" }, { type: "executed", outcome: outcome() }] as FlowEvent[]) f = flowStep(f, ev);
    expect(f).toEqual(flows.done);
  });
});

describe("recall dialog: the focus trap", () => {
  it.each([
    ["nothing to focus", 0, 0, false, null],
    ["nothing to focus, backwards", 0, -1, true, null],
    ["focus outside, forwards: enter at the first", 4, -1, false, 0],
    ["focus outside, backwards: enter at the last", 4, -1, true, 3],
    ["last control, forwards: wrap to the first", 4, 3, false, 0],
    ["first control, backwards: wrap to the last", 4, 0, true, 3],
    ["a middle control, forwards: browser moves on", 4, 1, false, null],
    ["a middle control, backwards: browser moves on", 4, 2, true, null],
    ["first control, forwards: browser moves on", 4, 0, false, null],
    ["last control, backwards: browser moves on", 4, 3, true, null],
    ["a single control, forwards: stays", 1, 0, false, 0],
    ["a single control, backwards: stays", 1, 0, true, 0],
  ])("wrapTarget: %s", (_name, count, index, backwards, want) => {
    expect(wrapTarget(count, index, backwards)).toBe(want);
  });
});

// The dialog is only as good as its agreement with the server, so these run the real route and the real
// op log through the same helpers the component uses.
describe("recall dialog against the platform", () => {
  async function landChange(t: TestRepo, agent: string, model: string, reads: string[], files: Record<string, string | null>) {
    const b = ok(await t.L.begin({ agent, model, intent: `${agent} changes ${Object.keys(files).join(" ")}` }));
    if (reads.length) ok(await t.L.reads(b.txn, reads));
    const sha = await commitToFork(b, files);
    ok(await t.L.submit(b.txn, { head: sha }));
    await landAlone(t, b.txn, b, sha, Object.keys(files));
    return b.txn;
  }

  it("offers what the op log knows, plans over HTTP, executes, and reads every answer", { timeout: 180_000 }, async () => {
    const t = await newRepo();
    const target = await landChange(t, "agent-13", "sloppy-v0", ["src/a.ts"], { "src/a.ts": "export const a = 5;\n" });
    const clean = await landChange(t, "agent-01", "m-clean", ["src/a.ts"], { "src/r.ts": "export const r = 1;\n" });
    const conflicting = await landChange(t, "agent-02", "m-conflict", ["src/a.ts"], { "src/a.ts": "export const a = 5;\nexport const a2 = 6;\n" });

    const state = fold(await opsOf(t));
    expect(candidates(state.txns.values())).toEqual({
      agents: [
        { value: "agent-01", count: 1 },
        { value: "agent-02", count: 1 },
        { value: "agent-13", count: 1 },
      ],
      models: [
        { value: "m-clean", count: 1 },
        { value: "m-conflict", count: 1 },
        { value: "sloppy-v0", count: 1 },
      ],
      landed: 3,
    });

    const path = `/api/repos/${t.name}/recall`;
    const selector = buildSelector("model", "sloppy-v0", "")!;

    const unauth = await http("POST", path, { body: { selector, dryRun: true }, auth: false });
    expect(requestProblem(unauth.status, unauth.text)).toEqual({ text: "The admin token was rejected. Enter it again.", needsToken: true });

    const dry = await http("POST", path, { body: { selector, dryRun: true } });
    const planned = parseDryRun(parseJson(dry.text))!;
    expect(planned).toEqual({ targets: [target], dependents: [clean, conflicting], order: [target] });
    const rows = planRows(planned, state.txns);
    expect(rows.map((r) => [r.id, r.role, r.order])).toEqual([
      [conflicting, "dependent", null],
      [clean, "dependent", null],
      [target, "target", 1],
    ]);
    expect(rows[2]).toMatchObject({ agent: "agent-13", model: "sloppy-v0" });
    expect(planSentence(planned)).toBe("Reverting 1 transaction; 2 dependents will be revalidated; any whose revert conflicts are recalled too and re-queued.");

    const nothing = await http("POST", path, { body: { selector: { model: "nobody" }, dryRun: false } });
    expect(requestProblem(nothing.status, nothing.text)).toEqual({ text: "the selector matches no landed transaction (HTTP 422)", needsToken: false });
    const stray = await http("POST", path, { body: { selector: { txns: ["t_nope"] }, dryRun: true } });
    expect(requestProblem(stray.status, stray.text).text).toContain("(HTTP 422)");

    const run = await http("POST", path, { body: { selector, dryRun: false } });
    expect(run.text).toContain("art_v1_"); // the raw answer does carry fork credentials
    const done = parseExecuted(parseJson(run.text))!;
    expect(done).toMatchObject({ outcome: "pass", cascade: [conflicting], plan: planned });
    expect(done.requeued).toHaveLength(1);
    expect(done.requeued[0]).toEqual({ from: conflicting, txn: expect.stringMatching(/^t_/) });
    expect(JSON.stringify(done)).not.toContain("art_v1_");
    expect(outcomeRows(done, state.txns).map((r) => [r.id, r.fate])).toEqual([
      [conflicting, "cascaded"],
      [clean, "stayed"],
      [target, "recalled"],
    ]);
    expect(summarizeOutcome(done)).toEqual({
      tone: "go",
      headline: "Recalled 1 transaction",
      detail: "1 dependent cascaded and was re-queued as a new transaction; 1 dependent stayed landed after revalidation.",
    });

    // The recall ops fold into a state in which the recalled transactions are no longer on offer.
    const after = candidates(fold(await opsOf(t)).txns.values());
    expect(after.models).toEqual([{ value: "m-clean", count: 1 }]);
  });
});
