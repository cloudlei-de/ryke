// Push-event ingest (PLAN.md §5.5). In production the `triggers.events` config starts the
// `ryke-ingest` workflow for every push in namespace `ryke`; locally dev/store posts the same
// envelope to /internal/events. Both end in ingestPush, which is idempotent.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { PushEvent } from "../shared/types";
import { ledger } from "./service";

export function isPushEvent(ev: unknown): ev is PushEvent {
  const e = ev as PushEvent | null;
  return (
    e?.type === "cf.artifacts.repo.pushed" &&
    typeof e.source?.repoName === "string" &&
    typeof e.payload?.ref === "string" &&
    typeof e.payload?.after === "string"
  );
}

export async function ingestPush(env: Env, ev: PushEvent): Promise<{ txn: string | null }> {
  const name = ev.source.repoName;
  // Forks are `<repo>--<txn>` and txn ids have no hyphens, so the last `--` splits them.
  const repo = name.includes("--") ? name.slice(0, name.lastIndexOf("--")) : name;
  const res = await ledger(env, repo).onPush(name, ev.payload.ref, ev.payload.after);
  return res.ok ? res.value : { txn: null };
}

export class Ingest extends WorkflowEntrypoint<Env, PushEvent> {
  async run(event: WorkflowEvent<PushEvent>, step: WorkflowStep) {
    const ev = event.payload;
    if (!isPushEvent(ev)) return { txn: null, ignored: true };
    return step.do("ingest", async () => ingestPush(this.env, ev));
  }
}
