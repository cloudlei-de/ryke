// The task catalogue and the pure decisions the scripted swarm makes with it: queue order, start
// gates, think time and which patch variant to try next (PLAN.md §10.2, §10.4, §11.1).
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SCRIPTED_MODEL = "scripted-v1";

// §10.4: lognormal think time, median 8 s. G2 tasks only touch one or two small files, so they think 4x shorter.
export const THINK_MEDIAN_S = 8;
export const THINK_SIGMA = 0.5;
export const G2_THINK_DIVISOR = 4;

export async function loadCatalogue(demo = "convert", root = ROOT) {
  const dir = join(root, "demo", demo);
  const raw = JSON.parse(await readFile(join(dir, "tasks.json"), "utf8"));
  const ids = new Set();
  const tasks = raw.map(({ spec: _spec, ...task }) => {
    // `spec` is the patch authors' brief. An agent never sees it, so it is dropped before anything else can read it.
    if (typeof task.id !== "string" || typeof task.intent !== "string" || !Array.isArray(task.reads) || !Array.isArray(task.writes)) {
      throw new Error(`demo/${demo}/tasks.json: malformed task ${JSON.stringify(task.id)}`);
    }
    if (ids.has(task.id)) throw new Error(`demo/${demo}/tasks.json: duplicate task id ${task.id}`);
    ids.add(task.id);
    return task;
  });
  return { demo, dir, tasks };
}

export function selectTasks(tasks, ids) {
  const known = new Set(tasks.map((t) => t.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`unknown task ids: ${unknown.join(", ")}`);
  const wanted = new Set(ids);
  return tasks.filter((t) => wanted.has(t.id));
}

export function identityFor(task, worker) {
  // The sloppy pair always runs as agent-13 / sloppy-v0, whichever worker picked it up, so a recall by agent or model finds it.
  return { agent: task.agent ?? worker, model: task.model ?? SCRIPTED_MODEL };
}

// ---------------------------------------------------------------------------------------------
// Queue order (§11.1). The demo depends on it:
//  - t-precision goes first and is quick, so it lands while the first wave of categories (which all
//    read format.ts) is still in flight: that is where the stale aborts with a delta come from.
//  - the sloppy pair follows at once, so its commits are old news by the time the G4 pair and the
//    categories that read length.ts begin.
//  - the other cross-cutting tasks arrive one every CATEGORY_GAP categories, so each one lands
//    while some categories are in flight, but no category sits through all of them.
// ---------------------------------------------------------------------------------------------

// The acceptance run has 12 agents, so the first 12 tasks start together; the G4 pair comes right after that wave.
export const FIRST_WAVE = 12;
export const CATEGORY_GAP = 5;
const HEAD = ["t-precision", "sloppy-a", "sloppy-b"];
// Alternating files: t-search and t-dark both rewrite layout.ts, which every category reads, so putting
// them back to back would stale a category twice in a row. Spaced out, no category meets more than two
// of the cross-cutting landings (Ryke aborts a transaction after its third bad attempt).
const CROSS_CUTTING = ["t-search", "t-favorites", "t-dark", "t-share"];
const KELVIN_PAIR = ["kelvin-first", "kelvin-remove"];
// dup-speed follows cat-speed by this many positions: close enough that cat-speed is still in flight or just landed.
const DUP_LAG = 3;

export function orderTasks(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const placed = new Set();
  const take = (id) => {
    const t = byId.get(id);
    if (!t || placed.has(id)) return [];
    placed.add(id);
    return [t];
  };

  const head = HEAD.flatMap(take);
  const sloppyWrites = new Set(tasks.filter((t) => t.group === "G6").flatMap((t) => t.writes));
  const readsSloppy = (t) => t.reads.some((p) => sloppyWrites.has(p));
  const categories = tasks.filter((t) => t.group === "G1");
  const free = categories.filter((t) => !readsSloppy(t));
  const gated = categories.filter(readsSloppy);

  const wave = [...head, ...free.splice(0, Math.max(0, FIRST_WAVE - head.length))];
  wave.forEach((t) => placed.add(t.id));
  const kelvin = KELVIN_PAIR.flatMap(take);
  const crossCutting = CROSS_CUTTING.flatMap(take);
  const dupSpeed = take("dup-speed");
  const tamper = take("tamper-routes");
  const late = ["dup-velocity", "dup-kmh"].flatMap(take);
  const locale = take("t-locale");

  // After the first wave: the categories that read a file the sloppy pair rewrote come first, then the
  // rest, with one cross-cutting task after every CATEGORY_GAP categories.
  const tail = [];
  [...gated, ...free].forEach((c, i) => {
    placed.add(c.id);
    tail.push(c);
    if ((i + 1) % CATEGORY_GAP === 0 && crossCutting.length > 0) tail.push(crossCutting.shift());
  });
  tail.push(...crossCutting);
  // Anything the rules do not know (another demo's tasks) keeps its catalogue order after the tail.
  const rest = tasks.filter((t) => !placed.has(t.id));

  const body = [...wave, ...kelvin, ...tail, ...rest];
  const speedAt = body.findIndex((t) => t.id === "cat-speed");
  body.splice(speedAt < 0 ? body.length : Math.min(speedAt + DUP_LAG, body.length), 0, ...dupSpeed);
  body.splice(Math.min(Math.floor(tasks.length / 2), body.length), 0, ...tamper);
  // dup-velocity and dup-kmh sit late with categories still behind them, t-locale is last: its landing
  // is the final wave of stale aborts.
  const total = tasks.length;
  const at = (fraction) => Math.min(Math.floor(total * fraction), body.length);
  if (late[0]) body.splice(at(0.85), 0, late[0]);
  if (late[1]) body.splice(at(0.93), 0, late[1]);
  body.push(...locale);
  return body;
}

// A task that reads a file a G6 task rewrites starts only after that task has finished, so its patch
// (v1 or v2) is chosen against a trunk that already has the rewrite instead of racing it.
export function startGates(tasks) {
  const sloppy = tasks.filter((t) => t.group === "G6");
  const gates = {};
  for (const t of tasks) {
    if (t.group === "G6") continue;
    const waitFor = sloppy.filter((s) => s.writes.some((p) => t.reads.includes(p))).map((s) => s.id);
    if (waitFor.length > 0) gates[t.id] = waitFor;
  }
  return gates;
}

// ---------------------------------------------------------------------------------------------
// Randomness: seeded, so a run's think times are reproducible (--seed).
// ---------------------------------------------------------------------------------------------

// mulberry32: tiny, well distributed enough for think times, and identical on every machine.
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One stream per task, so think times do not depend on which worker happened to pick the task up.
export function seedFor(seed, text) {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function gaussian(rng) {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function lognormal(rng, median, sigma) {
  return median * Math.exp(sigma * gaussian(rng));
}

// Retries think half as long: the agent already knows the code and only has to adapt to the delta.
export function thinkMs(rng, task, { speed = 1, retry = false } = {}) {
  const seconds = lognormal(rng, THINK_MEDIAN_S, THINK_SIGMA) / speed / (task.group === "G2" ? G2_THINK_DIVISOR : 1) / (retry ? 2 : 1);
  return Math.round(seconds * 1000);
}

// ---------------------------------------------------------------------------------------------
// Which patch to try (§10.4 step 6). `tried` lists what has been done on this snapshot, in order:
// { variant: "v1" | "v2", applied: boolean, passed: boolean }.
// ---------------------------------------------------------------------------------------------

export function nextVariant(task, tried) {
  const last = tried.at(-1);
  if (!last) return { variant: "v1" };
  if (last.applied && last.passed) return { done: true, variant: last.variant };
  if (last.variant === "v1" && task.v2) return { variant: "v2" };
  // A patch that applied but failed its tests got further than one that did not apply; report that.
  return { abort: tried.some((t) => t.applied) ? "local_tests_fail" : "patch_does_not_apply" };
}

export function patchFile(dir, task, variant) {
  const rel = variant === "v2" ? task.v2 : task.solution;
  return rel ? join(dir, rel) : null;
}

// "Add the \"Area\" converter category with 9 units: …" -> "Area"; the preview must show it once the task has landed.
export function categoryName(task) {
  return task.group === "G1" ? /"([^"]+)" converter category/.exec(task.intent)?.[1] ?? null : null;
}
