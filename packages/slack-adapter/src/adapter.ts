import {
  isAgentResponseCancelledError,
  type AgentAttachment,
  type AgentRequestBase,
  type AgentResponder as SharedAgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";

import {
  SlackMessageStream,
  type AgentMessageStream,
  type SlackMessageStreamLogger,
  type SlackMessageStreamOptions,
} from "./message-stream.js";
import type {
  SlackChannelId,
  SlackEventBase,
  SlackEventCallback,
  SlackFile,
  SlackMessageTs,
  SlackUserId,
  SlackWebApi,
} from "./types.js";

export type SlackTriggerKind = "direct" | "app_mention";

export interface AgentRequest extends AgentRequestBase {
  conversationId: string;
  channelId: SlackChannelId;
  messageTs: SlackMessageTs;
  threadTs: SlackMessageTs;
  eventId: string;
  teamId?: string;
  userId?: SlackUserId;
  text: string;
  trigger: SlackTriggerKind;
  abortSignal: AbortSignal;
  attachments?: readonly AgentAttachment[];
  metadata: {
    slack: SlackRequestMetadata;
    [key: string]: unknown;
  };
}

/** Tunes how inbound Slack file attachments are downloaded. */
export interface SlackAttachmentOptions {
  /**
   * Maximum decoded bytes to accept per file. Files whose advertised size
   * exceeds this — or whose download exceeds it — are skipped. Default 10 MiB.
   */
  maxBytes?: number;
  /**
   * Allowed file mimetypes. A file whose mimetype is not listed is skipped.
   * Defaults to a conservative allowlist of common image and document types.
   */
  allowedMimeTypes?: readonly string[];
}

export interface SlackRequestMetadata {
  teamId?: string;
  apiAppId?: string;
  eventId: string;
  eventTime?: number;
  channel: {
    id: SlackChannelId;
    type?: string;
  };
  message: {
    ts: SlackMessageTs;
    threadTs?: SlackMessageTs;
    eventTs?: SlackMessageTs;
  };
  user?: {
    id: SlackUserId;
  };
  trigger: SlackTriggerKind;
}

export type { AgentResponse };
export type AgentResponder = SharedAgentResponder<AgentRequest, AgentMessageStream, AgentResponse>;

/**
 * Outcome of a proactive {@link SlackAdapter.notify} delivery. `delivered` is
 * true only when the answer reached the channel; otherwise `reason` carries a
 * short, human-readable cause for the silent drop (e.g. concurrency cap, the
 * agent produced no answer, a cancelled or failed run).
 */
export interface SlackNotifyResult {
  readonly delivered: boolean;
  readonly reason?: string;
}

export interface SlackAdapterMessages {
  welcomeText?: string;
  helpText?: string;
  busyText?: string;
  unauthorizedText?: string;
  cancelledText?: string;
  errorText?: string;
  unsupportedText?: string;
}

export interface SlackAdapterStreamOptions {
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
  maxSendRetries?: number;
  retryCapMs?: number;
  retryBaseDelayMs?: number;
  showHints?: boolean;
  /**
   * Deliver only the final answer with a 👀 "seen" reaction while working,
   * instead of streaming interim edits. Defaults to true for the Slack adapter.
   */
  finalOnly?: boolean;
}

export interface SlackAdapterLogger extends SlackMessageStreamLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
}

export interface SlackAdapterOptions {
  api: SlackWebApi;
  responder: AgentResponder;
  allowedChannelIds?: SlackChannelId[];
  allowAllChannels?: boolean;
  botUserIds?: SlackUserId[];
  mentionTextAliases?: string[];
  stripMentionText?: boolean;
  stream?: SlackAdapterStreamOptions;
  messages?: SlackAdapterMessages;
  attachments?: SlackAttachmentOptions;
  logger?: SlackAdapterLogger;
  /**
   * Resolve an in-thread reply back to the conversation that produced the message
   * it threads off. When set and an inbound threaded reply's `(channel, threadTs)`
   * matches a recorded post, the run continues that producing conversation instead
   * of a fresh `slack:<channel>:<threadTs>` (which would have no history). Injected
   * by the host so this package stays free of the artifact store.
   */
  resolvePostIndex?: (channelId: string, ts: string) => Promise<string | undefined>;
  /**
   * Record that this adapter posted a message at `(channel, ts)` for conversation
   * `conversationId`, so a later in-thread reply can be resolved back to it. Used
   * for top-level proactive posts (a fresh thread root with no prior history).
   * Fire-and-forget; best-effort.
   */
  recordPostedMessage?: (channelId: string, ts: string, conversationId: string) => void;
}

export type SlackEventIgnoredReason =
  | "unsupported_event"
  | "unsupported_message"
  | "empty_text"
  | "no_usable_attachments"
  | "from_bot"
  | "from_self";

export type SlackEventHandlingResult =
  | {
      kind: "handled";
      eventId: string;
      channelId: SlackChannelId;
      action: "command" | "responded";
      command?: "start" | "help";
      trigger: SlackTriggerKind;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "ignored";
      reason: SlackEventIgnoredReason;
      eventId?: string;
      channelId?: SlackChannelId;
    }
  | {
      kind: "unauthorized";
      eventId: string;
      channelId: SlackChannelId;
    }
  | {
      kind: "busy";
      eventId: string;
      channelId: SlackChannelId;
    }
  | {
      kind: "cancelled";
      eventId: string;
      channelId: SlackChannelId;
    }
  | {
      kind: "error";
      eventId: string;
      channelId?: SlackChannelId;
      error: unknown;
    };

interface NormalizedCommand {
  name: string;
}

interface SlackTextEvent {
  eventId: string;
  teamId?: string;
  apiAppId?: string;
  eventTime?: number;
  channelId: SlackChannelId;
  channelType?: string;
  userId?: SlackUserId;
  text: string;
  messageTs: SlackMessageTs;
  threadTs: SlackMessageTs;
  eventTs?: SlackMessageTs;
  trigger: SlackTriggerKind;
  files: readonly SlackFile[];
}

const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_ALLOWED_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];

const DEFAULT_MESSAGES: Required<SlackAdapterMessages> = {
  welcomeText:
    "Hello! Send me a Slack message and I will pass it to the configured agent.",
  helpText:
    "Send a Slack DM or mention the app in a channel. Use /cancel in a thread to stop the current response.",
  busyText: "I am still working on this Slack thread. Use /cancel to stop it.",
  unauthorizedText: "This Slack channel is not authorized to use this bot.",
  cancelledText: "Cancelled.",
  errorText: "The agent failed while processing your Slack message.",
  unsupportedText: "I can only handle Slack text messages in this adapter for now.",
};

// Slack delivers file uploads as subtyped messages (`file_share`), and a message
// posted to a thread "also sent to channel" arrives as `thread_broadcast`. Both
// carry real user content (text and/or a `files` array), so they must NOT be
// rejected alongside genuinely-unsupported subtypes (e.g. message_changed,
// channel_join). Without this, attachments are silently dropped.
const FILE_BEARING_MESSAGE_SUBTYPES: ReadonlySet<string> = new Set([
  "file_share",
  "thread_broadcast",
]);

// Mirrors the harness LiveSessionManager's DEFAULT_MAX_PENDING_PER_CONVERSATION:
// the per-conversation admission queue rejects past this depth so a flood of
// same-conversation messages cannot grow the queue unbounded.
const DEFAULT_ADMISSION_QUEUE_MAX_DEPTH = 100;

/**
 * Thrown synchronously by {@link SerialQueue.run} when the queue is already at
 * its depth cap. The adapter catches this sentinel to answer with the busy
 * terminal instead of admitting an unbounded backlog.
 */
export class SerialQueueFullError extends Error {
  readonly code = "serial_queue_full" as const;

  constructor(maxDepth: number) {
    super(`Per-conversation admission queue is full (max ${maxDepth} pending).`);
    this.name = "SerialQueueFullError";
  }
}

/**
 * Minimal per-conversation serial queue: each submitted task runs only after the
 * previous one settles, preserving arrival order. A task's failure does not
 * poison the queue (the chain swallows it; the caller still sees the rejection).
 *
 * The queue is bounded by {@link maxDepth}: once `depth` reaches the cap, `run`
 * rejects synchronously with a {@link SerialQueueFullError} BEFORE incrementing
 * or chaining, so an over-cap task never enters the chain (mirroring the harness
 * LiveSessionManager's maxPendingPerConversation rejection).
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;
  private readonly maxDepth: number;

  constructor(maxDepth: number = DEFAULT_ADMISSION_QUEUE_MAX_DEPTH) {
    this.maxDepth = maxDepth;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.depth >= this.maxDepth) {
      return Promise.reject(new SerialQueueFullError(this.maxDepth));
    }
    this.depth += 1;
    const result = this.tail.then(() => task());
    this.tail = result.then(() => undefined, () => undefined);
    void result.then(
      () => { this.depth -= 1; },
      () => { this.depth -= 1; },
    );
    return result;
  }

  /** True when no task is queued or running. */
  get idle(): boolean {
    return this.depth === 0;
  }
}

function isSerialQueueFullError(error: unknown): error is SerialQueueFullError {
  return error instanceof SerialQueueFullError;
}

export class SlackAdapter {
  private readonly api: SlackWebApi;
  private readonly responder: AgentResponder;
  private readonly allowAllChannels: boolean;
  private readonly allowedChannelIds: Set<string>;
  private readonly botUserIds: Set<string>;
  private readonly rawBotUserIds: readonly string[];
  private readonly mentionTextAliases: readonly string[];
  private readonly stripMentionText: boolean;
  private readonly streamOptions: SlackAdapterStreamOptions;
  private readonly messages: Required<SlackAdapterMessages>;
  private readonly attachmentMaxBytes: number;
  private readonly allowedMimeTypes: ReadonlySet<string>;
  private readonly logger: SlackAdapterLogger | undefined;
  private readonly resolvePostIndex:
    | ((channelId: string, ts: string) => Promise<string | undefined>)
    | undefined;
  private readonly recordPostedMessage:
    | ((channelId: string, ts: string, conversationId: string) => void)
    | undefined;
  /**
   * In-flight abort controllers per thread. The harness serializes runs for a
   * conversation, so several may be queued/active concurrently; /cancel aborts
   * every controller for the thread (and clears the harness queue via
   * responder.cancel).
   */
  private readonly activeControllers = new Map<string, Set<AbortController>>();
  /**
   * Per-conversation admission queue. Socket Mode dispatches envelopes
   * concurrently, and pre-submit work (status + file download) is variable
   * latency, so without this a later same-thread message could reach
   * responder.respond() (and the harness FIFO) before an earlier one. We
   * serialize respondToEvent per conversation to preserve message order.
   * /cancel stays out-of-band (handled before this queue).
   */
  private readonly admissionQueues = new Map<string, SerialQueue>();

  constructor(options: SlackAdapterOptions) {
    this.api = options.api;
    this.responder = options.responder;
    this.allowAllChannels = options.allowAllChannels === true;
    this.allowedChannelIds = new Set(
      options.allowedChannelIds?.map((channelId) => normalizeIdForMatch(channelId)) ?? [],
    );
    this.botUserIds = new Set(
      options.botUserIds?.map((userId) => normalizeIdForMatch(userId)) ?? [],
    );
    this.rawBotUserIds = options.botUserIds ?? [];
    this.mentionTextAliases = options.mentionTextAliases ?? [];
    this.stripMentionText =
      options.stripMentionText ?? (this.botUserIds.size > 0 || this.mentionTextAliases.length > 0);
    this.streamOptions = options.stream ?? {};
    this.messages = { ...DEFAULT_MESSAGES, ...options.messages };
    this.attachmentMaxBytes = options.attachments?.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
    this.allowedMimeTypes = new Set(
      (options.attachments?.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES).map((mime) =>
        mime.trim().toLowerCase(),
      ),
    );
    this.logger = options.logger;
    this.resolvePostIndex = options.resolvePostIndex;
    this.recordPostedMessage = options.recordPostedMessage;

    if (!this.allowAllChannels && this.allowedChannelIds.size === 0) {
      throw new TypeError(
        "SlackAdapter requires allowedChannelIds or allowAllChannels: true.",
      );
    }
  }

  async handleEventCallback(
    callback: SlackEventCallback,
  ): Promise<SlackEventHandlingResult> {
    const normalized = this.normalizeEventCallback(callback);
    if (normalized.kind === "ignored") {
      return normalized;
    }

    const event = normalized.event;
    if (!this.isAuthorized(event.channelId)) {
      await this.api.chatPostMessage({
        channel: event.channelId,
        text: this.messages.unauthorizedText,
        thread_ts: event.threadTs,
      });
      return {
        kind: "unauthorized",
        eventId: event.eventId,
        channelId: event.channelId,
      };
    }

    const text = event.text.trim();
    if (text.length === 0 && event.files.length === 0) {
      await this.api.chatPostMessage({
        channel: event.channelId,
        text: this.messages.unsupportedText,
        thread_ts: event.threadTs,
      });
      return {
        kind: "ignored",
        reason: "empty_text",
        eventId: event.eventId,
        channelId: event.channelId,
      };
    }

    const command = parseCommand(text);
    if (command?.name === "start") {
      await this.api.chatPostMessage({
        channel: event.channelId,
        text: this.messages.welcomeText,
        thread_ts: event.threadTs,
      });
      return {
        kind: "handled",
        eventId: event.eventId,
        channelId: event.channelId,
        action: "command",
        command: "start",
        trigger: event.trigger,
      };
    }

    if (command?.name === "help") {
      await this.api.chatPostMessage({
        channel: event.channelId,
        text: this.messages.helpText,
        thread_ts: event.threadTs,
      });
      return {
        kind: "handled",
        eventId: event.eventId,
        channelId: event.channelId,
        action: "command",
        command: "help",
        trigger: event.trigger,
      };
    }

    const runKey = runKeyFor(event);
    // Resolve once, up front, so /cancel, the admission queue, and the run all use
    // the SAME conversationId — an in-thread reply to a message we posted resolves
    // to the producing conversation (so it loads that history), else the default
    // slack: thread id.
    const conversationId = await this.resolveConversationId(event);
    if (command?.name === "cancel") {
      // Clear any queued follow-ups for the conversation (the harness owns the
      // queue) and abort every in-flight controller for this thread.
      this.responder.cancel?.(conversationId, new Error("Cancelled by Slack user."));
      const controllers = this.activeControllers.get(runKey);
      if (controllers !== undefined) {
        for (const controller of controllers) {
          controller.abort(new Error("Cancelled by Slack user."));
        }
      }
      await this.api.chatPostMessage({
        channel: event.channelId,
        text: this.messages.cancelledText,
        thread_ts: event.threadTs,
      });
      return {
        kind: "cancelled",
        eventId: event.eventId,
        channelId: event.channelId,
      };
    }

    // No per-thread "busy" rejection: the harness serializes runs for the
    // conversation, queuing a concurrent message and answering it on the warm
    // session after the current turn. We admit messages through a per-conversation
    // serial queue first so they reach the harness in arrival order even when an
    // earlier message stalls on file download.
    //
    // Create and register the controller BEFORE entering the admission queue so a
    // /cancel can abort a message still parked behind an earlier same-thread run.
    // respondToEvent's first abort check then makes the queued-then-cancelled run
    // bail before responder.respond and post only the cancelled terminal.
    const controller = new AbortController();
    this.registerController(runKey, controller);
    let queue = this.admissionQueues.get(conversationId);
    if (queue === undefined) {
      queue = new SerialQueue();
      this.admissionQueues.set(conversationId, queue);
    }
    try {
      return await queue.run(() => this.respondToEvent(event, text, runKey, controller, conversationId));
    } catch (error) {
      if (isSerialQueueFullError(error)) {
        // Over-cap: the task was rejected BEFORE entering the queue, so
        // respondToEvent (and its finally) never ran. Unregister the eagerly
        // created controller here so it does not leak in activeControllers, then
        // answer with the busy terminal instead of admitting an unbounded backlog.
        this.unregisterController(runKey, controller);
        await this.api.chatPostMessage({
          channel: event.channelId,
          text: this.messages.busyText,
          thread_ts: event.threadTs,
        });
        return { kind: "busy", eventId: event.eventId, channelId: event.channelId };
      }
      throw error;
    } finally {
      if (queue.idle && this.admissionQueues.get(conversationId) === queue) {
        this.admissionQueues.delete(conversationId);
      }
    }
  }

  /**
   * Deliver a proactive notification to a Slack destination by running it as a
   * turn on that destination's OWN harness (shared session/history + the same
   * per-conversation admission queue as inbound messages) and posting the answer
   * through the normal stream. `threadTs` targets an existing thread (clean
   * continuity — the user's in-thread replies share the session); omitting it
   * posts top-level (fire-and-forget: a fresh top-level post has no pre-existing
   * thread to share continuity with). Used by cron/webhook nudges. Best-effort:
   * a failed or empty turn posts nothing.
   */
  async notify(
    channelId: SlackChannelId,
    threadTs: SlackMessageTs | undefined,
    text: string,
  ): Promise<SlackNotifyResult> {
    const conversationId = threadTs === undefined ? `slack:${channelId}` : `slack:${channelId}:${threadTs}`;
    // A threaded proactive run shares the inbound /cancel key so a user's
    // /cancel in that thread can abort it; a top-level post (no thread) has no
    // inbound /cancel target, so it keeps its own proactive key.
    const runKey = threadTs === undefined ? `proactive:${conversationId}` : `${channelId}:${threadTs}`;
    const controller = new AbortController();
    this.registerController(runKey, controller);
    let queue = this.admissionQueues.get(conversationId);
    if (queue === undefined) {
      queue = new SerialQueue();
      this.admissionQueues.set(conversationId, queue);
    }
    try {
      return await queue.run(() => this.runProactiveTurn(conversationId, channelId, threadTs, text, runKey, controller));
    } catch (error) {
      if (isSerialQueueFullError(error)) {
        this.unregisterController(runKey, controller);
        this.logger?.warn?.("Slack proactive notify dropped: conversation is at its concurrency cap.", {
          conversationId,
        });
        return { delivered: false, reason: "conversation at concurrency cap" };
      }
      throw error;
    } finally {
      if (queue.idle && this.admissionQueues.get(conversationId) === queue) {
        this.admissionQueues.delete(conversationId);
      }
    }
  }

  private async runProactiveTurn(
    conversationId: string,
    channelId: SlackChannelId,
    threadTs: SlackMessageTs | undefined,
    text: string,
    runKey: string,
    controller: AbortController,
  ): Promise<SlackNotifyResult> {
    const streamOptions: SlackMessageStreamOptions = {
      api: this.api,
      channelId,
      // No reactToTs: a proactive turn has no inbound message to react to.
      finalOnly: this.streamOptions.finalOnly ?? true,
      abortSignal: controller.signal,
    };
    if (threadTs !== undefined) {
      streamOptions.threadTs = threadTs;
    } else if (this.recordPostedMessage !== undefined) {
      // A top-level proactive post is a fresh thread root with no prior history.
      // Record its ts → this conversation so a user's in-thread reply resolves
      // back here (the threaded case already shares the thread's conversationId).
      const record = this.recordPostedMessage;
      let recorded = false;
      streamOptions.onPosted = ({ ts, channel }) => {
        if (recorded || ts.length === 0) {
          return;
        }
        recorded = true;
        record(channel, ts, conversationId);
      };
    }
    if (this.streamOptions.maxMessageChars !== undefined) {
      streamOptions.maxMessageChars = this.streamOptions.maxMessageChars;
    }
    if (this.streamOptions.maxSendRetries !== undefined) {
      streamOptions.maxSendRetries = this.streamOptions.maxSendRetries;
    }
    if (this.streamOptions.retryCapMs !== undefined) {
      streamOptions.retryCapMs = this.streamOptions.retryCapMs;
    }
    if (this.streamOptions.retryBaseDelayMs !== undefined) {
      streamOptions.retryBaseDelayMs = this.streamOptions.retryBaseDelayMs;
    }
    if (this.logger !== undefined) {
      streamOptions.logger = this.logger;
    }
    const stream = new SlackMessageStream(streamOptions);
    try {
      if (controller.signal.aborted) {
        return { delivered: false, reason: "cancelled" };
      }
      const request: AgentRequest = {
        conversationId,
        channelId,
        messageTs: threadTs ?? "",
        threadTs: threadTs ?? "",
        eventId: "proactive",
        text,
        trigger: "direct",
        abortSignal: controller.signal,
        metadata: {
          slack: {
            eventId: "proactive",
            channel: { id: channelId },
            message: { ts: threadTs ?? "" },
            trigger: "direct",
          },
        },
      };
      let response: AgentResponse;
      try {
        response = await this.responder.respond(request, stream);
      } catch (error) {
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          return { delivered: false, reason: "cancelled" };
        }
        this.logger?.error?.("Slack proactive notify failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { delivered: false, reason: "responder failed" };
      }
      const answer = response.text;
      if (controller.signal.aborted) {
        return { delivered: false, reason: "cancelled" };
      }
      if (answer === undefined || answer.trim().length === 0) {
        return { delivered: false, reason: "agent produced no answer" };
      }
      try {
        await stream.finish(answer);
      } catch (error) {
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          return { delivered: false, reason: "cancelled" };
        }
        this.logger?.error?.("Slack proactive delivery failed after a successful AI run.", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { delivered: false, reason: "delivery failed" };
      }
      return { delivered: true };
    } finally {
      this.unregisterController(runKey, controller);
    }
  }

  /**
   * The conversation the run should continue. A genuine in-thread reply
   * (`threadTs !== messageTs`) whose `(channel, threadTs)` matches a message we
   * posted resolves to that producing conversation; everything else uses the
   * default `slack:<channel>:<threadTs>`. Best-effort: a lookup error falls back.
   */
  private async resolveConversationId(event: SlackTextEvent): Promise<string> {
    const fallback = conversationIdFor(event);
    if (this.resolvePostIndex === undefined || event.threadTs === event.messageTs) {
      return fallback;
    }
    try {
      const producing = await this.resolvePostIndex(event.channelId, event.threadTs);
      return producing !== undefined && producing.length > 0 ? producing : fallback;
    } catch {
      return fallback;
    }
  }

  private async respondToEvent(
    event: SlackTextEvent,
    text: string,
    runKey: string,
    controller: AbortController,
    conversationId: string,
  ): Promise<SlackEventHandlingResult> {
    const streamOptions: SlackMessageStreamOptions = {
      api: this.api,
      channelId: event.channelId,
      threadTs: event.threadTs,
      reactToTs: event.messageTs,
      // Default to a 👀 "seen" reaction + final-answer-only delivery (no streamed
      // interim edits); a tuning override can restore interim streaming.
      finalOnly: this.streamOptions.finalOnly ?? true,
      abortSignal: controller.signal,
    };
    if (this.streamOptions.initialStatusText !== undefined) {
      streamOptions.initialStatusText = this.streamOptions.initialStatusText;
    }
    if (this.streamOptions.editDebounceMs !== undefined) {
      streamOptions.editDebounceMs = this.streamOptions.editDebounceMs;
    }
    if (this.streamOptions.maxMessageChars !== undefined) {
      streamOptions.maxMessageChars = this.streamOptions.maxMessageChars;
    }
    if (this.streamOptions.maxSendRetries !== undefined) {
      streamOptions.maxSendRetries = this.streamOptions.maxSendRetries;
    }
    if (this.streamOptions.retryCapMs !== undefined) {
      streamOptions.retryCapMs = this.streamOptions.retryCapMs;
    }
    if (this.streamOptions.retryBaseDelayMs !== undefined) {
      streamOptions.retryBaseDelayMs = this.streamOptions.retryBaseDelayMs;
    }
    if (this.streamOptions.showHints !== undefined) {
      streamOptions.showHints = this.streamOptions.showHints;
    }
    if (this.logger !== undefined) {
      streamOptions.logger = this.logger;
    }
    const stream = new SlackMessageStream(streamOptions);

    try {
      await stream.status(this.streamOptions.initialStatusText ?? "Thinking...");
      if (controller.signal.aborted) {
        await stream.finish(this.messages.cancelledText);
        return { kind: "cancelled", eventId: event.eventId, channelId: event.channelId };
      }

      const attachments = await this.downloadAttachments(event.files, controller.signal);
      if (controller.signal.aborted) {
        await stream.finish(this.messages.cancelledText);
        return { kind: "cancelled", eventId: event.eventId, channelId: event.channelId };
      }

      // A file-only message whose files were all skipped (MIME/size/missing
      // URL/download failure) leaves no text and no attachments. Deliver a
      // deterministic message instead of submitting an empty request the harness
      // would reject.
      if (text.length === 0 && attachments.length === 0) {
        await stream.finish(this.messages.unsupportedText);
        return { kind: "ignored", reason: "no_usable_attachments", eventId: event.eventId, channelId: event.channelId };
      }

      const request = buildAgentRequest(event, text, controller.signal, attachments, conversationId);
      const response = await this.responder.respond(request, stream);

      if (controller.signal.aborted) {
        await stream.finish(this.messages.cancelledText);
        return { kind: "cancelled", eventId: event.eventId, channelId: event.channelId };
      }

      await stream.finish(response.text);
      const result: SlackEventHandlingResult = {
        kind: "handled",
        eventId: event.eventId,
        channelId: event.channelId,
        action: "responded",
        trigger: event.trigger,
      };
      if (response.metadata !== undefined) {
        result.metadata = response.metadata;
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
        await finishSafely(stream, this.messages.cancelledText, this.logger);
        return { kind: "cancelled", eventId: event.eventId, channelId: event.channelId };
      }

      this.logger?.error?.("Slack adapter responder failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      await finishSafely(stream, this.messages.errorText, this.logger);
      return { kind: "error", eventId: event.eventId, channelId: event.channelId, error };
    } finally {
      this.unregisterController(runKey, controller);
    }
  }

  /**
   * Download each inbound Slack file's bytes into an {@link AgentAttachment}.
   * Files with a missing/disallowed mimetype, no private URL, or an advertised
   * size over the cap are skipped before any network call. The byte cap is also
   * enforced during the download. A failed download skips that file and
   * continues; downloads are tied to the request abort signal.
   */
  private async downloadAttachments(
    files: readonly SlackFile[],
    signal: AbortSignal,
  ): Promise<AgentAttachment[]> {
    const attachments: AgentAttachment[] = [];
    // downloadFile is optional on SlackWebApi: a text-only custom client may omit
    // it. Without it we cannot fetch bytes, so skip attachment download entirely.
    if (typeof this.api.downloadFile !== "function") {
      if (files.length > 0) {
        this.logger?.debug?.("Slack client has no downloadFile; skipping attachments.", { count: files.length });
      }
      return attachments;
    }
    const downloadFile = this.api.downloadFile.bind(this.api);
    for (const file of files) {
      if (signal.aborted) {
        break;
      }

      const mimeType = typeof file.mimetype === "string" ? file.mimetype : "";
      if (mimeType.length === 0 || !this.allowedMimeTypes.has(mimeType.toLowerCase())) {
        this.logger?.debug?.("Skipped Slack file with disallowed mimetype.", {
          id: file.id,
          mimeType,
        });
        continue;
      }

      if (typeof file.size === "number" && file.size > this.attachmentMaxBytes) {
        this.logger?.debug?.("Skipped Slack file exceeding the byte cap.", {
          id: file.id,
          size: file.size,
        });
        continue;
      }

      const url = file.url_private ?? file.url_private_download;
      if (typeof url !== "string" || url.length === 0) {
        this.logger?.debug?.("Skipped Slack file without a private URL.", { id: file.id });
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await downloadFile({ url, maxBytes: this.attachmentMaxBytes }, { signal });
      } catch (error) {
        this.logger?.warn?.("Failed to download a Slack file (skipped).", {
          id: file.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (bytes.byteLength > this.attachmentMaxBytes) {
        this.logger?.debug?.("Skipped Slack file exceeding the byte cap.", {
          id: file.id,
          size: bytes.byteLength,
        });
        continue;
      }

      attachments.push(buildAttachment(file, mimeType, bytes));
    }
    return attachments;
  }

  private registerController(runKey: string, controller: AbortController): void {
    let controllers = this.activeControllers.get(runKey);
    if (controllers === undefined) {
      controllers = new Set<AbortController>();
      this.activeControllers.set(runKey, controllers);
    }
    controllers.add(controller);
  }

  private unregisterController(runKey: string, controller: AbortController): void {
    const controllers = this.activeControllers.get(runKey);
    if (controllers === undefined) {
      return;
    }
    controllers.delete(controller);
    if (controllers.size === 0) {
      this.activeControllers.delete(runKey);
    }
  }

  private normalizeEventCallback(
    callback: SlackEventCallback,
  ): { kind: "event"; event: SlackTextEvent } | Extract<SlackEventHandlingResult, { kind: "ignored" }> {
    const rawEvent = callback.event;
    const eventType = rawEvent.type;
    const trigger = triggerFromEvent(rawEvent);
    if (trigger === undefined) {
      return ignored("unsupported_event", callback, rawEvent);
    }

    if (rawEvent.bot_id !== undefined) {
      return ignored("from_bot", callback, rawEvent);
    }
    if (rawEvent.user !== undefined && this.botUserIds.has(normalizeIdForMatch(rawEvent.user))) {
      return ignored("from_self", callback, rawEvent);
    }
    if (rawEvent.subtype !== undefined && !FILE_BEARING_MESSAGE_SUBTYPES.has(rawEvent.subtype)) {
      return ignored("unsupported_message", callback, rawEvent);
    }
    if (
      eventType === "message" &&
      rawEvent.channel_type !== "im"
    ) {
      return ignored("unsupported_event", callback, rawEvent);
    }
    // A file upload may arrive with no caption (text absent/empty); accept it as
    // long as it carries files so the attachment is not dropped.
    const hasFiles = Array.isArray(rawEvent.files) && rawEvent.files.length > 0;
    if (
      typeof rawEvent.channel !== "string" ||
      typeof rawEvent.ts !== "string" ||
      (typeof rawEvent.text !== "string" && !hasFiles)
    ) {
      return ignored("unsupported_message", callback, rawEvent);
    }

    const threadTs = typeof rawEvent.thread_ts === "string" && rawEvent.thread_ts.trim().length > 0
      ? rawEvent.thread_ts
      : rawEvent.ts;
    const event: SlackTextEvent = {
      eventId: callback.event_id,
      channelId: rawEvent.channel,
      text: this.prepareText(typeof rawEvent.text === "string" ? rawEvent.text : ""),
      messageTs: rawEvent.ts,
      threadTs,
      trigger,
      files: Array.isArray(rawEvent.files) ? rawEvent.files : [],
    };
    if (callback.team_id !== undefined) {
      event.teamId = callback.team_id;
    }
    if (callback.api_app_id !== undefined) {
      event.apiAppId = callback.api_app_id;
    }
    if (callback.event_time !== undefined) {
      event.eventTime = callback.event_time;
    }
    if (rawEvent.channel_type !== undefined) {
      event.channelType = rawEvent.channel_type;
    }
    if (rawEvent.user !== undefined) {
      event.userId = rawEvent.user;
    }
    if (rawEvent.event_ts !== undefined) {
      event.eventTs = rawEvent.event_ts;
    }
    return { kind: "event", event };
  }

  private prepareText(text: string): string {
    if (!this.stripMentionText) {
      return text.trim();
    }

    let stripped = text;
    for (const botUserId of this.rawBotUserIds) {
      stripped = stripped.replaceAll(`<@${botUserId}>`, " ");
    }
    for (const alias of this.mentionTextAliases) {
      const normalizedAlias = alias.trim();
      if (normalizedAlias.length > 0) {
        stripped = stripped.replaceAll(normalizedAlias, " ");
      }
    }
    return stripped.replace(/\s+/gu, " ").trim();
  }

  private isAuthorized(channelId: SlackChannelId): boolean {
    return this.allowAllChannels || this.allowedChannelIds.has(normalizeIdForMatch(channelId));
  }
}

function triggerFromEvent(event: SlackEventBase): SlackTriggerKind | undefined {
  if (event.type === "app_mention") {
    return "app_mention";
  }
  if (event.type === "message" && event.channel_type === "im") {
    return "direct";
  }
  return undefined;
}

function ignored(
  reason: SlackEventIgnoredReason,
  callback: SlackEventCallback,
  event: SlackEventBase,
): Extract<SlackEventHandlingResult, { kind: "ignored" }> {
  const result: Extract<SlackEventHandlingResult, { kind: "ignored" }> = {
    kind: "ignored",
    reason,
    eventId: callback.event_id,
  };
  if (event.channel !== undefined) {
    result.channelId = event.channel;
  }
  return result;
}

function buildAgentRequest(
  event: SlackTextEvent,
  text: string,
  abortSignal: AbortSignal,
  attachments: readonly AgentAttachment[],
  conversationId: string,
): AgentRequest {
  const metadata: SlackRequestMetadata = {
    eventId: event.eventId,
    channel: {
      id: event.channelId,
    },
    message: {
      ts: event.messageTs,
    },
    trigger: event.trigger,
  };
  if (event.teamId !== undefined) {
    metadata.teamId = event.teamId;
  }
  if (event.apiAppId !== undefined) {
    metadata.apiAppId = event.apiAppId;
  }
  if (event.eventTime !== undefined) {
    metadata.eventTime = event.eventTime;
  }
  if (event.channelType !== undefined) {
    metadata.channel.type = event.channelType;
  }
  if (event.threadTs !== event.messageTs) {
    metadata.message.threadTs = event.threadTs;
  }
  if (event.eventTs !== undefined) {
    metadata.message.eventTs = event.eventTs;
  }
  if (event.userId !== undefined) {
    metadata.user = { id: event.userId };
  }

  const request: AgentRequest = {
    conversationId,
    channelId: event.channelId,
    messageTs: event.messageTs,
    threadTs: event.threadTs,
    eventId: event.eventId,
    text,
    trigger: event.trigger,
    abortSignal,
    metadata: { slack: metadata },
  };
  if (event.teamId !== undefined) {
    request.teamId = event.teamId;
  }
  if (event.userId !== undefined) {
    request.userId = event.userId;
  }
  if (attachments.length > 0) {
    request.attachments = attachments;
  }
  return request;
}

const TEXT_MIME_PATTERN = /^text\/|[/+](?:json|xml|csv)$/iu;

/** Build an {@link AgentAttachment} from downloaded Slack file bytes. */
function buildAttachment(
  file: SlackFile,
  mimeType: string,
  bytes: Uint8Array,
): AgentAttachment {
  const attachment: {
    kind: "image" | "document";
    mimeType: string;
    data: string;
    name?: string;
    sizeBytes?: number;
    text?: string;
  } = {
    kind: mimeType.toLowerCase().startsWith("image/") ? "image" : "document",
    mimeType,
    data: toBase64(bytes),
    sizeBytes: bytes.byteLength,
  };

  const name = typeof file.name === "string" && file.name.length > 0
    ? file.name
    : typeof file.title === "string" && file.title.length > 0
      ? file.title
      : undefined;
  if (name !== undefined) {
    attachment.name = name;
  }

  if (TEXT_MIME_PATTERN.test(mimeType)) {
    attachment.text = new TextDecoder("utf-8").decode(bytes);
  }

  return attachment;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function parseCommand(text: string): NormalizedCommand | undefined {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:\s|$)/u);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return { name: match[1].toLowerCase() };
}

async function finishSafely(
  stream: AgentMessageStream,
  text: string,
  logger: SlackAdapterLogger | undefined,
): Promise<void> {
  try {
    await stream.finish(text);
  } catch (error) {
    logger?.error?.("Failed to send Slack terminal stream message.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function runKeyFor(event: SlackTextEvent): string {
  return `${event.channelId}:${event.threadTs}`;
}

/**
 * The conversation key the harness serializes runs on. /cancel uses the same id
 * so the responder clears the right conversation's queued follow-ups.
 */
function conversationIdFor(event: SlackTextEvent): string {
  return `slack:${event.channelId}:${event.threadTs}`;
}

function normalizeIdForMatch(value: string): string {
  return value.trim().toLowerCase();
}
