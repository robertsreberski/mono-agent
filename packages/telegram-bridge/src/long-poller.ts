import type {
  TelegramBotApi,
  TelegramDeleteWebhookParams,
  TelegramGetUpdatesParams,
  TelegramRequestOptions,
  TelegramUpdate,
} from "./types.js";
import type { TelegramUpdateHandlingResult } from "./bridge.js";

export interface TelegramUpdateHandler {
  handleUpdate(update: TelegramUpdate): Promise<TelegramUpdateHandlingResult>;
}

export interface TelegramLongPollerBackoffOptions {
  initialMs?: number;
  maxMs?: number;
}

export interface TelegramLongPollerLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface TelegramLongPollerOptions {
  api: TelegramBotApi;
  bridge: TelegramUpdateHandler;
  initialOffset?: number;
  limit?: number;
  timeoutSeconds?: number;
  allowedUpdates?: string[];
  deleteWebhookOnStart?: boolean;
  dropPendingUpdates?: boolean;
  backoff?: TelegramLongPollerBackoffOptions;
  onError?: (error: unknown) => void | Promise<void>;
  logger?: TelegramLongPollerLogger;
}

export interface TelegramLongPollerStartOptions {
  signal?: AbortSignal;
}

export interface TelegramLongPollerPollOptions {
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 10_000;

export class TelegramLongPoller {
  private readonly api: TelegramBotApi;
  private readonly bridge: TelegramUpdateHandler;
  private readonly limit: number;
  private readonly timeoutSeconds: number;
  private readonly allowedUpdates: string[] | undefined;
  private readonly deleteWebhookOnStart: boolean;
  private readonly dropPendingUpdates: boolean;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onError: ((error: unknown) => void | Promise<void>) | undefined;
  private readonly logger: TelegramLongPollerLogger | undefined;
  private nextUpdateOffset: number | undefined;

  constructor(options: TelegramLongPollerOptions) {
    if (options.api === undefined) {
      throw new TypeError("TelegramLongPoller requires a Telegram Bot API client.");
    }
    if (typeof options.bridge?.handleUpdate !== "function") {
      throw new TypeError("TelegramLongPoller requires a bridge with handleUpdate().");
    }

    this.api = options.api;
    this.bridge = options.bridge;
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.allowedUpdates = options.allowedUpdates?.slice();
    this.deleteWebhookOnStart = options.deleteWebhookOnStart === true;
    this.dropPendingUpdates = options.dropPendingUpdates === true;
    this.initialBackoffMs =
      options.backoff?.initialMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.backoff?.maxMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.onError = options.onError;
    this.logger = options.logger;
    this.nextUpdateOffset = options.initialOffset;

    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 100) {
      throw new RangeError("TelegramLongPoller limit must be an integer between 1 and 100.");
    }
    if (!Number.isFinite(this.timeoutSeconds) || this.timeoutSeconds < 0) {
      throw new RangeError("TelegramLongPoller timeoutSeconds must be non-negative.");
    }
    if (!Number.isFinite(this.initialBackoffMs) || this.initialBackoffMs < 0) {
      throw new RangeError("TelegramLongPoller initial backoff must be non-negative.");
    }
    if (!Number.isFinite(this.maxBackoffMs) || this.maxBackoffMs < this.initialBackoffMs) {
      throw new RangeError("TelegramLongPoller max backoff must be at least the initial backoff.");
    }
  }

  get nextOffset(): number | undefined {
    return this.nextUpdateOffset;
  }

  async start(options: TelegramLongPollerStartOptions = {}): Promise<void> {
    if (isSignalAborted(options.signal)) {
      return;
    }

    if (this.deleteWebhookOnStart) {
      await this.deleteWebhook(options.signal);
    }

    let backoffMs = this.initialBackoffMs;
    while (!isSignalAborted(options.signal)) {
      try {
        const pollOptions: TelegramLongPollerPollOptions = {};
        if (options.signal !== undefined) {
          pollOptions.signal = options.signal;
        }
        await this.pollOnce(pollOptions);
        backoffMs = this.initialBackoffMs;
      } catch (error) {
        if (isSignalAborted(options.signal) || isAbortError(error)) {
          return;
        }

        this.logger?.warn?.("Telegram long polling failed; backing off.", {
          error: error instanceof Error ? error.message : String(error),
          backoffMs,
        });
        await this.onError?.(error);
        await abortableDelay(backoffMs, options.signal);
        backoffMs = Math.min(this.maxBackoffMs, Math.max(backoffMs * 2, 1));
      }
    }
  }

  async pollOnce(options: TelegramLongPollerPollOptions = {}): Promise<number> {
    if (isSignalAborted(options.signal)) {
      throw new DOMException("Telegram polling was aborted.", "AbortError");
    }

    const params = this.buildGetUpdatesParams();
    const requestOptions: TelegramRequestOptions = {};
    if (options.signal !== undefined) {
      requestOptions.signal = options.signal;
    }

    const updates = await this.api.getUpdates(params, requestOptions);
    let handled = 0;
    for (const update of updates) {
      if (isSignalAborted(options.signal)) {
        throw new DOMException("Telegram polling was aborted.", "AbortError");
      }

      await this.bridge.handleUpdate(update);
      this.nextUpdateOffset = update.update_id + 1;
      handled += 1;
    }

    return handled;
  }

  private buildGetUpdatesParams(): TelegramGetUpdatesParams {
    const params: TelegramGetUpdatesParams = {
      limit: this.limit,
      timeout: this.timeoutSeconds,
    };
    if (this.nextUpdateOffset !== undefined) {
      params.offset = this.nextUpdateOffset;
    }
    if (this.allowedUpdates !== undefined) {
      params.allowed_updates = this.allowedUpdates;
    }
    return params;
  }

  private async deleteWebhook(signal: AbortSignal | undefined): Promise<void> {
    if (typeof this.api.deleteWebhook !== "function") {
      throw new TypeError(
        "TelegramLongPoller deleteWebhookOnStart requires api.deleteWebhook().",
      );
    }

    const params: TelegramDeleteWebhookParams = {
      drop_pending_updates: this.dropPendingUpdates,
    };
    const requestOptions: TelegramRequestOptions = {};
    if (signal !== undefined) {
      requestOptions.signal = signal;
    }
    await this.api.deleteWebhook(params, requestOptions);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (error instanceof Error && error.name === "AbortError");
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
