# Blockers (things only Felix can provide)

| Need | Why | Fallback in use |
|---|---|---|
| Workers Paid on the Cloudflare account (Artifacts beta, Containers, Dynamic Workers) | Production trunk/forks, the container lander, previews in production | `RYKE_STORE=local` (dev/store), `RYKE_RUNNER=process` (dev/runner), miniflare's worker loader; `npm run deploy:dry` |
| Cloudflare API token (permissions in docs/deploy.md) | Deploy to ryke.ai | `npm run deploy:dry` |
| `ANTHROPIC_API_KEY` | Real Claude swarm agents | Claude stub replaying `test/fixtures/claude/*.jsonl` (`--stub`) |
| A machine whose egress does not re-sign TLS, with Docker | `docker build -f containers/runner/Dockerfile .` stops at `npm install` here (SELF_SIGNED_CERT_IN_CHAIN from the VM proxy) | `npm run deploy:dry` with `--containers-rollout=none`; the job scripts run unchanged under dev/runner |
| A first production run of the store contract against Artifacts | The Artifacts adapter, candidate refs under `refs/ryke/candidates/*`, and the `ryke-ingest` trigger have not met the real service | Same contract suite against dev/store in `npm test`; steps in docs/deploy.md §4 |

## Commands for Felix once the blockers are gone

- Deploy: see docs/deploy.md (`npm run deploy:dry`, then `npm run deploy`).
- Real Claude smoke run (M8), on a machine with the key; about $0.1–0.5 per task:
  ```
  npm i -g @anthropic-ai/claude-code@2.1.293
  ANTHROPIC_API_KEY=sk-ant-… npm run swarm -- --mode claude --agents 3 --stack --fresh --tasks t-precision,cat-area,cat-volume --model claude-sonnet-5-5
  ```
  Add `NODE_USE_ENV_PROXY=1` behind an egress proxy. Without `--stack`, start `npm run dev:all` in another
  terminal first. `claude` must be on PATH (or set `CLAUDE_BIN`); a bad key fails before any transaction begins.
