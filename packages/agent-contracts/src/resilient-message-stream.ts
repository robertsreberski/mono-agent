/**
 * Transport-agnostic resilient message stream.
 *
 * Generalizes the battle-tested finite-state machine that the Telegram and Slack
 * adapters had each hand-rolled: lazy first send, debounced interim edits,
 * overflow chunking, and a final delivery that classifies failures into a
 * recovery strategy (retry-with-backoff / recreate / reformat-plain /
 * not-modified / last-resort fresh send) with abort-aware sleeps and an
 * idempotent finish.
 *
 * A {@link ChannelTransport} supplies the channel API (post / edit / classify /
 * render-markdown) so this class never references a concrete chat platform. It
 * streams text as-is — there are no "answer" / "thinking" / "final-answer"
 * labels, and reasoning (assistant_thought) is never rendered as prose.
 */

import type {
  AgentMessageStream as AgentMessageStreamBase,
  AgentStreamEvent,
} from "./index.js";
import {
  DEFAULT_EMPTY_FINAL_TEXT,
  DEFAULT_MAX_MESSAGE_CHARS,
  buildStreamingTailPreview,
  normalizeTrailing,
  splitTextByCodePoints,
} from "./stream-text.js";
import { toolHintFor } from "./tool-hints.js";

/** Opaque handle to a posted message, returned by {@link ChannelTransport.post}. */
export interface MessageRef {
  readonly id: string;
  readonly [key: string]: unknown;
}

/** How a failed post/edit should be handled by {@link ResilientMessageStream}. */
export type ChannelSendOutcome =
  | { kind: "not_modified" }
  | { kind: "recreate" }
  | { kind: "reformat_plain" }
  | { kind: "retry"; retryAfterMs?: number }
  | { kind: "fatal" };

/**
 * Abstracts a chat channel's API so the resilience FSM is transport-agnostic.
 * Implementations wrap a concrete platform client (Telegram, Slack, …).
 */
export interface ChannelTransport {
  /** Per-message character budget for this channel. */
  readonly maxMessageChars: number;
  /** Post a new message and return a ref usable by {@link edit}. */
  post(text: string, options: { markdown: boolean }): Promise<MessageRef>;
  /** Edit a previously posted message in place. */
  edit(ref: MessageRef, text: string, options: { markdown: boolean }): Promise<void>;
  /** Classify a post/edit failure into a recovery strategy. */
  classifyError(error: unknown): ChannelSendOutcome;
  /** Render markdown to the channel's wire format. Defaults to identity. */
  renderMarkdown?(text: string): string;
}

export interface ResilientMessageStreamLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface ResilientMessageStreamOptions {
  transport: ChannelTransport;
  initialStatusText?: string;
  editDebounceMs?: number;
  /** Overrides `transport.maxMessageChars` when provided. */
  maxMessageChars?: number;
  /** Maximum retries for a *final* delivery before giving up. Default 3. */
  maxSendRetries?: number;
  /** Upper bound on any honored `retryAfterMs`/backoff wait, in ms. Default 60000. */
  retryCapMs?: number;
  /** Base delay for exponential backoff between final-delivery retries. Default 500. */
  retryBaseDelayMs?: number;
  /**
   * Show lightweight, friendly activity hints (e.g. "Searching the web…") while
   * the agent works, before any answer text has arrived. Default true.
   */
  showHints?: boolean;
  /** Render the final answer with `transport.renderMarkdown`. Default true. */
  formatMarkdown?: boolean;
  /** Aborts in-flight retry waits (e.g. on /cancel). */
  abortSignal?: AbortSignal;
  /** Injectable sleep so tests need not wait on real timers. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger?: ResilientMessageStreamLogger;
}

/**
 * Raised only when a *final* delivery cannot reach the channel after retries and
 * the last-resort fresh send. The AI request itself already succeeded, so a
 * caller should treat this as a degraded delivery — never as an agent failure.
 */
export class ChannelDeliveryError extends Error {
  override readonly cause: unknown;
  readonly attempts: number;

  constructor(message: string, details: { cause: unknown; attempts: number }) {
    super(message);
    this.name = "ChannelDeliveryError";
    this.cause = details.cause;
    this.attempts = details.attempts;
  }
}

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking…";
const DEFAULT_EDIT_DEBOUNCE_MS = 750;
const DEFAULT_MAX_SEND_RETRIES = 3;
const DEFAULT_RETRY_CAP_MS = 60_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const EMPTY_FINAL_TEXT = DEFAULT_EMPTY_FINAL_TEXT;

export interface ResilientAgentMessageStream extends AgentMessageStreamBase {
  status(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace(text: string): Promise<void>;
  event(event: AgentStreamEvent): Promise<void>;
  finish(finalText?: string): Promise<void>;
}

export class ResilientMessageStream implements ResilientAgentMessageStream {
  private readonly transport: ChannelTransport;
  private readonly initialStatusText: string;
  private readonly editDebounceMs: number;
  private readonly maxMessageChars: number;
  private readonly maxSendRetries: number;
  private readonly retryCapMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly showHints: boolean;
  private readonly formatMarkdown: boolean;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly logger: ResilientMessageStreamLogger | undefined;

  private currentText = "";
  private hasAnswerText = false;
  private statusText: string;
  private sentMessage: MessageRef | undefined;
  private sendMessagePromise: Promise<MessageRef> | undefined;
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlightEdit: Promise<void> | undefined;
  private lastFlushedText: string | undefined;
  private lastFlushedMarkdown = false;
  private finished = false;

  constructor(options: ResilientMessageStreamOptions) {
    this.transport = options.transport;
    this.initialStatusText = normalizeTrailing(
      options.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT,
      EMPTY_FINAL_TEXT,
    );
    this.statusText = this.initialStatusText;
    this.editDebounceMs = options.editDebounceMs ?? DEFAULT_EDIT_DEBOUNCE_MS;
    this.maxMessageChars = options.maxMessageChars ?? options.transport.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    this.maxSendRetries = options.maxSendRetries ?? DEFAULT_MAX_SEND_RETRIES;
    this.retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.showHints = options.showHints ?? true;
    this.formatMarkdown = options.formatMarkdown ?? true;
    this.abortSignal = options.abortSignal;
    this.sleepFn = options.sleep ?? defaultSleep;
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
    this.statusText = normalizeTrailing(text, EMPTY_FINAL_TEXT);
    const hadMessage = this.sentMessage !== undefined;
    await this.ensureMessage();
    if (hadMessage && !this.hasAnswerText) {
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
      // Reasoning prose is never rendered to the user — not as a labelled
      // "Thinking" message, not inline. It is dropped entirely.
      return;
    }

    if (event.type === "runtime_warning") {
      this.logger?.warn?.("Resilient stream received runtime warning.", {
        warningKind: event.warningKind,
        message: event.message,
      });
      return;
    }

    if (event.type === "tool_call_started") {
      this.logger?.debug?.("Resilient stream received tool start event.", {
        id: event.id,
        name: event.name,
      });
      // Surface a lightweight, friendly activity hint while we work. Hints only
      // refresh the message until answer text starts arriving, at which point
      // the streamed answer takes over and is never clobbered by a later hint.
      if (!this.showHints || this.hasAnswerText) {
        return;
      }
      this.statusText = normalizeTrailing(toolHintFor(event.name), EMPTY_FINAL_TEXT);
      const hadMessage = this.sentMessage !== undefined;
      await this.ensureMessage();
      if (hadMessage) {
        await this.deliverText(this.statusText, { final: false });
      } else {
        this.scheduleEdit();
      }
      return;
    }

    if (event.type === "tool_call_completed") {
      this.logger?.debug?.("Resilient stream received tool completion event.", {
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

    const finalMessageText = normalizeTrailing(this.currentText, EMPTY_FINAL_TEXT);
    const chunks = splitTextByCodePoints(finalMessageText, this.maxMessageChars);
    const [firstChunk, ...remainingChunks] = chunks;

    await this.ensureMessage();
    try {
      await this.deliverText(firstChunk ?? EMPTY_FINAL_TEXT, { final: true });
    } catch (error) {
      if (this.abortSignal?.aborted === true) {
        // Cancelled: deliver in place if we can, but never post a brand-new
        // message carrying content the user has already asked us to drop.
        this.logger?.warn?.("Resilient final delivery skipped after cancellation.", {
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
      // The answer streams directly — no label.
      return buildStreamingTailPreview(
        normalizeTrailing(this.currentText, EMPTY_FINAL_TEXT),
        this.maxMessageChars,
        "…\n",
      );
    }
    // No answer yet: show the current status/activity hint as-is.
    return buildStreamingTailPreview(
      normalizeTrailing(this.statusText, EMPTY_FINAL_TEXT),
      this.maxMessageChars,
      "…\n",
    );
  }

  private render(text: string, markdown: boolean): string {
    if (!markdown) {
      return text;
    }
    return this.transport.renderMarkdown ? this.transport.renderMarkdown(text) : text;
  }

  private async ensureMessage(): Promise<MessageRef> {
    if (this.sentMessage !== undefined) {
      return this.sentMessage;
    }

    if (this.sendMessagePromise === undefined) {
      const initialText = this.statusText;
      this.sendMessagePromise = this.transport
        .post(initialText, { markdown: false })
        .then((message) => {
          this.lastFlushedText = initialText;
          this.lastFlushedMarkdown = false;
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
    const text = this.interimDisplayText();
    this.inFlightEdit = this.deliverText(text, { final: false }).catch((error: unknown) => {
      // Interim edits are best-effort; deliverText already swallows, but guard
      // against an abort rejection so a streaming hiccup never aborts the run.
      this.logger?.warn?.("Resilient stream interim edit failed (ignored).", {
        error: errorMessage(error),
      });
    });
    void this.inFlightEdit;
  }

  /**
   * Send `sourceText` to the channel, classifying failures and recovering where
   * possible. Interim edits (`final: false`) are best-effort and never throw;
   * final delivery retries transient failures and throws ChannelDeliveryError
   * only when every path is exhausted.
   */
  private async deliverText(
    sourceText: string,
    options: { final: boolean },
  ): Promise<void> {
    const normalizedSource = normalizeTrailing(sourceText, EMPTY_FINAL_TEXT);
    let useMarkdown = options.final && this.formatMarkdown;
    let renderedText = this.render(normalizedSource, useMarkdown);

    if (renderedText === this.lastFlushedText && useMarkdown === this.lastFlushedMarkdown) {
      return;
    }

    const maxAttempts = options.final ? this.maxSendRetries + 1 : 1;
    let recreate = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (recreate) {
          const sent = await this.transport.post(renderedText, { markdown: useMarkdown });
          this.sentMessage = sent;
        } else {
          const message = await this.ensureMessage();
          await this.transport.edit(message, renderedText, { markdown: useMarkdown });
        }
        this.lastFlushedText = renderedText;
        this.lastFlushedMarkdown = useMarkdown;
        return;
      } catch (error) {
        lastError = error;
        const outcome = this.transport.classifyError(error);
        if (outcome.kind === "not_modified") {
          this.lastFlushedText = renderedText;
          this.lastFlushedMarkdown = useMarkdown;
          return;
        }
        if (outcome.kind === "reformat_plain" && useMarkdown) {
          useMarkdown = false;
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
      throw new ChannelDeliveryError("Channel final delivery failed.", {
        cause: lastError,
        attempts: maxAttempts,
      });
    }
    this.logger?.warn?.("Resilient stream interim edit failed (ignored).", {
      error: errorMessage(lastError),
    });
  }

  /**
   * The streamed message could not be edited or recreated in place. Post the
   * final answer as a brand-new plain message so the user still receives it.
   */
  private async lastResortSend(text: string, cause: unknown): Promise<void> {
    const normalized = normalizeTrailing(text, EMPTY_FINAL_TEXT);
    const maxAttempts = this.maxSendRetries + 1;
    let lastError: unknown = cause;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const sent = await this.transport.post(normalized, { markdown: false });
        this.sentMessage = sent;
        this.lastFlushedText = normalized;
        this.lastFlushedMarkdown = false;
        return;
      } catch (error) {
        lastError = error;
        const outcome = this.transport.classifyError(error);
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

    throw new ChannelDeliveryError("Channel delivery failed after fallback send.", {
      cause: lastError,
      attempts: maxAttempts,
    });
  }

  /** Overflow continuation chunks are best-effort: the primary answer already landed. */
  private async sendOverflowChunk(chunk: string): Promise<void> {
    const normalized = normalizeTrailing(chunk, EMPTY_FINAL_TEXT);
    const maxAttempts = this.maxSendRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.transport.post(normalized, { markdown: false });
        return;
      } catch (error) {
        const outcome = this.transport.classifyError(error);
        if (outcome.kind === "retry" && attempt < maxAttempts) {
          await this.sleep(this.retryDelayMs(outcome.retryAfterMs, attempt));
          if (this.abortSignal?.aborted === true) {
            return;
          }
          continue;
        }
        this.logger?.warn?.("Resilient overflow chunk failed (ignored).", {
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

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.abortSignal?.aborted === true) {
      return;
    }
    await this.sleepFn(ms, this.abortSignal);
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
      throw new Error("Cannot write to a finished ResilientMessageStream.");
    }
  }
}

/** Default abort-aware sleep used when no `sleep` is injected. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
