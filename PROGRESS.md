# Progress

Current: 2026-10-08 (UTC evening). PR cloudlei-de/ryke#1 merged (d4a7845). Since: the dashboard redesigned
from scratch (DECISIONS 2026-10-08 · M4), then agents on the person's own subscription or API key, for
Claude Code and Codex (DECISIONS 2026-10-08 · M8, this commit).

| Milestone | State | Verifier evidence (commit) |
|---|---|---|
| M0 Foundations | ACCEPTED | fresh clone `npm ci && npm run check && npm test` (35f5d87): vitest 31 files 3033 tests, node:test 1636 tests, 0 fail; store-contract suite included; gate4 at 243152d: vitest 3041, node 1636; fresh clone at 016c31e (verifier): vitest 31 files 3041, node:test 1644, 0 fail; fresh clone at e03e2e8 (verifier, pipelining on): vitest 31 files 3084, node:test 1807, 0 fail, store-contract 30/30 |
| M1 Ledger core | ACCEPTED | `npm run e2e:api` (35f5d87, fresh clone): begin 201 → clone/commit/push → reads `{"recorded":1}` → submit `ready` → wait `verifying` then `landed` (seq 1); 401 without/with a wrong token; 404 unknown txn |
| M2 Landing | ACCEPTED | `npm run e2e:land` (35f5d87): train of 2 lands at seq 1–2; third stale on src/format.ts with the digits = 2 → 3 delta; train of 4 bisected in 3 probes isolating "broken by design", 3 landed; trunk 89 tests green. Runner DO fake-container suite 516 tests. Real container build: BLOCKERS (proxy TLS, API token) |
| M3 Demo + scripted swarm | ACCEPTED | `npm run e2e:swarm` (016c31e, lead run alone): 36 landed (all landable; not landed: dup-speed/dup-kmh G3, kelvin-first, tamper-routes G5 protected), 0 max_attempts, 9 t-precision stale aborts all landed after retry, trunk 723 tests green, preview 26 categories. History: f3eb9c3 36 (verifier), then 34, 34; b76a574 33 (3 max_attempts: retries re-ran v1, fixed in 89c8702); 89c8702 34 (t-share parked by the gate, fixed in 016c31e) |
| M4 Dashboard | ACCEPTED (redesign) | `npm run shots` after the redesign (main checkout, Geist loaded): 40 files, 0 console/page errors; Line shows trains as capsules, stale notches with a guide from the culprit's commit, hot rows, the scripted-agents tag, and after the recall struck-through targets and the revert commit; recall dialog: 2 targets recalled, 1 cascaded and re-queued, 3 revalidated. Measured: 30 agents fit at 1440x900 (17 px rows, no scroll). Before the redesign: e03e2e8, committed in 5acdac4 |
| M5 Jev + contention | ACCEPTED | judge+heat 207, jev 137 tests; jev-calibration.md at HEAD: 84/89 (94 %), holdout 24/27, all 39 reference patches land; `npm run e2e:contention` PASS at cce3e9f (bench/results/contention/latest.json): scripted leg 279 lease grants, 0 waits, hot-file aborts off 25 / on 27 reported not asserted; bench leg at 50 agents, leases off / on: hot-file stale aborts 185 / 86 (asserted ≥ 20 % fewer), lease waits 0 / 27, landed/min 55 / 64.5; ablation at 8e3bfdd leases on vs off 67 vs 42.5 and 73 vs 38.5 landed/min |
| M6 Recall | ACCEPTED | `npm run e2e:recall` (35f5d87): both G6 targets recalled, cascade 1 re-queued and landed at seq 40, 3 dependents revalidated, trunk green |
| M7 Bench | ACCEPTED (lead check of committed results) | bench/results/latest.md at 1e10234 (code of 8e3bfdd, pipelining on): ryke 24.5/61.5/75.5/43.5 vs queue 23/23/18.5/22 vs lock 6.5/5.5/5.5/6 at 10/50/100/200, 0 breakages in 12 cells; C1 ablation: pipelining on vs off 67 vs 58 (50), 73 vs 55.5 (100), at 200 28.5/44.5/53 vs 36/36.5/37.5 over three runs |
| M8 Claude mode | ACCEPTED | `npm run e2e:claude` (35f5d87): 7 landed, tamper rejected protected, 5 categories landed on retry, trunk 207 tests; BLOCKERS has the real smoke command. Codex and `--auth` (this commit): `npm run e2e:codex` PASS (7 landed, tamper rejected protected, 5 categories landed on retry after a failed verify, trunk 207 tests), `npm run e2e:claude` PASS again (2 stale aborts, 3 failed verifies, all retried to a landing) |
| M9 Production + docs | ACCEPTED, PR open (cloudlei-de/ryke#1) | e2e:deploy PASS with `--containers-rollout=none` (image build blocked, BLOCKERS); wrangler production env complete; how-it-works 1,500 prose words (re-trimmed after the pipelining paragraph) with §4.3 example and one diagram; deploy.md token list identical to PLAN; README sections present; §14 quickstart from a fresh clone at e03e2e8 (verifier): README steps as written, clone to swarm exit 3.6 min, 36 landed, 23 speculative trains all confirmed, all six M3 criteria PASS, dashboard 200 |

## How things fit (for after compaction)
- Worker: `src/worker/index.ts` → api.ts (Hono, /api), mcp.ts (/mcp), /internal/events. service.ts shared by both.
- Ledger DO `src/worker/ledger/ledger.ts`: RPC returns Res unions; autoland flag (tests drive trains by hand
  via formTrain/commitTrain/trainOutcome/trainDone). Index of txn→repo in the `__index` instance.
- Pure: validate.ts, trains.ts (selectTrain + bisect state machine), heat.ts (decay, leaseDecision),
  recall.ts, similar.ts, src/shared/diff.ts, src/shared/policy.ts.
- Store: src/worker/store/{store,local,artifacts}.ts; dev/store (Node, real git). Runner:
  src/worker/runner/{runner,process}.ts; dev/runner. Scripts: containers/runner/bin/*.sh → lib/*.mjs.
- Tests: vitest (workerd) `test/*.test.ts` with globalSetup test/setup/stack.mjs (store, runner, git
  helper on free ports, fixture repo); node:test `test/node/*.test.mjs`. `npm test` runs both.
- dev/stack.mjs = startStack({offset}) used by dev/all.mjs and e2e scripts.

## Next
1. Only fixes for review findings on cloudlei-de/ryke#1 until the code freeze (2026-10-12 23:59 CEST).

## Known issues
- The scripted swarm cannot show what leases buy (no two concurrent writers of a hot file in the
  catalogue); e2e:contention now says so and adds a bench leg where agents contend.
- At 200 bench agents Ryke's throughput falls from 75.5 to 43.5/min: 383 of 390 stale aborts hit changes
  already ready. Pipelining's gain at 200 swings with bisections (28.5 to 53 over three runs).
- The scripted swarm's landed count depends on live Jev and on timing: 33–36 across runs before
  89c8702/016c31e. The causes found (sloppy-a, t-search, t-dark, t-share test names the gate could not
  read; retries re-running v1) are fixed; one category can still run out of attempts when three
  hot-file writers land inside its lifetime.

## Review round 1 (2026-10-08 early morning), all fixed with failing tests first
- [x] A approval survives retry → gate skipped (both reviews)
- [x] B recall plans before waiting for in-flight train; C recall lock persisted in meta (restart wedges lander)
- [x] D agent can create ryke.json (V1 exempts created) when seed had none
- [x] E submit without head trusts push-event head; use store.info(fork)
- [x] F LAND.create failure loops every 200 ms (backoff)
- [x] G recall error paths: no recall.done, partial requeue lost
- [x] H policy patterns not normalised (./test/**, test/), verify null → "null"
- [x] I watchdog ends live train on lookup error; trunk moved but commitTrain missed → reconcile by store head
- [x] J verify gets a WRITE token; revert runs verify where a write remote is configured → split revert into prepare/verify/push jobs, verify read-only
- [x] K jobResult treats timeouts as results; push job cancelled on timeout; repeated train errors loop forever
- [x] L tamper regex misses {skip:true}/{todo:true}/test.todo(; skipped tests not counted
- [x] M landed txns get evidence of the failing whole-train verify
- [x] N recall taints through union paths; union-file revert conflicts should drop only the target's lines
- [~] O test gaps (done except e2e:recall): pushed-candidate asserts, rebuild_failed, unresolved, approved member, push-then-commit-fail, replay memo, recall conflict/cas/503/in-flight, revert.mjs real git, ingest out-of-order, e2e:recall
- [x] P candidate refs leak on non-landed trains; Jev re-asked after removal; DECISIONS for bisect budget, abort states, open→submitted→rejected, retry no alarm

## Log
- 05:00 vitest: 10 files, 523 tests passed (policy 56, validate 52, trains 111, heat 57, recall 76, diff 56,
  similar 60, store-contract 9, ledger 45, health 1).
- 05:40 e2e:recall PASS from a detached worktree (see M6 row). The run before it, in the main tree, was
  wrecked by an edit to src/worker/index.ts: vite reloaded the Worker under the swarm (11 agent_error
  aborts, a train wedged in verifying). Since then stacks from dev/stack.mjs run without a file watcher.
- 06:00 review round 2 (ledger/landing, interfaces/security, claude mode, UI, claims/docs/tests). Blockers:
  verify jobs could push to trunk through an unrestricted gateway (container mode); npm test red since the
  G3 rewording (harness/jev-cases.json); the fresh-clone quickstart sent everything to needs_human
  (recorded Jev); the dashboard froze after `--fresh`. All fixed or being committed; see DECISIONS.
- 06:30 cccc842 gated in a clean worktree: vitest 2647/2647, swarm suite 36/36, other node suites green.
- 07:45 UTC M3 margin: readers-first train ordering rejected (DECISIONS: v1 category tests pin the old
  precision, t-precision would fail its train). Real causes in the per-agent log of a 33-landed run: retries
  re-ran v1 (89c8702) and the gate could not read t-share's tests (016c31e). e2e:swarm at 016c31e: 36 landed.
- 11:45 UTC all seven e2e suites PASS at e03e2e8 (pipelining on): contention (above), swarm 36 landed with 20
  speculative trains all confirmed, land (train of 2, stale delta, bisect 3 probes, trunk 89 green), recall
  (2 targets, 1 cascade re-landed, 3 revalidated), claude, api, deploy (dry run, --containers-rollout=none).
- 12:30 UTC review fixes: docs claims audit (5ca709e), harness counting and margins (cce3e9f); e2e:contention
  PASS at cce3e9f with its JSON committed; calibration re-run at HEAD (94 %, 39/39 reference patches land).
- 13:35 UTC second C1 review fixed (a1301fc: no spec on a ryke.json change, trainBisecting before the first
  probe, committed trains end as landed); e2e:land and e2e:recall PASS at a1301fc. e2e:swarm failed twice
  there on a slow judge API (every gate call timed out at 3 s, answered neutral: 13 then 31 landed); the
  gate now waits 15 s per attempt and the report counts neutral verdicts (a5c0e10): e2e:swarm PASS at
  a5c0e10, 36 landed, 23 speculative trains all confirmed. Gate at a5c0e10: vitest 3095, node 1896.
- 16:50 UTC dashboard redesign (Felix: "komplett neu designed"): new design system, all five views rebuilt, a review
  (shots checks matched the legend, stale guide at the notches' mean, 30 agents did not fit, hidden trunk links)
  fixed in 2906ff1. Then an idle live Line shows its last activity and trunk commits drift at most 16 px. Gate at
  that commit: vitest 3212, node 1914 (run alone; run beside shots, recall-exec timed out at 30 s under load);
  `npm run shots` PASS, 40 files, 0 errors.
- evening UTC: bring your own subscription or key (Felix: "bring your own subscription … für claude code und
  codex … und auch bring your own api key"). `--mode codex`, `--auth subscription|api-key|auto`, login and key
  checks before begin, no credential in a subscription job, refused in containers and on remote runners,
  Codex reads from its event stream, the gateway's OpenAI key swap. Real codex 0.161.0 checked for its flags,
  `login status` and events (OpenAI unreachable from this VM). Gate: vitest 34 files 3227, node 2080, 0 fail;
  e2e:codex and e2e:claude PASS.
