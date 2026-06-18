import {
  ChannelDeliveryError,
  DEFAULT_MAX_MESSAGE_CHARS,
  ResilientMessageStream,
} from "@mono-agent/agent-contracts";
import type {
  AgentMessageStream as AgentMessageStreamBase,
  AgentStreamEvent,
  ChannelSendOutcome,
  ChannelTransport,
  MessageRef,
  ResilientMessageStreamLogger,
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

export type SlackMessageStreamLogger = ResilientMessageStreamLogger;

export interface SlackMessageStreamOptions {
  api: SlackWebApi;
  channelId: SlackChannelId;
  threadTs?: SlackMessageTs;
  /** Message ts to react to (👀 "seen") in final-only mode. */
  reactToTs?: SlackMessageTs;
  /**
   * Deliver only the final answer: suppress interim edits and react 👀 ("seen")
   * while the agent works. Default false.
   */
  finalOnly?: boolean;
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
  /**
   * Status shown via `assistant.threads.setStatus` ("App is <status>") while the
   * agent works, when this is a Slack AI-assistant thread. Falls back to the 👀
   * reaction in regular channels/DMs. Default "is thinking…".
   */
  assistantStatusText?: string;
  /** Aborts in-flight retry waits (e.g. on /cancel). */
  abortSignal?: AbortSignal;
  logger?: SlackMessageStreamLogger;
}

/**
 * Raised only when a *final* delivery cannot reach Slack after retries and the
 * last-resort fresh post. The AI request itself already succeeded, so the
 * adapter treats this as a degraded delivery — never as an agent failure.
 *
 * Retained as the adapter's public error type; the shared substrate raises a
 * {@link ChannelDeliveryError}, which this class normalizes so callers continue
 * to catch `SlackDeliveryError`.
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
const DEFAULT_ASSISTANT_STATUS_TEXT = "is thinking…";

/**
 * Adapts a {@link SlackWebApi} to the transport-agnostic {@link ChannelTransport}
 * the shared {@link ResilientMessageStream} drives. Posts/edits map to
 * chat.postMessage / chat.update (preserving `thread_ts`), failures are mapped
 * through {@link classifySlackError}, and markdown renders via
 * {@link formatMarkdownForSlack}. `mrkdwn` mirrors the substrate's markdown flag
 * so a `reformat_plain` retry drops to plain text.
 */
class SlackChannelTransport implements ChannelTransport {
  readonly maxMessageChars: number;
  private readonly api: SlackWebApi;
  private readonly channelId: SlackChannelId;
  private readonly threadTs: SlackMessageTs | undefined;
  private readonly reactToTs: SlackMessageTs | undefined;
  private readonly assistantStatusText: string;
  private reacted = false;
  private assistantStatusUnavailable = false;

  constructor(options: {
    api: SlackWebApi;
    channelId: SlackChannelId;
    threadTs?: SlackMessageTs;
    reactToTs?: SlackMessageTs;
    assistantStatusText: string;
    maxMessageChars: number;
  }) {
    this.api = options.api;
    this.channelId = options.channelId;
    this.threadTs = options.threadTs;
    this.reactToTs = options.reactToTs;
    this.assistantStatusText = options.assistantStatusText;
    this.maxMessageChars = options.maxMessageChars;
  }

  async indicateActivity(): Promise<void> {
    // Prefer Slack's official assistant-thread status ("App is <status>"), which
    // Slack auto-clears when the app posts its next message to the thread. It only
    // works inside an AI-assistant thread (needs the assistant:write scope), so if
    // it is unavailable or errors we stop trying for this stream and fall back to
    // the 👀 reaction used in regular channels/DMs.
    if (
      !this.assistantStatusUnavailable &&
      this.threadTs !== undefined &&
      this.api.setAssistantStatus !== undefined
    ) {
      try {
        await this.api.setAssistantStatus({
          channelId: this.channelId,
          threadTs: this.threadTs,
          status: this.assistantStatusText,
        });
        return;
      } catch {
        // Not an assistant thread (or missing scope): don't retry it this stream.
        this.assistantStatusUnavailable = true;
      }
    }
    // Slack has no bot "typing" indicator, so signal "seen" with a 👀 reaction on
    // the triggering message — added once (Slack rejects duplicates).
    if (this.reacted || this.reactToTs === undefined || this.api.reactionsAdd === undefined) {
      return;
    }
    this.reacted = true;
    await this.api.reactionsAdd({ channel: this.channelId, timestamp: this.reactToTs, name: "eyes" });
  }

  async post(text: string, options: { markdown: boolean }): Promise<MessageRef> {
    const sent = await this.api.chatPostMessage(
      this.withThread({ channel: this.channelId, text, mrkdwn: options.markdown }),
    );
    return slackMessageRef(sent);
  }

  async edit(ref: MessageRef, text: string, options: { markdown: boolean }): Promise<void> {
    await this.api.chatUpdate({
      channel: this.channelId,
      ts: ref.id,
      text,
      mrkdwn: options.markdown,
    });
  }

  classifyError(error: unknown): ChannelSendOutcome {
    return classifySlackError(error);
  }

  renderMarkdown(text: string): string {
    return formatMarkdownForSlack(text);
  }

  private withThread<T extends { thread_ts?: SlackMessageTs }>(
    params: Omit<T, "thread_ts">,
  ): T {
    if (this.threadTs === undefined) {
      return params as T;
    }
    return { ...params, thread_ts: this.threadTs } as T;
  }
}

function slackMessageRef(message: SlackChatPostMessageResult): MessageRef {
  return { id: message.ts, channel: message.channel };
}

/**
 * Thin wrapper over the shared {@link ResilientMessageStream}. It builds a
 * {@link SlackChannelTransport} and delegates the streaming/resilience FSM,
 * preserving the adapter's public surface: the `status/append/replace/event/
 * finish` API, friendly tool hints, abort-aware retries, and a Slack-shaped
 * delivery error.
 */
export class SlackMessageStream implements AgentMessageStream {
  private readonly inner: ResilientMessageStream;

  constructor(options: SlackMessageStreamOptions) {
    const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    const transport = new SlackChannelTransport({
      api: options.api,
      channelId: options.channelId,
      ...(options.threadTs === undefined ? {} : { threadTs: options.threadTs }),
      ...(options.reactToTs === undefined ? {} : { reactToTs: options.reactToTs }),
      assistantStatusText: options.assistantStatusText ?? DEFAULT_ASSISTANT_STATUS_TEXT,
      maxMessageChars,
    });

    this.inner = new ResilientMessageStream({
      transport,
      initialStatusText: options.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT,
      maxMessageChars,
      formatMarkdown: true,
      ...(options.finalOnly === undefined ? {} : { finalOnly: options.finalOnly }),
      ...(options.editDebounceMs === undefined ? {} : { editDebounceMs: options.editDebounceMs }),
      ...(options.maxSendRetries === undefined ? {} : { maxSendRetries: options.maxSendRetries }),
      ...(options.retryCapMs === undefined ? {} : { retryCapMs: options.retryCapMs }),
      ...(options.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: options.retryBaseDelayMs }),
      ...(options.showHints === undefined ? {} : { showHints: options.showHints }),
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  status(text: string): Promise<void> {
    return this.inner.status(text);
  }

  append(delta: string): Promise<void> {
    return this.inner.append(delta);
  }

  replace(text: string): Promise<void> {
    return this.inner.replace(text);
  }

  event(event: AgentStreamEvent): Promise<void> {
    return this.inner.event(event);
  }

  async finish(finalText?: string): Promise<void> {
    try {
      await this.inner.finish(finalText);
    } catch (error) {
      if (error instanceof ChannelDeliveryError) {
        throw new SlackDeliveryError("Slack final delivery failed.", {
          cause: error.cause,
          attempts: error.attempts,
        });
      }
      throw error;
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
