# Blockers (things only Felix can provide)

| Need | Why | Fallback in use |
|---|---|---|
| Workers Paid on the Cloudflare account (Artifacts beta, Containers, Dynamic Workers) | Production trunk/forks, the container lander, previews in production | `RYKE_STORE=local` (dev/store), `RYKE_RUNNER=process` (dev/runner), miniflare's worker loader; `npm run deploy:dry` |
| Cloudflare API token (permissions in docs/deploy.md) | Deploy to ryke.ai | `npm run deploy:dry` |
| Your own Claude login (Pro or Max) or `ANTHROPIC_API_KEY` | Real Claude swarm agents | Claude stub replaying `test/fixtures/claude/*.jsonl` (`--stub`) |
| Your own Codex login (ChatGPT plan) or an OpenAI key, and a machine that reaches OpenAI | Real Codex swarm agents; this VM's proxy blocks openai.com, so Codex ran only against its stub and as `codex exec` with no reachable API | Codex stub (`harness/agents/codex-stub`, `--mode codex --stub`), `npm run e2e:codex` |
| Your reading of OpenAI's terms for Codex on a ChatGPT plan | They could not be fetched here; Ryke applies Anthropic's rule (your own login, the official CLI, your own machine, never in hosted Ryke) to both | DECISIONS 2026-10-08 · M8 |
| A machine whose egress does not re-sign TLS, with Docker, plus the API token | `docker build -f containers/runner/Dockerfile .` stops at `npm install` here (SELF_SIGNED_CERT_IN_CHAIN from the VM proxy). A local container run through the dev server (`CLOUDFLARE_ENV=production npx vite dev`) stops earlier: the remote Artifacts binding needs CLOUDFLARE_API_TOKEN. Plain `wrangler dev --env production` cannot run this config at all (the assets directory comes from the Vite plugin) | `npm run deploy:dry` with `--containers-rollout=none` (`npm run e2e:deploy`); the job scripts run unchanged under dev/runner; the Runner DO is unit-tested against a fake container |
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
- The same on your Claude subscription instead of a key: run `claude` once and `/login` with your Pro or Max
  account, then `--auth subscription` in place of the key (three agents draw on your plan's limits).
- Codex, on your ChatGPT plan or a key:
  ```
  npm i -g @openai/codex@0.161.0 && codex login
  npm run swarm -- --mode codex --auth subscription --agents 3 --stack --fresh --tasks t-precision,cat-area,cat-volume
  OPENAI_API_KEY=sk-… npm run swarm -- --mode codex --auth api-key --agents 3 --stack --fresh --tasks t-precision,cat-area,cat-volume
  ```
