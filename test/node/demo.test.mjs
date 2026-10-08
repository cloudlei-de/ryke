// Guards the Convert demo: the seed passes its own tests, the 40-task catalogue is consistent with the
// seed, and tools/check.mjs does what the patch authors and the swarm rely on (checked on a small fixture
// demo built with real git, because the real solution patches are written in a later step).
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listSeedFiles, parseCounts, parseFailures } from "../../demo/convert/tools/check.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const demo = path.join(root, "demo/convert");
const checkScript = path.join(demo, "tools/check.mjs");
const tasks = JSON.parse(fs.readFileSync(path.join(demo, "tasks.json"), "utf8"));
const seedFiles = listSeedFiles(demo);
const seed = new Set(seedFiles);

const G1_IDS = [
  "area", "volume", "speed", "pressure", "energy", "power", "data", "time", "angle", "frequency", "fuel-economy", "force",
  "density", "torque", "illuminance", "radiation", "flow", "acceleration", "cooking", "typography", "shoe-sizes",
  "ring-sizes", "paper-sizes", "astronomy", "viscosity", "currency",
].map((n) => `cat-${n}`);
const IDS = {
  G1: G1_IDS,
  G2: ["t-precision", "t-search", "t-dark", "t-favorites", "t-locale", "t-share"],
  G3: ["dup-speed", "dup-velocity", "dup-kmh"],
  G4: ["kelvin-first", "kelvin-remove"],
  G5: ["tamper-routes"],
  G6: ["sloppy-a", "sloppy-b"],
};
const EXPECT = { G1: "land", G2: "land", G3: "duplicate", G4: "conflict_pair", G5: "reject_protected", G6: "sloppy" };
const policy = JSON.parse(fs.readFileSync(path.join(demo, "ryke.json"), "utf8"));

function runCheck(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [checkScript, ...args], { cwd: root, maxBuffer: 1 << 26 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

const jsonLine = (stdout) => JSON.parse(stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1));

describe("the seed", () => {
  test("passes its own verify command in under 2 seconds", async () => {
    const res = await runCheck(["seed"]);
    assert.equal(res.code, 0, res.stderr);
    const out = jsonLine(res.stdout);
    assert.equal(out.seed, "pass");
    assert.equal(typeof out.ms, "number");
    assert.ok(out.ms < 2000, `took ${out.ms} ms`);
    // A nested `node --test` that silently runs nothing would also exit 0, so insist on a real count.
    assert.ok(out.tests > 50, `only ${out.tests} tests ran`);
  });

  test("ryke.json is the policy PLAN.md section 10.1 asks for", () => {
    assert.deepEqual(policy, {
      protected: ["test/**", "ryke.json"],
      union: ["src/registry.ts", "CHANGELOG.md"],
      verify: "node --test --experimental-strip-types test/*.test.ts",
      verifyTimeoutSeconds: 120,
      human: ["src/payments/**"],
      trainMax: 8,
      preview: { main: "src/index.ts" },
    });
  });

  test("the seed excludes tools, solutions and the catalogue", () => {
    assert.ok(seedFiles.length > 10);
    for (const f of seedFiles) assert.ok(!/^(tools|solutions)\//.test(f) && f !== "tasks.json", f);
    for (const f of ["ryke.json", "CHANGELOG.md", "package.json", "src/index.ts", "src/registry.ts", "src/format.ts", "src/ui/layout.ts", "src/ui/styles.ts", "test/format.test.ts", "test/units.test.ts", "test/routes.test.ts"]) {
      assert.ok(seed.has(f), `seed lacks ${f}`);
    }
  });

  test("registry.ts has exactly one export line per category and ends with a newline", () => {
    const text = fs.readFileSync(path.join(demo, "src/registry.ts"), "utf8");
    assert.ok(text.endsWith("\n"));
    const lines = text.trimEnd().split("\n");
    const names = new Set();
    for (const line of lines) {
      const m = /^export \{ (\w+) \} from "\.\/units\/([\w-]+)\.ts";$/.exec(line);
      assert.ok(m, `not a category line: ${line}`);
      names.add(m[1]);
      assert.ok(seed.has(`src/units/${m[2]}.ts`), `no file for ${line}`);
    }
    assert.equal(names.size, lines.length);
    assert.equal(lines.length, seedFiles.filter((f) => f.startsWith("src/units/")).length);
  });

  test("CHANGELOG.md has the union layout and ends with a newline", () => {
    const text = fs.readFileSync(path.join(demo, "CHANGELOG.md"), "utf8");
    assert.ok(text.startsWith("# Changelog\n\n## Unreleased\n\n- "));
    assert.ok(text.endsWith("\n"));
    assert.ok(text.trimEnd().split("\n").slice(4).every((l) => l.startsWith("- ")));
  });

  test("src is erasable TypeScript with .ts relative imports and no Node built-ins", () => {
    for (const f of seedFiles.filter((p) => p.startsWith("src/") && p.endsWith(".ts"))) {
      const text = fs.readFileSync(path.join(demo, f), "utf8");
      assert.ok(!/\b(enum|namespace)\s+\w+/.test(text), `${f} uses enum or namespace`);
      assert.ok(!/constructor\s*\([^)]*\b(private|public|protected|readonly)\b/.test(text), `${f} uses parameter properties`);
      assert.ok(!/from "node:/.test(text), `${f} imports a Node built-in`);
      for (const m of text.matchAll(/(?:import|export)[^;]*? from "(\.[^"]*)"/g)) assert.ok(m[1].endsWith(".ts"), `${f} imports ${m[1]} without .ts`);
    }
  });

  test("the app has no dependencies and the registry feeds the home page", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(demo, "package.json"), "utf8"));
    assert.equal(pkg.type, "module");
    assert.ok(!pkg.dependencies && !pkg.devDependencies);
    const index = fs.readFileSync(path.join(demo, "src/index.ts"), "utf8");
    assert.ok(index.includes('import * as registry from "./registry.ts"') && index.includes("Object.values(registry)"));
  });

  test("the tamper target in the protected routes test is a single 404 assertion", () => {
    const text = fs.readFileSync(path.join(demo, "test/routes.test.ts"), "utf8");
    assert.equal(text.split('  const res = await get("/c/unknown");\n  assert.equal(res.status, 404);\n').length, 2);
  });
});

describe("tasks.json", () => {
  test("has exactly 40 tasks with unique ids", () => {
    assert.ok(Array.isArray(tasks));
    assert.equal(tasks.length, 40);
    assert.equal(new Set(tasks.map((t) => t.id)).size, 40);
  });

  test("group counts are 26/6/3/2/1/2 and the ids are the specified ones, in order", () => {
    const counts = Object.fromEntries(Object.keys(IDS).map((g) => [g, tasks.filter((t) => t.group === g).length]));
    assert.deepEqual(counts, { G1: 26, G2: 6, G3: 3, G4: 2, G5: 1, G6: 2 });
    for (const [g, ids] of Object.entries(IDS)) {
      assert.deepEqual(tasks.filter((t) => t.group === g).map((t) => t.id), ids, g);
    }
    assert.deepEqual(tasks.map((t) => t.group), tasks.map((t) => t.group).sort(), "tasks are ordered by group");
  });

  const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s !== "");
  const normalized = (p) => typeof p === "string" && p !== "" && !p.startsWith("./") && !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..");

  for (const t of tasks) {
    describe(t.id, () => {
      test("every field is present and well-typed", () => {
        for (const key of ["id", "group", "intent", "solution", "screenshot_description", "expect", "spec"]) {
          assert.equal(typeof t[key], "string", key);
          assert.ok(t[key].trim() !== "", `${key} is empty`);
        }
        assert.ok(isStringList(t.criteria) && t.criteria.length >= 2, "criteria");
        assert.ok(isStringList(t.reads) && t.reads.length >= 1, "reads");
        assert.ok(isStringList(t.writes) && t.writes.length >= 1, "writes");
        assert.ok(isStringList(t.tags) && t.tags.length >= 1, "tags");
        assert.ok(isStringList(t.v2_after), "v2_after");
        assert.ok(t.v2 === null || typeof t.v2 === "string", "v2");
        assert.ok(!t.screenshot_description.includes("\n"), "screenshot_description is one line");
        assert.ok(["land", "reject_protected", "duplicate", "conflict_pair", "sloppy"].includes(t.expect));
        assert.equal(t.expect, EXPECT[t.group]);
        assert.deepEqual(Object.keys(t).filter((k) => !["id", "group", "intent", "criteria", "solution", "v2", "v2_after", "reads", "writes", "screenshot_description", "tags", "agent", "model", "expect", "spec"].includes(k)), []);
      });

      test("solution paths match the id and v2 matches v2_after", () => {
        assert.equal(t.solution, `solutions/${t.id}.patch`);
        if (t.v2 === null) assert.deepEqual(t.v2_after, [], "no v2 means no v2_after");
        else {
          assert.equal(t.v2, `solutions/${t.id}.v2.patch`);
          assert.ok(Array.isArray(t.v2_after));
          for (const id of t.v2_after) assert.ok(tasks.some((o) => o.id === id && o.id !== t.id), `v2_after names unknown task ${id}`);
        }
      });

      test("paths are normalized, reads exist in the seed, writes follow the protection rule", () => {
        for (const p of [...t.reads, ...t.writes]) assert.ok(normalized(p), p);
        assert.equal(new Set(t.writes).size, t.writes.length);
        for (const p of t.reads) assert.ok(seed.has(p), `${p} is not in the seed`);
        const protectedExisting = t.writes.filter((p) => seed.has(p) && /^(test\/|ryke\.json$)/.test(p));
        if (t.expect === "reject_protected") assert.deepEqual(protectedExisting, t.writes);
        else assert.deepEqual(protectedExisting, [], "only the tamper task may modify existing protected files");
      });

      test("the spec names every file the patch touches and points to the authoring rules", () => {
        for (const p of t.writes) assert.ok(t.spec.includes(p), `spec does not mention ${p}`);
        assert.ok(t.spec.includes("solutions/README.md"));
        if (t.v2) assert.ok(/V2 PATCH/.test(t.spec), "spec lacks a v2 section");
      });

      test("agent and model are set exactly for the sloppy tasks", () => {
        if (t.group === "G6") {
          assert.equal(t.agent, "agent-13");
          assert.equal(t.model, "sloppy-v0");
        } else {
          assert.ok(!("agent" in t) && !("model" in t));
        }
      });
    });
  }

  test("G1 tasks add one units file, one test, one registry line and one bullet and all have a v2 after t-precision", () => {
    for (const t of tasks.filter((x) => x.group === "G1")) {
      const name = t.id.slice(4);
      assert.deepEqual([...t.writes].sort(), ["CHANGELOG.md", "src/registry.ts", `src/units/${name}.ts`, `test/${name}.test.ts`].sort(), t.id);
      assert.deepEqual(t.v2_after, ["t-precision"], t.id);
      assert.equal(t.v2, `solutions/${t.id}.v2.patch`);
      const base = ["src/format.ts", "src/ui/layout.ts", "src/registry.ts"];
      const extra = ["cat-area", "cat-volume", "cat-speed"].includes(t.id) ? ["src/units/length.ts"] : [];
      assert.deepEqual(t.reads, [...base, ...extra], t.id);
      assert.equal((t.spec.match(/display v1 "[^"]*", v2 "[^"]*"/g) ?? []).length, 3, `${t.id} lists 3 display checks`);
      assert.ok(t.spec.includes(`export { `) && t.spec.includes(`./units/${name}.ts";`), t.id);
    }
  });

  test("only t-precision, t-locale and the G4 pair among the rest have a v2, built on the right base", () => {
    const withV2 = tasks.filter((t) => t.group !== "G1" && t.v2).map((t) => [t.id, t.v2_after]);
    assert.deepEqual(withV2, [
      ["t-precision", ["t-locale"]],
      ["t-locale", ["t-precision"]],
      ["kelvin-first", ["sloppy-a"]],
      ["kelvin-remove", ["sloppy-a"]],
    ]);
  });

  test("the kelvin pair and sloppy-a edit the same file, and the sloppy patches stay off the union files", () => {
    for (const id of ["kelvin-first", "kelvin-remove", "sloppy-a"]) {
      assert.ok(tasks.find((t) => t.id === id).writes.includes("src/units/temperature.ts"), id);
    }
    assert.ok(tasks.find((t) => t.id === "sloppy-b").writes.includes("src/units/length.ts"));
    for (const t of tasks.filter((x) => ["G4", "G5", "G6"].includes(x.group))) {
      assert.ok(!t.writes.some((p) => policy.union.includes(p)), `${t.id} must not touch union files`);
    }
  });

  test("the four layout and index tasks write the source files their regions live in", () => {
    const ui = ["t-search", "t-dark", "t-favorites", "t-share"].map((id) => tasks.find((t) => t.id === id));
    const src = ui.map((t) => t.writes.filter((p) => p.startsWith("src/")));
    assert.deepEqual(src, [["src/ui/layout.ts"], ["src/ui/layout.ts", "src/ui/styles.ts"], ["src/index.ts", "src/ui/favorites.ts"], ["src/index.ts", "src/ui/share.ts"]]);
  });

  test("duplicate tasks: dup-speed repeats cat-speed, the other two use their own files", () => {
    const get = (id) => tasks.find((t) => t.id === id);
    assert.deepEqual(get("dup-speed").writes, get("cat-speed").writes);
    assert.ok(get("dup-velocity").writes.includes("src/units/velocity.ts"));
    assert.ok(get("dup-kmh").writes.includes("src/units/road-speed.ts"));
  });
});

describe("parseFailures", () => {
  const table = [
    ["empty output", "", []],
    ["tap with passing tests", "ok 1 - fine\nok 2 - also fine\n", []],
    ["tap failure with a nested subtest", "not ok 1 - suite\n    not ok 1 - inner one\n", ["suite", "inner one"]],
    ["tap failure with a trailing directive", "not ok 3 - flaky # TODO later\n", ["flaky"]],
    ["spec failure with timing", "✖ breaks on purpose (0.61ms)\n", ["breaks on purpose"]],
    ["spec summary header is not a test", "✖ failing tests:\n\n✖ one (1.2ms)\n", ["one"]],
    ["the same failure printed twice is listed once", "✖ one (1ms)\n✖ one (1ms)\nnot ok 1 - one\n", ["one"]],
  ];
  for (const [name, output, expected] of table) {
    test(name, () => assert.deepEqual(parseFailures(output), expected));
  }
});

describe("parseCounts", () => {
  const table = [
    ["tap summary", "1..65\n# tests 65\n# suites 0\n# pass 64\n# fail 1\n", { tests: 65, pass: 64, fail: 1 }],
    ["spec summary", "ℹ tests 12\nℹ suites 0\nℹ pass 12\nℹ fail 0\n", { tests: 12, pass: 12, fail: 0 }],
    ["no summary", "something else\n", { tests: null, pass: null, fail: null }],
  ];
  for (const [name, output, expected] of table) {
    test(name, () => assert.deepEqual(parseCounts(output), expected));
  }
});

// ---- tools/check.mjs against a fixture demo ----

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

function copySeed(dir) {
  for (const f of seedFiles) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(demo, f), path.join(dir, f));
  }
}

// Builds a patch by editing a scratch checkout of the seed (optionally after committing `prepare`).
function makePatch(scratch, name, { prepare, edit }) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  copySeed(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
  if (prepare) {
    prepare(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
  }
  edit(dir);
  git(dir, "add", "-A");
  return git(dir, "diff", "--cached", "--no-color");
}

const append = (dir, rel, text) => fs.appendFileSync(path.join(dir, rel), text);
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

function category(name, extraAssert = "") {
  const units = `import type { Category } from "../types.ts";

export const ${name}: Category = {
  id: "${name}",
  name: "${name}",
  base: "u",
  units: [
    { id: "u", name: "Unit", symbol: "u", toBase: (v) => v, fromBase: (v) => v },
    { id: "k", name: "Kilo", symbol: "ku", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
  ],
};
`;
  const spec = `import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.ts";

test("${name} converts one kilo to a thousand units", async () => {
  const res = await worker.fetch(new Request("http://localhost/api/convert?c=${name}&from=k&to=u&v=1"));
  assert.equal(((await res.json()) as { result: number }).result, 1000);${extraAssert}
});
`;
  return { units, spec };
}

function addCategory(name, extraAssert) {
  const { units, spec } = category(name, extraAssert);
  return (dir) => {
    write(dir, `src/units/${name}.ts`, units);
    write(dir, `test/${name}.test.ts`, spec);
    append(dir, "src/registry.ts", `export { ${name} } from "./units/${name}.ts";\n`);
    append(dir, "CHANGELOG.md", `- Add ${name}.\n`);
  };
}

const FILES = (name) => ["CHANGELOG.md", "src/registry.ts", `src/units/${name}.ts`, `test/${name}.test.ts`];

describe("tools/check.mjs on a fixture demo", () => {
  let scratch;
  let fixture; // demo dir with every fixture task
  const fixtureTasks = [];

  const task = (id, over) => ({
    id,
    group: "G2",
    intent: id,
    criteria: ["a", "b"],
    solution: `solutions/${id}.patch`,
    v2: null,
    v2_after: [],
    reads: ["src/format.ts"],
    writes: [],
    screenshot_description: "x",
    tags: ["t"],
    expect: "land",
    spec: "x",
    ...over,
  });

  // A demo dir with the real seed, and only the listed tasks in tasks.json.
  function demoWith(ids) {
    const dir = fs.mkdtempSync(path.join(scratch, "demo-"));
    copySeed(dir);
    fs.cpSync(path.join(fixture, "solutions"), path.join(dir, "solutions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify(fixtureTasks.filter((t) => ids.includes(t.id)), null, 2));
    return dir;
  }

  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ryke-demo-test-"));
    fixture = path.join(scratch, "fixture");
    const sol = path.join(fixture, "solutions");
    fs.mkdirSync(sol, { recursive: true });
    const put = (file, text) => fs.writeFileSync(path.join(sol, file), text);

    // Two categories that both append to the union files; v2 differs from v1 only in the test.
    for (const name of ["alpha", "beta"]) {
      put(`add-${name}.patch`, makePatch(scratch, `p-${name}`, { edit: addCategory(name) }));
      put(`add-${name}.v2.patch`, makePatch(scratch, `p-${name}-v2`, { edit: addCategory(name, "\n  assert.ok(true);") }));
      fixtureTasks.push(task(`add-${name}`, { group: "G1", v2: `solutions/add-${name}.v2.patch`, writes: FILES(name) }));
    }
    // A patch whose test fails.
    put("breaks.patch", makePatch(scratch, "p-breaks", { edit: (d) => write(d, "test/breaks.test.ts", 'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("breaks on purpose", () => assert.equal(1, 2));\n') }));
    fixtureTasks.push(task("breaks", { writes: ["test/breaks.test.ts"] }));
    // A patch made against another version of format.ts: it cannot apply to the seed.
    put("no-apply.patch", makePatch(scratch, "p-noapply", { prepare: (d) => append(d, "src/format.ts", "// somebody else was here\n"), edit: (d) => append(d, "src/format.ts", "// and me\n") }));
    fixtureTasks.push(task("no-apply", { writes: ["src/format.ts"] }));
    // Edits an existing protected file: right for the tamper task, wrong for anything else.
    const tamper = makePatch(scratch, "p-tamper", { edit: (d) => append(d, "test/routes.test.ts", "// loosened\n") });
    put("tamper.patch", tamper);
    put("tamper-liar.patch", tamper);
    fixtureTasks.push(task("tamper", { group: "G5", expect: "reject_protected", writes: ["test/routes.test.ts"] }));
    fixtureTasks.push(task("tamper-liar", { writes: ["test/routes.test.ts"] }));
    // The write set in tasks.json does not match the patch.
    put("wrong-writes.patch", makePatch(scratch, "p-ww", { edit: (d) => write(d, "test/extra.test.ts", 'import { test } from "node:test";\ntest("extra", () => {});\n') }));
    fixtureTasks.push(task("wrong-writes", { writes: ["test/other.test.ts"] }));
    // A v2 written against seed + add-alpha (minus the union files): it applies only on that base.
    put(
      "needs-base.v2.patch",
      makePatch(scratch, "p-nb2", {
        prepare: (d) => {
          const { units, spec } = category("alpha");
          write(d, "src/units/alpha.ts", units);
          write(d, "test/alpha.test.ts", spec);
        },
        edit: (d) => {
          append(d, "src/units/alpha.ts", "// based on alpha\n");
          write(d, "test/nb.test.ts", 'import { test } from "node:test";\ntest("nb", () => {});\n');
        },
      }),
    );
    fixtureTasks.push(task("needs-base", { v2: "solutions/needs-base.v2.patch", v2_after: ["add-alpha"], writes: ["src/units/alpha.ts", "test/nb.test.ts"] }));
    // A task whose patch file was never written.
    fixtureTasks.push(task("absent", { writes: ["test/absent.test.ts"] }));
  });

  after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const patchCmd = async (id, ...flags) => {
    const res = await runCheck(["patch", id, "--demo", demoWith(fixtureTasks.map((t) => t.id)), ...flags]);
    return { ...res, out: res.stdout.trim().startsWith("{") ? jsonLine(res.stdout) : null };
  };

  test("patch: a good patch applies to the seed and verifies", async () => {
    const r = await patchCmd("add-alpha");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.out.id, "add-alpha");
    assert.equal(r.out.applied, true);
    assert.equal(r.out.verify, "pass");
    assert.deepEqual(r.out.failures, []);
  });

  test("patch --on: a second patch that appends to the same union files merges with the union driver", async () => {
    const r = await patchCmd("add-beta", "--on", "add-alpha");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.out.verify, "pass");
  });

  test("patch --on with the :v2 suffix applies that variant", async () => {
    const r = await patchCmd("add-beta", "--v2", "--on", "add-alpha:v2");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.out.verify, "pass");
  });

  test("patch --v2 defaults its base to v2_after and fails without it", async () => {
    const withBase = await patchCmd("needs-base", "--v2");
    assert.equal(withBase.code, 0, withBase.stdout + withBase.stderr);
    assert.equal(withBase.out.verify, "pass");
    const wrongBase = await patchCmd("needs-base", "--v2", "--on", "add-beta");
    assert.equal(wrongBase.code, 1);
    assert.equal(wrongBase.out.applied, false);
    assert.match(wrongBase.out.problems[0], /patch does not apply/);
  });

  test("patch: a failing test is reported with its name and a non-zero exit", async () => {
    const r = await patchCmd("breaks");
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(r.out.applied, true);
    assert.equal(r.out.verify, "fail");
    assert.deepEqual(r.out.failures, ["breaks on purpose"]);
  });

  test("patch: a patch that does not apply is reported as not applied", async () => {
    const r = await patchCmd("no-apply");
    assert.equal(r.code, 1);
    assert.equal(r.out.applied, false);
    assert.equal(r.out.verify, "skipped");
  });

  test("patch: editing an existing protected file is right for the tamper task and wrong for others", async () => {
    const ok = await patchCmd("tamper");
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(ok.out.verify, "pass");
    const liar = await patchCmd("tamper-liar");
    assert.equal(liar.code, 1);
    assert.match(liar.out.problems.join(" "), /changes existing protected files: test\/routes\.test\.ts/);
  });

  test("patch: writes in tasks.json must match the files the patch touches", async () => {
    const r = await patchCmd("wrong-writes");
    assert.equal(r.code, 1);
    assert.match(r.out.problems.join(" "), /writes mismatch/);
  });

  test("patch: a patch file that does not exist is missing, and a missing base is reported", async () => {
    const r = await patchCmd("absent");
    assert.equal(r.code, 1);
    assert.equal(r.out.verify, "missing");
    const base = await patchCmd("add-alpha", "--on", "absent");
    assert.equal(base.code, 1);
    assert.equal(base.out.verify, "missing");
    assert.match(base.out.problems[0], /absent is missing/);
  });

  test("patch: unknown ids and a --v2 request without a v2 are usage errors (exit 2)", async () => {
    const unknown = await patchCmd("nope");
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown task nope/);
    const noV2 = await patchCmd("breaks", "--v2");
    assert.equal(noV2.code, 2);
    assert.match(noV2.stderr, /has no v2 patch/);
    const noCmd = await runCheck(["frobnicate"]);
    assert.equal(noCmd.code, 2);
  });

  test("all: good patches pass, the cumulative run merges the union files, missing patches do not fail without --strict", async () => {
    const dir = demoWith(["add-alpha", "add-beta", "tamper", "absent"]);
    const res = await runCheck(["all", "--json", "--demo", dir]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const rows = Object.fromEntries(JSON.parse(res.stdout).map((r) => [r.name, r]));
    for (const name of ["add-alpha", "add-alpha v2", "add-beta", "add-beta v2", "tamper"]) assert.equal(rows[name].status, "pass", name);
    assert.equal(rows.absent.status, "missing");
    assert.equal(rows.integration.status, "pass");
    assert.match(rows.integration.note, /2 patches/);
    assert.equal(rows["recall:cascade"].status, "missing");
    assert.equal(rows["recall:clean"].status, "missing");
  });

  test("all --strict fails on missing patches and prints a table otherwise", async () => {
    const dir = demoWith(["add-alpha", "absent"]);
    const strict = await runCheck(["all", "--strict", "--demo", dir]);
    assert.equal(strict.code, 1);
    assert.match(strict.stdout, /absent\s+missing/);
    assert.match(strict.stdout, /add-alpha\s+pass/);
    assert.match(strict.stdout, /\d+ pass, 0 fail, \d+ missing/);
  });

  test("all: a failing patch fails the run and is listed", async () => {
    const dir = demoWith(["add-alpha", "breaks", "tamper-liar", "wrong-writes", "no-apply"]);
    const res = await runCheck(["all", "--json", "--demo", dir]);
    assert.equal(res.code, 1);
    const rows = Object.fromEntries(JSON.parse(res.stdout).map((r) => [r.name, r]));
    assert.equal(rows["add-alpha"].status, "pass");
    for (const name of ["breaks", "tamper-liar", "wrong-writes", "no-apply"]) assert.equal(rows[name].status, "fail", name);
    assert.match(rows.breaks.note, /breaks on purpose/);
  });
});

describe("solution patches", () => {
  test("every patch applies to the seed and passes, v2s pass on their base, and the integration and recall probes hold", { timeout: 180_000 }, async () => {
    const { stdout } = await new Promise((resolve, reject) =>
      execFile(process.execPath, [checkScript, "all", "--strict", "--json"], { cwd: root, maxBuffer: 1 << 26 }, (error, out, err) =>
        error && !out ? reject(error) : resolve({ stdout: out, stderr: err }),
      ),
    );
    const rows = JSON.parse(stdout);
    const bad = rows.filter((r) => r.status !== "pass");
    assert.deepEqual(bad, []);
    assert.equal(rows.length, 73);
    for (const name of ["integration", "recall:cascade", "recall:clean", "tamper-routes"]) assert.ok(rows.some((r) => r.name === name), `missing row ${name}`);
  });
});
