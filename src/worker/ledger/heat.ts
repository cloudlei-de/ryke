export const HALF_LIFE_MS = 5 * 60_000;
export const HOT = 2;
export const LEASE_MS = 90_000;
export const HEAT_EMIT_MS = 1000;

const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 5000;

// A clock that steps backwards must not inflate heat above its stored value, hence the clamp.
export function decayed(value: number, at: number, now: number): number {
  return value * 2 ** (-Math.max(0, now - at) / HALF_LIFE_MS);
}

export function bump(
  prev: { value: number; at: number } | undefined,
  now: number,
  inc = 1,
): { value: number; at: number } {
  return { value: (prev ? decayed(prev.value, prev.at, now) : 0) + inc, at: now };
}

export function isHot(value: number): boolean {
  return value >= HOT;
}

// Throttles heat.changed ops per path so a burst of conflicts does not flood the op log (§7.1).
export function shouldEmit(lastEmitAt: number | undefined, now: number): boolean {
  return lastEmitAt === undefined || now - lastEmitAt >= HEAT_EMIT_MS;
}

export type Lease = { path: string; txn: string; expires: number };

// `path` is an argument because a first grant has no existing lease to take it from.
// `lease` is the current row for that path, if any (the Ledger does not delete expired rows eagerly).
// `holderOpen` says whether the lease holder's transaction is still open: a holder that submitted
// or aborted has stopped editing, so its lease must not make anyone wait (R2: never block forever).
export function leaseDecision(args: {
  path: string;
  requester: string;
  heat: number;
  lease: Lease | null;
  holderOpen: boolean;
  now: number;
}): { go: true; lease: Lease } | { go: false; owner: string; retryAfterMs: number } {
  const { path, requester, heat, lease, holderOpen, now } = args;
  const blocked = lease !== null && lease.expires > now && lease.txn !== requester && holderOpen && isHot(heat);
  if (blocked) {
    return {
      go: false,
      owner: lease.txn,
      retryAfterMs: Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, lease.expires - now)),
    };
  }
  // Grant and refresh are the same write: the requester always ends up holding a full 90 s lease.
  return { go: true, lease: { path, txn: requester, expires: now + LEASE_MS } };
}
