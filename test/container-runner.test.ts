// Container-mode runner (PLAN.md §3.4) against a fake container: the Runner DO runs on the real
// SQLite and alarm of a scratch Durable Object, with only `ctx.container` and the gateway swapped.
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Outbound,
  ContainerRunner,
  Runner,
  checkJob,
  completeUtf8Length,
  gatewayTokens,
  gitTarget,
  jobEnvironment,
  killCommand,
  launchCommand,
  newJobId,
  parseAllow,
  parseResult,
  scopeOf,
  shellQuote,
  slotOf,
  type Box,
} from "../src/worker/runner/container";
import { ProcessRunner } from "../src/worker/runner/process";
import { RunnerError, runnerFor, type JobKind } from "../src/worker/runner/runner";

const enc = new TextEncoder();
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const IMAGE = "registry.test/ryke-runner@sha256:abc123";
const GATEWAY = { gateway: "outbound" } as unknown as Fetcher;
const allowsOf = (rules: unknown[]) => rules.map((r) => (r as { allow?: string[] }).allow);
const MIB = 1024 * 1024;

// ------------------------------------------------------------------------------------ fakes

type ExecCall = { cmd: string[]; options?: ContainerExecOptions };
type Sim = { code?: number; stdout?: Uint8Array | string; stderr?: string };

const bytes = (v: Uint8Array | string): Uint8Array => (typeof v === "string" ? enc.encode(v) : v);
const buf = (v: Uint8Array): ArrayBuffer => v.slice().buffer as ArrayBuffer;

// A container whose disk is a map and whose exec understands exactly the argv the Runner DO sends.
// Anything else throws, so an unexpected command cannot pass a test unnoticed.
class FakeContainer implements Box {
  running = false;
  images: Record<string, string> = { runner: IMAGE };
  events: string[] = [];
  starts: ContainerStartupOptions[] = [];
  httpsRules: { addr: string; binding: Fetcher }[] = [];
  httpRules: Fetcher[] = [];
  inactivity: (number | bigint)[] = [];
  destroys = 0;
  execs: ExecCall[] = [];
  files = new Map<string, Uint8Array>();
  killed: string[] = [];
  nextPid = 4100;
  mkdirExit = 0;
  launchExit = 0;
  launchStderr = "";
  failIntercept = false;
  failInactivity = false;
  failHttp = false;
  // Holds the kill exec open, so a cancel can be observed half way.
  killGate: Promise<void> | null = null;
  // Holds interceptOutboundHttps open, so a boot can be observed half way.
  gate: Promise<void> | null = null;
  throwOn: ((cmd: string[]) => boolean) | null = null;

  start(options?: ContainerStartupOptions): void {
    if (this.running) throw new Error("container already running");
    this.running = true;
    this.events.push("start");
    this.starts.push(options as ContainerStartupOptions);
  }

  async destroy(): Promise<void> {
    this.running = false;
    this.destroys++;
    this.events.push("destroy");
  }

  async setInactivityTimeout(ms: number | bigint): Promise<void> {
    this.events.push("inactivity");
    if (this.failInactivity) throw new Error("inactivity refused");
    this.inactivity.push(ms);
  }

  async interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void> {
    this.events.push("https");
    await this.gate;
    if (this.failIntercept) throw new Error("intercept refused");
    this.httpsRules.push({ addr, binding });
  }

  async interceptAllOutboundHttp(binding: Fetcher): Promise<void> {
    this.events.push("http");
    if (this.failHttp) throw new Error("http intercept refused");
    this.httpRules.push(binding);
  }

  async exec(cmd: string[], options?: ContainerExecOptions): Promise<{ output(): Promise<ExecOutput> }> {
    if (!this.running) throw new Error("container is not running");
    this.execs.push({ cmd, options });
    this.events.push(`exec ${cmd[0]}`);
    if (this.throwOn?.(cmd)) throw new Error("exec refused");
    if (cmd[0] === "bash" && cmd[2]?.includes("kill -TERM")) await this.killGate;
    const r = this.simulate(cmd, options);
    return {
      output: async () => ({
        stdout: buf(bytes(r.stdout ?? "")),
        stderr: buf(bytes(r.stderr ?? "")),
        exitCode: r.code ?? 0,
      }),
    };
  }

  private simulate(cmd: string[], options?: ContainerExecOptions): Sim {
    const [bin, ...rest] = cmd;
    const file = (path: string | undefined) => this.files.get(path ?? "");
    switch (bin) {
      case "mkdir":
        return { code: this.mkdirExit };
      case "bash": {
        const script = rest[1] ?? "";
        if (script.startsWith("setsid ")) {
          this.write(`/work/${options?.env?.RYKE_JOB_ID}/pid`, `${this.nextPid++}\n`);
          return { code: this.launchExit, stderr: this.launchStderr };
        }
        const id = /\/work\/(j_[0-9a-z_]+)\/pid/.exec(script)?.[1];
        if (id === undefined || !script.includes("kill -TERM")) throw new Error(`unexpected bash script: ${script}`);
        this.killed.push(id);
        return {};
      }
      case "cat": {
        const f = file(rest[0]);
        return f ? { stdout: f } : { code: 1, stderr: "No such file or directory" };
      }
      case "tail": {
        // tail -c N <file>
        const f = file(rest[2]);
        return f ? { stdout: f.subarray(Math.max(0, f.length - Number(rest[1]))) } : { code: 1 };
      }
      case "stat": {
        // stat -c %s <file>
        const f = file(rest[2]);
        return f ? { stdout: `${f.length}\n` } : { code: 1 };
      }
      case "dd": {
        // dd iflag=skip_bytes,count_bytes skip=S count=C if=F status=none
        const arg = (name: string) => rest.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
        const f = file(arg("if"));
        if (!f) return { code: 1 };
        const skip = Number(arg("skip"));
        return { stdout: f.subarray(skip, skip + Number(arg("count"))) };
      }
      default:
        throw new Error(`unexpected exec: ${cmd.join(" ")}`);
    }
  }

  write(path: string, content: Uint8Array | string): void {
    this.files.set(path, bytes(content));
  }

  append(path: string, content: Uint8Array | string): void {
    const old = this.files.get(path) ?? new Uint8Array(0);
    const add = bytes(content);
    const next = new Uint8Array(old.length + add.length);
    next.set(old);
    next.set(add, old.length);
    this.files.set(path, next);
  }

  // What the detached wrapper leaves behind when the script ends: its two logs, then the exit code.
  finishJob(id: string, code: number, stdout: Uint8Array | string = "", stderr: Uint8Array | string = ""): void {
    this.write(`/work/${id}/out.log`, stdout);
    this.write(`/work/${id}/err.log`, stderr);
    this.write(`/work/${id}/exit`, `${code}\n`);
  }

  execsOf(bin: string): string[][] {
    return this.execs.filter((e) => e.cmd[0] === bin).map((e) => e.cmd);
  }
}

type Harness = {
  box: FakeContainer;
  clock: { t: number };
  state: DurableObjectState;
  // A new Runner on the same storage, the way a restarted DO would be.
  make: () => Runner;
  runner: Runner;
};

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

// Borrows the storage of a scratch Ledger instance: real SQLite and a real alarm, nothing shared
// with other tests because each gets a fresh instance name.
async function withRunner(fn: (h: Harness) => Promise<void>, opts: { container?: boolean } = {}): Promise<void> {
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`runner-test-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_ledger, state) => {
    const box = new FakeContainer();
    const clock = { t: Date.now() };
    // The seams are overridden through closures: a constructor runs before subclass fields exist.
    class Under extends Runner {
      protected override box(): Box | undefined {
        return opts.container === false ? undefined : box;
      }
      // Stands in for ctx.exports; the Fetcher it returns carries the props it was made with, so
      // tests can see what each registration was given.
      protected override exports() {
        return { Outbound: ({ props }: { props: { allow?: string[] } }) => ({ ...GATEWAY, ...props }) as unknown as Fetcher };
      }
      protected override now(): number {
        return clock.t;
      }
    }
    const make = () => new Under(state, env);
    try {
      await fn({ box, clock, state, make, runner: make() });
    } finally {
      await state.storage.deleteAlarm();
    }
  });
}

let counter = 0;
const jobId = (slot = 0) => `j_${slot}_${(++counter).toString(36).padStart(8, "0")}`;
const ARGS = { repo: "convert", txn: "t_1" };
const JOB_ENV = { FOO: "bar" };

// A lexer for the sh subset launchCommand emits, so the quoting is checked by what a shell would
// see and not by comparing against a string computed with the same rules.
function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let inQuote = false;
  const flush = () => {
    if (started) out.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (inQuote) {
      if (c === "'") inQuote = false;
      else cur += c;
    } else if (c === "'") {
      inQuote = true;
      started = true;
    } else if (c === "\\") {
      cur += cmd[++i];
      started = true;
    } else if (/\s/.test(c)) {
      flush();
    } else if ("<>&;".includes(c)) {
      // A run of operator characters is one token, so `2>&1` reads as `2`, `>&`, `1`.
      if (!(started && /^[<>&;]+$/.test(cur))) flush();
      cur += c;
      started = true;
    } else {
      if (started && /^[<>&;]+$/.test(cur)) flush();
      cur += c;
      started = true;
    }
  }
  if (inQuote) throw new Error(`unterminated quote in ${cmd}`);
  flush();
  return out;
}

// ------------------------------------------------------------------------------------ pure helpers

describe("shellQuote", () => {
  it.each([
    ["abc", "abc"],
    ["--repo", "--repo"],
    ["/opt/ryke/bin/land.sh", "/opt/ryke/bin/land.sh"],
    ["a=b,c:d@e%f+g", "a=b,c:d@e%f+g"],
    ["", "''"],
    ["two words", "'two words'"],
    ["it's", `'it'\\''s'`],
    ["'", `''\\'''`],
    ["$HOME", "'$HOME'"],
    ["a;b", "'a;b'"],
    ["$(rm -rf /)", "'$(rm -rf /)'"],
    ["`id`", "'`id`'"],
    ["a\nb", "'a\nb'"],
    ["https://h/x.git?a=1&b=2", "'https://h/x.git?a=1&b=2'"],
    ["ünï", "'ünï'"],
  ])("quotes %j as %j", (input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });

  it.each(["", "plain", "two words", "it's", "''", "a\\b", "$x `y` $(z)", "a;b&c|d>e<f", "line1\nline2", "tab\there", "ünï ✓", "\"dq\""])(
    "reads back as one word: %j",
    (input) => {
      expect(shellWords(`echo ${shellQuote(input)} end`)).toEqual(["echo", input, "end"]);
    },
  );
});

describe("job ids", () => {
  it.each([
    ["j_0_abcdef", 0],
    ["j_5_abcdef123456", 5],
    ["j_63_0123456789abcdefghij", 63],
    ["j_999_abcdef", 999],
  ])("%s belongs to slot %i", (id, slot) => {
    expect(slotOf(id)).toBe(slot);
  });

  it.each([
    "",
    "j_",
    "j_x_abcdef",
    "j_1_abc", // random part too short
    "j_1_ABCDEF",
    "j_1000_abcdef", // slot wider than three digits
    "j_-1_abcdef",
    "j_1_abcdef/../x",
    "j_1_abcdef;rm",
    "k_1_abcdef",
    " j_1_abcdef",
    "j_1_abcdef\n",
    "j_1__abcdef",
  ])("%j is not a job id", (id) => {
    expect(slotOf(id)).toBeNull();
  });

  it("newJobId encodes the slot and is unique", () => {
    const ids = Array.from({ length: 200 }, () => newJobId(4));
    expect(new Set(ids).size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^j_4_[0-9a-z]{10}$/);
      expect(slotOf(id)).toBe(4);
    }
  });
});

describe("launchCommand", () => {
  const id = "j_2_abcdef123456";

  it("detaches the job into its own session with pid, log and exit files", () => {
    expect(launchCommand(id, "land", { repo: "convert", train: "tr_1" })).toBe(
      "setsid bash -c 'bash /opt/ryke/containers/runner/bin/land.sh --repo convert --train tr_1 " +
        "> /work/j_2_abcdef123456/out.log 2> /work/j_2_abcdef123456/err.log; echo $? > /work/j_2_abcdef123456/exit' " +
        "< /dev/null > /dev/null 2>&1 & echo $! > /work/j_2_abcdef123456/pid",
    );
  });

  it("runs a script with no arguments", () => {
    expect(launchCommand(id, "verify", {})).toContain("'bash /opt/ryke/containers/runner/bin/verify.sh > /work/");
  });

  it.each<Record<string, string>>([
    { a: "plain" },
    { msg: "it's a \"test\"" },
    { remote: "https://h.test/git/ryke/r.git?x=1&y=2" },
    { evil: "$(touch /tmp/pwned); `id` && rm -rf /" },
    { nl: "line1\nline2", empty: "", tab: "a\tb" },
    { uni: "ünï ✓", slash: "a\\b", quotes: `''"'` },
  ])("hands every argument to the script exactly as given: %j", (args) => {
    const outer = shellWords(launchCommand(id, "agent", args));
    // setsid bash -c <inner> < /dev/null > /dev/null 2>&1 & echo $! > pid
    expect(outer.slice(0, 3)).toEqual(["setsid", "bash", "-c"]);
    expect(outer.slice(4)).toEqual(["<", "/dev/null", ">", "/dev/null", "2", ">&", "1", "&", "echo", "$!", ">", `/work/${id}/pid`]);
    const inner = shellWords(outer[3]!);
    const expectedArgs = Object.entries(args).flatMap(([k, v]) => [`--${k}`, v]);
    expect(inner).toEqual([
      "bash",
      "/opt/ryke/containers/runner/bin/agent.sh",
      ...expectedArgs,
      ">",
      `/work/${id}/out.log`,
      "2",
      ">",
      `/work/${id}/err.log`,
      ";",
      "echo",
      "$?",
      ">",
      `/work/${id}/exit`,
    ]);
  });

  it("backgrounds only the setsid command, so $! is the session leader", () => {
    const words = shellWords(launchCommand(id, "land", ARGS));
    // The single `&` that is not part of `2>&1` follows the redirections of setsid itself.
    expect(words.filter((w) => w === "&")).toHaveLength(1);
    expect(words.indexOf("&")).toBeLessThan(words.indexOf("echo"));
    expect(words).not.toContain("&&");
  });
});

describe("killCommand", () => {
  it("terminates the process group from the pid file, then kills what is left", () => {
    const cmd = killCommand("j_1_abcdef");
    expect(cmd).toBe(
      'pid=$(cat /work/j_1_abcdef/pid 2>/dev/null); [ -n "$pid" ] || exit 0; kill -TERM -- "-$pid" 2>/dev/null; ' +
        'for i in 1 2 3 4; do kill -0 -- "-$pid" 2>/dev/null || exit 0; sleep 0.5; done; kill -KILL -- "-$pid" 2>/dev/null; exit 0',
    );
    expect(cmd.indexOf("kill -TERM")).toBeLessThan(cmd.indexOf("kill -KILL"));
  });
});

describe("jobEnvironment", () => {
  it("adds the job identity, directories and gateway CA to the caller's env", () => {
    expect(jobEnvironment("j_0_abcdef", { FOO: "bar" })).toEqual({
      HOME: "/root",
      FOO: "bar",
      RYKE_ROOT: "/opt/ryke",
      RYKE_JOB_ID: "j_0_abcdef",
      RYKE_JOB_DIR: "/work/j_0_abcdef",
      RYKE_EVIDENCE_DIR: "/work/evidence",
      NODE_EXTRA_CA_CERTS: CA,
      GIT_SSL_CAINFO: CA,
      SSL_CERT_FILE: CA,
      CURL_CA_BUNDLE: CA,
    });
  });

  it("lets a job choose HOME but not its identity or trust roots", () => {
    const spoof = {
      HOME: "/home/agent",
      RYKE_ROOT: "/evil",
      RYKE_JOB_ID: "j_9_other",
      RYKE_JOB_DIR: "/evil",
      RYKE_EVIDENCE_DIR: "/evil",
      NODE_EXTRA_CA_CERTS: "/evil",
      GIT_SSL_CAINFO: "/evil",
      SSL_CERT_FILE: "/evil",
      CURL_CA_BUNDLE: "/evil",
    };
    const e = jobEnvironment("j_0_abcdef", spoof);
    expect(e.HOME).toBe("/home/agent");
    expect(Object.values({ ...e, HOME: "" })).not.toContain("/evil");
    expect(e.RYKE_JOB_ID).toBe("j_0_abcdef");
  });
});

describe("checkJob", () => {
  it.each([
    ["land", {}, {}],
    ["verify", { a: "1", "b-c": "x y" }, { A_B: "v", lower: "" }],
    ["agent", { empty: "" }, {}],
  ] as const)("accepts %s", (kind, args, e) => {
    expect(() => checkJob(kind, { ...args }, { ...e })).not.toThrow();
  });

  it.each([
    ["Land", {}, {}, "kind must match"],
    ["", {}, {}, "kind must match"],
    ["../land", {}, {}, "kind must match"],
    ["land sh", {}, {}, "kind must match"],
    ["land", { "": "x" }, {}, "args has an invalid name"],
    ["land", { k: "a\0b" }, {}, "args has an invalid name"],
    ["land", { "a\0": "b" }, {}, "args has an invalid name"],
    ["land", { k: 1 }, {}, "args.k must be a string"],
    ["land", [], {}, "args must be an object"],
    ["land", null, {}, "args must be an object"],
    ["land", {}, { "": "x" }, "env has an invalid name"],
    ["land", {}, { "A=B": "x" }, "env has an invalid name"],
    ["land", {}, { A: "x\0" }, "env has an invalid name"],
    ["land", {}, { A: true }, "env.A must be a string"],
    ["land", {}, "FOO=1", "env must be an object"],
  ] as const)("rejects kind %j args %j env %j", (kind, args, e, message) => {
    expect(() => checkJob(kind, args as never, e as never)).toThrow(message);
    expect(() => checkJob(kind, args as never, e as never)).toThrow(RunnerError);
  });

  it("allows '=' in an argument name, which only becomes --name=...", () => {
    expect(() => checkJob("land", { "a=b": "c" }, {})).not.toThrow();
  });
});

describe("parseAllow", () => {
  it.each([
    [undefined, undefined],
    ["", []],
    ["  ", []],
    [",,", []],
    ["convert", ["convert"]],
    ["b,a", ["a", "b"]],
    [" a , b ", ["a", "b"]],
    ["a,,b,a", ["a", "b"]],
    ["convert--t_1,convert", ["convert", "convert--t_1"]],
    ["a.b_c-d", ["a.b_c-d"]],
  ] as const)("reads %j as %j", (raw, expected) => {
    expect(parseAllow(raw)).toEqual(expected);
  });

  it.each(["a b", "../x", "-x", ".hidden", "a/b", "a*", "ü", "a;b", "ok,bad name", ".."])("rejects %j", (raw) => {
    expect(() => parseAllow(raw)).toThrow("RYKE_ALLOW_REPOS has an invalid repo name");
    expect(() => parseAllow(raw)).toThrow(RunnerError);
  });
});

describe("gitTarget", () => {
  const at = (path: string) => gitTarget(new URL(`https://acct.artifacts.cloudflare.net${path}`));

  it.each([
    ["/git/ryke/convert.git/info/refs", { namespace: "ryke", repo: "convert" }],
    ["/git/ryke/convert.git", { namespace: "ryke", repo: "convert" }],
    ["/git/ryke/convert.git/", { namespace: "ryke", repo: "convert" }],
    ["/git/ryke/convert--t_1.git/git-receive-pack", { namespace: "ryke", repo: "convert--t_1" }],
    ["/git/other/a.b_c-d.git/HEAD", { namespace: "other", repo: "a.b_c-d" }],
    ["/git/ryke/x.git/objects/info/packs", { namespace: "ryke", repo: "x" }],
  ])("%s names a repo", (path, expected) => {
    expect(at(path)).toEqual(expected);
  });

  it.each([
    "/",
    "/git",
    "/git/",
    "/git/ryke",
    "/git/ryke/",
    "/git/ryke/convert",
    "/git/ryke/convert/info/refs",
    "/git/ryke/convert.git.x/info/refs",
    "/git/ryke/.git/info/refs",
    "/git/ryke/..git/info/refs",
    "/git//convert.git/info/refs",
    "/git/ry%20ke/convert.git/info/refs",
    "/git/ryke/con%2Fvert.git/info/refs",
    "/git/ryke/../convert.git/info/refs", // normalised away by the URL parser into /git/convert.git
    "/GIT/ryke/convert.git/info/refs",
    "/x/git/ryke/convert.git/info/refs",
    "/api/v1/repos",
    "/v1/tokens",
  ])("%s names none", (path) => {
    expect(at(path)).toBeNull();
  });
});

describe("scopeOf", () => {
  const base = "https://acct.artifacts.cloudflare.net/git/ryke/convert.git";
  it.each([
    ["GET", "/info/refs?service=git-upload-pack", "read"],
    ["GET", "/info/refs?service=git-receive-pack", "write"],
    ["GET", "/info/refs?service=git-receive-pack&x=1", "write"],
    ["POST", "/git-upload-pack", "read"],
    ["POST", "/git-receive-pack", "write"],
    ["POST", "/git-receive-pack?x=1", "write"],
    ["GET", "/git-receive-pack", "read"], // not a push: receive-pack is only ever POSTed
    ["HEAD", "/git-receive-pack", "read"],
    ["GET", "/info/refs", "read"],
    ["GET", "/HEAD", "read"],
    ["GET", "/info/refs?service=git-upload-pack-evil", "read"],
    ["GET", "/info/refs?service=GIT-RECEIVE-PACK", "read"],
    ["POST", "/not-git-receive-pack-x", "read"],
  ] as const)("%s %s needs %s", (method, path, scope) => {
    expect(scopeOf(new URL(base + path), method)).toBe(scope);
  });
});

describe("parseResult", () => {
  it.each([
    ["", false, undefined],
    ["\n\n  \n", false, undefined],
    ['{"sha":"abc"}', false, { sha: "abc" }],
    ['{"sha":"abc"}\n', false, { sha: "abc" }],
    ['log line\n{"sha":"abc"}\n\n  \n', false, { sha: "abc" }],
    ['  {"a":1}  \n', false, { a: 1 }],
    ["noise\n[1,2]\n", false, [1, 2]],
    ["5\n", false, 5],
    ["null\n", false, null],
    ['"text"\n', false, "text"],
    ['{"a":1}\nnot json\n', false, undefined],
    ["{broken\n", false, undefined],
    ['{"a":1}\r\n', false, { a: 1 }],
    // The window cut the file: its first line may be a fragment, later lines are whole.
    ['{"a":1}', true, undefined],
    ['frag{"a":1}\n{"b":2}\n', true, { b: 2 }],
    ['frag\n{"b":2}', true, { b: 2 }],
    ["tail of a long line\n\n", true, undefined],
  ] as const)("reads %j (truncated %s) as %j", (text, truncated, expected) => {
    expect(parseResult(text, truncated)).toEqual(expected);
  });
});

describe("completeUtf8Length", () => {
  const e = (s: string) => enc.encode(s);
  it.each([
    ["empty", new Uint8Array(0), 0],
    ["ascii", e("abc"), 3],
    ["whole two-byte char", e("aé"), 3],
    ["cut after the lead of a two-byte char", e("aé").subarray(0, 2), 1],
    ["whole three-byte char", e("✓"), 3],
    ["three-byte char with one byte missing", e("✓").subarray(0, 2), 0],
    ["three-byte char with two bytes missing", e("a✓").subarray(0, 2), 1],
    ["whole four-byte char", e("😀"), 4],
    ["four-byte char with one byte missing", e("😀").subarray(0, 3), 0],
    ["four-byte char after text", e("ab😀").subarray(0, 4), 2],
    ["only continuation bytes", new Uint8Array([0x80, 0x80]), 2],
  ])("%s", (_name, input, expected) => {
    expect(completeUtf8Length(input)).toBe(expected);
  });
});

// ------------------------------------------------------------------------------------ Runner DO

describe("Runner.start", () => {
  it("boots the container, registers the gateway, then launches the job detached", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = "j_2_abcdef123456";
      await runner.start(id, "land", { repo: "convert", train: "tr_1" }, JOB_ENV);

      expect(box.starts).toEqual([{ image: IMAGE, instance: "standard-2", enableInternet: false, env: { RYKE_ROOT: "/opt/ryke" } }]);
      expect(box.httpsRules).toEqual([{ addr: "*", binding: GATEWAY }]);
      expect(box.httpRules).toEqual([GATEWAY]);
      expect(box.inactivity).toEqual([600_000]);
      // Hostname rules go in before the plain-HTTP catch-all, and all of it before the first exec.
      expect(box.events).toEqual(["start", "https", "http", "inactivity", "exec mkdir", "exec bash"]);

      expect(box.execs[0]).toEqual({ cmd: ["mkdir", "-p", "/work/j_2_abcdef123456/work", "/work/evidence"], options: undefined });
      expect(box.execs[1]).toEqual({
        cmd: ["bash", "-c", launchCommand(id, "land", { repo: "convert", train: "tr_1" })],
        options: {
          cwd: "/work/j_2_abcdef123456/work",
          env: {
            HOME: "/root",
            FOO: "bar",
            RYKE_ROOT: "/opt/ryke",
            RYKE_JOB_ID: id,
            RYKE_JOB_DIR: "/work/j_2_abcdef123456",
            RYKE_EVIDENCE_DIR: "/work/evidence",
            NODE_EXTRA_CA_CERTS: CA,
            GIT_SSL_CAINFO: CA,
            SSL_CERT_FILE: CA,
            CURL_CA_BUNDLE: CA,
          },
        },
      });
      expect(await runner.status(id)).toEqual({ state: "running", exitCode: undefined, result: undefined });
    });
  });

  it("passes the job's env through exec only, never on a command line or in the start options", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "agent", ARGS, { SECRET_FOR_JOB: "s3cret-value" });
      expect(JSON.stringify(box.starts)).not.toContain("s3cret-value");
      expect(JSON.stringify(box.execs.map((e) => e.cmd))).not.toContain("s3cret-value");
      expect(box.execs[1]!.options?.env?.SECRET_FOR_JOB).toBe("s3cret-value");
    });
  });

  it("does not start a container that is already running, nor register the gateway twice", async () => {
    await withRunner(async ({ runner, box }) => {
      await runner.start(jobId(), "land", ARGS, {});
      await runner.start(jobId(), "verify", ARGS, {});
      expect(box.starts).toHaveLength(1);
      expect(box.httpsRules).toHaveLength(1);
      expect(box.httpRules).toHaveLength(1);
      expect(box.execsOf("bash")).toHaveLength(2);
    });
  });

  it("starts the container again, with fresh intercepts, after it stopped", async () => {
    await withRunner(async ({ runner, box }) => {
      await runner.start(jobId(), "land", ARGS, {});
      box.running = false; // idle timeout or crash: intercepts went with it
      await runner.start(jobId(), "land", ARGS, {});
      expect(box.starts).toHaveLength(2);
      expect(box.httpsRules).toHaveLength(2);
      expect(box.httpRules).toHaveLength(2);
      expect(box.inactivity).toEqual([600_000, 600_000]);
    });
  });

  it("lets concurrent starts share one boot and exec only after the intercepts exist", async () => {
    await withRunner(async ({ runner, box }) => {
      let release!: () => void;
      box.gate = new Promise<void>((r) => (release = r));
      const a = runner.start(jobId(), "land", ARGS, {});
      const b = runner.start(jobId(), "verify", ARGS, {});
      await tick();
      expect(box.running).toBe(true); // running flips at start(), well before the gateway is registered
      expect(box.execs).toHaveLength(0);
      release();
      await Promise.all([a, b]);
      expect(box.starts).toHaveLength(1);
      expect(box.httpsRules).toHaveLength(1);
      // Both jobs launch, but only once the one boot is complete.
      expect(box.events.slice(0, 4)).toEqual(["start", "https", "http", "inactivity"]);
      expect(box.events.slice(4).sort()).toEqual(["exec bash", "exec bash", "exec mkdir", "exec mkdir"]);
    });
  });

  it("reports queued while the container boots, then running", async () => {
    await withRunner(async ({ runner, box }) => {
      let release!: () => void;
      box.gate = new Promise<void>((r) => (release = r));
      const id = jobId();
      const started = runner.start(id, "land", ARGS, {});
      await tick();
      expect(await runner.status(id)).toEqual({ state: "queued", exitCode: undefined, result: undefined });
      release();
      await started;
      expect((await runner.status(id)).state).toBe("running");
    });
  });

  it.each([
    ["an id without a slot", "land-1", "land", ARGS, {}, "invalid job id"],
    ["an id that could escape the work dir", "j_1_abcdef/../../x", "land", ARGS, {}, "invalid job id"],
    ["a bad kind", "j_1_abcdef01", "Land", ARGS, {}, "kind must match"],
    ["a NUL in an argument", "j_1_abcdef02", "land", { a: "x\0" }, {}, "invalid name or value"],
    ["a bad env name", "j_1_abcdef03", "land", ARGS, { "A=B": "x" }, "invalid name or value"],
  ])("rejects %s before touching the container", async (_name, id, kind, args, e, message) => {
    await withRunner(async ({ runner, box }) => {
      await expect(runner.start(id, kind as JobKind, args, e)).rejects.toThrow(message);
      expect(box.starts).toHaveLength(0);
      expect(box.execs).toHaveLength(0);
    });
  });

  it("rejects a job id that is already in use, leaving the first job alone", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      await expect(runner.start(id, "land", ARGS, {})).rejects.toThrow("already exists");
      expect(box.execsOf("bash")).toHaveLength(1);
      expect((await runner.status(id)).state).toBe("running");
    });
  });

  it("rejects when the Durable Object has no container", async () => {
    await withRunner(
      async ({ runner }) => {
        await expect(runner.start(jobId(), "land", ARGS, {})).rejects.toThrow("no container is configured");
      },
      { container: false },
    );
  });

  describe("launch failures mark the job failed with 127 and tell the caller", () => {
    it("no runner image", async () => {
      await withRunner(async ({ runner, box }) => {
        box.images = {};
        const id = jobId();
        await expect(runner.start(id, "land", ARGS, {})).rejects.toThrow("no `runner` image");
        expect(box.starts).toHaveLength(0);
        expect(await runner.status(id)).toMatchObject({ state: "failed", exitCode: 127 });
      });
    });

    it("mkdir fails", async () => {
      await withRunner(async ({ runner, box }) => {
        box.mkdirExit = 1;
        const id = jobId();
        await expect(runner.start(id, "land", ARGS, {})).rejects.toThrow("could not create /work/");
        expect(box.execsOf("bash")).toHaveLength(0);
        expect(await runner.status(id)).toMatchObject({ state: "failed", exitCode: 127 });
      });
    });

    it("the launch shell exits non-zero", async () => {
      await withRunner(async ({ runner, box }) => {
        box.launchExit = 2;
        box.launchStderr = "setsid: not found\n";
        const id = jobId();
        await expect(runner.start(id, "land", ARGS, {})).rejects.toThrow("could not launch land: setsid: not found");
        expect(await runner.status(id)).toMatchObject({ state: "failed", exitCode: 127 });
      });
    });

    it("the launch shell exits non-zero without a message", async () => {
      await withRunner(async ({ runner, box }) => {
        box.launchExit = 3;
        await expect(runner.start(jobId(), "land", ARGS, {})).rejects.toThrow("could not launch land: exit 3");
      });
    });

    it("exec itself fails", async () => {
      await withRunner(async ({ runner, box }) => {
        box.throwOn = (cmd) => cmd[0] === "bash";
        const id = jobId();
        await expect(runner.start(id, "land", ARGS, {})).rejects.toThrow("exec refused");
        expect(await runner.status(id)).toMatchObject({ state: "failed", exitCode: 127 });
      });
    });

    it("the gateway cannot be registered: the container is destroyed and the next start boots a fresh one", async () => {
      await withRunner(async ({ runner, box }) => {
        box.failIntercept = true;
        const first = jobId();
        await expect(runner.start(first, "land", ARGS, {})).rejects.toThrow("intercept refused");
        expect(box.destroys).toBe(1);
        expect(box.running).toBe(false);
        expect(box.execs).toHaveLength(0);
        expect(await runner.status(first)).toMatchObject({ state: "failed", exitCode: 127 });

        box.failIntercept = false;
        const second = jobId();
        await runner.start(second, "land", ARGS, {});
        expect(box.starts).toHaveLength(2);
        expect((await runner.status(second)).state).toBe("running");
      });
    });

    it("a container that will not take the inactivity timeout is not left running", async () => {
      await withRunner(async ({ runner, box }) => {
        box.failInactivity = true;
        await expect(runner.start(jobId(), "land", ARGS, {})).rejects.toThrow("inactivity refused");
        expect(box.destroys).toBe(1);
      });
    });
  });
});

describe("Runner.status", () => {
  it("is running until the exit file exists", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.write(`/work/${id}/out.log`, "working...\n"); // output alone does not end a job
      expect(await runner.status(id)).toEqual({ state: "running", exitCode: undefined, result: undefined });
    });
  });

  it.each([
    ["an empty exit file (the shell is between creating and writing it)", ""],
    ["a half-written exit file", "\n"],
    ["a garbage exit file", "oops\n"],
  ])("stays running for %s", async (_name, content) => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.write(`/work/${id}/exit`, content);
      expect((await runner.status(id)).state).toBe("running");
    });
  });

  it.each([
    ["done with the last stdout line as result", 0, 'building\n{"sha":"abc","landed":["t_1"]}\n', "done", { sha: "abc", landed: ["t_1"] }],
    ["done without a result when stdout ends in prose", 0, "all good\n", "done", undefined],
    ["done without a result when stdout is empty", 0, "", "done", undefined],
    ["done ignoring trailing blank lines", 0, '{"ok":true}\n\n\n', "done", { ok: true }],
    ["failed with its result", 1, '{"error":"tests failed","failures":[{"name":"adds"}]}\n', "failed", { error: "tests failed", failures: [{ name: "adds" }] }],
    ["failed without a result", 2, "boom\n", "failed", undefined],
    ["failed for any non-zero code", 255, "", "failed", undefined],
    ["failed for the code of a killed script", 137, "", "failed", undefined],
    ["done with a scalar result", 0, "42\n", "done", 42],
    ["done with a null result", 0, "null\n", "done", null],
  ])("is %s", async (_name, code, stdout, state, result) => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.finishJob(id, code, stdout, "diagnostics on stderr\n");
      expect(await runner.status(id)).toEqual({ state, exitCode: code, result });
    });
  });

  it("takes the result from stdout only, never from stderr", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.finishJob(id, 0, '{"from":"stdout"}\n', '{"from":"stderr"}\n');
      expect((await runner.status(id)).result).toEqual({ from: "stdout" });
    });
  });

  it("finds the result at the end of a log far larger than the window", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "verify", ARGS, {});
      box.finishJob(id, 0, `${"x".repeat(2 * MIB)}\n{"ok":true}\n`);
      expect((await runner.status(id)).result).toEqual({ ok: true });
    });
  });

  it("does not trust the fragment a window cuts off when the log is one huge line", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "verify", ARGS, {});
      box.finishJob(id, 0, `{"pad":"${"x".repeat(2 * MIB)}"}`);
      expect((await runner.status(id)).result).toBeUndefined();
    });
  });

  it("reports no result when out.log never existed", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.write(`/work/${id}/exit`, "127\n");
      expect(await runner.status(id)).toEqual({ state: "failed", exitCode: 127, result: undefined });
    });
  });

  it("answers from storage once a job has ended, without touching the container", async () => {
    await withRunner(async ({ runner, box, make }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.finishJob(id, 0, '{"sha":"abc"}\n');
      await runner.status(id);
      const execs = box.execs.length;
      box.running = false; // the container went to sleep; the outcome must outlive it
      expect(await runner.status(id)).toEqual({ state: "done", exitCode: 0, result: { sha: "abc" } });
      expect(await make().status(id)).toEqual({ state: "done", exitCode: 0, result: { sha: "abc" } });
      expect(box.execs).toHaveLength(execs);
    });
  });

  it("survives a Durable Object restart while the job runs", async () => {
    await withRunner(async ({ runner, box, make }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      const restarted = make();
      expect((await restarted.status(id)).state).toBe("running");
      box.finishJob(id, 3);
      expect(await restarted.status(id)).toMatchObject({ state: "failed", exitCode: 3 });
    });
  });

  it("fails a running job whose container is gone with 137", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.running = false;
      expect(await runner.status(id)).toEqual({ state: "failed", exitCode: 137, result: undefined });
    });
  });

  it("fails a job whose start was lost after three minutes, and not before", async () => {
    await withRunner(async ({ runner, box, clock }) => {
      let release!: () => void;
      box.gate = new Promise<void>((r) => (release = r));
      const id = jobId();
      const started = runner.start(id, "land", ARGS, {});
      await tick();
      clock.t += 3 * 60_000;
      expect((await runner.status(id)).state).toBe("queued");
      clock.t += 1;
      expect(await runner.status(id)).toEqual({ state: "failed", exitCode: 127, result: undefined });
      release();
      await started;
      expect((await runner.status(id)).state).toBe("failed"); // the late launch cannot revive it
      expect(box.killed).toEqual([id]); // and the process it did launch is stopped
    });
  });

  it("kills and fails a job that outlives the two-hour backstop with 124", async () => {
    await withRunner(async ({ runner, box, clock }) => {
      const id = jobId();
      await runner.start(id, "agent", ARGS, {});
      clock.t += 2 * 3600_000;
      expect((await runner.status(id)).state).toBe("running");
      expect(box.killed).toEqual([]);
      clock.t += 1;
      expect(await runner.status(id)).toEqual({ state: "failed", exitCode: 124, result: undefined });
      expect(box.killed).toEqual([id]);
    });
  });

  it("still ends a job past the backstop when the container cannot be reached for the kill", async () => {
    await withRunner(async ({ runner, box, clock }) => {
      const id = jobId();
      await runner.start(id, "agent", ARGS, {});
      clock.t += 2 * 3600_000 + 1;
      box.throwOn = (cmd) => cmd[0] === "bash";
      expect(await runner.status(id)).toMatchObject({ state: "failed", exitCode: 124 });
    });
  });

  it.each(["j_1_unknown01", "not-an-id", "j_1_abcdef/../x", ""])("rejects unknown id %j", async (id) => {
    await withRunner(async ({ runner }) => {
      await expect(runner.status(id)).rejects.toThrow("no such job");
    });
  });

  it("propagates an exec failure while polling instead of guessing an outcome", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.throwOn = (cmd) => cmd[0] === "cat";
      await expect(runner.status(id)).rejects.toThrow("exec refused");
      box.throwOn = null;
      expect((await runner.status(id)).state).toBe("running");
    });
  });
});

describe("Runner.log", () => {
  it("serves stdout from an offset while the job runs, never stderr", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.write(`/work/${id}/out.log`, "one\ntwo\n");
      box.write(`/work/${id}/err.log`, "warning\n");
      expect(await runner.log(id, 0)).toEqual({ text: "one\ntwo\n", next: 8 });
      expect(await runner.log(id, 4)).toEqual({ text: "two\n", next: 8 });
      expect(await runner.log(id, 8)).toEqual({ text: "", next: 8 });
      box.append(`/work/${id}/out.log`, "three\n");
      expect(await runner.log(id, 8)).toEqual({ text: "three\n", next: 14 });
      const reads = box.execs.filter((e) => ["stat", "dd", "cat", "tail"].includes(e.cmd[0]!));
      expect(reads.flatMap((e) => e.cmd).filter((a) => a.includes("err.log"))).toEqual([]);
    });
  });

  it("is empty before the job writes anything", async () => {
    await withRunner(async ({ runner }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      expect(await runner.log(id, 0)).toEqual({ text: "", next: 0 });
    });
  });

  it("appends stderr after stdout once the job has ended, with continuous offsets", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.write(`/work/${id}/out.log`, "one\n");
      const live = await runner.log(id, 0);
      expect(live).toEqual({ text: "one\n", next: 4 });

      box.finishJob(id, 0, "one\ntwo\n", "warn\n");
      expect(await runner.log(id, live.next)).toEqual({ text: "two\nwarn\n", next: 13 }); // rest of stdout, then stderr
      expect(await runner.log(id, 0)).toEqual({ text: "one\ntwo\nwarn\n", next: 13 });
      expect(await runner.log(id, 6)).toEqual({ text: "o\nwarn\n", next: 13 }); // inside stdout
      expect(await runner.log(id, 8)).toEqual({ text: "warn\n", next: 13 }); // exactly at the boundary
      expect(await runner.log(id, 10)).toEqual({ text: "rn\n", next: 13 }); // inside stderr
      expect(await runner.log(id, 13)).toEqual({ text: "", next: 13 });
    });
  });

  it("serves the log of a failed job as well", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "verify", ARGS, {});
      box.finishJob(id, 1, "", "FAIL adds\n");
      expect(await runner.log(id, 0)).toEqual({ text: "FAIL adds\n", next: 10 });
    });
  });

  it("clamps an offset past the end so later bytes are not skipped", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.write(`/work/${id}/out.log`, "abc");
      expect(await runner.log(id, 100)).toEqual({ text: "", next: 3 });
      box.append(`/work/${id}/out.log`, "def");
      expect(await runner.log(id, 3)).toEqual({ text: "def", next: 6 });
    });
  });

  it("does not hand out half a character while the job runs, and completes it later", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      const check = enc.encode("✓"); // e2 9c 93
      const head = enc.encode("ok ");
      const cut = new Uint8Array(head.length + 2);
      cut.set(head);
      cut.set(check.subarray(0, 2), head.length);
      box.write(`/work/${id}/out.log`, cut);
      expect(await runner.log(id, 0)).toEqual({ text: "ok ", next: 3 });
      box.write(`/work/${id}/out.log`, `ok ✓ done`);
      expect(await runner.log(id, 3)).toEqual({ text: "✓ done", next: 3 + 3 + 5 });
    });
  });

  it("hands over a dangling character once the job is over: nothing will complete it", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.finishJob(id, 0, enc.encode("ok ✓").subarray(0, 5));
      const r = await runner.log(id, 0);
      expect(r.next).toBe(5);
      expect(r.text.startsWith("ok ")).toBe(true);
    });
  });

  it("returns at most one megabyte per call and lets the reader continue", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "agent", ARGS, {});
      box.finishJob(id, 0, "a".repeat(MIB + 10));
      const first = await runner.log(id, 0);
      expect(first.text).toHaveLength(MIB);
      expect(first.next).toBe(MIB);
      const second = await runner.log(id, first.next);
      expect(second).toEqual({ text: "a".repeat(10), next: MIB + 10 });
    });
  });

  it("spills a chunk over the cap into the next file without re-reading", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "agent", ARGS, {});
      box.finishJob(id, 0, "a".repeat(MIB - 2), "bcdef");
      const first = await runner.log(id, 0);
      expect(first.text).toBe("a".repeat(MIB - 2) + "bc");
      expect(await runner.log(id, first.next)).toEqual({ text: "def", next: MIB + 3 });
    });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])("rejects offset %s", async (offset) => {
    await withRunner(async ({ runner }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      await expect(runner.log(id, offset)).rejects.toThrow("offset must be a non-negative integer");
    });
  });

  it("rejects an unknown id", async () => {
    await withRunner(async ({ runner }) => {
      await expect(runner.log("j_1_unknown01", 0)).rejects.toThrow("no such job");
    });
  });

  it("is empty for a queued job, and once the container that held the log is gone", async () => {
    await withRunner(async ({ runner, box }) => {
      let release!: () => void;
      box.gate = new Promise<void>((r) => (release = r));
      const queued = jobId();
      const started = runner.start(queued, "land", ARGS, {});
      await tick();
      expect(await runner.log(queued, 7)).toEqual({ text: "", next: 7 });
      release();
      await started;

      box.finishJob(queued, 0, "bye\n");
      await runner.status(queued);
      box.running = false;
      expect(await runner.log(queued, 0)).toEqual({ text: "", next: 0 });
    });
  });
});

describe("Runner.cancel", () => {
  it("signals the process group and fails the job with 143", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      await runner.cancel(id);
      expect(box.killed).toEqual([id]);
      expect(box.execsOf("bash").at(-1)).toEqual(["bash", "-c", killCommand(id)]);
      expect(await runner.status(id)).toEqual({ state: "failed", exitCode: 143, result: undefined });
    });
  });

  it("is a no-op for a job that already ended", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.finishJob(id, 0, '{"sha":"abc"}\n');
      await runner.status(id);
      const execs = box.execs.length;
      await runner.cancel(id);
      expect(box.execs).toHaveLength(execs);
      expect(await runner.status(id)).toEqual({ state: "done", exitCode: 0, result: { sha: "abc" } });
    });
  });

  it("keeps the real outcome of a job that exited by itself before the cancel", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.finishJob(id, 0, '{"sha":"abc"}\n'); // nobody polled yet
      await runner.cancel(id);
      expect(box.killed).toEqual([]);
      expect(await runner.status(id)).toEqual({ state: "done", exitCode: 0, result: { sha: "abc" } });
    });
  });

  it("lets the outcome a poll recorded stand when the job finished while the cancel was killing it", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      let release!: () => void;
      box.killGate = new Promise<void>((r) => (release = r));
      const cancelled = runner.cancel(id);
      await tick(); // the cancel has polled once and is now inside the kill
      box.finishJob(id, 0, '{"sha":"abc"}\n');
      expect(await runner.status(id)).toEqual({ state: "done", exitCode: 0, result: { sha: "abc" } });
      release();
      await cancelled;
      expect(await runner.status(id)).toEqual({ state: "done", exitCode: 0, result: { sha: "abc" } });
    });
  });

  it("cancelling twice kills once", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      await runner.cancel(id);
      await runner.cancel(id);
      expect(box.killed).toEqual([id]);
    });
  });

  it("still kills and fails the job when polling it throws", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.throwOn = (cmd) => cmd[0] === "cat";
      await runner.cancel(id);
      expect(box.killed).toEqual([id]);
      expect(await runner.status(id)).toMatchObject({ state: "failed", exitCode: 143 });
    });
  });

  it("fails the job even when the kill cannot reach the container", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.throwOn = (cmd) => cmd[0] === "bash" || cmd[0] === "cat";
      await runner.cancel(id);
      expect(await runner.status(id)).toMatchObject({ state: "failed", exitCode: 143 });
    });
  });

  it("leaves a job on a stopped container failed with 137: the container took it first", async () => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.running = false;
      await runner.cancel(id);
      expect(await runner.status(id)).toMatchObject({ state: "failed", exitCode: 137 });
    });
  });

  it("cancels a job that is still queued without signalling anything", async () => {
    await withRunner(async ({ runner, box }) => {
      let release!: () => void;
      box.gate = new Promise<void>((r) => (release = r));
      const id = jobId();
      const started = runner.start(id, "land", ARGS, {});
      await tick();
      await runner.cancel(id);
      expect(await runner.status(id)).toMatchObject({ state: "failed", exitCode: 143 });
      expect(box.killed).toEqual([]);
      release();
      await started;
      expect(box.killed).toEqual([id]); // the launch that was already under way is stopped once it lands
      expect(await runner.status(id)).toMatchObject({ state: "failed", exitCode: 143 });
    });
  });

  it("rejects an unknown id", async () => {
    await withRunner(async ({ runner }) => {
      await expect(runner.cancel("j_1_unknown01")).rejects.toThrow("no such job");
    });
  });
});

describe("Runner keep-alive", () => {
  const FIRST = 60_000;

  it("arms a 60 s alarm when a job starts and leaves a pending alarm alone for later jobs", async () => {
    await withRunner(async ({ runner, state, clock }) => {
      expect(await state.storage.getAlarm()).toBeNull();
      const base = clock.t;
      await runner.start(jobId(), "land", ARGS, {});
      expect(await state.storage.getAlarm()).toBe(base + FIRST);
      clock.t += 10_000;
      await runner.start(jobId(), "land", ARGS, {});
      expect(await state.storage.getAlarm()).toBe(base + FIRST); // a busy runner must not push it out forever
    });
  });

  it("arms the alarm even when the job fails to launch, so the stale row is swept", async () => {
    await withRunner(async ({ runner, box, state }) => {
      box.mkdirExit = 1;
      await expect(runner.start(jobId(), "land", ARGS, {})).rejects.toThrow();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("polls the running jobs and re-arms while any is left", async () => {
    await withRunner(async ({ runner, box, state, clock }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      await state.storage.deleteAlarm(); // the alarm that is now firing
      const before = box.execsOf("cat").length;
      clock.t += 60_000;
      await runner.alarm();
      expect(box.execsOf("cat").length).toBe(before + 1); // the poll is the container activity
      expect(await state.storage.getAlarm()).toBe(clock.t + 60_000);
    });
  });

  it("records a finished job and stops re-arming once nothing runs", async () => {
    await withRunner(async ({ runner, box, state, clock }) => {
      const id = jobId();
      await runner.start(id, "land", ARGS, {});
      box.finishJob(id, 0, '{"sha":"abc"}\n');
      await state.storage.deleteAlarm();
      clock.t += 60_000;
      await runner.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      box.running = false;
      expect(await runner.status(id)).toEqual({ state: "done", exitCode: 0, result: { sha: "abc" } }); // kept without the container
    });
  });

  it("keeps the alarm while one of several jobs is still running", async () => {
    await withRunner(async ({ runner, box, state, clock }) => {
      const a = jobId();
      const b = jobId();
      await runner.start(a, "land", ARGS, {});
      await runner.start(b, "verify", ARGS, {});
      box.finishJob(a, 0);
      await state.storage.deleteAlarm();
      clock.t += 60_000;
      await runner.alarm();
      expect((await runner.status(a)).state).toBe("done");
      expect((await runner.status(b)).state).toBe("running");
      expect(await state.storage.getAlarm()).toBe(clock.t + 60_000);
    });
  });

  it("does not arm anything when no job is running", async () => {
    await withRunner(async ({ runner, state }) => {
      await runner.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("does not let one unreachable job stop the sweep or the re-arm", async () => {
    await withRunner(async ({ runner, box, state, clock }) => {
      const a = jobId();
      const b = jobId();
      await runner.start(a, "land", ARGS, {});
      await runner.start(b, "verify", ARGS, {});
      box.finishJob(b, 0);
      box.throwOn = (cmd) => cmd[0] === "cat" && cmd[1] === `/work/${a}/exit`;
      await state.storage.deleteAlarm();
      clock.t += 60_000;
      await runner.alarm();
      box.throwOn = null;
      expect((await runner.status(b)).state).toBe("done");
      expect((await runner.status(a)).state).toBe("running");
      expect(await state.storage.getAlarm()).toBe(clock.t + 60_000);
    });
  });

  it("sweeps a start that never completed", async () => {
    await withRunner(async ({ runner, box, state, clock }) => {
      let release!: () => void;
      box.gate = new Promise<void>((r) => (release = r));
      const stuck = jobId();
      const started = runner.start(stuck, "land", ARGS, {});
      await tick();
      clock.t += 3 * 60_000 + 1;
      await state.storage.deleteAlarm();
      await runner.alarm();
      expect(await runner.status(stuck)).toMatchObject({ state: "failed", exitCode: 127 });
      expect(await state.storage.getAlarm()).toBeNull();
      release();
      await started;
    });
  });

  it("gives a restarted Durable Object the inactivity timeout back when its container is still up", async () => {
    await withRunner(async ({ runner, box, make }) => {
      await runner.start(jobId(), "land", ARGS, {});
      box.inactivity.length = 0;
      make();
      await tick();
      expect(box.inactivity).toEqual([600_000]);
    });
  });

  it("does not touch the inactivity timeout of a container that is not running", async () => {
    await withRunner(async ({ box, make }) => {
      make();
      await tick();
      expect(box.inactivity).toEqual([]);
    });
  });

  it("swallows a refused inactivity timeout in the constructor", async () => {
    await withRunner(async ({ box, make }) => {
      box.running = true;
      box.failInactivity = true;
      make();
      await tick();
      expect(box.events).toEqual(["inactivity"]);
    });
  });
});

describe("Runner gateway allow-list", () => {
  const job = (allow?: string): Record<string, string> => (allow === undefined ? {} : { RYKE_ALLOW_REPOS: allow });
  const httpsAllows = (box: FakeContainer) => allowsOf(box.httpsRules.map((r) => r.binding));
  const httpAllows = (box: FakeContainer) => allowsOf(box.httpRules);

  it("registers an unrestricted gateway when the job names no repos (the lander)", async () => {
    await withRunner(async ({ runner, box }) => {
      await runner.start(jobId(), "land", ARGS, job());
      expect(httpsAllows(box)).toEqual([undefined]);
      expect(httpAllows(box)).toEqual([undefined]);
    });
  });

  it("registers the job's repos on both rules, and still hands the job its own list", async () => {
    await withRunner(async ({ runner, box }) => {
      await runner.start(jobId(), "agent", ARGS, job("convert--t_1"));
      expect(httpsAllows(box)).toEqual([["convert--t_1"]]);
      expect(httpAllows(box)).toEqual([["convert--t_1"]]);
      expect(box.execs[1]!.options?.env?.RYKE_ALLOW_REPOS).toBe("convert--t_1");
    });
  });

  it.each([
    [" b, a ,a", ["a", "b"]],
    ["", []], // present but empty means nothing, never everything
    [" , ", []],
  ])("reads RYKE_ALLOW_REPOS=%j as %j", async (raw, expected) => {
    await withRunner(async ({ runner, box }) => {
      await runner.start(jobId(), "agent", ARGS, job(raw));
      expect(httpsAllows(box)).toEqual([expected]);
    });
  });

  it.each(["a b", "../x", "-x", "a/b", ".hidden", "ok,bad name"])("rejects RYKE_ALLOW_REPOS=%j before touching the container", async (raw) => {
    await withRunner(async ({ runner, box }) => {
      const id = jobId();
      await expect(runner.start(id, "agent", ARGS, job(raw))).rejects.toThrow("RYKE_ALLOW_REPOS has an invalid repo name");
      expect(box.starts).toHaveLength(0);
      expect(box.execs).toHaveLength(0);
      await expect(runner.status(id)).rejects.toThrow("no such job");
    });
  });

  it("does not register again for a second job with the same list", async () => {
    await withRunner(async ({ runner, box }) => {
      await runner.start(jobId(), "agent", ARGS, job("a"));
      await runner.start(jobId(), "agent", ARGS, job("a"));
      expect(box.httpsRules).toHaveLength(1);
      expect(box.httpRules).toHaveLength(1);
    });
  });

  it("widens the registration to the union while jobs run side by side, HTTPS rule first", async () => {
    await withRunner(async ({ runner, box }) => {
      await runner.start(jobId(), "agent", ARGS, job("a"));
      box.events.length = 0;
      await runner.start(jobId(), "agent", ARGS, job("b"));
      expect(httpsAllows(box)).toEqual([["a"], ["a", "b"]]);
      expect(httpAllows(box)).toEqual([["a"], ["a", "b"]]);
      expect(box.events.filter((e) => e === "https" || e === "http")).toEqual(["https", "http"]);
      expect(box.events.indexOf("exec cat")).toBeLessThan(box.events.indexOf("https")); // running jobs are polled first
      expect(box.starts).toHaveLength(1); // same container, new props
    });
  });

  it("becomes unrestricted while an unrestricted job runs, and stays so", async () => {
    await withRunner(async ({ runner, box }) => {
      await runner.start(jobId(), "agent", ARGS, job("a"));
      await runner.start(jobId(), "land", ARGS, job());
      await runner.start(jobId(), "agent", ARGS, job("c")); // cannot narrow it again
      expect(httpsAllows(box)).toEqual([["a"], undefined]);
    });
  });

  it("narrows again once the earlier jobs have ended", async () => {
    await withRunner(async ({ runner, box }) => {
      const first = jobId();
      await runner.start(first, "agent", ARGS, job("a"));
      box.finishJob(first, 0);
      await runner.start(jobId(), "agent", ARGS, job("b"));
      expect(httpsAllows(box)).toEqual([["a"], ["b"]]);
    });
  });

  it("does not let a cancelled or failed job keep its repos in the registration", async () => {
    await withRunner(async ({ runner, box }) => {
      const first = jobId();
      await runner.start(first, "agent", ARGS, job("a"));
      await runner.cancel(first);
      await runner.start(jobId(), "agent", ARGS, job("b"));
      expect(httpsAllows(box)).toEqual([["a"], ["b"]]);
    });
  });

  it("registers again after the Durable Object restarted, since it cannot know what is registered", async () => {
    await withRunner(async ({ runner, box, make }) => {
      await runner.start(jobId(), "agent", ARGS, job("a"));
      await make().start(jobId(), "agent", ARGS, job("a"));
      expect(httpsAllows(box)).toEqual([["a"], ["a"]]);
      expect(box.starts).toHaveLength(1);
    });
  });

  it("registers a fresh container with only what is running now", async () => {
    await withRunner(async ({ runner, box }) => {
      const first = jobId();
      await runner.start(first, "agent", ARGS, job("a"));
      box.finishJob(first, 0);
      await runner.status(first);
      box.running = false;
      await runner.start(jobId(), "agent", ARGS, job("b"));
      expect(box.starts).toHaveLength(2);
      expect(httpsAllows(box)).toEqual([["a"], ["b"]]);
    });
  });

  it("marks the jobs of a container that is gone as lost when the next one boots, and drops their repos", async () => {
    await withRunner(async ({ runner, box, state }) => {
      const old = jobId();
      await runner.start(old, "agent", ARGS, job("a"));
      box.running = false; // idle stop or crash, nobody polled in between
      await runner.start(jobId(), "agent", ARGS, job("b"));
      expect(httpsAllows(box)).toEqual([["a"], ["b"]]);
      expect(box.execsOf("cat")).toEqual([]); // no polling was needed to know
      box.running = true;
      expect(await runner.status(old)).toEqual({ state: "failed", exitCode: 137, result: undefined });
      await state.storage.deleteAlarm();
    });
  });

  it("registers once for starts that boot together, covering both jobs", async () => {
    await withRunner(async ({ runner, box }) => {
      let release!: () => void;
      box.gate = new Promise<void>((r) => (release = r));
      const a = runner.start(jobId(), "agent", ARGS, job("a"));
      const b = runner.start(jobId(), "agent", ARGS, job("b"));
      await tick();
      release();
      await Promise.all([a, b]);
      expect(httpsAllows(box)).toEqual([["a", "b"]]);
    });
  });

  it("registers again after a half-finished registration instead of trusting what it last registered", async () => {
    await withRunner(async ({ runner, box }) => {
      await runner.start(jobId(), "agent", ARGS, job("a"));
      box.failHttp = true; // the HTTPS rule goes in widened to a,b, the HTTP rule does not
      await expect(runner.start(jobId(), "agent", ARGS, job("b"))).rejects.toThrow("http intercept refused");
      box.failHttp = false;
      await runner.start(jobId(), "agent", ARGS, job("a")); // wants exactly what was registered before the failure
      expect(httpsAllows(box).at(-1)).toEqual(["a"]);
      expect(httpAllows(box).at(-1)).toEqual(["a"]);
    });
  });

  it("registers once, not once per start, when starts race for a widened list", async () => {
    await withRunner(async ({ runner, box }) => {
      await runner.start(jobId(), "agent", ARGS, job("a"));
      let release!: () => void;
      box.gate = new Promise<void>((r) => (release = r)); // holds the HTTPS registration open
      const b = runner.start(jobId(), "agent", ARGS, job("b"));
      const c = runner.start(jobId(), "agent", ARGS, job("c"));
      await tick();
      release();
      await Promise.all([b, c]);
      expect(httpsAllows(box)).toEqual([["a"], ["a", "b", "c"]]);
      expect(httpAllows(box)).toEqual([["a"], ["a", "b", "c"]]);
    });
  });

  it("fails only the job whose registration failed, and leaves the container and its other jobs alone", async () => {
    await withRunner(async ({ runner, box }) => {
      const first = jobId();
      const second = jobId();
      await runner.start(first, "agent", ARGS, job("a"));
      box.failIntercept = true;
      await expect(runner.start(second, "agent", ARGS, job("b"))).rejects.toThrow("intercept refused");
      expect(box.destroys).toBe(0);
      expect(box.running).toBe(true);
      expect((await runner.status(first)).state).toBe("running");
      expect(await runner.status(second)).toMatchObject({ state: "failed", exitCode: 127 });

      box.failIntercept = false;
      await runner.start(jobId(), "agent", ARGS, job("b")); // the failed registration is retried, not assumed
      expect(httpsAllows(box).at(-1)).toEqual(["a", "b"]);
    });
  });
});

// ------------------------------------------------------------------------------------ client

type StubCall = { slot: string; method: string; args: unknown[] };

type Impl = (...args: unknown[]) => unknown;

function fakeNamespace(overrides: Partial<Record<"start" | "status" | "log" | "cancel", Impl>> = {}) {
  const calls: StubCall[] = [];
  const defaults: Record<string, unknown> = { status: { state: "running" }, log: { text: "", next: 0 } };
  const stubFor = (slot: string) => {
    const call =
      (method: "start" | "status" | "log" | "cancel") =>
      async (...args: unknown[]) => {
        calls.push({ slot, method, args });
        return overrides[method] ? overrides[method](...args) : defaults[method];
      };
    return { start: call("start"), status: call("status"), log: call("log"), cancel: call("cancel") };
  };
  return {
    calls,
    ns: { idFromName: (name: string) => name, get: (name: string) => stubFor(name) },
  };
}

function clientEnv(ns: unknown, slots?: string): Env {
  return { RUNNER: ns, RYKE_RUNNER: "container", ...(slots === undefined ? {} : { RYKE_RUNNER_SLOTS: slots }) } as unknown as Env;
}

describe("ContainerRunner", () => {
  it("sends a job to one slot and returns an id that names it", async () => {
    const { ns, calls } = fakeNamespace();
    const runner = new ContainerRunner(clientEnv(ns, "4"));
    const id = await runner.start("land", { repo: "convert" }, { FOO: "bar" });
    const slot = slotOf(id);
    expect(slot).not.toBeNull();
    expect(slot).toBeLessThan(4);
    expect(calls).toEqual([{ slot: `slot-${slot}`, method: "start", args: [id, "land", { repo: "convert" }, { FOO: "bar" }] }]);
  });

  it.each([
    ["3", 3],
    [undefined, 6],
    ["", 6],
    ["abc", 6],
    ["0", 6],
    ["-2", 6],
    ["2.5", 6],
    ["1", 1],
    ["64", 64],
    ["1000", 64],
  ])("with RYKE_RUNNER_SLOTS=%j spreads over %i slots round-robin", async (config, slots) => {
    const { ns, calls } = fakeNamespace();
    const runner = new ContainerRunner(clientEnv(ns, config));
    const n = Math.min(slots * 2 + 1, 130);
    for (let i = 0; i < n; i++) await runner.start("verify", {}, {});
    const used = calls.map((c) => Number(c.slot.slice("slot-".length)));
    expect(new Set(used).size).toBe(Math.min(n, slots));
    expect(Math.max(...used)).toBeLessThan(slots);
    // Consecutive starts take consecutive slots, wrapping at the slot count.
    for (let i = 1; i < used.length; i++) expect(used[i]).toBe((used[i - 1]! + 1) % slots);
  });

  it("routes status, log and cancel to the slot in the job id, whatever the current slot count", async () => {
    const { ns, calls } = fakeNamespace({
      status: () => ({ state: "done", exitCode: 0, result: { sha: "abc" }, extra: "dropped" }) as never,
      log: () => ({ text: "hi", next: 2 }) as never,
    });
    const runner = new ContainerRunner(clientEnv(ns, "2"));
    expect(await runner.status("j_5_abcdef123456")).toEqual({ state: "done", exitCode: 0, result: { sha: "abc" } });
    expect(await runner.log("j_5_abcdef123456", 7)).toEqual({ text: "hi", next: 2 });
    await runner.cancel("j_5_abcdef123456");
    expect(calls).toEqual([
      { slot: "slot-5", method: "status", args: ["j_5_abcdef123456"] },
      { slot: "slot-5", method: "log", args: ["j_5_abcdef123456", 7] },
      { slot: "slot-5", method: "cancel", args: ["j_5_abcdef123456"] },
    ]);
  });

  it.each(["", "land", "j_x_abcdef", "j_1_ab", "j_1_abcdef/../x"])("rejects job id %j without calling a slot", async (id) => {
    const { ns, calls } = fakeNamespace();
    const runner = new ContainerRunner(clientEnv(ns));
    await expect(runner.status(id)).rejects.toThrow(RunnerError);
    await expect(runner.log(id, 0)).rejects.toThrow("invalid job id");
    await expect(runner.cancel(id)).rejects.toThrow("invalid job id");
    expect(calls).toEqual([]);
  });

  it("does not run swarm jobs, which exist only in process mode", async () => {
    const { ns, calls } = fakeNamespace();
    const runner = new ContainerRunner(clientEnv(ns));
    await expect(runner.start("swarm", {}, {})).rejects.toThrow("only in process mode");
    expect(calls).toEqual([]);
  });

  it("wraps a failing slot call in a RunnerError that names the call", async () => {
    const { ns } = fakeNamespace({
      start: () => {
        throw new Error("container image 'runner' missing");
      },
      status: () => {
        throw new Error('no such job "j_1_abcdef01"');
      },
      log: () => {
        throw new Error("boom log");
      },
      cancel: () => {
        throw new Error("boom cancel");
      },
    });
    const runner = new ContainerRunner(clientEnv(ns));
    const err = await runner.start("land", {}, {}).catch((e) => e);
    expect(err).toBeInstanceOf(RunnerError);
    expect(err.message).toBe("runner start failed: container image 'runner' missing");
    await expect(runner.status("j_1_abcdef01")).rejects.toThrow('runner status failed: no such job "j_1_abcdef01"');
    await expect(runner.log("j_1_abcdef01", 0)).rejects.toThrow("runner log failed: boom log");
    await expect(runner.cancel("j_1_abcdef01")).rejects.toThrow("runner cancel failed: boom cancel");
  });

  it("passes a RunnerError through unchanged", async () => {
    const original = new RunnerError("already a runner error");
    const { ns } = fakeNamespace({
      status: () => {
        throw original;
      },
    });
    await expect(new ContainerRunner(clientEnv(ns)).status("j_1_abcdef01")).rejects.toBe(original);
  });

  it("reaches a real Runner Durable Object's methods through the stub the namespace returns", async () => {
    // Wires ContainerRunner to the Runner on the fake container: the id the client makes must be
    // accepted by the DO, and what the DO answers must come back in the contract's shape.
    await withRunner(async ({ runner, box }) => {
      const ns = { idFromName: (n: string) => n, get: () => runner };
      const client = new ContainerRunner(clientEnv(ns, "1"));
      const id = await client.start("verify", { repo: "convert" }, JOB_ENV);
      expect(id).toMatch(/^j_0_[0-9a-z]{10}$/);
      expect(await client.status(id)).toEqual({ state: "running", exitCode: undefined, result: undefined });
      box.finishJob(id, 0, 'tests ok\n{"passed":12}\n', "");
      expect(await client.status(id)).toEqual({ state: "done", exitCode: 0, result: { passed: 12 } });
      expect(await client.log(id, 0)).toEqual({ text: 'tests ok\n{"passed":12}\n', next: 'tests ok\n{"passed":12}\n'.length });
      await client.cancel(id);
      expect(box.killed).toEqual([]); // already done: nothing to kill
      // The stub here is the DO itself, so its RunnerError arrives as is; over real RPC it would be wrapped.
      await expect(client.status("j_0_zzzzzzzz")).rejects.toThrow(new RunnerError('no such job "j_0_zzzzzzzz"'));
    });
  });
});

describe("runnerFor", () => {
  it("returns the container client in container mode", () => {
    const runner = runnerFor({ RYKE_RUNNER: "container", RYKE_RUNNER_URL: "" } as Env);
    expect(runner).toBeInstanceOf(ContainerRunner);
  });

  it.each(["process", "", "Container", "docker"])("returns the process client for RYKE_RUNNER=%j", (mode) => {
    expect(runnerFor({ RYKE_RUNNER: mode, RYKE_RUNNER_URL: "http://127.0.0.1:1" } as Env)).toBeInstanceOf(ProcessRunner);
  });
});

// ------------------------------------------------------------------------------------ gateway

describe("Outbound gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  // The token cache lives for the isolate; every test starts without it.
  beforeEach(() => gatewayTokens.clear());

  const KEY = "sk-ant-real-key";
  const gateway = (extra: Record<string, unknown> = { ANTHROPIC_API_KEY: KEY }, props?: { allow?: string[] }) => {
    const ctx = createExecutionContext();
    if (props) Object.defineProperty(ctx, "props", { value: props });
    return new Outbound(ctx, extra as unknown as Env);
  };

  // The lib setting of this repo predates Symbol.dispose; workerd has it, and `using` needs it.
  const dispose = (Symbol as unknown as { dispose: symbol }).dispose;

  // An ARTIFACTS binding that counts what the gateway asks of it.
  function fakeArtifacts(opts: { lifetimeMs?: number; missing?: string[]; failMint?: () => boolean } = {}) {
    const gets: string[] = [];
    const mints: { repo: string; scope: string; ttl: number }[] = [];
    let disposed = 0;
    let n = 0;
    const binding = {
      async get(name: string) {
        gets.push(name);
        if (opts.missing?.includes(name)) throw Object.assign(new Error("no such repo"), { code: "NOT_FOUND" });
        return {
          async createToken(scope: "read" | "write", ttl: number) {
            mints.push({ repo: name, scope, ttl });
            if (opts.failMint?.()) throw Object.assign(new Error("internal detail that must not leak"), { code: "INTERNAL_ERROR" });
            const expires = Date.now() + (opts.lifetimeMs ?? 3600_000);
            return { id: `tok${++n}`, plaintext: `art_v1_${name}_${scope}_${n}?expires=${Math.floor(expires / 1000)}`, scope, expiresAt: new Date(expires).toISOString() };
          },
          [dispose]() {
            disposed++;
          },
        };
      },
    };
    return { binding: binding as unknown as Artifacts, gets, mints, disposed: () => disposed };
  }

  function upstream(response: Response = new Response("upstream", { status: 200 })) {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response);
    const sent = () => {
      expect(spy).toHaveBeenCalledTimes(1);
      return spy.mock.calls[0]![0] as Request;
    };
    return { spy, sent, response };
  }

  describe("Artifacts hosts", () => {
    const HOST = "acct123.artifacts.cloudflare.net";
    const git = (path: string) => `https://${HOST}/git/ryke/${path}`;
    const gw = (a: ReturnType<typeof fakeArtifacts>, props?: { allow?: string[] }, extra: Record<string, unknown> = {}) =>
      gateway({ ARTIFACTS: a.binding, RYKE_NAMESPACE: "ryke", ANTHROPIC_API_KEY: KEY, ...extra }, props);
    const auth = (req: Request) => req.headers.get("authorization");

    it.each([
      ["GET", "convert.git/info/refs?service=git-upload-pack", "read"],
      ["GET", "convert.git/info/refs?service=git-receive-pack", "write"],
      ["POST", "convert.git/git-upload-pack", "read"],
      ["POST", "convert.git/git-receive-pack", "write"],
      ["GET", "convert.git/git-receive-pack", "read"],
      ["HEAD", "convert.git/info/refs", "read"],
      ["GET", "convert--t_1.git/HEAD", "read"],
    ] as const)("%s %s mints a %s token for the repo in the path", async (method, path, scope) => {
      const a = fakeArtifacts();
      const { sent, response } = upstream();
      const res = await gw(a).fetch(new Request(git(path), { method, body: method === "POST" ? "x" : undefined }));
      expect(res).toBe(response);
      const repo = path.slice(0, path.indexOf(".git"));
      expect(a.mints).toEqual([{ repo, scope, ttl: 3600 }]);
      expect(auth(sent())).toMatch(new RegExp(`^Bearer art_v1_${repo}_${scope}_1\\?expires=\\d+$`)); // the full token, `?expires=` included
    });

    it("releases the repo handle after minting", async () => {
      const a = fakeArtifacts();
      upstream();
      await gw(a).fetch(new Request(git("convert.git/info/refs")));
      expect(a.gets).toEqual(["convert"]);
      expect(a.disposed()).toBe(1);
    });

    it("drops the credentials the container sent and keeps the rest of the request", async () => {
      const a = fakeArtifacts();
      const { sent } = upstream();
      await gw(a).fetch(
        new Request(`https://x:container-chosen-token@${HOST}/git/ryke/convert.git/git-receive-pack?a=1`, {
          method: "POST",
          body: "0000PACK",
          headers: {
            authorization: "Basic eDpjb250YWluZXItY2hvc2VuLXRva2Vu",
            "content-type": "application/x-git-receive-pack-request",
            "user-agent": "git/2.47",
          },
        }),
      );
      const req = sent();
      expect(req.url).toBe(`https://${HOST}/git/ryke/convert.git/git-receive-pack?a=1`); // userinfo gone
      expect(auth(req)).toMatch(/^Bearer art_v1_convert_write_1\?expires=\d+$/);
      expect(JSON.stringify([...req.headers])).not.toContain("container-chosen-token");
      expect(JSON.stringify([...req.headers])).not.toContain("Basic");
      expect(req.method).toBe("POST");
      expect(new TextDecoder().decode(await req.arrayBuffer())).toBe("0000PACK");
      expect(req.headers.get("content-type")).toBe("application/x-git-receive-pack-request");
      expect(req.headers.get("user-agent")).toBe("git/2.47");
      expect(req.redirect).toBe("manual");
    });

    it("no longer reads a token out of URL userinfo", async () => {
      const a = fakeArtifacts();
      const { sent } = upstream();
      await gw(a).fetch(new Request(`https://x:art_v1_stolen@${HOST}/git/ryke/convert.git/info/refs`));
      expect(auth(sent())).not.toContain("stolen");
      expect(a.mints).toHaveLength(1);
    });

    it("sends a plain-HTTP request on over HTTPS, so the token never travels in the clear", async () => {
      const a = fakeArtifacts();
      const { sent } = upstream();
      await gw(a).fetch(new Request(`http://${HOST}/git/ryke/convert.git/info/refs?service=git-upload-pack`));
      expect(sent().url).toBe(`https://${HOST}/git/ryke/convert.git/info/refs?service=git-upload-pack`);
    });

    describe("token cache", () => {
      const get = (g: Outbound, path = "convert.git/info/refs?service=git-upload-pack") => g.fetch(new Request(git(path)));

      it("mints once per repo and scope and reuses the token", async () => {
        const a = fakeArtifacts();
        const { spy } = upstream();
        const g = gw(a);
        await get(g);
        await get(g);
        await get(gw(a)); // another request, another entrypoint instance: still the same isolate
        expect(a.mints).toHaveLength(1);
        expect(a.gets).toHaveLength(1);
        const sentAuth = spy.mock.calls.map((c) => auth(c[0] as Request));
        expect(new Set(sentAuth).size).toBe(1);
      });

      it("keeps a read token and a write token apart", async () => {
        const a = fakeArtifacts();
        const { spy } = upstream();
        const g = gw(a);
        await get(g, "convert.git/info/refs?service=git-upload-pack");
        await get(g, "convert.git/info/refs?service=git-receive-pack");
        await get(g, "convert.git/info/refs?service=git-upload-pack");
        await get(g, "convert.git/info/refs?service=git-receive-pack");
        expect(a.mints.map((m) => m.scope)).toEqual(["read", "write"]);
        const [r1, w1, r2, w2] = spy.mock.calls.map((c) => auth(c[0] as Request));
        expect(r1).toBe(r2);
        expect(w1).toBe(w2);
        expect(r1).not.toBe(w1);
      });

      it("keeps repos apart", async () => {
        const a = fakeArtifacts();
        upstream();
        const g = gw(a);
        await get(g, "convert.git/info/refs");
        await get(g, "convert--t_1.git/info/refs");
        await get(g, "convert--t_2.git/info/refs");
        expect(a.mints.map((m) => m.repo)).toEqual(["convert", "convert--t_1", "convert--t_2"]);
      });

      it.each([
        ["more than five minutes before it expires", 6 * 60_000, 1],
        ["less than five minutes before it expires", 4 * 60_000, 2],
        ["already expired", -1000, 2],
      ])("with a token that is %s mints %i time(s)", async (_name, lifetimeMs, mints) => {
        const a = fakeArtifacts({ lifetimeMs });
        upstream();
        const g = gw(a);
        await get(g);
        await get(g);
        expect(a.mints).toHaveLength(mints);
      });

      it("does not cache a failed mint", async () => {
        let fail = true;
        const a = fakeArtifacts({ failMint: () => fail });
        const { spy } = upstream();
        const g = gw(a);
        expect((await get(g)).status).toBe(502);
        expect(spy).not.toHaveBeenCalled();
        fail = false;
        expect((await get(g)).status).toBe(200);
        expect(a.mints).toHaveLength(2);
      });

      it("drops expired entries when it caches another", async () => {
        const a = fakeArtifacts({ lifetimeMs: 4 * 60_000 }); // inside the renewal window from the start
        upstream();
        const g = gw(a);
        await get(g, "one.git/info/refs");
        await get(g, "two.git/info/refs");
        await get(g, "one.git/info/refs");
        expect(a.mints.map((m) => m.repo)).toEqual(["one", "two", "one"]);
        expect(gatewayTokens.size).toBe(1); // each insert swept the expired entries before it
      });
    });

    describe("allow-list", () => {
      it("serves a repo that is on the list", async () => {
        const a = fakeArtifacts();
        const { sent } = upstream();
        const res = await gw(a, { allow: ["convert--t_1", "other"] }).fetch(new Request(git("convert--t_1.git/info/refs")));
        expect(res.status).toBe(200);
        expect(auth(sent())).toMatch(/^Bearer art_v1_convert--t_1_read/);
      });

      it.each([
        ["a repo that is not on the list", ["convert--t_1"], "convert.git/info/refs"],
        ["a repo whose name only starts like an allowed one", ["convert"], "convert--t_1.git/info/refs"],
        ["any repo when the list is empty", [], "convert.git/info/refs"],
      ])("answers 403 for %s, without contacting Artifacts or upstream", async (_name, allow, path) => {
        const a = fakeArtifacts();
        const { spy } = upstream();
        const res = await gw(a, { allow }).fetch(new Request(git(path)));
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toMatch(/not allowed for this container/);
        expect(a.gets).toEqual([]);
        expect(a.mints).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
      });

      it.each([
        ["no props at all", undefined],
        ["props without a list", {}],
      ])("serves any repo in the namespace with %s", async (_name, props) => {
        const a = fakeArtifacts();
        upstream();
        const res = await gw(a, props).fetch(new Request(git("anything-at-all.git/info/refs")));
        expect(res.status).toBe(200);
        expect(a.mints[0]?.repo).toBe("anything-at-all");
      });

      it("refuses a push as well as a fetch for a repo off the list", async () => {
        const a = fakeArtifacts();
        upstream();
        const res = await gw(a, { allow: ["mine"] }).fetch(new Request(git("trunk.git/git-receive-pack"), { method: "POST", body: "x" }));
        expect(res.status).toBe(403);
        expect(a.mints).toEqual([]);
      });
    });

    describe("what is not served", () => {
      it("refuses a namespace other than the gateway's", async () => {
        const a = fakeArtifacts();
        const { spy } = upstream();
        const res = await gw(a).fetch(new Request(`https://${HOST}/git/other/convert.git/info/refs`));
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe('namespace "other" is not served');
        expect(a.gets).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
      });

      it("does not check the namespace when none is configured", async () => {
        const a = fakeArtifacts();
        upstream();
        const res = await gw(a, undefined, { RYKE_NAMESPACE: "" }).fetch(new Request(`https://${HOST}/git/other/convert.git/info/refs`));
        expect(res.status).toBe(200);
      });

      it.each(["/", "/v1/repos", "/git/ryke", "/git/ryke/convert", "/git/ryke/convert/info/refs", "/git/ryke/../x.git/info/refs", "/git/ryke/.git/info/refs"])(
        "answers 403 for %s, which is not a git request",
        async (path) => {
          const a = fakeArtifacts();
          const { spy } = upstream();
          const res = await gw(a).fetch(new Request(`https://${HOST}${path}`));
          expect(res.status).toBe(403);
          expect(a.gets).toEqual([]);
          expect(spy).not.toHaveBeenCalled();
        },
      );
    });

    describe("failures", () => {
      it("answers 503 with a clear message when the gateway has no ARTIFACTS binding", async () => {
        const { spy } = upstream();
        const res = await gateway({ RYKE_NAMESPACE: "ryke" }).fetch(new Request(git("convert.git/info/refs")));
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "the ARTIFACTS binding is not configured on the gateway" });
        expect(spy).not.toHaveBeenCalled();
      });

      it("checks the allow-list before the binding, so a denied repo is 403 either way", async () => {
        upstream();
        const res = await gateway({ RYKE_NAMESPACE: "ryke" }, { allow: [] }).fetch(new Request(git("convert.git/info/refs")));
        expect(res.status).toBe(403);
      });

      it("answers 404 for a repo that does not exist, without forwarding", async () => {
        const a = fakeArtifacts({ missing: ["ghost"] });
        const { spy } = upstream();
        const res = await gw(a).fetch(new Request(git("ghost.git/info/refs")));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'repo "ghost" does not exist' });
        expect(a.mints).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
      });

      it("answers 502 when Artifacts cannot mint, without leaking its error", async () => {
        const a = fakeArtifacts({ failMint: () => true });
        const { spy } = upstream();
        const res = await gw(a).fetch(new Request(git("convert.git/info/refs")));
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'could not mint a token for "convert"' });
        expect(spy).not.toHaveBeenCalled();
      });
    });

    it.each([
      ["a host that merely ends the same way", "https://x:tok@evilartifacts.cloudflare.net/git/ryke/convert.git/info/refs"],
      ["a host that contains it as a prefix", "https://x:tok@acct.artifacts.cloudflare.net.evil.test/git/ryke/convert.git/info/refs"],
      ["the bare parent domain", "https://x:tok@cloudflare.net/git/ryke/convert.git/info/refs"],
      ["an unrelated host", "https://example.com/git/ryke/convert.git/info/refs"],
      ["a bare artifacts domain without an account label", "https://artifacts.cloudflare.net/git/ryke/convert.git/info/refs"],
    ])("gets no token and no check for %s", async (_name, url) => {
      const a = fakeArtifacts();
      const { sent } = upstream();
      const request = new Request(url);
      await gw(a, { allow: [] }).fetch(request);
      expect(sent()).toBe(request);
      expect(a.gets).toEqual([]);
    });
  });

  describe("api.anthropic.com", () => {
    const URL_ = "https://api.anthropic.com/v1/messages?beta=true";

    it("swaps the placeholder key for the gateway's own", async () => {
      const { sent, response } = upstream();
      const res = await gateway().fetch(
        new Request(URL_, {
          method: "POST",
          body: '{"model":"m"}',
          headers: { "x-api-key": "placeholder", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        }),
      );
      expect(res).toBe(response);
      const req = sent();
      expect(req.url).toBe(URL_);
      expect(req.method).toBe("POST");
      expect(req.headers.get("x-api-key")).toBe(KEY);
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(req.headers.get("content-type")).toBe("application/json");
      expect(await req.text()).toBe('{"model":"m"}');
      expect(req.redirect).toBe("manual");
    });

    it("adds the key when the container sent none", async () => {
      const { sent } = upstream();
      await gateway().fetch(new Request(URL_));
      expect(sent().headers.get("x-api-key")).toBe(KEY);
    });

    it.each([
      ["unset", {}],
      ["empty", { ANTHROPIC_API_KEY: "" }],
    ])("answers 503 and sends nothing when the key is %s", async (_name, e) => {
      const { spy } = upstream();
      const res = await gateway(e).fetch(new Request(URL_, { headers: { "x-api-key": "placeholder" } }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "ANTHROPIC_API_KEY is not configured on the gateway" });
      expect(spy).not.toHaveBeenCalled();
    });

    it.each([
      "https://api.anthropic.com.evil.test/v1/messages",
      "https://eu.api.anthropic.com/v1/messages",
      "https://anthropic.com/v1/messages",
    ])("does not inject the key for %s", async (url) => {
      const { sent } = upstream();
      const request = new Request(url, { headers: { "x-api-key": "placeholder" } });
      await gateway().fetch(request);
      expect(sent()).toBe(request);
      expect(sent().headers.get("x-api-key")).toBe("placeholder");
    });
  });

  describe("everything else", () => {
    it.each([
      "https://registry.npmjs.org/left-pad",
      "http://example.com/plain",
      "https://github.com/cloudflare/workers-sdk.git/info/refs?service=git-upload-pack",
    ])("passes %s through unchanged", async (url) => {
      const { sent, response } = upstream();
      const request = new Request(url, { headers: { authorization: "Bearer keep", "x-api-key": "keep" } });
      expect(await gateway().fetch(request)).toBe(response);
      expect(sent()).toBe(request);
    });

    it("hands the upstream error back as it came", async () => {
      const failing = new Response("nope", { status: 502 });
      upstream(failing);
      expect(await gateway().fetch(new Request("https://example.com/"))).toBe(failing);
    });
  });
});
