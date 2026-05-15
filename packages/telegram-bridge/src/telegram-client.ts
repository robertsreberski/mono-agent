import type {
  TelegramBotApi,
  TelegramDeleteWebhookParams,
  TelegramEditMessageTextParams,
  TelegramGetUpdatesParams,
  TelegramRequestOptions,
  TelegramSendMessageParams,
  TelegramSentMessage,
  TelegramUpdate,
} from "./types.js";

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
  cause?: unknown;
}

export class TelegramApiError extends Error {
  readonly kind: TelegramApiErrorKind;
  readonly method: string;
  readonly status?: number;
  readonly errorCode?: number;
  readonly telegramDescription?: string;
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
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}

export interface TelegramBotApiClientOptions {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

interface TelegramOkEnvelope<T> {
  ok: true;
  result: T;
}

interface TelegramErrorEnvelope {
  ok: false;
  error_code?: number;
  description?: string;
}

type TelegramEnvelope<T> = TelegramOkEnvelope<T> | TelegramErrorEnvelope;

const DEFAULT_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class TelegramBotApiClient implements TelegramBotApi {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: TelegramBotApiClientOptions) {
    const token = options.token.trim();
    if (token.length === 0) {
      throw new TypeError("Telegram bot token is required.");
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError(
        "A fetch implementation is required to call the Telegram Bot API.",
      );
    }

    this.token = token;
    this.apiBaseUrl = stripTrailingSlashes(
      options.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    );
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  sendMessage(
    params: TelegramSendMessageParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage> {
    return this.request<TelegramSentMessage>("sendMessage", params, options);
  }

  editMessageText(
    params: TelegramEditMessageTextParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage | true> {
    return this.request<TelegramSentMessage | true>(
      "editMessageText",
      params,
      options,
    );
  }

  getUpdates(
    params: TelegramGetUpdatesParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramUpdate[]> {
    return this.request<TelegramUpdate[]>("getUpdates", params, options);
  }

  deleteWebhook(
    params: TelegramDeleteWebhookParams = {},
    options?: TelegramRequestOptions,
  ): Promise<true> {
    return this.request<true>("deleteWebhook", params, options);
  }

  private async request<T>(
    method: string,
    params: object,
    options?: TelegramRequestOptions,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${this.token}/${method}`;
    const { signal, cleanup } = createRequestSignal(
      options?.signal,
      this.requestTimeoutMs,
    );

    let response: Response;
    try {
      const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(params),
      };
      if (signal !== undefined) {
        init.signal = signal;
      }

      response = await this.fetchImpl(url, init);
    } catch (error) {
      cleanup();
      if (isAbortError(error) || options?.signal?.aborted === true) {
        throw new TelegramApiError(
          `Telegram API ${method} request was aborted.`,
          { kind: "aborted", method },
        );
      }

      throw new TelegramApiError(
        `Network failure while calling Telegram API ${method}.`,
        { kind: "network", method },
      );
    }

    cleanup();

    if (!response.ok) {
      await safelyDrainResponse(response);
      throw new TelegramApiError(
        `Telegram API ${method} failed with HTTP ${response.status}.`,
        { kind: "http", method, status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramApiError(
        `Telegram API ${method} returned malformed JSON.`,
        { kind: "malformed", method },
      );
    }

    const envelope = parseTelegramEnvelope<T>(method, payload);
    if (!envelope.ok) {
      const details: TelegramApiErrorDetails = {
        kind: "telegram",
        method,
      };
      if (envelope.error_code !== undefined) {
        details.errorCode = envelope.error_code;
      }
      if (envelope.description !== undefined) {
        details.telegramDescription = envelope.description;
      }

      throw new TelegramApiError(
        `Telegram API ${method} rejected the request.`,
        details,
      );
    }

    return envelope.result;
  }
}

function parseTelegramEnvelope<T>(
  method: string,
  payload: unknown,
): TelegramEnvelope<T> {
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    throw new TelegramApiError(
      `Telegram API ${method} returned an unexpected response shape.`,
      { kind: "malformed", method },
    );
  }

  if (payload.ok === false) {
    const errorEnvelope: TelegramErrorEnvelope = { ok: false };
    if (typeof payload.error_code === "number") {
      errorEnvelope.error_code = payload.error_code;
    }
    if (typeof payload.description === "string") {
      errorEnvelope.description = payload.description;
    }
    return errorEnvelope;
  }

  if (!("result" in payload)) {
    throw new TelegramApiError(
      `Telegram API ${method} returned success without a result.`,
      { kind: "malformed", method },
    );
  }

  return { ok: true, result: payload.result as T };
}

function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal?: AbortSignal; cleanup: () => void } {
  const shouldUseTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!shouldUseTimeout) {
    if (externalSignal === undefined) {
      return { cleanup: () => undefined };
    }

    return { signal: externalSignal, cleanup: () => undefined };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("Telegram API request timed out."));
  }, timeoutMs);

  const abortFromExternalSignal = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      abortFromExternalSignal();
    } else {
      externalSignal.addEventListener("abort", abortFromExternalSignal, {
        once: true,
      });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    },
  };
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortError(value: unknown): boolean {
  return (
    value instanceof DOMException && value.name === "AbortError"
  ) || (value instanceof Error && value.name === "AbortError");
}

async function safelyDrainResponse(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // Best effort only. Error messages intentionally avoid raw response bodies.
  }
}
