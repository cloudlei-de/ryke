// runToCompletion polls a runner job to its end (src/worker/runner/runner.ts). Land steps, reverts and
// repo seeding all wait through it, so its three ways out are pinned here: the job's own end, the
// timeout (exit 124, with or without cancelling the job) and a runner that breaks.
import { describe, expect, it } from "vitest";
import { RunnerError, runToCompletion, type JobStatus, type Runner } from "../src/worker/runner/runner";

// A runner that reports `script` one status per poll and then repeats the last one.
function scripted(script: JobStatus[], opts: { startError?: Error; statusError?: Error; cancelError?: Error } = {}) {
  const calls = { start: [] as unknown[][], status: 0, cancel: [] as string[] };
  const runner: Runner = {
    async start(...args) {
      calls.start.push(args);
      if (opts.startError) throw opts.startError;
      return "j_1";
    },
    async status() {
      if (opts.statusError) throw opts.statusError;
      return script[Math.min(calls.status++, script.length - 1)]!;
    },
    async log() {
      return { text: "", next: 0 };
    },
    async cancel(id) {
      calls.cancel.push(id);
      if (opts.cancelError) throw opts.cancelError;
    },
  };
  return { runner, calls };
}

const FAST = { pollMs: 2 };

describe("runToCompletion", () => {
  it("starts the job with its arguments and returns the status it ended in, with the job id", async () => {
    const { runner, calls } = scripted([{ state: "queued" }, { state: "running" }, { state: "done", exitCode: 0, result: { sha: "abc" } }]);
    const job = await runToCompletion(runner, "seed", { remote: "r" }, { A: "1" }, 5_000, FAST);
    expect(job).toEqual({ state: "done", exitCode: 0, result: { sha: "abc" }, id: "j_1" });
    expect(calls.start).toEqual([["seed", { remote: "r" }, { A: "1" }]]);
    expect(calls.status).toBe(3);
    expect(calls.cancel).toEqual([]);
  });

  it("returns a failed job as it is, not as a timeout", async () => {
    const { runner, calls } = scripted([{ state: "running" }, { state: "failed", exitCode: 3, result: { error: "boom" } }]);
    expect(await runToCompletion(runner, "land", {}, {}, 5_000, FAST)).toEqual({ state: "failed", exitCode: 3, result: { error: "boom" }, id: "j_1" });
    expect(calls.cancel).toEqual([]);
  });

  it("does not poll again once a job has ended", async () => {
    const { runner, calls } = scripted([{ state: "done", exitCode: 0 }]);
    await runToCompletion(runner, "verify", {}, {}, 5_000, FAST);
    expect(calls.status).toBe(1);
  });

  it("uses a default poll interval when none is given", async () => {
    const { runner, calls } = scripted([{ state: "running" }, { state: "done", exitCode: 0 }]);
    const started = Date.now();
    await runToCompletion(runner, "verify", {}, {}, 5_000);
    expect(calls.status).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  describe("when the job outlives the timeout", () => {
    const stuck = [{ state: "running" } as JobStatus];

    it("cancels it and reports a failed job with exit code 124", async () => {
      const { runner, calls } = scripted(stuck);
      const job = await runToCompletion(runner, "seed", {}, {}, 30, FAST);
      expect(job).toEqual({ state: "failed", exitCode: 124, result: { error: "seed timed out after 30 ms" }, id: "j_1" });
      expect(calls.cancel).toEqual(["j_1"]);
    });

    it("cancels it by default, also when opts has no cancelOnTimeout", async () => {
      const { runner, calls } = scripted(stuck);
      await runToCompletion(runner, "verify", {}, {}, 20, { pollMs: 2 });
      expect(calls.cancel).toEqual(["j_1"]);
    });

    it("leaves it running with cancelOnTimeout: false, and still reports 124", async () => {
      const { runner, calls } = scripted(stuck);
      const job = await runToCompletion(runner, "land", {}, {}, 30, { ...FAST, cancelOnTimeout: false });
      expect(job).toEqual({ state: "failed", exitCode: 124, result: { error: "land timed out after 30 ms" }, id: "j_1" });
      expect(calls.cancel).toEqual([]);
    });

    it("cancels with cancelOnTimeout: true spelled out", async () => {
      const { runner, calls } = scripted(stuck);
      await runToCompletion(runner, "land", {}, {}, 20, { ...FAST, cancelOnTimeout: true });
      expect(calls.cancel).toEqual(["j_1"]);
    });

    it("lets a failing cancel surface, because the job may still be running", async () => {
      const { runner } = scripted(stuck, { cancelError: new RunnerError("runner unreachable") });
      await expect(runToCompletion(runner, "seed", {}, {}, 20, FAST)).rejects.toThrow("runner unreachable");
    });
  });

  describe("when the runner breaks", () => {
    it("passes a failing start on and polls nothing", async () => {
      const { runner, calls } = scripted([{ state: "running" }], { startError: new RunnerError("runner unreachable at x") });
      await expect(runToCompletion(runner, "seed", {}, {}, 5_000, FAST)).rejects.toBeInstanceOf(RunnerError);
      expect(calls.status).toBe(0);
    });

    it("passes a failing status on", async () => {
      const { runner } = scripted([{ state: "running" }], { statusError: new RunnerError("runner answered 500") });
      await expect(runToCompletion(runner, "seed", {}, {}, 5_000, FAST)).rejects.toThrow("runner answered 500");
    });
  });
});
