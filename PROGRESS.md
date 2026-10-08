# Progress

Current: 2026-10-08 ~06:40 CEST. M0–M2 built and committed; M3 swarm, M5 Jev, container gateway in progress.
Commits on feat/ryke-mvp: 6e5e37b core, 75ca247 demo+verify+e2e:land, 9efcb71 recall, cb5289a fixes+previews, fe49b5b dashboard.

| Milestone | State | Evidence |
|---|---|---|
| M0 Foundations | built, needs verifier | npm test green: vitest 532 + node 383 at 05:30; store-contract (local) 9/9 |
| M1 Ledger core | built, needs curl walkthrough + verifier | ledger 45, api 263, mcp 126 tests |
| M2 Landing | built, needs verifier | `npm run e2e:land` PASS (train of 2, stale with delta, bisection 3 probes isolates "broken by design", trunk 89 tests green) |
| M3 Demo app + scripted swarm | swarm in progress | demo seed + 40 tasks + 70 patches (check.mjs all --strict 73/73); previews 76 tests |
| M4 Dashboard | views built | web-line 288, web-txn 185, web-bench 113, web-replay 130; `npm run shots` todo |
| M5 Jev + contention | in progress | judge-questions.ts refactor; calibration implementer running |
| M6 Recall | built, e2e:recall todo | recall-exec 10 tests (cascade, forced second pass, requeue) |
| M7 Bench | todo | |
| M8 Claude agent mode | partial | container Runner DO 239 tests; gateway token minting in progress |
| M9 Production + docs | todo | |

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
1. Swarm implementer reports → commit; run M3 accept; contention on/off numbers (M5).
2. Jev implementer reports → commit judge tests + fixtures + calibration doc.
3. Bench (M7) implementer; claude mode (M8) implementer; e2e:recall; npm run shots.
4. Verifiers per milestone, reviewers per area; then M9 wrangler production config + docs + PR.

## Known issues
- none yet

## Log
- 05:00 vitest: 10 files, 523 tests passed (policy 56, validate 52, trains 111, heat 57, recall 76, diff 56,
  similar 60, store-contract 9, ledger 45, health 1).
