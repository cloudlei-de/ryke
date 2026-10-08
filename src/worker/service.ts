// The operations behind both /api (api.ts) and /mcp (mcp.ts), so the two interfaces cannot drift.
import { screenIntent } from "./judge";
import type { Ledger, Res, Screen } from "./ledger/ledger";
import { RunnerError, runnerFor, runToCompletion } from "./runner/runner";
import { StoreError, storeFor, type RepoStore } from "./store/store";

// wrangler types cannot see the class behind an `exports` binding, so the stub type is asserted here once.
export const ledger = (env: Env, repo: string): DurableObjectStub<Ledger> => {
  const ns = env.LEDGER as unknown as DurableObjectNamespace<Ledger>;
  return ns.get(ns.idFromName(repo));
};

const REPO_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const NAME_ERROR = "name must match [a-z0-9][a-z0-9-]{0,40}";
const SEED_TIMEOUT_MS = 120_000;
const FORK_BATCH = 16;
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

// The registry of repos lives in the txn → repo index under `repo:<name>` keys, so a public GET can
// tell a repo from an arbitrary name without creating that name's Durable Object. The index has no
// delete, so a removed repo is marked with "", which reads as absent. A positive answer may outlive a
// delete made in another isolate; that only costs a lookup in the repo's own Ledger, which then says
// "not initialised" itself.
const knownRepos = new Set<string>();
const registryKey = (name: string) => `repo:${name}`;

export async function registerRepo(env: Env, name: string): Promise<void> {
  await ledger(env, "__index").indexPut(registryKey(name), name);
  knownRepos.add(name);
}

async function forgetRepo(env: Env, name: string): Promise<void> {
  knownRepos.delete(name);
  await ledger(env, "__index").indexPut(registryKey(name), "");
}

export async function repoKnown(env: Env, name: string): Promise<boolean> {
  if (knownRepos.has(name)) return true;
  if (!(await ledger(env, "__index").indexGet(registryKey(name)))) return false;
  knownRepos.add(name);
  return true;
}

export async function begin(env: Env, repo: string, input: Parameters<Ledger["begin"]>[0]) {
  const L = ledger(env, repo);
  let screen: Screen = { warnings: [] };
  let reserved: string | undefined;
  if (typeof input?.intent === "string" && input.intent.trim() !== "") {
    const c = await L.screenCandidates(input.intent);
    if (c.ok) {
      reserved = c.value.txn;
      screen = await screenIntent(env, input.intent, c.value.candidates);
    }
  }
  const res = await L.begin(input, screen, reserved);
  if (!res.ok) return res;
  await ledger(env, "__index").indexPut(res.value.txn, repo);
  knownTxns.set(res.value.txn, repo);
  // A rejected transaction is over before it started; there is nothing for a token to do.
  if (res.value.state === "rejected") return res;
  return { ...res, value: { ...res.value, agentToken: await agentToken(env, res.value.txn) } };
}

// An agent job runs code nobody reviewed (Claude's Bash tool sees the job's environment), so it gets a
// token that works only on its own transaction's agent routes (api.ts), never the admin RYKE_TOKEN,
// which can also approve, reject, recall and delete.
const AGENT_TOKEN = /^rtx\.(t_[0-9a-z]+)\.([A-Za-z0-9_-]{43})$/;
const utf8 = (s: string) => new TextEncoder().encode(s);

function agentKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(`ryke-agent:${env.RYKE_TOKEN}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function agentToken(env: Env, txn: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await agentKey(env), utf8(txn)));
  return `rtx.${txn}.${btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

// The transaction a well-formed, correctly signed agent token is for; null for anything else.
export async function agentTokenTxn(env: Env, token: string): Promise<string | null> {
  const m = AGENT_TOKEN.exec(token);
  if (!m || !env.RYKE_TOKEN) return null;
  const mac = Uint8Array.from(atob(m[2]!.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
  return (await crypto.subtle.verify("HMAC", await agentKey(env), mac, utf8(m[1]!))) ? m[1]! : null;
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
  if (!validRepoName(name)) return { ok: false, status: 422, error: NAME_ERROR };
  if (seedFrom !== undefined && (typeof seedFrom !== "string" || !/^[a-z0-9-]+$/.test(seedFrom)))
    return { ok: false, status: 422, error: "seedFrom must name a directory under demo/" };
  let store: RepoStore | undefined;
  let created = false;
  try {
    store = storeFor(env);
    const ref = await store.create(name, { description: "Ryke trunk" });
    created = true;
    const token = await store.token(name, "write", 600);
    const job = await runToCompletion(runnerFor(env), "seed", { remote: authRemote(env, ref.remote, token), seed: (seedFrom as string) ?? "" }, {}, SEED_TIMEOUT_MS);
    const sha = (job.result as { sha?: string } | undefined)?.sha;
    if (job.state !== "done" || !sha) {
      await unmake(store, name);
      // 124 is the timeout (the poll's or the script's own): the runner is slow or stuck, which is an
      // outage to retry, not a seed the caller got wrong.
      if (job.exitCode === 124) return { ok: false, status: 503, error: `seeding timed out: ${JSON.stringify(job.result ?? job.exitCode)}` };
      return { ok: false, status: 422, error: `seeding failed: ${JSON.stringify(job.result ?? job.exitCode)}` };
    }
    const policy = await store.readFile(name, sha, "ryke.json");
    let init: Res<{ repo: string; head: string }>;
    try {
      init = await ledger(env, name).init(name, sha, policy);
      if (init.ok) await registerRepo(env, name);
    } catch (e) {
      // The Ledger is a Durable Object: it can be unreachable or overloaded. Whatever it managed to do
      // before failing is undone, so a retry starts clean.
      await unmake(store, name);
      try {
        await ledger(env, name).reset();
      } catch {
        // Unreachable as before; the next `fresh: true` clears it.
      }
      return { ok: false, status: 503, error: `ledger unavailable: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!init.ok) await unmake(store, name);
    return init;
  } catch (e) {
    // Whatever broke once the trunk existed, the name must not stay taken by a repo with no ledger.
    if (created && store) await unmake(store, name);
    if (e instanceof StoreError) return { ok: false, status: e.code === "ALREADY_EXISTS" ? 409 : 503, error: e.message };
    if (e instanceof RunnerError) return { ok: false, status: 503, error: e.message };
    throw e;
  }
}

// Best effort: the failure being reported is the one that matters, and a trunk that survives is
// replaced by `fresh: true`.
const unmake = (store: RepoStore, name: string) => store.remove(name).catch(() => false);

// Also guards the reserved `__index` Ledger, which no repo name can reach.
export function validRepoName(name: unknown): name is string {
  return typeof name === "string" && REPO_NAME.test(name);
}

// Fork repos (`<repo>--<txn>`) belong to the repo's transactions and nothing else removes them; the
// Ledger is the only list of their names, so they go before it is reset. Failures are ignored: an
// orphaned fork wastes space, while refusing to delete the repo over one would strand it.
async function removeForks(env: Env, forks: string[]): Promise<void> {
  try {
    const store = storeFor(env);
    for (let i = 0; i < forks.length; i += FORK_BATCH) await Promise.allSettled(forks.slice(i, i + FORK_BATCH).map((f) => store.remove(f)));
  } catch {
    // No store to talk to: the trunk removal below reports that.
  }
}

export async function deleteRepo(env: Env, name: string): Promise<Res<{ deleted: boolean }>> {
  if (!validRepoName(name)) return { ok: false, status: 422, error: NAME_ERROR };
  const L = ledger(env, name);
  const forks = await L.forks();
  if (forks.ok) await removeForks(env, forks.value);
  await L.reset();
  await forgetRepo(env, name);
  try {
    return { ok: true, value: { deleted: await storeFor(env).remove(name) } };
  } catch (e) {
    if (e instanceof StoreError) return { ok: false, status: 503, error: e.message };
    throw e;
  }
}
