# Decisions

`date · milestone · decision · why`

- 2026-10-08 · setup · npm instead of bun · bun package fetching breaks behind the cloud-session proxy
- 2026-10-08 · setup · local Artifacts stand-in · miniflare only proxies the Artifacts binding to the real service, and Workers Paid is not active yet
- 2026-10-08 · M0 · Node 22.22 stays on PATH (n installed 24 to /usr/local/bin, but the session PATH puts /opt/node22 first); all code targets 22 and 24 · the session's shell init cannot be changed mid-run
- 2026-10-08 · M0 · demo verify command is `node --test --experimental-strip-types test/*.test.ts` · `node --test` rejects a directory argument on Node 22 and 24
- 2026-10-08 · M0 · RepoStore gains `files(name, ref)` and `diff(name, base, head)` (A/M/D) · V1 needs to know whether a protected write existed at the snapshot, and the untracked-read fallback, heat map and previews need listings, without a git checkout; the Artifacts adapter walks trees and skips equal subtree hashes
- 2026-10-08 · M0 · local store accepts token TTLs from 1 s (Artifacts minimum is 60 s; the Artifacts adapter clamps) · token-expiry tests must not wait a minute
- 2026-10-08 · M0 · runner job scripts are thin `bin/<kind>.sh` wrappers over Node modules in `containers/runner/lib` · JSON results and git plumbing are simpler and testable in Node; the image ships Node 24
- 2026-10-08 · M0 · JobKind adds `seed` (first trunk commit from demo/<seed>) and `swarm` (process mode only, §11.2) · the Worker cannot push to a repo
- 2026-10-08 · M0 · in process mode job remotes carry credentials as basic-auth userinfo; in container mode the Outbound gateway adds them · one job talks to several repos with different tokens
- 2026-10-08 · M0 · dev/ and harness/ are plain ESM .mjs; node:test suites live in test/node/*.test.mjs, vitest owns test/**/*.test.ts · no build step for Node-side code
- 2026-10-08 · M0 · vitest picks free ports per run and its globalSetup starts store, runner and a git helper there · parallel subagent test runs collided on fixed ports
- 2026-10-08 · M0 · state dir is `.ryke` at offset 0 and `.ryke-<offset>` otherwise · matches §3.2 paths and keeps parallel stacks apart
- 2026-10-08 · M1 · Ledger schema adds txn.submitted_at, skips, detail (JSON notes), commit_sha, a `train` table and `txn_index` · FIFO by submit time, fairness counters, stale/conflict/failure notes, a train watchdog, and txn → repo lookup
- 2026-10-08 · M1 · the txn → repo index lives in the Ledger instance named `__index` · `/api/txns/:id` carries no repo and one more DO class is not worth it
- 2026-10-08 · M1 · Ledger RPC methods return `{ok, value} | {ok: false, status, error}` instead of throwing · custom error fields do not survive Workers RPC
- 2026-10-08 · M1 · `retry` returns the new snapshot plus a trunk read token and the agent rebases onto exactly that sha · "sync first, then retry" races with a moving trunk and would corrupt the write set
- 2026-10-08 · M1 · `approve` moves needs_human → ready (flagged approved, the gate skips Jev) instead of straight to landed · trunk only ever takes verified trees
- 2026-10-08 · M1 · a stale or failed outcome on attempt 3 transitions directly to aborted (`max_attempts`, cause in the op) · §4.2 says so and it saves a pointless retry call
- 2026-10-08 · M1 · abort is refused (409) while verifying · the train owns the transaction until it reports
- 2026-10-08 · M1 · `DELETE /api/repos/:repo` and `POST /api/repos {fresh: true}` added · `swarm --fresh` must wipe Ledger and trunk
- 2026-10-08 · M1 · union paths merge with git's built-in union driver (`.git/info/attributes` in land and agent jobs); Convert's registry is one `export { x } from …` line per category · a plain 3-way merge conflicts on concurrent appends, and union only works on self-contained lines
- 2026-10-08 · M1 · zod 4.4.3 added as a dependency · peer of @modelcontextprotocol/server, needed for tool input schemas
- 2026-10-08 · M1 · intent prefilter keeps the plan's 0.15 trigram threshold; G3 duplicate intents share unit wording with their originals · "add a velocity converter" vs "add a speed category" scores 0.128
