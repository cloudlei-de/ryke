# Artifacts: what the platform gives us (researched 2026-10-08)

Sources: developers.cloudflare.com/artifacts/, `cloudflare/workerd` `types/defines/artifacts.d.ts`,
`cloudflare/ci`, `cloudflare/artifact-fs`, `cloudflare/computer`.

## Binding

```jsonc
"artifacts": [{ "binding": "ARTIFACTS", "namespace": "default" }]
```

- `env.ARTIFACTS`: `create(name, opts)`, `get(name)`, `import({source, target})`, `list()`, `delete(name)`.
- Repo handle (`using repo = await env.ARTIFACTS.get(name)`): `info()`, `createToken(scope, ttl)`,
  `revokeToken()`, `fork(name, opts)`, `log({ref, limit})`, `readCommit`, `readTree`, `readBlob`,
  `readFile({ref, path})`.
- **No write, commit, diff, merge or ref-update.** Every write is a git push, from isomorphic-git
  (Worker/DO, in-memory, no rebase) or the git CLI (Sandbox container).
- Repo metadata comes only from `info()`; some doc examples read `repo.remote` directly, the types disagree.

## Git

- Remote `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`, smart HTTP only.
- Token `art_v1_<hex>?expires=<unix>`, repo-scoped, read or write, TTL 60 s to 1 year. Bearer header
  with the full token, or basic auth with the part before `?expires`.
- Fetch on protocol v1/v2 incl. shallow; push on v1 receive-pack only; `filter` unsupported; git notes work.
- Each repo is one Durable Object running a Zig/Wasm git server.

## Events

- `cf.artifacts.repo.{created,deleted,forked,imported,pushed,cloned,fetched,token.created,token.revoked}`.
- Push payload `{ref, before, after, commits[], totalCommitsCount, commitsTruncated}`; deletion has `after` = 40 zeros.
- Namespace-wide push events reach a Workflow through config (the docs page shows the wrong shape):

  ```jsonc
  "triggers": { "events": [{ "type": "cf.artifacts.repo.pushed",
    "filter": { "namespace": "NS" },
    "targets": [{ "type": "workflow", "workflow_name": "land" }] }] }
  ```
- Queue subscriptions get push events only per repo (`--source artifacts.repo --source-repo-name`).

## Limits and money

- 1 GB per repo, 32 MB per file, 2,000 git requests per 10 s per repo, unlimited repos.
- Open beta, Workers Paid. 10k ops/month and 1 GB-month included, then 0.15 USD per 1k ops and
  0.50 USD per GB-month. Billing starts 2026-10-14 (docs) or 10-15 (blog).
- Jurisdiction `eu`/`us` per namespace, fixed at creation via REST.

## Patterns worth copying

- Fork per task: `project.fork(\`task-${id}\`)`, one repo per agent session.
- Sandbox never sees the token: `container.interceptOutboundHttps(host, ctx.exports.GitGateway)` adds
  the auth header in a `WorkerEntrypoint` and can restrict to upload-pack.
- `@cloudflare/ci` runs push-triggered Workflows with steps in Sandbox containers; `examples/self-healing`
  lets an agent fix failures and push.
- Agent context (prompt, model output) as git notes under `refs/notes/*`.
- Workers Builds production branch must be `main`; other branches get Preview URLs (500 per Worker).
