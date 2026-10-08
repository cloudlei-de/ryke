// Creates the first trunk commit from demo/<seed> (or a bare default) and pushes it (PLAN.md §6.1).
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git, main } from "./common.mjs";

const SKIP = new Set(["tools", "solutions", "tasks.json", "node_modules"]);

main(async ({ remote, seed = "", message, policy }) => {
  if (!remote) throw new Error("--remote is required");
  const dir = resolve("seed");
  await mkdir(dir, { recursive: true });
  if (seed) {
    const src = join(process.env.RYKE_ROOT ?? resolve(import.meta.dirname, "../../.."), "demo", seed);
    await cp(src, dir, { recursive: true, filter: (p) => !SKIP.has(p.slice(src.length + 1).split("/")[0]) });
  } else {
    await writeFile(join(dir, "README.md"), "# Ryke repo\n");
    await writeFile(join(dir, "ryke.json"), `${JSON.stringify({ protected: ["ryke.json"], union: [], verify: "true" }, null, 2)}\n`);
  }
  if (policy) {
    const file = join(dir, "ryke.json");
    const current = await readFile(file, "utf8").then(JSON.parse, () => ({}));
    await writeFile(file, `${JSON.stringify({ ...current, ...JSON.parse(policy) }, null, 2)}\n`);
  }
  await git(dir, ["init", "-q", "--template=", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message || (seed ? `Seed ${seed}` : "Initial commit")]);
  const sha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  await git(dir, ["push", "-q", remote, "HEAD:refs/heads/main"]);
  return { ok: true, sha };
});
