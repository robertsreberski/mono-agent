import { readFile } from "node:fs/promises";

import {
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
  type AgentAttachment,
  type AgentStreamWireFrame,
} from "@mono-agent/agent-contracts";
import { EFFORT_LEVELS } from "@mono-agent/config";

import {
  WEB_API_VERSION,
  WEB_MAX_CONCURRENT_UPLOADS,
  WEB_MAX_ACTIVE_ATTACHMENT_TURN_BYTES,
  WEB_MAX_FILES_PER_TURN,
  WEB_MAX_STAGED_UPLOAD_BYTES,
  WEB_MAX_STAGED_UPLOADS,
  WEB_MAX_QUEUED_ATTACHMENT_TURNS,
  WEB_MAX_TURN_ATTACHMENT_BYTES,
  WEB_STAGED_UPLOAD_TTL_MS,
  type CreateWebUploadInput,
  type PatchWebAgentInput,
  type StartWebTurnInput,
  type WebAgentSummary,
  type WebAttachment,
  type WebBootstrap,
  type WebEvent,
  type WebEventType,
  type WebModelOption,
  type WebThread,
  type WebThreadDetail,
} from "./contracts.js";
import {
  discoverOperatorAgents,
  type DiscoverOperatorAgentsOptions,
  type DiscoveredOperatorAgent,
} from "./discovery.js";
import { errorCode, errorMessage, WebConsoleError } from "./errors.js";
import { OperatorClient, type OperatorInfo } from "./operator-client.js";
import { acquireWebStateLease, prepareWebStatePaths, type WebStateLease, type WebStatePathOptions } from "./state-paths.js";
import { toWebAttachment, WebStore, type StoredAttachment } from "./store.js";

const DEFAULT_DISCOVERY_INTERVAL_MS = 5_000;
const DEFAULT_PURGE_INTERVAL_MS = 60 * 60 * 1_000;
const INFO_TIMEOUT_MS = 2_500;

export interface WebServiceLogger {
  debug?(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  info?(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn?(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  error?(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export interface CreateWebServiceOptions extends WebStatePathOptions, DiscoverOperatorAgentsOptions {
  readonly fetchImpl?: typeof fetch;
  readonly logger?: WebServiceLogger;
  readonly clock?: () => Date;
  readonly discoveryIntervalMs?: number;
  readonly purgeIntervalMs?: number;
  readonly discoverImpl?: (options: DiscoverOperatorAgentsOptions) => Promise<readonly DiscoveredOperatorAgent[]>;
  /** Test/embedding override; production defaults to one 64 MiB weighted attachment turn. */
  readonly maxActiveAttachmentTurnBytes?: number;
  readonly maxQueuedAttachmentTurns?: number;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly controller: AbortController;
  readonly client: OperatorClient;
  readonly completion: Promise<void>;
}

interface AgentConnection {
  readonly client: OperatorClient;
  readonly info: OperatorInfo;
}

export interface WebUploadReservation {
  readonly attachment: StoredAttachment;
  readonly maxBytes: number;
  release(): void;
}

export class WebService {
  readonly store: WebStore;
  private readonly options: CreateWebServiceOptions;
  private readonly lease: WebStateLease;
  private readonly subscribers = new Set<(event: WebEvent) => boolean | void>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly activeUploads = new Map<string, number>();
  private readonly allowlist = new Set(DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST);
  private readonly attachmentTurnBudget: WeightedTurnBudget;
  private connections = new Map<string, AgentConnection>();
  private discoveryTimer: ReturnType<typeof setInterval> | undefined;
  private purgeTimer: ReturnType<typeof setInterval> | undefined;
  private purgePromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private refreshController: AbortController | undefined;
  private eventSequence = 0;
  private stopped = false;

  private constructor(store: WebStore, lease: WebStateLease, options: CreateWebServiceOptions) {
    this.store = store;
    this.lease = lease;
    this.options = options;
    this.attachmentTurnBudget = new WeightedTurnBudget(
      options.maxActiveAttachmentTurnBytes ?? WEB_MAX_ACTIVE_ATTACHMENT_TURN_BYTES,
      options.maxQueuedAttachmentTurns ?? WEB_MAX_QUEUED_ATTACHMENT_TURNS,
    );
  }

  static async create(options: CreateWebServiceOptions = {}): Promise<WebService> {
    const paths = await prepareWebStatePaths(options);
    let lease: WebStateLease;
    try {
      lease = await acquireWebStateLease(paths);
    } catch (error) { throw error; }
    let store: WebStore;
    try {
      // Recovery mutates active rows, so it must happen only after singleton
      // ownership is established. A losing second process never opens the DB.
      store = await WebStore.openPrepared(paths, options);
    } catch (error) {
      await lease.release();
      throw error;
    }
    const service = new WebService(store, lease, options);
    try {
      await store.purgePartialUploadFiles();
      await service.purgeOrphans();
      await service.refreshAgents();
      service.startTimers();
      return service;
    } catch (error) {
      await service.stop();
      throw error;
    }
  }

  async bootstrap(): Promise<WebBootstrap> {
    const currentThreadId = this.store.currentThreadId();
    return {
      version: WEB_API_VERSION,
      agents: this.store.listAgents(),
      threads: this.store.listThreads(),
      ...(currentThreadId === undefined ? {} : { currentThreadId }),
      limits: {
        maxFileBytes: DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
        maxFilesPerTurn: WEB_MAX_FILES_PER_TURN,
        maxTurnBytes: WEB_MAX_TURN_ATTACHMENT_BYTES,
        accept: DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
      },
    };
  }

  createThread(sourceId: string): WebThread {
    const thread = this.store.createThread(sourceId);
    this.emit("threads.changed", thread.id, { thread });
    return thread;
  }

  thread(id: string): WebThreadDetail {
    const detail = this.store.getThreadDetail(id);
    if (detail === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    return detail;
  }

  patchThread(id: string, patch: { readonly title?: string; readonly archived?: boolean }): WebThread {
    const thread = this.store.patchThread(id, patch);
    this.emit("thread.changed", id, { thread });
    this.emit("threads.changed", id);
    return thread;
  }

  patchAgent(sourceId: string, patch: PatchWebAgentInput): WebAgentSummary {
    const agent = this.store.setAgentPinned(sourceId, patch.pinned);
    this.emit("agents.changed", undefined, { agents: this.store.listAgents() });
    return agent;
  }

  async startTurn(threadId: string, input: StartWebTurnInput): Promise<{ readonly thread: WebThread; readonly turn: WebThread["runState"] }> {
    const text = input.text ?? "";
    const attachmentIds = input.attachmentIds ?? [];
    const thread = this.store.getThread(threadId);
    if (thread === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    const agent = this.store.getAgent(thread.sourceId);
    const connection = this.connections.get(thread.sourceId);
    if (agent === undefined || connection === undefined || !thread.canSend) {
      throw new WebConsoleError("agent_offline", "This agent is offline. The conversation remains available read-only.", 409);
    }
    validateModelAndEffort(agent, input.model, input.effort);
    const started = this.store.beginTurn({ threadId, text, attachmentIds, ...(input.model === undefined ? {} : { model: input.model }), ...(input.effort === undefined ? {} : { effort: input.effort }) });
    const controller = new AbortController();
    const completion = this.runTurn(started, connection.client, controller).finally(() => {
      this.activeTurns.delete(threadId);
    });
    this.activeTurns.set(threadId, { turnId: started.turnId, controller, client: connection.client, completion });
    this.emit("turn.changed", threadId, { turn: started.thread.runState });
    this.emit("threads.changed", threadId);
    return { thread: started.thread, turn: started.thread.runState };
  }

  async cancelTurn(threadId: string): Promise<WebThread> {
    const active = this.activeTurns.get(threadId);
    const stored = this.store.activeTurn(threadId);
    if (stored === undefined) throw new WebConsoleError("no_active_turn", "This conversation has no active turn.", 409);
    if (active !== undefined) {
      void active.client.cancel(stored.conversationId).catch((error: unknown) => {
        this.options.logger?.debug?.("Web turn cancel request failed.", { error: errorMessage(error) });
      });
      active.controller.abort(new WebTurnCancellation("user", "Cancelled from the web console."));
    }
    const thread = this.store.getThread(threadId);
    if (thread === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    return thread;
  }

  createUpload(input: CreateWebUploadInput): WebAttachment {
    const name = normalizeFilename(input.name);
    const contentType = normalizeMime(input.contentType);
    if (!this.allowlist.has(contentType)) {
      throw new WebConsoleError("unsupported_attachment_type", `Attachments of type ${contentType} are not allowed.`, 415);
    }
    if (input.sizeBytes !== undefined && (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)) {
      throw new WebConsoleError("invalid_attachment_size", "Attachment size must be a non-negative integer.", 400);
    }
    if ((input.sizeBytes ?? 0) > DEFAULT_AGENT_ATTACHMENT_MAX_BYTES) {
      throw new WebConsoleError("attachment_too_large", "Attachment exceeds the 20 MiB file limit.", 413);
    }
    const usage = this.store.stagedUploadUsage();
    if (usage.count >= WEB_MAX_STAGED_UPLOADS
      || usage.bytes + this.activeReservedUploadBytes() + (input.sizeBytes ?? 0) > WEB_MAX_STAGED_UPLOAD_BYTES) {
      throw new WebConsoleError("staged_upload_quota", "The staged upload quota is full. Remove an upload or try later.", 429);
    }
    const attachment = this.store.createUpload({
      name,
      contentType,
      kind: contentType.startsWith("image/") ? "image" : "document",
      ...(input.sizeBytes === undefined ? {} : { declaredSize: input.sizeBytes }),
    });
    const web = toWebAttachment(attachment);
    this.emit("attachment.changed", undefined, { attachment: web });
    return web;
  }

  reserveUpload(id: string): WebUploadReservation {
    const attachment = this.store.getStoredAttachment(id);
    if (attachment === undefined) throw new WebConsoleError("attachment_not_found", "Attachment not found.", 404);
    if (attachment.status !== "staged" || attachment.uploaded) {
      throw new WebConsoleError("attachment_unavailable", "This attachment is not available for upload.", 409);
    }
    if (this.activeUploads.size >= WEB_MAX_CONCURRENT_UPLOADS || this.activeUploads.has(id)) {
      throw new WebConsoleError("upload_concurrency_limit", "Too many uploads are already in progress.", 429);
    }
    const usage = this.store.stagedUploadUsage();
    const reservationBytes = DEFAULT_AGENT_ATTACHMENT_MAX_BYTES - attachment.sizeBytes;
    const worstCaseBytes = usage.bytes + this.activeReservedUploadBytes() + reservationBytes;
    if (worstCaseBytes > WEB_MAX_STAGED_UPLOAD_BYTES) {
      throw new WebConsoleError("staged_upload_quota", "The staged upload byte quota is full.", 429);
    }
    this.activeUploads.set(id, reservationBytes);
    let released = false;
    return {
      attachment,
      maxBytes: DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
      release: () => {
        if (released) return;
        released = true;
        this.activeUploads.delete(id);
      },
    };
  }

  completeUpload(id: string, sizeBytes: number): WebAttachment {
    const web = toWebAttachment(this.store.markUploadComplete(id, sizeBytes));
    this.emit("attachment.changed", undefined, { attachment: web });
    return web;
  }

  storedAttachment(id: string): StoredAttachment {
    const attachment = this.store.getStoredAttachment(id);
    if (attachment === undefined) throw new WebConsoleError("attachment_not_found", "Attachment not found.", 404);
    return attachment;
  }

  async removeUpload(id: string): Promise<void> {
    if (this.activeUploads.has(id)) throw new WebConsoleError("upload_active", "This upload is still in progress.", 409);
    await this.store.removeStagedAttachment(id);
    this.emit("attachment.changed", undefined, { attachmentId: id, removed: true });
  }

  subscribe(callback: (event: WebEvent) => boolean | void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  readyEvent(): WebEvent {
    return this.createEvent("ready", undefined, { version: WEB_API_VERSION });
  }

  refreshAgents(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshPromise !== undefined) return this.refreshPromise;
    const controller = new AbortController();
    this.refreshController = controller;
    this.refreshPromise = this.refreshAgentsOnce(controller.signal).finally(() => {
      this.refreshPromise = undefined;
      if (this.refreshController === controller) this.refreshController = undefined;
    });
    return this.refreshPromise;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.discoveryTimer !== undefined) clearInterval(this.discoveryTimer);
    if (this.purgeTimer !== undefined) clearInterval(this.purgeTimer);
    const pendingRefresh = this.refreshPromise;
    const pendingPurge = this.purgePromise;
    this.refreshController?.abort(new Error("Web service is stopping."));
    const active = [...this.activeTurns.values()];
    const trackedIds = new Set(active.map((turn) => turn.turnId));
    for (const turnId of this.store.listActiveTurnIds()) {
      if (!trackedIds.has(turnId)) this.store.interruptTurn(turnId);
    }
    for (const turn of active) {
      this.store.interruptTurn(turn.turnId);
      turn.controller.abort(new WebTurnCancellation("shutdown", "Web service is stopping."));
    }
    await Promise.allSettled(active.map((turn) => turn.completion));
    if (pendingRefresh !== undefined) await pendingRefresh.catch(() => undefined);
    if (pendingPurge !== undefined) await pendingPurge.catch(() => undefined);
    this.subscribers.clear();
    this.store.close();
    await this.lease.release();
  }

  private async runTurn(
    started: ReturnType<WebStore["beginTurn"]>,
    client: OperatorClient,
    controller: AbortController,
  ): Promise<void> {
    const coalescer = new StreamFrameCoalescer(
      async (frames) => {
        const message = this.store.applyStreamFrames(started.turnId, frames);
        this.emit("message.changed", started.thread.id, { messageId: message.id, updatedAt: message.updatedAt });
      },
      (error) => controller.abort(error),
    );
    let releaseAttachmentBudget: (() => void) | undefined;
    try {
      const attachmentBytes = started.attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
      releaseAttachmentBudget = await this.attachmentTurnBudget.acquire(attachmentBytes, controller.signal);
      const attachments = await Promise.all(started.attachments.map(async (attachment) => this.toAgentAttachment(attachment)));
      const modelMetadata = {
        ...(started.thread.runState.model === undefined ? {} : { model: started.thread.runState.model }),
        ...(started.thread.runState.effort === undefined ? {} : { effort: started.thread.runState.effort }),
      };
      const response = await client.turn({
        conversationId: started.conversationId,
        text: started.text,
        attachments,
        signal: controller.signal,
        metadata: {
          web: { threadId: started.thread.id, turnId: started.turnId, ...modelMetadata },
          tui: modelMetadata,
        },
        onFrame: (frame) => coalescer.push(frame),
      });
      await coalescer.flush();
      const detail = this.store.completeTurn(started.turnId, response.finalText, response.metadata);
      this.emit("turn.changed", started.thread.id, { turn: detail.thread.runState });
      this.emit("thread.changed", started.thread.id, { revision: detail.thread.revision });
      this.emit("threads.changed", started.thread.id);
    } catch (error) {
      let failure = error;
      try {
        await coalescer.flush();
      } catch (flushError) {
        failure = flushError;
      }
      const cancelled = controller.signal.reason instanceof WebTurnCancellation
        || (error as { cancelled?: unknown }).cancelled === true;
      const code = errorCode(failure);
      const detail = this.store.failTurn(started.turnId, {
        message: cancelled ? "Turn cancelled." : errorMessage(failure),
        ...(code === undefined ? {} : { code }),
        cancelled,
      });
      this.emit("turn.changed", started.thread.id, { turn: detail.thread.runState });
      this.emit("thread.changed", started.thread.id, { revision: detail.thread.revision });
      this.emit("threads.changed", started.thread.id);
    } finally {
      releaseAttachmentBudget?.();
      coalescer.close();
    }
  }

  private async toAgentAttachment(attachment: StoredAttachment): Promise<AgentAttachment> {
    const bytes = await readFile(this.store.attachmentPath(attachment));
    if (bytes.byteLength !== attachment.sizeBytes || bytes.byteLength > DEFAULT_AGENT_ATTACHMENT_MAX_BYTES) {
      throw new WebConsoleError("attachment_integrity", `Attachment ${attachment.name} failed its size check.`, 409);
    }
    return {
      kind: attachment.kind,
      mimeType: attachment.contentType,
      data: bytes.toString("base64"),
      name: attachment.name,
      sizeBytes: bytes.byteLength,
    };
  }

  private async refreshAgentsOnce(signal: AbortSignal): Promise<void> {
    const discover = this.options.discoverImpl ?? discoverOperatorAgents;
    let discovered: readonly DiscoveredOperatorAgent[];
    try {
      discovered = await discover({
        ...(this.options.registryDirs === undefined ? {} : { registryDirs: this.options.registryDirs }),
        ...(this.options.staleAfterMs === undefined ? {} : { staleAfterMs: this.options.staleAfterMs }),
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
      });
    } catch (error) {
      this.options.logger?.warn?.("Web agent discovery failed.", { error: errorMessage(error) });
      this.store.replaceAgents([]);
      this.connections = new Map();
      this.emit("agents.changed");
      return;
    }

    const nextConnections = new Map<string, AgentConnection>();
    const summaries = await Promise.all(discovered.map(async (agent): Promise<WebAgentSummary> => {
      if (agent.baseUrl === undefined) return offlineSummary(agent);
      const client = new OperatorClient({
        baseUrl: agent.baseUrl,
        ...(agent.apiKey === undefined ? {} : { apiKey: agent.apiKey }),
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      });
      try {
        const info = await client.info(AbortSignal.any([signal, AbortSignal.timeout(INFO_TIMEOUT_MS)]));
        nextConnections.set(agent.source.sourceId, { client, info });
        const efforts = collectEfforts(info);
        return {
          sourceId: agent.source.sourceId,
          label: info.label ?? agent.source.label,
          status: agent.source.health === "running" ? "online" : "degraded",
          pinned: false,
          health: agent.source.health,
          supportsAttachments: info.supportsAttachments,
          ...(info.models === undefined ? {} : { models: info.models }),
          ...(info.model === undefined ? {} : { defaultModel: info.model }),
          ...(info.effort === undefined ? {} : { defaultEffort: info.effort }),
          ...(efforts.length === 0 ? {} : { efforts }),
          ...(info.modelOptions === undefined ? {} : { modelOptions: info.modelOptions }),
          updatedAt: agent.source.updatedAt,
        };
      } catch (error) {
        this.options.logger?.debug?.("Discovered agent operator probe failed.", {
          sourceId: agent.source.sourceId,
          error: errorMessage(error),
        });
        return offlineSummary(agent);
      }
    }));
    this.connections = nextConnections;
    this.store.replaceAgents(summaries);
    this.emit("agents.changed", undefined, { agents: this.store.listAgents() });
    this.emit("threads.changed");
  }

  private startTimers(): void {
    const discoveryInterval = this.options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS;
    const purgeInterval = this.options.purgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS;
    if (discoveryInterval > 0) {
      this.discoveryTimer = setInterval(() => {
        void this.refreshAgents().catch((error: unknown) => {
          this.options.logger?.warn?.("Scheduled web agent discovery failed.", { error: errorMessage(error) });
        });
      }, discoveryInterval);
      this.discoveryTimer.unref();
    }
    if (purgeInterval > 0) {
      this.purgeTimer = setInterval(() => {
        void this.purgeOrphans().catch((error: unknown) => {
          this.options.logger?.warn?.("Scheduled web upload purge failed.", { error: errorMessage(error) });
        });
      }, purgeInterval);
      this.purgeTimer.unref();
    }
  }

  private purgeOrphans(): Promise<void> {
    if (this.purgePromise !== undefined) return this.purgePromise;
    this.purgePromise = this.purgeOrphansOnce().finally(() => {
      this.purgePromise = undefined;
    });
    return this.purgePromise;
  }

  private async purgeOrphansOnce(): Promise<void> {
    const before = new Date((this.options.clock?.() ?? new Date()).getTime() - WEB_STAGED_UPLOAD_TTL_MS).toISOString();
    const partialCount = await this.store.purgePartialUploadFiles(before);
    const count = await this.store.purgeStagedAttachments(before);
    if (count > 0 || partialCount > 0) {
      this.options.logger?.info?.("Purged orphaned web uploads.", { count, partialCount });
    }
  }

  private emit(type: WebEventType, threadId?: string, payload?: unknown): void {
    if (this.stopped) return;
    const event = this.createEvent(type, threadId, payload);
    for (const subscriber of [...this.subscribers]) {
      try {
        if (subscriber(event) === false) this.subscribers.delete(subscriber);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  private createEvent(type: WebEventType, threadId?: string, payload?: unknown): WebEvent {
    this.eventSequence += 1;
    return {
      id: `${Date.now()}-${this.eventSequence}`,
      version: WEB_API_VERSION,
      type,
      at: (this.options.clock?.() ?? new Date()).toISOString(),
      ...(threadId === undefined ? {} : { threadId }),
      ...(payload === undefined ? {} : { payload }),
    };
  }

  private activeReservedUploadBytes(): number {
    let total = 0;
    for (const bytes of this.activeUploads.values()) total += bytes;
    return total;
  }
}

const STREAM_FLUSH_INTERVAL_MS = 50;

class WebTurnCancellation extends Error {
  constructor(readonly kind: "user" | "shutdown", message: string) {
    super(message);
    this.name = "WebTurnCancellation";
  }
}

class StreamFrameCoalescer {
  private pending: AgentStreamWireFrame[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private closed = false;

  constructor(
    private readonly persist: (frames: readonly AgentStreamWireFrame[]) => Promise<void>,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  push(frame: AgentStreamWireFrame): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.closed) return;
    this.pending.push(frame);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch((error: unknown) => {
          this.failure = error;
          this.onFailure(error);
        });
      }, STREAM_FLUSH_INTERVAL_MS);
      this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const frames = this.pending;
    this.pending = [];
    if (frames.length > 0) {
      this.tail = this.tail.then(async () => this.persist(frames));
    }
    await this.tail;
    if (this.failure !== undefined) throw this.failure;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

interface BudgetWaiter {
  readonly weight: number;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

/** FIFO weighted semaphore: zero-weight text turns bypass attachment memory pressure. */
export class WeightedTurnBudget {
  private used = 0;
  private readonly queue: BudgetWaiter[] = [];

  constructor(private readonly capacity: number, private readonly maxQueue: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0 || !Number.isSafeInteger(maxQueue) || maxQueue < 0) {
      throw new TypeError("Weighted turn budget requires positive capacity and a non-negative queue bound.");
    }
  }

  acquire(weight: number, signal: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(weight) || weight < 0 || weight > this.capacity) {
      return Promise.reject(new WebConsoleError("attachment_turn_capacity", "Attachment turn exceeds the active memory budget.", 429));
    }
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Turn cancelled."));
    if (weight === 0) return Promise.resolve(() => undefined);
    if (this.queue.length === 0 && this.used + weight <= this.capacity) {
      return Promise.resolve(this.grant(weight));
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new WebConsoleError("attachment_turn_queue_full", "Too many attachment turns are waiting.", 429));
    }
    return new Promise<() => void>((resolvePromise, reject) => {
      const waiter: BudgetWaiter = {
        weight,
        resolve: resolvePromise,
        reject,
        signal,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason ?? new Error("Turn cancelled."));
          this.drain();
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private grant(weight: number): () => void {
    this.used += weight;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= weight;
      this.drain();
    };
  }

  private drain(): void {
    for (;;) {
      const next = this.queue[0];
      if (next === undefined || this.used + next.weight > this.capacity) return;
      this.queue.shift();
      next.signal.removeEventListener("abort", next.onAbort);
      next.resolve(this.grant(next.weight));
    }
  }
}

function offlineSummary(agent: DiscoveredOperatorAgent): WebAgentSummary {
  return {
    sourceId: agent.source.sourceId,
    label: agent.source.label,
    status: "offline",
    pinned: false,
    health: agent.source.health,
    supportsAttachments: false,
    updatedAt: agent.source.updatedAt,
  };
}

function collectEfforts(info: OperatorInfo): readonly string[] {
  // Older operator schemas do not advertise per-model metadata. Match the TUI
  // picker in that case: cloud/unknown models use the canonical global effort
  // ladder rather than treating only the current default as selectable.
  if (info.modelOptions === undefined) return EFFORT_LEVELS;
  const models = info.models ?? (info.model === undefined ? [] : [info.model]);
  return [...new Set(models.flatMap((model) => effortLevelsForOption(info.modelOptions?.[model])))];
}

function validateModelAndEffort(agent: WebAgentSummary, model: string | undefined, effort: string | undefined): void {
  if (model !== undefined
    && (agent.models === undefined ? model !== agent.defaultModel : !agent.models.includes(model))) {
    throw new WebConsoleError("invalid_model", "This agent did not advertise the selected model.", 400);
  }
  const effectiveModel = model ?? agent.defaultModel;
  const option = effectiveModel === undefined ? undefined : agent.modelOptions?.[effectiveModel];
  const allowedEfforts = option === undefined ? agent.efforts : effortLevelsForOption(option);
  if (effort !== undefined && (allowedEfforts === undefined || !allowedEfforts.includes(effort))) {
    throw new WebConsoleError("invalid_effort", "This agent did not advertise the selected effort for this model.", 400);
  }
}

function effortLevelsForOption(option: WebModelOption | undefined): readonly string[] {
  if (option !== undefined
    && (option.reasoning === false || option.reasoningMode === "none" || option.effortLevels?.length === 0)) {
    return [];
  }
  if (option?.reasoningMode === "toggle") return ["high", "none"];
  return option?.effortLevels ?? EFFORT_LEVELS;
}

function normalizeFilename(value: string): string {
  const withoutPath = value.replace(/\\/gu, "/").split("/").at(-1)?.trim() ?? "";
  const normalized = withoutPath.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 255);
  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    throw new WebConsoleError("invalid_attachment_name", "Attachment filename is invalid.", 400);
  }
  return normalized;
}

function normalizeMime(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(normalized)) {
    throw new WebConsoleError("invalid_attachment_type", "Attachment MIME type is invalid.", 400);
  }
  return normalized;
}
