# Ryke build plan

This file is the complete brief for an autonomous build. Read it once end to end before writing any
code, then work milestone by milestone. Every product and architecture decision has already been
made here, so do not reopen it. If reality forces a deviation, record it in `DECISIONS.md` (see §0)
and keep going.

Companion files:
- [docs/challenge.md](docs/challenge.md): the rules.
- [docs/artifacts-notes.md](docs/artifacts-notes.md) and [docs/platform-notes.md](docs/platform-notes.md):
  exact APIs, versions and limits. Cloud sessions have no web search, so these files are the reference.
- [docs/prior-art.md](docs/prior-art.md): what competitors already built, and the failure modes this design answers.

---

## 0. Operating rules for the autonomous run

0.1 **Never wait for a human.** No question in this run gets an answer. When something is ambiguous,
pick the option that best serves the demo described in §11, write one line in `DECISIONS.md`
(`date · milestone · decision · why`), and continue.

0.2 **Branch and pushes.** Work on branch `feat/ryke-mvp`, created from `main`. Commit after each green step
and push after each milestone at minimum. Never push to `main`, never force-push, never create tags.
GitHub GraphQL is blocked in cloud sessions, so use `gh api repos/cloudlei-de/ryke/...` for anything else.
After M9, open one PR `feat/ryke-mvp → main` with `gh api` (title and body rules in `CLAUDE.md`).

0.3 **Gates for every commit.** `npm run check` and `npm test` must pass. A milestone is done only when
its acceptance commands (listed per milestone) pass and their output summary is recorded in `PROGRESS.md`.

0.3a **Complete tests, always.** Every module ships with complete tests in the same commit, never "tests later".
"Complete" means:
- **Pure logic.** Every rule and branch is covered: `validate` V1–V9, train selection incl. fairness, heat decay and
  thresholds, recall planning incl. transitive and cascade, policy globs, the op reducers. Use table-driven tests with the edge cases
  (empty sets, union-only overlaps, protected new-vs-existing files, max attempts).
- **Ledger.** Every state transition in §4.2, including every illegal transition answered with 409, plus idempotent
  push ingest and submit.
- **API and MCP.** Every route and tool: success, 401 without a token, 404 for an unknown id, 409 for a wrong state, 422 for
  invalid input.
- **Store and runner.** The contract suite against the local adapter, using the real git CLI, plus token expiry, read-only
  push rejection, and the event envelope shape.
- **Workflow.** The land path, the stale path, the text-conflict path, bisection with 1 and 2 culprits, compare-and-swap
  rejection, needs_human removal.
- **Harness.** Each agent mode against a running local stack (claude via the stub).
- **End to end.** Every milestone's Accept line exists as an `npm run e2e:*` script, not a manual walkthrough.

No skipped, `.only`, empty or assertion-free tests. A bug fix starts with a failing test.
`PROGRESS.md` records the test count per suite at every milestone.

0.4 **Memory across context compaction.** `PROGRESS.md` is your memory. Keep it current with:
- the current milestone and step,
- what is done, with evidence (command plus key output lines),
- what is next,
- known issues.

Re-read `PROGRESS.md` and the section of this plan for the current milestone after every compaction
and at the start of every milestone.

0.5 **Blockers.** Some things only Felix can provide: Workers Paid, the Cloudflare API token, the
Anthropic API key, a network host that is not allowlisted. Each such need gets one entry in `BLOCKERS.md`
(what is needed, why, which fallback you took). Never stop on a blocker. Every external dependency in
this plan has a local fallback.

0.6 **Time budget and cut list.** All times are CEST. Code freeze is **2026-10-12 23:59**. Felix records
the video on 10-13 and submits on 10-14.

| Checkpoint | Done by |
|---|---|
| 10-09 20:00 | M0, M1 |
| 10-10 20:00 | M2, M3 |
| 10-11 20:00 | M4, M5 |
| 10-12 18:00 | M6, M7, M8 |
| 10-12 23:59 | M9 |

If you miss a checkpoint by more than 4 h, cut in this order. Never cut anything else.
1. C1 speculative pipelining of trains (§5.6, already a stretch)
2. C2 replay scrubber UI (keep the replay API)
3. C3 bench at 200 agents (run 10/50/100)
4. C4 phone layout of the dashboard
5. C5 recall dialog UI (keep the API and CLI)
6. C6 contention admission leases (keep heat measurement and display)

0.7 **Dependencies.** Allowed:
- already installed: hono, react, react-dom, vite, wrangler, vitest 4, @cloudflare/vitest-plugin, typescript
- `@cloudflare/sandbox@1.0.0`, `@cloudflare/worker-bundler`, `agents@0.27.0`,
  `@modelcontextprotocol/server@2.0.0`, `@typesafe-ai/sdk@0.6.0`, `playwright` (dev),
  `@anthropic-ai/claude-code` (container image only)

Anything else needs a line in `DECISIONS.md` explaining why it is cheaper than writing it.
No UI component libraries, no state libraries, no ORMs.

0.8 **Style.** Follow `CLAUDE.md`:
- small modules, no abstraction for a single caller
- comments explain why, not what
- TypeScript strict
- tests for every behaviour in §4 and §5

0.9 **Model and subagents.** The main session (you) is the lead. It owns the schedule, the Ledger
and Land code (§4, §5), every `PROGRESS.md`/`DECISIONS.md` entry, and every commit. It delegates
bounded work to the project subagents in `.claude/agents/`:

| Subagent | Model | Use for | Parallel limit |
|---|---|---|---|
| `implementer` | sonnet | One module or directory with its tests, from a named PLAN section | 9 at once, on disjoint directories only |
| `patch-author` | sonnet | M3 solution patches; split the 40 tasks into 15 batches of 2–3 | 15 at once |
| `verifier` | sonnet | Running Accept commands before `PROGRESS.md` says done; one verifier per criterion group | 5 at once, each with its own `RYKE_PORT_OFFSET` |
| `reviewer` | opus | Reviewing every milestone diff before it is pushed, split by area (ledger, landing, interfaces, UI, tests); fix serious findings first | 5 at once |

- Give each subagent its PLAN section number, the exact files it owns, and the test that must pass.
- Merge its work yourself and re-run `npm run check && npm test` after every merge.
- The VM has 4 vCPU and 16 GB RAM. Subagents mostly wait on the model, so these limits are about file
  ownership, not CPU. Heavy runs are different: at most 2 e2e or swarm runs at once, and the bench always
  runs alone.
- Parallel runs must not share ports or state. `dev/all.mjs` and every e2e script read `RYKE_PORT_OFFSET`
  (default 0). They add it to every port (store 8788, runner 8789, vite 5173) and use `.ryke-<offset>/` as the state dir.
  Give each parallel verifier a distinct offset (0, 10, 20, 30, 40).
- Good parallel splits:
  - M0: `dev/store` ∥ `dev/runner` ∥ `src/shared/policy.ts`
  - M1: `validate.ts` + `trains.ts` + `heat.ts` (pure, one implementer) ∥ MCP tools
  - M4: one implementer per dashboard view, after you have built the shared op reducers
  - M6/M7: `recall.ts` ∥ bench harness

0.10 **Truthfulness.** Never claim a capability the code does not have. The README, the dashboard and the
demo briefing label simulated parts as simulated. The bench uses real git, real merges and real tests,
but its agents are synthetic; the bench page says so.

---

## 1. Product

**Ryke — Git with transactions.** Agents do not branch and open pull requests. Each change is a
**transaction** against a snapshot of trunk:
1. Ryke records what the agent **read** and what it **wrote**.
2. Ryke lands the change only if nothing it read has changed since its snapshot.
3. Otherwise Ryke aborts it and hands the agent the exact delta to retry against.

This is serializable snapshot isolation, the guarantee databases give concurrent writers, applied to a
codebase. Ryke adds four platform capabilities around it, none of which the other entries have:

| # | Capability | One-line pitch |
|---|---|---|
| P1 | Read-set validation | Silent semantic conflicts become precise, early aborts with a delta |
| P2 | Merge trains with bisection | Non-overlapping transactions land together; one bad change is isolated in log₂(n) runs |
| P3 | Contention control | Ryke measures heat per file, warns agents live, and serializes only where it is hot |
| P4 | Fleet recall | One command removes everything an agent (or model, or prompt version) landed and revalidates what depends on it |

Plus the evidence gate, where nobody reads diffs:
- Protected paths cannot be written: existing tests and the policy file. This blocks test tampering.
- Hard checks run in code.
- Judgement calls go to Jev, a calibrated model with typed answers.
- Low confidence escalates to a human.

### 1.1 Vocabulary

Use these words everywhere: code, UI, docs. Never "PR" or "branch" for Ryke concepts.

| Term | Meaning |
|---|---|
| **Repo** | A Ryke-managed codebase; its trunk lives in an Artifacts repo `<repo>` |
| **Trunk** | The single line of history (`main` in the trunk repo); only the lander writes it |
| **Transaction (txn)** | One unit of agent work, id `t_<base36 time><4 random>` |
| **Snapshot** | The trunk sha a transaction attempt started from |
| **Attempt** | A transaction retried against a newer snapshot keeps its id; `attempt` increments (max 3) |
| **Fork** | The Artifacts repo `<repo>--<txnId>` the agent pushes to |
| **Read set R** | Paths the agent read in this attempt |
| **Write set W** | Paths that differ between snapshot and fork head |
| **Footprint** | R ∪ W |
| **Delta** | For stale paths, the diff on trunk between snapshot and current head |
| **Union path** | A path the repo policy declares commutative (registries, changelogs): concurrent additions are fine |
| **Protected path** | A path no transaction may modify or delete (adding new files under a protected dir is allowed) |
| **Train** | A batch of ready transactions with disjoint footprints, verified together and landed as one push |
| **Heat** | Exponentially decayed count of stale-aborts and text conflicts per path |
| **Op log** | Append-only log of every state change; the dashboard, replay and bench are projections of it |
| **Recall** | Reverting every landed transaction matching a selector, then revalidating dependents |

---

## 2. Architecture

```
            agents (Claude Code in containers, any MCP client, synthetic bench agents)
              │  MCP /mcp  ·  HTTP /api  ·  git push to fork (smart HTTP, repo token)
              ▼
┌──────────────────────── Worker "ryke" (Hono) ────────────────────────┐
│  /api/*  /mcp  /preview/:repo/:sha/*  /internal/events  static SPA   │
│                                                                      │
│  Ledger DO (one per repo, SQLite)    Land Workflow (one per train)    │
│   txns, access sets, trunk index,     prepare → verify → judge →      │
│   op log, heat, verdicts, policy      (bisect) → push → commit        │
│   WebSocket op stream (hibernation)                                   │
│   scheduler alarm (forms trains)     Runner DO (container) ── jobs    │
│                                       land.sh verify.sh agent.sh      │
│  Store adapter ── Artifacts binding | local store                     │
│  Runner adapter ── Runner DO (containers) | local process runner      │
│  Judge ── Jev live | recorded fixtures                                │
│  Previews ── Dynamic Workers (env.LOADER) bundling demo app at a sha  │
└──────────────────────────────────────────────────────────────────────┘
```

**Two environments, two adapters each.** These are the only abstractions in the system.

| Env var | Production | Local (default in cloud sessions) |
|---|---|---|
| `RYKE_STORE` | `artifacts`: the `ARTIFACTS` binding, namespace `ryke` | `local`: `dev/store`, a Node service implementing the same contract with real git |
| `RYKE_RUNNER` | `container`: Runner DO driving `ctx.container` | `process`: `dev/runner`, a Node service running the same scripts as host processes |
| `RYKE_JEV` | `live`: `api.typesafe.ai` | `recorded`: fixtures in `test/fixtures/jev/*.json` (unit tests always use this) |

The container scripts (`containers/runner/bin/*.sh`) are the same files in both runner modes. They
take every input from env vars and arguments and write results as JSON to stdout and files.

### 2.1 Repository layout (target)

```
src/shared/            types.ts (Txn, Op, Policy, events), policy.ts (ryke.json parsing + glob match)
src/worker/
  index.ts             Hono app, exports Ledger, Runner, Land
  api.ts               HTTP routes (§6.1)
  mcp.ts               MCP tools (§6.2)
  ledger/ledger.ts     Durable Object: state machine, scheduler, op stream
  ledger/schema.ts     SQL DDL + migrations by version number
  ledger/validate.ts   pure function validate() (§4.3)
  ledger/trains.ts     pure train selection + bisection planning (§5)
  ledger/heat.ts       pure heat math (§7)
  ledger/recall.ts     pure recall planning (§8)
  land.ts              Land Workflow (§5)
  store/store.ts       RepoStore interface; artifacts.ts; local.ts
  runner/runner.ts     Runner interface; container.ts (Runner DO + Outbound gateway); process.ts
  judge.ts             Jev questions (§9), live + recorded
  preview.ts           Dynamic Worker previews (§10.3)
src/web/               dashboard (§12)
containers/runner/     Dockerfile, bin/land.sh verify.sh agent.sh revert.sh, claude/settings.json, hooks/*.mjs
dev/store/             local Artifacts stand-in (§3.2)
dev/runner/            local process runner (§3.3)
dev/all.mjs            starts store, runner, vite dev; one Ctrl-C stops all
harness/               swarm.mjs, bench.mjs, agents/{scripted,claude,synthetic}.mjs, jev-calibrate.mjs
demo/convert/          demo app seed (§10) + tasks.json + solutions/<task>.patch
bench/results/         committed bench outputs
docs/                  how-it-works.md, deploy.md, demo-briefing.md (exists), notes
test/                  vitest (workerd) suites + node:test suites for dev/ and harness/
```

---

## 3. Storage

### 3.1 RepoStore contract (`src/worker/store/store.ts`)

```ts
export type RepoRef = { name: string; remote: string; defaultBranch: string };
export type Commit = { sha: string; parents: string[]; message: string; author: string; at: number };
export interface RepoStore {
  create(name: string, opts?: { description?: string }): Promise<RepoRef>;
  fork(source: string, name: string): Promise<RepoRef>;           // default branch only
  info(name: string): Promise<RepoRef & { head: string | null }>;
  remove(name: string): Promise<boolean>;
  token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<string>;
  log(name: string, opts?: { ref?: string; limit?: number }): Promise<Commit[]>;
  readFile(name: string, ref: string, path: string): Promise<string | null>;
}
```

- **Artifacts adapter.** Maps 1:1 to the binding (docs/artifacts-notes.md):
  - `info()` is the only source of `remote` and `defaultBranch`.
  - `using repo = await env.ARTIFACTS.get(name)` must be disposed.
  - `head` comes from `log({limit:1})`.
  - Tokens come from `createToken(scope, ttl).plaintext`.
- **Errors.** Both adapters throw `StoreError` with `code` ∈ `NOT_FOUND | ALREADY_EXISTS | INVALID | UNAVAILABLE`.
- **Contract test.** One suite, `test/store-contract.test.ts`, runs against the local adapter in CI and against the
  Artifacts adapter when `RYKE_STORE_CONTRACT=artifacts`. That second run is for Felix after Workers Paid is enabled.

### 3.2 Local store (`dev/store`, Node 24, no dependencies)

- **Repos and control API.** Repos are bare repos under `.ryke/store/<namespace>/<name>.git`. The control API mirrors the binding:
  - `POST /v1/repos {name}`
  - `POST /v1/repos/:name/fork {name}` (implemented as `git clone --bare --single-branch`)
  - `GET /v1/repos/:name`
  - `DELETE /v1/repos/:name`
  - `POST /v1/repos/:name/tokens {scope, ttl}`
  - `GET /v1/repos/:name/log`
  - `GET /v1/repos/:name/file?ref=&path=`
- **Git smart HTTP.** Served at `/git/<namespace>/<name>.git/*` by spawning `git http-backend` (CGI env:
  `GIT_PROJECT_ROOT`, `GIT_HTTP_EXPORT_ALL=1`, `PATH_INFO`, `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`).
- **Token format and auth.** Tokens are `art_v1_<40 hex>?expires=<unix>`, the same as Artifacts. Auth works exactly as in production:
  - `Authorization: Bearer <full token>`, or basic auth with the part before `?expires`
  - `read` tokens may only use upload-pack
  - an expired token returns 401
- **Push events.** A `post-receive` hook POSTs to `RYKE_EVENTS_URL` (default `http://127.0.0.1:5173/internal/events`)
  with header `x-ryke-internal: $RYKE_INTERNAL_SECRET` and the **exact Artifacts event envelope**:
  `{type:"cf.artifacts.repo.pushed", source:{type:"artifacts.repo", namespace, repoName}, payload:{ref, before, after, commits:[…], totalCommitsCount, commitsTruncated:false}, metadata:{eventTimestamp}}`.
- **Port.** `RYKE_STORE_PORT`, default 8788. The remote URL format is `http://127.0.0.1:8788/git/<ns>/<name>.git`.

### 3.3 Local process runner (`dev/runner`)

- **API.** `POST /v1/jobs {kind, args, env}` → `{id}`, `GET /v1/jobs/:id` → `{state, exitCode, result}`,
  `GET /v1/jobs/:id/log?offset=` (text), `DELETE /v1/jobs/:id`.
- **Execution.** Each job runs `containers/runner/bin/<kind>.sh` in a fresh temp dir `.ryke/jobs/<id>`.
  `result` is the parsed last line of stdout if it is JSON.
- **Limits.** Concurrency is capped at `RYKE_RUNNER_CONCURRENCY` (default 6) and the rest queue. Port 8789.

### 3.4 Runner contract (`src/worker/runner/runner.ts`)

```ts
export type JobKind = "land" | "verify" | "revert" | "agent";
export interface Runner {
  start(kind: JobKind, args: Record<string, string>, env: Record<string, string>): Promise<string>; // job id
  status(id: string): Promise<{ state: "queued" | "running" | "done" | "failed"; exitCode?: number; result?: unknown }>;
  log(id: string, offset: number): Promise<{ text: string; next: number }>;
  cancel(id: string): Promise<void>;
}
```

The container implementation is a Runner DO per job slot, following docs/platform-notes.md §Sandbox:
- detached `setsid` jobs with pid and exit files, an alarm keep-alive, and the `Outbound` gateway.
- The gateway attaches the Artifacts token and the Anthropic key, so no secret enters a container.

It must compile and have unit tests with a fake `ctx.container`. A real container run happens when Docker builds work in the session
(try once, then record the result in `PROGRESS.md`).

---

## 4. Transactions

### 4.1 Ledger schema (`src/worker/ledger/schema.ts`)

```sql
CREATE TABLE meta    (key TEXT PRIMARY KEY, value TEXT);                         -- schema_version, policy json, repo name
CREATE TABLE txn     (id TEXT PRIMARY KEY, agent TEXT NOT NULL, model TEXT, intent TEXT NOT NULL,
                      criteria TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
                      snapshot TEXT NOT NULL, snapshot_seq INTEGER NOT NULL, fork TEXT NOT NULL, head TEXT,
                      train TEXT, landed_seq INTEGER, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE access  (txn TEXT NOT NULL, attempt INTEGER NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, -- read|write
                      at INTEGER NOT NULL, PRIMARY KEY (txn, attempt, path, kind));
CREATE TABLE trunk   (seq INTEGER PRIMARY KEY, sha TEXT NOT NULL UNIQUE, txn TEXT, at INTEGER NOT NULL);  -- seq 0 = seed
CREATE TABLE changed (seq INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (seq, path));
CREATE TABLE op      (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
                      txn TEXT, agent TEXT, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE heat    (path TEXT PRIMARY KEY, value REAL NOT NULL, at INTEGER NOT NULL);
CREATE TABLE verdict (txn TEXT NOT NULL, attempt INTEGER NOT NULL, question TEXT NOT NULL, value REAL NOT NULL,
                      confidence REAL, detail TEXT, PRIMARY KEY (txn, attempt, question));
CREATE TABLE evidence(txn TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL, -- tests|screenshot|preview|log
                      summary TEXT NOT NULL, ref TEXT, PRIMARY KEY (txn, attempt, kind));
CREATE TABLE lease   (path TEXT PRIMARY KEY, txn TEXT NOT NULL, expires INTEGER NOT NULL);
```

**Why `trunk` and `changed` exist.** Validation must not touch git. The set of paths changed since a snapshot is
`SELECT DISTINCT path FROM changed WHERE seq > :snapshot_seq`, which is microseconds inside the DO.
That is what lets Ryke validate hundreds of transactions per second.

### 4.2 State machine

```
open ──submit──▶ submitted ──validate ok──▶ ready ──train──▶ verifying ──pass──▶ landed ──recall──▶ recalled
  │                 │                          │                 │
  │                 └─validate stale─▶ stale ◀─┘(trunk moved)    ├─fail──▶ failed
  │                                     │                        └─judge low──▶ needs_human ─approve▶ landed
  │                                     └─retry (attempt+1, new snapshot)──▶ open             └reject─▶ failed
  ├─abort──▶ aborted                    failed ─retry──▶ open
  └─protected write / duplicate ──▶ rejected
```

- **Terminal states.** `landed`, `recalled`, `aborted` and `rejected` are terminal. After 3 failed or stale attempts the state becomes `aborted` with
  reason `max_attempts`.
- **Op log.** Every transition appends one op `{kind: "txn.<newState>", txn, agent, data}`. Ops also exist for
  `trunk.advanced`, `train.formed`, `train.bisect`, `stale.warning`, `heat.changed`, `lease.granted|waiting|released`,
  `dup.warning`, `conflict.warning`, `judge.verdict`, `recall.planned`, `recall.done` and `policy.updated`.
- **Retry.** The agent first syncs its fork to the new snapshot (fetch trunk with a read token and rebase or merge
  locally, or start fresh), then calls `retry`.

### 4.3 `validate()` (`src/worker/ledger/validate.ts`)

`validate()` is a pure function. Table-driven tests must cover every rule V1–V9.

```ts
type Input = { reads: string[]; writes: string[]; changedSinceSnapshot: Map<string, number /*seq*/>; policy: Policy };
type Result =
  | { ok: true; unionTouched: string[] }
  | { ok: false; kind: "protected"; paths: string[] }
  | { ok: false; kind: "stale"; paths: { path: string; seq: number }[] };
```

| # | Rule |
|---|---|
| V1 | Any `writes` path that is protected **and existed at the snapshot** (modified or deleted) → `protected`. New files under protected dirs are allowed. |
| V2 | Footprint F = reads ∪ writes. |
| V3 | stale = { p ∈ F ∩ changedSinceSnapshot : p is not a union path }. |
| V4 | If stale is empty → `ok`, `unionTouched` = F ∩ changedSinceSnapshot ∩ union. |
| V5 | Otherwise → `stale` with the paths and the trunk seq that changed each one. |
| V6 | Path matching is literal after normalisation (no leading `./`, posix separators). Globs live only in policy. |
| V7 | A read of a directory listing (Glob/Grep pattern) is recorded as the matched files, not the pattern. Harness responsibility; tested in the harness. |
| V8 | Empty `writes` → `rejected` with reason `empty` (nothing to land). |
| V9 | A path both read and written counts once. |

**Why reads count even for files the agent did not write.** That is the semantic-conflict case.
Example: agent B read `format.ts` to learn the rounding rule and wrote a test expecting 2 decimals.
Agent A changed the rule to 3. The text merges cleanly, yet the trunk breaks. Ryke aborts B *before* merging and gives it A's delta.

**Union paths are still verified.** The merged tree goes through tests. Union only means
"concurrent edits here are expected, let git merge and tests decide".

### 4.4 Early stale warnings

When the trunk advances (`commitTrain`), the Ledger computes the newly changed paths. For every `open` transaction
whose current-attempt read set intersects them, it appends `stale.warning {txn, paths, seq}`. The warning
reaches the agent in two ways:
- `ryke_status`/`ryke_wait` return it,
- the Claude Code hook in §10.4 injects it into the agent's context on its next tool call.

The agent fixes it before submitting, which saves a full abort round trip. The dashboard shows the warning as an amber notch.

### 4.5 Policy (`ryke.json` at the trunk root)

```json
{ "protected": ["test/**", "ryke.json"],
  "union": ["src/registry.ts", "CHANGELOG.md"],
  "verify": "node --test --experimental-strip-types test/",
  "verifyTimeoutSeconds": 120,
  "human": ["src/payments/**"],
  "trainMax": 8 }
```

- The Ledger reloads the policy whenever a landed train changes `ryke.json`. That can only happen via a human
  transaction, because the file is protected.
- Glob support: `**`, `*` and literal. Implement it in `src/shared/policy.ts` (about 30 lines, no dependency).

---

## 5. Landing

### 5.1 Scheduling

The Ledger owns scheduling. Submit, retry, approve and train completion all set an alarm 200 ms out. The
alarm handler:
1. Expires leases.
2. Re-validates every `ready` transaction against the current trunk (the trunk may have moved) and moves stale ones to `stale`.
3. If no train is in flight, forms the next train (§5.2) and starts `env.LAND.create({id: trainId, params})`.

Exactly one train lands at a time per repo. That serialises trunk writes and makes the push a natural
compare-and-swap.

### 5.2 Train selection (`trains.ts`, pure)

1. Take `ready` transactions in FIFO order of `submitted_at`.
2. Greedily add each transaction whose footprint is disjoint from the footprints already in the train.
   Union paths don't count, because they may overlap.
3. Stop at `policy.trainMax`.

A transaction that overlaps stays `ready` for the next train. Fairness: a transaction skipped 3 times is
placed first in the next train.

### 5.3 Land Workflow (`land.ts`)

Params: `{repo, trainId, base: trunkSha, txns: [{id, fork, head, attempt}]}`. Steps:

1. **`prepare`.** Runner job `land.sh` (inputs below).
   - Sequence: clone trunk at `base`, then for each transaction in order:
     1. `git fetch <fork remote> <head>`
     2. `git merge-tree --write-tree --messages <current> <head>` with merge base = that transaction's snapshot
     3. on a clean merge, create one squash commit (format in §5.4)
     4. on a conflict, record `{txn, paths}` and skip it
   - Output: `{candidate: sha, applied: [txn…], conflicts: [{txn, paths}]}`, pushed to a scratch ref
     `refs/ryke/candidates/<trainId>` **in the trunk repo**. If the store rejects non-branch refs, use branch
     `ryke-candidate-<trainId>` and delete it after landing. Record which one worked in `DECISIONS.md`.
   - Conflicting transactions go to `stale`, with reason `text_conflict` and the conflicting paths. Their heat increases.
2. **`verify`.** Runner job `verify.sh`: check out the candidate and run `policy.verify` under the timeout.
   - If `demo/convert`-style preview metadata exists (`ryke.json.preview`), also build the preview bundle
     manifest and take a Playwright screenshot of the preview route at 1280×800.
   - Output: `{pass, durationMs, tests: {passed, failed, failures: [{name, message}]}, screenshot?: path}`.
     Store the screenshot as evidence through the store (local: files under `.ryke/evidence`; prod: commit it to
     `refs/notes/ryke-evidence`. Pick one and record it).
3. **`judge`.** Only when verify passes. For each applied transaction, the evidence gate (§9.3) runs in the Worker.
   - Any transaction with `needs_human` is removed from the train. Its commit is dropped by rebuilding the
     candidate without it (repeat `prepare` for the remaining set). It waits for approve or reject.
4. **`bisect`.** Only when verify fails and the train has more than one transaction. Use binary splitting:
   1. Verify the first half on `base`.
   2. If the first half passes, verify (first half + half of the rest), and so on.
   3. Culprits go to `failed` with the failing tests as evidence; everyone else re-forms a train next round.
   - Each verify is one `step.do` so Workflow retries stay granular. The depth limit is log₂(trainMax) + 1.
5. **`push`.** Runner job: `git push <trunk remote> <candidate>:refs/heads/main`. This is non-force, so a
   moved trunk is rejected (compare-and-swap). On rejection, mark all train transactions `ready` again and end the
   instance. The scheduler re-forms the train.
6. **`commit`.** Ledger RPC `commitTrain(trainId, candidateSha, perTxnCommits, changedPathsPerCommit)`:
   - one `trunk` row per transaction commit, plus `changed` rows,
   - transactions → `landed`,
   - ops, stale warnings (§4.4), heat decay, previews.

### 5.4 Commit format on trunk

Each landed transaction is exactly one commit, so recall stays a clean revert:

```
<intent, first line, ≤ 72 chars>

Ryke-Txn: t_k3x9a1b2
Ryke-Agent: agent-07
Ryke-Model: claude-sonnet-5-5
Ryke-Attempt: 2
Ryke-Snapshot: 1a2b3c…
```

The author is the agent id (`agent-07 <agent-07@agents.ryke.ai>`); the committer is `Ryke <lander@ryke.ai>`.
A git note on `refs/notes/ryke` holds JSON `{reads, writes, verdicts, evidence}`. Artifacts supports notes natively.

### 5.5 Push-event path

- **Production.** The `triggers.events` config (platform-notes §Workflows) starts a small workflow `ryke-ingest`
  for every `cf.artifacts.repo.pushed` in namespace `ryke`. It calls the Ledger's `onPush(repoName, ref, after)`,
  which records `head` for the transaction that owns the fork.
- **Local.** `/internal/events` does the same synchronously.
- **Submit.** `submit` without a prior push event fetches the fork head via `store.info()`. Both paths are idempotent.

### 5.6 Stretch C1: speculative pipelining

While train N is in `verify`, train N+1 may run `prepare`+`verify` on top of train N's candidate. If train N
lands, train N+1 is already verified. If it fails, train N+1 is discarded. Do this only after M7 is
green.

---

## 6. Interfaces

### 6.1 HTTP API (`api.ts`, JSON, under `/api`)

**Authentication.**
- Reads are public.
- Writes need `Authorization: Bearer <RYKE_TOKEN>`, a Worker secret; locally `.dev.vars` sets
  `RYKE_TOKEN=dev`.
- Agents get it through the harness.

| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/repos` | `{name, seedFrom?}` → creates the trunk repo, seeds it from `demo/<seedFrom>`, initialises the Ledger |
| GET | `/api/repos/:repo` | → `{head, seq, policy, counts by state, inflight: [{txn, agent, intent, footprint}], heat: top 20}` |
| POST | `/api/repos/:repo/txns` | `{agent, model?, intent, criteria?: string[]}` → `{txn, snapshot, remote, token, policy, warnings[]}` |
| POST | `/api/txns/:id/reads` | `{paths[]}` → `{staleWarnings[]}` (paths is a batch, up to 500) |
| POST | `/api/txns/:id/intend-write` | `{path}` → `{go: true} \| {go: false, owner, retryAfterMs}` (§7.2) |
| POST | `/api/txns/:id/submit` | `{head?, evidence?: {summary}}` → `{state}` |
| POST | `/api/txns/:id/retry` | `{}` → `{snapshot, attempt, delta: [{path, patch}]}` |
| POST | `/api/txns/:id/abort` | `{reason}` |
| POST | `/api/txns/:id/approve` and `/reject` | human gate |
| GET | `/api/txns/:id` | full detail: attempts, access sets, verdicts, evidence, delta if stale |
| GET | `/api/txns/:id/wait?timeout=30` | long-poll until the state changes or a stale warning arrives |
| GET | `/api/repos/:repo/ops?after=<seq>&limit=500` | op page (replay) |
| GET (WS) | `/api/repos/:repo/stream?after=<seq>` | op stream; the server sends `{ops: Op[]}` frames |
| POST | `/api/repos/:repo/recall` | `{selector: {agent?\|model?\|txns?}, dryRun: boolean}` → plan or result (§8) |
| GET | `/api/repos/:repo/files?ref=&path=` | file at a ref (agents without a clone; the MCP read tool uses it) |
| POST | `/api/demo/:repo/start` | `{mode: "scripted"\|"claude", agents}` → starts the swarm in-platform (§11.2) |
| GET | `/api/bench` | latest bench results JSON |

`delta` is the unified diff of each stale path between the snapshot and the current trunk head. It is computed by a
runner `land.sh --mode diff` call, or by fetching both blobs through the store and diffing in the Worker. Choose
whichever is simpler and record it.

### 6.2 MCP tools (`mcp.ts`, route `/mcp`, bearer `RYKE_TOKEN`)

| Tool | Input | Purpose |
|---|---|---|
| `ryke_repo` | `{repo}` | Awareness: trunk head, in-flight intents with live footprints, heat. Call before starting |
| `ryke_begin` | `{repo, intent, criteria?, agent, model?}` | Open a transaction; returns remote, token, warnings |
| `ryke_read` | `{txn, path}` | Read a file at the snapshot **and record the read** (for agents without a clone) |
| `ryke_reads` | `{txn, paths}` | Record reads done through a local clone |
| `ryke_submit` | `{txn}` | After pushing to the fork |
| `ryke_status` | `{txn}` | State, stale paths with delta, verdicts |
| `ryke_wait` | `{txn, timeoutSeconds}` | Long-poll |
| `ryke_retry` | `{txn}` | New attempt against the current trunk |
| `ryke_abort` | `{txn, reason}` | Give up |

Each tool description is written for an agent reader. It says when to call the tool, what the fields mean, and
that reads must be reported or the transaction is serialised against everything.

**Fallback for untracked reads.** If an agent submits with zero recorded reads, Ryke treats its read set as "every file it wrote, plus
every file in the same directories". That is conservative, and the agent gets a warning op.

### 6.3 CLI (`harness/ryke.mjs`)

Thin Node wrapper over the HTTP API for Felix and for scripts:
`ryke repo create convert --seed convert`, `ryke txns`, `ryke recall --agent agent-07 [--dry-run]`,
`ryke swarm …`, `ryke bench …`.

---

## 7. Contention control

### 7.1 Heat (`heat.ts`, pure)

- `heat(p) = value · 2^(-(now - at)/halfLife) + increment`, with halfLife = 5 min.
- Increments: +1 for each `stale` abort that lists p, +1 for each text conflict on p.
- p is hot when heat ≥ 2.
- `heat.changed` ops are throttled to at most 1/s per path.

### 7.2 Admission leases

- **Hook.** In Claude agent mode, a PreToolUse hook on `Edit|Write|MultiEdit` calls `intend-write` for the target path.
- **Grant rule.**
  - The Ledger grants immediately unless p is hot **and** another `open` transaction holds a live lease on p.
  - Otherwise it answers `{go:false, owner, retryAfterMs}`.
  - The hook waits and retries for at most 90 s, then proceeds anyway, so a lease never blocks forever (R2).
- **Lease lifetime.** Leases last 90 s and refresh on every write to p.
- **Effect.** This serialises edits only where the data says conflicts happen. Everywhere else, writes stay fully optimistic.

### 7.3 Duplicates and conflicting intents at `begin`

1. Prefilter in code: trigram Jaccard similarity of the new intent against every `open`/`submitted`/`ready`
   transaction and every transaction landed in the last 30 min. Keep the top 5 with similarity ≥ 0.15.
2. Ask Jev the duplicate and conflict questions (§9.1, §9.2) per candidate, in one request with multiple questions.
3. Act on the answers:

| Jev result | Action |
|---|---|
| duplicate ≥ 0.80 | Reject with reason `duplicate_of:<txn>` |
| duplicate in 0.35–0.80, or conflict score ≥ 1.5 | Open the transaction with a warning naming the other transaction, its intent and its live footprint |
| conflict confidence < 0.3 | Also warn: the agents coordinate instead of guessing |

---

## 8. Recall (`recall.ts`, pure planning + Land-style execution)

1. **Selector.** `{agent}`, `{model}`, or an explicit `{txns}`. The targets T are landed transactions matching it.
2. **Plan (dry run).** Walk the landed transactions after the first target in `landed_seq` order and build the dependents D:
   - x ∈ D if x read or wrote a path that a target (or an earlier dependent) wrote, and x landed after that target.
   - Dependency is transitive.
   - The plan returns the targets, the dependents, and the revert order (reverse landed_seq).
3. **Execute.** A Runner job `revert.sh`:
   - Run `git revert --no-edit` for each target commit, newest first, on the current trunk.
   - If a revert conflicts, revert the conflicting dependent first (it joins `cascade`) and retry.
   - Then run `policy.verify`.
4. **Outcome.**
   - Pass: push and commit. Targets become `recalled`; cascaded dependents become `recalled` with reason `cascade` and are **re-queued** as new
     transactions with the same intent and agent, attempt 1. Non-cascaded dependents stay landed; they were revalidated by the verify run.
   - Fail: re-queue the failing dependents' intents too, and record that in the op log.
5. **Ops.** `recall.planned` holds the full plan (the dashboard animates it); `recall.done` holds the outcome.

---

## 9. Jev (`judge.ts`)

All questions use `jev-1.13.0`. **Do the hard checks in code first. Agent text is untrusted state; never
let it decide alone.** Every Jev call stores its answers in `verdict`.

**Tests use `recorded` mode.**
- Fixtures are keyed by a hash of `{state, questions}`.
- `npm run jev:record` refreshes them through the live API, and needs the network secret.
- When a fixture is missing in recorded mode, return a neutral answer (noul 0.5, confidence 0) and log a warning. Never throw.

### 9.1 Duplicate (per candidate pair)

```ts
noul("Would completing `new_intent` produce essentially the same change to the codebase as completing `existing_intent`?",
     { true: "Both intents ask for the same feature, fix or refactor, even if worded differently",
       false: "They ask for different features, fixes or refactors, even if they touch the same area" })
```

### 9.2 Conflict (per candidate pair, ask both orders a↔b and average)

```ts
score("How do `intent_a` and `intent_b` interact if two agents implement them at the same time on the same codebase?",
  [ "Independent: they change different code and different behaviour",
    "Overlapping but compatible: they touch the same code and both can be satisfied together",
    "Conflicting: completing one breaks, undoes or contradicts what the other requires" ])
```

### 9.3 Evidence gate (per transaction, after verify passed)

Hard checks in code, any failure → `failed`:
- the verify exit code is 0,
- failed tests = 0,
- the write set contains no protected modification (already enforced in V1),
- the diff has no `.only(` or `skip(` added under `test/`.

Then Jev, with state `{intent, criteria, test_summary, new_tests: [names], screenshot_description?, diff_stat}`:
- One noul per criterion: "Does the evidence show that `criterion` is met?". If there are no criteria, use one criterion:
  the intent itself.
- `noul("Does `diff_stat` show changes outside what `intent` needs?")` (scope creep).

Decision:
- Any criterion < 0.35 → `failed`, reason `criterion_unmet`.
- Any criterion in 0.35–0.70, or scope creep ≥ 0.7, or a write matching `policy.human` → `needs_human`.
- Otherwise land.

Only a reasoning model can produce the screenshot description. In claude mode, the agent writes one line describing its screenshot.
In scripted mode the task catalogue provides it. Mark it as agent-provided in the UI.

### 9.4 Calibration

`harness/jev-cases.json` holds at least 24 labelled cases: 8 duplicate/not, 8 conflict levels, 8 evidence
met/unmet. Build them from the demo tasks. `npm run jev:calibrate` reports accuracy and the confidence
distribution into `docs/jev-calibration.md`. Tune the question wording, not the thresholds, until accuracy is ≥ 85 %.
Record the before and after numbers.

---

## 10. Demo app "Convert" and agents

### 10.1 The app (`demo/convert`, seeded as the trunk of repo `convert`)

A tiny Worker (plain `fetch` handler, no dependencies) that renders a unit converter site. It runs as a
Dynamic Worker preview. Seed contents:

```
src/index.ts        routes: / (tiles of categories), /c/:id (converter page), /api/convert?c=&from=&to=&v=
src/registry.ts     export const categories = [length, mass, temperature]   ← union path
src/format.ts       export function formatValue(n: number, digits = 2): string  ← hot by design
src/units/length.ts mass.ts temperature.ts   { id, name, units: [{id, name, toBase, fromBase}] }
src/ui/layout.ts    html shell, nav, footer        ← hot by design
src/ui/styles.ts    css string
test/format.test.ts test/units.test.ts test/routes.test.ts   ← protected (node:test, TS via strip-types)
ryke.json           policy from §4.5 plus "preview": {"main": "src/index.ts"}
CHANGELOG.md        ← union path
```

Tests must run in under 2 s with `node --test --experimental-strip-types test/` on Node 24.

### 10.2 Task catalogue (`demo/convert/tasks.json`)

40 tasks: `{id, intent, criteria[], solution: "solutions/<id>.patch", screenshot_description, tags[]}`.
You write every solution patch against the seed and verify it applies and passes the tests on its own.

| Group | Count | Content | What it demonstrates |
|---|---|---|---|
| G1 New categories | 26 | area, volume, speed, pressure, energy, power, data, time, angle, frequency, fuel economy, force, density, torque, illuminance, radiation, flow, acceleration, cooking, typography, shoe sizes, ring sizes, paper sizes, astronomy, viscosity, currency (static rates). Each adds `src/units/<x>.ts` + a test file + a line in `registry.ts` + a CHANGELOG line | Parallel landing; union paths merge; trains of 8 |
| G2 Cross-cutting | 6 | T-precision: "default precision 3 digits, trims trailing zeros" (changes `format.ts`); T-search: search box in `layout.ts`; T-dark: dark mode in `styles.ts` + toggle in `layout.ts`; T-favorites; T-locale: `formatValue` uses `Intl.NumberFormat`; T-share: copy-link button | Stale reads: every category task that read `format.ts` before T-precision landed is aborted with the delta and retried |
| G3 Duplicates | 3 | a second "add speed category", "add a velocity converter", "support km/h and mph" | Jev rejects or warns at begin |
| G4 Conflict pair | 2 | "show Kelvin first in temperature" vs "remove Kelvin, keep only °C and °F" | Jev conflict warning; one lands, the other stale-aborts |
| G5 Tamper bait | 1 | "make the routes test accept a 404 for /c/unknown as 200" (the patch edits `test/routes.test.ts`) | V1 rejects the protected write |
| G6 Sloppy agent | 2 | assigned to `agent-13` with `model: "sloppy-v0"`; patches land but introduce a subtle UX bug (wrong rounding in one category, caught only by a later task's test) | Recall: `ryke recall --model sloppy-v0` reverts both, revalidates dependents |

### 10.3 Previews (`preview.ts`)

`GET /preview/:repo/:sha/*`:
1. Fetch the files under `src/` at the sha through the store.
2. Bundle them with `@cloudflare/worker-bundler`.
3. Run them through `env.LOADER.get(`${repo}:${sha}`, …)` with `globalOutbound: null`.
4. Cache the bundle per sha in memory.

Every landed transaction and every train candidate gets a preview link in the dashboard.

### 10.4 Agents (`harness/agents/*`)

All three modes speak only the public HTTP/MCP API plus git. That proves the platform is agent-agnostic.

- **scripted.**
  1. Pick a task, `begin`.
  2. Clone the fork.
  3. Report reads = the files its solution patch touches plus the files the task's `reads` list names. For category tasks that list is `format.ts`, `layout.ts`, `registry.ts`.
  4. Wait a think time (lognormal, median 8 s, scaled by `--speed`).
  5. Apply the patch, commit, push, `submit`.
  6. On stale: fetch trunk, rebase, re-apply the patch. If the patch no longer applies, regenerate it from
     `solutions/<id>.v2.patch` when present. Then `retry`.
- **claude.** For each agent, a job of kind `agent` in the runner. It runs `containers/runner/bin/agent.sh`:
  1. Clone the fork.
  2. Install `claude/settings.json` hooks:
     - PostToolUse on `Read|Grep|Glob` → batch POST `/reads`, plus inject pending stale warnings as `additionalContext`
     - PreToolUse on `Edit|Write|MultiEdit` → `intend-write`
     - PostToolUse on edits → records writes
  3. Run `claude --print --output-format stream-json …` (platform-notes) with the prompt below.
  4. After it exits: commit, push, `submit`, then `wait`.
  5. On stale or failed with retries left: re-run claude with the delta or the failing tests appended.

  Verify the hook JSON format against `curl -s https://code.claude.com/docs/en/hooks.md` (that host is in the
  default allowlist).
  - **Without `ANTHROPIC_API_KEY`:** `harness/agents/claude-stub` provides a fake `claude` binary that replays
    `test/fixtures/claude/*.jsonl` and applies the task's solution patch. CI uses it.
  - **Model:** `claude-sonnet-5-5` by default, `--model` overrides it.
- **synthetic** (bench only, §11.3).

Agent prompt for claude mode (`containers/runner/prompt.md`):

```
You are agent {{agent}} working in a Ryke transaction on repo {{repo}}.
Intent: {{intent}}
Acceptance criteria: {{criteria}}
Rules: work only inside this checkout. Read files with the Read tool so Ryke can track your reads.
Never modify existing files under test/ or ryke.json — add new test files instead.
If a hook tells you a file changed on trunk since you read it, re-read it and adapt.
When done, make sure `{{verify}}` passes, then write one line describing what the main page now shows
to .ryke/screenshot.txt and stop. Do not commit; the harness commits.
```

---

## 11. Demo runs

### 11.1 `npm run swarm -- --mode scripted|claude --agents N --repo convert [--speed 4] [--fresh]`

- `--fresh` recreates the repo from the seed.
- The swarm assigns tasks from the catalogue to N concurrent agents, ordered so that the G2 cross-cutting
  tasks start early and land while category tasks are in flight (that guarantees visible stale aborts).
- At the end it prints counts by state, landed per minute, aborts by cause, and the final trunk test result.

### 11.2 In-platform start

`POST /api/demo/:repo/start` runs the same swarm inside the platform:
- in production the agents are Runner jobs,
- locally the Worker calls `dev/runner`, which spawns `harness/swarm.mjs`.

The dashboard's "Run demo" button (admin token required) calls it. Felix uses this for the live demo.

### 11.3 Bench: `npm run bench -- --agents 10,50,100,200 --policy lock,queue,ryke --duration 300`

- **Agents.** Synthetic agents run against a fresh `convert` repo per (policy, N) cell.
  - Each agent loops: begin, choose a footprint, wait a think time, write, push, submit, then handle the outcome.
  - Footprint: reads 3–8 files drawn Zipf(s = 1.1) from the repo's files, so `format.ts`, `layout.ts` and `registry.ts` are hot. Writes are 1–3 files, each a new file with probability 0.6 (new category units/tests) or an edit of a read file otherwise.
  - Think time is lognormal, median 6 s, multiplied by a fixed time factor.
  - Edits are real text changes generated so that 10 % of read-overlap pairs are semantically incompatible: a constant both depend on changes, and a test catches it.
- **Policies.**
  - `lock`: a global mutex from begin to land (the "agent teams with file locks" baseline).
  - `queue`: no read tracking; FIFO, one at a time: merge-tree onto trunk, verify, land; a text conflict or a failed verify sends the agent back to retry. This is what GitHub's merge queue does.
  - `ryke`: everything in this plan.
- **Metrics per cell.** Landed per minute, p50/p95 begin→land seconds, aborts by cause, verify runs per
  landed change, wasted agent-seconds (think time of attempts that did not land), and trunk breakages (must be
  0 for every policy; assert it).
- **Output.** `bench/results/<date>.json` plus `bench/results/latest.md` (table and an ASCII chart), committed. The
  dashboard's Bench view renders the JSON.
- **Sizing.** Each cell runs for `--duration` seconds of wall time. On the cloud VM, keep the whole bench under 40 min:
  reduce the duration or drop N = 200 per cut C3.

---

## 12. Dashboard (`src/web`)

`impeccable` is not available in cloud sessions. This section is the binding design spec. Felix polishes it
later. Build it plainly and precisely, with no generic dark-panel grid.

**World: signal box timetable.** Trunk is the main line, transactions are trains on sidings. Everything reads
like a railway graphic timetable printed on paper.

- **Tokens on `:root`.**
  - `--paper #F3F0E8`, `--ink #121212`, `--rule #121212` at 1 px hairlines, `--muted #6B675F`.
  - Signal colours, used only as signals: `--go #1E7B3C` (landed), `--stop #D9412B` (stale, failed, rejected), `--caution #C78A00` (warning, waiting, needs_human), `--run #2850B8` (verifying), `--recall #7A3FB5`.
  - Dark mode under `@media (prefers-color-scheme: dark)` with `:root:not([data-theme=light])`, plus `[data-theme=dark]`: paper `#101010`, ink `#ECE8DE`, same signals lifted 10 % in lightness.
- **Type.** "IBM Plex Sans Condensed" (UI) and "IBM Plex Mono" (hashes, paths, numbers, tabular-nums), from Google Fonts.
- **Shapes.** No shadows, no rounded cards (radius 0–2 px), no gradients. Hatching (repeating-linear-gradient hairlines) is the only tonal step.

**Views (hash routes):**

1. **Line** (`#/`, the main screen, fits 1440×900 without scrolling):
   - **Top band: trunk.** A horizontal main line; each landed commit is a tick with its txn id on hover. Trains landing
     animate as a block of ticks. Head sha and seq sit at the right.
   - **Middle: sidings.** One row per agent (up to 30 visible, the rest scroll inside the panel). Each attempt is a bar on a shared time axis:
     - open: outline
     - submitted/ready: hatched
     - verifying: `--run`
     - landed: `--go` bar that joins the main line with a short diagonal
     - stale: `--stop` notch, with label `stale · src/format.ts ← t_…` and the retry bar continuing on the same row
     - stale warning: `--caution` tick
     - waiting for lease: `--caution` dotted segment
     - rejected: `--stop` cross
     - recalled: `--recall` strike-through
   - **Right rail.**
     - live counters: in flight, landed/min (1-min window), aborts by cause, trains formed
     - **heat map**: the repo's file list as rows with a heat bar, hot files marked
   - **Bottom: op ticker.** The latest 12 ops in monospace, newest at the top.
2. **Transaction** (`#/t/:id`):
   - intent and criteria
   - attempts timeline
   - read set and write set as two path lists, stale paths flagged with the delta inline
   - verdicts as typed values with probabilities, e.g. `criterion 1 · noul 0.96`
   - evidence: test summary, screenshot, preview link
   - commit sha
3. **Bench** (`#/bench`): the throughput curve (x = agents, y = landed/min, three lines for the three policies, direct labels at the line
   ends, no legend box), plus small multiples for aborts and wasted agent-seconds. A note says the bench agents are synthetic.
4. **Recall** (dialog from the Line view, admin): choose agent or model → dry-run plan visual (targets struck, dependents
   outlined) → Execute.
5. **Replay** (`#/replay`): a scrubber over the op log. The Line view renders from any seq, with play at 1×/4×/16×. Felix uses it to
   record the video without a live run.

**Data flow.** One WebSocket per repo (`/api/repos/:repo/stream`). The client keeps an op array and derives everything
by pure reducers in `src/shared`, the same code the replay uses. No polling.

**Checks.** `npm run shots` (Playwright, Node) runs a scripted swarm at `--speed 8` and captures every view at
1440×900 and 390×844, light and dark, into `docs/shots/`. It also fails the run on any console error. Commit the shots.

---

## 13. Milestones

Each milestone ends with a commit, a push, and a `PROGRESS.md` entry quoting the acceptance output.

### M0 Foundations (≈3 h)

- Create the layout from §2.1, `src/shared/types.ts`, `src/shared/policy.ts` (+ tests).
- Build `dev/store` (§3.2) and `dev/runner` (§3.3) as node:test integration suites using the real `git` CLI: create, fork,
  token auth (read, write and expired), clone, push, the push-event envelope sent to a capture server, readFile, log.
- `dev/all.mjs`, plus npm scripts `dev:all`, `test` (vitest + node:test), `check`.
- **Accept:** `npm test` green, including `test/store-contract.test.ts` against the local adapter.

### M1 Ledger core (≈6 h)

- Schema, state machine, `validate()` (table tests V1–V9), heat math tests, train selection tests.
- HTTP API §6.1 except demo, recall and bench. Op log, plus the WebSocket stream with hibernation.
- MCP tools §6.2 with a test that lists the tools and calls `ryke_begin`.
- **Accept:** vitest suites green; `curl` walkthrough (begin → reads → submit) against `npm run dev:all`,
  recorded in `PROGRESS.md`.

### M2 Landing (≈8 h)

- `land.sh`, `verify.sh` and the Land Workflow (§5.3), compare-and-swap push, commit format and notes (§5.4), push-event ingest (§5.5).
- Runner DO (container mode) with a fake-container unit test. Try one real `wrangler dev` container build and record the result.
- **Accept:** `npm run e2e:land`:
  1. seed `convert`,
  2. 3 transactions, 2 disjoint plus 1 reading a path the first changes → one train of 2 lands, the third goes `stale` with the correct delta,
  3. a train of 4 with one broken transaction → bisection lands 3 and marks 1 `failed` with the failing test name,
  4. trunk tests green.

### M3 Demo app and scripted swarm (≈6 h)

- `demo/convert` seed, 40 tasks, all solution patches, `ryke.json`. Previews (§10.3).
- `harness/swarm.mjs` + scripted agents.
- **Accept:** `npm run swarm -- --mode scripted --agents 12 --fresh --speed 4`:
  - at least 34 tasks land,
  - G3 duplicates rejected or warned,
  - G5 rejected `protected`,
  - at least 5 stale aborts caused by T-precision, each followed by a landed retry,
  - final trunk tests green,
  - `/preview/convert/<head>/` renders all landed categories.

### M4 Dashboard (≈8 h)

- §12 views 1, 2, 3 and 5; view 4 after M6.
- **Accept:** `npm run shots` produces all screenshots with zero console errors; the Line view shows trains,
  stale notches and heat during a scripted swarm.

### M5 Jev and contention (≈4 h)

- §7 and §9: recorded fixtures, `jev:record`, `jev:calibrate`, leases, the hooks for claude mode.
- **Accept:** unit tests; `docs/jev-calibration.md` with ≥ 85 % accuracy (or the best achieved, plus what was tried);
  a scripted swarm with `--contention on` vs `off` shows fewer stale aborts on hot files (numbers in `PROGRESS.md`).

### M6 Recall (≈4 h)

- §8 plus the dashboard dialog.
- **Accept:** `npm run e2e:recall`: after a scripted swarm, `recall --model sloppy-v0` reverts both G6 transactions,
  cascades correctly, re-queues the cascaded intents, and the trunk tests are green.

### M7 Bench (≈6 h)

- §11.3.
- **Accept:** `bench/results/latest.md` committed. `ryke` has the highest landed/min at every N ≥ 50, with zero trunk
  breakages in all cells. If `ryke` does not win, do not tune the bench to make it win. Investigate, fix real
  inefficiencies, and report the honest numbers.

### M8 Claude agent mode (≈4 h)

- `containers/runner` image with Claude Code pinned, hooks and prompt; `agent.sh`; the claude stub; the outbound gateway
  that injects `x-api-key` (container mode) or passes the env key through (process mode).
- **Accept:** `npm run swarm -- --mode claude --agents 3 --stub` lands its tasks. `BLOCKERS.md` contains the exact
  command for Felix's real smoke run once `ANTHROPIC_API_KEY` exists.

### M9 Production readiness and docs (≈4 h)

- Complete `wrangler.jsonc` for production:
  - `artifacts` binding (namespace `ryke`), containers, Runner DO, Ledger DO via `exports`,
  - workflows `ryke-land` + `ryke-ingest`, the `triggers.events` config, `worker_loaders`, `observability`,
  - routes for `ryke.ai`.
- Make sure `npx wrangler deploy --dry-run --outdir .wrangler/dry` succeeds (use `--containers-rollout=none` if image
  builds fail).
- Docs:
  - `docs/how-it-works.md`: for judges, ≤ 1,500 words, with the §4.3 example and one diagram.
  - `docs/deploy.md`: the token permissions below, `wrangler secret put` for `RYKE_TOKEN`, `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`, the deploy command, the smoke checks.
  - README: pitch, 60-second quickstart (`npm ci && npm run dev:all && npm run swarm -- --mode scripted --agents 12 --fresh`), architecture diagram (Mermaid), the bench table, licence.
- Open the PR (§0.2).
- **Accept:** a fresh clone, `npm ci && npm run check && npm test` green; dry-run deploy green; PR open.

**Cloudflare API token for Felix (in `docs/deploy.md`).**
- Account: Workers Scripts Edit, Workers Builds Configuration Edit, Workflows Edit, Containers Edit, Artifacts Edit, Account Settings Read, Workers Tail Read.
- Zone `ryke.ai`: Workers Routes Edit, DNS Edit.
- Nothing else.

---

## 14. Definition of done (whole run)

- [ ] M0–M9 accepted, `PROGRESS.md` complete, `DECISIONS.md` and `BLOCKERS.md` current
- [ ] `npm run swarm -- --mode scripted --agents 12 --fresh` works from a fresh clone in under 10 minutes
- [ ] Bench results and dashboard screenshots committed
- [ ] Every claim in the README is backed by a test, a script or a committed result
- [ ] PR `feat/ryke-mvp → main` open with a Verified list of what actually ran
