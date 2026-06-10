import {
  isAgentResponseCancelledError,
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
  metadata: {
    slack: SlackRequestMetadata;
    [key: string]: unknown;
  };
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
  logger?: SlackAdapterLogger;
}

export type SlackEventIgnoredReason =
  | "unsupported_event"
  | "unsupported_message"
  | "empty_text"
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

interface ActiveRun {
  controller: AbortController;
}

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
}

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
  private readonly logger: SlackAdapterLogger | undefined;
  private readonly activeRuns = new Map<string, ActiveRun>();

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
    this.logger = options.logger;

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
    if (text.length === 0) {
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
    const activeRun = this.activeRuns.get(runKey);
    if (command?.name === "cancel") {
      if (activeRun !== undefined) {
        activeRun.controller.abort(new Error("Cancelled by Slack user."));
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

    if (activeRun !== undefined) {
      await this.api.chatPostMessage({
        channel: event.channelId,
        text: this.messages.busyText,
        thread_ts: event.threadTs,
      });
      return {
        kind: "busy",
        eventId: event.eventId,
        channelId: event.channelId,
      };
    }

    return await this.respondToEvent(event, text, runKey);
  }

  private async respondToEvent(
    event: SlackTextEvent,
    text: string,
    runKey: string,
  ): Promise<SlackEventHandlingResult> {
    const controller = new AbortController();
    const activeRun: ActiveRun = { controller };
    this.activeRuns.set(runKey, activeRun);

    const streamOptions: SlackMessageStreamOptions = {
      api: this.api,
      channelId: event.channelId,
      threadTs: event.threadTs,
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

      const request = buildAgentRequest(event, text, controller.signal);
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
      if (this.activeRuns.get(runKey) === activeRun) {
        this.activeRuns.delete(runKey);
      }
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
    if (rawEvent.subtype !== undefined) {
      return ignored("unsupported_message", callback, rawEvent);
    }
    if (
      eventType === "message" &&
      rawEvent.channel_type !== "im"
    ) {
      return ignored("unsupported_event", callback, rawEvent);
    }
    if (
      typeof rawEvent.channel !== "string" ||
      typeof rawEvent.ts !== "string" ||
      typeof rawEvent.text !== "string"
    ) {
      return ignored("unsupported_message", callback, rawEvent);
    }

    const threadTs = typeof rawEvent.thread_ts === "string" && rawEvent.thread_ts.trim().length > 0
      ? rawEvent.thread_ts
      : rawEvent.ts;
    const event: SlackTextEvent = {
      eventId: callback.event_id,
      channelId: rawEvent.channel,
      text: this.prepareText(rawEvent.text),
      messageTs: rawEvent.ts,
      threadTs,
      trigger,
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
    conversationId: `slack:${event.channelId}:${event.threadTs}`,
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
  return request;
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

function normalizeIdForMatch(value: string): string {
  return value.trim().toLowerCase();
}
