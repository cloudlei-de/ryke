#!/usr/bin/env node
// PostToolUse on Edit|Write|MultiEdit (PLAN.md §10.4): notes which files the agent edited. The real
// write set still comes from git when the harness commits; this file is the audit trail and tells
// a debugging human which tool call touched what.
import { appendLine, hookMain, repoPath } from "./common.mjs";

export async function handle(input, cfg) {
  const path = repoPath(input.tool_input?.file_path, cfg);
  if (path !== null) appendLine(cfg, "writes.jsonl", { at: Date.now(), tool: input.tool_name, path });
  return null;
}

await hookMain(import.meta.url, handle);
