// Shared fixtures for the workerd suites: a fresh trunk forked from the fixture repo, a Ledger with
// manual landing, and real git commits through the Node git helper (test/setup/git-helper.mjs).
import { env } from "cloudflare:workers";
import { inject } from "vitest";
import type { Op } from "../src/shared/types";
import type { Ledger } from "../src/worker/ledger/ledger";
import { ledger, registerRepo } from "../src/worker/service";
import { LocalStore } from "../src/worker/store/local";

export const store = new LocalStore(env.RYKE_STORE_URL, env.RYKE_INTERNAL_SECRET);
export const fixture = inject("fixture");
export const AUTH = { authorization: `Bearer ${env.RYKE_TOKEN}` };

export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

type Value<R> = R extends { ok: true; value: infer T } ? T : never;

export function ok<R extends { ok: boolean }>(res: R): Value<R> {
  const r = res as unknown as { ok: boolean; value: Value<R>; status?: number; error?: string };
  if (!r.ok) throw new Error(`expected ok, got ${r.status}: ${r.error}`);
  return r.value;
}

export function errorText(res: unknown): string {
  return (res as { error?: string }).error ?? "";
}

export function err(res: { ok: boolean; status?: number; error?: string }): number {
  if (res.ok) throw new Error("expected an error result");
  return res.status!;
}

export async function gitHelper<T>(path: "/commit" | "/push", body: unknown): Promise<T> {
  const r = await fetch(`${env.RYKE_TEST_GIT_URL}${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`git helper ${path}: ${await r.text()}`);
  return (await r.json()) as T;
}

export type TestRepo = { name: string; L: DurableObjectStub<Ledger>; head: string };

// A trunk with the fixture's two commits; the Ledger starts at the fixture head with autoland off so
// tests drive trains by hand.
export async function newRepo(opts: { autoland?: boolean; policy?: string } = {}): Promise<TestRepo> {
  const name = unique("r");
  await store.fork(fixture.name, name);
  const head = (await store.info(name)).head!;
  const L = ledger(env, name);
  const policy = opts.policy ?? (await store.readFile(name, head, "ryke.json"));
  ok(await L.init(name, head, policy, { autoland: opts.autoland ?? false }));
  // Public reads only answer for registered repos, which is what POST /api/repos does after init.
  await registerRepo(env, name);
  return { name, L, head };
}

export async function beginTxn(t: TestRepo, agent = "agent-01", intent = "change something") {
  return ok(await t.L.begin({ agent, intent, model: "test-model" }));
}

// `from` fetches the base from trunk, the way an agent syncs its fork to a retry snapshot.
export async function commitToFork(
  begun: { remote: string; token: string; snapshot: string },
  files: Record<string, string | null>,
  opts: { force?: boolean; from?: { remote: string; token: string } } = {},
) {
  return (await gitHelper<{ sha: string }>("/commit", { remote: begun.remote, token: begun.token, base: begun.snapshot, files, ...opts })).sha;
}

// Lands a ready transaction the way the Land workflow does: form a train, push the fork head to
// trunk main, commit the train.
export async function landAlone(t: TestRepo, txn: string, fork: { remote: string; token: string }, sha: string, paths: string[]) {
  const train = ok(await t.L.formTrain()).train!;
  const trunkToken = await store.token(t.name, "write", 600);
  const trunk = await store.info(t.name);
  await gitHelper("/push", { from: fork, sha, to: { remote: trunk.remote, token: trunkToken } });
  ok(await t.L.commitTrain(train, sha, [{ txn, sha, paths }]));
  ok(await t.L.trainDone(train, "landed"));
  return train;
}

// Typed by hand: Op payloads are `any`, which sends the RPC stub types past TypeScript's depth limit.
export async function opsPage(t: TestRepo, after: number, limit: number): Promise<{ ops: Op[]; last: number }> {
  return ok((await t.L.ops(after, limit)) as unknown as { ok: true; value: { ops: Op[]; last: number } });
}

export async function opsOf(t: TestRepo, kind?: string): Promise<Op[]> {
  const all = (await opsPage(t, 0, 5000)).ops;
  return kind ? all.filter((o) => o.kind === kind) : all;
}

// ---------------------------------------------------------------- HTTP (api.test.ts, mcp.test.ts)
// The Worker is called in-process through exports.default, the way the platform calls it. These
// imports sit here because the section above is shared with the Ledger suites.
import { exports } from "cloudflare:workers";
import type { BeginResult } from "../src/worker/ledger/ledger";

// Answers are parsed JSON whose shape each test asserts, so the loose type is deliberate.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export type HttpResult = { status: number; headers: Headers; text: string; body: Json };

// `auth` is true (the test token, the default), false (no header) or a literal Authorization value.
// `raw` sends a body that is not JSON-encoded from `body`.
export async function http(
  method: string,
  path: string,
  opts: { body?: unknown; raw?: string; auth?: boolean | string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...opts.headers };
  const auth = opts.auth ?? true;
  if (auth === true) headers.authorization = AUTH.authorization;
  else if (typeof auth === "string") headers.authorization = auth;
  const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (payload !== undefined) headers["content-type"] = "application/json";
  const res = await exports.default.fetch(`http://ryke.test${path}`, { method, headers, body: payload });
  const text = await res.text();
  let body: Json = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Hono's plain-text 404 and similar answers keep body null; callers assert on `text` then.
  }
  return { status: res.status, headers: res.headers, text, body };
}

// Opens a transaction through POST /api/repos/:repo/txns, which (unlike Ledger.begin) also registers
// it in the txn → repo index, so /api/txns/:id and the MCP tools can find it.
// The default intent is random: begin screens each intent against the live ones with a trigram
// prefilter, and unrelated random text never reaches the judge, so no warnings or extra ops appear.
export async function apiBegin(repo: string, agent = "agent-01", intent = Math.random().toString(36).slice(2, 14), extra: Record<string, unknown> = {}): Promise<BeginResult> {
  const r = await http("POST", `/api/repos/${repo}/txns`, { body: { agent, intent, model: "test-model", ...extra } });
  if (r.status !== 201) throw new Error(`begin over HTTP: ${r.status} ${r.text}`);
  return r.body as BeginResult;
}

// Lands another agent's change on trunk, directly through the Ledger so it needs no HTTP. Call it
// after the transaction under test began, which leaves that transaction's snapshot behind trunk.
export async function landOnTrunk(t: TestRepo, files: Record<string, string>, agent = "lander"): Promise<{ txn: string; sha: string }> {
  const paths = Object.keys(files);
  const b = await beginTxn(t, agent, `land ${paths.join(", ")}`);
  ok(await t.L.reads(b.txn, paths));
  const sha = await commitToFork(b, files);
  ok(await t.L.submit(b.txn, { head: sha }));
  await landAlone(t, b.txn, b, sha, paths);
  return { txn: b.txn, sha };
}

// Builds a fixture on first use and reuses it, for tables of tests that only read or are refused:
// each row then skips a fork and a ledger init.
export function lazy<T>(make: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= make());
}
