# Progress

Current: 2026-10-08 05:10 CEST. M0–M6 built, M7/M8 implementers finishing, M9 config written. No milestone is
marked accepted until a verifier has re-run its Accept commands. All pushed to `feat/ryke-mvp` through 62a095b.

| Milestone | State | Evidence so far |
|---|---|---|
| M0 Foundations | built, needs verifier | npm test green (vitest + node:test); store-contract (local) 9/9 |
| M1 Ledger core | built, needs curl walkthrough + verifier | ledger, api, mcp suites green |
| M2 Landing | built, needs verifier | `npm run e2e:land` PASS (train of 2, stale with delta, bisection 3 probes isolates "broken by design", trunk 89 tests green) |
| M3 Demo app + scripted swarm | built, needs verifier | swarm 12 agents: 37 landed, 9 T-precision stale aborts all landed on retry, G5 protected, trunk 707 tests green, previews 200; G3 reworded (DECISIONS) |
| M4 Dashboard | views built; `npm run shots` in progress | web-line, web-txn, web-bench, web-replay suites |
| M5 Jev + contention | calibration done; contention numbers todo | docs/jev-calibration.md 94 % overall, 89 % holdout; leases held until landing + refresh (0d2a9cd) |
| M6 Recall | built; e2e:recall PASS 05:40, needs verifier | `RYKE_PORT_OFFSET=85 npm run e2e:recall` (clean worktree of 62a095b): swarm 4m45s; recall targets the 2 G6 txns, 4 dependents planned, cascade 1 (kelvin-remove), 3 stay landed revalidated by the recall verify; cascaded intent re-queued and landed on attempt 1; trunk ccfec681 seq 39 tests green; PASS |
| M7 Bench | harness in progress | measured run waits for a quiet VM |
| M8 Claude agent mode | Runner DO + gateway committed; agent.sh, stub, Dockerfile in progress | |
| M9 Production + docs | wrangler production env, README, how-it-works, deploy.md written; dry run todo | |

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
1. e2e:recall result; merge bench, claude mode, interface fixes, recall dialog + shots as each reports.
2. M1 curl walkthrough; contention on/off numbers (M5); measured bench alone on a quiet VM (M7).
3. Export Runner + Outbound (done, uncommitted) → `npm run deploy:dry` (M9).
4. Verifiers per milestone (offsets 0/10/20/30/40), final reviewer round, fixes; then the PR.

## Known issues (review round 1, 2026-10-08 ~07:30) — fixing now, failing tests first
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
