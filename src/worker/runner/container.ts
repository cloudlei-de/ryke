// Container-mode runner (PLAN.md §3.4): a Runner Durable Object per job slot drives one container
// through `ctx.container`, the ContainerRunner client routes jobs to those slots, and Outbound is
// the egress gateway that keeps every secret out of the container (docs/platform-notes.md §Sandbox).
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { RunnerError, type JobKind, type JobStatus, type Runner as RunnerClient } from "./runner";

// ---------------------------------------------------------------------------- constants

const ROOT = "/opt/ryke";
const SCRIPTS = `${ROOT}/containers/runner/bin`;
const WORK = "/work";
const EVIDENCE_DIR = `${WORK}/evidence`;
const CA_BUNDLE = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

// A running process is not container activity, so while a job runs an alarm polls it (the poll is
// an exec, which is activity) and re-arms itself.
const KEEPALIVE_MS = 60_000;
// How long the container outlives the DO's last activity; keep-alive alarms land well inside it.
const INACTIVITY_MS = 10 * 60_000;
// Cold start is 1-3 s. A row still "queued" after this lost its start() (the DO was evicted mid-way).
const QUEUED_TTL_MS = 3 * 60_000;
// Backstop for a job whose caller never cancelled it; otherwise the alarm would keep the container up forever.
const MAX_JOB_MS = 2 * 3600_000;
const RESULT_WINDOW = 1024 * 1024;
const LOG_CHUNK = 1024 * 1024;

// Same codes as dev/runner so a job reads the same in both modes.
const CANCELLED = 143;
const LAUNCH_FAILED = 127;
const CONTAINER_LOST = 137;
const TIMED_OUT = 124;

const DEFAULT_SLOTS = 6;
const MAX_SLOTS = 64;
const KIND_RE = /^[a-z][a-z0-9-]*$/;
// Artifacts repo names: letters, digits, dots, hyphens, underscores; the first character rules out "." and "..".
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Gateway tokens live an hour and are renewed five minutes early, so a long push never meets an expiry.
const TOKEN_TTL_S = 3600;
const TOKEN_RENEW_MS = 5 * 60_000;
// `j_<slot>_<random>`: the slot in the id is how status, log and cancel reach the DO that holds the job.
const JOB_ID_RE = /^j_(\d{1,3})_([0-9a-z]{6,40})$/;

// ---------------------------------------------------------------------------- pure helpers

export function slotOf(id: string): number | null {
  const m = JOB_ID_RE.exec(id);
  return m ? Number(m[1]) : null;
}

export function newJobId(slot: number): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join("");
  return `j_${slot}_${rand}`;
}

// POSIX single-quote quoting; words that need none are left bare so the logged command stays readable.
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// The job runs as a detached session leader (setsid), so `kill -- -<pid>` reaches the script and
// everything it started. The outer shell must not hold the exec's pipes: output() would wait for
// the job to finish, and the pipe dies with the request. The inner redirects send the job's own
// output to files, exit code last, which is what status() polls.
export function launchCommand(id: string, kind: string, args: Record<string, string>): string {
  const dir = `${WORK}/${id}`;
  const script = ["bash", `${SCRIPTS}/${kind}.sh`, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, v])].map(shellQuote).join(" ");
  const inner = `${script} > ${dir}/out.log 2> ${dir}/err.log; echo $? > ${dir}/exit`;
  return `setsid bash -c ${shellQuote(inner)} < /dev/null > /dev/null 2>&1 & echo $! > ${dir}/pid`;
}

// SIGTERM, a short grace period, then SIGKILL, like dev/runner. Exits 0 whether or not a group was left.
export function killCommand(id: string): string {
  const pid = `${WORK}/${id}/pid`;
  return [
    `pid=$(cat ${pid} 2>/dev/null)`,
    `[ -n "$pid" ] || exit 0`,
    `kill -TERM -- "-$pid" 2>/dev/null`,
    `for i in 1 2 3 4; do kill -0 -- "-$pid" 2>/dev/null || exit 0; sleep 0.5; done`,
    `kill -KILL -- "-$pid" 2>/dev/null`,
    `exit 0`,
  ].join("; ");
}

// exec does not inherit the start env, and secrets are never in it: the job gets only what its
// caller passed plus the identity and CA settings. The fixed names come last so a job cannot spoof
// its own identity or untrust the gateway CA.
export function jobEnvironment(id: string, env: Record<string, string>): Record<string, string> {
  return {
    HOME: "/root",
    ...env,
    RYKE_ROOT: ROOT,
    RYKE_JOB_ID: id,
    RYKE_JOB_DIR: `${WORK}/${id}`,
    RYKE_EVIDENCE_DIR: EVIDENCE_DIR,
    NODE_EXTRA_CA_CERTS: CA_BUNDLE,
    GIT_SSL_CAINFO: CA_BUNDLE,
    SSL_CERT_FILE: CA_BUNDLE,
    CURL_CA_BUNDLE: CA_BUNDLE,
  };
}

export function checkJob(kind: string, args: Record<string, string>, env: Record<string, string>): void {
  if (!KIND_RE.test(kind)) throw new RunnerError(`kind must match ${KIND_RE}`);
  for (const [field, map] of [["args", args], ["env", env]] as const) {
    if (typeof map !== "object" || map === null || Array.isArray(map)) throw new RunnerError(`${field} must be an object of strings`);
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== "string") throw new RunnerError(`${field}.${k} must be a string`);
      // A NUL ends a C string and `=` in an env name corrupts the environment block.
      if (k === "" || k.includes("\0") || v.includes("\0") || (field === "env" && k.includes("="))) {
        throw new RunnerError(`${field} has an invalid name or value (empty name, NUL byte${field === "env" ? ", or '='" : ""})`);
      }
    }
  }
}

// RYKE_ALLOW_REPOS is the list of repos a job's container may reach through the gateway. Absent
// means unrestricted (the lander). Present but empty means none: a list that came out empty by
// mistake must not turn into "everything".
export function parseAllow(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const names = [...new Set(raw.split(",").map((n) => n.trim()).filter((n) => n !== ""))].sort();
  for (const n of names) if (!REPO_RE.test(n)) throw new RunnerError(`RYKE_ALLOW_REPOS has an invalid repo name "${n}"`);
  return names;
}

// The result is the last non-empty stdout line when it is JSON. When the window cut the file, its
// first line may be a fragment and is not trusted.
export function parseResult(text: string, truncated: boolean): unknown {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    if (i === 0 && truncated) return undefined;
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// A byte-offset log is read in slices; one must not end inside a multi-byte character.
export function completeUtf8Length(buf: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const byte = buf[buf.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte, keep looking for its lead byte
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? buf.length - back : buf.length;
  }
  return buf.length;
}

const decoder = new TextDecoder();

// ---------------------------------------------------------------------------- Runner DO

// The slice of ctx.container the job logic uses. Tests replace it with a fake.
export type Box = Pick<
  Container,
  "running" | "images" | "start" | "destroy" | "setInactivityTimeout" | "interceptOutboundHttps" | "interceptAllOutboundHttp"
> & { exec(cmd: string[], options?: ContainerExecOptions): Promise<Pick<ExecProcess, "output">> };

type Row = {
  id: string;
  kind: string;
  state: JobStatus["state"];
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  result: string | null;
  // Comma-separated repos the job may reach; NULL = unrestricted.
  allow: string | null;
};

type Ran = { code: number; stdout: Uint8Array; stderr: string };

async function run(box: Box, cmd: string[], options?: ContainerExecOptions): Promise<Ran> {
  const out = await (await box.exec(cmd, options)).output();
  return { code: out.exitCode, stdout: new Uint8Array(out.stdout), stderr: decoder.decode(out.stderr) };
}

const allowKey = (allow: string[] | undefined) => (allow === undefined ? "*" : allow.join(","));

const terminal = (r: Row) => r.state === "done" || r.state === "failed";

export class Runner extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  // Concurrent start() calls share one boot, or the second would exec before the intercepts exist.
  private booting: Promise<void> | null = null;
  // What the container's gateway rules were last registered with ("*" = unrestricted). Unknown
  // after a DO restart, so the first start of a new instance registers again.
  private registered: string | null = null;
  private gatewayChain: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Not deployed yet, so no migrations; a column added after the first deploy needs a guarded ALTER here.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS runner_job (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER, result TEXT, allow TEXT)`);
    // A restarted DO has no inactivity timeout of its own while the container it started is still up.
    const box = this.box();
    if (box?.running) void ctx.blockConcurrencyWhile(() => box.setInactivityTimeout(INACTIVITY_MS).catch(() => {}));
  }

  // Seams for the unit tests, which run the real SQLite and alarm of a scratch DO against a fake container.
  protected box(): Box | undefined {
    return this.ctx.container;
  }

  // `Outbound` joins ctx.exports once index.ts exports it and the types are regenerated.
  protected exports(): { Outbound(o: { props: OutboundProps }): Fetcher } {
    return this.ctx.exports as unknown as { Outbound(o: { props: OutboundProps }): Fetcher };
  }

  private gateway(allow: string[] | undefined): Fetcher {
    const props: OutboundProps = allow === undefined ? {} : { allow };
    return this.exports().Outbound({ props });
  }

  protected now(): number {
    return Date.now();
  }

  // ---------------------------------------------------------------- RPC

  async start(id: string, kind: JobKind, args: Record<string, string>, env: Record<string, string>): Promise<void> {
    if (slotOf(id) === null) throw new RunnerError(`invalid job id "${id}"`);
    checkJob(kind, args, env);
    const allow = parseAllow(env.RYKE_ALLOW_REPOS);
    const box = this.requireBox();
    if (this.find(id)) throw new RunnerError(`job "${id}" already exists`);
    this.sql.exec(
      "INSERT INTO runner_job (id, kind, state, started_at, allow) VALUES (?, ?, 'queued', ?, ?)",
      id,
      kind,
      this.now(),
      allow === undefined ? null : allow.join(","),
    );
    const dir = `${WORK}/${id}`;
    try {
      await this.keepAlive();
      await this.ensureRunning(box);
      await this.syncGateway(box);
      const made = await run(box, ["mkdir", "-p", `${dir}/work`, EVIDENCE_DIR]);
      if (made.code !== 0) throw new RunnerError(`could not create ${dir}: ${made.stderr.trim()}`);
      const launched = await run(box, ["bash", "-c", launchCommand(id, kind, args)], { cwd: `${dir}/work`, env: jobEnvironment(id, env) });
      if (launched.code !== 0) throw new RunnerError(`could not launch ${kind}: ${launched.stderr.trim() || `exit ${launched.code}`}`);
    } catch (e) {
      this.finish(id, LAUNCH_FAILED);
      throw e;
    }
    if (this.find(id)?.state !== "queued") {
      // Cancelled or swept while the container booted: the job it describes must not outlive its row.
      await this.killGroup(box, id);
      return;
    }
    this.sql.exec("UPDATE runner_job SET state = 'running' WHERE id = ?", id);
  }

  async status(id: string): Promise<JobStatus> {
    const row = await this.refresh(this.row(id));
    return {
      state: row.state,
      exitCode: row.exit_code ?? undefined,
      result: row.result === null ? undefined : JSON.parse(row.result),
    };
  }

  // stdout is readable while the job runs; stderr joins after it, so the byte offsets of what a
  // reader already holds stay valid (the two files grow independently and cannot be interleaved).
  async log(id: string, offset: number): Promise<{ text: string; next: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RunnerError("offset must be a non-negative integer");
    const row = await this.refresh(this.row(id));
    const box = this.box();
    // The container's disk is gone once it stops; only status() outlives it.
    if (!box?.running || row.state === "queued") return { text: "", next: offset };
    const done = terminal(row);
    const dir = `${WORK}/${id}`;
    const files = done ? [`${dir}/out.log`, `${dir}/err.log`] : [`${dir}/out.log`];
    const sizes = await Promise.all(files.map((f) => this.size(box, f)));
    const total = sizes.reduce((a, b) => a + b, 0);
    // Clamp so a stale offset past the end cannot make the reader skip bytes written later.
    const start = Math.min(offset, total);
    const chunks: Uint8Array[] = [];
    let skip = start;
    let budget = LOG_CHUNK;
    for (const [i, file] of files.entries()) {
      if (skip >= sizes[i]!) {
        skip -= sizes[i]!;
        continue;
      }
      const bytes = await this.slice(box, file, skip, budget);
      chunks.push(bytes);
      budget -= bytes.length;
      skip = 0;
      if (budget <= 0) break;
    }
    let body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.length;
    }
    // Only a log that is over and fully delivered may end mid-character: nothing will complete it.
    if (!(done && start + body.length >= total)) body = body.subarray(0, completeUtf8Length(body));
    return { text: decoder.decode(body), next: start + body.length };
  }

  async cancel(id: string): Promise<void> {
    let row = this.row(id);
    try {
      // A job that already exited keeps its real outcome, as in dev/runner.
      row = await this.refresh(row);
    } catch {
      // An unreachable container must not stop the cancel (a timed-out caller is waiting on it).
    }
    if (terminal(row)) return;
    const box = this.box();
    // A queued job has no process yet; start() kills the one it is about to launch.
    if (row.state === "running" && box?.running) await this.killGroup(box, id);
    this.finish(id, CANCELLED);
  }

  async alarm(): Promise<void> {
    await this.sweep();
    const left = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM runner_job WHERE state IN ('queued', 'running')").one().n;
    if (left > 0) await this.ctx.storage.setAlarm(this.now() + KEEPALIVE_MS);
  }

  // ---------------------------------------------------------------- container lifecycle

  // Brings every queued or running job up to date. One unreachable job must not stop the others,
  // nor the alarm's re-arm that keeps the container up.
  private async sweep(): Promise<void> {
    for (const row of this.sql.exec<Row>("SELECT * FROM runner_job WHERE state IN ('queued', 'running')").toArray()) {
      try {
        await this.refresh(row);
      } catch {
        // Left as it was; the next sweep tries again.
      }
    }
  }

  private requireBox(): Box {
    const box = this.box();
    if (!box) throw new RunnerError("no container is configured for this Durable Object");
    return box;
  }

  private async keepAlive(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(this.now() + KEEPALIVE_MS);
  }

  private async ensureRunning(box: Box): Promise<void> {
    // `booting` first: start() flips `running` before the intercepts are registered.
    if (this.booting) return this.booting;
    if (box.running) return;
    this.booting = this.boot(box).finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  private async boot(box: Box): Promise<void> {
    // `images` exists only under the durable_object scheduling policy.
    const image = box.images?.runner;
    if (!image) throw new RunnerError("no `runner` image in ctx.container.images; check containers[].images in wrangler.jsonc");
    // A job still "running" belongs to the container that is gone; it would otherwise stay in the
    // allow-list and hold the keep-alive alarm until the backstop. Queued rows are starts in flight.
    this.sql.exec(
      "UPDATE runner_job SET state = 'failed', ended_at = ?, exit_code = ? WHERE state = 'running'",
      this.now(),
      CONTAINER_LOST,
    );
    try {
      box.start({ image, instance: "standard-2", enableInternet: false, env: { RYKE_ROOT: ROOT } });
      // Intercepts end with the container, so every start registers them again.
      await this.registerGateway(box, this.desiredAllow());
      await box.setInactivityTimeout(INACTIVITY_MS);
    } catch (e) {
      // A container up without its gateway would let a job run with no egress rules; start over next time.
      await box.destroy().catch(() => {});
      throw e;
    }
  }

  // The HTTPS catch-all goes before the plain-HTTP catch-all, as the platform requires for hostname rules.
  private async registerGateway(box: Box, allow: string[] | undefined): Promise<void> {
    this.registered = null;
    const gateway = this.gateway(allow);
    await box.interceptOutboundHttps("*", gateway);
    await box.interceptAllOutboundHttp(gateway);
    this.registered = allowKey(allow);
  }

  // Interception is per container, not per job, so the repo allow-list is too: the union of what
  // the jobs now queued or running may reach, and unrestricted as soon as one of them is (the lander
  // shares a container with agents only if the caller routes them to the same slot). It narrows
  // again once those jobs end, at the next start.
  private desiredAllow(): string[] | undefined {
    const rows = this.sql.exec<{ allow: string | null }>("SELECT allow FROM runner_job WHERE state IN ('queued', 'running')").toArray();
    if (rows.some((r) => r.allow === null)) return undefined;
    return [...new Set(rows.flatMap((r) => (r.allow === "" || r.allow === null ? [] : r.allow.split(","))))].sort();
  }

  // Registering again replaces the handler and its props without dropping open connections.
  // Serialised, so two starts cannot finish their registrations out of order.
  private syncGateway(box: Box): Promise<void> {
    const next = this.gatewayChain
      .catch(() => {})
      .then(async () => {
        // A job that ended since the last poll must not keep its repos reachable.
        await this.sweep();
        const want = this.desiredAllow();
        if (this.registered !== allowKey(want)) await this.registerGateway(box, want);
      });
    this.gatewayChain = next;
    return next;
  }

  private async killGroup(box: Box, id: string): Promise<void> {
    try {
      await run(box, ["bash", "-c", killCommand(id)]);
    } catch {
      // The container is already gone, so is the process.
    }
  }

  // ---------------------------------------------------------------- job state

  private find(id: string): Row | undefined {
    return this.sql.exec<Row>("SELECT * FROM runner_job WHERE id = ?", id).toArray()[0];
  }

  private row(id: string): Row {
    const row = slotOf(id) === null ? undefined : this.find(id);
    if (!row) throw new RunnerError(`no such job "${id}"`);
    return row;
  }

  // The only place a job becomes done or failed; the guard makes the first writer win when a poll
  // and a cancel race.
  private finish(id: string, exitCode: number, result?: unknown): Row {
    this.sql.exec(
      "UPDATE runner_job SET state = ?, ended_at = ?, exit_code = ?, result = ? WHERE id = ? AND state IN ('queued', 'running')",
      exitCode === 0 ? "done" : "failed",
      this.now(),
      exitCode,
      result === undefined ? null : JSON.stringify(result),
      id,
    );
    return this.row(id);
  }

  // Brings a row up to date with what the container shows. Same semantics as dev/runner: running
  // until the exit file exists, then done (0) or failed (anything else) with the parsed result.
  private async refresh(row: Row): Promise<Row> {
    if (terminal(row)) return row;
    const now = this.now();
    if (row.state === "queued") return now - row.started_at > QUEUED_TTL_MS ? this.finish(row.id, LAUNCH_FAILED) : row;
    const box = this.box();
    if (!box?.running) return this.finish(row.id, CONTAINER_LOST);
    if (now - row.started_at > MAX_JOB_MS) {
      await this.killGroup(box, row.id);
      return this.finish(row.id, TIMED_OUT);
    }
    const exit = await run(box, ["cat", `${WORK}/${row.id}/exit`]);
    const code = exit.code === 0 ? Number.parseInt(decoder.decode(exit.stdout).trim(), 10) : Number.NaN;
    // An empty file is the instant between the shell creating it and writing the code.
    if (Number.isNaN(code)) return row;
    return this.finish(row.id, code, await this.readResult(box, row.id));
  }

  private async readResult(box: Box, id: string): Promise<unknown> {
    const tail = await run(box, ["tail", "-c", String(RESULT_WINDOW + 1), `${WORK}/${id}/out.log`]);
    if (tail.code !== 0) return undefined; // no stdout.log: the job never started
    return parseResult(decoder.decode(tail.stdout), tail.stdout.length > RESULT_WINDOW);
  }

  private async size(box: Box, file: string): Promise<number> {
    const r = await run(box, ["stat", "-c", "%s", file]);
    const n = r.code === 0 ? Number.parseInt(decoder.decode(r.stdout).trim(), 10) : 0;
    return Number.isNaN(n) ? 0 : n;
  }

  private async slice(box: Box, file: string, from: number, count: number): Promise<Uint8Array> {
    const r = await run(box, ["dd", "iflag=skip_bytes,count_bytes", `skip=${from}`, `count=${count}`, `if=${file}`, "status=none"]);
    return r.code === 0 ? r.stdout : new Uint8Array(0);
  }
}

// ---------------------------------------------------------------------------- client

// Typed by hand: the Workers RPC stub types turn a result of `unknown` into `never` or recurse without end.
type RunnerStub = Pick<Runner, "start" | "status" | "log" | "cancel">;

type RunnerBindings = {
  RUNNER: DurableObjectNamespace;
  RYKE_RUNNER_SLOTS?: string;
};

// Round-robin per isolate. Isolates are many, so the spread is statistical; it starts at a random
// slot so that a burst of fresh isolates does not all begin on slot 0.
let cursor = Math.floor(Math.random() * MAX_SLOTS);

// Implements the Runner contract of runner.ts by sending each job to the Runner DO of one slot.
export class ContainerRunner implements RunnerClient {
  constructor(private readonly env: Env) {}

  private get bindings(): RunnerBindings {
    // RUNNER and RYKE_RUNNER_SLOTS join Env when wrangler.jsonc gains them (M9).
    return this.env as unknown as RunnerBindings;
  }

  private slotCount(): number {
    const n = Number(this.bindings.RYKE_RUNNER_SLOTS);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_SLOTS) : DEFAULT_SLOTS;
  }

  private stub(slot: number): RunnerStub {
    const ns = this.bindings.RUNNER;
    return ns.get(ns.idFromName(`slot-${slot}`)) as unknown as RunnerStub;
  }

  // Errors cross Workers RPC as plain Errors; callers of Runner expect RunnerError.
  private async rpc<T>(what: string, slot: number, call: (stub: RunnerStub) => Promise<T>): Promise<T> {
    try {
      return await call(this.stub(slot));
    } catch (e) {
      if (e instanceof RunnerError) throw e;
      throw new RunnerError(`runner ${what} failed: ${(e as Error).message}`);
    }
  }

  private slotFor(id: string): number {
    const slot = slotOf(id);
    if (slot === null) throw new RunnerError(`invalid job id "${id}"`);
    return slot;
  }

  async start(kind: JobKind, args: Record<string, string>, env: Record<string, string>): Promise<string> {
    if (kind === "swarm") throw new RunnerError("swarm jobs run only in process mode (PLAN.md §11.2)");
    const slot = cursor++ % this.slotCount();
    const id = newJobId(slot);
    await this.rpc("start", slot, (s) => s.start(id, kind, args, env));
    return id;
  }

  async status(id: string): Promise<JobStatus> {
    const s = await this.rpc("status", this.slotFor(id), (stub) => stub.status(id));
    return { state: s.state, exitCode: s.exitCode, result: s.result };
  }

  // async, so a malformed id rejects instead of throwing before a promise exists.
  async log(id: string, offset: number): Promise<{ text: string; next: number }> {
    return this.rpc("log", this.slotFor(id), (s) => s.log(id, offset));
  }

  async cancel(id: string): Promise<void> {
    return this.rpc("cancel", this.slotFor(id), (s) => s.cancel(id));
  }
}

// ---------------------------------------------------------------------------- Outbound gateway

// `allow` is the set of repos the container may reach; absent means any repo in the namespace.
// Interception is registered per container, so this is per container as well (see desiredAllow).
export type OutboundProps = { allow?: string[] };

export const ARTIFACTS_SUFFIX = ".artifacts.cloudflare.net";
export const ANTHROPIC_HOST = "api.anthropic.com";

const GIT_PATH = /^\/git\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.git(?:\/|$)/;

// Which repo a git smart-HTTP request is about, or null for any other path on an Artifacts host.
export function gitTarget(url: URL): { namespace: string; repo: string } | null {
  const m = GIT_PATH.exec(url.pathname);
  return m ? { namespace: m[1]!, repo: m[2]! } : null;
}

// A push needs a write token; clones and fetches get a read token, so a compromised container
// cannot push to a repo it was only meant to read.
export function scopeOf(url: URL, method: string): "read" | "write" {
  if (url.searchParams.get("service") === "git-receive-pack") return "write";
  return method === "POST" && url.pathname.endsWith("/git-receive-pack") ? "write" : "read";
}

type CachedToken = { plaintext: string; renewAt: number };
// Per isolate. Tokens are repo-scoped and expire, and a container makes several requests per git
// operation, so one mint serves them all. Exported so tests can start empty and watch the pruning.
export const gatewayTokens = new Map<string, CachedToken>();

async function tokenFor(artifacts: Artifacts, repo: string, scope: "read" | "write"): Promise<string> {
  const key = `${repo}:${scope}`;
  const now = Date.now();
  const cached = gatewayTokens.get(key);
  if (cached && cached.renewAt > now) return cached.plaintext;
  for (const [k, t] of gatewayTokens) if (t.renewAt <= now) gatewayTokens.delete(k);
  using handle = await artifacts.get(repo);
  const made = await handle.createToken(scope, TOKEN_TTL_S);
  const expires = Date.parse(made.expiresAt);
  gatewayTokens.set(key, { plaintext: made.plaintext, renewAt: (Number.isNaN(expires) ? now + TOKEN_TTL_S * 1000 : expires) - TOKEN_RENEW_MS });
  return made.plaintext;
}

const deny = (status: number, error: string) => Response.json({ error }, { status });

// Every request the container makes leaves through here (interceptOutboundHttps("*") plus
// interceptAllOutboundHttp), which is where credentials are attached: no secret enters the
// container, so the container never holds a token to leak.
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname.endsWith(ARTIFACTS_SUFFIX)) return this.artifacts(request, url);
    if (url.hostname === ANTHROPIC_HOST) {
      const key = (this.env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
      // Fail closed: forwarding the container's placeholder key would only fail slower, after retries.
      if (!key) return deny(503, "ANTHROPIC_API_KEY is not configured on the gateway");
      return forward(request, url, (h) => h.set("x-api-key", key));
    }
    return fetch(request);
  }

  private async artifacts(request: Request, url: URL): Promise<Response> {
    // Only git smart HTTP is served: the rest of the Artifacts host is not the container's business.
    const target = gitTarget(url);
    if (!target) return deny(403, "only git requests under /git/<namespace>/<repo>.git are served");
    if (this.env.RYKE_NAMESPACE && target.namespace !== this.env.RYKE_NAMESPACE) {
      return deny(403, `namespace "${target.namespace}" is not served`);
    }
    // Checked before Artifacts is contacted: a denied repo costs nothing and reveals nothing.
    const allow = this.ctx.props?.allow;
    if (allow !== undefined && !allow.includes(target.repo)) return deny(403, `repo "${target.repo}" is not allowed for this container`);
    if (!this.env.ARTIFACTS) return deny(503, "the ARTIFACTS binding is not configured on the gateway");
    let token: string;
    try {
      token = await tokenFor(this.env.ARTIFACTS, target.repo, scopeOf(url, request.method));
    } catch (e) {
      return (e as { code?: string }).code === "NOT_FOUND"
        ? deny(404, `repo "${target.repo}" does not exist`)
        : deny(502, `could not mint a token for "${target.repo}"`);
    }
    // Whatever credentials the container sent are dropped; the plain-HTTP rule is upgraded so the
    // token never travels in the clear.
    url.username = "";
    url.password = "";
    url.protocol = "https:";
    return forward(request, url, (h) => h.set("authorization", `Bearer ${token}`));
  }
}

// Not following redirects: a gateway that adds credentials must not replay them at wherever a
// response points; the client sees the redirect and decides.
function forward(request: Request, url: URL, edit: (headers: Headers) => void): Promise<Response> {
  const headers = new Headers(request.headers);
  edit(headers);
  return fetch(new Request(url, { method: request.method, headers, body: request.body, redirect: "manual" }));
}
