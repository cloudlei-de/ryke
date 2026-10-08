// The RepoStore contract (PLAN.md §3.1) as one function, so every adapter answers the same cases:
// the local adapter against dev/store (test/store-contract.test.ts), the Artifacts adapter against
// a real binding when RYKE_STORE_CONTRACT=artifacts (same file) and against an in-memory fake of the
// binding in CI (test/artifacts-fake.test.ts).
import { beforeAll, describe, expect, it } from "vitest";
import { StoreError, type RepoStore } from "../src/worker/store/store";
import type { FileSpec } from "./fake-artifacts";

export type ContractTarget = {
  store: RepoStore;
  // A repo `name` with these two commits on main, in this order (first is the root commit).
  fixture: { name: string; commits: [string, string] };
  // Adds a commit to the repo's main and returns its sha. The store has no write call: the local
  // target pushes with git, the fake writes objects directly.
  commit(repo: string, files: Record<string, FileSpec>, message: string): Promise<string>;
};

const unique = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    return (e as StoreError).code;
  }
}

export function storeContract(label: string, setup: () => Promise<ContractTarget>) {
  let t: ContractTarget;
  let store: RepoStore;
  beforeAll(async () => {
    t = await setup();
    store = t.store;
  });

  // A repo with one commit per entry, for the diff and listing cases.
  async function history(prefix: string, ...steps: Record<string, FileSpec>[]): Promise<{ name: string; shas: string[] }> {
    const name = unique(prefix);
    await store.create(name);
    const shas: string[] = [];
    for (const [i, files] of steps.entries()) shas.push(await t.commit(name, files, `step ${i}`));
    return { name, shas };
  }

  describe(`RepoStore contract: ${label}`, () => {
    it("creates a repo with a remote and main as the default branch", async () => {
      const name = unique("c");
      const ref = await store.create(name, { description: "x" });
      expect(ref.name).toBe(name);
      expect(ref.defaultBranch).toBe("main");
      expect(ref.remote).toMatch(new RegExp(`/${name}\\.git$`));
      expect(await store.info(name)).toEqual({ ...ref, head: null });
    });

    it("refuses a duplicate name and an invalid name", async () => {
      const name = unique("d");
      await store.create(name);
      expect(await code(store.create(name))).toBe("ALREADY_EXISTS");
      expect(await code(store.create("bad/name"))).toBe("INVALID");
    });

    it("reports NOT_FOUND for a missing repo", async () => {
      expect(await code(store.info(unique("missing")))).toBe("NOT_FOUND");
      expect(await code(store.token(unique("missing"), "read", 60))).toBe("NOT_FOUND");
      expect(await code(store.log(unique("missing")))).toBe("NOT_FOUND");
      expect(await code(store.readFile(unique("missing"), "main", "a"))).toBe("NOT_FOUND");
      expect(await code(store.files(unique("missing"), "main"))).toBe("NOT_FOUND");
      expect(await code(store.diff(unique("missing"), "a".repeat(40), "b".repeat(40)))).toBe("NOT_FOUND");
    });

    it("issues tokens in the Artifacts format", async () => {
      const name = unique("t");
      await store.create(name);
      for (const scope of ["read", "write"] as const) {
        const token = await store.token(name, scope, 120);
        expect(token).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/);
        const expires = Number(token.split("=")[1]);
        expect(expires).toBeGreaterThan(Date.now() / 1000 + 60);
      }
    });

    it("reads the head, the first-parent log and its commit fields", async () => {
      const [first, second] = t.fixture.commits;
      expect((await store.info(t.fixture.name)).head).toBe(second);
      const log = await store.log(t.fixture.name);
      expect(log.map((c) => c.sha)).toEqual([second, first]);
      expect(log[0]!.parents).toEqual([first]);
      expect(log[1]!.parents).toEqual([]);
      expect(log[0]!.message).toBe("Second commit\n\nWith a body.");
      expect(log[0]!.author).toBe("Test <test@ryke.ai>");
      expect(log[0]!.at).toBeGreaterThan(1_700_000_000_000);
      expect((await store.log(t.fixture.name, { limit: 1 })).map((c) => c.sha)).toEqual([second]);
      expect((await store.log(t.fixture.name, { ref: first })).map((c) => c.sha)).toEqual([first]);
      expect(await store.log(t.fixture.name, { ref: "no-such-ref" })).toEqual([]);
    });

    it("has no log for a repo without commits", async () => {
      const name = unique("e");
      await store.create(name);
      expect(await store.log(name)).toEqual([]);
    });

    it("reads files at a ref, null for a missing path, a directory or a missing ref", async () => {
      const [first, second] = t.fixture.commits;
      expect(await store.readFile(t.fixture.name, first, "src/a.ts")).toBe("export const a = 1;\n");
      expect(await store.readFile(t.fixture.name, second, "src/a.ts")).toBe("export const a = 2;\n");
      expect(await store.readFile(t.fixture.name, "main", "src/a.ts")).toBe("export const a = 2;\n");
      expect(await store.readFile(t.fixture.name, "main", "src/b.ts")).toBeNull();
      expect(await store.readFile(t.fixture.name, "main", "src")).toBeNull();
      expect(await store.readFile(t.fixture.name, "main", "src/a.ts/deeper")).toBeNull();
      expect(await store.readFile(t.fixture.name, "0".repeat(40), "src/a.ts")).toBeNull();
      expect(await store.readFile(t.fixture.name, "no-such-ref", "src/a.ts")).toBeNull();
    });

    it("lists files and diffs two commits with A/M/D status", async () => {
      const [first, second] = t.fixture.commits;
      expect(await store.files(t.fixture.name, first)).toEqual(["CHANGELOG.md", "ryke.json", "src/a.ts", "src/b.ts", "src/format.ts", "src/registry.ts", "test/a.test.ts"]);
      expect(await store.files(t.fixture.name, second)).toContain("src/c/d.ts");
      expect(await store.files(t.fixture.name, "main")).toEqual(await store.files(t.fixture.name, second));
      expect(await store.diff(t.fixture.name, first, second)).toEqual([
        { path: "src/a.ts", status: "M" },
        { path: "src/b.ts", status: "D" },
        { path: "src/c/d.ts", status: "A" },
      ]);
      expect(await store.diff(t.fixture.name, second, second)).toEqual([]);
    });

    it("lists no files for a repo without commits, and refuses an unknown ref in a repo that has some", async () => {
      const empty = unique("e");
      await store.create(empty);
      expect(await store.files(empty, "main")).toEqual([]);
      expect(await code(store.files(t.fixture.name, "no-such-ref"))).toBe("NOT_FOUND");
      expect(await code(store.files(t.fixture.name, "f".repeat(40)))).toBe("NOT_FOUND");
    });

    it("refuses to diff commits that do not exist, whichever side is unknown", async () => {
      const [first] = t.fixture.commits;
      const nope = "f".repeat(40);
      expect(await code(store.diff(t.fixture.name, nope, first))).toBe("NOT_FOUND");
      expect(await code(store.diff(t.fixture.name, first, nope))).toBe("NOT_FOUND");
      const empty = unique("e");
      await store.create(empty);
      expect(await code(store.diff(empty, nope, nope))).toBe("NOT_FOUND");
    });

    // Each row is a repo whose last commit changes the first one in some way a diff has to name.
    const changes: [string, Record<string, FileSpec>, Record<string, FileSpec>, { path: string; status: "A" | "M" | "D" }[]][] = [
      ["a file in a nested directory", { "a/b/c.txt": "1", "a/keep.txt": "k", "z.txt": "z" }, { "a/b/c.txt": "2" }, [{ path: "a/b/c.txt", status: "M" }]],
      ["a new file next to existing ones and a new directory", { "a/x.txt": "x" }, { "a/y.txt": "y", "n/m/o.txt": "o" }, [{ path: "a/y.txt", status: "A" }, { path: "n/m/o.txt", status: "A" }]],
      ["a whole directory removed", { "d/1.txt": "1", "d/e/2.txt": "2", "keep.txt": "k" }, { d: null }, [{ path: "d/1.txt", status: "D" }, { path: "d/e/2.txt", status: "D" }]],
      ["a file turned into a directory", { x: "plain", "keep.txt": "k" }, { "x/y.txt": "inside" }, [{ path: "x", status: "D" }, { path: "x/y.txt", status: "A" }]],
      ["a directory turned into a file", { "x/y.txt": "inside", "x/z/w.txt": "deep", "keep.txt": "k" }, { x: "plain" }, [{ path: "x", status: "A" }, { path: "x/y.txt", status: "D" }, { path: "x/z/w.txt", status: "D" }]],
      ["only the executable bit", { "run.sh": "echo hi\n" }, { "run.sh": { content: "echo hi\n", exec: true } }, [{ path: "run.sh", status: "M" }]],
      ["the executable bit and the content", { "run.sh": { content: "echo hi\n", exec: true } }, { "run.sh": { content: "echo bye\n" } }, [{ path: "run.sh", status: "M" }]],
      ["a file turned into a symlink", { link: "target" }, { link: { symlink: "elsewhere" } }, [{ path: "link", status: "M" }]],
      ["a file moved to another name (no rename detection)", { "old.txt": "same content\n" }, { "old.txt": null, "new.txt": "same content\n" }, [{ path: "new.txt", status: "A" }, { path: "old.txt", status: "D" }]],
      ["nothing but the message", { "a.txt": "a" }, {}, []],
    ];
    it.each(changes)("diffs %s", async (_label, before, after, expected) => {
      const { name, shas } = await history("df", before, after);
      expect(await store.diff(name, shas[0]!, shas[1]!)).toEqual(expected);
      // The same change read backwards swaps A and D, and nothing else.
      const flip = { A: "D", D: "A", M: "M" } as const;
      const backwards = expected.map((c) => ({ path: c.path, status: flip[c.status] })).sort((a, b) => (a.path < b.path ? -1 : 1));
      expect(await store.diff(name, shas[1]!, shas[0]!)).toEqual(backwards);
    });

    it("lists nested files, including executables and symlinks, in path order", async () => {
      const { name, shas } = await history("ls", { "b.txt": "b", "a/z.txt": "z", "a/b/c.txt": "c", "run.sh": { content: "#!/bin/sh\n", exec: true }, link: { symlink: "b.txt" } });
      expect(await store.files(name, shas[0]!)).toEqual(["a/b/c.txt", "a/z.txt", "b.txt", "link", "run.sh"]);
    });

    it("keeps an old commit readable after the branch moved on", async () => {
      const { name, shas } = await history("old", { "f.txt": "one" }, { "f.txt": "two" }, { "f.txt": "three" });
      expect(await store.readFile(name, shas[0]!, "f.txt")).toBe("one");
      expect(await store.readFile(name, "main", "f.txt")).toBe("three");
      expect((await store.log(name)).map((c) => c.sha)).toEqual([...shas].reverse());
      expect((await store.log(name, { ref: shas[1]!, limit: 5 })).map((c) => c.sha)).toEqual([shas[1], shas[0]]);
      expect((await store.info(name)).head).toBe(shas[2]);
    });

    it("forks the default branch with its history", async () => {
      const name = unique("f");
      const ref = await store.fork(t.fixture.name, name);
      expect(ref.name).toBe(name);
      expect(ref.remote).toMatch(new RegExp(`/${name}\\.git$`));
      expect((await store.info(name)).head).toBe(t.fixture.commits[1]);
      expect(await store.diff(name, t.fixture.commits[0], t.fixture.commits[1])).toHaveLength(3);
      expect(await code(store.fork(t.fixture.name, name))).toBe("ALREADY_EXISTS");
      expect(await code(store.fork(unique("nope"), unique("f")))).toBe("NOT_FOUND");
    });

    it("keeps a fork independent of its source", async () => {
      const { name: source, shas } = await history("src", { "f.txt": "one" });
      const fork = unique("f");
      await store.fork(source, fork);
      const forked = await t.commit(fork, { "f.txt": "two" }, "in the fork");
      expect((await store.info(source)).head).toBe(shas[0]);
      expect((await store.info(fork)).head).toBe(forked);
      expect(await store.readFile(source, "main", "f.txt")).toBe("one");
      expect(await store.readFile(fork, "main", "f.txt")).toBe("two");
      // The source can go away without taking the fork with it.
      expect(await store.remove(source)).toBe(true);
      expect(await store.readFile(fork, "main", "f.txt")).toBe("two");
    });

    it("forks a repo that has no commits yet", async () => {
      const source = unique("e");
      await store.create(source);
      const fork = unique("f");
      await store.fork(source, fork);
      expect((await store.info(fork)).head).toBeNull();
    });

    it("removes a repo once", async () => {
      const name = unique("r");
      await store.create(name);
      expect(await store.remove(name)).toBe(true);
      expect(await store.remove(name)).toBe(false);
      expect(await code(store.info(name))).toBe("NOT_FOUND");
      // The name is free again.
      await store.create(name);
      expect((await store.info(name)).head).toBeNull();
    });

    it("refuses to remove a repo under an invalid name", async () => {
      expect(await code(store.remove("bad/name"))).toBe("INVALID");
    });
  });
}
