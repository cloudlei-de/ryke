# Platform notes (researched 2026-10-08)

Cloud sessions have no web search. Everything an implementer needs from the docs is here or in
[artifacts-notes.md](artifacts-notes.md). For more detail, `curl` the Markdown form of a docs page:
`curl -s https://developers.cloudflare.com/sandbox/reference/index.md`. `[unverified]` marks
something we inferred and did not see documented.

## Versions (npm, 2026-10-08)

| Package | Version | Note |
|---|---|---|
| `wrangler` | 4.148.0 | Pinned in package.json |
| `@cloudflare/sandbox` | 1.0.0 | 1.0 removed the whole 0.x API, see below |
| `docker.io/cloudflare/sandbox` | 1.0.0 | Source of `sandbox-shim` |
| `@cloudflare/worker-bundler` | 0.2.6 | Bundles code for Dynamic Workers |
| `agents` | 0.27.0 | Peer-pins `@modelcontextprotocol/server` **2.0.0** exactly |
| `@typesafe-ai/sdk` | 0.6.0 | Jev client, fetch-only, works in workerd |
| `@anthropic-ai/claude-code` | 2.1.293 | Pin it inside the agent image |
| `@cloudflare/vitest-plugin` | 1.3.x | Needs vitest 4.x, not 5 |

## Sandbox SDK 1.0 / Containers

1.0 keeps only `Files`, `S3Mount` and `DirectoryBackup`. You write your own Durable Object and drive
`this.ctx.container` yourself. `getSandbox`, `exec` on the SDK, sessions, `gitCheckout`,
`setEnvVars`, `startProcess` and `exposePort` are gone. Ignore any example that uses them.

```jsonc
// wrangler.jsonc: "exports" replaces "migrations"; a config with both is rejected
"containers": [{ "class_name": "Runner", "scheduling_policy": "durable_object",
                 "images": { "runner": { "dockerfile": "./containers/runner/Dockerfile" } } }],
"durable_objects": { "bindings": [{ "name": "RUNNER", "class_name": "Runner" }] },
"exports": { "Runner": { "type": "durable-object", "storage": "sqlite" } }
```

```dockerfile
FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

- **Image constraints.** Images must be `linux/amd64`. 1.0 images come without python, git, curl or jq unless you install them.
- **Start.** `container.start({ image: container.images.runner, instance: "standard-2", enableInternet: false, env, labels })`
  returns before the container is ready. Use `monitor()` to catch exit and errors. Instance sizes: `lite`, `standard-1` to `standard-4`,
  or custom `{vcpu, memoryMib, diskMb}`.
- **Exec.** `ctx.container.exec(argv[], {cwd, env, stdin, stdout, stderr, user, signal})` returns
  `ExecProcess` with `.output()`, `.stdout`/`.stderr` streams, `.exitCode` and `.kill()`. `exec` does not inherit the
  `start` env except `PATH`.
- **Files.** `new Files(container).readFile(path)` returns a `Response`; `.writeFile()`, `.mkdir()` and `.remove()` also exist.
- **Lifetime.**
  - `setInactivityTimeout(ms)` takes at most 6 h. Set it again in the constructor.
  - A running process does not count as activity, so keep the container alive with a DO alarm.
  - Long jobs run detached: `setsid … > /work/out.log`, plus pid and exit-code files, polled by a 60 s alarm.
  - Piped exec output dies with SIGPIPE when the triggering request ends.
- **Outbound gateway (secrets never enter the container).**
  - Call `container.interceptOutboundHttps("*", this.ctx.exports.Outbound)` and
    `interceptAllOutboundHttp(...)` again after every start. Per-container context goes in
    `this.ctx.exports.Outbound({ props: { txnId } })`.
  - TLS is re-signed by `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. Point `NODE_EXTRA_CA_CERTS`,
    `GIT_SSL_CAINFO`, `SSL_CERT_FILE` and `CURL_CA_BUNDLE` at it.
  - The gateway adds `Authorization: Bearer <artifacts token>` for `<ACCOUNT_ID>.artifacts.cloudflare.net`
    and `x-api-key` for `api.anthropic.com` [unverified for Artifacts].
- **Previews out of a container.** There is no built-in preview URL. Route to `container.getTcpPort(port).fetch(req)`, and the
  server must listen on `0.0.0.0`.
- **Limits.** 1,500 vCPU and 6 TiB per account, 50 GB image storage, cold start often 1–3 s. The `durable_object` scheduling
  policy is in public beta. Cost is about 0.13 USD/h for a busy standard-2.
- **Local dev.** `wrangler dev` builds the image with local Docker; `wrangler deploy` also builds locally.

### Claude Code inside a container (swarm agents)

```
claude --print --output-format stream-json --verbose --dangerously-skip-permissions \
  --no-session-persistence --model $MODEL -- "<prompt>"
```
- Env: `IS_SANDBOX=1` (needed to skip permissions as root), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
  and a placeholder `ANTHROPIC_API_KEY`. The Outbound gateway swaps it for the real key from a Worker secret.
- Read the outcome from the last `{"type":"result"}` line using `is_error`, not `subtype`.
- A bad key takes about 3 minutes to fail, because Claude Code retries 10 times. Validate the key once before a swarm starts.
- Hooks in the container's `~/.claude/settings.json` (`PostToolUse` on `Read|Grep|Glob|Edit|Write|MultiEdit`)
  can append every touched path to a JSONL file. That file is how Ryke records the read and write sets.

## Workflows

```ts
export class Land extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const r = await step.do("merge", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => …);
    const ev = await step.waitForEvent<Verdict>("verdict", { type: "verdict", timeout: "1 hour" });
  }
}
```
```jsonc
"workflows": [{ "name": "ryke-land", "binding": "LAND", "class_name": "Land" }],
"triggers": { "events": [{ "type": "cf.artifacts.repo.pushed",
  "filter": { "namespace": "ryke" },
  "targets": [{ "type": "workflow", "workflow_name": "ryke-land" }] }] }
```
- **API.** Step results must be JSON-serialisable and at most 1 MiB. `NonRetryableError` stops retries. Start an instance with
  `env.LAND.create({ id, params })` (`createBatch` takes up to 100). Signal it with `(await env.LAND.get(id)).sendEvent({ type, payload })`.
- **Limits.** 10k steps by default; 30 s CPU per step by default, up to 5 min with `limits.cpu_ms`; wall time unlimited.
- **Triggers.** The `triggers.events` shape above comes from the Wrangler 4.148 schema and `cloudflare/ci`. The Artifacts docs page
  shows a wrong shape. The trigger only works against real Artifacts, so the local store calls
  `env.LAND.create()` itself with the same event payload.

## Durable Objects

- **Migrations.** Use `exports` with `"storage": "sqlite"`, not `migrations`/`new_sqlite_classes`. Once deployed with `exports` you cannot switch back.
- **SQLite.** `ctx.storage.sql.exec(q, ...binds)` returns a cursor (`toArray`, `one`, `raw`). Consume it before any `await`.
  There is no `BEGIN`; use `ctx.storage.transactionSync(fn)`. Limits: 10 GB per DO, 2 MB per row, 100 bound parameters.
- **WebSocket hibernation.** `ctx.acceptWebSocket(ws, tags)`, handlers `webSocketMessage`, `webSocketClose` and `webSocketError`,
  plus `ctx.getWebSockets(tag)`. `serializeAttachment` holds at most 16 KiB.
- **Alarms and RPC.** One alarm per object, delivered at least once, 15 min wall time. RPC is plain public methods on the stub.

## Dynamic Workers (per-transaction previews)

```jsonc
"worker_loaders": [{ "binding": "LOADER" }]
```
```ts
const worker = env.LOADER.get(`${repo}:${sha}`, async () => ({
  compatibilityDate: "2026-10-01", mainModule, modules, env: {}, globalOutbound: null }));
return worker.getEntrypoint().fetch(request);
```
- Bundle the demo app's files at a commit with `@cloudflare/worker-bundler` (`createWorker({ files })`).
- Miniflare supports `worker_loaders` locally (checked in `node_modules/miniflare`).
- At most 4 distinct Dynamic Workers in flight per request. They require Workers Paid in production.
- `wrangler versions upload --preview-alias` creates no URLs for Workers that contain DOs or containers, so don't use it.

## Agents SDK: MCP server

```ts
import { McpServer } from "@modelcontextprotocol/server"; // exactly 2.0.0
import { createMcpHandler } from "agents/mcp/server";
const mcp = createMcpHandler(() => { const s = new McpServer({ name: "ryke", version: "0.1.0" }); /* s.registerTool(...) */ return s; },
  { route: "/mcp" });
// bearer auth: validate the header yourself, then mcp(req, env, ctx)
```
`McpAgent` is deprecated. Use the stateless handler above.

## Jev (TypeSafe System One)

- **Endpoint.** `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>`. Body `{model, state, questions}`,
  response `{model, answers, usage}`. Pin `model: "jev-1.13.0"`.
- **Primitives.**
  - `noul`: probability of yes, 0..1.
  - `choice`: `criteria` map of options; returns `choice`, `probabilities` and `confidence`.
  - `score`: 2–10 ordered levels as an array; returns the `score`, `probabilities` and `confidence`.
- **Measured from this repo (2026-10-08).** 0.29 s and 422 input tokens. On "rename settings page" vs "add dark mode to settings page"
  it returned conflict score 1.5, confidence 0.25. That is honest uncertainty; Ryke treats low confidence as "coordinate".
- **Rules.** One condition per question. Describe each Score level as a concrete situation. High value means yes. Text only:
  describe screenshots first. Max 64k tokens. English works best.
- **Injection.** Agent-written logs and diffs are untrusted state. Do the hard checks in code (exit code, counts, protected paths);
  Jev decides judgement calls only.
- **SDK.** `new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY, defaultModel: "jev-1.13.0", timeout: 3000 })`, then
  `ts.systemOne({ state, questions: { a: noul("…"), b: choice("…", {…}), c: score("…", […]) } })`.
- **Cost.** 0.042 USD per million input tokens. Rate limit 80 req/s.

## Cloud session facts (claude.ai/code)

- **VM.** Ubuntu 24.04 x86_64, 4 vCPU, 16 GB RAM, Docker available, Node 22 preinstalled (setup installs 24).
- **Package managers.** Bun has documented proxy problems, so this repo uses npm.
- **Proxy.** All egress goes through a security proxy. Node's `fetch` needs `NODE_USE_ENV_PROXY=1`. Whether workerd
  (`wrangler dev`) can reach external hosts through the proxy is [unverified]. Unit tests must not need the network.
- **GitHub.** Branch pushes work; tags and branch deletions are rejected; `gh` GraphQL is blocked, so use `gh api repos/...`.
- **Secrets.** Network secrets attach headers for listed hosts, and the VM never sees the value.
