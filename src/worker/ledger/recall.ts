import { matchesAny } from "../../shared/policy";
// Recall planning (PLAN.md §8). Pure: the Ledger feeds it the landed transactions and executes the
// plan through the Runner; nothing here touches git.

export type LandedTxn = {
  id: string;
  agent: string;
  model: string | null;
  landedSeq: number;
  commit: string;
  reads: string[];
  writes: string[];
};
export type RecallSelector = { agent?: string; model?: string; txns?: string[] };
export type RecallPlan = {
  targets: string[];
  dependents: string[];
  order: string[];
  // target id -> path -> dependents that wrote the path after the target, newest first
  cascadeCandidates: Record<string, Record<string, string[]>>;
};

export class RecallError extends Error {
  override name = "RecallError";
}

// Union paths (registries, changelogs) take concurrent additions by design, so touching one does not
// make a transaction depend on another; without this, recalling one category would drag along
// every later category that appended a registry line.
export function planRecall(landed: LandedTxn[], selector: RecallSelector, opts: { union?: string[] } = {}): RecallPlan {
  const union = opts.union ?? [];
  const counts = (p: string) => !matchesAny(union, p);
  // Copy before sorting: callers pass Ledger rows in whatever order they were read.
  const sorted = [...landed].sort((a, b) => a.landedSeq - b.landedSeq);
  const isTarget = selectTargets(sorted, selector);

  const targets = sorted.filter((t) => isTarget(t));
  const dependents: LandedTxn[] = [];
  if (targets.length > 0) {
    // Paths whose content a revert would change: written by a target or by a dependent that the
    // revert drags along. A txn only counts as dependent on a writer that landed before it, which
    // the single in-order pass gives for free because the set only holds earlier writers.
    const tainted = new Set<string>();
    const first = sorted.indexOf(targets[0]!);
    for (const x of sorted.slice(first)) {
      if (isTarget(x)) {
        for (const p of x.writes) if (counts(p)) tainted.add(p);
      } else if (x.reads.some((p) => tainted.has(p)) || x.writes.some((p) => tainted.has(p))) {
        // A read-only dependent still counts: it validated against content the revert removes.
        dependents.push(x);
        for (const p of x.writes) if (counts(p)) tainted.add(p);
      }
    }
  }

  const cascadeCandidates: RecallPlan["cascadeCandidates"] = {};
  for (const t of targets) {
    const byPath: Record<string, string[]> = {};
    // Walking newest first fills each list newest first, which is the order a revert conflict
    // wants to peel dependents off in.
    for (const d of [...dependents].reverse()) {
      if (d.landedSeq <= t.landedSeq) continue;
      for (const p of new Set(d.writes)) if (counts(p)) (byPath[p] ??= []).push(d.id);
    }
    cascadeCandidates[t.id] = byPath;
  }

  return {
    targets: targets.map((t) => t.id),
    dependents: dependents.map((d) => d.id),
    order: targets.map((t) => t.id).reverse(),
    cascadeCandidates,
  };
}

function selectTargets(sorted: LandedTxn[], selector: RecallSelector): (t: LandedTxn) => boolean {
  const given = [selector.agent, selector.model, selector.txns].filter((v) => v !== undefined).length;
  if (given !== 1) throw new RecallError("selector needs exactly one of agent, model or txns");

  if (selector.txns !== undefined) {
    const wanted = new Set(selector.txns);
    const known = new Set(sorted.map((t) => t.id));
    const missing = [...wanted].filter((id) => !known.has(id));
    if (missing.length > 0) throw new RecallError(`txns not landed: ${missing.join(", ")}`);
    return (t) => wanted.has(t.id);
  }
  if (selector.agent !== undefined) return (t) => t.agent === selector.agent;
  return (t) => t.model === selector.model;
}

export function nextCascade(
  plan: RecallPlan,
  target: string,
  conflictPaths: string[],
  reverted: Set<string>,
): string | null {
  const byPath = plan.cascadeCandidates[target];
  if (!byPath) return null;
  // Candidate lists are per path, so "newest" across paths needs the global landed order, which
  // plan.dependents carries.
  const age = new Map(plan.dependents.map((id, i) => [id, i]));
  let best: string | null = null;
  for (const p of conflictPaths) {
    const newestLeft = byPath[p]?.find((id) => !reverted.has(id));
    if (newestLeft !== undefined && (best === null || (age.get(newestLeft) ?? -1) > (age.get(best) ?? -1))) {
      best = newestLeft;
    }
  }
  return best;
}
