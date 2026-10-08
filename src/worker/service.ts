// The operations behind both /api (api.ts) and /mcp (mcp.ts), so the two interfaces cannot drift.
import { screenIntent } from "./judge";
import type { Ledger, Res, Screen } from "./ledger/ledger";
import { runnerFor, runToCompletion } from "./runner/runner";
import { StoreError, storeFor } from "./store/store";

// wrangler types cannot see the class behind an `exports` binding, so the stub type is asserted here once.
export const ledger = (env: Env, repo: string): DurableObjectStub<Ledger> => {
  const ns = env.LEDGER as unknown as DurableObjectNamespace<Ledger>;
  return ns.get(ns.idFromName(repo));
};

const REPO_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const knownTxns = new Map<string, string>();

export async function repoOfTxn(env: Env, txn: string): Promise<string | null> {
  const cached = knownTxns.get(txn);
  if (cached) return cached;
  const repo = await ledger(env, "__index").indexGet(txn);
  if (repo) knownTxns.set(txn, repo);
  return repo;
}

export async function txnLedger(env: Env, txn: string): Promise<DurableObjectStub<Ledger> | null> {
  const repo = await repoOfTxn(env, txn);
  return repo ? ledger(env, repo) : null;
}

export async function begin(env: Env, repo: string, input: Parameters<Ledger["begin"]>[0]) {
  const L = ledger(env, repo);
  let screen: Screen = { warnings: [] };
  if (typeof input?.intent === "string" && input.intent.trim() !== "") {
    const candidates = await L.screenCandidates();
    if (candidates.ok) screen = await screenIntent(env, input.intent, candidates.value);
  }
  const res = await L.begin(input, screen);
  if (res.ok) {
    await ledger(env, "__index").indexPut(res.value.txn, repo);
    knownTxns.set(res.value.txn, repo);
  }
  return res;
}

// Process-mode jobs reach the local store directly, so credentials travel in the remote URL (basic
// auth, password = token before `?expires`). In container mode the Outbound gateway adds them instead.
export function authRemote(env: Env, remote: string, token: string): string {
  if (env.RYKE_RUNNER === "container") return remote;
  const u = new URL(remote);
  u.username = "x";
  u.password = token.split("?")[0]!;
  return u.toString();
}

export async function createRepo(env: Env, name: unknown, seedFrom: unknown): Promise<Res<{ repo: string; head: string }>> {
  if (!validRepoName(name)) return { ok: false, status: 422, error: "name must match [a-z0-9][a-z0-9-]{0,40}" };
  if (seedFrom !== undefined && (typeof seedFrom !== "string" || !/^[a-z0-9-]+$/.test(seedFrom)))
    return { ok: false, status: 422, error: "seedFrom must name a directory under demo/" };
  try {
    const store = storeFor(env);
    const ref = await store.create(name, { description: "Ryke trunk" });
    const token = await store.token(name, "write", 600);
    const job = await runToCompletion(runnerFor(env), "seed", { remote: authRemote(env, ref.remote, token), seed: (seedFrom as string) ?? "" }, {}, 120_000);
    const sha = (job.result as { sha?: string } | undefined)?.sha;
    if (job.state !== "done" || !sha) {
      await store.remove(name);
      return { ok: false, status: 422, error: `seeding failed: ${JSON.stringify(job.result ?? job.exitCode)}` };
    }
    const policy = await store.readFile(name, sha, "ryke.json");
    return await ledger(env, name).init(name, sha, policy);
  } catch (e) {
    if (e instanceof StoreError) return { ok: false, status: e.code === "ALREADY_EXISTS" ? 409 : 503, error: e.message };
    throw e;
  }
}

// Also guards the reserved `__index` Ledger, which no repo name can reach.
export function validRepoName(name: unknown): name is string {
  return typeof name === "string" && REPO_NAME.test(name);
}

export async function deleteRepo(env: Env, name: string): Promise<Res<{ deleted: boolean }>> {
  if (!validRepoName(name)) return { ok: false, status: 422, error: "name must match [a-z0-9][a-z0-9-]{0,40}" };
  await ledger(env, name).reset();
  try {
    return { ok: true, value: { deleted: await storeFor(env).remove(name) } };
  } catch (e) {
    if (e instanceof StoreError) return { ok: false, status: 503, error: e.message };
    throw e;
  }
}
