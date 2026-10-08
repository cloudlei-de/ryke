import { describe, expect, it } from "vitest";
import { jaccard, topSimilar, trigrams } from "../src/worker/ledger/similar";

const sorted = (s: Set<string>) => [...s].sort();
const set = (...items: string[]) => new Set(items);

describe("trigrams", () => {
  it.each<[string, string, string[]]>([
    ["nothing", "", []],
    ["only spaces", "   ", []],
    ["only punctuation, which would otherwise pad to a bare space", "!!!", []],
    ["a single letter gets its padding", "a", [" a "]],
    ["two letters", "ab", [" ab", "ab "]],
    ["a word", "add", [" ad", "add", "dd "]],
    ["two words share the padding between them", "add a", [" a ", " ad", "add", "d a", "dd "]],
    ["digits count as characters", "v2", [" v2", "v2 "]],
    ["repeated letters collapse in the set", "aaaaa", [" aa", "aa ", "aaa"]],
    ["underscores and dashes separate words", "snake_case-name", sorted(trigrams("snake case name"))],
    ["a non-ASCII word", "Größe", [" gr", "grö", "röß", "öße", "ße "].sort()],
    ["non-Latin scripts are kept, not dropped as separators", "日本語 テスト", [" テス", " 日本", "スト ", "テスト", "日本語", "本語 ", "語 テ"].sort()],
  ])("%s", (_name, input, expected) => {
    expect(sorted(trigrams(input))).toEqual(expected);
  });

  it("gives the exact trigrams of a short phrase", () => {
    expect(sorted(trigrams("Add a speed"))).toEqual(
      [" a ", " ad", " sp", "a s", "add", "d a", "dd ", "ed ", "eed", "pee", "spe"].sort(),
    );
  });

  it.each([
    ["case", "ADD A SPEED", "add a speed"],
    ["trailing punctuation", "add a speed!!!", "add a speed"],
    ["leading punctuation", "...add a speed", "add a speed"],
    ["a run of separators", "add --- a, speed", "add a speed"],
    ["tabs and newlines", "add\ta\nspeed", "add a speed"],
    ["surrounding whitespace", "  add a speed  ", "add a speed"],
    ["an emoji between words", "add 😀 a speed", "add a speed"],
    ["an emoji between letters", "a😀b", "a b"],
  ])("ignores %s", (_name, noisy, plain) => {
    expect(sorted(trigrams(noisy))).toEqual(sorted(trigrams(plain)));
  });

  it("treats a letter outside the BMP as one character", () => {
    // U+1D49C is two UTF-16 units; slicing by units would split it across trigrams.
    expect([...trigrams("\u{1D49C}")]).toEqual([" \u{1D49C} "]);
  });

  it("keeps word boundaries, so a word and a longer word that contains it differ", () => {
    expect(sorted(trigrams("add"))).not.toEqual(sorted(trigrams("address")));
    expect(trigrams("add").has("dd ")).toBe(true);
    expect(trigrams("address").has("dd ")).toBe(false);
  });
});

describe("jaccard", () => {
  it.each<[string, Set<string>, Set<string>, number]>([
    ["both empty", set(), set(), 0],
    ["the first empty", set(), set("a"), 0],
    ["the second empty", set("a"), set(), 0],
    ["identical", set("a", "b", "c"), set("c", "b", "a"), 1],
    ["disjoint", set("a", "b"), set("c", "d"), 0],
    ["one shared of three distinct", set("a", "b"), set("b", "c"), 1 / 3],
    ["a subset", set("a"), set("a", "b"), 0.5],
    ["two shared of eight", set("a", "b", "c", "d"), set("c", "d", "e", "f", "g", "h"), 0.25],
    ["a single identical element", set("a"), set("a"), 1],
  ])("%s", (_name, a, b, expected) => {
    expect(jaccard(a, b)).toBeCloseTo(expected, 12);
    expect(jaccard(b, a)).toBeCloseTo(expected, 12);
  });

  it("does not modify its arguments", () => {
    const a = set("a", "b");
    const b = set("b", "c", "d");
    jaccard(a, b);
    expect(sorted(a)).toEqual(["a", "b"]);
    expect(sorted(b)).toEqual(["b", "c", "d"]);
  });
});

describe("topSimilar", () => {
  const base = "add a speed category";
  const cand = (id: string, intent: string) => ({ id, intent });

  it("scores an identical intent 1 and keeps its fields", () => {
    expect(topSimilar(base, [cand("t1", base)])).toEqual([{ id: "t1", intent: base, similarity: 1 }]);
  });

  it("scores an intent that differs only in case and punctuation 1", () => {
    expect(topSimilar(base, [cand("t1", "ADD A SPEED CATEGORY!!")])[0]?.similarity).toBe(1);
  });

  it("drops a disjoint intent", () => {
    expect(topSimilar("aaa", [cand("t1", "zzz")])).toEqual([]);
  });

  it("returns nothing for no candidates", () => {
    expect(topSimilar(base, [])).toEqual([]);
  });

  it("sorts by similarity, highest first", () => {
    // Similarities 1, 17/21, 20/27 and 8/21; the input order is deliberately not that order.
    const out = topSimilar(base, [
      cand("low", "add speed"),
      cand("extra-word", "add a speed category please"),
      cand("dropped-word", "add speed category"),
      cand("top", base),
    ]);
    expect(out.map((c) => c.id)).toEqual(["top", "dropped-word", "extra-word", "low"]);
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.similarity).toBeGreaterThan(out[i]!.similarity);
  });

  it("breaks ties on id, whatever order the candidates arrive in", () => {
    const ids = ["t10", "t2", "b", "a", "t1"];
    const forward = topSimilar(base, ids.map((id) => cand(id, base)));
    const backward = topSimilar(base, [...ids].reverse().map((id) => cand(id, base)));
    // Plain string order, not numeric: "t10" < "t2".
    expect(forward.map((c) => c.id)).toEqual(["a", "b", "t1", "t10", "t2"]);
    expect(backward).toEqual(forward);
  });

  it("keeps 5 candidates by default", () => {
    const many = Array.from({ length: 8 }, (_, i) => cand(`t${i}`, base));
    expect(topSimilar(base, many).map((c) => c.id)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("keeps the most similar ones when it has to cut", () => {
    const pool = [
      ...Array.from({ length: 6 }, (_, i) => cand(`weak${i}`, "add speed")),
      cand("best", base),
    ];
    const out = topSimilar(base, pool);
    expect(out).toHaveLength(5);
    expect(out[0]!.id).toBe("best");
  });

  it.each([
    { k: 1, expected: ["a"] },
    { k: 2, expected: ["a", "b"] },
    { k: 3, expected: ["a", "b", "c"] },
    { k: 10, expected: ["a", "b", "c"] },
    { k: 0, expected: [] },
    // slice(0, -1) would silently return all but the last.
    { k: -1, expected: [] },
  ])("honours k = $k", ({ k, expected }) => {
    const pool = ["c", "a", "b"].map((id) => cand(id, base));
    expect(topSimilar(base, pool, k).map((c) => c.id)).toEqual(expected);
  });

  it("includes a candidate exactly at the minimum, 3 of 20 trigrams being 0.15", () => {
    const out = topSimilar(base, [cand("edge", "add")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.similarity).toBe(0.15);
  });

  it.each([
    { min: 0.15, ids: ["same", "edge"] },
    { min: 0.16, ids: ["same"] },
    { min: 1, ids: ["same"] },
    { min: 0, ids: ["same", "edge", "none"] },
  ])("honours min = $min", ({ min, ids }) => {
    const pool = [cand("none", "zzzz"), cand("edge", "add"), cand("same", base)];
    expect(topSimilar(base, pool, 5, min).map((c) => c.id)).toEqual(ids);
  });

  it("matches nothing for an intent with no letters or digits, unless the minimum is 0", () => {
    const pool = [cand("b", "add"), cand("a", "!!!")];
    expect(topSimilar("???", pool)).toEqual([]);
    // Two empty trigram sets are 0 similar, not 1: punctuation-only intents are not duplicates.
    expect(topSimilar("???", pool, 5, 0)).toEqual([
      { id: "a", intent: "!!!", similarity: 0 },
      { id: "b", intent: "add", similarity: 0 },
    ]);
  });

  it("neither reorders nor modifies the candidate list", () => {
    const pool = [cand("z", "add"), cand("a", base)];
    const copy = structuredClone(pool);
    topSimilar(base, pool);
    expect(pool).toEqual(copy);
  });

  describe("realistic intents", () => {
    // Similarities of "add a speed category" with the 20 trigrams it has, with this normalisation.
    const table = [
      { other: "Add speed converter", expected: 6 / 20, aboveDefaultMin: true },
      { other: "Add speed category to the converter", expected: 17 / 38, aboveDefaultMin: true },
      { other: "add a velocity converter", expected: 5 / 39, aboveDefaultMin: false },
      { other: "dark mode toggle in the footer", expected: 0, aboveDefaultMin: false },
      { other: "fix rounding in temperature", expected: 0, aboveDefaultMin: false },
    ];

    it.each(table)("$other scores $expected", ({ other, expected, aboveDefaultMin }) => {
      const [hit] = topSimilar(base, [cand("t", other)], 5, 0);
      expect(hit!.similarity).toBeCloseTo(expected, 10);
      expect(topSimilar(base, [cand("t", other)])).toHaveLength(aboveDefaultMin ? 1 : 0);
    });

    it("ranks a reworded duplicate above a related feature above an unrelated one", () => {
      const pool = [
        cand("footer", "dark mode toggle in the footer"),
        cand("velocity", "add a velocity converter"),
        cand("speed", "Add speed converter"),
      ];
      expect(topSimilar(base, pool, 5, 0).map((c) => c.id)).toEqual(["speed", "velocity", "footer"]);
      expect(topSimilar(base, pool).map((c) => c.id)).toEqual(["speed"]);
      // The related feature needs a lower minimum than the default to reach Jev.
      expect(topSimilar(base, pool, 5, 0.1).map((c) => c.id)).toEqual(["speed", "velocity"]);
    });
  });
});
