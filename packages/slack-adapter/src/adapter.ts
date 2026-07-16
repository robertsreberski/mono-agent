import {
  createChannelUserCancelReason,
  type AgentAttachment,
  type AgentContinuationTurn,
  type AgentRequestBase,
  type AgentResponder as SharedAgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";
import { createHash } from "node:crypto";

import {
  isSafeSlackPrototypeInstance,
  readSafeSlackDataProperty,
  redactSlackErrorMessage,
} from "./log-redaction.js";
import {
  SlackDeliveryError,
  SlackMessageStream,
  type AgentMessageStream,
  type SlackDeliveryReceipt,
  type SlackMessageStreamLogger,
  type SlackMessageStreamOptions,
} from "./message-stream.js";
import { SlackApiError } from "./slack-client.js";
import { normalizeSlackMarkdownToMarkdown } from "./slack-markdown.js";
import type {
  SlackBlockActionsPayload,
  SlackChannelId,
  SlackEventBase,
  SlackEventCallback,
  SlackFile,
  SlackInteractivityPayload,
  SlackMessageTs,
  SlackShortcutPayload,
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
  /** Stable machine-readable outcome for durable continuation routing. */
  readonly code?: string;
  readonly retryable?: boolean;
  /** True when Slack may have accepted the post but no receipt was observed. */
  readonly ambiguous?: boolean;
  readonly deliveryId?: string;
  readonly channelId?: "slack";
  /** Whether the confirmed Slack post was also appended to durable conversation history. */
  readonly historyRecorded?: boolean;
  /** Bounded machine code when a confirmed post could not be recorded to history. */
  readonly historyErrorCode?: string;
}

/**
 * Options for {@link SlackAdapter.notify}. With `verbatim`, `text` is posted to
 * the destination UNCHANGED with no model call (native cron/webhook notification
 * — the producing run already wrote the message) and recorded to history so a
 * reply resumes with it in context. Without it, `text` is run as a turn.
 */
export interface SlackNotifyOptions {
  readonly verbatim?: boolean;
  /** Stable host delivery identity. Converted to Slack's UUID client_msg_id. */
  readonly deliveryKey?: string;
  /**
   * Request notification-suppressed delivery for cross-channel parity.
   *
   * Slack's `chat.postMessage` contract has no bot-controlled equivalent to
   * Telegram's `disable_notification`. The adapter therefore posts normally
   * and, when a logger is configured, emits an explicit warning instead of
   * forwarding an invented field or claiming that Slack client/workspace
   * notifications were suppressed.
   */
  readonly silent?: boolean;
}

export interface SlackContinuationSynthesisInput {
  /** Exact history identity, including a rollover bucket when present. */
  readonly conversationId: string;
  readonly replyToConversationId: string;
  readonly channelId: SlackChannelId;
  readonly threadTs?: SlackMessageTs;
  readonly prompt: string;
  readonly continuation: AgentContinuationTurn;
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

/**
 * Binds a Slack shortcut `callback_id` to a prompt. When a user invokes that
 * shortcut, the adapter runs the prompt as a proactive turn — the same machinery
 * as a cron/webhook nudge — making the shortcut a persistent one-click trigger
 * for an agent routine. When `channelId` is omitted, a MESSAGE shortcut uses its
 * source channel and a GLOBAL shortcut uses the first allowlisted channel; a
 * global shortcut needs `channelId` only when no allowlist default exists.
 */
export interface SlackShortcutBinding {
  readonly callbackId: string;
  readonly prompt: string;
  /**
   * Destination channel for the run's reply. When omitted, a MESSAGE shortcut
   * uses its source channel and is refused if that source is unauthorized; it
   * does not retry an allowlist default. A source-less GLOBAL shortcut uses the
   * first explicit `allowedChannelIds` entry. With `allowAllChannels` and no
   * explicit allowlist, a global shortcut needs a `channelId`. Pin it to bound
   * the destination.
   */
  readonly channelId?: SlackChannelId;
  /**
   * Optional message posted immediately when the shortcut is invoked, before the
   * run starts — instant feedback for an action whose result lands seconds later
   * (e.g. "🔄 Syncing…"). Best-effort: a failed ack post does not block the run.
   */
  readonly ackText?: string;
  /**
   * When true (and `ackText` is set), the run's result posts as a threaded reply
   * under the instant ack instead of as a separate top-level message. Default off.
   */
  readonly threadReply?: boolean;
}

/**
 * Outcome of routing an interaction (a shortcut or a Home-tab button). `id` is
 * the shortcut's `callback_id` or the button's `action_id`. `triggered` means a
 * bound interaction ran (`delivered` mirrors the proactive turn's outcome); the
 * other kinds explain why nothing ran, for logging.
 */
export type SlackInteractionHandlingResult =
  | {
      kind: "triggered";
      id: string;
      channelId: SlackChannelId;
      delivered: boolean;
      reason?: string;
    }
  | {
      kind: "ignored";
      reason: "no_action" | "unbound" | "missing_channel";
      id?: string;
    }
  | {
      kind: "unauthorized";
      id: string;
      channelId: SlackChannelId;
    };

/**
 * A button rendered on the App Home tab. Clicking it runs `prompt` as a proactive
 * turn (same machinery as a shortcut), replying in `channelId` (the Home tab
 * carries no channel of its own, so this — or the first allowlisted channel — is
 * where the result lands). `label` is the button text; `ackText` posts instantly.
 */
export interface SlackHomeButton {
  readonly actionId: string;
  readonly label: string;
  readonly prompt: string;
  readonly channelId?: SlackChannelId;
  readonly ackText?: string;
  /**
   * When true (and `ackText` is set), the run's result posts as a threaded reply
   * under the instant ack — one ack+result thread instead of two top-level
   * messages. Default: top-level. See {@link SlackHomeButton.ackText}.
   */
  readonly threadReply?: boolean;
}

/** App Home tab options: whether to publish it, an optional header, and its buttons. */
export interface SlackHomeTabOptions {
  readonly enabled: boolean;
  readonly headerText?: string;
  readonly buttons: readonly SlackHomeButton[];
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
  /**
   * Shortcut bindings (callback_id → prompt). Invoking a bound shortcut in/for an
   * authorized channel runs its prompt as a proactive turn. Omitted/empty means
   * no shortcuts are wired (interactions are ignored).
   */
  shortcuts?: readonly SlackShortcutBinding[];
  /**
   * App Home tab configuration. When `enabled`, the adapter publishes a persistent
   * panel of action buttons whenever a user opens the Home tab, and a button click
   * runs its bound prompt as a proactive turn. Omitted/disabled means no Home tab.
   */
  homeTab?: SlackHomeTabOptions;
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
    }
  | {
      kind: "home_published";
      eventId: string;
      userId: SlackUserId;
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
  return isSafeSlackPrototypeInstance(error, SerialQueueFullError.prototype);
}

function isSlackDeliveryError(error: unknown): error is SlackDeliveryError {
  return isSafeSlackPrototypeInstance(error, SlackDeliveryError.prototype);
}

function isAgentResponseCancelledError(error: unknown): boolean {
  return readSafeSlackDataProperty(error, "agentResponseCancelled") === true;
}

function isChannelUserCancelReason(reason: unknown): boolean {
  return readSafeSlackDataProperty(reason, "channelUserCancel") === true;
}

function slackNotifyFailure(error: SlackDeliveryError, confirmedAnswer: boolean): SlackNotifyResult {
  const disposition = readSafeSlackDataProperty(error, "disposition");
  if (
    confirmedAnswer
    || (disposition !== "retryable" && disposition !== "permanent")
  ) {
    return {
      delivered: false,
      reason: "delivery outcome is unknown",
      code: "delivery_unknown",
      retryable: false,
      ambiguous: true,
    };
  }
  if (disposition === "retryable") {
    return {
      delivered: false,
      reason: "Slack temporarily refused delivery",
      code: slackDeliveryErrorCode(error, "delivery_retry_exhausted"),
      retryable: true,
    };
  }
  return {
    delivered: false,
    reason: "Slack refused delivery",
    code: slackDeliveryErrorCode(error, "delivery_refused"),
    retryable: false,
  };
}

function slackDeliveryErrorCode(error: SlackDeliveryError, fallback: string): string {
  const cause = readSafeSlackDataProperty(error, "cause");
  if (isSafeSlackPrototypeInstance(cause, SlackApiError.prototype)) {
    const rawCode = readSafeSlackDataProperty(cause, "slackError");
    const code = typeof rawCode === "string" ? rawCode.trim() : undefined;
    if (code !== undefined && code.length > 0 && code.length <= 128) return code;
  }
  return fallback;
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
  /** callback_id → shortcut binding for registered Slack shortcuts. */
  private readonly shortcuts: ReadonlyMap<string, SlackShortcutBinding>;
  /** action_id → button binding for App Home tab buttons. */
  private readonly homeButtons: ReadonlyMap<string, SlackHomeButton>;
  /** Ordered Home tab buttons (for rendering the view in config order). */
  private readonly homeButtonOrder: readonly SlackHomeButton[];
  private readonly homeTabEnabled: boolean;
  private readonly homeTabHeaderText: string | undefined;
  /** First allowlisted channel (original case), used as a global interaction's default reply destination. */
  private readonly defaultShortcutChannelId: string | undefined;
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
  /** The same controllers indexed by resolved conversation for cross-thread aliases. */
  private readonly activeControllersByConversation = new Map<string, Set<AbortController>>();
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
    this.shortcuts = new Map(
      (options.shortcuts ?? [])
        .filter((binding) => binding.callbackId.trim().length > 0)
        .map((binding) => [binding.callbackId, binding]),
    );
    this.homeButtonOrder = (options.homeTab?.buttons ?? []).filter(
      (button) => button.actionId.trim().length > 0,
    );
    this.homeButtons = new Map(this.homeButtonOrder.map((button) => [button.actionId, button]));
    this.homeTabEnabled = options.homeTab?.enabled === true;
    this.homeTabHeaderText = options.homeTab?.headerText;
    this.defaultShortcutChannelId = options.allowedChannelIds?.[0];
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
    // App Home tab opened → (re)publish the button panel. This is an events_api
    // event with no channel/trigger, so it is handled before the message path.
    if (callback.event.type === "app_home_opened" && callback.event.tab === "home") {
      return this.handleAppHomeOpened(callback);
    }

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
      const reason = createChannelUserCancelReason("Slack");
      // Clear queued follow-ups and abort every controller for the resolved
      // conversation, including other physical Slack threads aliased to it.
      this.responder.cancel?.(conversationId, reason);
      const controllers = this.activeControllersByConversation.get(conversationId);
      if (controllers !== undefined) {
        for (const controller of controllers) {
          controller.abort(reason);
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
    this.registerController(runKey, conversationId, controller);
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
        this.unregisterController(runKey, conversationId, controller);
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
    options?: SlackNotifyOptions,
  ): Promise<SlackNotifyResult> {
    const conversationId = threadTs === undefined ? `slack:${channelId}` : `slack:${channelId}:${threadTs}`;
    // A threaded proactive run shares the inbound /cancel key so a user's
    // /cancel in that thread can abort it; a top-level post (no thread) has no
    // inbound /cancel target, so it keeps its own proactive key.
    const runKey = threadTs === undefined ? `proactive:${conversationId}` : `${channelId}:${threadTs}`;
    const controller = new AbortController();
    this.registerController(runKey, conversationId, controller);
    let queue = this.admissionQueues.get(conversationId);
    if (queue === undefined) {
      queue = new SerialQueue();
      this.admissionQueues.set(conversationId, queue);
    }
    try {
      return await queue.run(() =>
        options?.verbatim === true
          ? this.runVerbatimDelivery(
              conversationId,
              channelId,
              threadTs,
              text,
              runKey,
              controller,
              options.deliveryKey,
              options.silent,
            )
          : this.runProactiveTurn(
              conversationId,
              channelId,
              threadTs,
              text,
              runKey,
              controller,
              options?.deliveryKey,
              options?.silent,
            ),
      );
    } catch (error) {
      if (isSerialQueueFullError(error)) {
        this.unregisterController(runKey, conversationId, controller);
        this.logger?.warn?.("Slack proactive notify dropped: conversation is at its concurrency cap.", {
          conversationId,
        });
        return {
          delivered: false,
          reason: "conversation at concurrency cap",
          code: "conversation_busy",
          retryable: true,
        };
      }
      throw error;
    } finally {
      if (queue.idle && this.admissionQueues.get(conversationId) === queue) {
        this.admissionQueues.delete(conversationId);
      }
    }
  }

  /**
   * Run a framework-owned continuation synthesis in the original conversation
   * without posting or committing history. The harness enforces the immutable
   * history boundary and zero-tool policy carried by `continuation`; native
   * delivery happens only after the caller durably persists the returned text.
   */
  async synthesizeContinuation(input: SlackContinuationSynthesisInput): Promise<string> {
    if (!this.isAuthorized(input.channelId)) {
      throw new Error("Slack continuation destination is not in the adapter allowlist.");
    }
    const controller = new AbortController();
    const runKey = `continuation:${input.continuation.continuationId}`;
    this.registerController(runKey, input.conversationId, controller);
    let queue = this.admissionQueues.get(input.conversationId);
    if (queue === undefined) {
      queue = new SerialQueue();
      this.admissionQueues.set(input.conversationId, queue);
    }
    try {
      return await queue.run(async () => {
        const stream = new SilentAgentMessageStream();
        const response = await this.responder.respond({
          conversationId: input.conversationId,
          replyTo: { conversationId: input.replyToConversationId },
          continuation: input.continuation,
          channelId: input.channelId,
          messageTs: input.threadTs ?? "",
          threadTs: input.threadTs ?? "",
          eventId: `continuation:${input.continuation.continuationId}`,
          text: input.prompt,
          trigger: "direct",
          abortSignal: controller.signal,
          metadata: {
            slack: {
              eventId: `continuation:${input.continuation.continuationId}`,
              channel: { id: input.channelId },
              message: {
                ts: input.threadTs ?? "",
                ...(input.threadTs === undefined ? {} : { threadTs: input.threadTs }),
              },
              trigger: "direct",
            },
          },
        }, stream);
        const text = response.text?.trim();
        if (text === undefined || text.length === 0) throw new Error("Continuation synthesis produced no answer.");
        return text;
      });
    } finally {
      this.unregisterController(runKey, input.conversationId, controller);
      if (queue.idle && this.admissionQueues.get(input.conversationId) === queue) {
        this.admissionQueues.delete(input.conversationId);
      }
    }
  }

  /**
   * Append an operator-confirmed continuation to durable history without
   * touching Slack. This is deliberately separate from notify(verbatim) so an
   * ambiguous native send can be reconciled without any chance of reposting.
   */
  async recordContinuationHistory(
    conversationId: string,
    text: string,
    deliveryKey?: string,
  ): Promise<{ readonly recorded: true } | { readonly recorded: false; readonly code: string }> {
    if (this.responder.deliverVerbatim === undefined) {
      return { recorded: false, code: "history_record_unavailable" };
    }
    try {
      await this.responder.deliverVerbatim(
        conversationId,
        text,
        deliveryKey === undefined ? undefined : { idempotencyKey: deliveryKey },
      );
      return { recorded: true };
    } catch (error) {
      this.logger?.warn?.("Slack continuation history-only commit failed.", {
        error: redactSlackErrorMessage(error),
      });
      return { recorded: false, code: "history_record_failed" };
    }
  }

  /**
   * Route any interactivity payload to the right handler: a shortcut/message
   * action by `callback_id`, or a Block Kit button click by `action_id`.
   */
  async handleInteraction(
    payload: SlackInteractivityPayload,
  ): Promise<SlackInteractionHandlingResult> {
    if (payload.type === "block_actions") {
      return this.handleBlockActions(payload);
    }
    return this.handleShortcut(payload);
  }

  /**
   * Route a Slack shortcut payload. When its `callback_id` is bound to a prompt
   * and the resolved destination channel is authorized, run that prompt as a
   * proactive turn. The destination is the binding's `channelId`, else the
   * payload's own channel (message shortcuts), else the first allowlisted channel.
   */
  async handleShortcut(
    payload: SlackShortcutPayload,
  ): Promise<SlackInteractionHandlingResult> {
    const callbackId = typeof payload.callback_id === "string" ? payload.callback_id : undefined;
    if (callbackId === undefined || callbackId.length === 0) {
      return { kind: "ignored", reason: "no_action" };
    }
    const binding = this.shortcuts.get(callbackId);
    if (binding === undefined) {
      return { kind: "ignored", reason: "unbound", id: callbackId };
    }
    // A message shortcut can reply in the source thread; a global shortcut has no
    // thread, so the run posts top-level in the destination channel.
    const threadTs = firstNonEmpty(payload.message?.thread_ts, payload.message?.ts);
    return this.runBoundInteraction(callbackId, binding, payload.channel?.id, threadTs);
  }

  /**
   * Route a Block Kit `block_actions` payload (a clicked button — typically on the
   * App Home tab). Acts on the first action whose `action_id` is a bound Home
   * button. A Home-tab click carries no channel, so the reply goes to the button's
   * `channelId` (or the first allowlisted channel).
   */
  async handleBlockActions(
    payload: SlackBlockActionsPayload,
  ): Promise<SlackInteractionHandlingResult> {
    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    if (actions.length === 0) {
      return { kind: "ignored", reason: "no_action" };
    }
    const action = actions.find(
      (candidate) => typeof candidate.action_id === "string" && this.homeButtons.has(candidate.action_id),
    );
    if (action === undefined || typeof action.action_id !== "string") {
      return { kind: "ignored", reason: "unbound" };
    }
    const actionId = action.action_id;
    const binding = this.homeButtons.get(actionId);
    if (binding === undefined) {
      return { kind: "ignored", reason: "unbound", id: actionId };
    }
    const threadTs = firstNonEmpty(payload.message?.thread_ts, payload.message?.ts);
    return this.runBoundInteraction(actionId, binding, payload.channel?.id, threadTs);
  }

  /**
   * Shared interaction run path: resolve the destination channel, enforce the
   * allowlist, post the optional instant ack, then run the bound prompt as a
   * proactive turn. The returned result is for logging.
   */
  private async runBoundInteraction(
    id: string,
    binding: {
      readonly prompt: string;
      readonly channelId?: SlackChannelId;
      readonly ackText?: string;
      readonly threadReply?: boolean;
    },
    payloadChannelId: SlackChannelId | undefined,
    payloadThreadTs: SlackMessageTs | undefined,
  ): Promise<SlackInteractionHandlingResult> {
    const channelId = firstNonEmpty(binding.channelId, payloadChannelId, this.defaultShortcutChannelId);
    if (channelId === undefined) {
      this.logger?.warn?.("Slack interaction has no destination channel; set channelId on the binding.", { id });
      return { kind: "ignored", reason: "missing_channel", id };
    }
    if (!this.isAuthorized(channelId)) {
      this.logger?.warn?.("Slack interaction targets an unauthorized channel; ignored.", { id, channelId });
      return { kind: "unauthorized", id, channelId };
    }

    // A Slack `thread_ts` is channel-scoped, so only thread off a SOURCE message
    // when the destination IS the channel the interaction came from. A binding that
    // pins a different channelId (or a global shortcut / Home-tab click with no
    // source channel) has no such thread — a foreign thread_ts would 404.
    let threadTs = channelId === payloadChannelId ? payloadThreadTs : undefined;

    // Instant feedback: the result lands seconds later (and a global shortcut or a
    // Home-tab click shows no on-click UI), so post the ack now (best-effort)
    // before the run.
    if (binding.ackText !== undefined) {
      try {
        const ack = await this.api.chatPostMessage({
          channel: channelId,
          text: binding.ackText,
          ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
        });
        // Opt-in (`threadReply`): thread the run's result under the ack so a click
        // with no source thread (Home-tab button / global shortcut) yields ONE
        // thread — ack + result — instead of two separate top-level messages. Left
        // off, the result posts top-level as before. When the interaction already
        // threads off a source message, that thread is kept either way.
        if (binding.threadReply === true && threadTs === undefined) {
          threadTs = ack.ts;
        }
      } catch (error) {
        this.logger?.warn?.("Slack interaction ack message failed (continuing with the run).", {
          id,
          error: redactSlackErrorMessage(error),
        });
      }
    }

    const delivery = await this.notify(channelId, threadTs, binding.prompt);
    const result: SlackInteractionHandlingResult = {
      kind: "triggered",
      id,
      channelId,
      delivered: delivery.delivered,
    };
    if (delivery.reason !== undefined) {
      result.reason = delivery.reason;
    }
    return result;
  }

  /**
   * Publish the App Home tab for a user when they open it. Best-effort: a publish
   * failure is logged, not thrown, so opening Home never surfaces an error.
   */
  private async handleAppHomeOpened(
    callback: SlackEventCallback,
  ): Promise<SlackEventHandlingResult> {
    const userId = callback.event.user;
    if (!this.homeTabEnabled || typeof userId !== "string" || userId.length === 0) {
      return { kind: "ignored", reason: "unsupported_event", eventId: callback.event_id };
    }
    if (typeof this.api.viewsPublish !== "function") {
      this.logger?.warn?.("Home tab is enabled but the Slack client cannot publish views.");
      return { kind: "ignored", reason: "unsupported_event", eventId: callback.event_id };
    }
    const blocks = this.buildHomeTabBlocks();
    if (blocks.length === 0) {
      // views.publish requires 1–100 blocks; an enabled-but-empty Home tab would
      // error on every open. Skip the publish instead (config load also rejects
      // this combination, so it should not happen in practice).
      this.logger?.warn?.("Skipping App Home publish: the Home view has no blocks.");
      return { kind: "ignored", reason: "unsupported_event", eventId: callback.event_id };
    }
    try {
      await this.api.viewsPublish({ userId, view: { type: "home", blocks } });
      return { kind: "home_published", eventId: callback.event_id, userId };
    } catch (error) {
      this.logger?.error?.("Failed to publish the Slack App Home tab.", {
        userId,
        error: redactSlackErrorMessage(error),
      });
      return { kind: "error", eventId: callback.event_id, error };
    }
  }

  /** Build the App Home tab Block Kit: an optional header plus one button per configured Home button. */
  private buildHomeTabBlocks(): readonly unknown[] {
    const blocks: unknown[] = [];
    if (this.homeTabHeaderText !== undefined && this.homeTabHeaderText.trim().length > 0) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: this.homeTabHeaderText } });
    }
    const elements = this.homeButtonOrder.map((button) => ({
      type: "button",
      text: { type: "plain_text", text: button.label, emoji: true },
      action_id: button.actionId,
      value: button.actionId,
    }));
    if (elements.length > 0) {
      blocks.push({ type: "actions", block_id: "home_actions", elements });
    }
    return blocks;
  }

  /**
   * Build the stream options shared by both proactive delivery paths
   * ({@link runProactiveTurn} and {@link runVerbatimDelivery}): a threaded post
   * targets the existing thread; a top-level post records its ts → this
   * conversation so a user's in-thread reply resolves back here.
   */
  private buildProactiveStreamOptions(
    conversationId: string,
    channelId: SlackChannelId,
    threadTs: SlackMessageTs | undefined,
    controller: AbortController,
    deliveryKey?: string,
    silent?: boolean,
    onAnswerReceipt?: (ref: { readonly ts: SlackMessageTs; readonly channel: SlackChannelId }) => void,
  ): SlackMessageStreamOptions {
    const streamOptions: SlackMessageStreamOptions = {
      api: this.api,
      channelId,
      // No reactToTs: a proactive turn has no inbound message to react to.
      finalOnly: this.streamOptions.finalOnly ?? true,
      abortSignal: controller.signal,
      ...(deliveryKey === undefined ? {} : { clientMsgId: slackClientMessageId(deliveryKey) }),
      ...(silent === true ? { silent: true } : {}),
    };
    if (threadTs !== undefined) {
      streamOptions.threadTs = threadTs;
    }
    if (this.recordPostedMessage !== undefined) {
      // A top-level proactive post is a fresh thread root with no prior history.
      // Record its ts → this conversation so a user's in-thread reply resolves
      // back here (the threaded case already shares the thread's conversationId).
      const record = this.recordPostedMessage;
      let recorded = false;
      streamOptions.onPosted = ({ ts, channel }) => {
        if (threadTs === undefined && record !== undefined && !recorded && ts.length > 0) {
          recorded = true;
          record(channel, ts, conversationId);
        }
      };
    }
    if (onAnswerReceipt !== undefined) {
      streamOptions.onDeliveryReceipt = (receipt: SlackDeliveryReceipt) => {
        if (receipt.contentKind === "answer") {
          onAnswerReceipt({ ts: receipt.ts, channel: receipt.channel });
        }
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
    return streamOptions;
  }

  /**
   * Deliver `text` VERBATIM to a Slack destination: post it unchanged through the
   * normal stream with NO model call (the producing cron/webhook run already wrote
   * the message), then record it to the destination's durable history via the
   * responder so a later reply resumes with it in context. Best-effort: a
   * history-record failure never fails an already-delivered post.
   */
  private async runVerbatimDelivery(
    conversationId: string,
    channelId: SlackChannelId,
    threadTs: SlackMessageTs | undefined,
    text: string,
    runKey: string,
    controller: AbortController,
    deliveryKey?: string,
    silent?: boolean,
  ): Promise<SlackNotifyResult> {
    let answerReceipt: { readonly ts: SlackMessageTs; readonly channel: SlackChannelId } | undefined;
    const streamOptions = this.buildProactiveStreamOptions(
      conversationId,
      channelId,
      threadTs,
      controller,
      deliveryKey,
      silent,
      (ref) => {
        answerReceipt = ref;
      },
    );
    const stream = new SlackMessageStream(streamOptions);
    try {
      if (controller.signal.aborted) {
        return { delivered: false, reason: "cancelled", code: "cancelled", retryable: false };
      }
      if (text.trim().length === 0) {
        return { delivered: false, reason: "empty notification", code: "empty_notification", retryable: false };
      }
      try {
        await stream.finish(text);
      } catch (error) {
        if (isSlackDeliveryError(error)) {
          const failure = slackNotifyFailure(error, answerReceipt !== undefined);
          this.logger?.error?.("Slack verbatim notify delivery failed.", {
            error: redactSlackErrorMessage(error),
            disposition: failure.ambiguous === true
              ? "unknown"
              : failure.retryable === true ? "retryable" : "permanent",
          });
          return failure;
        }
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          return { delivered: false, reason: "cancelled", code: "cancelled", retryable: false };
        }
        this.logger?.error?.("Slack verbatim notify delivery failed.", {
          error: redactSlackErrorMessage(error),
        });
        return { delivered: false, reason: "delivery failed", code: "delivery_failed", retryable: true };
      }
      let historyRecorded = false;
      let historyErrorCode: string | undefined;
      try {
        if (this.responder.deliverVerbatim === undefined) {
          historyErrorCode = "history_record_unavailable";
        } else {
          await this.responder.deliverVerbatim(
            conversationId,
            text,
            deliveryKey === undefined ? undefined : { idempotencyKey: deliveryKey },
          );
          historyRecorded = true;
        }
      } catch (error) {
        historyErrorCode = "history_record_failed";
        this.logger?.warn?.("Slack verbatim notify history record failed.", {
          error: redactSlackErrorMessage(error),
        });
      }
      return {
        delivered: true,
        code: "delivered",
        channelId: "slack",
        historyRecorded,
        ...(historyErrorCode === undefined ? {} : { historyErrorCode }),
        ...(answerReceipt === undefined
          ? {}
          : { deliveryId: `slack:${answerReceipt.channel}:${answerReceipt.ts}` }),
      };
    } finally {
      this.unregisterController(runKey, conversationId, controller);
    }
  }

  private async runProactiveTurn(
    conversationId: string,
    channelId: SlackChannelId,
    threadTs: SlackMessageTs | undefined,
    text: string,
    runKey: string,
    controller: AbortController,
    deliveryKey?: string,
    silent?: boolean,
  ): Promise<SlackNotifyResult> {
    let answerReceipt: { readonly ts: SlackMessageTs; readonly channel: SlackChannelId } | undefined;
    const streamOptions = this.buildProactiveStreamOptions(
      conversationId,
      channelId,
      threadTs,
      controller,
      deliveryKey,
      silent,
      (ref) => {
        answerReceipt = ref;
      },
    );
    const stream = new SlackMessageStream(streamOptions);
    try {
      if (controller.signal.aborted) {
        return { delivered: false, reason: "cancelled", code: "cancelled", retryable: false };
      }
      const request: AgentRequest = {
        conversationId,
        replyTo: { conversationId },
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
          return { delivered: false, reason: "cancelled", code: "cancelled", retryable: false };
        }
        this.logger?.error?.("Slack proactive notify failed.", {
          error: redactSlackErrorMessage(error),
        });
        return { delivered: false, reason: "responder failed", code: "responder_failed", retryable: true };
      }
      const answer = response.text;
      if (controller.signal.aborted) {
        return { delivered: false, reason: "cancelled", code: "cancelled", retryable: false };
      }
      if (answer === undefined || answer.trim().length === 0) {
        return { delivered: false, reason: "agent produced no answer", code: "empty_response", retryable: false };
      }
      try {
        await stream.finish(answer);
      } catch (error) {
        if (isSlackDeliveryError(error)) {
          const failure = slackNotifyFailure(error, answerReceipt !== undefined);
          this.logger?.error?.("Slack proactive delivery failed after a successful AI run.", {
            error: redactSlackErrorMessage(error),
            disposition: failure.ambiguous === true
              ? "unknown"
              : failure.retryable === true ? "retryable" : "permanent",
          });
          return failure;
        }
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          return { delivered: false, reason: "cancelled", code: "cancelled", retryable: false };
        }
        this.logger?.error?.("Slack proactive delivery failed after a successful AI run.", {
          error: redactSlackErrorMessage(error),
        });
        return { delivered: false, reason: "delivery failed", code: "delivery_failed", retryable: true };
      }
      return {
        delivered: true,
        code: "delivered",
        channelId: "slack",
        ...(answerReceipt === undefined
          ? {}
          : { deliveryId: `slack:${answerReceipt.channel}:${answerReceipt.ts}` }),
      };
    } finally {
      this.unregisterController(runKey, conversationId, controller);
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
        await this.finishCancelledUnlessAcknowledged(stream, controller.signal);
        return { kind: "cancelled", eventId: event.eventId, channelId: event.channelId };
      }

      const attachments = await this.downloadAttachments(event.files, controller.signal);
      if (controller.signal.aborted) {
        await this.finishCancelledUnlessAcknowledged(stream, controller.signal);
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
        await this.finishCancelledUnlessAcknowledged(stream, controller.signal);
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
        await this.finishCancelledUnlessAcknowledged(stream, controller.signal, error);
        return { kind: "cancelled", eventId: event.eventId, channelId: event.channelId };
      }

      this.logger?.error?.("Slack adapter responder failed.", {
        error: redactSlackErrorMessage(error),
      });
      await finishSafely(stream, this.messages.errorText, this.logger);
      return { kind: "error", eventId: event.eventId, channelId: event.channelId, error };
    } finally {
      this.unregisterController(runKey, conversationId, controller);
    }
  }

  private async finishCancelledUnlessAcknowledged(
    stream: SlackMessageStream,
    signal: AbortSignal,
    error?: unknown,
  ): Promise<void> {
    const acknowledgedByCommand =
      isChannelUserCancelReason(signal.reason) ||
      (isAgentResponseCancelledError(error) && isChannelUserCancelReason(
        readSafeSlackDataProperty(error, "reason"),
      ));
    if (!acknowledgedByCommand) {
      await finishSafely(stream, this.messages.cancelledText, this.logger);
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
          error: redactSlackErrorMessage(error),
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

  private registerController(runKey: string, conversationId: string, controller: AbortController): void {
    addController(this.activeControllers, runKey, controller);
    addController(this.activeControllersByConversation, conversationId, controller);
  }

  private unregisterController(runKey: string, conversationId: string, controller: AbortController): void {
    removeController(this.activeControllers, runKey, controller);
    removeController(this.activeControllersByConversation, conversationId, controller);
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
      return normalizeSlackMarkdownToMarkdown(text);
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
    return normalizeSlackMarkdownToMarkdown(stripped);
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
    replyTo: { conversationId: `slack:${event.channelId}:${event.threadTs}` },
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
      error: redactSlackErrorMessage(error),
    });
  }
}

function runKeyFor(event: SlackTextEvent): string {
  return `${event.channelId}:${event.threadTs}`;
}

function addController(
  index: Map<string, Set<AbortController>>,
  key: string,
  controller: AbortController,
): void {
  let controllers = index.get(key);
  if (controllers === undefined) {
    controllers = new Set<AbortController>();
    index.set(key, controllers);
  }
  controllers.add(controller);
}

function removeController(
  index: Map<string, Set<AbortController>>,
  key: string,
  controller: AbortController,
): void {
  const controllers = index.get(key);
  if (controllers === undefined) return;
  controllers.delete(controller);
  if (controllers.size === 0) index.delete(key);
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

/** Provider event sink for a continuation turn whose output is persisted before delivery. */
class SilentAgentMessageStream implements AgentMessageStream {
  async status(): Promise<void> {}
  async append(): Promise<void> {}
  async replace(): Promise<void> {}
  async event(): Promise<void> {}
  async finish(): Promise<void> {}
}

/** Derive a stable RFC 4122-shaped UUID for Slack's client_msg_id field. */
function slackClientMessageId(deliveryKey: string): string {
  const bytes = createHash("sha256").update(`mono-agent-slack-delivery\0${deliveryKey}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** First argument that is a non-blank string, else undefined. */
function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}
