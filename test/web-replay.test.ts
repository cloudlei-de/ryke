import { describe, expect, it } from "vitest";
import { fold } from "../src/shared/reducers";
import type { Op, OpKind } from "../src/shared/types";
import {
  displayNow,
  fmtClock,
  fmtElapsed,
  foldTo,
  indexAtTime,
  initialPlayer,
  keyAction,
  loadHistory,
  markers,
  mergeOps,
  newFoldCache,
  opFields,
  opSignal,
  playerReduce,
  prefixMaxTimes,
  SPEEDS,
  type Player,
} from "../src/web/views/replay/scrub";
import e2e from "./fixtures/ops/e2e-land.json";

const ops = e2e as unknown as Op[];
const op = (seq: number, at: number, kind: OpKind = "heat.changed", over: Partial<Op> = {}): Op => ({ seq, at, kind, txn: null, agent: null, data: {}, ...over });
// Ops at t = 0, 0, 100, 100, 100, 1000 ms: two bursts and a gap, the shape a swarm produces.
const burst = [op(1, 0), op(2, 0), op(3, 100), op(4, 100), op(5, 100), op(6, 1000)];
const times = prefixMaxTimes(burst);
const player = (over: Partial<Player> = {}): Player => ({ idx: 0, clock: 0, playing: false, speed: 1, ...over });

describe("prefixMaxTimes and indexAtTime", () => {
  it("turns timestamps into a non-decreasing timeline even if a clock stepped back", () => {
    expect(prefixMaxTimes([op(1, 10), op(2, 5), op(3, 20)])).toEqual([10, 10, 20]);
    expect(prefixMaxTimes([])).toEqual([]);
  });

  const cases: [string, number, number][] = [
    ["before the first op", -1, -1],
    ["exactly the first op: both ops at t=0 are included", 0, 1],
    ["between bursts", 50, 1],
    ["exactly a burst: all three ops at t=100 are included", 100, 4],
    ["inside the long gap", 999, 4],
    ["exactly the last op", 1000, 5],
    ["after the last op", 5000, 5],
  ];
  it.each(cases)("indexAtTime: %s", (_name, t, want) => {
    expect(indexAtTime(times, t)).toBe(want);
  });

  it("is -1 for an empty timeline", () => {
    expect(indexAtTime([], 10)).toBe(-1);
  });
});

describe("playerReduce", () => {
  it("starts paused at the first op at 1x", () => {
    expect(initialPlayer()).toEqual({ idx: 0, clock: 0, playing: false, speed: 1 });
  });

  describe("seek, start, end", () => {
    const cases: [string, Player, Parameters<typeof playerReduce>[2], Player][] = [
      ["seek sets the position and resets the clock to that op", player({ idx: 0 }), { type: "seek", idx: 3 }, player({ idx: 3, clock: 100 })],
      ["seek keeps playing mid-log", player({ playing: true, speed: 4 }), { type: "seek", idx: 2 }, player({ idx: 2, clock: 100, playing: true, speed: 4 })],
      ["seek to the end stops playback", player({ playing: true }), { type: "seek", idx: 5 }, player({ idx: 5, clock: 1000 })],
      ["seek clamps above the end", player(), { type: "seek", idx: 99 }, player({ idx: 5, clock: 1000 })],
      ["seek clamps below the start", player({ idx: 3, clock: 100 }), { type: "seek", idx: -4 }, player()],
      ["seek rounds a fractional slider value", player(), { type: "seek", idx: 2.6 }, player({ idx: 3, clock: 100 })],
      ["seek ignores NaN", player({ idx: 2, clock: 100 }), { type: "seek", idx: Number.NaN }, player({ idx: 2, clock: 100 })],
      ["start jumps to the first op", player({ idx: 4, clock: 100 }), { type: "start" }, player()],
      ["end jumps to the last op and stops", player({ idx: 1, playing: true }), { type: "end" }, player({ idx: 5, clock: 1000 })],
    ];
    it.each(cases)("%s", (_name, from, action, want) => {
      expect(playerReduce(from, times, action)).toEqual(want);
    });
  });

  describe("step", () => {
    const cases: [string, Player, number, Player][] = [
      ["forward one op", player({ idx: 1 }), 1, player({ idx: 2, clock: 100 })],
      ["back one op", player({ idx: 3, clock: 100 }), -1, player({ idx: 2, clock: 100 })],
      ["pauses playback", player({ idx: 1, playing: true }), 1, player({ idx: 2, clock: 100 })],
      ["stays at the end", player({ idx: 5, clock: 1000 }), 1, player({ idx: 5, clock: 1000 })],
      ["stays at the start", player(), -1, player()],
    ];
    it.each(cases)("%s", (_name, from, by, want) => {
      expect(playerReduce(from, times, { type: "step", by })).toEqual(want);
    });
  });

  describe("toggle", () => {
    it("starts playing from the current op", () => {
      expect(playerReduce(player({ idx: 2, clock: 100 }), times, { type: "toggle" })).toEqual(player({ idx: 2, clock: 100, playing: true }));
    });
    it("resumes where pause left the clock, between ops, so the Line does not jump back", () => {
      expect(playerReduce(player({ idx: 2, clock: 160 }), times, { type: "toggle" })).toEqual(player({ idx: 2, clock: 160, playing: true }));
    });
    it("pauses while playing, keeping the clock", () => {
      expect(playerReduce(player({ idx: 2, clock: 160, playing: true }), times, { type: "toggle" })).toEqual(player({ idx: 2, clock: 160 }));
    });
    it("restarts from the beginning when pressed at the end, like a video", () => {
      expect(playerReduce(player({ idx: 5, clock: 1000 }), times, { type: "toggle" })).toEqual(player({ playing: true }));
    });
    it("does nothing without ops", () => {
      expect(playerReduce(player(), [], { type: "toggle" })).toEqual(player());
    });
  });

  describe("speed", () => {
    it.each(SPEEDS)("sets %sx", (speed) => {
      expect(playerReduce(player(), times, { type: "speed", speed }).speed).toBe(speed);
    });
    it("ignores a speed the view does not offer", () => {
      expect(playerReduce(player({ speed: 4 }), times, { type: "speed", speed: 3 as never }).speed).toBe(4);
    });
  });

  describe("tick advances by wall time x speed, not by op count", () => {
    const cases: [string, Player, number, Player][] = [
      ["a paused player does not move", player({ idx: 1 }), 500, player({ idx: 1 })],
      ["less than the gap to the next burst plays nothing new", player({ idx: 1, playing: true }), 50, player({ idx: 1, clock: 50, playing: true })],
      ["reaching a burst plays all its ops at once", player({ idx: 1, playing: true }), 100, player({ idx: 4, clock: 100, playing: true })],
      ["16x covers the same stretch in a sixteenth of the time", player({ idx: 1, playing: true, speed: 16 }), 6.25, player({ idx: 4, clock: 100, playing: true, speed: 16 })],
      ["4x", player({ idx: 1, playing: true, speed: 4 }), 25, player({ idx: 4, clock: 100, playing: true, speed: 4 })],
      ["the clock keeps running through an idle gap", player({ idx: 4, clock: 100, playing: true }), 200, player({ idx: 4, clock: 300, playing: true })],
      ["reaching the last op stops playback on it", player({ idx: 4, clock: 100, playing: true, speed: 4 }), 225, player({ idx: 5, clock: 1000, speed: 4 })],
      ["a slower tick stops short of the last op", player({ idx: 4, clock: 100, playing: true, speed: 4 }), 224, player({ idx: 4, clock: 996, playing: true, speed: 4 })],
      ["overshooting the end stops on the last op", player({ idx: 4, clock: 100, playing: true, speed: 16 }), 200, player({ idx: 5, clock: 1000, speed: 16 })],
      ["a zero tick changes nothing", player({ idx: 1, playing: true }), 0, player({ idx: 1, playing: true })],
      ["a negative tick is ignored", player({ idx: 1, playing: true }), -10, player({ idx: 1, playing: true })],
      ["a NaN tick is ignored", player({ idx: 1, playing: true }), Number.NaN, player({ idx: 1, playing: true })],
    ];
    it.each(cases)("%s", (_name, from, dt, want) => {
      expect(playerReduce(from, times, { type: "tick", dt })).toEqual(want);
    });

    it("caps one tick at 250 ms so a backgrounded tab does not skip the replay", () => {
      const out = playerReduce(player({ idx: 0, playing: true }), times, { type: "tick", dt: 60_000 });
      expect(out.clock).toBe(250);
      expect(out.idx).toBe(4);
    });

    it("plays a whole log through in total wall time / speed", () => {
      let p = player({ playing: true, speed: 4 });
      let wall = 0;
      while (p.playing) {
        p = playerReduce(p, times, { type: "tick", dt: 40 });
        wall += 40;
        if (wall > 10_000) throw new Error("did not finish");
      }
      expect(p.idx).toBe(5);
      expect(wall).toBeGreaterThanOrEqual(250);
      expect(wall).toBeLessThan(250 + 40);
    });

    it("does nothing on an empty log", () => {
      expect(playerReduce(player({ playing: true }), [], { type: "tick", dt: 40 })).toEqual(player({ playing: false }));
    });
  });

  describe("grew: ops arriving from the socket or the history fetch", () => {
    it("lands on the newest op when the first ops arrive", () => {
      expect(playerReduce(player(), times, { type: "grew", from: 0 })).toEqual(player({ idx: 5, clock: 1000 }));
    });
    it("follows the end while paused there", () => {
      const grown = prefixMaxTimes([...burst, op(7, 2000)]);
      expect(playerReduce(player({ idx: 5, clock: 1000 }), grown, { type: "grew", from: 6 })).toEqual(player({ idx: 6, clock: 2000 }));
    });
    it("leaves a scrubbed position alone", () => {
      const grown = prefixMaxTimes([...burst, op(7, 2000)]);
      const p = player({ idx: 2, clock: 100 });
      expect(playerReduce(p, grown, { type: "grew", from: 6 })).toEqual(p);
    });
    it("leaves playback alone, even at the last op it knew about", () => {
      const grown = prefixMaxTimes([...burst, op(7, 2000)]);
      const p = player({ idx: 5, clock: 1000, playing: true });
      expect(playerReduce(p, grown, { type: "grew", from: 6 })).toEqual(p);
    });
    it("ignores an empty log", () => {
      expect(playerReduce(player(), [], { type: "grew", from: 0 })).toEqual(player());
    });
  });
});

describe("displayNow", () => {
  it("is the timestamp of the op at the playhead after a seek or step", () => {
    expect(displayNow(player({ idx: 2, clock: 100 }), times)).toBe(100);
  });
  it("is the running clock while playing, so open bars grow between ops", () => {
    expect(displayNow(player({ idx: 3, clock: 130, playing: true }), times)).toBe(130);
  });
  it("keeps the running clock when paused, so pausing does not rewind the picture", () => {
    expect(displayNow(player({ idx: 3, clock: 130 }), times)).toBe(130);
  });
  it("never shows a time before the op itself", () => {
    expect(displayNow(player({ idx: 4, clock: 0 }), times)).toBe(100);
  });
  it("is 0 without ops", () => {
    expect(displayNow(player(), [])).toBe(0);
  });
});

describe("mergeOps", () => {
  const a = [op(1, 1), op(2, 2), op(3, 3)];
  it("returns the base itself when the socket has nothing it lacks", () => {
    expect(mergeOps(a, [])).toBe(a);
    expect(mergeOps(a, [op(2, 2), op(3, 3)])).toBe(a);
  });
  it("appends ops past the end", () => {
    expect(mergeOps(a, [op(3, 3), op(4, 4), op(5, 5)]).map((o) => o.seq)).toEqual([1, 2, 3, 4, 5]);
  });
  it("fills a hole in the middle and keeps seq order", () => {
    expect(mergeOps([op(1, 1), op(3, 3)], [op(2, 2)]).map((o) => o.seq)).toEqual([1, 2, 3]);
  });
  it("keeps the base's op objects where both have a seq, so a fold cache stays valid", () => {
    const merged = mergeOps(a, [op(3, 99), op(4, 4)]);
    expect(merged[2]).toBe(a[2]);
    expect(merged[2]!.at).toBe(3);
  });
  it("works from nothing", () => {
    expect(mergeOps([], [op(1, 1)]).map((o) => o.seq)).toEqual([1]);
    expect(mergeOps([], [])).toEqual([]);
  });
});

describe("loadHistory", () => {
  const page = (all: Op[]) => async (after: number, limit: number) => {
    const ops = all.filter((o) => o.seq > after).slice(0, limit);
    return { ops, last: ops.at(-1)?.seq ?? after };
  };
  const make = (n: number) => Array.from({ length: n }, (_, i) => op(i + 1, i));

  it("returns a short log from one request", async () => {
    const calls: [number, number][] = [];
    const fetchPage = async (after: number, limit: number) => {
      calls.push([after, limit]);
      return page(make(7))(after, limit);
    };
    expect((await loadHistory(fetchPage, 5000)).map((o) => o.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(calls).toEqual([[0, 5000]]);
  });

  it("pages until a short page, passing the last seq as the cursor", async () => {
    const calls: number[] = [];
    const inner = page(make(12));
    const got = await loadHistory(async (after, limit) => {
      calls.push(after);
      return inner(after, limit);
    }, 5);
    expect(got.map((o) => o.seq)).toEqual(make(12).map((o) => o.seq));
    expect(calls).toEqual([0, 5, 10]);
  });

  it("asks once more after an exactly full last page, then stops on the empty one", async () => {
    const calls: number[] = [];
    const inner = page(make(10));
    const got = await loadHistory(async (after, limit) => {
      calls.push(after);
      return inner(after, limit);
    }, 5);
    expect(got).toHaveLength(10);
    expect(calls).toEqual([0, 5, 10]);
  });

  it("returns nothing for an empty log", async () => {
    expect(await loadHistory(page([]), 5)).toEqual([]);
  });

  it("stops if the server does not advance the cursor", async () => {
    let calls = 0;
    const stuck = async () => {
      calls++;
      return { ops: [op(1, 1), op(2, 2)], last: 0 };
    };
    expect(await loadHistory(stuck, 2)).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it("lets a failed request reject so the view can say so", async () => {
    await expect(
      loadHistory(async () => {
        throw new Error("503");
      }),
    ).rejects.toThrow("503");
  });
});

describe("foldTo", () => {
  const upTo = (i: number) => fold(ops, ops[i]!.seq);

  it("matches a full fold at every position of a real run, scrubbing forward", () => {
    const cache = newFoldCache();
    for (let i = 0; i < ops.length; i++) expect(foldTo(cache, ops, i)).toEqual(upTo(i));
  });

  it("matches a full fold scrubbing backward and jumping around", () => {
    const cache = newFoldCache();
    for (const i of [58, 40, 41, 10, 0, 33, 33, 57, 12, 58, 1]) expect(foldTo(cache, ops, i)).toEqual(upTo(i));
  });

  it("applies only the new ops when moving forward, on the same state object", () => {
    const cache = newFoldCache();
    const a = foldTo(cache, ops, 10);
    const b = foldTo(cache, ops, 20);
    expect(b).toBe(a);
    expect(b.seq).toBe(ops[20]!.seq);
  });

  it("returns a fresh state when moving backward, so a stale one is never mutated", () => {
    const cache = newFoldCache();
    const a = foldTo(cache, ops, 30);
    const b = foldTo(cache, ops, 5);
    expect(b).not.toBe(a);
    expect(a.seq).toBe(ops[30]!.seq);
  });

  it("keeps the state when the same position is asked for again", () => {
    const cache = newFoldCache();
    expect(foldTo(cache, ops, 12)).toBe(foldTo(cache, ops, 12));
  });

  it("keeps folding forward when ops are appended to the log", () => {
    const grow = ops.slice(0, 30);
    const cache = newFoldCache();
    const a = foldTo(cache, grow, 29);
    const more = [...grow, ...ops.slice(30, 40)];
    const b = foldTo(cache, more, 39);
    expect(b).toBe(a);
    expect(b).toEqual(upTo(39));
  });

  it("refolds from the start when an op appears before the playhead", () => {
    const cache = newFoldCache();
    foldTo(cache, ops, 30);
    const without = [...ops.slice(0, 5), ...ops.slice(6)];
    const refolded = foldTo(cache, without, 30);
    expect(refolded).toEqual(fold(without, without[30]!.seq));
  });

  it("clamps a position past the end", () => {
    expect(foldTo(newFoldCache(), ops, 10_000)).toEqual(upTo(ops.length - 1));
  });

  it("gives the initial state for an empty log", () => {
    const s = foldTo(newFoldCache(), [], 0);
    expect(s.seq).toBe(0);
    expect(s.txns.size).toBe(0);
  });

  it("goes back to the initial state when the log empties", () => {
    const cache = newFoldCache();
    foldTo(cache, ops, 10);
    expect(foldTo(cache, [], 0).seq).toBe(0);
  });
});

describe("keyAction", () => {
  const cases: [string, Parameters<typeof keyAction>[0], ReturnType<typeof keyAction>][] = [
    ["space on the page toggles play", { key: " " }, { type: "toggle" }],
    ["space over the body toggles play", { key: " ", targetTag: "BODY" }, { type: "toggle" }],
    ["space over the range input toggles play (the input does nothing with it)", { key: " ", targetTag: "INPUT", targetType: "range" }, { type: "toggle" }],
    ["space on a focused button presses that button", { key: " ", targetTag: "BUTTON" }, null],
    ["space in a select is left alone", { key: " ", targetTag: "SELECT" }, null],
    ["space in a text input is typed", { key: " ", targetTag: "INPUT", targetType: "text" }, null],
    ["space in a textarea is typed", { key: " ", targetTag: "TEXTAREA" }, null],
    ["space in an editable element is typed", { key: " ", targetTag: "DIV", editable: true }, null],
    ["right arrow steps forward", { key: "ArrowRight" }, { type: "step", by: 1 }],
    ["left arrow steps back", { key: "ArrowLeft" }, { type: "step", by: -1 }],
    ["arrows still work after a button was clicked", { key: "ArrowRight", targetTag: "BUTTON" }, { type: "step", by: 1 }],
    ["arrows on the range input are its own: one step, same as ours", { key: "ArrowLeft", targetTag: "INPUT", targetType: "range" }, null],
    ["arrows in a select change the option", { key: "ArrowRight", targetTag: "SELECT" }, null],
    ["arrows in an editable element move the caret", { key: "ArrowLeft", editable: true }, null],
    ["Home jumps to the start", { key: "Home" }, { type: "start" }],
    ["End jumps to the end", { key: "End" }, { type: "end" }],
    ["Home in the range input is native, and does the same", { key: "Home", targetTag: "INPUT", targetType: "range" }, null],
    ["ctrl+arrow belongs to the browser", { key: "ArrowRight", ctrlKey: true }, null],
    ["cmd+space belongs to the system", { key: " ", metaKey: true }, null],
    ["alt+left is browser back", { key: "ArrowLeft", altKey: true }, null],
    ["other keys do nothing", { key: "a" }, null],
    ["lowercase tag names are normalised", { key: " ", targetTag: "button" }, null],
  ];
  it.each(cases)("%s", (_name, e, want) => {
    expect(keyAction(e)).toEqual(want);
  });
});

describe("opSignal", () => {
  const cases: [OpKind, string | null][] = [
    ["txn.landed", "go"],
    ["txn.stale", "stop"],
    ["txn.failed", "stop"],
    ["txn.rejected", "stop"],
    ["txn.needs_human", "caution"],
    ["stale.warning", "caution"],
    ["lease.waiting", "caution"],
    ["txn.verifying", "run"],
    ["train.formed", "run"],
    ["txn.recalled", "recall"],
    ["recall.planned", "recall"],
    ["recall.done", "recall"],
    ["txn.open", null],
    ["heat.changed", null],
    ["trunk.advanced", null],
  ];
  it.each(cases)("%s is %s", (kind, want) => {
    expect(opSignal(kind)).toBe(want);
  });
});

describe("markers", () => {
  it("places landed, stale, rejected and recalled ops along the track by position in the log", () => {
    const log = [op(1, 0), op(2, 1, "txn.landed"), op(3, 2, "txn.stale"), op(4, 3, "txn.rejected"), op(5, 4, "recall.planned"), op(6, 5, "heat.changed"), op(7, 6, "txn.landed")];
    expect(markers(log)).toEqual([
      { at: 1 / 6, tone: "go" },
      { at: 2 / 6, tone: "stop" },
      { at: 3 / 6, tone: "stop" },
      { at: 4 / 6, tone: "recall" },
      { at: 1, tone: "go" },
    ]);
  });
  it("puts a one-op log at the start and an empty log nowhere", () => {
    expect(markers([op(1, 0, "txn.landed")])).toEqual([{ at: 0, tone: "go" }]);
    expect(markers([])).toEqual([]);
  });
  it("finds the landings in a real run", () => {
    expect(markers(ops).filter((m) => m.tone === "go")).toHaveLength(5);
  });
});

describe("formatting", () => {
  it.each([
    [0, "00:00"],
    [999, "00:00"],
    [1000, "00:01"],
    [65_400, "01:05"],
    [3_599_000, "59:59"],
    [3_600_000, "1:00:00"],
    [3_725_000, "1:02:05"],
    [-500, "00:00"],
    [Number.NaN, "00:00"],
  ])("fmtElapsed(%s) is %s", (ms, want) => {
    expect(fmtElapsed(ms)).toBe(want);
  });

  it("fmtClock shows local time of day, zero padded", () => {
    expect(fmtClock(new Date(2026, 9, 12, 9, 3, 7).getTime())).toBe("09:03:07");
    expect(fmtClock(new Date(2026, 9, 12, 23, 59, 59).getTime())).toBe("23:59:59");
    expect(fmtClock(Number.NaN)).toBe("--:--:--");
  });

  it("opFields spells out the op under the scrubber, with a dash for what it lacks", () => {
    expect(opFields(op(12, 0, "txn.landed", { txn: "t_ab", agent: "agent-a" }))).toEqual({ seq: "12", kind: "txn.landed", txn: "t_ab", agent: "agent-a" });
    expect(opFields(op(3, 0, "heat.changed"))).toEqual({ seq: "3", kind: "heat.changed", txn: "–", agent: "–" });
  });
});
