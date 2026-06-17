import {
  DEFAULT_EMPTY_FINAL_TEXT,
  DEFAULT_MAX_MESSAGE_CHARS,
  buildStreamingTailPreview,
  normalizeTrailing,
  splitTextByCodePoints,
  toolHintFor,
} from "@mono-agent/agent-contracts";
import type {
  AgentMessageStream as AgentMessageStreamBase,
  AgentStreamEvent,
} from "@mono-agent/agent-contracts";

import { SlackApiError } from "./slack-client.js";
import type {
  SlackChannelId,
  SlackChatPostMessageResult,
  SlackMessageTs,
  SlackWebApi,
} from "./types.js";
import { formatMarkdownForSlack } from "./slack-markdown.js";

export interface AgentMessageStream extends AgentMessageStreamBase {
  status(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace(text: string): Promise<void>;
  event(event: AgentStreamEvent): Promise<void>;
  finish(finalText?: string): Promise<void>;
}

export interface SlackMessageStreamOptions {
  api: SlackWebApi;
  channelId: SlackChannelId;
  threadTs?: SlackMessageTs;
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
  /** Maximum retries for a *final* delivery before giving up. Default 3. */
  maxSendRetries?: number;
  /** Upper bound on any honored `retry-after`/backoff wait, in ms. Default 60000. */
  retryCapMs?: number;
  /** Base delay for exponential backoff between final-delivery retries. Default 500. */
  retryBaseDelayMs?: number;
  /** Render lightweight tool activity hints as the live status. Default true. */
  showHints?: boolean;
  /** Aborts in-flight retry waits (e.g. on /cancel). */
  abortSignal?: AbortSignal;
  logger?: SlackMessageStreamLogger;
}

export interface SlackMessageStreamLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Raised only when a *final* delivery cannot reach Slack after retries and the
 * last-resort fresh post. The AI request itself already succeeded, so the
 * adapter treats this as a degraded delivery — never as an agent failure.
 */
export class SlackDeliveryError extends Error {
  override readonly cause: unknown;
  readonly attempts: number;

  constructor(message: string, details: { cause: unknown; attempts: number }) {
    super(message);
    this.name = "SlackDeliveryError";
    this.cause = details.cause;
    this.attempts = details.attempts;
  }
}

/** How a failed Slack post/update should be handled. */
export type SlackSendOutcome =
  | { kind: "recreate" }
  | { kind: "reformat_plain" }
  | { kind: "retry"; retryAfterMs?: number }
  | { kind: "fatal" };

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking...";
const DEFAULT_EDIT_DEBOUNCE_MS = 750;
const DEFAULT_MAX_SEND_RETRIES = 3;
const DEFAULT_RETRY_CAP_MS = 60_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const EMPTY_FINAL_TEXT = DEFAULT_EMPTY_FINAL_TEXT;

export class SlackMessageStream implements AgentMessageStream {
  private readonly api: SlackWebApi;
  private readonly channelId: SlackChannelId;
  private readonly threadTs: SlackMessageTs | undefined;
  private readonly initialStatusText: string;
  private readonly editDebounceMs: number;
  private readonly maxMessageChars: number;
  private readonly maxSendRetries: number;
  private readonly retryCapMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly showHints: boolean;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly logger: SlackMessageStreamLogger | undefined;

  private currentText = "";
  private hasAnswerText = false;
  private statusText: string;
  private sentMessage: SlackChatPostMessageResult | undefined;
  private sendMessagePromise: Promise<SlackChatPostMessageResult> | undefined;
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlightUpdate: Promise<void> | undefined;
  private lastFlushedText: string | undefined;
  private lastFlushedMrkdwn = true;
  private finished = false;

  constructor(options: SlackMessageStreamOptions) {
    this.api = options.api;
    this.channelId = options.channelId;
    this.threadTs = options.threadTs;
    this.initialStatusText = normalizeTrailing(
      options.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT,
      EMPTY_FINAL_TEXT,
    );
    this.statusText = this.initialStatusText;
    this.editDebounceMs = options.editDebounceMs ?? DEFAULT_EDIT_DEBOUNCE_MS;
    this.maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    this.maxSendRetries = options.maxSendRetries ?? DEFAULT_MAX_SEND_RETRIES;
    this.retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.showHints = options.showHints ?? true;
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
    await this.awaitInFlightUpdate();
    this.statusText = normalizeTrailing(text, EMPTY_FINAL_TEXT);
    const hadMessage = this.sentMessage !== undefined;
    await this.ensureMessage();
    if (hadMessage && !this.hasAnswerText) {
      await this.deliverText(this.statusText, { final: false });
    }
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    await this.awaitInFlightUpdate();
    if (delta.length === 0) {
      return;
    }

    this.currentText += delta;
    if (!this.hasAnswerText && delta.trim().length > 0) {
      this.hasAnswerText = true;
    }
    await this.ensureMessage();
    this.scheduleUpdate();
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    await this.awaitInFlightUpdate();
    this.currentText = text;
    if (text.trim().length > 0) {
      this.hasAnswerText = true;
    }
    await this.ensureMessage();
    this.scheduleUpdate();
  }

  async event(event: AgentStreamEvent): Promise<void> {
    this.assertOpen();
    await this.awaitInFlightUpdate();

    if (event.type === "assistant_thought") {
      // Reasoning is never rendered as prose in Slack — it is private. Ignore it.
      return;
    }

    if (event.type === "runtime_warning") {
      this.logger?.warn?.("Slack stream received runtime warning.", {
        warningKind: event.warningKind,
        message: event.message,
      });
      return;
    }

    if (event.type === "tool_call_started") {
      this.logger?.debug?.("Slack stream received tool start event.", {
        id: event.id,
        name: event.name,
      });
      // Surface a friendly activity hint while we have no answer text yet. Once
      // the answer starts streaming, the hint must never overwrite it.
      if (!this.showHints || this.hasAnswerText) {
        return;
      }
      this.statusText = normalizeTrailing(toolHintFor(event.name), EMPTY_FINAL_TEXT);
      const hadMessage = this.sentMessage !== undefined;
      await this.ensureMessage();
      if (hadMessage) {
        await this.deliverText(this.statusText, { final: false });
      }
      return;
    }

    if (event.type === "tool_call_completed") {
      this.logger?.debug?.("Slack stream received tool completion event.", {
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

    this.cancelScheduledUpdate();
    await this.awaitInFlightUpdate();

    const finalMessageText = normalizeTrailing(
      this.currentText.length > 0 ? this.currentText : EMPTY_FINAL_TEXT,
      EMPTY_FINAL_TEXT,
    );
    const chunks = splitTextByCodePoints(finalMessageText, this.maxMessageChars);
    const [firstChunk, ...remainingChunks] = chunks;

    await this.ensureMessage();
    try {
      await this.deliverText(firstChunk ?? EMPTY_FINAL_TEXT, { final: true });
    } catch (error) {
      if (this.abortSignal?.aborted === true) {
        // Cancelled: deliver in place if we can, but never post a brand-new
        // message carrying content the user has already asked us to drop.
        this.logger?.warn?.("Slack final delivery skipped after cancellation.", {
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
      return buildStreamingTailPreview(
        normalizeTrailing(this.currentText, EMPTY_FINAL_TEXT),
        this.maxMessageChars,
        "...\n",
      );
    }
    return buildStreamingTailPreview(
      normalizeTrailing(this.statusText, EMPTY_FINAL_TEXT),
      this.maxMessageChars,
      "...\n",
    );
  }

  private async ensureMessage(): Promise<SlackChatPostMessageResult> {
    if (this.sentMessage !== undefined) {
      return this.sentMessage;
    }

    if (this.sendMessagePromise === undefined) {
      const initialText = this.statusText;
      const initialMrkdwn = true;
      this.sendMessagePromise = this.api
        .chatPostMessage(this.withThread({
          channel: this.channelId,
          text: formatMarkdownForSlack(initialText),
          mrkdwn: initialMrkdwn,
        }))
        .then((message) => {
          this.lastFlushedText = formatMarkdownForSlack(initialText);
          this.lastFlushedMrkdwn = initialMrkdwn;
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

  private withThread<T extends { thread_ts?: SlackMessageTs }>(
    params: Omit<T, "thread_ts">,
  ): T {
    if (this.threadTs === undefined) {
      return params as T;
    }
    return { ...params, thread_ts: this.threadTs } as T;
  }

  private scheduleUpdate(): void {
    this.cancelScheduledUpdate();
    if (this.editDebounceMs === 0) {
      this.startInFlightUpdate();
      return;
    }

    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      this.startInFlightUpdate();
    }, this.editDebounceMs);
  }

  private startInFlightUpdate(): void {
    const text = this.interimDisplayText();
    this.inFlightUpdate = this.deliverText(text, { final: false }).catch((error: unknown) => {
      // Interim edits are best-effort; deliverText already swallows, but guard
      // against an abort rejection so a streaming hiccup never aborts the run.
      this.logger?.warn?.("Slack stream interim update failed (ignored).", {
        error: errorMessage(error),
      });
    });
    void this.inFlightUpdate;
  }

  /**
   * Send `sourceText` to Slack, classifying failures and recovering where
   * possible. Interim edits (`final: false`) are best-effort and never throw;
   * final delivery retries transient failures and throws SlackDeliveryError only
   * when every path is exhausted.
   */
  private async deliverText(
    sourceText: string,
    options: { final: boolean },
  ): Promise<void> {
    const renderedText = formatMarkdownForSlack(normalizeTrailing(sourceText, EMPTY_FINAL_TEXT));
    let useMrkdwn = true;

    if (renderedText === this.lastFlushedText && useMrkdwn === this.lastFlushedMrkdwn) {
      return;
    }

    const maxAttempts = options.final ? this.maxSendRetries + 1 : 1;
    let recreate = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (recreate) {
          const sent = await this.api.chatPostMessage(
            this.withThread({ channel: this.channelId, text: renderedText, mrkdwn: useMrkdwn }),
          );
          this.sentMessage = sent;
        } else {
          const message = await this.ensureMessage();
          await this.api.chatUpdate({
            channel: this.channelId,
            ts: message.ts,
            text: renderedText,
            mrkdwn: useMrkdwn,
          });
        }
        this.lastFlushedText = renderedText;
        this.lastFlushedMrkdwn = useMrkdwn;
        return;
      } catch (error) {
        lastError = error;
        const outcome = classifySlackError(error);
        if (outcome.kind === "reformat_plain" && useMrkdwn) {
          useMrkdwn = false;
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
      throw new SlackDeliveryError("Slack final delivery failed.", {
        cause: lastError,
        attempts: maxAttempts,
      });
    }
    this.logger?.warn?.("Slack stream interim update failed (ignored).", {
      error: errorMessage(lastError),
    });
  }

  /**
   * The streamed message could not be edited or recreated in place. Post the
   * final answer as a brand-new plain message so the user still receives it.
   */
  private async lastResortSend(text: string, cause: unknown): Promise<void> {
    const rendered = formatMarkdownForSlack(normalizeTrailing(text, EMPTY_FINAL_TEXT));
    const maxAttempts = this.maxSendRetries + 1;
    let lastError: unknown = cause;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const sent = await this.api.chatPostMessage(
          this.withThread({ channel: this.channelId, text: rendered, mrkdwn: true }),
        );
        this.sentMessage = sent;
        this.lastFlushedText = rendered;
        this.lastFlushedMrkdwn = true;
        return;
      } catch (error) {
        lastError = error;
        const outcome = classifySlackError(error);
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

    throw new SlackDeliveryError("Slack delivery failed after fallback post.", {
      cause: lastError,
      attempts: maxAttempts,
    });
  }

  /** Overflow continuation chunks are best-effort: the primary answer already landed. */
  private async sendOverflowChunk(chunk: string): Promise<void> {
    const rendered = formatMarkdownForSlack(normalizeTrailing(chunk, EMPTY_FINAL_TEXT));
    const maxAttempts = this.maxSendRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.api.chatPostMessage(
          this.withThread({ channel: this.channelId, text: rendered, mrkdwn: true }),
        );
        return;
      } catch (error) {
        const outcome = classifySlackError(error);
        if (outcome.kind === "retry" && attempt < maxAttempts) {
          await this.sleep(this.retryDelayMs(outcome.retryAfterMs, attempt));
          if (this.abortSignal?.aborted === true) {
            return;
          }
          continue;
        }
        this.logger?.warn?.("Slack overflow chunk failed (ignored).", {
          error: errorMessage(error),
        });
        return;
      }
    }
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

  private cancelScheduledUpdate(): void {
    if (this.editTimer !== undefined) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
  }

  private async awaitInFlightUpdate(): Promise<void> {
    if (this.inFlightUpdate !== undefined) {
      await this.inFlightUpdate;
      this.inFlightUpdate = undefined;
    }
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error("Cannot write to a finished SlackMessageStream.");
    }
  }
}

/**
 * Classify a Slack post/update failure into a recovery strategy. Pure and
 * exported so the recovery policy can be unit-tested directly.
 */
export function classifySlackError(error: unknown): SlackSendOutcome {
  if (error instanceof SlackApiError) {
    const slackError = (error.slackError ?? "").toLowerCase();
    if (
      slackError === "message_not_found" ||
      slackError === "cant_update_message" ||
      slackError === "edit_window_closed"
    ) {
      return { kind: "recreate" };
    }
    if (
      slackError === "invalid_blocks" ||
      slackError === "invalid_block_id" ||
      slackError === "msg_blocks_too_long" ||
      slackError === "as_user_not_supported"
    ) {
      return { kind: "reformat_plain" };
    }
    if (
      error.retryAfterMs !== undefined ||
      error.status === 429 ||
      slackError === "ratelimited" ||
      slackError === "rate_limited"
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

  // Non-SlackApiError (e.g. a transient transport error or a test stub): retry
  // conservatively rather than surfacing it as a hard failure.
  return { kind: "retry" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
