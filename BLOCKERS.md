# Blockers (things only Felix can provide)

| Need | Why | Fallback in use |
|---|---|---|
| Workers Paid on the Cloudflare account | Artifacts, Containers, Dynamic Workers in production | `RYKE_STORE=local`, `RYKE_RUNNER=process`, local miniflare |
| Cloudflare API token (permissions in PLAN.md §13 M9) | Deploy to ryke.ai | `wrangler deploy --dry-run` |
| `ANTHROPIC_API_KEY` | Real Claude swarm agents | Claude stub replaying fixtures |
