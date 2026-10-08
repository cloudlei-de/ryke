// CLI entry for the local Artifacts stand-in. Everything is configured through env so
// dev/all.mjs and the e2e scripts can start it with a per-run port and state dir.
import { startStore } from "./server.mjs";

const env = process.env;
const port = Number.parseInt(env.RYKE_STORE_PORT ?? "8788", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`ryke store: invalid RYKE_STORE_PORT ${JSON.stringify(env.RYKE_STORE_PORT)}`);
  process.exit(1);
}

const store = await startStore({
  port,
  host: env.RYKE_STORE_HOST || "127.0.0.1",
  stateDir: env.RYKE_STATE_DIR || ".ryke",
  namespace: env.RYKE_NAMESPACE || "ryke",
  // An explicitly empty RYKE_EVENTS_URL turns push events off, so only undefined gets the default.
  eventsUrl: env.RYKE_EVENTS_URL ?? "http://127.0.0.1:5173/internal/events",
  internalSecret: env.RYKE_INTERNAL_SECRET || "dev",
});
console.log(`ryke store listening on ${store.url}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    store.close().finally(() => process.exit(0));
  });
}
