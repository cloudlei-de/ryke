// The pure parts of `npm run shots` (harness/shots.mjs): which transactions the Transaction shots open,
// when the mid-run shot may be taken, the file names, and which browser errors are ignored. The browser run
// itself is the M4 acceptance, not a unit test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  captureHeight,
  checkVariants,
  isFontFailure,
  LINE_CHECKS,
  midRunReady,
  OPTIONAL_VARIANTS,
  pickTxns,
  pruneList,
  RECALLED_CHECKS,
  REQUIRED_VARIANTS,
  SCHEMES,
  shortfalls,
  shotName,
  shotPrefix,
  SIZES,
} from "../../harness/shots.mjs";

let seq = 0;
const op = (kind, txn = null, data = {}) => ({ seq: ++seq, at: 1_000 + seq, kind, txn, agent: txn ? "agent-01" : null, data });
const open = (txn) => op("txn.open", txn, { attempt: 1 });
const landed = (txn) => op("txn.landed", txn, { sha: "abc", seq: 1 });
const stale = (txn) => op("txn.stale", txn, { reason: "stale_read", paths: [{ path: "src/format.ts", by: "t_x" }] });
const staleNoPaths = (txn) => op("txn.stale", txn, { reason: "text_conflict", paths: [] });
const verifying = (txn, train) => op("txn.verifying", txn, { train });
const failed = (txn) => op("txn.failed", txn, { reason: "tests" });
const rejected = (txn, reason) => op("txn.rejected", txn, reason === undefined ? {} : { reason });
const bisect = (train) => op("train.bisect", null, { train, probe: ["t_a"], pass: false });

const none = { landed: null, stale: null, failed: null, rejected: null };

describe("pickTxns", () => {
  const cases = [
    ["no ops", [], none],
    ["ops that belong to no transaction are skipped", [op("trunk.advanced"), op("train.formed", null, { train: "tr_1" }), op("heat.changed", null, { path: "a", value: 1 })], none],
    ["a transaction that landed at the first attempt", [open("t_a"), landed("t_a")], { ...none, landed: "t_a" }],
    ["the first of several first-try landings, in the order the ledger saw them", [open("t_b"), open("t_a"), landed("t_a"), landed("t_b")], { ...none, landed: "t_b" }],
    ["a stale transaction that landed on the retry is not a first-try landing", [open("t_a"), stale("t_a"), open("t_a"), landed("t_a")], { ...none, stale: "t_a" }],
    ["stale and still open is not picked", [open("t_a"), stale("t_a")], none],
    // The Transaction shot of a retried attempt shows the delta of its stale paths; without any there is nothing to show.
    ["a stale transaction whose stale op names no path is not picked", [open("t_a"), staleNoPaths("t_a"), open("t_a"), landed("t_a")], none],
    ["the first stale transaction that names a path wins over an earlier one that names none", [open("t_a"), staleNoPaths("t_a"), open("t_a"), landed("t_a"), open("t_b"), stale("t_b"), open("t_b"), landed("t_b")], { ...none, stale: "t_b" }],
    ["stale and then aborted is not picked", [open("t_a"), stale("t_a"), op("txn.aborted", "t_a", { reason: "max_attempts" })], none],
    ["first-try and stale-then-landed are picked side by side", [open("t_s"), stale("t_s"), open("t_f"), landed("t_f"), landed("t_s")], { ...none, landed: "t_f", stale: "t_s" }],
    ["the first stale-then-landed wins when there are several", [open("t_a"), stale("t_a"), open("t_b"), stale("t_b"), landed("t_b"), landed("t_a")], { ...none, stale: "t_a" }],
    ["a failed transaction", [open("t_a"), verifying("t_a", "tr_1"), failed("t_a")], { ...none, failed: "t_a" }],
    [
      "a failure in a bisected train is preferred over an earlier one in a train that was not",
      [open("t_a"), verifying("t_a", "tr_1"), failed("t_a"), open("t_b"), verifying("t_b", "tr_2"), bisect("tr_2"), failed("t_b")],
      { ...none, failed: "t_b" },
    ],
    ["without any bisected train the first failure is picked", [open("t_a"), failed("t_a"), open("t_b"), failed("t_b")], { ...none, failed: "t_a" }],
    ["a failure whose train was bisected after the failure op still counts as bisected", [open("t_a"), failed("t_a"), open("t_b"), verifying("t_b", "tr_2"), failed("t_b"), bisect("tr_2")], { ...none, failed: "t_b" }],
    ["the tamper attempt is the one rejected as protected", [open("t_a"), rejected("t_a", "protected")], { ...none, rejected: "t_a" }],
    ["a duplicate rejection is not the tamper attempt", [open("t_a"), rejected("t_a", "duplicate_of t_x"), open("t_b"), rejected("t_b", "protected")], { ...none, rejected: "t_b" }],
    ["a rejection without a reason is not the tamper attempt", [open("t_a"), rejected("t_a")], none],
    [
      "all four at once",
      [open("t_1"), landed("t_1"), open("t_2"), stale("t_2"), landed("t_2"), open("t_3"), failed("t_3"), open("t_4"), rejected("t_4", "protected")],
      { landed: "t_1", stale: "t_2", failed: "t_3", rejected: "t_4" },
    ],
  ];
  for (const [name, ops, want] of cases) {
    it(name, () => assert.deepEqual(pickTxns(ops), want));
  }
});

describe("midRunReady", () => {
  const many = (kind, n) => Array.from({ length: n }, () => op(kind, kind.startsWith("txn.") ? `t_${n}` : null, kind === "heat.changed" ? { path: "a", value: 1 } : {}));
  const ops = ({ landed = 6, stale = 2, trains = 2, heat = 1 } = {}) => [...many("txn.landed", landed), ...many("txn.stale", stale), ...many("train.formed", trains), ...many("heat.changed", heat)];
  const cases = [
    ["empty", [], false],
    ["exactly the thresholds", ops(), true],
    ["more than the thresholds", ops({ landed: 30, stale: 9, trains: 12, heat: 40 }), true],
    ["one landing short", ops({ landed: 5 }), false],
    ["one stale notch short", ops({ stale: 1 }), false],
    ["one train short", ops({ trains: 1 }), false],
    ["no heat yet", ops({ heat: 0 }), false],
    ["only landings", ops({ stale: 0, trains: 0, heat: 0 }), false],
    ["unrelated ops do not count", [...ops({ landed: 0 }), ...many("txn.open", 20), ...many("txn.ready", 20)], false],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => assert.equal(midRunReady(input), want));
  }
});

describe("isFontFailure", () => {
  const cases = [
    ["the Google Fonts stylesheet", "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap", true],
    ["a font file", "https://fonts.gstatic.com/s/ibmplexmono/v19/abc.woff2", true],
    ["the dashboard's own module", "http://127.0.0.1:5248/src/web/live.ts", false],
    ["an API call", "http://127.0.0.1:5248/api/repos/convert/files", false],
    ["a look-alike host", "https://fonts.googleapis.com.evil.example/css", false],
    ["a look-alike prefix", "https://evil.example/https://fonts.googleapis.com/css", false],
    ["another Google host", "https://www.googleapis.com/css", false],
    ["plain http is not the fonts CDN", "http://fonts.googleapis.com/css", false],
    ["an empty url", "", false],
    ["no url", undefined, false],
    ["a null url", null, false],
  ];
  for (const [name, url, want] of cases) {
    it(name, () => assert.equal(isFontFailure(url), want));
  }
});

describe("shot names and sizes", () => {
  it("names a shot <view>-<variant>-<width>-<scheme>.png", () => {
    assert.equal(shotName("line", "mid", 1440, "light"), "line-mid-1440-light.png");
    assert.equal(shotName("recall", "planned", 390, "dark"), "recall-planned-390-dark.png");
    assert.equal(shotName("txn", "stale", 1440, "dark"), "txn-stale-1440-dark.png");
  });

  it("captures the two sizes PLAN.md §12 names, in light and dark", () => {
    assert.deepEqual(SIZES, [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]);
    assert.deepEqual(SCHEMES, ["light", "dark"]);
  });

  it("gives every size and scheme of a view its own file", () => {
    const names = SIZES.flatMap((s) => SCHEMES.map((c) => shotName("replay", "paused", s.width, c)));
    assert.equal(new Set(names).size, 4);
    for (const n of names) assert.match(n, /^replay-paused-(1440|390)-(light|dark)\.png$/);
  });
});

describe("the variants a run has to produce", () => {
  it("requires the landed, stale and protected-rejection shots and leaves the failed one optional", () => {
    assert.deepEqual([...REQUIRED_VARIANTS], ["landed", "stale", "rejected"]);
    assert.deepEqual([...OPTIONAL_VARIANTS], ["failed"]);
  });

  const cases = [
    ["all four", { landed: "t_1", stale: "t_2", failed: "t_3", rejected: "t_4" }, { missing: [], optionalMissing: [] }],
    ["no failure is only noted", { landed: "t_1", stale: "t_2", failed: null, rejected: "t_4" }, { missing: [], optionalMissing: ["failed"] }],
    ["no stale transaction is a failure", { landed: "t_1", stale: null, failed: "t_3", rejected: "t_4" }, { missing: ["stale"], optionalMissing: [] }],
    ["no protected rejection is a failure", { landed: "t_1", stale: "t_2", failed: "t_3", rejected: null }, { missing: ["rejected"], optionalMissing: [] }],
    ["no first-try landing is a failure", { landed: null, stale: "t_2", failed: "t_3", rejected: "t_4" }, { missing: ["landed"], optionalMissing: [] }],
    ["nothing at all", none, { missing: ["landed", "stale", "rejected"], optionalMissing: ["failed"] }],
  ];
  for (const [name, picks, want] of cases) {
    it(name, () => assert.deepEqual(checkVariants(picks), want));
  }
});

describe("captureHeight: a shot that does not fit its viewport", () => {
  const big = SIZES[0];
  const phone = SIZES[1];
  const cases = [
    ["a page that fits is shot as it is", "txn", big, { y: 0, x: 0 }, { height: 900, problem: null }],
    ["the Line at 1440x900 that fits", "line", big, { y: 0, x: 0 }, { height: 900, problem: null }],
    // PLAN.md §12: the Line fits 1440x900 without scrolling. Taller is a bug to report, not a viewport to enlarge.
    ["the Line at 1440x900 that scrolls is a problem and keeps the viewport", "line", big, { y: 120, x: 0 }, { height: 900, problem: "the Line overflows 1440x900 by 120 px vertically; PLAN.md §12 says it fits without scrolling" }],
    ["the Line at 1440x900 that is too wide is a problem too", "line", big, { y: 0, x: 40 }, { height: 900, problem: "the Line overflows 1440x900 by 40 px horizontally; PLAN.md §12 says it fits without scrolling" }],
    ["both directions are named", "line", big, { y: 5, x: 6 }, { height: 900, problem: "the Line overflows 1440x900 by 5 px vertically and 6 px horizontally; PLAN.md §12 says it fits without scrolling" }],
    ["the phone layout of the Line scrolls by design and is shot whole", "line", phone, { y: 700, x: 0 }, { height: 1544, problem: null }],
    ["a long Transaction page is shot whole", "txn", big, { y: 1200, x: 0 }, { height: 2100, problem: null }],
    ["a Replay or Bench page is shot whole", "bench", big, { y: 300, x: 0 }, { height: 1200, problem: null }],
    ["a page is never taller than 6000 px", "txn", big, { y: 9000, x: 0 }, { height: 6000, problem: null }],
    ["horizontal overflow of another view is not this check's business", "txn", big, { y: 0, x: 50 }, { height: 900, problem: null }],
  ];
  for (const [name, view, size, extra, want] of cases) {
    it(name, () => assert.deepEqual(captureHeight(view, size, extra), want));
  }
});

describe("pruneList: which old shots to delete after a run", () => {
  const files = ["line-mid-1440-light.png", "line-mid-1440-dark.png", "txn-failed-1440-light.png", "txn-failed-390-dark.png", "txn-landed-1440-light.png", "old-view-1440-light.png", "notes.txt"];
  const cases = [
    ["a file the run did not write is pruned", files, ["line-mid-1440-light.png", "line-mid-1440-dark.png", "txn-failed-1440-light.png", "txn-failed-390-dark.png", "txn-landed-1440-light.png"], [], ["old-view-1440-light.png"]],
    ["the shots of a skipped variant are kept", files, ["line-mid-1440-light.png", "line-mid-1440-dark.png", "txn-landed-1440-light.png"], [shotPrefix("txn", "failed")], ["old-view-1440-light.png"]],
    ["only the skipped variant is spared, not its neighbours", files, [], [shotPrefix("txn", "failed")], ["line-mid-1440-light.png", "line-mid-1440-dark.png", "txn-landed-1440-light.png", "old-view-1440-light.png"]],
    ["a prefix is a whole <view>-<variant>-, so txn-fail does not shelter txn-failed2", ["txn-failed2-1440-light.png"], [], [shotPrefix("txn", "fail")], ["txn-failed2-1440-light.png"]],
    ["only pngs are ever listed for deletion", ["a.txt", "b.png"], [], [], ["b.png"]],
    ["an empty directory has nothing to prune", [], [], [], []],
  ];
  for (const [name, existing, written, skipped, want] of cases) {
    it(name, () => assert.deepEqual(pruneList(existing, written, skipped), want));
  }
});

describe("the Line checks", () => {
  it("wait for a train block, two stale notches and a hot heat row before the mid-run shot, and the scripted-agents tag", () => {
    assert.deepEqual(
      LINE_CHECKS.map((c) => [c.selector, c.min]),
      [
        [".trunk .block-box", 1],
        [".sidings .m-stale", 2],
        ['.heat-list li[data-hot="true"]', 1],
        [".sidings .sim-tag", 1],
      ],
    );
  });

  it("add the struck-through recalled bar and the recall's tick on the trunk after the recall", () => {
    assert.deepEqual(
      RECALLED_CHECKS.map((c) => [c.selector, c.min]),
      [
        [".sidings .strike", 1],
        [".trunk .tick.recall", 1],
      ],
    );
  });

  // The selectors are classes of the dashboard's components; if one is renamed the run would wait out its timeout.
  const source = (f) => readFileSync(new URL(`../../src/web/${f}`, import.meta.url), "utf8");
  const text = [source("views/line/Trunk.tsx"), source("views/line/Sidings.tsx"), source("views/line/Rail.tsx"), source("views/recall/index.tsx"), source("views/txn/parts.tsx")].join("\n");
  for (const token of ["block-box", "m-stale", "data-hot", "sim-tag", "strike", "tick recall", "recall-outcome", "data-tone", "txn-id", "txn-diff", "txn-shot"]) {
    it(`finds ${token} in the dashboard's source`, () => assert.ok(text.includes(token), token));
  }

  describe("shortfalls", () => {
    const checks = [
      { selector: ".a", min: 1, what: "an a" },
      { selector: ".b", min: 2, what: "two bs" },
    ];
    const cases = [
      ["everything is there", { ".a": 1, ".b": 2 }, []],
      ["more than enough", { ".a": 9, ".b": 9 }, []],
      ["one short", { ".a": 1, ".b": 1 }, ["two bs (.b: 1 of 2)"]],
      ["nothing drawn", {}, ["an a (.a: 0 of 1)", "two bs (.b: 0 of 2)"]],
    ];
    for (const [name, counts, want] of cases) {
      it(name, () => assert.deepEqual(shortfalls(checks, counts), want));
    }
  });
});
