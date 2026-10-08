// post-receive hook body: tells the Ryke worker about every ref a push moved,
// using the same envelope Cloudflare Artifacts emits as cf.artifacts.repo.pushed.
// It must never fail a push, so every error path ends in exit 0.
import { execFileSync } from "node:child_process";
import { LOG_FORMAT, parseLog } from "./commits.mjs";

const ZEROS = "0".repeat(40);
const MAX_COMMITS = 100;
const POST_TIMEOUT_MS = 3000;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function commitsFor(before, after) {
  if (after === ZEROS) return { commits: [], total: 0 };
  // A new ref has no base, so every commit reachable from it is reported.
  const range = before === ZEROS ? after : `${before}..${after}`;
  try {
    const total = Number(git(["rev-list", "--count", range, "--"]).trim());
    const commits = parseLog(
      git(["log", "-n", String(MAX_COMMITS), `--format=${LOG_FORMAT}`, range, "--"]),
    ).map(({ sha, message, author, at }) => ({ sha, message, author, at }));
    return { commits, total };
  } catch {
    // A ref that points at a non-commit (a tag of a blob, say) has no history to list.
    return { commits: [], total: 0 };
  }
}

async function main() {
  // Drain stdin first so receive-pack never sees a closed pipe.
  const input = await readStdin();
  const url = process.env.RYKE_EVENTS_URL;
  if (!url) return;

  for (const line of input.split("\n")) {
    const [before, after, ...refParts] = line.trim().split(" ");
    const ref = refParts.join(" ");
    if (!before || !after || !ref) continue;

    const { commits, total } = commitsFor(before, after);
    const envelope = {
      type: "cf.artifacts.repo.pushed",
      source: {
        type: "artifacts.repo",
        namespace: process.env.RYKE_NAMESPACE ?? "",
        repoName: process.env.RYKE_REPO_NAME ?? "",
      },
      payload: {
        ref,
        before,
        after,
        commits,
        totalCommitsCount: total,
        commitsTruncated: total > commits.length,
      },
      metadata: { eventTimestamp: new Date().toISOString() },
    };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ryke-internal": process.env.RYKE_INTERNAL_SECRET ?? "",
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      // Reading the body keeps the abort signal armed until the exchange is done.
      await response.arrayBuffer();
    } catch {
      // The push has already been accepted; a dead worker must not undo that.
    }
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
