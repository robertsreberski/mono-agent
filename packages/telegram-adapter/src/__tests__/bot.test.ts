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
      "Hello! Send me a text message and I will pass it to the configured agent.",
      "Send a text message to talk to the agent. Use /cancel to stop the current response.",
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
    expect(texts(calls, "editMessageText")).toEqual(["partial", "final"]);
  });

  it("hides thoughts when disabled and delivers only the final answer", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0, showThoughts: false },
      responder: responderFrom(async (_request, stream) => {
        await stream.event?.({ type: "assistant_thought", text: "secret" });
        await stream.append("the answer");
        return { text: "the answer" };
      }),
    });

    await bot.handleUpdate(textUpdate("hello"));

    expect(texts(calls, "editMessageText")).toEqual(["the answer"]);
    expect(calls.some((call) => String(call.payload.text).includes("secret"))).toBe(false);
  });

  it("replies busy for a second concurrent message in the same chat", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<{ text: string }>();
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => {
        started.resolve();
        return finish.promise;
      }),
    });

    const first = bot.handleUpdate(textUpdate("first"));
    await started.promise;

    await bot.handleUpdate(textUpdate("second", { updateId: 2 }));

    expect(texts(calls, "sendMessage").at(-1)).toBe(
      "I am still working on your previous message. Use /cancel to stop it.",
    );

    finish.resolve({ text: "done" });
    await first;
  });

  it("rejects non-text messages as unsupported", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({ responder });

    await bot.handleUpdate(stickerUpdate());

    expect(texts(calls, "sendMessage")).toEqual([
      "I can only handle text messages in this adapter for now.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
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
    const { bot, calls } = buildTestBot({
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
            started.resolve();
          }),
      ),
    });

    const first = bot.handleUpdate(textUpdate("long task"));
    await started.promise;

    await bot.handleUpdate(commandUpdate("/cancel", { updateId: 2 }));

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
});
