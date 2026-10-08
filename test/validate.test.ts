import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, PolicyError } from "../src/shared/policy";
import type { Policy } from "../src/shared/types";
import { validate, type ValidateInput, type ValidateResult } from "../src/worker/ledger/validate";

const POLICY: Policy = {
  ...DEFAULT_POLICY,
  protected: ["test/**", "ryke.json"],
  union: ["src/registry.ts", "CHANGELOG.md", "src/generated/**"],
};

type Case = {
  name: string;
  reads?: string[];
  writes?: string[];
  created?: string[];
  changed?: Record<string, number>;
  policy?: Policy;
  expected: ValidateResult;
};

function run(c: Pick<Case, "reads" | "writes" | "created" | "changed" | "policy">): ValidateResult {
  const input: ValidateInput = {
    reads: c.reads ?? [],
    writes: c.writes ?? [],
    created: c.created ?? [],
    changedSinceSnapshot: new Map(Object.entries(c.changed ?? {})),
    policy: c.policy ?? POLICY,
  };
  return validate(input);
}

const ok = (...unionTouched: string[]): ValidateResult => ({ ok: true, unionTouched });
const stale = (...paths: [string, number][]): ValidateResult => ({
  ok: false,
  kind: "stale",
  paths: paths.map(([path, seq]) => ({ path, seq })),
});
const prot = (...paths: string[]): ValidateResult => ({ ok: false, kind: "protected", paths });
const EMPTY: ValidateResult = { ok: false, kind: "empty" };

describe("validate", () => {
  describe("V8 empty writes", () => {
    it.each<Case>([
      { name: "no reads, no writes", expected: EMPTY },
      { name: "reads only: nothing to land", reads: ["src/a.ts"], expected: EMPTY },
      {
        name: "reads only, even when the read went stale: empty wins over stale",
        reads: ["src/a.ts"],
        changed: { "src/a.ts": 4 },
        expected: EMPTY,
      },
      { name: "created without writes is ignored", created: ["src/new.ts"], expected: EMPTY },
    ])("$name", (c) => {
      expect(run(c)).toEqual(c.expected);
    });
  });

  describe("V1 protected writes", () => {
    it.each<Case>([
      { name: "modifying an existing protected file", writes: ["test/a.test.ts"], expected: prot("test/a.test.ts") },
      {
        name: "deleting an existing protected file looks the same as modifying it (it is in writes, not in created)",
        writes: ["test/old.test.ts"],
        expected: prot("test/old.test.ts"),
      },
      {
        name: "a new file under a protected glob is allowed",
        writes: ["test/new.test.ts"],
        created: ["test/new.test.ts"],
        expected: ok(),
      },
      {
        name: "mixed: only the pre-existing protected file is reported",
        writes: ["test/new.test.ts", "test/old.test.ts", "src/a.ts"],
        created: ["test/new.test.ts"],
        expected: prot("test/old.test.ts"),
      },
      {
        name: "deep path under the glob",
        writes: ["test/deep/er/x.test.ts"],
        expected: prot("test/deep/er/x.test.ts"),
      },
      { name: "literal protected file: ryke.json", writes: ["ryke.json"], expected: prot("ryke.json") },
      { name: "literal pattern does not match a nested namesake", writes: ["src/ryke.json"], expected: ok() },
      { name: "test/** does not match tests/", writes: ["tests/a.ts"], expected: ok() },
      { name: "test/** does not match src/test/", writes: ["src/test/a.ts"], expected: ok() },
      {
        name: "reading a protected file is fine",
        reads: ["test/a.test.ts", "ryke.json"],
        writes: ["src/a.ts"],
        expected: ok(),
      },
      {
        name: "several protected paths come back sorted",
        writes: ["test/z.ts", "ryke.json", "test/a.ts", "test/m/b.ts"],
        expected: prot("ryke.json", "test/a.ts", "test/m/b.ts", "test/z.ts"),
      },
      {
        name: "created entries that are not in writes do not affect anything",
        writes: ["test/old.test.ts"],
        created: ["test/other.test.ts"],
        expected: prot("test/old.test.ts"),
      },
      {
        name: "empty protected list protects nothing",
        writes: ["test/a.test.ts"],
        policy: { ...POLICY, protected: [] },
        expected: ok(),
      },
      {
        name: "protected wins over stale on the same call",
        writes: ["test/a.test.ts", "src/a.ts"],
        changed: { "src/a.ts": 9 },
        expected: prot("test/a.test.ts"),
      },
      {
        name: "a protected union path is still protected when it existed",
        writes: ["src/shared/x.ts"],
        policy: { ...POLICY, protected: ["src/shared/**"], union: ["src/shared/**"] },
        expected: prot("src/shared/x.ts"),
      },
    ])("$name", (c) => {
      expect(run(c)).toEqual(c.expected);
    });
  });

  describe("V6 literal match after normalisation", () => {
    it.each<Case>([
      {
        name: "./ prefix in a write still hits the protected glob; result carries the normalised path",
        writes: ["./test/a.test.ts"],
        expected: prot("test/a.test.ts"),
      },
      {
        name: "backslashes are separators",
        writes: ["test\\sub\\a.test.ts"],
        expected: prot("test/sub/a.test.ts"),
      },
      {
        name: "created is normalised too, so ./ and \\ spellings agree with writes",
        writes: ["test/new.test.ts", "test/sub/new2.test.ts"],
        created: ["./test/new.test.ts", "test\\sub\\new2.test.ts"],
        expected: ok(),
      },
      {
        name: "unnormalised read matches the normalised changed key",
        reads: ["./src/format.ts"],
        writes: ["src/a.ts"],
        changed: { "src/format.ts": 3 },
        expected: stale(["src/format.ts", 3]),
      },
      {
        name: "backslash write matches the normalised changed key",
        writes: ["src\\a.ts"],
        changed: { "src/a.ts": 6 },
        expected: stale(["src/a.ts", 6]),
      },
      {
        name: "doubled separators and dot segments collapse",
        writes: ["src//./units/../a.ts"],
        changed: { "src/a.ts": 2 },
        expected: stale(["src/a.ts", 2]),
      },
      {
        name: "matching is case sensitive",
        writes: ["src/A.ts"],
        changed: { "src/a.ts": 2 },
        expected: ok(),
      },
      {
        name: "a directory is not a prefix of the files changed under it",
        writes: ["src"],
        changed: { "src/a.ts": 2 },
        expected: ok(),
      },
      {
        name: "glob characters in an agent path are literal; globs live only in policy",
        reads: ["src/*.ts"],
        writes: ["src/b.ts"],
        changed: { "src/a.ts": 2 },
        expected: ok(),
      },
    ])("$name", (c) => {
      expect(run(c)).toEqual(c.expected);
    });

    it.each<[string, Pick<Case, "reads" | "writes" | "created">]>([
      ["an escaping write", { writes: ["../outside.ts"] }],
      ["an empty write", { writes: [""] }],
      ["an escaping read", { reads: ["a/../../x"], writes: ["src/a.ts"] }],
      ["an empty read", { reads: ["."], writes: ["src/a.ts"] }],
      ["an escaping created entry", { writes: ["src/a.ts"], created: ["../x"] }],
    ])("throws PolicyError for %s so the caller can answer 422", (_name, c) => {
      expect(() => run(c)).toThrow(PolicyError);
    });
  });

  describe("V2 + V3 + V5 stale detection", () => {
    it.each<Case>([
      {
        name: "write-only overlap",
        writes: ["src/a.ts"],
        changed: { "src/a.ts": 5 },
        expected: stale(["src/a.ts", 5]),
      },
      {
        name: "read-only overlap is the semantic-conflict case: merges cleanly, still stale",
        reads: ["src/format.ts"],
        writes: ["test/new.test.ts"],
        created: ["test/new.test.ts"],
        changed: { "src/format.ts": 7 },
        expected: stale(["src/format.ts", 7]),
      },
      {
        name: "a path both read and written is reported once (V9)",
        reads: ["src/a.ts"],
        writes: ["src/a.ts"],
        changed: { "src/a.ts": 8 },
        expected: stale(["src/a.ts", 8]),
      },
      {
        name: "the same path in different spellings is reported once (V9 after V6)",
        reads: ["./src/a.ts", "src\\a.ts"],
        writes: ["src/a.ts"],
        changed: { "src/a.ts": 8 },
        expected: stale(["src/a.ts", 8]),
      },
      {
        name: "changed path outside the footprint is irrelevant",
        reads: ["src/a.ts"],
        writes: ["src/b.ts"],
        changed: { "src/c.ts": 4, "src/d.ts": 5 },
        expected: ok(),
      },
      {
        name: "nothing changed since the snapshot",
        reads: ["src/a.ts"],
        writes: ["src/b.ts"],
        expected: ok(),
      },
      {
        name: "several stale paths keep their own seqs and come back sorted by path",
        reads: ["src/z.ts", "src/m.ts"],
        writes: ["src/a.ts", "src/b.ts"],
        changed: { "src/z.ts": 12, "src/a.ts": 3, "src/m.ts": 12, "src/b.ts": 9, "src/other.ts": 1 },
        expected: stale(["src/a.ts", 3], ["src/b.ts", 9], ["src/m.ts", 12], ["src/z.ts", 12]),
      },
      {
        name: "one stale path among clean ones",
        reads: ["src/a.ts", "src/b.ts"],
        writes: ["src/c.ts"],
        changed: { "src/b.ts": 2 },
        expected: stale(["src/b.ts", 2]),
      },
      {
        name: "seq is passed through untouched",
        writes: ["src/a.ts"],
        changed: { "src/a.ts": 1 },
        expected: stale(["src/a.ts", 1]),
      },
    ])("$name", (c) => {
      expect(run(c)).toEqual(c.expected);
    });
  });

  describe("V3 + V4 union paths", () => {
    it.each<Case>([
      {
        name: "union-only write overlap is ok and reported as touched",
        writes: ["CHANGELOG.md"],
        changed: { "CHANGELOG.md": 3 },
        expected: ok("CHANGELOG.md"),
      },
      {
        name: "union-only read overlap is ok and reported as touched",
        reads: ["src/registry.ts"],
        writes: ["src/a.ts"],
        changed: { "src/registry.ts": 3 },
        expected: ok("src/registry.ts"),
      },
      {
        name: "union path in the footprint but unchanged is not touched",
        writes: ["src/registry.ts"],
        expected: ok(),
      },
      {
        name: "changed union path outside the footprint is not touched",
        writes: ["src/a.ts"],
        changed: { "src/registry.ts": 3, "CHANGELOG.md": 4 },
        expected: ok(),
      },
      {
        name: "union overlap does not hide a non-union stale path, and is not listed in it",
        reads: ["src/registry.ts"],
        writes: ["src/a.ts"],
        changed: { "src/registry.ts": 5, "src/a.ts": 6 },
        expected: stale(["src/a.ts", 6]),
      },
      {
        name: "unionTouched is sorted and deduplicated",
        reads: ["src/registry.ts", "CHANGELOG.md"],
        writes: ["src/registry.ts", "./CHANGELOG.md"],
        changed: { "src/registry.ts": 5, "CHANGELOG.md": 6 },
        expected: ok("CHANGELOG.md", "src/registry.ts"),
      },
      {
        name: "union globs apply",
        writes: ["src/generated/a.ts", "src/generated/deep/b.ts"],
        changed: { "src/generated/a.ts": 2, "src/generated/deep/b.ts": 3 },
        expected: ok("src/generated/a.ts", "src/generated/deep/b.ts"),
      },
      {
        name: "empty union list: every changed path in the footprint is stale",
        writes: ["CHANGELOG.md"],
        changed: { "CHANGELOG.md": 3 },
        policy: { ...POLICY, union: [] },
        expected: stale(["CHANGELOG.md", 3]),
      },
    ])("$name", (c) => {
      expect(run(c)).toEqual(c.expected);
    });
  });

  describe("V4 ok result", () => {
    it("is exactly { ok: true, unionTouched } with no extra keys", () => {
      expect(run({ writes: ["src/a.ts"] })).toStrictEqual({ ok: true, unionTouched: [] });
    });
  });

  it("does not mutate its input", () => {
    const reads = ["./src/b.ts", "src/a.ts"];
    const writes = ["src\\z.ts", "src/y.ts"];
    const created = ["src/y.ts"];
    const changed = new Map([["src/b.ts", 2]]);
    validate({ reads, writes, created, changedSinceSnapshot: changed, policy: POLICY });
    expect(reads).toEqual(["./src/b.ts", "src/a.ts"]);
    expect(writes).toEqual(["src\\z.ts", "src/y.ts"]);
    expect(created).toEqual(["src/y.ts"]);
    expect([...changed]).toEqual([["src/b.ts", 2]]);
  });
});
