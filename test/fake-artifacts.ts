// An in-memory stand-in for the Artifacts binding (worker-configuration.d.ts, docs/artifacts-notes.md),
// so the ArtifactsStore adapter runs in tests although Workers Paid is not available. It keeps real git
// objects (blobs, trees, commits, hashed the way git hashes them), because the adapter relies on tree
// hashes to skip unchanged subtrees. What it does not and cannot prove: that the real service behaves
// like this. The shapes follow the type declarations; the semantics come from their doc comments.
//
// The binding has no write API (every write is a git push), so `commit()` is a test-only door on the
// fake, not part of the binding.

const encoder = new TextEncoder();

export type FileSpec = string | null | { content: string; exec?: boolean } | { symlink: string };

const MODE = { blob: "100644", exec: "100755", symlink: "120000", tree: "40000", gitlink: "160000" } as const;
const TYPE_OF_MODE: Record<string, ArtifactsTreeEntryType> = { "100644": "blob", "100755": "exec", "120000": "symlink", "40000": "tree", "160000": "gitlink" };

// The lib this project compiles against predates Symbol.dispose, but the runtime has it (as `using` needs).
const DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose;

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HASH = /^[0-9a-f]{40}$/;

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const toHex = (bytes: ArrayBuffer | Uint8Array): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

async function hashObject(type: "blob" | "tree" | "commit", body: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-1", concat(encoder.encode(`${type} ${body.length}\0`), body)));
}

type StoredEntry = { name: string; mode: string; hash: string };
type Stored = { kind: "blob"; data: Uint8Array } | { kind: "tree"; entries: StoredEntry[] } | { kind: "commit"; meta: ArtifactsCommitMetadata };

class FakeRepo {
  readonly objects = new Map<string, Stored>();
  // Only the default branch is modelled: it is all the adapter uses.
  head: string | null = null;
  readonly createdAt = new Date().toISOString();
  constructor(
    readonly id: string,
    readonly name: string,
    readonly description: string | null,
    readonly defaultBranch: string,
    readonly source: string | null,
  ) {}
}

// What the adapter sees when something goes wrong. `code` is what the types promise; a real RPC
// boundary may deliver a plain Error without it (the `dropCodes` option), with the code only in the text.
function failure(code: ArtifactsErrorCode, text: string, dropCodes: boolean): Error {
  if (dropCodes) {
    const e = new Error(`${code}: ${text}`);
    e.name = "ArtifactsError";
    return e;
  }
  const e = new Error(text) as Error & { code: ArtifactsErrorCode; numericCode: number };
  e.name = "ArtifactsError";
  e.code = code;
  e.numericCode = 1000;
  return e;
}

export type FakeOptions = { namespace?: string; account?: string; dropCodes?: boolean };

export class FakeArtifacts {
  private readonly repos = new Map<string, FakeRepo>();
  private nextId = 1;
  private clock = 1_700_000_000;
  /** Handles handed out and not yet disposed: a leak shows as a non-zero count after an operation. */
  open = 0;
  /** Every tree hash asked of readTree, in order, to show which subtrees an operation walked. */
  readonly treeReads: string[] = [];
  /** Every call that reached a repo handle, as `method` or `method:detail`. */
  readonly calls: string[] = [];
  readonly binding: Artifacts;

  constructor(private readonly opts: FakeOptions = {}) {
    // The adapter only ever sees the binding's declared methods.
    this.binding = {
      create: (name: string, o?: { description?: string; setDefaultBranch?: string; readOnly?: boolean }) => this.create(name, o),
      get: (name: string) => this.get(name),
      delete: (name: string) => this.delete(name),
    } as unknown as Artifacts;
  }

  private fail(code: ArtifactsErrorCode, text: string): never {
    throw failure(code, text, this.opts.dropCodes ?? false);
  }

  private remote(name: string): string {
    return `https://${this.opts.account ?? "acct"}.artifacts.cloudflare.net/git/${this.opts.namespace ?? "ryke"}/${name}.git`;
  }

  private validName(name: string) {
    if (typeof name !== "string" || !REPO_NAME.test(name) || name.endsWith(".git")) this.fail("INVALID_REPO_NAME", `invalid repository name ${JSON.stringify(name)}`);
  }

  private token(scope: "read" | "write", ttl: number) {
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 31_536_000) this.fail("INVALID_TTL", `ttl ${ttl} is outside 60..31536000`);
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const secret = toHex(crypto.getRandomValues(new Uint8Array(20)));
    return { id: `tok_${this.nextId++}`, plaintext: `art_v1_${secret}?expires=${expires}`, scope, expiresAt: new Date(expires * 1000).toISOString() };
  }

  private async create(name: string, o: { description?: string; setDefaultBranch?: string } = {}) {
    this.validName(name);
    if (this.repos.has(name)) this.fail("ALREADY_EXISTS", `repository ${name} already exists`);
    const repo = new FakeRepo(`repo_${this.nextId++}`, name, o.description ?? null, o.setDefaultBranch ?? "main", null);
    this.repos.set(name, repo);
    return { id: repo.id, name, description: repo.description, defaultBranch: repo.defaultBranch, remote: this.remote(name), token: this.token("write", 86_400).plaintext };
  }

  private async delete(name: string): Promise<boolean> {
    this.validName(name);
    return this.repos.delete(name);
  }

  private async get(name: string): Promise<ArtifactsRepo> {
    const repo = this.repos.get(name);
    if (!repo) this.fail("NOT_FOUND", `repository ${name} not found`);
    return this.handle(repo);
  }

  private handle(repo: FakeRepo): ArtifactsRepo {
    this.open++;
    let disposed = false;
    // Using a handle after it was disposed is a bug in the caller; make it loud.
    const live = async <T>(method: string, detail: string | undefined, run: () => T): Promise<T> => {
      if (disposed) throw new Error(`${method} on a disposed Artifacts handle`);
      this.calls.push(detail === undefined ? method : `${method}:${detail}`);
      if (this.repos.get(repo.name) !== repo) this.fail("NOT_FOUND", `repository ${repo.name} not found`);
      return run();
    };
    const handle = {
      [DISPOSE]: () => {
        if (disposed) return;
        disposed = true;
        this.open--;
      },
      info: () =>
        live("info", undefined, () => ({
          id: repo.id,
          name: repo.name,
          description: repo.description,
          defaultBranch: repo.defaultBranch,
          createdAt: repo.createdAt,
          updatedAt: repo.createdAt,
          lastPushAt: repo.head ? repo.createdAt : null,
          source: repo.source,
          readOnly: false,
          remote: this.remote(repo.name),
        })),
      createToken: (scope: "read" | "write" = "write", ttl = 86_400) => live("createToken", scope, () => this.token(scope, ttl)),
      listTokens: () => live("listTokens", undefined, () => ({ tokens: [], total: 0 })),
      revokeToken: () => live("revokeToken", undefined, () => false),
      readBlob: (hash: string) =>
        live("readBlob", hash, () => {
          this.hashArg(hash);
          const o = repo.objects.get(hash);
          return o?.kind === "blob" ? new Blob([o.data as BlobPart]) : null;
        }),
      readTree: (hash: string) =>
        live("readTree", hash, () => {
          this.hashArg(hash);
          this.treeReads.push(hash);
          const o = repo.objects.get(hash);
          if (!o) return null;
          if (o.kind !== "tree") this.fail("INTERNAL_ERROR", `${hash} is not a tree`);
          return o.entries.map((e) => ({ name: e.name, mode: e.mode, hash: e.hash, type: TYPE_OF_MODE[e.mode]! }));
        }),
      readCommit: (hash: string) =>
        live("readCommit", hash, () => {
          this.hashArg(hash);
          const o = repo.objects.get(hash);
          return o?.kind === "commit" ? structuredClone(o.meta) : null;
        }),
      readFile: (args: { ref: string; path: string }) =>
        live("readFile", `${args?.ref}:${args?.path}`, () => {
          if (!args?.ref || !args?.path) this.fail("INVALID_INPUT", "ref and path are required");
          const commit = this.resolve(repo, args.ref);
          if (!commit) return null;
          let entries = this.entries(repo, commit.treeHash);
          const parts = args.path.split("/").filter(Boolean);
          for (let i = 0; i < parts.length; i++) {
            const e = entries.find((x) => x.name === parts[i]);
            if (!e) return null;
            if (i < parts.length - 1) {
              if (e.mode !== MODE.tree) return null;
              entries = this.entries(repo, e.hash);
              continue;
            }
            const o = repo.objects.get(e.hash);
            return e.mode !== MODE.tree && e.mode !== MODE.gitlink && o?.kind === "blob" ? new Blob([o.data as BlobPart]) : null;
          }
          return null;
        }),
      log: (o: { ref?: string; limit?: number; offset?: number } = {}) =>
        live("log", `${o.ref ?? "HEAD"}:${o.limit ?? ""}`, () => {
          const limit = Math.min(o.limit ?? 50, 1000);
          const out: ArtifactsCommitMetadata[] = [];
          let at = this.resolve(repo, o.ref);
          for (let skipped = 0; at && out.length < limit; at = this.commitOf(repo, at.parents[0])) {
            if (skipped < (o.offset ?? 0)) skipped++;
            else out.push(structuredClone(at));
          }
          return out;
        }),
      fork: (name: string, o: { description?: string; defaultBranchOnly?: boolean } = {}) =>
        live("fork", name, () => {
          this.validName(name);
          if (this.repos.has(name)) this.fail("ALREADY_EXISTS", `repository ${name} already exists`);
          const copy = new FakeRepo(`repo_${this.nextId++}`, name, o.description ?? null, repo.defaultBranch, `artifacts:${this.opts.namespace ?? "ryke"}/${repo.name}`);
          for (const [hash, obj] of repo.objects) copy.objects.set(hash, obj);
          copy.head = repo.head;
          this.repos.set(name, copy);
          return { id: copy.id, name, description: copy.description, defaultBranch: copy.defaultBranch, remote: this.remote(name), token: this.token("write", 86_400).plaintext };
        }),
    };
    return handle as unknown as ArtifactsRepo;
  }

  private hashArg(hash: string) {
    if (typeof hash !== "string" || !HASH.test(hash)) this.fail("INVALID_INPUT", `malformed object id ${JSON.stringify(hash)}`);
  }

  private commitOf(repo: FakeRepo, hash: string | undefined): ArtifactsCommitMetadata | null {
    const o = hash ? repo.objects.get(hash) : undefined;
    return o?.kind === "commit" ? o.meta : null;
  }

  private entries(repo: FakeRepo, hash: string): StoredEntry[] {
    const o = repo.objects.get(hash);
    return o?.kind === "tree" ? o.entries : [];
  }

  // A branch name, `HEAD`, nothing (HEAD), or a commit id; anything else does not resolve.
  private resolve(repo: FakeRepo, ref: string | undefined): ArtifactsCommitMetadata | null {
    if (ref === undefined || ref === "HEAD" || ref === repo.defaultBranch || ref === `refs/heads/${repo.defaultBranch}`) return this.commitOf(repo, repo.head ?? undefined);
    return HASH.test(ref) ? this.commitOf(repo, ref) : null;
  }

  // ---- test-only: writing history, which the binding leaves to git push ------------------------

  /** Commits `files` on top of the default branch: a string is a file, null deletes a path or a directory. */
  async commit(name: string, files: Record<string, FileSpec>, message: string, at?: number): Promise<string> {
    const repo = this.repos.get(name);
    if (!repo) throw new Error(`the test commits to unknown repo ${name}`);
    const parent = this.commitOf(repo, repo.head ?? undefined);
    const flat = new Map<string, { mode: string; hash: string }>();
    if (parent) this.flatten(repo, parent.treeHash, "", flat);
    for (const [path, spec] of Object.entries(files)) {
      // Whatever sits at the path, file or directory, goes first; a new file also replaces a file that
      // was in the way of its directory, as `git add` of the working tree would see it.
      for (const k of [...flat.keys()]) if (k === path || k.startsWith(`${path}/`)) flat.delete(k);
      if (spec === null) continue;
      const segments = path.split("/");
      for (let i = 1; i < segments.length; i++) flat.delete(segments.slice(0, i).join("/"));
      const data = encoder.encode(typeof spec === "string" ? spec : "content" in spec ? spec.content : spec.symlink);
      const hash = await hashObject("blob", data);
      repo.objects.set(hash, { kind: "blob", data });
      const mode = typeof spec === "string" ? MODE.blob : "content" in spec ? (spec.exec ? MODE.exec : MODE.blob) : MODE.symlink;
      flat.set(path, { mode, hash });
    }
    const treeHash = await this.writeTree(repo, flat, "");
    const time = at ?? this.clock++;
    const person = { name: "Test", email: "test@ryke.ai" };
    const text = [`tree ${treeHash}`, ...(parent ? [`parent ${parent.hash}`] : []), `author ${person.name} <${person.email}> ${time} +0000`, `committer ${person.name} <${person.email}> ${time} +0000`, "", `${message}\n`].join("\n");
    const hash = await hashObject("commit", encoder.encode(text));
    repo.objects.set(hash, {
      kind: "commit",
      meta: { hash, treeHash, message, author: person, committer: person, parents: parent ? [parent.hash] : [], authoredAt: time, committedAt: time },
    });
    repo.head = hash;
    return hash;
  }

  private flatten(repo: FakeRepo, tree: string, prefix: string, out: Map<string, { mode: string; hash: string }>) {
    for (const e of this.entries(repo, tree)) {
      if (e.mode === MODE.tree) this.flatten(repo, e.hash, `${prefix}${e.name}/`, out);
      else out.set(`${prefix}${e.name}`, { mode: e.mode, hash: e.hash });
    }
  }

  private async writeTree(repo: FakeRepo, flat: Map<string, { mode: string; hash: string }>, prefix: string): Promise<string> {
    const entries: StoredEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, e] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) entries.push({ name: rest, mode: e.mode, hash: e.hash });
      else dirs.add(rest.slice(0, slash));
    }
    for (const dir of dirs) entries.push({ name: dir, mode: MODE.tree, hash: await this.writeTree(repo, flat, `${prefix}${dir}/`) });
    // Git sorts as if directory names ended in "/".
    const key = (e: StoredEntry) => (e.mode === MODE.tree ? `${e.name}/` : e.name);
    entries.sort((a, b) => (key(a) < key(b) ? -1 : 1));
    const body = concat(...entries.map((e) => concat(encoder.encode(`${e.mode} ${e.name}\0`), fromHex(e.hash))));
    const hash = await hashObject("tree", body);
    repo.objects.set(hash, { kind: "tree", entries });
    return hash;
  }
}
