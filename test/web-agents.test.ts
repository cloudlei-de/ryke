// PLAN.md §0.10: the dashboard says which agents are simulated. Models the harness makes up are labelled
// wherever a model shows up: the Sidings header, the bar titles and the Recall dialog's model list.
import { describe, expect, it } from "vitest";
import { fold } from "../src/shared/reducers";
import type { Op, OpKind } from "../src/shared/types";
import { modelLabel, simulationOf, simulationTag } from "../src/web/agents";
import { layoutBar, type Scale } from "../src/web/views/line/geometry";
import { optionText } from "../src/web/views/recall/plan";

describe("simulationOf", () => {
  it.each([
    ["scripted-v1", "scripted"],
    ["sloppy-v0", "scripted"],
    ["claude-stub", "stub"],
    ["synthetic-v1", "synthetic"],
    ["claude-sonnet-5-5", null],
    ["jev-1.13.0", null],
    ["", null],
    [null, null],
    [undefined, null],
    // Plain-object keys that are not models.
    ["constructor", null],
    ["toString", null],
    ["__proto__", null],
  ])("%j is %j", (model, kind) => {
    expect(simulationOf(model)).toBe(kind);
  });
});

describe("modelLabel", () => {
  it.each([
    ["scripted-v1", "scripted-v1 (scripted)"],
    ["sloppy-v0", "sloppy-v0 (scripted)"],
    ["claude-stub", "claude-stub (stub)"],
    ["synthetic-v1", "synthetic-v1 (synthetic)"],
    ["claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["something-new", "something-new"],
  ])("%s -> %s", (model, label) => {
    expect(modelLabel(model)).toBe(label);
  });
});

describe("simulationTag: what the Sidings header says about the agents on the line", () => {
  it.each<[string, (string | null)[], string | null]>([
    ["no transactions", [], null],
    ["transactions without a model", [null, null], null],
    ["only real models", ["claude-sonnet-5-5", "claude-sonnet-5-5"], null],
    ["the scripted swarm", ["scripted-v1", "scripted-v1", "sloppy-v0"], "scripted agents"],
    ["the stub of Claude mode", ["claude-stub", "claude-stub"], "stub agents"],
    ["the bench's agents", ["synthetic-v1"], "synthetic agents"],
    ["scripted and stub together", ["claude-stub", "scripted-v1"], "scripted + stub agents"],
    ["scripted next to a real model", ["scripted-v1", "claude-sonnet-5-5"], "scripted + real agents"],
    ["a transaction without a model does not make the others real", ["scripted-v1", null], "scripted agents"],
  ])("%s", (_name, models, text) => {
    expect(simulationTag(models)?.text ?? null).toBe(text);
  });

  it("explains in the tooltip what each kind is, so nobody mistakes it for a language model", () => {
    expect(simulationTag(["scripted-v1"])!.title).toMatch(/not language models/);
    expect(simulationTag(["claude-stub"])!.title).toMatch(/no model is called/);
    expect(simulationTag(["synthetic-v1"])!.title).toMatch(/bench/);
    expect(simulationTag(["scripted-v1", "claude-stub"])!.title).toMatch(/not language models.*no model is called/);
  });
});

describe("bar titles name the model", () => {
  let seq = 0;
  const op = (kind: OpKind, at: number, data: Record<string, unknown>, txn: string, agent: string): Op => ({ seq: ++seq, at, kind, txn, agent, data });
  const scale: Scale = { t0: 0, t1: 1000, x0: 0, x1: 1000 };
  const titleOf = (model: string | undefined) => {
    const s = fold([op("txn.open", 100, { attempt: 1, intent: "Add a speed category", ...(model === undefined ? {} : { model }) }, "t1", "agent-13")]);
    const t = s.txns.get("t1")!;
    return layoutBar({ txn: t, attempt: t.attempts[0]!, lane: 0, lanes: 1, scale, now: 500 })!.title;
  };

  it("puts the agent and the model, with its simulation label, under the transaction line", () => {
    const lines = titleOf("sloppy-v0").split("\n");
    expect(lines[0]).toBe("t1 · attempt 1 · open");
    expect(lines[1]).toBe("agent-13 · sloppy-v0 (scripted)");
    expect(lines[2]).toBe("Add a speed category");
  });

  it("names a real model plainly", () => {
    expect(titleOf("claude-sonnet-5-5").split("\n")[1]).toBe("agent-13 · claude-sonnet-5-5");
  });

  it("names only the agent when the transaction has no model", () => {
    const title = titleOf(undefined);
    expect(title.split("\n")[1]).toBe("agent-13");
    expect(title).not.toMatch(/null|undefined/);
  });
});

describe("the Recall dialog's lists", () => {
  it.each([
    ["model", "sloppy-v0", 2, "sloppy-v0 (scripted) · 2 landed"],
    ["model", "scripted-v1", 11, "scripted-v1 (scripted) · 11 landed"],
    ["model", "claude-stub", 1, "claude-stub (stub) · 1 landed"],
    ["model", "claude-sonnet-5-5", 3, "claude-sonnet-5-5 · 3 landed"],
    ["model", "sloppy-v0", 0, "sloppy-v0 (scripted) · 0 landed"],
    ["agent", "agent-13", 2, "agent-13 · 2 landed"],
    // An agent called like a model is still an agent: only models are labelled.
    ["agent", "scripted-v1", 1, "scripted-v1 · 1 landed"],
  ] as const)("%s %s x%d reads %j", (kind, value, count, text) => {
    expect(optionText(kind, value, count)).toBe(text);
  });
});
