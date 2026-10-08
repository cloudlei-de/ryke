// The bench workload (PLAN.md §11.3): what a synthetic agent reads, writes and thinks, and the
// estimator that says how often two agents' changes are semantically incompatible. Everything here is
// pure and seeded, so the three policies get the same agents doing the same work.
import { lognormal, makeRng, seedFor } from "../lib/tasks.mjs";

export { makeRng, seedFor };

// Hottest first; ranks 1, 2, 3 of the Zipf draw whatever else the repo holds.
export const HOT_FILES = ["src/format.ts", "src/ui/layout.ts", "src/registry.ts"];

// Hot files that carry an exported numeric constant, added by the cell's own seed commit. registry.ts
// has none: the protected units test and src/index.ts treat every export of it as a category.
export const BENCH_CONSTS = { "src/format.ts": "BENCH_FORMAT", "src/ui/layout.ts": "BENCH_LAYOUT" };

// A pin is a small module `src/bench/pin-<id>.ts` saying "I was written against BENCH_X = v"; one seed test
// (test/bench-contract.test.ts) fails when a pin and its constant disagree. A pin cannot be a test file
// under test/: existing tests are protected and permanent, so once one pinned a constant no later change of
// it could ever pass, in any policy. As dependents under src/ they are rewritten by whoever changes the
// constant (a change that can see them), so only a pin written concurrently with a change breaks.
export const PIN_DIR = "src/bench";
export const isPin = (path) => /^src\/bench\/pin-[^/]+\.ts$/.test(path);

export const ZIPF_S = 1.1;
export const READ_COUNT = [3, 8];
export const WRITE_COUNT = [1, 3];
export const THINK_MEDIAN_S = 6;
export const THINK_SIGMA = 0.5;
export const RETRY_THINK_FACTOR = 0.5;

// pNew and pCategory are fixed by the brief (a new file with probability 0.6; this split between a
// category and a test file is ours). pChange and pAssert were chosen with calibrate() so that about a
// tenth of read-overlapping pairs are incompatible; the harness prints the realised rate per cell.
// A "pin" is a reader's test of the value it read; see PIN_DIR for why it is not a file under test/.
export const MIX = { pNew: 0.6, pCategory: 0.5, pChange: 0.8, pAssert: 0.8 };

export const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// ---------------------------------------------------------------------------------------------
// Reads: Zipf over a fixed ranking.
// ---------------------------------------------------------------------------------------------

// Not alphabetical for the hot files: they come first in a fixed order, then the rest A to Z.
export function rankFiles(files) {
  const present = HOT_FILES.filter((f) => files.includes(f));
  const rest = files.filter((f) => !HOT_FILES.includes(f)).sort();
  return [...present, ...rest];
}

export function zipfWeights(n, s = ZIPF_S) {
  return Array.from({ length: n }, (_, i) => (i + 1) ** -s);
}

// One draw: the index of the chosen weight.
export function weightedIndex(rng, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let u = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    u -= weights[i];
    if (u < 0) return i;
  }
  return weights.length - 1;
}

// k distinct items by successive sampling: each draw is Zipf over what is left, so the first is
// exactly Zipf(s) and the hot files still dominate every footprint without ever repeating.
export function drawDistinct(rng, ranked, k, s = ZIPF_S) {
  const left = ranked.map((item, i) => ({ item, w: (i + 1) ** -s }));
  const out = [];
  while (out.length < k && left.length > 0) {
    const [picked] = left.splice(weightedIndex(rng, left.map((l) => l.w)), 1);
    out.push(picked.item);
  }
  return out;
}

// Lognormal think time with the brief's median, scaled by the time factor; a retry thinks half as long.
export function thinkMs(rng, { factor = 1, retry = false } = {}) {
  return Math.max(1, Math.round(lognormal(rng, THINK_MEDIAN_S, THINK_SIGMA) * 1000 * factor * (retry ? RETRY_THINK_FACTOR : 1)));
}

// ---------------------------------------------------------------------------------------------
// The footprint of one transaction.
// ---------------------------------------------------------------------------------------------

// Existing tests and ryke.json are protected: a policy-abiding agent adds test files instead of editing them.
export const isEditable = (path) => (/^src\/.*\.ts$/.test(path) || path === "CHANGELOG.md");

// plan = { reads, slots, changes, asserts }
//   slots: { kind: "category" } | { kind: "test", asserts: [hot file] } | { kind: "edit", path, change: boolean }
//   changes: hot files whose constant this transaction rewrites; asserts: hot files whose constant a new test pins.
export function planTransaction(rng, files, mix = MIX) {
  const ranked = rankFiles(files);
  const reads = drawDistinct(rng, ranked, Math.min(ranked.length, randInt(rng, READ_COUNT[0], READ_COUNT[1])));
  const slotCount = randInt(rng, WRITE_COUNT[0], WRITE_COUNT[1]);
  const editable = reads.filter(isEditable);
  const slots = [];
  for (let i = 0; i < slotCount; i++) {
    // All four numbers are drawn whatever the branch, so a slot never shifts the stream of the next one.
    const [uNew, uCategory, uPick, uChange] = [rng(), rng(), rng(), rng()];
    const free = editable.filter((p) => !slots.some((s) => s.path === p));
    if (uNew >= mix.pNew && free.length > 0) {
      const path = free[Math.floor(uPick * free.length)];
      slots.push({ kind: "edit", path, change: path in BENCH_CONSTS && uChange < mix.pChange });
    } else {
      // An edit with nothing left to edit becomes a new file, never a protected-file edit.
      slots.push(uCategory < mix.pCategory ? { kind: "category" } : { kind: "test", asserts: [] });
    }
  }
  const changes = slots.filter((s) => s.kind === "edit" && s.change).map((s) => s.path);
  // A reader pins the value of a constant it read, unless it rewrote that constant itself. One pin per
  // slot, so a slot is still one file.
  for (const slot of slots) {
    if (slot.kind !== "test") continue;
    for (const f of Object.keys(BENCH_CONSTS)) {
      const u = rng();
      if (slot.asserts.length === 0 && reads.includes(f) && !changes.includes(f) && u < mix.pAssert) slot.asserts.push(f);
    }
  }
  const asserts = [...new Set(slots.flatMap((s) => s.asserts ?? []))].sort();
  return { reads, slots, changes: [...changes].sort(), asserts };
}

// ---------------------------------------------------------------------------------------------
// Incompatibility: the estimator behind "about 10 % of read-overlapping pairs".
// ---------------------------------------------------------------------------------------------

export function readsOverlap(a, b) {
  const [small, large] = a.reads.length <= b.reads.length ? [a, b] : [b, a];
  const set = new Set(large.reads);
  return small.reads.some((p) => set.has(p));
}

// One rewrites a constant the other's test pins: whichever lands second, the merged tree fails.
// Two rewrites of the same constant are a text conflict, which is not counted here.
export function incompatible(a, b) {
  return a.changes.some((f) => b.asserts.includes(f)) || b.changes.some((f) => a.asserts.includes(f));
}

export function estimateIncompatibility(plans) {
  let overlapping = 0;
  let bad = 0;
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      if (!readsOverlap(plans[i], plans[j])) continue;
      overlapping++;
      if (incompatible(plans[i], plans[j])) bad++;
    }
  }
  return { plans: plans.length, overlapping, incompatible: bad, rate: overlapping === 0 ? 0 : bad / overlapping };
}

// Offline calibration: what rate would these mix parameters give for this file list?
export function calibrate(files, mix = MIX, { samples = 600, seed = 1 } = {}) {
  const rng = makeRng(seed);
  return estimateIncompatibility(Array.from({ length: samples }, () => planTransaction(rng, files, mix)));
}

// ---------------------------------------------------------------------------------------------
// Real text edits.
// ---------------------------------------------------------------------------------------------

export function parseConst(text, name) {
  const m = new RegExp(`^export const ${name} = (-?\\d+);$`, "m").exec(text);
  return m ? Number(m[1]) : null;
}

const CONTRACT_TEST = `import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { BENCH_FORMAT } from "../src/format.ts";
import { BENCH_LAYOUT } from "../src/ui/layout.ts";

// Every dependent under src/bench/ names the constant it was written against; they must still agree.
const current: Record<string, number> = { BENCH_FORMAT, BENCH_LAYOUT };
const dir = new URL("../src/bench/", import.meta.url);

for (const file of readdirSync(dir).filter((f) => f.startsWith("pin-") && f.endsWith(".ts")).sort()) {
  test(\`\${file} is written against the current value\`, async () => {
    const { dependsOn } = await import(new URL(file, dir).href);
    assert.equal(current[dependsOn.name], dependsOn.value);
  });
}
`;

export const pinSource = (name, value) => `// A bench dependent: written against ${name}, whatever its value was when it was written.\nexport const dependsOn = { name: "${name}", value: ${value} };\n`;
export const parsePin = (text) => {
  const m = /^export const dependsOn = \{ name: "([A-Z_]+)", value: (-?\d+) \};$/m.exec(text);
  return m ? { name: m[1], value: Number(m[2]) } : null;
};

// The cell's own seed commit: the constants, one seed dependent each, and the test that holds them together.
export function seedFiles(files) {
  const out = {};
  for (const [path, name] of Object.entries(BENCH_CONSTS)) {
    const text = files[path];
    if (text === undefined) throw new Error(`bench seed: ${path} is missing`);
    if (parseConst(text, name) !== null) continue;
    out[path] = `${text.endsWith("\n") ? text : `${text}\n`}\n// Bench anchor: dependents under src/bench/ are written against this value.\nexport const ${name} = 1;\n`;
    out[`${PIN_DIR}/pin-seed-${path.split("/").at(-1).replace(".ts", "")}.ts`] = pinSource(name, 1);
  }
  if (Object.keys(out).length > 0) out["test/bench-contract.test.ts"] = CONTRACT_TEST;
  return out;
}

// Lines before which a block can go without cutting a statement or a template literal in two.
function insertionPoints(lines) {
  const points = [];
  lines.forEach((l, i) => {
    if (/^(export|import) /.test(l)) points.push(i);
  });
  points.push(lines.length);
  return points;
}

// Harmless, unique and at a random top-level position, so two agents editing one file usually merge
// and sometimes collide on the same spot. (Rewriting a constant is done by `rewriteConst`.)
export function editFile(path, text, { tag, rng }) {
  if (path.endsWith(".md")) return `${text.endsWith("\n") ? text : `${text}\n`}- ${tag}: touched\n`;
  const lines = text.split("\n");
  const trailing = lines.at(-1) === "";
  if (trailing) lines.pop();
  const points = insertionPoints(lines);
  const at = points[Math.floor(rng() * points.length)];
  // A function export would be read as a category by anything that walks the registry's exports.
  const fn = rng() < 0.5 && path !== "src/registry.ts";
  const n = Math.floor(rng() * 1000);
  const body = [`export function bench_${tag}(x: number): number {`, `  return x + ${n};`, "}"];
  // Blank-line separated from what follows, or from what precedes when it is the last thing in the file.
  const block = fn ? (at === lines.length ? ["", ...body] : [...body, ""]) : [`// ${tag}: note ${n}`];
  lines.splice(at, 0, ...block);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Turning a plan into files, against whatever the agent's snapshot holds.
// ---------------------------------------------------------------------------------------------

const slotId = (tag, i) => `${tag}${String.fromCharCode(97 + i)}`;

export function categorySource(id, factor) {
  return `import type { Category } from "../types.ts";

export const ${id}: Category = {
  id: "${id}",
  name: "Bench ${id}",
  base: "u",
  units: [
    { id: "u", name: "Unit", symbol: "u", toBase: (v) => v, fromBase: (v) => v },
    { id: "w", name: "Wide", symbol: "w", toBase: (v) => v * ${factor}, fromBase: (v) => v / ${factor} },
  ],
};
`;
}

export function testSource(id, n) {
  return `import assert from "node:assert/strict";
import { test } from "node:test";

test("${id}: arithmetic holds", () => {
  assert.equal(${n} + ${n}, ${2 * n});
});
`;
}

// The new value is always different from the old one, and unique enough that two changers collide.
export function rewriteConst(text, name, rng) {
  const old = parseConst(text, name);
  if (old === null) return null;
  return text.replace(new RegExp(`^export const ${name} = -?\\d+;$`, "m"), `export const ${name} = ${old + 1 + Math.floor(rng() * 997)};`);
}

// The dependents a change of `plan` has to rewrite: every pin at this snapshot naming a constant it changes.
// The agent reads them, so they belong to its read set.
export function dependents(plan, files, read) {
  const names = new Set(plan.changes.map((f) => BENCH_CONSTS[f]));
  if (names.size === 0) return [];
  return files.filter(isPin).filter((p) => names.has(parsePin(read(p) ?? "")?.name));
}

// read(path) returns the file at the agent's snapshot and `files` lists the snapshot. Returns every file to
// write, plus the values the new pins record and the constants this change rewrote.
export function materialise(plan, { tag, read, files: snapshot = [], rng }) {
  const files = {};
  const current = (path) => files[path] ?? read(path) ?? "";
  const pinned = {};
  const changed = {};
  plan.slots.forEach((slot, i) => {
    const id = slotId(tag, i);
    if (slot.kind === "category") {
      files[`src/units/${id}.ts`] = categorySource(id, 2 + Math.floor(rng() * 998));
      const registry = current("src/registry.ts");
      files["src/registry.ts"] = `${registry.endsWith("\n") || registry === "" ? registry : `${registry}\n`}export { ${id} } from "./units/${id}.ts";\n`;
    } else if (slot.kind === "test") {
      const pin = slot.asserts[0];
      const v = pin === undefined ? null : parseConst(current(pin), BENCH_CONSTS[pin]);
      if (v === null) files[`test/${id}.test.ts`] = testSource(id, 1 + Math.floor(rng() * 500));
      else {
        pinned[pin] = v;
        files[`${PIN_DIR}/pin-${id}.ts`] = pinSource(BENCH_CONSTS[pin], v);
      }
    } else {
      const before = current(slot.path);
      const next = slot.change && slot.path in BENCH_CONSTS ? rewriteConst(before, BENCH_CONSTS[slot.path], rng) : null;
      if (next !== null) {
        files[slot.path] = next;
        const value = parseConst(next, BENCH_CONSTS[slot.path]);
        changed[slot.path] = value;
        // An informed change brings its dependents along.
        for (const p of dependents({ changes: [slot.path] }, snapshot, read)) files[p] = pinSource(BENCH_CONSTS[slot.path], value);
      } else files[slot.path] = editFile(slot.path, before, { tag: id, rng });
    }
  });
  return { files, pinned, changed };
}

export function intentFor(tag, plan) {
  const parts = plan.slots.map((s) => (s.kind === "category" ? "add a category" : s.kind === "test" ? "add a test" : `adjust ${s.path}`));
  return `Bench ${tag}: ${parts.join(", ")}`;
}
