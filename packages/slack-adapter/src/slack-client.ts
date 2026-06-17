import type {
  SlackAppsConnectionsOpenResult,
  SlackAuthTestResult,
  SlackChatPostMessageParams,
  SlackChatPostMessageResult,
  SlackChatUpdateParams,
  SlackChatUpdateResult,
  SlackRequestOptions,
  SlackWebApi,
} from "./types.js";

export type SlackApiErrorKind =
  | "http"
  | "slack"
  | "malformed"
  | "network"
  | "aborted";

export interface SlackApiErrorDetails {
  kind: SlackApiErrorKind;
  method: string;
  status?: number;
  slackError?: string;
  needed?: string;
  provided?: string;
  warning?: string;
  /**
   * How long to wait before retrying, in milliseconds. Lifted from a Slack
   * `Retry-After` response header (seconds) on a rate-limited (HTTP 429)
   * response. Only the integer is carried — never a raw response body — so bot
   * tokens cannot leak.
   */
  retryAfterMs?: number;
  cause?: unknown;
}

export class SlackApiError extends Error {
  readonly kind: SlackApiErrorKind;
  readonly method: string;
  readonly status?: number;
  readonly slackError?: string;
  readonly needed?: string;
  readonly provided?: string;
  readonly warning?: string;
  readonly retryAfterMs?: number;
  override readonly cause?: unknown;

  constructor(message: string, details: SlackApiErrorDetails) {
    super(message);
    this.name = "SlackApiError";
    this.kind = details.kind;
    this.method = details.method;
    if (details.status !== undefined) {
      this.status = details.status;
    }
    if (details.slackError !== undefined) {
      this.slackError = details.slackError;
    }
    if (details.needed !== undefined) {
      this.needed = details.needed;
    }
    if (details.provided !== undefined) {
      this.provided = details.provided;
    }
    if (details.warning !== undefined) {
      this.warning = details.warning;
    }
    if (details.retryAfterMs !== undefined) {
      this.retryAfterMs = details.retryAfterMs;
    }
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}

export interface SlackWebApiClientOptions {
  botToken: string;
  appToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

type SlackEnvelope<T> = T | SlackErrorEnvelope;

interface SlackErrorEnvelope {
  ok: false;
  error?: string;
  needed?: string;
  provided?: string;
  warning?: string;
}

const DEFAULT_API_BASE_URL = "https://slack.com/api";
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

export class SlackWebApiClient implements SlackWebApi {
  private readonly botToken: string;
  private readonly appToken: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: SlackWebApiClientOptions) {
    const botToken = options.botToken.trim();
    const appToken = options.appToken.trim();
    if (botToken.length === 0) {
      throw new TypeError("Slack bot token is required.");
    }
    if (appToken.length === 0) {
      throw new TypeError("Slack app token is required.");
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required to call the Slack Web API.");
    }

    this.botToken = botToken;
    this.appToken = appToken;
    this.apiBaseUrl = stripTrailingSlashes(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  authTest(options?: SlackRequestOptions): Promise<SlackAuthTestResult> {
    return this.request<SlackAuthTestResult>("auth.test", {}, this.botToken, options);
  }

  appsConnectionsOpen(options?: SlackRequestOptions): Promise<SlackAppsConnectionsOpenResult> {
    return this.request<SlackAppsConnectionsOpenResult>("apps.connections.open", {}, this.appToken, options);
  }

  chatPostMessage(
    params: SlackChatPostMessageParams,
    options?: SlackRequestOptions,
  ): Promise<SlackChatPostMessageResult> {
    return this.request<SlackChatPostMessageResult>("chat.postMessage", params, this.botToken, options);
  }

  chatUpdate(
    params: SlackChatUpdateParams,
    options?: SlackRequestOptions,
  ): Promise<SlackChatUpdateResult> {
    return this.request<SlackChatUpdateResult>("chat.update", params, this.botToken, options);
  }

  private async request<T extends { ok: true }>(
    method: string,
    params: object,
    token: string,
    options?: SlackRequestOptions,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/${method}`;
    const { signal, cleanup } = createRequestSignal(options?.signal, this.requestTimeoutMs);

    let response: Response;
    try {
      const init: RequestInit = {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
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
        throw new SlackApiError(`Slack API ${method} request was aborted.`, {
          kind: "aborted",
          method,
        });
      }
      throw new SlackApiError(`Network failure while calling Slack API ${method}.`, {
        kind: "network",
        method,
      });
    }

    cleanup();

    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response);
      await safelyDrainResponse(response);
      throw new SlackApiError(`Slack API ${method} failed with HTTP ${response.status}.`, {
        kind: "http",
        method,
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SlackApiError(`Slack API ${method} returned malformed JSON.`, {
        kind: "malformed",
        method,
      });
    }

    const envelope = parseSlackEnvelope<T>(method, payload);
    if (!envelope.ok) {
      throw new SlackApiError(`Slack API ${method} rejected the request.`, {
        kind: "slack",
        method,
        ...(typeof envelope.error === "string" ? { slackError: envelope.error } : {}),
        ...(typeof envelope.needed === "string" ? { needed: envelope.needed } : {}),
        ...(typeof envelope.provided === "string" ? { provided: envelope.provided } : {}),
        ...(typeof envelope.warning === "string" ? { warning: envelope.warning } : {}),
      });
    }

    return envelope;
  }
}

function parseSlackEnvelope<T extends { ok: true }>(
  method: string,
  payload: unknown,
): SlackEnvelope<T> {
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    throw new SlackApiError(`Slack API ${method} returned an unexpected response shape.`, {
      kind: "malformed",
      method,
    });
  }
  if (payload.ok === false) {
    return {
      ok: false,
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      ...(typeof payload.needed === "string" ? { needed: payload.needed } : {}),
      ...(typeof payload.provided === "string" ? { provided: payload.provided } : {}),
      ...(typeof payload.warning === "string" ? { warning: payload.warning } : {}),
    };
  }
  return payload as T;
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
    controller.abort(new Error("Slack API request timed out."));
  }, timeoutMs);

  const abortFromExternalSignal = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      abortFromExternalSignal();
    } else {
      externalSignal.addEventListener("abort", abortFromExternalSignal, { once: true });
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

/**
 * Extract a `Retry-After` header (seconds) as milliseconds. Slack sends this on
 * a rate-limited HTTP 429 response. Only the parsed integer is read so no raw
 * response body or token material is carried.
 */
function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers?.get?.("retry-after");
  if (header === null || header === undefined) {
    return undefined;
  }
  const seconds = Number.parseInt(header.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds * 1000;
}

function isAbortError(value: unknown): boolean {
  return (
    value instanceof DOMException && value.name === "AbortError"
  ) || (value instanceof Error && value.name === "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function safelyDrainResponse(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // Best effort only. Error messages intentionally avoid raw response bodies.
  }
}
