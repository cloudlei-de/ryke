import { StoreError, type Change, type Commit, type RepoRef, type RepoStore } from "./store";

function mapError(e: unknown): never {
  if (e instanceof StoreError) throw e;
  const code = (e as { code?: string }).code ?? "";
  const message = (e as Error).message ?? String(e);
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

  private async tree(repo: ArtifactsRepo, ref: string): Promise<string> {
    const [c] = await repo.log({ ref, limit: 1 });
    if (!c) throw new StoreError("NOT_FOUND", `ref ${ref} does not resolve`);
    return c.treeHash;
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
      const out = new Map<string, string>();
      await this.walk(repo, await this.tree(repo, ref), "", out);
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
      const out: Change[] = [];
      await this.compare(repo, await this.tree(repo, base), await this.tree(repo, head), "", out);
      return out.sort((x, y) => (x.path < y.path ? -1 : 1));
    } catch (e) {
      mapError(e);
    }
  }
}
