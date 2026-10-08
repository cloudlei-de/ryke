// A tiny HTTP service that lets the workerd test suites make real git commits (workerd cannot run
// git). POST /commit clones a remote at a base, writes or deletes files, commits and pushes.
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@ryke.ai",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@ryke.ai",
};
const git = (cwd, ...argv) => run("git", argv, { cwd, env }).then((r) => r.stdout.trim());

function withAuth(remote, token) {
  if (!token) return remote;
  const u = new URL(remote);
  u.username = "x";
  u.password = token.split("?")[0];
  return u.toString();
}

async function commit({ remote, token, base, files, message = "test change", ref = "refs/heads/main", force = false, from }) {
  const dir = await mkdtemp(join(tmpdir(), "ryke-git-"));
  try {
    const url = withAuth(remote, token);
    await git(dir, "init", "-q", "-b", "main");
    // `from` lets a test fetch a base that lives in another repo (e.g. trunk) into a fork.
    const src = from ? withAuth(from.remote, from.token) : url;
    if (base) {
      await git(dir, "fetch", "-q", src, base);
      await git(dir, "checkout", "-q", base);
    } else {
      const heads = await git(dir, "ls-remote", src, "refs/heads/main");
      if (heads) {
        await git(dir, "fetch", "-q", src, "refs/heads/main");
        await git(dir, "checkout", "-q", "FETCH_HEAD");
      }
    }
    // A value is file content, null (delete the file or directory), `{ content, exec }` for an
    // executable file or `{ symlink }` for a link. Whatever is in the way (a directory where a file
    // goes, a file where a directory goes) is replaced, as it would be by checking out the new tree.
    for (const [path, value] of Object.entries(files)) {
      const abs = join(dir, path);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const ancestor = join(dir, ...parts.slice(0, i));
        if ((await lstat(ancestor).catch(() => null))?.isDirectory() === false) await rm(ancestor, { force: true });
      }
      await rm(abs, { recursive: true, force: true });
      if (value === null) continue;
      await mkdir(dirname(abs), { recursive: true });
      if (typeof value === "string") await writeFile(abs, value);
      else if ("symlink" in value) await symlink(value.symlink, abs);
      else {
        await writeFile(abs, value.content);
        await chmod(abs, value.exec ? 0o755 : 0o644);
      }
    }
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "--allow-empty", "-m", message);
    const sha = await git(dir, "rev-parse", "HEAD");
    await git(dir, "push", "-q", ...(force ? ["--force"] : []), url, `HEAD:${ref}`);
    return { sha };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Moves a commit from one repo to another, e.g. a fork head onto trunk main, as the lander would.
async function push({ from, sha, to, ref = "refs/heads/main", force = false }) {
  const dir = await mkdtemp(join(tmpdir(), "ryke-git-"));
  try {
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "fetch", "-q", withAuth(from.remote, from.token), sha);
    await git(dir, "push", "-q", ...(force ? ["--force"] : []), withAuth(to.remote, to.token), `${sha}:${ref}`);
    return { sha };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function startGitHelper(port) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const op = req.method === "POST" && { "/commit": commit, "/push": push }[req.url];
      if (!op) throw Object.assign(new Error("not found"), { status: 404 });
      const out = await op(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(e.status ?? 500, { "content-type": "application/json" }).end(JSON.stringify({ error: e.stderr || e.message }));
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { close: () => new Promise((r) => server.close(r)) };
}
