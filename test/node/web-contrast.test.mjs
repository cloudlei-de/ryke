// The sheet's tokens and rules, computed from the stylesheets so a later edit cannot quietly regress them: WCAG AA
// in both prints (4.5:1 for every colour words are set in, on the paper they are set on, and 3:1 for the signal
// marks), one ink at fixed densities for every rule and grid line, and none of what the redesign removed (DECISIONS
// 2026-10-08 graphic timetable): radii past 2 px, shadows, blur, tints, gradients that shade, and the system or
// Inter and Geist faces. A node test, not a vitest one: vitest hands every .css import (even ?raw) back empty.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/web/${rel}`, import.meta.url)), "utf8");
const styles = read("styles.css");
const FILES = ["styles.css", "fonts/fonts.css", "views/line/line.css", "views/txn/txn.css", "views/recall/recall.css", "views/replay/replay.css", "views/bench/bench.css"];
const sheets = FILES.map((f) => [f, read(f).replace(/\/\*[\s\S]*?\*\//g, "")]);

function tokens(css, pattern) {
  const body = pattern.exec(css)?.[1];
  assert.notEqual(body, undefined, `styles.css has no block matching ${pattern}`);
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().toLowerCase()]));
}

const SCHEMES = {
  day: tokens(styles, /:root\s*\{([^}]*)\}/),
  "night (prefers-color-scheme)": tokens(styles, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/),
  "night (data-theme)": tokens(styles, /:root\[data-theme="dark"\]\s*\{([^}]*)\}/),
};
const SIGNALS = ["go", "stop", "caution", "run"];
const COLOURS = ["paper", "ink", "ink-2", "rule", "grid", "grid-2", ...SIGNALS, "scrim"];

// WCAG 2.x relative luminance and contrast ratio.
const channel = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => {
  assert.match(hex, /^#[0-9a-f]{6}$/, `${hex} is a 6 digit hex colour`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(a, b) {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const atLeast = (fg, bg, min, what) => {
  const r = contrast(fg, bg);
  assert.ok(r >= min, `${what}: ${fg} on ${bg} is ${r.toFixed(2)}:1, need ${min}:1`);
};

describe("the tokens", () => {
  it("are defined in all three places the print is set", () => {
    for (const [name, t] of Object.entries(SCHEMES)) for (const k of COLOURS) assert.ok(t[k], `${name} --${k}`);
  });

  it("are the same whether the night print comes from the system or from data-theme", () => {
    assert.deepEqual(SCHEMES["night (prefers-color-scheme)"], SCHEMES["night (data-theme)"]);
  });

  it("are the brief's paper, inks and signals", () => {
    const day = SCHEMES.day;
    const night = SCHEMES["night (data-theme)"];
    assert.deepEqual(
      Object.fromEntries(["paper", "ink", "ink-2", ...SIGNALS].map((k) => [k, [day[k], night[k]]])),
      {
        paper: ["#f4f1e8", "#16150f"],
        ink: ["#16150f", "#ece7d8"],
        "ink-2": ["#5e594c", "#a39d8c"],
        go: ["#1b7a3a", "#4fb56e"],
        stop: ["#c8321e", "#f0614a"],
        caution: ["#b87a00", "#e3a82b"],
        run: ["#1f4fb0", "#6e93e8"],
      },
    );
  });

  it("are only used where they are defined: no stylesheet names a custom property styles.css lacks", () => {
    // The last four are set per element from the components' style attributes: a heat track's mark, the replay's
    // played share, a gauge's value and threshold.
    const defined = new Set(Object.keys(SCHEMES.day).concat(["hot-at", "fill", "v", "at"]));
    for (const [file, css] of sheets) {
      const local = new Set([...css.matchAll(/--([\w-]+):/g)].map((m) => m[1]));
      for (const m of css.matchAll(/var\(--([\w-]+)/g)) assert.ok(defined.has(m[1]) || local.has(m[1]), `${file} uses --${m[1]}, which is not defined`);
    }
  });
});

for (const [scheme, t] of Object.entries(SCHEMES)) {
  describe(`one ink in the ${scheme} print`, () => {
    it("draws every rule in the ink, and the grid in the ink at a fifth and a tenth", () => {
      assert.equal(t.rule, t.ink);
      assert.equal(t.grid, `${t.ink}33`);
      assert.equal(t["grid-2"], `${t.ink}1a`);
    });
    it("veils the sheet under a dialog with its own paper", () => assert.ok(t.scrim.startsWith(t.paper), `--scrim ${t.scrim} is not --paper ${t.paper} with an alpha`));
  });

  describe(`words in the ${scheme} print`, () => {
    // Words are set in the inks, and in --go and --stop for a diff's counts, a stale flag and an error; never in
    // --caution or --run, which are marks only.
    for (const token of ["ink", "ink-2", "go", "stop"]) {
      it(`--${token} on the paper is at least 4.5:1`, () => atLeast(t[token], t.paper, 4.5, `--${token} on --paper`));
    }
    it("reverse print (paper on ink: the sheet in front, now, a pressed lever) is at least 4.5:1", () => atLeast(t.paper, t.ink, 4.5, "--paper on --ink"));
    it("the Execute recall button's words (paper on stop) are at least 4.5:1", () => atLeast(t.paper, t.stop, 4.5, "--paper on --stop"));
  });

  describe(`marks in the ${scheme} print`, () => {
    for (const s of SIGNALS) {
      it(`--${s} stands out from the paper at 3:1`, () => atLeast(t[s], t.paper, 3, `--${s} on --paper`));
    }
    // A lamp is a signal colour in an ink housing; the housing must show against the colour it holds.
    for (const s of SIGNALS) {
      it(`a lit ${s} lamp shows its ink housing`, () => assert.ok(contrast(t.ink, t[s]) >= 1.5, `--ink on --${s}`));
    }
  });
}

// Every rule of every sheet with its selector, at-rule headers left out; the last declaration may lack its ";".
const RULES = sheets.flatMap(([file, css]) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ file, selector: m[1].trim(), body: `${m[2].trim()};` })));

describe("the colour words are set in", () => {
  // --caution and --run fail 4.5:1 on the day paper, so no rule may set text in them. They may fill only these
  // marks, which carry no words: the bands, the lease dots and barrier stripes, the warning triangle, a lamp, a
  // hovered trunk tick.
  const MARKS = /^(\.s-verify|\.seg-verify|\.human-bg|\.lease-dot|\.warn|\.agent-dot\[data-tone="(caution|run)"\]|a:hover > \.tick,\s*a:focus-visible > \.tick)$/;

  it("is never --caution or --run", () => {
    for (const r of RULES) {
      for (const m of r.body.matchAll(/(?:^|[;\s])(color|fill)\s*:\s*var\(--(caution|run)\)/g)) {
        assert.ok(m[1] === "fill" && MARKS.test(r.selector), `${r.file} "${r.selector}" sets ${m[1]} to --${m[2]}`);
      }
    }
  });

  it("is never on a tint: no colour is mixed into the paper", () => {
    for (const [file, css] of sheets) assert.doesNotMatch(css, /color-mix\(/, file);
  });
});

// Every gradient in a sheet with the colour of each of its stops; a leading direction or angle is not a stop.
function gradients(css) {
  const out = [];
  for (const m of css.matchAll(/(repeating-)?(?:linear|radial|conic)-gradient\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) depth += css[i] === "(" ? 1 : css[i] === ")" ? -1 : 0;
    const args = [];
    let level = 0;
    let from = start;
    for (let j = start; j < i - 1; j++) {
      if (css[j] === "(") level++;
      else if (css[j] === ")") level--;
      else if (css[j] === "," && level === 0) {
        args.push(css.slice(from, j).trim());
        from = j + 1;
      }
    }
    args.push(css.slice(from, i - 1).trim());
    const stops = args.filter((a) => !/^(to |-?[\d.]+deg)/.test(a)).map((a) => (a.startsWith("var(") ? a.slice(0, a.indexOf(")") + 1) : a.split(/\s+/)[0]));
    out.push({ repeating: Boolean(m[1]), stops });
  }
  return out;
}

describe("what the sheet is not", () => {
  const rules = RULES;

  it("has no corner rounder than 2 px except the round marks (lamps, balloons)", () => {
    for (const r of rules) {
      for (const m of r.body.matchAll(/border(?:-[a-z]+)*-radius:\s*([^;]+);/g)) {
        const v = m[1].trim();
        assert.ok(/^(0|1px|2px|50%)$/.test(v), `${r.file} "${r.selector}" has border-radius ${v}`);
        if (v === "50%") assert.match(r.selector, /dot|crit-n|recall-num/, `${r.file} "${r.selector}" is round but is not a lamp or a balloon`);
      }
    }
  });

  it("casts no shadow and blurs nothing", () => {
    for (const r of rules) {
      assert.doesNotMatch(r.body, /box-shadow|text-shadow|backdrop-filter|filter:\s*(?:blur|drop-shadow)/, `${r.file} "${r.selector}"`);
    }
  });

  it("shades with no gradient: only hatching in the one ink and flat fills", () => {
    const found = sheets.flatMap(([file, css]) => gradients(css).map((g) => ({ file, ...g })));
    assert.ok(found.some((g) => g.repeating), "the hatching is found");
    for (const g of found) {
      const colours = new Set(g.stops);
      if (g.repeating) for (const c of colours) assert.match(c, /^(var\(--(ink|grid|grid-2)\)|transparent)$/, `${g.file}: hatching in ${c}`);
      else assert.equal(colours.size, 1, `${g.file}: a gradient shades between ${[...colours].join(" and ")}`);
    }
  });

  it("sets no system, Inter or Geist face", () => {
    for (const [file, css] of sheets) assert.doesNotMatch(css, /system-ui|ui-monospace|ui-sans-serif|-apple-system|BlinkMacSystemFont|Segoe UI|SF Mono|\bInter\b|Geist/, file);
    assert.match(SCHEMES.day.sans, /^"IBM Plex Sans Condensed"/i);
    assert.match(SCHEMES.day.mono, /^"IBM Plex Mono"/i);
  });
});
