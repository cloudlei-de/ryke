// The small shared pieces of the dashboard: sentence case for labels, the Print switch's order and the mark each
// transaction state is drawn with.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TXN_STATES } from "../src/shared/types";
import { EndMark, endReach, Lamp, nextTheme, sentence, stateMark, Swatch, THEME_TEXT, type EndKind, type MarkName } from "../src/web/ui";

describe("sentence", () => {
  it.each([
    ["needs human", "Needs human"],
    ["landed", "Landed"],
    ["Stale", "Stale"],
    ["", ""],
  ])("%j -> %j", (s, out) => expect(sentence(s)).toBe(out));
});

describe("nextTheme", () => {
  it("cycles system, light, dark and back", () => {
    expect([nextTheme("system"), nextTheme("light"), nextTheme("dark")]).toEqual(["light", "dark", "system"]);
  });
  it("names every theme as the Print cell prints it", () => expect(THEME_TEXT).toEqual({ system: "Auto", light: "Day", dark: "Night" }));
});

describe("stateMark", () => {
  it.each([
    ["open", "working"],
    ["submitted", "queued"],
    ["ready", "queued"],
    ["verifying", "verifying"],
    ["landed", "landed"],
    ["stale", "stale"],
    ["failed", "failed"],
    ["rejected", "rejected"],
    ["needs_human", "human"],
    ["lease_wait", "lease"],
    ["aborted", "aborted"],
    ["recalled", "recalled"],
    ["something_new", "working"],
  ])("%s -> %s", (state, mark) => expect(stateMark(state)).toBe(mark));

  it("gives every state of the state machine a mark, and the terminal ones their own", () => {
    const marks = TXN_STATES.map(stateMark);
    expect(marks.every(Boolean)).toBe(true);
    expect(new Set(["landed", "stale", "failed", "rejected", "recalled", "needs_human", "aborted"].map(stateMark)).size).toBe(7);
  });
});

describe("Swatch", () => {
  const draw = (mark: MarkName) => renderToStaticMarkup(createElement(Swatch, { mark }));
  const ALL: MarkName[] = ["working", "retry", "queued", "verifying", "landed", "stale", "failed", "rejected", "aborted", "human", "lease", "recalled", "warning", "train", "trunk", "alert", "policy"];
  // A drawing with its colours taken out: each class keeps only what it says about form (empty, solid, or which
  // texture), so two marks that differ in hue alone come out the same.
  const FORM: Record<string, string> = { "s-open": "empty", "s-verify": "solid", "s-landed": "solid", "s-queued": "hatch", "s-lease": "dots", "s-human": "stripes", "f-paper": "empty", "f-stop": "solid" };
  const form = (html: string) => html.replace(/class="([^"]*)"/g, (_m, c: string) => `form="${c.split(" ").map((k) => FORM[k] ?? "").join("")}"`);

  it("draws every mark in a form of its own, so none is told by colour alone", () => {
    const forms = ALL.map((m) => form(draw(m)));
    const same = ALL.filter((m, i) => forms.indexOf(forms[i]!) !== i).map((m) => `${m} looks like ${ALL[forms.indexOf(form(draw(m)))]}`);
    expect(same).toEqual([]);
  });

  it.each<[MarkName, string]>([
    ["stale", 'class="m-stale"'],
    ["landed", 'class="m-switch"'],
    ["failed", 'class="m-cross"'],
    ["rejected", 'class="m-buffer"'],
    ["aborted", 'class="m-end"'],
    ["human", "s-human"],
    ["recalled", 'class="strike"'],
    ["queued", "s-queued"],
    ["lease", "s-lease"],
  ])("draws %s with %s", (mark, cls) => expect(draw(mark)).toContain(cls));

  it("scales to the width asked for, keeping the 24 by 10 drawing", () => {
    const html = renderToStaticMarkup(createElement(Swatch, { mark: "working", width: 36 }));
    expect(html).toContain('width="36" height="15" viewBox="0 0 24 10"');
  });
});

describe("EndMark", () => {
  const draw = (kind: EndKind) => renderToStaticMarkup(createElement("svg", null, createElement(EndMark, { kind, x: 100, y: 10, h: 20 })));
  it.each<[EndKind, string]>([
    // the notch crosses the band 3 px above and below it, centred on its end
    ["stale", '<rect class="m-stale" x="98.75" y="7" width="2.5" height="26"></rect>'],
    // the switch leaves the band's lower corner and rises past its top toward trunk
    ["landed", '<path class="m-switch" d="M99.5 30L110 7.5"></path>'],
    // the cross sits just past the end, its arms as long as a third of the band
    ["failed", '<path class="m-cross" d="M102 15L112 25M112 15L102 25"></path>'],
    // the buffer stop closes the end and braces back along the band
    ["rejected", '<path class="m-buffer" d="M98.25 7H101.75V33H98.25"></path>'],
    // two bars where the line ends
    ["aborted", '<path class="m-end" d="M100.5 7V33M103 7V33"></path>'],
  ])("draws %s", (kind, svg) => expect(draw(kind)).toContain(svg));

  it("draws a recalled landing's switch in ink", () => {
    const html = renderToStaticMarkup(createElement("svg", null, createElement(EndMark, { kind: "landed", x: 100, y: 10, h: 20, recalled: true })));
    expect(html).toContain('class="m-switch recalled"');
  });

  it("reaches no further than endReach says, so a hit area holds the whole mark", () => {
    const right = (kind: EndKind) => Math.max(...[...draw(kind).matchAll(/(?:[MLHV ]|x=")(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter((v) => v > 90));
    for (const kind of ["landed", "failed", "rejected", "aborted"] as const) expect(right(kind)).toBeLessThanOrEqual(100 + endReach(kind, 20));
  });
});

describe("endReach", () => {
  it.each<[Parameters<typeof endReach>[0], number, number]>([
    ["landed", 20, 11],
    ["landed", 8, 7],
    ["failed", 20, 13],
    ["failed", 4, 2 * 2.4 + 3],
    ["stale", 20, 1.5],
    ["rejected", 20, 4],
    ["aborted", 10, 3],
  ])("%s at %d px reaches %d px past the end", (kind, h, reach) => expect(endReach(kind, h)).toBeCloseTo(reach, 6));
});

describe("Lamp", () => {
  const lamp = (tone: Parameters<typeof Lamp>[0]["tone"], live?: boolean) => renderToStaticMarkup(createElement(Lamp, { tone, live, children: "Live" }));

  it("is lit in a signal colour and unlit for no signal or a recall", () => {
    expect(lamp("go")).toBe('<span class="lamp" data-tone="go"><i class="dot" data-tone="go"></i>Live</span>');
    for (const tone of [null, "none", "recall"] as const) expect(lamp(tone)).toBe('<span class="lamp"><i class="dot"></i>Live</span>');
  });

  it("carries the stream state the screenshot run waits for when it is the stream's lamp", () => {
    expect(lamp("go", true)).toContain('class="lamp status-dot" data-tone="go" data-live="true"');
    expect(lamp("stop", false)).toContain('data-live="false"');
  });
});
