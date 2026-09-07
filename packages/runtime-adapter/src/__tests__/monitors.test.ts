import { describe, expect, it, vi } from "vitest";

import { bridgeMonitorsController, type MonitorStartRequest } from "../monitors.js";

function fixture() {
  const start = vi.fn(async () => ({
    monitorId: "mon-1", state: "running" as const, startedAt: new Date().toISOString(),
    maxRuntimeMs: 300000, persistent: false,
    wakeOn: "batch" as const, dedupe: "batch" as const, minWakeIntervalMs: 1000,
  }));
  const controller = bridgeMonitorsController({
    limits: { maxRuntimeMs: 300000, persistentMaxRuntimeMs: 300000, maxActivePerConversation: 2, maxWakeIntervalMs: 1000 },
    start, stop: vi.fn(),
  });
  const request: MonitorStartRequest = {
    prepared: { command: "/bin/true", args: [], cwd: "/tmp", sandboxed: false },
    description: "Watching a probe", summary: "redacted", launch: vi.fn(),
  };
  return { start, controller, request };
}

describe("Monitor policy bridge", () => {
  it("preserves host cap, requested policy and effective receipt", async () => {
    const { start, controller, request } = fixture();
    expect(controller.limits?.maxWakeIntervalMs).toBe(1000);
    const policy = { wakeOn: "batch" as const, dedupe: "batch" as const, minWakeIntervalMs: 900000 };
    expect(await controller.start({ ...request, ...policy })).toMatchObject({ minWakeIntervalMs: 1000 });
    expect(start).toHaveBeenCalledWith({ ...request, ...policy });
  });

  it.each([
    { wakeOn: "bad" }, { dedupe: "bad" }, { minWakeIntervalMs: -1 },
    { minWakeIntervalMs: 0.5 }, { wakeOn: "exit", dedupe: "batch" },
    { wakeOn: "exit", minWakeIntervalMs: 1 },
  ])("rejects invalid policy before the host: %j", async (policy) => {
    const { start, controller, request } = fixture();
    await expect(controller.start({ ...request, ...policy } as MonitorStartRequest))
      .rejects.toThrow("Kernel monitor start request is invalid.");
    expect(start).not.toHaveBeenCalled();
  });

  it("accepts default and explicit exit-only policy", async () => {
    const { start, controller, request } = fixture();
    await controller.start(request);
    await controller.start({ ...request, wakeOn: "exit", dedupe: "none", minWakeIntervalMs: 0 });
    expect(start).toHaveBeenCalledTimes(2);
  });
});
