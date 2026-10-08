// Bring your own subscription or API key, for Claude Code and Codex: which credentials an agent job's
// CLI runs on (containers/runner/lib/agent.mjs), how the harness checks them before a transaction begins
// (harness/agents/claude.mjs), and how Codex's `exec --json` stream is read: its outcome, its log lines,
// and the reads Ryke takes from it in place of hooks.
import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import {
  agentEnv,
  codexArgs,
  codexOutcome,
  CODEX_PLACEHOLDER_KEY,
  codexReads,
  credentialsFor,
  describeCodexEvent,
  inCheckout,
  inputsFrom,
  isCredential,
  keyOf,
  PLACEHOLDER_KEY,
  resolveAuth,
} from "../../containers/runner/lib/agent.mjs";
import { checkAccess, isLoopback, loginOf, STUB_BINS, validateOpenAIKey } from "../../harness/agents/claude.mjs";
import { authStatus } from "../../harness/agents/claude-stub/claude.mjs";
import { loginStatus, parseExecArgv } from "../../harness/agents/codex-stub/codex.mjs";

const ARGS = { repo: "convert", txn: "t_1", agent: "agent-01", intent: "Do it", remote: "/r.git", snapshot: "abc" };

describe("inputsFrom: the CLI and its auth", () => {
  const cases = [
    ["claude by default, on whatever credentials auto finds", {}, {}, { cli: "claude", auth: "auto", bin: "claude", model: "claude-sonnet-5-5" }],
    ["codex with its own default model and binary", { cli: "codex" }, {}, { cli: "codex", auth: "auto", bin: "codex", model: "" }],
    ["codex with a model and a binary of the runner's", { cli: "codex", model: "codex-model-x" }, { CODEX_BIN: "/opt/codex" }, { cli: "codex", auth: "auto", bin: "/opt/codex", model: "codex-model-x" }],
    ["claude's binary is not codex's", { cli: "codex" }, { CLAUDE_BIN: "/opt/claude" }, { cli: "codex", auth: "auto", bin: "codex", model: "" }],
    ["a subscription asked for", { auth: "subscription" }, {}, { cli: "claude", auth: "subscription", bin: "claude", model: "claude-sonnet-5-5" }],
    ["a key asked for", { cli: "codex", auth: "api-key" }, {}, { cli: "codex", auth: "api-key", bin: "codex", model: "" }],
  ];
  for (const [name, args, env, want] of cases) {
    it(name, () => {
      const inp = inputsFrom({ ...ARGS, ...args }, env);
      assert.deepEqual({ cli: inp.cli, auth: inp.auth, bin: inp.bin, model: inp.model }, want);
    });
  }

  for (const [args, message] of [
    [{ cli: "gemini" }, /--cli must be claude or codex, got gemini/],
    [{ auth: "oauth" }, /--auth must be subscription or api-key or auto, got oauth/],
  ]) {
    it(`refuses ${JSON.stringify(args)}`, () => assert.throws(() => inputsFrom({ ...ARGS, ...args }, {}), message));
  }

  it("reads the stub flag of either CLI from RYKE_AGENT_STUB", () => {
    assert.equal(inputsFrom(ARGS, { RYKE_AGENT_STUB: "1" }).stub, true);
    assert.equal(inputsFrom({ ...ARGS, cli: "codex" }, { RYKE_AGENT_STUB: "1" }).stub, true);
    assert.equal(inputsFrom(ARGS, { RYKE_CLAUDE_STUB: "1" }).stub, false);
  });
});

describe("keyOf and resolveAuth", () => {
  it("takes Codex's key from CODEX_API_KEY first, then OPENAI_API_KEY; Claude's only from ANTHROPIC_API_KEY", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-openai", CODEX_API_KEY: "sk-codex" };
    assert.equal(keyOf("claude", env), "sk-ant");
    assert.equal(keyOf("codex", env), "sk-codex");
    assert.equal(keyOf("codex", { OPENAI_API_KEY: "sk-openai" }), "sk-openai");
    assert.equal(keyOf("claude", { OPENAI_API_KEY: "sk-openai" }), "");
    assert.equal(keyOf("codex", { ANTHROPIC_API_KEY: "sk-ant" }), "");
  });

  // [cli, auth, env, container, the mode or the error]
  const CASES = [
    ["claude", "auto", { ANTHROPIC_API_KEY: "k" }, false, "api-key"],
    ["claude", "auto", {}, false, "subscription"],
    ["claude", "auto", {}, true, "api-key"],
    ["claude", "auto", { OPENAI_API_KEY: "k" }, false, "subscription"],
    ["codex", "auto", { OPENAI_API_KEY: "k" }, false, "api-key"],
    ["codex", "auto", { ANTHROPIC_API_KEY: "k" }, false, "subscription"],
    ["claude", "subscription", { ANTHROPIC_API_KEY: "k" }, false, "subscription"],
    ["codex", "subscription", {}, false, "subscription"],
    ["claude", "subscription", {}, true, /--auth subscription runs claude on your own login and only on your own machine/],
    ["codex", "subscription", { CODEX_API_KEY: "k" }, true, /--auth subscription runs codex on your own login/],
    ["claude", "api-key", {}, false, /--auth api-key needs ANTHROPIC_API_KEY in the environment/],
    ["codex", "api-key", { ANTHROPIC_API_KEY: "k" }, false, /--auth api-key needs CODEX_API_KEY or OPENAI_API_KEY/],
    ["codex", "api-key", {}, true, "api-key"],
    ["claude", "api-key", { ANTHROPIC_API_KEY: "k" }, false, "api-key"],
  ];
  for (const [cli, auth, env, container, want] of CASES) {
    it(`${cli} ${auth} ${JSON.stringify(Object.keys(env))}${container ? " in a container" : ""} -> ${want}`, () => {
      if (typeof want === "string") assert.equal(resolveAuth(cli, auth, env, container), want);
      else assert.throws(() => resolveAuth(cli, auth, env, container), want);
    });
  }
});

describe("isCredential", () => {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) {
    it(`${name} is one`, () => assert.equal(isCredential(name), true));
  }
  for (const name of ["PATH", "HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "RYKE_TOKEN", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
    it(`${name} is not`, () => assert.equal(isCredential(name), false));
  }
});

describe("credentialsFor: only the run's own credentials go back in", () => {
  const ALL = { ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "http://proxy", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01", OPENAI_API_KEY: "sk-openai", CODEX_ACCESS_TOKEN: "pat" };
  const CASES = [
    ["claude on a key keeps its base URL", "claude", "api-key", ALL, false, { ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "http://proxy" }],
    ["claude on a subscription keeps only the setup-token, never a key or a base URL", "claude", "subscription", ALL, false, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01" }],
    ["claude on a subscription without a setup-token gets nothing: the CLI uses its stored login", "claude", "subscription", { ANTHROPIC_API_KEY: "sk-ant" }, false, {}],
    ["codex on a key gets it under its own name", "codex", "api-key", ALL, false, { CODEX_API_KEY: "sk-openai" }],
    ["codex on a subscription gets nothing, not even its access token", "codex", "subscription", ALL, false, {}],
    ["claude in a container gets the placeholder the gateway swaps", "claude", "api-key", {}, true, { ANTHROPIC_API_KEY: PLACEHOLDER_KEY }],
    ["codex in a container gets its placeholder", "codex", "api-key", {}, true, { CODEX_API_KEY: CODEX_PLACEHOLDER_KEY }],
  ];
  for (const [name, cli, mode, base, container, want] of CASES) it(name, () => assert.deepEqual(credentialsFor(cli, mode, base, container), want));
});

describe("agentEnv for both CLIs", () => {
  const inp = { apiUrl: "http://api", token: "tok", txn: "t_1", repo: "convert", snapshot: "abc", contention: true };
  const SHELL = {
    PATH: "/bin",
    HOME: "/home/felix",
    CLAUDE_CONFIG_DIR: "/home/felix/.claude",
    CODEX_HOME: "/home/felix/.codex",
    ANTHROPIC_API_KEY: "sk-ant",
    ANTHROPIC_BASE_URL: "http://proxy",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01",
    OPENAI_API_KEY: "sk-openai",
    CODEX_ACCESS_TOKEN: "pat",
    RYKE_FORK_TOKEN: "fork",
  };
  const names = (env) => Object.keys(env).sort();

  it("a Claude subscription run sees no key and no base URL, and keeps its login dir and setup-token", () => {
    const env = agentEnv({ ...inp, auth: "subscription" }, "/w", { base: SHELL, container: false });
    assert.deepEqual(names(env).filter((k) => !k.startsWith("RYKE_")), ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "IS_SANDBOX", "PATH"]);
  });

  it("a Codex key run sees its key as CODEX_API_KEY, its login dir, and nothing of Claude's or Ryke's", () => {
    const env = agentEnv({ ...inp, cli: "codex", auth: "api-key" }, "/w", { base: SHELL, container: false });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/home/felix", CODEX_HOME: "/home/felix/.codex", CODEX_API_KEY: "sk-openai" });
  });

  it("a Codex subscription run sees no credential at all: codex uses its own login under CODEX_HOME", () => {
    const env = agentEnv({ ...inp, cli: "codex", auth: "subscription" }, "/w", { base: SHELL, container: false });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/home/felix", CODEX_HOME: "/home/felix/.codex" });
  });

  it("Codex runs no hooks, so it gets no Ryke token, but keeps the stub's knobs and the proxy", () => {
    const env = agentEnv({ ...inp, cli: "codex", auth: "subscription" }, "/w", { base: { HTTPS_PROXY: "http://p", RYKE_STUB_LOGIN: "chatgpt", RYKE_CATALOGUE_DIR: "/cat", RYKE_TOKEN: "admin" }, container: false });
    assert.deepEqual(env, { HTTPS_PROXY: "http://p", RYKE_STUB_LOGIN: "chatgpt", RYKE_CATALOGUE_DIR: "/cat" });
  });

  it("refuses a subscription inside a container", () => {
    assert.throws(() => agentEnv({ ...inp, auth: "subscription" }, "/w", { base: {}, container: true }), /only on your own machine/);
    assert.throws(() => agentEnv({ ...inp, cli: "codex", auth: "subscription" }, "/w", { base: {}, container: true }), /only on your own machine/);
  });
});

describe("codexArgs", () => {
  it("runs exec with the JSON stream, without the user's config, rules or saved session, in the checkout, the prompt last", () => {
    assert.deepEqual(codexArgs("", "P", "/w"), ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--cd", "/w", "--", "P"]);
    assert.deepEqual(codexArgs("codex-model-x", "P", "/w").slice(-4), ["--model", "codex-model-x", "--", "P"]);
  });

  it("is exactly what the fake codex accepts", () => {
    assert.deepEqual(parseExecArgv(codexArgs("m", "the prompt", "/w")), { cd: "/w", model: "m", prompt: "the prompt" });
    assert.deepEqual(parseExecArgv(codexArgs("", "--looks-like-a-flag", "/w")), { cd: "/w", model: null, prompt: "--looks-like-a-flag" });
    assert.throws(() => parseExecArgv(["exec", "--json", "--cd", "/w", "--", "P"]), /missing --ephemeral/);
  });
});

describe("codexOutcome", () => {
  const msg = (text) => ({ type: "item.completed", item: { id: "item_3", type: "agent_message", text } });
  const CASES = [
    ["a completed turn, with the last message as its text", [{ type: "turn.started" }, msg("first"), msg("Done; tests pass."), { type: "turn.completed", usage: {} }], 0, false, { isError: false, text: "Done; tests pass." }],
    ["reconnects are not the end of the turn", [{ type: "error", message: "Reconnecting... 2/5" }, msg("ok"), { type: "turn.completed" }], 0, false, { isError: false, text: "ok" }],
    ["a failed turn says why", [msg("trying"), { type: "turn.failed", error: { message: "usage limit reached" } }], 1, false, { isError: true, text: "usage limit reached" }],
    ["a failed turn without a message", [{ type: "turn.failed" }], 1, false, { isError: true, text: "turn failed" }],
    ["the last turn decides", [{ type: "turn.failed", error: { message: "x" } }, msg("again"), { type: "turn.completed" }], 0, false, { isError: false, text: "again" }],
    ["no end of turn: the last error is the reason", [{ type: "thread.started" }, { type: "error", message: "Not logged in" }], 1, false, { isError: true, text: "codex: Not logged in" }],
    ["no end of turn and no error", [{ type: "thread.started" }], 137, false, { isError: true, text: "codex exited with code 137 without finishing its turn" }],
    ["a timeout wins over a completed turn", [{ type: "turn.completed" }], null, true, { isError: true, text: "codex timed out" }],
    ["nothing at all", [], 1, false, { isError: true, text: "codex exited with code 1 without finishing its turn" }],
  ];
  for (const [name, lines, code, timedOut, want] of CASES) {
    it(name, () => {
      const got = codexOutcome(lines, code, timedOut);
      assert.deepEqual({ isError: got.isError, text: got.text }, want);
    });
  }
});

describe("describeCodexEvent", () => {
  const done = (item) => ({ type: "item.completed", item: { id: "i", ...item } });
  const CASES = [
    ["a patch, by default", done({ type: "file_change", changes: [{ path: "/w/c/src/a.ts", kind: "update" }, { path: "/w/c/test/a.test.ts", kind: "add" }], status: "completed" }), false, "codex: patch update src/a.ts, add test/a.test.ts"],
    ["a patch that did not apply", done({ type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "failed" }), false, "codex: patch update src/a.ts (failed)"],
    ["a command only when verbose", done({ type: "command_execution", command: "/bin/bash -lc 'cat /w/c/src/a.ts'", exit_code: 0 }), false, null],
    ["a command, verbose", done({ type: "command_execution", command: "/bin/bash -lc 'cat /w/c/src/a.ts'", exit_code: 0 }), true, "codex: $ /bin/bash -lc 'cat src/a.ts' (exit 0)"],
    ["a message, verbose", done({ type: "agent_message", text: "Looking\n  at it" }), true, "codex: Looking at it"],
    ["a message, quiet", done({ type: "agent_message", text: "Looking" }), false, null],
    ["the end of the turn", { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }, false, "codex: turn completed (10 in, 3 out)"],
    ["a failed turn", { type: "turn.failed", error: { message: "quota" } }, false, "codex: turn failed: quota"],
    ["an error line", { type: "error", message: "Reconnecting... 1/5" }, false, "codex: error: Reconnecting... 1/5"],
    ["a started item", { type: "item.started", item: { type: "command_execution", command: "ls" } }, true, null],
    ["nothing", undefined, true, null],
  ];
  for (const [name, ev, verbose, want] of CASES) it(name, () => assert.equal(describeCodexEvent(ev, { cwd: "/w/c", verbose }), want));
});

describe("inCheckout", () => {
  const CASES = [
    ["/w/c/src/a.ts", "src/a.ts"],
    ["src/a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["src/../src/a.ts", "src/a.ts"],
    ["/w/cx/src/a.ts", null],
    ["/etc/passwd", null],
    ["../outside.ts", null],
    ["..", null],
    [".", null],
    ["", null],
    [undefined, null],
  ];
  for (const [raw, want] of CASES) it(`${JSON.stringify(raw)} -> ${JSON.stringify(want)}`, () => assert.equal(inCheckout(raw, "/w/c"), want));
});

describe("codexReads: what Codex looked at, from its commands and their output", () => {
  const tracked = new Set(["src/a.ts", "src/b.ts", "src/units/length.ts", "README.md", "test/a.test.ts"]);
  const cmd = (command, aggregated_output = "") => ({ type: "item.completed", item: { id: "i", type: "command_execution", command, aggregated_output, exit_code: 0, status: "completed" } });
  const patch = (changes) => ({ type: "item.completed", item: { id: "i", type: "file_change", changes, status: "completed" } });
  const CASES = [
    ["cat names the file", cmd("/bin/bash -lc 'cat src/a.ts'", "export const a = 1;\n"), ["src/a.ts"]],
    ["sed -n and an absolute path", cmd(`/bin/bash -lc "sed -n '1,80p' /w/c/src/b.ts"`), ["src/b.ts"]],
    ["several files and a pipe", cmd("bash -lc 'nl -ba src/a.ts | head; wc -l ./README.md'"), ["src/a.ts", "README.md"]],
    ["rg prints path:line:text", cmd("bash -lc 'rg -n formatValue src'", "src/a.ts:3:import { formatValue }\nsrc/units/length.ts:12:  formatValue(x)\n"), ["src/a.ts", "src/units/length.ts"]],
    ["rg --files lists names, which count like a Glob's", cmd("bash -lc 'rg --files src/units'", "src/units/length.ts\n"), ["src/units/length.ts"]],
    ["find prints ./paths", cmd("bash -lc 'find . -name \"*.test.ts\"'", "./test/a.test.ts\n"), ["test/a.test.ts"]],
    ["a directory is not a read of what is in it", cmd("bash -lc 'ls src'", "a.ts\nb.ts\nunits\n"), []],
    ["a file the snapshot does not have is not a read", cmd("bash -lc 'cat src/new.ts'"), []],
    ["outside the checkout is not a read", cmd("bash -lc 'cat /etc/hosts ../x/src/a.ts'"), []],
    ["code that mentions a path in passing is not a read", cmd("bash -lc 'cat README.md'", "See src/b.ts: it formats.\nimport x from './src/a.ts'\n"), ["README.md"]],
    ["a patched file counts, a created or tracked-but-deleted one only if it was there", patch([{ path: "/w/c/src/a.ts", kind: "update" }, { path: "/w/c/src/new.ts", kind: "add" }, { path: "src/b.ts", kind: "delete" }]), ["src/a.ts", "src/b.ts"]],
    ["a started command is not read yet", { type: "item.started", item: { type: "command_execution", command: "cat src/a.ts" } }, []],
    ["messages are not reads", { type: "item.completed", item: { type: "agent_message", text: "I read src/a.ts" } }, []],
    ["the same file twice is one read", cmd("bash -lc 'cat src/a.ts src/a.ts'", "src/a.ts:1:x\n"), ["src/a.ts"]],
  ];
  for (const [name, ev, want] of CASES) it(name, () => assert.deepEqual(codexReads(ev, { dir: "/w/c", tracked }), want));
});

describe("the stubs' own status commands", () => {
  const CLAUDE = [
    [{}, 0, { loggedIn: true, authMethod: "claude.ai" }],
    [{ RYKE_STUB_LOGIN: "none" }, 1, { loggedIn: false, authMethod: "none" }],
    [{ CLAUDE_CODE_OAUTH_TOKEN: "t" }, 0, { loggedIn: true, authMethod: "oauth_token" }],
    [{ ANTHROPIC_API_KEY: "k", RYKE_STUB_LOGIN: "none" }, 0, { loggedIn: true, authMethod: "api_key" }],
  ];
  for (const [env, code, want] of CLAUDE) {
    it(`claude auth status with ${JSON.stringify(env)}`, () => {
      const r = authStatus(env);
      assert.equal(r.code, code);
      const s = JSON.parse(r.stdout);
      assert.deepEqual({ loggedIn: s.loggedIn, authMethod: s.authMethod }, want);
    });
  }
  const CODEX = [
    [{}, 0, "Logged in using ChatGPT\n"],
    [{ RYKE_STUB_LOGIN: "api-key" }, 0, "Logged in using an API key - sk-proj-***stub\n"],
    [{ RYKE_STUB_LOGIN: "none" }, 1, "Not logged in\n"],
    [{ RYKE_STUB_LOGIN: "none", CODEX_API_KEY: "k" }, 1, "Not logged in\n"],
  ];
  for (const [env, code, stderr] of CODEX) {
    it(`codex login status with ${JSON.stringify(env)}`, () => assert.deepEqual(loginStatus(env), { code, stderr }));
  }
});

describe("loginOf: the verdict of `claude auth status` and `codex login status`", () => {
  const json = (o) => JSON.stringify(o, null, 2);
  const CASES = [
    ["claude.ai is a subscription", "claude", { code: 0, stdout: json({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) }, { loggedIn: true, method: "subscription", detail: "claude.ai" }],
    ["a setup-token is a subscription", "claude", { code: 0, stdout: json({ loggedIn: true, authMethod: "oauth_token" }) }, { loggedIn: true, method: "subscription", detail: "oauth_token" }],
    ["a Console login is a key", "claude", { code: 0, stdout: json({ loggedIn: true, authMethod: "api_key", apiKeySource: "/login managed key" }) }, { loggedIn: true, method: "api-key", detail: "api_key" }],
    ["an apiKeyHelper is a key", "claude", { code: 0, stdout: json({ loggedIn: true, authMethod: "api_key_helper" }) }, { loggedIn: true, method: "api-key", detail: "api_key_helper" }],
    ["logged out", "claude", { code: 1, stdout: json({ loggedIn: false, authMethod: "none" }) }, { loggedIn: false, method: "none", detail: "none" }],
    ["a provider Ryke does not know is not mistaken for a subscription", "claude", { code: 0, stdout: json({ loggedIn: true, authMethod: "third_party" }) }, { loggedIn: true, method: "unknown", detail: "third_party" }],
    ["text instead of JSON: the exit code decides", "claude", { code: 0, stdout: "Logged in as felix" }, { loggedIn: true, method: "unknown", detail: "Logged in as felix" }],
    ["text and a failure", "claude", { code: 1, stdout: "", stderr: "error: unknown command" }, { loggedIn: false, method: "none", detail: "error: unknown command" }],
    ["ChatGPT is a subscription", "codex", { code: 0, stderr: "Logged in using ChatGPT\n" }, { loggedIn: true, method: "subscription", detail: "ChatGPT" }],
    ["a stored key", "codex", { code: 0, stderr: "Logged in using an API key - sk-proj-***abcd\n" }, { loggedIn: true, method: "api-key", detail: "API key" }],
    ["logged out", "codex", { code: 1, stderr: "Not logged in\n" }, { loggedIn: false, method: "none", detail: "Not logged in" }],
    ["something else", "codex", { code: 0, stderr: "Logged in using a personal access token\n" }, { loggedIn: true, method: "unknown", detail: "Logged in using a personal access token" }],
  ];
  for (const [name, cli, run, want] of CASES) it(`${cli}: ${name}`, () => assert.deepEqual(loginOf(cli, run), want));
});

describe("isLoopback", () => {
  for (const [url, want] of [
    ["http://127.0.0.1:8789", true],
    ["http://localhost:8789", true],
    ["http://[::1]:8789", true],
    ["http://10.0.0.5:8789", false],
    ["https://runner.example.com", false],
    ["http://127.0.0.1.example.com", false],
  ]) {
    it(`${url} -> ${want}`, () => assert.equal(isLoopback(url), want));
  }
});

// A local stand-in for api.openai.com that answers GET /v1/models with the given status.
async function models(status) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(status, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

describe("validateOpenAIKey", () => {
  it("accepts a key the API takes, asking once per process", async () => {
    const api = await models(200);
    try {
      await validateOpenAIKey("sk-good", api.url);
      await validateOpenAIKey("sk-good", api.url);
      assert.deepEqual(api.seen, [{ url: "/v1/models", auth: "Bearer sk-good" }]);
    } finally {
      await api.close();
    }
  });

  for (const status of [401, 403]) {
    it(`refuses a key answered with ${status}, and remembers it`, async () => {
      const api = await models(status);
      try {
        await assert.rejects(validateOpenAIKey(`sk-bad-${status}`, api.url), new RegExp(`CODEX_API_KEY or OPENAI_API_KEY was rejected by ${api.url} \\(HTTP ${status}\\)`));
        await assert.rejects(validateOpenAIKey(`sk-bad-${status}`, api.url), /was rejected/);
        assert.equal(api.seen.length, 1);
      } finally {
        await api.close();
      }
    });
  }

  it("does not call an unreachable API a rejection", async () => {
    const api = await models(200);
    await api.close();
    await validateOpenAIKey("sk-unreachable", api.url);
  });
});

describe("checkAccess: decided before a transaction begins", () => {
  const RUNNER = "http://127.0.0.1:8789";
  const base = (over) => ({ cli: "claude", auth: "auto", stub: true, bin: STUB_BINS.claude, runnerUrl: RUNNER, ...over });

  it("auto takes the key that is set and hands it to the job", async () => {
    const access = await checkAccess(base({ env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-ant" } }));
    assert.deepEqual(access, { mode: "api-key", how: "an API key", env: { ANTHROPIC_API_KEY: "sk-ant" } });
  });

  it("auto without a key runs the CLI's own login and hands the job no credential", async () => {
    const access = await checkAccess(base({ env: { PATH: process.env.PATH, HOME: "/h-auto" } }));
    assert.deepEqual(access, { mode: "subscription", how: "your own login (claude.ai)", env: {} });
  });

  it("a subscription ignores a key in the shell, both for the check and for the job", async () => {
    const access = await checkAccess(base({ auth: "subscription", env: { PATH: process.env.PATH, HOME: "/h-sub", ANTHROPIC_API_KEY: "sk-ant" } }));
    assert.deepEqual(access, { mode: "subscription", how: "your own login (claude.ai)", env: {} }, "the stub would report api_key had the key reached it");
  });

  it("a setup-token reaches the check and the job", async () => {
    const access = await checkAccess(base({ auth: "subscription", env: { PATH: process.env.PATH, HOME: "/h-oat", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" } }));
    assert.deepEqual(access, { mode: "subscription", how: "your own login (oauth_token)", env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" } });
  });

  it("Codex on ChatGPT", async () => {
    const access = await checkAccess(base({ cli: "codex", bin: STUB_BINS.codex, env: { PATH: process.env.PATH, HOME: "/h-codex" } }));
    assert.deepEqual(access, { mode: "subscription", how: "your own login (ChatGPT)", env: {} });
  });

  it("Codex on OPENAI_API_KEY, passed on as CODEX_API_KEY", async () => {
    const access = await checkAccess(base({ cli: "codex", bin: STUB_BINS.codex, env: { PATH: process.env.PATH, OPENAI_API_KEY: "sk-openai" } }));
    assert.deepEqual(access, { mode: "api-key", how: "an API key", env: { CODEX_API_KEY: "sk-openai" } });
  });

  const REFUSED = [
    ["a key asked for and none set", base({ auth: "api-key", env: { PATH: process.env.PATH } }), /--auth api-key needs ANTHROPIC_API_KEY/],
    ["a subscription on a runner elsewhere", base({ auth: "subscription", runnerUrl: "http://10.0.0.5:8789", env: { PATH: process.env.PATH } }), /the runner must be on this machine; http:\/\/10\.0\.0\.5:8789 is not/],
    ["a CLI that is not logged in", base({ env: { PATH: process.env.PATH, HOME: "/h-none", RYKE_STUB_LOGIN: "none" } }), /claude is not logged in on this machine.*\/login with your Claude Pro or Max account/],
    ["codex not logged in", base({ cli: "codex", bin: STUB_BINS.codex, env: { PATH: process.env.PATH, HOME: "/h-none", RYKE_STUB_LOGIN: "none" } }), /codex is not logged in on this machine \(Not logged in\); run `codex login` with your ChatGPT account/],
    ["a subscription asked for, an API-key login found", base({ auth: "subscription", env: { PATH: process.env.PATH, HOME: "/h-key", RYKE_STUB_LOGIN: "api_key" } }), /claude is logged in with an API key \(api_key\), not a subscription/],
    ["codex's stored key is no subscription either", base({ cli: "codex", bin: STUB_BINS.codex, auth: "subscription", env: { PATH: process.env.PATH, HOME: "/h-key", RYKE_STUB_LOGIN: "api-key" } }), /codex is logged in with an API key/],
    ["a CLI that is not installed", base({ bin: "/nonexistent/claude", stub: false, env: { PATH: process.env.PATH, HOME: "/h-missing" } }), /\/nonexistent\/claude could not be run/],
  ];
  for (const [name, args, message] of REFUSED) {
    it(`refuses ${name}`, async () => {
      await assert.rejects(checkAccess(args), (e) => e.name === "AccessError" && message.test(e.message));
    });
  }

  it("auto accepts whatever login the CLI has, a stored key included", async () => {
    const access = await checkAccess(base({ env: { PATH: process.env.PATH, HOME: "/h-auto-key", RYKE_STUB_LOGIN: "api_key" } }));
    assert.equal(access.mode, "subscription");
    assert.equal(access.how, "your own login (api_key)");
  });
});
