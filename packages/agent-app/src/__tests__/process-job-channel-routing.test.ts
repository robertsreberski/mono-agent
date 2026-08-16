import type { ProcessJobProjection } from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  assertUniqueProcessJobChannelSchemes,
  routeProcessJobSurfaceUpdate,
  routeProcessJobWake,
} from "../process-job-channel-routing.js";
import type { ChannelDriver, RunningChannel } from "../channels.js";

describe("process-job channel routing", () => {
  it("routes one future plugin scheme through its explicit running capability", async () => {
    const update = vi.fn(async () => ({ delivered: true, channelId: "discord-plugin" }));
    const wake = vi.fn(async () => ({
      delivered: true,
      channelId: "discord-plugin",
      disposition: "follow_up" as const,
    }));
    const driver = pluginDriver("discord-plugin", "discord");
    const channel: RunningChannel = {
      summary: {},
      stop: async () => undefined,
      processJobs: { update, wake },
    };
    const projection = job("discord:channel-1#bucket", "discord");
    const base = {
      projection,
      conversationId: "discord:channel-1",
      deliveryKey: projection.wake.deliveryKey,
      drivers: [driver],
      running: new Map([[driver.id, channel]]),
    };

    await expect(routeProcessJobSurfaceUpdate(base)).resolves.toMatchObject({ delivered: true });
    await expect(routeProcessJobWake({ ...base, text: "finished" })).resolves.toMatchObject({
      delivered: true,
      disposition: "follow_up",
    });
    expect(update).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "discord:channel-1",
      text: "finished",
      processJob: projection,
    }));
  });

  it("fails closed for duplicate, invalid, missing, or mismatched scheme ownership", async () => {
    expect(() => assertUniqueProcessJobChannelSchemes([
      pluginDriver("one", "discord"),
      pluginDriver("two", "discord"),
    ])).toThrow(/both claim/u);
    expect(() => assertUniqueProcessJobChannelSchemes([
      pluginDriver("bad", "Not Valid"),
    ])).toThrow(/invalid/u);

    const projection = job("discord:channel-1#bucket", "discord");
    await expect(routeProcessJobWake({
      projection,
      conversationId: "discord:channel-1",
      deliveryKey: projection.wake.deliveryKey,
      text: "finished",
      drivers: [],
      running: new Map(),
    })).resolves.toMatchObject({ delivered: false, code: "background_unsupported_channel" });
    await expect(routeProcessJobWake({
      projection,
      conversationId: "discord:other",
      deliveryKey: projection.wake.deliveryKey,
      text: "finished",
      drivers: [pluginDriver("discord-plugin", "discord")],
      running: new Map(),
    })).resolves.toMatchObject({ delivered: false, code: "process_job_origin_mismatch" });
  });
});

function pluginDriver(id: string, conversationScheme: string): ChannelDriver {
  return {
    id,
    label: id,
    processJobs: { conversationScheme },
    loadConfig: async () => ({}),
    isConfigError: () => false,
    start: async () => ({ summary: {}, stop: async () => undefined }),
  };
}

function job(conversationId: string, channel: string): ProcessJobProjection {
  return {
    schema: "mono-agent.process-job-projection.v1",
    jobId: "11111111-1111-4111-8111-111111111111",
    tool: "Exec",
    state: "succeeded",
    summary: "worker",
    origin: { channel, conversationId, runId: "run-1", historyBoundary: "run-1", bucket: "bucket" },
    timestamps: {
      admittedAt: "2026-08-16T10:00:00.000Z",
      queueDeadlineAt: "2026-08-16T10:01:00.000Z",
      startedAt: "2026-08-16T10:00:01.000Z",
      runtimeDeadlineAt: "2026-08-16T10:02:00.000Z",
      completedAt: "2026-08-16T10:00:02.000Z",
    },
    limits: { maxRuntimeMs: 60_000, maxOutputBytes: 1_024, previewChars: 1_000, chainDepth: 0 },
    output: {
      stdoutBytes: 2,
      stderrBytes: 0,
      truncated: false,
      preview: "ok",
      stdoutRef: null,
      stderrRef: null,
    },
    wake: { state: "pending", attempts: 0, deliveryKey: "process-job:job-1", lastAttemptAt: null },
    exitCode: 0,
    signal: null,
    durationMs: 1_000,
    cancelRequested: false,
    lastError: null,
  };
}
