import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { ProcessJobState } from "@mono-agent/agent-contracts";
import { createRuntime } from "@mono-agent/agent-runtime";

import {
  bridgeProcessJobsController,
  type ProcessJobsController,
  type ProcessJobStartRequest,
  type ProcessJobStartResult,
} from "../process-jobs.js";
import type { RuntimeRunOptions } from "../types.js";

type KernelRuntime = ReturnType<typeof createRuntime>;
type KernelRunOptions = Parameters<KernelRuntime["run"]>[1];
type KernelProcessJobsController = NonNullable<KernelRunOptions["processJobs"]>;
type KernelStartRequest = Parameters<KernelProcessJobsController["start"]>[0];
type KernelStartResult = Awaited<ReturnType<KernelProcessJobsController["start"]>>;

describe("process-jobs kernel bridge", () => {
  it("carries the host's published budget across the kernel seam", () => {
    // Object.freeze in the bridge drops unknown fields, so the limits have to be
    // copied deliberately or the tool schema would never see the real ceiling.
    const bridged = bridgeProcessJobsController({
      limits: { maxRuntimeMs: 28_800_000, maxOutputBytes: 1_048_576 },
      start: async () => ({ jobId: "pj", state: "queued" as const, startedAt: null }),
    });

    expect(bridged.limits).toEqual({ maxRuntimeMs: 28_800_000, maxOutputBytes: 1_048_576 });
    expect(Object.isFrozen(bridged.limits)).toBe(true);
  });

  it("leaves an absent or malformed budget unstated rather than failing the bridge", () => {
    const start = async () => ({ jobId: "pj", state: "queued" as const, startedAt: null });

    expect(bridgeProcessJobsController({ start })).not.toHaveProperty("limits");
    for (const limits of [
      { maxRuntimeMs: 0, maxOutputBytes: 1_048_576 },
      { maxRuntimeMs: 28_800_000, maxOutputBytes: -1 },
      { maxRuntimeMs: 1.5, maxOutputBytes: 1_048_576 },
    ]) {
      expect(bridgeProcessJobsController({ limits: limits as never, start }))
        .not.toHaveProperty("limits");
    }
  });

  it("proves the kernel seam and neutral contract are structurally identical", () => {
    expectTypeOf<ProcessJobsController>().toExtend<KernelProcessJobsController>();
    expectTypeOf<KernelProcessJobsController>().toExtend<ProcessJobsController>();
    expectTypeOf<ProcessJobStartRequest>().toExtend<KernelStartRequest>();
    expectTypeOf<KernelStartRequest>().toExtend<ProcessJobStartRequest>();
    expectTypeOf<ProcessJobStartResult>().toExtend<KernelStartResult>();
    expectTypeOf<KernelStartResult>().toExtend<ProcessJobStartResult>();
    expectTypeOf<ProcessJobStartResult["state"]>()
      .toEqualTypeOf<Extract<ProcessJobState, "queued" | "starting" | "running">>();
    expectTypeOf<RuntimeRunOptions["processJobs"]>()
      .toEqualTypeOf<ProcessJobsController | undefined>();
  });

  it("forwards the exact prepared command and one-shot launcher", async () => {
    const start = vi.fn(async (request: ProcessJobStartRequest): Promise<ProcessJobStartResult> => ({
      jobId: request.summary,
      state: "queued",
      startedAt: null,
    }));
    const controller = bridgeProcessJobsController({ start });
    const launch = vi.fn();
    const request = {
      tool: "Exec" as const,
      prepared: {
        command: "/usr/bin/true",
        args: [],
        cwd: "/tmp",
        sandboxed: false,
      },
      summary: "true (0 arguments; values redacted)",
      launch,
    };
    await expect(controller.start(request)).resolves.toEqual({
      jobId: request.summary,
      state: "queued",
      startedAt: null,
    });
    expect(start).toHaveBeenCalledWith(request);
    expect(start.mock.calls[0]![0].prepared).toBe(request.prepared);
    expect(start.mock.calls[0]![0].launch).toBe(launch);
  });

  it("rejects malformed kernel requests before they reach the host", async () => {
    const start = vi.fn();
    const controller = bridgeProcessJobsController({ start });
    await expect(controller.start({
      tool: "Exec",
      prepared: { command: "/bin/true", args: [], cwd: "/tmp" },
      summary: "true",
      launch: vi.fn(),
    } as unknown as ProcessJobStartRequest)).rejects.toThrow(/invalid/u);
    await expect(controller.start({
      tool: "Bash",
      prepared: { command: "/bin/bash", args: [], cwd: "/tmp", sandboxed: true },
      summary: "Bash command (1 character; content redacted)",
      timeoutMs: -1,
      launch: vi.fn(),
    })).rejects.toThrow(/invalid/u);
    expect(start).not.toHaveBeenCalled();
  });
});
