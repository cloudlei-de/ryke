# Blockers (things only Felix can provide)

| Need | Why | Fallback in use |
|---|---|---|
| Workers Paid on the Cloudflare account (Artifacts beta, Containers, Dynamic Workers) | Production trunk/forks, the container lander, previews in production | `RYKE_STORE=local` (dev/store), `RYKE_RUNNER=process` (dev/runner), miniflare's worker loader; `npm run deploy:dry` |
| Cloudflare API token (permissions in docs/deploy.md) | Deploy to ryke.ai | `npm run deploy:dry` |
| `ANTHROPIC_API_KEY` | Real Claude swarm agents | Claude stub replaying `test/fixtures/claude/*.jsonl` (`--stub`) |
| A first production run of the store contract against Artifacts | The Artifacts adapter, candidate refs under `refs/ryke/candidates/*`, and the `ryke-ingest` trigger have not met the real service | Same contract suite against dev/store in `npm test`; steps in docs/deploy.md §4 |

## Commands for Felix once the blockers are gone

- Deploy: see docs/deploy.md (`npm run deploy:dry`, then `npm run deploy`).
