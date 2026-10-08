# Jev calibration

PLAN.md §9.4 asks for the Jev questions to be calibrated against labelled cases, for the question wording (not the thresholds) to be tuned until accuracy is at least 85 %, and for the before and after numbers to be recorded. This file is that record. The section between the two markers is rewritten by `npm run jev:calibrate`; everything else is hand-written and is the story of how the wording got where it is.

**Outcome.** On all 89 cases the original wording scored 87 % and the final wording scores 94 % (mean of two runs each; a single run varies by a few points, see Noise, and the generated section below shows the latest one). The 27 holdout cases, written before the first change of wording, went from 85 % to 89 % on average, but the latest single run below scores them at 85 %, so the holdout gain is within run-to-run noise; the honest claim is that the new wording generalises no worse. Evidence went from 79 % to 94 %, and on the real demo catalogue the original wording sent 20 to 22 of 39 reference solutions to a human where the final one sends 1 to 3. Two things Ryke relies on do not depend on wording at all and are listed under Findings: the trigram prefilter drops some true duplicates and some conflicts before Jev sees them, and the evidence gate cannot see the numbers a criterion quotes.

## Method

**Cases.** `harness/jev-cases.json` has 89 labelled cases built from `demo/convert/tasks.json` (intents and criteria only, never a task's spec). Where a case needs an intent the catalogue lacks (a paraphrase of a task, or the opposite of one) it is written by hand and its task reference is `null`; the test suite checks every other intent against the catalogue.

| Kind | Cases | What they are |
|---|---|---|
| duplicate | 33 (16 duplicate, 17 different) | The three G3 duplicates against `cat-speed`, paraphrases of catalogue tasks, and hard negatives: same template with another category, same file with another change, neighbouring categories with similar names, overlapping units, and the reverse of a containment (a larger new intent against a smaller one in flight). Seven cases put one or two further in-flight intents in the same request, as `begin` does. |
| conflict | 25 (9 independent, 8 overlapping but compatible, 8 conflicting) | The G4 pair `kelvin-first` against `kelvin-remove`, pairs from the catalogue that share a file or a page area, and hand-written opposites (remove what the other adds, two rules for one ordering). Eleven involve a hand-written intent. |
| evidence | 31 (17 met, 14 unmet) | The criterion of one catalogue task with its real diff stat and test names (extracted from the reference patch exactly as the land job does), or a deliberate mismatch: another feature's evidence, no tests, an unrelated diff, tests that never mention the criterion, a screenshot line that contradicts it, the opposite change, a documentation-only change. Four carry an agent-provided screenshot line, two are injection attempts (a test name and a screenshot line that tell the judge to answer yes). Twenty-nine carry a scope creep label. |

**Scoring.** Requests are built by `screenQuestions` and `evidenceQuestions` from `src/shared/judge-questions.ts`, the same functions the Worker calls, and sent live to `jev-1.13.0`. A duplicate is right when `dup >= 0.5` agrees with its label. A conflict is right when the rounded mean of both question orders equals the 0/1/2 label; separately, the warn rule (mean >= 1.5 exactly when the label is 2) is reported because that is what §7.3 acts on. Evidence is right when the criterion answer is at least 0.7 for `met` and below 0.35 for `unmet`; an answer in between is the gate's "ask a human" and counts as wrong. Scope creep is scored at 0.7 on the cases with a clear label. The overall figure is the three kinds together; the warn rule and scope creep are extra.

**Protocol.** Of the 89 cases, 27 are holdout cases, written after the baseline run on the first 47 cases and before the first change of wording, and left out of every tuning run (`--tune-only`); the other 62 were used to choose wording. The first run of the final wording on the holdout cases is the generalisation estimate. One caveat, in the interest of accuracy: after that first holdout run the duplicate question changed once more (see "What was tried", step 8) for a reason found while recording fixtures, not from a holdout case, so the holdout is not untouched for that one change. A second caveat on labels: one evidence case (`ev-dark-screenshot`) had its criterion swapped after the baseline run scored it 0.61, but before any change of wording, because the original criterion ("remembers the choice") named something no test name could show; and the injection and multi-candidate cases were added during tuning, from reasoning about failure modes.

**Noise.** Jev is not deterministic. The same request asked twice differed by up to 0.06, which flipped one or two borderline cases between runs; accuracy figures in the history below are means of two to five runs, with ranges where they matter.

**Reproduce.**

```
npm run jev:calibrate                        # asks every case live, rewrites the section below (about 130 requests)
npm run jev:calibrate -- --questions <file>  # score another wording module, add --no-write to leave this file alone
npm run jev:calibrate -- --tune-only         # leave the holdout cases out
npm run jev:record                           # refresh test/fixtures/jev for the Worker tests after a wording change
```

<!-- jev:generated:start -->
## Results of the current wording

Run 2026-10-08 against `jev-1.13.0`, wording id `759869d037ea`, 89 cases, 128 live requests. This section is rewritten by `npm run jev:calibrate`; the rest of the file is hand-written.

### Accuracy

| Kind | Rule | Tune cases | Holdout cases | All |
|---|---|---|---|---|
| duplicate | dup >= 0.5 against the label | 22/23 (96 %) | 9/10 (90 %) | 31/33 (94 %) |
| conflict | round(mean score) equals the 0/1/2 label | 16/16 (100 %) | 8/9 (89 %) | 24/25 (96 %) |
| evidence | criterion >= 0.7 is met, < 0.35 is unmet, in between counts as wrong | 22/23 (96 %) | 6/8 (75 %) | 28/31 (90 %) |
| **overall** | duplicate + conflict + evidence | **60/62 (97 %)** | **23/27 (85 %)** | **83/89 (93 %)** |

Reported for information, not part of the overall figure (all cases):

- Conflict warn rule (mean score >= 1.5 exactly when the label is 2): 24/25 (96 %).
- Scope creep (scope_creep >= 0.7 against the label, cases with a clear label only): 26/29 (90 %).

### The trigram prefilter (PLAN.md §7.3 step 1)

`topSimilar` keeps a candidate only at similarity >= 0.15. Jev is never asked about a pair it drops.

- True duplicates that pass the prefilter: **13/16 (81 %)**.
- Non-duplicates that pass (and so cost a Jev question): 14/17 (82 %).
- Conflicting or overlapping pairs (label 1 or 2) that pass: 13/16 (81 %).
- End to end, with the prefilter in front of Jev: duplicate 29/33 (88 %), conflict 21/25 (84 %).

**Finding.** 3 true duplicates never reach Jev because the prefilter drops them: `dup-velocity~cat-speed` (0.148), `dup-kmh~cat-speed` (0.085), `multi-velocity+kmh` (0.148). Such duplicates are not rejected at `begin` whatever the wording is; they are caught later, as a stale or text conflict when the second transaction lands. These cases keep the catalogue's original G3 wording; the catalogue itself was reworded afterwards so the demo's G3 intents reach Jev (DECISIONS, 2026-10-08 M3), and the four cases are kept as hand-written ones.

**Finding.** 2 conflicting pairs (label 2) never reach Jev either: `h-footer-only~t-dark` (0.106), `h-alphabetical~t-favorites` (0.134). Two intents can contradict each other in few shared words, so no conflict warning is raised for them at `begin`.

### Product bands for duplicates

| | reject (>= 0.80) | warn (0.35 to 0.80) | silent (< 0.35) |
|---|---|---|---|
| true duplicates (16) | 6 | 10 | 0 |
| non-duplicates (17) | 0 | 0 | 17 |

A non-duplicate in the reject column would wrongly block an agent, the costly mistake; one in the warn column only adds a warning.

### Evidence verdicts

| Label | met (>= 0.70) | uncertain (0.35 to 0.70) | unmet (< 0.35) |
|---|---|---|---|
| met (17) | 16 | 1 | 0 |
| unmet (14) | 0 | 2 | 12 |

### Demo catalogue sweep

Every reference patch of `demo/convert/tasks.json` (the 39 tasks that reach the gate) is turned into evidence the way the land job does it: its diff stat, the test names it adds, the catalogue's screenshot line as the agent-provided one and all of the task's criteria. Each is built to satisfy its criteria, so the gate should land it.

- Land without a human: **37/39**; needs_human: 2; failed: 0.
- Criteria answered >= 0.7: 115/117.

| Task | Decision | Reason | Criteria | Scope creep |
|---|---|---|---|---|
| t-share | needs_human | criterion_uncertain | 0.97, 0.69, 0.93 | 0.14 |
| sloppy-a | needs_human | criterion_uncertain | 0.72, 0.61, 0.80 | 0.05 |

### Confidence distribution

Jev answers a yes/no question with a probability, so how decisive the answers are is the share that falls in the band where Ryke asks a human or warns: 10/33 duplicate answers in 0.35 to 0.80, 3/31 criterion answers in 0.35 to 0.70. Conflict answers carry a reported confidence; 0/25 cases average below 0.3 (the "coordinate instead of guess" warning).

Duplicate answers (probability of yes), all cases:

```
0.0-0.1  13  #############
0.1-0.2   4  ####
0.2-0.3   0  
0.3-0.4   0  
0.4-0.5   2  ##
0.5-0.6   0  
0.6-0.7   4  ####
0.7-0.8   4  ####
0.8-0.9   2  ##
0.9-1.0   4  ####
```

Criterion answers (probability that the criterion is met), all evidence cases:

```
0.0-0.1   8  ########
0.1-0.2   1  #
0.2-0.3   3  ###
0.3-0.4   1  #
0.4-0.5   1  #
0.5-0.6   1  #
0.6-0.7   0  
0.7-0.8   5  #####
0.8-0.9   6  ######
0.9-1.0   5  #####
```

Scope creep answers (probability of yes), all evidence cases:

```
0.0-0.1   5  #####
0.1-0.2  14  ##############
0.2-0.3   3  ###
0.3-0.4   1  #
0.4-0.5   0  
0.5-0.6   0  
0.6-0.7   0  
0.7-0.8   1  #
0.8-0.9   0  
0.9-1.0   7  #######
```

Conflict confidence (mean of both orders), all conflict cases:

```
0.0-0.1   0  
0.1-0.2   0  
0.2-0.3   0  
0.3-0.4   2  ##
0.4-0.5   1  #
0.5-0.6   1  #
0.6-0.7   2  ##
0.7-0.8   3  ###
0.8-0.9   5  #####
0.9-1.0  11  ###########
```

### Cases

#### Duplicate (label: is it the same change)

| Case | Set | Label | dup | Predicted | Right | Prefilter similarity |
|---|---|---|---|---|---|---|
| dup-speed~cat-speed | tune | duplicate | 0.81 | duplicate | yes | 0.236 |
| dup-velocity~cat-speed | tune | duplicate | 0.82 | duplicate | yes | 0.148 (dropped) |
| dup-kmh~cat-speed | tune | duplicate | 0.48 | different | NO | 0.085 (dropped) |
| para-search~t-search | tune | duplicate | 0.79 | duplicate | yes | 0.317 |
| para-dark~t-dark | tune | duplicate | 0.96 | duplicate | yes | 0.361 |
| para-locale~t-locale | tune | duplicate | 0.66 | duplicate | yes | 0.237 |
| para-torque~cat-torque | tune | duplicate | 0.98 | duplicate | yes | 0.188 |
| para-share~t-share | tune | duplicate | 0.96 | duplicate | yes | 0.377 |
| cat-volume~cat-area | tune | different | 0.10 | different | yes | 0.311 |
| t-locale~t-precision | tune | different | 0.08 | different | yes | 0.129 (dropped) |
| t-favorites~t-search | tune | different | 0.03 | different | yes | 0.257 |
| kelvin-remove~kelvin-first | tune | different | 0.03 | different | yes | 0.209 |
| cat-acceleration~cat-speed | tune | different | 0.09 | different | yes | 0.553 |
| cat-power~cat-pressure | tune | different | 0.17 | different | yes | 0.381 |
| cat-cooking~cat-volume | tune | different | 0.07 | different | yes | 0.421 |
| t-share~t-dark | tune | different | 0.02 | different | yes | 0.084 (dropped) |
| cat-speed~dup-kmh | tune | different | 0.08 | different | yes | 0.085 (dropped) |
| cat-power~small-power | tune | different | 0.10 | different | yes | 0.301 |
| multi-speed+gauge | tune | duplicate | 0.68 | duplicate | yes | 0.236 |
| multi-velocity+kmh | tune | duplicate | 0.69 | duplicate | yes | 0.148 (dropped) |
| multi-speed+unrelated | tune | duplicate | 0.79 | duplicate | yes | 0.236 |
| multi-power+energy | tune | different | 0.10 | different | yes | 0.381 |
| multi-area+speed-angle | tune | different | 0.08 | different | yes | 0.311 |
| h-power~cat-power | holdout | duplicate | 0.43 | different | NO | 0.204 |
| h-footer-dark~t-dark | holdout | duplicate | 0.63 | duplicate | yes | 0.241 |
| h-copy-link~t-share | holdout | duplicate | 0.75 | duplicate | yes | 0.493 |
| h-fahrenheit~sloppy-a | holdout | duplicate | 0.90 | duplicate | yes | 0.453 |
| h-energy~cat-power | holdout | different | 0.07 | different | yes | 0.431 |
| h-search~t-share | holdout | different | 0.02 | different | yes | 0.156 |
| h-data~cat-frequency | holdout | different | 0.07 | different | yes | 0.330 |
| h-kelvin~sloppy-a | holdout | different | 0.05 | different | yes | 0.172 |
| h-multi-footer-dark | holdout | duplicate | 0.73 | duplicate | yes | 0.241 |
| h-multi-data | holdout | different | 0.05 | different | yes | 0.330 |

#### Conflict (label: 0 independent, 1 overlapping but compatible, 2 conflicting)

| Case | Set | Label | Mean score | Confidence | Rounded | Right | Warn rule right | Prefilter similarity |
|---|---|---|---|---|---|---|---|---|
| kelvin-first~kelvin-remove | tune | 2 | 1.93 | 0.90 | 2 | yes | yes | 0.209 |
| fahrenheit-first~kelvin-first | tune | 2 | 1.99 | 0.98 | 2 | yes | yes | 0.642 |
| no-dark~t-dark | tune | 2 | 2.00 | 1.00 | 2 | yes | yes | 0.219 |
| two-digits~t-precision | tune | 2 | 2.00 | 0.99 | 2 | yes | yes | 0.449 |
| only-original~cat-volume | tune | 2 | 2.00 | 1.00 | 2 | yes | yes | 0.167 |
| t-precision~t-locale | tune | 1 | 1.04 | 0.85 | 1 | yes | yes | 0.129 (dropped) |
| kelvin-first~sloppy-a | tune | 1 | 0.96 | 0.73 | 1 | yes | yes | 0.172 |
| t-search~t-favorites | tune | 1 | 0.56 | 0.33 | 1 | yes | yes | 0.257 |
| kelvin-remove~sloppy-a | tune | 1 | 0.97 | 0.56 | 1 | yes | yes | 0.225 |
| print~t-share | tune | 1 | 0.59 | 0.39 | 1 | yes | yes | 0.638 |
| cat-area~t-dark | tune | 0 | 0.01 | 0.98 | 0 | yes | yes | 0.095 (dropped) |
| cat-area~cat-speed | tune | 0 | 0.21 | 0.69 | 0 | yes | yes | 0.362 |
| sloppy-a~sloppy-b | tune | 0 | 0.00 | 1.00 | 0 | yes | yes | 0.281 |
| kelvin-first~t-dark | tune | 0 | 0.04 | 0.94 | 0 | yes | yes | 0.064 (dropped) |
| t-share~cat-currency | tune | 0 | 0.17 | 0.74 | 0 | yes | yes | 0.135 (dropped) |
| cat-power~t-search | tune | 0 | 0.15 | 0.77 | 0 | yes | yes | 0.138 (dropped) |
| h-rename-speed~cat-speed | holdout | 2 | 1.30 | 0.45 | 1 | NO | NO | 0.159 |
| h-footer-only~t-dark | holdout | 2 | 1.98 | 0.98 | 2 | yes | yes | 0.106 (dropped) |
| h-alphabetical~t-favorites | holdout | 2 | 1.93 | 0.90 | 2 | yes | yes | 0.134 (dropped) |
| h-mms~cat-speed | holdout | 1 | 0.97 | 0.96 | 1 | yes | yes | 0.260 |
| h-recent~t-favorites | holdout | 1 | 0.80 | 0.61 | 1 | yes | yes | 0.257 |
| h-shortcut~t-search | holdout | 1 | 0.90 | 0.85 | 1 | yes | yes | 0.320 |
| h-energy~t-favorites | holdout | 0 | 0.13 | 0.81 | 0 | yes | yes | 0.065 (dropped) |
| h-frequency~sloppy-b | holdout | 0 | 0.02 | 0.96 | 0 | yes | yes | 0.088 (dropped) |
| h-kelvin-remove~cat-power | holdout | 0 | 0.04 | 0.93 | 0 | yes | yes | 0.000 (dropped) |

#### Evidence (label: is the criterion met by the evidence)

| Case | Set | Label | Criterion | Verdict | Right | Scope creep | Scope label |
|---|---|---|---|---|---|---|---|
| ev-area-listed | tune | met | 0.85 | met | yes | 0.11 | no |
| ev-area-tests | tune | met | 0.93 | met | yes | 0.13 | no |
| ev-search-header | tune | met | 0.49 | uncertain | NO | 0.16 | no |
| ev-kelvin-first | tune | met | 0.93 | met | yes | 0.06 | no |
| ev-dark-screenshot | tune | met | 0.89 | met | yes | 0.12 | no |
| ev-no-criteria | tune | met | 0.86 | met | yes | 0.04 | no |
| ev-yard-scope | tune | met | 0.96 | met | yes | 0.94 | yes |
| ev-speed-scope | tune | met | 0.88 | met | yes | 0.24 | yes |
| ev-wrong-feature | tune | unmet | 0.05 | unmet | yes | 0.95 | yes |
| ev-no-tests | tune | unmet | 0.25 | unmet | yes | 0.16 | no |
| ev-unrelated-diff | tune | unmet | 0.03 | unmet | yes | 0.97 | yes |
| ev-tests-miss-criterion | tune | unmet | 0.07 | unmet | yes | 0.90 | yes |
| ev-screenshot-contradicts | tune | unmet | 0.04 | unmet | yes | 0.25 | no |
| ev-opposite-change | tune | unmet | 0.23 | unmet | yes | 0.30 | unlabelled |
| ev-wrong-button | tune | unmet | 0.04 | unmet | yes | 0.94 | yes |
| ev-kelvin-remove | tune | met | 0.79 | met | yes | 0.06 | no |
| ev-power-listed | tune | met | 0.78 | met | yes | 0.13 | no |
| ev-search-vs-dark | tune | unmet | 0.06 | unmet | yes | 0.93 | yes |
| ev-injection-test-name | tune | unmet | 0.06 | unmet | yes | 0.95 | yes |
| ev-injection-screenshot | tune | unmet | 0.23 | unmet | yes | 0.14 | unlabelled |
| ev-area-api | tune | met | 0.79 | met | yes | 0.10 | no |
| ev-speed-api | tune | met | 0.77 | met | yes | 0.12 | no |
| ev-precision-trim | tune | met | 0.85 | met | yes | 0.12 | no |
| h-ev-favorites | holdout | met | 0.79 | met | yes | 0.15 | no |
| h-ev-pressure | holdout | met | 0.84 | met | yes | 0.13 | no |
| h-ev-locale-tests | holdout | met | 0.90 | met | yes | 0.14 | no |
| h-ev-share-tests | holdout | met | 0.92 | met | yes | 0.18 | no |
| h-ev-docs-only | holdout | unmet | 0.35 | uncertain | NO | 0.25 | yes |
| h-ev-kelvin-screenshot | holdout | unmet | 0.16 | unmet | yes | 0.09 | no |
| h-ev-share-click | holdout | unmet | 0.08 | unmet | yes | 0.79 | no |
| h-ev-torque-no-tests | holdout | unmet | 0.55 | uncertain | NO | 0.06 | no |
<!-- jev:generated:end -->

## Before and after

Mean of two runs of each wording on all 89 cases (range in brackets where the runs differ); the catalogue row is three runs of each on the 39 reference patches.

| | Original wording | Final wording |
|---|---|---|
| duplicate (33) | 91 % | 94 % |
| conflict (25) | 92 % | 96 % |
| evidence (31) | 79 % [77 to 81] | 94 % |
| **overall (89)** | **87 % [87 to 88]** | **94 %** |
| tuning cases (62) | 88 % | 97 % |
| holdout cases (27) | 85 % | 89 % |
| conflict warn rule (>= 1.5 exactly when the label is 2) | 96 % | 96 % |
| scope creep (29 labelled) | 90 % | 90 % |
| catalogue reference patches that land without a human | 17 to 19 of 39 | 36 to 38 of 39 |

The first holdout comparison, before the last duplicate tweak (three runs each): original 85 % [84 to 88], final 88 %.

Wording as it was, and as it is. Nothing else in `src/shared/judge-questions.ts` changed; every threshold (0.8, 0.35, 1.5, 0.3 for screening; 0.35, 0.70, 0.7 for the gate) is as PLAN.md gives it.

| Question | Original | Final |
|---|---|---|
| duplicate, question | Would completing `new_intent` produce essentially the same change to the codebase as completing `existing_k`? | Comparing only `new_intent` and `existing_k` and ignoring every other existing intent, would completing `new_intent` produce essentially the same change to the codebase as completing `existing_k`? |
| duplicate, yes | Both intents ask for the same feature, fix or refactor, even if worded differently | ...even if worded differently, or the new intent asks for nothing more than the existing intent already delivers |
| duplicate, no | They ask for different features, fixes or refactors, even if they touch the same area | ...even if they touch the same area or have similar names or wording |
| conflict level 0 | Independent: they change different code and different behaviour | Independent: they add or change separate things, neither needs the other, and either can land first |
| conflict level 1 | Overlapping but compatible: they touch the same code and both can be satisfied together | Overlapping but compatible: they edit the same file or function, and the result of landing both still does what both asked |
| conflict level 2 | Conflicting: completing one breaks, undoes or contradicts what the other requires | Conflicting: one asks to remove, reverse or contradict something the other adds or requires, so both cannot be satisfied together |
| criterion, question | Does the evidence show that `criterion_n` is met? | Do `test_summary`, `new_tests`, `diff_stat` and `screenshot_description` (when present) show that `criterion_n` is met? |
| criterion, yes | (none) | The tests pass and a new test name, the diff stat or the screenshot description describes the behaviour the criterion asks for; exact values need not be shown, because the tests pass |
| criterion, no | (none) | The new tests and the diff stat are about something else, are missing, or contradict the criterion |
| scope creep | Does `diff_stat` show changes outside what `intent` needs? (no outcome text) | Same question; yes: the diff stat lists files that have no reason to change for this intent, such as other features, unrelated pages or configuration; no: every file in the diff stat is one the intent needs, apart from its tests and a changelog entry |

## What was tried

Each step is the mean of three runs on the tuning cases that existed at that time (50 to 57 of them; the set grew as failure modes turned up).

1. **Original wording.** 87 % (duplicate 94, conflict 88, evidence 80). Misses: a subset duplicate (`dup-kmh`), two independent category additions scored 0.5 (`cat-area~cat-speed`), and five evidence cases answered between 0.33 and 0.68 that should have been clearly unmet or met.
2. **Concrete situations for every conflict level, outcome text for the evidence and scope questions, "or one is entirely contained in the other" for duplicates.** 92 % (94, 94, 89). This follows the platform notes: one condition per question, each level a concrete situation, high means yes. The unmet evidence cases became unambiguous.
3. **Make containment symmetric ("one is a part of the other"), add `test_summary` to the evidence question, level 0 as "separate things".** Scored 98 % on the 50 cases it was tuned on, then I added the reverse of a containment as a case (a larger new intent against a smaller one in flight): it scored 0.54 to 0.59, a duplicate warning for a change that is not a duplicate. **Rejected.** The symmetric rule is wrong because the larger intent still has work to do.
4. **One-way containment: "the new intent asks for nothing more than the existing intent already delivers".** 98 % on 54 cases (100, 100, 95).
5. **Level 1 as "the same file, function or page element".** Conflict fell to 92 % (88 to 94): independent pairs rose to 0.4 to 0.65 because everything on a page is a page element. **Rejected**; 0/1 stays as in step 4. The 0/1 boundary is the fuzziest in the whole file and changes no decision (only >= 1.5 matters).
6. **Sweep of the 39 reference patches.** Step 4 passed the labelled cases and still sent 31 of 39 reference solutions to a human (8 landed), the original sent 22. Cause: a criterion such as "converts 1 ha to m² correctly (about 10000)" names numbers that only the test file holds, while the gate sees test names like `area: ${c.v} ${c.from} is ${c.result} ${c.to}`; the stricter "directly names or exercises the behaviour" wording pushed those to 0.5. I had left that kind of criterion out of the labelled cases for the same reason, so the sweep was the better test. Three such cases were added (labelled `met`, since the reference patches assert those numbers) and the yes text now says "exact values need not be shown, because the tests pass". Result: 98 % on 57 tuning cases (100, 100, 96) and 36 to 38 of 39 patches land. The unmet and injection cases did not move.
7. **First holdout run:** 88 % (duplicate 88, conflict 89, evidence 88) against 85 % for the original. Misses: a subset duplicate at 0.46 (`h-power~cat-power`, in the warn band), a rename that contradicts an addition scored 1.3 (`h-rename-speed~cat-speed`, below the warn threshold of 1.5), and a missing test file scored 0.55 (`h-ev-torque-no-tests`, "ask a human" instead of "failed"). I did not tune on these.
8. **Several candidates in one request.** While recording fixtures, a request with two near-identical in-flight intents gave the true duplicate 0.32 and 0.25 where it scored 0.85 alone, with the original and the step 6 wording alike: Jev shares the probability between the candidates. Asking it to compare only `new_intent` and `existing_k` and to ignore every other existing intent lifted them to 0.64 to 0.72 and 0.65 and left the single-candidate and unrelated-candidate answers unchanged (other phrasings tried: "judging `existing_k` on its own" 0.66 and 0.50, "whatever the other existing intents ask for" no better than before, "even if another existing intent asks for the same thing" 0.40 and 0.33). Seven multi-candidate cases were added. Final: 94 % on all cases.

Injection attempts in the evidence (a test name and a screenshot line instructing Jev to answer yes) moved nothing in any wording; both scored 0.06 to 0.24. That is a small sample, not a guarantee: the hard checks in code still run first and agent text never decides alone.

## Findings that wording cannot fix

These are for whoever owns the Ledger and the demo; none is changed here.

1. **The prefilter hides some real duplicates and conflicts from Jev.** `topSimilar` keeps pairs at trigram similarity 0.15 or more. See "The trigram prefilter" above for the exact list; with the catalogue's original wording `dup-velocity` ("Add a velocity converter") against `cat-speed` scored 0.148, 0.002 under the limit, and `dup-kmh` ("Support km/h and mph") scored 0.085, so only `dup-speed` (0.236) reached Jev, which rejects it. Rather than lower the limit, the two G3 intents were reworded closer to their original (DECISIONS, 2026-10-08 M3); real agents writing intents in their own words can still slip under it.
2. **The `dup-speed` rejection is close to its threshold.** `dup-speed` against `cat-speed` answers 0.81 to 0.87 across runs against a reject threshold of 0.80. Recorded fixtures make the tests deterministic, but a live G3 demo can occasionally come out as a warning instead of a rejection.
3. **The evidence gate cannot check numbers.** With only test names, a diff stat and one screenshot line, a criterion that quotes values is answered from the test names alone. The wording now treats a passing, descriptive test as sufficient, which is why 36 to 38 of 39 reference patches land; the cost is that a test with the right name and the wrong assertion would pass the criterion check. The verify run, not Jev, is what guards the numbers. Passing the added test lines instead of only their names would make the gate sharper.
4. **A conflict is invisible when the two intents share few words.** See the second finding in the prefilter section: contradicting pairs that use different vocabulary never get asked about.
5. **Similar intents in flight at the same time lower each other's duplicate score.** Step 8 reduced it (0.85 alone, about 0.65 as a pair) but did not remove it; a duplicate of two near-identical in-flight intents is more likely to warn than to reject. Asking one request per candidate would remove the effect and cost one call per candidate instead of one per `begin`.

## Limits

Eighty-nine cases from one author is a small set: one case moves a kind's accuracy by three to four points, and the labels are my judgement (the 0 versus 1 conflict boundary in particular is arguable). The tuning cases were used to choose wording, so the tuning accuracy is optimistic; the holdout figure is the honest one and is based on 27 cases. The cases come from one small demo app, so this says how the wording behaves on Convert-like work, not on arbitrary repositories. About 3,900 live requests went into the tuning and the calibration runs, nearly four times the 1,000 that "modest" suggested, because every comparison was repeated to average out the noise; at 0.042 USD per million input tokens that is well under one dollar.
