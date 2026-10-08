// The Artifacts store adapter (src/worker/store/artifacts.ts) against an in-memory fake of the binding
// (test/fake-artifacts.ts). This is as far as it can be tested without Workers Paid: the fake follows
// the binding's declared types and doc comments, so passing here shows the adapter uses the binding
// as documented, not that the real service behaves that way. The real run is
// `RYKE_STORE_CONTRACT=artifacts` (BLOCKERS.md).
import { describe, expect, it } from "vitest";
import { ArtifactsStore } from "../src/worker/store/artifacts";
import { StoreError } from "../src/worker/store/store";
import { FakeArtifacts } from "./fake-artifacts";
import { storeContract, type ContractTarget } from "./store-contract";

// The same two commits test/setup/stack.mjs pushes for the local store, with the same messages.
async function seeded(fake: FakeArtifacts): Promise<ContractTarget> {
  const store = new ArtifactsStore(fake.binding);
  await store.create("fixture");
  const first = await fake.commit(
    "fixture",
    {
      "ryke.json": JSON.stringify({ protected: ["test/**", "ryke.json"], union: ["src/registry.ts", "CHANGELOG.md"], verify: "true", trainMax: 4 }),
      "src/format.ts": "export const digits = 2;\n",
      "src/registry.ts": "export { a } from './a.ts';\n",
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
      "test/a.test.ts": "// protected\n",
      "CHANGELOG.md": "# Changelog\n",
    },
    "Seed fixture",
  );
  const second = await fake.commit("fixture", { "src/a.ts": "export const a = 2;\n", "src/b.ts": null, "src/c/d.ts": "export const d = 1;\n" }, "Second commit\n\nWith a body.");
  return { store, fixture: { name: "fixture", commits: [first, second] }, commit: (repo, files, message) => fake.commit(repo, files, message) };
}

// Run twice: once with errors the way the types declare them, once the way an RPC boundary may deliver
// them, as plain Errors whose `code` property was dropped on the way.
const suites = [
  { label: "errors carry their code", dropCodes: false },
  { label: "errors arrive without their code", dropCodes: true },
];

for (const { label, dropCodes } of suites) {
  const fake = new FakeArtifacts({ dropCodes });
  storeContract(`Artifacts adapter on an in-memory binding (${label})`, () => seeded(fake));

  describe(`Artifacts adapter on an in-memory binding (${label}): handles and traffic`, () => {
    const store = new ArtifactsStore(fake.binding);
    const name = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    it("disposes every repo handle it takes, also when the call fails", async () => {
      const repo = name("h");
      await store.create(repo);
      const sha = await fake.commit(repo, { "a.txt": "a", "d/b.txt": "b" }, "one");
      const second = await fake.commit(repo, { "d/b.txt": "c" }, "two");
      await store.fork(repo, name("h-fork"));
      await store.info(repo);
      await store.token(repo, "read", 60);
      await store.log(repo);
      await store.readFile(repo, "main", "a.txt");
      await store.files(repo, "main");
      await store.diff(repo, sha, second);
      await store.remove(repo);
      for (const failing of [() => store.info(name("gone")), () => store.fork(name("gone"), name("x")), () => store.files(name("gone"), "main"), () => store.diff(name("gone"), "a".repeat(40), "b".repeat(40))])
        await failing().catch(() => undefined);
      expect(fake.open).toBe(0);
    });

    it("disposes the handle of a call that fails after it was taken", async () => {
      const repo = name("h");
      await store.create(repo);
      await fake.commit(repo, { "a.txt": "a" }, "one");
      await expect(store.files(repo, "no-such-ref")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(store.diff(repo, "e".repeat(40), "f".repeat(40))).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fake.open).toBe(0);
    });

    it("creates with the description and main as the default branch, and asks the repo for its remote", async () => {
      const repo = name("m");
      const ref = await store.create(repo, { description: "Ryke trunk" });
      expect(ref).toEqual({ name: repo, remote: `https://acct.artifacts.cloudflare.net/git/ryke/${repo}.git`, defaultBranch: "main" });
      expect(fake.calls.at(-1)).toBe("info");
    });

    it("never asks for fewer than the 60 seconds a token must live", async () => {
      const repo = name("tok");
      await store.create(repo);
      for (const [ttl, atLeast] of [[1, 60], [59, 60], [60, 60], [600, 600]] as const) {
        const expires = Number((await store.token(repo, "write", ttl)).split("=")[1]);
        expect(expires).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + atLeast - 1);
        expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + atLeast + 1);
      }
    });

    it("reports a commit's author, committer-time in milliseconds and parents", async () => {
      const repo = name("c");
      await store.create(repo);
      const a = await fake.commit(repo, { "a.txt": "a" }, "first", 1_700_000_123);
      const b = await fake.commit(repo, { "a.txt": "b" }, "second", 1_700_000_456);
      expect(await store.log(repo)).toEqual([
        { sha: b, parents: [a], message: "second", author: "Test <test@ryke.ai>", at: 1_700_000_456_000 },
        { sha: a, parents: [], message: "first", author: "Test <test@ryke.ai>", at: 1_700_000_123_000 },
      ]);
    });

    it("passes the ref and the limit on to the binding's log", async () => {
      const repo = name("l");
      await store.create(repo);
      const shas: string[] = [];
      for (const n of [1, 2, 3]) shas.push(await fake.commit(repo, { "a.txt": String(n) }, `c${n}`));
      expect((await store.log(repo, { limit: 2 })).map((c) => c.message)).toEqual(["c3", "c2"]);
      expect((await store.log(repo, { ref: shas[0], limit: 10 })).map((c) => c.message)).toEqual(["c1"]);
    });

    it("walks only the subtrees a diff has to look at", async () => {
      const repo = name("w");
      await store.create(repo);
      const a = await fake.commit(repo, { "big/one/f.txt": "1", "big/two/g.txt": "2", "small/h.txt": "3", "top.txt": "t" }, "base");
      const b = await fake.commit(repo, { "small/h.txt": "changed" }, "touch one file");
      fake.treeReads.length = 0;
      expect(await store.diff(repo, a, b)).toEqual([{ path: "small/h.txt", status: "M" }]);
      // Both root trees and both versions of `small`; the untouched `big` is never opened.
      expect(fake.treeReads).toHaveLength(4);
      using bigRead = await fake.binding.get(repo);
      const root = (await bigRead.readTree((await bigRead.log({ limit: 1 }))[0]!.treeHash))!;
      expect(fake.treeReads).not.toContain(root.find((e) => e.name === "big")!.hash);
    });

    it("reads a file through the binding's readFile, not by walking trees", async () => {
      const repo = name("r");
      await store.create(repo);
      await fake.commit(repo, { "a/b/c.txt": "deep" }, "one");
      fake.calls.length = 0;
      expect(await store.readFile(repo, "main", "a/b/c.txt")).toBe("deep");
      expect(fake.calls).toEqual(["readFile:main:a/b/c.txt"]);
    });
  });
}

// What a failure looks like to the adapter. The binding promises an `ArtifactsError` with a string
// `code`, but errors cross an RPC boundary and may arrive as a plain Error, so the text is the
// fallback. Each row is one thrown value and the StoreError code it has to become.
describe("Artifacts adapter error mapping", () => {
  const binding = (thrown: unknown) =>
    ({
      get: async () => {
        throw thrown;
      },
      create: async () => {
        throw thrown;
      },
      delete: async () => {
        throw thrown;
      },
    }) as unknown as Artifacts;
  const coded = (code: string, message = `something about ${code}`) => Object.assign(new Error(message), { name: "ArtifactsError", code });
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  const rows: [string, unknown, string][] = [
    ["NOT_FOUND code", coded("NOT_FOUND"), "NOT_FOUND"],
    ["ALREADY_EXISTS code", coded("ALREADY_EXISTS"), "ALREADY_EXISTS"],
    ["INVALID_REPO_NAME code", coded("INVALID_REPO_NAME"), "INVALID"],
    ["INVALID_INPUT code", coded("INVALID_INPUT"), "INVALID"],
    ["INVALID_TTL code", coded("INVALID_TTL"), "INVALID"],
    ["INVALID_URL code", coded("INVALID_URL"), "INVALID"],
    ["INTERNAL_ERROR code", coded("INTERNAL_ERROR"), "UNAVAILABLE"],
    ["MEMORY_LIMIT code", coded("MEMORY_LIMIT"), "UNAVAILABLE"],
    ["FORK_IN_PROGRESS code", coded("FORK_IN_PROGRESS"), "UNAVAILABLE"],
    ["CREATE_IN_PROGRESS code", coded("CREATE_IN_PROGRESS"), "UNAVAILABLE"],
    ["UPSTREAM_UNAVAILABLE code", coded("UPSTREAM_UNAVAILABLE"), "UNAVAILABLE"],
    ["a recognised code outranks what the message says", coded("INTERNAL_ERROR", "NOT_FOUND somewhere inside"), "UNAVAILABLE"],
    ["no code, the code first in the message", named("ArtifactsError", "NOT_FOUND: repository x not found"), "NOT_FOUND"],
    ["no code, the code inside the message", named("ArtifactsError", "ArtifactsError: ALREADY_EXISTS (repository x)"), "ALREADY_EXISTS"],
    ["no code, the code as the error name", named("NOT_FOUND", "repository x"), "NOT_FOUND"],
    ["no code, an INVALID_* code in the message", named("ArtifactsError", "INVALID_REPO_NAME: bad name"), "INVALID"],
    ["no code, an INVALID_* code as the name", named("INVALID_TTL", "ttl out of range"), "INVALID"],
    ["no code, an in-progress code in the message", named("ArtifactsError", "FORK_IN_PROGRESS: wait"), "UNAVAILABLE"],
    ["no code, a code in lower case with spaces", named("Error", "Repository not found"), "NOT_FOUND"],
    ["no code, the phrase 'already exists'", named("Error", "a repository with that name already exists"), "ALREADY_EXISTS"],
    ["no code, the first code the message mentions wins", named("Error", "INTERNAL_ERROR: while looking for a NOT_FOUND marker"), "UNAVAILABLE"],
    ["an unknown code falls back to the message", coded("E_SOMETHING", "NOT_FOUND: x"), "NOT_FOUND"],
    ["an unknown code and an unhelpful message", coded("E_SOMETHING", "boom"), "UNAVAILABLE"],
    ["no code and nothing to go by", new Error("boom"), "UNAVAILABLE"],
    ["a string that was thrown", "plain string failure", "UNAVAILABLE"],
    ["an object without a message", { code: "NOT_FOUND" }, "NOT_FOUND"],
    ["null", null, "UNAVAILABLE"],
  ];

  it.each(rows)("%s", async (_label, thrown, expected) => {
    const store = new ArtifactsStore(binding(thrown));
    for (const call of [() => store.info("x"), () => store.create("x"), () => store.remove("x"), () => store.token("x", "read", 60), () => store.fork("x", "y")]) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).code).toBe(expected);
    }
  });

  it("keeps the message of the failure", async () => {
    const e = await new ArtifactsStore(binding(coded("NOT_FOUND", "repository gone-repo not found"))).info("gone-repo").catch((x: unknown) => x);
    expect((e as StoreError).message).toBe("repository gone-repo not found");
    const odd = await new ArtifactsStore(binding("plain string failure")).info("x").catch((x: unknown) => x);
    expect((odd as StoreError).message).toBe("plain string failure");
  });

  it("leaves a StoreError alone", async () => {
    const own = new StoreError("INVALID", "already mapped");
    const e = await new ArtifactsStore(binding(own)).info("x").catch((x: unknown) => x);
    expect(e).toBe(own);
  });
});
