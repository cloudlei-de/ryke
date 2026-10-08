// The ryke-ingest workflow (PLAN.md §5.5): the production path for push events, run here for real.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isPushEvent } from "../src/worker/ingest";
import { beginTxn, commitToFork, newRepo, ok } from "./helpers";

const event = (repoName: string, after: string, ref = "refs/heads/main") => ({
  type: "cf.artifacts.repo.pushed" as const,
  source: { type: "artifacts.repo" as const, namespace: "ryke", repoName },
  payload: { ref, before: "0".repeat(40), after, commits: [], totalCommitsCount: 1, commitsTruncated: false },
  metadata: { eventTimestamp: new Date().toISOString() },
});

async function finished(id: string) {
  const instance = await env.INGEST.get(id);
  for (let i = 0; i < 100; i++) {
    const s = await instance.status();
    if (s.status === "complete" || s.status === "errored") return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("ingest workflow did not finish");
}

describe("isPushEvent", () => {
  it.each([
    [event("r--t_x", "a".repeat(40)), true],
    [{ ...event("r", "a"), type: "cf.artifacts.repo.created" }, false],
    [{ type: "cf.artifacts.repo.pushed", source: { repoName: "r" } }, false],
    [{ type: "cf.artifacts.repo.pushed", payload: { ref: "x", after: "y" } }, false],
    [null, false],
    ["x", false],
  ])("%j → %s", (ev, expected) => {
    expect(isPushEvent(ev)).toBe(expected);
  });
});

describe("Ingest workflow", () => {
  it("records the fork head for the transaction that owns the fork", async () => {
    const t = await newRepo();
    const b = await beginTxn(t);
    const sha = await commitToFork(b, { "src/w.ts": "w\n" });
    const instance = await env.INGEST.create({ params: event(`${t.name}--${b.txn}`, sha) });
    const s = await finished(instance.id);
    expect(s.status).toBe("complete");
    expect(s.output).toEqual({ txn: b.txn });
    expect(ok(await t.L.status(b.txn)).txn.head).toBe(sha);
  });

  it("ignores anything that is not a push event", async () => {
    const instance = await env.INGEST.create({ params: { type: "cf.artifacts.repo.created" } as never });
    const s = await finished(instance.id);
    expect(s.output).toEqual({ txn: null, ignored: true });
  });
});
