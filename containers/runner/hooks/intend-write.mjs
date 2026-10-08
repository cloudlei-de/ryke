#!/usr/bin/env node
// PreToolUse on Edit|Write|MultiEdit (PLAN.md §7.2): asks the Ledger for the write lease on the
// target path. On a hot path somebody else holds, it waits and asks again, for at most 90 s in
// total, then lets the edit through, so a lease can never block an agent forever (R2).
import { apiCall, hasApi, isMain, log, pollStale, preToolUseReply, repoPath, runHook, seconds } from "./common.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The Ledger suggests 250 ms to 5 s; the floor only guards against a server that answers 0.
const MIN_WAIT_MS = 50;

// Resolves with how the lease went: { waitedMs, owner, gaveUp, denied } (denied: how often it was told to wait).
export async function acquire(cfg, path, { now = Date.now, wait = sleep } = {}) {
  const started = now();
  const until = started + cfg.patienceMs;
  let owner = null;
  let denied = 0;
  for (;;) {
    const r = await apiCall(cfg, "POST", `/api/txns/${cfg.txn}/intend-write`, { path });
    if (r?.go) return { waitedMs: now() - started, owner, gaveUp: false, denied };
    denied++;
    owner = r?.owner ?? owner;
    if (now() >= until) return { waitedMs: now() - started, owner, gaveUp: true, denied };
    await wait(Math.max(MIN_WAIT_MS, Math.min(Number(r?.retryAfterMs) || MIN_WAIT_MS, until - now())));
  }
}

export async function handle(input, cfg, deps) {
  const path = repoPath(input.tool_input?.file_path, cfg);
  if (path === null || !hasApi(cfg)) return null;
  let reason = "ryke: contention control is off";
  const context = [];
  let lease = null;
  if (cfg.contention) {
    lease = await acquire(cfg, path, deps);
    if (lease.gaveUp) {
      reason = `ryke: gave up after ${seconds(lease.waitedMs)} waiting for the lease on ${path} held by ${lease.owner}; writing anyway`;
      context.push(`Ryke: ${path} is being edited by ${lease.owner}, and the write lease did not free up within ${seconds(lease.waitedMs)}. The edit goes ahead, and a conflict on this file is likely to show up as a stale abort.`);
    } else if (lease.waitedMs >= 1000) {
      reason = `ryke: waited ${seconds(lease.waitedMs)} for the lease on ${path} held by ${lease.owner}`;
    } else {
      reason = `ryke: lease on ${path} granted`;
    }
  }
  // The edit is the next moment the agent can still change course, so it is also when it hears that trunk moved.
  // After a wait it is the likeliest moment of all: whoever held the lease has probably landed meanwhile,
  // so the paths read so far are stated again and the answer is put in terms of the wait. The checkout holds
  // uncommitted work, so the hook never refreshes the snapshot itself; a stale outcome goes through the retry.
  const waited = lease !== null && lease.denied > 0 ? { path, owner: lease.owner, ms: lease.waitedMs } : null;
  try {
    const stale = await pollStale(cfg, { resend: waited !== null, waited });
    if (stale) context.push(stale);
  } catch (e) {
    log(`stale poll failed: ${e.message}`);
  }
  return preToolUseReply(reason, context.join("\n\n"));
}

if (isMain(import.meta.url)) await runHook(handle);
