import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

declare const process: { env: Record<string, string | undefined> };

// dev/stack.mjs passes the port offset; the Worker must talk to the store and runner of the same stack.
const offset = Number(process.env.RYKE_PORT_OFFSET ?? 0);
const stateDir = process.env.RYKE_STATE_DIR ?? (offset ? `.ryke-${offset}` : ".ryke");

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      persistState: { path: `${stateDir}/wrangler` },
      config: (cfg) => ({
        vars: {
          ...cfg.vars,
          RYKE_STORE_URL: `http://127.0.0.1:${8788 + offset}`,
          RYKE_RUNNER_URL: `http://127.0.0.1:${8789 + offset}`,
          RYKE_JEV: process.env.RYKE_JEV ?? "recorded",
        },
      }),
    }),
  ],
  server: { port: 5173 + offset, strictPort: true, host: "127.0.0.1" },
});
