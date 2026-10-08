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
  return new ProcessRunner(env.RYKE_RUNNER_URL);
}

// Polls a job to its end. Land steps and repo seeding are short, so polling beats callbacks here.
export async function runToCompletion(
  runner: Runner,
  kind: JobKind,
  args: Record<string, string>,
  env: Record<string, string>,
  timeoutMs: number,
  pollMs = 150,
): Promise<JobStatus & { id: string }> {
  const id = await runner.start(kind, args, env);
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await runner.status(id);
    if (s.state === "done" || s.state === "failed") return { ...s, id };
    if (Date.now() > until) {
      await runner.cancel(id);
      return { state: "failed", exitCode: 124, result: { error: `${kind} timed out after ${timeoutMs} ms` }, id };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
