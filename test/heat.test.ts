import { describe, expect, it } from "vitest";
import {
  bump,
  decayed,
  HALF_LIFE_MS,
  HEAT_EMIT_MS,
  HOT,
  isHot,
  LEASE_MS,
  leaseDecision,
  shouldEmit,
  type Lease,
} from "../src/worker/ledger/heat";

describe("constants (PLAN.md §7)", () => {
  it("match the plan", () => {
    expect(HALF_LIFE_MS).toBe(300_000);
    expect(HOT).toBe(2);
    expect(LEASE_MS).toBe(90_000);
    expect(HEAT_EMIT_MS).toBe(1000);
  });
});

describe("decayed", () => {
  it.each([
    ["no time elapsed", 4, 1000, 1000, 4],
    ["one half-life", 4, 0, HALF_LIFE_MS, 2],
    ["two half-lives", 4, 0, 2 * HALF_LIFE_MS, 1],
    ["three half-lives", 8, 1000, 1000 + 3 * HALF_LIFE_MS, 1],
    ["half of a half-life", 2, 0, HALF_LIFE_MS / 2, 2 * Math.SQRT1_2],
    ["zero value stays zero", 0, 0, HALF_LIFE_MS, 0],
    ["now before at is treated as now = at", 4, 5000, 1000, 4],
    ["now far before at is still not amplified", 3, 10 * HALF_LIFE_MS, 0, 3],
  ])("%s", (_name, value, at, now, expected) => {
    expect(decayed(value, at, now)).toBeCloseTo(expected, 10);
  });

  it("is strictly decreasing over time for a positive value", () => {
    const a = decayed(1, 0, 1000);
    const b = decayed(1, 0, 2000);
    expect(a).toBeLessThan(1);
    expect(b).toBeLessThan(a);
    expect(b).toBeGreaterThan(0);
  });
});

describe("bump", () => {
  it("starts from nothing: value is the increment, at is now", () => {
    expect(bump(undefined, 1234)).toEqual({ value: 1, at: 1234 });
    expect(bump(undefined, 1234, 2.5)).toEqual({ value: 2.5, at: 1234 });
  });

  it("adds to the undecayed value when no time has passed", () => {
    expect(bump({ value: 1, at: 1000 }, 1000)).toEqual({ value: 2, at: 1000 });
  });

  it("decays the previous value before adding", () => {
    const next = bump({ value: 2, at: 0 }, HALF_LIFE_MS);
    expect(next.value).toBeCloseTo(2, 10); // 2 -> 1, then +1
    expect(next.at).toBe(HALF_LIFE_MS);
  });

  it("honours a custom increment on top of the decayed value", () => {
    const next = bump({ value: 4, at: 0 }, 2 * HALF_LIFE_MS, 0.5);
    expect(next.value).toBeCloseTo(1.5, 10);
  });

  it("accumulates repeated bumps in the same instant", () => {
    let h = bump(undefined, 0);
    for (let i = 0; i < 4; i++) h = bump(h, 0);
    expect(h).toEqual({ value: 5, at: 0 });
  });

  it("a long quiet period cools a path below the hot threshold", () => {
    const h = bump(bump(undefined, 0), 0); // value 2: hot
    expect(isHot(h.value)).toBe(true);
    expect(isHot(decayed(h.value, h.at, h.at + HALF_LIFE_MS + 1))).toBe(false);
  });

  it("a stale clock (now < at) keeps the stored value undecayed and moves at to now", () => {
    expect(bump({ value: 1, at: 1000 }, 500)).toEqual({ value: 2, at: 500 });
  });

  it("does not mutate prev", () => {
    const prev = { value: 1, at: 0 };
    bump(prev, 1000);
    expect(prev).toEqual({ value: 1, at: 0 });
  });
});

describe("isHot", () => {
  it.each([
    [0, false],
    [1, false],
    [1.999999, false],
    [2, true],
    [2.000001, true],
    [10, true],
  ])("%s -> %s", (value, expected) => {
    expect(isHot(value)).toBe(expected);
  });
});

describe("shouldEmit", () => {
  it.each([
    ["never emitted", undefined, 5000, true],
    ["never emitted, now = 0", undefined, 0, true],
    ["same instant", 5000, 5000, false],
    ["1 ms later", 5000, 5001, false],
    ["999 ms later", 5000, 5999, false],
    ["exactly one window later", 5000, 6000, true],
    ["1001 ms later", 5000, 6001, true],
    ["much later", 5000, 500_000, true],
    ["clock stepped back", 5000, 4000, false],
  ])("%s", (_name, last, now, expected) => {
    expect(shouldEmit(last, now)).toBe(expected);
  });
});

describe("leaseDecision (§7.2 grant rule)", () => {
  const NOW = 1_000_000;
  const PATH = "src/format.ts";
  const lease = (over: Partial<Lease> = {}): Lease => ({ path: PATH, txn: "t_a", expires: NOW + 30_000, ...over });

  type Args = Parameters<typeof leaseDecision>[0];
  const call = (over: Partial<Args>) =>
    leaseDecision({ path: PATH, requester: "t_b", heat: 3, lease: lease(), holderOpen: true, now: NOW, ...over });

  const granted = (txn: string) => ({ go: true, lease: { path: PATH, txn, expires: NOW + LEASE_MS } });

  describe("grants", () => {
    it.each<[string, Partial<Args>, string]>([
      ["no lease exists", { lease: null }, "t_b"],
      ["no lease exists and the path is cold", { lease: null, heat: 0 }, "t_b"],
      ["the path is cold even though another txn holds a live lease", { heat: 1.99 }, "t_b"],
      ["the path is cold and the heat is zero", { heat: 0 }, "t_b"],
      ["the holder's lease has expired (expires == now)", { lease: lease({ expires: NOW }) }, "t_b"],
      ["the holder's lease expired long ago", { lease: lease({ expires: NOW - 60_000 }) }, "t_b"],
      ["the holder is no longer open", { holderOpen: false }, "t_b"],
      ["the requester already holds the live lease: refresh", { lease: lease({ txn: "t_b" }) }, "t_b"],
      ["the requester holds the lease on a cold path", { lease: lease({ txn: "t_b" }), heat: 0 }, "t_b"],
      [
        "the requester holds the lease and is the holder even if holderOpen were false",
        { lease: lease({ txn: "t_b" }), holderOpen: false },
        "t_b",
      ],
      ["the requester's own lease expired", { lease: lease({ txn: "t_b", expires: NOW - 1 }) }, "t_b"],
    ])("when %s", (_name, over, txn) => {
      expect(call(over)).toEqual(granted(txn));
    });

    it("hot threshold is inclusive: heat exactly 2 with a live foreign lease is denied, just under is granted", () => {
      expect(call({ heat: HOT }).go).toBe(false);
      expect(call({ heat: HOT - 1e-9 }).go).toBe(true);
    });

    it("a grant or refresh always expires LEASE_MS from now, not from the old expiry", () => {
      const d = call({ lease: lease({ txn: "t_b", expires: NOW + 80_000 }) });
      expect(d).toEqual({ go: true, lease: { path: PATH, txn: "t_b", expires: NOW + LEASE_MS } });
    });

    it("takes the path from the argument, so a first grant needs no existing lease", () => {
      expect(call({ lease: null, path: "src/other.ts" })).toEqual({
        go: true,
        lease: { path: "src/other.ts", txn: "t_b", expires: NOW + LEASE_MS },
      });
    });
  });

  describe("denials", () => {
    it.each<[string, Partial<Args>, number]>([
      ["30 s left is clamped to the 5 s maximum", { lease: lease({ expires: NOW + 30_000 }) }, 5000],
      ["exactly 5 s left", { lease: lease({ expires: NOW + 5000 }) }, 5000],
      ["5001 ms left", { lease: lease({ expires: NOW + 5001 }) }, 5000],
      ["4999 ms left is passed through", { lease: lease({ expires: NOW + 4999 }) }, 4999],
      ["1 s left is passed through", { lease: lease({ expires: NOW + 1000 }) }, 1000],
      ["exactly 250 ms left", { lease: lease({ expires: NOW + 250 }) }, 250],
      ["249 ms left is raised to the 250 ms minimum", { lease: lease({ expires: NOW + 249 }) }, 250],
      ["1 ms left is raised to the minimum", { lease: lease({ expires: NOW + 1 }) }, 250],
    ])("when %s", (_name, over, retryAfterMs) => {
      expect(call(over)).toEqual({ go: false, owner: "t_a", retryAfterMs });
    });

    it("names the lease holder as the owner", () => {
      expect(call({ lease: lease({ txn: "t_zzz" }) })).toMatchObject({ go: false, owner: "t_zzz" });
    });

    it("a very hot path is denied the same way", () => {
      expect(call({ heat: 50 })).toMatchObject({ go: false, owner: "t_a" });
    });
  });
});
