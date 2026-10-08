// The delta of an attempt that has already been retried (PLAN.md §12 view 2: "stale paths flagged with the
// delta inline"). The API computes a delta only while the transaction is stale, against the head at that moment.
// Once the agent has retried, the same comparison is still possible from what the op log kept: the stale
// attempt's snapshot and the snapshot the retry started from, both trunk commits. Pure apart from the injected fetch.
import { unifiedDiff } from "../../../shared/diff";
import type { DeltaEntry } from "../../../shared/types";
import type { AttemptRow } from "./format";

// Each path costs two requests, and a stale attempt can name every file it read.
export const MAX_DELTA_PATHS = 8;

export type DeltaRequest = { key: string; before: string; after: string; paths: string[]; omitted: number };
export type FetchFile = (ref: string, path: string) => Promise<string | null>;

// null when there is nothing to compare: the attempt is not a stale one, no retry followed it yet (the API's own
// delta covers the current attempt), or a snapshot is unknown.
export function deltaRequest(rows: readonly AttemptRow[], attempt: number): DeltaRequest | null {
  const row = rows.find((r) => r.attempt === attempt);
  const next = rows.find((r) => r.attempt === attempt + 1);
  if (!row || !next || row.outcome !== "stale" || !row.snapshot || !next.snapshot || row.snapshot === next.snapshot) return null;
  // A stale read lists stale paths, a text conflict the conflicting ones.
  const all = [...new Set([...row.stale.map((p) => p.path), ...row.conflicts])];
  if (all.length === 0) return null;
  const paths = all.slice(0, MAX_DELTA_PATHS);
  return { key: `${row.snapshot}..${next.snapshot} ${paths.join(" ")}`, before: row.snapshot, after: next.snapshot, paths, omitted: all.length - paths.length };
}

// One path failing fails the whole delta: half a delta would read as the full story.
export function computeDelta(req: DeltaRequest, fetchFile: FetchFile): Promise<DeltaEntry[]> {
  return Promise.all(
    req.paths.map(async (path) => {
      const [before, after] = await Promise.all([fetchFile(req.before, path), fetchFile(req.after, path)]);
      return { path, patch: unifiedDiff(path, before, after) };
    }),
  );
}

// GET /api/repos/:repo/files?ref=&path= answers 404 "no file …" for a file that does not exist at that ref, which
// is a legitimate side of a diff (added or deleted). Any other failure, including a 404 for the repo itself, is
// an error, or every file of an unreachable repo would look deleted.
export function fileFetcher(repo: string, fetchImpl: (url: string) => Promise<Response> = (url) => fetch(url)): FetchFile {
  return async (ref, path) => {
    const res = await fetchImpl(`/api/repos/${encodeURIComponent(repo)}/files?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`);
    const body = (await res.json().catch(() => null)) as { content?: unknown; error?: unknown } | null;
    if (res.status === 404 && typeof body?.error === "string" && body.error.startsWith("no file ")) return null;
    if (!res.ok) throw new Error(`GET files answered ${res.status}`);
    if (typeof body?.content !== "string") throw new Error("GET files answered without content");
    return body.content;
  };
}

export type DeltaState = { key: string; status: "ready"; delta: DeltaEntry[] } | { key: string; status: "error"; message: string };
export type DeltaView = { status: "none" | "loading" | "ready" | "error"; delta: DeltaEntry[]; message?: string };

// A result belongs to one comparison; a view that moved to another attempt must not show the last one's.
export function deltaView(request: DeltaRequest | null, loaded: DeltaState | null): DeltaView {
  if (!request) return { status: "none", delta: [] };
  if (!loaded || loaded.key !== request.key) return { status: "loading", delta: [] };
  return loaded.status === "ready" ? { status: "ready", delta: loaded.delta } : { status: "error", delta: [], message: loaded.message };
}
