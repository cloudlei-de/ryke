import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, matchGlob, matchesAny, normalizePath, parsePolicy, PolicyError } from "../src/shared/policy";

describe("matchGlob", () => {
  it.each([
    ["test/**", "test/a.ts", true],
    ["test/**", "test/deep/b.test.ts", true],
    ["test/**", "test", true],
    ["test/**", "tests/a.ts", false],
    ["test/**", "src/test/a.ts", false],
    ["ryke.json", "ryke.json", true],
    ["ryke.json", "src/ryke.json", false],
    ["src/*.ts", "src/format.ts", true],
    ["src/*.ts", "src/units/length.ts", false],
    ["src/*.ts", "src/format.tsx", false],
    ["src/**/*.ts", "src/format.ts", true],
    ["src/**/*.ts", "src/units/length.ts", true],
    ["src/**/*.ts", "src/units/a/b/c.ts", true],
    ["src/payments/**", "src/payments/stripe.ts", true],
    ["src/payments/**", "src/paymentsx/a.ts", false],
    ["**", "anything/at/all", true],
    ["**/CHANGELOG.md", "CHANGELOG.md", true],
    ["**/CHANGELOG.md", "docs/CHANGELOG.md", true],
    ["*", "a", true],
    ["*", "a/b", false],
    ["a*b*c", "abc", true],
    ["a*b*c", "a-b-c", true],
    ["a*b*c", "acb", false],
    ["*.test.ts", "x.test.ts", true],
    ["*.test.ts", ".test.ts", true],
    ["ab*ab", "ab", false],
    ["ab*ab", "abab", true],
  ])("%s ~ %s → %s", (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
  });

  it("matchesAny is false for an empty pattern list", () => {
    expect(matchesAny([], "a")).toBe(false);
    expect(matchesAny(["x", "a"], "a")).toBe(true);
  });
});

describe("normalizePath", () => {
  it.each([
    ["./src/format.ts", "src/format.ts"],
    ["src//format.ts", "src/format.ts"],
    ["src\\units\\length.ts", "src/units/length.ts"],
    ["/src/format.ts", "src/format.ts"],
    ["src/./a/../format.ts", "src/format.ts"],
    ["src/units/", "src/units"],
    ["CHANGELOG.md", "CHANGELOG.md"],
  ])("%s → %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it.each(["", ".", "./", "../x", "a/../../x"])("rejects %j", (input) => {
    expect(() => normalizePath(input)).toThrow(PolicyError);
  });
});

describe("parsePolicy", () => {
  it("returns the defaults when the repo has no ryke.json", () => {
    expect(parsePolicy(null)).toEqual(DEFAULT_POLICY);
  });

  it("parses the full policy from PLAN.md §4.5", () => {
    const p = parsePolicy(
      JSON.stringify({
        protected: ["test/**", "ryke.json"],
        union: ["src/registry.ts", "CHANGELOG.md"],
        verify: "node --test",
        verifyTimeoutSeconds: 60,
        human: ["src/payments/**"],
        trainMax: 4,
        preview: { main: "src/index.ts" },
      }),
    );
    expect(p).toEqual({
      protected: ["test/**", "ryke.json"],
      union: ["src/registry.ts", "CHANGELOG.md"],
      verify: "node --test",
      verifyTimeoutSeconds: 60,
      human: ["src/payments/**"],
      trainMax: 4,
      preview: { main: "src/index.ts" },
    });
  });

  it("always protects ryke.json itself", () => {
    expect(parsePolicy(JSON.stringify({ protected: ["test/**"] })).protected).toEqual(["test/**", "ryke.json"]);
    expect(parsePolicy("{}").protected).toEqual(["ryke.json"]);
  });

  it.each([
    ["not json", "{"],
    ["array", "[]"],
    ["null", "null"],
    ["protected not a list", JSON.stringify({ protected: "test/**" })],
    ["empty pattern", JSON.stringify({ union: [""] })],
    ["non-string pattern", JSON.stringify({ human: [1] })],
    ["zero timeout", JSON.stringify({ verifyTimeoutSeconds: 0 })],
    ["string timeout", JSON.stringify({ verifyTimeoutSeconds: "5" })],
    ["fractional trainMax", JSON.stringify({ trainMax: 2.5 })],
    ["zero trainMax", JSON.stringify({ trainMax: 0 })],
    ["huge trainMax", JSON.stringify({ trainMax: 65 })],
    ["preview without main", JSON.stringify({ preview: {} })],
    ["preview null", JSON.stringify({ preview: null })],
  ])("rejects %s", (_name, text) => {
    expect(() => parsePolicy(text)).toThrow(PolicyError);
  });
});
