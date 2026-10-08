#!/usr/bin/env node
// `ryke`: a thin CLI over the public HTTP API (PLAN.md §6.3), for Felix and for scripts.
//   ryke repo create <name> --seed <dir>      ryke repo show <name>
//   ryke txns [--repo convert] [--state s]    ryke txn <id>
//   ryke recall --agent a | --model m | --txns a,b [--dry-run] [--repo convert]
//   ryke approve <id>    ryke reject <id>
//   ryke swarm …         ryke bench …
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ApiError, client } from "./lib/client.mjs";
import { foldTxns } from "./lib/report.mjs";
import { ROOT } from "./lib/tasks.mjs";

const USAGE = `usage: ryke <command> [options]
  repo create <name> --seed <dir>     create a repo seeded from demo/<dir>
  repo show <name>                    head, policy, counts, in-flight work, heat
  txns [--repo convert] [--state s]   one line per transaction
  txn <id>                            everything Ryke knows about one transaction
  recall --agent a | --model m | --txns a,b [--dry-run] [--repo convert]
  approve <id> | reject <id>          decide a needs_human transaction
  swarm …                             run the swarm (see \`ryke swarm --help\`)
  bench …                             run the bench
options: --api URL (default $RYKE_API_URL, else http://127.0.0.1:<5173 + RYKE_PORT_OFFSET>), --token T (default $RYKE_TOKEN, else "dev"), --json`;

class Usage extends Error {}

const STATES = ["open", "submitted", "ready", "verifying", "landed", "stale", "failed", "needs_human", "aborted", "rejected", "recalled"];

function table(rows, header) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length)));
  return all.map((r) => r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function delegate(script, args, env, out) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", env });
    child.on("error", (e) => {
      out(`ryke: could not start ${script}: ${e.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function showRepo(s) {
  const lines = [];
  lines.push(`${s.repo}  head ${s.head.slice(0, 8)}  seq ${s.seq}${s.train ? `  train ${s.train} in flight` : ""}`);
  lines.push(`verify   ${s.policy.verify}`);
  lines.push(`protect  ${s.policy.protected.join(", ")}   union ${s.policy.union.join(", ")}   trainMax ${s.policy.trainMax}`);
  lines.push(`counts   ${Object.entries(s.counts).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "no transactions yet"}`);
  if (s.inflight.length > 0) {
    lines.push("", "in flight");
    for (const t of s.inflight) lines.push(`  ${t.txn}  ${t.agent.padEnd(9)} ${t.state.padEnd(9)} ${clip(t.intent, 60)}  (${t.footprint.length} files)`);
  }
  if (s.heat.length > 0) {
    lines.push("", "heat");
    for (const h of s.heat) lines.push(`  ${h.path.padEnd(32)} ${h.value.toFixed(2)}${h.hot ? "  hot" : ""}`);
  }
  return lines.join("\n");
}

function showTxn(d) {
  const t = d.txn;
  const lines = [`${t.id}  ${t.state}${t.reason ? ` (${t.reason})` : ""}  attempt ${t.attempt}`, `repo ${t.repo}  agent ${t.agent}  model ${t.model ?? "-"}`, `intent   ${t.intent}`];
  if (t.criteria.length > 0) lines.push("criteria", ...t.criteria.map((c) => `  - ${c}`));
  lines.push(`snapshot ${t.snapshot.slice(0, 8)}  head ${t.head?.slice(0, 8) ?? "-"}${d.commit ? `  trunk commit ${d.commit.slice(0, 8)}` : ""}${t.train ? `  train ${t.train}` : ""}`);
  for (const a of d.attempts) lines.push(`attempt ${a.attempt}`, `  reads   ${a.reads.join(", ") || "-"}`, `  writes  ${a.writes.join(", ") || "-"}`);
  if (d.detail.stale?.length) lines.push("stale", ...d.detail.stale.map((p) => `  ${p.path}  seq ${p.seq}${p.by ? `  by ${p.by}` : ""}`));
  for (const e of d.delta) lines.push(`delta ${e.path}`, ...e.patch.split("\n").map((l) => `  ${l}`));
  if (d.verdicts.length > 0) lines.push("verdicts", ...d.verdicts.map((v) => `  attempt ${v.attempt}  ${v.question}  ${v.value}${v.confidence === null ? "" : ` (confidence ${v.confidence})`}`));
  if (d.evidence.length > 0) lines.push("evidence", ...d.evidence.map((e) => `  attempt ${e.attempt}  ${e.kind}: ${e.summary}`));
  return lines.join("\n");
}

// Returns the process exit code. `io` is for tests: where output goes, which environment and repo root to use.
export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.out ?? console.log;
  const err = io.err ?? console.error;
  const env = io.env ?? process.env;
  const root = io.root ?? ROOT;
  const [cmd, ...rest] = argv;
  let apiUrl = "";

  if (cmd === "swarm") return delegate(join(root, "harness/swarm.mjs"), rest, env, err);
  if (cmd === "bench") {
    const script = join(root, "harness/bench.mjs");
    if (!existsSync(script)) {
      err("ryke bench: harness/bench.mjs is not built yet");
      return 1;
    }
    return delegate(script, rest, env, err);
  }

  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          api: { type: "string" },
          token: { type: "string" },
          repo: { type: "string", default: "convert" },
          seed: { type: "string" },
          state: { type: "string" },
          agent: { type: "string" },
          model: { type: "string" },
          txns: { type: "string" },
          "dry-run": { type: "boolean", default: false },
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (e) {
      throw new Usage(e.message);
    }
    const { values, positionals } = parsed;
    if (values.help || positionals.length === 0) {
      out(USAGE);
      return values.help ? 0 : 2;
    }
    const offset = Number(env.RYKE_PORT_OFFSET ?? 0);
    apiUrl = values.api ?? env.RYKE_API_URL ?? `http://127.0.0.1:${5173 + offset}`;
    const api = client(apiUrl, values.token ?? env.RYKE_TOKEN ?? "dev");
    const [command, arg] = positionals;
    const json = (v) => out(JSON.stringify(v, null, 2));
    const need = (what) => {
      if (!arg) throw new Usage(`${command} needs ${what}`);
      return arg;
    };

    if (command === "repo" && arg === "create") {
      const name = positionals[2];
      if (!name || !values.seed) throw new Usage("repo create needs a name and --seed <dir>: ryke repo create convert --seed convert");
      const r = await api.createRepo(name, values.seed);
      if (values.json) json(r);
      else out(`created ${r.repo} from demo/${values.seed} at ${r.head}`);
      return 0;
    }
    if (command === "repo" && arg === "show") {
      const name = positionals[2];
      if (!name) throw new Usage("repo show needs a name");
      const s = await api.repo(name);
      if (values.json) json(s);
      else out(showRepo(s));
      return 0;
    }
    if (command === "repo") throw new Usage(`unknown repo command ${arg ?? ""}; try repo create or repo show`);

    if (command === "txns") {
      if (values.state && !STATES.includes(values.state)) throw new Usage(`--state must be one of ${STATES.join(", ")}`);
      const ops = [];
      for (let after = 0; ; ) {
        const page = await api.ops(values.repo, after, 1000);
        ops.push(...page.ops);
        if (page.ops.length < 1000) break;
        after = page.last;
      }
      const txns = [...foldTxns(ops).values()].filter((t) => !values.state || t.state === values.state).sort((a, b) => a.openedAt - b.openedAt);
      if (values.json) json(txns);
      else if (txns.length === 0) out(`no transactions${values.state ? ` in state ${values.state}` : ""} in ${values.repo}`);
      else {
        out(table(txns.map((t) => [t.id, t.agent, t.state, t.attempt, t.reason ?? "", clip(t.intent, 60)]), ["TXN", "AGENT", "STATE", "ATT", "REASON", "INTENT"]));
        out(`${txns.length} transactions`);
      }
      return 0;
    }
    if (command === "txn") {
      const d = await api.txn(need("a transaction id"));
      if (values.json) json(d);
      else out(showTxn(d));
      return 0;
    }
    if (command === "approve" || command === "reject") {
      const r = await api[command](need("a transaction id"));
      out(`${arg} -> ${r.state}`);
      return 0;
    }
    if (command === "recall") {
      const given = [values.agent && "agent", values.model && "model", values.txns && "txns"].filter(Boolean);
      if (given.length !== 1) throw new Usage("recall needs exactly one of --agent, --model, --txns a,b");
      const selector = values.agent ? { agent: values.agent } : values.model ? { model: values.model } : { txns: values.txns.split(",").map((s) => s.trim()).filter(Boolean) };
      json(await api.recall(values.repo, selector, values["dry-run"]));
      return 0;
    }
    throw new Usage(`unknown command ${command}`);
  } catch (e) {
    if (e instanceof Usage) {
      err(`ryke: ${e.message}\n${USAGE}`);
      return 2;
    }
    // ApiError messages already read "POST /api/… → 404: <body>".
    if (e instanceof ApiError) err(`ryke: ${e.message}`);
    else if (e.cause?.code === "ECONNREFUSED") err(`ryke: nothing is listening at ${apiUrl}; start the platform with \`npm run dev:all\``);
    else err(`ryke: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
