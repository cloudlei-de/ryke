// A scripted swarm against a real local stack (store, runner, Worker) with real git and real tests:
// the stale-and-retry path, the protected path, the duplicate, the report numbers, the CLI and the
// in-platform demo start. Judgement is off so the run is deterministic.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startStack } from "../../dev/stack.mjs";
import { client } from "../../harness/lib/client.mjs";
import { loadCatalogue, makeRng, seedFor, thinkMs } from "../../harness/lib/tasks.mjs";
import { agentFor, parseSwarmArgs, runSwarm, UsageError } from "../../harness/swarm.mjs";

process.env.RYKE_JEV = "off";

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OFFSET = 200;
const SEED = 42;
const SPEED = 2;
// Ordered by the swarm as t-precision, cat-speed, cat-pressure, tamper-routes, cat-energy, dup-speed.
const TASKS = ["t-precision", "cat-speed", "cat-pressure", "cat-energy", "tamper-routes", "dup-speed"];

let stack;
let api;
let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ryke-swarm-test-"));
  stack = await startStack({ offset: OFFSET, fresh: true, quiet: true });
  api = client(stack.apiUrl, stack.token);
}, { timeout: 120_000 });
after(async () => {
  await stack?.close();
  await rm(tmp, { recursive: true, force: true });
});

const env = () => ({ ...process.env, RYKE_PORT_OFFSET: String(OFFSET), RYKE_API_URL: stack.apiUrl, RYKE_TOKEN: stack.token });
async function node(script, args, extraEnv = {}) {
  const r = await run(process.execPath, [join(ROOT, script), ...args], { env: { ...env(), ...extraEnv }, maxBuffer: 1 << 26 }).catch((e) => e);
  return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const ryke = (...args) => node("harness/ryke.mjs", args);

describe("a small scripted swarm", () => {
  let result;
  let ops;
  const lines = [];
  const byTask = () => Object.fromEntries(result.results.map((r) => [r.task, r]));

  before(async () => {
    const { tasks } = await loadCatalogue("convert");
    // The test leans on t-precision asking for its local test slot well before the categories do.
    const thinks = Object.fromEntries(TASKS.map((id) => [id, thinkMs(makeRng(seedFor(SEED, id)), tasks.find((t) => t.id === id), { speed: SPEED })]));
    assert.ok(thinks["t-precision"] + 1500 < Math.min(thinks["cat-speed"], thinks["cat-pressure"]), `think times ${JSON.stringify(thinks)}`);

    const opts = parseSwarmArgs(
      ["--agents", "3", "--fresh", "--speed", String(SPEED), "--seed", String(SEED), "--verify-slots", "1", "--tasks", TASKS.join(","), "--api", stack.apiUrl, "--token", stack.token],
      { RYKE_PORT_OFFSET: String(OFFSET) },
    );
    result = await runSwarm(opts, { log: (l) => lines.push(l) });
    ops = (await api.ops("convert", 0, 5000)).ops;
  }, { timeout: 240_000 });

  it("lands t-precision, then the categories through a stale abort and the v2 patch", () => {
    const r = byTask();
    assert.deepEqual([r["t-precision"].outcome, r["t-precision"].attempts, r["t-precision"].variants], ["landed", 1, ["v1"]]);
    for (const id of ["cat-speed", "cat-pressure"]) {
      assert.equal(r[id].outcome, "landed", id);
      assert.ok(r[id].attempts >= 2, `${id} took ${r[id].attempts} attempts`);
      assert.equal(r[id].variants[0], "v1", id);
      assert.equal(r[id].variants.at(-1), "v2", id);
    }
    // began after t-precision had landed: v1 applies, fails its tests locally, v2 passes
    assert.deepEqual([r["cat-energy"].outcome, r["cat-energy"].attempts, r["cat-energy"].variants], ["landed", 1, ["v2"]]);
    assert.ok(lines.some((l) => /cat-speed  stale at submit: src\/format\.ts <- t_/.test(l) || /cat-speed  stale \(stale_read\)/.test(l)), "the log shows the stale abort");
    assert.ok(lines.some((l) => /cat-pressure  v1 applied, local tests fail/.test(l)));
    assert.ok(lines.some((l) => /cat-pressure  v2 applied, local tests pass/.test(l)));
  });

  it("rejects the tamper bait as protected", () => {
    const r = byTask()["tamper-routes"];
    assert.deepEqual([r.outcome, r.reason, r.attempts], ["rejected", "protected", 1]);
    assert.ok(lines.some((l) => l.includes("tamper-routes  rejected: protected (test/routes.test.ts)")));
  });

  it("does not land the duplicate speed category", () => {
    const r = byTask()["dup-speed"];
    assert.equal(r.outcome, "aborted");
    assert.ok(["patch_does_not_apply", "local_tests_fail"].includes(r.reason), r.reason);
    assert.ok(lines.some((l) => /dup-speed  warning duplicate of t_/.test(l)), "begin warned about the duplicate");
  });

  it("runs the tasks as the swarm's workers with the scripted model and sends its evidence", async () => {
    const r = byTask();
    for (const id of TASKS) assert.match(r[id].agent, /^agent-0[1-3]$/, id);
    assert.ok(result.results.every((x) => x.model === "scripted-v1"));
    const detail = await api.txn(r["cat-speed"].txn);
    assert.equal(detail.txn.model, "scripted-v1");
    assert.equal(detail.evidence.filter((e) => e.kind === "log").map((e) => e.summary).at(-1), "cat-speed: applied v2, local tests pass");
    assert.match(detail.evidence.find((e) => e.kind === "screenshot").summary, /Speed/);
    assert.ok(detail.attempts.at(-1).reads.includes("src/format.ts"));
  });

  it("reports numbers that match the op log", () => {
    const { report } = result;
    const count = (kind, pick = () => true) => ops.filter((o) => o.kind === kind && pick(o)).length;
    assert.equal(report.txns, 6);
    assert.deepEqual(report.final, { landed: 4, rejected: 1, aborted: 1 });
    assert.equal(report.final.landed, count("txn.landed"));
    assert.deepEqual([...report.landedTasks].sort(), ["cat-energy", "cat-pressure", "cat-speed", "t-precision"]);
    assert.equal(report.aborts.stale_read, count("txn.stale", (o) => o.data.reason === "stale_read"));
    assert.ok(report.aborts.stale_read >= 2);
    assert.equal(report.aborts.text_conflict, 0);
    assert.equal(report.aborts.failed_verify, 0);
    assert.equal(report.aborts.duplicate, 0);
    assert.equal(report.aborts.max_attempts, 0);
    assert.equal(report.aborts.protected, count("txn.rejected", (o) => o.data.reason === "protected"));
    assert.equal(report.aborts.protected, 1);
    assert.deepEqual(Object.values(report.aborts.agent), [1]);
    assert.equal(report.trains.formed, count("train.formed"));
    assert.equal(Object.entries(report.trains.sizes).reduce((n, [size, k]) => n + Number(size) * k, 0), ops.filter((o) => o.kind === "train.formed").reduce((n, o) => n + o.data.txns.length, 0));
    assert.ok(report.durationMs > 0 && report.landedPerMinute > 0);
    assert.equal(report.landedPerMinuteBuckets.reduce((a, b) => a + b, 0), 4);
  });

  it("counts the stale aborts t-precision caused, each followed by a landed retry", () => {
    const { report } = result;
    const precision = report.outcomes.find((o) => o.task === "t-precision").txn;
    const caused = ops.filter((o) => o.kind === "txn.stale" && o.data.paths.some((p) => p.by === precision));
    assert.equal(report.precision.txn, precision);
    assert.equal(report.precision.staleAborts, caused.length);
    assert.equal(report.precision.staleAborts, 2);
    assert.equal(report.precision.landedAfterRetry, 2);
    assert.deepEqual(report.precision.caused.map((c) => c.task).sort(), ["cat-pressure", "cat-speed"]);
  });

  it("finds the trunk green and the preview showing the landed categories", () => {
    const { report } = result;
    assert.equal(report.trunk.pass, true, JSON.stringify(report.trunk));
    assert.equal(report.trunk.head, report.head);
    assert.ok(report.trunk.tests > 100, `${report.trunk.tests} tests`);
    assert.ok(["ok", "unavailable"].includes(report.preview.status), JSON.stringify(report.preview));
    if (report.preview.status === "ok") assert.equal(report.preview.categories, 3);
  });

  it("prints a report that says which M3 criteria hold", () => {
    const { text, report } = result;
    assert.match(text, /Swarm report: convert/);
    assert.match(text, /transactions   6   aborted 1, landed 4, rejected 1/);
    assert.match(text, /\[FAIL\] >= 34 tasks landed: 4 landed/);
    assert.match(text, /\[PASS\] G5 tamper rejected as protected/);
    assert.match(text, /\[PASS\] final trunk tests green/);
    const criteria = Object.fromEntries(report.criteria.map((c) => [c.id, c.pass]));
    // 4 landed, 2 caused by t-precision: far from the full demo's 34 and 5; dup-speed was warned about
    assert.deepEqual([criteria.landed, criteria.g3, criteria.g5, criteria.precision, criteria.trunk], [false, true, true, false, true]);
  });
});

describe("swarm.mjs and swarm.sh as processes", () => {
  it("creates a missing repo, scopes the report to its own run, writes --json without the token", async () => {
    const out = join(tmp, "report.json");
    for (const round of [1, 2]) {
      const r = await node("harness/swarm.mjs", ["--repo", "swarm-new", "--agents", "1", "--speed", "50", "--tasks", "tamper-routes", "--contention", "off", "--json", out, "--api", stack.apiUrl, "--token", stack.token]);
      assert.equal(r.code, 0, r.stderr || r.stdout);
      assert.match(r.stdout, round === 1 ? /repo swarm-new created from demo\/convert at / : /tamper-routes  rejected: protected/);
      assert.match(r.stdout, /G5 +tamper-routes rejected \(protected\)/);
      const json = JSON.parse(await readFile(out, "utf8"));
      // the second run does not count the first run's transaction
      assert.equal(json.report.txns, 1, `round ${round}`);
      assert.equal(json.report.repo, "swarm-new");
      assert.equal(json.opts.contention, false);
      assert.equal("token" in json.opts, false);
      assert.deepEqual(json.results.map((x) => [x.task, x.outcome, x.reason]), [["tamper-routes", "rejected", "protected"]]);
    }
    assert.equal((await api.repo("swarm-new")).counts.rejected, 2);
  });

  it("is what the runner starts: swarm.sh takes the API and token from the environment", async () => {
    const r = await run("bash", [join(ROOT, "containers/runner/bin/swarm.sh"), "--repo", "swarm-new", "--mode", "scripted", "--agents", "1", "--speed", "50", "--tasks", "tamper-routes"], {
      env: { ...env(), RYKE_ROOT: ROOT },
    });
    assert.ok(r.stdout.includes(`swarm     repo=swarm-new mode=scripted agents=1 speed=50 contention=on seed=42 tasks=1 api=${stack.apiUrl}`), r.stdout);
    assert.match(r.stdout, /tamper-routes  rejected: protected/);
  });

  it("fails fast with a clear message when no Ryke answers, and on bad arguments", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    server.close();
    await once(server, "close");
    const down = await node("harness/swarm.mjs", ["--api", `http://127.0.0.1:${port}`]);
    assert.equal(down.code, 2);
    assert.match(down.stderr, new RegExp(`no Ryke API answers at http://127\\.0\\.0\\.1:${port}/api/health`));
    assert.match(down.stderr, /npm run dev:all/);
    assert.match(down.stderr, /--stack/);

    const unknown = await node("harness/swarm.mjs", ["--tasks", "cat-area,nope", "--api", stack.apiUrl]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown task ids: nope/);

    const bad = await node("harness/swarm.mjs", ["--agents", "0"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--agents must be an integer from 1 to 50/);
    assert.match(bad.stderr, /usage: swarm\.mjs/);

    const help = await node("harness/swarm.mjs", ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--stack/);
  });

  it("looks agent modes up by file and says when one is not built", async () => {
    const empty = join(tmp, "no-agents");
    await mkdir(empty, { recursive: true });
    await assert.rejects(agentFor("claude", empty), (e) => e instanceof UsageError && /mode claude is not built yet \(harness\/agents\/claude\.mjs is missing\)/.test(e.message));
    await mkdir(join(empty, "agents"), { recursive: true });
    await writeFile(join(empty, "agents", "claude.mjs"), "export const runTask = async () => 'ran';");
    assert.equal(await (await agentFor("claude", empty))(), "ran");
    await writeFile(join(empty, "agents", "broken.mjs"), "import './missing-dependency.mjs';");
    await assert.rejects(agentFor("broken", empty), (e) => !(e instanceof UsageError));
    assert.equal(typeof (await agentFor("scripted")), "function");
  });
});

describe("the ryke command line against the stack", () => {
  it("shows a repo", async () => {
    const r = await ryke("repo", "show", "convert");
    assert.equal(r.code, 0, r.stderr);
    for (const part of [/^convert  head [0-9a-f]{8}  seq 4/, /verify   node --test --experimental-strip-types test\/\*\.test\.ts/, /protect  test\/\*\*, ryke\.json   union src\/registry\.ts, CHANGELOG\.md   trainMax 8/, /counts   aborted 1, landed 4, rejected 1/]) {
      assert.match(r.stdout, part);
    }
    const json = JSON.parse((await ryke("repo", "show", "convert", "--json")).stdout);
    assert.equal(json.repo, "convert");
    assert.equal(json.seq, 4);
  });

  it("lists transactions, filtered by state", async () => {
    const all = await ryke("txns");
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /^TXN +AGENT +STATE +ATT +REASON +INTENT$/m);
    assert.match(all.stdout, /6 transactions/);
    const landed = await ryke("txns", "--state", "landed");
    assert.match(landed.stdout, /4 transactions/);
    assert.ok(landed.stdout.split("\n").filter((l) => /^t_/.test(l)).every((l) => /\blanded\b/.test(l)));
    assert.match(landed.stdout, /Add the "Speed" converter category/);
    const rejected = await ryke("txns", "--state", "rejected", "--repo", "convert");
    assert.match(rejected.stdout, /rejected +1 +protected +Make the routes test accept a 404/);
    const none = await ryke("txns", "--state", "needs_human");
    assert.equal(none.code, 0);
    assert.match(none.stdout, /no transactions in state needs_human in convert/);
    const json = JSON.parse((await ryke("txns", "--json")).stdout);
    assert.equal(json.length, 6);
  });

  it("shows one transaction, and says so for an unknown one", async () => {
    const rejected = JSON.parse((await ryke("txns", "--state", "rejected", "--json")).stdout)[0];
    const r = await ryke("txn", rejected.id);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^${rejected.id}  rejected \\(protected\\)  attempt 1`));
    assert.match(r.stdout, /agent-0\d  model scripted-v1/);
    assert.match(r.stdout, /writes {2}test\/routes\.test\.ts/);
    assert.match(r.stdout, /evidence/);
    const missing = await ryke("txn", "t_nope");
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /GET \/api\/txns\/t_nope → 404: unknown transaction t_nope/);
  });

  it("prints the HTTP error when a decision is not allowed or needs a token", async () => {
    const landed = JSON.parse((await ryke("txns", "--state", "landed", "--json")).stdout)[0];
    for (const verb of ["approve", "reject"]) {
      const r = await ryke(verb, landed.id);
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`POST /api/txns/${landed.id}/${verb} → 409: .*needs_human`));
    }
    const noToken = await node("harness/ryke.mjs", ["approve", landed.id], { RYKE_TOKEN: "wrong" });
    assert.equal(noToken.code, 1);
    assert.match(noToken.stderr, /→ 401: unauthorized/);
  });

  it("asks for a recall plan and prints whatever the platform answers", async () => {
    for (const args of [["--agent", "agent-13", "--dry-run"], ["--model", "sloppy-v0", "--dry-run"], ["--txns", "t_a,t_b", "--dry-run"]]) {
      const r = await ryke("recall", ...args);
      if (r.code === 0) assert.ok(JSON.parse(r.stdout) !== null, r.stdout);
      else assert.match(r.stderr, /^ryke: POST \/api\/repos\/convert\/recall → \d{3}: /m, r.stderr);
    }
  });

  it("creates a repo, and prints the conflict when it already exists", async () => {
    const created = await ryke("repo", "create", "cli-made", "--seed", "convert");
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /^created cli-made from demo\/convert at [0-9a-f]{40}$/m);
    const again = await ryke("repo", "create", "cli-made", "--seed", "convert");
    assert.equal(again.code, 1);
    assert.match(again.stderr, /POST \/api\/repos → 409: /);
    const bad = await ryke("repo", "create", "Bad_Name", "--seed", "convert");
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /→ 422: name must match/);
  });

  it("delegates swarm and bench", async () => {
    const swarm = await ryke("swarm", "--help");
    assert.equal(swarm.code, 0);
    assert.match(swarm.stdout, /usage: swarm\.mjs/);
    const bench = await ryke("bench", "--help");
    // harness/bench.mjs belongs to another module; either it exists and answers, or the CLI says it is not built
    if (bench.code !== 0) assert.match(bench.stderr, /harness\/bench\.mjs is not built yet/);
  });
});

describe("POST /api/demo/:repo/start", () => {
  const post = (path, body, token = stack.token) =>
    fetch(`${stack.apiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("needs the admin token", async () => {
    for (const token of [null, "wrong"]) {
      const res = await post("/api/demo/convert/start", { mode: "scripted", agents: 3 }, token);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "unauthorized" });
    }
  });

  const invalid = [
    ["not JSON", "{nope", "/api/demo/convert/start"],
    ["a JSON array", [], "/api/demo/convert/start"],
    ["no mode", { agents: 3 }, "/api/demo/convert/start"],
    ["an unknown mode", { mode: "robot", agents: 3 }, "/api/demo/convert/start"],
    ["no agents", { mode: "scripted" }, "/api/demo/convert/start"],
    ["zero agents", { mode: "scripted", agents: 0 }, "/api/demo/convert/start"],
    ["51 agents", { mode: "scripted", agents: 51 }, "/api/demo/convert/start"],
    ["a fraction of an agent", { mode: "scripted", agents: 2.5 }, "/api/demo/convert/start"],
    ["agents as text", { mode: "scripted", agents: "3" }, "/api/demo/convert/start"],
    ["speed zero", { mode: "scripted", agents: 3, speed: 0 }, "/api/demo/convert/start"],
    ["negative speed", { mode: "scripted", agents: 3, speed: -2 }, "/api/demo/convert/start"],
    ["speed as text", { mode: "scripted", agents: 3, speed: "fast" }, "/api/demo/convert/start"],
    ["a repo name with capitals", { mode: "scripted", agents: 3 }, "/api/demo/Bad_Repo/start"],
  ];
  for (const [name, body, path] of invalid) {
    it(`answers 422 for ${name}`, async () => {
      const res = await post(path, body);
      assert.equal(res.status, 422);
      assert.equal(typeof (await res.json()).error, "string");
    });
  }

  it("starts a swarm job that carries the arguments, the API origin and the token", async () => {
    const res = await post("/api/demo/demo-start/start", { mode: "scripted", agents: 1, speed: 1000 });
    assert.equal(res.status, 202);
    const { job } = await res.json();
    assert.match(job, /^j_/);
    const runner = `http://127.0.0.1:${stack.runnerPort}`;
    try {
      let log = "";
      for (const until = Date.now() + 30_000; !log.includes("repo=demo-start") && Date.now() < until; await new Promise((r) => setTimeout(r, 200))) {
        log = await (await fetch(`${runner}/v1/jobs/${job}/log?offset=0`)).text();
      }
      assert.ok(log.includes(`swarm     repo=demo-start mode=scripted agents=1 speed=1000 contention=on seed=42 tasks=40 api=${stack.apiUrl}`), log);
      assert.equal((await (await fetch(`${runner}/v1/jobs/${job}`)).json()).kind, "swarm");
    } finally {
      // the job would now seed a repo and work through all 40 tasks
      await fetch(`${runner}/v1/jobs/${job}`, { method: "DELETE" });
    }
  });

  it("defaults the speed and accepts claude mode (the job itself then says it is not built)", async () => {
    const res = await post("/api/demo/demo-claude/start", { mode: "claude", agents: 50 });
    assert.equal(res.status, 202);
    const { job } = await res.json();
    const runner = `http://127.0.0.1:${stack.runnerPort}`;
    let status;
    for (const until = Date.now() + 30_000; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) {
      status = await (await fetch(`${runner}/v1/jobs/${job}`)).json();
      if (status.state === "done" || status.state === "failed") break;
    }
    const log = await (await fetch(`${runner}/v1/jobs/${job}/log?offset=0`)).text();
    assert.match(log, /agents=50 speed=4 /);
    // harness/agents/claude.mjs belongs to another module: the job either starts working or says it is missing
    if (status.state === "failed") assert.match(log, /mode claude is not built yet/);
    else await fetch(`${runner}/v1/jobs/${job}`, { method: "DELETE" });
  });

  it("answers 503 when the runner cannot be reached", async () => {
    // A Worker with no store and no runner behind it: only the route's own failure path is under test.
    const offset = OFFSET + 1;
    const base = `http://127.0.0.1:${5173 + offset}`;
    const vite = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "dev"], {
      cwd: ROOT,
      env: { ...process.env, RYKE_PORT_OFFSET: String(offset), RYKE_STATE_DIR: join(tmp, "state-lonely") },
      stdio: "ignore",
    });
    try {
      for (let up = false; !up; await new Promise((r) => setTimeout(r, 300))) {
        up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
      }
      const res = await fetch(`${base}/api/demo/convert/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "scripted", agents: 2 }),
      });
      assert.equal(res.status, 503);
      assert.match((await res.json()).error, new RegExp(`runner unreachable at http://127\\.0\\.0\\.1:${8789 + offset}`));
    } finally {
      vite.kill("SIGTERM");
      await once(vite, "exit");
    }
  }, { timeout: 90_000 });
});
