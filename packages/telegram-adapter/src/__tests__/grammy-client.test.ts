import { GrammyError, HttpError } from "grammy";
import type { Api } from "grammy";
import { describe, expect, it } from "vitest";

import { createGrammyTelegramApi } from "../grammy-client.js";
import { TelegramApiError } from "../telegram-error.js";

interface RecordedCall {
  args: unknown[];
}

function recordingApi(
  handlers: {
    sendMessage?: (...args: unknown[]) => unknown;
    editMessageText?: (...args: unknown[]) => unknown;
    editMessageTextInline?: (...args: unknown[]) => unknown;
  },
): { api: Api; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const api = {
    async sendMessage(...args: unknown[]) {
      calls.push({ args });
      return handlers.sendMessage?.(...args);
    },
    async editMessageText(...args: unknown[]) {
      calls.push({ args });
      return handlers.editMessageText?.(...args);
    },
    async editMessageTextInline(...args: unknown[]) {
      calls.push({ args });
      return handlers.editMessageTextInline?.(...args);
    },
  } as unknown as Api;
  return { api, calls };
}

describe("createGrammyTelegramApi", () => {
  it("translates sendMessage params into grammY positional args plus options", async () => {
    const { api, calls } = recordingApi({
      sendMessage: (chat_id, text) => ({
        message_id: 7,
        chat: { id: chat_id },
        text,
      }),
    });
    const client = createGrammyTelegramApi(api);

    const message = await client.sendMessage({
      chat_id: 42,
      text: "hi",
      parse_mode: "MarkdownV2",
      reply_to_message_id: 5,
      disable_web_page_preview: true,
    });

    expect(calls[0]?.args[0]).toBe(42);
    expect(calls[0]?.args[1]).toBe("hi");
    expect(calls[0]?.args[2]).toEqual({
      parse_mode: "MarkdownV2",
      reply_parameters: { message_id: 5 },
      link_preview_options: { is_disabled: true },
    });
    expect(message.message_id).toBe(7);
  });

  it("translates editMessageText params into grammY positional args", async () => {
    const { api, calls } = recordingApi({ editMessageText: () => true });
    const client = createGrammyTelegramApi(api);

    const result = await client.editMessageText({
      chat_id: 1,
      message_id: 9,
      text: "x",
      parse_mode: "MarkdownV2",
    });

    expect(calls[0]?.args.slice(0, 3)).toEqual([1, 9, "x"]);
    expect(calls[0]?.args[3]).toEqual({ parse_mode: "MarkdownV2" });
    expect(result).toBe(true);
  });

  it("routes inline-message edits to editMessageTextInline", async () => {
    const { api, calls } = recordingApi({ editMessageTextInline: () => true });
    const client = createGrammyTelegramApi(api);

    const result = await client.editMessageText({
      inline_message_id: "inline-1",
      text: "x",
      parse_mode: "MarkdownV2",
    });

    expect(calls[0]?.args.slice(0, 2)).toEqual(["inline-1", "x"]);
    expect(calls[0]?.args[2]).toEqual({ parse_mode: "MarkdownV2" });
    expect(result).toBe(true);
  });

  it("maps a GrammyError to a TelegramApiError carrying retry_after", async () => {
    const { api } = recordingApi({
      sendMessage: () => {
        throw new GrammyError(
          "Call to 'sendMessage' failed!",
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 3",
            parameters: { retry_after: 3 },
          },
          "sendMessage",
          {},
        );
      },
    });
    const client = createGrammyTelegramApi(api);

    const error = await client
      .sendMessage({ chat_id: 1, text: "x" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({
      kind: "telegram",
      method: "sendMessage",
      errorCode: 429,
      telegramDescription: "Too Many Requests: retry after 3",
      retryAfterMs: 3000,
    });
  });

  it("maps an HttpError to a network TelegramApiError", async () => {
    const { api } = recordingApi({
      editMessageText: () => {
        throw new HttpError("Network request failed", new Error("ECONNRESET"));
      },
    });
    const client = createGrammyTelegramApi(api);

    const error = await client
      .editMessageText({ chat_id: 1, message_id: 2, text: "x" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).kind).toBe("network");
  });

  it("maps an aborted request to an aborted TelegramApiError", async () => {
    const controller = new AbortController();
    controller.abort();
    const { api } = recordingApi({
      sendMessage: () => {
        throw new DOMException("Aborted", "AbortError");
      },
    });
    const client = createGrammyTelegramApi(api);

    const error = await client
      .sendMessage({ chat_id: 1, text: "x" }, { signal: controller.signal })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).kind).toBe("aborted");
  });
});
