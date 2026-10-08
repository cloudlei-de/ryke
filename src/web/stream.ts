// The resume logic behind the live socket (PLAN.md §12 "Data flow"), without React or a WebSocket so that
// every rule is table-tested. `useLive` in live.ts owns the socket and calls these on each event.
import { apply, initial, type LineState } from "../shared/reducers";
import type { Op } from "../shared/types";

// Ledger.reset() (swarm --fresh, a repo delete) closes every socket with this code and starts seq over at 1.
export const RESET_CLOSE_CODE = 1012;
export const BACKOFF_FIRST_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

export type Feed = {
  ops: Op[];
  state: LineState;
  // Counts the times the log was thrown away, so a view holding a copy of it (Replay's history) knows to refetch.
  epoch: number;
  // Milliseconds to wait before the next reconnect; 0 once a frame has proved the socket works.
  delay: number;
};

export function newFeed(): Feed {
  return { ops: [], state: initial(), epoch: 0, delay: 0 };
}

export const lastSeq = (f: Feed): number => f.ops.at(-1)?.seq ?? 0;

// The `after` for the next socket's URL: the Ledger sends only ops past it.
export const openSocket = lastSeq;

// New arrays rather than emptying the old ones: views memoise on the identity of `ops` and `state`.
function reset(f: Feed): void {
  f.ops = [];
  f.state = initial();
  f.epoch++;
}

// The Ledger only ever sends ops past the last one a socket has seen, in order, so an op at or below the last seq
// shown means the log started over (swarm --fresh, a repo delete) and this socket is delivering the tail of the new
// run to a client that asked to resume past it. "reset" tells the caller to reopen the socket from 0: the frame is
// dropped, since the ops before it are missing. A reset is always safe, only wasteful, so a doubtful frame resets.
export function receive(f: Feed, frame: readonly Op[]): "applied" | "reset" {
  const last = lastSeq(f);
  if (frame.some((o) => o.seq <= last)) {
    reset(f);
    f.delay = 0;
    return "reset";
  }
  for (const op of frame) {
    f.ops.push(op);
    apply(f.state, op);
  }
  f.delay = 0;
  return "applied";
}

// Returns how long to wait before reconnecting. A close because the repo was reset also forgets the old run:
// resuming after its last seq would hide the new run until it caught up with that number.
export function closed(f: Feed, code: number): number {
  if (code === RESET_CLOSE_CODE) reset(f);
  f.delay = f.delay === 0 ? BACKOFF_FIRST_MS : Math.min(f.delay * 2, BACKOFF_MAX_MS);
  return f.delay;
}
