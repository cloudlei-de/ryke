// Starts the local platform: dev/store, dev/runner and `vite dev` (the Worker + dashboard).
// Every port moves by RYKE_PORT_OFFSET and state lives in .ryke-<offset>/ so parallel runs never
// share anything (PLAN.md §0.9).
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRunner } from "./runner/server.mjs";
import { startStore } from "./store/server.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function stackConfig(offset = Number(process.env.RYKE_PORT_OFFSET ?? 0)) {
  const stateDir = process.env.RYKE_STATE_DIR ?? join(ROOT, offset ? `.ryke-${offset}` : ".ryke");
  return {
    offset,
    stateDir,
    storePort: 8788 + offset,
    runnerPort: 8789 + offset,
    vitePort: 5173 + offset,
    apiUrl: `http://127.0.0.1:${5173 + offset}`,
    token: process.env.RYKE_TOKEN ?? "dev",
    internalSecret: process.env.RYKE_INTERNAL_SECRET ?? "dev",
  };
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    if (Date.now() > until) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function startStack({ offset, fresh = false, quiet = false } = {}) {
  const cfg = stackConfig(offset);
  if (fresh) await rm(cfg.stateDir, { recursive: true, force: true });
  await mkdir(cfg.stateDir, { recursive: true });
  const log = (line) => quiet || console.log(line);
  const store = await startStore({
    port: cfg.storePort,
    stateDir: cfg.stateDir,
    eventsUrl: `${cfg.apiUrl}/internal/events`,
    internalSecret: cfg.internalSecret,
  });
  log(`store   ${store.url}`);
  const runner = await startRunner({
    port: cfg.runnerPort,
    stateDir: cfg.stateDir,
    env: { RYKE_API_URL: cfg.apiUrl, RYKE_TOKEN: cfg.token, RYKE_PORT_OFFSET: String(cfg.offset) },
  });
  log(`runner  ${runner.url}`);
  const vite = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "dev"], {
    cwd: ROOT,
    env: { ...process.env, RYKE_PORT_OFFSET: String(cfg.offset), RYKE_STATE_DIR: cfg.stateDir },
    stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
  });
  try {
    await waitFor(`${cfg.apiUrl}/api/health`, 60_000);
  } catch (e) {
    vite.kill("SIGTERM");
    await runner.close();
    await store.close();
    throw e;
  }
  log(`worker  ${cfg.apiUrl}`);
  let closed = false;
  return {
    ...cfg,
    async close() {
      if (closed) return;
      closed = true;
      vite.kill("SIGTERM");
      await new Promise((r) => (vite.exitCode !== null ? r() : vite.once("exit", r)));
      await runner.close();
      await store.close();
    },
  };
}
