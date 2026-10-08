// WCAG AA for small text (4.5:1) in both colour schemes, computed from the custom properties in
// src/web/styles.css so a later edit of a token cannot quietly regress it. The signal colours keep their
// PLAN.md §12 values for marks and fills; text uses the `-text` variants, which are the same hue moved only as
// far as the contrast needs. A node test, not a vitest one: vitest hands every .css import (even ?raw) back empty.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/web/${rel}`, import.meta.url)), "utf8");
const styles = read("styles.css");
const sheets = ["styles.css", "views/line/line.css", "views/txn/txn.css", "views/recall/recall.css", "views/replay/replay.css", "views/bench/bench.css"].map((f) => [f, read(f)]);
const line = read("views/line/line.css");
const recall = read("views/recall/recall.css");

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
const SIGNALS = ["go", "stop", "caution", "run", "recall"];

// WCAG 2.x relative luminance and contrast ratio.
const channel = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => {
  assert.match(hex, /^#[0-9a-f]{6}$/, `${hex} is a 6 digit hex colour`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// color-mix(in srgb, <fg> 16%, <bg>): the tint behind the added and removed lines of a diff.
const tint = (fg, bg, share = 0.16) => fg.map((v, i) => v * share + bg[i] * (1 - share));
const atLeast = (actual, min, what) => assert.ok(actual >= min, `${what}: ${actual.toFixed(2)}:1, need ${min}:1`);

describe("the tokens", () => {
  it("are found in all three places the theme is defined", () => {
    for (const [name, t] of Object.entries(SCHEMES)) {
      for (const k of ["paper", "ink", "rule", "muted", ...SIGNALS, ...SIGNALS.map((s) => `${s}-text`)]) assert.ok(t[k], `${name} --${k}`);
    }
  });

  it("keep the PLAN.md §12 values for paper, ink, muted and the signals' marks and fills in the light scheme", () => {
    assert.deepEqual(
      Object.fromEntries(["paper", "ink", "rule", "muted", ...SIGNALS].map((k) => [k, SCHEMES.light[k]])),
      { paper: "#f3f0e8", ink: "#121212", rule: "#121212", muted: "#6b675f", go: "#1e7b3c", stop: "#d9412b", caution: "#c78a00", run: "#2850b8", recall: "#7a3fb5" },
    );
  });

  it("keep them in the dark scheme too", () => {
    assert.deepEqual(
      Object.fromEntries(["paper", "ink", "rule", "muted", ...SIGNALS].map((k) => [k, SCHEMES["dark (data-theme)"][k]])),
      { paper: "#101010", ink: "#ece8de", rule: "#ece8de", muted: "#9a958b", go: "#29a352", stop: "#e2654f", caution: "#f0a800", run: "#4d73d6", recall: "#9563cc" },
    );
  });

  it("are the same whether the dark scheme comes from the system or from data-theme", () => {
    assert.deepEqual(SCHEMES["dark (prefers-color-scheme)"], SCHEMES["dark (data-theme)"]);
  });
});

for (const [scheme, t] of Object.entries(SCHEMES)) {
  describe(`small text in the ${scheme} scheme`, () => {
    const paper = rgb(t.paper);

    for (const token of ["ink", "muted", ...SIGNALS.map((s) => `${s}-text`)]) {
      it(`--${token} on paper is at least 4.5:1`, () => atLeast(contrast(rgb(t[token]), paper), 4.5, `--${token} ${t[token]} on ${t.paper}`));
    }

    // The marks of a diff are drawn on a tint of their own colour.
    for (const signal of ["go", "stop"]) {
      it(`--${signal}-text on the 16% tint of --${signal} (the diff's +/- marks) is at least 4.5:1`, () =>
        atLeast(contrast(rgb(t[`${signal}-text`]), tint(rgb(t[signal]), paper)), 4.5, `--${signal}-text on its tint`));
    }

    for (const signal of SIGNALS) {
      it(`--${signal}-text is the same hue as --${signal}, only moved as far as the contrast needs`, () => {
        const [a, b] = [rgb(t[signal]), rgb(t[`${signal}-text`])];
        // Each channel stays on the same side of the others: a darker or lighter version, not another colour.
        assert.equal(Math.sign(a[0] - a[1]), Math.sign(b[0] - b[1]));
        assert.equal(Math.sign(a[1] - a[2]), Math.sign(b[1] - b[2]));
        // The text variant never moves toward the paper, which would lower the contrast.
        atLeast(contrast(b, paper), contrast(a, paper) - 1e-9, `--${signal}-text keeps at least --${signal}'s contrast`);
      });
    }
  });
}

describe("the stylesheets use the text variants for text", () => {
  // `color:` only; border-color, text-decoration-color and the like are marks, not text.
  for (const [name, css] of sheets) {
    it(`${name} sets no text colour straight from a signal`, () => {
      const bare = [...css.matchAll(/(?<![-\w])color:\s*var\(--(go|stop|caution|run|recall)\)/g)].map((m) => m[0]);
      assert.deepEqual(bare, []);
    });
  }

  it("draws the stale label, an SVG text, in --stop-text", () => {
    const rule = /\.sidings \.stale-label\s*\{([^}]*)\}/.exec(line)?.[1] ?? "";
    assert.match(rule, /fill:\s*var\(--stop-text\)/);
  });

  it("puts the Execute button's hover state, paper text on a fill, on --recall-text so the text keeps its contrast", () => {
    const rule = /\.recall-go:hover\s*\{([^}]*)\}/.exec(recall)?.[1] ?? "";
    assert.match(rule, /background:\s*var\(--recall-text\)/);
    for (const [name, t] of Object.entries(SCHEMES)) atLeast(contrast(rgb(t["recall-text"]), rgb(t.paper)), 4.5, `${name} --recall-text under paper text`);
  });
});
