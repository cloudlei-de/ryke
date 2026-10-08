# Progress

Current: 2026-10-08 09:45 CEST (07:45 UTC). M3 margin fixed (89c8702 retry variant, 016c31e share/favorites tests):
e2e:swarm lands 36 of 36 landable. Fresh-clone quickstart re-verify and a review of both commits in
flight. Then the PR.

| Milestone | State | Verifier evidence (commit) |
|---|---|---|
| M0 Foundations | ACCEPTED | fresh clone `npm ci && npm run check && npm test` (35f5d87): vitest 31 files 3033 tests, node:test 1636 tests, 0 fail; store-contract suite included; gate4 at 243152d: vitest 3041, node 1636 |
| M1 Ledger core | ACCEPTED | `npm run e2e:api` (35f5d87, fresh clone): begin 201 → clone/commit/push → reads `{"recorded":1}` → submit `ready` → wait `verifying` then `landed` (seq 1); 401 without/with a wrong token; 404 unknown txn |
| M2 Landing | ACCEPTED | `npm run e2e:land` (35f5d87): train of 2 lands at seq 1–2; third stale on src/format.ts with the digits = 2 → 3 delta; train of 4 bisected in 3 probes isolating "broken by design", 3 landed; trunk 89 tests green. Runner DO fake-container suite 516 tests. Real container build: BLOCKERS (proxy TLS, API token) |
| M3 Demo + scripted swarm | ACCEPTED | `npm run e2e:swarm` (016c31e, lead run alone): 36 landed (all landable; not landed: dup-speed/dup-kmh G3, kelvin-first, tamper-routes G5 protected), 0 max_attempts, 9 t-precision stale aborts all landed after retry, trunk 723 tests green, preview 26 categories. History: f3eb9c3 36 (verifier), then 34, 34; b76a574 33 (3 max_attempts: retries re-ran v1, fixed in 89c8702); 89c8702 34 (t-share parked by the gate, fixed in 016c31e) |
| M4 Dashboard | ACCEPTED | `npm run shots` (35f5d87): 40 files, 0 console/page errors; Line shows trains (×2 ×2 ×8 …), stale notches, heat (format.ts 8.5 hot); recall dialog shows 2 struck targets and 4 dependents |
| M5 Jev + contention | ACCEPTED (contention evidence from the bench ablation) | judge+heat 207, jev 137 tests; jev-calibration.md 94 % overall (holdout within noise); e2e:contention PASS (hot-file stale aborts 24 on vs 28 off, but 0 lease waits: weak); bench ablation: leases on vs off 56 vs 46 and 64 vs 31 landed/min, stale aborts 106 vs 245 and 246 vs 502 |
| M6 Recall | ACCEPTED | `npm run e2e:recall` (35f5d87): both G6 targets recalled, cascade 1 re-queued and landed at seq 40, 3 dependents revalidated, trunk green |
| M7 Bench | ACCEPTED (lead check of committed results) | bench/results/latest.md (485c763): ryke 58/68/38.5 vs queue 24/19/24.5 vs lock 5.5/5.5/6.5 at 50/100/200; queue wins at 10; 0 breakages in all 12 cells |
| M8 Claude mode | ACCEPTED | `npm run e2e:claude` (35f5d87): 7 landed, tamper rejected protected, 5 categories landed on retry, trunk 207 tests; BLOCKERS has the real smoke command |
| M9 Production + docs | config + docs ACCEPTED; quickstart re-run pending; PR todo | e2e:deploy PASS with `--containers-rollout=none` (image build blocked, BLOCKERS); wrangler production env complete; how-it-works 1500 prose words with §4.3 example and one diagram; deploy.md token list identical to PLAN; README sections present |

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
1. Combined gate → commit the batches (auth/MCP, UI fixes, gateway scoping + access lists, claude-mode
   fixes, e2e scripts, bench ablation, docs).
2. Remaining ledger review items: trunk/store head reconcile (recall push loss, CAS loop), prepare fetch
   error ≠ text_conflict, revert.mjs union list from the Ledger, recall error-path tests, ingest name
   checks, recall scratch ref cleanup.
3. Measured bench alone, then the ryke/ryke-nolease ablation; README bench table; shots rerun; commit.
4. Verifiers per milestone (≤ 2 heavy at once, offsets 0/10/20/30/40); fix; PROGRESS; PR.

## Known issues
- The scripted-swarm contention comparison (e2e:contention) is weak evidence: the catalogue never has two
  concurrent writers of a hot file, so leases never make anyone wait. The bench ablation is the
  measurement of the lease effect (see M5 row).
- At 200 bench agents Ryke's throughput falls to 38.5/min: 464 of 466 stale aborts hit changes already
  ready, waiting for the one train at a time (README says so).
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
