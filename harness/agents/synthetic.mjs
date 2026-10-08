// The bench's synthetic agent (PLAN.md §10.4, §11.3): real git against a real fork, scripted edits.
// It loops until the cell's deadline: begin, choose a footprint, think, write, push, submit, and
// handle the outcome. It speaks only to the policy interface of harness/bench/policies.mjs, so lock,
// queue and Ryke see the same agent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_ATTEMPTS } from "../../src/shared/types.ts";
import { Workspace } from "../lib/gitops.mjs";
import { dependents, materialise, makeRng, planTransaction, seedFor, thinkMs } from "../bench/workload.mjs";

export const brief = (e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 200);

const WORDS = "abcdefghijklmnopqrstuvwxyz";

// Unlike a real agent's, these intents share almost no trigrams, so Ryke's begin-time duplicate screen
// stays quiet and the cell measures landing, not screening.
function intentFor(rng, tag) {
  return `${tag} ${Array.from({ length: 18 }, () => WORDS[Math.floor(rng() * 26)]).join("")}`;
}

const readSync = (dir) => (path) => {
  try {
    return readFileSync(join(dir, path), "utf8");
  } catch {
    return null;
  }
};

// ctx: { index, name, policy, rec, clock, seed, factor, root, staggerMs }
//   rec:   plan(plan) attempt(a) txn(t) error(message)
//   clock: elapsedMs() expired() signal
export async function runAgent(ctx) {
  const { index, name, policy, rec, clock, seed, factor, root, staggerMs = 0 } = ctx;
  let ws = null;
  try {
    // Agents do not all start in the same millisecond; the spread is part of the workload, not of a policy.
    if (staggerMs > 0) await pause(Math.floor(makeRng(seedFor(seed, `stagger-${index}`))() * staggerMs), clock);
    for (let n = 1; !clock.expired() && !clock.signal.aborted; n++) {
      const tag = `b${index}x${n}`;
      const planRng = makeRng(seedFor(seed, `plan-${tag}`));
      const startMs = clock.elapsedMs();
      let session = null;
      try {
        session = await policy.open(name, { intent: intentFor(planRng, tag) });
        if (!session) break;
        rec.opened(session.id);
        ws ??= await Workspace.create(name, root);
        await work({ session, tag, planRng, startMs, ws, ...ctx });
      } catch (e) {
        if (clock.signal.aborted) {
          // The cell's hard stop cut this change off; it neither landed nor failed.
          if (session) rec.txn({ txn: session.id, startMs, endMs: clock.elapsedMs(), status: "abandoned" });
          break;
        }
        // The loop goes on: one failed change is a data point, not the end of the agent.
        const cause = e?.reason ? `rejected:${e.reason}` : "agent_error";
        rec.error(`${name} ${tag}: ${brief(e)}`);
        rec.attempt({ txn: session?.id ?? tag, attempt: session?.attempt ?? 1, endMs: clock.elapsedMs(), thinkS: 0, outcome: cause });
        rec.txn({ txn: session?.id ?? tag, startMs, endMs: clock.elapsedMs(), status: "aborted", cause });
        await pause(500, clock).catch(() => {});
      } finally {
        if (session) await policy.close(session).catch(() => {});
      }
    }
  } finally {
    await ws?.remove();
  }
}

function pause(ms, clock) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    clock.signal.addEventListener("abort", () => (clearTimeout(timer), reject(clock.signal.reason)), { once: true });
  });
}

// Where the agent stands for one attempt: the snapshot fetched and checked out, and its file list.
async function stand(ws, session) {
  const sha = await ws.fetch(session.source.remote, session.source.token, session.source.ref);
  await ws.git("checkout", "-q", "-f", "--detach", sha);
  session.snapshot = sha;
  return (await ws.git("ls-tree", "-r", "--name-only", sha)).split("\n").filter(Boolean);
}

// A stale warning ends a think early and the agent refreshes onto the new trunk and adapts; this bounds
// how often one attempt may do that, so a very hot trunk cannot keep one agent in the loop forever.
export const MAX_REFRESHES = 8;

async function work({ session, tag, planRng, startMs, ws, policy, rec, clock, seed, factor }) {
  let plan = null;
  const read = readSync(ws.dir);
  for (;;) {
    // 1. The snapshot this attempt builds on.
    let files = await stand(ws, session);
    if (!plan) {
      plan = planTransaction(planRng, files);
      rec.plan(plan);
    }
    // A change to a constant also reads (and rewrites) the dependents that name it at this snapshot.
    const readsOf = () => [...new Set([...plan.reads.filter((p) => files.includes(p)), ...dependents(plan, files, read)])];
    const editRng = () => makeRng(seedFor(seed, `edit-${tag}-${session.attempt}`));
    const written = () => Object.keys(materialise(plan, { tag, read, files, rng: editRng() }).files);
    let { warned } = await policy.report(session, readsOf(), clock.signal);

    // 2. Ryke only: lease the paths about to be written, then move onto the trunk before the work if
    // something this change read has moved (the holder we waited for, or anyone else).
    let leaseWaitS = 0;
    if (policy.admit) {
      const waitStart = clock.elapsedMs();
      const { waited } = await policy.admit(session, written(), clock.signal);
      leaseWaitS = (clock.elapsedMs() - waitStart) / 1000;
      if (waited) ({ warned } = await policy.report(session, readsOf(), clock.signal));
    }
    let refreshes = 0;
    let lostMs = 0;
    const refresh = async () => {
      await policy.refresh(session);
      files = await stand(ws, session);
      ({ warned } = await policy.report(session, readsOf(), clock.signal));
      refreshes++;
    };
    if (warned && policy.refresh) await refresh();

    // 3. Think. A retry thinks half as long, whatever the policy. A stale warning during the think
    // means the base moved: refresh, then spend a retry's worth of time adapting to what changed.
    let ms = thinkMs(makeRng(seedFor(seed, `think-${tag}-${session.attempt}`)), { factor, retry: session.attempt > 1 });
    let spentMs = 0;
    for (;;) {
      const t = await policy.think(session, ms, clock.signal);
      spentMs += t.spentMs;
      if (!t.early || refreshes >= MAX_REFRESHES) break;
      lostMs += t.spentMs;
      await refresh();
      ms = thinkMs(makeRng(seedFor(seed, `think-${tag}-${session.attempt}-r${refreshes}`)), { factor, retry: true });
    }
    const thinkS = spentMs / 1000;

    // 4. Write the change on this snapshot, commit, push.
    const { files: out } = materialise(plan, { tag, read, files, rng: editRng() });
    await ws.write(out);
    const head = await ws.commitAll(session.intent);
    await ws.push(session.sink.remote, session.sink.token, head, true);

    // 5. Hand it in and learn what happened.
    const result = await policy.submit(session, head, clock.signal);
    const endMs = clock.elapsedMs();
    const record = { txn: session.id, attempt: session.attempt, endMs, thinkS, refreshes, lostThinkS: lostMs / 1000, leaseWaitS, verified: result.verified === true };
    if (result.abandoned) {
      rec.attempt({ ...record, outcome: "abandoned" });
      rec.txn({ txn: session.id, startMs, endMs, status: "abandoned" });
      return;
    }
    if (result.landed) {
      rec.attempt({ ...record, outcome: "landed" });
      rec.txn({ txn: session.id, startMs, endMs, status: "landed" });
      session.finished = true;
      return;
    }
    rec.attempt({ ...record, outcome: result.cause, paths: result.paths, failures: result.failures });
    // Ryke enforces the attempt limit itself; the baselines get the same limit from the agent.
    const spent = result.maxAttempts || !result.retry || session.attempt >= MAX_ATTEMPTS;
    if (spent) {
      rec.txn({ txn: session.id, startMs, endMs, status: "aborted", cause: result.retry || result.maxAttempts ? "max_attempts" : result.cause });
      session.finished = true;
      return;
    }
    await policy.retry(session, clock.signal);
  }
}
