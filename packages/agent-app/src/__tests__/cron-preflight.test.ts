import { describe, expect, it, vi } from "vitest";

import type { ChannelLogger } from "@mono-agent/agent-contracts";
import type { CronFiringIdentity } from "@mono-agent/cron-adapter";

import {
  CRON_PREFLIGHT_KILL_GRACE_MS,
  MAX_CRON_PREFLIGHT_STDERR_LOG_BYTES,
  MAX_CRON_PREFLIGHT_STDOUT_BYTES,
  runCronPreflight,
  type CronPreflightChild,
  type CronPreflightSpawn,
  type CronPreflightSpawnOptions,
} from "../cron-preflight.js";

const firing: CronFiringIdentity = {
  runId: "cron:digest:2026-09-18T09:00:00.000Z",
  jobId: "digest",
  scheduledAt: "2026-09-18T09:00:00.000Z",
  orderedAt: "2026-09-18T09:00:00.000Z",
  sequence: 4,
  trigger: "scheduled",
};

type DataListener = (chunk: string | Uint8Array) => void;

class FakeGateChild implements CronPreflightChild {
  readonly stdoutData: DataListener[] = [];
  readonly stderrData: DataListener[] = [];
  readonly errorListeners: Array<(error: Error) => void> = [];
  readonly closeListeners: Array<(code: number | null, signal: string | null) => void> = [];
  readonly kills: string[] = [];
  readonly stdout = {
    on: (_event: "data", listener: DataListener): void => {
      this.stdoutData.push(listener);
    },
  };
  readonly stderr = {
    on: (_event: "data", listener: DataListener): void => {
      this.stderrData.push(listener);
    },
  };

  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  on(
    event: "error" | "close",
    listener: ((error: Error) => void) | ((code: number | null, signal: string | null) => void),
  ): void {
    if (event === "error") this.errorListeners.push(listener as (error: Error) => void);
    else this.closeListeners.push(listener as (code: number | null, signal: string | null) => void);
  }

  kill(signal?: "SIGTERM" | "SIGKILL"): boolean {
    this.kills.push(signal ?? "SIGTERM");
    return true;
  }

  unref(): void {}

  emitStdout(text: string): void {
    for (const listener of this.stdoutData) listener(text);
  }

  emitStderr(text: string): void {
    for (const listener of this.stderrData) listener(text);
  }

  emitClose(code: number | null, signal: string | null = null): void {
    for (const listener of this.closeListeners) listener(code, signal);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

interface Harness {
  readonly child: FakeGateChild;
  readonly spawn: CronPreflightSpawn;
  readonly captured: { command?: string; args?: readonly string[]; options?: CronPreflightSpawnOptions };
}

function harness(child: FakeGateChild = new FakeGateChild()): Harness {
  const captured: Harness["captured"] = {};
  const spawn: CronPreflightSpawn = (command, args, options) => {
    captured.command = command;
    captured.args = args;
    captured.options = options;
    return child;
  };
  return { child, spawn, captured };
}

function run(input: {
  readonly argv?: readonly string[];
  readonly timeoutMs?: number;
  readonly spawn?: CronPreflightSpawn;
  readonly signal?: AbortSignal;
  readonly logger?: ChannelLogger;
}) {
  return runCronPreflight({
    argv: input.argv ?? ["gate"],
    firing,
    cwd: "/agent-root",
    timeoutMs: input.timeoutMs ?? 5_000,
    abortSignal: input.signal ?? new AbortController().signal,
    ...(input.spawn === undefined ? {} : { spawn: input.spawn }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
}

describe("cron preflight runner", () => {
  it("runs the argv in the agent root with the firing identity in the environment", async () => {
    const { child, spawn, captured } = harness();
    const pending = run({ argv: ["node", "gate.mjs", "--strict"], spawn });
    child.emitStdout("{\"run\":true}");
    child.emitClose(0);

    await expect(pending).resolves.toEqual({ outcome: "run" });
    expect(captured.command).toBe("node");
    expect(captured.args).toEqual(["gate.mjs", "--strict"]);
    expect(captured.options?.cwd).toBe("/agent-root");
    expect(captured.options?.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(captured.options?.env).toMatchObject({
      MONO_AGENT_CRON_JOB_ID: "digest",
      MONO_AGENT_CRON_RUN_ID: firing.runId,
      MONO_AGENT_CRON_SCHEDULED_AT: firing.scheduledAt,
      MONO_AGENT_CRON_TRIGGER: "scheduled",
    });
    expect(captured.options?.env?.PATH).toBe(process.env.PATH);
  });

  it("reads a bare skip and ignores unknown diagnostic keys", async () => {
    const { child, spawn } = harness();
    const pending = run({ spawn });
    child.emitStdout("  {\"run\": false}  \n");
    child.emitClose(0);

    await expect(pending).resolves.toEqual({ outcome: "skip" });
  });

  it("keeps the gate input and reason on a run verdict", async () => {
    const { child, spawn } = harness();
    const pending = run({ spawn });
    child.emitStdout(JSON.stringify({
      run: true,
      input: "3 new PRs: #951 #952 #953",
      reason: "queue moved",
      diagnostics: { durationMs: 12 },
    }));
    child.emitClose(0);

    await expect(pending).resolves.toEqual({
      outcome: "run",
      input: "3 new PRs: #951 #952 #953",
      reason: "queue moved",
    });
  });

  it("fails open on wrong verdict types instead of guessing", async () => {
    for (const stdout of [
      "{\"run\": \"yes\"}",
      "{\"input\": \"no run flag\"}",
      "{\"run\": true, \"input\": 7}",
      "{\"run\": false, \"reason\": {\"why\": \"object\"}}",
      "[{\"run\": true}]",
      "\"skip\"",
    ]) {
      const { child, spawn } = harness();
      const pending = run({ spawn });
      child.emitStdout(stdout);
      child.emitClose(0);
      await expect(pending).resolves.toMatchObject({ outcome: "error", code: "invalid_verdict" });
    }
  });

  it("fails open on empty, malformed, or multi-object stdout", async () => {
    for (const stdout of ["", "   ", "{\"run\": false}{\"run\": true}", "not json"]) {
      const { child, spawn } = harness();
      const pending = run({ spawn });
      child.emitStdout(stdout);
      child.emitClose(0);
      await expect(pending).resolves.toMatchObject({ outcome: "error", code: "invalid_json" });
    }
  });

  it("kills the gate and fails open when stdout crosses the byte cap", async () => {
    const { child, spawn } = harness();
    const pending = run({ spawn });
    child.emitStdout("x".repeat(MAX_CRON_PREFLIGHT_STDOUT_BYTES + 1));
    child.emitClose(0);

    await expect(pending).resolves.toMatchObject({ outcome: "error", code: "output_overflow" });
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("fails open when the decoded input crosses its cap", async () => {
    const { child, spawn } = harness();
    const pending = run({ spawn });
    child.emitStdout(JSON.stringify({ run: true, input: "i".repeat(64 * 1024 + 1) }));
    child.emitClose(0);

    await expect(pending).resolves.toMatchObject({ outcome: "error", code: "output_overflow" });
  });

  it("reports a non-zero exit with a stable reason and logs stderr bounded at warn", async () => {
    const warn = vi.fn();
    const { child, spawn } = harness();
    const pending = run({ spawn, logger: { warn } });
    child.emitStderr("S".repeat(4_000));
    child.emitClose(3);

    await expect(pending).resolves.toEqual({
      outcome: "error",
      code: "exit_nonzero",
      reason: "preflight gate exited with code 3",
    });
    expect(warn).toHaveBeenCalledOnce();
    const [message, metadata] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toMatch(/failed open/u);
    expect(metadata).toMatchObject({ jobId: "digest", runId: firing.runId, code: "exit_nonzero" });
    // Raw stderr never becomes the recorded reason; the warn line is bounded.
    expect(Buffer.byteLength(String(metadata.detail), "utf8")).toBeLessThanOrEqual(MAX_CRON_PREFLIGHT_STDERR_LOG_BYTES);
  });

  it("reports a signal termination as a stable code", async () => {
    const { child, spawn } = harness();
    const pending = run({ spawn });
    child.emitClose(null, "SIGKILL");

    await expect(pending).resolves.toMatchObject({ outcome: "error", code: "signal" });
  });

  it("times out, SIGTERMs then SIGKILLs, and ignores a late verdict", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawn } = harness();
      const pending = run({ spawn, timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toMatchObject({ outcome: "error", code: "timeout" });
      expect(child.kills).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(CRON_PREFLIGHT_KILL_GRACE_MS);
      expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);

      // A gate that answers after the kill cannot flip the recorded outcome.
      child.emitStdout("{\"run\": true}");
      child.emitClose(0);
      await expect(pending).resolves.toMatchObject({ outcome: "error", code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open when spawn throws or the child cannot start", async () => {
    const warn = vi.fn();
    const throwing = run({
      spawn: () => {
        throw new Error("spawn EACCES");
      },
      logger: { warn },
    });
    await expect(throwing).resolves.toEqual({
      outcome: "error",
      code: "spawn_failed",
      reason: "preflight gate could not be started",
    });

    const { child, spawn } = harness();
    const pending = run({ spawn, logger: { warn } });
    child.emitError(new Error("spawn ENOENT"));
    await expect(pending).resolves.toMatchObject({ outcome: "error", code: "spawn_failed" });
  });

  it("kills the gate when the firing is cancelled before it answers", async () => {
    const controller = new AbortController();
    const { child, spawn } = harness();
    const pending = run({ spawn, signal: controller.signal });
    controller.abort(new Error("stopped"));
    child.emitClose(0);

    await expect(pending).resolves.toMatchObject({ outcome: "error", code: "signal" });
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("runs a real argv and reads its JSON verdict", async () => {
    const verdict = await runCronPreflight({
      argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify({run:true,input:'real gate'}))"],
      firing,
      cwd: process.cwd(),
      timeoutMs: 10_000,
      abortSignal: new AbortController().signal,
    });

    expect(verdict).toEqual({ outcome: "run", input: "real gate" });
  });

  it("reports a missing executable as spawn_failed without throwing", async () => {
    const verdict = await runCronPreflight({
      argv: ["mono-agent-definitely-not-a-real-gate-binary"],
      firing,
      cwd: process.cwd(),
      timeoutMs: 5_000,
      abortSignal: new AbortController().signal,
    });

    expect(verdict).toMatchObject({ outcome: "error", code: "spawn_failed" });
  });

  it("kills a real hung gate at the timeout and fails open", async () => {
    const verdict = await runCronPreflight({
      argv: [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
      firing,
      cwd: process.cwd(),
      timeoutMs: 100,
      abortSignal: new AbortController().signal,
    });

    expect(verdict).toMatchObject({ outcome: "error", code: "timeout" });
  });
});
