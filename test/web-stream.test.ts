import { describe, expect, it } from "vitest";
import type { Op, OpKind } from "../src/shared/types";
import { BACKOFF_FIRST_MS, BACKOFF_MAX_MS, closed, lastSeq, newFeed, openSocket, receive, RESET_CLOSE_CODE, type Feed } from "../src/web/stream";

const op = (seq: number, kind: OpKind = "heat.changed", over: Partial<Op> = {}): Op => ({ seq, at: seq * 10, kind, txn: null, agent: null, data: { path: `p${seq}`, value: 1 }, ...over });
const frame = (from: number, to: number): Op[] => Array.from({ length: to - from + 1 }, (_, i) => op(from + i));
const seqs = (f: Feed) => f.ops.map((o) => o.seq);

// A feed that has already shown ops 1..n over one socket, the way the dashboard looks mid-run.
function running(n: number): Feed {
  const f = newFeed();
  openSocket(f);
  receive(f, frame(1, n));
  return f;
}

describe("receive: what a frame does to what the dashboard already shows", () => {
  it("applies the first frame and folds it into the state", () => {
    const f = newFeed();
    openSocket(f);
    expect(receive(f, frame(1, 3))).toBe("applied");
    expect(seqs(f)).toEqual([1, 2, 3]);
    expect(f.state.seq).toBe(3);
    expect(lastSeq(f)).toBe(3);
  });

  it("appends a later frame on the same socket", () => {
    const f = running(3);
    expect(receive(f, frame(4, 5))).toBe("applied");
    expect(seqs(f)).toEqual([1, 2, 3, 4, 5]);
  });

  it("resumes: a reconnect with after=3 gets 4 onwards and keeps what it had", () => {
    const f = running(3);
    expect(openSocket(f)).toBe(3);
    expect(receive(f, frame(4, 4))).toBe("applied");
    expect(seqs(f)).toEqual([1, 2, 3, 4]);
  });

  it("ignores an empty frame and still counts it as a sign that the socket works", () => {
    const f = running(3);
    closed(f, 1006);
    expect(f.delay).toBe(BACKOFF_FIRST_MS);
    expect(receive(f, [])).toBe("applied");
    expect(seqs(f)).toEqual([1, 2, 3]);
    expect(f.delay).toBe(0);
  });

  // The repo was deleted and created again while the dashboard was away: the log starts at seq 1 again, and
  // the Ledger broadcasts the new run's ops to the reconnected socket whatever `after` it asked for.
  it.each([
    ["the new run's first op", 400, [op(1)]],
    ["the new run's third op", 400, [op(3), op(4)]],
    ["an op exactly at the last seq", 3, [op(3)]],
    ["an old seq hidden in the middle of a frame", 10, [op(11), op(2)]],
    ["a first op of 1 while the dashboard holds more than one op", 2, [op(1), op(2), op(3)]],
    // The Ledger never repeats an op; if it ever did, starting over from 0 loses nothing.
    ["a repeat of the last op", 5, [op(5), op(6)]],
  ])("resets when a frame carries an op at or below the last seq shown: %s", (_name, after, ops) => {
    const f = running(after);
    const oldOps = f.ops;
    const oldState = f.state;
    const epoch = f.epoch;
    openSocket(f);
    expect(receive(f, ops)).toBe("reset");
    expect(f.ops).toEqual([]);
    expect(f.ops).not.toBe(oldOps);
    expect(f.state).not.toBe(oldState);
    expect(f.state.seq).toBe(0);
    expect(f.epoch).toBe(epoch + 1);
    expect(openSocket(f)).toBe(0);
  });

  it("does not mistake the first frame of a brand new feed for a reset", () => {
    const f = newFeed();
    openSocket(f);
    expect(receive(f, [op(1)])).toBe("applied");
  });

  it("does not apply the frame that triggered a reset: the socket reopens from 0 and delivers the whole run", () => {
    const f = running(400);
    openSocket(f);
    receive(f, [op(2)]);
    expect(f.ops).toEqual([]);
    openSocket(f);
    expect(receive(f, frame(1, 4))).toBe("applied");
    expect(seqs(f)).toEqual([1, 2, 3, 4]);
  });

  it("a reset starts the backoff over: the reconnect is not an error", () => {
    const f = running(5);
    closed(f, 1006);
    closed(f, 1006);
    openSocket(f);
    receive(f, [op(1)]);
    expect(f.delay).toBe(0);
  });
});

describe("closed: what a closed socket does and how long to wait", () => {
  it("backs off 1 s, 2 s, 4 s, 8 s, 16 s, then stays at 30 s", () => {
    const f = running(1);
    const waits = Array.from({ length: 8 }, () => closed(f, 1006));
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
    expect(BACKOFF_MAX_MS).toBe(30_000);
  });

  it("starts again at 1 s after a good frame", () => {
    const f = running(1);
    closed(f, 1006);
    closed(f, 1006);
    closed(f, 1006);
    openSocket(f);
    receive(f, frame(2, 2));
    expect(closed(f, 1006)).toBe(1000);
  });

  it.each([1000, 1001, 1005, 1006, 1011, 1013])("keeps everything it shows when the socket closes with %i", (code) => {
    const f = running(7);
    const ops = f.ops;
    const epoch = f.epoch;
    closed(f, code);
    expect(f.ops).toBe(ops);
    expect(f.epoch).toBe(epoch);
    expect(openSocket(f)).toBe(7);
  });

  // Ledger.reset() closes every socket with 1012 and starts seq over at 1. Resuming after the old last seq
  // would drop every op of the new run until it passed that number: the dashboard froze.
  it("forgets the old run when the Ledger closes the socket because the repo was reset", () => {
    const f = running(400);
    const epoch = f.epoch;
    expect(closed(f, RESET_CLOSE_CODE)).toBe(BACKOFF_FIRST_MS);
    expect(f.ops).toEqual([]);
    expect(f.state.txns.size).toBe(0);
    expect(f.epoch).toBe(epoch + 1);
    expect(openSocket(f)).toBe(0);
  });

  it("keeps backing off while the repo is still being recreated", () => {
    const f = running(5);
    expect(closed(f, RESET_CLOSE_CODE)).toBe(1000);
    openSocket(f); // the upgrade is refused while the repo does not exist, and the socket closes again
    expect(closed(f, 1006)).toBe(2000);
    expect(f.epoch).toBe(1);
  });

  it("shows the new run after a reset, and none of the old one", () => {
    const f = newFeed();
    openSocket(f);
    receive(f, [op(1, "txn.open", { txn: "t_old", agent: "agent-01", data: { attempt: 1, intent: "old" } }), ...frame(2, 400)]);
    expect(f.state.txns.has("t_old")).toBe(true);
    closed(f, RESET_CLOSE_CODE);
    openSocket(f);
    receive(f, [op(1, "txn.open", { txn: "t_new", agent: "agent-02", data: { attempt: 1, intent: "new" } }), op(2)]);
    expect([...f.state.txns.keys()]).toEqual(["t_new"]);
    expect(f.state.agents).toEqual(["agent-02"]);
    expect(seqs(f)).toEqual([1, 2]);
  });

  it("recovers when the 1012 close was lost and the socket only dropped", () => {
    const f = running(400);
    closed(f, 1006);
    expect(openSocket(f)).toBe(400);
    expect(receive(f, [op(1), op(2)])).toBe("reset");
    expect(openSocket(f)).toBe(0);
    expect(receive(f, frame(1, 3))).toBe("applied");
    expect(seqs(f)).toEqual([1, 2, 3]);
  });
});
