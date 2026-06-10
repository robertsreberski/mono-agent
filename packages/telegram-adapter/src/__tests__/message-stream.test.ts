import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  splitTelegramText,
  TelegramMessageStream,
} from "../message-stream.js";
import type {
  TelegramBotApi,
  TelegramEditMessageTextParams,
  TelegramGetUpdatesParams,
  TelegramSendMessageParams,
  TelegramSentMessage,
  TelegramUpdate,
} from "../types.js";

class FakeTelegramApi implements TelegramBotApi {
  readonly sendMessageCalls: TelegramSendMessageParams[] = [];
  readonly editMessageTextCalls: TelegramEditMessageTextParams[] = [];
  nextMessageId = 100;
  failSendWith: Error | undefined;
  failEditWith: Error | undefined;

  async sendMessage(
    params: TelegramSendMessageParams,
  ): Promise<TelegramSentMessage> {
    this.sendMessageCalls.push(params);
    if (this.failSendWith !== undefined) {
      throw this.failSendWith;
    }

    return {
      message_id: this.nextMessageId++,
      chat: { id: params.chat_id },
      text: params.text,
    };
  }

  async editMessageText(
    params: TelegramEditMessageTextParams,
  ): Promise<TelegramSentMessage | true> {
    this.editMessageTextCalls.push(params);
    if (this.failEditWith !== undefined) {
      throw this.failEditWith;
    }

    return {
      message_id: params.message_id ?? 0,
      chat: { id: params.chat_id ?? 0 },
      text: params.text,
    };
  }

  async getUpdates(_params: TelegramGetUpdatesParams): Promise<TelegramUpdate[]> {
    return [];
  }
}

describe("TelegramMessageStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a placeholder and debounces Telegram edit updates", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      initialStatusText: "Starting…",
      editDebounceMs: 50,
    });

    await stream.append("Hel");
    await stream.append("lo");

    expect(api.sendMessageCalls).toEqual([{ chat_id: 42, text: "Starting…" }]);
    expect(api.editMessageTextCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(49);
    expect(api.editMessageTextCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(api.editMessageTextCalls).toEqual([
      { chat_id: 42, message_id: 100, text: "Hello" },
    ]);
  });

  it("flushes final output immediately and cancels pending edits", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: "chat-a",
      editDebounceMs: 10_000,
    });

    await stream.append("draft");
    await stream.finish("final answer");

    expect(api.editMessageTextCalls).toEqual([
      { chat_id: "chat-a", message_id: 100, text: "final answer" },
    ]);
    await vi.runOnlyPendingTimersAsync();
    expect(api.editMessageTextCalls).toHaveLength(1);
  });

  it("splits final output into Telegram-sized message chunks", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 99,
      editDebounceMs: 0,
      maxMessageChars: 32,
    });
    const finalText = "a".repeat(70);

    await stream.finish(finalText);

    expect(api.editMessageTextCalls).toHaveLength(1);
    expect(api.editMessageTextCalls[0]?.text).toHaveLength(32);
    expect(api.sendMessageCalls).toHaveLength(3);
    expect(api.sendMessageCalls[0]).toEqual({ chat_id: 99, text: "Thinking…" });
    expect(api.sendMessageCalls[1]?.text).toHaveLength(32);
    expect(api.sendMessageCalls[2]?.text).toHaveLength(6);
  });

  it("uses a bounded preview for long in-progress content", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 1,
      editDebounceMs: 0,
      maxMessageChars: 32,
    });

    await stream.append("x".repeat(60));
    await vi.runAllTimersAsync();

    expect(api.editMessageTextCalls[0]?.text).toHaveLength(32);
    expect(api.editMessageTextCalls[0]?.text.startsWith("…\n")).toBe(true);
  });

  it("does not substitute the placeholder for blank status updates", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 7,
      initialStatusText: "Working…",
      editDebounceMs: 0,
    });

    // Establish the message, then push a whitespace-only status update.
    await stream.status("first");
    await stream.status("   \n");

    const lastEdit = api.editMessageTextCalls.at(-1);
    expect(lastEdit?.text).toBe("");
    expect(lastEdit?.text).not.toBe("No response text was returned.");
  });

  it("substitutes the placeholder only when finishing with empty content", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({ api, chatId: 8, editDebounceMs: 0 });

    await stream.finish("   ");

    expect(api.editMessageTextCalls).toEqual([
      { chat_id: 8, message_id: 100, text: "No response text was returned." },
    ]);
  });

  it("propagates send and edit failures", async () => {
    const sendApi = new FakeTelegramApi();
    sendApi.failSendWith = new Error("send failed");
    const editApi = new FakeTelegramApi();
    editApi.failEditWith = new Error("edit failed");

    await expect(
      new TelegramMessageStream({ api: sendApi, chatId: 1 }).append("hello"),
    ).rejects.toThrow("send failed");

    await expect(
      new TelegramMessageStream({ api: editApi, chatId: 1 }).finish("done"),
    ).rejects.toThrow("edit failed");
  });
});

describe("splitTelegramText", () => {
  it("splits text without dropping characters", () => {
    expect(splitTelegramText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(splitTelegramText("abc", 10)).toEqual(["abc"]);
  });
});
