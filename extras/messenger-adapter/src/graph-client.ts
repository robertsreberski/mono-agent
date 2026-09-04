import type { MessengerMessagingType } from "./config.js";
import { splitForMessenger, MESSENGER_MAX_MESSAGE_CHARS } from "./text.js";

export const DEFAULT_GRAPH_API_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 1_000;

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

  constructor(status: number, detail: unknown) {
    super(`Messenger Graph API request failed with HTTP ${status}.`);
    this.name = "MessengerGraphError";
    this.status = status;
    this.detail = detail;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
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
      const data = await this.post("/me/messages", {
        ...basePayload(recipientId, options),
        message: { text: chunk },
      });
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
    const data = await this.post("/me/messages", {
      ...basePayload(recipientId, options),
      message: { attachment: { type: attachmentType, payload: { url, is_reusable: true } } },
    });
    const messageId = readMessageId(data);
    return { messageIds: messageId === undefined ? [] : [messageId] };
  }

  async senderAction(recipientId: string, action: MessengerSenderAction): Promise<void> {
    await this.post("/me/messages", { recipient: { id: recipientId }, sender_action: action });
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await this.postOnce(path, payload);
      } catch (error) {
        const retryable = error instanceof MessengerGraphError ? error.retryable : isNetworkError(error);
        if (!retryable || attempt >= 2) {
          throw error;
        }
        this.logger?.debug?.("Messenger Graph API request failed; retrying once.", {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, RETRY_DELAY_MS));
      }
    }
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
        throw new MessengerGraphError(response.status, redactGraphError(data));
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
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

/** Keep Graph error bodies inspectable but never echo tokens that Meta may reflect. */
function redactGraphError(data: unknown): unknown {
  if (typeof data === "string") {
    return data.replace(/access_token=[^&\s]+/gu, "access_token=<redacted>").slice(0, 2_000);
  }
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const { message, type, code, error_subcode: subcode, fbtrace_id: traceId } = error as Record<string, unknown>;
      return { message, type, code, error_subcode: subcode, fbtrace_id: traceId };
    }
    return { error };
  }
  return data;
}
