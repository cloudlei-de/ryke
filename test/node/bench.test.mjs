// The bench (PLAN.md §11.3): the pure parts table-driven, the policies against fakes, the agent loop
// against a local git remote, and one tiny real cell per policy on a private stack (port offset 210 + 3 * RYKE_PORT_OFFSET, so
// parallel `npm test` runs with different offsets do not collide).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MAX_REFRESHES, runAgent } from "../../harness/agents/synthetic.mjs";
import { BENCH_ENV_KEYS, caveatsFor, main as benchMain, noteFor, parseBenchArgs, runBench, startBenchStack, UsageError, writeResults } from "../../harness/bench.mjs";
import { runCell, runVerifyCommand, SEED_POLICY } from "../../harness/bench/cell.mjs";
import { ABLATION_POLICIES, BENCH_POLICIES, buildResults, isRyke, percentile, rykeOpStats, rykeVerifyRuns, summarizeCell } from "../../harness/bench/metrics.mjs";
import { authRemote, checkTrunk, controlPlane, FifoQueue, landOne, Mutex, pickCommits, sleep } from "../../harness/bench/plumbing.mjs";
import { lockPolicy, queuePolicy, Rejected, rykeNoLeasePolicy, rykeNoPipePolicy, rykePolicy } from "../../harness/bench/policies.mjs";
import { client } from "../../harness/lib/client.mjs";
import { chart, leaseComparison, pipelineComparison, renderMarkdown, table, verdict } from "../../harness/bench/render.mjs";
import { inferCause, outcomeFromState, waitWhileSettling } from "../../harness/bench/settle.mjs";
import {
  BENCH_CONSTS,
  calibrate,
  dependents,
  drawDistinct,
  editFile,
  estimateIncompatibility,
  HOT_FILES,
  incompatible,
  isBenchHotPath,
  isEditable,
  isPin,
  MIX,
  materialise,
  makeRng,
  parseConst,
  parsePin,
  pinSource,
  planTransaction,
  rankFiles,
  readsOverlap,
  rewriteConst,
  seedFiles,
  thinkMs,
  weightedIndex,
  zipfWeights,
} from "../../harness/bench/workload.mjs";
import { parseBench, POLICIES } from "../../src/shared/bench.ts";

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SKIP = new Set(["tools", "solutions", "tasks.json", "node_modules"]);

let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ryke-bench-test-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// The files of the seeded `convert` trunk, as the lander would see them.
async function seedTree(dir) {
  await cp(join(ROOT, "demo/convert"), dir, { recursive: true, filter: (p) => !SKIP.has(relative(join(ROOT, "demo/convert"), p).split("/")[0]) });
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(relative(base, p));
  }
  return out.sort();
}

const SEED_FILES = ["CHANGELOG.md", "package.json", "ryke.json", "src/format.ts", "src/index.ts", "src/registry.ts", "src/types.ts", "src/ui/html.ts", "src/ui/layout.ts", "src/ui/styles.ts", "src/units/length.ts", "src/units/mass.ts", "src/units/temperature.ts", "test/format.test.ts", "test/routes.test.ts", "test/units.test.ts"];

const countBy = (items) => items.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

// ---------------------------------------------------------------------------------------------
describe("ranking and the Zipf sampler", () => {
  const rankCases = [
    ["hot files first in their fixed order, the rest alphabetical", ["test/a.test.ts", "src/registry.ts", "CHANGELOG.md", "src/ui/layout.ts", "src/format.ts", "src/b.ts"], ["src/format.ts", "src/ui/layout.ts", "src/registry.ts", "CHANGELOG.md", "src/b.ts", "test/a.test.ts"]],
    ["a missing hot file is skipped, not invented", ["src/b.ts", "src/format.ts"], ["src/format.ts", "src/b.ts"]],
    ["no hot file at all", ["z.md", "a.md"], ["a.md", "z.md"]],
    ["empty", [], []],
  ];
  for (const [name, files, want] of rankCases) {
    it(`rankFiles: ${name}`, () => assert.deepEqual(rankFiles(files), want));
  }

  it("rankFiles gives the seed trunk the documented order", () => {
    assert.deepEqual(rankFiles(SEED_FILES).slice(0, 4), [...HOT_FILES, "CHANGELOG.md"]);
  });

  it("zipfWeights follow k^-s", () => {
    const w = zipfWeights(4, 1.1);
    assert.deepEqual(w.map((x) => +x.toFixed(4)), [1, 0.4665, 0.2987, 0.2176]);
  });

  it("weightedIndex picks by weight and survives a draw at the very end", () => {
    const cases = [[0, 0], [0.49, 0], [0.5, 1], [0.99, 1], [0.999999999, 1]];
    for (const [u, want] of cases) assert.equal(weightedIndex(() => u, [1, 1]), want, `u=${u}`);
  });

  it("the first draw has the Zipf(1.1) rank frequencies", () => {
    const n = 10;
    const ranked = Array.from({ length: n }, (_, i) => i);
    const rng = makeRng(11);
    const draws = 200_000;
    const seen = countBy(Array.from({ length: draws }, () => drawDistinct(rng, ranked, 1)[0]));
    const w = zipfWeights(n);
    const total = w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) assert.ok(Math.abs(seen[i] / draws - w[i] / total) < 0.01, `rank ${i + 1}: ${seen[i] / draws} vs ${w[i] / total}`);
    // Ranks are monotone: a hotter file is never rarer than a colder one by more than noise.
    for (let i = 1; i < n; i++) assert.ok(seen[i - 1] >= seen[i] * 0.97, `rank ${i} vs ${i + 1}`);
  });

  const distinctCases = [
    ["k below n", 16, 5, 5],
    ["k equal to n", 6, 6, 6],
    ["k above n returns everything once", 4, 8, 4],
    ["k zero", 9, 0, 0],
  ];
  for (const [name, n, k, want] of distinctCases) {
    it(`drawDistinct: ${name}`, () => {
      const picked = drawDistinct(makeRng(3), Array.from({ length: n }, (_, i) => `f${i}`), k);
      assert.equal(picked.length, want);
      assert.equal(new Set(picked).size, want);
    });
  }
});

// ---------------------------------------------------------------------------------------------
describe("think time", () => {
  const sample = (opts, n = 20_001) => {
    const rng = makeRng(5);
    return Array.from({ length: n }, () => thinkMs(rng, opts)).sort((a, b) => a - b);
  };
  const cases = [
    ["factor 1", { factor: 1 }, 6000],
    ["factor 0.25", { factor: 0.25 }, 1500],
    ["a retry thinks half as long", { factor: 1, retry: true }, 3000],
    ["a retry at factor 2", { factor: 2, retry: true }, 6000],
  ];
  for (const [name, opts, median] of cases) {
    it(`median is ${median} ms: ${name}`, () => {
      const m = sample(opts)[10_000];
      assert.ok(Math.abs(m - median) / median < 0.03, `median ${m}`);
    });
  }

  it("is lognormal with sigma 0.5", () => {
    const logs = sample({ factor: 1 }).map(Math.log);
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length);
    assert.ok(Math.abs(sd - 0.5) < 0.02, `sd ${sd}`);
  });

  it("is deterministic per seed and never zero", () => {
    assert.equal(thinkMs(makeRng(1), {}), thinkMs(makeRng(1), {}));
    assert.ok(sample({ factor: 0.0001 })[0] >= 1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the footprint generator", () => {
  const rng = makeRng(2026);
  const plans = Array.from({ length: 4000 }, () => planTransaction(rng, SEED_FILES));

  it("reads 3 to 8 distinct files that exist, writes 1 to 3", () => {
    for (const p of plans) {
      assert.ok(p.reads.length >= 3 && p.reads.length <= 8, `${p.reads.length} reads`);
      assert.equal(new Set(p.reads).size, p.reads.length);
      assert.ok(p.reads.every((r) => SEED_FILES.includes(r)));
      assert.ok(p.slots.length >= 1 && p.slots.length <= 3, `${p.slots.length} slots`);
    }
    assert.deepEqual([...new Set(plans.map((p) => p.reads.length))].sort(), [3, 4, 5, 6, 7, 8]);
    assert.deepEqual([...new Set(plans.map((p) => p.slots.length))].sort(), [1, 2, 3]);
  });

  it("the hot files are read most, in rank order", () => {
    const reads = countBy(plans.flatMap((p) => p.reads));
    const order = Object.entries(reads).sort((a, b) => b[1] - a[1]).map(([f]) => f);
    assert.deepEqual(order.slice(0, 3), HOT_FILES);
    assert.ok(reads["src/format.ts"] / plans.length > 0.7, "format.ts is in most footprints");
  });

  it("edits only touch editable files the transaction read, each at most once", () => {
    for (const p of plans) {
      const edits = p.slots.filter((s) => s.kind === "edit");
      for (const e of edits) {
        assert.ok(p.reads.includes(e.path), `${e.path} was not read`);
        assert.ok(isEditable(e.path), `${e.path} is protected or not code`);
      }
      assert.equal(new Set(edits.map((e) => e.path)).size, edits.length);
    }
  });

  it("about 60 % of writes are new files, split between categories and tests", () => {
    const slots = plans.flatMap((p) => p.slots);
    const newShare = slots.filter((s) => s.kind !== "edit").length / slots.length;
    // Slightly above 0.6: an edit with nothing editable left becomes a new file.
    assert.ok(newShare > 0.58 && newShare < 0.68, `new share ${newShare}`);
    const kinds = countBy(slots.map((s) => s.kind));
    assert.ok(Math.abs(kinds.category / (kinds.category + kinds.test) - 0.5) < 0.05);
  });

  it("only constant-bearing hot files are rewritten, and a reader pins only what it read and did not rewrite, one pin per slot", () => {
    for (const p of plans) {
      assert.ok(p.changes.every((f) => f in BENCH_CONSTS));
      assert.ok(p.asserts.every((f) => f in BENCH_CONSTS && p.reads.includes(f) && !p.changes.includes(f)));
      const testSlots = p.slots.filter((s) => s.kind === "test");
      if (testSlots.length === 0) assert.deepEqual(p.asserts, []);
      for (const slot of testSlots) assert.ok(slot.asserts.length <= 1);
    }
    assert.ok(plans.some((p) => p.changes.length > 0) && plans.some((p) => p.asserts.length > 0));
  });

  it("is deterministic per seed and differs between seeds", () => {
    const a = planTransaction(makeRng(9), SEED_FILES);
    assert.deepEqual(a, planTransaction(makeRng(9), SEED_FILES));
    assert.notDeepEqual(a, planTransaction(makeRng(10), SEED_FILES));
  });

  it("a repo with no editable read file turns edits into new files, never protected edits", () => {
    const files = ["package.json", "ryke.json", "test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
    const r = makeRng(1);
    for (let i = 0; i < 300; i++) {
      const p = planTransaction(r, files, { ...MIX, pNew: 0 });
      assert.ok(p.slots.every((s) => s.kind !== "edit"));
    }
  });

  it("small repos cap the reads at the repo size", () => {
    assert.equal(planTransaction(makeRng(1), ["a.ts", "b.ts"]).reads.length, 2);
  });
});

// ---------------------------------------------------------------------------------------------
describe("incompatibility", () => {
  const plan = (reads, changes = [], asserts = []) => ({ reads, changes, asserts });
  const F = "src/format.ts";
  const L = "src/ui/layout.ts";
  const cases = [
    ["one rewrites what the other pins", plan([F, "a"], [F]), plan([F, "b"], [], [F]), true, true],
    ["symmetric", plan([F, "b"], [], [F]), plan([F, "a"], [F]), true, true],
    ["different constants never clash", plan([F, L], [F]), plan([F, L], [], [L]), true, false],
    ["two rewrites of one constant are a text conflict, not a semantic one", plan([F], [F]), plan([F], [F]), true, false],
    ["two pins agree", plan([F], [], [F]), plan([F], [], [F]), true, false],
    ["no overlap in reads", plan(["a"], [F]), plan(["b"], [], [F]), false, true],
    ["empty reads", plan([]), plan([]), false, false],
  ];
  for (const [name, a, b, overlap, bad] of cases) {
    it(`${name}: overlap ${overlap}, incompatible ${bad}`, () => {
      assert.equal(readsOverlap(a, b), overlap);
      assert.equal(incompatible(a, b), bad);
    });
  }

  it("estimateIncompatibility counts only read-overlapping pairs", () => {
    const plans = [plan([F], [F]), plan([F], [], [F]), plan(["x"], [], [F]), plan(["x", F], [], [F])];
    // pairs: (0,1) overlap+bad, (0,2) none, (0,3) overlap+bad, (1,2) none, (1,3) overlap ok, (2,3) overlap ok
    assert.deepEqual(estimateIncompatibility(plans), { plans: 4, overlapping: 4, incompatible: 2, rate: 0.5 });
  });

  it("no plans, no pairs, rate 0", () => {
    assert.deepEqual(estimateIncompatibility([]), { plans: 0, overlapping: 0, incompatible: 0, rate: 0 });
    assert.equal(estimateIncompatibility([plan(["a"])]).rate, 0);
  });

  it("the chosen mix gives about 10 % on the seed trunk and as the repo grows", () => {
    const grown = (n) => [...SEED_FILES, ...Array.from({ length: n }, (_, i) => [`src/units/b${i}x1a.ts`, `test/b${i}x1b.test.ts`]).flat()];
    for (const [files, lo, hi] of [[SEED_FILES, 0.085, 0.13], [grown(10), 0.08, 0.125], [grown(25), 0.07, 0.115]]) {
      const r = calibrate(files, MIX, { samples: 1200, seed: 4 });
      assert.ok(r.rate >= lo && r.rate <= hi, `${files.length} files: ${(r.rate * 100).toFixed(1)} %`);
      assert.ok(r.overlapping > 100_000);
    }
  });

  it("without asserts or changes nothing is incompatible", () => {
    for (const mix of [{ ...MIX, pAssert: 0 }, { ...MIX, pChange: 0 }]) assert.equal(calibrate(SEED_FILES, mix, { samples: 300 }).incompatible, 0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("real text edits", () => {
  const constCases = [
    ["export const BENCH_FORMAT = 7;\n", "BENCH_FORMAT", 7],
    ["a\nexport const BENCH_FORMAT = -3;\nb\n", "BENCH_FORMAT", -3],
    ["export const BENCH_OTHER = 7;\n", "BENCH_FORMAT", null],
    ["// export const BENCH_FORMAT = 7;\n", "BENCH_FORMAT", null],
    ["", "BENCH_FORMAT", null],
  ];
  for (const [text, name, want] of constCases) it(`parseConst(${JSON.stringify(text.slice(0, 30))}, ${name}) is ${want}`, () => assert.equal(parseConst(text, name), want));

  it("pins round-trip through pinSource and parsePin", () => {
    assert.deepEqual(parsePin(pinSource("BENCH_FORMAT", 12)), { name: "BENCH_FORMAT", value: 12 });
    assert.deepEqual(parsePin(pinSource("BENCH_LAYOUT", -1)), { name: "BENCH_LAYOUT", value: -1 });
    assert.equal(parsePin("export const x = 1;"), null);
    assert.equal(isPin("src/bench/pin-b1x1a.ts"), true);
    for (const p of ["src/bench/other.ts", "src/bench/pin-a/b.ts", "test/pin-a.ts", "src/pin-a.ts"]) assert.equal(isPin(p), false, p);
  });

  it("seedFiles adds one constant and one seed dependent per hot file plus the contract test, once", () => {
    const files = { "src/format.ts": "export function f() {}\n", "src/ui/layout.ts": "export const x = 1" };
    const first = seedFiles(files);
    assert.deepEqual(Object.keys(first).sort(), ["src/bench/pin-seed-format.ts", "src/bench/pin-seed-layout.ts", "src/format.ts", "src/ui/layout.ts", "test/bench-contract.test.ts"]);
    assert.equal(parseConst(first["src/format.ts"], "BENCH_FORMAT"), 1);
    assert.equal(parseConst(first["src/ui/layout.ts"], "BENCH_LAYOUT"), 1);
    assert.deepEqual(parsePin(first["src/bench/pin-seed-layout.ts"]), { name: "BENCH_LAYOUT", value: 1 });
    assert.deepEqual(seedFiles({ ...files, ...first }), {});
    assert.throws(() => seedFiles({ "src/format.ts": "" }), /missing/);
  });

  const text = "import a from \"a\";\n\n// doc\nexport function f() {\n  return 1;\n}\n\nexport const BENCH_FORMAT = 1;\n";
  it("an insertion keeps every original line in order, adds one unique block and ends with a newline", () => {
    for (let seed = 0; seed < 60; seed++) {
      const out = editFile("src/format.ts", text, { tag: "b1x1a", rng: makeRng(seed) });
      const stripped = out
        .replace(/\nexport function bench_b1x1a\(x: number\): number \{\n  return x \+ \d+;\n\}\n$/, "")
        .replace(/export function bench_b1x1a\(x: number\): number \{\n  return x \+ \d+;\n\}\n\n/, "")
        .replace(/\/\/ b1x1a: note \d+\n/, "");
      assert.equal(stripped, text, `seed ${seed}`);
      assert.match(out, /b1x1a/);
      assert.ok(out.endsWith("\n") && !out.endsWith("\n\n"));
    }
  });

  it("insertions land only before a top-level export or import, or at the end", () => {
    const where = new Set();
    for (let seed = 0; seed < 200; seed++) {
      const lines = editFile("src/format.ts", text, { tag: "t", rng: makeRng(seed) }).split("\n");
      const i = lines.findIndex((l) => l.includes("// t:") || l.startsWith("export function bench_t"));
      where.add(lines[i + (lines[i].startsWith("//") ? 1 : 4)] ?? "<end>");
    }
    for (const w of where) assert.ok(/^(import|export) |^<end>$|^$/.test(w), `inserted before ${JSON.stringify(w)}`);
    assert.ok(where.size >= 3, "several positions are used");
  });

  it("rewriteConst gives a different number and touches nothing else; a file without the constant gives null", () => {
    for (let seed = 0; seed < 40; seed++) {
      const out = rewriteConst(text, "BENCH_FORMAT", makeRng(seed));
      assert.ok(parseConst(out, "BENCH_FORMAT") > 1, `seed ${seed}`);
      assert.equal(out.replace(/BENCH_FORMAT = \d+/, "BENCH_FORMAT = 1"), text);
    }
    assert.equal(rewriteConst("export function f() {}\n", "BENCH_FORMAT", makeRng(1)), null);
  });

  it("markdown gets a bullet and the registry never gets a function export", () => {
    assert.equal(editFile("CHANGELOG.md", "# Changelog\n", { tag: "t1", rng: makeRng(1) }), "# Changelog\n- t1: touched\n");
    const registry = "export { length } from \"./units/length.ts\";\n";
    for (let seed = 0; seed < 80; seed++) assert.doesNotMatch(editFile("src/registry.ts", registry, { tag: "t", rng: makeRng(seed) }), /export function/);
  });

  it("editable means source code or the changelog, never tests or config", () => {
    const cases = [["src/format.ts", true], ["src/ui/layout.ts", true], ["CHANGELOG.md", true], ["src/bench/pin-a.ts", true], ["test/format.test.ts", false], ["ryke.json", false], ["package.json", false], ["src/data.json", false]];
    for (const [p, want] of cases) assert.equal(isEditable(p), want, p);
  });
});

// ---------------------------------------------------------------------------------------------
const VERIFY = "node --test --experimental-strip-types test/*.test.ts";

// The seeded `convert` trunk plus the cell's own seed commit, on disk.
async function benchTree(name) {
  const dir = join(tmp, name);
  await seedTree(dir);
  const files = Object.fromEntries(await Promise.all(["src/format.ts", "src/ui/layout.ts"].map(async (p) => [p, await readFile(join(dir, p), "utf8")])));
  await writeAll(dir, seedFiles(files));
  return dir;
}

async function writeAll(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

// What an agent standing on `dir` would write for `plan`.
async function change(dir, plan, tag, seed = 1) {
  const files = await listFiles(dir);
  const cache = new Map(await Promise.all(files.filter((f) => !f.startsWith("test/")).map(async (f) => [f, await readFile(join(dir, f), "utf8")])));
  return materialise(plan, { tag, read: (p) => cache.get(p) ?? null, files, rng: makeRng(seed) });
}

describe("materialise: generated changes are valid code that passes the repo's own tests", () => {
  it("the bench seed commit leaves the trunk green", async () => {
    const dir = await benchTree("seeded");
    const r = await runVerifyCommand(dir, VERIFY, 120_000);
    assert.equal(r.pass, true, `${r.failing} ${r.tail}`);
  });

  it("categories, pins, tests, edits and constant changes applied one after another keep the trunk green", async () => {
    const dir = await benchTree("sequential");
    const rng = makeRng(77);
    const seen = new Set();
    let changers = 0;
    for (let i = 1; i <= 40; i++) {
      const plan = planTransaction(rng, await listFiles(dir));
      const m = await change(dir, plan, `b1x${i}`, i);
      changers += Object.keys(m.changed).length;
      await writeAll(dir, m.files);
      for (const path of Object.keys(m.files)) seen.add(isPin(path) ? "pin" : path.startsWith("test/") ? "test" : path.startsWith("src/units/b") ? "category" : path);
    }
    for (const kind of ["category", "pin", "test", "src/registry.ts", "src/format.ts"]) assert.ok(seen.has(kind), `${kind} in ${[...seen].join(", ")}`);
    assert.ok(changers >= 2, "constants were rewritten while pins existed");
    const r = await runVerifyCommand(dir, VERIFY, 120_000);
    assert.equal(r.pass, true, `${r.failing} ${r.tail}`);
  });

  const pinPlan = { reads: ["src/format.ts"], changes: [], asserts: ["src/format.ts"], slots: [{ kind: "test", asserts: ["src/format.ts"] }] };
  const changePlan = { reads: ["src/format.ts"], changes: ["src/format.ts"], asserts: [], slots: [{ kind: "edit", path: "src/format.ts", change: true }] };

  it("a pin written at the same snapshot as a change to its constant breaks the merged tree, and a test catches it", async () => {
    const dir = await benchTree("concurrent");
    const pin = await change(dir, pinPlan, "bP", 1);
    const rewrite = await change(dir, changePlan, "bC", 2);
    assert.deepEqual(Object.keys(pin.files), ["src/bench/pin-bPa.ts"]);
    assert.ok(Object.keys(rewrite.files).includes("src/bench/pin-seed-format.ts"), "the change brings the dependent it can see along");
    // Neither touches a file the other wrote, so any text merge is clean.
    assert.deepEqual(Object.keys(pin.files).filter((p) => p in rewrite.files), []);
    await writeAll(dir, { ...pin.files, ...rewrite.files });
    const r = await runVerifyCommand(dir, VERIFY, 120_000);
    assert.equal(r.pass, false);
    assert.ok(r.failing.some((n) => n.startsWith("pin-bPa.ts")), r.failing.join("; "));
  });

  for (const order of ["pin first", "change first"]) {
    it(`the same two changes one after another (${order}) stay compatible, because the second sees the first`, async () => {
      const dir = await benchTree(`serial-${order.replace(" ", "-")}`);
      const [firstPlan, secondPlan] = order === "pin first" ? [pinPlan, changePlan] : [changePlan, pinPlan];
      await writeAll(dir, (await change(dir, firstPlan, "b1", 1)).files);
      await writeAll(dir, (await change(dir, secondPlan, "b2", 2)).files);
      const r = await runVerifyCommand(dir, VERIFY, 120_000);
      assert.equal(r.pass, true, `${r.failing} ${r.tail}`);
    });
  }

  const base = { "src/registry.ts": "export { length } from \"./units/length.ts\";\n", "src/format.ts": "export function f() {}\n\nexport const BENCH_FORMAT = 5;\n", "src/ui/layout.ts": "export const BENCH_LAYOUT = 9;\n", "src/bench/pin-old.ts": pinSource("BENCH_FORMAT", 5), "src/bench/pin-lay.ts": pinSource("BENCH_LAYOUT", 9) };
  const read = (p) => base[p] ?? null;
  const files = Object.keys(base);

  it("a category adds the unit file and one registry line", () => {
    const m = materialise({ slots: [{ kind: "category" }] }, { tag: "b2x1", read, files, rng: makeRng(1) });
    assert.deepEqual(Object.keys(m.files).sort(), ["src/registry.ts", "src/units/b2x1a.ts"]);
    assert.equal(m.files["src/registry.ts"], `${base["src/registry.ts"]}export { b2x1a } from "./units/b2x1a.ts";\n`);
    assert.match(m.files["src/units/b2x1a.ts"], /id: "b2x1a"/);
  });

  it("two categories in one change append two lines in order", () => {
    const m = materialise({ slots: [{ kind: "category" }, { kind: "category" }] }, { tag: "b2x2", read, files, rng: makeRng(1) });
    assert.match(m.files["src/registry.ts"], /b2x2a.*\n.*b2x2b/);
  });

  it("a pin records the value it read, in one new dependent file", () => {
    const m = materialise({ slots: [{ kind: "test", asserts: ["src/ui/layout.ts"] }] }, { tag: "b2x3", read, files, rng: makeRng(1) });
    assert.deepEqual(Object.keys(m.files), ["src/bench/pin-b2x3a.ts"]);
    assert.deepEqual(parsePin(m.files["src/bench/pin-b2x3a.ts"]), { name: "BENCH_LAYOUT", value: 9 });
    assert.deepEqual(m.pinned, { "src/ui/layout.ts": 9 });
  });

  it("a test slot with nothing to pin is a plain test file that asserts something", () => {
    const m = materialise({ slots: [{ kind: "test", asserts: [] }] }, { tag: "b2x4", read, files, rng: makeRng(1) });
    assert.deepEqual(Object.keys(m.files), ["test/b2x4a.test.ts"]);
    assert.match(m.files["test/b2x4a.test.ts"], /assert\.equal\(\d+ \+ \d+, \d+\)/);
    assert.deepEqual(m.pinned, {});
  });

  it("a pin of a constant that is not in the file falls back to a plain test", () => {
    const m = materialise({ slots: [{ kind: "test", asserts: ["src/format.ts"] }] }, { tag: "b2x4", read: () => "export {}\n", files, rng: makeRng(1) });
    assert.deepEqual(Object.keys(m.files), ["test/b2x4a.test.ts"]);
  });

  it("a change rewrites the constant and exactly the dependents that name it", () => {
    const m = materialise({ changes: ["src/format.ts"], slots: [{ kind: "edit", path: "src/format.ts", change: true }] }, { tag: "b2x5", read, files, rng: makeRng(1) });
    assert.deepEqual(Object.keys(m.files).sort(), ["src/bench/pin-old.ts", "src/format.ts"]);
    const v = parseConst(m.files["src/format.ts"], "BENCH_FORMAT");
    assert.ok(v > 5);
    assert.deepEqual(m.changed, { "src/format.ts": v });
    assert.deepEqual(parsePin(m.files["src/bench/pin-old.ts"]), { name: "BENCH_FORMAT", value: v });
  });

  it("dependents lists the pins naming a changed constant, and nothing for a change that touches none", () => {
    assert.deepEqual(dependents({ changes: ["src/format.ts"] }, files, read), ["src/bench/pin-old.ts"]);
    assert.deepEqual(dependents({ changes: ["src/format.ts", "src/ui/layout.ts"] }, files, read), ["src/bench/pin-old.ts", "src/bench/pin-lay.ts"]);
    assert.deepEqual(dependents({ changes: [] }, files, read), []);
  });

  it("an edit that does not change the constant leaves every dependent alone", () => {
    const m = materialise({ slots: [{ kind: "edit", path: "src/format.ts", change: false }] }, { tag: "b2x6", read, files, rng: makeRng(1) });
    assert.deepEqual(Object.keys(m.files), ["src/format.ts"]);
    assert.deepEqual(m.changed, {});
    assert.equal(parseConst(m.files["src/format.ts"], "BENCH_FORMAT"), 5);
  });

  it("a category and a registry edit in one change compose instead of overwriting each other", () => {
    const m = materialise({ slots: [{ kind: "category" }, { kind: "edit", path: "src/registry.ts", change: false }] }, { tag: "b2x7", read, files, rng: makeRng(3) });
    assert.match(m.files["src/registry.ts"], /export \{ b2x7a \}/);
    assert.match(m.files["src/registry.ts"], /b2x7b/);
  });

  it("the same plan on the same snapshot gives the same files", () => {
    const plan = planTransaction(makeRng(5), SEED_FILES);
    const a = materialise(plan, { tag: "t", read, files, rng: makeRng(8) });
    assert.deepEqual(a, materialise(plan, { tag: "t", read, files, rng: makeRng(8) }));
  });

  it("a retry re-reads: the pinned value follows the new snapshot", () => {
    const plan = { slots: [{ kind: "test", asserts: ["src/format.ts"] }] };
    const later = (p) => (p === "src/format.ts" ? base[p].replace("= 5", "= 42") : read(p));
    assert.deepEqual(materialise(plan, { tag: "t", read, files, rng: makeRng(1) }).pinned, { "src/format.ts": 5 });
    assert.deepEqual(materialise(plan, { tag: "t", read: later, files, rng: makeRng(1) }).pinned, { "src/format.ts": 42 });
  });
});

// ---------------------------------------------------------------------------------------------
describe("metrics", () => {
  const cases = [
    ["no data", [], 0.5, 0],
    ["one value", [7], 0.95, 7],
    ["median of an odd count", [3, 1, 2], 0.5, 2],
    ["median of an even count interpolates", [1, 2, 3, 4], 0.5, 2.5],
    ["p95 of 1..100", Array.from({ length: 100 }, (_, i) => i + 1), 0.95, 95.05],
    ["p0 and p100", [5, 9, 1], 0, 1],
    ["p100", [5, 9, 1], 1, 9],
  ];
  for (const [name, values, p, want] of cases) it(`percentile: ${name}`, () => assert.ok(Math.abs(percentile(values, p) - want) < 1e-9));

  const base = { policy: "queue", agents: 10, durationMs: 120_000, trunkBreakages: 0 };
  const L = (txn, startMs, endMs) => ({ txn, startMs, endMs, status: "landed" });
  const A = (txn, outcome, endMs, thinkS = 5) => ({ txn, attempt: 1, endMs, thinkS, outcome });

  it("counts only what landed inside the duration; the grace period only drains", () => {
    const { cell, extras } = summarizeCell({
      ...base,
      verifyRuns: 6,
      attempts: [A("a", "landed", 20_000), A("b", "landed", 119_000), A("c", "landed", 125_000)],
      txns: [L("a", 0, 20_000), L("b", 100_000, 119_000), L("c", 100_000, 125_000)],
    });
    assert.equal(cell.landed, 2);
    assert.equal(cell.landedPerMinute, 1);
    assert.equal(extras.landedInGrace, 1);
    assert.equal(cell.verifyRunsPerLanded, 3);
  });

  it("p50 and p95 are begin to land in seconds", () => {
    const txns = Array.from({ length: 20 }, (_, i) => L(`t${i}`, 0, (i + 1) * 1000));
    const { cell } = summarizeCell({ ...base, verifyRuns: 20, attempts: [], txns });
    assert.equal(cell.p50, 10.5);
    assert.equal(cell.p95, 19.05);
  });

  it("aborts by cause, wasted think time of attempts that did not land, max_attempts once per given-up change", () => {
    const attempts = [
      A("a", "stale_read", 10_000, 4),
      A("a", "stale_read", 30_000, 2),
      A("a", "landed", 50_000, 2),
      A("b", "failed_verify", 20_000, 5),
      A("c", "text_conflict", 25_000, 3),
      A("c", "stale_read", 60_000, 1.5),
      A("d", "stale_read", 121_000, 99),
      A("e", "abandoned", 119_000, 50),
    ];
    const txns = [
      L("a", 0, 50_000),
      { txn: "c", startMs: 0, endMs: 60_000, status: "aborted", cause: "max_attempts" },
      { txn: "z", startMs: 0, endMs: 125_000, status: "aborted", cause: "max_attempts" },
      { txn: "e", startMs: 0, endMs: 119_000, status: "abandoned" },
    ];
    const { cell, extras } = summarizeCell({ ...base, verifyRuns: 4, attempts, txns });
    assert.deepEqual(cell.aborts, { stale_read: 3, failed_verify: 1, text_conflict: 1, max_attempts: 1 });
    // a: 4 + 2, b: 5, c: 3 + 1.5; the attempt after the deadline and the abandoned one do not count.
    assert.equal(cell.wastedAgentSeconds, 15.5);
    assert.equal(extras.abandoned, 1);
    assert.equal(extras.notLandedAttempts, 5);
  });

  it("nothing landed: the ratio is 0 and the numbers stay finite", () => {
    const { cell } = summarizeCell({ ...base, verifyRuns: 5, attempts: [A("a", "stale_read", 1000)], txns: [] });
    assert.deepEqual([cell.landed, cell.landedPerMinute, cell.p50, cell.p95, cell.verifyRunsPerLanded], [0, 0, 0, 0, 0]);
  });

  it("landed per minute scales with the duration", () => {
    const txns = Array.from({ length: 5 }, (_, i) => L(`t${i}`, 0, 1000 * (i + 1)));
    assert.equal(summarizeCell({ ...base, durationMs: 30_000, verifyRuns: 0, attempts: [], txns }).cell.landedPerMinute, 10);
  });

  it("every cell field of src/shared/bench.ts is there and nothing else", () => {
    const { cell } = summarizeCell({ ...base, verifyRuns: 1, attempts: [], txns: [L("a", 0, 1000)] });
    assert.deepEqual(Object.keys(cell).sort(), ["agents", "aborts", "landed", "landedPerMinute", "p50", "p95", "policy", "trunkBreakages", "verifyRunsPerLanded", "wastedAgentSeconds"].sort());
  });
});

describe("the Ryke op log", () => {
  const op = (at, kind, data, txn = null) => ({ at, kind, data, txn });
  const ops = [
    op(1000, "train.formed", { train: "tr1", txns: ["a", "b", "c"] }),
    op(2000, "train.bisect", { train: "tr1", probe: ["a"], pass: true }),
    op(2500, "train.bisect", { train: "tr1", probe: ["b"], pass: false }),
    op(3000, "trunk.advanced", { train: "tr1", seq: 3 }),
    op(3000, "train.done", { train: "tr1", outcome: "landed" }),
    op(4000, "train.formed", { train: "tr2", txns: ["d"] }),
    op(4500, "train.done", { train: "tr2", outcome: "empty" }),
    op(5000, "train.formed", { train: "tr3", txns: ["e", "f"] }),
    op(6000, "train.done", { train: "tr3", outcome: "landed" }),
    op(7000, "train.formed", { train: "tr4", txns: ["g"] }),
    op(9000, "train.done", { train: "tr4", outcome: "landed" }),
  ];
  const cases = [
    ["every train that finished", {}, 1 + 2 + 0 + 1 + 1],
    ["only trains done by 6000", { untilAt: 6000 }, 1 + 2 + 0 + 1],
    ["trains done after 3500", { sinceAt: 3500 }, 0 + 1 + 1],
    ["nothing in the window", { sinceAt: 20_000 }, 0],
  ];
  for (const [name, win, want] of cases) it(`rykeVerifyRuns: ${name}`, () => assert.equal(rykeVerifyRuns(ops, win), want));

  // tr5 was formed on tr4's candidate and discarded; tr6 on tr5's and confirmed, then landed. A discarded train
  // prepared and verified for nothing, and that cost belongs in verify runs per landed change.
  const spec = [
    op(100, "train.formed", { train: "tr5", txns: ["a"] }),
    op(150, "train.formed", { train: "tr6", txns: ["b"], after: "tr5" }),
    op(200, "train.done", { train: "tr5", outcome: "landed" }),
    op(210, "train.confirmed", { train: "tr6", after: "tr5" }),
    op(300, "train.done", { train: "tr6", outcome: "landed" }),
    op(400, "train.formed", { train: "tr7", txns: ["c"], after: "tr6" }),
    op(450, "train.done", { train: "tr7", outcome: "discarded" }),
  ];
  const specCases = [
    ["a confirmed speculative train is one run, like any train", { untilAt: 300 }, 2],
    ["a discarded one counts as a run too", {}, 3],
    ["a discard outside the window does not", { untilAt: 400 }, 2],
  ];
  for (const [name, win, want] of specCases) it(`rykeVerifyRuns, speculative: ${name}`, () => assert.equal(rykeVerifyRuns(spec, win), want));

  it("rykeOpStats: train sizes, probes, warnings, stale and conflict causes by path", () => {
    const all = [
      ...ops,
      op(1500, "stale.warning", { paths: ["src/format.ts"] }),
      op(1600, "txn.stale", { reason: "stale_read", paths: [{ path: "src/format.ts", seq: 2 }, { path: "src/ui/layout.ts", seq: 2 }] }),
      op(1700, "txn.stale", { reason: "text_conflict", paths: [{ path: "src/ui/styles.ts" }] }),
      op(1800, "txn.aborted", { reason: "max_attempts", cause: { state: "stale", reason: "stale_read" }, paths: [{ path: "src/format.ts", seq: 4 }] }),
      op(1900, "txn.aborted", { reason: "max_attempts", cause: { state: "failed", reason: "tests" } }),
      op(1950, "txn.aborted", { reason: "bench_end" }),
    ];
    const s = rykeOpStats(all);
    assert.deepEqual(s.trainSizes, { 3: 1, 1: 2, 2: 1 });
    assert.equal(s.trains, 4);
    assert.equal(s.meanTrainSize, 1.75);
    assert.equal(s.maxTrainSize, 3);
    assert.equal(s.bisectProbes, 2);
    assert.equal(s.staleWarnings, 1);
    assert.equal(s.staleAborts, 2);
    assert.equal(s.conflictAborts, 1);
    assert.equal(s.staleWhileReady, 0);
    assert.deepEqual(s.stalePaths, { "src/format.ts": 2, "src/ui/layout.ts": 1 });
    // The first stale op lists two hot files and still is one abort on hot files; the text conflict is not one.
    assert.equal(s.hotStaleAborts, 2);
    assert.deepEqual(s.conflictPaths, { "src/ui/styles.ts": 1 });
    assert.equal(s.trainCycleSecondsP50, 2);
    assert.equal(rykeOpStats([]).meanTrainSize, 0);
  });
});

describe("stale changes that were waiting for a train", () => {
  const op = (seq, kind, txn, data = {}) => ({ seq, at: seq, kind, txn, data });
  it("counts a change that went stale straight after ready, not one stale at submit or failed in a train", () => {
    const ops = [
      op(1, "txn.submitted", "a"),
      op(2, "txn.stale", "a", { reason: "stale_read", paths: [{ path: "p" }] }),
      op(3, "txn.submitted", "b"),
      op(4, "txn.ready", "b"),
      op(5, "txn.stale", "b", { reason: "stale_read", paths: [{ path: "p" }] }),
      op(6, "txn.ready", "c"),
      op(7, "txn.verifying", "c"),
      op(8, "txn.stale", "c", { reason: "text_conflict", paths: [{ path: "p" }] }),
      op(9, "txn.ready", "d"),
      op(10, "txn.aborted", "d", { reason: "max_attempts", cause: { state: "stale", reason: "stale_read" }, paths: [{ path: "p" }] }),
      op(11, "txn.ready", "e"),
      op(12, "txn.aborted", "e", { reason: "max_attempts", cause: { state: "failed", reason: "tests" } }),
    ];
    const s = rykeOpStats(ops);
    assert.deepEqual([s.staleAborts, s.conflictAborts, s.staleWhileReady], [3, 1, 2]);
  });
});

// The workload defines "hot": the three files its Zipf draw reads and writes most, plus the pins, which whoever
// changes a pinned constant rewrites and which therefore heat and get leased with it.
describe("the workload's hot paths", () => {
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
  it("is exactly HOT_FILES and the pins", () => {
    for (const f of HOT_FILES) assert.equal(isBenchHotPath(f), true, f);
    for (const f of SEED_FILES.filter((x) => !HOT_FILES.includes(x))) assert.equal(isBenchHotPath(f), false, f);
  });
});

// "Stale aborts on hot files" is a count of aborts: an abort that lists src/format.ts and the pin that goes with
// it is one abort on hot files, not two. Summing the by-path table (`stalePaths`, which stays as it is for the
// per-file report) counted it twice, so the number could exceed all the stale aborts and the lease verdict could
// pass or fail the wrong way.
describe("stale aborts on hot files, each abort once", () => {
  const op = (kind, data, at = 1000) => ({ at, kind, data, txn: null });
  const stale = (paths, reason = "stale_read", at) => op("txn.stale", { reason, paths: paths.map((path) => ({ path, seq: 2 })) }, at);
  const abortedStale = (paths, at) => op("txn.aborted", { reason: "max_attempts", cause: { state: "stale", reason: "stale_read" }, paths: paths.map((path) => ({ path, seq: 4 })) }, at);
  const PIN = "src/bench/pin-seed-format.ts";
  // [name, ops, window, stale aborts, on hot files, the by-path table]
  const rows = [
    ["no ops", [], {}, 0, 0, {}],
    ["one abort on one hot file", [stale(["src/format.ts"])], {}, 1, 1, { "src/format.ts": 1 }],
    ["an abort listing a hot file and its pin is one abort, the table keeps both", [stale(["src/format.ts", PIN])], {}, 1, 1, { "src/format.ts": 1, [PIN]: 1 }],
    ["an abort listing all three hot files and a pin is still one", [stale(["src/format.ts", "src/ui/layout.ts", "src/registry.ts", PIN])], {}, 1, 1, { "src/format.ts": 1, "src/ui/layout.ts": 1, "src/registry.ts": 1, [PIN]: 1 }],
    ["an abort listing the same hot path twice is one", [stale(["src/format.ts", "src/format.ts"])], {}, 1, 1, { "src/format.ts": 2 }],
    ["an abort on a cold file only is not one on hot files", [stale(["src/ui/html.ts", "src/units/length.ts"])], {}, 1, 0, { "src/ui/html.ts": 1, "src/units/length.ts": 1 }],
    ["an abort listing a cold and a hot file is one on hot files", [stale(["src/ui/html.ts", "src/format.ts"])], {}, 1, 1, { "src/ui/html.ts": 1, "src/format.ts": 1 }],
    ["an abort without paths is not on a hot file", [stale([])], {}, 1, 0, {}],
    ["an op without a paths list at all is not on a hot file", [op("txn.stale", { reason: "stale_read" })], {}, 1, 0, {}],
    ["the registry alone is hot", [stale(["src/registry.ts"])], {}, 1, 1, { "src/registry.ts": 1 }],
    ["a pin alone is hot", [stale([PIN])], {}, 1, 1, { [PIN]: 1 }],
    ["a third attempt recorded as an abort with a stale cause counts like a stale op", [abortedStale(["src/format.ts", PIN])], {}, 1, 1, { "src/format.ts": 1, [PIN]: 1 }],
    ["an abort whose cause was a failed verify is not a stale abort", [op("txn.aborted", { reason: "max_attempts", cause: { state: "failed", reason: "tests" }, paths: [{ path: "src/format.ts" }] })], {}, 0, 0, {}],
    ["a text conflict on a hot file is a conflict, not a stale_read abort", [stale(["src/format.ts"], "text_conflict")], {}, 0, 0, {}],
    [
      "several aborts add up one each",
      [stale(["src/format.ts", PIN]), stale(["src/ui/layout.ts"]), stale(["src/ui/html.ts"]), abortedStale(["src/format.ts", "src/ui/layout.ts"])],
      {},
      4,
      3,
      { "src/format.ts": 2, [PIN]: 1, "src/ui/layout.ts": 2, "src/ui/html.ts": 1 },
    ],
    ["only aborts inside the window count", [stale(["src/format.ts"], "stale_read", 500), stale(["src/format.ts", PIN], "stale_read", 1500), stale(["src/format.ts"], "stale_read", 2500)], { sinceAt: 1000, untilAt: 2000 }, 1, 1, { "src/format.ts": 1, [PIN]: 1 }],
  ];
  for (const [name, ops, window, all, hot, byPath] of rows) {
    it(name, () => {
      const s = rykeOpStats(ops, window);
      assert.equal(s.staleAborts, all);
      assert.equal(s.hotStaleAborts, hot);
      assert.deepEqual(s.stalePaths, byPath);
      assert.ok(s.hotStaleAborts <= s.staleAborts, "aborts on hot files can never exceed all the stale aborts");
    });
  }
});

// What the Ledger recorded about leases for a cell's repo. A `ryke-nolease` agent never calls intend-write, so
// its own wait counter is 0 whatever happened; the ops are how the ablation is checked to have taken effect.
describe("lease ops in the Ryke op log", () => {
  const op = (kind, at = 1000, txn = "t_1") => ({ at, kind, data: { path: "src/format.ts" }, txn });
  const rows = [
    ["no ops", [], {}, 0, 0],
    ["grants and waiting ops are counted apart", [op("lease.granted"), op("lease.granted"), op("lease.waiting"), op("lease.waiting"), op("lease.waiting")], {}, 2, 3],
    ["every op counts, a transaction asking again is another op", [op("lease.waiting"), op("lease.waiting"), op("lease.granted")], {}, 1, 2],
    ["a release is neither", [op("lease.released"), op("lease.granted")], {}, 1, 0],
    ["a log with no lease ops at all is a ryke-nolease run", [op("txn.ready"), op("train.formed")], {}, 0, 0],
    ["only the window", [op("lease.granted", 500), op("lease.granted", 1500), op("lease.waiting", 1600), op("lease.waiting", 2500)], { sinceAt: 1000, untilAt: 2000 }, 1, 1],
  ];
  for (const [name, ops, window, grants, waiting] of rows) {
    it(name, () => {
      const s = rykeOpStats(ops, window);
      assert.deepEqual([s.leaseGrantOps, s.leaseWaitingOps], [grants, waiting]);
    });
  }
});

describe("speculative trains in the Ryke op log", () => {
  const op = (at, kind, data) => ({ at, kind, data, txn: null });
  const formed = (at, train, after) => op(at, "train.formed", { train, txns: ["a"], base: "b".repeat(40), ...(after === undefined ? {} : { after }) });
  const done = (at, train, outcome) => op(at, "train.done", { train, outcome });
  const plain = [formed(100, "t1"), done(150, "t1", "landed"), formed(200, "t2"), done(250, "t2", "empty")];
  const log = [
    formed(100, "t1"),
    formed(200, "t2", "t1"),
    op(300, "train.confirmed", { train: "t2", after: "t1" }),
    formed(400, "t3", "t2"),
    done(500, "t3", "discarded"),
    formed(600, "t4", "t2"),
    done(700, "t1", "landed"),
    done(800, "t2", "landed"),
    formed(900, "t5", null),
  ];
  const cases = [
    ["a log of plain trains has none", plain, {}, 2, { formed: 0, confirmed: 0, discarded: 0 }],
    ["an empty log has none", [], {}, 0, { formed: 0, confirmed: 0, discarded: 0 }],
    ["formed with an `after`, confirmed, discarded; landed and empty do not count and `after: null` is not speculative", log, {}, 5, { formed: 3, confirmed: 1, discarded: 1 }],
    ["a train still waiting at the end is formed but neither confirmed nor discarded", log.slice(0, 2), {}, 2, { formed: 1, confirmed: 0, discarded: 0 }],
    ["only what happened by 350", log, { untilAt: 350 }, 2, { formed: 1, confirmed: 1, discarded: 0 }],
    ["only what happened from 450: the discard at 500 and the later formations", log, { sinceAt: 450 }, 2, { formed: 1, confirmed: 0, discarded: 1 }],
    ["a discard counts in the window it happened in", log, { sinceAt: 450, untilAt: 550 }, 0, { formed: 0, confirmed: 0, discarded: 1 }],
  ];
  for (const [name, ops, window, trains, speculative] of cases) {
    it(`rykeOpStats: ${name}`, () => {
      const s = rykeOpStats(ops, window);
      assert.equal(s.trains, trains);
      assert.deepEqual(s.speculative, speculative);
    });
  }

  it("speculative trains are trains: they are in the size counts and never change the other numbers", () => {
    const s = rykeOpStats(log);
    assert.deepEqual(s.trainSizes, { 1: 5 });
    assert.equal(s.bisectProbes, 0);
    assert.equal(s.staleAborts, 0);
  });
});

describe("the results JSON", () => {
  const cell = (policy, agents) => ({ policy, agents, landed: 4, landedPerMinute: 2, p50: 9.5, p95: 20, aborts: { stale_read: 1 }, verifyRunsPerLanded: 1.25, wastedAgentSeconds: 12.5, trunkBreakages: 0 });
  const cells = POLICIES.map((p) => cell(p, 10));
  const note = noteFor({ factor: 1, seed: 7 });

  it("has exactly the BenchResults fields, synthetic is true and parseBench accepts it", () => {
    const r = buildResults({ cells, durationSeconds: 120, note, generatedAt: "2026-10-12T10:00:00.000Z" });
    assert.deepEqual(Object.keys(r), ["generatedAt", "durationSeconds", "synthetic", "note", "cells"]);
    assert.equal(r.synthetic, true);
    const parsed = parseBench(JSON.parse(JSON.stringify(r)));
    assert.ok(parsed);
    assert.equal(parsed.cells.length, 3);
    for (const c of parsed.cells) assert.deepEqual(Object.keys(c).sort(), Object.keys(cell("ryke", 1)).sort());
  });

  it("refuses a result the dashboard would refuse", () => {
    assert.throws(() => buildResults({ cells: [{ ...cell("ryke", 10), landed: Number.NaN }], durationSeconds: 1, note }), /bench\.ts/);
    assert.throws(() => buildResults({ cells: [{ ...cell("ryke", 10), policy: "git" }], durationSeconds: 1, note }), /bench\.ts/);
    assert.throws(() => buildResults({ cells: [{ ...cell("ryke", 10), aborts: { x: "1" } }], durationSeconds: 1, note }), /bench\.ts/);
  });

  it("accepts ablation cells as the Ryke variant they are, and still refuses a malformed one", () => {
    const ablation = [cell("ryke", 50), cell("ryke-nolease", 50), cell("ryke-nopipe", 50)];
    const r = buildResults({ cells: ablation, durationSeconds: 120, note, generatedAt: "2026-10-12T10:00:00.000Z" });
    assert.deepEqual(r.cells.map((c) => c.policy), ["ryke", "ryke-nolease", "ryke-nopipe"]);
    assert.throws(() => buildResults({ cells: [{ ...cell("ryke-nopipe", 50), landed: Number.NaN }], durationSeconds: 1, note }), /bench\.ts/);
    assert.throws(() => buildResults({ cells: [cell("ryke-nopipe-x", 50)], durationSeconds: 1, note }), /bench\.ts/);
    assert.throws(() => buildResults({ cells: [{ ...cell("ryke-nolease", 50), landed: Number.NaN }], durationSeconds: 1, note }), /bench\.ts/);
    assert.throws(() => buildResults({ cells: [{ ...cell("ryke-nolease", 50), aborts: [] }], durationSeconds: 1, note }), /bench\.ts/);
    assert.throws(() => buildResults({ cells: [cell("ryke-nolease-x", 50)], durationSeconds: 1, note }), /bench\.ts/);
  });

  // Why a run with an ablation never goes to bench/results/latest.json: parseBench in src/shared/bench.ts
  // rejects the whole file when one cell names a policy outside POLICIES. Update this when it learns the name.
  it("the dashboard's parseBench refuses a file with a policy it does not know", () => {
    const file = (cells) => ({ generatedAt: null, durationSeconds: 1, synthetic: true, note: "n", cells });
    for (const name of ABLATION_POLICIES) assert.equal(parseBench(file([cell("ryke", 50), cell(name, 50)])), null, name);
    assert.ok(parseBench(file([cell("ryke", 50)])));
  });

  it("the note says what the agents are, and the time factor, seed, VM and Jev", () => {
    const n = noteFor({ factor: 0.5, seed: 11 });
    for (const part of ["Synthetic agents: real git, real merges, real tests, scripted edits", "Time factor 0.5", "median think 3 s", "seed 11", `${availableParallelism()}-vCPU VM`, "Jev off"]) assert.ok(n.includes(part), `${part} in ${n}`);
  });

  it("writes <date>.json, latest.json, latest.md and the optional details", async () => {
    const results = buildResults({ cells, durationSeconds: 120, note, generatedAt: "2026-10-12T10:00:00.000Z" });
    const details = POLICIES.map((p) => detail(p, 10));
    const markdown = renderMarkdown({ results, details, meta: { caveats: [] } });
    const out = join(tmp, "results");
    const files = await writeResults(out, { results, markdown, details }, join(tmp, "results-detail", "d.json"));
    assert.deepEqual(files.map((f) => relative(tmp, f)), ["results/2026-10-12.json", "results/latest.json", "results/latest.md", "results-detail/d.json"]);
    assert.deepEqual(JSON.parse(await readFile(join(out, "latest.json"), "utf8")), results);
    assert.equal(await readFile(join(out, "2026-10-12.json"), "utf8"), await readFile(join(out, "latest.json"), "utf8"));
    assert.match(await readFile(join(out, "latest.md"), "utf8"), /# Ryke bench/);
  });
});

function detail(policy, agents, over = {}) {
  return {
    policy,
    agents,
    landedInGrace: 0,
    abandoned: 0,
    started: 12,
    attemptsPerLanded: 1.5,
    incompatibility: { plans: 12, overlapping: 66, incompatible: 7, rate: 0.106 },
    refreshes: 2,
    leaseWaits: 1,
    errors: 0,
    errorSamples: [],
    meanVerifySeconds: 1.2,
    loopLagMs: { p50: 20, p99: 40, max: 90 },
    loadAverage1m: 1.5,
    ledger: null,
    ryke: policy.startsWith("ryke") ? { trains: 5, meanTrainSize: 2.4, maxTrainSize: 5, bisectProbes: 0, staleWarnings: 3, staleAborts: 4, conflictAborts: 0, trainCycleSecondsP50: 3, trainCycleSecondsP95: 5, stalePaths: { "src/format.ts": 3, "src/ui/layout.ts": 1 }, speculative: { formed: 4, confirmed: 3, discarded: 1 } } : null,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
describe("the report", () => {
  const cell = (policy, agents, perMin) => ({ policy, agents, landed: perMin * 2, landedPerMinute: perMin, p50: 8, p95: 16.5, aborts: policy === "lock" ? {} : { stale_read: 3 }, verifyRunsPerLanded: 1, wastedAgentSeconds: 4, trunkBreakages: 0 });

  it("table pads to the widest cell", () => {
    assert.equal(table(["a", "bb"], [["xxx", "y"]]), "| a   | bb |\n| --- | -- |\n| xxx | y  |");
  });

  it("chart: one bar per policy per agent count, scaled to the best cell", () => {
    const text = chart([cell("lock", 10, 5), cell("queue", 10, 10), cell("ryke", 10, 20), cell("ryke", 50, 40)], { width: 40 });
    const bars = text.split("\n").filter((l) => l.includes("|")).map((l) => (l.match(/#/g) ?? []).length);
    assert.deepEqual(bars, [5, 10, 20, 40]);
    assert.match(text, /10 agents/);
    assert.match(text, /50 agents/);
    assert.match(text, /ryke  \|#+ *\| 40/);
  });

  it("chart: an empty or all-zero run does not divide by zero", () => {
    assert.equal(typeof chart([]), "string");
    assert.doesNotMatch(chart([cell("lock", 10, 0)]), /NaN|Infinity/);
  });

  const verdictCases = [
    ["ryke wins every large N", [cell("lock", 10, 9), cell("ryke", 10, 5), cell("lock", 50, 3), cell("queue", 50, 6), cell("ryke", 50, 12), cell("ryke", 100, 20), cell("queue", 100, 7)], true, 2],
    ["ryke loses one large N", [cell("ryke", 50, 12), cell("queue", 50, 6), cell("ryke", 100, 5), cell("queue", 100, 7)], false, 2],
    ["only small N: not evaluated", [cell("ryke", 10, 1), cell("lock", 10, 2)], false, 0],
  ];
  for (const [name, cells, wins, large] of verdictCases) {
    it(`verdict: ${name}`, () => {
      const v = verdict(cells);
      assert.equal(v.rykeWinsEveryLarge, wins);
      assert.equal(v.large, large);
    });
  }

  it("the markdown has the note, every cell, the chart, the verdict and the caveats", () => {
    const cells = POLICIES.flatMap((p) => [cell(p, 10, p === "ryke" ? 9 : 4), cell(p, 50, p === "ryke" ? 7 : 5)]);
    const results = buildResults({ cells, durationSeconds: 120, note: noteFor({ factor: 1, seed: 7 }), generatedAt: "2026-10-12T10:00:00.000Z" });
    const md = renderMarkdown({ results, details: cells.map((c) => detail(c.policy, c.agents)), meta: { caveats: ["N = 200 was left out (PLAN.md cut C3)."] } });
    for (const part of ["Synthetic agents: real git, real merges, real tests, scripted edits", "## Throughput", "## Every cell", "### Ryke internals", "Ryke has the highest landed/min at every N >= 50", "N = 200 was left out", "src/format.ts 3"]) assert.ok(md.includes(part), part);
    assert.equal((md.match(/^\| (lock|queue|ryke) +\| \d+ +\| \d+ +\| [\d.]+ +\| 8 /gm) ?? []).length, 6);
  });

  it("the verify-runs note counts discarded speculative trains as one run each and calls the ratio an upper bound", () => {
    const cells = [cell("ryke", 50, 9), cell("lock", 50, 4)];
    const results = buildResults({ cells, durationSeconds: 60, note: "n", generatedAt: null });
    const md = renderMarkdown({ results, details: cells.map((c) => detail(c.policy, c.agents)), meta: {} });
    const note = md.split("\n").find((l) => l.startsWith("- Verify runs"));
    assert.ok(note, "a note on verify runs under How to read this");
    assert.match(note, /bisection probes/);
    assert.match(note, /Discarded speculative trains are counted as one verify run each/);
    assert.match(note, /skips verify when the turn check after prepare already says discard/);
    assert.match(note, /upper bound for pipelined Ryke/);
    assert.match(note, /baselines run one verify per attempt that merged cleanly/);
  });

  describe("with write leases off", () => {
    const pair = (n, on, off) => [cell("ryke", n, on), cell("ryke-nolease", n, off)];
    const aborted = (c, stale) => ({ ...c, aborts: { stale_read: stale, max_attempts: 1 } });

    it("the chart labels the ablation without breaking the bars", () => {
      const text = chart([...pair(50, 20, 10), cell("lock", 50, 5)], { width: 40 });
      assert.match(text, /^ {2}ryke-nolease \|#{20} *\| 10$/m);
      assert.match(text, /^ {2}ryke {9}\|#{40}\| 20$/m);
      assert.match(text, /^ {2}lock {9}\|#{10} *\| 5$/m);
    });

    it("the ablation is never a competitor: it does not change the verdict", () => {
      const v = verdict([cell("lock", 50, 3), cell("queue", 50, 4), cell("ryke", 50, 9)].filter((c) => POLICIES.includes(c.policy)));
      assert.equal(v.rykeWinsEveryLarge, true);
      const cells = [cell("lock", 50, 3), cell("queue", 50, 4), ...pair(50, 9, 30)];
      const results = buildResults({ cells, durationSeconds: 60, note: "n", generatedAt: null });
      const md = renderMarkdown({ results, details: cells.map((c) => detail(c.policy, c.agents)), meta: {} });
      assert.match(md, /Ryke has the highest landed\/min at every N >= 50/);
      assert.match(md, /\| 50 +\| queue 4 > lock 3 > ryke 9|\| 50 +\| ryke 9 > queue 4 > lock 3/);
      assert.doesNotMatch(md, /ryke-nolease \d+ >/);
    });

    const comparison = [
      ["leases win", pair(50, 24, 20), "+20 %"],
      ["leases lose", pair(50, 15, 20), "-25 %"],
      ["equal", pair(50, 20, 20), "+0 %"],
      ["nothing lands without leases", pair(50, 20, 0), "n/a"],
    ];
    for (const [name, cells, delta] of comparison) {
      it(`leaseComparison, ${name}: ${delta}`, () => {
        const { rows, lines } = leaseComparison(cells.map((c) => aborted(c, c.policy === "ryke" ? 2 : 7)), cells.map((c) => detail(c.policy, c.agents)));
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((r) => r[1]), ["ryke", "ryke-nolease"]);
        assert.deepEqual(rows.map((r) => r[6]), [2, 7]);
        assert.equal(lines.length, 1);
        assert.ok(lines[0].includes(`(${delta})`), lines[0]);
        assert.match(lines[0], /stale_read aborts 2 against 7/);
      });
    }

    it("leaseComparison pairs by agent count and shows a lone ablation cell without a delta", () => {
      const cells = [...pair(10, 5, 4), cell("ryke-nolease", 50, 9), cell("ryke", 100, 30)];
      const { rows, lines } = leaseComparison(cells, cells.map((c) => detail(c.policy, c.agents)));
      assert.deepEqual(rows.map((r) => `${r[0]} ${r[1]}`), ["10 ryke", "10 ryke-nolease", "50 ryke-nolease"]);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^- 10 agents/);
    });

    it("leaseComparison is empty, and the section absent, when no ablation cell ran", () => {
      assert.deepEqual(leaseComparison([cell("ryke", 50, 9), cell("lock", 50, 3)], []), { rows: [], lines: [] });
      const results = buildResults({ cells: [cell("ryke", 50, 9)], durationSeconds: 60, note: "n", generatedAt: null });
      assert.doesNotMatch(renderMarkdown({ results, details: [detail("ryke", 50)], meta: {} }), /Write leases on and off/);
    });

    it("the markdown has the lease section, both policies in the cell table and the Ryke internals", () => {
      const cells = pair(50, 24, 20);
      const results = buildResults({ cells, durationSeconds: 120, note: noteFor({ factor: 1, seed: 7 }), generatedAt: "2026-10-12T10:00:00.000Z" });
      const details = cells.map((c) => detail(c.policy, c.agents, c.policy === "ryke-nolease" ? { leaseWaits: 0 } : {}));
      const md = renderMarkdown({ results, details, meta: { caveats: caveatsFor(details) } });
      for (const part of ["## Write leases on and off", "ryke-nolease", "leases on land 24/min against 20/min with leases off (+20 %)", "| policy", "never call intend-write"]) assert.ok(md.includes(part), part);
      assert.equal((md.match(/^\| ryke(-nolease)? +\| 50 /gm) ?? []).length >= 4, true, "both policies appear in every per-cell table");
    });
  });

  describe("with speculative pipelining off", () => {
    const pair = (n, on, off) => [cell("ryke", n, on), cell("ryke-nopipe", n, off)];
    const stats = (over) => ({ ...detail("ryke", 1).ryke, ...over });
    const detailsOf = (cells, byPolicy = {}) => cells.map((c) => detail(c.policy, c.agents, byPolicy[c.policy] ? { ryke: byPolicy[c.policy] } : {}));
    const column = (cmp, name) => {
      const at = cmp.headers.indexOf(name);
      assert.ok(at >= 0, `no column ${name} in ${cmp.headers}`);
      return cmp.rows.map((r) => r[at]);
    };

    it("the chart puts the ablations after ryke, in the order of BENCH_POLICIES, without breaking the bars", () => {
      const text = chart([cell("ryke-nopipe", 50, 10), cell("ryke-nolease", 50, 15), cell("ryke", 50, 20), cell("lock", 50, 5)], { width: 40 });
      const lines = text.split("\n").filter((l) => l.includes("|"));
      assert.deepEqual(lines.map((l) => l.trim().split(/\s+/)[0]), ["lock", "ryke", "ryke-nolease", "ryke-nopipe"]);
      assert.match(text, /^ {2}ryke-nopipe {2}\|#{20} *\| 10$/m);
      assert.match(text, /^ {2}ryke {9}\|#{40}\| 20$/m);
    });

    it("the chart pads to the ablation's own name when it is the longest", () => {
      assert.match(chart([cell("ryke", 50, 20), cell("ryke-nopipe", 50, 10)], { width: 40 }), /^ {2}ryke {8}\|#{40}\| 20$/m);
    });

    it("an ablation that beats Ryke is still not a competitor: the verdict and the ranking ignore it", () => {
      const cells = [cell("lock", 50, 3), cell("queue", 50, 4), ...pair(50, 9, 30)];
      const results = buildResults({ cells, durationSeconds: 60, note: "n", generatedAt: null });
      const md = renderMarkdown({ results, details: detailsOf(cells), meta: {} });
      assert.match(md, /Ryke has the highest landed\/min at every N >= 50/);
      assert.match(md, /\| 50 +\| ryke 9 > queue 4 > lock 3 +\| ryke +\|/);
      assert.doesNotMatch(md, /ryke-nopipe \d+ >/);
    });

    const comparison = [
      ["pipelining wins", pair(50, 24, 20), "+20 %"],
      ["pipelining loses", pair(50, 15, 20), "-25 %"],
      ["equal", pair(50, 20, 20), "+0 %"],
      ["nothing lands without pipelining", pair(50, 20, 0), "n/a"],
    ];
    for (const [name, cells, delta] of comparison) {
      it(`pipelineComparison, ${name}: ${delta}`, () => {
        const withAborts = cells.map((c) => ({ ...c, aborts: { stale_read: c.policy === "ryke" ? 2 : 7, max_attempts: 1 } }));
        const cmp = pipelineComparison(withAborts, detailsOf(withAborts));
        assert.deepEqual(column(cmp, "policy"), ["ryke", "ryke-nopipe"]);
        assert.deepEqual(column(cmp, "stale_read aborts"), [2, 7]);
        assert.deepEqual(column(cmp, "max_attempts"), [1, 1]);
        assert.equal(cmp.lines.length, 1);
        assert.ok(cmp.lines[0].includes(`(${delta})`), cmp.lines[0]);
        assert.match(cmp.lines[0], /^- 50 agents: pipelining on lands \d+\/min against \d+\/min with pipelining off/);
      });
    }

    it("pipelineComparison: every column of a row, from the cell and from the Ryke op stats", () => {
      const cells = [
        { ...cell("ryke", 50, 24), p50: 11.5, p95: 30, verifyRunsPerLanded: 1.4, wastedAgentSeconds: 120.5, aborts: { stale_read: 5, max_attempts: 2 } },
        { ...cell("ryke-nopipe", 50, 20), p50: 14, p95: 41.25, verifyRunsPerLanded: 1.1, wastedAgentSeconds: 180, aborts: { stale_read: 9 } },
      ];
      const cmp = pipelineComparison(
        cells,
        detailsOf(cells, { ryke: stats({ trains: 31, staleWhileReady: 6, speculative: { formed: 12, confirmed: 9, discarded: 3 } }), "ryke-nopipe": stats({ trains: 22, staleWhileReady: 11, speculative: { formed: 0, confirmed: 0, discarded: 0 } }) }),
      );
      assert.deepEqual(cmp.headers, ["agents", "policy", "landed/min", "p50 s", "p95 s", "verify runs/landed", "wasted agent-s", "stale_read aborts", "stale while ready", "max_attempts", "trains formed", "speculative (formed / confirmed / discarded)"]);
      assert.deepEqual(cmp.rows, [
        [50, "ryke", "24", "11.5", "30", "1.4", "120.5", 5, 6, 2, 31, "12 / 9 / 3"],
        [50, "ryke-nopipe", "20", "14", "41.25", "1.1", "180", 9, 11, 0, 22, "0 / 0 / 0"],
      ]);
      assert.deepEqual(cmp.lines, ["- 50 agents: pipelining on lands 24/min against 20/min with pipelining off (+20 %); p95 30 s against 41.25 s; verify runs per landed change 1.4 against 1.1; wasted agent-seconds 120.5 against 180; speculative trains 12 formed, 9 confirmed, 3 discarded."]);
    });

    it("pipelineComparison: details from before the speculative counts existed show a dash, and the line drops the sentence", () => {
      const cells = pair(50, 24, 20);
      const old = { ...detail("ryke", 50).ryke };
      delete old.speculative;
      delete old.trains;
      const cmp = pipelineComparison(cells, detailsOf(cells, { ryke: old, "ryke-nopipe": old }));
      assert.deepEqual(column(cmp, "speculative (formed / confirmed / discarded)"), ["-", "-"]);
      assert.deepEqual(column(cmp, "trains formed"), ["-", "-"]);
      assert.doesNotMatch(cmp.lines[0], /speculative/);
      const none = pipelineComparison(cells, []);
      assert.deepEqual(column(none, "stale while ready"), ["-", "-"]);
    });

    it("pipelineComparison pairs by agent count and shows a lone ablation cell without a delta", () => {
      const cells = [...pair(10, 5, 4), cell("ryke-nopipe", 50, 9), cell("ryke", 100, 30)];
      const cmp = pipelineComparison(cells, detailsOf(cells));
      assert.deepEqual(cmp.rows.map((r) => `${r[0]} ${r[1]}`), ["10 ryke", "10 ryke-nopipe", "50 ryke-nopipe"]);
      assert.equal(cmp.lines.length, 1);
      assert.match(cmp.lines[0], /^- 10 agents/);
    });

    it("pipelineComparison ignores the other ablation: each pairs against plain ryke only", () => {
      const cells = [cell("ryke", 50, 20), cell("ryke-nolease", 50, 15), cell("ryke-nopipe", 50, 10)];
      const details = detailsOf(cells);
      assert.deepEqual(pipelineComparison(cells, details).rows.map((r) => r[1]), ["ryke", "ryke-nopipe"]);
      assert.deepEqual(leaseComparison(cells, details).rows.map((r) => r[1]), ["ryke", "ryke-nolease"]);
    });

    it("pipelineComparison is empty, and the section absent, when no nopipe cell ran", () => {
      assert.deepEqual(pipelineComparison([cell("ryke", 50, 9), cell("ryke-nolease", 50, 3), cell("lock", 50, 3)], []).rows, []);
      assert.deepEqual(pipelineComparison([cell("ryke", 50, 9)], []).lines, []);
      const cells = pair(50, 24, 20).slice(0, 1);
      const results = buildResults({ cells, durationSeconds: 60, note: "n", generatedAt: null });
      assert.doesNotMatch(renderMarkdown({ results, details: detailsOf(cells), meta: {} }), /Speculative pipelining on and off|ryke-nopipe/);
    });

    it("the markdown has the pipelining section with both policies, and no lease section", () => {
      const cells = pair(50, 24, 20);
      const results = buildResults({ cells, durationSeconds: 120, note: noteFor({ factor: 1, seed: 7 }), generatedAt: "2026-10-12T10:00:00.000Z" });
      const details = detailsOf(cells, { "ryke-nopipe": stats({ speculative: { formed: 0, confirmed: 0, discarded: 0 } }) });
      const md = renderMarkdown({ results, details, meta: { caveats: caveatsFor(details) } });
      for (const part of ["## Speculative pipelining on and off", "`ryke-nopipe` is Ryke with `pipeline: false`", "pipelining on lands 24/min against 20/min with pipelining off (+20 %)", "speculative trains 4 formed, 3 confirmed, 1 discarded", "| speculative (formed / confirmed / discarded) |", "0 / 0 / 0"]) assert.ok(md.includes(part), part);
      assert.doesNotMatch(md, /Write leases on and off/);
      assert.equal((md.match(/^\| ryke(-nopipe)? +\| 50 /gm) ?? []).length >= 4, true, "both policies appear in every per-cell table");
    });

    it("a run with both ablations gets two tables, each against plain ryke, the lease one first", () => {
      const cells = [...pair(50, 24, 20), cell("ryke-nolease", 50, 18), ...pair(100, 30, 25), cell("ryke-nolease", 100, 22)];
      const results = buildResults({ cells, durationSeconds: 120, note: "n", generatedAt: "2026-10-12T10:00:00.000Z" });
      const md = renderMarkdown({ results, details: detailsOf(cells), meta: {} });
      const sections = Object.fromEntries(md.split(/^## /m).slice(1).map((s) => [s.split("\n")[0], s]));
      const rowsOf = (title) => (sections[title].match(/^\| \d+ +\| (ryke\S*) /gm) ?? []).map((r) => r.replace(/^\| \d+ +\| /, "").trim());
      assert.deepEqual(rowsOf("Write leases on and off"), ["ryke", "ryke-nolease", "ryke", "ryke-nolease"]);
      assert.deepEqual(rowsOf("Speculative pipelining on and off"), ["ryke", "ryke-nopipe", "ryke", "ryke-nopipe"]);
      assert.ok(md.indexOf("## Write leases on and off") < md.indexOf("## Speculative pipelining on and off"));
      assert.ok(md.indexOf("## Speculative pipelining on and off") < md.indexOf("## Every cell"));
      assert.match(sections["Write leases on and off"], /leases on land 24\/min against 18\/min with leases off/);
      assert.match(sections["Speculative pipelining on and off"], /pipelining on lands 24\/min against 20\/min with pipelining off/);
    });

    it("a run with only the lease ablation renders the lease section exactly as before", () => {
      const cells = [cell("ryke", 50, 24), cell("ryke-nolease", 50, 20)].map((c) => ({ ...c, aborts: { stale_read: c.policy === "ryke" ? 2 : 7, max_attempts: 1 } }));
      const results = buildResults({ cells, durationSeconds: 120, note: "n", generatedAt: "2026-10-12T10:00:00.000Z" });
      const md = renderMarkdown({ results, details: cells.map((c) => detail(c.policy, c.agents, c.policy === "ryke-nolease" ? { leaseWaits: 0 } : {})), meta: {} });
      const section = md.slice(md.indexOf("## Write leases on and off"), md.indexOf("## Every cell"));
      assert.equal(
        section,
        [
          "## Write leases on and off",
          "",
          "`ryke-nolease` is Ryke with the same agents and the same refresh on a stale warning, but the agents never take write leases.",
          "",
          "| agents | policy       | landed/min | p50 s | p95 s | wasted agent-s | stale_read aborts | max_attempts | refreshes | lease waits | stale while ready |",
          "| ------ | ------------ | ---------- | ----- | ----- | -------------- | ----------------- | ------------ | --------- | ----------- | ----------------- |",
          "| 50     | ryke         | 24         | 8     | 16.5  | 4              | 2                 | 1            | 2         | 1 (0 s)     | 0                 |",
          "| 50     | ryke-nolease | 20         | 8     | 16.5  | 4              | 7                 | 1            | 2         | 0 (0 s)     | 0                 |",
          "",
          "- 50 agents: leases on land 24/min against 20/min with leases off (+20 %); stale_read aborts 2 against 7; wasted agent-seconds 4 against 4.",
          "",
          "",
        ].join("\n"),
      );
      assert.doesNotMatch(md, /Speculative pipelining|nopipe/);
    });
  });

  it("the markdown says plainly when Ryke does not win", () => {
    const cells = [cell("ryke", 50, 3), cell("queue", 50, 6)];
    const results = buildResults({ cells, durationSeconds: 60, note: "n", generatedAt: null });
    assert.match(renderMarkdown({ results, details: cells.map((c) => detail(c.policy, c.agents)), meta: {} }), /does NOT have the highest/);
  });

  describe("the ablation caveats", () => {
    const NOLEASE = "`ryke-nolease` is Ryke with write leases off: identical agents and refresh on a stale warning, but they never call intend-write.";
    const NOPIPE = "`ryke-nopipe` is Ryke with speculative pipelining off (`pipeline: false` in the seeded ryke.json): identical agents and leases, but the Ledger forms one train at a time.";
    const DASHBOARD = "The dashboard's results format only knows lock, queue and ryke, so this run is not written to bench/results/latest.json.";
    // A nopipe cell that really ran without pipelining formed no speculative train.
    const stats = (speculative) => ({ ...detail("ryke", 50).ryke, speculative });
    const none = { formed: 0, confirmed: 0, discarded: 0 };
    const cellOf = (policy, agents = 50, speculative = none) => detail(policy, agents, policy === "ryke-nopipe" ? { ryke: stats(speculative) } : {});
    const ablationLines = (policies) => caveatsFor(policies.map((p) => cellOf(p))).filter((l) => /ablation|dashboard|^`ryke-no/.test(l));
    const cases = [
      ["no ablation: no line at all", ["lock", "queue", "ryke"], []],
      ["only the lease ablation: the text it always had, in one line", ["ryke", "ryke-nolease"], [`${NOLEASE} ${DASHBOARD}`]],
      ["only the pipelining ablation", ["ryke", "ryke-nopipe"], [`${NOPIPE} ${DASHBOARD}`]],
      ["both: one line, the dashboard sentence once", ["ryke", "ryke-nolease", "ryke-nopipe"], [`${NOLEASE} ${NOPIPE} ${DASHBOARD}`]],
      ["a lone ablation cell without plain ryke", ["ryke-nopipe"], [`${NOPIPE} ${DASHBOARD}`]],
    ];
    for (const [name, policies, want] of cases) it(name, () => assert.deepEqual(ablationLines(policies), want));

    it("says so when the ablation did not take effect: a ryke-nopipe cell that formed speculative trains", () => {
      const lines = caveatsFor([cellOf("ryke-nopipe", 50, { formed: 3, confirmed: 2, discarded: 1 }), cellOf("ryke-nopipe", 100)]);
      assert.ok(lines.some((l) => l === "ryke-nopipe x 50: 3 speculative train(s) formed although pipelining was off, so the ablation did not take effect."), lines.join("\n"));
      assert.equal(lines.filter((l) => l.includes("did not take effect")).length, 1);
    });

    for (const [name, ryke] of [["none formed", stats(none)], ["details from before the counts existed", { trains: 4 }], ["no Ryke stats at all", null]]) {
      it(`stays quiet about the ablation taking effect when ${name}`, () => {
        assert.ok(!caveatsFor([detail("ryke-nopipe", 50, { ryke })]).some((l) => l.includes("did not take effect")));
      });
    }

    it("plain ryke forming speculative trains is the point, not a caveat", () => {
      assert.ok(!caveatsFor([detail("ryke", 50)]).some((l) => l.includes("did not take effect")));
    });
  });

  it("caveatsFor flags errors, a starved event loop, an oversubscribed machine and a busy lander", () => {
    const cpus = availableParallelism();
    const c = caveatsFor(
      [
        detail("ryke", 50, { errors: 2, errorSamples: ["boom"], loopLagMs: { p99: 900, max: 2000 }, loadAverage1m: cpus * 3, ledger: { quiet: false } }),
        detail("lock", 10),
      ],
      ["extra line"],
    );
    for (const part of ["extra line", "ryke x 50: 2 agent error(s), for example: boom", "event loop lagged (p99 900 ms", "load average", "still busy"]) assert.ok(c.some((l) => l.includes(part)), part);
    assert.equal(c.filter((l) => l.startsWith("lock x 10")).length, 0);
    assert.ok(c.some((l) => l.includes("synthetic")));
  });
});

// ---------------------------------------------------------------------------------------------
describe("the command line", () => {
  it("defaults", () => {
    const o = parseBenchArgs([]);
    assert.deepEqual(o.agents, [10, 50, 100, 200]);
    assert.deepEqual(o.policies, ["lock", "queue", "ryke"]);
    assert.deepEqual([o.durationS, o.factor, o.seed, o.offset, o.graceS], [300, 1, 7, 70, 20]);
  });

  it("parses every option", () => {
    const o = parseBenchArgs(["--agents", "5, 7", "--policy", "ryke", "--duration", "60", "--time-factor", "0.5", "--seed", "3", "--offset", "90", "--grace", "5", "--caveat", "a", "--caveat", "b", "--out", "x"]);
    assert.deepEqual([o.agents, o.policies, o.durationS, o.factor, o.seed, o.offset, o.graceS, o.caveats], [[5, 7], ["ryke"], 60, 0.5, 3, 90, 5, ["a", "b"]]);
    assert.ok(o.out.endsWith("/x"));
  });

  const policyCases = [
    [[], ["lock", "queue", "ryke"], "bench/results"],
    [["--policy", "ryke,ryke-nolease"], ["ryke", "ryke-nolease"], "bench/results/ablation"],
    [["--policy", "ryke-nolease"], ["ryke-nolease"], "bench/results/ablation"],
    [["--policy", "ryke,ryke-nopipe"], ["ryke", "ryke-nopipe"], "bench/results/ablation"],
    [["--policy", "ryke-nopipe"], ["ryke-nopipe"], "bench/results/ablation"],
    [["--policy", "ryke,ryke-nolease,ryke-nopipe"], ["ryke", "ryke-nolease", "ryke-nopipe"], "bench/results/ablation"],
    [["--policy", "lock,queue,ryke,ryke-nolease"], ["lock", "queue", "ryke", "ryke-nolease"], "bench/results/ablation"],
    [["--policy", "lock,queue,ryke,ryke-nolease,ryke-nopipe"], ["lock", "queue", "ryke", "ryke-nolease", "ryke-nopipe"], "bench/results/ablation"],
    [["--policy", "queue,ryke"], ["queue", "ryke"], "bench/results"],
    [["--policy", "ryke,ryke-nolease", "--out", "/tmp/x"], ["ryke", "ryke-nolease"], "/tmp/x"],
    [["--policy", "ryke,ryke-nopipe", "--out", "/tmp/x"], ["ryke", "ryke-nopipe"], "/tmp/x"],
    [["--policy", "ryke", "--out", "bench/other"], ["ryke"], "bench/other"],
  ];
  for (const [argv, policies, out] of policyCases) {
    it(`policies ${JSON.stringify(policies)}, results go to ${out}${argv.includes("--out") ? " (explicit)" : ""}`, () => {
      const o = parseBenchArgs(argv);
      assert.deepEqual(o.policies, policies);
      assert.ok(o.out.endsWith(out), `${o.out} should end with ${out}`);
      // The default policy list never includes an ablation: the dashboard file must keep its three names.
      if (argv.length === 0) assert.ok(o.policies.every((p) => !ABLATION_POLICIES.includes(p)));
    });
  }

  // bench/results/latest.json is read by the dashboard, whose parseBench refuses the whole file when one cell names a
  // policy it does not know. An explicit --out must not be a way around the default that keeps ablations out of it.
  describe("--out at the dashboard's results directory", () => {
    const dashboard = join(ROOT, "bench/results");
    const ablationDir = join(dashboard, "ablation");
    const message = (policy) => (e) =>
      e instanceof UsageError &&
      /--out/.test(e.message) &&
      /bench\/results\/ablation/.test(e.message) &&
      /lock, queue and ryke/.test(e.message) &&
      policy.split(",").filter((p) => ABLATION_POLICIES.includes(p)).every((p) => e.message.includes(p));
    for (const policy of ["ryke,ryke-nolease", "ryke,ryke-nopipe", "ryke-nolease", "ryke-nopipe", "ryke,ryke-nolease,ryke-nopipe", "lock,queue,ryke,ryke-nopipe"]) {
      it(`refuses ${policy}`, () => assert.throws(() => parseBenchArgs(["--policy", policy, "--out", dashboard]), message(policy)));
    }
    // The same directory under every spelling that resolves to it.
    const spellings = [
      ["with a trailing slash", `${dashboard}/`],
      ["relative to the working directory", relative(process.cwd(), dashboard)],
      ["through a parent directory", join(ablationDir, "..")],
      ["through a dot", `${dashboard}/.`],
    ];
    for (const [spelling, out] of spellings) {
      it(`refuses an ablation with --out ${spelling}`, () => assert.throws(() => parseBenchArgs(["--policy", "ryke,ryke-nolease", "--out", out]), message("ryke,ryke-nolease")));
    }

    const allowed = [
      ["the dashboard's own three policies", ["--policy", "lock,queue,ryke", "--out", dashboard], dashboard],
      ["plain ryke alone", ["--policy", "ryke", "--out", dashboard], dashboard],
      ["the default policies with the default out, spelled out", ["--out", dashboard], dashboard],
      ["an ablation in the ablation directory", ["--policy", "ryke,ryke-nolease", "--out", ablationDir], ablationDir],
      ["an ablation in a directory next to it", ["--policy", "ryke,ryke-nopipe", "--out", `${dashboard}-ablation`], `${dashboard}-ablation`],
      ["an ablation in another directory below it", ["--policy", "ryke,ryke-nopipe", "--out", join(dashboard, "repeats")], join(dashboard, "repeats")],
      ["an ablation somewhere else", ["--policy", "ryke,ryke-nolease", "--out", "/tmp/x"], "/tmp/x"],
      ["an ablation without --out, which defaults to the ablation directory", ["--policy", "ryke,ryke-nolease"], ablationDir],
    ];
    for (const [name, argv, out] of allowed) it(`allows ${name}`, () => assert.equal(parseBenchArgs(argv).out, out));
  });

  it("the policy names are the dashboard's three plus the two ablations", () => {
    assert.deepEqual(ABLATION_POLICIES, ["ryke-nolease", "ryke-nopipe"]);
    assert.deepEqual(BENCH_POLICIES, [...POLICIES, "ryke-nolease", "ryke-nopipe"]);
    for (const [name, want] of [["ryke", true], ["ryke-nolease", true], ["ryke-nopipe", true], ["lock", false], ["queue", false], ["ryke2", false], ["nolease", false], ["nopipe", false], ["ryke-nopipe2", false]]) assert.equal(isRyke(name), want, name);
  });

  const bad = [
    [["--policy", "nolease"], /--policy/],
    [["--policy", "ryke-nolease2"], /--policy/],
    [["--policy", "nopipe"], /--policy/],
    [["--policy", "ryke-nopipe2"], /--policy/],
    [["--policy", "ryke-nopipes"], /--policy/],
    [["--policy", "ryke,,Ryke"], /--policy/],
    [["--agents", "0"], /--agents/],
    [["--agents", "ten"], /--agents/],
    [["--agents", ""], /at least one/],
    [["--agents", "5000"], /--agents/],
    [["--policy", "git"], /--policy/],
    [["--duration", "2"], /--duration/],
    [["--time-factor", "0"], /--time-factor/],
    [["--seed", "1.5"], /--seed/],
    [["--offset", "-1"], /--offset/],
    [["--grace", "-3"], /--grace/],
    [["--nope"], /nope/],
  ];
  for (const [argv, re] of bad) it(`rejects ${argv.join(" ")}`, () => assert.throws(() => parseBenchArgs(argv), (e) => e instanceof UsageError && re.test(e.message)));
});

describe("runBench", () => {
  const opts = { agents: [10, 50], policies: ["lock", "ryke"], durationS: 60, factor: 1, seed: 7, offset: 70, graceS: 20, caveats: ["a caveat"] };
  const fakeCell = (policy, agents, over = {}) => ({
    cell: { policy, agents, landed: agents, landedPerMinute: agents, p50: 5, p95: 9, aborts: {}, verifyRunsPerLanded: 1, wastedAgentSeconds: 0, trunkBreakages: 0, ...over.cell },
    detail: { ...detail(policy, agents), failedChecks: [], problems: [], checkedCommits: 4, ...over.detail },
  });
  const harness = async (over = {}) => {
    const stateDir = await mkdtemp(join(tmp, "run-state-"));
    const calls = [];
    const stack = { stateDir, closed: 0, close: async () => stack.closed++ };
    const lines = [];
    const run = async (o) => (calls.push(`${o.policy}x${o.agents}`), over.cell?.(o) ?? fakeCell(o.policy, o.agents));
    return { stateDir, calls, stack, lines, run, log: (l) => lines.push(l) };
  };

  it("runs the cells one after another, agent counts in the outer loop, and builds valid results", async () => {
    const h = await harness();
    const r = await runBench(opts, { stack: h.stack, run: h.run, log: h.log });
    assert.deepEqual(h.calls, ["lockx10", "rykex10", "lockx50", "rykex50"]);
    assert.ok(parseBench(JSON.parse(JSON.stringify(r.results))));
    assert.equal(r.results.durationSeconds, 60);
    assert.match(r.results.note, /Synthetic agents: real git, real merges, real tests, scripted edits/);
    assert.match(r.markdown, /a caveat/);
    assert.equal(h.stack.closed, 0, "a stack it was handed is not its to close");
    assert.equal(h.lines.filter((l) => l.startsWith("[")).length, 4, "progress per cell");
    const partial = JSON.parse(await readFile(join(h.stateDir, "bench-partial.json"), "utf8"));
    assert.equal(partial.cells.length, 4);
  });

  it("stops loudly at a cell with a broken trunk commit and names the commit and the failing test", async () => {
    const h = await harness({
      cell: (o) => fakeCell(o.policy, o.agents, o.policy === "ryke" && o.agents === 10 ? { cell: { trunkBreakages: 1 }, detail: { failedChecks: [{ sha: "abcdef1234567890", failing: ["pin-b1x1a.ts is written against the current value"], tail: "" }] } } : {}),
    });
    await assert.rejects(runBench(opts, { stack: h.stack, run: h.run, log: h.log }), (e) => /TRUNK BREAKAGE in ryke x 10: 1 commit/.test(e.message) && e.message.includes("abcdef12") && e.message.includes("pin-b1x1a.ts"));
    assert.deepEqual(h.calls, ["lockx10", "rykex10"], "no further cell runs after a breakage");
  });

  it("a Ledger that disagrees with the trunk is as fatal as a breakage", async () => {
    const h = await harness({ cell: (o) => fakeCell(o.policy, o.agents, { detail: { problems: ["the Ledger's head a differs from the trunk's b"] } }) });
    await assert.rejects(runBench(opts, { stack: h.stack, run: h.run, log: h.log }), /TRUNK BREAKAGE in lock x 10.*differs/s);
  });

  it("starts its own stack on the given offset and closes it afterwards, also when a cell throws", async () => {
    for (const fail of [false, true]) {
      const h = await harness({ cell: (o) => (fail ? Promise.reject(new Error("boom")) : fakeCell(o.policy, o.agents)) });
      const started = [];
      const start = async (offset) => (started.push(offset), h.stack);
      const done = runBench({ ...opts, agents: [3] }, { start, run: h.run, log: h.log });
      if (fail) await assert.rejects(done, /boom/);
      else await done;
      assert.deepEqual(started, [70]);
      assert.equal(h.stack.closed, 1);
    }
  });

  it("main prints usage and exits 0 for --help, 2 for a bad option", async () => {
    const log = console.log;
    const err = console.error;
    const out = [];
    console.log = (...a) => out.push(a.join(" "));
    console.error = (...a) => out.push(a.join(" "));
    try {
      assert.equal(await benchMain(["--help"]), 0);
      assert.equal(await benchMain(["--agents", "x"]), 2);
    } finally {
      console.log = log;
      console.error = err;
    }
    assert.ok(out.some((l) => l.includes("usage: bench.mjs")));
    assert.ok(out.some((l) => l.includes("--agents")));
  });

  it("the usage names both ablations, says what each switches off, and where a run with one is written", async () => {
    const log = console.log;
    const out = [];
    console.log = (...a) => out.push(a.join(" "));
    try {
      await benchMain(["--help"]);
    } finally {
      console.log = log;
    }
    const usage = out.join("\n");
    assert.match(usage, /ryke-nolease \(Ryke with write leases off/);
    assert.match(usage, /ryke-nopipe \(Ryke with speculative pipelining off/);
    assert.match(usage, /includes either ablation writes to bench\/results\/ablation by default/);
  });
});

// The bench starts its stack in the calling process and the stack reads these from the environment, so they are set
// there. e2e:contention runs the bench leg after the scripted swarms and puts back exactly BENCH_ENV_KEYS
// (harness/e2e/lib.mjs withEnvRestored); a variable set here that is not in the list would leak out of the leg.
describe("startBenchStack", () => {
  it("sets RYKE_JEV and RYKE_STATE_DIR before the stack reads them, and changes no other variable", async () => {
    const env = { PATH: "/bin", RYKE_JEV: "live", RYKE_TOKEN: "t", RYKE_PORT_OFFSET: "3" };
    const before = { ...env };
    const seen = [];
    const start = async (opts) => (seen.push({ opts, env: { ...env } }), { stub: true });
    assert.deepEqual(await startBenchStack(5, { start, env }), { stub: true });
    assert.deepEqual(seen.map((c) => c.opts), [{ offset: 5, fresh: true, quiet: true }]);
    assert.equal(seen[0].env.RYKE_JEV, "off");
    assert.equal(seen[0].env.RYKE_STATE_DIR, join(tmpdir(), "ryke-bench-state-5"));
    const changed = Object.keys({ ...before, ...env }).filter((k) => before[k] !== env[k]);
    assert.deepEqual(changed.sort(), [...BENCH_ENV_KEYS].sort());
  });

  it("names the variables it sets, once each", () => {
    assert.deepEqual([...BENCH_ENV_KEYS].sort(), ["RYKE_JEV", "RYKE_STATE_DIR"]);
  });

  it("puts the state dir outside the repo, one per offset", async () => {
    const dirs = [];
    for (const offset of [70, 71]) {
      const env = {};
      await startBenchStack(offset, { start: async () => ({}), env });
      dirs.push(env.RYKE_STATE_DIR);
    }
    assert.deepEqual(dirs, [join(tmpdir(), "ryke-bench-state-70"), join(tmpdir(), "ryke-bench-state-71")]);
    assert.ok(dirs.every((d) => !d.startsWith(ROOT)));
  });
});

// ---------------------------------------------------------------------------------------------
describe("how the Ryke agent reads answers", () => {
  const cases = [
    ["landed", { state: "landed" }, { landed: true }],
    ["stale read", { state: "stale", reason: "stale_read", paths: [{ path: "a" }] }, { landed: false, cause: "stale_read", retry: true, paths: [{ path: "a" }] }],
    ["text conflict", { state: "stale", reason: "text_conflict" }, { landed: false, cause: "text_conflict", retry: true, paths: [] }],
    ["failed tests", { state: "failed", reason: "tests" }, { landed: false, cause: "failed_verify", retry: true }],
    ["failed for another reason", { state: "failed", reason: "criterion_unmet" }, { landed: false, cause: "criterion_unmet", retry: true }],
    ["out of attempts after a stale read", { state: "aborted", reason: "max_attempts", paths: [{ path: "a" }] }, { landed: false, cause: "stale_read", retry: false, maxAttempts: true }],
    ["out of attempts after a conflict", { state: "aborted", reason: "max_attempts", detail: { conflicts: ["a"] } }, { landed: false, cause: "text_conflict", retry: false, maxAttempts: true }],
    ["out of attempts after failing tests", { state: "aborted", reason: "max_attempts", detail: { failures: [] } }, { landed: false, cause: "failed_verify", retry: false, maxAttempts: true }],
    ["aborted by someone", { state: "aborted", reason: "bench_end" }, { landed: false, cause: "aborted:bench_end", retry: false }],
    ["rejected", { state: "rejected", reason: "protected" }, { landed: false, cause: "rejected:protected", retry: false }],
    ["needs a human", { state: "needs_human" }, { landed: false, cause: "needs_human", retry: false }],
  ];
  for (const [name, input, want] of cases) it(`outcomeFromState: ${name}`, () => assert.deepEqual(outcomeFromState(input), want));

  it("outcomeFromState refuses a state a submitted change cannot be in", () => {
    assert.throws(() => outcomeFromState({ state: "open" }), /unexpected/);
  });

  it("inferCause prefers conflicts, then stale paths, then failures", () => {
    assert.equal(inferCause({ conflicts: ["a"], stale: [{}] }, []), "text_conflict");
    assert.equal(inferCause({ stale: [{}] }, []), "stale_read");
    assert.equal(inferCause({}, [{ path: "a" }]), "stale_read");
    assert.equal(inferCause({ failures: [{ name: "x" }] }, []), "failed_verify");
    assert.equal(inferCause({ failures: null }, []), "max_attempts");
    assert.equal(inferCause(undefined, undefined), "max_attempts");
  });

  const scripted = (...steps) => {
    const calls = [];
    return { calls, wait: async (id, s) => (calls.push([id, s]), steps.shift() ?? steps.at(-1)) };
  };
  const w = (state, reason = null, detail = {}) => ({ txn: { state, reason }, detail });

  it("waitWhileSettling polls while submitted, ready or verifying, then maps the final state", async () => {
    const api = scripted(w("ready"), w("verifying"), w("landed"));
    assert.deepEqual(await waitWhileSettling(api, "t1", { state: "submitted" }), { landed: true });
    assert.equal(api.calls.length, 3);
    assert.deepEqual(api.calls[0], ["t1", 20]);
  });

  it("waitWhileSettling does not poll when submit already answered", async () => {
    const api = scripted();
    assert.deepEqual(await waitWhileSettling(api, "t1", { state: "stale", reason: "stale_read", paths: [{ path: "p" }] }), { landed: false, cause: "stale_read", retry: true, paths: [{ path: "p" }] });
    assert.equal(api.calls.length, 0);
  });

  it("waitWhileSettling uses the detail of the last poll to name why an exhausted change failed", async () => {
    const api = scripted(w("verifying"), w("aborted", "max_attempts", { conflicts: ["src/format.ts"] }));
    assert.equal((await waitWhileSettling(api, "t1", { state: "ready" })).cause, "text_conflict");
  });

  it("waitWhileSettling gives up at the hard stop, even in the middle of a long poll", async () => {
    const ac = new AbortController();
    const api = { wait: () => new Promise(() => {}) };
    const pending = waitWhileSettling(api, "t1", { state: "ready" }, ac.signal);
    setTimeout(() => ac.abort(new Error("stop")), 10);
    assert.deepEqual(await pending, { abandoned: true });
    assert.deepEqual(await waitWhileSettling(api, "t1", { state: "ready" }, ac.signal), { abandoned: true });
  });
});

// ---------------------------------------------------------------------------------------------
describe("plumbing", () => {
  it("authRemote puts the token in the userinfo without its expiry", () => {
    assert.equal(authRemote("http://127.0.0.1:8788/git/ryke/a.git", "art_v1_abc?expires=99"), "http://x:art_v1_abc@127.0.0.1:8788/git/ryke/a.git");
  });

  it("sleep waits, and rejects at once on an aborted signal", async () => {
    const t = Date.now();
    await sleep(30);
    assert.ok(Date.now() - t >= 25);
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort(new Error("stop"));
    await assert.rejects(p, /stop/);
    await assert.rejects(sleep(5, ac.signal), /stop/);
  });

  it("Mutex: one holder at a time, in arrival order", async () => {
    const m = new Mutex();
    const order = [];
    let inside = 0;
    let max = 0;
    const worker = async (n, ms) => {
      const release = await m.acquire();
      inside++;
      max = Math.max(max, inside);
      order.push(n);
      await sleep(ms);
      inside--;
      release();
    };
    await Promise.all([worker(1, 20), worker(2, 5), worker(3, 5), worker(4, 1)]);
    assert.deepEqual(order, [1, 2, 3, 4]);
    assert.equal(max, 1);
    assert.equal(m.waiting, 0);
    // Free again afterwards.
    (await m.acquire())();
  });

  it("Mutex: a cancelled waiter leaves the line without blocking the others", async () => {
    const m = new Mutex();
    const first = await m.acquire();
    const ac = new AbortController();
    const cancelled = m.acquire(ac.signal);
    const patient = m.acquire();
    assert.equal(m.waiting, 2);
    ac.abort(new Error("stop"));
    await assert.rejects(cancelled, /stop/);
    assert.equal(m.waiting, 1);
    first();
    (await patient)();
    assert.equal(m.waiting, 0);
    await assert.rejects(m.acquire(ac.signal), /stop/);
  });

  it("FifoQueue: one item at a time in arrival order, answers go to the right caller, errors do not stop the line", async () => {
    let inside = 0;
    let max = 0;
    const seen = [];
    const q = new FifoQueue(async (n) => {
      inside++;
      max = Math.max(max, inside);
      seen.push(n);
      await sleep(5);
      inside--;
      if (n === 2) throw new Error("bad item");
      return n * 10;
    });
    const results = await Promise.allSettled([1, 2, 3, 4].map((n) => q.enqueue(n)));
    assert.deepEqual(seen, [1, 2, 3, 4]);
    assert.equal(max, 1);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    assert.deepEqual(results.filter((r) => r.status === "fulfilled").map((r) => r.value), [10, 30, 40]);
    assert.equal(q.length, 0);
  });

  const pickCases = [
    ["nothing", [], 10, []],
    ["one commit is the head", ["a"], 10, ["a"]],
    ["few commits: all of them", ["a", "b", "c"], 10, ["a", "b", "c"]],
    ["exactly ten before the head", Array.from({ length: 11 }, (_, i) => `c${i}`), 10, Array.from({ length: 11 }, (_, i) => `c${i}`)],
    ["many: ten evenly spaced plus the head", Array.from({ length: 101 }, (_, i) => `c${i}`), 10, ["c0", "c10", "c20", "c30", "c40", "c50", "c60", "c70", "c80", "c90", "c100"]],
    ["a smaller budget", Array.from({ length: 41 }, (_, i) => `c${i}`), 3, ["c0", "c13", "c26", "c40"]],
  ];
  for (const [name, commits, k, want] of pickCases) it(`pickCommits: ${name}`, () => assert.deepEqual(pickCommits(commits, k), want));

  const fakeFetch = (script) => {
    const calls = [];
    const f = async (url, init = {}) => {
      calls.push([init.method ?? "GET", url.replace(/^http:\/\/[^/]+/, "")]);
      const r = script(url, init, calls);
      return { ok: r.status === undefined || r.status < 400, status: r.status ?? 200, text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)) };
    };
    f.calls = calls;
    return f;
  };

  it("controlPlane.job posts the job and polls until it is done", async () => {
    let polls = 0;
    const fetchImpl = fakeFetch((url) => (url.endsWith("/v1/jobs") ? { body: { id: "j1" } } : { body: { state: ++polls < 3 ? "running" : "done", exitCode: 0, result: { ok: true } } }));
    const ctl = controlPlane({ storeUrl: "http://s", runnerUrl: "http://r", fetchImpl, pollMs: 1 });
    const job = await ctl.job("verify", { remote: "x" });
    assert.deepEqual(job.result, { ok: true });
    assert.equal(polls, 3);
    assert.deepEqual(fetchImpl.calls[0], ["POST", "/v1/jobs"]);
  });

  it("controlPlane.job returns a failed job, times out a stuck one, and surfaces HTTP errors", async () => {
    const failing = controlPlane({ storeUrl: "http://s", runnerUrl: "http://r", pollMs: 1, fetchImpl: fakeFetch((url) => (url.endsWith("/v1/jobs") ? { body: { id: "j" } } : { body: { state: "failed", exitCode: 1 } })) });
    assert.equal((await failing.job("land", {})).state, "failed");
    const stuck = controlPlane({ storeUrl: "http://s", runnerUrl: "http://r", pollMs: 1, fetchImpl: fakeFetch((url) => (url.endsWith("/v1/jobs") ? { body: { id: "j" } } : { body: { state: "running" } })) });
    await assert.rejects(stuck.job("land", {}, { timeoutMs: 20 }), /still running/);
    const down = controlPlane({ storeUrl: "http://s", runnerUrl: "http://r", fetchImpl: fakeFetch(() => ({ status: 503, body: { error: "down" } })) });
    await assert.rejects(down.job("land", {}), /503/);
    await assert.rejects(down.info("x"), /503/);
  });

  it("controlPlane talks to the store's documented routes, with the internal secret on store calls only", async () => {
    const headers = [];
    const fetchImpl = fakeFetch((url, init) => (headers.push([url.slice(0, 8), init.headers?.["x-ryke-internal"]]), { body: url.includes("/tokens") ? { token: "art_v1_z?expires=1" } : url.includes("/file") ? { content: "hello" } : url.includes("/jobs/") ? { state: "done", exitCode: 0 } : url.endsWith("/jobs") ? { id: "j" } : { ok: 1 } }));
    const ctl = controlPlane({ storeUrl: "http://s", runnerUrl: "http://r", secret: "s3cret", fetchImpl });
    await ctl.info("r");
    await ctl.fork("r", "r--t_1");
    assert.equal(await ctl.token("r", "read"), "art_v1_z?expires=1");
    assert.equal(await ctl.file("r", "main", "a b.ts"), "hello");
    await ctl.remove("r");
    await ctl.job("verify", {});
    assert.deepEqual(headers, [["http://s", "s3cret"], ["http://s", "s3cret"], ["http://s", "s3cret"], ["http://s", "s3cret"], ["http://s", "s3cret"], ["http://r", undefined], ["http://r", undefined]]);
    assert.deepEqual(fetchImpl.calls.slice(0, 5).map((c) => c.join(" ")), ["GET /v1/repos/r", "POST /v1/repos/r/fork", "POST /v1/repos/r/tokens", "GET /v1/repos/r/file?ref=main&path=a+b.ts", "DELETE /v1/repos/r"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("landOne: prepare, verify, push", () => {
  const policy = { union: ["src/registry.ts"], verify: "node --test", verifyTimeoutSeconds: 90 };
  const t = { id: "t_1", agent: "agent-1", model: "m", intent: "do it", attempt: 2, snapshot: "s".repeat(40), head: "h".repeat(40), fork: { remote: "http://127.0.0.1:1/git/ryke/r--t_1.git", token: "ft?expires=1" } };

  function fakeCtl(answers) {
    const jobs = [];
    return {
      jobs,
      info: async () => ({ remote: "http://127.0.0.1:1/git/ryke/r.git", head: "b".repeat(40) }),
      token: async () => "tt?expires=1",
      job: async (kind, args) => {
        jobs.push({ kind, args });
        const a = answers[jobs.length - 1];
        return a === undefined ? { state: "done", exitCode: 0, result: { ok: true } } : { state: "done", exitCode: a.exit ?? 0, result: a.result };
      },
    };
  }
  const prepared = { ok: true, candidate: "c".repeat(40), applied: [{ txn: "t_1" }], conflicts: [] };
  const verified = (pass, failures = []) => ({ ok: true, pass, durationMs: 1500, tests: { failures } });
  const land = async (answers) => {
    const ctl = fakeCtl(answers);
    const stats = { verifyMs: [] };
    return { ctl, stats, result: await landOne(ctl, { trunk: "r", policy, t, stats }) };
  };

  it("a clean change is prepared against the trunk head, verified and pushed", async () => {
    const { ctl, stats, result } = await land([{ result: prepared }, { result: verified(true) }, { result: { ok: true, pushed: true } }]);
    assert.deepEqual(result, { landed: true, verified: true, sha: prepared.candidate });
    assert.deepEqual(ctl.jobs.map((j) => `${j.kind}:${j.args.mode ?? ""}`), ["land:prepare", "verify:", "land:push"]);
    const [prep, ver, push] = ctl.jobs.map((j) => j.args);
    assert.equal(prep.base, "b".repeat(40));
    assert.equal(prep.ref, "refs/ryke/candidates/t_1/2");
    assert.equal(prep.trunk, "http://x:tt@127.0.0.1:1/git/ryke/r.git");
    assert.deepEqual(JSON.parse(prep.union), ["src/registry.ts"]);
    const sent = JSON.parse(prep.txns);
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].id, sent[0].snapshot, sent[0].head, sent[0].fork], ["t_1", t.snapshot, t.head, "http://x:ft@127.0.0.1:1/git/ryke/r--t_1.git"]);
    assert.deepEqual([ver.ref, ver.command, ver.timeout], [prepared.candidate, "node --test", "90"]);
    assert.deepEqual([push.candidate, JSON.parse(push.cleanup)], [prepared.candidate, ["refs/ryke/candidates/t_1/2"]]);
    assert.deepEqual(stats.verifyMs, [1500]);
  });

  const failures = [
    ["a text conflict stops before verify", [{ result: { ok: true, candidate: "b", applied: [], conflicts: [{ txn: "t_1", paths: ["src/format.ts"] }] } }], { landed: false, cause: "text_conflict", verified: false, paths: ["src/format.ts"], error: undefined }, ["land"]],
    ["failing tests stop before the push", [{ result: prepared }, { result: verified(false, [{ name: "boom" }]) }], { landed: false, cause: "failed_verify", verified: true, failures: ["boom"] }, ["land", "verify"]],
    ["a push the store rejects is retried as a conflict", [{ result: prepared }, { result: verified(true) }, { result: { ok: true, pushed: false } }], { landed: false, cause: "text_conflict", verified: true, paths: [], error: "push rejected" }, ["land", "verify", "land"]],
  ];
  for (const [name, answers, want, kinds] of failures) {
    it(name, async () => {
      const { ctl, result } = await land(answers);
      assert.deepEqual(result, want);
      assert.deepEqual(ctl.jobs.map((j) => j.kind), kinds);
    });
  }

  it("a job that breaks is an error, not an outcome", async () => {
    await assert.rejects(land([{ exit: 1, result: { ok: false, error: "git exploded" } }]), /prepare job failed.*git exploded/);
    await assert.rejects(land([{ result: prepared }, { exit: 1, result: undefined }]), /verify job failed.*no result/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the policies against fakes", () => {
  const live = () => ({ flag: false, signal: new AbortController().signal });
  const clockOf = (state = live()) => ({ expired: () => state.flag, signal: state.signal, state });
  const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
  const settled = (p) => Promise.race([p.then(() => true), tick().then(() => false)]);

  function fakeCtl() {
    const created = [];
    return {
      created,
      fork: async (_s, name) => created.push(name),
      info: async (name) => ({ remote: `http://127.0.0.1:1/git/ryke/${name}.git`, head: "a".repeat(40) }),
      token: async () => "tok?expires=1",
      job: async (kind, args) => ({ state: "done", exitCode: 0, result: kind === "verify" ? { ok: true, pass: true, durationMs: 1, tests: {} } : args.mode === "prepare" ? { ok: true, candidate: "c".repeat(40), applied: [{}], conflicts: [] } : { ok: true, pushed: true } }),
    };
  }
  const policy = { union: [], verify: "true", verifyTimeoutSeconds: 5 };

  it("lock: the second agent waits for the first to close; an expired cell hands out nothing", async () => {
    const clock = clockOf();
    const p = lockPolicy({ ctl: fakeCtl(), trunk: "r", policy, clock, stats: { verifyMs: [] } });
    const a = await p.open("agent-1", { intent: "x" });
    assert.match(a.id, /^t_/);
    assert.equal(a.source.ref, "main");
    assert.equal(a.attempt, 1);
    const pending = p.open("agent-2", { intent: "y" });
    assert.equal(await settled(pending), false);
    await p.close(a);
    const b = await pending;
    assert.equal(b.agent, "agent-2");
    const late = p.open("agent-3", { intent: "z" });
    clock.state.flag = true;
    await p.close(b);
    assert.equal(await late, null);
    assert.equal(await p.open("agent-4", { intent: "w" }), null);
  });

  it("lock: closing twice does not free the lock for two agents", async () => {
    const p = lockPolicy({ ctl: fakeCtl(), trunk: "r", policy, clock: clockOf(), stats: { verifyMs: [] } });
    const a = await p.open("a", { intent: "x" });
    await p.close(a);
    await p.close(a);
    const b = await p.open("b", { intent: "y" });
    assert.equal(await settled(p.open("c", { intent: "z" })), false);
    await p.close(b);
  });

  it("lock: a failed fork releases the lock", async () => {
    const ctl = fakeCtl();
    ctl.fork = async () => {
      throw new Error("no fork");
    };
    const p = lockPolicy({ ctl, trunk: "r", policy, clock: clockOf(), stats: { verifyMs: [] } });
    await assert.rejects(p.open("a", { intent: "x" }), /no fork/);
    ctl.fork = async () => {};
    assert.ok(await p.open("b", { intent: "y" }));
  });

  it("lock and queue: no read tracking, a plain sleep for think time, and a retry starts from the trunk", async () => {
    for (const make of [lockPolicy, queuePolicy]) {
      const p = make({ ctl: fakeCtl(), trunk: "r", policy, clock: clockOf(), stats: { verifyMs: [] } });
      const s = await p.open("a", { intent: "x" });
      assert.deepEqual(await p.report(s, ["a"]), { warned: false });
      const t0 = Date.now();
      assert.deepEqual(await p.think(s, 30), { early: false, spentMs: 30 });
      assert.ok(Date.now() - t0 >= 25);
      await p.retry(s);
      assert.equal(s.attempt, 2);
      assert.equal(s.source.remote, "http://127.0.0.1:1/git/ryke/r.git");
      assert.equal(s.source.ref, "main");
      await p.close(s);
    }
  });

  it("queue: opens without waiting and lands submissions one after another", async () => {
    const ctl = fakeCtl();
    const order = [];
    let inside = 0;
    let max = 0;
    const job = ctl.job;
    ctl.job = async (kind, args, o) => {
      if (kind === "verify") {
        inside++;
        max = Math.max(max, inside);
        order.push(args.ref);
        await sleep(15);
        inside--;
      }
      return job(kind, args, o);
    };
    const p = queuePolicy({ ctl, trunk: "r", policy, clock: clockOf(), stats: { verifyMs: [] } });
    const sessions = await Promise.all([1, 2, 3].map((n) => p.open(`a${n}`, { intent: "x" })));
    const results = await Promise.all(sessions.map((s, i) => p.submit(s, String(i).repeat(40))));
    assert.ok(results.every((r) => r.landed && r.verified));
    assert.equal(order.length, 3);
    assert.equal(max, 1);
  });

  it("queue: at the hard stop waiting agents are released and the rest of the line is dropped", async () => {
    const ctl = fakeCtl();
    const ac = new AbortController();
    const clock = { expired: () => false, signal: ac.signal };
    let started = 0;
    const job = ctl.job;
    ctl.job = async (kind, args, o) => {
      started++;
      await sleep(40);
      // The real control plane stops polling once the signal fires.
      if (o?.signal?.aborted) throw o.signal.reason;
      return job(kind, args, o);
    };
    const p = queuePolicy({ ctl, trunk: "r", policy, clock, stats: { verifyMs: [] } });
    const [a, b, c] = await Promise.all([1, 2, 3].map((n) => p.open(`a${n}`, { intent: "x" })));
    const results = Promise.all([a, b, c].map((s) => p.submit(s, "d".repeat(40), ac.signal)));
    await tick(20);
    ac.abort(new Error("stop"));
    assert.ok((await results).every((r) => r.abandoned));
    await tick(200);
    // Only the first item's prepare job was ever started.
    assert.equal(started, 1);
  });

  function fakeApi(over = {}) {
    const calls = [];
    const rec = (name, fn) => async (...a) => (calls.push([name, ...a]), fn(...a));
    return {
      calls,
      begin: rec("begin", async () => ({ txn: "t_9", state: "open", snapshot: "s".repeat(40), remote: "http://f", token: "ft" })),
      reads: rec("reads", async () => ({ staleWarnings: [] })),
      wait: rec("wait", async () => (await sleep(5), { txn: { state: "open" }, staleWarnings: [] })),
      submit: rec("submit", async () => ({ state: "ready" })),
      retry: rec("retry", async () => ({ attempt: 2, snapshot: "n".repeat(40), trunk: { remote: "http://t", token: "tt" }, remote: "http://f2", token: "ft2" })),
      abort: rec("abort", async () => ({ state: "aborted" })),
      intendWrite: rec("intendWrite", async () => ({ go: true })),
      call: rec("call", async () => ({ snapshot: "r".repeat(40), attempt: 1, delta: [], trunk: { remote: "http://trunk", token: "trt" } })),
      ...over,
    };
  }

  it("ryke: begin makes a session from the fork, a rejection is an error, an expired cell begins nothing", async () => {
    const api = fakeApi();
    const stats = {};
    const p = rykePolicy({ api, repo: "r", clock: clockOf(), stats });
    const s = await p.open("agent-1", { intent: "i" });
    assert.deepEqual([s.id, s.attempt, s.source, s.sink, s.forkName], ["t_9", 1, { remote: "http://f", token: "ft", ref: "main" }, { remote: "http://f", token: "ft" }, "r--t_9"]);
    assert.deepEqual(api.calls[0].slice(0, 2), ["begin", "r"]);
    assert.equal(api.calls[0][2].agent, "agent-1");
    const rejected = rykePolicy({ api: fakeApi({ begin: async () => ({ txn: "t_x", state: "rejected", reason: "duplicate_of:t_1" }) }), repo: "r", clock: clockOf(), stats });
    await assert.rejects(rejected.open("a", { intent: "i" }), (e) => e instanceof Rejected && e.reason === "duplicate_of:t_1");
    await assert.rejects(rykePolicy({ api: fakeApi({ begin: async () => ({ error: "nope" }) }), repo: "r", clock: clockOf(), stats }).open("a", { intent: "i" }), /begin failed/);
    const state = live();
    state.flag = true;
    assert.equal(await rykePolicy({ api, repo: "r", clock: clockOf(state), stats }).open("a", { intent: "i" }), null);
  });

  it("ryke: report passes the reads on and says whether trunk already moved", async () => {
    for (const [warnings, want] of [[[], false], [[{ path: "src/format.ts" }], true]]) {
      const api = fakeApi({ reads: async () => ({ staleWarnings: warnings }) });
      assert.deepEqual(await rykePolicy({ api, repo: "r", clock: clockOf(), stats: {} }).report({ id: "t_9" }, ["a"]), { warned: want });
    }
  });

  it("ryke: the whole think time is spent in the long-poll when nothing moves", async () => {
    const api = fakeApi();
    const t0 = Date.now();
    assert.deepEqual(await rykePolicy({ api, repo: "r", clock: clockOf(), stats: {} }).think({ id: "t_9" }, 60), { early: false, spentMs: 60 });
    assert.ok(Date.now() - t0 >= 55);
    assert.ok(api.calls.filter((c) => c[0] === "wait").length >= 2);
    assert.ok(api.calls.every((c) => c[0] !== "wait" || c[2] <= 0.06));
  });

  it("ryke: a stale warning ends the think early and says how long it lasted", async () => {
    let n = 0;
    const api = fakeApi({ wait: async () => (await sleep(5), { txn: { state: "open" }, staleWarnings: ++n >= 2 ? [{ path: "src/format.ts" }] : [] }) });
    const t0 = Date.now();
    const r = await rykePolicy({ api, repo: "r", clock: clockOf(), stats: {} }).think({ id: "t_9" }, 5000);
    assert.equal(r.early, true);
    assert.ok(r.spentMs >= 8 && r.spentMs < 1000, `${r.spentMs}`);
    assert.ok(Date.now() - t0 < 1000);
  });

  it("ryke: think stops when the transaction is no longer open, and at the hard stop", async () => {
    const closed = fakeApi({ wait: async () => ({ txn: { state: "aborted" }, staleWarnings: [] }) });
    assert.equal((await rykePolicy({ api: closed, repo: "r", clock: clockOf(), stats: {} }).think({ id: "t_9" }, 5000)).early, false);
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    await assert.rejects(rykePolicy({ api: fakeApi(), repo: "r", clock: clockOf({ flag: false, signal: ac.signal }), stats: {} }).think({ id: "t_9" }, 5000, ac.signal), /stop/);
  });

  it("ryke: admit takes a lease on every path and reports that it did not have to wait", async () => {
    const api = fakeApi();
    const stats = { leaseWaits: 0, leaseWaitMs: 0, leaseGaveUp: 0 };
    assert.deepEqual(await rykePolicy({ api, repo: "r", clock: clockOf(), stats }).admit({ id: "t_9" }, ["src/format.ts", "src/units/b1x1a.ts"]), { waited: false });
    assert.deepEqual(api.calls.filter((c) => c[0] === "intendWrite").map((c) => c.slice(1)), [["t_9", "src/format.ts"], ["t_9", "src/units/b1x1a.ts"]]);
    assert.deepEqual(stats, { leaseWaits: 0, leaseWaitMs: 0, leaseGaveUp: 0 });
  });

  it("ryke: admit waits while a hot path is held, then goes, and counts the wait", async () => {
    let n = 0;
    const api = fakeApi({ intendWrite: async (_t, path) => (path === "src/format.ts" && ++n <= 2 ? { go: false, owner: "t_1", retryAfterMs: 20 } : { go: true }) });
    const stats = { leaseWaits: 0, leaseWaitMs: 0, leaseGaveUp: 0 };
    const t0 = Date.now();
    assert.deepEqual(await rykePolicy({ api, repo: "r", clock: clockOf(), stats }).admit({ id: "t_9" }, ["src/format.ts", "src/ui/layout.ts"]), { waited: true });
    assert.ok(Date.now() - t0 >= 40, "it waited out two retry intervals");
    assert.equal(stats.leaseWaits, 1);
    assert.ok(stats.leaseWaitMs >= 40);
    assert.equal(stats.leaseGaveUp, 0);
  });

  it("ryke: admit gives up after 90 s and writes anyway, counting that too", async () => {
    let clockMs = 0;
    const api = fakeApi({ intendWrite: async () => ((clockMs += 60_000), { go: false, owner: "t_1", retryAfterMs: 1 }) });
    const stats = { leaseWaits: 0, leaseWaitMs: 0, leaseGaveUp: 0 };
    const p = rykePolicy({ api, repo: "r", clock: clockOf(), stats, now: () => clockMs });
    assert.deepEqual(await p.admit({ id: "t_9" }, ["src/format.ts"]), { waited: true });
    assert.equal(stats.leaseGaveUp, 1);
  });

  it("ryke: a hard stop interrupts a lease wait", async () => {
    const ac = new AbortController();
    const api = fakeApi({ intendWrite: async () => ({ go: false, owner: "t_1", retryAfterMs: 60_000 }) });
    const pending = rykePolicy({ api, repo: "r", clock: clockOf(), stats: { leaseWaits: 0, leaseWaitMs: 0 } }).admit({ id: "t_9" }, ["src/format.ts"], ac.signal);
    setTimeout(() => ac.abort(new Error("stop")), 20);
    await assert.rejects(pending, /stop/);
  });

  it("ryke: refresh posts to the refresh route and moves the session onto the returned trunk snapshot", async () => {
    const api = fakeApi();
    const stats = { refreshes: 0 };
    const s = { id: "t_9", attempt: 1, snapshot: "old", source: { ref: "main" } };
    const r = await rykePolicy({ api, repo: "r", clock: clockOf(), stats }).refresh(s);
    assert.deepEqual(api.calls.find((c) => c[0] === "call").slice(1), ["POST", "/api/txns/t_9/refresh", {}]);
    assert.equal(r.snapshot, "r".repeat(40));
    assert.deepEqual([s.snapshot, s.source, s.attempt, stats.refreshes], ["r".repeat(40), { remote: "http://trunk", token: "trt", ref: "r".repeat(40) }, 1, 1]);
  });

  describe("ryke-nolease", () => {
    const make = (extra = {}) => ({ api: fakeApi(extra), repo: "r", clock: clockOf(), stats: { refreshes: 0, leaseWaits: 0, leaseWaitMs: 0, leaseGaveUp: 0 } });

    it("is Ryke with the lease tool taken away and nothing else", () => {
      const ryke = rykePolicy(make());
      const nolease = rykeNoLeasePolicy(make());
      assert.equal(typeof ryke.admit, "function");
      assert.equal(nolease.admit, undefined);
      assert.equal("admit" in nolease, false);
      assert.deepEqual(Object.keys(nolease).sort(), Object.keys(ryke).filter((k) => k !== "admit").sort());
      assert.deepEqual([ryke.name, nolease.name], ["ryke", "ryke-nolease"]);
      for (const k of ["open", "report", "think", "submit", "retry", "refresh", "close"]) assert.equal(typeof nolease[k], "function", k);
    });

    // Refresh on a warning is the part the two share, so it must behave the same.
    for (const [name, build] of [["ryke", rykePolicy], ["ryke-nolease", rykeNoLeasePolicy], ["ryke-nopipe", rykeNoPipePolicy]]) {
      it(`${name}: refresh and think behave identically`, async () => {
        const args = make();
        const p = build(args);
        const s = { id: "t_9", attempt: 1, snapshot: "old", source: { ref: "main" } };
        await p.refresh(s);
        assert.deepEqual(args.api.calls.find((c) => c[0] === "call").slice(1), ["POST", "/api/txns/t_9/refresh", {}]);
        assert.equal(args.stats.refreshes, 1);
        assert.deepEqual(await p.think(s, 20), { early: false, spentMs: 20 });
        const [kind] = (await p.open("a", { intent: "i" })).id.split("_");
        assert.equal(kind, "t");
      });
    }
  });

  describe("ryke-nopipe", () => {
    const make = (extra = {}) => ({ api: fakeApi(extra), repo: "r", clock: clockOf(), stats: { refreshes: 0, leaseWaits: 0, leaseWaitMs: 0, leaseGaveUp: 0 } });

    // The switch lives in the repo's ryke.json (see SEED_POLICY), not in the agents: they are Ryke's, leases included.
    it("is Ryke's agents under another name, with every tool including the lease one", () => {
      const ryke = rykePolicy(make());
      const nopipe = rykeNoPipePolicy(make());
      assert.deepEqual([ryke.name, nopipe.name], ["ryke", "ryke-nopipe"]);
      assert.deepEqual(Object.keys(nopipe).sort(), Object.keys(ryke).sort());
      assert.equal(typeof nopipe.admit, "function");
      for (const k of Object.keys(ryke)) assert.equal(typeof nopipe[k], typeof ryke[k], k);
    });

    it("takes write leases like ryke does: a held file makes it wait", async () => {
      let held = 1;
      const args = make({ intendWrite: async () => (held-- > 0 ? { go: false, owner: "t_1", retryAfterMs: 5 } : { go: true }) });
      const r = await rykeNoPipePolicy(args).admit({ id: "t_9" }, ["src/format.ts"]);
      assert.deepEqual(r, { waited: true });
      assert.equal(args.stats.leaseWaits, 1);
    });
  });

  it("lock and queue have neither leases nor refresh", () => {
    for (const make of [lockPolicy, queuePolicy]) {
      const p = make({ ctl: fakeCtl(), trunk: "r", policy, clock: clockOf(), stats: { verifyMs: [] } });
      assert.equal(p.admit, undefined);
      assert.equal(p.refresh, undefined);
    }
  });

  it("ryke: submit hands in the head and waits for the lander; retry moves the session to the new snapshot", async () => {
    let n = 0;
    const api = fakeApi({ wait: async () => ({ txn: { state: ++n < 2 ? "verifying" : "stale", reason: "stale_read" }, detail: {} }) });
    const p = rykePolicy({ api, repo: "r", clock: clockOf(), stats: {} });
    const s = { id: "t_9", attempt: 1 };
    assert.deepEqual(await p.submit(s, "h".repeat(40)), { landed: false, cause: "stale_read", retry: true, paths: [] });
    assert.deepEqual(api.calls.find((c) => c[0] === "submit").slice(1), ["t_9", { head: "h".repeat(40) }]);
    await p.retry(s);
    assert.deepEqual([s.attempt, s.snapshot, s.source, s.sink], [2, "n".repeat(40), { remote: "http://t", token: "tt", ref: "n".repeat(40) }, { remote: "http://f2", token: "ft2" }]);
  });

  it("ryke: close aborts an unfinished transaction and leaves a finished one alone", async () => {
    const api = fakeApi();
    const p = rykePolicy({ api, repo: "r", clock: clockOf(), stats: {} });
    await p.close({ id: "t_1", finished: true });
    assert.equal(api.calls.filter((c) => c[0] === "abort").length, 0);
    await p.close({ id: "t_2" });
    assert.deepEqual(api.calls.find((c) => c[0] === "abort").slice(1), ["t_2", "bench_end"]);
    const refusing = rykePolicy({ api: fakeApi({ abort: async () => Promise.reject(new Error("409 verifying")) }), repo: "r", clock: clockOf(), stats: {} });
    await refusing.close({ id: "t_3" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("the synthetic agent against a local git remote", () => {
  let remote;
  let seedSha;
  before(async () => {
    const seed = join(tmp, "agent-seed");
    await seedTree(seed);
    await writeFile(join(seed, "src/format.ts"), `${await readFile(join(seed, "src/format.ts"), "utf8")}\nexport const BENCH_FORMAT = 1;\n`);
    await writeFile(join(seed, "src/ui/layout.ts"), `${await readFile(join(seed, "src/ui/layout.ts"), "utf8")}\nexport const BENCH_LAYOUT = 1;\n`);
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    for (const argv of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "seed"]]) await run("git", argv, { cwd: seed, env });
    remote = join(tmp, "agent-remote.git");
    await run("git", ["clone", "-q", "--bare", seed, remote]);
    seedSha = (await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim();
  });
  // Each test starts from the seed: agents force-push, and the refresh script moves the remote on.
  beforeEach(async () => {
    await run("git", ["--git-dir", remote, "update-ref", "refs/heads/main", seedSha]);
  });

  const recorderOf = () => {
    const d = { plans: [], attempts: [], txns: [], errors: [], opened: [] };
    return { plan: (p) => d.plans.push(p), attempt: (a) => d.attempts.push(a), txn: (t) => d.txns.push(t), error: (m) => d.errors.push(m), opened: (id) => d.opened.push(id), d };
  };

  // A policy that answers from a script; the agent does real git against `remote`.
  function scripted(answers, { retryable = true } = {}) {
    const log = [];
    return {
      log,
      async open(agent, { intent }) {
        log.push("open");
        return { id: `t_${log.length}`, attempt: 1, snapshot: "", source: { remote, token: "x", ref: "main" }, sink: { remote, token: "x" }, agent, model: "m", intent };
      },
      report: async (_s, paths) => (log.push(`report ${paths.length}`), { warned: false }),
      think: async (_s, ms) => (log.push("think"), { early: false, spentMs: ms }),
      submit: async (s) => (log.push(`submit ${s.attempt}`), answers.shift() ?? { landed: true }),
      retry: async (s) => {
        log.push("retry");
        s.attempt++;
      },
      close: async () => log.push("close"),
      retryable,
    };
  }

  const clock = (rec, stopAfter = 1) => {
    const ac = new AbortController();
    const started = performance.now();
    return { elapsedMs: () => performance.now() - started, expired: () => rec.d.txns.length >= stopAfter, signal: ac.signal, ac };
  };
  const ctx = (rec, policy, clk) => ({ index: 1, name: "bench-001", policy, rec, clock: clk, seed: 7, factor: 0.001, root: tmp });

  it("a change that lands first time: one plan, one attempt, one landed transaction", async () => {
    const rec = recorderOf();
    const policy = scripted([{ landed: true, verified: true }]);
    await runAgent(ctx(rec, policy, clock(rec)));
    assert.deepEqual(policy.log.map((l) => l.split(" ")[0]), ["open", "report", "think", "submit", "close"]);
    assert.equal(rec.d.plans.length, 1);
    assert.deepEqual(rec.d.attempts.map((a) => a.outcome), ["landed"]);
    assert.equal(rec.d.attempts[0].verified, true);
    assert.equal(rec.d.txns[0].status, "landed");
    assert.ok(rec.d.txns[0].endMs >= rec.d.txns[0].startMs);
    assert.equal(rec.d.opened.length, 1);
    assert.ok(rec.d.plans[0].reads.length >= 3);
  });

  it("a retry keeps the plan, thinks again and lands the second time", async () => {
    const rec = recorderOf();
    const policy = scripted([{ landed: false, cause: "stale_read", retry: true, paths: ["src/format.ts"] }, { landed: true }]);
    await runAgent(ctx(rec, policy, clock(rec)));
    assert.deepEqual(policy.log.map((l) => l.split(" ")[0]), ["open", "report", "think", "submit", "retry", "report", "think", "submit", "close"]);
    assert.equal(rec.d.plans.length, 1, "the footprint is chosen once per change");
    assert.deepEqual(rec.d.attempts.map((a) => [a.attempt, a.outcome]), [[1, "stale_read"], [2, "landed"]]);
    assert.deepEqual(rec.d.attempts[0].paths, ["src/format.ts"]);
    assert.equal(rec.d.txns[0].status, "landed");
  });

  it("three failed attempts end the change as max_attempts, with no fourth try", async () => {
    const rec = recorderOf();
    const fail = { landed: false, cause: "failed_verify", retry: true };
    const policy = scripted([fail, fail, fail, { landed: true }]);
    await runAgent(ctx(rec, policy, clock(rec)));
    assert.equal(policy.log.filter((l) => l.startsWith("submit")).length, 3);
    assert.deepEqual(rec.d.attempts.map((a) => a.outcome), ["failed_verify", "failed_verify", "failed_verify"]);
    assert.deepEqual([rec.d.txns[0].status, rec.d.txns[0].cause], ["aborted", "max_attempts"]);
  });

  it("an answer that ends the change (Ryke gave up, or rejected it) is recorded with its own cause", async () => {
    const rec = recorderOf();
    await runAgent(ctx(rec, scripted([{ landed: false, cause: "rejected:duplicate_of:t_1", retry: false }]), clock(rec)));
    assert.deepEqual([rec.d.txns[0].status, rec.d.txns[0].cause], ["aborted", "rejected:duplicate_of:t_1"]);
    const rec2 = recorderOf();
    await runAgent(ctx(rec2, scripted([{ landed: false, cause: "stale_read", retry: false, maxAttempts: true }]), clock(rec2)));
    assert.deepEqual([rec2.d.txns[0].status, rec2.d.txns[0].cause], ["aborted", "max_attempts"]);
  });

  // The two contention tools of Ryke, scripted. `refresh` really moves the remote on, so the agent has
  // to fetch the new snapshot for its commit to sit on it.
  function withTools(policy, { warnings = [], waits = [], early = [] } = {}) {
    const state = { admitted: [], refreshedTo: [], pushes: 0 };
    policy.report = async (_s, paths) => (policy.log.push(`report ${paths.length}`), { warned: warnings.shift() ?? false });
    policy.admit = async (_s, paths) => {
      policy.log.push("admit");
      state.admitted.push(paths);
      const waited = waits.shift() ?? false;
      if (waited) await sleep(30);
      return { waited };
    };
    policy.refresh = async (s) => {
      policy.log.push("refresh");
      const dir = await mkdtemp(join(tmp, "advance-"));
      const git = (...argv) => run("git", argv, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "o", GIT_AUTHOR_EMAIL: "o@o", GIT_COMMITTER_NAME: "o", GIT_COMMITTER_EMAIL: "o@o" } });
      await git("init", "-q", "-b", "main");
      await git("fetch", "-q", remote, "main");
      await git("checkout", "-q", "FETCH_HEAD");
      await writeFile(join(dir, `NEWS-${state.refreshedTo.length}.txt`), "someone else landed\n");
      await git("add", "-A");
      await git("commit", "-q", "-m", "news");
      const sha = (await git("rev-parse", "HEAD")).stdout.trim();
      await git("push", "-q", "-f", remote, `${sha}:refs/heads/main`);
      state.refreshedTo.push(sha);
      s.source = { remote, token: "x", ref: sha };
    };
    const thinks = [...early];
    policy.think = async (_s, ms) => {
      policy.log.push("think");
      const e = thinks.shift();
      return e === undefined ? { early: false, spentMs: ms } : { early: true, spentMs: e };
    };
    const submit = policy.submit;
    policy.submit = async (s, head) => ((state.head = head), submit(s, head));
    return state;
  }

  const kinds = (policy) => policy.log.map((l) => l.split(" ")[0]);

  it("Ryke's agent leases exactly the paths its commit writes, before it thinks", async () => {
    const rec = recorderOf();
    const policy = scripted([]);
    const state = withTools(policy);
    await runAgent(ctx(rec, policy, clock(rec)));
    assert.deepEqual(kinds(policy), ["open", "report", "admit", "think", "submit", "close"]);
    const changed = (await run("git", ["--git-dir", remote, "diff", "--name-only", `${state.head}^`, state.head])).stdout.trim().split("\n").sort();
    assert.deepEqual([...state.admitted[0]].sort(), changed);
  });

  it("a warning on the first report sends the agent to the new trunk before it thinks", async () => {
    const rec = recorderOf();
    const policy = scripted([]);
    const state = withTools(policy, { warnings: [true] });
    await runAgent(ctx(rec, policy, clock(rec)));
    assert.deepEqual(kinds(policy), ["open", "report", "admit", "refresh", "report", "think", "submit", "close"]);
    assert.equal((await run("git", ["--git-dir", remote, "rev-parse", `${state.head}^`])).stdout.trim(), state.refreshedTo[0], "the commit sits on the refreshed snapshot");
    assert.equal(rec.d.attempts[0].refreshes, 1);
    assert.equal(rec.d.attempts[0].lostThinkS, 0);
  });

  it("after a lease wait the agent reads again, and refreshes only if that reports a warning", async () => {
    const quiet = scripted([]);
    withTools(quiet, { waits: [true], warnings: [false, false] });
    const rec = recorderOf();
    await runAgent(ctx(rec, quiet, clock(rec)));
    assert.deepEqual(kinds(quiet), ["open", "report", "admit", "report", "think", "submit", "close"]);
    // The fake waits 30 ms on a timer, which may fire a fraction of a millisecond early against the
    // agent's high-resolution clock (one run measured 0.0297 s).
    assert.ok(rec.d.attempts[0].leaseWaitS >= 0.025, `${rec.d.attempts[0].leaseWaitS}`);
    assert.equal(rec.d.attempts[0].refreshes, 0);

    const moved = scripted([]);
    const state = withTools(moved, { waits: [true], warnings: [false, true] });
    const rec2 = recorderOf();
    await runAgent(ctx(rec2, moved, clock(rec2)));
    assert.deepEqual(kinds(moved), ["open", "report", "admit", "report", "refresh", "report", "think", "submit", "close"]);
    assert.equal(rec2.d.attempts[0].refreshes, 1);
    assert.equal(state.refreshedTo.length, 1);
  });

  it("a warning during the think refreshes, thinks a retry's worth again and counts the time that was lost", async () => {
    const rec = recorderOf();
    const policy = scripted([]);
    const state = withTools(policy, { early: [5] });
    await runAgent(ctx(rec, policy, clock(rec)));
    assert.deepEqual(kinds(policy), ["open", "report", "admit", "think", "refresh", "report", "think", "submit", "close"]);
    const a = rec.d.attempts[0];
    assert.equal(a.refreshes, 1);
    assert.equal(a.lostThinkS, 0.005);
    assert.ok(a.thinkS > 0.005, "the think before the refresh counts as think time of the attempt");
    assert.equal((await run("git", ["--git-dir", remote, "rev-parse", `${state.head}^`])).stdout.trim(), state.refreshedTo[0]);
    assert.equal(rec.d.txns[0].status, "landed");
  });

  it("an attempt refreshes at most MAX_REFRESHES times, then goes with what it has", async () => {
    const rec = recorderOf();
    const policy = scripted([]);
    const state = withTools(policy, { early: Array(50).fill(1) });
    await runAgent(ctx(rec, policy, clock(rec)));
    assert.equal(state.refreshedTo.length, MAX_REFRESHES);
    assert.equal(rec.d.attempts[0].refreshes, MAX_REFRESHES);
    assert.equal(policy.log.filter((l) => l === "submit 1").length, 1);
  });

  it("refreshing never spends an attempt: the retry that follows is attempt 2", async () => {
    const rec = recorderOf();
    const policy = scripted([{ landed: false, cause: "stale_read", retry: true }, { landed: true }]);
    withTools(policy, { early: [1] });
    await runAgent(ctx(rec, policy, clock(rec)));
    assert.deepEqual(rec.d.attempts.map((a) => [a.attempt, a.outcome]), [[1, "stale_read"], [2, "landed"]]);
  });

  // The real Ryke policies on a fake API, with the agent's git going to the local remote: this is where
  // "no admit" has to show up as "no lease calls, no lease waits".
  function rykeOn(over = {}) {
    const calls = [];
    const rec = (name, fn) => async (...a) => (calls.push([name, ...a]), fn(...a));
    const api = {
      calls,
      begin: rec("begin", async () => ({ txn: "t_9", state: "open", snapshot: seedSha, remote, token: "x" })),
      reads: rec("reads", async () => ({ staleWarnings: [] })),
      intendWrite: rec("intendWrite", async () => ({ go: true })),
      wait: rec("wait", async () => ({ txn: { state: "landed", reason: null }, detail: {}, staleWarnings: [] })),
      submit: rec("submit", async () => ({ state: "ready" })),
      abort: rec("abort", async () => ({})),
      call: rec("call", async () => ({ snapshot: seedSha, attempt: 1, delta: [], trunk: { remote, token: "x" } })),
      // Overrides are recorded too, so a test can see which calls were made.
      ...Object.fromEntries(Object.entries(over).map(([name, fn]) => [name, rec(name, fn)])),
    };
    return { api, stats: { verifyMs: [], refreshes: 0, leaseWaits: 0, leaseWaitMs: 0, leaseGaveUp: 0 } };
  }

  const leaseCases = [
    ["ryke", rykePolicy, true],
    ["ryke-nolease", rykeNoLeasePolicy, false],
    ["ryke-nopipe", rykeNoPipePolicy, true],
  ];
  for (const [name, build, leases] of leaseCases) {
    it(`${name}: a held hot file ${leases ? "makes the agent wait" : "is never asked about"}`, async () => {
      let held = 2;
      const { api, stats } = rykeOn({ intendWrite: async () => (held-- > 0 ? { go: false, owner: "t_1", retryAfterMs: 15 } : { go: true }) });
      const rec = recorderOf();
      const clk = clock(rec);
      await runAgent(ctx(rec, build({ api, repo: "r", clock: clk, stats }), clk));
      const asked = api.calls.filter((c) => c[0] === "intendWrite");
      assert.equal(asked.length > 0, leases);
      assert.equal(stats.leaseWaits > 0, leases);
      assert.equal(stats.leaseWaitMs > 0, leases);
      assert.equal(rec.d.attempts[0].leaseWaitS > 0, leases);
      assert.equal(rec.d.txns[0].status, "landed");
      if (!leases) assert.deepEqual([stats.leaseWaits, stats.leaseWaitMs, stats.leaseGaveUp, rec.d.attempts[0].leaseWaitS], [0, 0, 0, 0]);
    });

    it(`${name}: a stale warning before the think refreshes onto the trunk in both variants`, async () => {
      let first = true;
      const { api, stats } = rykeOn({ reads: async () => ({ staleWarnings: first ? ((first = false), [{ path: "src/format.ts" }]) : [] }) });
      const rec = recorderOf();
      const clk = clock(rec);
      await runAgent(ctx(rec, build({ api, repo: "r", clock: clk, stats }), clk));
      assert.equal(stats.refreshes, 1);
      assert.equal(api.calls.filter((c) => c[0] === "call").length, 1);
      assert.equal(rec.d.attempts[0].refreshes, 1);
    });
  }

  it("an error is recorded, the policy is closed and the agent carries on", async () => {
    const rec = recorderOf();
    const policy = scripted([]);
    let boom = true;
    const submit = policy.submit;
    policy.submit = async (...a) => {
      if (boom) {
        boom = false;
        throw new Error("api down");
      }
      return submit(...a);
    };
    await runAgent(ctx(rec, policy, clock(rec, 2)));
    assert.equal(rec.d.errors.length, 1);
    assert.match(rec.d.errors[0], /bench-001 b1x1: api down/);
    assert.deepEqual(rec.d.txns.map((t) => t.status), ["aborted", "landed"]);
    assert.equal(rec.d.attempts[0].outcome, "agent_error");
    assert.equal(policy.log.filter((l) => l === "close").length, 2);
  });

  it("a rejection at begin is recorded with the platform's reason", async () => {
    const rec = recorderOf();
    const policy = scripted([]);
    let first = true;
    const open = policy.open;
    policy.open = async (...a) => {
      if (first) {
        first = false;
        throw new Rejected("duplicate_of:t_7");
      }
      return open(...a);
    };
    await runAgent(ctx(rec, policy, clock(rec, 2)));
    assert.equal(rec.d.txns[0].cause, "rejected:duplicate_of:t_7");
  });

  it("a hard stop mid-submit abandons the change quietly", async () => {
    const rec = recorderOf();
    const clk = clock(rec, 99);
    const policy = scripted([]);
    policy.submit = async () => {
      clk.ac.abort(new Error("hard stop"));
      return { abandoned: true };
    };
    await runAgent(ctx(rec, policy, clk));
    assert.deepEqual(rec.d.txns.map((t) => t.status), ["abandoned"]);
    assert.deepEqual(rec.d.attempts.map((a) => a.outcome), ["abandoned"]);
    assert.equal(rec.d.errors.length, 0);
  });

  it("a hard stop while waiting to begin ends the agent without a record", async () => {
    const rec = recorderOf();
    const clk = clock(rec, 99);
    const policy = scripted([]);
    policy.open = async () => {
      clk.ac.abort(new Error("hard stop"));
      throw clk.signal.reason;
    };
    await runAgent(ctx(rec, policy, clk));
    assert.deepEqual([rec.d.txns.length, rec.d.errors.length], [0, 0]);
  });

  it("stops beginning at the deadline", async () => {
    const rec = recorderOf();
    const policy = scripted([]);
    await runAgent(ctx(rec, policy, { ...clock(rec), expired: () => true }));
    assert.deepEqual(policy.log, []);
  });

  it("the commit it pushes is a real change on the snapshot: files from the plan, parent is the snapshot", async () => {
    const rec = recorderOf();
    const policy = scripted([]);
    const submit = policy.submit;
    let pushed;
    policy.submit = async (s, head) => ((pushed = { head, snapshot: s.snapshot }), submit(s, head));
    await runAgent(ctx(rec, policy, clock(rec)));
    const parent = (await run("git", ["--git-dir", remote, "rev-parse", `${pushed.head}^`])).stdout.trim();
    assert.equal(parent, pushed.snapshot);
    const changed = (await run("git", ["--git-dir", remote, "diff", "--name-only", `${pushed.head}^`, pushed.head])).stdout.trim().split("\n");
    assert.ok(changed.length >= 1 && changed.every((p) => p !== "ryke.json" && !(p.startsWith("test/") && !p.startsWith("test/b"))), changed.join(", "));
  });
});

// ---------------------------------------------------------------------------------------------
describe("the trunk check", () => {
  async function history(name, files) {
    const dir = join(tmp, name);
    await mkdir(dir, { recursive: true });
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (...argv) => run("git", argv, { cwd: dir, env });
    await git("init", "-q", "-b", "main");
    for (const [i, content] of files.entries()) {
      await writeFile(join(dir, "ok.txt"), content);
      await git("add", "-A");
      await git("commit", "-q", "-m", `c${i}`);
    }
    return dir;
  }
  const ctlFor = (dir) => ({ info: async () => ({ remote: dir }), token: async () => "t" });
  const policy = { verify: "grep -q good ok.txt || (echo 'not ok 1 - the file is bad'; exit 1)", verifyTimeoutSeconds: 30 };

  it("passes a good history and checks the head plus the intermediate commits", async () => {
    const dir = await history("good", Array.from({ length: 6 }, (_, i) => `good ${i}`));
    const r = await checkTrunk(ctlFor(dir), { repo: "r", policy, runCommand: runVerifyCommand });
    assert.equal(r.breakages, 0);
    assert.equal(r.commits, 6);
    assert.equal(r.checked.length, 6);
  });

  it("an evenly spaced sample when the history is longer than the budget", async () => {
    const dir = await history("long", Array.from({ length: 9 }, (_, i) => `good ${i}`));
    const r = await checkTrunk(ctlFor(dir), { repo: "r", policy, runCommand: runVerifyCommand, intermediate: 3 });
    assert.equal(r.checked.length, 4);
    assert.equal(r.checked.at(-1).sha, r.head);
  });

  it("a broken commit in the middle is a breakage, and the failing test is named", async () => {
    const dir = await history("bad-middle", ["good 0", "good 1", "broken", "good 3"]);
    const r = await checkTrunk(ctlFor(dir), { repo: "r", policy, runCommand: runVerifyCommand });
    assert.equal(r.breakages, 1);
    const bad = r.checked.filter((c) => !c.pass);
    assert.equal(bad.length, 1);
    assert.deepEqual(bad[0].failing, ["the file is bad"]);
  });

  it("a broken head is a breakage even when the history before it is fine", async () => {
    const dir = await history("bad-head", ["good 0", "good 1", "nope"]);
    const r = await checkTrunk(ctlFor(dir), { repo: "r", policy, runCommand: runVerifyCommand });
    assert.equal(r.breakages, 1);
    assert.equal(r.checked.at(-1).pass, false);
  });

  it("runVerifyCommand reports a timeout as a failure", async () => {
    const r = await runVerifyCommand(tmp, "sleep 5", 200);
    assert.equal(r.pass, false);
  });
});

// ---------------------------------------------------------------------------------------------
// What a cell asks the platform for first: its repo, with the ryke.json the policy needs. A platform that
// answers the create and then refuses everything else stops the cell right there, with no stack needed.
// ---------------------------------------------------------------------------------------------
describe("the repo a cell creates", () => {
  let server;
  let base;
  const requests = [];
  before(async () => {
    server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null });
      const created = req.method === "POST" && req.url === "/api/repos";
      res.writeHead(created ? 201 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(created ? { repo: JSON.parse(raw).name, head: "a".repeat(40) } : { error: "stop here" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
  });

  it("only ryke-nopipe seeds a ryke.json of its own, and it turns pipelining off", () => {
    assert.deepEqual(SEED_POLICY, { "ryke-nopipe": { pipeline: false } });
    for (const p of BENCH_POLICIES) assert.deepEqual(SEED_POLICY[p], p === "ryke-nopipe" ? { pipeline: false } : undefined, p);
  });

  for (const policy of BENCH_POLICIES) {
    const override = policy === "ryke-nopipe";
    it(`${policy}: POST /api/repos ${override ? "carries policy { pipeline: false }" : "carries no policy at all"}`, async () => {
      requests.length = 0;
      const stack = { apiUrl: base, token: "t", storePort: 1, runnerPort: 2, internalSecret: "s", stateDir: tmp };
      await assert.rejects(runCell({ policy, agents: 3, durationS: 5, stack }), (e) => e.status === 404 && /stop here/.test(e.message));
      assert.deepEqual(requests[0], { method: "POST", path: "/api/repos", body: { name: `bench-${policy}-3`, seedFrom: "convert", fresh: true, ...(override ? { policy: { pipeline: false } } : {}) } });
      assert.equal("policy" in requests[0].body, override);
      assert.deepEqual(requests.slice(1).map((r) => `${r.method} ${r.path}`), ["GET /api/repos/bench-" + policy + "-3"], "the cell goes on to read the repo and nothing else before it fails");
    });
  }
});

// ---------------------------------------------------------------------------------------------
// One tiny real cell per policy: real git, real runner jobs, real tests, on a private stack.
// ---------------------------------------------------------------------------------------------
const STACK_OFFSET = 210 + 3 * Number(process.env.RYKE_PORT_OFFSET ?? 0);

describe(`real cells (3 agents, 20 s) on a private stack at offset ${STACK_OFFSET}`, { timeout: 600_000 }, () => {
  let stack;
  before(async () => {
    stack = await startBenchStack(STACK_OFFSET);
  }, { timeout: 180_000 });
  after(async () => {
    await stack?.close();
  });

  for (const policy of BENCH_POLICIES) {
    it(`${policy}: lands changes and leaves a trunk that passes its own tests`, async () => {
      const { cell, detail } = await runCell({ policy, agents: 3, durationS: 20, factor: 0.2, seed: 7, stack, graceS: 10 });
      assert.equal(cell.policy, policy);
      assert.equal(cell.agents, 3);
      assert.ok(cell.landed > 0, `landed ${cell.landed}: ${JSON.stringify(detail.errorSamples)}`);
      assert.equal(cell.trunkBreakages, 0, JSON.stringify(detail.failedChecks));
      assert.deepEqual(detail.problems, []);
      assert.equal(detail.errors, 0, JSON.stringify(detail.errorSamples));
      assert.ok(detail.checkedCommits >= 3, "the seed, the bench seed and at least one landed change were checked");
      assert.ok(detail.trunkCommits >= cell.landed + 2);
      assert.ok(cell.landedPerMinute > 0 && cell.p50 > 0 && cell.p95 >= cell.p50);
      // The baselines verify every change at least once; a Ryke train verifies several changes in one run.
      assert.ok(isRyke(policy) ? cell.verifyRunsPerLanded > 0 : cell.verifyRunsPerLanded >= 1, `verify runs per landed ${cell.verifyRunsPerLanded}`);
      // The cell must be a valid row of the results file (the ablation as the Ryke variant it is).
      assert.ok(parseBench({ generatedAt: null, durationSeconds: 20, synthetic: true, note: "n", cells: [{ ...cell, policy: isRyke(policy) ? "ryke" : policy }] }));
      if (isRyke(policy)) {
        assert.equal(detail.ledger.quiet, true);
        assert.ok(detail.ryke.trains >= 1);
      }
      if (policy === "ryke-nolease") {
        assert.deepEqual([detail.leaseWaits, detail.leaseWaitSeconds, detail.leaseGaveUp], [0, 0, 0]);
        // Its agents never call intend-write, so the Ledger never granted or queued a lease either.
        assert.deepEqual([detail.ryke.leaseGrantOps, detail.ryke.leaseWaitingOps], [0, 0]);
      }
      // The speculative counts are always there for Ryke.
      if (isRyke(policy)) assert.deepEqual(Object.keys(detail.ryke.speculative), ["formed", "confirmed", "discarded"]);
      // Pipelining is a switch of the repo's ryke.json, so it is read where the Ledger holds it. Three agents rarely
      // form a speculative train in 20 s whatever the switch says, so zero speculative trains would prove nothing.
      const { policy: repoPolicy } = await client(stack.apiUrl, stack.token).repo(`bench-${policy}-3`);
      if (policy === "ryke-nopipe") assert.equal(repoPolicy.pipeline, false);
      else assert.notEqual(repoPolicy.pipeline, false, "only ryke-nopipe turns pipelining off");
    });
  }
});
