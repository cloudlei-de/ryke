// The dashboard's components rendered to static markup (no browser, no effects): what the pure helpers
// cannot show, namely that each view passes the right inputs to them.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fold } from "../src/shared/reducers";
import type { Op, OpKind } from "../src/shared/types";
import type { Live } from "../src/web/live";
import { axisTicks, opBounds, plotBox, replayWindow } from "../src/web/views/line/geometry";
import { LineView } from "../src/web/views/line";
import { ReplayView } from "../src/web/views/replay";
import e2e from "./fixtures/ops/e2e-land.json";

const recorded = e2e as unknown as Op[];

function liveOf(ops: Op[]): Live {
  return { ops, state: fold(ops), connected: true, version: 0, epoch: 0 };
}

// Rail reads `location.hash` to decide whether Recall is offered; workerd has no `location`.
const had = Object.getOwnPropertyDescriptor(globalThis, "location");
beforeEach(() => {
  Object.defineProperty(globalThis, "location", { value: { hash: "#/replay", search: "", protocol: "http:", host: "ryke.test" }, configurable: true });
});
afterEach(() => {
  if (had) Object.defineProperty(globalThis, "location", had);
  else delete (globalThis as { location?: unknown }).location;
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

// The labels on the Line's time axis, left to right.
function axisLabels(html: string): string[] {
  const svg = /<svg class="axis"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
  return [...svg.matchAll(/<text x="[^"]*" y="11"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
}

describe("Replay", () => {
  it("fits the whole recording on the time axis, so scrubbing moves a cursor instead of rescaling the Line", () => {
    const html = render(createElement(ReplayView, { repo: "convert", live: liveOf(recorded) }));
    // The player starts on the first op. Slicing the log at the playhead gives the axis the 10 s minimum window
    // around that op, which ends before the recording does.
    const { first, last } = opBounds(recorded);
    const tz = -new Date().getTimezoneOffset();
    const plot = plotBox(1000);
    const labels = (a: number, b: number) => axisTicks(replayWindow(a, b, first!), plot.x1 - plot.x0, tz).map((k) => k.label);
    const whole = labels(first!, last!);
    expect(whole).not.toEqual(labels(first!, first!));
    expect(axisLabels(html)).toEqual(whole);
  });
});

let seq = 0;
const op = (kind: OpKind, at: number, data: Record<string, unknown> = {}, txn: string | null = null, agent: string | null = null): Op => ({ seq: ++seq, at, kind, txn, agent, data });
const line = (ops: Op[]) => render(createElement(LineView, { repo: "convert", state: fold(ops), ops, mode: "live" }));

describe("Line: the Sidings header", () => {
  const opened = (model: string | null) => [op("txn.open", 10, { attempt: 1, intent: "do it", model }, "t_1", "agent-01")];

  it.each([
    ["scripted-v1", "scripted agents"],
    ["sloppy-v0", "scripted agents"],
    ["claude-stub", "stub agents"],
  ])("says the agents are simulated when the model is %s", (model, text) => {
    const html = line(opened(model));
    expect(html).toMatch(new RegExp(`<span class="sim-tag" title="[^"]+">${text}</span>`));
  });

  it("says nothing about real models, or about transactions without one", () => {
    expect(line(opened("claude-sonnet-5-5"))).not.toContain("sim-tag");
    expect(line(opened(null))).not.toContain("sim-tag");
    expect(line([])).not.toContain("sim-tag");
  });

  it("puts the model in the hover title of a bar", () => {
    expect(line(opened("sloppy-v0"))).toContain("agent-01 · sloppy-v0 (scripted)");
  });
});

describe("Line: the trunk", () => {
  // The live window ends at the wall clock, so the ops have to be recent to be on it.
  const t = Date.now() - 20_000;
  const ticks = () => [
    op("trunk.advanced", t, { seq: 0, sha: "a".repeat(40), txns: [], train: null }),
    op("trunk.advanced", t + 5000, { seq: 1, sha: "b".repeat(40), txns: [{ txn: "t_1", sha: "b".repeat(40), seq: 1 }], train: "tr_1" }),
    op("trunk.advanced", t + 10_000, { seq: 2, sha: "c".repeat(40), txns: [], train: null, recall: "rc_1" }),
  ];

  it("draws a recall's revert commit in its own class and names the recall, not the seed", () => {
    const html = line([op("txn.open", t, { attempt: 1, intent: "x" }, "t_1", "a"), ...ticks()]);
    expect(html.match(/class="tick recall"/g)).toHaveLength(1);
    expect(html.match(/class="tick seed"/g)).toHaveLength(1);
    expect(html).toContain("recall rc_1 · seq 2 · cccccccc");
    expect(html.match(/seed · seq/g)).toHaveLength(1);
  });
});
