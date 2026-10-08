// vitest globalSetup: real dev/store and dev/runner for the workerd suites (PLAN.md §3), plus the
// git helper the suites use to commit, and a fixture repo with known history for the store contract.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRunner } from "../../dev/runner/server.mjs";
import { startStore } from "../../dev/store/server.mjs";
import { startGitHelper } from "./git-helper.mjs";

// The same value vitest.config.ts gives the Worker as RYKE_INTERNAL_SECRET, which the store's control API requires.
const INTERNAL_SECRET = "test-secret";

async function fixture(storeUrl, gitUrl) {
  const call = async (path, body) => {
    const r = await fetch(storeUrl + path, { method: "POST", headers: { "content-type": "application/json", "x-ryke-internal": INTERNAL_SECRET }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const repo = await call("/v1/repos", { name: "fixture" });
  const { token } = await call("/v1/repos/fixture/tokens", { scope: "write", ttl: 3600 });
  const push = async (files, message) => {
    const r = await fetch(`${gitUrl}/commit`, { method: "POST", body: JSON.stringify({ remote: repo.remote, token, files, message }) });
    if (!r.ok) throw new Error(`fixture commit: ${await r.text()}`);
    return (await r.json()).sha;
  };
  const first = await push(
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
  const second = await push({ "src/a.ts": "export const a = 2;\n", "src/b.ts": null, "src/c/d.ts": "export const d = 1;\n" }, "Second commit\n\nWith a body.");
  return { name: "fixture", commits: [first, second] };
}

export default async function ({ provide }) {
  const ports = JSON.parse(process.env.RYKE_TEST_PORTS);
  const stateDir = await mkdtemp(join(tmpdir(), "ryke-test-"));
  const store = await startStore({ port: ports.store, stateDir, eventsUrl: "", internalSecret: INTERNAL_SECRET });
  const runner = await startRunner({ port: ports.runner, stateDir });
  const helper = await startGitHelper(ports.git);
  provide("fixture", await fixture(`http://127.0.0.1:${ports.store}`, `http://127.0.0.1:${ports.git}`));
  return async () => {
    await helper.close();
    await runner.close();
    await store.close();
    await rm(stateDir, { recursive: true, force: true });
  };
}
