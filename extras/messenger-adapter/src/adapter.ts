import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
import { isMessengerAmbiguousDeliveryError } from "./graph-client.js";
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
  /**
   * Explicit host policy for attachment downloads. Only hostnames equal to, or
   * a subdomain of, one of these suffixes are contacted. Defaults to Meta's
   * media CDNs ({@link DEFAULT_MESSENGER_ATTACHMENT_HOST_SUFFIXES}) — the only
   * origin a Messenger webhook legitimately points at. Pass `[]` to disable
   * attachment downloads entirely.
   */
  readonly allowedHostSuffixes?: readonly string[];
  /** Resolves a hostname to IP addresses. Test seam; defaults to the system resolver. */
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
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
/**
 * Meta's media CDNs. Messenger attachment payload URLs are signed links into
 * these origins, so an explicit allowlist — rather than "any public-looking
 * HTTPS host" — is what actually bounds this downloader.
 */
export const DEFAULT_MESSENGER_ATTACHMENT_HOST_SUFFIXES: readonly string[] = [
  "fbcdn.net",
  "fbsbx.com",
];
/** Redirect hops followed before a download is abandoned. */
const MAX_ATTACHMENT_REDIRECTS = 3;
const PROCESS_JOB_WAKE_DELIVERY_METADATA = Symbol.for("mono-agent.process-job-wake.delivery-key.v1");

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

/** How a reserved wake slot should settle once the live-input offer resolves. */
type WakeDecision = "run" | "steered" | "discarded" | "uncertain";

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
  /**
   * Every controller admitted for a user, registered BEFORE the work reaches
   * the per-user queue. Registering eagerly is what lets `/cancel` retire a
   * prompt that is still parked behind an earlier run — a controller created
   * only at execution time would not exist yet.
   */
  private readonly pendingControllers = new Map<string, Set<AbortController>>();
  private readonly queueTails = new Map<string, Promise<unknown>>();
  /** Admitted work per user: at most one active turn plus `maxQueuedPerUser` waiting. */
  private readonly admitted = new Map<string, number>();
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
      allowedHostSuffixes: normalizeHostSuffixes(
        options.attachments?.allowedHostSuffixes ?? DEFAULT_MESSENGER_ATTACHMENT_HOST_SUFFIXES,
      ),
      resolveAddresses: options.attachments?.resolveAddresses ?? resolveHostAddresses,
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
      // Clear the harness's queued follow-ups first, then abort every
      // controller admitted so far — the active turn AND anything parked
      // behind it, which would otherwise run and answer after the user asked
      // to stop. `/cancel` stays out-of-band (it never enters the queue), and
      // a prompt admitted after this point gets a fresh controller and runs.
      this.responder.cancel?.(messengerConversationId(userId), reason);
      this.cancelPending(userId, reason);
      await this.sendTextSafely(userId, this.messages.cancelledText);
      return withMessageId({ kind: "cancelled", userId }, messageId);
    }
    if (inbound.text.length === 0 && inbound.attachments.length === 0) {
      await this.sendTextSafely(userId, this.messages.unsupportedText);
      return withMessageId({ kind: "ignored", reason: "empty_text", userId }, messageId);
    }
    // One active turn plus `maxQueuedPerUser` waiting behind it.
    if ((this.admitted.get(userId) ?? 0) > this.maxQueuedPerUser) {
      await this.sendTextSafely(userId, this.messages.busyText);
      return withMessageId({ kind: "busy", userId }, messageId);
    }
    void this.client.senderAction(userId, "mark_seen").catch(() => undefined);
    const controller = this.registerController(userId);
    return await this.admit(userId, () => this.respondToInbound(inbound, controller));
  }

  /** Stop accepting work and abort every active turn. */
  stop(reason: unknown = new AgentResponseCancelledError("Messenger adapter stopped.")): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    for (const controllers of this.pendingControllers.values()) {
      for (const controller of controllers) {
        controller.abort(reason);
      }
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
      return await this.admit(userId, () => this.deliverVerbatim(userId, text, options.deliveryKey));
    }
    const offerLiveInput = this.responder.offerLiveInput;
    if (options?.steerActive === true && options.deliveryKey !== undefined && offerLiveInput !== undefined) {
      return await this.steerOrRunReserved(userId, text, options.deliveryKey, offerLiveInput.bind(this.responder));
    }
    const controller = this.registerController(userId);
    return await this.admit(userId, () => this.runProactiveTurn(userId, text, controller, options?.deliveryKey));
  }

  /**
   * Offer a wake to the active turn, having RESERVED this user's queue slot
   * first.
   *
   * The `AgentLiveInputOffer` contract requires an accepted offer to stay
   * represented by its reserved normal-turn slot until `settled` says whether
   * that reservation runs or becomes a no-op. Offering first and enqueueing
   * only afterwards lets a prompt that arrives during the offer overtake the
   * wake; reserving first keeps arrival order. Every settlement path —
   * accepted/applied, requeue, discard, uncertain, unavailable, and a throwing
   * offer — resolves the reservation exactly once.
   */
  private async steerOrRunReserved(
    userId: string,
    text: string,
    deliveryKey: string,
    offerLiveInput: (request: Parameters<NonNullable<AgentResponder["offerLiveInput"]>>[0]) => AgentLiveInputOffer,
  ): Promise<MessengerNotifyResult> {
    const controller = this.registerController(userId);
    const decision = createDeferred<WakeDecision>();
    const reserved = this.admit(userId, async (): Promise<MessengerNotifyResult> => {
      const next = await decision.promise;
      if (next === "run") {
        return await this.runProactiveTurn(userId, text, controller, deliveryKey);
      }
      // The slot is not going to run a turn; release its controller now.
      this.unregisterController(userId, controller);
      if (next === "steered") {
        return {
          delivered: true,
          code: "delivered",
          channelId: MESSENGER_CHANNEL_ID,
          historyRecorded: true,
          disposition: "steered",
        };
      }
      if (next === "discarded") {
        return {
          delivered: false,
          code: "process_job_wake_discarded",
          reason: "The active turn was cancelled before the wake was applied.",
          retryable: false,
        };
      }
      return {
        delivered: false,
        code: "delivery_uncertain",
        reason: "Live-input delivery is uncertain and was not retried.",
        retryable: false,
        ambiguous: true,
        channelId: MESSENGER_CHANNEL_ID,
      };
    });
    let offer: AgentLiveInputOffer;
    try {
      offer = offerLiveInput({
        conversationId: messengerConversationId(userId),
        id: deliveryKey,
        text,
        receivedAt: new Date().toISOString(),
        deliveryKey,
      });
    } catch (error) {
      this.logger?.debug?.("Messenger steering failed; running the reserved fallback turn.", {
        error: errorMessage(error),
      });
      decision.resolve("run");
      return await reserved;
    }
    if (offer.status === "accepted") {
      void offer.settled.then(
        (settlement) => decision.resolve(
          settlement.status === "applied"
            ? "steered"
            : settlement.status === "requeue"
              ? "run"
              : settlement.status === "discarded"
                ? "discarded"
                : "uncertain",
        ),
        () => decision.resolve("uncertain"),
      );
    } else {
      decision.resolve("run");
    }
    return await reserved;
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

  /** Create and register a controller for a user BEFORE the work is admitted. */
  private registerController(userId: string): AbortController {
    const controller = new AbortController();
    const controllers = this.pendingControllers.get(userId);
    if (controllers === undefined) {
      this.pendingControllers.set(userId, new Set([controller]));
    } else {
      controllers.add(controller);
    }
    return controller;
  }

  private unregisterController(userId: string, controller: AbortController): void {
    const controllers = this.pendingControllers.get(userId);
    if (controllers === undefined) {
      return;
    }
    controllers.delete(controller);
    if (controllers.size === 0) {
      this.pendingControllers.delete(userId);
    }
  }

  /** Abort every controller currently admitted for a user (active and parked). */
  private cancelPending(userId: string, reason: unknown): void {
    for (const controller of this.pendingControllers.get(userId) ?? []) {
      controller.abort(reason);
    }
  }

  /** Append work to a user's serial queue, tracking admitted depth for the busy cap. */
  private async admit<T extends MessengerEventResult | MessengerNotifyResult>(userId: string, task: () => Promise<T>): Promise<T> {
    this.admitted.set(userId, (this.admitted.get(userId) ?? 0) + 1);
    const previous = this.queueTails.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.queueTails.set(userId, current);
    try {
      return await current;
    } finally {
      const remaining = (this.admitted.get(userId) ?? 1) - 1;
      if (remaining <= 0) {
        this.admitted.delete(userId);
      } else {
        this.admitted.set(userId, remaining);
      }
      if (this.queueTails.get(userId) === current) {
        this.queueTails.delete(userId);
      }
    }
  }

  private async respondToInbound(inbound: NormalizedInbound, controller: AbortController): Promise<MessengerEventResult> {
    const { userId, messageId } = inbound;
    // The turn may have been parked behind an earlier run while `/cancel` (or
    // `stop()`) aborted it. Retire it as a no-op instead of answering a prompt
    // the user already withdrew.
    if (this.stopping || controller.signal.aborted) {
      this.unregisterController(userId, controller);
      return withMessageId({ kind: "cancelled", userId }, messageId);
    }
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
      this.unregisterController(userId, controller);
    }
  }

  private async runProactiveTurn(
    userId: string,
    text: string,
    controller: AbortController,
    deliveryKey?: string,
  ): Promise<MessengerNotifyResult> {
    if (this.stopping || controller.signal.aborted) {
      this.unregisterController(userId, controller);
      return { delivered: false, reason: "adapter stopped", retryable: true };
    }
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
      this.unregisterController(userId, controller);
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
      // Only an unknown-outcome send is ambiguous. A clean rejection (auth,
      // policy, a 4xx) definitively did not deliver, and saying so lets the
      // host distinguish "never sent" from "may already be posted".
      if (isMessengerAmbiguousDeliveryError(error)) {
        return {
          delivered: false,
          code: "delivery_uncertain",
          reason: "The Messenger send outcome is unknown and was not retried.",
          retryable: false,
          ambiguous: true,
          channelId: MESSENGER_CHANNEL_ID,
        };
      }
      return { delivered: false, code: "delivery_failed", reason: "delivery failed", retryable: false };
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

  /**
   * Fetch one attachment under an explicit host policy.
   *
   * Redirects are followed MANUALLY so every hop is re-validated: the original
   * URL being a signed Meta link says nothing about where a `Location` header
   * points. Each hop must satisfy the host allowlist AND resolve entirely to
   * public addresses, so neither an open redirect nor a hostname whose DNS
   * answer is loopback/private/link-local can reach internal resources. The
   * body is then read incrementally against the size cap, so a chunked
   * response with an absent or lying `Content-Length` cannot exhaust memory.
   */
  private async downloadAttachment(url: string, kind: "image" | "file"): Promise<AgentAttachment | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.ingest.timeoutMs);
    try {
      let current = url;
      let response: Response | undefined;
      for (let hop = 0; ; hop += 1) {
        const rejection = await this.attachmentUrlRejection(current);
        if (rejection !== undefined) {
          this.logger?.warn?.("Blocked unsafe Messenger attachment URL.", {
            url: safeUrlForLog(current),
            reason: rejection,
            ...(hop === 0 ? {} : { hop }),
          });
          return undefined;
        }
        const hopResponse = await this.ingest.fetch(current, { signal: controller.signal, redirect: "manual" });
        if (!isRedirectResponse(hopResponse)) {
          response = hopResponse;
          break;
        }
        const location = hopResponse.headers.get("location");
        await cancelBody(hopResponse);
        if (location === null || location.length === 0) {
          this.logger?.warn?.("Messenger attachment redirect had no location.", { url: safeUrlForLog(current) });
          return undefined;
        }
        if (hop >= MAX_ATTACHMENT_REDIRECTS) {
          this.logger?.warn?.("Messenger attachment exceeded the redirect cap.", { url: safeUrlForLog(current) });
          return undefined;
        }
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          this.logger?.warn?.("Messenger attachment redirect location was unparseable.", { url: safeUrlForLog(current) });
          return undefined;
        }
        current = next;
      }
      if (!response.ok) {
        this.logger?.warn?.("Messenger attachment download failed.", { url: safeUrlForLog(current), status: response.status });
        return undefined;
      }
      const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > this.ingest.maxBytes) {
        await cancelBody(response);
        this.logger?.warn?.("Messenger attachment exceeds the size cap.", { url: safeUrlForLog(current), bytes: declared });
        return undefined;
      }
      const bytes = await readBodyWithinCap(response, this.ingest.maxBytes);
      if (bytes === undefined) {
        this.logger?.warn?.("Messenger attachment exceeds the size cap.", {
          url: safeUrlForLog(current),
          maxBytes: this.ingest.maxBytes,
        });
        return undefined;
      }
      const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
      const name = fileNameFromUrl(current, kind, mimeType);
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

  /**
   * Full per-hop admission check: the static URL policy, then DNS resolution
   * with every returned address required to be public. Returns a short
   * rejection reason, or `undefined` when the hop may be fetched.
   */
  private async attachmentUrlRejection(url: string): Promise<string | undefined> {
    const policyRejection = attachmentUrlPolicyRejection(url, this.ingest.allowedHostSuffixes);
    if (policyRejection !== undefined) {
      return policyRejection;
    }
    const hostname = normalizeHostname(new URL(url).hostname);
    let addresses: readonly string[];
    try {
      addresses = await this.ingest.resolveAddresses(hostname);
    } catch {
      return "dns_resolution_failed";
    }
    if (addresses.length === 0) {
      return "dns_no_addresses";
    }
    // Every answer must be public: one private record is enough to make the
    // fetch a rebinding vector, since we do not control which one is dialled.
    return addresses.every((address) => isPublicUnicastAddress(address)) ? undefined : "non_public_address";
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

/**
 * Static URL policy for an attachment download: HTTPS, no embedded
 * credentials, no literal IP host, and a hostname inside the configured
 * allowlist. Returns a short rejection reason, or `undefined` when the URL
 * passes. Address resolution is a separate, asynchronous check —
 * see {@link MessengerAdapter.attachmentUrlRejection}.
 */
export function attachmentUrlPolicyRejection(
  url: string,
  allowedHostSuffixes: readonly string[] = DEFAULT_MESSENGER_ATTACHMENT_HOST_SUFFIXES,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unparseable_url";
  }
  if (parsed.protocol !== "https:") {
    return "not_https";
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return "embedded_credentials";
  }
  const host = normalizeHostname(parsed.hostname);
  if (host.length === 0) {
    return "empty_host";
  }
  // A literal address bypasses the name-based allowlist entirely, so it is
  // never acceptable here regardless of which address it is.
  if (isIP(host) !== 0) {
    return "ip_literal_host";
  }
  if (!hostMatchesSuffixes(host, allowedHostSuffixes)) {
    return "host_not_allowed";
  }
  return undefined;
}

/** Only fetch https URLs on allowlisted Meta CDN hostnames. */
export function isSafeAttachmentUrl(
  url: string,
  allowedHostSuffixes: readonly string[] = DEFAULT_MESSENGER_ATTACHMENT_HOST_SUFFIXES,
): boolean {
  return attachmentUrlPolicyRejection(url, allowedHostSuffixes) === undefined;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  const unbracketed = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  // A trailing dot names the same host but would defeat suffix matching.
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

function normalizeHostSuffixes(suffixes: readonly string[]): readonly string[] {
  return suffixes
    .map((suffix) => normalizeHostname(suffix))
    .filter((suffix) => suffix.length > 0);
}

function hostMatchesSuffixes(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

async function resolveHostAddresses(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

/** Release a response body we are not going to read, ignoring teardown races. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed or unsupported by an injected fake; nothing to release.
  }
}

/**
 * Read a response body incrementally, stopping and cancelling the stream the
 * moment it exceeds `maxBytes`. Returns `undefined` when over the cap, so an
 * absent or dishonest `Content-Length` cannot buffer an unbounded body.
 */
async function readBodyWithinCap(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const body = response.body;
  if (body === null || body === undefined) {
    // No stream to meter (empty body, or an injected fake without one): fall
    // back to the buffered read, which is still bounded by the check below.
    const buffered = new Uint8Array(await response.arrayBuffer());
    return buffered.byteLength > maxBytes ? undefined : buffered;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader is already released when the stream errored or was cancelled.
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * True only for a globally routable unicast address. Everything else —
 * loopback, private, link-local, CGNAT, multicast, and the reserved/documentation
 * ranges — is rejected, so a hostname whose DNS answer points inside the
 * deployment cannot be fetched.
 */
export function isPublicUnicastAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isPublicIPv4(address);
  }
  if (version === 6) {
    return isPublicIPv6(address);
  }
  return false;
}

function isPublicIPv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0) return false; // 192.0.0/24 protocol assignments, 192.0.2/24 docs
  if (a === 192 && b === 88) return false; // 192.88.99/24 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18/15
  if (a === 198 && b === 51) return false; // 198.51.100/24 docs
  if (a === 203 && b === 0) return false; // 203.0.113/24 docs
  if (a >= 224) return false; // multicast and reserved, incl. broadcast
  return true;
}

function isPublicIPv6(address: string): boolean {
  const bytes = parseIPv6(address);
  if (bytes === undefined) {
    return false;
  }
  // IPv4-mapped/compatible: classify by the embedded IPv4 address.
  const isV4Mapped = bytes.slice(0, 10).every((byte) => byte === 0)
    && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0));
  if (isV4Mapped) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    // `::` and `::1` fall out of this as 0.0.0.0 / 0.0.0.1, both rejected.
    return isPublicIPv4(embedded);
  }
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if (first === 0xff) return false; // multicast
  if ((first & 0xfe) === 0xfc) return false; // unique local fc00::/7
  if (first === 0xfe && (second & 0xc0) === 0x80) return false; // link-local fe80::/10
  if (first === 0x20 && second === 0x01 && (bytes[2] ?? 0) === 0x0d && (bytes[3] ?? 0) === 0xb8) return false; // 2001:db8::/32
  if (first === 0x00 && second === 0x64 && (bytes[2] ?? 0) === 0xff && (bytes[3] ?? 0) === 0x9b) return false; // NAT64 64:ff9b::/96
  return true;
}

/** Expand an IPv6 literal (including `::` and a trailing IPv4 tail) to 16 bytes. */
function parseIPv6(address: string): number[] | undefined {
  const withoutZone = address.split("%", 1)[0] ?? address;
  const [head, tail, ...rest] = withoutZone.split("::");
  if (rest.length > 0 || head === undefined) {
    return undefined;
  }
  const expandGroups = (part: string): number[] | undefined => {
    if (part.length === 0) {
      return [];
    }
    const bytes: number[] = [];
    const groups = part.split(":");
    for (const [index, group] of groups.entries()) {
      if (group.includes(".")) {
        // Only a trailing IPv4 tail is legal.
        if (index !== groups.length - 1) {
          return undefined;
        }
        const octets = group.split(".").map((octet) => Number(octet));
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
          return undefined;
        }
        bytes.push(...octets);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/u.test(group)) {
        return undefined;
      }
      const value = Number.parseInt(group, 16);
      bytes.push((value >> 8) & 0xff, value & 0xff);
    }
    return bytes;
  };
  const headBytes = expandGroups(head);
  const tailBytes = tail === undefined ? [] : expandGroups(tail);
  if (headBytes === undefined || tailBytes === undefined) {
    return undefined;
  }
  if (tail === undefined) {
    return headBytes.length === 16 ? headBytes : undefined;
  }
  const fill = 16 - headBytes.length - tailBytes.length;
  if (fill < 0) {
    return undefined;
  }
  return [...headBytes, ...new Array<number>(fill).fill(0), ...tailBytes];
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
