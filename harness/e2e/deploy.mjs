// `npm run e2e:deploy` (PLAN.md §13 M9 Accept, the dry-run half): `npm run deploy:dry` must succeed, and
// the production configuration the build emitted (dist/<worker>/wrangler.json) must be the production one:
// artifacts store, container runner, live Jev, no secrets and no local addresses among the vars, every
// binding present, containers, the push trigger and the routes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ROOT } from "../lib/tasks.mjs";
import { bindingNames, checkProductionConfig, parseDevVars, REQUIRED_BINDINGS } from "./lib.mjs";

const run = promisify(execFile);
const log = (line) => console.log(`e2e:deploy  ${line}`);
const REDIRECT = join(ROOT, ".wrangler/deploy/config.json");
// What wrangler says when it cannot build the container image: no Docker daemon, or a proxy that re-signs TLS.
const IMAGE_BUILD = /docker|container image|image build|SELF_SIGNED_CERT|UNABLE_TO_VERIFY|certificate|x509/i;

async function deployDry(extra = []) {
  const started = Date.now();
  const cmd = ["run", "deploy:dry", ...(extra.length ? ["--", ...extra] : [])];
  log(`npm ${cmd.join(" ")}`);
  try {
    const { stdout, stderr } = await run("npm", cmd, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000, env: { ...process.env, CI: "1" } });
    return { ok: true, text: `${stdout}\n${stderr}`, started };
  } catch (e) {
    return { ok: false, text: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`, started };
  }
}

// The Vite plugin leaves a redirect to the config it emitted; the worker's name decides the directory.
async function emittedConfig() {
  try {
    return resolve(dirname(REDIRECT), JSON.parse(await readFile(REDIRECT, "utf8")).configPath);
  } catch {
    return join(ROOT, "dist/ryke/wrangler.json");
  }
}

// Proxy warnings and blank lines are what wrangler prints last, so without this filter the tail says nothing.
const tail = (text, n = 12) =>
  text
    .split("\n")
    .filter((l) => l.trim() !== "" && !/UNDICI|trace-warnings|Proxy environment variables/.test(l))
    .slice(-n)
    .map((l) => `    ${l}`)
    .join("\n");
// The build wrote its config after this run started, so the failure came after `vite build` succeeded.
const builtSince = async (started) => (await stat(await emittedConfig()).catch(() => null))?.mtimeMs >= started;

let failed = false;
try {
  let result = await deployDry();
  let imageBuilt = true;
  if (!result.ok && IMAGE_BUILD.test(result.text) && (await builtSince(result.started))) {
    log("the container image could not be built here:");
    console.log(tail(result.text));
    log("retrying with --containers-rollout=none: the Worker and its configuration are checked, the image build is NOT");
    imageBuilt = false;
    result = await deployDry(["--containers-rollout=none"]);
  }
  console.log(tail(result.text));
  assert.ok(result.ok, "npm run deploy:dry failed");
  log(`deploy:dry succeeded${imageBuilt ? "" : " without building the container image (--containers-rollout=none)"}`);

  const file = await emittedConfig();
  const cfg = JSON.parse(await readFile(file, "utf8"));
  // Secrets a developer keeps in .dev.vars must not have been baked into the config under another name.
  const devSecrets = await readFile(join(ROOT, ".dev.vars"), "utf8").then(parseDevVars, () => []);
  const failures = checkProductionConfig(cfg, { devSecrets });

  const vars = cfg.vars ?? {};
  log(`${file.replace(`${ROOT}/`, "")}: name ${cfg.name}, vars ${Object.keys(vars).sort().join(", ")}`);
  log(`  RYKE_STORE=${vars.RYKE_STORE} RYKE_RUNNER=${vars.RYKE_RUNNER} RYKE_JEV=${vars.RYKE_JEV}`);
  log(`  bindings ${[...bindingNames(cfg)].sort().join(", ")} (required: ${REQUIRED_BINDINGS.join(", ")})`);
  log(`  containers ${(cfg.containers ?? []).map((c) => c.name ?? c.class_name).join(", ") || "none"}; triggers.events ${(cfg.triggers?.events ?? []).map((t) => t.type).join(", ") || "none"}; routes ${(cfg.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern)).join(", ") || "none"}`);
  assert.deepEqual(failures, [], `the production config is wrong:\n  ${failures.join("\n  ")}`);
  log("PASS");
} catch (e) {
  failed = true;
  console.error(`e2e:deploy  FAIL: ${e.stack ?? e.message}`);
}
process.exit(failed ? 1 : 0);
