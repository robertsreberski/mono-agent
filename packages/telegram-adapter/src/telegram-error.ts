/**
 * Transport-agnostic error type for failed Telegram Bot API calls.
 *
 * The streaming delivery logic ({@link import("./message-stream.js")}) and its
 * recovery policy (`classifyTelegramError`) depend only on this shape, never on
 * how the request was made. The grammY-backed client maps `GrammyError` /
 * `HttpError` onto it, so the delivery layer is unaware of the transport.
 */

export type TelegramApiErrorKind =
  | "http"
  | "telegram"
  | "malformed"
  | "network"
  | "aborted";

export interface TelegramApiErrorDetails {
  kind: TelegramApiErrorKind;
  method: string;
  status?: number;
  errorCode?: number;
  telegramDescription?: string;
  /**
   * How long to wait before retrying, in milliseconds. Lifted from a Telegram
   * `parameters.retry_after` value (seconds) when present. Only the integer is
   * carried — never a raw response body — so bot tokens cannot leak.
   */
  retryAfterMs?: number;
  cause?: unknown;
}

export class TelegramApiError extends Error {
  readonly kind: TelegramApiErrorKind;
  readonly method: string;
  readonly status?: number;
  readonly errorCode?: number;
  readonly telegramDescription?: string;
  readonly retryAfterMs?: number;
  override readonly cause?: unknown;

  constructor(message: string, details: TelegramApiErrorDetails) {
    super(message);
    this.name = "TelegramApiError";
    this.kind = details.kind;
    this.method = details.method;
    if (details.status !== undefined) {
      this.status = details.status;
    }
    if (details.errorCode !== undefined) {
      this.errorCode = details.errorCode;
    }
    if (details.telegramDescription !== undefined) {
      this.telegramDescription = details.telegramDescription;
    }
    if (details.retryAfterMs !== undefined) {
      this.retryAfterMs = details.retryAfterMs;
    }
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}

/**
 * True when a failed send proves its forum topic no longer exists. Telegram
 * sends bots no topic-deletion update; the only evidence is a send into the
 * topic answered with "message thread not found" or `TOPIC_DELETED`. Walks the
 * `cause` chain (bounded) because the delivery layer wraps API errors.
 */
export function isTelegramTopicGoneError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const description = (current as { readonly telegramDescription?: unknown }).telegramDescription;
    if (typeof description === "string" && /message thread not found|TOPIC_DELETED/iu.test(description)) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}
