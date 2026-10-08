# Ryke

Competition entry (`docs/challenge.md`), hard deadline 2026-10-14. **The build brief is `PLAN.md`;
read it before any work.** Progress lives in `PROGRESS.md`, deviations in `DECISIONS.md`, things only
Felix can provide in `BLOCKERS.md`.

- One Worker (`src/worker`) serves `/api/*`, `/mcp`, previews and the React dashboard (`src/web`) as
  static assets, built with the Cloudflare Vite plugin.
- npm, not bun: bun breaks behind the cloud-session proxy.
- `npm run types` after every `wrangler.jsonc` change (regenerates `worker-configuration.d.ts`).
- `npm run check` and `npm test` must pass before every commit. Worker tests run inside workerd via
  `@cloudflare/vitest-plugin`, which needs vitest 4.x (not 5).
- No web search in cloud sessions: API facts are in `docs/platform-notes.md` and
  `docs/artifacts-notes.md`; fetch more with `curl -s https://developers.cloudflare.com/<path>/index.md`.

## Commits and PRs

- Title `feat: ` / `fix: ` plus the precise thing done; imperative, lower case, no period, ~70 chars.
  `refactor:` / `docs:` / `test:` / `chore:` / `perf:` only when it is genuinely neither.
- Body: two short paragraphs, symptom or need first, then cause and change. Explain why.
- No `Co-Authored-By` trailer, no mention of Claude or any tool.
- PR body sections: Problem, Change, Verified, Rollback. Two or three sentences each; Verified is a
  flat list of what actually ran. About 200 words plus the list.

## Code

- Comments explain why, never what. No abstraction for a single caller; the only adapters are the
  ones `PLAN.md` §2 names.
- Tests for every behaviour; pure logic (validate, trains, heat, recall) gets table-driven tests.
