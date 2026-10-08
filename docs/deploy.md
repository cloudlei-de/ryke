# Deploying Ryke to Cloudflare

Ryke runs locally without a Cloudflare account (`npm run dev:all`). Production needs the Workers Paid
plan with the Artifacts beta, Containers and Dynamic Workers enabled, because the trunk and forks
live in Artifacts, the lander runs in containers and previews run as Dynamic Workers.

The production configuration is the `production` environment in [`wrangler.jsonc`](../wrangler.jsonc):

- the `ARTIFACTS` binding (namespace `ryke`);
- the `Ledger` and `Runner` Durable Objects through `exports`, with the Runner container image built
  from `containers/runner/Dockerfile`;
- the `ryke-land` and `ryke-ingest` workflows, plus the `triggers.events` entry that starts
  `ryke-ingest` for every `cf.artifacts.repo.pushed` event in namespace `ryke`;
- `worker_loaders` for previews, `observability`, and the `ryke.ai` custom domain.

## 1. API token

Create a Cloudflare API token with exactly these permissions:

- Account: Workers Scripts Edit, Workers Builds Configuration Edit, Workflows Edit, Containers Edit,
  Artifacts Edit, Account Settings Read, Workers Tail Read.
- Zone `ryke.ai`: Workers Routes Edit, DNS Edit.
- Nothing else.

```sh
export CLOUDFLARE_API_TOKEN=…
export CLOUDFLARE_ACCOUNT_ID=…
```

## 2. Secrets

```sh
npx wrangler secret put RYKE_TOKEN --env production            # admin bearer for writes, MCP and the dashboard
npx wrangler secret put RYKE_INTERNAL_SECRET --env production  # internal event secret (unused by Artifacts triggers, kept for parity)
npx wrangler secret put TYPESAFE_API_KEY --env production      # Jev, api.typesafe.ai
npx wrangler secret put ANTHROPIC_API_KEY --env production     # Claude agents; the Outbound gateway injects it, containers never see it
npx wrangler secret put OPENAI_API_KEY --env production        # Codex agents, the same way (api.openai.com)
```

Agents in containers run only on these operator keys. A subscription login (Claude Pro or Max, a
ChatGPT plan) is for its owner's own machine: `--auth subscription` is refused inside a container,
and the gateway attaches no credential for chatgpt.com.

## 3. Deploy

```sh
npm ci
npm run check && npm test
npm run deploy:dry     # CLOUDFLARE_ENV=production vite build, then wrangler deploy --dry-run
npm run deploy         # builds the container image with local Docker, then deploys
```

The Cloudflare Vite plugin selects the environment at build time (`CLOUDFLARE_ENV=production`), so
both scripts build first. If the image build fails on the deploying machine, `npm run deploy:dry --
--containers-rollout=none` still checks the Worker.

## 4. Smoke checks

```sh
curl -s https://ryke.ai/api/health                                   # {"ok":true}
curl -s -X POST https://ryke.ai/api/repos -H "authorization: Bearer $RYKE_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"convert","seedFrom":"convert"}'
RYKE_API_URL=https://ryke.ai RYKE_TOKEN=$RYKE_TOKEN npm run swarm -- --mode scripted --agents 3 --repo convert
open https://ryke.ai/?repo=convert                                   # the Line view fills in live
```

The store contract suite (`test/store-contract.test.ts`) switches to the Artifacts adapter when
`RYKE_STORE_CONTRACT=artifacts` and an `ARTIFACTS` binding is present. Its history checks read a
`fixture` repo that the local test setup pushes with git; against Artifacts that repo has to exist
first (push the same two commits as `test/setup/stack.mjs` does), and the vitest config needs the
binding with `"remote": true`. That run has not been done yet (BLOCKERS.md).

## What has not been run against Cloudflare

Workers Paid was not active while Ryke was built, so these paths compile and have unit tests but have
not been exercised on Cloudflare: the Artifacts store adapter (`src/worker/store/artifacts.ts`, whose
tests run the store contract against an in-memory fake of the binding, `test/fake-artifacts.ts`, not
the real service), the container Runner and its Outbound gateway (`src/worker/runner/container.ts`),
the `ryke-ingest` trigger, and candidate refs under `refs/ryke/candidates/*` on Artifacts (if
Artifacts rejects non-branch refs, switch `land.mjs` to `ryke-candidate-<train>` branches as PLAN.md
§5.3 describes).
BLOCKERS.md lists what is needed to close each gap.
