// The RepoStore contract (PLAN.md §3.1). CI runs it against the local adapter; with
// RYKE_STORE_CONTRACT=artifacts it runs against the Artifacts binding instead. The same cases run
// against the Artifacts adapter on an in-memory fake of the binding in test/artifacts-fake.test.ts.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { ArtifactsStore } from "../src/worker/store/artifacts";
import { LocalStore } from "../src/worker/store/local";
import { StoreError, storeFor, type RepoStore } from "../src/worker/store/store";
import { gitHelper } from "./helpers";
import { storeContract } from "./store-contract";

const local = new LocalStore(env.RYKE_STORE_URL, env.RYKE_INTERNAL_SECRET);
const store: RepoStore = env.RYKE_STORE_CONTRACT === "artifacts" && env.ARTIFACTS ? new ArtifactsStore(env.ARTIFACTS) : local;
const fixture = inject("fixture");

storeContract(env.RYKE_STORE_CONTRACT === "artifacts" && env.ARTIFACTS ? "Artifacts binding" : "local store", async () => ({
  store,
  fixture,
  async commit(repo, files, message) {
    const [info, token] = await Promise.all([store.info(repo), store.token(repo, "write", 600)]);
    return (await gitHelper<{ sha: string }>("/commit", { remote: info.remote, token, files, message })).sha;
  },
}));

// The local store's control API is a trust boundary: process-mode jobs run candidate code on the same
// host and can reach its port, so every call must carry the internal secret (dev/store/server.mjs).
describe("LocalStore and the store's internal secret", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is refused by a store that expects another secret, with a message that names the cause", async () => {
    for (const secret of ["wrong-secret", "", undefined]) {
      const refused = new LocalStore(env.RYKE_STORE_URL, secret as string);
      const e = await refused.info(fixture.name).catch((x: unknown) => x);
      expect(e, String(secret)).toBeInstanceOf(StoreError);
      expect((e as StoreError).code).toBe("UNAVAILABLE");
      expect((e as StoreError).message).toContain("internal secret");
    }
  });

  it("sends the secret with every kind of call", async () => {
    const real = globalThis.fetch;
    const seen: [string, string | null][] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      seen.push([`${req.method} ${new URL(req.url).pathname}`, req.headers.get("x-ryke-internal")]);
      return real(input as RequestInfo, init);
    });
    const name = `secret-${Date.now().toString(36)}`;
    await local.create(name);
    await local.info(name);
    await local.token(name, "read", 60);
    await local.log(name);
    await local.readFile(fixture.name, "main", "src/a.ts");
    await local.files(fixture.name, "main");
    await local.diff(fixture.name, fixture.commits[0], fixture.commits[1]);
    await local.fork(fixture.name, `${name}-fork`);
    await local.remove(`${name}-fork`);
    await local.remove(name);
    expect(seen.map(([call]) => call)).toEqual([
      "POST /v1/repos",
      `GET /v1/repos/${name}`,
      `POST /v1/repos/${name}/tokens`,
      `GET /v1/repos/${name}/log`,
      `GET /v1/repos/${fixture.name}/file`,
      `GET /v1/repos/${fixture.name}/files`,
      `GET /v1/repos/${fixture.name}/diff`,
      `POST /v1/repos/${fixture.name}/fork`,
      `DELETE /v1/repos/${name}-fork`,
      `DELETE /v1/repos/${name}`,
    ]);
    for (const [call, header] of seen) expect(header, call).toBe(env.RYKE_INTERNAL_SECRET);
  });

  it("is what storeFor builds for the local store", async () => {
    expect(await storeFor(env).info(fixture.name)).toMatchObject({ name: fixture.name, head: fixture.commits[1] });
    const wrong = Object.create(env, { RYKE_INTERNAL_SECRET: { value: "not-the-secret" } }) as Env;
    await expect(storeFor(wrong).info(fixture.name)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
