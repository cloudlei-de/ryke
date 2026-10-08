// `npm run e2e:land` (PLAN.md §13 M2 Accept), against a fresh local stack:
//  1. seed `convert`;
//  2. two disjoint transactions plus one reading a path the first changes: one train of 2 lands,
//     the third goes stale with the correct delta;
//  3. a train of 4 with one broken transaction: bisection lands 3 and fails 1 with the test name;
//  4. the trunk tests are green.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startStack } from "../../dev/stack.mjs";
import { client, waitWhile } from "../lib/client.mjs";
import { Workspace } from "../lib/gitops.mjs";

const run = promisify(execFile);
// The evidence gate's judgement calls have their own tests; this run checks the landing mechanics.
process.env.RYKE_JEV = "off";

const category = (id, name, factor) => `import type { Category } from "../types.ts";

export const ${id}: Category = {
  id: "${id}",
  name: "${name}",
  base: "a",
  units: [
    { id: "a", name: "A", symbol: "a", toBase: (v) => v, fromBase: (v) => v },
    { id: "b", name: "B", symbol: "b", toBase: (v) => v * ${factor}, fromBase: (v) => v / ${factor} },
  ],
};
`;

const registryLine = (id) => `export { ${id} } from "./units/${id}.ts";\n`;

async function change(api, repo, agent, intent, reads, files) {
  const b = await api.begin(repo, { agent, intent, model: "e2e" });
  assert.equal(b.state, "open", `begin ${intent}: ${JSON.stringify(b)}`);
  if (reads.length) await api.reads(b.txn, reads);
  const ws = await Workspace.create(agent);
  const snapshot = await ws.fetch(b.remote, b.token, "main");
  await ws.checkout(snapshot);
  const registry = files["src/registry.ts"];
  if (registry !== undefined) {
    const current = (await api.files(repo, snapshot, "src/registry.ts")).content;
    files = { ...files, "src/registry.ts": current + registry };
  }
  await ws.write(files);
  const head = await ws.commitAll(intent);
  await ws.push(b.remote, b.token, head);
  await ws.remove();
  return { ...b, head };
}

function log(line) {
  console.log(`e2e:land  ${line}`);
}

const offset = Number(process.env.RYKE_PORT_OFFSET ?? 0);
const stack = await startStack({ offset, fresh: true, quiet: true });
let failed = false;
try {
  const api = client(stack.apiUrl, stack.token);
  const repo = "convert";
  const created = await api.createRepo(repo, "convert", true);
  log(`1. seeded ${repo} at ${created.head.slice(0, 8)}`);

  const a = await change(api, repo, "agent-a", "Show three digits by default", ["src/format.ts"], {
    "src/format.ts": (await api.files(repo, created.head, "src/format.ts")).content.replace("digits = 2", "digits = 3"),
  });
  const b = await change(api, repo, "agent-b", "Add an area category", ["src/ui/layout.ts"], {
    "src/units/area.ts": category("area", "Area", 10000),
    "src/registry.ts": registryLine("area"),
  });
  const c = await change(api, repo, "agent-c", "Add a volume category that relies on two-digit rounding", ["src/format.ts"], {
    "src/units/volume.ts": category("volume", "Volume", 1000),
    "src/registry.ts": registryLine("volume"),
  });
  await Promise.all([api.submit(a.txn), api.submit(b.txn)]);
  const [la, lb] = await Promise.all([waitWhile(api, a.txn, ["submitted", "ready", "verifying"]), waitWhile(api, b.txn, ["submitted", "ready", "verifying"])]);
  assert.equal(la.state, "landed", `a is ${la.state} (${la.reason})`);
  assert.equal(lb.state, "landed", `b is ${lb.state} (${lb.reason})`);
  assert.equal(la.train, lb.train, "a and b landed in one train");
  log(`2. train ${la.train}: ${a.txn} and ${b.txn} landed together at seq ${la.landedSeq}–${lb.landedSeq}`);

  const s = await api.submit(c.txn);
  assert.equal(s.state, "stale");
  assert.equal(s.reason, "stale_read");
  assert.deepEqual(s.paths, [{ path: "src/format.ts", seq: la.landedSeq, by: a.txn }]);
  const detail = await api.txn(c.txn);
  assert.equal(detail.delta.length, 1);
  assert.match(detail.delta[0].patch, /-export function formatValue\(n: number, digits = 2\): string \{/);
  assert.match(detail.delta[0].patch, /\+export function formatValue\(n: number, digits = 3\): string \{/);
  log(`2. ${c.txn} is stale on src/format.ts ← ${a.txn}, delta:\n${detail.delta[0].patch.replace(/^/gm, "            ")}`);

  const four = await Promise.all([
    change(api, repo, "agent-d", "Add a data category", ["src/units/data.ts"], { "src/units/data.ts": category("data", "Data", 8), "src/registry.ts": registryLine("data") }),
    change(api, repo, "agent-e", "Add a time category", ["src/units/time.ts"], { "src/units/time.ts": category("time", "Time", 60), "src/registry.ts": registryLine("time") }),
    change(api, repo, "agent-f", "Add a broken test", ["test/broken.test.ts"], {
      "test/broken.test.ts": 'import assert from "node:assert/strict";\nimport { test } from "node:test";\n\ntest("broken by design", () => {\n  assert.equal(1 + 1, 3);\n});\n',
    }),
    change(api, repo, "agent-g", "Add an angle category", ["src/units/angle.ts"], { "src/units/angle.ts": category("angle", "Angle", 57.29577951308232), "src/registry.ts": registryLine("angle") }),
  ]);
  await Promise.all(four.map((t) => api.submit(t.txn)));
  const ends = await Promise.all(four.map((t) => waitWhile(api, t.txn, ["submitted", "ready", "verifying"])));
  assert.deepEqual(
    ends.map((t) => t.state),
    ["landed", "landed", "failed", "landed"],
    ends.map((t) => `${t.id} ${t.state} ${t.reason}`).join("; "),
  );
  const ops = (await api.ops(repo, 0, 5000)).ops;
  const trainOf4 = ops.find((o) => o.kind === "train.formed" && o.data.txns.length === 4);
  assert.ok(trainOf4, "one train held all four");
  const probes = ops.filter((o) => o.kind === "train.bisect" && o.data.train === trainOf4.data.train);
  assert.ok(probes.length >= 1 && probes.length <= 4, `${probes.length} bisection probes`);
  const broken = await api.txn(four[2].txn);
  const names = (broken.detail.failures ?? []).map((f) => f.name);
  assert.ok(names.some((n) => n.includes("broken by design")), `failures: ${JSON.stringify(broken.detail.failures)}`);
  log(`3. train ${trainOf4.data.train} of 4 failed verify; ${probes.length} probes isolated ${four[2].txn} (failing test "${names[0]}"); 3 landed`);

  const summary = await api.repo(repo);
  const ws = await Workspace.create("checker");
  // The store's control API wants the internal secret the stack was started with.
  const internal = { "x-ryke-internal": stack.internalSecret };
  const token = (await (await fetch(`http://127.0.0.1:${stack.storePort}/v1/repos/${repo}/tokens`, { method: "POST", headers: internal, body: JSON.stringify({ scope: "read", ttl: 600 }) })).json()).token;
  const remote = (await (await fetch(`http://127.0.0.1:${stack.storePort}/v1/repos/${repo}`, { headers: internal })).json()).remote;
  const head = await ws.fetch(remote, token, "main");
  assert.equal(head, summary.head);
  await ws.checkout(head);
  const verify = await run("bash", ["-c", summary.policy.verify], { cwd: ws.dir }).catch((e) => e);
  assert.equal(verify.code ?? 0, 0, `trunk tests failed:\n${verify.stdout}\n${verify.stderr}`);
  const pass = /# pass (\d+)|ℹ pass (\d+)/.exec(verify.stdout);
  await ws.remove();
  log(`4. trunk ${head.slice(0, 8)} at seq ${summary.seq}: \`${summary.policy.verify}\` green (${pass?.[1] ?? pass?.[2]} tests)`);
  if (process.env.RYKE_E2E_DUMP) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(process.env.RYKE_E2E_DUMP, `${JSON.stringify((await api.ops(repo, 0, 5000)).ops, null, 1)}\n`);
    log(`ops written to ${process.env.RYKE_E2E_DUMP}`);
  }
  log("PASS");
} catch (e) {
  failed = true;
  console.error(`e2e:land  FAIL: ${e.stack ?? e.message}`);
} finally {
  await stack.close();
}
process.exit(failed ? 1 : 0);
