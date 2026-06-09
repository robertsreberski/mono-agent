import {
  DEFAULT_EMPTY_FINAL_TEXT,
  DEFAULT_MAX_MESSAGE_CHARS,
  buildStreamingTailPreview,
  normalizeTrailing,
  splitTextByCodePoints,
} from "@worklab-ai/agent-contracts";
import type { AgentMessageStream as AgentMessageStreamBase } from "@worklab-ai/agent-contracts";

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
  finish(finalText?: string): Promise<void>;
}

export interface SlackMessageStreamOptions {
  api: SlackWebApi;
  channelId: SlackChannelId;
  threadTs?: SlackMessageTs;
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
  logger?: SlackMessageStreamLogger;
}

export interface SlackMessageStreamLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking...";
const DEFAULT_EDIT_DEBOUNCE_MS = 750;
const EMPTY_FINAL_TEXT = DEFAULT_EMPTY_FINAL_TEXT;

export class SlackMessageStream implements AgentMessageStream {
  private readonly api: SlackWebApi;
  private readonly channelId: SlackChannelId;
  private readonly threadTs: SlackMessageTs | undefined;
  private readonly initialStatusText: string;
  private readonly editDebounceMs: number;
  private readonly maxMessageChars: number;
  private readonly logger: SlackMessageStreamLogger | undefined;

  private currentText = "";
  private statusText: string;
  private sentMessage: SlackChatPostMessageResult | undefined;
  private sendMessagePromise: Promise<SlackChatPostMessageResult> | undefined;
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlightUpdate: Promise<void> | undefined;
  private lastAsyncError: unknown;
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
    this.logger = options.logger;

    if (!Number.isInteger(this.maxMessageChars) || this.maxMessageChars < 32) {
      throw new RangeError("maxMessageChars must be an integer of at least 32.");
    }
    if (!Number.isFinite(this.editDebounceMs) || this.editDebounceMs < 0) {
      throw new RangeError("editDebounceMs must be a non-negative number.");
    }
  }

  async status(text: string): Promise<void> {
    this.assertOpen();
    await this.throwIfAsyncError();
    this.statusText = normalizeTrailing(text, EMPTY_FINAL_TEXT);
    const hadMessage = this.sentMessage !== undefined;
    await this.ensureMessage();
    if (hadMessage) {
      await this.flushUpdate(this.statusText);
    }
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    await this.throwIfAsyncError();
    if (delta.length === 0) {
      return;
    }

    this.currentText += delta;
    await this.ensureMessage();
    this.scheduleUpdate();
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    await this.throwIfAsyncError();
    this.currentText = text;
    await this.ensureMessage();
    this.scheduleUpdate();
  }

  async finish(finalText?: string): Promise<void> {
    if (this.finished) {
      return;
    }

    this.finished = true;
    if (finalText !== undefined) {
      this.currentText = finalText;
    }

    this.cancelScheduledUpdate();
    await this.throwIfAsyncError();
    await this.awaitInFlightUpdate();
    await this.throwIfAsyncError();

    const finalMessageText = normalizeTrailing(
      this.currentText.length > 0 ? this.currentText : EMPTY_FINAL_TEXT,
      EMPTY_FINAL_TEXT,
    );
    const chunks = splitTextByCodePoints(finalMessageText, this.maxMessageChars);
    const [firstChunk, ...remainingChunks] = chunks;

    await this.ensureMessage();
    await this.flushUpdate(firstChunk ?? EMPTY_FINAL_TEXT);
    for (const chunk of remainingChunks) {
      await this.api.chatPostMessage(this.withThread({
        channel: this.channelId,
        text: formatMarkdownForSlack(chunk),
        mrkdwn: true,
      }));
    }
  }

  private async ensureMessage(): Promise<SlackChatPostMessageResult> {
    if (this.sentMessage !== undefined) {
      return this.sentMessage;
    }

    if (this.sendMessagePromise === undefined) {
      this.sendMessagePromise = this.api.chatPostMessage(this.withThread({
        channel: this.channelId,
        text: formatMarkdownForSlack(this.statusText),
        mrkdwn: true,
      }));
    }

    this.sentMessage = await this.sendMessagePromise;
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
    const text = buildStreamingTailPreview(
      normalizeTrailing(this.currentText, EMPTY_FINAL_TEXT),
      this.maxMessageChars,
      "...\n",
    );
    this.inFlightUpdate = this.flushUpdate(text).catch((error: unknown) => {
      this.lastAsyncError = error;
      this.logger?.error?.("Slack stream update failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
    void this.inFlightUpdate.catch(() => undefined);
  }

  private async flushUpdate(text: string): Promise<void> {
    const message = await this.ensureMessage();
    await this.api.chatUpdate({
      channel: this.channelId,
      ts: message.ts,
      text: formatMarkdownForSlack(normalizeTrailing(text, EMPTY_FINAL_TEXT)),
      mrkdwn: true,
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

  private async throwIfAsyncError(): Promise<void> {
    if (this.inFlightUpdate !== undefined) {
      await this.awaitInFlightUpdate();
    }

    if (this.lastAsyncError !== undefined) {
      const error = this.lastAsyncError;
      this.lastAsyncError = undefined;
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error("Cannot write to a finished SlackMessageStream.");
    }
  }
}
