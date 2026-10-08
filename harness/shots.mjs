#!/usr/bin/env node
// `npm run shots` (PLAN.md §12 "Checks", §13 M4 Accept): starts a fresh stack, runs the scripted swarm
// against it at --speed 8 while a real browser watches, and captures every dashboard view at 1440x900 and
// 390x844 in light and dark into docs/shots/<view>-<variant>-<width>-<scheme>.png. Any console error or
// uncaught page error fails the run (exit 1), after the shots are written, with the page that raised it.
//
// The run fails (exit 1, shots written first) when the Line is not what the plan describes at the moment it is
// captured, instead of photographing whatever is there: a train block, stale notches and a hot file before the
// mid-run shot, a struck-through target and the recall's commit after the recall, no overflow at 1440x900, and
// every required Transaction variant. txn-failed is the one optional variant; a run without one says so.
//
// RYKE_PORT_OFFSET moves every port like the rest of the harness (default 0). The Jev judge is off so the
// shots do not depend on recorded fixtures or a model key. RYKE_SCREENSHOTS=1 makes every train's verify take a
// screenshot, which the landed Transaction shot has to show (vite.config.ts hands the variable to the Worker).
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
// Any of them can be null when the run did not produce one. The stale one must have named a stale path: the shot
// is there to show the delta of that path, which the page computes from the two snapshots around the retry.
export function pickTxns(ops) {
  const txns = new Map();
  const bisected = new Set();
  for (const op of ops) {
    if (op.kind === "train.bisect") bisected.add(op.data.train);
    if (!op.txn) continue;
    let t = txns.get(op.txn);
    if (!t) txns.set(op.txn, (t = { id: op.txn, stale: 0, stalePaths: false, landed: false, failed: false, rejected: null, train: null }));
    if (op.kind === "txn.stale") {
      t.stale++;
      if (Array.isArray(op.data.paths) && op.data.paths.length > 0) t.stalePaths = true;
    } else if (op.kind === "txn.landed") t.landed = true;
    else if (op.kind === "txn.failed") t.failed = true;
    else if (op.kind === "txn.rejected") t.rejected = op.data.reason ?? "";
    else if (op.kind === "txn.verifying") t.train = op.data.train ?? t.train;
  }
  const all = [...txns.values()];
  const first = (list) => list[0]?.id ?? null;
  const failed = all.filter((t) => t.failed);
  return {
    landed: first(all.filter((t) => t.landed && t.stale === 0)),
    stale: first(all.filter((t) => t.landed && t.stale > 0 && t.stalePaths)),
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

// ---------------------------------------------------------------- what a run has to produce

// The shots of these variants are part of the deliverable, so a run that cannot make one fails. A failure
// (txn-failed) depends on the swarm's luck and is the only one allowed to be missing, out loud.
export const REQUIRED_VARIANTS = ["landed", "stale", "rejected"];
export const OPTIONAL_VARIANTS = ["failed"];

export function checkVariants(picks) {
  return { missing: REQUIRED_VARIANTS.filter((v) => !picks[v]), optionalMissing: OPTIONAL_VARIANTS.filter((v) => !picks[v]) };
}

// "<view>-<variant>-" starts every file name of one shot, whatever its size or scheme.
export const shotPrefix = (view, variant) => `${view}-${variant}-`;

// A run deletes the shots it did not write (a renamed view must not leave its old pictures behind), except those
// of a variant it skipped on purpose: the previous picture of that variant is still the best one there is.
export function pruneList(existing, written, skippedPrefixes) {
  const keep = new Set(written);
  return existing.filter((f) => f.endsWith(".png") && !keep.has(f) && !skippedPrefixes.some((p) => f.startsWith(p)));
}

const MAX_SHOT_HEIGHT = 6000;

// The page scrolls inside `.view` (phone layouts, the Transaction and Bench pages): those are shot at their full
// height, which is what a reader scrolls through. The Line at 1440x900 is the exception: PLAN.md §12 says it fits
// without scrolling, so overflow there is a finding and the viewport stays as it is. `extra` is how far the page
// reaches past the viewport in each direction.
export function captureHeight(view, size, extra) {
  if (view === "line" && size.width === SIZES[0].width && (extra.y > 0 || extra.x > 0)) {
    const by = [extra.y > 0 ? `${extra.y} px vertically` : null, extra.x > 0 ? `${extra.x} px horizontally` : null].filter(Boolean).join(" and ");
    return { height: size.height, problem: `the Line overflows ${size.width}x${size.height} by ${by}; PLAN.md §12 says it fits without scrolling` };
  }
  return { height: extra.y > 0 ? Math.min(size.height + extra.y, MAX_SHOT_HEIGHT) : size.height, problem: null };
}

// What the Line has to have drawn before it is photographed, as selectors into the dashboard's own markup.
// The tag is there from the first transaction on; the rest is what a finished swarm leaves on the screen.
export const TAG_CHECK = { selector: ".line-head .sim-tag", min: 1, what: "the scripted-agents tag in the Line header" };
export const LINE_CHECKS = [
  { selector: ".trunk .block-box", min: 1, what: "a train drawn as a block on the trunk" },
  { selector: ".timeline .m-stale", min: 2, what: "stale notches on the agents' rows" },
  { selector: '.heat-list li[data-hot="true"]', min: 1, what: "a hot heat row" },
  TAG_CHECK,
];
// After the recall the sloppy model's work is struck through and the revert commit sits on the trunk.
export const RECALLED_CHECKS = [
  { selector: ".timeline .strike", min: 1, what: "a struck-through recalled bar" },
  { selector: ".trunk .tick.recall", min: 1, what: "the recall's revert commit on the trunk" },
];

export function shortfalls(checks, counts) {
  return checks.filter((c) => (counts[c.selector] ?? 0) < c.min).map((c) => `${c.what} (${c.selector}: ${counts[c.selector] ?? 0} of ${c.min})`);
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
  // The landed Transaction shot shows the screenshot verify took, and that costs a browser run per train.
  process.env.RYKE_SCREENSHOTS = "1";
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers")) process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
  const { chromium } = await import("playwright");

  const written = [];
  const skipped = []; // file name prefixes of variants this run left out on purpose; their old shots stay
  const problems = []; // console errors and page errors, with where they happened
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
        problems.push({ where, kind: "console.error", text: m.text(), url });
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
    // full height, which is the whole page as a reader would scroll it. The Line at 1440x900 must not scroll:
    // that is reported (captureHeight) and the shot is taken at the size it is supposed to fit.
    async function snap(view, variant) {
      for (const size of SIZES) {
        for (const scheme of SCHEMES) {
          await page.setViewportSize(size);
          await page.emulateMedia({ colorScheme: scheme });
          await settle(150);
          const extra = await page.evaluate(() => {
            const v = document.querySelector(".view");
            const root = document.documentElement;
            return {
              y: v ? Math.max(0, v.scrollHeight - v.clientHeight) : 0,
              x: Math.max(0, root.scrollWidth - root.clientWidth, v ? v.scrollWidth - v.clientWidth : 0),
            };
          });
          const { height, problem } = captureHeight(view, size, extra);
          if (problem) problems.push({ where: `${view}-${variant} ${size.width}-${scheme}`, kind: "overflow", text: problem, url: "" });
          if (height !== size.height) {
            await page.setViewportSize({ width: size.width, height });
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

    // Waits for what the plan says the Line shows, and fails (rather than photographs a broken Line) when it
    // never appears.
    const countsOf = (checks) => page.evaluate((sels) => Object.fromEntries(sels.map((q) => [q, document.querySelectorAll(q).length])), checks.map((c) => c.selector));
    async function expectDrawn(checks, label, timeout = 60_000) {
      let missing = [];
      try {
        await waitUntil(label, async () => (missing = shortfalls(checks, await countsOf(checks))).length === 0, { timeout, every: 500 });
      } catch {
        throw new Error(`${label}: the Line is missing ${missing.join("; ")}`);
      }
    }

    // The fonts ship with the dashboard (@fontsource), so a shot in a fallback face means the bundle is broken.
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return ["Geist Variable", "Geist Mono Variable"].every((f) => [...document.fonts].some((x) => x.family.replace(/"/g, "") === f && x.status === "loaded"));
    });
    if (!fonts) problems.push({ where, kind: "fonts", text: "Geist and Geist Mono did not load: the shots would use the fallback fonts", url: "" });

    await waitUntil("a mid-run state with trains, stale notches and heat", async () => {
      if (swarm.exitCode !== null) throw new Error("the swarm finished before the mid-run condition (landed >= 6, stale >= 2, trains >= 2, heat) was reached");
      return midRunReady(await readOps(stack.apiUrl));
    }, { timeout: 15 * 60_000, every: 1000 });
    where = "line mid-run";
    await expectDrawn(LINE_CHECKS, "line-mid");
    const tag = (await page.locator(".line-head .sim-tag").first().textContent()) ?? "";
    if (!/scripted/.test(tag)) problems.push({ where, kind: "sim-tag", text: `the Line header says "${tag}", not that the agents are scripted`, url: "" });
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
    await expectDrawn(LINE_CHECKS, "line-end");
    await snap("line", "end");

    // ------------------------------------------------------------ Transaction view
    const ops = await readOps(stack.apiUrl);
    const picks = pickTxns(ops);
    const { missing, optionalMissing } = checkVariants(picks);
    for (const variant of missing) {
      problems.push({ where: "transaction views", kind: "missing-variant", text: `this run produced no ${variant} transaction to shoot, so txn-${variant} is missing`, url: "" });
    }
    for (const variant of optionalMissing) {
      say(`no ${variant} transaction in this run; txn-${variant} is optional and is skipped, its previous shots are kept`);
      skipped.push(shotPrefix("txn", variant));
    }
    for (const [variant, id] of Object.entries(picks)) {
      if (!id) continue;
      where = `transaction ${variant} (${id})`;
      await page.evaluate((h) => (location.hash = h), `#/t/${id}`);
      // `.txn-id` alone would match the previous transaction's page until this one has loaded.
      await page.waitForFunction((want) => document.querySelector(".txn-id")?.textContent === want, id, { timeout: 120_000 });
      if (variant === "stale") {
        // The attempt was retried, so its delta is the one the page computes from the snapshots around the retry.
        const first = page.locator('.txn-picker button:text-is("1")');
        if (await first.count()) await first.click();
        try {
          await page.waitForSelector(".txn-diff .txn-ln", { timeout: 60_000 });
        } catch {
          problems.push({ where, kind: "no-delta", text: "the stale attempt shows no delta of its stale path", url: "" });
        }
        await page.waitForFunction(() => !/Reading the stale files/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => {});
      }
      if (variant === "landed") {
        try {
          await page.waitForFunction(() => {
            const img = document.querySelector(".txn-shot img");
            return Boolean(img && img.complete && img.naturalWidth > 0);
          }, null, { timeout: 60_000 });
        } catch {
          problems.push({ where, kind: "no-screenshot", text: "the landed transaction shows no verify screenshot (GET /api/evidence/:file)", url: "" });
        }
      }
      if (variant === "rejected" && !(await page.getByText("wrote a protected path").count())) {
        problems.push({ where, kind: "reason", text: 'the rejected transaction does not say it "wrote a protected path"', url: "" });
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
    // Simulated models are labelled so nobody takes the demo's agents for language models (PLAN.md §0.10).
    if (!options.some((o) => o.startsWith("sloppy-v0 (scripted)"))) throw new Error(`the Recall dialog offers no model "sloppy-v0 (scripted)" (options: ${options.join(" | ")})`);
    await page.locator(".recall select").selectOption("sloppy-v0");
    await page.getByRole("button", { name: "Plan recall", exact: true }).click();
    await page.waitForSelector(".recall-plan", { timeout: 120_000 });
    await snap("recall", "planned");
    say("captured recall-planned; executing the recall");

    await page.getByRole("button", { name: "Execute recall" }).click();
    where = "recall dialog (executing)";
    // Esc must not dismiss the dialog while the reverts and the tests run. Only judged while it is still running.
    if (await page.locator('.recall-foot[data-busy="true"]').count()) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      if (!(await dialog.count())) problems.push({ where, kind: "dismissed", text: "Esc closed the Recall dialog while the recall was executing", url: "" });
    } else say("the recall had already finished, so Esc during execution was not tried");
    await page.waitForSelector(".recall-outcome", { timeout: 5 * 60_000 });
    const tone = await page.locator(".recall-outcome").getAttribute("data-tone");
    if (tone !== "go") problems.push({ where, kind: "recall", text: `the recall did not land (outcome tone "${tone}"): ${(await page.locator(".recall-outcome").innerText()).split("\n").slice(0, 3).join(" | ")}`, url: "" });
    // A struck-through target in the dialog: the recalled transactions of the plan, drawn in --recall.
    if (!(await page.locator('.recall-outcome .recall-rows li[data-tone="revert"]').count())) {
      problems.push({ where, kind: "recall", text: "the outcome lists no struck-through target", url: "" });
    }
    await page.waitForTimeout(600);
    await snap("recall", "executed");

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    where = "line after recall";
    // Not LINE_CHECKS again: minutes later the live window has moved on, and the notches that qualified the
    // mid-run shot may have scrolled off. What this shot is for is the recall.
    await expectDrawn([TAG_CHECK, ...RECALLED_CHECKS], "line-recalled");
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
  // Only a run that passed prunes: a failed one may have stopped before it wrote every view.
  if (!failure && problems.length === 0) {
    for (const f of pruneList(await readdir(SHOTS_DIR), written.map((w) => w.slice(SHOTS_DIR.length + 1)), skipped)) await rm(join(SHOTS_DIR, f));
  }
  console.log(`\nfiles written (${written.length}):`);
  for (const f of written) console.log(`  ${relative(ROOT, f)}  ${(((await stat(f)).size) / 1024).toFixed(0)} kB`);
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
