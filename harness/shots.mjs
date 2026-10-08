#!/usr/bin/env node
// `npm run shots` (PLAN.md §12 "Checks", §13 M4 Accept): starts a fresh stack, runs the scripted swarm
// against it at --speed 8 while a real browser watches, and captures every dashboard view at 1440x900 and
// 390x844 in light and dark into docs/shots/<view>-<variant>-<width>-<scheme>.png. Any console error or
// uncaught page error fails the run (exit 1), after the shots are written, with the page that raised it.
//
// RYKE_PORT_OFFSET moves every port like the rest of the harness (default 0). The Jev judge is off so the
// shots do not depend on recorded fixtures or a model key.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, startStack } from "../dev/stack.mjs";

export const REPO = "convert";
export const SHOTS_DIR = join(ROOT, "docs/shots");
export const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
export const SCHEMES = ["light", "dark"];

export const shotName = (view, variant, width, scheme) => `${view}-${variant}-${width}-${scheme}.png`;

// ---------------------------------------------------------------- reading the op log (pure)

// Which transactions to open on the Transaction view: one that landed first time, one that went stale and
// then landed, one that failed (preferring a train that was bisected) and the rejected tamper attempt.
// Any of them can be null when the run did not produce one.
export function pickTxns(ops) {
  const txns = new Map();
  const bisected = new Set();
  for (const op of ops) {
    if (op.kind === "train.bisect") bisected.add(op.data.train);
    if (!op.txn) continue;
    let t = txns.get(op.txn);
    if (!t) txns.set(op.txn, (t = { id: op.txn, stale: 0, landed: false, failed: false, rejected: null, train: null }));
    if (op.kind === "txn.stale") t.stale++;
    else if (op.kind === "txn.landed") t.landed = true;
    else if (op.kind === "txn.failed") t.failed = true;
    else if (op.kind === "txn.rejected") t.rejected = op.data.reason ?? "";
    else if (op.kind === "txn.verifying") t.train = op.data.train ?? t.train;
  }
  const all = [...txns.values()];
  const first = (list) => list[0]?.id ?? null;
  const failed = all.filter((t) => t.failed);
  return {
    landed: first(all.filter((t) => t.landed && t.stale === 0)),
    stale: first(all.filter((t) => t.landed && t.stale > 0)),
    failed: first([...failed.filter((t) => t.train && bisected.has(t.train)), ...failed]),
    // The tamper task edits a protected test file; duplicates are rejected for another reason.
    rejected: first(all.filter((t) => t.rejected === "protected")),
  };
}

// The mid-run shot has to show what §13 M4 asks for: trains, stale notches and heat, with work still running.
export function midRunReady(ops) {
  const n = (kind) => ops.filter((o) => o.kind === kind).length;
  return n("txn.landed") >= 6 && n("txn.stale") >= 2 && n("train.formed") >= 2 && n("heat.changed") >= 1;
}

// The webfonts are an enhancement with a fallback stack; a machine that cannot reach Google Fonts must
// not fail the run for it. Everything else that logs an error does.
export function isFontFailure(url) {
  return /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url ?? "");
}

// ---------------------------------------------------------------- the run

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (line) => console.log(`${stamp()}  shots  ${line}`);

async function waitUntil(what, fn, { timeout = 120_000, every = 500 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out after ${timeout / 1000} s waiting for ${what}`);
    await sleep(every);
  }
}

async function readOps(apiUrl) {
  const out = [];
  for (let after = 0; ; ) {
    const res = await fetch(`${apiUrl}/api/repos/${REPO}/ops?after=${after}&limit=1000`);
    if (!res.ok) throw new Error(`GET ops answered ${res.status}`);
    const page = await res.json();
    out.push(...page.ops);
    if (page.ops.length < 1000) return out;
    after = page.last;
  }
}

async function main() {
  const offset = Number(process.env.RYKE_PORT_OFFSET ?? 0);
  process.env.RYKE_JEV = "off";
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers")) process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
  const { chromium } = await import("playwright");

  const written = [];
  const problems = []; // console errors and page errors, with where they happened
  const ignored = []; // font failures, listed so they are never invisible
  let where = "start-up";
  let stack = null;
  let browser = null;
  let swarm = null;
  const t0 = Date.now();
  const watchdog = setTimeout(() => {
    console.error(`shots  FAIL: still running after ${Number(process.env.RYKE_SHOTS_TIMEOUT_MS ?? 20 * 60_000) / 60_000} minutes (${where})`);
    void cleanup().then(() => process.exit(1));
  }, Number(process.env.RYKE_SHOTS_TIMEOUT_MS ?? 20 * 60_000));
  watchdog.unref();

  async function cleanup() {
    if (swarm && swarm.exitCode === null) swarm.kill("SIGTERM");
    await browser?.close().catch(() => {});
    await stack?.close().catch(() => {});
  }
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => void cleanup().then(() => process.exit(130)));

  let failure = null;
  try {
    await mkdir(SHOTS_DIR, { recursive: true });
    say(`starting a fresh stack at port offset ${offset} (Jev off)`);
    stack = await startStack({ offset, fresh: true, quiet: true });
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: SIZES[0], deviceScaleFactor: 1, colorScheme: "light" });
    // The dev server and the platform share the machine with the swarm's local test runs; a slow page is not a failed one.
    context.setDefaultTimeout(120_000);
    // The admin token is stored the way the dashboard's own token field stores it, so the Recall dialog opens ready.
    await context.addInitScript((token) => {
      try {
        localStorage.setItem("ryke.token", token);
      } catch {
        // storage blocked: the dialog then asks for the token, which the run would report
      }
    }, stack.token);

    const watch = (page) => {
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const url = m.location().url;
        (isFontFailure(url) ? ignored : problems).push({ where, kind: "console.error", text: m.text(), url });
      });
      page.on("pageerror", (e) => problems.push({ where, kind: "pageerror", text: e.stack ?? e.message, url: "" }));
      page.on("crash", () => problems.push({ where, kind: "crash", text: "the page crashed", url: "" }));
    };

    // Vite pre-bundles dependencies on the first request, and may reload once while it does. That happens
    // here, on the Bench route (which opens no socket), so the pages that matter load a settled bundle.
    where = "warm-up";
    const warm = await context.newPage();
    watch(warm);
    await warm.goto(`${stack.apiUrl}/#/bench`, { waitUntil: "domcontentloaded" });
    await warm.waitForSelector(".bench", { timeout: 120_000 });
    await warm.waitForTimeout(1500);
    await warm.close();

    // ------------------------------------------------------------ the swarm, with a browser watching
    where = "swarm";
    const logPath = join(stack.stateDir, "shots-swarm.log");
    const lines = [];
    swarm = spawn(process.execPath, [join(ROOT, "harness/swarm.mjs"), "--mode", "scripted", "--agents", "12", "--fresh", "--speed", "8", "--repo", REPO], {
      env: { ...process.env, RYKE_API_URL: stack.apiUrl, RYKE_TOKEN: stack.token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let repoReady = false;
    const onData = (buf) => {
      for (const line of buf.toString().split("\n")) {
        if (line.trim() === "") continue;
        lines.push(line);
        if (/repo \S+ (re)?created from/.test(line)) repoReady = true;
      }
    };
    swarm.stdout.on("data", onData);
    swarm.stderr.on("data", onData);
    const swarmExit = new Promise((resolve) => swarm.once("exit", (code) => resolve(code)));
    swarmExit.then(() => writeFile(logPath, `${lines.join("\n")}\n`).catch(() => {}));
    // The swarm recreates the repo first (--fresh); a socket opened before that would 404 and log an error.
    await waitUntil(
      "the swarm to create the repo",
      () => {
        if (swarm.exitCode !== null) throw new Error(`the swarm exited with ${swarm.exitCode} before it created the repo:\n${lines.slice(-12).join("\n")}`);
        return repoReady;
      },
      { timeout: 120_000, every: 200 },
    );
    say("swarm running; opening the Line");

    where = "line (live)";
    const page = await context.newPage();
    watch(page);
    await page.goto(`${stack.apiUrl}/?repo=${REPO}#/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.status-dot[data-live="true"]', { timeout: 120_000 });

    const settle = async (ms = 250) => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      await page.waitForTimeout(ms);
    };
    // Each view is captured in the four variants from one page, so the dialog or the scrubber keeps its state.
    // A view that scrolls inside the page (phone layouts, the Transaction and Bench pages) is captured at its
    // full height, which is the whole page as a reader would scroll it.
    async function snap(view, variant) {
      for (const size of SIZES) {
        for (const scheme of SCHEMES) {
          await page.setViewportSize(size);
          await page.emulateMedia({ colorScheme: scheme });
          await settle(150);
          const extra = await page.evaluate(() => {
            const v = document.querySelector(".view");
            return v ? Math.max(0, v.scrollHeight - v.clientHeight) : 0;
          });
          if (extra > 0) {
            await page.setViewportSize({ width: size.width, height: Math.min(size.height + extra, 6000) });
            await settle(200);
          }
          const file = join(SHOTS_DIR, shotName(view, variant, size.width, scheme));
          await page.screenshot({ path: file });
          written.push(file);
        }
      }
      await page.setViewportSize(SIZES[0]);
      await page.emulateMedia({ colorScheme: "light" });
    }

    // document.fonts lists a face only once the Google Fonts stylesheet has loaded, so "check()" alone would
    // answer true on a machine that never got it.
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return ["IBM Plex Mono", "IBM Plex Sans Condensed"].every((f) => [...document.fonts].some((x) => x.family.replace(/"/g, "") === f && x.status === "loaded"));
    });
    say(fonts ? "IBM Plex loaded" : "IBM Plex not loaded: the shots use the fallback fonts");

    await waitUntil("a mid-run state with trains, stale notches and heat", async () => {
      if (swarm.exitCode !== null) throw new Error("the swarm finished before the mid-run condition (landed >= 6, stale >= 2, trains >= 2, heat) was reached");
      return midRunReady(await readOps(stack.apiUrl));
    }, { timeout: 15 * 60_000, every: 1000 });
    where = "line mid-run";
    await page.waitForTimeout(800);
    await snap("line", "mid");
    say("captured line-mid");

    const code = await swarmExit;
    if (code !== 0) throw new Error(`the swarm exited with ${code}; last lines:\n${lines.slice(-12).join("\n")}`);
    say(`swarm done after ${Math.round((Date.now() - t0) / 1000)} s`);
    const start = lines.findLastIndex((l) => l.startsWith("Swarm report"));
    for (const l of start < 0 ? lines.slice(-6) : lines.slice(start, start + 24)) console.log(`           ${l}`);

    // Let the socket deliver the last ops and the last train's arrival animation finish.
    await page.waitForTimeout(2500);
    where = "line end";
    await snap("line", "end");

    // ------------------------------------------------------------ Transaction view
    const ops = await readOps(stack.apiUrl);
    const picks = pickTxns(ops);
    for (const [variant, id] of Object.entries(picks)) {
      if (!id) {
        say(`no ${variant} transaction in this run; txn-${variant} skipped`);
        continue;
      }
      where = `transaction ${variant} (${id})`;
      await page.evaluate((h) => (location.hash = h), `#/t/${id}`);
      await page.waitForSelector(".txn-id", { timeout: 120_000 });
      // The delta of a stale attempt belongs to that attempt; once it has retried, attempt 1 is where it shows.
      if (variant === "stale") {
        const first = page.locator('.txn-picker button:text-is("1")');
        if (await first.count()) await first.click();
      }
      await snap("txn", variant);
    }

    // ------------------------------------------------------------ Bench
    where = "bench";
    await page.evaluate(() => (location.hash = "#/bench"));
    await page.waitForFunction(() => document.querySelector(".bench") && !/Loading the latest bench run/.test(document.body.innerText), null, { timeout: 120_000 });
    await snap("bench", "main");

    // ------------------------------------------------------------ Replay, paused in the middle of the log
    where = "replay";
    await page.evaluate(() => (location.hash = "#/replay"));
    await page.waitForSelector('.scrubber input[type="range"]:not([disabled])', { timeout: 120_000 });
    const max = Number(await page.locator('.scrubber input[type="range"]').getAttribute("max"));
    await page.locator('.scrubber input[type="range"]').fill(String(Math.round(max * 0.55)));
    await page.waitForTimeout(400);
    await snap("replay", "paused");

    // ------------------------------------------------------------ Recall dialog
    where = "recall dialog";
    await page.evaluate(() => (location.hash = "#/"));
    await page.waitForSelector(".line");
    const opener = page.getByRole("button", { name: "Recall…" });

    // Keyboard: focus stays inside while tabbing, Esc closes and gives focus back to the button.
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Recall" });
    await dialog.waitFor();
    const outside = [];
    for (const [key, count] of [["Tab", 14], ["Shift+Tab", 14]]) {
      for (let i = 1; i <= count; i++) {
        await page.keyboard.press(key);
        if (!(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))))) outside.push(`${key} #${i}`);
      }
    }
    if (outside.length > 0) problems.push({ where, kind: "focus", text: `focus left the dialog at presses ${outside.join(", ")}`, url: "" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    if (!(await opener.evaluate((el) => el === document.activeElement))) problems.push({ where, kind: "focus", text: "Esc did not return focus to the Recall button", url: "" });

    await opener.click();
    await dialog.waitFor();
    const options = await page.locator(".recall select option").allTextContents();
    if (!options.some((o) => o.startsWith("sloppy-v0"))) throw new Error(`the Recall dialog offers no model sloppy-v0 (options: ${options.join(" | ")})`);
    await page.locator(".recall select").selectOption("sloppy-v0");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.waitForSelector(".recall-plan", { timeout: 120_000 });
    await snap("recall", "planned");
    say("captured recall-planned; executing the recall");

    await page.getByRole("button", { name: "Execute recall" }).click();
    where = "recall dialog (executing)";
    await page.waitForSelector(".recall-outcome", { timeout: 5 * 60_000 });
    await page.waitForTimeout(600);
    await snap("recall", "executed");

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    where = "line after recall";
    await page.waitForTimeout(1500);
    await snap("line", "recalled");

    await page.close();
  } catch (e) {
    failure = e;
  } finally {
    clearTimeout(watchdog);
    await cleanup();
  }

  // ------------------------------------------------------------ report
  if (!failure) {
    const keep = new Set(written.map((f) => f.slice(SHOTS_DIR.length + 1)));
    for (const f of await readdir(SHOTS_DIR)) if (f.endsWith(".png") && !keep.has(f)) await rm(join(SHOTS_DIR, f));
  }
  console.log(`\nfiles written (${written.length}):`);
  for (const f of written) console.log(`  ${relative(ROOT, f)}  ${(((await stat(f)).size) / 1024).toFixed(0)} kB`);
  if (ignored.length > 0) console.log(`\nignored ${ignored.length} failed webfont request(s): ${[...new Set(ignored.map((i) => i.url))].join(", ")}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} browser problem(s):`);
    for (const p of problems) console.error(`  [${p.where}] ${p.kind}: ${p.text.split("\n")[0]}${p.url ? `  (${p.url})` : ""}`);
  }
  if (failure) console.error(`\nshots  FAIL: ${failure.stack ?? failure.message}`);
  const ok = !failure && problems.length === 0;
  console.log(`\nshots  ${ok ? "PASS" : "FAIL"}  ${written.length} files, ${problems.length} console/page errors, ${Math.round((Date.now() - t0) / 1000)} s`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
