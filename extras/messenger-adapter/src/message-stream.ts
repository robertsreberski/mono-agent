import {
  DEFAULT_EMPTY_FINAL_TEXT,
  appendReplyPartFallback,
  normalizeTrailing,
  type AgentMessageFinishOptions,
  type AgentMessageStream,
} from "@mono-agent/agent-contracts";

import type { MessengerGraphClientLike, MessengerSendOptions } from "./graph-client.js";
import { MESSENGER_MAX_MESSAGE_CHARS, stripMarkdownForMessenger } from "./text.js";

export interface MessengerMessageStreamLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface MessengerMessageStreamOptions {
  readonly client: MessengerGraphClientLike;
  readonly recipientId: string;
  readonly send?: MessengerSendOptions;
  readonly maxMessageChars?: number;
  /** Flatten Markdown before sending (Messenger renders plain text). Default true. */
  readonly stripMarkdown?: boolean;
  readonly logger?: MessengerMessageStreamLogger;
}

/**
 * Buffered, final-only stream: Messenger cannot edit a sent message, so
 * intermediate deltas are accumulated and the final answer is posted once as
 * one or more 2,000-character Send API messages.
 */
export class MessengerMessageStream implements AgentMessageStream {
  private readonly client: MessengerGraphClientLike;
  private readonly recipientId: string;
  private readonly send: MessengerSendOptions;
  private readonly stripMarkdown: boolean;
  private readonly logger: MessengerMessageStreamLogger | undefined;
  private currentText = "";
  private finished = false;

  constructor(options: MessengerMessageStreamOptions) {
    this.client = options.client;
    this.recipientId = options.recipientId;
    this.send = { ...options.send, maxMessageChars: options.maxMessageChars ?? MESSENGER_MAX_MESSAGE_CHARS };
    this.stripMarkdown = options.stripMarkdown !== false;
    this.logger = options.logger;
  }

  async status(): Promise<void> {
    // Typing indicators are owned by the adapter; Messenger has no status message to edit.
    this.assertOpen();
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    this.currentText += delta;
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    this.currentText = text;
  }

  async finish(finalText?: string, options?: AgentMessageFinishOptions): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const deliveredText = appendReplyPartFallback(finalText, options?.parts);
    if (deliveredText !== undefined) {
      this.currentText = deliveredText;
    }
    const text = normalizeTrailing(this.currentText, DEFAULT_EMPTY_FINAL_TEXT);
    const rendered = this.stripMarkdown ? normalizeTrailing(stripMarkdownForMessenger(text), DEFAULT_EMPTY_FINAL_TEXT) : text;
    try {
      await this.client.sendText(this.recipientId, rendered, this.send);
    } catch (error) {
      this.logger?.error?.("Messenger stream send failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error("Cannot write to a finished MessengerMessageStream.");
    }
  }
}
