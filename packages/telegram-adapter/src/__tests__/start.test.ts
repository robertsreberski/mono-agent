import { describe, expect, it, vi } from "vitest";

import { startTelegramAdapter, type TelegramPollerLike } from "../start.js";
import type { AgentResponder } from "../adapter.js";
import type {
  TelegramBotApi,
  TelegramEditMessageTextParams,
  TelegramGetUpdatesParams,
  TelegramRequestOptions,
  TelegramSendMessageParams,
  TelegramSentMessage,
  TelegramUpdate,
} from "../types.js";
import type {
  TelegramLongPollerOptions,
  TelegramLongPollerStartOptions,
  TelegramUpdateHandler,
} from "../long-poller.js";

class FakeTelegramApi implements TelegramBotApi {
  readonly sendMessageCalls: TelegramSendMessageParams[] = [];
  readonly editMessageTextCalls: TelegramEditMessageTextParams[] = [];
  nextMessageId = 900;

  async sendMessage(
    params: TelegramSendMessageParams,
    _options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage> {
    this.sendMessageCalls.push(params);
    return { message_id: this.nextMessageId++, chat: { id: params.chat_id }, text: params.text };
  }

  async editMessageText(
    params: TelegramEditMessageTextParams,
    _options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage | true> {
    this.editMessageTextCalls.push(params);
    return { message_id: params.message_id ?? 0, chat: { id: params.chat_id ?? 0 }, text: params.text };
  }

  async getUpdates(
    _params: TelegramGetUpdatesParams,
    _options?: TelegramRequestOptions,
  ): Promise<TelegramUpdate[]> {
    return [];
  }

  async deleteWebhook(): Promise<true> {
    return true;
  }
}

/**
 * Fake poller that captures the wired adapter and start signal without ever
 * touching Telegram. start() resolves once the injected signal aborts, so
 * stop() can prove the poll loop settles.
 */
class FakePoller implements TelegramPollerLike {
  startCalls = 0;
  capturedSignal: AbortSignal | undefined;
  readonly options: TelegramLongPollerOptions;

  constructor(options: TelegramLongPollerOptions) {
    this.options = options;
  }

  get adapter(): TelegramUpdateHandler {
    return this.options.adapter;
  }

  start(options: TelegramLongPollerStartOptions = {}): Promise<void> {
    this.startCalls += 1;
    this.capturedSignal = options.signal;
    return new Promise<void>((resolve) => {
      if (options.signal?.aborted === true) {
        resolve();
        return;
      }
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

function messageUpdate(text: string, chatId = 42, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    message: { message_id: 10, chat: { id: chatId }, from: { id: 7 }, text },
  };
}

describe("startTelegramAdapter", () => {
  it("wires the client + adapter + poller and starts polling", async () => {
    const api = new FakeTelegramApi();
    let capturedToken: string | undefined;
    let fakePoller: FakePoller | undefined;

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      clientFactory: (options) => {
        capturedToken = options.token;
        return api;
      },
      pollerFactory: (options) => {
        fakePoller = new FakePoller(options);
        return fakePoller;
      },
    });

    expect(capturedToken).toBe("test-token");
    expect(fakePoller?.startCalls).toBe(1);
    expect(fakePoller?.capturedSignal).toBeInstanceOf(AbortSignal);
    expect(fakePoller?.options.api).toBe(api);
    expect(fakePoller?.options.deleteWebhookOnStart).toBe(true);
    expect(fakePoller?.options.allowedUpdates).toEqual(["message"]);

    await result.stop();
  });

  it("routes a fake update through the wired adapter to the responder", async () => {
    const api = new FakeTelegramApi();
    const respondCalls: Array<{ text: string; chatId: unknown }> = [];
    const responder: AgentResponder = {
      async respond(request) {
        respondCalls.push({ text: request.text, chatId: request.chatId });
        return { text: "pong" };
      },
    };
    let fakePoller: FakePoller | undefined;

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowedChatIds: [42],
      responder,
      stream: { editDebounceMs: 0 },
      clientFactory: () => api,
      pollerFactory: (options) => {
        fakePoller = new FakePoller(options);
        return fakePoller;
      },
    });

    const handled = await fakePoller!.adapter.handleUpdate(messageUpdate("ping"));

    expect(handled).toMatchObject({ kind: "handled", action: "responded", chatId: 42 });
    expect(respondCalls).toEqual([{ text: "ping", chatId: 42 }]);

    await result.stop();
  });

  it("stop() aborts the poll signal and settles the start promise", async () => {
    const api = new FakeTelegramApi();
    let fakePoller: FakePoller | undefined;

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      clientFactory: () => api,
      pollerFactory: (options) => {
        fakePoller = new FakePoller(options);
        return fakePoller;
      },
    });

    expect(fakePoller?.capturedSignal?.aborted).toBe(false);

    await result.stop();

    expect(fakePoller?.capturedSignal?.aborted).toBe(true);
    // Second stop is a no-op and still resolves.
    await expect(result.stop()).resolves.toBeUndefined();
  });

  it("fails closed when neither allowedChatIds nor allowAllChats is provided", async () => {
    await expect(
      startTelegramAdapter({
        botToken: "test-token",
        responder: { respond: vi.fn() } satisfies AgentResponder,
        clientFactory: () => new FakeTelegramApi(),
        pollerFactory: (options) => new FakePoller(options),
      }),
    ).rejects.toThrow(/allowedChatIds/);
  });
});
