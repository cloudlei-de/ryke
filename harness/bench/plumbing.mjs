// What the lock and queue baselines share with each other and with Ryke's own lander: the store and
// runner control APIs, and the three runner jobs (land.sh prepare, verify.sh, land.sh push) that land
// one change. Ryke runs the very same scripts for its trains, so the comparison is about policy.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../lib/gitops.mjs";

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// Same shape the Worker uses for process-mode jobs: credentials ride in the URL's userinfo.
export function authRemote(remote, token) {
  const u = new URL(remote);
  u.username = "x";
  u.password = token.split("?")[0];
  return u.toString();
}

// The store's control API wants the internal secret the Worker holds; the runner's API is open.
export function controlPlane({ storeUrl, runnerUrl, secret = "dev", fetchImpl = fetch, pollMs = 100 }) {
  async function call(base, method, path, body, headers = {}) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  const store = (method, path, body) => call(storeUrl, method, path, body, { "x-ryke-internal": secret });
  return {
    info: (name) => store("GET", `/v1/repos/${name}`),
    fork: (source, name) => store("POST", `/v1/repos/${source}/fork`, { name }),
    token: async (name, scope, ttl = 3600) => (await store("POST", `/v1/repos/${name}/tokens`, { scope, ttl })).token,
    remove: (name) => store("DELETE", `/v1/repos/${name}`),
    file: async (name, ref, path) => (await store("GET", `/v1/repos/${name}/file?${new URLSearchParams({ ref, path })}`)).content,
    // Runs a job on the dev runner and waits for it; the result is the script's last JSON line.
    async job(kind, args, { signal, timeoutMs = 10 * 60_000 } = {}) {
      const { id } = await call(runnerUrl, "POST", "/v1/jobs", { kind, args, env: {} });
      const until = Date.now() + timeoutMs;
      for (;;) {
        const job = await call(runnerUrl, "GET", `/v1/jobs/${id}`);
        if (job.state === "done" || job.state === "failed") return job;
        if (Date.now() > until) throw new Error(`${kind} job ${id} still ${job.state} after ${timeoutMs} ms`);
        await sleep(pollMs, signal);
      }
    },
  };
}

// First come, first served, one holder at a time. A waiter can be cancelled, so a cell that ends
// does not leave agents parked on a lock nobody will release.
export class Mutex {
  #held = false;
  #waiting = [];

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.#held) {
      this.#held = true;
      return Promise.resolve(() => this.#release());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve: () => resolve(() => this.#release()), reject };
      const onAbort = () => {
        const i = this.#waiting.indexOf(waiter);
        if (i >= 0) this.#waiting.splice(i, 1);
        reject(signal.reason);
      };
      waiter.cleanup = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(waiter);
    });
  }

  #release() {
    const next = this.#waiting.shift();
    if (next) {
      next.cleanup();
      next.resolve();
    } else this.#held = false;
  }

  get waiting() {
    return this.#waiting.length;
  }
}

// One consumer, items in arrival order: the merge queue. enqueue resolves with the worker's answer.
export class FifoQueue {
  #items = [];
  #running = false;

  constructor(worker) {
    this.worker = worker;
  }

  enqueue(item) {
    return new Promise((resolve, reject) => {
      this.#items.push({ item, resolve, reject });
      void this.#drain();
    });
  }

  get length() {
    return this.#items.length;
  }

  async #drain() {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let next = this.#items.shift(); next; next = this.#items.shift()) {
        try {
          next.resolve(await this.worker(next.item));
        } catch (e) {
          next.reject(e);
        }
      }
    } finally {
      this.#running = false;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Landing one change the way the lock and queue baselines do: prepare, verify, push.
// ---------------------------------------------------------------------------------------------

// t = { id, agent, model, intent, attempt, snapshot, head, fork: { remote, token } }
// Returns { landed: true, sha } or { landed: false, cause, paths?, failures? }, each with `verified`: whether a
// verify job ran. `stats.verifyMs` collects the durations of those jobs.
export async function landOne(ctl, { trunk, policy, t, stats, signal }) {
  const info = await ctl.info(trunk);
  const token = await ctl.token(trunk, "write", 3600);
  const remote = authRemote(info.remote, token);
  const ref = `refs/ryke/candidates/${t.id}/${t.attempt}`;
  const job = (kind, args) => ctl.job(kind, args, { signal });
  const answer = (j, what) => {
    if (!j.result || j.result.ok === false) throw new Error(`${what} job failed (exit ${j.exitCode}): ${j.result?.error ?? "no result"}`);
    return j.result;
  };

  const prepared = answer(
    await job("land", {
      mode: "prepare",
      trunk: remote,
      base: info.head,
      ref,
      union: JSON.stringify(policy.union),
      txns: JSON.stringify([
        {
          id: t.id,
          fork: authRemote(t.fork.remote, t.fork.token),
          head: t.head,
          attempt: t.attempt,
          snapshot: t.snapshot,
          agent: t.agent,
          model: t.model,
          intent: t.intent,
        },
      ]),
    }),
    "prepare",
  );
  if (prepared.applied.length === 0) {
    const c = prepared.conflicts[0];
    return { landed: false, cause: "text_conflict", verified: false, paths: c?.paths ?? [], error: c?.error };
  }

  const verified = answer(await job("verify", { remote, ref: prepared.candidate, command: policy.verify, timeout: String(policy.verifyTimeoutSeconds) }), "verify");
  stats.verifyMs.push(verified.durationMs);
  if (!verified.pass) {
    return { landed: false, cause: "failed_verify", verified: true, failures: (verified.tests?.failures ?? []).map((f) => f.name) };
  }

  const pushed = answer(await job("land", { mode: "push", trunk: remote, candidate: prepared.candidate, notes: "[]", cleanup: JSON.stringify([ref]) }), "push");
  // The lander is the only writer, so a rejected push means something else touched trunk: retry as a conflict.
  if (!pushed.pushed) return { landed: false, cause: "text_conflict", verified: true, paths: [], error: "push rejected" };
  return { landed: true, verified: true, sha: prepared.candidate };
}

// ---------------------------------------------------------------------------------------------
// The trunk check after a cell: the head and up to ten evenly spaced earlier commits must pass the
// repo's own verify command.
// ---------------------------------------------------------------------------------------------

export function pickCommits(commits, intermediate = 10) {
  if (commits.length === 0) return [];
  const head = commits.at(-1);
  const earlier = commits.slice(0, -1);
  const picked =
    earlier.length <= intermediate ? earlier : Array.from({ length: intermediate }, (_, i) => earlier[Math.floor((i * earlier.length) / intermediate)]);
  return [...picked, head];
}

export async function checkTrunk(ctl, { repo, policy, runCommand, intermediate = 10, parallel = 2 }) {
  const ws = await Workspace.create("checker");
  const root = await mkdtemp(join(tmpdir(), "ryke-bench-check-"));
  try {
    const info = await ctl.info(repo);
    const token = await ctl.token(repo, "read", 3600);
    const head = await ws.fetch(info.remote, token, "main");
    const commits = (await ws.git("rev-list", "--first-parent", "--reverse", head)).split("\n").filter(Boolean);
    const picked = pickCommits(commits, intermediate);
    const checked = new Array(picked.length);
    // The agents are gone, so the machine is quiet and two checkouts can be tested at once.
    const adding = new Mutex();
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < picked.length; i = next++) {
        const dir = join(root, `c${i}`);
        const release = await adding.acquire();
        try {
          await ws.git("worktree", "add", "-q", "--detach", dir, picked[i]);
        } finally {
          release();
        }
        const r = await runCommand(dir, policy.verify, policy.verifyTimeoutSeconds * 1000);
        checked[i] = { sha: picked[i], pass: r.pass, failing: r.failing ?? [], tail: r.tail ?? "" };
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, picked.length) }, worker));
    return { head, commits: commits.length, checked, breakages: checked.filter((c) => !c.pass).length };
  } finally {
    await rm(root, { recursive: true, force: true });
    await ws.remove();
  }
}
