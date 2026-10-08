import { ArtifactsStore } from "./artifacts";
import { LocalStore } from "./local";

export type RepoRef = { name: string; remote: string; defaultBranch: string };
export type Commit = { sha: string; parents: string[]; message: string; author: string; at: number };
export type Change = { path: string; status: "A" | "M" | "D" };

export type StoreErrorCode = "NOT_FOUND" | "ALREADY_EXISTS" | "INVALID" | "UNAVAILABLE";
export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

// PLAN.md §3.1, plus files() and diff(): the Ledger needs the write set (status per path, for V1)
// and directory listings (untracked-read fallback, heat map, previews) without a git checkout.
export interface RepoStore {
  create(name: string, opts?: { description?: string }): Promise<RepoRef>;
  fork(source: string, name: string): Promise<RepoRef>;
  info(name: string): Promise<RepoRef & { head: string | null }>;
  remove(name: string): Promise<boolean>;
  token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<string>;
  log(name: string, opts?: { ref?: string; limit?: number }): Promise<Commit[]>;
  readFile(name: string, ref: string, path: string): Promise<string | null>;
  files(name: string, ref: string): Promise<string[]>;
  diff(name: string, base: string, head: string): Promise<Change[]>;
}

export function storeFor(env: Env): RepoStore {
  if (env.RYKE_STORE === "artifacts") {
    if (!env.ARTIFACTS) throw new StoreError("UNAVAILABLE", "RYKE_STORE=artifacts needs the ARTIFACTS binding");
    return new ArtifactsStore(env.ARTIFACTS);
  }
  return new LocalStore(env.RYKE_STORE_URL, env.RYKE_INTERNAL_SECRET);
}
