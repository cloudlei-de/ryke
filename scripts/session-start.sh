#!/bin/bash
# Cloud sessions only: the VM starts from a cached snapshot without node_modules.
[ "$CLAUDE_CODE_REMOTE" != "true" ] && exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
[ -d node_modules ] || npm ci --no-audit --no-fund >/tmp/npm-ci.log 2>&1 || echo "npm ci failed, see /tmp/npm-ci.log"
# .dev.vars is gitignored; recreate the non-secret local defaults.
[ -f .dev.vars ] || printf 'RYKE_TOKEN=dev\nRYKE_INTERNAL_SECRET=dev\nTYPESAFE_API_KEY=%s\n' "${TYPESAFE_API_KEY:-}" > .dev.vars
exit 0
