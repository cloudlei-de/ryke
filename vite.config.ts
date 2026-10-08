import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

declare const process: { env: Record<string, string | undefined> };

// dev/stack.mjs passes the port offset; the Worker must talk to the store and runner of the same stack.
const offset = Number(process.env.RYKE_PORT_OFFSET ?? 0);
const stateDir = process.env.RYKE_STATE_DIR ?? (offset ? `.ryke-${offset}` : ".ryke");
// `npm run deploy` builds with CLOUDFLARE_ENV=production; the local overrides must not leak into that build.
const production = process.env.CLOUDFLARE_ENV === "production";
// A stack started by dev/stack.mjs (tests, e2e, the harness) must not reload its Worker when someone
// edits the tree under a running swarm; `npm run dev:all` opts back in with RYKE_WATCH=1.
const watch = !process.env.RYKE_STATE_DIR || process.env.RYKE_WATCH === "1";

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      persistState: { path: `${stateDir}/wrangler` },
      config: (cfg) =>
        production
          ? {}
          : {
              vars: {
                ...cfg.vars,
                RYKE_STORE_URL: `http://127.0.0.1:${8788 + offset}`,
                RYKE_RUNNER_URL: `http://127.0.0.1:${8789 + offset}`,
                RYKE_JEV: process.env.RYKE_JEV ?? "recorded",
                // A fresh clone has no .dev.vars; these match dev/stack.mjs's defaults.
                RYKE_TOKEN: process.env.RYKE_TOKEN ?? "dev",
                RYKE_INTERNAL_SECRET: process.env.RYKE_INTERNAL_SECRET ?? "dev",
              },
            },
    }),
  ],
  server: {
    port: 5173 + offset,
    strictPort: true,
    host: "127.0.0.1",
    // Every git object in a stack's state dir would otherwise cost an inotify watch.
    watch: watch ? { ignored: ["**/.ryke/**", "**/.ryke-*/**", "**/.wrangler/**", "**/dist/**"] } : null,
  },
});
