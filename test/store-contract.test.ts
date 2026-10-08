// The RepoStore contract (PLAN.md §3.1). CI runs it against the local adapter; with
// RYKE_STORE_CONTRACT=artifacts it runs against the Artifacts binding instead.
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import { ArtifactsStore } from "../src/worker/store/artifacts";
import { LocalStore } from "../src/worker/store/local";
import { StoreError, type RepoStore } from "../src/worker/store/store";

const store: RepoStore = env.RYKE_STORE_CONTRACT === "artifacts" && env.ARTIFACTS ? new ArtifactsStore(env.ARTIFACTS) : new LocalStore(env.RYKE_STORE_URL);
const fixture = inject("fixture");
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

describe("RepoStore contract", () => {
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
  });

  it("issues tokens in the Artifacts format", async () => {
    const name = unique("t");
    await store.create(name);
    for (const scope of ["read", "write"] as const) {
      const t = await store.token(name, scope, 120);
      expect(t).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/);
      const expires = Number(t.split("=")[1]);
      expect(expires).toBeGreaterThan(Date.now() / 1000 + 60);
    }
  });

  it("reads the head, the first-parent log and its commit fields", async () => {
    const [first, second] = fixture.commits;
    expect((await store.info(fixture.name)).head).toBe(second);
    const log = await store.log(fixture.name);
    expect(log.map((c) => c.sha)).toEqual([second, first]);
    expect(log[0]!.parents).toEqual([first]);
    expect(log[1]!.parents).toEqual([]);
    expect(log[0]!.message).toBe("Second commit\n\nWith a body.");
    expect(log[0]!.author).toBe("Test <test@ryke.ai>");
    expect(log[0]!.at).toBeGreaterThan(1_700_000_000_000);
    expect((await store.log(fixture.name, { limit: 1 })).map((c) => c.sha)).toEqual([second]);
    expect((await store.log(fixture.name, { ref: first })).map((c) => c.sha)).toEqual([first]);
    expect(await store.log(fixture.name, { ref: "no-such-ref" })).toEqual([]);
  });

  it("reads files at a ref, null for a missing path or ref", async () => {
    const [first, second] = fixture.commits;
    expect(await store.readFile(fixture.name, first, "src/a.ts")).toBe("export const a = 1;\n");
    expect(await store.readFile(fixture.name, second, "src/a.ts")).toBe("export const a = 2;\n");
    expect(await store.readFile(fixture.name, "main", "src/b.ts")).toBeNull();
    expect(await store.readFile(fixture.name, "0".repeat(40), "src/a.ts")).toBeNull();
  });

  it("lists files and diffs two commits with A/M/D status", async () => {
    const [first, second] = fixture.commits;
    expect(await store.files(fixture.name, first)).toEqual(["CHANGELOG.md", "ryke.json", "src/a.ts", "src/b.ts", "src/format.ts", "src/registry.ts", "test/a.test.ts"]);
    expect(await store.files(fixture.name, second)).toContain("src/c/d.ts");
    expect(await store.diff(fixture.name, first, second)).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "D" },
      { path: "src/c/d.ts", status: "A" },
    ]);
    expect(await store.diff(fixture.name, second, second)).toEqual([]);
  });

  it("forks the default branch with its history", async () => {
    const name = unique("f");
    const ref = await store.fork(fixture.name, name);
    expect(ref.name).toBe(name);
    expect((await store.info(name)).head).toBe(fixture.commits[1]);
    expect(await store.diff(name, fixture.commits[0], fixture.commits[1])).toHaveLength(3);
    expect(await code(store.fork(fixture.name, name))).toBe("ALREADY_EXISTS");
    expect(await code(store.fork(unique("nope"), unique("f")))).toBe("NOT_FOUND");
  });

  it("removes a repo once", async () => {
    const name = unique("r");
    await store.create(name);
    expect(await store.remove(name)).toBe(true);
    expect(await store.remove(name)).toBe(false);
    expect(await code(store.info(name))).toBe("NOT_FOUND");
  });
});
