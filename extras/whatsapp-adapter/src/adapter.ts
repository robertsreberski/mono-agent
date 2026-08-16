import {
  AgentResponseCancelledError,
  createChannelUserCancelReason,
  isAgentResponseCancelledError,
  isChannelUserCancelReason,
  type AgentLiveInputOffer,
  type AgentMessageStream,
  type NotifyDeliveryResult,
  type ProcessJobProjection,
  type ProcessJobWakeDisposition,
  type AgentRequestBase,
  type AgentResponder as SharedAgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";

import {
  normalizeWhatsAppMessage,
  type WhatsAppMessageIgnoredReason,
} from "./message-normalizer.js";
import {
  WhatsAppMessageStream,
  type WhatsAppMessageStreamLogger,
  type WhatsAppMessageStreamOptions,
} from "./message-stream.js";
import type {
  WhatsAppChatKind,
  WhatsAppJid,
  WhatsAppRawMessage,
  WhatsAppSocketLike,
  WhatsAppTextMessage,
} from "./types.js";

export type WhatsAppGroupTriggerMode = "mention" | "any";

export type WhatsAppTriggerKind = "direct" | "group_mention" | "group_any";

export interface WhatsAppTriggerOptions {
  groupMode?: WhatsAppGroupTriggerMode;
  botJids?: WhatsAppJid[];
  mentionTextAliases?: string[];
  stripMentionText?: boolean;
}

export interface AgentRequest extends AgentRequestBase {
  conversationId: string;
  chatJid: WhatsAppJid;
  remoteJid: WhatsAppJid;
  chatKind: WhatsAppChatKind;
  senderJid?: WhatsAppJid;
  participantJid?: WhatsAppJid;
  messageId?: string;
  text: string;
  trigger: WhatsAppTriggerKind;
  abortSignal: AbortSignal;
  metadata: {
    whatsapp: WhatsAppRequestMetadata;
    [key: string]: unknown;
  };
}

export interface WhatsAppRequestMetadata {
  chat: {
    jid: WhatsAppJid;
    kind: WhatsAppChatKind;
  };
  message: {
    id?: string;
    timestamp?: number;
  };
  sender?: {
    jid: WhatsAppJid;
    pushName?: string;
  };
  participantJid?: WhatsAppJid;
  mentionedJids: WhatsAppJid[];
  trigger: WhatsAppTriggerKind;
}

export type { AgentResponse };
export type AgentResponder = SharedAgentResponder<AgentRequest, AgentMessageStream, AgentResponse>;

export interface WhatsAppAdapterMessages {
  welcomeText?: string;
  helpText?: string;
  busyText?: string;
  unauthorizedText?: string;
  cancelledText?: string;
  errorText?: string;
  unsupportedText?: string;
  mentionRequiredText?: string;
}

export interface WhatsAppAdapterStreamOptions {
  initialStatusText?: string;
  sendInitialStatus?: boolean;
  maxMessageChars?: number;
}

export interface WhatsAppAdapterLogger extends WhatsAppMessageStreamLogger {
  info?(message: string, metadata?: Record<string, unknown>): void;
}

export interface WhatsAppAdapterOptions {
  socket: WhatsAppSocketLike;
  responder: AgentResponder;
  allowedChatJids?: WhatsAppJid[];
  allowAllChats?: boolean;
  trigger?: WhatsAppTriggerOptions;
  stream?: WhatsAppAdapterStreamOptions;
  messages?: WhatsAppAdapterMessages;
  logger?: WhatsAppAdapterLogger;
}

export interface WhatsAppNotifyOptions {
  readonly deliveryKey?: string;
  readonly steerActive?: boolean;
}

export interface WhatsAppNotifyResult extends NotifyDeliveryResult {
  readonly disposition?: ProcessJobWakeDisposition;
}

export type WhatsAppAdapterIgnoredReason =
  | WhatsAppMessageIgnoredReason
  | "mention_required"
  | "non_message_update"
  | "history_sync_ignored";

export type WhatsAppMessageHandlingResult =
  | {
      kind: "handled";
      chatJid: WhatsAppJid;
      messageId?: string;
      action: "command" | "responded";
      command?: "start" | "help";
      trigger: WhatsAppTriggerKind;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "ignored";
      reason: WhatsAppAdapterIgnoredReason;
      chatJid?: WhatsAppJid;
      messageId?: string;
    }
  | {
      kind: "unauthorized";
      chatJid: WhatsAppJid;
      messageId?: string;
    }
  | {
      kind: "busy";
      chatJid: WhatsAppJid;
      messageId?: string;
    }
  | {
      kind: "cancelled";
      chatJid: WhatsAppJid;
      messageId?: string;
    }
  | {
      kind: "error";
      chatJid?: WhatsAppJid;
      messageId?: string;
      error: unknown;
    };

interface ActiveRun {
  controller: AbortController;
  settled: Promise<void>;
  settle(): void;
}

interface NormalizedCommand {
  name: string;
}

interface TriggerResolution {
  kind: WhatsAppTriggerKind;
  text: string;
}

const DEFAULT_MESSAGES: Required<WhatsAppAdapterMessages> = {
  welcomeText:
    "Hello! Send me a WhatsApp text message and I will pass it to the configured agent.",
  helpText:
    "Send a text message to talk to the agent. Use /cancel to stop the current response.",
  busyText: "I am still working on your previous message. Use /cancel to stop it.",
  unauthorizedText: "This WhatsApp chat is not authorized to use this bot.",
  cancelledText: "Cancelled.",
  errorText: "The agent failed while processing your message.",
  unsupportedText: "I can only handle WhatsApp text messages in this adapter for now.",
  mentionRequiredText: "Mention this bot to trigger the agent in this group.",
};

const DEFAULT_STREAM_OPTIONS: Required<WhatsAppAdapterStreamOptions> = {
  initialStatusText: "Thinking…",
  sendInitialStatus: true,
  maxMessageChars: 3_800,
};

const PROCESS_JOB_WAKE_DELIVERY_METADATA = Symbol.for("mono-agent.process-job-wake.delivery-key.v1");

export class WhatsAppAdapter {
  private readonly socket: WhatsAppSocketLike;
  private readonly responder: AgentResponder;
  private readonly allowAllChats: boolean;
  private readonly allowedChatJids: Set<string>;
  private readonly triggerOptions: Required<WhatsAppTriggerOptions>;
  private readonly streamOptions: Required<WhatsAppAdapterStreamOptions>;
  private readonly messages: Required<WhatsAppAdapterMessages>;
  private readonly logger: WhatsAppAdapterLogger | undefined;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly proactiveTails = new Map<string, Promise<void>>();
  private readonly proactiveReservations = new Map<string, number>();
  private stopping = false;

  constructor(options: WhatsAppAdapterOptions) {
    this.socket = options.socket;
    this.responder = options.responder;
    this.allowAllChats = options.allowAllChats === true;
    this.allowedChatJids = new Set(
      options.allowedChatJids?.map((chatJid) => normalizeJidForMatch(chatJid)) ?? [],
    );
    const mentionTextAliases = options.trigger?.mentionTextAliases ?? [];
    this.triggerOptions = {
      groupMode: options.trigger?.groupMode ?? "mention",
      botJids: options.trigger?.botJids ?? [],
      mentionTextAliases,
      stripMentionText:
        options.trigger?.stripMentionText ?? mentionTextAliases.length > 0,
    };
    this.streamOptions = { ...DEFAULT_STREAM_OPTIONS, ...options.stream };
    this.messages = { ...DEFAULT_MESSAGES, ...options.messages };
    this.logger = options.logger;

    if (!this.allowAllChats && this.allowedChatJids.size === 0) {
      throw new TypeError(
        "WhatsAppAdapter requires allowedChatJids or allowAllChats: true.",
      );
    }
  }

  async handleMessage(rawMessage: WhatsAppRawMessage): Promise<WhatsAppMessageHandlingResult> {
    if (this.stopping) {
      return {
        kind: "error",
        error: new AgentResponseCancelledError("WhatsApp adapter is stopping."),
      };
    }
    const normalized = normalizeWhatsAppMessage(rawMessage);
    if (normalized.kind === "ignored") {
      return await this.handleIgnoredMessage(normalized);
    }

    const message = normalized.message;
    if (!this.isAuthorized(message.chatJid)) {
      await this.sendText(message.chatJid, this.messages.unauthorizedText);
      return withMessageId(
        { kind: "unauthorized", chatJid: message.chatJid },
        message.messageId,
      );
    }

    const trigger = this.resolveTrigger(message);
    if (trigger === undefined) {
      this.logger?.debug?.("WhatsApp group message ignored because mention is required.", {
        chatJid: message.chatJid,
        messageId: message.messageId,
      });
      return withMessageId(
        { kind: "ignored", reason: "mention_required", chatJid: message.chatJid },
        message.messageId,
      );
    }

    if (trigger.text.length === 0) {
      await this.sendText(message.chatJid, this.messages.unsupportedText);
      return withMessageId(
        { kind: "ignored", reason: "empty_text", chatJid: message.chatJid },
        message.messageId,
      );
    }

    const command = parseCommand(trigger.text);
    if (command?.name === "start") {
      await this.sendText(message.chatJid, this.messages.welcomeText);
      return withMessageId(
        {
          kind: "handled",
          chatJid: message.chatJid,
          action: "command",
          command: "start",
          trigger: trigger.kind,
        },
        message.messageId,
      );
    }

    if (command?.name === "help") {
      await this.sendText(message.chatJid, this.messages.helpText);
      return withMessageId(
        {
          kind: "handled",
          chatJid: message.chatJid,
          action: "command",
          command: "help",
          trigger: trigger.kind,
        },
        message.messageId,
      );
    }

    const runKey = message.chatJid;
    const activeRun = this.activeRuns.get(runKey);
    if (command?.name === "cancel") {
      const reason = createChannelUserCancelReason("WhatsApp");
      this.responder.cancel?.(`whatsapp:${message.chatJid}`, reason);
      if (activeRun !== undefined) {
        activeRun.controller.abort(reason);
      }
      await this.sendText(message.chatJid, this.messages.cancelledText);
      return withMessageId(
        { kind: "cancelled", chatJid: message.chatJid },
        message.messageId,
      );
    }

    if (activeRun !== undefined || (this.proactiveReservations.get(runKey) ?? 0) > 0) {
      await this.sendText(message.chatJid, this.messages.busyText);
      return withMessageId({ kind: "busy", chatJid: message.chatJid }, message.messageId);
    }

    return await this.respondToMessage(message, trigger, runKey);
  }

  /** Stop accepting work and signal every active responder invocation. */
  stop(reason: unknown = new AgentResponseCancelledError("WhatsApp adapter stopped.")): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const active of this.activeRuns.values()) {
      active.controller.abort(reason);
    }
  }

  async notify(
    chatJid: WhatsAppJid,
    text: string,
    options?: WhatsAppNotifyOptions,
  ): Promise<WhatsAppNotifyResult> {
    if (this.stopping) return { delivered: false, reason: "adapter stopped", retryable: true };
    if (!this.isAuthorized(chatJid)) {
      return { delivered: false, reason: "whatsapp chat is not in the adapter allowlist", retryable: false };
    }
    return await this.runReservedProactive(chatJid, async () => {
      if (options?.steerActive === true
        && options.deliveryKey !== undefined
        && this.responder.offerLiveInput !== undefined) {
        let offer: AgentLiveInputOffer;
        try {
          offer = this.responder.offerLiveInput({
            conversationId: `whatsapp:${chatJid}`,
            id: options.deliveryKey,
            text,
            receivedAt: new Date().toISOString(),
            deliveryKey: options.deliveryKey,
          });
        } catch (error) {
          this.logger?.debug?.("WhatsApp process-job steering failed; running the reserved fallback turn.", {
            error: error instanceof Error ? error.message : String(error),
          });
          return await this.runProactiveTurn(chatJid, text, options.deliveryKey);
        }
        if (offer.status === "accepted") {
          try {
            const settlement = await offer.settled;
            if (settlement.status === "applied") {
              return {
                delivered: true,
                code: "delivered",
                channelId: "whatsapp",
                historyRecorded: true,
                disposition: "steered",
              };
            }
          } catch {
            // The reserved fallback below owns every non-applied settlement.
          }
        }
      }
      return await this.runProactiveTurn(chatJid, text, options?.deliveryKey);
    });
  }

  async updateProcessJob(
    chatJid: WhatsAppJid,
    projection: ProcessJobProjection,
  ): Promise<NotifyDeliveryResult> {
    if (this.stopping) return { delivered: false, reason: "adapter stopped", retryable: true };
    if (!this.isAuthorized(chatJid)) {
      return { delivered: false, reason: "whatsapp chat is not in the adapter allowlist", retryable: false };
    }
    const status = projection.state.replaceAll("_", " ");
    const sent = await this.socket.sendMessage(chatJid, {
      text: `Background job ${projection.jobId}: ${status}.`,
    });
    return {
      delivered: true,
      code: "delivered",
      channelId: "whatsapp",
      ...(sent?.key?.id == null ? {} : { deliveryId: sent.key.id }),
    };
  }

  private async handleIgnoredMessage(
    ignored: Extract<ReturnType<typeof normalizeWhatsAppMessage>, { kind: "ignored" }>,
  ): Promise<WhatsAppMessageHandlingResult> {
    if (ignored.chatJid === undefined) {
      return ignored;
    }

    const silentReason =
      ignored.reason === "from_self" ||
      ignored.reason === "status_broadcast_ignored" ||
      ignored.reason === "broadcast_ignored";
    if (silentReason) {
      return ignored;
    }

    if (!this.isAuthorized(ignored.chatJid)) {
      await this.sendText(ignored.chatJid, this.messages.unauthorizedText);
      return withMessageId(
        { kind: "unauthorized", chatJid: ignored.chatJid },
        ignored.messageId,
      );
    }

    await this.sendText(ignored.chatJid, this.messages.unsupportedText);
    return ignored;
  }

  private async respondToMessage(
    message: WhatsAppTextMessage,
    trigger: TriggerResolution,
    runKey: string,
  ): Promise<WhatsAppMessageHandlingResult> {
    const controller = new AbortController();
    const activeRun = createActiveRun(controller);
    this.activeRuns.set(runKey, activeRun);

    const streamOptions: WhatsAppMessageStreamOptions = {
      socket: this.socket,
      chatJid: message.chatJid,
      initialStatusText: this.streamOptions.initialStatusText,
      sendInitialStatus: this.streamOptions.sendInitialStatus,
      maxMessageChars: this.streamOptions.maxMessageChars,
      quotedMessage: message.raw,
    };
    if (this.logger !== undefined) {
      streamOptions.logger = this.logger;
    }
    const stream = new WhatsAppMessageStream(streamOptions);

    try {
      await stream.status(this.streamOptions.initialStatusText);
      if (controller.signal.aborted) {
        await this.finishCancelledUnlessAcknowledged(stream, controller.signal);
        return withMessageId(
          { kind: "cancelled", chatJid: message.chatJid },
          message.messageId,
        );
      }

      const request = buildAgentRequest(message, trigger, controller.signal);
      const response = await this.responder.respond(request, stream);

      if (controller.signal.aborted) {
        await this.finishCancelledUnlessAcknowledged(stream, controller.signal);
        return withMessageId(
          { kind: "cancelled", chatJid: message.chatJid },
          message.messageId,
        );
      }

      await stream.finish(response.text, response.parts === undefined ? undefined : { parts: response.parts });
      const result: WhatsAppMessageHandlingResult = {
        kind: "handled",
        chatJid: message.chatJid,
        action: "responded",
        trigger: trigger.kind,
      };
      if (message.messageId !== undefined) {
        result.messageId = message.messageId;
      }
      if (response.metadata !== undefined) {
        result.metadata = response.metadata;
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
        await this.finishCancelledUnlessAcknowledged(stream, controller.signal, error);
        return withMessageId(
          { kind: "cancelled", chatJid: message.chatJid },
          message.messageId,
        );
      }

      this.logger?.error?.("WhatsApp adapter responder failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      await finishSafely(stream, this.messages.errorText, this.logger);
      const result: WhatsAppMessageHandlingResult = {
        kind: "error",
        chatJid: message.chatJid,
        error,
      };
      if (message.messageId !== undefined) {
        result.messageId = message.messageId;
      }
      return result;
    } finally {
      activeRun.settle();
      if (this.activeRuns.get(runKey) === activeRun) {
        this.activeRuns.delete(runKey);
      }
    }
  }

  private async runProactiveTurn(
    chatJid: WhatsAppJid,
    text: string,
    deliveryKey?: string,
  ): Promise<WhatsAppNotifyResult> {
    const prior = this.activeRuns.get(chatJid);
    if (prior !== undefined) await prior.settled;
    if (this.stopping) return { delivered: false, reason: "adapter stopped", retryable: true };
    const controller = new AbortController();
    const activeRun = createActiveRun(controller);
    this.activeRuns.set(chatJid, activeRun);
    const stream = new WhatsAppMessageStream({
      socket: this.socket,
      chatJid,
      initialStatusText: this.streamOptions.initialStatusText,
      sendInitialStatus: this.streamOptions.sendInitialStatus,
      maxMessageChars: this.streamOptions.maxMessageChars,
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    });
    try {
      await stream.status(this.streamOptions.initialStatusText);
      const conversationId = `whatsapp:${chatJid}`;
      const metadata: AgentRequest["metadata"] = {
        whatsapp: {
          chat: { jid: chatJid, kind: chatJid.endsWith("@g.us") ? "group" : "direct" },
          message: {},
          mentionedJids: [],
          trigger: chatJid.endsWith("@g.us") ? "group_any" : "direct",
        },
        ...(deliveryKey === undefined ? {} : { [PROCESS_JOB_WAKE_DELIVERY_METADATA]: deliveryKey }),
      };
      const response = await this.responder.respond({
        conversationId,
        replyTo: { conversationId },
        chatJid,
        remoteJid: chatJid,
        chatKind: chatJid.endsWith("@g.us") ? "group" : "direct",
        text,
        trigger: chatJid.endsWith("@g.us") ? "group_any" : "direct",
        abortSignal: controller.signal,
        metadata,
      }, stream);
      await stream.finish(response.text, response.parts === undefined ? undefined : { parts: response.parts });
      return {
        delivered: true,
        code: "delivered",
        channelId: "whatsapp",
        historyRecorded: true,
        disposition: "follow_up",
      };
    } catch (error) {
      if (!controller.signal.aborted && !isAgentResponseCancelledError(error)) {
        await finishSafely(stream, this.messages.errorText, this.logger);
      }
      return {
        delivered: false,
        code: "process_job_wake_failed",
        reason: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    } finally {
      activeRun.settle();
      if (this.activeRuns.get(chatJid) === activeRun) this.activeRuns.delete(chatJid);
    }
  }

  private async runReservedProactive<T>(chatJid: WhatsAppJid, task: () => Promise<T>): Promise<T> {
    this.proactiveReservations.set(chatJid, (this.proactiveReservations.get(chatJid) ?? 0) + 1);
    const previous = this.proactiveTails.get(chatJid) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const tail = previous.catch(() => undefined).then(async () => await current);
    this.proactiveTails.set(chatJid, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      const remaining = (this.proactiveReservations.get(chatJid) ?? 1) - 1;
      if (remaining === 0) this.proactiveReservations.delete(chatJid);
      else this.proactiveReservations.set(chatJid, remaining);
      if (this.proactiveTails.get(chatJid) === tail) this.proactiveTails.delete(chatJid);
    }
  }

  private async finishCancelledUnlessAcknowledged(
    stream: WhatsAppMessageStream,
    signal: AbortSignal,
    error?: unknown,
  ): Promise<void> {
    const acknowledgedByCommand =
      isChannelUserCancelReason(signal.reason) ||
      (isAgentResponseCancelledError(error) && isChannelUserCancelReason(error.reason));
    if (!acknowledgedByCommand) {
      await finishSafely(stream, this.messages.cancelledText, this.logger);
    }
  }

  private resolveTrigger(message: WhatsAppTextMessage): TriggerResolution | undefined {
    if (message.chatKind === "direct") {
      return { kind: "direct", text: this.stripMentionAliases(message.text).trim() };
    }

    if (this.triggerOptions.groupMode === "any") {
      return { kind: "group_any", text: this.stripMentionAliases(message.text).trim() };
    }

    if (!mentionsAnyBotJid(message.mentionedJids, this.triggerOptions.botJids)) {
      return undefined;
    }

    return { kind: "group_mention", text: this.stripMentionAliases(message.text).trim() };
  }

  private stripMentionAliases(text: string): string {
    if (!this.triggerOptions.stripMentionText) {
      return text;
    }

    let stripped = text;
    for (const alias of this.triggerOptions.mentionTextAliases) {
      const normalizedAlias = alias.trim();
      if (normalizedAlias.length === 0) {
        continue;
      }
      stripped = stripped.replaceAll(normalizedAlias, " ");
    }
    return stripped.replace(/\s+/gu, " ").trim();
  }

  private isAuthorized(chatJid: WhatsAppJid): boolean {
    return this.allowAllChats || this.allowedChatJids.has(normalizeJidForMatch(chatJid));
  }

  private async sendText(chatJid: WhatsAppJid, text: string): Promise<void> {
    await this.socket.sendMessage(chatJid, { text });
  }
}

function createActiveRun(controller: AbortController): ActiveRun {
  let settle!: () => void;
  const settled = new Promise<void>((resolvePromise) => { settle = resolvePromise; });
  return { controller, settled, settle };
}

function buildAgentRequest(
  message: WhatsAppTextMessage,
  trigger: TriggerResolution,
  abortSignal: AbortSignal,
): AgentRequest {
  const metadata: WhatsAppRequestMetadata = {
    chat: { jid: message.chatJid, kind: message.chatKind },
    message: {},
    mentionedJids: message.mentionedJids,
    trigger: trigger.kind,
  };
  if (message.messageId !== undefined) {
    metadata.message.id = message.messageId;
  }
  if (message.timestamp !== undefined) {
    metadata.message.timestamp = message.timestamp;
  }
  if (message.senderJid !== undefined) {
    metadata.sender = { jid: message.senderJid };
    if (message.pushName !== undefined) {
      metadata.sender.pushName = message.pushName;
    }
  }
  if (message.participantJid !== undefined) {
    metadata.participantJid = message.participantJid;
  }

  const conversationId = `whatsapp:${message.chatJid}`;
  const request: AgentRequest = {
    conversationId,
    replyTo: { conversationId },
    chatJid: message.chatJid,
    remoteJid: message.remoteJid,
    chatKind: message.chatKind,
    text: trigger.text,
    trigger: trigger.kind,
    abortSignal,
    metadata: { whatsapp: metadata },
  };
  if (message.senderJid !== undefined) {
    request.senderJid = message.senderJid;
  }
  if (message.participantJid !== undefined) {
    request.participantJid = message.participantJid;
  }
  if (message.messageId !== undefined) {
    request.messageId = message.messageId;
  }
  return request;
}

function parseCommand(text: string): NormalizedCommand | undefined {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/u);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return { name: match[1].toLowerCase() };
}

async function finishSafely(
  stream: WhatsAppMessageStream,
  text: string,
  logger: WhatsAppAdapterLogger | undefined,
): Promise<void> {
  try {
    await stream.finish(text);
  } catch (error) {
    logger?.error?.("Failed to send WhatsApp terminal stream message.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function mentionsAnyBotJid(
  mentionedJids: readonly WhatsAppJid[],
  botJids: readonly WhatsAppJid[],
): boolean {
  if (botJids.length === 0) {
    return false;
  }
  const configured = new Set(botJids.map((jid) => normalizeJidForMatch(jid)));
  return mentionedJids.some((jid) => configured.has(normalizeJidForMatch(jid)));
}

function normalizeJidForMatch(jid: WhatsAppJid): string {
  return jid.trim().toLowerCase();
}

function withMessageId<T extends object>(
  result: T,
  messageId: string | undefined,
): T {
  if (messageId !== undefined) {
    (result as T & { messageId: string }).messageId = messageId;
  }
  return result;
}
