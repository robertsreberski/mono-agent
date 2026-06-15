import { GrammyError, HttpError, type Api } from "grammy";

import {
  TelegramApiError,
  type TelegramApiErrorDetails,
} from "./telegram-error.js";
import type {
  TelegramEditMessageTextParams,
  TelegramMessageSender,
  TelegramRequestOptions,
  TelegramSendMessageParams,
  TelegramSentMessage,
} from "./types.js";

type SendOther = NonNullable<Parameters<Api["sendMessage"]>[2]>;
type EditOther = NonNullable<Parameters<Api["editMessageText"]>[3]>;

// grammY's `Api` types its `signal` parameter with the `abort-controller` shim's
// AbortSignal rather than the global one; the runtime value is identical, so we
// cast through this helper at the call boundary.
function asGrammySignal(signal: AbortSignal | undefined): Parameters<Api["sendMessage"]>[3] {
  return signal as unknown as Parameters<Api["sendMessage"]>[3];
}

/**
 * Adapt a grammY {@link Api} to the {@link TelegramMessageSender} the streaming
 * delivery layer depends on.
 *
 * Two responsibilities: translate our params-object calls into grammY's
 * positional `(chat_id, text, other, signal)` form, and translate grammY's
 * thrown errors (`GrammyError`, `HttpError`) back into {@link TelegramApiError}
 * so the existing recovery policy (`classifyTelegramError`) keeps working
 * unchanged.
 */
export function createGrammyTelegramApi(api: Api): TelegramMessageSender {
  return {
    async sendMessage(
      params: TelegramSendMessageParams,
      options?: TelegramRequestOptions,
    ): Promise<TelegramSentMessage> {
      try {
        const message = await api.sendMessage(
          params.chat_id,
          params.text,
          buildSendOther(params),
          asGrammySignal(options?.signal),
        );
        return message as unknown as TelegramSentMessage;
      } catch (error) {
        throw toTelegramApiError("sendMessage", error, options?.signal);
      }
    },

    async editMessageText(
      params: TelegramEditMessageTextParams,
      options?: TelegramRequestOptions,
    ): Promise<TelegramSentMessage | true> {
      if (params.chat_id === undefined || params.message_id === undefined) {
        throw new TelegramApiError(
          "grammY editMessageText requires chat_id and message_id.",
          { kind: "telegram", method: "editMessageText" },
        );
      }
      try {
        const result = await api.editMessageText(
          params.chat_id,
          params.message_id,
          params.text,
          buildEditOther(params),
          asGrammySignal(options?.signal),
        );
        return result === true ? true : (result as unknown as TelegramSentMessage);
      } catch (error) {
        throw toTelegramApiError("editMessageText", error, options?.signal);
      }
    },
  };
}

function buildSendOther(params: TelegramSendMessageParams): SendOther {
  const other: SendOther = {};
  if (params.parse_mode !== undefined) {
    other.parse_mode = params.parse_mode as NonNullable<SendOther["parse_mode"]>;
  }
  if (params.reply_to_message_id !== undefined) {
    other.reply_parameters = { message_id: params.reply_to_message_id };
  }
  if (params.disable_web_page_preview !== undefined) {
    other.link_preview_options = { is_disabled: params.disable_web_page_preview };
  }
  return other;
}

function buildEditOther(params: TelegramEditMessageTextParams): EditOther {
  const other: EditOther = {};
  if (params.parse_mode !== undefined) {
    other.parse_mode = params.parse_mode as NonNullable<EditOther["parse_mode"]>;
  }
  if (params.disable_web_page_preview !== undefined) {
    other.link_preview_options = { is_disabled: params.disable_web_page_preview };
  }
  return other;
}

function toTelegramApiError(
  method: string,
  error: unknown,
  signal: AbortSignal | undefined,
): TelegramApiError {
  if (error instanceof TelegramApiError) {
    return error;
  }
  if (signal?.aborted === true || isAbortError(error)) {
    return new TelegramApiError(`Telegram API ${method} request was aborted.`, {
      kind: "aborted",
      method,
    });
  }
  if (error instanceof GrammyError) {
    const details: TelegramApiErrorDetails = {
      kind: "telegram",
      method,
      errorCode: error.error_code,
      telegramDescription: error.description,
    };
    const retryAfter = error.parameters.retry_after;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
      details.retryAfterMs = Math.max(0, retryAfter) * 1000;
    }
    return new TelegramApiError(`Telegram API ${method} rejected the request.`, details);
  }
  if (error instanceof HttpError) {
    return new TelegramApiError(
      `Network failure while calling Telegram API ${method}.`,
      { kind: "network", method, cause: error },
    );
  }
  return new TelegramApiError(
    `Unexpected failure while calling Telegram API ${method}.`,
    { kind: "network", method, cause: error },
  );
}

function isAbortError(value: unknown): boolean {
  return (
    (value instanceof DOMException && value.name === "AbortError") ||
    (value instanceof Error && value.name === "AbortError")
  );
}
