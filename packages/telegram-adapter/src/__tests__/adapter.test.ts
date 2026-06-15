import { AgentResponseCancelledError } from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  TelegramAdapter,
  type AgentRequest,
  type AgentResponder,
} from "../adapter.js";
import { TelegramApiError } from "../telegram-client.js";
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
  rejectDuplicateEdits = false;
  private readonly lastEditTextByMessageId = new Map<number, string>();

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
    if (this.rejectDuplicateEdits && params.message_id !== undefined) {
      const previousText = this.lastEditTextByMessageId.get(params.message_id);
      if (previousText === params.text) {
        throw new Error("Bad Request: message is not modified");
      }
      this.lastEditTextByMessageId.set(params.message_id, params.text);
    }
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
      bridge.handleUpdate(textUpdate("  hello agent  ", { username: "person_a" })),
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
      username: "person_a",
      text: "hello agent",
      metadata: {
        telegram: {
          updateId: 1,
          chat: { id: 42, type: "private" },
          message: { id: 10, date: 1234 },
          from: { id: 7, username: "person_a", firstName: "Person A" },
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

  it("keeps a successful run successful when the final streamed text is unchanged", async () => {
    const api = new FakeTelegramApi();
    api.rejectDuplicateEdits = true;
    const bridge = new TelegramAdapter({
      api,
      allowAllChats: true,
      stream: { editDebounceMs: 0, showThoughts: false },
      messages: {
        errorText: "The agent failed honestly; check the local artifact summary for details.",
      },
      responder: responderFrom(async (_request, stream) => {
        await stream.event?.({ type: "assistant_thought", text: "I" });
        await stream.event?.({ type: "assistant_thought", text: " see" });
        await stream.append("Final answer.");
        return {
          text: "Final answer.",
          metadata: { summary: { status: "succeeded" } },
        };
      }),
    });

    await expect(bridge.handleUpdate(textUpdate("hello"))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
      metadata: { summary: { status: "succeeded" } },
    });

    expect(api.sendMessageCalls.map((call) => call.text)).toEqual(["Thinking…"]);
    expect(api.editMessageTextCalls.map((call) => call.text)).toEqual([
      "Final answer.",
    ]);
    expect(api.sendMessageCalls.some((call) => call.text.includes("failed honestly"))).toBe(false);
    expect(api.editMessageTextCalls.some((call) => call.text.includes("I see"))).toBe(false);
  });

  it("keeps an AI success non-error when every Telegram delivery path fails", async () => {
    const fatal = new TelegramApiError("Telegram API rejected the request.", {
      kind: "telegram",
      method: "sendMessage",
      errorCode: 403,
      telegramDescription: "Forbidden: bot was blocked by the user",
    });
    let sendCount = 0;
    const api: TelegramBotApi = {
      async sendMessage(params) {
        sendCount += 1;
        if (sendCount === 1) {
          return { message_id: 700, chat: { id: params.chat_id }, text: params.text };
        }
        throw fatal;
      },
      async editMessageText() {
        throw fatal;
      },
      async getUpdates() {
        return [];
      },
    };
    const bridge = new TelegramAdapter({
      api,
      allowAllChats: true,
      stream: { editDebounceMs: 0 },
      messages: { errorText: "THE AGENT FAILED" },
      responder: responderFrom(async () => ({
        text: "the real answer",
        metadata: { ok: true },
      })),
    });

    // AI succeeded; even though no delivery path works, this is NOT an error.
    await expect(bridge.handleUpdate(textUpdate("hello"))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
      delivery: "degraded",
      metadata: { ok: true },
    });
  });

  it("recovers when the initial placeholder send fails but the agent still answers", async () => {
    let sendCount = 0;
    const editTexts: string[] = [];
    const api: TelegramBotApi = {
      async sendMessage(params) {
        sendCount += 1;
        if (sendCount === 1) {
          throw new TelegramApiError("Telegram API sendMessage failed.", {
            kind: "network",
            method: "sendMessage",
          });
        }
        return { message_id: 900, chat: { id: params.chat_id }, text: params.text };
      },
      async editMessageText(params) {
        editTexts.push(params.text);
        return { message_id: params.message_id ?? 0, chat: { id: params.chat_id ?? 0 }, text: params.text };
      },
      async getUpdates() {
        return [];
      },
    };
    const bridge = new TelegramAdapter({
      api,
      allowAllChats: true,
      stream: { editDebounceMs: 0 },
      messages: { errorText: "THE AGENT FAILED" },
      responder: responderFrom(async (_request, stream) => {
        await stream.append("the answer");
        return { text: "the answer" };
      }),
    });

    // A transient placeholder-send failure must not be reported as an AI error.
    await expect(bridge.handleUpdate(textUpdate("hello"))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });
    expect(editTexts).toContain("the answer");
    expect(editTexts).not.toContain("THE AGENT FAILED");
  });

  it("keeps the run successful when an interim streamed edit fails", async () => {
    let editCount = 0;
    const api: TelegramBotApi = {
      async sendMessage(params) {
        return { message_id: 800, chat: { id: params.chat_id }, text: params.text };
      },
      async editMessageText(params) {
        editCount += 1;
        if (editCount === 1) {
          throw new TelegramApiError("Telegram API editMessageText failed.", {
            kind: "network",
            method: "editMessageText",
          });
        }
        return { message_id: params.message_id ?? 0, chat: { id: params.chat_id ?? 0 }, text: params.text };
      },
      async getUpdates() {
        return [];
      },
    };
    const bridge = new TelegramAdapter({
      api,
      allowAllChats: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.append("streaming partial");
        return { text: "final answer" };
      }),
    });

    await expect(bridge.handleUpdate(textUpdate("hello"))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
      delivery: "ok",
    });
    // The interim edit failed (and was swallowed); the final edit succeeded.
    expect(editCount).toBe(2);
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
        throw new AgentResponseCancelledError();
      }),
    });

    await expect(bridge.handleUpdate(textUpdate("please stop"))).resolves.toEqual({
      kind: "cancelled",
      updateId: 1,
      chatId: 42,
    });
    expect(api.editMessageTextCalls.at(-1)?.text).toBe("Cancelled.");
  });

  it("lets hosts derive terminal error text from responder failure details", async () => {
    const api = new FakeTelegramApi();
    const bridge = new TelegramAdapter({
      api,
      allowAllChats: true,
      stream: { editDebounceMs: 0 },
      messages: {
        errorText: ({ error, request }) => {
          const failure = (error as { failure?: { kind?: string } }).failure;
          return failure?.kind === "usage_limit"
            ? `I hit the turn limit while handling "${request.text}".`
            : "I could not complete that message.";
        },
      },
      responder: responderFrom(async () => {
        throw Object.assign(new Error("Provider limit"), {
          failure: { kind: "usage_limit", message: "Provider limit" },
        });
      }),
    });

    await expect(bridge.handleUpdate(textUpdate("check calendar"))).resolves.toMatchObject({
      kind: "error",
      updateId: 1,
      chatId: 42,
    });

    expect(api.editMessageTextCalls.at(-1)?.text).toBe(
      'I hit the turn limit while handling "check calendar".',
    );
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
        first_name: "Person A",
        username: options?.username ?? "person_a",
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
