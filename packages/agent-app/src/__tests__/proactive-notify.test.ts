import { describe, expect, it, vi } from "vitest";

import type { ProcessJobProjection } from "@mono-agent/agent-contracts";

import type { ChannelId, RunningChannel } from "../channels.js";
import { channelIdForConversation, routeProactiveNotification } from "../proactive-notify.js";

describe("channelIdForConversation", () => {
  it("maps push-channel prefixes to their channel id", () => {
    expect(channelIdForConversation("telegram:42")).toBe("telegram");
    expect(channelIdForConversation("slack:C1:171.5")).toBe("slack");
    expect(channelIdForConversation("whatsapp:123@s.whatsapp.net")).toBe("whatsapp");
  });

  it("returns undefined for non-deliverable destinations", () => {
    expect(channelIdForConversation("cron:morning-brief")).toBeUndefined();
    expect(channelIdForConversation("webhook:req-1")).toBeUndefined();
    expect(channelIdForConversation("web:thread-1")).toBeUndefined();
    expect(channelIdForConversation("nonsense")).toBeUndefined();
    // A scheme without a target (no colon) is not a routable destination.
    expect(channelIdForConversation("telegram")).toBeUndefined();
  });
});

describe("routeProactiveNotification", () => {
  const running = (entries: Partial<Record<ChannelId, Pick<RunningChannel, "notify">>>) =>
    new Map(Object.entries(entries) as [ChannelId, Pick<RunningChannel, "notify">][]);

  it("delivers to the destination channel's notify and returns its result", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const result = await routeProactiveNotification({
      conversationId: "telegram:42",
      text: "morning brief",
      running: running({ telegram: { notify } }),
    });
    expect(result.delivered).toBe(true);
    expect(notify).toHaveBeenCalledWith({ conversationId: "telegram:42", text: "morning brief" });
  });

  it("returns a failure result (does not throw) when the channel's notify rejects", async () => {
    const warn = vi.fn();
    const notify = vi.fn(async () => {
      throw new Error("delivery failed");
    });
    const result = await routeProactiveNotification({
      conversationId: "telegram:42",
      text: "morning brief",
      running: running({ telegram: { notify } }),
      logger: { warn },
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("delivery failed");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips + warns when the destination prefix is not a push channel", async () => {
    const warn = vi.fn();
    const result = await routeProactiveNotification({
      conversationId: "cron:job",
      text: "x",
      running: running({}),
      logger: { warn },
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBeDefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips + warns when the destination channel is not running or has no notify", async () => {
    const warn = vi.fn();
    const result = await routeProactiveNotification({
      conversationId: "whatsapp:123@s.whatsapp.net",
      text: "x",
      running: running({}),
      logger: { warn },
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBeDefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects ordinary web notifications while ProcessJob web lifecycle wakes use TUI", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const ordinary = await routeProactiveNotification({
      conversationId: "web:thread-1",
      text: "ordinary",
      running: running({ tui: { notify } }),
    });
    expect(ordinary.delivered).toBe(false);
    expect(notify).not.toHaveBeenCalled();

    const processJob = jobProjection("web:thread-1", "web");
    const lifecycle = await routeProactiveNotification({
      conversationId: "web:thread-1",
      text: "wake",
      processJob,
      running: running({ tui: { notify } }),
    });
    expect(lifecycle.delivered).toBe(true);
    expect(notify).toHaveBeenCalledWith({
      conversationId: "web:thread-1",
      text: "wake",
      processJob,
    });
  });

  it("classifies an absent recognized channel as retryable before dispatch", async () => {
    await expect(routeProactiveNotification({
      conversationId: "slack:C1:171.5",
      text: "wake",
      running: running({}),
    })).resolves.toEqual({
      delivered: false,
      code: "destination_channel_unavailable",
      reason: "slack channel is not running",
      retryable: true,
    });
  });

  it("keeps a running channel without notify permanently unsupported", async () => {
    await expect(routeProactiveNotification({
      conversationId: "whatsapp:123@s.whatsapp.net",
      text: "wake",
      running: running({ whatsapp: {} }),
    })).resolves.toEqual({
      delivered: false,
      code: "destination_channel_unsupported",
      reason: "whatsapp channel does not support proactive delivery",
      retryable: false,
    });
  });
});

function jobProjection(
  conversationId: string,
  channel: "slack" | "telegram" | "web",
): ProcessJobProjection {
  return {
    schema: "mono-agent.process-job-projection.v1",
    jobId: "pj_route",
    tool: "Exec",
    state: "running",
    summary: "Exec command (values redacted)",
    origin: { conversationId, channel, runId: "run", historyBoundary: "run", bucket: null },
    timestamps: {
      admittedAt: "2026-08-15T00:00:00.000Z",
      queueDeadlineAt: "2026-08-15T00:05:00.000Z",
      startedAt: "2026-08-15T00:00:01.000Z",
      runtimeDeadlineAt: "2026-08-15T00:30:01.000Z",
      completedAt: null,
    },
    limits: { maxRuntimeMs: 1_800_000, maxOutputBytes: 1024, previewChars: 100, chainDepth: 0 },
    output: { stdoutBytes: 0, stderrBytes: 0, truncated: false, preview: "", stdoutRef: null, stderrRef: null },
    wake: { state: "pending", attempts: 0, deliveryKey: "process-job:pj_route", lastAttemptAt: null },
    exitCode: null,
    signal: null,
    durationMs: null,
    cancelRequested: false,
    lastError: null,
  };
}
