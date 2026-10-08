// CLI entry for the local process runner; all configuration comes from RYKE_* env vars (PLAN.md §3.3).
import { startRunner } from "./server.mjs";

const { env } = process;
const runner = await startRunner({
  port: Number(env.RYKE_RUNNER_PORT || 8789),
  host: env.RYKE_RUNNER_HOST || "127.0.0.1",
  stateDir: env.RYKE_STATE_DIR || ".ryke",
  // Unset means the default next to this file, which startRunner owns.
  scriptsDir: env.RYKE_SCRIPTS_DIR || undefined,
  concurrency: Number(env.RYKE_RUNNER_CONCURRENCY || 6),
  keepJobs: env.RYKE_KEEP_JOBS === "1",
});
console.log(`ryke runner listening on ${runner.url}`);

// Jobs run in their own process groups, so Ctrl-C in the terminal does not reach them; kill them here.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await runner.close();
    process.exit(0);
  });
}
