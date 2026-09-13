import type { MessengerMessagingType } from "./config.js";
import { splitForMessenger, MESSENGER_MAX_MESSAGE_CHARS } from "./text.js";

export const DEFAULT_GRAPH_API_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 1_000;
/** Upper bound on an honored `Retry-After`, so a hostile/typo'd header cannot park a turn. */
const MAX_RETRY_AFTER_MS = 10_000;
/** Cap on any retained error string, applied after redaction. */
const MAX_DETAIL_CHARS = 2_000;

export type MessengerSenderAction = "typing_on" | "typing_off" | "mark_seen";

export interface MessengerSendOptions {
  readonly messagingType?: MessengerMessagingType;
  readonly tag?: string;
  readonly maxMessageChars?: number;
}

export interface MessengerSendResult {
  /** Send API message ids in delivery order (one per chunk). */
  readonly messageIds: readonly string[];
}

export interface MessengerGraphClientLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
}

export interface MessengerGraphClientOptions {
  readonly pageAccessToken: string;
  readonly apiVersion: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: MessengerGraphClientLogger;
}

/** Minimal surface the adapter and stream depend on; tests inject fakes. */
export interface MessengerGraphClientLike {
  sendText(recipientId: string, text: string, options?: MessengerSendOptions): Promise<MessengerSendResult>;
  sendAttachmentUrl(
    recipientId: string,
    attachmentType: "image" | "video" | "audio" | "file",
    url: string,
    options?: MessengerSendOptions,
  ): Promise<MessengerSendResult>;
  senderAction(recipientId: string, action: MessengerSenderAction): Promise<void>;
}

export class MessengerGraphError extends Error {
  readonly status: number;
  readonly detail: unknown;
  /** Bounded `Retry-After` from the response, when the server sent a usable one. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, detail: unknown, retryAfterMs?: number) {
    super(`Messenger Graph API request failed with HTTP ${status}.`);
    this.name = "MessengerGraphError";
    this.status = status;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /**
   * True when the server definitively refused to act on the request. A 429 is
   * a pre-processing rejection, so replaying it cannot duplicate a message; a
   * 5xx may have been applied before the failure and is ambiguous instead.
   */
  get definitivelyRejected(): boolean {
    return this.status === 429;
  }
}

/**
 * A non-idempotent Send API POST whose outcome is unknown: the request may have
 * been accepted by Meta and only its response lost. It is deliberately NOT
 * retried — a replay would deliver the message twice — and is surfaced so the
 * caller can report an ambiguous delivery instead of silently duplicating or
 * silently dropping it.
 */
export class MessengerAmbiguousDeliveryError extends Error {
  readonly path: string;
  readonly cause: unknown;
  /** Chunks already confirmed delivered before the ambiguous one, in order. */
  readonly deliveredMessageIds: readonly string[];

  constructor(path: string, cause: unknown, deliveredMessageIds: readonly string[] = []) {
    super(`Messenger Send API request to ${path} has an unknown outcome and was not retried.`);
    this.name = "MessengerAmbiguousDeliveryError";
    this.path = path;
    this.cause = cause;
    this.deliveredMessageIds = deliveredMessageIds;
  }
}

export function isMessengerAmbiguousDeliveryError(error: unknown): error is MessengerAmbiguousDeliveryError {
  return error instanceof MessengerAmbiguousDeliveryError;
}

/** Thin Send API client over global `fetch`; retries one transient failure per request. */
export class MessengerGraphClient implements MessengerGraphClientLike {
  private readonly pageAccessToken: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: MessengerGraphClientLogger | undefined;

  constructor(options: MessengerGraphClientOptions) {
    if (options.pageAccessToken.length === 0) {
      throw new TypeError("MessengerGraphClient requires a page access token.");
    }
    this.pageAccessToken = options.pageAccessToken;
    this.apiVersion = options.apiVersion;
    this.baseUrl = (options.baseUrl ?? DEFAULT_GRAPH_API_BASE_URL).replace(/\/+$/u, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
  }

  async sendText(recipientId: string, text: string, options?: MessengerSendOptions): Promise<MessengerSendResult> {
    const chunks = splitForMessenger(text, options?.maxMessageChars ?? MESSENGER_MAX_MESSAGE_CHARS);
    const messageIds: string[] = [];
    for (const chunk of chunks) {
      // Report the chunks already on their way when a later one goes ambiguous,
      // so the caller can describe a partial delivery instead of guessing.
      const data = await this.postDelivery("/me/messages", {
        ...basePayload(recipientId, options),
        message: { text: chunk },
      }, messageIds);
      const messageId = readMessageId(data);
      if (messageId !== undefined) {
        messageIds.push(messageId);
      }
    }
    return { messageIds };
  }

  async sendAttachmentUrl(
    recipientId: string,
    attachmentType: "image" | "video" | "audio" | "file",
    url: string,
    options?: MessengerSendOptions,
  ): Promise<MessengerSendResult> {
    const data = await this.postDelivery("/me/messages", {
      ...basePayload(recipientId, options),
      message: { attachment: { type: attachmentType, payload: { url, is_reusable: true } } },
    }, []);
    const messageId = readMessageId(data);
    return { messageIds: messageId === undefined ? [] : [messageId] };
  }

  async senderAction(recipientId: string, action: MessengerSenderAction): Promise<void> {
    // Sender actions are replay-safe: `typing_on`/`typing_off`/`mark_seen` are
    // state assignments, so a duplicate is a no-op rather than a second message.
    await this.postReplaySafe("/me/messages", { recipient: { id: recipientId }, sender_action: action });
  }

  /**
   * A replay-safe POST: retried once on any transient failure, because a
   * duplicate delivery of this request has no user-visible effect.
   */
  private async postReplaySafe(path: string, payload: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.postOnce(path, payload);
    } catch (error) {
      const retryable = error instanceof MessengerGraphError ? error.retryable : isNetworkError(error);
      if (!retryable) {
        throw error;
      }
      this.logger?.debug?.("Messenger Graph API request failed; retrying once.", {
        path,
        error: errorText(error),
      });
      await delay(retryDelayFor(error));
      return await this.postOnce(path, payload);
    }
  }

  /**
   * A message-bearing POST. Meta's Send API has no idempotency key, so the only
   * safe retry is one the server definitively refused before acting (429).
   * Every other transient outcome — timeout, transport failure, 5xx — may have
   * been applied on Meta's side, and is surfaced as
   * {@link MessengerAmbiguousDeliveryError} rather than replayed into a
   * duplicate message.
   */
  private async postDelivery(
    path: string,
    payload: Record<string, unknown>,
    deliveredMessageIds: readonly string[],
  ): Promise<unknown> {
    try {
      return await this.postOnce(path, payload);
    } catch (error) {
      if (error instanceof MessengerGraphError && error.definitivelyRejected) {
        this.logger?.debug?.("Messenger Send API rejected the request before delivery; retrying once.", {
          path,
          status: error.status,
        });
        await delay(retryDelayFor(error));
        try {
          return await this.postOnce(path, payload);
        } catch (retryError) {
          throw this.asDeliveryFailure(path, retryError, deliveredMessageIds);
        }
      }
      throw this.asDeliveryFailure(path, error, deliveredMessageIds);
    }
  }

  /** Classify a failed delivery POST as ambiguous (unknown outcome) or a clean rejection. */
  private asDeliveryFailure(path: string, error: unknown, deliveredMessageIds: readonly string[]): unknown {
    const ambiguous = error instanceof MessengerGraphError
      ? error.status >= 500
      : isNetworkError(error);
    if (!ambiguous) {
      return error;
    }
    this.logger?.warn?.("Messenger Send API outcome is unknown; not retrying a non-idempotent send.", {
      path,
      error: errorText(error),
      deliveredMessageIds: deliveredMessageIds.length,
    });
    return new MessengerAmbiguousDeliveryError(path, error, [...deliveredMessageIds]);
  }

  private async postOnce(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/${this.apiVersion}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.pageAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      let data: unknown = text;
      try {
        data = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        // Non-JSON error bodies are surfaced as text.
      }
      if (response.status >= 400) {
        throw new MessengerGraphError(
          response.status,
          redactGraphError(data, this.pageAccessToken),
          retryAfterMsFromHeader(response.headers.get("retry-after")),
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function retryDelayFor(error: unknown): number {
  const advertised = error instanceof MessengerGraphError ? error.retryAfterMs : undefined;
  return advertised ?? RETRY_DELAY_MS;
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) into a bounded millisecond delay. */
export function retryAfterMsFromHeader(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  const ms = Number.isFinite(seconds) && trimmed.length > 0
    ? seconds * 1_000
    : Date.parse(trimmed) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basePayload(recipientId: string, options: MessengerSendOptions | undefined): Record<string, unknown> {
  const messagingType = options?.messagingType ?? "RESPONSE";
  return {
    recipient: { id: recipientId },
    messaging_type: messagingType,
    ...(messagingType === "MESSAGE_TAG" && options?.tag !== undefined ? { tag: options.tag } : {}),
  };
}

function readMessageId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const messageId = (data as { message_id?: unknown }).message_id;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : undefined;
}

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TypeError");
}

const REDACTED = "<redacted>";

/**
 * Keep Graph error bodies inspectable but never echo the configured credential.
 *
 * Meta reflects request content in some error messages, so every retained
 * string is scrubbed of the exact configured token plus the usual bearer and
 * query-parameter carriers. Structured bodies are reduced to an allowlist of
 * scalar diagnostic fields — anything not on it is dropped rather than trusted,
 * so a newly added Graph field cannot leak a credential by default.
 */
function redactGraphError(data: unknown, pageAccessToken: string): unknown {
  if (typeof data === "string") {
    return sanitizeErrorString(data, pageAccessToken);
  }
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const source = error as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of ["message", "type", "code", "error_subcode", "fbtrace_id"] as const) {
        const value = sanitizeScalar(source[key], pageAccessToken);
        if (value !== undefined) {
          out[key] = value;
        }
      }
      return out;
    }
    return { error: sanitizeScalar(error, pageAccessToken) };
  }
  return typeof data === "object" && data !== null ? {} : sanitizeScalar(data, pageAccessToken);
}

/** Retain only bounded scalars, redacted; everything else becomes `undefined`. */
function sanitizeScalar(value: unknown, pageAccessToken: string): unknown {
  if (typeof value === "string") {
    return sanitizeErrorString(value, pageAccessToken);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function sanitizeErrorString(value: string, pageAccessToken: string): string {
  let out = value;
  // The configured credential first: a reflected token is the one value we know
  // exactly, and it may appear with no surrounding `access_token=` marker.
  if (pageAccessToken.length > 0) {
    out = out.split(pageAccessToken).join(REDACTED);
  }
  out = out.replace(/access_token=[^&\s"']+/giu, `access_token=${REDACTED}`);
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, `Bearer ${REDACTED}`);
  return out.slice(0, MAX_DETAIL_CHARS);
}
