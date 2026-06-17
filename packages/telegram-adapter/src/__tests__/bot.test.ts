import { AgentResponseCancelledError } from "@mono-agent/agent-contracts";
import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { AgentRequest, AgentResponder, TelegramAdapterLogger } from "../adapter.js";
import { createTelegramBot, type CreateTelegramBotOptions } from "../bot.js";

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "Example Bot",
  username: "ExampleBot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

function buildTestBot(
  options: Partial<CreateTelegramBotOptions> & { responder: AgentResponder },
): {
  bot: Bot;
  calls: RecordedCall[];
  failures: Map<string, () => unknown>;
} {
  const calls: RecordedCall[] = [];
  const failures = new Map<string, () => unknown>();
  let nextMessageId = 1000;

  const controller = createTelegramBot({
    botToken: "test-token",
    allowAllChats: true,
    ...options,
    botFactory: () => {
      const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
      bot.api.config.use(async (_prev, method, payload) => {
        const typedPayload = payload as Record<string, unknown>;
        calls.push({ method, payload: typedPayload });
        const override = failures.get(method);
        if (override !== undefined) {
          return override() as never;
        }
        if (method === "sendMessage") {
          return ok({
            message_id: nextMessageId++,
            date: 0,
            chat: { id: typedPayload.chat_id, type: "private" },
            text: typedPayload.text,
          });
        }
        if (method === "editMessageText") {
          return ok({
            message_id: typedPayload.message_id ?? 0,
            date: 0,
            chat: { id: typedPayload.chat_id, type: "private" },
            text: typedPayload.text,
          });
        }
        return ok(true);
      });
      return bot;
    },
  });

  return { bot: controller.bot, calls, failures };
}

function ok(result: unknown): never {
  return { ok: true, result } as never;
}

function err(errorCode: number, description: string): never {
  return { ok: false, error_code: errorCode, description, parameters: {} } as never;
}

function textUpdate(
  text: string,
  options?: { chatId?: number; updateId?: number; username?: string },
): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: options?.chatId ?? 42, type: "private" },
      from: {
        id: 7,
        is_bot: false,
        first_name: "Person A",
        username: options?.username ?? "person_a",
      },
      text,
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function commandUpdate(
  command: string,
  options?: { chatId?: number; updateId?: number },
): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: options?.chatId ?? 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
      text: command,
      entities: [{ type: "bot_command", offset: 0, length: command.length }],
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function stickerUpdate(): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A" },
      sticker: { file_id: "s", file_unique_id: "u", width: 1, height: 1, type: "regular", is_animated: false, is_video: false },
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function animationUpdate(): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A" },
      animation: {
        file_id: "animation-file-id",
        file_unique_id: "animation-unique-id",
        width: 320,
        height: 240,
        duration: 3,
        file_name: "funny.gif",
        mime_type: "image/gif",
        file_size: 20_000,
      },
      document: {
        file_id: "animation-file-id",
        file_unique_id: "animation-unique-id",
        file_name: "funny.gif",
        mime_type: "image/gif",
        file_size: 20_000,
      },
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function documentUpdate(
  options?: { caption?: string; updateId?: number },
): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
      caption: options?.caption,
      document: {
        file_id: "doc-file-id",
        file_unique_id: "doc-unique-id",
        file_name: "brief.pdf",
        mime_type: "application/pdf",
        file_size: 12_345,
      },
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function photoUpdate(options?: { caption?: string; updateId?: number }): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
      caption: options?.caption,
      photo: [
        {
          file_id: "photo-small-id",
          file_unique_id: "photo-small-unique",
          width: 160,
          height: 90,
          file_size: 1_024,
        },
        {
          file_id: "photo-large-id",
          file_unique_id: "photo-large-unique",
          width: 1280,
          height: 720,
          file_size: 65_536,
        },
      ],
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function voiceUpdate(options?: { caption?: string; updateId?: number }): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
      caption: options?.caption,
      voice: {
        file_id: "voice-file-id",
        file_unique_id: "voice-unique-id",
        duration: 17,
        mime_type: "audio/ogg",
        file_size: 23_456,
      },
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function responderFrom(respond: AgentResponder["respond"]): AgentResponder {
  return { respond };
}

function texts(calls: RecordedCall[], method: string): unknown[] {
  return calls.filter((call) => call.method === method).map((call) => call.payload.text);
}

function lastEditText(calls: RecordedCall[]): unknown {
  return calls.filter((call) => call.method === "editMessageText").at(-1)?.payload.text;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("createTelegramBot", () => {
  it("fails closed unless chats are explicitly allowed", () => {
    expect(() =>
      createTelegramBot({
        botToken: "test-token",
        responder: responderFrom(async () => ({ text: "ok" })),
        botFactory: () => new Bot("test-token", { botInfo: FAKE_BOT_INFO }),
      }),
    ).toThrow(/allowedChatIds/);
  });

  it("answers /start and /help with deterministic plain replies", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({ responder });

    await bot.handleUpdate(commandUpdate("/start"));
    await bot.handleUpdate(commandUpdate("/help@ExampleBot", { updateId: 2 }));

    expect(texts(calls, "sendMessage")).toEqual([
      "Hello! Send text or Telegram media. I will pass captions and attachment metadata to the configured agent.",
      "Send text, documents, photos, audio, video, or voice messages. I forward captions and Telegram attachment metadata, not file contents. Use /cancel to stop the current response.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("denies unauthorized chats without calling the responder", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({
      responder,
      allowAllChats: false,
      allowedChatIds: [99],
    });

    await bot.handleUpdate(textUpdate("hello", { chatId: 42 }));

    expect(texts(calls, "sendMessage")).toEqual([
      "This Telegram chat is not authorized to use this bot.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("invokes the responder with a bounded request and streams the answer", async () => {
    const requests: AgentRequest[] = [];
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request, stream) => {
        requests.push(request);
        await stream.append("partial");
        return { text: "final", metadata: { provider: "fake" } };
      }),
    });

    await bot.handleUpdate(textUpdate("  hello agent  ", { username: "person_a" }));

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

    const placeholder = calls.find((call) => call.method === "sendMessage");
    expect(placeholder?.payload).toMatchObject({
      chat_id: 42,
      text: "Thinking…",
      reply_parameters: { message_id: 10 },
    });
    expect(texts(calls, "editMessageText")).toEqual([
      "partial",
      "final",
    ]);
  });

  it("handles Telegram file attachments with caption text", async () => {
    const requests: AgentRequest[] = [];
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "received document" };
      }),
    });

    await bot.handleUpdate(documentUpdate({ caption: "Please summarize this" }));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      text: "Please summarize this",
      attachments: [
        {
          kind: "document",
          fileId: "doc-file-id",
          fileUniqueId: "doc-unique-id",
          fileName: "brief.pdf",
          mimeType: "application/pdf",
          fileSize: 12_345,
        },
      ],
      metadata: {
        telegram: {
          attachments: [
            {
              kind: "document",
              fileId: "doc-file-id",
              fileUniqueId: "doc-unique-id",
              fileName: "brief.pdf",
              mimeType: "application/pdf",
              fileSize: 12_345,
            },
          ],
        },
      },
    });
    expect(texts(calls, "sendMessage")).not.toContain(
      "I can handle text and Telegram document, photo, audio, video, or voice metadata in this adapter.",
    );
  });

  it("handles Telegram photo attachments without captions using a text summary", async () => {
    const requests: AgentRequest[] = [];
    const { bot } = buildTestBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "received photo" };
      }),
    });

    await bot.handleUpdate(photoUpdate());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toContain("Telegram photo");
    expect(requests[0]?.attachments).toEqual([
      {
        kind: "photo",
        fileId: "photo-large-id",
        fileUniqueId: "photo-large-unique",
        fileSize: 65_536,
        width: 1280,
        height: 720,
        sizes: [
          {
            fileId: "photo-small-id",
            fileUniqueId: "photo-small-unique",
            fileSize: 1_024,
            width: 160,
            height: 90,
          },
          {
            fileId: "photo-large-id",
            fileUniqueId: "photo-large-unique",
            fileSize: 65_536,
            width: 1280,
            height: 720,
          },
        ],
      },
    ]);
  });

  it("handles Telegram voice attachments with a duration summary", async () => {
    const requests: AgentRequest[] = [];
    const { bot } = buildTestBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "received voice" };
      }),
    });

    await bot.handleUpdate(voiceUpdate());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toContain("17s");
    expect(requests[0]?.attachments).toEqual([
      {
        kind: "voice",
        fileId: "voice-file-id",
        fileUniqueId: "voice-unique-id",
        duration: 17,
        mimeType: "audio/ogg",
        fileSize: 23_456,
      },
    ]);
  });

  it("never renders reasoning and delivers only the final answer text", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.event?.({ type: "assistant_thought", text: "secret" });
        await stream.append("the answer");
        return { text: "the answer" };
      }),
    });

    await bot.handleUpdate(textUpdate("hello"));

    // The reasoning is never rendered; the answer streams as plain text (no
    // label) and the final edit re-renders it as MarkdownV2.
    expect(texts(calls, "editMessageText")).toEqual([
      "the answer",
      "the answer",
    ]);
    const finalEdit = calls.filter((call) => call.method === "editMessageText").at(-1);
    expect(finalEdit?.payload.parse_mode).toBe("MarkdownV2");
    expect(calls.some((call) => String(call.payload.text).includes("secret"))).toBe(false);
  });

  it("surfaces a friendly activity hint for tool_call_started, never the raw tool name", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.event?.({ type: "tool_call_started", id: "t1", name: "WebSearch" });
        await stream.append("the answer");
        return { text: "the answer" };
      }),
    });

    await bot.handleUpdate(textUpdate("look it up"));

    const editTexts = texts(calls, "editMessageText");
    // The friendly hint shows while working, then is replaced by the answer.
    expect(editTexts).toContain("Searching the web…");
    expect(editTexts.some((text) => String(text).includes("WebSearch"))).toBe(false);
    expect(editTexts.at(-1)).toBe("the answer");
  });

  it("replaces hint-only bot runs with an explicit final placeholder", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.event({ type: "tool_call_started", id: "t1", name: "todoist" });
        return {};
      }),
    });

    await bot.handleUpdate(textUpdate("clean up todoist"));

    expect(texts(calls, "editMessageText")).toEqual([
      "Checking your tasks…",
      "No response text was returned\\.",
    ]);
    const finalEdit = calls.filter((call) => call.method === "editMessageText").at(-1);
    expect(finalEdit?.payload.parse_mode).toBe("MarkdownV2");
  });

  it("preserves streamed bot answers when the responder returns no text", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.append("streamed answer");
        return {};
      }),
    });

    await bot.handleUpdate(textUpdate("stream only"));

    expect(texts(calls, "editMessageText")).toEqual([
      "streamed answer",
      "streamed answer",
    ]);
    const finalEdit = calls.filter((call) => call.method === "editMessageText").at(-1);
    expect(finalEdit?.payload.parse_mode).toBe("MarkdownV2");
  });

  it("does not reject a second concurrent message in the same chat", async () => {
    const started: string[] = [];
    const firstFinish = createDeferred<{ text: string }>();
    const secondFinish = createDeferred<{ text: string }>();
    const received: string[] = [];
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        received.push(request.text);
        if (received.length === 1) {
          started.push("first");
          return firstFinish.promise;
        }
        started.push("second");
        return secondFinish.promise;
      }),
    });

    const first = bot.handleUpdate(textUpdate("first"));
    // Wait until the first run is actually in the responder.
    while (started.length === 0) {
      await Promise.resolve();
    }

    const second = bot.handleUpdate(textUpdate("second", { updateId: 2 }));
    // Both messages reach the responder — no "busy" rejection. The harness is
    // responsible for serializing per conversation, so the channel must not
    // refuse the follow-up.
    while (received.length < 2) {
      await Promise.resolve();
    }
    expect(received).toEqual(["first", "second"]);
    expect(
      texts(calls, "sendMessage").includes(
        "I am still working on your previous message. Use /cancel to stop it.",
      ),
    ).toBe(false);

    firstFinish.resolve({ text: "done one" });
    secondFinish.resolve({ text: "done two" });
    await first;
    await second;
  });

  it("rejects non-text messages as unsupported", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({ responder });

    await bot.handleUpdate(stickerUpdate());

    expect(texts(calls, "sendMessage")).toEqual([
      "I can handle text and Telegram document, photo, audio, video, or voice metadata in this adapter.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("rejects Telegram animation documents as unsupported", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({ responder });

    await bot.handleUpdate(animationUpdate());

    expect(texts(calls, "sendMessage")).toEqual([
      "I can handle text and Telegram document, photo, audio, video, or voice metadata in this adapter.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("treats media captions with /cancel as control commands", async () => {
    let capturedSignal: AbortSignal | undefined;
    const started = createDeferred<void>();
    const cancelCalls: string[] = [];
    const responder: AgentResponder = {
      respond: async (request) =>
        await new Promise<{ text: string }>((resolve) => {
          capturedSignal = request.abortSignal;
          request.abortSignal.addEventListener(
            "abort",
            () => resolve({ text: "should not be used" }),
            { once: true },
          );
          started.resolve();
        }),
      cancel: (conversationId) => {
        cancelCalls.push(conversationId);
      },
    };
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder,
    });

    const first = bot.handleUpdate(textUpdate("long task"));
    await started.promise;

    await bot.handleUpdate(documentUpdate({ caption: "/cancel", updateId: 2 }));

    // /cancel clears queued follow-ups via responder.cancel AND aborts the live run.
    expect(cancelCalls).toEqual(["telegram:42"]);
    expect(capturedSignal?.aborted).toBe(true);
    await first;
    expect(texts(calls, "sendMessage")).toContain("Cancelled.");
    expect(lastEditText(calls)).toBe("Cancelled.");
  });

  it("ignores media caption commands targeted at another bot", async () => {
    const signals: AbortSignal[] = [];
    const received: string[] = [];
    const finishers: Array<(value: { text: string }) => void> = [];
    const { bot } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        signals.push(request.abortSignal);
        received.push(request.text);
        return await new Promise<{ text: string }>((resolve) => {
          finishers.push(resolve);
        });
      }),
    });

    const first = bot.handleUpdate(textUpdate("long task"));
    while (received.length === 0) {
      await Promise.resolve();
    }

    // A caption command aimed at another bot is NOT our /cancel, so it is treated
    // as an ordinary media message and reaches the responder (no busy rejection,
    // no cancellation of the in-flight run).
    const second = bot.handleUpdate(documentUpdate({ caption: "/cancel@OtherBot", updateId: 2 }));
    while (received.length < 2) {
      await Promise.resolve();
    }

    expect(signals.every((signal) => signal.aborted === false)).toBe(true);

    finishers.forEach((resolve) => resolve({ text: "done" }));
    await first;
    await second;
  });

  it("finishes with plain cancelled text when the responder reports cancellation", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => {
        throw new AgentResponseCancelledError();
      }),
    });

    await bot.handleUpdate(textUpdate("please stop"));

    expect(lastEditText(calls)).toBe("Cancelled.");
    expect(
      calls.filter((call) => call.method === "editMessageText").at(-1)?.payload.parse_mode,
    ).toBeUndefined();
  });

  it("lets hosts derive terminal error text from responder failure details", async () => {
    const { bot, calls } = buildTestBot({
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

    await bot.handleUpdate(textUpdate("check calendar"));

    expect(lastEditText(calls)).toBe('I hit the turn limit while handling "check calendar".');
  });

  it("aborts the active run when /cancel is received and acks it", async () => {
    let capturedSignal: AbortSignal | undefined;
    const started = createDeferred<void>();
    const cancelCalls: string[] = [];
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: {
        respond: async (request) =>
          await new Promise<{ text: string }>((resolve) => {
            capturedSignal = request.abortSignal;
            request.abortSignal.addEventListener(
              "abort",
              () => resolve({ text: "should not be used" }),
              { once: true },
            );
            started.resolve();
          }),
        cancel: (conversationId) => {
          cancelCalls.push(conversationId);
        },
      },
    });

    const first = bot.handleUpdate(textUpdate("long task"));
    await started.promise;

    await bot.handleUpdate(commandUpdate("/cancel", { updateId: 2 }));

    // /cancel clears queued follow-ups via responder.cancel and aborts the live run.
    expect(cancelCalls).toEqual(["telegram:42"]);
    expect(capturedSignal?.aborted).toBe(true);
    await first;

    // The /cancel command acks with plain cancelled text…
    expect(texts(calls, "sendMessage")).toContain("Cancelled.");
    // …and the in-flight run's placeholder is also resolved to cancelled text.
    expect(lastEditText(calls)).toBe("Cancelled.");
  });

  it("does not throw when every delivery path fails after a successful run", async () => {
    const errors: string[] = [];
    const logger: TelegramAdapterLogger = {
      error: (message) => errors.push(message),
    };
    const { bot, failures } = buildTestBot({
      stream: { editDebounceMs: 0 },
      logger,
      responder: responderFrom(async () => ({ text: "the real answer" })),
    });

    // Editing the placeholder always fails fatally (no retry, no recreate).
    failures.set("editMessageText", () => err(403, "Forbidden: bot was blocked by the user"));
    // The placeholder send works once; the last-resort fresh send fails too.
    let sends = 0;
    failures.set("sendMessage", () => {
      sends += 1;
      if (sends === 1) {
        return ok({ message_id: 1, date: 0, chat: { id: 42, type: "private" }, text: "Thinking…" });
      }
      return err(403, "Forbidden: bot was blocked by the user");
    });

    // The AI run succeeded, so a delivery failure must not throw out of the handler.
    await expect(bot.handleUpdate(textUpdate("hello"))).resolves.toBeUndefined();
    expect(errors.some((message) => message.includes("final delivery"))).toBe(true);
  });

  it("reports a post-start polling crash via onPollingError", async () => {
    const crashes: unknown[] = [];
    const failure = new Error("polling crashed");
    const controller = createTelegramBot({
      botToken: "test-token",
      allowAllChats: true,
      responder: responderFrom(async () => ({ text: "ok" })),
      onPollingError: (error) => crashes.push(error),
      botFactory: () => {
        const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
        bot.api.config.use(async () => ok(true));
        return bot;
      },
      runnerFactory: () => ({
        start: () => undefined,
        stop: () => Promise.resolve(),
        size: () => 0,
        isRunning: () => true,
        task: () => Promise.reject(failure),
      }),
    });

    await controller.start();
    // Let the task().catch microtask run.
    await Promise.resolve();
    await Promise.resolve();

    expect(crashes).toEqual([failure]);
    await controller.stop();
  });
});
