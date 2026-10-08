// The pure helpers behind `npm run e2e:*` (harness/e2e/lib.mjs). The scripts themselves need a stack and
// are run by hand; everything they decide with is tested here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  benchCaveats,
  benchCellStats,
  benchVerdict,
  bindingNames,
  checkProductionConfig,
  claudeVerdict,
  commandLine,
  contentionCaveats,
  contentionStats,
  contentionVerdict,
  criteriaVerdict,
  formatBenchComparison,
  formatComparison,
  formatCriteria,
  isBenchHotPath,
  landedPerMinute,
  jevPlan,
  M3_CRITERIA,
  parseDevVarEntries,
  parseDevVars,
  redactTokens,
  REQUIRED_BINDINGS,
  reportSummary,
  runNode,
  stalePaths,
} from "../../harness/e2e/lib.mjs";

const MIN = 60_000;

// ---------------------------------------------------------------------------------------------
// Ops, built the way the Ledger writes them (see test/fixtures/ops/e2e-land.json)
// ---------------------------------------------------------------------------------------------

let seq = 0;
const next = () => ++seq;
const entry = (path) => ({ path, seq: 1, by: "t_other" });
const stale = (at, paths, extra = {}) => ({
  seq: next(),
  at,
  kind: "txn.stale",
  txn: `t_${seq}`,
  agent: "agent-01",
  data: { attempt: 1, reason: "stale_read", paths: paths.map(entry), ...extra },
});
const conflict = (at, paths) => stale(at, [], { reason: "text_conflict", paths: paths.map((path) => ({ path })) });
const aborted = (at, paths, cause) => ({
  seq: next(),
  at,
  kind: "txn.aborted",
  txn: `t_${seq}`,
  agent: "agent-01",
  data: { attempt: 3, reason: "max_attempts", paths: paths.map(entry), ...(cause ? { cause } : {}) },
});
const op = (kind, txn, at = 0, data = {}) => ({ seq: next(), at, kind, txn, agent: txn ? "agent-01" : null, data });
const times = (n, make) => Array.from({ length: n }, () => make());

describe("stalePaths", () => {
  const rows = [
    ["a stale op lists its paths", stale(0, ["a.ts", "b.ts"]), ["a.ts", "b.ts"]],
    ["a text conflict names paths without seq or author", conflict(0, ["a.ts"]), ["a.ts"]],
    ["a third stale attempt is an abort with a stale cause", aborted(0, ["a.ts"], { state: "stale", reason: "stale_read" }), ["a.ts"]],
    ["a third text conflict is an abort with a stale cause", aborted(0, ["a.ts"], { state: "stale", reason: "text_conflict" }), ["a.ts"]],
    ["an abort caused by a failed verify is not stale", aborted(0, ["a.ts"], { state: "failed", reason: "tests" }), null],
    ["an abort the agent asked for is not stale", { ...aborted(0, [], undefined), data: { reason: "agent_error" } }, null],
    ["a path listed twice counts once", stale(0, ["a.ts", "a.ts"]), ["a.ts"]],
    ["plain string paths are accepted", { ...stale(0, []), data: { paths: ["a.ts"] } }, ["a.ts"]],
    ["entries without a usable path are dropped", { ...stale(0, []), data: { paths: [{ seq: 1 }, { path: "" }, null, { path: "a.ts" }] } }, ["a.ts"]],
    ["no paths at all is still a stale op", { ...stale(0, []), data: {} }, []],
    ["a landed op is not stale", op("txn.landed", "t_1"), null],
    ["a heat op is not stale", op("heat.changed", null, 0, { path: "a.ts", value: 3, hot: true }), null],
  ];
  for (const [name, input, want] of rows) {
    it(name, () => assert.deepEqual(stalePaths(input), want));
  }
});

describe("contentionStats: stale aborts on hot files", () => {
  // [name, ops, [stale aborts, on hot files, hot incl. the abort that made it hot]]
  const rows = [
    ["no ops", [], [0, 0, 0]],
    ["one abort on a cold file", [stale(0, ["p"])], [1, 0, 0]],
    ["the second abort makes the file hot but happened on a cold one", times(2, () => stale(0, ["p"])), [2, 0, 1]],
    ["the third abort at once is on a file at exactly the threshold of 2", times(3, () => stale(0, ["p"])), [3, 1, 2]],
    ["one millisecond later the file has decayed below 2", [...times(2, () => stale(0, ["p"])), stale(1, ["p"])], [3, 0, 2]],
    ["exactly one half-life later two aborts have decayed to 1", [...times(2, () => stale(0, ["p"])), stale(5 * MIN, ["p"])], [3, 0, 2]],
    ["heat 3 is still hot after 175 s (3 * 2^(-175/300) = 2.002)", [...times(3, () => stale(0, ["p"])), stale(175_000, ["p"])], [4, 2, 3]],
    ["heat 3 is cold after 176 s (3 * 2^(-176/300) = 1.998)", [...times(3, () => stale(0, ["p"])), stale(176_000, ["p"])], [4, 1, 3]],
    ["a cooled file needs fresh aborts to get hot again", [...times(2, () => stale(0, ["p"])), ...times(2, () => stale(20 * MIN, ["p"]))], [4, 0, 2]],
    ["and the abort after those is on a hot file", [...times(2, () => stale(0, ["p"])), ...times(3, () => stale(20 * MIN, ["p"]))], [5, 1, 3]],
    ["heat is per path", [stale(0, ["p"]), stale(0, ["p"]), stale(0, ["q"])], [3, 0, 1]],
    ["an abort that lists a hot and a cold path is one abort on a hot file", [...times(3, () => stale(0, ["p"])), stale(0, ["p", "q"])], [4, 2, 3]],
    ["an abort that lists two hot paths counts once", [...times(3, () => stale(0, ["p"])), ...times(3, () => stale(0, ["q"])), stale(0, ["p", "q"])], [7, 3, 5]],
    ["a path listed twice in one abort is bumped once", times(2, () => stale(0, ["p", "p"])), [2, 0, 1]],
    ["text conflicts bump heat and count as stale aborts", times(3, () => conflict(0, ["p"])), [3, 1, 2]],
    ["stale reads and text conflicts heat the same file", [stale(0, ["p"]), conflict(0, ["p"]), stale(0, ["p"])], [3, 1, 2]],
    ["a third attempt recorded as an abort counts and heats", times(3, () => aborted(0, ["p"], { state: "stale", reason: "stale_read" })), [3, 1, 2]],
    ["an abort that was not stale neither counts nor heats", [aborted(0, ["p"], { state: "failed", reason: "tests" }), aborted(0, ["p"], { state: "failed", reason: "tests" }), stale(0, ["p"])], [1, 0, 0]],
    ["a stale op without paths counts but is never on a hot file", [stale(0, []), stale(0, [])], [2, 0, 0]],
    ["other ops are ignored", [op("heat.changed", null, 0, { path: "p", value: 9, hot: true }), op("txn.landed", "t_1"), stale(0, ["p"])], [1, 0, 0]],
  ];
  for (const [name, ops, [all, hot, inclusive]] of rows) {
    it(name, () => {
      const s = contentionStats(ops);
      assert.deepEqual([s.staleAborts, s.hotStaleAborts, s.hotStaleAbortsInclusive], [all, hot, inclusive]);
    });
  }

  it("replays by seq whatever order the ops arrive in", () => {
    const ops = [...times(2, () => stale(0, ["p"])), stale(0, ["p"])];
    assert.deepEqual(contentionStats([...ops].reverse()), contentionStats(ops));
    assert.equal(contentionStats([...ops].reverse()).hotStaleAborts, 1);
  });

  it("does not modify the list it is given", () => {
    const ops = [stale(5, ["p"]), stale(1, ["p"])];
    const before = ops.map((o) => o.seq);
    contentionStats(ops);
    assert.deepEqual(ops.map((o) => o.seq), before);
  });

  it("names the hot files and how often each was aborted while hot", () => {
    const s = contentionStats([...times(3, () => stale(0, ["src/format.ts"])), stale(0, ["src/format.ts", "src/ui/layout.ts"]), stale(0, ["src/ui/layout.ts"])]);
    assert.deepEqual(s.hotByPath, { "src/format.ts": 2 });
  });

  it("counts lease waits as distinct transactions, and the waiting ops separately", () => {
    const s = contentionStats([op("lease.waiting", "t_1"), op("lease.waiting", "t_1"), op("lease.waiting", "t_2"), op("lease.granted", "t_3"), op("lease.waiting", null)]);
    assert.deepEqual([s.leaseWaits, s.leaseWaitOps, s.leaseGrants], [2, 4, 1]);
  });

  it("counts every lease grant, whoever got it", () => {
    const s = contentionStats([op("lease.granted", "t_1"), op("lease.granted", "t_1"), op("lease.granted", "t_2"), op("lease.released", "t_1"), op("lease.waiting", "t_3")]);
    assert.equal(s.leaseGrants, 3);
  });

  it("counts each landed transaction once", () => {
    const s = contentionStats([op("txn.landed", "t_1"), op("txn.landed", "t_1"), op("txn.landed", "t_2"), op("txn.stale", "t_3"), op("txn.landed", null)]);
    assert.equal(s.landed, 2);
  });
});

describe("landedPerMinute", () => {
  const rows = [
    ["12 in a minute", 12, 60_000, 12],
    ["6 in half a minute", 6, 30_000, 12],
    ["nothing landed", 0, 5 * MIN, 0],
    ["an instant run is floored at one second", 5, 0, 300],
    ["so is a run shorter than a second", 5, 10, 300],
    ["37 in 5 minutes", 37, 5 * MIN, 7.4],
  ];
  for (const [name, landed, wallMs, want] of rows) {
    it(name, () => assert.ok(Math.abs(landedPerMinute(landed, wallMs) - want) < 1e-9));
  }
});

describe("contentionVerdict", () => {
  // The baseline never leases anything; the contention-on run defaults to one in which leases made someone
  // wait, so a row only has to name what it changes.
  const baseline = (hot, trunkGreen = true) => ({ hotStaleAborts: hot, trunkGreen, leaseGrants: 0, leaseWaits: 0 });
  const leased = (hot, over = {}) => ({ hotStaleAborts: hot, trunkGreen: true, leaseGrants: 40, leaseWaits: 5, ...over });
  const NOT_EXERCISED = "contention on granted no leases (0 lease.granted ops), so the lease mechanism was not exercised";
  const reduced = (off, on) => `contention on did not reduce stale aborts on hot files: off ${off}, on ${on}`;
  const rows = [
    // Leases made someone wait: the hot-file claim is asserted, exactly as before.
    ["waits, fewer hot aborts with contention on, both trunks green", baseline(9), leased(3), []],
    ["waits, one fewer is enough", baseline(2), leased(1), []],
    ["waits, equal numbers are not a reduction", baseline(3), leased(3), [reduced(3, 3)]],
    ["waits, more with contention on is not a reduction", baseline(3), leased(5), [reduced(3, 5)]],
    ["waits, no hot aborts at all in the baseline proves nothing", baseline(0), leased(0), [reduced(0, 0)]],
    ["a single wait is enough to assert the hot-file claim", baseline(3), leased(5, { leaseWaits: 1 }), [reduced(3, 5)]],
    // Nobody waited: leases changed nothing, so the difference is noise and is not asserted either way.
    ["no waits, more hot aborts with contention on (24 off, 25 on at e080cb1) is not a failure", baseline(24), leased(25, { leaseWaits: 0 }), []],
    ["no waits, fewer hot aborts with contention on is not credited to leases and not a failure either", baseline(28), leased(24, { leaseWaits: 0 }), []],
    ["no waits, equal hot aborts", baseline(3), leased(3, { leaseWaits: 0 }), []],
    ["no waits and no hot aborts at all", baseline(0), leased(0, { leaseWaits: 0 }), []],
    // The mechanism must have been exercised in the on run, whether or not anyone waited.
    ["no leases granted with contention on fails, waits or not", baseline(9), leased(3, { leaseGrants: 0, leaseWaits: 0 }), [NOT_EXERCISED]],
    ["no leases granted fails even when the hot-file numbers look right", baseline(9), leased(3, { leaseGrants: 0 }), [NOT_EXERCISED]],
    ["no leases granted and waits with worse hot numbers fails both", baseline(3), leased(5, { leaseGrants: 0 }), [NOT_EXERCISED, reduced(3, 5)]],
    ["a grant count that is missing is no grant", baseline(9), leased(3, { leaseGrants: undefined, leaseWaits: 0 }), [NOT_EXERCISED]],
    // Missing data is a failure, never a silent pass.
    ["a wait count that is missing fails", baseline(9), leased(3, { leaseWaits: undefined }), ["contention on has no lease wait count, so it is unknown whether leases made anyone wait"]],
    ["a wait count that is not a number fails", baseline(9), leased(3, { leaseWaits: "7" }), ["contention on has no lease wait count, so it is unknown whether leases made anyone wait"]],
    ["a missing hot count on the on run fails when waits make it matter", baseline(9), leased(undefined), ["contention on made transactions wait, so hot-file stale aborts are compared, but a count is missing: off 9, on undefined"]],
    ["a missing hot count on the baseline fails when waits make it matter", baseline(undefined), leased(3), ["contention on made transactions wait, so hot-file stale aborts are compared, but a count is missing: off undefined, on 3"]],
    ["a missing hot count is nobody's business when nobody waited", baseline(undefined), leased(undefined, { leaseWaits: 0 }), []],
    // Trunks.
    ["a red trunk with contention on is reported", baseline(9), leased(3, { trunkGreen: false }), ["the trunk of the contention on run is not green"]],
    ["a red trunk with contention off is reported", baseline(9, false), leased(3), ["the trunk of the contention off run is not green"]],
    ["a trunk that was not checked is not green", baseline(9), leased(3, { trunkGreen: null }), ["the trunk of the contention on run is not green"]],
    ["a red trunk is reported when nobody waited too", baseline(9), leased(3, { trunkGreen: false, leaseWaits: 0 }), ["the trunk of the contention on run is not green"]],
    [
      "everything wrong at once reports everything",
      baseline(3, false),
      leased(5, { trunkGreen: false, leaseGrants: 0 }),
      ["the trunk of the contention off run is not green", "the trunk of the contention on run is not green", NOT_EXERCISED, reduced(3, 5)],
    ],
  ];
  for (const [name, off, on, want] of rows) {
    it(name, () => assert.deepEqual(contentionVerdict({ off, on }), want));
  }
});

describe("contentionCaveats", () => {
  const run = (leaseGrants, leaseWaits) => ({ leaseGrants, leaseWaits });
  const NO_WAITS = (grants) =>
    `contention on never made a transaction wait for a lease (${grants} grants, 0 waits), so leases changed nothing in this run: the hot-file difference between the runs is reported, not asserted, and the lease effect is the bench leg's`;
  const rows = [
    ["leases made someone wait with contention on, none with it off", run(0, 0), run(228, 7), []],
    ["contention on granted leases but never made anyone wait", run(0, 0), run(228, 0), [NO_WAITS(228)]],
    ["contention on did not even grant one", run(0, 0), run(0, 0), [NO_WAITS(0)]],
    ["contention off recorded leases", run(3, 0), run(228, 7), ["contention off still recorded 3 lease grants and 0 waits"]],
    ["contention off recorded waits", run(0, 2), run(228, 7), ["contention off still recorded 0 lease grants and 2 waits"]],
    ["both caveats", run(1, 1), run(0, 0), [NO_WAITS(0), "contention off still recorded 1 lease grants and 1 waits"]],
  ];
  for (const [name, off, on, want] of rows) {
    it(name, () => assert.deepEqual(contentionCaveats({ off, on }), want));
  }
});

describe("formatComparison", () => {
  const off = { staleAborts: 14, hotStaleAborts: 9, hotStaleAbortsInclusive: 11, leaseGrants: 0, leaseWaits: 0, landed: 36, wallMs: 5 * MIN + 7000, landedPerMinute: 6.9, trunkGreen: true };
  const on = { staleAborts: 8, hotStaleAborts: 3, hotStaleAbortsInclusive: 4, leaseGrants: 228, leaseWaits: 7, landed: 37, wallMs: 49_000, landedPerMinute: 45.31, trunkGreen: false };
  const text = formatComparison({ off, on });
  const rows = [
    [/^\s+off\s+on$/m, "a header with the baseline first"],
    [/^stale aborts, all\s+14\s+8$/m, "all stale aborts"],
    [/^stale aborts on hot files\s+9\s+3$/m, "the headline row"],
    [/^\s+\(incl\. the abort that made the file hot\)\s+11\s+4$/m, "the inclusive variant, indented under the headline"],
    [/^lease grants \(ops\)\s+0\s+228$/m, "lease grants"],
    [/^lease waits \(distinct txns\)\s+0\s+7$/m, "lease waits"],
    [/^landed\s+36\s+37$/m, "landed"],
    [/^wall time\s+5m 07s\s+49s$/m, "durations in minutes and seconds"],
    [/^landed\/min\s+6\.9\s+45\.3$/m, "rates with one decimal"],
    [/^trunk green\s+yes\s+NO$/m, "a red trunk is loud"],
  ];
  for (const [pattern, name] of rows) {
    it(`has ${name}`, () => assert.match(text, pattern));
  }
  it("lines every column up", () => {
    const widths = new Set(text.split("\n").map((l) => l.length));
    assert.equal(widths.size, 1, text);
  });
});

// ---------------------------------------------------------------------------------------------
// The bench leg: `ryke` against `ryke-nolease` on the bench workload (harness/bench.mjs, runBench)
// ---------------------------------------------------------------------------------------------

describe("isBenchHotPath", () => {
  const rows = [
    ["the hottest file by reads and writes", "src/format.ts", true],
    ["the second", "src/ui/layout.ts", true],
    ["the third, which is a union path and never aborts anything but is still hot", "src/registry.ts", true],
    ["a pin of a hot constant is rewritten by whoever changes it, so it heats with it", "src/bench/pin-seed-format.ts", true],
    ["any pin", "src/bench/pin-a1b2.ts", true],
    ["a file that merely gets aborted a lot is not hot by the workload's definition", "src/ui/html.ts", false],
    ["a new unit", "src/units/temperature.ts", false],
    ["a pin-like name outside the pin directory", "src/pin-seed-format.ts", false],
    ["a nested path under the pin directory", "src/bench/sub/pin-x.ts", false],
    ["a test file", "test/format.test.ts", false],
    ["a similar name", "src/format.tsx", false],
    ["an empty path", "", false],
  ];
  for (const [name, path, want] of rows) {
    it(name, () => assert.equal(isBenchHotPath(path), want));
  }
});

describe("benchCellStats", () => {
  // What runBench hands over for one cell: the results cell and the details entry ({policy, agents, ...detail}).
  const cell = (over = {}) => ({ policy: "ryke", agents: 50, landed: 40, landedPerMinute: 40, p50: 12, p95: 30, aborts: { stale_read: 20, max_attempts: 2 }, verifyRunsPerLanded: 0.3, wastedAgentSeconds: 90.5, trunkBreakages: 0, ...over });
  const detail = (over = {}) => ({
    policy: "ryke",
    agents: 50,
    leaseWaits: 9,
    leaseWaitSeconds: 41.5,
    errors: 0,
    ryke: { staleAborts: 18, stalePaths: { "src/format.ts": 6, "src/ui/layout.ts": 4, "src/bench/pin-seed-format.ts": 3, "src/units/temperature.ts": 5 } },
    ...over,
  });

  it("reads the headline numbers off the cell and its details", () => {
    assert.deepEqual(benchCellStats(cell(), detail()), {
      policy: "ryke",
      agents: 50,
      landed: 40,
      landedPerMinute: 40,
      staleAborts: 20,
      hotStaleAborts: 13,
      leaseWaits: 9,
      leaseWaitSeconds: 41.5,
      trunkBreakages: 0,
      errors: 0,
    });
  });

  const hot = [
    ["only the workload's hot files and pins are summed", { "src/format.ts": 6, "src/ui/layout.ts": 4, "src/registry.ts": 1, "src/bench/pin-x.ts": 2, "src/ui/html.ts": 20 }, 13],
    ["no stale aborts at all is zero, not missing", {}, 0],
    ["only cold files is zero", { "src/ui/html.ts": 20 }, 0],
    ["a count that is not a number is ignored", { "src/format.ts": 6, "src/ui/layout.ts": "4", "src/registry.ts": null }, 6],
  ];
  for (const [name, stalePaths, want] of hot) {
    it(`hot-file aborts: ${name}`, () => assert.equal(benchCellStats(cell(), detail({ ryke: { stalePaths } })).hotStaleAborts, want));
  }

  it("a cell without a stale_read entry had none", () => assert.equal(benchCellStats(cell({ aborts: { max_attempts: 1 } }), detail()).staleAborts, 0));
  it("a cell with an empty abort map had none", () => assert.equal(benchCellStats(cell({ aborts: {} }), detail()).staleAborts, 0));

  const missing = [
    ["no aborts map on the cell", cell({ aborts: undefined }), detail(), "staleAborts"],
    ["an aborts value that is not a map", cell({ aborts: 7 }), detail(), "staleAborts"],
    ["no ryke section in the details (a baseline policy)", cell(), detail({ ryke: null }), "hotStaleAborts"],
    ["no stalePaths in the ryke section", cell(), detail({ ryke: { staleAborts: 3 } }), "hotStaleAborts"],
    ["stalePaths that is not a map", cell(), detail({ ryke: { stalePaths: 5 } }), "hotStaleAborts"],
    ["no lease wait count in the details", cell(), detail({ leaseWaits: undefined }), "leaseWaits"],
    ["no landed/min on the cell", cell({ landedPerMinute: undefined }), detail(), "landedPerMinute"],
  ];
  for (const [name, c, d, field] of missing) {
    it(`missing data stays missing (null), never zero: ${name}`, () => assert.equal(benchCellStats(c, d)[field], null));
  }

  it("no cell and no details at all is every number missing", () => {
    const s = benchCellStats(undefined, undefined);
    assert.deepEqual(
      Object.values(s).filter((v) => v !== null),
      [],
    );
  });
  it("a cell without details still reports what the cell has", () => {
    const s = benchCellStats(cell(), undefined);
    assert.deepEqual([s.landedPerMinute, s.staleAborts, s.hotStaleAborts, s.leaseWaits], [40, 20, null, null]);
  });
});

describe("benchVerdict", () => {
  const stats = (over = {}) => ({ landedPerMinute: 40, staleAborts: 30, hotStaleAborts: 20, leaseWaits: 6, trunkBreakages: 0, errors: 0, ...over });
  // The baseline (`ryke-nolease`) never waits; the run with leases defaults to one that did and contended less.
  const nolease = (over = {}) => stats({ staleAborts: 60, hotStaleAborts: 45, leaseWaits: 0, ...over });
  const ryke = (over = {}) => stats(over);
  const NO_WAIT = "the bench ryke cell never made an agent wait for a lease (0 lease waits), so it shows nothing about leases";
  const NOT_FEWER = (off, on) => `in the bench, leases did not reduce stale_read aborts on hot files: ryke-nolease ${off}, ryke ${on}`;
  const rows = [
    ["fewer hot-file aborts with leases and at least one wait passes", nolease(), ryke(), []],
    ["one fewer is enough", nolease({ hotStaleAborts: 11 }), ryke({ hotStaleAborts: 10 }), []],
    ["a single lease wait is enough", nolease(), ryke({ leaseWaits: 1 }), []],
    ["more stale aborts overall do not matter while the hot-file ones are fewer", nolease({ staleAborts: 10 }), ryke({ staleAborts: 90 }), []],
    ["equal hot-file aborts are not a reduction", nolease({ hotStaleAborts: 20 }), ryke({ hotStaleAborts: 20 }), [NOT_FEWER(20, 20)]],
    ["more hot-file aborts with leases are not a reduction", nolease({ hotStaleAborts: 20 }), ryke({ hotStaleAborts: 25 }), [NOT_FEWER(20, 25)]],
    ["no hot-file aborts at all in the baseline proves nothing", nolease({ hotStaleAborts: 0 }), ryke({ hotStaleAborts: 0 }), [NOT_FEWER(0, 0)]],
    ["zero lease waits fails even with far fewer aborts", nolease(), ryke({ leaseWaits: 0 }), [NO_WAIT]],
    ["zero lease waits and no reduction fails twice", nolease({ hotStaleAborts: 20 }), ryke({ leaseWaits: 0, hotStaleAborts: 20 }), [NO_WAIT, NOT_FEWER(20, 20)]],
    ["a lease wait count of zero on the baseline is expected", nolease({ leaseWaits: 0 }), ryke(), []],
    // Missing data is a failure that names what is missing, and nothing is compared.
    ["the baseline cell is missing", null, ryke(), ["the bench ryke-nolease cell has no result"]],
    ["the leased cell is missing", nolease(), undefined, ["the bench ryke cell has no result"]],
    ["both cells are missing", null, null, ["the bench ryke-nolease cell has no result", "the bench ryke cell has no result"]],
    ["no hot-file count on the leased cell", nolease(), ryke({ hotStaleAborts: null }), ["the bench ryke cell has no stale_read aborts on hot files"]],
    ["no hot-file count on the baseline", nolease({ hotStaleAborts: null }), ryke(), ["the bench ryke-nolease cell has no stale_read aborts on hot files"]],
    ["no lease wait count on the leased cell is not read as zero", nolease(), ryke({ leaseWaits: null }), ["the bench ryke cell has no lease waits"]],
    ["no lease wait count on the baseline", nolease({ leaseWaits: undefined }), ryke(), ["the bench ryke-nolease cell has no lease waits"]],
    ["no overall stale_read count", nolease(), ryke({ staleAborts: null }), ["the bench ryke cell has no stale_read aborts"]],
    ["no landed/min", nolease({ landedPerMinute: null }), ryke(), ["the bench ryke-nolease cell has no landed/min"]],
    ["a count that is not finite counts as missing", nolease(), ryke({ hotStaleAborts: Number.NaN, leaseWaits: Infinity }), ["the bench ryke cell has no stale_read aborts on hot files", "the bench ryke cell has no lease waits"]],
    ["missing data on one cell and a cell missing on the other reports both", nolease({ leaseWaits: null }), null, ["the bench ryke-nolease cell has no lease waits", "the bench ryke cell has no result"]],
  ];
  for (const [name, off, on, want] of rows) {
    it(name, () => assert.deepEqual(benchVerdict({ off, on }), want));
  }
});

describe("benchCaveats", () => {
  const run = (leaseWaits, errors = 0) => ({ leaseWaits, errors });
  const rows = [
    ["a clean pair has nothing to say", run(0), run(6), []],
    ["the baseline waited for a lease, so the ablation did not take", run(2), run(6), ["the bench ryke-nolease cell recorded 2 lease waits, so the ablation did not take effect and the comparison is not leases against none"]],
    ["agent errors in the leased cell", run(0), run(6, 3), ["the bench ryke cell had 3 agent error(s), so what it measured is partly the errors"]],
    ["agent errors in the baseline", run(0, 1), run(6), ["the bench ryke-nolease cell had 1 agent error(s), so what it measured is partly the errors"]],
    [
      "everything at once, baseline first",
      run(4, 2),
      run(6, 5),
      [
        "the bench ryke-nolease cell recorded 4 lease waits, so the ablation did not take effect and the comparison is not leases against none",
        "the bench ryke-nolease cell had 2 agent error(s), so what it measured is partly the errors",
        "the bench ryke cell had 5 agent error(s), so what it measured is partly the errors",
      ],
    ],
    ["missing cells are the verdict's business, not a caveat", null, undefined, []],
    ["missing counts are the verdict's business too", {}, {}, []],
  ];
  for (const [name, off, on, want] of rows) {
    it(name, () => assert.deepEqual(benchCaveats({ off, on }), want));
  }
});

describe("formatBenchComparison", () => {
  const off = { policy: "ryke-nolease", agents: 50, landed: 33, landedPerMinute: 33.04, staleAborts: 61, hotStaleAborts: 44, leaseWaits: 0, leaseWaitSeconds: 0, trunkBreakages: 0 };
  const on = { policy: "ryke", agents: 50, landed: 41, landedPerMinute: 41.5, staleAborts: 27, hotStaleAborts: 16, leaseWaits: 9, leaseWaitSeconds: 41.5, trunkBreakages: 0 };
  const text = formatBenchComparison({ off, on });
  const rows = [
    [/^\s+off\s+on$/m, "a header with the leases-off baseline first"],
    [/^policy\s+ryke-nolease\s+ryke$/m, "the policy each column ran"],
    [/^agents\s+50\s+50$/m, "agents"],
    [/^landed\s+33\s+41$/m, "landed"],
    [/^landed\/min\s+33\.0\s+41\.5$/m, "rates with one decimal"],
    [/^stale_read aborts, all\s+61\s+27$/m, "all stale_read aborts"],
    [/^stale_read aborts on hot files\s+44\s+16$/m, "the headline row"],
    [/^lease waits \(agents\)\s+0\s+9$/m, "lease waits"],
    [/^lease wait time \(s\)\s+0\s+41\.5$/m, "lease wait seconds"],
    [/^trunk breakages\s+0\s+0$/m, "trunk breakages"],
  ];
  for (const [pattern, name] of rows) {
    it(`has ${name}`, () => assert.match(text, pattern));
  }
  it("lines every column up", () => {
    const widths = new Set(text.split("\n").map((l) => l.length));
    assert.equal(widths.size, 1, text);
  });
  it("shows a number it does not have as a dash instead of NaN or undefined", () => {
    const t = formatBenchComparison({ off: { ...off, hotStaleAborts: null, landedPerMinute: undefined }, on: { ...on, leaseWaits: null } });
    assert.match(t, /^stale_read aborts on hot files\s+-\s+16$/m);
    assert.match(t, /^landed\/min\s+-\s+41\.5$/m);
    assert.match(t, /^lease waits \(agents\)\s+0\s+-$/m);
    assert.doesNotMatch(t, /NaN|undefined|null/);
  });
  it("a number that is not finite is a dash too", () => {
    const t = formatBenchComparison({ off: { ...off, landedPerMinute: Number.NaN, staleAborts: Infinity }, on });
    assert.match(t, /^landed\/min\s+-\s+41\.5$/m);
    assert.match(t, /^stale_read aborts, all\s+-\s+27$/m);
  });
  it("a missing cell is a column of dashes", () => {
    const t = formatBenchComparison({ off: null, on });
    assert.match(t, /^policy\s+-\s+ryke$/m);
    assert.match(t, /^landed\s+-\s+41$/m);
  });
});

// ---------------------------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------------------------

describe("criteriaVerdict", () => {
  const all = (overrides = {}) => M3_CRITERIA.map((id) => ({ id, text: `criterion ${id}`, pass: id in overrides ? overrides[id] : true, detail: `detail of ${id}` }));
  const rows = [
    ["every criterion passes", all(), true, []],
    ["one failure", all({ g5: false }), false, ["g5: failed (detail of g5)"]],
    ["a criterion that was not evaluated fails a full-catalogue run", all({ preview: null }), false, ["preview: not evaluated (detail of preview)"]],
    ["failures are listed in report order", all({ trunk: false, landed: null }), false, ["landed: not evaluated (detail of landed)", "trunk: failed (detail of trunk)"]],
    ["an extra criterion that passes changes nothing", [...all(), { id: "extra", text: "x", pass: true, detail: "" }], true, []],
    ["an extra criterion that fails counts", [...all(), { id: "extra", text: "x", pass: false, detail: "no" }], false, ["extra: failed (no)"]],
    ["a required criterion the report no longer has", all().filter((c) => c.id !== "precision"), false, ["precision: missing from the report"]],
    ["an empty list", [], false, ["the report has no criteria"]],
    ["no list", undefined, false, ["the report has no criteria"]],
    ["a truthy value that is not true does not pass", all({ landed: "yes" }), false, ["landed: failed (detail of landed)"]],
  ];
  for (const [name, criteria, ok, failing] of rows) {
    it(name, () => assert.deepEqual(criteriaVerdict(criteria), { ok, failing }));
  }

  it("takes the required list as an argument", () => {
    assert.deepEqual(criteriaVerdict([{ id: "a", text: "a", pass: true, detail: "" }], ["a", "b"]), { ok: false, failing: ["b: missing from the report"] });
    assert.deepEqual(criteriaVerdict([{ id: "a", text: "a", pass: true, detail: "" }], ["a"]), { ok: true, failing: [] });
  });
});

describe("formatCriteria", () => {
  it("labels pass, fail and not evaluated, with the id aligned", () => {
    const text = formatCriteria([
      { id: "landed", text: ">= 34 tasks landed", pass: true, detail: "37 landed" },
      { id: "g5", text: "G5 tamper rejected as protected", pass: false, detail: "tamper-routes landed" },
      { id: "preview", text: "preview renders all landed categories", pass: null, detail: "not checked" },
    ]);
    assert.deepEqual(text.split("\n"), [
      "  [PASS] landed   >= 34 tasks landed: 37 landed",
      "  [FAIL] g5       G5 tamper rejected as protected: tamper-routes landed",
      "  [n/a ] preview  preview renders all landed categories: not checked",
    ]);
  });

  it("prints nothing for no criteria", () => assert.equal(formatCriteria([]), ""));
});

describe("claudeVerdict", () => {
  const tasks = [
    { id: "t-precision", expect: "land" },
    { id: "cat-area", expect: "land" },
    { id: "tamper-routes", expect: "reject_protected" },
  ];
  const landed = (task, attempts = 1) => ({ task, outcome: "landed", reason: null, attempts });
  const rejected = { task: "tamper-routes", outcome: "rejected", reason: "protected", attempts: 1 };
  const green = { trunk: { pass: true } };
  const good = [landed("t-precision"), landed("cat-area", 2), rejected];
  const rows = [
    ["everything lands, the tamper task is rejected, one retry, trunk green", good, green, []],
    ["a task that was aborted", [landed("t-precision"), { task: "cat-area", outcome: "aborted", reason: "agent_error", attempts: 1 }, rejected, landed("x", 2)], green, ["cat-area: aborted (agent_error), expected landed"]],
    ["a task that ended in error", [landed("t-precision", 2), { task: "cat-area", outcome: "error", reason: null, attempts: 0 }, rejected], green, ["cat-area: error, expected landed"]],
    ["the tamper task landed", [landed("t-precision"), landed("cat-area", 2), landed("tamper-routes")], green, ["tamper-routes: landed, expected rejected (protected)"]],
    ["the tamper task was rejected for another reason", [landed("t-precision"), landed("cat-area", 2), { ...rejected, reason: "duplicate_of:t_1" }], green, ["tamper-routes: rejected (duplicate_of:t_1), expected rejected (protected)"]],
    ["a task with no result", [landed("t-precision", 2), rejected], green, ["cat-area: no result"]],
    ["nothing needed a second attempt", [landed("t-precision"), landed("cat-area"), rejected], green, ["no landed task needed a second attempt, so no retry was exercised"]],
    ["only a task that did not land retried", [landed("t-precision"), landed("cat-area"), { ...rejected, attempts: 2 }], green, ["no landed task needed a second attempt, so no retry was exercised"]],
    ["the trunk is red", good, { trunk: { pass: false, failing: ["units: area", "format: digits"] } }, ["final trunk tests did not pass: units: area; format: digits"]],
    ["the trunk is red with an error", good, { trunk: { pass: false, error: "store head differs" } }, ["final trunk tests did not pass: store head differs"]],
    ["the trunk was not checked", good, { trunk: null }, ["final trunk tests did not pass: not checked"]],
    ["no report", good, undefined, ["final trunk tests did not pass: not checked"]],
  ];
  for (const [name, results, report, want] of rows) {
    it(name, () => assert.deepEqual(claudeVerdict({ tasks, results, report }), want));
  }
});

// ---------------------------------------------------------------------------------------------
// The production config
// ---------------------------------------------------------------------------------------------

describe("production config", () => {
  // What `CLOUDFLARE_ENV=production vite build` should emit, reduced to the keys the checks read.
  const good = () => ({
    name: "ryke",
    routes: [{ pattern: "ryke.ai", custom_domain: true }],
    vars: { RYKE_STORE: "artifacts", RYKE_RUNNER: "container", RYKE_JEV: "live", RYKE_NAMESPACE: "ryke", RYKE_STORE_URL: "", RYKE_RUNNER_URL: "", RYKE_SCREENSHOTS: "1", RYKE_RUNNER_SLOTS: "6" },
    durable_objects: { bindings: [{ name: "LEDGER", class_name: "Ledger" }, { name: "RUNNER", class_name: "Runner" }] },
    workflows: [{ name: "ryke-land", binding: "LAND", class_name: "Land" }, { name: "ryke-ingest", binding: "INGEST", class_name: "Ingest" }],
    worker_loaders: [{ binding: "LOADER" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: "ryke" }],
    containers: [{ name: "runner", class_name: "Runner", image: "./containers/runner/Dockerfile" }],
    triggers: { events: [{ type: "cf.artifacts.repo.pushed", filter: { namespace: "ryke" }, targets: [{ type: "workflow", workflow_name: "ryke-ingest" }] }] },
  });
  const without = (path) => (cfg) => {
    const keys = path.split(".");
    let node = cfg;
    for (const k of keys.slice(0, -1)) node = node[k];
    delete node[keys.at(-1)];
  };
  const set = (path, value) => (cfg) => {
    const keys = path.split(".");
    let node = cfg;
    for (const k of keys.slice(0, -1)) node = node[k];
    node[keys.at(-1)] = value;
  };

  // [name, change to the good config, the one failure it must produce]
  const rows = [
    ["the store is local", set("vars.RYKE_STORE", "local"), 'vars.RYKE_STORE is "local", expected "artifacts"'],
    ["the runner is a process", set("vars.RYKE_RUNNER", "process"), 'vars.RYKE_RUNNER is "process", expected "container"'],
    ["Jev is recorded", set("vars.RYKE_JEV", "recorded"), 'vars.RYKE_JEV is "recorded", expected "live"'],
    ["Jev is not set", without("vars.RYKE_JEV"), 'vars.RYKE_JEV is undefined, expected "live"'],
    ...["RYKE_TOKEN", "RYKE_INTERNAL_SECRET", "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY"].map((name) => [`${name} is a var`, set(`vars.${name}`, "x"), `vars contains the secret ${name}; it belongs in \`wrangler secret put\``]),
    ["the store URL is the local one", set("vars.RYKE_STORE_URL", "http://127.0.0.1:8788"), "vars.RYKE_STORE_URL points at a local address: http://127.0.0.1:8788"],
    ["the runner URL says localhost", set("vars.RYKE_RUNNER_URL", "http://localhost:8789"), "vars.RYKE_RUNNER_URL points at a local address: http://localhost:8789"],
    ["a var points at an IPv6 loopback", set("vars.OTHER", "http://[::1]:9"), "vars.OTHER points at a local address: http://[::1]:9"],
    ...REQUIRED_BINDINGS.map((name) => {
      const remove = {
        LEDGER: (c) => c.durable_objects.bindings.splice(0, 1),
        RUNNER: (c) => c.durable_objects.bindings.splice(1, 1),
        LAND: (c) => c.workflows.splice(0, 1),
        INGEST: (c) => c.workflows.splice(1, 1),
        LOADER: set("worker_loaders", []),
        ARTIFACTS: without("artifacts"),
      }[name];
      return [`binding ${name} is gone`, remove, `binding ${name} is missing`];
    }),
    ["containers is empty", set("containers", []), "containers is missing or empty"],
    ["containers is missing", without("containers"), "containers is missing or empty"],
    ["triggers is empty", set("triggers", {}), "triggers.events is missing or empty"],
    ["triggers.events is empty", set("triggers.events", []), "triggers.events is missing or empty"],
    ["routes is empty", set("routes", []), "routes is missing or empty"],
    ["routes is missing", without("routes"), "routes is missing or empty"],
  ];

  it("accepts the production configuration", () => assert.deepEqual(checkProductionConfig(good()), []));

  for (const [name, change, failure] of rows) {
    it(`rejects it when ${name}`, () => {
      const cfg = good();
      change(cfg);
      assert.deepEqual(checkProductionConfig(cfg), [failure]);
    });
  }

  it("reports every problem of the development config the Vite plugin emitted before the fix", () => {
    const leaked = good();
    Object.assign(leaked.vars, { RYKE_STORE: "local", RYKE_RUNNER: "process", RYKE_STORE_URL: "http://127.0.0.1:8788", RYKE_RUNNER_URL: "http://127.0.0.1:8789", RYKE_TOKEN: "dev", RYKE_INTERNAL_SECRET: "dev" });
    assert.deepEqual(checkProductionConfig(leaked), [
      'vars.RYKE_STORE is "local", expected "artifacts"',
      'vars.RYKE_RUNNER is "process", expected "container"',
      "vars contains the secret RYKE_TOKEN; it belongs in `wrangler secret put`",
      "vars contains the secret RYKE_INTERNAL_SECRET; it belongs in `wrangler secret put`",
      "vars.RYKE_STORE_URL points at a local address: http://127.0.0.1:8788",
      "vars.RYKE_RUNNER_URL points at a local address: http://127.0.0.1:8789",
    ]);
  });

  it("flags an empty or absent config for everything at once", () => {
    for (const cfg of [{}, undefined, null]) assert.equal(checkProductionConfig(cfg).length, 3 + REQUIRED_BINDINGS.length + 3);
  });

  describe("secrets from .dev.vars", () => {
    it("finds one under a var name nobody thought of", () => {
      const cfg = good();
      cfg.vars.SOMETHING_ELSE = "prefix-0123456789abcdef-suffix";
      assert.deepEqual(checkProductionConfig(cfg, { devSecrets: ["0123456789abcdef"] }), ["the config contains a value from .dev.vars"]);
    });
    it("finds one anywhere else in the config", () => {
      const cfg = good();
      cfg.name = "ryke-0123456789abcdef";
      assert.deepEqual(checkProductionConfig(cfg, { devSecrets: ["0123456789abcdef"] }), ["the config contains a value from .dev.vars"]);
    });
    it("does not look for short values such as the dev token, which would match ordinary text", () => {
      assert.deepEqual(checkProductionConfig(good(), { devSecrets: ["dev", "ryke", "1234567", ""] }), []);
    });
    it("ignores values that are not strings", () => {
      assert.deepEqual(checkProductionConfig(good(), { devSecrets: [undefined, 123456789, null] }), []);
    });
    it("passes when none is present", () => {
      assert.deepEqual(checkProductionConfig(good(), { devSecrets: ["0123456789abcdef"] }), []);
    });
  });

  describe("parseDevVarEntries", () => {
    it("keeps the names, in file order, with unquoted values", () => {
      assert.deepEqual(parseDevVarEntries('# c\nRYKE_TOKEN=a\nexport TYPESAFE_API_KEY="k k"\nEMPTY=\nnot an entry\nRYKE_INTERNAL_SECRET = \'s\'\r\n'), [
        ["RYKE_TOKEN", "a"],
        ["TYPESAFE_API_KEY", "k k"],
        ["RYKE_INTERNAL_SECRET", "s"],
      ]);
    });
    it("is empty for nothing", () => assert.deepEqual(parseDevVarEntries(""), []));
  });

  describe("jevPlan", () => {
    const rows = [
      ["the key is in .dev.vars", { devVars: "RYKE_TOKEN=a\nTYPESAFE_API_KEY=k", env: {} }, { ok: true, mode: "live", source: ".dev.vars" }],
      ["the key is only in the environment", { devVars: "RYKE_TOKEN=a", env: { TYPESAFE_API_KEY: "k" } }, { ok: true, mode: "live", source: "the environment" }],
      ["the key is in both, and the file is what the Worker loads", { devVars: "TYPESAFE_API_KEY=k", env: { TYPESAFE_API_KEY: "e" } }, { ok: true, mode: "live", source: ".dev.vars" }],
      ["no .dev.vars and no environment", { devVars: "", env: {} }, { ok: false, reason: "G3 not judged (no Jev key): TYPESAFE_API_KEY is in neither .dev.vars nor the environment, so there is no judge to call a duplicate" }],
      ["an empty key in the file does not count", { devVars: "TYPESAFE_API_KEY=\n", env: {} }, { ok: false, reason: "G3 not judged (no Jev key): TYPESAFE_API_KEY is in neither .dev.vars nor the environment, so there is no judge to call a duplicate" }],
      ["an empty key in the environment does not count", { devVars: "", env: { TYPESAFE_API_KEY: "" } }, { ok: false, reason: "G3 not judged (no Jev key): TYPESAFE_API_KEY is in neither .dev.vars nor the environment, so there is no judge to call a duplicate" }],
      ["a commented-out key does not count", { devVars: "# TYPESAFE_API_KEY=k", env: {} }, { ok: false, reason: "G3 not judged (no Jev key): TYPESAFE_API_KEY is in neither .dev.vars nor the environment, so there is no judge to call a duplicate" }],
      ["other keys do not count", { devVars: "ANTHROPIC_API_KEY=k", env: { ANTHROPIC_API_KEY: "k" } }, { ok: false, reason: "G3 not judged (no Jev key): TYPESAFE_API_KEY is in neither .dev.vars nor the environment, so there is no judge to call a duplicate" }],
    ];
    for (const [name, input, want] of rows) {
      it(name, () => assert.deepEqual(jevPlan(input), want));
    }
    it("defaults to nothing", () => assert.equal(jevPlan().ok, false));
  });

  describe("parseDevVars", () => {
    const rows = [
      ["KEY=value lines", "RYKE_TOKEN=abc123\nTYPESAFE_API_KEY=xyz", ["abc123", "xyz"]],
      ["double and single quotes are removed", 'A="one two"\nB=\'three\'', ["one two", "three"]],
      ["an unbalanced quote is kept", 'A="open\nB=close"', ['"open', 'close"']],
      ["export prefix and spaces around the equals sign", "export A = b c \n  C=d", ["b c", "d"]],
      ["comments and blank lines are not values", "# RYKE_TOKEN=nope\n\n   \nA=1", ["1"]],
      ["lines without an equals sign are not values", "just some words\nA=1", ["1"]],
      ["empty values are dropped", "A=\nB=\"\"\nC=3", ["3"]],
      ["a value may contain an equals sign", "A=b=c==", ["b=c=="]],
      ["windows line endings", "A=1\r\nB=2\r\n", ["1", "2"]],
      ["nothing", "", []],
    ];
    for (const [name, text, want] of rows) {
      it(name, () => assert.deepEqual(parseDevVars(text), want));
    }
  });

  describe("bindingNames", () => {
    it("collects Durable Object names and the binding of every list", () => {
      assert.deepEqual([...bindingNames(good())].sort(), ["ARTIFACTS", "INGEST", "LAND", "LEDGER", "LOADER", "RUNNER"]);
    });
    it("ignores lists whose items have no binding, and values that are not lists", () => {
      const cfg = { containers: [{ name: "runner" }], routes: [{ pattern: "ryke.ai" }], vars: { binding: "NOT_A_BINDING" }, name: "x", kv_namespaces: [{ binding: "KV", id: "1" }] };
      assert.deepEqual([...bindingNames(cfg)], ["KV"]);
    });
    it("is empty for nothing", () => {
      assert.deepEqual([...bindingNames(undefined)], []);
      assert.deepEqual([...bindingNames({})], []);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------------------------

describe("commandLine", () => {
  const secrets = { RYKE_TOKEN: "dev", FORK_TOKEN: "f0rk.t0ken-123" };
  const vars = { API: "http://127.0.0.1:5173", WORK: "/tmp/ryke-agent-a1b2" };

  const rows = [
    [
      "a curl with the bearer token and a JSON body",
      ["curl", "-sS", "-X", "POST", "http://127.0.0.1:5173/api/repos", "-H", "Authorization: Bearer dev", "-H", "content-type: application/json", "-d", '{"name":"convert","seedFrom":"convert"}'],
      `curl -sS -X POST "$API/api/repos" -H "Authorization: Bearer $RYKE_TOKEN" -H 'content-type: application/json' -d '{"name":"convert","seedFrom":"convert"}'`,
    ],
    ["a curl without credentials", ["curl", "-sS", "http://127.0.0.1:5173/api/health"], 'curl -sS "$API/api/health"'],
    [
      "git with the fork token in an extra header",
      ["git", "-c", "http.extraHeader=Authorization: Bearer f0rk.t0ken-123", "clone", "-q", "http://127.0.0.1:8788/git/t_abc.git", "/tmp/ryke-agent-a1b2"],
      `git -c "http.extraHeader=Authorization: Bearer $FORK_TOKEN" clone -q http://127.0.0.1:8788/git/t_abc.git "$WORK"`,
    ],
    ["a token that is not behind \"Bearer\" is left alone", ["echo", "dev", "developer"], "echo dev developer"],
    ["a token that is only the start of a longer one is left alone", ["curl", "-H", "Authorization: Bearer devices"], "curl -H 'Authorization: Bearer devices'"],
    ["a token followed by a dot or dash continues the token", ["curl", "-H", "Authorization: Bearer dev.more", "-H", "Authorization: Bearer dev-more"], "curl -H 'Authorization: Bearer dev.more' -H 'Authorization: Bearer dev-more'"],
    ["the same token twice in one word", ["x", "Bearer dev and Bearer dev"], 'x "Bearer $RYKE_TOKEN and Bearer $RYKE_TOKEN"'],
    ["a placeholder followed by a path", ["cat", "/tmp/ryke-agent-a1b2/src/format.ts"], 'cat "$WORK/src/format.ts"'],
    ["a placeholder followed by a letter is braced so it still expands", ["cat", "/tmp/ryke-agent-a1b2x"], 'cat "${WORK}x"'],
    ["a placeholder followed by a digit or underscore is braced", ["a", "/tmp/ryke-agent-a1b22", "b", "/tmp/ryke-agent-a1b2_"], 'a "${WORK}2" b "${WORK}_"'],
    ["a placeholder at the end of a word", ["git", "-C", "/tmp/ryke-agent-a1b2", "status"], 'git -C "$WORK" status'],
    ["a literal dollar in an ordinary word stays literal", ["echo", "$HOME", "a$b"], "echo '$HOME' 'a$b'"],
    ["a literal dollar, quote and backslash next to a placeholder are escaped", ["echo", 'say "hi" $x \\ `y` /tmp/ryke-agent-a1b2'], 'echo "say \\"hi\\" \\$x \\\\ \\`y\\` $WORK"'],
    ["a single quote in an unmarked word", ["echo", "it's"], "echo 'it'\\''s'"],
    ["an empty word", ["echo", ""], "echo ''"],
    ["a word with spaces", ["git", "commit", "-m", "Add a comment"], "git commit -m 'Add a comment'"],
    ["numbers are words", ["head", "-n", 5], "head -n 5"],
    ["flags with = need no quotes, urls with a query do", ["x", "--out=/tmp/a.json", "https://ryke.ai/api/x?a=1"], "x --out=/tmp/a.json 'https://ryke.ai/api/x?a=1'"],
  ];
  for (const [name, argv, want] of rows) {
    it(name, () => assert.equal(commandLine(argv, { secrets, vars }), want));
  }

  it("never prints a secret, in either order of declaration", () => {
    const argv = ["git", "-c", "http.extraHeader=Authorization: Bearer f0rk.t0ken-123", "curl", "-H", "Authorization: Bearer dev"];
    for (const order of [secrets, { FORK_TOKEN: secrets.FORK_TOKEN, RYKE_TOKEN: secrets.RYKE_TOKEN }]) {
      const line = commandLine(argv, { secrets: order });
      assert.ok(!line.includes("f0rk.t0ken-123"), line);
      assert.match(line, /Bearer \$FORK_TOKEN/);
      assert.match(line, /Bearer \$RYKE_TOKEN/);
    }
  });

  it("prefers the longer of two secrets that share a prefix", () => {
    const line = commandLine(["curl", "-H", "Authorization: Bearer tok-long"], { secrets: { SHORT: "tok", LONG: "tok-long" } });
    assert.equal(line, 'curl -H "Authorization: Bearer $LONG"');
  });

  it("replaces the longer of two vars first", () => {
    const line = commandLine(["curl", "http://h:1/a/b"], { vars: { HOST: "http://h:1", PATHED: "http://h:1/a" } });
    assert.equal(line, 'curl "$PATHED/b"');
  });

  it("ignores empty secrets and vars", () => {
    assert.equal(commandLine(["echo", "Bearer x", "abc"], { secrets: { E: "" }, vars: { V: "" } }), "echo 'Bearer x' abc");
  });

  it("works without any secrets or vars", () => {
    assert.equal(commandLine(["ls", "-la"]), "ls -la");
  });

  it("does not interpret regex characters in a secret", () => {
    assert.equal(commandLine(["curl", "-H", "Authorization: Bearer a.b+c"], { secrets: { T: "a.b+c" } }), 'curl -H "Authorization: Bearer $T"');
    assert.equal(commandLine(["curl", "-H", "Authorization: Bearer aXb+c"], { secrets: { T: "a.b+c" } }), "curl -H 'Authorization: Bearer aXb+c'");
  });
});

describe("redactTokens", () => {
  const rows = [
    ["a token at the top", { txn: "t_1", token: "secret" }, { txn: "t_1", token: "<redacted>" }],
    ["tokens nested in objects and arrays", { trunk: { remote: "http://x", token: "s1" }, list: [{ token: "s2" }, { other: 1 }] }, { trunk: { remote: "http://x", token: "<redacted>" }, list: [{ token: "<redacted>" }, { other: 1 }] }],
    ["a token that is not a string is kept", { token: 5, nested: { token: null } }, { token: 5, nested: { token: null } }],
    ["other keys that mention a token are kept", { tokenCount: 3, tokens: ["a"] }, { tokenCount: 3, tokens: ["a"] }],
    ["scalars and null", "text", "text"],
    ["null", null, null],
    ["an array of scalars", [1, "two", null], [1, "two", null]],
  ];
  for (const [name, input, want] of rows) {
    it(name, () => assert.deepEqual(redactTokens(input), want));
  }

  it("does not modify its input", () => {
    const input = { token: "secret", nested: { token: "also" } };
    redactTokens(input);
    assert.deepEqual(input, { token: "secret", nested: { token: "also" } });
  });
});

// ---------------------------------------------------------------------------------------------
// The swarm as a child process
// ---------------------------------------------------------------------------------------------

describe("runNode", () => {
  it("returns the exit code and everything the child wrote to stdout", async () => {
    assert.deepEqual(await runNode(["-e", "console.log('a'); console.log('b'); process.exit(3)"]), { code: 3, out: "a\nb\n" });
  });

  it("returns 0 for a child that succeeds", async () => {
    const { code, out } = await runNode(["-e", "process.stdout.write('done')"]);
    assert.deepEqual([code, out], [0, "done"]);
  });

  it("reports a child that a signal killed as a failure", async () => {
    const { code } = await runNode(["-e", "process.kill(process.pid, 'SIGKILL')"]);
    assert.equal(code, 128);
  });

  it("passes the environment on", async () => {
    const { out } = await runNode(["-e", "process.stdout.write(process.env.E2E_LIB_TEST ?? 'unset')"], { env: { ...process.env, E2E_LIB_TEST: "set" } });
    assert.equal(out, "set");
  });

  it("calls the heartbeat with the seconds elapsed and the lines so far while the child runs, and stops when it ends", async () => {
    const beats = [];
    await runNode(["-e", "console.log('x'); setTimeout(() => {}, 1200)"], { heartbeatMs: 50, onHeartbeat: (seconds, lines) => beats.push([seconds, lines]) });
    assert.ok(beats.length >= 2, `${beats.length} heartbeats`);
    // The first beat can come before the child has printed anything; later ones have seen its one line.
    assert.ok(beats.every(([seconds, lines]) => Number.isInteger(seconds) && seconds >= 0 && seconds <= 5 && lines <= 1), JSON.stringify(beats));
    assert.deepEqual(beats.map((b) => b[0]), beats.map((b) => b[0]).sort((a, b) => a - b), "seconds only go up");
    assert.equal(beats.at(-1)[1], 1, JSON.stringify(beats));
    const after = beats.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(beats.length, after, "the timer outlived the child");
  });

  it("does not leave signal handlers behind", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await runNode(["-e", ""]);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
  });
});

describe("reportSummary", () => {
  const report = "Swarm report: convert  head 1a2b3c4d  seq 52  5m 02s\n\ntransactions   47   landed 37\nlanded         37 tasks: a, b";
  const criteria = "\nM3 criteria\n  [PASS] >= 34 tasks landed: 37 landed";
  const rows = [
    ["a full run: the report without the criteria and the trailer", `agent lines\n\n${report}\n${criteria}\n\nreport written to /tmp/x.json\n`, report],
    ["a run without --json has no trailer", `${report}\n${criteria}\n`, report],
    ["only the report", `${report}\n`, report],
    ["a trailer without criteria", `${report}\n\nreport written to /tmp/x.json\n`, report],
    ["the last report wins", `Swarm report: old\n\n${report}\n`, report],
  ];
  for (const [name, out, want] of rows) {
    it(name, () => assert.equal(reportSummary(out), want));
  }

  it("without a report, the last 15 lines say how the run died", () => {
    const out = `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const got = reportSummary(out).split("\n");
    assert.deepEqual([got.length, got[0], got.at(-1)], [15, "line 26", "line 40"]);
  });

  it("is empty for no output", () => assert.equal(reportSummary(""), ""));
});
