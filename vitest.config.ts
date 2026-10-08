import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { createServer } from "node:net";
import { defineConfig } from "vitest/config";

declare const process: { env: Record<string, string | undefined> };

// Each vitest run gets its own free ports for the store, runner and git helper that
// test/setup/stack.mjs starts, so parallel runs (subagents, verifiers, dev:all) never collide.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export default defineConfig(async () => {
  const [store, runner, git] = [await freePort(), await freePort(), await freePort()];
  process.env.RYKE_TEST_PORTS = JSON.stringify({ store, runner, git });
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            RYKE_STORE_URL: `http://127.0.0.1:${store}`,
            RYKE_RUNNER_URL: `http://127.0.0.1:${runner}`,
            RYKE_TEST_GIT_URL: `http://127.0.0.1:${git}`,
            RYKE_JEV: "recorded",
            RYKE_TOKEN: "test-token",
            RYKE_INTERNAL_SECRET: "test-secret",
            TYPESAFE_API_KEY: "",
            // test/store-contract.test.ts runs against a real Artifacts binding when this says "artifacts" (docs/deploy.md).
            RYKE_STORE_CONTRACT: process.env.RYKE_STORE_CONTRACT ?? "",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      exclude: ["test/node/**", "node_modules/**"],
      globalSetup: ["./test/setup/stack.mjs"],
      testTimeout: 30_000,
    },
  };
});
