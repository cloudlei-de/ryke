// Container-mode runner (PLAN.md §3.4): a Runner Durable Object per job slot drives one container
// through `ctx.container`, the ContainerRunner client routes jobs to those slots, and Outbound is
// the egress gateway that keeps every secret out of the container (docs/platform-notes.md §Sandbox).
//
// Two kinds of job meet here, and they never share a container. The trusted kinds (seed, land,
// revert) run our scripts over git data. Everything else (verify, agent) runs code a transaction's
// author wrote, as root, so it gets a slot range of its own, one job per container, and the container
// is stopped when the job is over. What a job may reach is decided only by the Worker that started
// it, through RYKE_ALLOW_REPOS and the job kind, never by the job.
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
// Below two slots there is nothing to keep apart.
const MIN_SLOTS = 2;
// An untrusted job needs a container to itself, so a start can find every slot of its range taken
// (the Runner answers "busy"). The client then waits for one to be stopped instead of failing the
// train, which would be retried against the same wall.
const ACQUIRE_MS = 120_000;
const ACQUIRE_RETRY_MS = 1000;
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

// Kinds whose scripts are ours and that only take data from git. Every other kind, including one added
// later and not listed here, runs code a transaction's author controls (the verify command, Claude's
// tools) and is treated as hostile: its own slot range, its own container, stopped afterwards. That is
// a cold start per job (1-3 s plus the image), paid so a test cannot leave a daemon behind or rewrite
// /opt/ryke for the lander that would use the same container next.
const TRUSTED_KINDS: ReadonlySet<string> = new Set(["seed", "land", "revert"]);
export const isTrusted = (kind: string): boolean => TRUSTED_KINDS.has(kind);

// Verify needs Artifacts for its checkout and nothing else, so it gets no other egress (not even
// api.anthropic.com): its tests are the author's, and anything they can reach they can send source to.
// Agents need the Anthropic API and the trusted kinds keep their reach as before; Artifacts is bounded
// by RYKE_ALLOW_REPOS for all of them.
const CLOSED_EGRESS_KINDS: ReadonlySet<string> = new Set(["verify"]);

export type Access = "read" | "write";
export type RepoAccess = Record<string, Access>;

// RYKE_ALLOW_REPOS is `<repo>:<read|write>,...`: the repos a job's container may reach through the
// gateway, and how. Absent or empty means none. It used to mean "any repo", and a verify job that
// ran with no list could push to trunk; a bare repo name is refused for the same reason, since it
// would have to mean either read or write and either guess is wrong for someone.
export function parseAllow(raw: string | undefined): RepoAccess {
  const modes = new Map<string, Access>();
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const colon = entry.lastIndexOf(":");
    const repo = colon < 0 ? entry : entry.slice(0, colon);
    const mode = colon < 0 ? "" : entry.slice(colon + 1);
    if (!REPO_RE.test(repo)) throw new RunnerError(`RYKE_ALLOW_REPOS has an invalid repo name "${repo}"`);
    if (mode !== "read" && mode !== "write") throw new RunnerError(`RYKE_ALLOW_REPOS entry "${entry}" needs a mode: <repo>:read or <repo>:write`);
    if (modes.get(repo) !== "write") modes.set(repo, mode);
  }
  return Object.fromEntries([...modes].sort(([a], [b]) => (a < b ? -1 : 1)));
}

const formatAllow = (allow: RepoAccess): string =>
  Object.entries(allow)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([repo, mode]) => `${repo}:${mode}`)
    .join(",");

// Own properties only: a repo may be called "constructor", and Object.prototype must not grant it.
const grantFor = (allow: RepoAccess | undefined, repo: string): Access | undefined => (allow !== undefined && Object.hasOwn(allow, repo) ? allow[repo] : undefined);

function unionAllow(lists: RepoAccess[]): RepoAccess {
  const out = new Map<string, Access>();
  for (const list of lists) for (const [repo, mode] of Object.entries(list)) if (out.get(repo) !== "write") out.set(repo, mode);
  return Object.fromEntries(out);
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
  // `<repo>:<mode>,...` as the job named them (normalised); '' = no Artifacts access.
  allow: string;
  // 1 = this job ran untrusted code in the container that has not been stopped since. Set when such a
  // job starts and cleared when the container is stopped or gone, so a Durable Object that restarted
  // in between still knows what the container may be holding.
  dirty: number;
};

type Ran = { code: number; stdout: Uint8Array; stderr: string };

async function run(box: Box, cmd: string[], options?: ContainerExecOptions): Promise<Ran> {
  const out = await (await box.exec(cmd, options)).output();
  return { code: out.exitCode, stdout: new Uint8Array(out.stdout), stderr: decoder.decode(out.stderr) };
}

type Gateway = { allow: RepoAccess; egress: "open" | "closed" };

const gatewayKey = (g: Gateway) => `${g.egress}|${formatAllow(g.allow)}`;

const terminal = (r: Row) => r.state === "done" || r.state === "failed";

export class Runner extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  // Concurrent start() calls share one boot, or the second would exec before the intercepts exist.
  private booting: Promise<void> | null = null;
  // What the container's gateway rules were last registered with. Unknown after a DO restart, so the
  // first start of a new instance registers again.
  private registered: string | null = null;
  private gatewayChain: Promise<void> = Promise.resolve();
  // One teardown at a time; everything that wants the container free joins the one in flight.
  private reaping: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Not deployed yet, so no migrations; a column added after the first deploy needs a guarded ALTER here.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS runner_job (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER, result TEXT, allow TEXT NOT NULL DEFAULT '',
      dirty INTEGER NOT NULL DEFAULT 0)`);
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

  private gateway(g: Gateway): Fetcher {
    const props: OutboundProps = { allow: g.allow, egress: g.egress };
    return this.exports().Outbound({ props });
  }

  protected now(): number {
    return Date.now();
  }

  // ---------------------------------------------------------------- RPC

  // "busy" means this container may not take the job now (see admits); the caller tries another slot.
  async start(id: string, kind: JobKind, args: Record<string, string>, env: Record<string, string>): Promise<"started" | "busy"> {
    if (slotOf(id) === null) throw new RunnerError(`invalid job id "${id}"`);
    checkJob(kind, args, env);
    const allow = parseAllow(env.RYKE_ALLOW_REPOS);
    // Whatever call site asks, a verify job never holds a credential that can write: its tests are
    // the author's, and a push to trunk from them lands unverified code.
    if (kind === "verify" && Object.values(allow).includes("write")) throw new RunnerError("verify jobs never get write access to a repo");
    const box = this.requireBox();
    if (this.find(id)) throw new RunnerError(`job "${id}" already exists`);
    const trusted = isTrusted(kind);
    if (!this.admits(trusted)) {
      // A job that ended since the last poll must not keep the container closed, and an untrusted
      // container nobody stopped yet is stopped here, before anything else goes into it.
      await this.sweep();
      await this.reap();
      if (!this.admits(trusted)) return "busy";
    }
    // No await between the last admission check and this insert: two starts cannot both pass it.
    this.sql.exec(
      "INSERT INTO runner_job (id, kind, state, started_at, allow, dirty) VALUES (?, ?, 'queued', ?, ?, ?)",
      id,
      kind,
      this.now(),
      formatAllow(allow),
      trusted ? 0 : 1,
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
      await this.reap();
      throw e;
    }
    if (this.find(id)?.state !== "queued") {
      // Cancelled or swept while the container booted: the job it describes must not outlive its row,
      // and a cancel that came during the boot left the teardown to this tail.
      await this.killGroup(box, id);
      await this.reap();
      return "started";
    }
    this.sql.exec("UPDATE runner_job SET state = 'running' WHERE id = ?", id);
    return "started";
  }

  async status(id: string): Promise<JobStatus> {
    const row = await this.refresh(this.row(id));
    await this.reap();
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
    // After the read: a job that this very poll saw end may be an untrusted one, whose disk goes now.
    await this.reap();
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
    await this.reap();
  }

  async alarm(): Promise<void> {
    await this.sweep();
    await this.reap();
    // A container that would not stop is watched until it does: nothing may enter it meanwhile.
    if (this.count("state IN ('queued', 'running')") + this.count("dirty = 1") > 0) await this.ctx.storage.setAlarm(this.now() + KEEPALIVE_MS);
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
    // Whatever an earlier untrusted job left was in the container that is gone.
    this.sql.exec("UPDATE runner_job SET dirty = 0 WHERE state IN ('done', 'failed')");
    try {
      box.start({ image, instance: "standard-2", enableInternet: false, env: { RYKE_ROOT: ROOT } });
      // Intercepts end with the container, so every start registers them again.
      await this.registerGateway(box, this.desiredGateway());
      await box.setInactivityTimeout(INACTIVITY_MS);
    } catch (e) {
      // A container up without its gateway would let a job run with no egress rules; start over next time.
      await box.destroy().catch(() => {});
      throw e;
    }
  }

  // The HTTPS catch-all goes before the plain-HTTP catch-all, as the platform requires for hostname rules.
  private async registerGateway(box: Box, want: Gateway): Promise<void> {
    this.registered = null;
    const gateway = this.gateway(want);
    await box.interceptOutboundHttps("*", gateway);
    await box.interceptAllOutboundHttp(gateway);
    this.registered = gatewayKey(want);
  }

  // Interception is per container, not per job, so what the gateway lets through is too: the union of
  // what the jobs now queued or running may reach (the stronger mode wins for a repo two of them
  // name). An untrusted job is alone in its container, so for it this is exactly its own list; the
  // union only ever mixes trusted jobs, whose code is ours. It narrows again once those jobs end, at
  // the next start. With nothing to go on the gateway is closed rather than open.
  private desiredGateway(): Gateway {
    const rows = this.sql.exec<Pick<Row, "kind" | "allow">>("SELECT kind, allow FROM runner_job WHERE state IN ('queued', 'running')").toArray();
    return {
      allow: unionAllow(rows.map((r) => parseAllow(r.allow))),
      egress: rows.length > 0 && !rows.some((r) => CLOSED_EGRESS_KINDS.has(r.kind)) ? "open" : "closed",
    };
  }

  // Registering again replaces the handler and its props without dropping open connections.
  // Serialised, so two starts cannot finish their registrations out of order.
  private syncGateway(box: Box): Promise<void> {
    const next = this.gatewayChain
      .catch(() => {})
      .then(async () => {
        // A job that ended since the last poll must not keep its repos reachable.
        await this.sweep();
        const want = this.desiredGateway();
        if (this.registered !== gatewayKey(want)) await this.registerGateway(box, want);
      });
    this.gatewayChain = next;
    return next;
  }

  private count(where: string): number {
    return this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM runner_job WHERE ${where}`).one().n;
  }

  // Whether this container may take a job of this class now. Untrusted jobs run alone and only in a
  // container nothing untrusted has run in since it was last stopped; trusted jobs share one that is
  // clean of untrusted jobs (an untrusted job is dirty from the moment it is queued, so the mark
  // covers the running ones too). The client keeps the two classes in separate slot ranges, so a
  // refusal here means a busy slot, or a slot count that changed under running jobs, never an error.
  private admits(trusted: boolean): boolean {
    if (this.count("dirty = 1") > 0) return false;
    return trusted || this.count("state IN ('queued', 'running')") === 0;
  }

  // Stops the container once no job is left in it and an untrusted one has run there, so nothing it
  // left behind (a daemon, a rewritten script, a planted credential helper) reaches the next job. A
  // failed stop leaves the mark: the slot stays closed, and the alarm and every later poll try again.
  private reap(): Promise<void> {
    this.reaping ??= this.stopIfDirty().finally(() => {
      this.reaping = null;
    });
    return this.reaping;
  }

  private async stopIfDirty(): Promise<void> {
    // A start in flight with nothing else queued is a cancelled one; its own tail stops the container
    // once the boot is over, and a cancel must not wait for the boot to say so.
    if (this.booting || this.count("state IN ('queued', 'running')") > 0 || this.count("dirty = 1") === 0) return;
    const box = this.box();
    if (box?.running) {
      try {
        await box.destroy();
      } catch {
        return;
      }
      // The intercepts went with the container.
      this.registered = null;
    }
    this.sql.exec("UPDATE runner_job SET dirty = 0");
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

// Round-robin per isolate and per class. Isolates are many, so the spread is statistical; each
// cursor starts at a random slot so that a burst of fresh isolates does not all begin on slot 0.
const cursors = { trusted: Math.floor(Math.random() * MAX_SLOTS), untrusted: Math.floor(Math.random() * MAX_SLOTS) };

export type RunnerTuning = { acquireMs?: number; retryMs?: number };

// Implements the Runner contract of runner.ts by sending each job to the Runner DO of one slot.
export class ContainerRunner implements RunnerClient {
  // `tuning` is for tests; production takes the defaults.
  constructor(
    private readonly env: Env,
    private readonly tuning: RunnerTuning = {},
  ) {}

  private get bindings(): RunnerBindings {
    // RUNNER and RYKE_RUNNER_SLOTS join Env when wrangler.jsonc gains them (M9).
    return this.env as unknown as RunnerBindings;
  }

  private slotCount(): number {
    const n = Number(this.bindings.RYKE_RUNNER_SLOTS);
    return Number.isInteger(n) && n >= 1 ? Math.max(MIN_SLOTS, Math.min(n, MAX_SLOTS)) : DEFAULT_SLOTS;
  }

  // The first third of the slots (at least one) take the trusted kinds, the rest everything else:
  // verify jobs outnumber them (one per train, and each holds its container alone), while the
  // trusted ones share theirs. The two ranges never overlap, so no container sees both.
  private range(trusted: boolean): readonly [from: number, to: number] {
    const n = this.slotCount();
    const split = Math.max(1, Math.floor(n / 3));
    return trusted ? [0, split] : [split, n];
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
    const trusted = isTrusted(kind);
    const [from, to] = this.range(trusted);
    const cursor = trusted ? "trusted" : "untrusted";
    const until = Date.now() + (this.tuning.acquireMs ?? ACQUIRE_MS);
    for (;;) {
      // One pass offers the job to every slot of its range once, starting where the last job stopped.
      for (let tried = 0; tried < to - from; tried++) {
        const slot = from + (cursors[cursor]++ % (to - from));
        const id = newJobId(slot);
        if ((await this.rpc("start", slot, (s) => s.start(id, kind, args, env))) !== "busy") return id;
      }
      if (Date.now() >= until) {
        throw new RunnerError(`no free runner slot for ${kind} jobs after ${Math.round((this.tuning.acquireMs ?? ACQUIRE_MS) / 1000)} s; every one of slots ${from}-${to - 1} holds a job (raise RYKE_RUNNER_SLOTS)`);
      }
      await new Promise((r) => setTimeout(r, this.tuning.retryMs ?? ACQUIRE_RETRY_MS));
    }
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

// What this container's gateway lets through. `allow` maps repos to the strongest access any job in
// the container was granted; a repo that is absent is not served, and so is every repo when `allow`
// itself is absent. `egress: "closed"` serves Artifacts and nothing else; anything but "closed" keeps
// the pass-through (and the Anthropic and OpenAI key swaps) the agents need. Interception is registered per
// container, so this is per container as well (see desiredGateway).
export type OutboundProps = { allow?: RepoAccess; egress?: "open" | "closed" };

export const ARTIFACTS_SUFFIX = ".artifacts.cloudflare.net";
export const ANTHROPIC_HOST = "api.anthropic.com";
// Codex on an API key (containers/runner/lib/agent.mjs). A subscription is never used in a container, so
// chatgpt.com, where a ChatGPT login would go, gets no credential from here.
export const OPENAI_HOST = "api.openai.com";

const GIT_PATH = /^\/git\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.git(?:\/|$)/;
// The three paths of git smart HTTP, anchored at both ends: one request, one repo, one operation.
const GIT_OPERATION = /^\/git\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const SERVICE_SCOPE: Record<string, Access> = { "git-upload-pack": "read", "git-receive-pack": "write" };

// Which repo a git smart-HTTP request is about, or null for any other path on an Artifacts host.
export function gitTarget(url: URL): { namespace: string; repo: string } | null {
  const m = GIT_PATH.exec(url.pathname);
  return m ? { namespace: m[1]!, repo: m[2]! } : null;
}

// The scope a git request needs, or null when it is none of the four requests a clone, fetch or push
// is made of (GET info/refs for either service, POST upload-pack, POST receive-pack). A push needs a
// write token and a fetch a read token, so a container given a repo to read cannot push to it; and a
// request that is not one of the four is not served at all, rather than served with a read token,
// because "read" there would be a guess about what the server does with it.
export function scopeOf(url: URL, method: string): Access | null {
  const operation = GIT_OPERATION.exec(url.pathname)?.[1];
  if (operation === undefined) return null;
  if (operation === "info/refs") {
    if (method !== "GET") return null;
    // Two `service` parameters would leave it to the server which one counts.
    const services = url.searchParams.getAll("service");
    return services.length === 1 && Object.hasOwn(SERVICE_SCOPE, services[0]!) ? SERVICE_SCOPE[services[0]!]! : null;
  }
  return method === "POST" ? SERVICE_SCOPE[operation]! : null;
}

type CachedToken = { plaintext: string; renewAt: number; host: string };
// Per isolate. Tokens are repo-scoped and expire, and a container makes several requests per git
// operation, so one mint serves them all. Exported so tests can start empty and watch the pruning.
export const gatewayTokens = new Map<string, CachedToken>();

// A token for the repo, but only for the host the repo really lives on: the one in the remote the
// binding itself reports. Any other `*.artifacts.cloudflare.net` host is another account's, and a
// token sent there would be a token handed to whoever runs it. Returns null for such a host, before
// anything is minted.
async function tokenFor(artifacts: Artifacts, repo: string, scope: Access, host: string): Promise<string | null> {
  const key = `${repo}:${scope}`;
  const now = Date.now();
  const cached = gatewayTokens.get(key);
  if (cached && cached.renewAt > now) return cached.host === host ? cached.plaintext : null;
  for (const [k, t] of gatewayTokens) if (t.renewAt <= now) gatewayTokens.delete(k);
  using handle = await artifacts.get(repo);
  const remote = new URL((await handle.info()).remote);
  if (remote.protocol !== "https:") throw new Error("remote is not an https URL");
  if (remote.host !== host) return null;
  const made = await handle.createToken(scope, TOKEN_TTL_S);
  const expires = Date.parse(made.expiresAt);
  gatewayTokens.set(key, { plaintext: made.plaintext, host, renewAt: (Number.isNaN(expires) ? now + TOKEN_TTL_S * 1000 : expires) - TOKEN_RENEW_MS });
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
    // A closed gateway serves Artifacts and nothing else. The container has no route of its own
    // (enableInternet: false), so this is where everything else ends.
    if (this.ctx.props?.egress === "closed") return deny(403, `egress to "${url.hostname}" is not allowed for this container`);
    if (url.hostname === ANTHROPIC_HOST) {
      const key = (this.env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
      // Fail closed: forwarding the container's placeholder key would only fail slower, after retries.
      if (!key) return deny(503, "ANTHROPIC_API_KEY is not configured on the gateway");
      return forward(request, url, (h) => h.set("x-api-key", key));
    }
    if (url.hostname === OPENAI_HOST) {
      const key = (this.env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
      if (!key) return deny(503, "OPENAI_API_KEY is not configured on the gateway");
      return forward(request, url, (h) => h.set("authorization", `Bearer ${key}`));
    }
    return fetch(request);
  }

  private async artifacts(request: Request, url: URL): Promise<Response> {
    // Only git smart HTTP is served: the rest of the Artifacts host is not the container's business.
    const target = gitTarget(url);
    if (!target) return deny(403, "only git requests under /git/<namespace>/<repo>.git are served");
    const need = scopeOf(url, request.method);
    if (!need) return deny(403, "only git fetch and push requests (info/refs, git-upload-pack, git-receive-pack) are served");
    if (this.env.RYKE_NAMESPACE && target.namespace !== this.env.RYKE_NAMESPACE) {
      return deny(403, `namespace "${target.namespace}" is not served`);
    }
    // Checked before Artifacts is contacted: a denied repo costs nothing and reveals nothing. Without
    // a list there is no access, and a read entry never covers a push.
    const granted = grantFor(this.ctx.props?.allow, target.repo);
    if (!granted) return deny(403, `repo "${target.repo}" is not allowed for this container`);
    if (need === "write" && granted !== "write") return deny(403, `repo "${target.repo}" is read-only for this container`);
    if (!this.env.ARTIFACTS) return deny(503, "the ARTIFACTS binding is not configured on the gateway");
    let token: string | null;
    try {
      token = await tokenFor(this.env.ARTIFACTS, target.repo, need, url.host);
    } catch (e) {
      return (e as { code?: string }).code === "NOT_FOUND"
        ? deny(404, `repo "${target.repo}" does not exist`)
        : deny(502, `could not mint a token for "${target.repo}"`);
    }
    if (token === null) return deny(403, `host "${url.host}" is not the Artifacts host of this namespace`);
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
