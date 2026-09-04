import {
  AgentResponseCancelledError,
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  DEFAULT_EMPTY_FINAL_TEXT,
  createChannelUserCancelReason,
  isAgentResponseCancelledError,
  isChannelUserCancelReason,
  normalizeTrailing,
  type AgentAttachment,
  type AgentLiveInputOffer,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder as SharedAgentResponder,
  type AgentResponse,
  type NotifyDeliveryResult,
  type ProcessJobProjection,
  type ProcessJobWakeDisposition,
} from "@mono-agent/agent-contracts";

import type { MessengerMessagingType } from "./config.js";
import type { MessengerGraphClientLike, MessengerSendOptions } from "./graph-client.js";
import { MessengerMessageStream, type MessengerMessageStreamLogger } from "./message-stream.js";
import { MESSENGER_MAX_MESSAGE_CHARS, stripMarkdownForMessenger } from "./text.js";

export const MESSENGER_CHANNEL_ID = "messenger";

/** Conversation id for a Messenger user: `messenger:<psid>`. */
export function messengerConversationId(userId: string): string {
  return `${MESSENGER_CHANNEL_ID}:${userId}`;
}

/** Parse `messenger:<psid>` back into the PSID; undefined for any other shape. */
export function messengerUserIdFromConversation(conversationId: string): string | undefined {
  const prefix = `${MESSENGER_CHANNEL_ID}:`;
  if (!conversationId.startsWith(prefix)) {
    return undefined;
  }
  const userId = conversationId.slice(prefix.length);
  return /^\d{1,64}$/u.test(userId) ? userId : undefined;
}

export interface MessengerWebhookAttachment {
  readonly type?: string;
  readonly title?: string;
  readonly payload?: {
    readonly url?: string;
    readonly coordinates?: { readonly lat?: number; readonly long?: number };
  };
}

/** One `entry[].messaging[]` event from a Messenger webhook payload. */
export interface MessengerWebhookEvent {
  readonly sender?: { readonly id?: string };
  readonly recipient?: { readonly id?: string };
  readonly timestamp?: number;
  readonly message?: {
    readonly mid?: string;
    readonly text?: string;
    readonly is_echo?: boolean;
    readonly attachments?: readonly MessengerWebhookAttachment[];
  };
  readonly postback?: { readonly mid?: string; readonly title?: string; readonly payload?: string };
  readonly delivery?: unknown;
  readonly read?: unknown;
}

export interface MessengerRequestMetadata {
  readonly user: { readonly id: string };
  readonly page?: { readonly id: string };
  readonly message: { readonly id?: string; readonly timestamp?: number };
  readonly attachmentTypes: readonly string[];
  readonly trigger: "message" | "postback" | "proactive";
}

export interface AgentRequest extends AgentRequestBase {
  readonly conversationId: string;
  readonly userId: string;
  readonly messageId?: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
  readonly metadata: {
    readonly messenger: MessengerRequestMetadata;
    readonly [key: string]: unknown;
  };
}

export type { AgentResponse };
export type AgentResponder = SharedAgentResponder<AgentRequest, AgentMessageStream, AgentResponse>;

export interface MessengerAdapterMessages {
  welcomeText?: string;
  helpText?: string;
  busyText?: string;
  unauthorizedText?: string;
  cancelledText?: string;
  errorText?: string;
  unsupportedText?: string;
}

export interface MessengerAdapterLogger extends MessengerMessageStreamLogger {
  info?(message: string, metadata?: Record<string, unknown>): void;
}

export interface MessengerAttachmentIngestOptions {
  readonly fetch?: typeof fetch;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface MessengerProactiveOptions {
  readonly messagingType: MessengerMessagingType;
  readonly tag?: string;
}

export interface MessengerAdapterOptions {
  readonly client: MessengerGraphClientLike;
  readonly responder: AgentResponder;
  readonly allowedUserIds?: readonly string[];
  readonly allowAllUsers?: boolean;
  readonly messages?: MessengerAdapterMessages;
  readonly logger?: MessengerAdapterLogger;
  readonly attachments?: MessengerAttachmentIngestOptions;
  readonly proactive?: MessengerProactiveOptions;
  /** Inbound messages queued per user while a turn runs; beyond it the user gets `busyText`. */
  readonly maxQueuedPerUser?: number;
  readonly maxMessageChars?: number;
}

export interface MessengerNotifyOptions {
  readonly verbatim?: boolean;
  readonly deliveryKey?: string;
  readonly steerActive?: boolean;
}

export interface MessengerNotifyResult extends NotifyDeliveryResult {
  readonly disposition?: ProcessJobWakeDisposition;
}

export type MessengerIgnoredReason =
  | "echo"
  | "receipt"
  | "no_sender"
  | "no_content"
  | "duplicate"
  | "empty_text";

export type MessengerEventResult =
  | { kind: "handled"; userId: string; messageId?: string; action: "command" | "responded"; command?: "start" | "help" }
  | { kind: "ignored"; reason: MessengerIgnoredReason; userId?: string; messageId?: string }
  | { kind: "unauthorized"; userId: string; messageId?: string }
  | { kind: "busy"; userId: string; messageId?: string }
  | { kind: "cancelled"; userId: string; messageId?: string }
  | { kind: "error"; userId?: string; messageId?: string; error: unknown };

const DEFAULT_MESSAGES: Required<MessengerAdapterMessages> = {
  welcomeText: "Hello! Send me a message and I will pass it to the configured agent.",
  helpText: "Send a message to talk to the agent. Use /cancel to stop the current response.",
  busyText: "I am still working on your previous messages. Use /cancel to stop.",
  unauthorizedText: "This Messenger account is not authorized to use this bot.",
  cancelledText: "Cancelled.",
  errorText: "The agent failed while processing your message.",
  unsupportedText: "I can only handle text, images, and documents here for now.",
};

const DEFAULT_MAX_QUEUED_PER_USER = 4;
const DEDUP_MAX_SIZE = 512;
const ATTACHMENT_TIMEOUT_MS = 30_000;
const PROCESS_JOB_WAKE_DELIVERY_METADATA = Symbol.for("mono-agent.process-job-wake.delivery-key.v1");

interface ActiveRun {
  readonly controller: AbortController;
}

interface NormalizedInbound {
  readonly userId: string;
  readonly pageId: string | undefined;
  readonly messageId: string | undefined;
  readonly timestamp: number | undefined;
  readonly text: string;
  readonly attachments: readonly AgentAttachment[];
  readonly attachmentTypes: readonly string[];
  readonly trigger: "message" | "postback";
}

/** Bounded insertion-ordered set of seen message ids. */
class MessageDeduplicator {
  private readonly seen = new Set<string>();

  constructor(private readonly maxSize = DEDUP_MAX_SIZE) {}

  isDuplicate(key: string): boolean {
    if (this.seen.has(key)) {
      return true;
    }
    this.seen.add(key);
    if (this.seen.size > this.maxSize) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    return false;
  }
}

export class MessengerAdapter {
  private readonly client: MessengerGraphClientLike;
  private readonly responder: AgentResponder;
  private readonly allowAllUsers: boolean;
  private readonly allowedUserIds: Set<string>;
  private readonly messages: Required<MessengerAdapterMessages>;
  private readonly logger: MessengerAdapterLogger | undefined;
  private readonly ingest: Required<MessengerAttachmentIngestOptions>;
  private readonly proactive: MessengerProactiveOptions;
  private readonly maxQueuedPerUser: number;
  private readonly maxMessageChars: number;
  private readonly dedup = new MessageDeduplicator();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly queueTails = new Map<string, Promise<unknown>>();
  private readonly queued = new Map<string, number>();
  private stopping = false;

  constructor(options: MessengerAdapterOptions) {
    this.client = options.client;
    this.responder = options.responder;
    this.allowAllUsers = options.allowAllUsers === true;
    this.allowedUserIds = new Set((options.allowedUserIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
    this.messages = { ...DEFAULT_MESSAGES, ...options.messages };
    this.logger = options.logger;
    this.ingest = {
      fetch: options.attachments?.fetch ?? fetch,
      maxBytes: options.attachments?.maxBytes ?? DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
      timeoutMs: options.attachments?.timeoutMs ?? ATTACHMENT_TIMEOUT_MS,
    };
    this.proactive = options.proactive ?? { messagingType: "RESPONSE" };
    this.maxQueuedPerUser = options.maxQueuedPerUser ?? DEFAULT_MAX_QUEUED_PER_USER;
    this.maxMessageChars = options.maxMessageChars ?? MESSENGER_MAX_MESSAGE_CHARS;
    if (!this.allowAllUsers && this.allowedUserIds.size === 0) {
      throw new TypeError("MessengerAdapter requires allowedUserIds or allowAllUsers: true.");
    }
  }

  /** Process one full webhook payload (`{ object: "page", entry: [...] }`). */
  async handleWebhookPayload(payload: unknown): Promise<MessengerEventResult[]> {
    const results: MessengerEventResult[] = [];
    if (!isRecord(payload) || payload.object !== "page" || !Array.isArray(payload.entry)) {
      this.logger?.debug?.("Ignoring non-page Messenger webhook payload.");
      return results;
    }
    for (const entry of payload.entry) {
      if (!isRecord(entry) || !Array.isArray(entry.messaging)) {
        continue;
      }
      for (const event of entry.messaging) {
        if (!isRecord(event)) {
          continue;
        }
        try {
          results.push(await this.handleEvent(event as MessengerWebhookEvent));
        } catch (error) {
          this.logger?.error?.("Messenger webhook event failed.", { error: errorMessage(error) });
          results.push({ kind: "error", error });
        }
      }
    }
    return results;
  }

  async handleEvent(event: MessengerWebhookEvent): Promise<MessengerEventResult> {
    if (this.stopping) {
      return { kind: "error", error: new AgentResponseCancelledError("Messenger adapter is stopping.") };
    }
    if (event.message?.is_echo === true) {
      return { kind: "ignored", reason: "echo" };
    }
    if (event.delivery !== undefined || event.read !== undefined) {
      return { kind: "ignored", reason: "receipt" };
    }
    const userId = normalizeId(event.sender?.id);
    if (userId === undefined) {
      return { kind: "ignored", reason: "no_sender" };
    }
    if (event.message === undefined && event.postback === undefined) {
      return { kind: "ignored", reason: "no_content", userId };
    }
    const messageId = normalizeId(event.message?.mid ?? event.postback?.mid);
    const dedupKey = messageId ?? `${userId}:${event.timestamp ?? ""}:${event.postback?.payload ?? event.postback?.title ?? ""}`;
    if (this.dedup.isDuplicate(dedupKey)) {
      return withMessageId({ kind: "ignored", reason: "duplicate", userId }, messageId);
    }
    if (!this.isAuthorized(userId)) {
      this.logger?.warn?.("Messenger message from unauthorized user dropped.", { userId });
      await this.sendTextSafely(userId, this.messages.unauthorizedText);
      return withMessageId({ kind: "unauthorized", userId }, messageId);
    }

    const inbound = await this.normalizeInbound(userId, event, messageId);
    const command = parseCommand(inbound.text);
    if (command === "start") {
      await this.sendTextSafely(userId, this.messages.welcomeText);
      return withMessageId({ kind: "handled", userId, action: "command", command: "start" }, messageId);
    }
    if (command === "help") {
      await this.sendTextSafely(userId, this.messages.helpText);
      return withMessageId({ kind: "handled", userId, action: "command", command: "help" }, messageId);
    }
    if (command === "cancel") {
      const reason = createChannelUserCancelReason("Messenger");
      this.responder.cancel?.(messengerConversationId(userId), reason);
      this.activeRuns.get(userId)?.controller.abort(reason);
      await this.sendTextSafely(userId, this.messages.cancelledText);
      return withMessageId({ kind: "cancelled", userId }, messageId);
    }
    if (inbound.text.length === 0 && inbound.attachments.length === 0) {
      await this.sendTextSafely(userId, this.messages.unsupportedText);
      return withMessageId({ kind: "ignored", reason: "empty_text", userId }, messageId);
    }
    if ((this.queued.get(userId) ?? 0) >= this.maxQueuedPerUser) {
      await this.sendTextSafely(userId, this.messages.busyText);
      return withMessageId({ kind: "busy", userId }, messageId);
    }
    void this.client.senderAction(userId, "mark_seen").catch(() => undefined);
    return await this.enqueue(userId, () => this.respondToInbound(inbound));
  }

  /** Stop accepting work and abort every active turn. */
  stop(reason: unknown = new AgentResponseCancelledError("Messenger adapter stopped.")): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    for (const active of this.activeRuns.values()) {
      active.controller.abort(reason);
    }
  }

  /**
   * Proactive delivery. With `verbatim`, `text` is posted unchanged (no model
   * call) and recorded to history; otherwise it runs as a turn for the user and
   * the answer is delivered. Enforces the adapter allowlist.
   */
  async notify(userId: string, text: string, options?: MessengerNotifyOptions): Promise<MessengerNotifyResult> {
    if (this.stopping) {
      return { delivered: false, reason: "adapter stopped", retryable: true };
    }
    if (!this.isAuthorized(userId)) {
      return { delivered: false, reason: "messenger user is not in the adapter allowlist", retryable: false };
    }
    if (options?.verbatim === true) {
      return await this.enqueue(userId, () => this.deliverVerbatim(userId, text, options.deliveryKey));
    }
    if (options?.steerActive === true && options.deliveryKey !== undefined && this.responder.offerLiveInput !== undefined) {
      let offer: AgentLiveInputOffer | undefined;
      try {
        offer = this.responder.offerLiveInput({
          conversationId: messengerConversationId(userId),
          id: options.deliveryKey,
          text,
          receivedAt: new Date().toISOString(),
          deliveryKey: options.deliveryKey,
        });
      } catch (error) {
        this.logger?.debug?.("Messenger steering failed; running a follow-up turn.", { error: errorMessage(error) });
      }
      if (offer?.status === "accepted") {
        try {
          const settlement = await offer.settled;
          if (settlement.status === "applied") {
            return { delivered: true, code: "delivered", channelId: MESSENGER_CHANNEL_ID, historyRecorded: true, disposition: "steered" };
          }
        } catch {
          // Fall through to the follow-up turn.
        }
      }
    }
    return await this.enqueue(userId, () => this.runProactiveTurn(userId, text, options?.deliveryKey));
  }

  async updateProcessJob(userId: string, projection: ProcessJobProjection): Promise<NotifyDeliveryResult> {
    if (this.stopping) {
      return { delivered: false, reason: "adapter stopped", retryable: true };
    }
    if (!this.isAuthorized(userId)) {
      return { delivered: false, reason: "messenger user is not in the adapter allowlist", retryable: false };
    }
    const status = projection.state.replaceAll("_", " ");
    const sent = await this.client.sendText(userId, `Background job ${projection.jobId}: ${status}.`, this.proactiveSend());
    const deliveryId = sent.messageIds.at(-1);
    return { delivered: true, code: "delivered", channelId: MESSENGER_CHANNEL_ID, ...(deliveryId === undefined ? {} : { deliveryId }) };
  }

  private async enqueue<T extends MessengerEventResult | MessengerNotifyResult>(userId: string, task: () => Promise<T>): Promise<T> {
    this.queued.set(userId, (this.queued.get(userId) ?? 0) + 1);
    const previous = this.queueTails.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.queueTails.set(userId, current);
    try {
      return await current;
    } finally {
      const remaining = (this.queued.get(userId) ?? 1) - 1;
      if (remaining <= 0) {
        this.queued.delete(userId);
      } else {
        this.queued.set(userId, remaining);
      }
      if (this.queueTails.get(userId) === current) {
        this.queueTails.delete(userId);
      }
    }
  }

  private async respondToInbound(inbound: NormalizedInbound): Promise<MessengerEventResult> {
    const { userId, messageId } = inbound;
    if (this.stopping) {
      return withMessageId({ kind: "cancelled", userId }, messageId);
    }
    const controller = new AbortController();
    this.activeRuns.set(userId, { controller });
    const stream = this.createStream(userId, undefined);
    void this.client.senderAction(userId, "typing_on").catch(() => undefined);
    try {
      const metadata: MessengerRequestMetadata = {
        user: { id: userId },
        ...(inbound.pageId === undefined ? {} : { page: { id: inbound.pageId } }),
        message: {
          ...(messageId === undefined ? {} : { id: messageId }),
          ...(inbound.timestamp === undefined ? {} : { timestamp: inbound.timestamp }),
        },
        attachmentTypes: inbound.attachmentTypes,
        trigger: inbound.trigger,
      };
      const conversationId = messengerConversationId(userId);
      const request: AgentRequest = {
        conversationId,
        replyTo: { conversationId },
        userId,
        ...(messageId === undefined ? {} : { messageId }),
        text: inbound.text,
        abortSignal: controller.signal,
        sender: { id: userId },
        surface: { kind: "dm", id: userId, messageBudget: { maxChars: this.maxMessageChars, overflow: "follow_up" } },
        ...(inbound.attachments.length === 0 ? {} : { attachments: inbound.attachments }),
        metadata: { messenger: metadata },
      };
      const response = await this.responder.respond(request, stream);
      if (controller.signal.aborted) {
        await this.finishCancelledUnlessAcknowledged(stream, controller.signal);
        return withMessageId({ kind: "cancelled", userId }, messageId);
      }
      await stream.finish(response.text, response.parts === undefined ? undefined : { parts: response.parts });
      return withMessageId({ kind: "handled", userId, action: "responded" }, messageId);
    } catch (error) {
      if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
        await this.finishCancelledUnlessAcknowledged(stream, controller.signal, error);
        return withMessageId({ kind: "cancelled", userId }, messageId);
      }
      this.logger?.error?.("Messenger adapter responder failed.", { error: errorMessage(error) });
      await this.finishSafely(stream, this.messages.errorText);
      return withMessageId({ kind: "error", userId, error }, messageId);
    } finally {
      void this.client.senderAction(userId, "typing_off").catch(() => undefined);
      if (this.activeRuns.get(userId)?.controller === controller) {
        this.activeRuns.delete(userId);
      }
    }
  }

  private async runProactiveTurn(userId: string, text: string, deliveryKey?: string): Promise<MessengerNotifyResult> {
    if (this.stopping) {
      return { delivered: false, reason: "adapter stopped", retryable: true };
    }
    const controller = new AbortController();
    this.activeRuns.set(userId, { controller });
    const stream = this.createStream(userId, this.proactiveSend());
    try {
      const conversationId = messengerConversationId(userId);
      const metadata: AgentRequest["metadata"] = {
        messenger: { user: { id: userId }, message: {}, attachmentTypes: [], trigger: "proactive" },
        ...(deliveryKey === undefined ? {} : { [PROCESS_JOB_WAKE_DELIVERY_METADATA]: deliveryKey }),
      };
      const response = await this.responder.respond({
        conversationId,
        replyTo: { conversationId },
        userId,
        text,
        abortSignal: controller.signal,
        surface: { kind: "dm", id: userId, messageBudget: { maxChars: this.maxMessageChars, overflow: "follow_up" } },
        metadata,
      }, stream);
      await stream.finish(response.text, response.parts === undefined ? undefined : { parts: response.parts });
      return { delivered: true, code: "delivered", channelId: MESSENGER_CHANNEL_ID, historyRecorded: true, disposition: "follow_up" };
    } catch (error) {
      if (!controller.signal.aborted && !isAgentResponseCancelledError(error)) {
        await this.finishSafely(stream, this.messages.errorText);
      }
      return { delivered: false, code: "process_job_wake_failed", reason: errorMessage(error), retryable: false };
    } finally {
      if (this.activeRuns.get(userId)?.controller === controller) {
        this.activeRuns.delete(userId);
      }
    }
  }

  private async deliverVerbatim(userId: string, text: string, deliveryKey?: string): Promise<MessengerNotifyResult> {
    if (this.stopping) {
      return { delivered: false, reason: "adapter stopped", retryable: true };
    }
    const normalized = normalizeTrailing(text, "");
    if (normalized.length === 0) {
      return { delivered: false, reason: "empty notification", retryable: false };
    }
    let deliveryId: string | undefined;
    try {
      const sent = await this.client.sendText(userId, stripMarkdownForMessenger(normalized), this.proactiveSend());
      deliveryId = sent.messageIds.at(-1);
    } catch (error) {
      this.logger?.error?.("Messenger verbatim notify delivery failed.", { error: errorMessage(error) });
      return { delivered: false, reason: "delivery failed", retryable: false, ambiguous: true };
    }
    let historyRecorded = false;
    try {
      await this.responder.deliverVerbatim?.(
        messengerConversationId(userId),
        normalized,
        deliveryKey === undefined ? undefined : { idempotencyKey: deliveryKey },
      );
      historyRecorded = this.responder.deliverVerbatim !== undefined;
    } catch (error) {
      this.logger?.warn?.("Messenger verbatim notify history record failed.", { error: errorMessage(error) });
    }
    return {
      delivered: true,
      code: "delivered",
      channelId: MESSENGER_CHANNEL_ID,
      historyRecorded,
      ...(deliveryId === undefined ? {} : { deliveryId }),
    };
  }

  private async normalizeInbound(userId: string, event: MessengerWebhookEvent, messageId: string | undefined): Promise<NormalizedInbound> {
    const parts: string[] = [];
    const attachments: AgentAttachment[] = [];
    const attachmentTypes: string[] = [];
    const message = event.message;
    const postback = event.postback;
    if (typeof message?.text === "string" && message.text.trim().length > 0) {
      parts.push(message.text.trim());
    }
    if (postback !== undefined) {
      const payload = postback.payload?.trim() ?? "";
      const title = postback.title?.trim() ?? "";
      parts.push(payload.length > 0 ? payload : title.length > 0 ? title : "[postback]");
    }
    for (const attachment of message?.attachments ?? []) {
      const kind = (attachment.type ?? "file").toLowerCase();
      attachmentTypes.push(kind);
      if (kind === "location") {
        const coordinates = attachment.payload?.coordinates;
        parts.push(`[location: ${attachment.title ?? "location"} ${coordinates?.lat ?? "?"},${coordinates?.long ?? "?"}]`);
        continue;
      }
      const url = attachment.payload?.url?.trim();
      if (url === undefined || url.length === 0) {
        parts.push(`[${kind} attachment]`);
        continue;
      }
      const ingested = kind === "image" || kind === "file" ? await this.downloadAttachment(url, kind) : undefined;
      if (ingested !== undefined) {
        attachments.push(ingested);
        parts.push(`[${kind} attachment: ${ingested.name ?? kind}]`);
      } else {
        parts.push(`[${kind} attachment: ${url}]`);
      }
    }
    return {
      userId,
      pageId: normalizeId(event.recipient?.id),
      messageId,
      timestamp: typeof event.timestamp === "number" ? event.timestamp : undefined,
      text: parts.join("\n").trim(),
      attachments,
      attachmentTypes,
      trigger: postback !== undefined && message === undefined ? "postback" : "message",
    };
  }

  private async downloadAttachment(url: string, kind: "image" | "file"): Promise<AgentAttachment | undefined> {
    if (!isSafeAttachmentUrl(url)) {
      this.logger?.warn?.("Blocked unsafe Messenger attachment URL.", { url: safeUrlForLog(url) });
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.ingest.timeoutMs);
    try {
      const response = await this.ingest.fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) {
        this.logger?.warn?.("Messenger attachment download failed.", { url: safeUrlForLog(url), status: response.status });
        return undefined;
      }
      const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > this.ingest.maxBytes) {
        this.logger?.warn?.("Messenger attachment exceeds the size cap.", { url: safeUrlForLog(url), bytes: declared });
        return undefined;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.ingest.maxBytes) {
        this.logger?.warn?.("Messenger attachment exceeds the size cap.", { url: safeUrlForLog(url), bytes: bytes.byteLength });
        return undefined;
      }
      const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
      const name = fileNameFromUrl(url, kind, mimeType);
      if (kind === "image" || mimeType.startsWith("image/")) {
        return { kind: "image", mimeType: mimeType.length > 0 ? mimeType : "image/jpeg", data: Buffer.from(bytes).toString("base64"), name, sizeBytes: bytes.byteLength };
      }
      const isText = mimeType.startsWith("text/") || mimeType === "application/json";
      if (mimeType === "application/pdf" || isText) {
        return {
          kind: "document",
          mimeType,
          data: Buffer.from(bytes).toString("base64"),
          name,
          sizeBytes: bytes.byteLength,
          ...(isText ? { text: Buffer.from(bytes).toString("utf8") } : {}),
        };
      }
      return undefined;
    } catch (error) {
      this.logger?.warn?.("Messenger attachment download failed.", { url: safeUrlForLog(url), error: errorMessage(error) });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private createStream(userId: string, send: MessengerSendOptions | undefined): MessengerMessageStream {
    return new MessengerMessageStream({
      client: this.client,
      recipientId: userId,
      maxMessageChars: this.maxMessageChars,
      ...(send === undefined ? {} : { send }),
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    });
  }

  private proactiveSend(): MessengerSendOptions {
    return {
      messagingType: this.proactive.messagingType,
      ...(this.proactive.tag === undefined ? {} : { tag: this.proactive.tag }),
    };
  }

  private isAuthorized(userId: string): boolean {
    return this.allowAllUsers || this.allowedUserIds.has(userId);
  }

  private async finishCancelledUnlessAcknowledged(stream: MessengerMessageStream, signal: AbortSignal, error?: unknown): Promise<void> {
    const acknowledged = isChannelUserCancelReason(signal.reason)
      || (isAgentResponseCancelledError(error) && isChannelUserCancelReason(error.reason));
    if (!acknowledged) {
      await this.finishSafely(stream, this.messages.cancelledText);
    }
  }

  private async finishSafely(stream: MessengerMessageStream, text: string): Promise<void> {
    try {
      await stream.finish(text);
    } catch (error) {
      this.logger?.error?.("Failed to send Messenger terminal message.", { error: errorMessage(error) });
    }
  }

  private async sendTextSafely(userId: string, text: string): Promise<void> {
    try {
      await this.client.sendText(userId, normalizeTrailing(text, DEFAULT_EMPTY_FINAL_TEXT));
    } catch (error) {
      this.logger?.error?.("Messenger send failed.", { error: errorMessage(error) });
    }
  }
}

function parseCommand(text: string): "start" | "help" | "cancel" | undefined {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:\s|$)/u);
  const name = match?.[1]?.toLowerCase();
  return name === "start" || name === "help" || name === "cancel" ? name : undefined;
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withMessageId<T extends object>(result: T, messageId: string | undefined): T {
  if (messageId !== undefined) {
    (result as T & { messageId: string }).messageId = messageId;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only fetch https URLs on public hostnames; Meta serves media from its CDN. */
export function isSafeAttachmentUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  if (/^\[?[0-9a-f:]+\]?$/u.test(host) && host.includes(":")) {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) {
    return false;
  }
  return true;
}

function safeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

function fileNameFromUrl(url: string, kind: string, mimeType: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter((segment) => segment.length > 0).at(-1);
    if (last !== undefined && /^[\w.-]{1,120}$/u.test(last) && last.includes(".")) {
      return last;
    }
  } catch {
    // Fall through to a synthesized name.
  }
  const extension = mimeType === "image/png" ? ".png"
    : mimeType === "image/gif" ? ".gif"
    : mimeType === "image/webp" ? ".webp"
    : mimeType.startsWith("image/") ? ".jpg"
    : mimeType === "application/pdf" ? ".pdf"
    : mimeType.startsWith("text/") ? ".txt"
    : "";
  return `messenger-${kind}${extension}`;
}
