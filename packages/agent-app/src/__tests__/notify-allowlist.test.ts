import { describe, expect, it, vi } from "vitest";

import type { ProcessJobProjection } from "@mono-agent/agent-contracts";

import {
  createSlackChannelDriver,
  createTelegramChannelDriver,
  type ChannelStartInput,
} from "../channels.js";

/** Minimal ChannelStartInput with the parsed runtime contract channel drivers consume. */
function startInput<T>(config: T): ChannelStartInput<T> {
  return {
    config,
    coreConfig: {
      runtime: {
        model: {
          sdk: "pi",
          provider: "openai-codex",
          model: "gpt-5.5",
          reference: "pi:openai-codex:gpt-5.5",
        },
      },
      tools: { allowedTools: [], disallowedTools: [] },
    } as never,
    responder: {} as never,
    cwd: "/tmp",
    onFailure: vi.fn(),
  };
}

describe("telegram proactive notify allowlist", () => {
  function telegramDriver(
    notify: ReturnType<typeof vi.fn>,
    updateProcessJob?: ReturnType<typeof vi.fn>,
  ) {
    return createTelegramChannelDriver({
      startAdapter: async () => ({
        stop: async () => undefined,
        notify,
        ...(updateProcessJob === undefined ? {} : { updateProcessJob }),
      }) as never,
    });
  }
  const config = (over: Record<string, unknown>) =>
    ({ enabled: true, botToken: "t", allowedChatIds: ["42"], allowAllChats: false, ...over }) as never;

  it("delivers to an allowlisted chat and returns the adapter outcome", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const running = await telegramDriver(notify).start(startInput(config({})));
    const result = await running.notify!({ conversationId: "telegram:42", text: "hi" });
    expect(result).toEqual({ delivered: true });
    expect(notify).toHaveBeenCalledWith(42, "hi", undefined);
  });

  it("forwards the verbatim flag to the adapter", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const running = await telegramDriver(notify).start(startInput(config({})));
    await running.notify!({ conversationId: "telegram:42", text: "hi", verbatim: true });
    expect(notify).toHaveBeenCalledWith(42, "hi", { verbatim: true });
  });

  it("surfaces a delivered:false outcome when the adapter cannot deliver (e.g. queue full)", async () => {
    const notify = vi.fn(async () => ({ delivered: false, reason: "chat at concurrency cap" }));
    const running = await telegramDriver(notify).start(startInput(config({})));
    const result = await running.notify!({ conversationId: "telegram:42", text: "hi" });
    expect(result).toEqual({ delivered: false, reason: "chat at concurrency cap" });
    expect(notify).toHaveBeenCalledWith(42, "hi", undefined);
  });

  it("rejects a chat that is not in the allowlist", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const running = await telegramDriver(notify).start(startInput(config({})));
    const result = await running.notify!({ conversationId: "telegram:999", text: "hi" });
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/allowlist/);
    expect(notify).not.toHaveBeenCalled();
  });

  it("allows any chat when allowAllChats is set", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const running = await telegramDriver(notify).start(startInput(config({ allowAllChats: true, allowedChatIds: [] })));
    const result = await running.notify!({ conversationId: "telegram:999", text: "hi" });
    expect(result).toEqual({ delivered: true });
  });

  it("records destination history through the responder with the receipt idempotency key", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const deliverVerbatim = vi.fn(async () => undefined);
    const running = await telegramDriver(notify).start({
      ...startInput(config({})),
      responder: { deliverVerbatim } as never,
    });
    const recordHistory = (running as unknown as {
      recordContinuationHistory(input: {
        conversationId: string;
        text: string;
        deliveryKey: string;
      }): Promise<{ recorded: boolean; code?: string }>;
    }).recordContinuationHistory;

    await expect(recordHistory({
      conversationId: "telegram:42",
      text: "Exact delivered text",
      deliveryKey: "adapter-send:telegram:42:7",
    })).resolves.toEqual({ recorded: true });
    expect(deliverVerbatim).toHaveBeenCalledWith(
      "telegram:42",
      "Exact delivered text",
      { idempotencyKey: "adapter-send:telegram:42:7" },
    );

    await expect(recordHistory({
      conversationId: "telegram:999",
      text: "blocked",
      deliveryKey: "adapter-send:telegram:999:8",
    })).resolves.toEqual({ recorded: false, code: "telegram_destination_not_allowlisted" });
    expect(deliverVerbatim).toHaveBeenCalledOnce();
  });

  it("handles host-only lifecycle updates before notify and never turns empty text into a model turn", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const lifecycleCalls: unknown[][] = [];
    const startResult = {
      receiverState: "ready",
      stop: async () => undefined,
      notify,
      async updateProcessJob(...args: unknown[]) {
        if (this !== startResult || this.receiverState !== "ready") {
          throw new Error("Telegram lifecycle updater lost its start-result receiver");
        }
        lifecycleCalls.push(args);
        return {
          delivered: true,
          code: "surface_updated",
          channelId: "telegram" as const,
        };
      },
    };
    const processJob = projection("telegram:42", "telegram");
    const running = await createTelegramChannelDriver({
      startAdapter: async () => startResult as never,
    }).start(startInput(config({})));

    await expect(running.notify!({ conversationId: "telegram:42", text: "", processJob }))
      .resolves.toMatchObject({ delivered: true, code: "surface_updated" });
    expect(lifecycleCalls).toEqual([[42, processJob, undefined]]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("fails empty lifecycle updates closed on an unsupported adapter without invoking notify", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const running = await telegramDriver(notify).start(startInput(config({})));

    await expect(running.notify!({
      conversationId: "telegram:42",
      text: "",
      processJob: projection("telegram:42", "telegram"),
    })).resolves.toMatchObject({ delivered: false, code: "background_unsupported_channel" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("marks a post-admission lifecycle wake failure ambiguous and nonretryable", async () => {
    const notify = vi.fn(async () => ({ delivered: false, retryable: true, reason: "post failed" }));
    const updateProcessJob = vi.fn(async () => ({ delivered: true }));
    const processJob = projection("telegram:42", "telegram");
    const running = await telegramDriver(notify, updateProcessJob).start(startInput(config({})));

    await expect(running.notify!({
      conversationId: "telegram:42",
      text: "wake",
      deliveryKey: processJob.wake.deliveryKey,
      processJob,
    }))
      .resolves.toMatchObject({ delivered: false, retryable: false, ambiguous: true });
    expect(notify).toHaveBeenCalledWith(42, "wake", { deliveryKey: processJob.wake.deliveryKey });
  });

  it("classifies process-job busy admission from the adapter's stable code", async () => {
    const notify = vi.fn(async () => ({
      delivered: false,
      code: "conversation_busy",
      reason: "chat at concurrency cap",
      retryable: true,
    }));
    const updateProcessJob = vi.fn(async () => ({ delivered: true }));
    const processJob = projection("telegram:42", "telegram");
    const running = await telegramDriver(notify, updateProcessJob).start(startInput(config({})));

    await expect(running.notify!({
      conversationId: "telegram:42",
      text: "wake",
      processJob,
    })).resolves.toMatchObject({
      delivered: false,
      code: "conversation_busy",
      retryable: true,
    });
  });

  it("keeps the legacy Telegram busy reason compatible for custom starters", async () => {
    const notify = vi.fn(async () => ({ delivered: false, reason: "chat at concurrency cap" }));
    const updateProcessJob = vi.fn(async () => ({ delivered: true }));
    const processJob = projection("telegram:42", "telegram");
    const running = await telegramDriver(notify, updateProcessJob).start(startInput(config({})));

    await expect(running.notify!({
      conversationId: "telegram:42",
      text: "wake",
      processJob,
    })).resolves.toMatchObject({
      delivered: false,
      code: "conversation_busy",
      retryable: true,
    });
  });

  it("does not let legacy Telegram busy prose override explicit nonretryability", async () => {
    const notify = vi.fn(async () => ({
      delivered: false,
      reason: "chat at concurrency cap",
      retryable: false,
    }));
    const updateProcessJob = vi.fn(async () => ({ delivered: true }));
    const processJob = projection("telegram:42", "telegram");
    const running = await telegramDriver(notify, updateProcessJob).start(startInput(config({})));

    await expect(running.notify!({
      conversationId: "telegram:42",
      text: "wake",
      processJob,
    })).resolves.toMatchObject({
      delivered: false,
      code: "conversation_busy",
      retryable: false,
    });
  });

  it("does not upgrade conflicting Telegram stable codes from busy-looking prose", async () => {
    const notify = vi.fn(async () => ({
      delivered: false,
      code: "destination_rejected",
      reason: "chat at concurrency cap",
      retryable: true,
    }));
    const updateProcessJob = vi.fn(async () => ({ delivered: true }));
    const processJob = projection("telegram:42", "telegram");
    const running = await telegramDriver(notify, updateProcessJob).start(startInput(config({})));

    await expect(running.notify!({
      conversationId: "telegram:42",
      text: "wake",
      processJob,
    })).resolves.toMatchObject({
      delivered: false,
      code: "destination_rejected",
      retryable: false,
      ambiguous: true,
    });
  });
});

describe("slack proactive notify allowlist", () => {
  function slackDriver(
    notify: ReturnType<typeof vi.fn>,
    updateProcessJob?: ReturnType<typeof vi.fn>,
  ) {
    return createSlackChannelDriver({
      startAdapter: async () => ({
        stop: async () => undefined,
        adapter: { notify, ...(updateProcessJob === undefined ? {} : { updateProcessJob }) },
      }) as never,
    });
  }
  const config = (over: Record<string, unknown>) =>
    ({
      enabled: true,
      botToken: "b",
      appToken: "a",
      allowedChannelIds: ["C1"],
      allowAllChannels: false,
      botUserIds: [],
      mentionTextAliases: [],
      stripMentionText: false,
      ...over,
    }) as never;

  it("rejects a channel that is not in the allowlist", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const running = await slackDriver(notify).start(startInput(config({})));
    const result = await running.notify!({ conversationId: "slack:C-other", text: "hi" });
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/allowlist/);
    expect(notify).not.toHaveBeenCalled();
  });

  it("delivers to an allowlisted channel (case-insensitive) and returns the adapter outcome", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const running = await slackDriver(notify).start(startInput(config({ allowedChannelIds: ["c1"] })));
    const result = await running.notify!({ conversationId: "slack:C1", text: "hi" });
    expect(result).toEqual({ delivered: true });
    expect(notify).toHaveBeenCalledWith("C1", undefined, "hi", undefined);
  });

  it("forwards the verbatim flag to the adapter", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const running = await slackDriver(notify).start(startInput(config({})));
    await running.notify!({ conversationId: "slack:C1", text: "hi", verbatim: true });
    expect(notify).toHaveBeenCalledWith("C1", undefined, "hi", { verbatim: true });
  });

  it("surfaces a delivered:false outcome when the adapter cannot deliver (e.g. queue full)", async () => {
    const notify = vi.fn(async () => ({ delivered: false, reason: "conversation at concurrency cap" }));
    const running = await slackDriver(notify).start(startInput(config({})));
    const result = await running.notify!({ conversationId: "slack:C1", text: "hi" });
    expect(result).toEqual({ delivered: false, reason: "conversation at concurrency cap" });
    expect(notify).toHaveBeenCalledWith("C1", undefined, "hi", undefined);
  });

  it("binds lifecycle updates to the exact Slack origin and preserves pre-turn busy retryability", async () => {
    const notify = vi.fn(async () => ({
      delivered: false,
      code: "conversation_busy",
      reason: "conversation at concurrency cap",
      retryable: true,
    }));
    const updateProcessJob = vi.fn(async () => ({ delivered: true }));
    const processJob = projection("slack:C1:171.5#bucket", "slack");
    const running = await slackDriver(notify, updateProcessJob).start(startInput(config({})));

    await expect(running.notify!({
      conversationId: "slack:C1:171.5",
      text: "wake",
      processJob,
    })).resolves.toMatchObject({
      delivered: false,
      code: "conversation_busy",
      retryable: true,
    });
    expect(updateProcessJob).toHaveBeenCalledWith("C1", "171.5", processJob);

    await expect(running.notify!({
      conversationId: "slack:C1:other",
      text: "",
      processJob,
    })).resolves.toMatchObject({ delivered: false, code: "process_job_origin_mismatch" });
    expect(updateProcessJob).toHaveBeenCalledOnce();
  });
});

function projection(
  conversationId: string,
  channel: "slack" | "telegram" | "web",
): ProcessJobProjection {
  return {
    schema: "mono-agent.process-job-projection.v1",
    jobId: "pj_native",
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
    wake: { state: "pending", attempts: 0, deliveryKey: "process-job:pj_native", lastAttemptAt: null },
    exitCode: null,
    signal: null,
    durationMs: null,
    cancelRequested: false,
    lastError: null,
  };
}
