import { describe, expect, it, vi } from "vitest";

import {
  AgentResponderCancelledError,
  TelegramAdapter,
  type AgentRequest,
  type AgentResponder,
} from "../adapter.js";
import type {
  TelegramBotApi,
  TelegramEditMessageTextParams,
  TelegramGetUpdatesParams,
  TelegramRequestOptions,
  TelegramSendMessageParams,
  TelegramSentMessage,
  TelegramUpdate,
} from "../types.js";

class FakeTelegramApi implements TelegramBotApi {
  readonly sendMessageCalls: TelegramSendMessageParams[] = [];
  readonly editMessageTextCalls: TelegramEditMessageTextParams[] = [];
  nextMessageId = 500;

  async sendMessage(
    params: TelegramSendMessageParams,
    _options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage> {
    this.sendMessageCalls.push(params);
    return {
      message_id: this.nextMessageId++,
      chat: { id: params.chat_id },
      text: params.text,
    };
  }

  async editMessageText(
    params: TelegramEditMessageTextParams,
    _options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage | true> {
    this.editMessageTextCalls.push(params);
    return {
      message_id: params.message_id ?? 0,
      chat: { id: params.chat_id ?? 0 },
      text: params.text,
    };
  }

  async getUpdates(
    _params: TelegramGetUpdatesParams,
    _options?: TelegramRequestOptions,
  ): Promise<TelegramUpdate[]> {
    return [];
  }
}

describe("TelegramAdapter", () => {
  it("fails closed unless chats are explicitly allowed", () => {
    expect(
      () =>
        new TelegramAdapter({
          api: new FakeTelegramApi(),
          responder: responderFrom(async () => ({ text: "ok" })),
        }),
    ).toThrow(/allowedChatIds/);
  });

  it("handles /start and /help commands with deterministic replies", async () => {
    const api = new FakeTelegramApi();
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const bridge = new TelegramAdapter({ api, responder, allowAllChats: true });

    await expect(bridge.handleUpdate(textUpdate("/start"))).resolves.toMatchObject({
      kind: "handled",
      action: "command",
      command: "start",
    });
    await expect(bridge.handleUpdate(textUpdate("/help@ExampleBot"))).resolves.toMatchObject({
      kind: "handled",
      action: "command",
      command: "help",
    });

    expect(api.sendMessageCalls.map((call) => call.text)).toEqual([
      "Hello! Send me a text message and I will pass it to the configured agent.",
      "Send a text message to talk to the agent. Use /cancel to stop the current response.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("denies unauthorized chats without calling the responder", async () => {
    const api = new FakeTelegramApi();
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const bridge = new TelegramAdapter({
      api,
      responder,
      allowedChatIds: [99],
    });

    await expect(bridge.handleUpdate(textUpdate("hello", { chatId: 42 }))).resolves.toEqual({
      kind: "unauthorized",
      updateId: 1,
      chatId: 42,
    });

    expect(api.sendMessageCalls).toEqual([
      { chat_id: 42, text: "This Telegram chat is not authorized to use this bot." },
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("invokes the responder with a bounded Telegram agent request", async () => {
    const api = new FakeTelegramApi();
    const requests: AgentRequest[] = [];
    const bridge = new TelegramAdapter({
      api,
      allowAllChats: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request, stream) => {
        requests.push(request);
        await stream.append("partial");
        return { text: "final", metadata: { provider: "fake" } };
      }),
    });

    await expect(
      bridge.handleUpdate(textUpdate("  hello agent  ", { username: "alice" })),
    ).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
      metadata: { provider: "fake" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      conversationId: "telegram:42",
      chatId: 42,
      messageId: 10,
      updateId: 1,
      userId: 7,
      username: "alice",
      text: "hello agent",
      metadata: {
        telegram: {
          updateId: 1,
          chat: { id: 42, type: "private" },
          message: { id: 10, date: 1234 },
          from: { id: 7, username: "alice", firstName: "Alice" },
        },
      },
    });
    expect(requests[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(api.sendMessageCalls[0]).toEqual({
      chat_id: 42,
      text: "Thinking…",
      reply_to_message_id: 10,
    });
    expect(api.editMessageTextCalls.map((call) => call.text)).toEqual([
      "partial",
      "final",
    ]);
  });

  it("rejects unsupported messages without calling the responder", async () => {
    const api = new FakeTelegramApi();
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const bridge = new TelegramAdapter({ api, responder, allowAllChats: true });

    await expect(
      bridge.handleUpdate({
        update_id: 1,
        message: { message_id: 10, chat: { id: 42 }, sticker: { file_id: "s" } },
      }),
    ).resolves.toMatchObject({
      kind: "ignored",
      reason: "unsupported_message",
      chatId: 42,
    });

    expect(api.sendMessageCalls).toEqual([
      { chat_id: 42, text: "I can only handle text messages in this adapter for now." },
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("returns a deterministic busy result for concurrent chat messages", async () => {
    const api = new FakeTelegramApi();
    const deferred = createDeferred<{ text: string }>();
    const bridge = new TelegramAdapter({
      api,
      allowAllChats: true,
      responder: responderFrom(async () => deferred.promise),
    });

    const firstResultPromise = bridge.handleUpdate(textUpdate("first"));
    await Promise.resolve();
    await Promise.resolve();

    await expect(bridge.handleUpdate(textUpdate("second", { updateId: 2 }))).resolves.toEqual({
      kind: "busy",
      updateId: 2,
      chatId: 42,
    });
    expect(api.sendMessageCalls.at(-1)).toEqual({
      chat_id: 42,
      text: "I am still working on your previous message. Use /cancel to stop it.",
    });

    deferred.resolve({ text: "done" });
    await expect(firstResultPromise).resolves.toMatchObject({ kind: "handled" });
  });

  it("finishes with cancelled text when the responder reports cancellation", async () => {
    const api = new FakeTelegramApi();
    const bridge = new TelegramAdapter({
      api,
      allowAllChats: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => {
        throw new AgentResponderCancelledError();
      }),
    });

    await expect(bridge.handleUpdate(textUpdate("please stop"))).resolves.toEqual({
      kind: "cancelled",
      updateId: 1,
      chatId: 42,
    });
    expect(api.editMessageTextCalls.at(-1)?.text).toBe("Cancelled.");
  });

  it("aborts the active run when /cancel is received", async () => {
    const api = new FakeTelegramApi();
    let capturedSignal: AbortSignal | undefined;
    const responderStarted = createDeferred<void>();
    const bridge = new TelegramAdapter({
      api,
      allowAllChats: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(
        async (request) =>
          await new Promise<{ text: string }>((resolve) => {
            capturedSignal = request.abortSignal;
            request.abortSignal.addEventListener(
              "abort",
              () => resolve({ text: "should not be used" }),
              { once: true },
            );
            responderStarted.resolve(undefined);
          }),
      ),
    });

    const firstResultPromise = bridge.handleUpdate(textUpdate("long task"));
    await responderStarted.promise;

    await expect(bridge.handleUpdate(textUpdate("/cancel", { updateId: 2 }))).resolves.toEqual({
      kind: "cancelled",
      updateId: 2,
      chatId: 42,
    });
    expect(capturedSignal?.aborted).toBe(true);
    await expect(firstResultPromise).resolves.toEqual({
      kind: "cancelled",
      updateId: 1,
      chatId: 42,
    });
    expect(api.sendMessageCalls.some((call) => call.text === "Cancelled.")).toBe(true);
    expect(api.editMessageTextCalls.at(-1)?.text).toBe("Cancelled.");
  });
});

function responderFrom(
  respond: AgentResponder["respond"],
): AgentResponder {
  return { respond };
}

function textUpdate(
  text: string,
  options?: { chatId?: number; updateId?: number; username?: string },
): TelegramUpdate {
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: options?.chatId ?? 42, type: "private" },
      from: {
        id: 7,
        first_name: "Alice",
        username: options?.username ?? "alice",
      },
      text,
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
