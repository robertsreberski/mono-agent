import { describe, expect, it, vi } from "vitest";

import {
  createSlackChannelDriver,
  createTelegramChannelDriver,
  type ChannelStartInput,
} from "../channels.js";

/** Minimal ChannelStartInput; the driver reads `config` and `coreConfig.tools`. */
function startInput<T>(config: T): ChannelStartInput<T> {
  return {
    config,
    coreConfig: { tools: { allowedTools: [], disallowedTools: [] } } as never,
    responder: {} as never,
    cwd: "/tmp",
    onFailure: vi.fn(),
  };
}

describe("telegram proactive notify allowlist", () => {
  function telegramDriver(notify: ReturnType<typeof vi.fn>) {
    return createTelegramChannelDriver({
      startAdapter: async () => ({ stop: async () => undefined, notify }) as never,
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
});

describe("slack proactive notify allowlist", () => {
  function slackDriver(notify: ReturnType<typeof vi.fn>) {
    return createSlackChannelDriver({
      startAdapter: async () => ({ stop: async () => undefined, adapter: { notify } }) as never,
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
});
