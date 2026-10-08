# Progress

Current: 2026-10-08 06:50 CEST (04:50 UTC). Everything is built; review round 2 (5 reviewers) is being
fixed. Pushed through cccc842; the combined gate (`npm run check && npm test`) is running on the rest.
No milestone is marked accepted until a verifier re-runs its Accept commands.

| Milestone | State | Evidence so far (implementer or lead runs; verifiers still to come) |
|---|---|---|
| M0 Foundations | built | npm test green at cccc842's gate: vitest 27 files 2647 tests; node suites green |
| M1 Ledger core | built | `npm run e2e:api` PASS: create → begin → clone/commit/push → reads `{"recorded":1}` → submit `ready` → wait `landed` seq 1; 401 without/with a wrong token; 404 unknown txn |
| M2 Landing | built | `npm run e2e:land` PASS (train of 2, stale with delta, bisection 3 probes isolates "broken by design", trunk 89 tests) |
| M3 Demo + scripted swarm | built | `npm run e2e:swarm` (Jev live) PASS: 34 landed (threshold 34, zero margin), G3 judged (dup-speed and dup-kmh rejected duplicate_of, dup-velocity warned), G5 protected, t-precision 9 stale aborts all landed after retry, trunk 672 tests, preview 200 with 25 categories |
| M4 Dashboard | built + review fixes | `npm run shots` PASS earlier (40 files, 0 console errors, 502 s); rerun needed after the UI fixes and the bench |
| M5 Jev + contention | built | jev-calibration.md 94 % overall (holdout gain within noise); `npm run e2e:contention` PASS but weak: hot-file stale aborts off 33 vs on 30, 0 lease waits (see Known issues) |
| M6 Recall | built | `npm run e2e:recall` PASS (2 G6 targets, 1 cascade re-queued and landed, trunk green) |
| M7 Bench | harness built | measured run (lock, queue, ryke at 10/50/100/200) and the ryke vs ryke-nolease ablation still to run alone |
| M8 Claude mode | built + review fixes | `npm run e2e:claude` PASS (7 landed incl. retries, tamper rejected, trunk 207 tests); claude-mode suite 283 |
| M9 Production + docs | built | `npm run e2e:deploy` PASS (config checks; image build blocked by the VM proxy, BLOCKERS) |

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
- M5 contention evidence is weak: the scripted catalogue never has two concurrent writers of a hot file,
  so leases never make anyone wait (two samples: off/on hot-file stale aborts 22/16 and 33/30, baseline
  noise larger than the gap). The bench ablation (`ryke` vs `ryke-nolease`, synthetic agents that edit
  hot files) is the measurement that can show the lease effect.
- e2e:swarm has zero margin (exactly 34 landed in five runs): live Jev parks sloppy-a (and sometimes
  t-search/t-dark) in needs_human; cat-typography sometimes hits max_attempts.

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
