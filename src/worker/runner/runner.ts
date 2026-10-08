import { ContainerRunner } from "./container";
import { ProcessRunner } from "./process";

// "seed" pushes a demo app into an empty trunk; "swarm" exists only in process mode (PLAN.md §11.2).
export type JobKind = "land" | "verify" | "revert" | "agent" | "seed" | "swarm";
export type JobStatus = { state: "queued" | "running" | "done" | "failed"; exitCode?: number; result?: unknown };

export interface Runner {
  start(kind: JobKind, args: Record<string, string>, env: Record<string, string>): Promise<string>;
  status(id: string): Promise<JobStatus>;
  log(id: string, offset: number): Promise<{ text: string; next: number }>;
  cancel(id: string): Promise<void>;
}

export class RunnerError extends Error {}

export function runnerFor(env: Env): Runner {
  return env.RYKE_RUNNER === "container" ? new ContainerRunner(env) : new ProcessRunner(env.RYKE_RUNNER_URL);
}

// What each job may touch in Artifacts, as the container gateway reads it (RYKE_ALLOW_REPOS in
// container.ts; no entry means no access). Only the lander's own jobs write, and a verify job never
// does: it runs code the agents wrote.
export const access = {
  write: (repo: string) => ({ RYKE_ALLOW_REPOS: `${repo}:write` }),
  prepare: (repo: string, forks: string[]) => ({ RYKE_ALLOW_REPOS: [`${repo}:write`, ...forks.map((f) => `${f}:read`)].join(",") }),
  verify: (repo: string) => ({ RYKE_ALLOW_REPOS: `${repo}:read` }),
};

// Polls a job to its end. Land steps and repo seeding are short, so polling beats callbacks here.
export async function runToCompletion(
  runner: Runner,
  kind: JobKind,
  args: Record<string, string>,
  env: Record<string, string>,
  timeoutMs: number,
  opts: { pollMs?: number; cancelOnTimeout?: boolean } = {},
): Promise<JobStatus & { id: string }> {
  const { pollMs = 150, cancelOnTimeout = true } = opts;
  const id = await runner.start(kind, args, env);
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await runner.status(id);
    if (s.state === "done" || s.state === "failed") return { ...s, id };
    if (Date.now() > until) {
      if (cancelOnTimeout) await runner.cancel(id);
      return { state: "failed", exitCode: 124, result: { error: `${kind} timed out after ${timeoutMs} ms` }, id };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
