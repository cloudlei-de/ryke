import { StoreError, type Change, type Commit, type RepoRef, type RepoStore, type StoreErrorCode } from "./store";

const CODES: readonly StoreErrorCode[] = ["NOT_FOUND", "ALREADY_EXISTS", "INVALID", "UNAVAILABLE"];

// Client for dev/store, which mirrors the Artifacts binding over HTTP (PLAN.md §3.2). The control API
// can mint push tokens and delete repos, and process-mode jobs run agent code on the same host, so
// every call proves itself with the internal secret the Worker and the store share.
export class LocalStore implements RepoStore {
  constructor(
    private readonly base: string,
    private readonly secret: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(this.secret ? { "x-ryke-internal": this.secret } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new StoreError("UNAVAILABLE", `store unreachable at ${this.base}: ${(e as Error).message}`);
    }
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (!res.ok) {
      const code = CODES.find((c) => c === data?.error?.code) ?? "UNAVAILABLE";
      throw new StoreError(code, data?.error?.message ?? `store answered ${res.status} for ${method} ${path}`);
    }
    return data as T;
  }

  create(name: string, opts?: { description?: string }): Promise<RepoRef> {
    return this.call("POST", "/v1/repos", { name, ...opts });
  }

  fork(source: string, name: string): Promise<RepoRef> {
    return this.call("POST", `/v1/repos/${encodeURIComponent(source)}/fork`, { name });
  }

  info(name: string): Promise<RepoRef & { head: string | null }> {
    return this.call("GET", `/v1/repos/${encodeURIComponent(name)}`);
  }

  async remove(name: string): Promise<boolean> {
    return (await this.call<{ deleted: boolean }>("DELETE", `/v1/repos/${encodeURIComponent(name)}`)).deleted;
  }

  async token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<string> {
    const r = await this.call<{ token: string }>("POST", `/v1/repos/${encodeURIComponent(name)}/tokens`, { scope, ttl: ttlSeconds });
    return r.token;
  }

  async log(name: string, opts: { ref?: string; limit?: number } = {}): Promise<Commit[]> {
    const q = new URLSearchParams();
    if (opts.ref) q.set("ref", opts.ref);
    if (opts.limit) q.set("limit", String(opts.limit));
    return (await this.call<{ commits: Commit[] }>("GET", `/v1/repos/${encodeURIComponent(name)}/log?${q}`)).commits;
  }

  async readFile(name: string, ref: string, path: string): Promise<string | null> {
    const q = new URLSearchParams({ ref, path });
    return (await this.call<{ content: string | null }>("GET", `/v1/repos/${encodeURIComponent(name)}/file?${q}`)).content;
  }

  async files(name: string, ref: string): Promise<string[]> {
    const q = new URLSearchParams({ ref });
    return (await this.call<{ files: string[] }>("GET", `/v1/repos/${encodeURIComponent(name)}/files?${q}`)).files;
  }

  async diff(name: string, base: string, head: string): Promise<Change[]> {
    const q = new URLSearchParams({ base, head });
    return (await this.call<{ changes: Change[] }>("GET", `/v1/repos/${encodeURIComponent(name)}/diff?${q}`)).changes;
  }
}
