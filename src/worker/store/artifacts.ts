import { StoreError, type Change, type Commit, type RepoRef, type RepoStore } from "./store";

const KNOWN_CODES = [
  "ALREADY_EXISTS",
  "NOT_FOUND",
  "CREATE_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "FORK_IN_PROGRESS",
  "INVALID_INPUT",
  "INVALID_REPO_NAME",
  "INVALID_TTL",
  "INVALID_URL",
  "REMOTE_AUTH_REQUIRED",
  "UPSTREAM_UNAVAILABLE",
  "MEMORY_LIMIT",
  "INTERNAL_ERROR",
];

// The binding promises `ArtifactsError.code`, but the error crosses an RPC boundary and may arrive as a
// plain Error without it. The text is then all there is: the code spelled out as the name or somewhere in
// the message, or failing that the plain words ("not found", "already exists").
function codeOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && KNOWN_CODES.includes(code)) return code;
  const text = `${(e as { name?: unknown } | null)?.name ?? ""} ${(e as { message?: unknown } | null)?.message ?? ""}`;
  // The first one mentioned wins: "INTERNAL_ERROR: could not find NOT_FOUND marker" is an internal error.
  const mentioned = KNOWN_CODES.filter((c) => text.includes(c)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
  if (mentioned[0]) return mentioned[0];
  if (/\bnot found\b/i.test(text)) return "NOT_FOUND";
  if (/\balready exists\b/i.test(text)) return "ALREADY_EXISTS";
  return "";
}

function mapError(e: unknown): never {
  if (e instanceof StoreError) throw e;
  const code = codeOf(e);
  const message = (e as Error | null)?.message ?? String(e);
  if (code === "NOT_FOUND") throw new StoreError("NOT_FOUND", message);
  if (code === "ALREADY_EXISTS") throw new StoreError("ALREADY_EXISTS", message);
  if (code.startsWith("INVALID")) throw new StoreError("INVALID", message);
  throw new StoreError("UNAVAILABLE", message);
}

function toCommit(c: ArtifactsCommitMetadata): Commit {
  return { sha: c.hash, parents: c.parents, message: c.message, author: `${c.author.name} <${c.author.email}>`, at: c.committedAt * 1000 };
}

// Maps RepoStore 1:1 onto the Artifacts binding (docs/artifacts-notes.md). The binding has no
// diff or listing, so files() and diff() walk trees, skipping subtrees whose hashes match.
export class ArtifactsStore implements RepoStore {
  constructor(private readonly ns: Artifacts) {}

  private async ref(name: string): Promise<RepoRef> {
    using repo = await this.ns.get(name);
    const i = await repo.info();
    return { name: i.name, remote: i.remote, defaultBranch: i.defaultBranch };
  }

  async create(name: string, opts?: { description?: string }): Promise<RepoRef> {
    try {
      await this.ns.create(name, { description: opts?.description, setDefaultBranch: "main" });
      return await this.ref(name);
    } catch (e) {
      mapError(e);
    }
  }

  async fork(source: string, name: string): Promise<RepoRef> {
    try {
      {
        using repo = await this.ns.get(source);
        await repo.fork(name, { defaultBranchOnly: true });
      }
      return await this.ref(name);
    } catch (e) {
      mapError(e);
    }
  }

  async info(name: string): Promise<RepoRef & { head: string | null }> {
    try {
      using repo = await this.ns.get(name);
      const i = await repo.info();
      const [last] = await repo.log({ limit: 1 });
      return { name: i.name, remote: i.remote, defaultBranch: i.defaultBranch, head: last?.hash ?? null };
    } catch (e) {
      mapError(e);
    }
  }

  async remove(name: string): Promise<boolean> {
    try {
      return await this.ns.delete(name);
    } catch (e) {
      mapError(e);
    }
  }

  async token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<string> {
    try {
      using repo = await this.ns.get(name);
      return (await repo.createToken(scope, Math.max(60, ttlSeconds))).plaintext;
    } catch (e) {
      mapError(e);
    }
  }

  async log(name: string, opts: { ref?: string; limit?: number } = {}): Promise<Commit[]> {
    try {
      using repo = await this.ns.get(name);
      return (await repo.log({ ref: opts.ref, limit: opts.limit })).map(toCommit);
    } catch (e) {
      mapError(e);
    }
  }

  async readFile(name: string, ref: string, path: string): Promise<string | null> {
    try {
      using repo = await this.ns.get(name);
      const blob = await repo.readFile({ ref, path });
      return blob === null ? null : await blob.text();
    } catch (e) {
      mapError(e);
    }
  }

  // The tree of the commit `ref` names, or null when it names none.
  private async tree(repo: ArtifactsRepo, ref: string): Promise<string | null> {
    const [c] = await repo.log({ ref, limit: 1 });
    return c?.treeHash ?? null;
  }

  private async walk(repo: ArtifactsRepo, hash: string, prefix: string, out: Map<string, string>): Promise<void> {
    const entries = (await repo.readTree(hash)) ?? [];
    for (const e of entries) {
      const path = prefix + e.name;
      if (e.type === "tree") await this.walk(repo, e.hash, path + "/", out);
      else if (e.type !== "gitlink") out.set(path, e.hash);
    }
  }

  async files(name: string, ref: string): Promise<string[]> {
    try {
      using repo = await this.ns.get(name);
      const tree = await this.tree(repo, ref);
      if (tree === null) {
        // Like the local store: a repo with no commits lists nothing, while an unknown ref in a repo
        // that has history is an error. The binding answers [] for both, so HEAD tells them apart.
        if ((await repo.log({ limit: 1 })).length === 0) return [];
        throw new StoreError("NOT_FOUND", `ref ${ref} does not resolve`);
      }
      const out = new Map<string, string>();
      await this.walk(repo, tree, "", out);
      return [...out.keys()].sort();
    } catch (e) {
      mapError(e);
    }
  }

  private async compare(repo: ArtifactsRepo, a: string | null, b: string | null, prefix: string, out: Change[]): Promise<void> {
    if (a === b) return;
    const left = new Map(((a && (await repo.readTree(a))) || []).map((e) => [e.name, e]));
    const right = new Map(((b && (await repo.readTree(b))) || []).map((e) => [e.name, e]));
    for (const name of new Set([...left.keys(), ...right.keys()])) {
      const l = left.get(name);
      const r = right.get(name);
      const path = prefix + name;
      if (l?.hash === r?.hash && l?.type === r?.type) continue;
      const lt = l?.type === "tree" ? l.hash : null;
      const rt = r?.type === "tree" ? r.hash : null;
      if (lt || rt) await this.compare(repo, lt, rt, path + "/", out);
      const lf = l && l.type !== "tree";
      const rf = r && r.type !== "tree";
      if (lf && rf) out.push({ path, status: "M" });
      else if (lf) out.push({ path, status: "D" });
      else if (rf) out.push({ path, status: "A" });
    }
  }

  async diff(name: string, base: string, head: string): Promise<Change[]> {
    try {
      using repo = await this.ns.get(name);
      const [from, to] = await Promise.all([this.tree(repo, base), this.tree(repo, head)]);
      if (from === null) throw new StoreError("NOT_FOUND", `unknown commit: ${base}`);
      if (to === null) throw new StoreError("NOT_FOUND", `unknown commit: ${head}`);
      const out: Change[] = [];
      await this.compare(repo, from, to, "", out);
      return out.sort((x, y) => (x.path < y.path ? -1 : 1));
    } catch (e) {
      mapError(e);
    }
  }
}
