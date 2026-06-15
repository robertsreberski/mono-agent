import type {
  AgentMessageStream as AgentMessageStreamBase,
  AgentStreamEvent,
} from "@mono-agent/agent-contracts";
import {
  DEFAULT_EMPTY_FINAL_TEXT,
  DEFAULT_MAX_MESSAGE_CHARS,
  buildStreamingTailPreview,
  normalizeTrailing,
  splitTextByCodePoints,
} from "@mono-agent/agent-contracts";
import { TelegramApiError } from "./telegram-client.js";
import { renderTelegramHtml } from "./telegram-html.js";
import type {
  TelegramBotApi,
  TelegramChatId,
  TelegramEditMessageTextParams,
  TelegramSendMessageParams,
  TelegramSentMessage,
} from "./types.js";

export interface AgentMessageStream extends AgentMessageStreamBase {
  status(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace(text: string): Promise<void>;
  event(event: AgentStreamEvent): Promise<void>;
  finish(finalText?: string): Promise<void>;
}

export interface TelegramMessageStreamOptions {
  api: TelegramBotApi;
  chatId: TelegramChatId;
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
  replyToMessageId?: number;
  /** Maximum retries for a *final* delivery before giving up. Default 3. */
  maxSendRetries?: number;
  /** Upper bound on any honored `retry_after`/backoff wait, in ms. Default 60000. */
  retryCapMs?: number;
  /** Base delay for exponential backoff between final-delivery retries. Default 500. */
  retryBaseDelayMs?: number;
  /** Render accumulated reasoning as a live "💭" message. Default true. */
  showThoughts?: boolean;
  /** Render the final answer's Markdown as Telegram HTML (plain fallback). Default true. */
  formatHtml?: boolean;
  /** Aborts in-flight retry waits (e.g. on /cancel). */
  abortSignal?: AbortSignal;
  logger?: TelegramMessageStreamLogger;
}

export interface TelegramMessageStreamLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Raised only when a *final* delivery cannot reach Telegram after retries and
 * the last-resort fresh send. The AI request itself already succeeded, so the
 * adapter treats this as a degraded delivery — never as an agent failure.
 */
export class TelegramDeliveryError extends Error {
  override readonly cause: unknown;
  readonly attempts: number;

  constructor(message: string, details: { cause: unknown; attempts: number }) {
    super(message);
    this.name = "TelegramDeliveryError";
    this.cause = details.cause;
    this.attempts = details.attempts;
  }
}

/** How a failed Telegram send/edit should be handled. */
export type TelegramSendOutcome =
  | { kind: "not_modified" }
  | { kind: "recreate" }
  | { kind: "reformat_plain" }
  | { kind: "retry"; retryAfterMs?: number }
  | { kind: "fatal" };

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking…";
const DEFAULT_EDIT_DEBOUNCE_MS = 750;
const DEFAULT_MAX_SEND_RETRIES = 3;
const DEFAULT_RETRY_CAP_MS = 60_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const EMPTY_FINAL_TEXT = DEFAULT_EMPTY_FINAL_TEXT;
const THOUGHT_PREFIX = "💭 ";

export class TelegramMessageStream implements AgentMessageStream {
  private readonly api: TelegramBotApi;
  private readonly chatId: TelegramChatId;
  private readonly initialStatusText: string;
  private readonly editDebounceMs: number;
  private readonly maxMessageChars: number;
  private readonly replyToMessageId: number | undefined;
  private readonly maxSendRetries: number;
  private readonly retryCapMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly showThoughts: boolean;
  private readonly formatHtml: boolean;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly logger: TelegramMessageStreamLogger | undefined;

  private currentText = "";
  private thinkingText = "";
  private hasAnswerText = false;
  private statusText: string;
  private sentMessage: TelegramSentMessage | undefined;
  private sendMessagePromise: Promise<TelegramSentMessage> | undefined;
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlightEdit: Promise<void> | undefined;
  private lastFlushedText: string | undefined;
  private lastFlushedHtml = false;
  private finished = false;

  constructor(options: TelegramMessageStreamOptions) {
    this.api = options.api;
    this.chatId = options.chatId;
    this.initialStatusText = normalizeTelegramText(
      options.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT,
    );
    this.statusText = this.initialStatusText;
    this.editDebounceMs = options.editDebounceMs ?? DEFAULT_EDIT_DEBOUNCE_MS;
    this.maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    this.replyToMessageId = options.replyToMessageId;
    this.maxSendRetries = options.maxSendRetries ?? DEFAULT_MAX_SEND_RETRIES;
    this.retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.showThoughts = options.showThoughts ?? true;
    this.formatHtml = options.formatHtml ?? true;
    this.abortSignal = options.abortSignal;
    this.logger = options.logger;

    if (!Number.isInteger(this.maxMessageChars) || this.maxMessageChars < 32) {
      throw new RangeError("maxMessageChars must be an integer of at least 32.");
    }
    if (!Number.isFinite(this.editDebounceMs) || this.editDebounceMs < 0) {
      throw new RangeError("editDebounceMs must be a non-negative number.");
    }
    if (!Number.isInteger(this.maxSendRetries) || this.maxSendRetries < 0) {
      throw new RangeError("maxSendRetries must be a non-negative integer.");
    }
    if (!Number.isFinite(this.retryCapMs) || this.retryCapMs < 0) {
      throw new RangeError("retryCapMs must be a non-negative number.");
    }
    if (!Number.isFinite(this.retryBaseDelayMs) || this.retryBaseDelayMs < 0) {
      throw new RangeError("retryBaseDelayMs must be a non-negative number.");
    }
  }

  async status(text: string): Promise<void> {
    this.assertOpen();
    await this.awaitInFlightEdit();
    this.statusText = normalizeTelegramText(text);
    const hadMessage = this.sentMessage !== undefined;
    await this.ensureMessage();
    if (hadMessage) {
      await this.deliverText(this.statusText, { final: false });
    }
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    await this.awaitInFlightEdit();
    if (delta.length === 0) {
      return;
    }

    this.currentText += delta;
    if (!this.hasAnswerText && delta.trim().length > 0) {
      this.hasAnswerText = true;
    }
    await this.ensureMessage();
    this.scheduleEdit();
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    await this.awaitInFlightEdit();
    this.currentText = text;
    if (text.trim().length > 0) {
      this.hasAnswerText = true;
    }
    await this.ensureMessage();
    this.scheduleEdit();
  }

  async event(event: AgentStreamEvent): Promise<void> {
    this.assertOpen();
    await this.awaitInFlightEdit();

    if (event.type === "assistant_thought") {
      // Reasoning is shown live as a single accumulating "💭" message, then
      // superseded the moment the answer starts streaming.
      if (!this.showThoughts || this.hasAnswerText || event.text.length === 0) {
        return;
      }
      this.thinkingText += event.text;
      await this.ensureMessage();
      this.scheduleEdit();
      return;
    }

    if (event.type === "runtime_warning") {
      this.logger?.warn?.("Telegram stream received runtime warning.", {
        warningKind: event.warningKind,
        message: event.message,
      });
      return;
    }

    if (event.type === "tool_call_started") {
      this.logger?.debug?.("Telegram stream received tool start event.", {
        id: event.id,
        name: event.name,
      });
      return;
    }

    if (event.type === "tool_call_completed") {
      this.logger?.debug?.("Telegram stream received tool completion event.", {
        id: event.id,
        name: event.name,
        isError: event.isError === true,
      });
    }
  }

  async finish(finalText?: string): Promise<void> {
    if (this.finished) {
      return;
    }

    this.finished = true;
    if (finalText !== undefined) {
      this.currentText = finalText;
      if (finalText.trim().length > 0) {
        this.hasAnswerText = true;
      }
    }

    this.cancelScheduledEdit();
    await this.awaitInFlightEdit();

    const chunks = splitTelegramText(this.currentText, this.maxMessageChars);
    const [firstChunk, ...remainingChunks] = chunks;

    await this.ensureMessage();
    try {
      await this.deliverText(firstChunk ?? EMPTY_FINAL_TEXT, { final: true });
    } catch (error) {
      if (this.abortSignal?.aborted === true) {
        // Cancelled: deliver in place if we can, but never post a brand-new
        // message carrying content the user has already asked us to drop.
        this.logger?.warn?.("Telegram final delivery skipped after cancellation.", {
          error: errorMessage(error),
        });
        return;
      }
      await this.lastResortSend(firstChunk ?? EMPTY_FINAL_TEXT, error);
    }
    if (this.abortSignal?.aborted === true) {
      // Do not spray overflow continuation messages onto a cancelled run.
      return;
    }
    for (const chunk of remainingChunks) {
      await this.sendOverflowChunk(chunk);
    }
  }

  private interimDisplayText(): string {
    if (this.hasAnswerText || this.currentText.length > 0) {
      return this.currentText;
    }
    if (this.showThoughts && this.thinkingText.length > 0) {
      return `${THOUGHT_PREFIX}${this.thinkingText}`;
    }
    return this.statusText;
  }

  private async ensureMessage(): Promise<TelegramSentMessage> {
    if (this.sentMessage !== undefined) {
      return this.sentMessage;
    }

    if (this.sendMessagePromise === undefined) {
      const initialText = this.statusText;
      const params: TelegramSendMessageParams = {
        chat_id: this.chatId,
        text: initialText,
      };
      if (this.replyToMessageId !== undefined) {
        params.reply_to_message_id = this.replyToMessageId;
      }

      this.sendMessagePromise = this.api.sendMessage(params).then((message) => {
        this.lastFlushedText = initialText;
        this.lastFlushedHtml = false;
        return message;
      });
    }

    try {
      this.sentMessage = await this.sendMessagePromise;
    } catch (error) {
      // Do not poison future sends with a rejected promise.
      this.sendMessagePromise = undefined;
      throw error;
    }
    return this.sentMessage;
  }

  private scheduleEdit(): void {
    this.cancelScheduledEdit();

    if (this.editDebounceMs === 0) {
      this.startInFlightEdit();
      return;
    }

    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      this.startInFlightEdit();
    }, this.editDebounceMs);
  }

  private startInFlightEdit(): void {
    const text = buildStreamingPreview(this.interimDisplayText(), this.maxMessageChars);
    this.inFlightEdit = this.deliverText(text, { final: false }).catch((error: unknown) => {
      // Interim edits are best-effort; deliverText already swallows, but guard
      // against an abort rejection so a streaming hiccup never aborts the run.
      this.logger?.warn?.("Telegram stream interim edit failed (ignored).", {
        error: errorMessage(error),
      });
    });
    void this.inFlightEdit;
  }

  /**
   * Send `sourceText` to Telegram, classifying failures and recovering where
   * possible. Interim edits (`final: false`) are best-effort and never throw;
   * final delivery retries transient failures and throws TelegramDeliveryError
   * only when every path is exhausted.
   */
  private async deliverText(
    sourceText: string,
    options: { final: boolean },
  ): Promise<void> {
    const normalizedSource = normalizeTelegramText(sourceText);
    let useHtml = options.final && this.formatHtml;
    let renderedText = useHtml ? renderTelegramHtml(normalizedSource) : normalizedSource;
    if (useHtml && renderedText === normalizedSource) {
      // No markup survived rendering — avoid parse_mode entirely.
      useHtml = false;
    }

    if (renderedText === this.lastFlushedText && useHtml === this.lastFlushedHtml) {
      return;
    }

    const maxAttempts = options.final ? this.maxSendRetries + 1 : 1;
    let recreate = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (recreate) {
          const sent = await this.api.sendMessage(this.buildSendParams(renderedText, useHtml));
          this.sentMessage = sent;
        } else {
          const message = await this.ensureMessage();
          await this.api.editMessageText(this.buildEditParams(message, renderedText, useHtml));
        }
        this.lastFlushedText = renderedText;
        this.lastFlushedHtml = useHtml;
        return;
      } catch (error) {
        lastError = error;
        const outcome = classifyTelegramError(error);
        if (outcome.kind === "not_modified") {
          this.lastFlushedText = renderedText;
          this.lastFlushedHtml = useHtml;
          return;
        }
        if (outcome.kind === "reformat_plain" && useHtml) {
          useHtml = false;
          renderedText = normalizedSource;
          continue;
        }
        if (outcome.kind === "recreate" && this.abortSignal?.aborted !== true) {
          recreate = true;
          this.sentMessage = undefined;
          this.lastFlushedText = undefined;
          continue;
        }
        if (outcome.kind === "retry" && options.final && attempt < maxAttempts) {
          await this.sleep(this.retryDelayMs(outcome.retryAfterMs, attempt));
          if (this.abortSignal?.aborted === true) {
            break;
          }
          continue;
        }
        break;
      }
    }

    if (options.final) {
      throw new TelegramDeliveryError("Telegram final delivery failed.", {
        cause: lastError,
        attempts: maxAttempts,
      });
    }
    this.logger?.warn?.("Telegram stream interim edit failed (ignored).", {
      error: errorMessage(lastError),
    });
  }

  /**
   * The streamed message could not be edited or recreated in place. Post the
   * final answer as a brand-new plain message so the user still receives it.
   */
  private async lastResortSend(text: string, cause: unknown): Promise<void> {
    const normalized = normalizeTelegramText(text);
    const maxAttempts = this.maxSendRetries + 1;
    let lastError: unknown = cause;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const sent = await this.api.sendMessage(this.buildSendParams(normalized, false));
        this.sentMessage = sent;
        this.lastFlushedText = normalized;
        this.lastFlushedHtml = false;
        return;
      } catch (error) {
        lastError = error;
        const outcome = classifyTelegramError(error);
        if (outcome.kind === "retry" && attempt < maxAttempts) {
          await this.sleep(this.retryDelayMs(outcome.retryAfterMs, attempt));
          if (this.abortSignal?.aborted === true) {
            break;
          }
          continue;
        }
        break;
      }
    }

    throw new TelegramDeliveryError("Telegram delivery failed after fallback send.", {
      cause: lastError,
      attempts: maxAttempts,
    });
  }

  /** Overflow continuation chunks are best-effort: the primary answer already landed. */
  private async sendOverflowChunk(chunk: string): Promise<void> {
    const normalized = normalizeTelegramText(chunk);
    const maxAttempts = this.maxSendRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.api.sendMessage(this.buildSendParams(normalized, false));
        return;
      } catch (error) {
        const outcome = classifyTelegramError(error);
        if (outcome.kind === "retry" && attempt < maxAttempts) {
          await this.sleep(this.retryDelayMs(outcome.retryAfterMs, attempt));
          if (this.abortSignal?.aborted === true) {
            return;
          }
          continue;
        }
        this.logger?.warn?.("Telegram overflow chunk failed (ignored).", {
          error: errorMessage(error),
        });
        return;
      }
    }
  }

  private buildEditParams(
    message: TelegramSentMessage,
    text: string,
    useHtml: boolean,
  ): TelegramEditMessageTextParams {
    const params: TelegramEditMessageTextParams = {
      chat_id: this.chatId,
      message_id: message.message_id,
      text,
    };
    if (useHtml) {
      params.parse_mode = "HTML";
    }
    return params;
  }

  private buildSendParams(text: string, useHtml: boolean): TelegramSendMessageParams {
    const params: TelegramSendMessageParams = { chat_id: this.chatId, text };
    if (useHtml) {
      params.parse_mode = "HTML";
    }
    return params;
  }

  private retryDelayMs(retryAfterMs: number | undefined, attempt: number): number {
    const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1);
    const chosen = retryAfterMs ?? backoff;
    return Math.min(chosen, this.retryCapMs);
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.abortSignal?.aborted === true) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const signal = this.abortSignal;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private cancelScheduledEdit(): void {
    if (this.editTimer !== undefined) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
  }

  private async awaitInFlightEdit(): Promise<void> {
    if (this.inFlightEdit !== undefined) {
      await this.inFlightEdit;
      this.inFlightEdit = undefined;
    }
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error("Cannot write to a finished TelegramMessageStream.");
    }
  }
}

/**
 * Classify a Telegram send/edit failure into a recovery strategy. Pure and
 * exported so the recovery policy can be unit-tested directly.
 */
export function classifyTelegramError(error: unknown): TelegramSendOutcome {
  if (error instanceof TelegramApiError) {
    const description = (error.telegramDescription ?? "").toLowerCase();
    if (description.includes("message is not modified")) {
      return { kind: "not_modified" };
    }
    if (
      description.includes("message to edit not found") ||
      description.includes("message to be edited not found") ||
      description.includes("message can't be edited") ||
      description.includes("message_id_invalid")
    ) {
      return { kind: "recreate" };
    }
    if (
      description.includes("can't parse entities") ||
      description.includes("can't find end of the entity") ||
      description.includes("unsupported start tag") ||
      description.includes("unclosed")
    ) {
      return { kind: "reformat_plain" };
    }
    if (
      error.retryAfterMs !== undefined ||
      error.errorCode === 429 ||
      error.status === 429 ||
      description.includes("too many requests")
    ) {
      if (error.retryAfterMs !== undefined) {
        return { kind: "retry", retryAfterMs: error.retryAfterMs };
      }
      return { kind: "retry" };
    }
    if (error.kind === "network") {
      return { kind: "retry" };
    }
    if (error.kind === "aborted") {
      return { kind: "fatal" };
    }
    if (error.status !== undefined && error.status >= 500) {
      return { kind: "retry" };
    }
    return { kind: "fatal" };
  }

  // Non-TelegramApiError (e.g. a transient transport error or a test stub):
  // retry conservatively rather than surfacing it as a hard failure.
  return { kind: "retry" };
}

export function splitTelegramText(text: string, maxChars: number): string[] {
  return splitTextByCodePoints(
    normalizeTrailing(text, EMPTY_FINAL_TEXT),
    maxChars,
  );
}

function buildStreamingPreview(text: string, maxChars: number): string {
  return buildStreamingTailPreview(
    normalizeTrailing(text, EMPTY_FINAL_TEXT),
    maxChars,
    "…\n",
  );
}

function normalizeTelegramText(text: string): string {
  return text.trimEnd();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
