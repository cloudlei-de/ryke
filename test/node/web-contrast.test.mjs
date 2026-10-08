// WCAG AA in both colour schemes, computed from the custom properties in src/web/styles.css so a later edit of a
// token cannot quietly regress it: 4.5:1 for every text token on every surface it is written on, and 3:1 for the
// state colours drawn as marks. A node test, not a vitest one: vitest hands every .css import (even ?raw) back empty.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/web/${rel}`, import.meta.url)), "utf8");
const styles = read("styles.css");
const sheets = ["styles.css", "views/line/line.css", "views/txn/txn.css", "views/recall/recall.css", "views/replay/replay.css", "views/bench/bench.css"].map((f) => [f, read(f)]);

function tokens(css, pattern) {
  const body = pattern.exec(css)?.[1];
  assert.notEqual(body, undefined, `styles.css has no block matching ${pattern}`);
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().toLowerCase()]));
}

const SCHEMES = {
  light: tokens(styles, /:root\s*\{([^}]*)\}/),
  "dark (prefers-color-scheme)": tokens(styles, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/),
  "dark (data-theme)": tokens(styles, /:root\[data-theme="dark"\]\s*\{([^}]*)\}/),
};
const STATES = ["run", "go", "stop", "caution", "recall"];
const SURFACES = ["bg", "surface", "surface-2", "surface-3"];
const TEXT = ["text", "text-2", "text-3", ...STATES.map((s) => `${s}-text`)];

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
  it("are defined in all three places the theme is set", () => {
    const want = [...SURFACES, ...TEXT, ...STATES, ...STATES.map((s) => `${s}-soft`), "border", "border-strong", "work", "work-ink", "queue", "queue-line", "heat", "recall-strong", "focus"];
    for (const [name, t] of Object.entries(SCHEMES)) for (const k of want) assert.ok(t[k], `${name} --${k}`);
  });

  it("are the same whether the dark scheme comes from the system or from data-theme", () => {
    assert.deepEqual(SCHEMES["dark (prefers-color-scheme)"], SCHEMES["dark (data-theme)"]);
  });

  it("are only used where they are defined: no stylesheet names a custom property styles.css lacks", () => {
    // The last four are set per element from the components' style attributes: a heat track's mark, the replay's
    // played share, a gauge's value and threshold.
    const defined = new Set(Object.keys(SCHEMES.light).concat(["hot-at", "fill", "v", "at"]));
    for (const [file, css] of sheets) {
      const local = new Set([...css.matchAll(/--([\w-]+):/g)].map((m) => m[1]));
      for (const m of css.matchAll(/var\(--([\w-]+)/g)) assert.ok(defined.has(m[1]) || local.has(m[1]), `${file} uses --${m[1]}, which is not defined`);
    }
  });
});

for (const [scheme, t] of Object.entries(SCHEMES)) {
  describe(`text in the ${scheme} scheme`, () => {
    for (const token of TEXT) {
      it(`--${token} is at least 4.5:1 on every surface`, () => {
        for (const s of SURFACES) atLeast(t[token], t[s], 4.5, `--${token} on --${s}`);
      });
    }

    for (const s of STATES) {
      it(`a ${s} pill (--${s}-text on --${s}-soft) and body text on it are at least 4.5:1`, () => {
        atLeast(t[`${s}-text`], t[`${s}-soft`], 4.5, `--${s}-text on --${s}-soft`);
        atLeast(t.text, t[`${s}-soft`], 4.5, `--text on --${s}-soft`);
      });
    }

    it("the intent written on a working bar is at least 4.5:1", () => atLeast(t["work-ink"], t.work, 4.5, "--work-ink on --work"));
    it("the primary button (surface on text) is at least 4.5:1", () => atLeast(t.surface, t.text, 4.5, "--surface on --text"));
    it("the Recall button's white words are at least 4.5:1", () => atLeast("#ffffff", t["recall-strong"], 4.5, "#fff on --recall-strong"));
  });

  describe(`marks in the ${scheme} scheme`, () => {
    for (const s of [...STATES, "heat"]) {
      it(`--${s} stands out from the surface at 3:1`, () => atLeast(t[s], t.surface, 3, `--${s} on --surface`));
    }
    // The landed, failed and stale glyphs draw white ink on their own colour.
    for (const s of ["go", "stop", "run"]) {
      it(`white glyph ink on --${s} is at least 3:1`, () => atLeast("#ffffff", t[s], 3, `#fff on --${s}`));
    }
  });
}
