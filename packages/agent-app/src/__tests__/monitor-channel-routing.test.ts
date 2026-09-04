import { describe, expect, it, vi } from "vitest";

import type { HostWakeDeliveryResult, MonitorProjection } from "@mono-agent/agent-contracts";

import type { ChannelDriver, ChannelId, RunningChannel } from "../channels.js";
import { routeMonitorWake } from "../monitor-channel-routing.js";

const MONITOR: MonitorProjection = {
  schema: "mono-agent.monitor-projection.v1",
  monitorId: "mon-1",
  state: "running",
  description: "Watching a pane",
  persistent: false,
  origin: {
    conversationId: "telegram:42#2026-09-03",
    channel: "telegram",
    runId: "run-1",
    bucket: "2026-09-03",
  },
  timestamps: {
    startedAt: "2026-09-03T10:00:00.000Z",
    runtimeDeadlineAt: null,
    lastEventAt: null,
    completedAt: null,
  },
  limits: { maxRuntimeMs: 60_000, coalesceMs: 200, maxBatchLines: 200, maxBatchBytes: 65_536, chainDepth: 0 },
  counters: { seq: 1, batchesDelivered: 0, linesObserved: 1, linesDelivered: 0, droppedLines: 0, pendingLines: 0 },
  exitCode: null,
  signal: null,
  cancelRequested: false,
  lastError: null,
};

function driver(id: ChannelId, scheme?: string): ChannelDriver {
  return {
    id,
    label: id,
    ...(scheme === undefined ? {} : { processJobs: { conversationScheme: scheme } }),
  } as ChannelDriver;
}

function running(wake: RunningChannel["monitors"]): RunningChannel {
  return { summary: {}, stop: async () => undefined, ...(wake === undefined ? {} : { monitors: wake }) } as RunningChannel;
}

function input(overrides: Partial<Parameters<typeof routeMonitorWake>[0]> = {}) {
  const wake = vi.fn(async (): Promise<HostWakeDeliveryResult> => ({ delivered: true, disposition: "steered" }));
  return {
    wake,
    args: {
      projection: MONITOR,
      conversationId: "telegram:42",
      deliveryKey: "monitor:mon-1:1",
      text: "fenced envelope",
      drivers: [driver("telegram", "telegram")],
      running: new Map<ChannelId, RunningChannel>([["telegram", running({ wake })]]),
      ...overrides,
    },
  };
}

describe("routeMonitorWake", () => {
  it("routes to the single channel owning the origin scheme", async () => {
    const { wake, args } = input();
    const result = await routeMonitorWake(args);
    expect(result).toEqual({ delivered: true, disposition: "steered" });
    expect(wake).toHaveBeenCalledWith({
      conversationId: "telegram:42",
      text: "fenced envelope",
      deliveryKey: "monitor:mon-1:1",
      monitor: MONITOR,
    });
  });

  it("fails closed when the destination is not the monitor's own base conversation", async () => {
    const { wake, args } = input({ conversationId: "telegram:99" });
    const result = await routeMonitorWake(args);
    expect(result).toMatchObject({ delivered: false, code: "monitor_origin_mismatch", retryable: false });
    expect(wake).not.toHaveBeenCalled();
  });

  it("fails closed when the delivery key does not belong to this monitor", async () => {
    const { wake, args } = input({ deliveryKey: "monitor:mon-2:1" });
    expect(await routeMonitorWake(args)).toMatchObject({ code: "monitor_origin_mismatch" });
    expect(wake).not.toHaveBeenCalled();

    const stale = input({ deliveryKey: "monitor:mon-1:2" });
    expect(await routeMonitorWake(stale.args)).toMatchObject({ code: "monitor_origin_mismatch" });
    expect(stale.wake).not.toHaveBeenCalled();
  });

  it("fails closed when no channel or several channels claim the scheme", async () => {
    const none = input({ drivers: [driver("slack", "slack")] });
    expect(await routeMonitorWake(none.args)).toMatchObject({
      delivered: false,
      code: "monitor_unsupported_channel",
      retryable: false,
    });

    const several = input({ drivers: [driver("telegram", "telegram"), driver("other", "telegram")] });
    expect(await routeMonitorWake(several.args)).toMatchObject({ code: "monitor_unsupported_channel" });
  });

  it("reports a stopped channel as retryable and a monitor-less channel as permanent", async () => {
    const stopped = input({ running: new Map() });
    expect(await routeMonitorWake(stopped.args)).toMatchObject({
      delivered: false,
      code: "destination_channel_unavailable",
      retryable: true,
    });

    const unsupported = input({
      running: new Map<ChannelId, RunningChannel>([["telegram", running(undefined)]]),
    });
    expect(await routeMonitorWake(unsupported.args)).toMatchObject({
      delivered: false,
      code: "monitor_unsupported_channel",
      retryable: false,
    });
  });

  it("treats a throwing adapter as ambiguous so the batch is never replayed", async () => {
    const wake = vi.fn(async () => { throw new Error("socket closed mid-post"); });
    const { args } = input({
      running: new Map<ChannelId, RunningChannel>([["telegram", running({ wake } as never)]]),
    });
    expect(await routeMonitorWake(args)).toMatchObject({
      delivered: false,
      code: "monitor_wake_failed",
      retryable: false,
      ambiguous: true,
    });
  });

  it("routes a web-console origin through the app-owned TUI Monitor surface", async () => {
    const webMonitor: MonitorProjection = {
      ...MONITOR,
      origin: { ...MONITOR.origin, conversationId: "web:thread-1", channel: "web", bucket: null },
    };
    const wake = vi.fn(async (): Promise<HostWakeDeliveryResult> => ({ delivered: true, disposition: "follow_up" }));
    const { args } = input({
      projection: webMonitor,
      conversationId: "web:thread-1",
      drivers: [driver("tui", "web")],
      running: new Map<ChannelId, RunningChannel>([["tui", running({ wake })]]),
    });
    expect(await routeMonitorWake(args)).toEqual({ delivered: true, disposition: "follow_up" });
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "web:thread-1",
      deliveryKey: "monitor:mon-1:1",
      monitor: webMonitor,
    }));
  });
});
