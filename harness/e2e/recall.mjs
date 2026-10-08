// `npm run e2e:recall` (PLAN.md §13 M6 Accept): after a scripted swarm, `recall --model sloppy-v0`
// reverts both G6 transactions, cascades correctly, re-queues the cascaded intents, and the trunk
// tests are green once the re-queued work has landed again.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ROOT, startStack } from "../../dev/stack.mjs";
import { runTask } from "../agents/scripted.mjs";
import { client, waitWhile } from "../lib/client.mjs";
import { Workspace } from "../lib/gitops.mjs";

const run = promisify(execFile);
process.env.RYKE_JEV = process.env.RYKE_JEV ?? "off";
const log = (line) => console.log(`e2e:recall  ${line}`);

const offset = Number(process.env.RYKE_PORT_OFFSET ?? 0);
const stack = await startStack({ offset, fresh: true, quiet: true });
let failed = false;
try {
  const api = client(stack.apiUrl, stack.token);
  const repo = "convert";
  const tasks = JSON.parse(await readFile(join(ROOT, "demo/convert/tasks.json"), "utf8"));
  const byIntent = new Map(tasks.map((t) => [t.intent, t]));

  log("1. scripted swarm (12 agents, speed 4)");
  const swarm = spawn(process.execPath, [join(ROOT, "harness/swarm.mjs"), "--mode", "scripted", "--agents", "12", "--fresh", "--speed", "4", "--repo", repo], {
    env: { ...process.env, RYKE_API_URL: stack.apiUrl, RYKE_TOKEN: stack.token },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const code = await new Promise((r) => swarm.once("exit", r));
  assert.equal(code, 0, "swarm exited non-zero");

  const ops = [];
  for (let after = 0; ; ) {
    const page = await api.ops(repo, after, 5000);
    ops.push(...page.ops);
    if (page.ops.length < 5000) break;
    after = page.last;
  }
  const landedSloppy = [...new Set(ops.filter((o) => o.kind === "txn.landed" && ops.some((x) => x.kind === "txn.open" && x.txn === o.txn && x.data.model === "sloppy-v0")).map((o) => o.txn))];
  assert.equal(landedSloppy.length, 2, `expected both G6 transactions landed, got ${landedSloppy.length}`);
  log(`   G6 landed: ${landedSloppy.join(", ")}`);

  const plan = await api.recall(repo, { model: "sloppy-v0" }, true);
  assert.deepEqual([...plan.plan.targets].sort(), [...landedSloppy].sort());
  log(`2. dry run: targets ${plan.plan.targets.join(", ")}; dependents ${plan.plan.dependents.join(", ") || "none"}`);

  const res = await api.recall(repo, { model: "sloppy-v0" }, false);
  assert.equal(res.outcome, "pass", `recall outcome ${res.outcome}: ${JSON.stringify(res.failures ?? res)}`);
  for (const id of landedSloppy) assert.equal((await api.txn(id)).txn.state, "recalled");
  for (const id of res.cascade) {
    const t = (await api.txn(id)).txn;
    assert.deepEqual([t.state, t.reason], ["recalled", "cascade"]);
    assert.ok(plan.plan.dependents.includes(id), `cascaded ${id} was not a planned dependent`);
  }
  const kept = plan.plan.dependents.filter((d) => !res.cascade.includes(d));
  for (const id of kept) assert.equal((await api.txn(id)).txn.state, "landed", `non-cascaded dependent ${id} must stay landed`);
  assert.equal(res.requeued.length, res.cascade.length);
  log(`3. recalled ${landedSloppy.length} targets; cascade ${res.cascade.join(", ") || "none"}; ${kept.length} dependents stay landed (revalidated by the recall verify)`);

  log(`4. re-queued: ${res.requeued.map((q) => `${q.from} → ${q.txn}`).join(", ") || "none"}`);
  const policy = (await api.repo(repo)).policy;
  for (const q of res.requeued) {
    const detail = await api.txn(q.txn);
    const task = byIntent.get(detail.txn.intent);
    assert.ok(task, `no task for re-queued intent ${detail.txn.intent}`);
    assert.equal(detail.txn.agent, (await api.txn(q.from)).txn.agent, "re-queued for the same agent");
    const begun = { txn: q.txn, state: "open", remote: q.remote, token: q.token, snapshot: q.snapshot, trunk: q.trunk, policy, warnings: [] };
    const out = await runTask({
      api,
      repo,
      task,
      dir: join(ROOT, "demo/convert"),
      worker: detail.txn.agent,
      rng: Math.random,
      speed: 8,
      log: (agent, line) => log(`   ${agent} ${line}`),
      begun,
    });
    assert.equal(out.outcome, "landed", `re-queued ${task.id} ended ${out.outcome} (${out.reason})`);
  }

  const summary = await api.repo(repo);
  const ws = await Workspace.create("checker");
  const store = `http://127.0.0.1:${stack.storePort}`;
  const headers = { "x-ryke-internal": stack.internalSecret, "content-type": "application/json" };
  const { token } = await (await fetch(`${store}/v1/repos/${repo}/tokens`, { method: "POST", headers, body: JSON.stringify({ scope: "read", ttl: 600 }) })).json();
  const { remote } = await (await fetch(`${store}/v1/repos/${repo}`, { headers })).json();
  const head = await ws.fetch(remote, token, "main");
  assert.equal(head, summary.head);
  await ws.checkout(head);
  const verify = await run("bash", ["-c", summary.policy.verify], { cwd: ws.dir, env: { PATH: process.env.PATH, HOME: process.env.HOME } }).catch((e) => e);
  assert.equal(verify.code ?? 0, 0, `trunk tests failed:\n${verify.stdout}\n${verify.stderr}`);
  await ws.remove();
  log(`5. trunk ${head.slice(0, 8)} at seq ${summary.seq}: tests green`);
  log("PASS");
} catch (e) {
  failed = true;
  console.error(`e2e:recall  FAIL: ${e.stack ?? e.message}`);
} finally {
  await stack.close();
}
process.exit(failed ? 1 : 0);
