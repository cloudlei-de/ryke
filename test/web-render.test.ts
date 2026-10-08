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
import { HotFiles } from "../src/web/views/line/Side";
import { Band, Path } from "../src/web/views/line/Timeline";
import { AXIS_H, buildRows, layoutTrunk, type Scale } from "../src/web/views/line/geometry";
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

// The clock labels on the Line's time axis, left to right (the "now" flag's own text sits in a group of its own).
function axisLabels(html: string): string[] {
  const svg = /<svg class="axis"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
  return [...svg.matchAll(/<text x="[^"]*" y="16"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
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
    // The labels under the "now" flag give way to it; the rest are the whole recording's, up to its last.
    const shown = axisLabels(html);
    expect(shown.length).toBeGreaterThanOrEqual(whole.length - 1);
    expect(shown.every((l) => whole.includes(l))).toBe(true);
    expect(shown.at(-1)).toBe(whole.at(-1));
  });
});

let seq = 0;
const op = (kind: OpKind, at: number, data: Record<string, unknown> = {}, txn: string | null = null, agent: string | null = null): Op => ({ seq: ++seq, at, kind, txn, agent, data });
const line = (ops: Op[]) => render(createElement(LineView, { repo: "convert", state: fold(ops), ops, mode: "live" }));

describe("Line: the header says when the agents are simulated", () => {
  const opened = (model: string | null) => [op("txn.open", 10, { attempt: 1, intent: "do it", model }, "t_1", "agent-01")];

  it.each([
    ["scripted-v1", "scripted agents"],
    ["sloppy-v0", "scripted agents"],
    ["claude-stub", "stub agents"],
  ])("says the agents are simulated when the model is %s", (model, text) => {
    const html = line(opened(model));
    expect(html).toMatch(new RegExp(`<span class="tag sim-tag" title="[^"]+">(<svg[\\s\\S]*?</svg>)?${text}</span>`));
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

describe("Line: the live lamp", () => {
  it("says Live while the socket is connected and Reconnecting when it is not", () => {
    const at = (connected: boolean) => render(createElement(LineView, { repo: "convert", state: fold([]), ops: [], mode: "live", connected }));
    expect(at(true)).toMatch(/data-tone="go"[^>]*><i class="dot" data-tone="go"><\/i>Live</);
    expect(at(false)).toMatch(/data-tone="stop"[^>]*><i class="dot" data-tone="stop"><\/i>Reconnecting</);
  });
});

describe("Line: the counters", () => {
  const t = Date.now() - 20_000;
  it("are a ruled table whose lamps light only for a signal", () => {
    const html = line([
      op("txn.open", t, { attempt: 1, intent: "x" }, "t_1", "agent-01"),
      op("txn.landed", t + 900, { sha: "b".repeat(40), seq: 1 }, "t_1", "agent-01"),
      op("trunk.advanced", t + 900, { seq: 1, sha: "b".repeat(40), txns: [{ txn: "t_1", sha: "b".repeat(40), seq: 1 }], train: null }),
    ]);
    expect(html).toContain('<table class="c-table">');
    expect(html).toContain('<td class="c-lamp"><i class="dot" data-tone="go"></i></td><th scope="row">Landed</th><td class="c-fig">1</td>');
    expect(html).toContain('<td class="c-lamp"><i class="dot"></i></td><th scope="row">Aborted</th><td class="c-fig">0</td>');
    expect(html).toContain('<td class="c-lamp"></td><th scope="row">In flight</th>');
  });
});

describe("Line: the foot of the sheet", () => {
  it("prints the key and the title block with trunk's head, the scale and the moment drawn", () => {
    const t = Date.now() - 20_000;
    const html = line([op("trunk.advanced", t, { seq: 3, sha: "d".repeat(40), txns: [], train: null })]);
    expect(html).toContain('<span class="key-title">Key</span>');
    expect(html).toMatch(/<dl class="title-block" aria-label="Title block">[\s\S]*<dt>Trunk head<\/dt><dd>seq 3 · <span class="mono">dddddddd<\/span>/);
    expect(html).toMatch(/<dt>Scale<\/dt><dd>\d+(\.\d)? s a line · 1 min shown<\/dd>/);
    expect(html).toContain("<dt>Drawn at</dt>");
  });

  it("says it is replayed in a replay", () => {
    const html = render(createElement(LineView, { repo: "convert", state: fold([]), ops: [], mode: "replay", now: 1000 }));
    expect(html).toContain("<dt>Replayed at</dt>");
    expect(html).toContain("no commits yet");
  });
});

describe("Line: what the screenshot checks count", () => {
  // harness/shots.mjs counts `.timeline .rows .m-stale` and `.timeline .rows .strike`: the legend draws the same
  // marks as swatches, so only the rows may count, or the checks would pass on an empty Line.
  const rowsOf = (html: string) => /<svg class="rows"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
  const t = Date.now() - 20_000;

  it("finds no stale notch or strike in the rows of a Line that has none, though the legend draws both", () => {
    const html = line([op("txn.open", t, { attempt: 1, intent: "x" }, "t_1", "agent-01")]);
    expect(html).toContain('class="m-stale"');
    expect(html).toContain('class="strike"');
    expect(rowsOf(html)).not.toContain("m-stale");
    expect(rowsOf(html)).not.toContain("strike");
  });

  it("finds them in the rows once a transaction went stale and another was recalled", () => {
    const html = line([
      op("txn.open", t, { attempt: 1, intent: "x" }, "t_1", "agent-01"),
      op("txn.stale", t + 1000, { reason: "stale_read", paths: [{ path: "a.ts", seq: 1, by: "t_2" }] }, "t_1", "agent-01"),
      op("txn.open", t, { attempt: 1, intent: "y" }, "t_2", "agent-02"),
      op("txn.landed", t + 900, { sha: "b".repeat(40), seq: 1 }, "t_2", "agent-02"),
      op("txn.recalled", t + 5000, { reason: "recall" }, "t_2", "agent-02"),
    ]);
    expect(rowsOf(html).match(/class="m-stale"/g)).toHaveLength(1);
    expect(rowsOf(html).match(/class="strike"/g)).toHaveLength(1);
  });
});

describe("Line: a band", () => {
  const scale: Scale = { t0: 0, t1: 1000, x0: 0, x1: 1000 };
  const band = (ops: Op[], now: number) => {
    const [row] = buildRows(fold(ops), scale, now);
    return render(createElement("svg", null, createElement(Band, { bar: row!.bars[0]!, y: 0, h: 20, label: true })));
  };

  it("is framed all round once it has ended, and open on the right while it runs", () => {
    const ended = band([op("txn.open", 100, { attempt: 1, intent: "Add the Power category" }, "t_1", "a"), op("txn.landed", 400, { sha: "s", seq: 1 }, "t_1", "a")], 500);
    expect(ended).toContain('d="M100.5 0.5H399.5V19.5H100.5Z"');
    const running = band([op("txn.open", 100, { attempt: 1, intent: "Add the Power category" }, "t_1", "a")], 400);
    expect(running).toContain('d="M400 0.5H100.5V19.5H400"');
  });

  it("writes the intent in its working stretch and ends in the mark of how it ended", () => {
    const html = band([op("txn.open", 100, { attempt: 1, intent: "Add the Power category" }, "t_1", "a"), op("txn.landed", 400, { sha: "s", seq: 1 }, "t_1", "a")], 500);
    expect(html).toContain(">Add the Power category</text>");
    expect(html).toContain('class="m-switch"');
  });

  it("fills a human's stretch with the barrier stripes and a queued one with the hatch", () => {
    const html = band([op("txn.open", 100, { attempt: 1, intent: "x" }, "t_1", "a"), op("txn.submitted", 200, {}, "t_1", "a"), op("txn.needs_human", 300, { reason: "scope_creep" }, "t_1", "a")], 400);
    expect(html).toContain('class="part seg-queued" fill="url(#ryke-queue)"');
    expect(html).toContain('class="part seg-human" fill="url(#ryke-human)"');
  });
});

describe("Line: the hovered path", () => {
  const scale: Scale = { t0: 0, t1: 1000, x0: 0, x1: 1000 };
  const ops = [
    op("trunk.advanced", 100, { seq: 1, sha: "a".repeat(40), txns: [], train: null }),
    op("txn.open", 150, { attempt: 1, intent: "x" }, "t_1", "agent-01"),
    op("txn.landed", 400, { sha: "b".repeat(40), seq: 2 }, "t_1", "agent-01"),
    op("trunk.advanced", 400, { seq: 2, sha: "b".repeat(40), txns: [{ txn: "t_1", sha: "b".repeat(40), seq: 2 }], train: null }),
  ];
  const state = fold(ops);
  const rows = buildRows(state, scale, 500);
  const blocks = layoutTrunk(state.ticks, scale);
  const path = (scrollTop: number) => render(createElement(Path, { hover: { bar: rows[0]!.bars[0]! }, state, rows, rowH: 34, blocks, scrollTop, width: 1000 }));

  it("runs down from the commit it began from and back up into the commit it landed as", () => {
    const html = path(0);
    const trunkY = AXIS_H + 30;
    expect(html).toContain(`<path class="path-depart" d="M100 ${trunkY + 4}L150 `);
    expect(html).toContain(`<circle class="path-stop" cx="100" cy="${trunkY}" r="5">`);
    expect(html).toMatch(new RegExp(`<path class="path-arrive" d="M400 [\\d.]+L400 ${trunkY + 4}"`));
  });

  it("meets the trunk where the sticky head is when the rows have scrolled", () => {
    expect(path(120)).toContain(`<circle class="path-stop" cx="100" cy="${AXIS_H + 30 + 120}" r="5">`);
  });

  it("draws nothing for a bar no longer on the sheet", () => {
    expect(render(createElement(Path, { hover: { bar: { ...rows[0]!.bars[0]!, key: "gone#1" } }, state, rows, rowH: 34, blocks, scrollTop: 0, width: 1000 }))).toBe("");
  });
});

describe("Line: the culprit's tick", () => {
  it("is drawn in --stop when its landing made others stale", () => {
    const t = Date.now() - 20_000;
    const html = line([
      op("txn.open", t, { attempt: 1, intent: "x" }, "t_1", "agent-01"),
      op("txn.open", t, { attempt: 1, intent: "y" }, "t_2", "agent-02"),
      op("txn.landed", t + 900, { sha: "b".repeat(40), seq: 1 }, "t_2", "agent-02"),
      op("trunk.advanced", t + 900, { seq: 1, sha: "b".repeat(40), txns: [{ txn: "t_2", sha: "b".repeat(40), seq: 1 }], train: null }),
      op("txn.stale", t + 1000, { reason: "stale_read", paths: [{ path: "a.ts", seq: 1, by: "t_2" }] }, "t_1", "agent-01"),
    ]);
    expect(html.match(/class="tick culprit"/g)).toHaveLength(1);
    expect(html).toContain('<text class="wave-label"');
    expect(html).toContain("1 stale</text>");
  });
});

describe("Line: hot files", () => {
  const row = (path: string, value: number) => ({ path, value, hot: value >= 4, fraction: Math.min(1, value / 8) });
  const files = (heat: ReturnType<typeof row>[]) => render(createElement(HotFiles, { heat, leases: new Map(), error: null }));

  it("lists the warm files and offers the cold ones of a small repo too", () => {
    const html = files([row("src/format.ts", 6), row("src/a.ts", 1), row("b.ts", 0), row("c.ts", 0), row("d.ts", 0)]);
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toContain("Show all 5 files");
  });

  it("says every file is cold, and still offers them, when none is warm", () => {
    const html = files([row("a.ts", 0), row("b.ts", 0)]);
    expect(html).toContain("Every file is cold");
    expect(html).toContain("Show all 2 files");
  });

  it("offers nothing more when every file is already shown", () => {
    const html = files([row("a.ts", 2), row("b.ts", 1)]);
    expect(html).not.toContain("Show all");
  });

  it("prints the heat as ink up to the hot mark and in --stop past it", () => {
    const html = files([row("src/format.ts", 6), row("src/a.ts", 1)]);
    expect(html.match(/class="heat-over"/g)).toHaveLength(1);
    expect(html).toContain('<span class="heat-fill" style="width:50.00%"></span><span class="heat-over" style="left:50.00%;width:25.00%"></span>');
    expect(html).toContain('<span class="heat-fill" style="width:12.50%"></span></span>');
  });

  it("marks a hot file and names its lease holder", () => {
    const html = render(createElement(HotFiles, { heat: [row("src/format.ts", 6)], leases: new Map([["src/format.ts", { txn: "t_9", expires: 1 }]]), error: null }));
    expect(html).toContain('data-hot="true"');
    expect(html).toContain("leased by t_9");
  });
});
