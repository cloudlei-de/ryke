// The pure helpers behind the swarm and the CLI: queue order, think time, patch variant choice, the
// end-of-run report, lease patience, argument parsing. No stack needed; test/node/swarm.test.mjs runs the real thing.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { admit, describeWarnings, LEASE_PATIENCE_MS, runTask } from "../../harness/agents/scripted.mjs";
import { ApiError, client } from "../../harness/lib/client.mjs";
import { buildReport, checkPreview, evaluateCriteria, foldTxns, formatReport, landedCategories } from "../../harness/lib/report.mjs";
import {
  categoryName,
  identityFor,
  lognormal,
  loadCatalogue,
  makeRng,
  nextVariant,
  orderTasks,
  patchFile,
  seedFor,
  selectTasks,
  startGates,
  thinkMs,
} from "../../harness/lib/tasks.mjs";
import { main as ryke } from "../../harness/ryke.mjs";
import { checksTrunk, limiter, parseSwarmArgs, resilient, runSwarm, UsageError } from "../../harness/swarm.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixture = JSON.parse(await readFile(join(ROOT, "test/fixtures/ops/e2e-land.json"), "utf8"));
const { tasks: catalogue, dir: catalogueDir } = await loadCatalogue("convert");

let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ryke-harness-lib-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ids = (tasks) => tasks.map((t) => t.id);
const task = (id, over = {}) => ({ id, group: "G1", intent: `intent ${id}`, reads: [], writes: [], v2: null, ...over });

describe("the swarm's trunk check (local stacks only)", () => {
  for (const [api, env, expected] of [
    ["http://127.0.0.1:5173", {}, true],
    ["http://localhost:5183", {}, true],
    ["http://[::1]:5173", {}, true],
    ["https://ryke.ai", {}, false],
    ["https://ryke.ai", { RYKE_STORE_URL: "http://127.0.0.1:8788" }, true],
    ["http://10.0.0.5:5173", {}, false],
  ]) {
    it(`${api} ${JSON.stringify(env)} → ${expected ? "checked" : "not checked"}`, () => {
      assert.equal(checksTrunk(api, env), expected);
    });
  }
});

describe("catalogue", () => {
  it("loads the 40 tasks without their spec", () => {
    assert.equal(catalogue.length, 40);
    assert.equal(new Set(ids(catalogue)).size, 40);
    for (const t of catalogue) {
      assert.equal("spec" in t, false, `${t.id} still carries its spec`);
      assert.ok(t.intent && Array.isArray(t.criteria) && Array.isArray(t.reads) && Array.isArray(t.writes), t.id);
    }
  });

  it("rejects a malformed task and a duplicate id", async () => {
    for (const [name, raw, message] of [
      ["no-intent", [{ id: "a", reads: [], writes: [] }], /malformed task "a"/],
      ["no-reads", [{ id: "a", intent: "x", writes: [] }], /malformed task "a"/],
      ["duplicate", [task("a"), task("a")], /duplicate task id a/],
    ]) {
      await mkdir(join(tmp, "demo", name), { recursive: true });
      await writeFile(join(tmp, "demo", name, "tasks.json"), JSON.stringify(raw));
      await assert.rejects(loadCatalogue(name, tmp), message, name);
    }
  });

  it("selects tasks in catalogue order and refuses unknown ids", () => {
    assert.deepEqual(ids(selectTasks(catalogue, ["cat-power", "t-precision"])), ["cat-power", "t-precision"].sort((a, b) => ids(catalogue).indexOf(a) - ids(catalogue).indexOf(b)));
    assert.throws(() => selectTasks(catalogue, ["cat-power", "nope", "nada"]), /unknown task ids: nope, nada/);
    assert.deepEqual(selectTasks(catalogue, []), []);
  });

  it("runs the sloppy pair as agent-13 and everybody else as the worker", () => {
    const byId = (id) => catalogue.find((t) => t.id === id);
    assert.deepEqual(identityFor(byId("sloppy-a"), "agent-02"), { agent: "agent-13", model: "sloppy-v0" });
    assert.deepEqual(identityFor(byId("sloppy-b"), "agent-09"), { agent: "agent-13", model: "sloppy-v0" });
    assert.deepEqual(identityFor(byId("cat-area"), "agent-02"), { agent: "agent-02", model: "scripted-v1" });
  });

  it("resolves patch files and category names", () => {
    const area = catalogue.find((t) => t.id === "cat-area");
    assert.equal(patchFile("/d", area, "v1"), "/d/solutions/cat-area.patch");
    assert.equal(patchFile("/d", area, "v2"), "/d/solutions/cat-area.v2.patch");
    assert.equal(patchFile("/d", { solution: "solutions/x.patch", v2: null }, "v2"), null);
    for (const [id, name] of [["cat-area", "Area"], ["cat-fuel-economy", "Fuel economy"], ["cat-shoe-sizes", "Shoe sizes"], ["t-precision", null], ["dup-speed", null]]) {
      assert.equal(categoryName(catalogue.find((t) => t.id === id)), name, id);
    }
    assert.ok(catalogue.filter((t) => t.group === "G1").every((t) => categoryName(t)), "every G1 task names its category");
  });
});

describe("queue order (PLAN.md section 11.1)", () => {
  const order = ids(orderTasks(catalogue));
  const at = (id) => order.indexOf(id);
  const g1Between = (a, b) => order.slice(at(a) + 1, at(b)).filter((id) => catalogue.find((t) => t.id === id).group === "G1").length;

  it("is a permutation of the catalogue and is deterministic", () => {
    assert.deepEqual([...order].sort(), ids(catalogue).sort());
    assert.deepEqual(ids(orderTasks(catalogue)), order);
  });

  it("starts with t-precision, then the sloppy pair", () => {
    assert.equal(at("t-precision"), 0);
    assert.deepEqual([at("sloppy-a"), at("sloppy-b")].sort(), [1, 2]);
  });

  it("keeps everything that reads a sloppy file out of the first wave", () => {
    const sloppyWrites = new Set(catalogue.filter((t) => t.group === "G6").flatMap((t) => t.writes));
    for (const t of catalogue.filter((x) => x.group !== "G6" && x.reads.some((p) => sloppyWrites.has(p)))) {
      assert.ok(at(t.id) >= 12, `${t.id} is at ${at(t.id)}`);
    }
  });

  it("puts the Kelvin pair next to each other, after the first wave", () => {
    assert.equal(Math.abs(at("kelvin-first") - at("kelvin-remove")), 1);
    assert.ok(Math.min(at("kelvin-first"), at("kelvin-remove")) >= 11);
    assert.ok(Math.min(at("kelvin-first"), at("kelvin-remove")) <= 13);
  });

  it("spreads the other cross-cutting tasks one every five categories", () => {
    const g2 = ["t-search", "t-favorites", "t-dark", "t-share"];
    assert.deepEqual([...g2].sort((a, b) => at(a) - at(b)), g2);
    for (const id of g2) assert.ok(at(id) >= 12, id);
    assert.equal(g1Between("t-search", "t-favorites"), 5);
    assert.equal(g1Between("t-favorites", "t-dark"), 5);
    const last = g1Between("t-dark", "t-share");
    assert.ok(last >= 1 && last <= 5, `${last} categories between t-dark and t-share`);
    // the two that rewrite layout.ts are never closer than ten categories
    assert.ok(g1Between("t-search", "t-dark") >= 10);
  });

  it("places the duplicates, the tamper bait and t-locale", () => {
    assert.equal(at("dup-speed") - at("cat-speed"), 3);
    assert.ok(at("tamper-routes") >= 14 && at("tamper-routes") <= 26, `tamper-routes at ${at("tamper-routes")}`);
    assert.ok(at("dup-velocity") >= 30 && at("dup-kmh") >= 30 && at("dup-velocity") < at("dup-kmh"));
    assert.ok(at("t-locale") >= 38, `t-locale at ${at("t-locale")}`);
  });

  it("orders subsets by the same rules", () => {
    const pick = (list) => ids(orderTasks(selectTasks(catalogue, list)));
    for (const [name, list, expected] of [
      ["empty", [], []],
      ["one", ["cat-area"], ["cat-area"]],
      ["the swarm test", ["dup-speed", "tamper-routes", "cat-energy", "cat-pressure", "cat-speed", "t-precision"], ["t-precision", "cat-speed", "cat-pressure", "tamper-routes", "cat-energy", "dup-speed"]],
      ["sloppy first, gated category after", ["cat-area", "cat-pressure", "sloppy-b", "sloppy-a"], ["sloppy-a", "sloppy-b", "cat-pressure", "cat-area"]],
      ["few categories: cross-cutting follows them", ["t-share", "t-search", "cat-area"], ["cat-area", "t-search", "t-share"]],
      ["dup-speed without cat-speed goes last", ["dup-speed", "cat-area"], ["cat-area", "dup-speed"]],
      ["t-locale is last", ["t-locale", "cat-area", "t-precision"], ["t-precision", "cat-area", "t-locale"]],
      ["late duplicates stay behind the categories", ["dup-kmh", "dup-velocity", "cat-area", "cat-pressure", "t-locale"], ["cat-area", "cat-pressure", "dup-velocity", "dup-kmh", "t-locale"]],
    ]) {
      assert.deepEqual(pick(list), expected, name);
    }
  });

  it("keeps tasks it has no rule for, in catalogue order, after the tail", () => {
    const odd = [task("x", { group: "G9" }), task("cat-a"), task("y", { group: "G9" }), task("cat-b")];
    assert.deepEqual(ids(orderTasks(odd)), ["cat-a", "cat-b", "x", "y"]);
  });

  it("gates a task on the sloppy tasks that rewrite what it reads", () => {
    assert.deepEqual(startGates(catalogue), {
      "cat-area": ["sloppy-b"],
      "cat-volume": ["sloppy-b"],
      "cat-speed": ["sloppy-b"],
      "dup-speed": ["sloppy-b"],
      "kelvin-first": ["sloppy-a"],
      "kelvin-remove": ["sloppy-a"],
    });
    assert.deepEqual(startGates(selectTasks(catalogue, ["cat-area", "kelvin-first"])), {});
    assert.deepEqual(startGates([]), {});
  });
});

describe("think time (PLAN.md section 10.4)", () => {
  const draw = (seed, n) => {
    const rng = makeRng(seed);
    return Array.from({ length: n }, () => lognormal(rng, 8, 0.5));
  };

  it("is reproducible by seed and differs between seeds", () => {
    assert.deepEqual(draw(42, 20), draw(42, 20));
    assert.notDeepEqual(draw(42, 20), draw(43, 20));
    const rng = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1);
    }
    assert.equal(seedFor(42, "cat-area"), seedFor(42, "cat-area"));
    assert.notEqual(seedFor(42, "cat-area"), seedFor(42, "cat-volume"));
    assert.notEqual(seedFor(42, "cat-area"), seedFor(43, "cat-area"));
  });

  it("is lognormal with median 8 s and sigma 0.5", () => {
    const xs = draw(42, 20001).sort((a, b) => a - b);
    const median = xs[10000];
    assert.ok(Math.abs(median - 8) / 8 < 0.03, `median ${median}`);
    const logs = xs.map(Math.log);
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length);
    assert.ok(Math.abs(sd - 0.5) < 0.02, `sigma ${sd}`);
    assert.ok(Math.abs(mean - Math.log(8)) < 0.02, `mean of logs ${mean}`);
    assert.ok(xs[0] > 0);
  });

  it("is divided by speed, by 4 for G2, and by 2 on a retry", () => {
    const base = (t, opts) => thinkMs(makeRng(5), t, opts);
    const g1 = task("a", { group: "G1" });
    const g2 = task("b", { group: "G2" });
    const one = base(g1, {});
    for (const [name, got, expected] of [
      ["speed 4", base(g1, { speed: 4 }), one / 4],
      ["speed 0.5", base(g1, { speed: 0.5 }), one * 2],
      ["G2", base(g2, {}), one / 4],
      ["retry", base(g1, { retry: true }), one / 2],
      ["G2 retry at speed 4", base(g2, { speed: 4, retry: true }), one / 32],
    ]) {
      assert.ok(Math.abs(got - expected) <= 1, `${name}: ${got} vs ${expected}`);
    }
    assert.equal(Number.isInteger(one), true);
  });
});

describe("which patch to try", () => {
  const withV2 = { id: "a", v2: "solutions/a.v2.patch" };
  const without = { id: "b", v2: null };
  const none = { id: "c" };
  const v = (variant, applied, passed) => ({ variant, applied, passed });
  const table = [
    ["start", withV2, [], { variant: "v1" }],
    ["v1 works", withV2, [v("v1", true, true)], { done: true, variant: "v1" }],
    ["v1 does not apply", withV2, [v("v1", false, false)], { variant: "v2" }],
    ["v1 applies but fails", withV2, [v("v1", true, false)], { variant: "v2" }],
    ["v2 works", withV2, [v("v1", false, false), v("v2", true, true)], { done: true, variant: "v2" }],
    ["v2 works after a failing v1", withV2, [v("v1", true, false), v("v2", true, true)], { done: true, variant: "v2" }],
    ["neither applies", withV2, [v("v1", false, false), v("v2", false, false)], { abort: "patch_does_not_apply" }],
    ["both fail their tests", withV2, [v("v1", true, false), v("v2", true, false)], { abort: "local_tests_fail" }],
    ["v1 fails, v2 does not apply", withV2, [v("v1", true, false), v("v2", false, false)], { abort: "local_tests_fail" }],
    ["v1 does not apply, v2 fails", withV2, [v("v1", false, false), v("v2", true, false)], { abort: "local_tests_fail" }],
    ["no v2, v1 does not apply", without, [v("v1", false, false)], { abort: "patch_does_not_apply" }],
    ["no v2, v1 fails its tests", without, [v("v1", true, false)], { abort: "local_tests_fail" }],
    ["no v2, v1 works", without, [v("v1", true, true)], { done: true, variant: "v1" }],
    ["v2 key missing, v1 does not apply", none, [v("v1", false, false)], { abort: "patch_does_not_apply" }],
  ];
  for (const [name, t, tried, expected] of table) {
    it(name, () => assert.deepEqual(nextVariant(t, tried), expected));
  }

  // A retry re-applies the patch it submitted last (PLAN.md section 10.4), not v1 again: under load each
  // doomed v1 test run cost about 20 s, long enough for the next hot-file landing to stale the change.
  const retries = [
    ["a retry after v2 starts with v2", withV2, ["v2"], [], { variant: "v2" }],
    ["v2 still works", withV2, ["v2"], [v("v2", true, true)], { done: true, variant: "v2" }],
    ["v2 no longer fits (a recall took its base away): back to v1", withV2, ["v2"], [v("v2", true, false)], { variant: "v1" }],
    ["neither fits any more", withV2, ["v2"], [v("v2", false, false), v("v1", false, false)], { abort: "patch_does_not_apply" }],
    ["v2 fails, v1 does not apply", withV2, ["v2"], [v("v2", true, false), v("v1", false, false)], { abort: "local_tests_fail" }],
    ["a retry after v1 starts with v1", withV2, ["v1"], [], { variant: "v1" }],
    ["the last submission decides", withV2, ["v1", "v2"], [], { variant: "v2" }],
    ["after falling back to v1, the next retry starts with v1", withV2, ["v2", "v1"], [], { variant: "v1" }],
    ["v2 does not apply any more: v1", withV2, ["v2"], [v("v2", false, false)], { variant: "v1" }],
    ["v2 fails, v1 works", withV2, ["v2"], [v("v2", true, false), v("v1", true, true)], { done: true, variant: "v1" }],
    ["v2 and v1 both fail their tests", withV2, ["v2"], [v("v2", true, false), v("v1", true, false)], { abort: "local_tests_fail" }],
    ["a task without v2 stays on v1", without, ["v1"], [v("v1", true, false)], { abort: "local_tests_fail" }],
  ];
  for (const [name, t, submitted, tried, expected] of retries) {
    it(name, () => assert.deepEqual(nextVariant(t, tried, submitted), expected));
  }
});

describe("the scripted agent's retry (PLAN.md section 10.4)", () => {
  const git = (cwd, ...argv) => promisify(execFile)("git", argv, { cwd }).then((r) => r.stdout.trim());

  // One file, two patches that both apply to the base; only v2 passes the (injected) local tests, the
  // way only a category's v2 passes once t-precision is on trunk. The fake Ledger answers the first
  // submit with stale and the second with landed.
  async function setup() {
    const root = await mkdtemp(join(tmp, "retry-"));
    const work = join(root, "work");
    await mkdir(work);
    await git(work, "init", "-q", "-b", "main");
    await writeFile(join(work, "a.txt"), "base\n");
    await git(work, "add", "-A");
    await git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    const base = await git(work, "rev-parse", "HEAD");
    const patch = async (name, text) => {
      await writeFile(join(work, "a.txt"), `${text}\n`);
      await writeFile(join(root, name), `${await git(work, "diff")}\n`);
      await git(work, "checkout", "-q", "--", "a.txt");
    };
    await patch("x.patch", "v1");
    await patch("x.v2.patch", "v2");
    const fork = join(root, "fork.git");
    await git(root, "clone", "-q", "--bare", work, fork);
    // The trunk the retry moves onto: base plus somebody else's change to another file.
    await writeFile(join(work, "b.txt"), "other\n");
    await git(work, "add", "-A");
    await git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "other");
    const trunk = join(root, "trunk.git");
    await git(root, "clone", "-q", "--bare", work, trunk);

    const submits = [];
    const api = {
      begin: async () => ({ txn: "t_x", state: "open", snapshot: base, remote: fork, token: "tok", warnings: [], policy: { union: [], verify: "true", verifyTimeoutSeconds: 10 } }),
      reads: async () => ({ recorded: 1, staleWarnings: [] }),
      submit: async (_txn, body) => {
        submits.push(body);
        return submits.length === 1 ? { state: "stale", reason: "stale_read", paths: [{ path: "a.txt", by: "t_other" }] } : { state: "ready" };
      },
      wait: async () => ({ txn: { state: "landed", landedSeq: 2, train: "tr_1" } }),
      retry: async () => ({ attempt: 2, snapshot: "main", delta: [{ path: "a.txt" }], remote: fork, token: "tok", trunk: { remote: trunk, token: "tok" } }),
      abort: async () => ({ state: "aborted" }),
    };
    const verified = [];
    const verify = async (dir) => {
      const content = (await readFile(join(dir, "a.txt"), "utf8")).trim();
      verified.push(content);
      return { pass: content === "v2", ms: 1, failing: content === "v2" ? [] : ["a.txt is v2"] };
    };
    const task = { id: "x", group: "G1", intent: "x", criteria: [], reads: [], writes: ["a.txt"], solution: "x.patch", v2: "x.v2.patch" };
    return { root, api, verify, verified, submits, task };
  }

  it("re-applies the variant it submitted last instead of starting over at v1", async () => {
    const { root, api, verify, verified, submits, task } = await setup();
    const lines = [];
    const r = await runTask({ api, repo: "r", task, dir: root, worker: "agent-01", rng: makeRng(1), speed: 1000, log: (_a, l) => lines.push(l), verify });
    assert.deepEqual([r.outcome, r.attempts, r.variants], ["landed", 2, ["v2", "v2"]]);
    assert.deepEqual(verified, ["v1", "v2", "v2"], lines.join("\n"));
    assert.equal(submits.length, 2);
  });
});

describe("lease patience (PLAN.md section 7.2)", () => {
  const clock = () => {
    const c = { t: 0, waits: [] };
    c.now = () => c.t;
    c.wait = async (ms) => {
      c.waits.push(ms);
      c.t += ms;
    };
    return c;
  };
  const scripted = (answers) => {
    const calls = [];
    return { calls, intendWrite: async (txn, path) => (calls.push([txn, path]), answers(path, calls.length)) };
  };

  it("asks once per path and never waits when every answer is go", async () => {
    const c = clock();
    const api = scripted(() => ({ go: true }));
    const said = [];
    await admit(api, "t_1", ["a.ts", "b.ts"], (m) => said.push(m), c);
    assert.deepEqual(api.calls, [["t_1", "a.ts"], ["t_1", "b.ts"]]);
    assert.deepEqual(c.waits, []);
    assert.deepEqual(said, []);
  });

  it("waits the advised time, with a floor of 50 ms, and retries the same path", async () => {
    const c = clock();
    const api = scripted((path, n) => (n === 1 ? { go: false, owner: "t_2", retryAfterMs: 1200 } : n === 2 ? { go: false, owner: "t_2", retryAfterMs: 5 } : { go: true }));
    const said = [];
    await admit(api, "t_1", ["a.ts"], (m) => said.push(m), c);
    assert.equal(api.calls.length, 3);
    assert.deepEqual(c.waits, [1200, 50]);
    assert.equal(said.length, 2);
    assert.match(said[0], /waiting for a\.ts: leased to t_2, retry in 1200 ms/);
  });

  it("gives up after 90 s in total and writes anyway, across paths", async () => {
    const c = clock();
    const api = scripted(() => ({ go: false, owner: "t_2", retryAfterMs: 30_000 }));
    const said = [];
    await admit(api, "t_1", ["a.ts", "b.ts"], (m) => said.push(m), c);
    assert.equal(LEASE_PATIENCE_MS, 90_000);
    assert.deepEqual(c.waits, [30_000, 30_000, 30_000]);
    assert.equal(c.t, 90_000);
    // a.ts: four asks (three waits, then give up); b.ts: one ask, the budget is already spent
    assert.equal(api.calls.length, 5);
    assert.equal(said.filter((m) => m.startsWith("gave up")).length, 2);
  });

  it("never waits past the deadline", async () => {
    const c = clock();
    const api = scripted(() => ({ go: false, owner: "t_2", retryAfterMs: 60_000 }));
    await admit(api, "t_1", ["a.ts"], () => {}, c);
    assert.deepEqual(c.waits, [60_000, 30_000]);
  });
});

describe("begin warnings in the swarm log", () => {
  const dup = (other, value, intent = `intent of ${other}`) => ({ kind: "duplicate", other, intent, footprint: [], value });
  const conflict = (other, score, confidence = 0) => ({ kind: "conflict", other, intent: `intent of ${other}`, footprint: [], score, confidence });
  const table = [
    ["none", [], []],
    ["one duplicate", [dup("t_a", 0.9, "Add a speed category")], ['warning duplicate of t_a "Add a speed category" (similarity 0.9)']],
    ["the strongest duplicate wins and the rest are counted", [dup("t_a", 0.4), dup("t_b", 0.7), dup("t_c", 0.5)], ['warning duplicate of t_b "intent of t_b" (similarity 0.7) (+2 more)']],
    ["one line per kind, duplicates first", [conflict("t_a", 1, 0.2), dup("t_a", 0.5), conflict("t_b", 1.8, 0.9)], ['warning duplicate of t_a "intent of t_a" (similarity 0.5)', 'warning conflict of t_b "intent of t_b" (conflict 1.8, confidence 0.9) (+1 more)']],
    ["a stale warning", [{ kind: "stale", paths: ["src/format.ts", "src/ui/layout.ts"], seq: 3 }], ["warning stale: src/format.ts, src/ui/layout.ts"]],
  ];
  for (const [name, warnings, expected] of table) it(name, () => assert.deepEqual(describeWarnings(warnings), expected));
});

describe("limiter and resilient", () => {
  it("runs at most n jobs at once and hands the slot over in order", async () => {
    const run = limiter(2);
    let active = 0;
    let peak = 0;
    const started = [];
    const job = (i) => async () => {
      started.push(i);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return i;
    };
    const out = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => run(job(i))));
    assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  });

  it("frees the slot when a job throws", async () => {
    const run = limiter(1);
    await assert.rejects(run(async () => Promise.reject(new Error("boom"))), /boom/);
    assert.equal(await run(async () => "next"), "next");
  });

  it("retries repeatable calls on 5xx and network errors, but not on 4xx, and never begin or retry", async () => {
    const pause = async () => {};
    const flaky = (errors) => {
      let n = 0;
      return { n: () => n, fn: async () => { if (n < errors.length) throw errors[n++]; n++; return "ok"; } };
    };
    for (const [name, errors, expectedCalls, outcome] of [
      ["two 503s", [new ApiError(503, "x", "GET /a"), new ApiError(500, "x", "GET /a")], 3, "ok"],
      ["a dropped connection", [new TypeError("fetch failed")], 2, "ok"],
      ["a 404", [new ApiError(404, "x", "GET /a")], 1, "error"],
      ["a 409", [new ApiError(409, "x", "GET /a")], 1, "error"],
      ["a plain error", [new Error("bug")], 1, "error"],
      ["never recovers", Array.from({ length: 10 }, () => new ApiError(502, "x", "GET /a")), 4, "error"],
    ]) {
      const f = flaky(errors);
      const api = resilient({ txn: f.fn, begin: f.fn, retry: f.fn }, { pause });
      const got = await api.txn("t").then(() => "ok", () => "error");
      assert.equal(got, outcome, name);
      assert.equal(f.n(), expectedCalls, name);
    }
    for (const name of ["begin", "retry"]) {
      const f = flaky([new ApiError(503, "x", `POST /${name}`)]);
      const api = resilient({ [name]: f.fn }, { pause });
      await assert.rejects(api[name](), ApiError, name);
      assert.equal(f.n(), 1, `${name} must not be repeated`);
    }
  });
});

describe("the API client's createRepo", () => {
  let platform;
  before(async () => {
    platform = await fakePlatform();
  });
  after(async () => {
    await platform.close();
  });

  const seeded = { name: "r", seedFrom: "convert" };
  const cases = [
    ["a name and a seed: fresh defaults to false and no policy is sent", ["r", "convert"], { ...seeded, fresh: false }],
    ["fresh", ["r", "convert", true], { ...seeded, fresh: true }],
    ["a policy is sent as given", ["r", "convert", true, { pipeline: false }], { ...seeded, fresh: true, policy: { pipeline: false } }],
    ["a policy without fresh", ["r", "convert", false, { pipeline: false }], { ...seeded, fresh: false, policy: { pipeline: false } }],
    ["a policy with several fields", ["r", "convert", true, { pipeline: false, verifyTimeoutSeconds: 5 }], { ...seeded, fresh: true, policy: { pipeline: false, verifyTimeoutSeconds: 5 } }],
    ["an empty policy is still sent: what it means is the Worker's to say", ["r", "convert", true, {}], { ...seeded, fresh: true, policy: {} }],
    ["an undefined policy is not sent", ["r", "convert", true, undefined], { ...seeded, fresh: true }],
    ["no seed", ["r"], { name: "r", fresh: false }],
  ];
  for (const [name, args, body] of cases) {
    it(name, async () => {
      platform.requests.length = 0;
      const created = await client(platform.url, "tok").createRepo(...args);
      assert.deepEqual(platform.requests, [{ method: "POST", path: "/api/repos", body }]);
      assert.equal(created.repo, "r");
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

function opLog() {
  let seq = 0;
  let at = 1_700_000_000_000;
  const ops = [];
  const add = (kind, txn, data = {}, dtMs = 1000) => {
    ops.push({ seq: ++seq, at: (at += dtMs), kind, txn, agent: txn ? `agent-${txn.slice(-1)}` : null, data });
    return ops;
  };
  return { ops, add };
}

describe("foldTxns", () => {
  it("keeps the last state and reason of each transaction, and counts warnings", () => {
    const { ops, add } = opLog();
    add("txn.open", "t_a", { attempt: 1, intent: "do a", model: "m" });
    add("dup.warning", "t_a", {});
    add("dup.warning", "t_a", {});
    add("conflict.warning", "t_a", {});
    add("txn.submitted", "t_a", { attempt: 1 });
    add("txn.stale", "t_a", { attempt: 1, reason: "stale_read", paths: [{ path: "f.ts", seq: 1, by: "t_p" }] });
    add("txn.open", "t_a", { attempt: 2, intent: "do a", retry: true });
    add("txn.aborted", "t_a", { attempt: 2, reason: "patch_does_not_apply" });
    add("trunk.advanced", null, { seq: 1 });
    const a = foldTxns(ops).get("t_a");
    assert.equal(a.state, "aborted");
    assert.equal(a.reason, "patch_does_not_apply");
    assert.equal(a.attempt, 2);
    assert.equal(a.intent, "do a");
    assert.equal(a.model, "m");
    assert.equal(a.dupWarnings, 2);
    assert.equal(a.conflictWarnings, 1);
    assert.equal(a.stale.length, 1);
    assert.ok(a.endedAt > a.openedAt);
    assert.equal(foldTxns(ops).size, 1);
  });

  it("handles a log that starts in the middle of a transaction", () => {
    const { ops, add } = opLog();
    add("txn.ready", "t_z", { attempt: 2 });
    add("txn.landed", "t_z", { attempt: 2, seq: 9, train: "tr_1" });
    const z = foldTxns(ops).get("t_z");
    assert.deepEqual([z.state, z.attempt, z.seq, z.train, z.intent], ["landed", 2, 9, "tr_1", ""]);
  });
});

describe("report from the recorded e2e:land log", () => {
  const A = "t_muyvqoug28lz";
  const B = "t_muyvqp8vqo5e";
  const C = "t_muyvqps5mhz7";
  const F = "t_muyvqs36f4d2";
  const intents = {
    [A]: "Show three digits by default",
    [B]: "Add an area category",
    [C]: "Add a volume category that relies on two-digit rounding",
  };
  const tasks = [
    { id: "t-precision", group: "G2", intent: intents[A] },
    { id: "cat-area", group: "G1", intent: intents[B] },
    { id: "cat-volume", group: "G1", intent: intents[C] },
    { id: "cat-never", group: "G1", intent: "Never asked for" },
  ];

  it("counts what the log says", () => {
    const r = buildReport({ ops: fixture, tasks: [], repo: "convert" });
    assert.equal(r.txns, 7);
    assert.deepEqual(r.final, { landed: 5, stale: 1, failed: 1 });
    assert.deepEqual(r.landedTasks, [A, B, "t_muyvqs3cis1c", "t_muyvqs360kd2", "t_muyvqs3621r4"]);
    assert.deepEqual(r.aborts, { stale_read: 1, text_conflict: 0, failed_verify: 1, duplicate: 0, protected: 0, max_attempts: 0, agent: {}, other: {} });
    assert.deepEqual(r.trains, { formed: 2, sizes: { 2: 1, 4: 1 }, max: 4, bisected: 1, speculative: { formed: 0, confirmed: 0, discarded: 0 } });
    assert.deepEqual(r.landedPerMinuteBuckets.reduce((a, b) => a + b, 0), 5);
    assert.ok(r.durationMs > 0 && r.durationMs < 60_000);
    assert.ok(r.landedPerMinute > 5);
    assert.equal(r.precision, null);
  });

  it("maps transactions to tasks by intent and finds the stale abort caused by t-precision", () => {
    const r = buildReport({ ops: fixture, tasks, repo: "convert" });
    assert.deepEqual(r.landedTasks.slice(0, 2), ["t-precision", "cat-area"]);
    assert.equal(r.precision.txn, A);
    assert.equal(r.precision.staleAborts, 1);
    // the volume transaction was never retried in this log
    assert.equal(r.precision.landedAfterRetry, 0);
    const byTask = Object.fromEntries(r.outcomes.map((o) => [o.task, o]));
    assert.equal(byTask["cat-volume"].state, "stale");
    assert.equal(byTask["cat-volume"].txn, C);
    assert.equal(byTask["cat-volume"].dupWarned, true);
    assert.equal(byTask["cat-volume"].conflictWarned, true);
    assert.equal(byTask["cat-area"].state, "landed");
    assert.deepEqual(byTask["cat-never"], { task: "cat-never", group: "G1", expect: null, txn: null, state: "not_run", reason: null, attempts: 0, dupWarned: false, conflictWarned: false });
    assert.equal(r.final.failed, 1);
    assert.equal(foldTxns(fixture).get(F).reason, "tests");
  });

  it("prints the numbers and the criteria", () => {
    const r = buildReport({ ops: fixture, tasks, repo: "convert", summary: { repo: "convert", head: "a".repeat(40), seq: 5 } });
    const text = formatReport(r);
    for (const part of [
      "Swarm report: convert  head aaaaaaaa  seq 5",
      "transactions   7   failed 1, landed 5, stale 1",
      "landed         5 tasks: t-precision, cat-area,",
      "not landed     cat-volume stale (stale_read); cat-never not_run",
      "aborts         stale_read 1, text_conflict 0, failed_verify 1, duplicate 0, protected 0, max_attempts 0",
      "trains         2 formed (count x size: 1x2 1x4), largest 4, 1 bisected",
      `t-precision    ${A}: 1 stale aborts caused, 0 landed after the retry`,
      "[FAIL] >= 34 tasks landed: 5 landed",
      "[n/a ] G3 duplicates rejected or warned: no G3 task in this run",
      "[FAIL] >= 5 stale aborts caused by t-precision",
      "[n/a ] final trunk tests green: not checked",
    ]) {
      assert.ok(text.includes(part), `missing ${JSON.stringify(part)} in\n${text}`);
    }
  });
});

describe("report from synthetic logs", () => {
  const P = "t_P";
  const gTasks = [
    { id: "t-precision", group: "G2", intent: "P" },
    { id: "cat-a", group: "G1", intent: "A" },
    { id: "cat-b", group: "G1", intent: "B" },
    { id: "dup-1", group: "G3", intent: "D", expect: "duplicate" },
    { id: "tamper", group: "G5", intent: "T", expect: "reject_protected" },
  ];
  const staleBy = (by, path = "src/format.ts") => ({ paths: [{ path, seq: 1, by }] });

  it("handles an empty log", () => {
    const r = buildReport({ ops: [], tasks: gTasks });
    assert.equal(r.txns, 0);
    assert.equal(r.durationMs, 0);
    assert.equal(r.landedPerMinute, 0);
    assert.deepEqual(r.landedPerMinuteBuckets, []);
    assert.deepEqual(r.final, {});
    assert.deepEqual(r.trains, { formed: 0, sizes: {}, max: 0, bisected: 0, speculative: { formed: 0, confirmed: 0, discarded: 0 } });
    assert.equal(r.precision, null);
    assert.equal(r.outcomes.every((o) => o.state === "not_run"), true);
    assert.match(formatReport(r), /transactions   0   none/);
  });

  for (const [name, details, judge, line] of [
    ["none neutral", ["live", "live", "recorded"], { verdicts: 3, neutral: 0 }, null],
    ["some neutral: Jev did not answer", ["live", "neutral", "neutral"], { verdicts: 3, neutral: 2 }, "judge          2 of 3 verdicts neutral: Jev did not answer, so those changes went to a human"],
    ["no verdicts", [], { verdicts: 0, neutral: 0 }, null],
  ]) {
    it(`counts the judge's neutral verdicts: ${name}`, () => {
      const { ops, add } = opLog();
      for (const [i, detail] of details.entries()) add("judge.verdict", `t_${i}`, { attempt: 1, question: "criterion_1", value: 0.5, confidence: null, detail });
      const r = buildReport({ ops, tasks: gTasks });
      assert.deepEqual(r.judge, judge);
      const text = formatReport(r);
      if (line) assert.ok(text.includes(`${line}\n`), text);
      else assert.ok(!text.includes("judge          "), text);
    });
  }

  it("follows a stale abort by t-precision through to the landed retry", () => {
    const { ops, add } = opLog();
    add("txn.open", P, { attempt: 1, intent: "P" });
    add("txn.open", "t_A", { attempt: 1, intent: "A" });
    add("txn.open", "t_B", { attempt: 1, intent: "B" });
    add("txn.landed", P, { attempt: 1, seq: 1, train: "tr_1" });
    add("txn.stale", "t_A", { attempt: 1, reason: "stale_read", ...staleBy(P) });
    add("txn.stale", "t_B", { attempt: 1, reason: "stale_read", ...staleBy(P) });
    add("txn.open", "t_A", { attempt: 2, intent: "A", retry: true });
    add("txn.landed", "t_A", { attempt: 2, seq: 2, train: "tr_2" });
    add("txn.open", "t_B", { attempt: 2, intent: "B", retry: true });
    add("txn.stale", "t_B", { attempt: 2, reason: "stale_read", ...staleBy("t_A", "src/ui/layout.ts") });
    add("txn.open", "t_B", { attempt: 3, intent: "B", retry: true });
    add("txn.aborted", "t_B", { attempt: 3, reason: "max_attempts", cause: { state: "stale", reason: "stale_read" }, ...staleBy("t_A", "src/ui/layout.ts") });
    const r = buildReport({ ops, tasks: gTasks });
    assert.equal(r.precision.txn, P);
    assert.equal(r.precision.staleAborts, 2);
    assert.equal(r.precision.landedAfterRetry, 1);
    assert.deepEqual(r.precision.caused.map((c) => [c.task, c.landedAfter]), [["cat-a", true], ["cat-b", false]]);
    // four stale endings: three txn.stale ops, and the abort that ran out of tries, which is a stale ending too
    assert.equal(r.aborts.stale_read, 4);
    assert.equal(r.aborts.max_attempts, 1);
    assert.deepEqual(r.final, { landed: 2, aborted: 1 });
    assert.deepEqual(r.landedTasks, ["t-precision", "cat-a"]);
  });

  it("buckets landings per minute and measures the run from the first open to the last end", () => {
    const { ops, add } = opLog();
    add("txn.open", "t_A", { attempt: 1, intent: "A" }, 0);
    add("txn.open", "t_B", { attempt: 1, intent: "B" }, 0);
    add("txn.landed", "t_A", { seq: 1 }, 10_000);
    add("txn.landed", "t_B", { seq: 2 }, 20_000);
    add("txn.open", "t_C", { attempt: 1, intent: "C" }, 0);
    add("txn.landed", "t_C", { seq: 3 }, 100_000);
    add("txn.open", "t_D", { attempt: 1, intent: "D" }, 0);
    add("txn.landed", "t_D", { seq: 4 }, 100_000);
    const r = buildReport({ ops, tasks: [] });
    assert.deepEqual(r.landedPerMinuteBuckets, [2, 0, 1, 1]);
    assert.equal(r.durationMs, 230_000);
    assert.ok(Math.abs(r.landedPerMinute - 4 / (230 / 60)) < 1e-9);
  });

  it("sorts every kind of ending into its cause", () => {
    const { ops, add } = opLog();
    const open = (id, intent) => add("txn.open", id, { attempt: 1, intent });
    open("t_1", "x");
    add("txn.stale", "t_1", { attempt: 1, reason: "text_conflict", paths: [{ path: "src/a.ts" }] });
    open("t_2", "x");
    add("txn.failed", "t_2", { attempt: 1, reason: "tests" });
    open("t_3", "x");
    add("txn.failed", "t_3", { attempt: 1, reason: "criterion_unmet" });
    open("t_4", "x");
    add("txn.rejected", "t_4", { reason: "duplicate_of:t_1" });
    open("t_5", "x");
    add("txn.rejected", "t_5", { reason: "protected", paths: ["test/routes.test.ts"] });
    open("t_6", "x");
    add("txn.rejected", "t_6", { reason: "empty" });
    open("t_7", "x");
    add("txn.aborted", "t_7", { attempt: 1, reason: "patch_does_not_apply" });
    open("t_8", "x");
    add("txn.aborted", "t_8", { attempt: 1, reason: "patch_does_not_apply" });
    open("t_9", "x");
    add("txn.aborted", "t_9", { attempt: 1, reason: "local_tests_fail" });
    open("t_10", "x");
    add("txn.aborted", "t_10", { attempt: 1 });
    open("t_11", "x");
    add("txn.aborted", "t_11", { attempt: 3, reason: "max_attempts", cause: { state: "failed", reason: "tests" } });
    open("t_12", "x");
    add("txn.aborted", "t_12", { attempt: 3, reason: "max_attempts", cause: { state: "failed", reason: "criterion_unmet" } });
    open("t_13", "x");
    add("txn.aborted", "t_13", { attempt: 3, reason: "max_attempts", cause: { state: "stale", reason: "text_conflict" } });
    open("t_14", "x");
    add("txn.needs_human", "t_14", { attempt: 1 });
    const r = buildReport({ ops, tasks: [] });
    assert.deepEqual(r.aborts, {
      stale_read: 0,
      text_conflict: 2,
      failed_verify: 2,
      duplicate: 1,
      protected: 1,
      max_attempts: 3,
      agent: { patch_does_not_apply: 2, local_tests_fail: 1, agent_abort: 1 },
      other: { criterion_unmet: 2, empty: 1 },
    });
    assert.deepEqual(r.final, { stale: 1, failed: 2, rejected: 3, aborted: 7, needs_human: 1 });
  });

  it("reports the G3 and G5 outcomes of each catalogue task, and prefers a landed transaction", () => {
    const { ops, add } = opLog();
    add("txn.open", "t_D1", { attempt: 1, intent: "D" });
    add("dup.warning", "t_D1", {});
    add("txn.aborted", "t_D1", { attempt: 2, reason: "patch_does_not_apply" });
    add("txn.open", "t_D2", { attempt: 1, intent: "D" });
    add("txn.landed", "t_D2", { seq: 1 });
    add("txn.open", "t_T", { attempt: 1, intent: "T" });
    add("txn.rejected", "t_T", { reason: "protected" });
    const byTask = Object.fromEntries(buildReport({ ops, tasks: gTasks }).outcomes.map((o) => [o.task, o]));
    assert.deepEqual([byTask["dup-1"].state, byTask["dup-1"].txn, byTask["dup-1"].expect], ["landed", "t_D2", "duplicate"]);
    assert.deepEqual([byTask.tamper.state, byTask.tamper.reason], ["rejected", "protected"]);
  });

  it("counts trains by size and the bisected ones once", () => {
    const { ops, add } = opLog();
    add("train.formed", null, { train: "tr_1", txns: ["a"] });
    add("train.formed", null, { train: "tr_2", txns: ["a", "b", "c"] });
    add("train.formed", null, { train: "tr_3", txns: ["a"] });
    add("train.bisect", null, { train: "tr_2", probe: ["a"], pass: false });
    add("train.bisect", null, { train: "tr_2", probe: ["b"], pass: true });
    assert.deepEqual(buildReport({ ops, tasks: [] }).trains, { formed: 3, sizes: { 1: 2, 3: 1 }, max: 3, bisected: 1, speculative: { formed: 0, confirmed: 0, discarded: 0 } });
  });

  describe("speculative trains (PLAN.md section 5.6)", () => {
    // tr_1 lands; tr_2 was formed on tr_1's candidate and is confirmed once trunk is its base; tr_3 was formed
    // on tr_2's candidate and discarded when tr_2 lost a member; tr_4 is still waiting when the log ends.
    const speculative = () => {
      const { ops, add } = opLog();
      add("train.formed", null, { train: "tr_1", txns: ["a", "b"], base: "b0" });
      add("train.formed", null, { train: "tr_2", txns: ["c"], base: "c1", after: "tr_1" });
      add("train.done", null, { train: "tr_1", outcome: "landed" });
      add("train.confirmed", null, { train: "tr_2", after: "tr_1" });
      add("train.formed", null, { train: "tr_3", txns: ["d", "e", "f"], base: "c2", after: "tr_2" });
      add("train.bisect", null, { train: "tr_2", probe: ["c"], pass: false });
      add("train.done", null, { train: "tr_3", outcome: "discarded" });
      add("train.done", null, { train: "tr_2", outcome: "landed" });
      add("train.formed", null, { train: "tr_4", txns: ["g"], base: "c3", after: "tr_2" });
      return ops;
    };
    const cases = [
      ["one plain train", [{ kind: "train.formed", data: { train: "t", txns: ["a"], base: "b" } }], { formed: 0, confirmed: 0, discarded: 0 }],
      ["`after: null` is not speculative", [{ kind: "train.formed", data: { train: "t", txns: ["a"], base: "b", after: null } }], { formed: 0, confirmed: 0, discarded: 0 }],
      ["formed, confirmed and discarded each count once", speculative(), { formed: 3, confirmed: 1, discarded: 1 }],
      ["done trains that landed or came up empty are not discards", [{ kind: "train.done", data: { train: "t", outcome: "landed" } }, { kind: "train.done", data: { train: "u", outcome: "empty" } }, { kind: "train.done", data: { train: "v", outcome: "error" } }], { formed: 0, confirmed: 0, discarded: 0 }],
      ["a discard seen without its formation still counts (a log read from the middle)", [{ kind: "train.done", data: { train: "t", outcome: "discarded" } }], { formed: 0, confirmed: 0, discarded: 1 }],
    ];
    for (const [name, ops, want] of cases) {
      it(`counts them: ${name}`, () => {
        const log = ops.map((o, i) => ({ seq: i + 1, at: 1_700_000_000_000 + i, txn: null, ...o }));
        assert.deepEqual(buildReport({ ops: log, tasks: [] }).trains.speculative, want);
      });
    }

    it("speculative trains are counted among the formed trains and their sizes, not on top of them", () => {
      const t = buildReport({ ops: speculative(), tasks: [] }).trains;
      assert.deepEqual([t.formed, t.sizes, t.max, t.bisected], [4, { 1: 2, 2: 1, 3: 1 }, 3, 1]);
    });

    it("appends the speculative numbers to the trains line, and only when there were any", () => {
      const text = formatReport(buildReport({ ops: speculative(), tasks: [] }));
      assert.ok(text.includes("trains         4 formed (count x size: 2x1 1x2 1x3), largest 3, 1 bisected; 3 speculative: 1 confirmed, 1 discarded\n"), text);
      const plain = opLog();
      plain.add("train.formed", null, { train: "tr_1", txns: ["a"] });
      plain.add("train.formed", null, { train: "tr_2", txns: ["b", "c"] });
      const line = formatReport(buildReport({ ops: plain.ops, tasks: [] })).split("\n").find((l) => l.startsWith("trains"));
      assert.equal(line, "trains         2 formed (count x size: 1x1 1x2), largest 2, 0 bisected");
    });

    it("says 0 confirmed and 0 discarded when every speculative train is still waiting", () => {
      const { ops, add } = opLog();
      add("train.formed", null, { train: "tr_1", txns: ["a"], base: "b" });
      add("train.formed", null, { train: "tr_2", txns: ["b"], base: "c", after: "tr_1" });
      const line = formatReport(buildReport({ ops, tasks: [] })).split("\n").find((l) => l.startsWith("trains"));
      assert.equal(line, "trains         2 formed (count x size: 2x1), largest 1, 0 bisected; 1 speculative: 0 confirmed, 0 discarded");
    });
  });
});

describe("the M3 criteria", () => {
  const report = (over = {}) => ({
    landedTasks: Array.from({ length: 34 }, (_, i) => `t${i}`),
    outcomes: [],
    precision: { txn: "t_P", staleAborts: 6, landedAfterRetry: 5 },
    trunk: { pass: true, head: "a".repeat(40), tests: 300 },
    preview: { status: "ok", detail: "200, all 30 landed categories present" },
    ...over,
  });
  const passOf = (r, id) => evaluateCriteria(r).find((c) => c.id === id).pass;
  const row = (task, group, state, reason = null, dupWarned = false) => ({ task, group, state, reason, dupWarned });

  it("lists exactly six criteria in order", () => {
    assert.deepEqual(evaluateCriteria(report()).map((c) => c.id), ["landed", "g3", "g5", "precision", "trunk", "preview"]);
  });

  const table = [
    ["landed", "34 tasks", report(), true],
    ["landed", "33 tasks", report({ landedTasks: report().landedTasks.slice(1) }), false],
    ["g3", "no G3 task", report(), null],
    ["g3", "all rejected as duplicates", report({ outcomes: [row("d1", "G3", "rejected", "duplicate_of:t_1"), row("d2", "G3", "rejected", "duplicate_of:t_2")] }), true],
    ["g3", "warned and aborted", report({ outcomes: [row("d1", "G3", "aborted", "patch_does_not_apply", true)] }), true],
    ["g3", "warned and landed still counts as warned", report({ outcomes: [row("d1", "G3", "landed", null, true)] }), true],
    ["g3", "one slipped through unnoticed", report({ outcomes: [row("d1", "G3", "rejected", "duplicate_of:t_1"), row("d2", "G3", "landed")] }), false],
    ["g3", "rejected for another reason is not a duplicate catch", report({ outcomes: [row("d1", "G3", "rejected", "empty")] }), false],
    ["g5", "no G5 task", report(), null],
    ["g5", "rejected protected", report({ outcomes: [row("x", "G5", "rejected", "protected")] }), true],
    ["g5", "rejected for another reason", report({ outcomes: [row("x", "G5", "rejected", "empty")] }), false],
    ["g5", "landed", report({ outcomes: [row("x", "G5", "landed")] }), false],
    ["precision", "5 landed retries", report(), true],
    ["precision", "4 landed retries", report({ precision: { txn: "t_P", staleAborts: 9, landedAfterRetry: 4 } }), false],
    ["precision", "no t-precision transaction", report({ precision: null }), null],
    ["trunk", "green", report(), true],
    ["trunk", "red", report({ trunk: { pass: false, head: "b".repeat(40), failing: ["x"] } }), false],
    ["trunk", "not checked", report({ trunk: null }), null],
    ["preview", "ok", report(), true],
    ["preview", "unavailable is not a failure", report({ preview: { status: "unavailable", detail: "preview: unavailable (404)" } }), null],
    ["preview", "incomplete", report({ preview: { status: "incomplete", detail: "missing" } }), false],
    ["preview", "error", report({ preview: { status: "error", detail: "boom" } }), false],
    ["preview", "not checked", report({ preview: null }), null],
  ];
  for (const [id, name, r, expected] of table) {
    it(`${id}: ${name}`, () => assert.equal(passOf(r, id), expected));
  }
});

describe("the preview check", () => {
  const answer = (status, body = "") => async () => new Response(body, { status });
  const names = ["Area", "Fish & Chips"];

  it("accepts a 200 that shows every category, HTML-escaped or not", async () => {
    const r = await checkPreview({ apiUrl: "http://x", repo: "convert", head: "abc", categories: names, fetchImpl: answer(200, "<li>Area</li><li>Fish &amp; Chips</li>") });
    assert.deepEqual([r.status, r.categories, r.url], ["ok", 2, "http://x/preview/convert/abc/"]);
    assert.equal((await checkPreview({ apiUrl: "http://x", repo: "c", head: "h", categories: names, fetchImpl: answer(200, "Area Fish & Chips") })).status, "ok");
  });

  it("names the categories a 200 is missing", async () => {
    const r = await checkPreview({ apiUrl: "http://x", repo: "c", head: "h", categories: names, fetchImpl: answer(200, "<li>Area</li>") });
    assert.equal(r.status, "incomplete");
    assert.deepEqual(r.missing, ["Fish & Chips"]);
    assert.match(r.detail, /missing 1 of 2 categories: Fish & Chips/);
  });

  it("treats 404 as unavailable and anything else as an error", async () => {
    assert.equal((await checkPreview({ apiUrl: "http://x", repo: "c", head: "h", categories: names, fetchImpl: answer(404, "nope") })).status, "unavailable");
    const bad = await checkPreview({ apiUrl: "http://x", repo: "c", head: "h", categories: names, fetchImpl: answer(500, "bundle exploded") });
    assert.deepEqual([bad.status, bad.httpStatus], ["error", 500]);
    assert.match(bad.detail, /bundle exploded/);
    const down = await checkPreview({
      apiUrl: "http://x",
      repo: "c",
      head: "h",
      categories: names,
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.deepEqual([down.status, down.detail], ["error", "preview request failed: socket hang up"]);
  });

  it("takes the category names from the landed G1 tasks only", () => {
    const r = { landedTasks: ["t-precision", "cat-area", "cat-power"] };
    assert.deepEqual(landedCategories(r, catalogue), ["Area", "Power"]);
    assert.deepEqual(landedCategories({ landedTasks: [] }, catalogue), []);
  });
});

// A stand-in for the platform that answers just enough for runSwarm: health, repo create and show,
// an empty op log, the store's token endpoint and no preview. The agents are fakes too.
async function fakePlatform() {
  const requests = [];
  const repos = new Set(["convert"]);
  const server = createHttp(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null });
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const repo = /^\/api\/repos\/([^/]+)$/.exec(url.pathname)?.[1];
    if (url.pathname === "/api/health") return send(200, { ok: true });
    if (req.method === "POST" && url.pathname === "/api/repos") {
      repos.add(JSON.parse(raw).name);
      return send(201, { repo: JSON.parse(raw).name, head: "a".repeat(40) });
    }
    if (repo) return repos.has(repo) ? send(200, { repo, head: "a".repeat(40), seq: 0, policy: { verify: "true", verifyTimeoutSeconds: 5 }, counts: {}, inflight: [], heat: [] }) : send(404, { error: "repo is not initialised" });
    if (url.pathname.endsWith("/ops")) return send(200, { ops: [], last: 0 });
    if (url.pathname.startsWith("/v1/repos") && req.method === "POST") return send(200, { token: "x" });
    if (url.pathname.startsWith("/v1/repos")) return send(200, { remote: "http://127.0.0.1:1/none.git" });
    return send(404, { error: "not here" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}

describe("the swarm's worker loop against a fake platform", () => {
  let platform;
  let savedStore;
  before(async () => {
    platform = await fakePlatform();
    savedStore = process.env.RYKE_STORE_URL;
    // verifyTrunk talks to the store; the fake has no git behind it, so that check reports a failure quickly
    process.env.RYKE_STORE_URL = platform.url;
  });
  after(async () => {
    if (savedStore === undefined) delete process.env.RYKE_STORE_URL;
    else process.env.RYKE_STORE_URL = savedStore;
    await platform.close();
  });

  const args = (extra) => parseSwarmArgs(["--api", platform.url, "--token", "tok", ...extra], { RYKE_PORT_OFFSET: "0" });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  it("starts tasks in queue order, never more than N at once, and holds gated tasks until the sloppy ones are done", async () => {
    const wanted = ["cat-pressure", "cat-area", "kelvin-remove", "kelvin-first", "sloppy-b", "sloppy-a", "t-precision", "cat-energy"];
    const opts = args(["--agents", "3", "--tasks", wanted.join(","), "--seed", "9", "--speed", "3", "--contention", "off", "--stub", "--model", "claude-x", "--mode", "claude", "--verify-slots", "1"]);
    const events = [];
    const contexts = new Map();
    let running = 0;
    let peak = 0;
    const runAgent = async (ctx) => {
      contexts.set(ctx.task.id, ctx);
      events.push(`start:${ctx.task.id}`);
      peak = Math.max(peak, ++running);
      await pause(ctx.task.id === "sloppy-a" || ctx.task.id === "sloppy-b" ? 120 : 30);
      running--;
      events.push(`end:${ctx.task.id}`);
      return { task: ctx.task.id, agent: ctx.worker, outcome: "landed", txn: `t_${ctx.task.id}`, attempts: 1, variants: ["v1"] };
    };
    const lines = [];
    const { results } = await runSwarm(opts, { log: (l) => lines.push(l), runAgent });

    assert.equal(results.length, 8);
    assert.equal(new Set(events.filter((e) => e.startsWith("start:"))).size, 8);
    assert.deepEqual(events.slice(0, 3), ["start:t-precision", "start:sloppy-a", "start:sloppy-b"]);
    assert.equal(peak, 3);
    const at = (e) => events.indexOf(e);
    assert.ok(at("start:kelvin-first") > at("end:sloppy-a"), "kelvin-first waited for sloppy-a");
    assert.ok(at("start:kelvin-remove") > at("end:sloppy-a"), "kelvin-remove waited for sloppy-a");
    assert.ok(at("start:cat-area") > at("end:sloppy-b"), "cat-area waited for sloppy-b");
    assert.ok(lines.some((l) => /kelvin-first {2}waiting for sloppy-a to finish/.test(l)));
    assert.match(lines[0], /swarm {5}repo=convert mode=claude auth=auto agents=3 speed=3 contention=off seed=9 tasks=8 api=http:\/\/127\.0\.0\.1:\d+$/);

    // every agent gets the same kind of context, with its own deterministic random stream
    for (const [id, ctx] of contexts) {
      assert.equal(ctx.repo, "convert", id);
      assert.equal(typeof ctx.api.begin, "function");
      assert.equal(ctx.dir, catalogueDir);
      assert.match(ctx.worker, /^agent-0[1-3]$/);
      assert.deepEqual([ctx.speed, ctx.contention, ctx.stub, ctx.model, ctx.auth, ctx.apiUrl, ctx.token], [3, false, true, "claude-x", "auto", platform.url, "tok"], id);
      assert.equal(ctx.rng(), makeRng(seedFor(9, id))(), id);
      assert.equal(ctx.task.id, id);
      assert.equal(typeof ctx.log, "function");
    }
    // a context handed out without --stub or --model leaves the choice to the agent
    const plain = [];
    await runSwarm(args(["--agents", "1", "--tasks", "cat-area"]), { log: () => {}, runAgent: async (ctx) => (plain.push(ctx), { task: ctx.task.id, outcome: "landed" }) });
    assert.deepEqual([plain[0].stub, plain[0].model, plain[0].contention], [undefined, undefined, true]);
  });

  it("checks a CLI mode's login once, before it touches the repo, and stops there when there is none", async () => {
    const saved = process.env.RYKE_STUB_LOGIN;
    process.env.RYKE_STUB_LOGIN = "none";
    try {
      const before = platform.requests.length;
      const lines = [];
      await assert.rejects(
        runSwarm(args(["--mode", "codex", "--stub", "--auth", "subscription", "--agents", "2", "--tasks", "cat-area", "--repo", "never-made"]), { log: (l) => lines.push(l) }),
        (e) => e.name === "AccessError" && /codex is not logged in on this machine/.test(e.message),
      );
      const after = platform.requests.slice(before).map((r) => `${r.method} ${r.path}`);
      assert.deepEqual(after, ["GET /api/health"], "nothing but the health check reached the platform");
      assert.match(lines[0], /mode=codex auth=subscription agents=2/);
    } finally {
      if (saved === undefined) delete process.env.RYKE_STUB_LOGIN;
      else process.env.RYKE_STUB_LOGIN = saved;
    }
  });

  it("gives local test runs to at most --verify-slots agents at a time", async () => {
    const opts = args(["--agents", "2", "--tasks", "cat-area,cat-pressure", "--verify-slots", "1"]);
    const spans = [];
    await runSwarm(opts, {
      log: () => {},
      runAgent: async (ctx) => {
        const started = Date.now();
        await ctx.verify(tmp, { verify: "sleep 0.2", verifyTimeoutSeconds: 10 });
        spans.push([started, Date.now()]);
        return { task: ctx.task.id, outcome: "landed" };
      },
    });
    const [first, second] = spans.sort((a, b) => a[1] - b[1]);
    assert.ok(second[1] - first[1] >= 150, `the second run waited for the first: ${second[1] - first[1]} ms apart`);
  });

  it("records an agent that throws as an error and carries on with the rest", async () => {
    const lines = [];
    const { results } = await runSwarm(args(["--agents", "2", "--tasks", "cat-area,cat-pressure,cat-energy"]), {
      log: (l) => lines.push(l),
      runAgent: async (ctx) => {
        if (ctx.task.id === "cat-pressure") throw new Error("boom\n  with a long\n  stack");
        return { task: ctx.task.id, agent: ctx.worker, outcome: "landed", txn: null };
      },
    });
    assert.deepEqual(results.map((r) => [r.task, r.outcome]).sort(), [["cat-area", "landed"], ["cat-energy", "landed"], ["cat-pressure", "error"]]);
    assert.equal(results.find((r) => r.task === "cat-pressure").error, "boom with a long stack");
    assert.ok(lines.some((l) => /cat-pressure {2}error: boom with a long stack$/.test(l)));
  });

  it("creates a repo that does not exist from the Convert seed, and recreates it with --fresh", async () => {
    const seen = platform.requests.length;
    const run = (extra) => runSwarm(args(["--tasks", "cat-area", "--agents", "1", ...extra]), { log: () => {}, runAgent: async (ctx) => ({ task: ctx.task.id, outcome: "landed" }) });
    await run(["--repo", "fresh-one"]);
    await run(["--repo", "fresh-one"]);
    await run(["--repo", "fresh-one", "--fresh"]);
    const posts = platform.requests.slice(seen).filter((r) => r.method === "POST" && r.path === "/api/repos").map((r) => r.body);
    // the first run creates it, the second finds it, --fresh always recreates it
    assert.deepEqual(posts, [{ name: "fresh-one", seedFrom: "convert", fresh: false }, { name: "fresh-one", seedFrom: "convert", fresh: true }]);
  });

  it("fails before touching anything when the demo has no catalogue or a mode is missing", async () => {
    const seen = platform.requests.length;
    await assert.rejects(runSwarm(args(["--demo", "nope"]), { log: () => {} }), (e) => e instanceof UsageError && /no catalogue at demo\/nope\/tasks\.json/.test(e.message));
    await assert.rejects(runSwarm(args(["--tasks", "cat-area,nope"]), { log: () => {} }), (e) => e instanceof UsageError && /unknown task ids: nope/.test(e.message));
    const touched = platform.requests.slice(seen).filter((r) => r.method === "POST");
    assert.deepEqual(touched, []);
  });

  it("builds the report from whatever the platform's op log says and survives a store without git", async () => {
    const { report, text } = await runSwarm(args(["--tasks", "cat-area", "--agents", "1"]), { log: () => {}, runAgent: async (ctx) => ({ task: ctx.task.id, outcome: "landed" }) });
    assert.equal(report.txns, 0);
    assert.equal(report.trunk.pass, false);
    assert.equal(report.preview.status, "unavailable");
    assert.equal(report.criteria.length, 6);
    assert.match(text, /preview {8}preview: unavailable \(404\)/);
  });
});

describe("swarm arguments", () => {
  const parse = (argv, env = {}) => parseSwarmArgs(argv, env);

  it("has the documented defaults", () => {
    const o = parse([]);
    assert.deepEqual(
      { ...o, verifySlots: typeof o.verifySlots },
      { mode: "scripted", agents: 12, repo: "convert", speed: 4, fresh: false, contention: true, stack: false, tasks: null, json: null, api: "http://127.0.0.1:5173", token: "dev", seed: 42, demo: null, stub: false, model: null, auth: "auto", verifySlots: "number", offset: 0, help: false },
    );
    assert.ok(o.verifySlots >= 1);
  });

  it("reads the port offset, the environment and the flags, in that order of precedence", () => {
    assert.equal(parse([], { RYKE_PORT_OFFSET: "40" }).api, "http://127.0.0.1:5213");
    assert.equal(parse([], { RYKE_PORT_OFFSET: "40" }).offset, 40);
    const env = { RYKE_API_URL: "http://example:1", RYKE_TOKEN: "envtok", RYKE_PORT_OFFSET: "40" };
    assert.deepEqual([parse([], env).api, parse([], env).token], ["http://example:1", "envtok"]);
    const o = parse(["--api", "http://flag:2", "--token", "flagtok", "--mode", "claude", "--agents", "50", "--repo", "demo-2", "--speed", "0.5", "--fresh", "--contention", "off", "--stack", "--tasks", "t-precision, cat-area,", "--json", "out.json", "--seed", "7", "--verify-slots", "3", "--stub", "--model", "claude-x"], env);
    assert.deepEqual(
      [o.api, o.token, o.mode, o.agents, o.repo, o.speed, o.fresh, o.contention, o.stack, o.tasks, o.json, o.seed, o.verifySlots, o.stub, o.model],
      ["http://flag:2", "flagtok", "claude", 50, "demo-2", 0.5, true, false, true, ["t-precision", "cat-area"], "out.json", 7, 3, true, "claude-x"],
    );
  });

  it("takes codex as a mode and the auth of either CLI", () => {
    assert.deepEqual([parse(["--mode", "codex"]).mode, parse(["--mode", "codex"]).auth], ["codex", "auto"]);
    for (const auth of ["subscription", "api-key", "auto"]) assert.equal(parse(["--mode", "claude", "--auth", auth]).auth, auth);
  });

  const bad = [
    [["--mode", "robot"], /--mode must be scripted, claude or codex/],
    [["--auth", "oauth"], /--auth must be subscription, api-key or auto, got oauth/],
    [["--agents", "0"], /--agents must be an integer from 1 to 50/],
    [["--agents", "51"], /--agents must be an integer from 1 to 50/],
    [["--agents", "2.5"], /--agents must be an integer/],
    [["--agents", "many"], /--agents must be an integer/],
    [["--speed", "0"], /--speed must be a positive number/],
    [["--speed=-1"], /--speed must be a positive number/],
    [["--speed", "-1"], /ambiguous/],
    [["--speed", "fast"], /--speed must be a positive number/],
    [["--contention", "maybe"], /--contention must be on or off/],
    [["--seed", "x"], /--seed must be an integer/],
    [["--repo", "Bad Name"], /--repo must match/],
    [["--verify-slots", "0"], /--verify-slots must be a positive integer/],
    [["--nope"], /nope/],
  ];
  for (const [argv, message] of bad) {
    it(`refuses ${argv.join(" ")}`, () => assert.throws(() => parse(argv), (e) => e instanceof UsageError && message.test(e.message)));
  }
});

describe("the ryke command line", () => {
  const capture = () => {
    const out = [];
    const err = [];
    return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s), env: {}, root: ROOT } };
  };

  it("prints usage for nothing and for --help", async () => {
    let c = capture();
    assert.equal(await ryke([], c.io), 2);
    assert.match(c.out.join("\n"), /usage: ryke <command>/);
    c = capture();
    assert.equal(await ryke(["--help"], c.io), 0);
    assert.match(c.out.join("\n"), /recall --agent a/);
  });

  const usage = [
    [["frobnicate"], /unknown command frobnicate/],
    [["--nope"], /nope/],
    [["repo"], /unknown repo command/],
    [["repo", "create", "convert"], /repo create needs a name and --seed/],
    [["repo", "create"], /repo create needs a name and --seed/],
    [["repo", "show"], /repo show needs a name/],
    [["txn"], /txn needs a transaction id/],
    [["approve"], /approve needs a transaction id/],
    [["reject"], /reject needs a transaction id/],
    [["txns", "--state", "bogus"], /--state must be one of/],
    [["recall"], /exactly one of --agent, --model, --txns/],
    [["recall", "--agent", "a", "--model", "m"], /exactly one of --agent, --model, --txns/],
  ];
  for (const [argv, message] of usage) {
    it(`answers a usage error for ${argv.join(" ")}`, async () => {
      const c = capture();
      assert.equal(await ryke(argv, c.io), 2);
      assert.match(c.err.join("\n"), message);
    });
  }

  it("says plainly when nothing listens", async () => {
    // a port that was free a moment ago, so the connection is refused
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    server.close();
    await once(server, "close");
    const c = capture();
    c.io.env = { RYKE_API_URL: `http://127.0.0.1:${port}` };
    assert.equal(await ryke(["repo", "show", "convert"], c.io), 1);
    assert.match(c.err.join("\n"), new RegExp(`nothing is listening at http://127\\.0\\.0\\.1:${port}`));
  });

  it("says bench is not built when harness/bench.mjs is missing, and delegates when it exists", async () => {
    const root = join(tmp, "cli-root");
    await mkdir(join(root, "harness"), { recursive: true });
    let c = capture();
    c.io.root = root;
    assert.equal(await ryke(["bench", "--agents", "10"], c.io), 1);
    assert.match(c.err.join("\n"), /harness\/bench\.mjs is not built yet/);

    const record = join(tmp, "delegated.json");
    for (const [cmd, script, code] of [["bench", "bench.mjs", 3], ["swarm", "swarm.mjs", 0]]) {
      await writeFile(join(root, "harness", script), `import { writeFileSync } from "node:fs"; writeFileSync(process.env.RECORD, JSON.stringify(process.argv.slice(2))); process.exit(${code});`);
      c = capture();
      c.io.root = root;
      c.io.env = { ...process.env, RECORD: record };
      assert.equal(await ryke([cmd, "--agents", "10", "--fresh"], c.io), code, cmd);
      assert.deepEqual(JSON.parse(await readFile(record, "utf8")), ["--agents", "10", "--fresh"], cmd);
    }
  });

  it("catalogue directory exists where the swarm will look for it", () => {
    assert.equal(catalogueDir, join(ROOT, "demo", "convert"));
  });
});
