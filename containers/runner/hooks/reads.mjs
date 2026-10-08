#!/usr/bin/env node
// PostToolUse on Read|Grep|Glob (PLAN.md §10.4): reports what the agent looked at to the Ledger, so
// the read set R exists even though the agent works in its own clone, and hands back the early
// stale warnings of §4.4 as additionalContext.
import { apiCall, appendLine, hasApi, isMain, log, READS_BATCH, postToolUseReply, runHook, staleContext, touchedPaths } from "./common.mjs";

export async function handle(input, cfg) {
  const paths = touchedPaths(input, cfg);
  if (paths.length === 0) return null;
  // Kept locally as well: agent.mjs re-sends the lot before submit, so a reads POST lost to a blip
  // cannot silently shrink the footprint that validation depends on.
  appendLine(cfg, "reads.jsonl", { at: Date.now(), tool: input.tool_name, paths });
  if (!hasApi(cfg)) {
    log("RYKE_API_URL or RYKE_TXN is not set; reads are only recorded locally");
    return null;
  }
  const warnings = new Map();
  for (let i = 0; i < paths.length; i += READS_BATCH) {
    const r = await apiCall(cfg, "POST", `/api/txns/${cfg.txn}/reads`, { paths: paths.slice(i, i + READS_BATCH) });
    for (const w of r?.staleWarnings ?? []) warnings.set(`${w.path}@${w.seq}`, w);
  }
  const text = await staleContext(cfg, [...warnings.values()]);
  return text ? postToolUseReply(text) : null;
}

if (isMain(import.meta.url)) await runHook(handle);
