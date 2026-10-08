# The Runner container (PLAN.md §3.4, docs/platform-notes.md §Sandbox): the job scripts under
# containers/runner/bin plus everything they shell out to, and Claude Code for agent jobs.
# Build context is the repo root (wrangler.jsonc: images.runner.build_context = ".").
FROM node:24-trixie-slim

# tini: PID 1 must reap the jobs the Runner DO kills, or they pile up as zombies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep tini \
 && rm -rf /var/lib/apt/lists/*

# Pinned: hooks and the stream-json result line are read by exact shape (docs/platform-notes.md).
# The autoupdater would try to reach the network and change the version under a running swarm.
ENV DISABLE_AUTOUPDATER=1
RUN npm install --global @anthropic-ai/claude-code@2.1.293 \
 && npm cache clean --force

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# RYKE_ROOT in every job is /opt/ryke (src/worker/runner/container.ts); demo/ is the seed seed.mjs copies.
COPY containers/runner /opt/ryke/containers/runner
COPY demo /opt/ryke/demo

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
