#!/usr/bin/env bash
# In-platform demo (PLAN.md §11.2): the Worker starts this job with RYKE_API_URL and RYKE_TOKEN in the
# environment and `--repo x --mode y --agents n --speed s` as arguments.
exec node "$RYKE_ROOT/harness/swarm.mjs" --api "$RYKE_API_URL" --token "$RYKE_TOKEN" "$@"
