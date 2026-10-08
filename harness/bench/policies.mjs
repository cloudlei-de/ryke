// The three landing policies, behind the one interface the synthetic agent speaks (PLAN.md §11.3):
//
//   open(agent, ctx)            start a change; may wait (lock). Resolves null once the cell is over.
//   report(session, paths)      tell the platform what was read. Resolves { warned }.
//   think(session, ms, signal)  spend the think time. Resolves { early, spentMs }; early when a stale
//                               warning cut it short (Ryke only).
//   submit(session, head, sig)  hand in the pushed commit and wait for the outcome:
//                               { landed } | { landed: false, cause, retry, maxAttempts? } | { abandoned }
//   retry(session, signal)      start the next attempt on the current trunk
//   close(session)              release whatever the session holds
//
// Only Ryke has the two contention tools, so only its policy defines them:
//   admit(session, paths, sig)  take write leases on the paths, waiting while a hot path is held (§7.2)
//   refresh(session)            move an open change onto the current trunk without spending an attempt
//
// A session is { id, attempt, snapshot, source: { remote, token, ref }, sink: { remote, token }, agent, model }.
// The agent fetches `source`, commits on what it got, force-pushes to `sink`, and sets `snapshot` to the sha it built on.
import { admit } from "../agents/scripted.mjs";
import { waitWhileSettling } from "./settle.mjs";
import { FifoQueue, landOne, Mutex, sleep } from "./plumbing.mjs";

export const MODEL = "synthetic-v1";

export class Rejected extends Error {
  constructor(reason) {
    super(`rejected: ${reason}`);
    this.reason = reason;
  }
}

const newTxnId = () => `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;

// A fork of trunk per change, exactly what Ryke's `begin` makes, so lock and queue pay the same plumbing.
async function openFork(ctl, trunk, agent, intent) {
  const id = newTxnId();
  const name = `${trunk}--${id}`;
  await ctl.fork(trunk, name);
  const [info, token] = await Promise.all([ctl.info(name), ctl.token(name, "write", 3600)]);
  const at = { remote: info.remote, token };
  return { id, attempt: 1, snapshot: info.head, source: { ...at, ref: "main" }, sink: at, agent, model: MODEL, intent, forkName: name };
}

// A retry without read tracking: take the trunk as it is now and redo the work on it.
async function refreshFromTrunk(ctl, trunk, session) {
  const [info, token] = await Promise.all([ctl.info(trunk), ctl.token(trunk, "read", 3600)]);
  session.attempt++;
  session.snapshot = info.head;
  session.source = { remote: info.remote, token, ref: "main" };
}

const outcomeOf = (r) =>
  r.landed ? { landed: true, verified: r.verified } : { landed: false, cause: r.cause, retry: true, verified: r.verified, paths: r.paths, failures: r.failures };

// The "agent teams with file locks" baseline: one agent holds the whole repo from begin to land.
export function lockPolicy({ ctl, trunk, policy, clock, stats }) {
  const mutex = new Mutex();
  return {
    name: "lock",
    stats,
    async open(agent, { intent }) {
      const release = await mutex.acquire(clock.signal);
      if (clock.expired()) {
        release();
        return null;
      }
      try {
        const session = await openFork(ctl, trunk, agent, intent);
        session.release = release;
        return session;
      } catch (e) {
        release();
        throw e;
      }
    },
    report: async () => ({ warned: false }),
    async think(_session, ms, signal) {
      await sleep(ms, signal);
      return { early: false, spentMs: ms };
    },
    async submit(session, head, signal) {
      const t = { id: session.id, agent: session.agent, model: session.model, intent: session.intent, attempt: session.attempt, snapshot: session.snapshot, head, fork: session.sink };
      return outcomeOf(await landOne(ctl, { trunk, policy, t, stats, signal }));
    },
    retry: (session) => refreshFromTrunk(ctl, trunk, session),
    async close(session) {
      session.release?.();
      session.release = null;
    },
  };
}

// GitHub's merge queue, one change at a time: no read tracking, a text conflict or a failing verify
// sends the author back to start over on the new trunk.
export function queuePolicy({ ctl, trunk, policy, clock, stats }) {
  const queue = new FifoQueue(({ session, head, signal }) => {
    // Once the cell is over nobody is waiting for the rest of the line.
    if (clock.signal.aborted) throw clock.signal.reason;
    const t = { id: session.id, agent: session.agent, model: session.model, intent: session.intent, attempt: session.attempt, snapshot: session.snapshot, head, fork: session.sink };
    return landOne(ctl, { trunk, policy, t, stats, signal });
  });
  return {
    name: "queue",
    stats,
    async open(agent, { intent }) {
      return clock.expired() ? null : openFork(ctl, trunk, agent, intent);
    },
    report: async () => ({ warned: false }),
    async think(_session, ms, signal) {
      await sleep(ms, signal);
      return { early: false, spentMs: ms };
    },
    async submit(session, head, signal) {
      const abandoned = new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ abandoned: true }), { once: true }));
      return Promise.race([queue.enqueue({ session, head, signal }).then(outcomeOf), abandoned]);
    },
    retry: (session) => refreshFromTrunk(ctl, trunk, session),
    close: async () => {},
  };
}

// Ryke itself: everything goes through the public API, the way an outside agent would use it.
export function rykePolicy({ api, repo, clock, stats, now = Date.now }) {
  return {
    name: "ryke",
    stats,
    async open(agent, { intent }) {
      if (clock.expired()) return null;
      const b = await api.begin(repo, { agent, model: MODEL, intent });
      if (!b?.txn) throw new Error(`begin failed: ${JSON.stringify(b)}`);
      if (b.state === "rejected") throw new Rejected(b.reason);
      const at = { remote: b.remote, token: b.token };
      return { id: b.txn, attempt: 1, snapshot: b.snapshot, source: { ...at, ref: "main" }, sink: at, agent, model: MODEL, intent, forkName: `${repo}--${b.txn}` };
    },
    async report(session, paths) {
      const r = await api.reads(session.id, paths);
      return { warned: r.staleWarnings.length > 0 };
    },
    // The think time is spent inside the long-poll, so a stale warning ends it the moment trunk moves
    // (PLAN.md §4.4) and the agent can refresh onto the new trunk instead of finishing doomed work.
    async think(session, ms, signal) {
      const start = Date.now();
      const end = start + ms;
      for (;;) {
        const left = end - Date.now();
        if (left <= 0) return { early: false, spentMs: ms };
        if (signal?.aborted) throw signal.reason;
        const w = await api.wait(session.id, Math.min(left, 20_000) / 1000);
        if (w.staleWarnings.length > 0) return { early: true, spentMs: Date.now() - start };
        if (w.txn.state !== "open") return { early: false, spentMs: Date.now() - start };
      }
    },
    // §7.2 from the agent's side, the same loop the scripted swarm uses: wait while a hot path is held by
    // a change that is still on its way, give up after 90 s in total.
    async admit(session, paths, signal) {
      const start = now();
      const waited = await admit(api, session.id, paths, (line) => line.startsWith("gave up") && stats.leaseGaveUp++, { now, wait: (ms) => sleep(ms, signal) });
      if (waited) {
        stats.leaseWaits++;
        stats.leaseWaitMs += now() - start;
      }
      return { waited };
    },
    async refresh(session) {
      const r = await api.call("POST", `/api/txns/${session.id}/refresh`, {});
      session.snapshot = r.snapshot;
      session.source = { remote: r.trunk.remote, token: r.trunk.token, ref: r.snapshot };
      stats.refreshes++;
      return r;
    },
    async submit(session, head, signal) {
      const s = await api.submit(session.id, { head });
      const settled = await waitWhileSettling(api, session.id, s, signal);
      if (settled.abandoned) return { abandoned: true };
      return settled;
    },
    async retry(session) {
      const r = await api.retry(session.id);
      session.attempt = r.attempt;
      session.snapshot = r.snapshot;
      session.source = { remote: r.trunk.remote, token: r.trunk.token, ref: r.snapshot };
      session.sink = { remote: r.remote, token: r.token };
      return r;
    },
    // A change still open or stale when the cell ends must not hold a footprint into the next phase.
    async close(session) {
      if (!session.finished) await api.abort(session.id, "bench_end").catch(() => {});
    },
  };
}

// Ryke with the lease tool taken away: the same agents, the same refresh on a stale warning, but they never
// call intend-write, so nobody ever waits for a hot file. The difference to `ryke` is what leases buy.
export function rykeNoLeasePolicy(opts) {
  const { admit: _leases, ...rest } = rykePolicy(opts);
  return { ...rest, name: "ryke-nolease" };
}
