// Git as an agent uses it: clone its fork, commit, push; on retry fetch the new snapshot from trunk
// and replay its commit on top with the union driver for union paths.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export function identity(agent) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: agent,
    GIT_AUTHOR_EMAIL: `${agent}@agents.ryke.ai`,
    GIT_COMMITTER_NAME: agent,
    GIT_COMMITTER_EMAIL: `${agent}@agents.ryke.ai`,
  };
}

export class Workspace {
  constructor(dir, agent) {
    this.dir = dir;
    this.env = identity(agent);
  }

  static async create(agent, root = tmpdir()) {
    const dir = await mkdtemp(join(root, `ryke-${agent}-`));
    const ws = new Workspace(dir, agent);
    await ws.git("init", "-q", "-b", "main");
    return ws;
  }

  async git(...argv) {
    try {
      return (await run("git", argv, { cwd: this.dir, env: this.env, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
    } catch (e) {
      throw new Error(`git ${argv.filter((a) => !a.startsWith("http.extraHeader")).join(" ")}: ${(e.stderr || e.message).trim()}`);
    }
  }

  // Bearer auth exactly as Artifacts expects, without putting the token in the remote URL.
  auth(token) {
    return ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
  }

  async fetch(remote, token, ref) {
    await this.git(...this.auth(token), "fetch", "-q", remote, ref);
    return this.git("rev-parse", "FETCH_HEAD");
  }

  async checkout(sha) {
    await this.git("checkout", "-q", "--detach", sha);
  }

  async setUnion(patterns) {
    await mkdir(join(this.dir, ".git", "info"), { recursive: true });
    await writeFile(join(this.dir, ".git", "info", "attributes"), patterns.map((p) => `${p} merge=union\n`).join(""));
  }

  async write(files) {
    for (const [path, content] of Object.entries(files)) {
      const abs = join(this.dir, path);
      if (content === null) await rm(abs, { force: true });
      else {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
      }
    }
  }

  async commitAll(message) {
    await this.git("add", "-A");
    await this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  async push(remote, token, sha, force = false) {
    await this.git(...this.auth(token), "push", "-q", ...(force ? ["--force"] : []), remote, `${sha}:refs/heads/main`);
  }

  // Replays `commit` onto `onto`; returns the new sha, or null when it does not apply.
  async replay(commit, onto) {
    await this.checkout(onto);
    try {
      await this.git("cherry-pick", "--allow-empty", commit);
      return this.git("rev-parse", "HEAD");
    } catch {
      await this.git("cherry-pick", "--abort").catch(() => {});
      return null;
    }
  }

  async remove() {
    await rm(this.dir, { recursive: true, force: true });
  }
}
