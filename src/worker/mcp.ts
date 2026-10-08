import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Res } from "./ledger/ledger";
import { begin, ledger, txnLedger } from "./service";
import { storeFor } from "./store/store";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function result<T>(res: Res<T>): ToolResult {
  if (res.ok) return { content: [{ type: "text", text: JSON.stringify(res.value) }] };
  return { content: [{ type: "text", text: JSON.stringify({ error: res.error, status: res.status, detail: res.detail }) }], isError: true };
}

const unknownTxn = (id: string): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ error: `unknown transaction ${id}`, status: 404 }) }], isError: true });

const READS_RULE =
  "Ryke lands your change only if nothing you READ changed on trunk since your snapshot, so report every file you read; a transaction with no reported reads is treated as having read every file in the directories it wrote, which serialises it against much more work.";

export function mcpServer(env: Env): McpServer {
  const s = new McpServer({ name: "ryke", version: "0.1.0" });

  s.registerTool(
    "ryke_repo",
    {
      description:
        "Call this before starting work. Returns the trunk head and seq, the repo policy (protected paths you must not modify, union paths, the verify command), every in-flight transaction with its intent and live footprint (files read or written), and the hottest files (frequent conflicts). Use it to avoid duplicating or colliding with work already in flight.",
      inputSchema: z.object({ repo: z.string().describe("Repo name, e.g. convert") }),
    },
    async ({ repo }) => result(await ledger(env, repo).summary()),
  );

  s.registerTool(
    "ryke_begin",
    {
      description: `Open a transaction for one unit of work. Returns txn (the id for every other tool), snapshot (the trunk sha your work starts from), remote and token (your private fork: clone it, commit, push to main with header 'Authorization: Bearer <token>'), the policy, and warnings about duplicate or conflicting work in flight. If state is 'rejected' the intent duplicates existing work; do not proceed. ${READS_RULE}`,
      inputSchema: z.object({
        repo: z.string(),
        intent: z.string().describe("What this change does, one sentence"),
        criteria: z.array(z.string()).optional().describe("Acceptance criteria the evidence gate checks"),
        agent: z.string().describe("Your agent id, e.g. agent-07"),
        model: z.string().optional().describe("Model id, used for recall by model"),
      }),
    },
    async ({ repo, intent, criteria, agent, model }) => result(await begin(env, repo, { intent, criteria, agent, model })),
  );

  s.registerTool(
    "ryke_read",
    {
      description: `Read a file as of your transaction's snapshot AND record the read. Use this if you have no git clone. ${READS_RULE}`,
      inputSchema: z.object({ txn: z.string(), path: z.string().describe("Repo-relative path") }),
    },
    async ({ txn, path }) => {
      const stub = await txnLedger(env, txn);
      if (!stub) return unknownTxn(txn);
      const status = await stub.status(txn);
      if (!status.ok) return result(status);
      const recorded = await stub.reads(txn, [path]);
      if (!recorded.ok) return result(recorded);
      const content = await storeFor(env).readFile(status.value.txn.repo, status.value.txn.snapshot, path);
      return result({ ok: true, value: { path, content, staleWarnings: recorded.value.staleWarnings } });
    },
  );

  s.registerTool(
    "ryke_reads",
    {
      description: `Record files you read through your own clone (Read, Grep, Glob results count as reads of the matched files, not the pattern). Batch up to 500 paths per call. Returns staleWarnings: files you read that already changed on trunk; re-read them and adapt. ${READS_RULE}`,
      inputSchema: z.object({ txn: z.string(), paths: z.array(z.string()) }),
    },
    async ({ txn, paths }) => {
      const stub = await txnLedger(env, txn);
      return stub ? result(await stub.reads(txn, paths)) : unknownTxn(txn);
    },
  );

  s.registerTool(
    "ryke_submit",
    {
      description:
        "Call after you pushed your commits to your fork's main. Ryke computes your write set from git, then validates: 'ready' means it will land in the next train; 'stale' means a file you read changed on trunk (call ryke_retry to get the delta); 'rejected' means you modified a protected path or changed nothing.",
      inputSchema: z.object({
        txn: z.string(),
        head: z.string().optional().describe("The commit sha you pushed; optional"),
        summary: z.string().optional().describe("One line on what you did and how you checked it"),
        screenshot: z.string().optional().describe("One line describing what the main page now shows"),
      }),
    },
    async ({ txn, head, summary, screenshot }) => {
      const stub = await txnLedger(env, txn);
      return stub ? result(await stub.submit(txn, { head, evidence: summary || screenshot ? { summary, screenshot } : undefined })) : unknownTxn(txn);
    },
  );

  s.registerTool(
    "ryke_status",
    {
      description: "State of your transaction: open, submitted, ready, verifying, landed, stale (with the stale paths), failed (with failing tests), needs_human, aborted, rejected, recalled. Also returns stale warnings for files you read that changed on trunk.",
      inputSchema: z.object({ txn: z.string() }),
    },
    async ({ txn }) => {
      const stub = await txnLedger(env, txn);
      return stub ? result(await stub.status(txn)) : unknownTxn(txn);
    },
  );

  s.registerTool(
    "ryke_wait",
    {
      description: "Block until your transaction changes state or a stale warning arrives, or the timeout passes (max 60 s). Use it after ryke_submit instead of polling.",
      inputSchema: z.object({ txn: z.string(), timeoutSeconds: z.number().min(0).max(60).default(30) }),
    },
    async ({ txn, timeoutSeconds }) => {
      const stub = await txnLedger(env, txn);
      return stub ? result(await stub.wait(txn, timeoutSeconds * 1000)) : unknownTxn(txn);
    },
  );

  s.registerTool(
    "ryke_retry",
    {
      description:
        "Start a new attempt after 'stale' or 'failed'. Returns the new snapshot sha, the attempt number (max 3), the delta (a unified diff per stale path between your old snapshot and the new one), failing tests if any, and trunk {remote, token} to fetch the new snapshot: rebase or redo your work on it, push to your fork, then ryke_submit again.",
      inputSchema: z.object({ txn: z.string() }),
    },
    async ({ txn }) => {
      const stub = await txnLedger(env, txn);
      return stub ? result(await stub.retry(txn)) : unknownTxn(txn);
    },
  );

  s.registerTool(
    "ryke_abort",
    {
      description: "Give up on the transaction. Nothing of it lands.",
      inputSchema: z.object({ txn: z.string(), reason: z.string() }),
    },
    async ({ txn, reason }) => {
      const stub = await txnLedger(env, txn);
      return stub ? result(await stub.abort(txn, reason)) : unknownTxn(txn);
    },
  );

  return s;
}

export function mcpFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return createMcpHandler(() => mcpServer(env), { route: "/mcp" })(request, env, ctx);
}
