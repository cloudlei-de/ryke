# Cloud session setup (claude.ai/code)

Environment `ryke`, network access **Custom** with "include defaults" on, extra hosts:

```text
developers.cloudflare.com
blog.cloudflare.com
api.cloudflare.com
*.artifacts.cloudflare.net
*.workers.dev
ryke.ai
*.ryke.ai
docs.typesafe.ai
api.typesafe.ai
deb.debian.org
security.debian.org
cdn.playwright.dev
playwright.azureedge.net
playwright.download.prss.microsoft.com
```

Environment variables (`TYPESAFE_API_KEY` holds the real key when the plan has no network secrets):

```text
RYKE_STORE=local
RYKE_RUNNER=process
RYKE_JEV=live
NODE_USE_ENV_PROXY=1
BASH_DEFAULT_TIMEOUT_MS=300000
BASH_MAX_TIMEOUT_MS=600000
TYPESAFE_API_KEY=<key>
```

Setup script:

```bash
#!/bin/bash
# Provisions the VM once; cached ~7 days. Must exit 0 and stay under ~5 min.
set -uo pipefail
(npm install -g n >/dev/null 2>&1 && n 24 >/dev/null 2>&1) || echo "node24 install failed, staying on $(node -v)"
hash -r
docker info >/dev/null 2>&1 || (nohup dockerd >/var/log/dockerd.log 2>&1 & sleep 8)
docker pull docker.io/cloudflare/sandbox:1.0.0 >/dev/null 2>&1 &
docker pull node:24-trixie-slim >/dev/null 2>&1 &
npx -y playwright@1 install --with-deps chromium >/dev/null 2>&1 &
wait
node -v; docker --version || true
exit 0
```

The repo's `.claude/settings.json` SessionStart hook runs `scripts/session-start.sh` (`npm ci`,
`.dev.vars` defaults) in every cloud session.

## Start prompt

```text
Read CLAUDE.md, PLAN.md and PROGRESS.md. Then build Ryke exactly as PLAN.md describes, milestone by
milestone, on branch feat/ryke-mvp, following the operating rules in PLAN.md §0. Work autonomously
until the definition of done in §14 is met; never wait for answers.
```

## Session settings

- Model: **Opus 5.5** for the main session. Project subagents in `.claude/agents/` pin their own
  model (Sonnet for implementer, patch-author and verifier; Opus for reviewer), see PLAN.md §0.10.
- Effort: the highest available.
- One session only. Parallelism comes from subagents; a second session on the same branch would
  cause conflicts.
- Check back on progress: `PROGRESS.md` on branch `feat/ryke-mvp`, or the session in the sidebar.
