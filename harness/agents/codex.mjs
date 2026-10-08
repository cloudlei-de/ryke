// The Codex agent (`swarm.mjs --mode codex`): the claude agent's runner job with `codex exec` in place
// of Claude Code. Everything else, the transaction, the job, the retries and the result record, is the
// claude agent's (harness/agents/claude.mjs).
import { preflight as cliPreflight, runTask as cliTask } from "./claude.mjs";

export const runTask = (ctx) => cliTask({ ...ctx, cli: "codex" });
export const preflight = (ctx) => cliPreflight({ ...ctx, cli: "codex" });
