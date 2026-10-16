import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../agent/tools/shared/process-runner.js", async (original) => ({
  ...await original(), runPreparedProcess: runner.run,
}));
import { bashToolRun } from "../../agent/tools/bash.js";
import { execToolRun } from "../../agent/tools/exec.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { createToolContext } from "../../agent/tools/shared/tool-context.js";
import { normalizeBashTimeoutMs, normalizeProcessTimeoutMs, normalizeBackgroundTimeoutMs, normalizeBackgroundBashTimeoutMs } from "../../agent/tools/shared/command-timeouts.js";

const result = { code: 0, signal: null, stdout: "fictional output", stderr: "", aborted: false,
  timedOut: false, bufferExceeded: false, truncated: false, bytes: 16, storedBytes: 16,
  spawnError: null, durationMs: 1 };
let root, workspace, allowed, ctx, cleanup, prepareCommand;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "turn-command-mechanics-"));
  workspace = join(root, "workspace"); allowed = join(root, "allowed");
  await Promise.all([mkdir(workspace), mkdir(allowed)]);
  await mkdir(join(workspace, "relative"));
  cleanup = vi.fn();
  prepareCommand = vi.fn(async ({ command }) => ({ ...command, sandboxed: false, cleanup }));
  ctx = createToolContext({ workspace, additionalReadRoots: [allowed], additionalWriteRoots: [allowed],
    sandbox: { ...passthroughSandbox, prepareCommand } });
  runner.run.mockResolvedValue({ ...result });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

for (const [tool, run, params, invalid] of [
  ["Bash", bashToolRun, { command: "fictional" }, { command: null }],
  ["Exec", execToolRun, { executable: "fictional" }, { executable: null, args: [null] }],
]) describe(`${tool} common mechanics`, () => {
  it.each([
    [{ background: true, wake_on_completion: "invalid" }, "process_job_invalid", "Error: wake_on_completion requires background=true and a boolean value."],
    [{ background: false, wake_on_completion: true }, "process_job_invalid", "Error: wake_on_completion requires background=true and a boolean value."],
    [{ background: true }, "background_unsupported", "Error: Background process jobs are unavailable for this request."],
  ])("keeps admission before invalid frontend arguments and missing context (%j)", async (extra, code, text) => {
    expect(await run({ ...invalid, ...extra }, undefined)).toMatchObject({ text, error: true, outcome: { code } });
    expect(prepareCommand).not.toHaveBeenCalled();
  });

  it.each(["relative", "outside", "missing", "denied"])("keeps ordered workdir checks (%s)", async (scenario) => {
    const workdir = scenario === "relative" ? relative(process.cwd(), join(workspace, "relative")) : scenario === "outside" ? allowed
      : scenario === "missing" ? join(workspace, "missing") : join(root, "denied");
    const answer = await run({ ...params, workdir }, { ctx });
    if (scenario === "missing" || scenario === "denied") {
      expect(answer).toMatchObject({ text: `Error: Working directory ${scenario === "missing" ? "not found" : "not allowed"}: ${workdir}`,
        outcome: { code: scenario === "missing" ? "workdir_not_found" : "workdir_denied" } });
      expect(prepareCommand).not.toHaveBeenCalled();
    } else {
      expect(answer.error).toBe(false);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(runner.run.mock.calls[0][0].cwd).toBe(scenario === "relative" ? join(workspace, "relative") : allowed);
    }
  });

  it.each([[undefined, 1777], [0.5, 1], [1_000_000, 1777]])("keeps exact foreground milliseconds (%s)", async (timeout_ms, expected) => {
    await run({ ...params, ...(timeout_ms === undefined ? {} : { timeout_ms }) }, { ctx, toolLimits: { bashTimeoutMs: 1777 } });
    expect(runner.run.mock.calls[0][1].timeoutMs).toBe(expected);
  });

  it.each([undefined, 1_000_000])("does not replace the host background budget (%s)", async (timeout_ms) => {
    const start = vi.fn(async () => ({ jobId: "fixture", state: "queued", startedAt: null }));
    const answer = await run({ ...params, background: true, ...(timeout_ms === undefined ? {} : { timeout_ms }) },
      { ctx, toolLimits: { bashTimeoutMs: 1777 }, processJobsController: { start } });
    expect(answer.outcome.code).toBe("background_started");
    if (timeout_ms === undefined) expect(start.mock.calls[0][0]).not.toHaveProperty("timeoutMs");
    else expect(start.mock.calls[0][0].timeoutMs).toBe(timeout_ms);
    expect(runner.run).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
  });

  it("keeps ordinary runner rejection authoritative and cleans once", async () => {
    const failure = new Error("Fictional runner rejection"); runner.run.mockRejectedValueOnce(failure);
    cleanup.mockRejectedValueOnce(new Error("Fictional cleanup rejection"));
    await expect(run(params, { ctx })).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("keeps cleanup failure behind process outcome (timedOut=%s)", async (timedOut) => {
    cleanup.mockRejectedValueOnce(new Error("Fictional cleanup rejection"));
    runner.run.mockResolvedValueOnce({ ...result, timedOut });
    const answer = await run(params, { ctx });
    expect(answer.outcome.code).toBe(timedOut ? "timeout" : "cleanup_failed");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["rejected", "unresolved"])("never falls back or cleans after owned %s", async (scenario) => {
    const owner = { run: vi.fn(async () => {
      if (scenario === "rejected") throw new Error("Fictional owner rejection");
      return { ...result, groupExitConfirmed: false };
    }) };
    const answer = await run(params, { ctx, ownedForegroundProcessController: owner, toolCallId: "fixture" });
    expect(answer.outcome.code).toBe("owned_process_unavailable");
    expect(owner.run).toHaveBeenCalledTimes(1); expect(runner.run).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
  });

  it("transfers ownership before waiting and preserves one owner cleanup", async () => {
    let admit, finish, owned;
    const admitted = new Promise((resolve) => { admit = resolve; });
    const completion = new Promise((resolve) => { finish = resolve; });
    const owner = { run: vi.fn((input) => { owned = input; admit(); return completion; }) };
    const running = run(params, { ctx, ownedForegroundProcessController: owner, toolCallId: "fixture" });
    await admitted;
    expect(cleanup).not.toHaveBeenCalled(); expect(runner.run).not.toHaveBeenCalled();
    finish({ ...result, groupExitConfirmed: true });
    expect((await running).error).toBe(false); expect(cleanup).not.toHaveBeenCalled();
    await owned.prepared.cleanup(); await owned.prepared.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

it.each([
  [normalizeBashTimeoutMs, 600, 600_000], [normalizeBashTimeoutMs, 601, 1000], [normalizeBashTimeoutMs, 0.5, 1000],
  [normalizeProcessTimeoutMs, 0.5, 1], [normalizeProcessTimeoutMs, 0, 1_000_000],
  [normalizeBackgroundTimeoutMs, undefined, undefined], [normalizeBackgroundTimeoutMs, 0, undefined],
  [normalizeBackgroundTimeoutMs, 0.5, 1], [normalizeBackgroundBashTimeoutMs, 600, 600_000],
  [normalizeBackgroundBashTimeoutMs, 601, 1000], [normalizeBackgroundBashTimeoutMs, 0, undefined],
].map(([normalize, input, expected]) => [normalize.name, input, expected, normalize]))("retains timeout facts (%s, %s)", (_name, input, expected, normalize) => {
  expect(normalize(input, 1_000_000)).toBe(expected);
});
