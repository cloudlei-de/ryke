# Prior art and competing entries (researched 2026-10-08)

## Entries already in the challenge

As of 2026-10-07 there were at least 17 public entries. Five of them were confirmed on GitHub on 2026-10-08.

| Entry | Mechanism | What it lacks |
|---|---|---|
| gitslice-io/gitslice | 104 agents, 102 changes landed, median 7 s from push to merge, Workers AI review, line-level merge | No read-awareness; semantic conflicts surface only in tests |
| rawkode/tartan | Footprint claims, overlap warnings, batches of 4, compare-and-swap trunk | Claims are declared up front; no bisection; no partitioning |
| teslacybrtrk/canon | `main` is defined as invariants checked against a live preview | Merge trains are still roadmap |
| altrwork/cinq | Hidden tests written by a separate agent; stale changes rebuilt from the goal | No rollback |
| alexeygrigorev/cloudflare-agent-git | Pairwise trial merges plus tests | Cost grows quadratically with agent count |

Most entries combine the same parts: one fork per agent, declared path or symbol claims, an AI reviewer, why-notes, and best-attempt-wins selection. **Ryke must not look like this.**

## Why declared claims fail

The STORM study found cross-module scope drift in about 90 % of failed multi-agent runs, meaning agents misjudge their own footprint. Same-file edits appeared in about 85 % of failures. Over 40 % of failure symptoms were semantic or assertion failures, not text conflicts.

## Failure modes Ryke's design must answer

| # | Failure mode | Source | Ryke's answer |
|---|---|---|---|
| R1 | Duplicate, converging work: in Anthropic's C compiler run, every agent fixed the same bug | Anthropic | Jev duplicate check when a transaction begins, plus a region heat map |
| R2 | Locks cut throughput: 20 agents ran at the speed of 2–3; agents died holding stale locks | Cursor | No locks; optimistic transactions; leases with TTL only for admission |
| R3 | Agents avoid hard tasks when writes are lock-free | Cursor | Tasks have owners; retries keep the owner |
| R4 | Regressions from new features; agents running tests for hours | C compiler | Protected test suite runs in the gate; tests have time budgets |
| R5 | Silent semantic conflicts: changes merge as text, then the behaviour breaks | STORM, Crystal | **Read-set validation**: a stale read aborts the transaction before merge |
| R6 | Incompatible implicit decisions between parallel writers | Cognition | Stale-read abort, and the agent retries with the delta |
| R7 | Test tampering on 39–76 % of impossible tasks | ImpossibleBench | Protected paths (tests, CI config) cannot be in an agent's write set |
| R8 | Drift and context pollution in long runs | Cursor | One transaction is one short agent run; retries start fresh with the delta |
| R9 | Shared-directory races | GitButler | One fork and one container per transaction |
| R10 | Stale bases after the parent changes | Sapling | Rebase is implicit: landing always validates against the current trunk |
| R12 | A central integrator becomes the bottleneck | Cursor | Trains batch disjoint transactions; bisection keeps one failure from blocking all |
| R14 | Repeated peeking selects false winners | Fork Arena | No best-of-N selection in Ryke |
| R15 | 2,000 git requests per 10 s per repo | Artifacts limits | Agents push to their own forks; only the lander writes trunk |

## Open gaps Ryke takes

- **I1 Read-set validation (serializable snapshot isolation for code).** No entry does it. This is our core.
- **I3 Speculative merge trains with bisection.** Tartan batches 4 without bisection; Canon has it on its roadmap.
- **I4 Contention control.** Measures heat per code region, then throttles or serializes there. No entry does it.
- **I5 Fleet-wide recall.** Removes everything one agent did and revalidates what depends on it. No entry does it.
- **Measured throughput curve.** Landed changes per minute against agent count, compared with lock and FIFO-queue baselines. Gitslice shows one number; nobody shows the curve.

## Licences to avoid embedding

Mergiraf is GPL-3. Don't vendor it. Ryke must stay MIT.
