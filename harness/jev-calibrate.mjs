// `npm run jev:calibrate` (PLAN.md §9.4): ask the live Jev API every labelled case in
// harness/jev-cases.json, score the answers against the labels and rewrite the results section of
// docs/jev-calibration.md. The requests come from the same builders the Worker uses, so what is
// calibrated is what is asked in production. Tune the question wording, never the thresholds.
//
//   node harness/jev-calibrate.mjs [--questions <module>] [--tune-only] [--no-catalogue] [--out <doc>] [--no-write] [--json <file>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_POLICY } from "../src/shared/policy.ts";
import { catalogueTasks, fixtureKey, liveClient, loadQuestions, mapPool, prefilter, REPO_ROOT, requestOf } from "./lib/jev.mjs";

const CASES = resolve(REPO_ROOT, "harness/jev-cases.json");
const DOC = resolve(REPO_ROOT, "docs/jev-calibration.md");
export const START = "<!-- jev:generated:start -->";
export const END = "<!-- jev:generated:end -->";

// Classification cut-offs used only to score a probability against a yes/no label. The product's
// own thresholds (reject 0.8, warn 0.35, gate 0.35/0.70, scope 0.7) are reported separately.
export const DUP_CUT = 0.5;
export const MET = 0.7;
export const UNMET = 0.35;
export const SCOPE = 0.7;
export const CONFLICT_WARN = 1.5;

const noulOf = (a) => (a?.type === "noul" ? a.noul : 0.5);

export function verdictOf(value) {
  return value >= MET ? "met" : value < UNMET ? "unmet" : "uncertain";
}

// Pure: one case plus Jev's answers in, the scored row out. `q` supplies the real decision rule
// (screenDecision), so the conflict average and its confidence are computed as in §7.3.
export function scoreCase(q, c, answers) {
  const row = scoreRow(q, c, answers);
  return { ...row, holdout: c.holdout === true };
}

function scoreRow(q, c, answers) {
  if (c.kind === "duplicate" || c.kind === "conflict") {
    const d = q.screenDecision(answers, 0);
    const pre = prefilter(c);
    if (c.kind === "duplicate") {
      const predicted = d.dup >= DUP_CUT;
      // A pair the prefilter drops is never asked, which reads as "not a duplicate".
      return { id: c.id, kind: c.kind, label: c.label, dup: d.dup, predicted, correct: predicted === c.label, prefilter: pre, e2e: (pre.passes && predicted) === c.label };
    }
    const predicted = Math.min(2, Math.max(0, Math.round(d.conflict)));
    const warns = d.conflict >= CONFLICT_WARN;
    return {
      id: c.id,
      kind: c.kind,
      label: c.label,
      conflict: d.conflict,
      confidence: d.confidence,
      predicted,
      correct: predicted === c.label,
      warnOk: warns === (c.label === 2),
      lowConfidence: d.warnConflict && !warns,
      prefilter: pre,
      // Without the prefilter hit nothing is asked, which reads as "independent".
      e2e: (pre.passes ? predicted : 0) === c.label,
    };
  }
  const value = noulOf(answers.criterion_1);
  const scope = noulOf(answers.scope_creep);
  const verdict = verdictOf(value);
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    criterion: value,
    verdict,
    correct: verdict === c.label,
    scope,
    scopeLabel: c.scopeCreep ?? null,
    scopeCorrect: c.scopeCreep == null ? null : (scope >= SCOPE) === c.scopeCreep,
  };
}

// The §9.3 decision for one catalogue task, from the real gate rule: every reference solution is
// expected to land, so anything else is a task the gate would hold back.
export function catalogueRow(q, { task, gate }, answers) {
  const { questions } = q.evidenceQuestions(gate);
  const result = q.gateDecision(gate, DEFAULT_POLICY, answers, questions, "live");
  const criteria = result.verdicts.filter((v) => v.question.startsWith("criterion_")).map((v) => v.value);
  const scope = result.verdicts.find((v) => v.question === "scope_creep")?.value ?? 0;
  return { id: task.id, expect: task.expect, decision: result.decision, reason: result.reason, criteria, scope };
}

export function summarizeCatalogue(rows) {
  const count = (d) => rows.filter((r) => r.decision === d).length;
  const all = rows.flatMap((r) => r.criteria);
  return {
    tasks: rows.length,
    land: count("land"),
    needsHuman: count("needs_human"),
    failed: count("failed"),
    criteria: all.length,
    criteriaMet: all.filter((v) => v >= MET).length,
  };
}

const ratio = (rows, f = (r) => r.correct) => ({ n: rows.length, correct: rows.filter(f).length });
const pct = ({ n, correct }) => (n === 0 ? "n/a" : `${correct}/${n} (${Math.round((100 * correct) / n)} %)`);

// Ten buckets over [0, 1]; 1.0 belongs to the last one.
export function histogram(values) {
  const bins = Array(10).fill(0);
  for (const v of values) bins[Math.min(9, Math.max(0, Math.floor(v * 10)))]++;
  return bins;
}

export function summarize(results) {
  const of = (k) => results.filter((r) => r.kind === k);
  const dups = of("duplicate");
  const cons = of("conflict");
  const evs = of("evidence");
  const trueDups = dups.filter((r) => r.label === true);
  const nonDups = dups.filter((r) => r.label === false);
  const band = (rows, lo, hi) => rows.filter((r) => r.dup >= lo && r.dup < hi).length;
  const scoped = evs.filter((r) => r.scopeCorrect !== null);
  // The holdout cases were written before the first wording change and are left out of tuning runs.
  const split = (rows) => ({
    duplicate: ratio(rows.filter((r) => r.kind === "duplicate")),
    conflict: ratio(rows.filter((r) => r.kind === "conflict")),
    evidence: ratio(rows.filter((r) => r.kind === "evidence")),
    overall: ratio(rows),
  });
  return {
    tune: split(results.filter((r) => !r.holdout)),
    holdout: split(results.filter((r) => r.holdout)),
    duplicate: ratio(dups),
    conflict: ratio(cons),
    evidence: ratio(evs),
    overall: ratio(results),
    conflictWarn: ratio(cons, (r) => r.warnOk),
    scope: ratio(scoped, (r) => r.scopeCorrect),
    duplicateE2E: ratio(dups, (r) => r.e2e),
    conflictE2E: ratio(cons, (r) => r.e2e),
    prefilter: {
      trueDuplicates: ratio(trueDups, (r) => r.prefilter.passes),
      nonDuplicates: ratio(nonDups, (r) => r.prefilter.passes),
      conflicts: ratio(cons.filter((r) => r.label > 0), (r) => r.prefilter.passes),
    },
    // The three bands §7.3 acts on: reject (>= 0.8), warn (0.35 to 0.8), silent (< 0.35).
    bands: {
      trueDuplicates: { reject: band(trueDups, 0.8, 2), warn: band(trueDups, 0.35, 0.8), silent: band(trueDups, -1, 0.35) },
      nonDuplicates: { reject: band(nonDups, 0.8, 2), warn: band(nonDups, 0.35, 0.8), silent: band(nonDups, -1, 0.35) },
    },
    verdicts: {
      met: evs.filter((r) => r.label === "met").map((r) => r.verdict),
      unmet: evs.filter((r) => r.label === "unmet").map((r) => r.verdict),
    },
    histograms: {
      duplicate: histogram(dups.map((r) => r.dup)),
      criterion: histogram(evs.map((r) => r.criterion)),
      scope: histogram(evs.map((r) => r.scope)),
      conflictConfidence: histogram(cons.map((r) => r.confidence)),
    },
    uncertain: {
      duplicate: dups.filter((r) => r.dup >= 0.35 && r.dup < 0.8).length,
      criterion: evs.filter((r) => r.criterion >= UNMET && r.criterion < MET).length,
      lowConfidence: cons.filter((r) => r.confidence < 0.3).length,
    },
  };
}

// ---- report -----------------------------------------------------------------------------------

const f2 = (x) => x.toFixed(2);
const f3 = (x) => x.toFixed(3);
const set = (r) => (r.holdout ? "holdout" : "tune");
const bar = (n) => "#".repeat(n);

function histogramBlock(title, bins) {
  const lines = bins.map((n, i) => `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}  ${String(n).padStart(2)}  ${bar(n)}`);
  return `${title}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

const mark = (ok) => (ok ? "yes" : "NO");
const cell = (s) => String(s).replaceAll("|", "\\|");

export function renderReport({ results, summary, sweep = [], meta }) {
  const s = summary;
  const rows = (k) => results.filter((r) => r.kind === k);
  const out = [];
  out.push(START);
  out.push(`## Results of the current wording`);
  out.push(
    `Run ${meta.date} against \`${meta.model}\`, wording id \`${meta.wordingId}\`, ${meta.cases} cases, ${meta.requests} live requests. ` +
      `This section is rewritten by \`npm run jev:calibrate\`; the rest of the file is hand-written.`,
  );
  out.push(`### Accuracy`);
  const both = (k) => `${pct(s.tune[k])} | ${pct(s.holdout[k])} | ${pct(s[k])}`;
  out.push(
    [
      "| Kind | Rule | Tune cases | Holdout cases | All |",
      "|---|---|---|---|---|",
      `| duplicate | dup >= ${DUP_CUT} against the label | ${both("duplicate")} |`,
      `| conflict | round(mean score) equals the 0/1/2 label | ${both("conflict")} |`,
      `| evidence | criterion >= ${MET} is met, < ${UNMET} is unmet, in between counts as wrong | ${both("evidence")} |`,
      `| **overall** | duplicate + conflict + evidence | **${pct(s.tune.overall)}** | **${pct(s.holdout.overall)}** | **${pct(s.overall)}** |`,
    ].join("\n"),
  );
  out.push(
    [
      "Reported for information, not part of the overall figure (all cases):",
      "",
      `- Conflict warn rule (mean score >= ${CONFLICT_WARN} exactly when the label is 2): ${pct(s.conflictWarn)}.`,
      `- Scope creep (scope_creep >= ${SCOPE} against the label, cases with a clear label only): ${pct(s.scope)}.`,
    ].join("\n"),
  );
  out.push(`### The trigram prefilter (PLAN.md §7.3 step 1)`);
  const p = s.prefilter;
  const missed = rows("duplicate").filter((r) => r.label === true && !r.prefilter.passes);
  const missedConflicts = rows("conflict").filter((r) => r.label === 2 && !r.prefilter.passes);
  const ids = (rs) => rs.map((r) => `\`${r.id}\` (${f3(r.prefilter.similarity)})`).join(", ");
  out.push(
    [
      `\`topSimilar\` keeps a candidate only at similarity >= 0.15. Jev is never asked about a pair it drops.`,
      "",
      `- True duplicates that pass the prefilter: **${pct(p.trueDuplicates)}**.`,
      `- Non-duplicates that pass (and so cost a Jev question): ${pct(p.nonDuplicates)}.`,
      `- Conflicting or overlapping pairs (label 1 or 2) that pass: ${pct(p.conflicts)}.`,
      `- End to end, with the prefilter in front of Jev: duplicate ${pct(s.duplicateE2E)}, conflict ${pct(s.conflictE2E)}.`,
      ...(missed.length > 0
        ? [
            "",
            `**Finding.** ${missed.length} true duplicate${missed.length === 1 ? "" : "s"} never reach${missed.length === 1 ? "es" : ""} Jev because the prefilter drops ${missed.length === 1 ? "it" : "them"}: ` +
              ids(missed) +
              `. Such duplicates are not rejected at \`begin\` whatever the wording is; they are caught later, as a stale or text conflict when the second transaction lands.`,
          ]
        : []),
      ...(missedConflicts.length > 0
        ? [
            "",
            `**Finding.** ${missedConflicts.length} conflicting pair${missedConflicts.length === 1 ? "" : "s"} (label 2) never reach${missedConflicts.length === 1 ? "es" : ""} Jev either: ` +
              ids(missedConflicts) +
              `. Two intents can contradict each other in few shared words, so no conflict warning is raised for them at \`begin\`.`,
          ]
        : []),
    ].join("\n"),
  );
  out.push(`### Product bands for duplicates`);
  out.push(
    [
      "| | reject (>= 0.80) | warn (0.35 to 0.80) | silent (< 0.35) |",
      "|---|---|---|---|",
      `| true duplicates (${p.trueDuplicates.n}) | ${s.bands.trueDuplicates.reject} | ${s.bands.trueDuplicates.warn} | ${s.bands.trueDuplicates.silent} |`,
      `| non-duplicates (${p.nonDuplicates.n}) | ${s.bands.nonDuplicates.reject} | ${s.bands.nonDuplicates.warn} | ${s.bands.nonDuplicates.silent} |`,
    ].join("\n"),
  );
  out.push(
    `A non-duplicate in the reject column would wrongly block an agent, the costly mistake; one in the warn column only adds a warning.`,
  );
  out.push(`### Evidence verdicts`);
  const count = (arr, v) => arr.filter((x) => x === v).length;
  out.push(
    [
      "| Label | met (>= 0.70) | uncertain (0.35 to 0.70) | unmet (< 0.35) |",
      "|---|---|---|---|",
      `| met (${s.verdicts.met.length}) | ${count(s.verdicts.met, "met")} | ${count(s.verdicts.met, "uncertain")} | ${count(s.verdicts.met, "unmet")} |`,
      `| unmet (${s.verdicts.unmet.length}) | ${count(s.verdicts.unmet, "met")} | ${count(s.verdicts.unmet, "uncertain")} | ${count(s.verdicts.unmet, "unmet")} |`,
    ].join("\n"),
  );
  if (sweep.length > 0) {
    const c = summarizeCatalogue(sweep);
    const held = sweep.filter((r) => r.decision !== "land");
    out.push(`### Demo catalogue sweep`);
    out.push(
      [
        `Every reference patch of \`demo/convert/tasks.json\` (the ${c.tasks} tasks that reach the gate) is turned into evidence the way the land job does it: its diff stat, the test names it adds, the catalogue's screenshot line as the agent-provided one and all of the task's criteria. Each is built to satisfy its criteria, so the gate should land it.`,
        "",
        `- Land without a human: **${c.land}/${c.tasks}**; needs_human: ${c.needsHuman}; failed: ${c.failed}.`,
        `- Criteria answered >= ${MET}: ${c.criteriaMet}/${c.criteria}.`,
        ...(held.length > 0
          ? [
              "",
              "| Task | Decision | Reason | Criteria | Scope creep |",
              "|---|---|---|---|---|",
              ...held.map((r) => `| ${cell(r.id)} | ${r.decision} | ${r.reason ?? ""} | ${r.criteria.map(f2).join(", ")} | ${f2(r.scope)} |`),
            ]
          : []),
      ].join("\n"),
    );
  }
  out.push(`### Confidence distribution`);
  out.push(
    `Jev answers a yes/no question with a probability, so how decisive the answers are is the share that falls in the band where Ryke asks a human or warns: ` +
      `${s.uncertain.duplicate}/${rows("duplicate").length} duplicate answers in 0.35 to 0.80, ${s.uncertain.criterion}/${rows("evidence").length} criterion answers in 0.35 to 0.70. ` +
      `Conflict answers carry a reported confidence; ${s.uncertain.lowConfidence}/${rows("conflict").length} cases average below 0.3 (the "coordinate instead of guess" warning).`,
  );
  out.push(histogramBlock("Duplicate answers (probability of yes), all cases:", s.histograms.duplicate));
  out.push(histogramBlock("Criterion answers (probability that the criterion is met), all evidence cases:", s.histograms.criterion));
  out.push(histogramBlock("Scope creep answers (probability of yes), all evidence cases:", s.histograms.scope));
  out.push(histogramBlock("Conflict confidence (mean of both orders), all conflict cases:", s.histograms.conflictConfidence));
  out.push(`### Cases`);
  out.push(`#### Duplicate (label: is it the same change)`);
  out.push(
    [
      "| Case | Set | Label | dup | Predicted | Right | Prefilter similarity |",
      "|---|---|---|---|---|---|---|",
      ...rows("duplicate").map(
        (r) => `| ${cell(r.id)} | ${set(r)} | ${r.label ? "duplicate" : "different"} | ${f2(r.dup)} | ${r.predicted ? "duplicate" : "different"} | ${mark(r.correct)} | ${f3(r.prefilter.similarity)}${r.prefilter.passes ? "" : " (dropped)"} |`,
      ),
    ].join("\n"),
  );
  out.push(`#### Conflict (label: 0 independent, 1 overlapping but compatible, 2 conflicting)`);
  out.push(
    [
      "| Case | Set | Label | Mean score | Confidence | Rounded | Right | Warn rule right | Prefilter similarity |",
      "|---|---|---|---|---|---|---|---|---|",
      ...rows("conflict").map(
        (r) => `| ${cell(r.id)} | ${set(r)} | ${r.label} | ${f2(r.conflict)} | ${f2(r.confidence)} | ${r.predicted} | ${mark(r.correct)} | ${mark(r.warnOk)} | ${f3(r.prefilter.similarity)}${r.prefilter.passes ? "" : " (dropped)"} |`,
      ),
    ].join("\n"),
  );
  out.push(`#### Evidence (label: is the criterion met by the evidence)`);
  out.push(
    [
      "| Case | Set | Label | Criterion | Verdict | Right | Scope creep | Scope label |",
      "|---|---|---|---|---|---|---|---|",
      ...rows("evidence").map(
        (r) => `| ${cell(r.id)} | ${set(r)} | ${r.label} | ${f2(r.criterion)} | ${r.verdict} | ${mark(r.correct)} | ${f2(r.scope)} | ${r.scopeLabel === null ? "unlabelled" : r.scopeLabel ? "yes" : "no"} |`,
      ),
    ].join("\n"),
  );
  out.push(END);
  return out.join("\n\n").replace(`${START}\n\n`, `${START}\n`).replace(`\n\n${END}`, `\n${END}`);
}

// Replace the generated region and keep the hand-written text around it; a missing file or missing
// markers gets a skeleton so the first run still produces a usable document.
export function spliceDoc(existing, generated) {
  if (existing && existing.includes(START) && existing.includes(END)) {
    const head = existing.slice(0, existing.indexOf(START));
    const tail = existing.slice(existing.indexOf(END) + END.length);
    return `${head}${generated}${tail}`;
  }
  return `# Jev calibration\n\n${generated}\n`;
}

// ---- run --------------------------------------------------------------------------------------

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function calibrate({ questionsPath, cases, catalogue = [] }) {
  const q = await loadQuestions(questionsPath);
  const live = liveClient({ model: q.MODEL });
  const requests = cases.map((c) => requestOf(q, c));
  const answers = await mapPool(requests, 4, ({ state, questions }) => live.ask(state, questions));
  const results = cases.map((c, i) => scoreCase(q, c, answers[i]));
  const sweep = await mapPool(catalogue, 4, async (entry) => {
    const { state, questions } = q.evidenceQuestions(entry.gate);
    return catalogueRow(q, entry, await live.ask(state, questions));
  });
  // The id covers every request sent, so a change to any wording or any case changes it.
  const wordingId = fixtureKey([...requests, ...catalogue.map((e) => q.evidenceQuestions(e.gate))], {}).slice(0, 12);
  return { results, summary: summarize(results), sweep, requests: live.requests, model: q.MODEL, wordingId, answers };
}

async function main() {
  // --tune-only keeps the holdout cases unseen while the wording is being tuned.
  const cases = JSON.parse(readFileSync(CASES, "utf8")).filter((c) => !(process.argv.includes("--tune-only") && c.holdout));
  const catalogue = process.argv.includes("--no-catalogue") ? [] : catalogueTasks();
  const run = await calibrate({ questionsPath: arg("--questions"), cases, catalogue });
  const meta = { date: new Date().toISOString().slice(0, 10), model: run.model, wordingId: run.wordingId, cases: cases.length, requests: run.requests };
  const report = renderReport({ results: run.results, summary: run.summary, sweep: run.sweep, meta });
  const s = run.summary;
  console.log(
    `duplicate ${pct(s.duplicate)}  conflict ${pct(s.conflict)}  evidence ${pct(s.evidence)}  overall ${pct(s.overall)}` +
      `  | warn-rule ${pct(s.conflictWarn)}  scope ${pct(s.scope)}  | prefilter true dups ${pct(s.prefilter.trueDuplicates)}` +
      (run.sweep.length > 0 ? `  | catalogue lands ${summarizeCatalogue(run.sweep).land}/${run.sweep.length}` : "") +
      `  | ${run.requests} live requests, wording ${run.wordingId}`,
  );
  if (arg("--json")) writeFileSync(resolve(arg("--json")), JSON.stringify({ meta, results: run.results, summary: s, sweep: run.sweep, answers: run.answers }, null, 2));
  if (process.argv.includes("--no-write")) return;
  const out = resolve(arg("--out") ?? DOC);
  writeFileSync(out, spliceDoc(existsSync(out) ? readFileSync(out, "utf8") : "", report));
  console.log(`wrote ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
