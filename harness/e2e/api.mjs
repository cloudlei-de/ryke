// `npm run e2e:api` (PLAN.md §13 M1 Accept): the begin -> reads -> submit walkthrough against a fresh
// local stack, done with real `curl` and `git` child processes, so the output is a literal transcript
// that can be pasted into PROGRESS.md. Credentials show up as $RYKE_TOKEN and $FORK_TOKEN.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startStack } from "../../dev/stack.mjs";
import { identity } from "../lib/gitops.mjs";
import { commandLine, redactTokens } from "./lib.mjs";

const run = promisify(execFile);
// This is the API walkthrough, not the evidence gate; as in e2e:land the landing stays deterministic.
process.env.RYKE_JEV = "off";
const log = (line) => console.log(`e2e:api  ${line}`);

const offset = Number(process.env.RYKE_PORT_OFFSET ?? 0);
const stack = await startStack({ offset, fresh: true, quiet: true });
const tmp = await mkdtemp(join(tmpdir(), "ryke-e2e-api-"));
// What the transcript hides, filled in as the walkthrough learns it.
const secrets = { RYKE_TOKEN: stack.token };
const vars = { API: stack.apiUrl };

const show = (argv) => log(`$ ${commandLine(argv, { secrets, vars })}`);
const reply = (res, pick = (j) => j) => log(`  -> ${res.status} ${typeof res.json === "string" ? res.json : JSON.stringify(redactTokens(pick(res.json)))}`);

// `auth`: true sends the stack's token, false none, a string that string (to show a wrong token fails).
// Reads are public (PLAN.md §6.1), so a GET sends no token unless asked to.
async function curl(method, path, { body, auth = method !== "GET" } = {}) {
  const token = auth === true ? stack.token : auth;
  const shown = [
    "curl",
    "-sS",
    ...(method === "GET" ? [] : ["-X", method]),
    `${stack.apiUrl}${path}`,
    ...(token ? ["-H", `Authorization: Bearer ${token}`] : []),
    ...(body === undefined ? [] : ["-H", "content-type: application/json", "-d", JSON.stringify(body)]),
  ];
  show(shown);
  // The status code comes back on its own last line; the transcript shows it as "-> 201".
  const { stdout } = await run("curl", ["-w", "\n%{http_code}", "--max-time", "90", ...shown.slice(1)], { maxBuffer: 32 * 1024 * 1024 });
  const cut = stdout.lastIndexOf("\n");
  const text = stdout.slice(0, cut);
  let json = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: Number(stdout.slice(cut + 1)), json };
}

async function git(...args) {
  show(["git", ...args]);
  const { stdout } = await run("git", args, { env: identity("agent-curl") });
  return stdout.trim();
}

let failed = false;
try {
  const repo = "convert";
  log(`API=${stack.apiUrl}; the bearer token is shown as $RYKE_TOKEN`);

  log("1. create the trunk repo and seed it from demo/convert");
  const created = await curl("POST", "/api/repos", { body: { name: repo, seedFrom: "convert", fresh: true } });
  reply(created);
  assert.equal(created.status, 201);
  assert.match(created.json.head, /^[0-9a-f]{40}$/);

  log("2. reads need no token");
  const summary = await curl("GET", `/api/repos/${repo}`);
  reply(summary, (j) => ({ head: j.head, seq: j.seq, verify: j.policy.verify, counts: j.counts, inflight: j.inflight.length }));
  assert.equal(summary.status, 200);
  assert.equal(summary.json.head, created.json.head);

  log("3. begin a transaction: a private fork of trunk, a token for it, the snapshot it starts from");
  const intent = "Document the rounding rule of formatValue";
  const begun = await curl("POST", `/api/repos/${repo}/txns`, { body: { agent: "agent-curl", model: "curl-walkthrough", intent } });
  reply(begun, (j) => ({ txn: j.txn, state: j.state, attempt: j.attempt, snapshot: j.snapshot, remote: j.remote, token: j.token, warnings: j.warnings.length }));
  assert.equal(begun.status, 201);
  assert.equal(begun.json.state, "open");
  assert.equal(begun.json.snapshot, created.json.head);
  const { txn, remote, token: forkToken } = begun.json;
  assert.match(txn, /^t_/);
  assert.ok(remote && forkToken, "begin returns a remote and a token");
  secrets.FORK_TOKEN = forkToken;
  vars.REMOTE = remote;

  log("4. clone the fork with that token, change one file, push");
  const work = join(tmp, "work");
  vars.WORK = work;
  const auth = `http.extraHeader=Authorization: Bearer ${forkToken}`;
  await git("-c", auth, "clone", "-q", remote, work);
  const comment = "// formatValue rounds to two digits unless the caller asks for more.";
  show(["sed", "-i", `1i ${comment}`, join(work, "src/format.ts")]);
  await run("sed", ["-i", `1i ${comment}`, join(work, "src/format.ts")]);
  await git("-C", work, "commit", "-q", "-a", "-m", intent);
  const pushed = await git("-C", work, "rev-parse", "HEAD");
  log(`  -> ${pushed}`);
  await git("-C", work, "-c", auth, "push", "-q", remote, "HEAD:refs/heads/main");

  log("5. report what the agent read");
  const reads = await curl("POST", `/api/txns/${txn}/reads`, { body: { paths: ["src/format.ts"] } });
  reply(reads);
  assert.equal(reads.status, 200);
  assert.deepEqual([reads.json.recorded, reads.json.staleWarnings], [1, []]);

  log("6. submit the pushed commit");
  const submit = await curl("POST", `/api/txns/${txn}/submit`, { body: { head: pushed } });
  reply(submit);
  assert.equal(submit.status, 200);
  assert.ok(["submitted", "ready", "verifying", "landed"].includes(submit.json.state), `submit answered ${JSON.stringify(submit.json)}`);

  log("7. wait until it has landed (the train verifies the merged tree first)");
  let landed = null;
  for (let i = 0; i < 12 && !landed; i++) {
    const w = await curl("GET", `/api/txns/${txn}/wait?timeout=20`);
    reply(w, (j) => ({ state: j.txn.state, reason: j.txn.reason, changed: j.changed }));
    assert.equal(w.status, 200);
    if (w.json.txn.state === "landed") landed = w.json.txn;
    else assert.ok(["submitted", "ready", "verifying"].includes(w.json.txn.state), `${txn} is ${w.json.txn.state} (${w.json.txn.reason})`);
  }
  assert.ok(landed, `${txn} did not land within four minutes`);

  log("8. the transaction as recorded, and the trunk it produced");
  const detail = await curl("GET", `/api/txns/${txn}`);
  const last = detail.json.attempts?.at(-1);
  reply(detail, (j) => ({ state: j.txn.state, landedSeq: j.txn.landedSeq, reads: last.reads, writes: last.writes }));
  assert.equal(detail.status, 200);
  assert.equal(detail.json.txn.state, "landed");
  assert.ok(detail.json.txn.landedSeq >= 1);
  assert.deepEqual([last.reads, last.writes], [["src/format.ts"], ["src/format.ts"]]);
  const after = await curl("GET", `/api/repos/${repo}`);
  reply(after, (j) => ({ head: j.head, seq: j.seq, counts: j.counts }));
  assert.notEqual(after.json.head, created.json.head, "trunk moved");
  assert.equal(after.json.counts.landed, 1);
  const file = await curl("GET", `/api/repos/${repo}/files?path=src/format.ts`);
  reply(file, (j) => ({ ref: j.ref, path: j.path, firstLine: j.content.split("\n")[0] }));
  assert.equal(file.json.ref, after.json.head);
  assert.equal(file.json.content.split("\n")[0], comment, "trunk's src/format.ts carries the change");

  log("9. a write without the token is refused, and so is a wrong one");
  const anonymous = await curl("POST", `/api/repos/${repo}/txns`, { auth: false, body: { agent: "agent-curl", intent: "No token" } });
  reply(anonymous);
  assert.deepEqual([anonymous.status, anonymous.json], [401, { error: "unauthorized" }]);
  const wrong = await curl("POST", `/api/txns/${txn}/abort`, { auth: "not-the-token", body: { reason: "no" } });
  reply(wrong);
  assert.deepEqual([wrong.status, wrong.json], [401, { error: "unauthorized" }]);

  log("10. an unknown transaction id is a 404, for a read and for a write");
  const unknown = await curl("GET", "/api/txns/t_doesnotexist");
  reply(unknown);
  assert.deepEqual([unknown.status, unknown.json], [404, { error: "unknown transaction t_doesnotexist" }]);
  const unknownWrite = await curl("POST", "/api/txns/t_doesnotexist/reads", { body: { paths: ["src/format.ts"] } });
  reply(unknownWrite);
  assert.deepEqual([unknownWrite.status, unknownWrite.json], [404, { error: "unknown transaction t_doesnotexist" }]);

  log("PASS");
} catch (e) {
  failed = true;
  console.error(`e2e:api  FAIL: ${e.stack ?? e.message}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
  await stack.close();
}
process.exit(failed ? 1 : 0);
