# Progress

Current: M0 + M1 in progress (2026-10-08 ~05:00 CEST). Branch `feat/ryke-mvp`.

| Milestone | State | Evidence |
|---|---|---|
| M0 Foundations | in progress | vitest 10 files / 523 tests green incl. store-contract (local); node suites pending |
| M1 Ledger core | in progress | ledger.test.ts 45 tests green; API/MCP suites being written |
| M2 Landing | started | runner seed job done; land.sh + Land workflow next (lead) |
| M3 Demo app + scripted swarm | started | demo/convert seed + tasks.json by implementer |
| M4 Dashboard | todo | |
| M5 Jev + contention | partial | heat + lease logic in Ledger; judge.ts todo |
| M6 Recall | partial | recall.ts pure planning done (76 tests) |
| M7 Bench | todo | |
| M8 Claude agent mode | partial | Runner DO (container) by implementer |
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
1. Merge dev/store, dev/runner, demo seed when implementers report; run `npm test`; commit M0.
2. land.mjs (prepare/push/diff modes) + src/worker/land.ts (Land workflow) + e2e:land.
3. Patch authors for the 40 tasks once the seed exists.

## Known issues
- none yet

## Log
- 05:00 vitest: 10 files, 523 tests passed (policy 56, validate 52, trains 111, heat 57, recall 76, diff 56,
  similar 60, store-contract 9, ledger 45, health 1).
