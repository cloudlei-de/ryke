import { matchesAny, normalizePath } from "../../shared/policy";
import type { Policy } from "../../shared/types";

export type ValidateInput = {
  reads: string[];
  writes: string[];
  // Subset of `writes` that did not exist at the snapshot (git status A). Only the caller can know this.
  created: string[];
  // path -> latest trunk seq (> snapshot seq) that changed it. Keys are already normalised (they come from `changed`).
  changedSinceSnapshot: Map<string, number>;
  policy: Policy;
};

export type ValidateResult =
  | { ok: true; unionTouched: string[] }
  | { ok: false; kind: "empty" }
  | { ok: false; kind: "protected"; paths: string[] }
  | { ok: false; kind: "stale"; paths: { path: string; seq: number }[] };

// Plain code-unit order: deterministic across runtimes, unlike localeCompare.
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Pure by design (PLAN.md §4.3): no git, no clock, so the Ledger can validate hundreds of
// transactions per second. normalizePath throws PolicyError for an empty or escaping path; the
// caller maps that to a 422 rather than this function inventing a fifth result kind.
export function validate(input: ValidateInput): ValidateResult {
  const { policy, changedSinceSnapshot } = input;

  // V6 + V9: one canonical literal form, and a path that is both read and written counts once.
  const reads = new Set(input.reads.map(normalizePath));
  const writes = new Set(input.writes.map(normalizePath));
  const created = new Set(input.created.map(normalizePath));

  // V8
  if (writes.size === 0) return { ok: false, kind: "empty" };

  // V1: new files under a protected glob are fine, so an agent can add a test; changing or
  // deleting one that existed at the snapshot is how an agent would weaken the verifier.
  const protectedPaths = [...writes].filter((p) => !created.has(p) && matchesAny(policy.protected, p)).sort(byPath);
  if (protectedPaths.length > 0) return { ok: false, kind: "protected", paths: protectedPaths };

  // V2 + V3 + V4: reads count as well as writes, because a read of a file that changed underneath
  // the agent is the semantic-conflict case that merges cleanly yet breaks trunk.
  const stale: { path: string; seq: number }[] = [];
  const unionTouched: string[] = [];
  for (const path of new Set([...reads, ...writes])) {
    const seq = changedSinceSnapshot.get(path);
    if (seq === undefined) continue;
    if (matchesAny(policy.union, path)) unionTouched.push(path);
    else stale.push({ path, seq });
  }

  // V5
  if (stale.length > 0) return { ok: false, kind: "stale", paths: stale.sort((a, b) => byPath(a.path, b.path)) };
  return { ok: true, unionTouched: unionTouched.sort(byPath) };
}
