import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
  type AgentReplyPart,
  createChannelUserCancelReason,
  isChannelUserCancelReason,
  toolNameLeaf,
  type AgentAttachment,
  type AgentMcpAppHostRequest,
  type AgentMcpAppResource,
  type AgentReplyAttachmentPart,
  type AgentStreamWireFrame,
  type ChannelAskAnswer,
  type ChannelAskSnapshot,
  type ChannelAskSubmissionResult,
  type MonitorProjection,
  type ProcessJobProjection,
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
  WEB_MAX_TURN_TEXT_CHARACTERS,
  WEB_MAX_TURN_ATTACHMENT_BYTES,
  WEB_STAGED_UPLOAD_TTL_MS,
  type CreateWebUploadInput,
  type PatchWebAgentInput,
  type PatchWebThreadInput,
  type StartWebTurnInput,
  type WebAgentsChangedPayload,
  type WebAgentSummary,
  type WebAttachment,
  type WebBootstrap,
  type WebBootstrapScope,
  type WebChannelConfigView,
  type WebCronMutationResult,
  type WebCronOverview,
  type WebCronRunSummary,
  type WebCronRunPage,
  type WebEvent,
  type WebEventType,
  type WebLiveInputReceipt,
  type WebMessage,
  type WebMessagePart,
  type WebModelOption,
  type WebThreadNotificationTriggerKind,
  type WebSkillRegistry,
  type WebThread,
  type WebThreadChangedPayload,
  type WebThreadDetail,
  type WebThreadPage,
  type WebThreadSearchPage,
  type WebToolCall,
  type SearchWebThreadsInput,
  type WebMessagePage,
  type WebModelPage,
  type WebPushSubscriptionStatus,
} from "./contracts.js";
import {
  discoverOperatorAgents,
  type DiscoverOperatorAgentsOptions,
  type DiscoveredOperatorAgent,
} from "./discovery.js";
import { conversationTitleFromFrame } from "./conversation-title.js";
import { advertisedEffortLevels, effectiveModelForAgent, effortLevelsForModel } from "./effort-ladder.js";
import { errorCode, errorMessage, WebConsoleError } from "./errors.js";
import { OperatorClient, type OperatorInfo } from "./operator-client.js";
import {
  generateWebPushIdentity,
  normalizeWebPushEndpoint,
  resolveWebPushSubject,
  validateWebPushEndpoint,
  validateWebPushKeys,
  WebPushDispatcher,
  WEB_PUSH_SERVICE_WORKER_VERSION,
  type WebPushDnsResolver,
  type WebPushSend,
} from "./push.js";
import { acquireWebStateLease, prepareWebStatePaths, type WebStateLease, type WebStatePathOptions } from "./state-paths.js";
import {
  cronChannelReadOnlyError,
  toWebAttachment,
  WebStore,
  WEB_THREAD_PAGE_DEFAULT,
  notificationPushLogicalKey,
  type StoredAttachment,
  type StoredTurnExecution,
  type StoredWebPushEvent,
  type WebPushIdentity,
} from "./store.js";

const DEFAULT_DISCOVERY_INTERVAL_MS = 5_000;
const DEFAULT_PURGE_INTERVAL_MS = 60 * 60 * 1_000;
const INFO_TIMEOUT_MS = 2_500;
const ASK_DISCOVERY_TIMEOUT_MS = 120_000;
/** Bounded per-agent catalog-admitted model refs; beyond it, oldest go first. */
const MODEL_CATALOG_CACHE_CAP = 2_048;
const REPLY_ACCESS_TTL_MS = 10 * 60 * 1_000;
/**
 * Raster types the console keeps its own copy of. `image/svg+xml` is absent on
 * purpose: it is active content, and both the inline gate in the browser and
 * `setReplyDownloadHeaders` already refuse to treat it as an image.
 */
const REPLY_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * How much of a tool call's `result`/`args` a browser read carries.
 *
 * Measured on a real fleet transcript: a 4-message tool-heavy conversation is
 * 231 KB, of which 211 KB is `tool-call` result bodies (single `Exec`/`ReadSkill`
 * results run 14-21 KB). The rows are collapsed, so what the operator sees of
 * one is its first screenful; the rest is a request away.
 */
const TOOL_PAYLOAD_PREVIEW_CHARS = 4_096;

/**
 * Telemetry whose `data` the console actually reads.
 *
 * `webapp/src/runtime.tsx` renders only `runtime_telemetry` of kind
 * `context_compaction`/`assistant_message_boundary`/`context_usage` plus
 * `cron_run`; `webapp/src/usage.ts` sums any part labelled `context_usage`,
 * `context_compaction`, or containing `usage`/`cost`. Everything else --
 * `provider_status`, `memory_recalled`, `status`, `run_config`, `cache_hit`,
 * `capabilities_resolved`, ... -- is carried across the wire and dropped, which
 * is ~10 KB a conversation.
 */
const TELEMETRY_DATA_ALLOWLIST: ReadonlySet<string> = new Set([
  "usage_update",
  "cron_run",
  "context_usage",
  "context_compaction",
  "assistant_message_boundary",
]);

/**
 * `?full=1`: serve the transcript exactly as recorded. The escape hatch for an
 * operator (or a support read) who needs the payloads the console elides.
 */
export interface WebTranscriptShape {
  readonly full?: boolean;
}

type WebTelemetryPart = Extract<WebMessagePart, { type: "telemetry" }>;
type WebToolCallPart = Extract<WebMessagePart, { type: "tool-call" }>;
type WebSubagentPart = Extract<WebMessagePart, { type: "subagent" }>;

/** A `runtime_telemetry` event's variant, which the store stores inside `data`. */
function telemetryKind(data: unknown): string | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const kind = (data as Record<string, unknown>).kind;
  return typeof kind === "string" && kind.length > 0 ? kind : undefined;
}

/** The allowlist, or the `usage`/`cost` substring rule `usage.ts` applies. */
function readsTelemetryLabel(label: string | undefined): boolean {
  if (label === undefined) return false;
  const normalized = label.toLowerCase();
  return TELEMETRY_DATA_ALLOWLIST.has(normalized)
    || normalized.includes("usage")
    || normalized.includes("cost");
}

function keepsTelemetryData(part: WebTelemetryPart): boolean {
  // `usage.ts` matches on the event name AND on a nested `kind`, so both are
  // measured against the same rule -- a `runtime_telemetry{kind:"token_usage"}`
  // counts towards the run's tokens exactly like a bare `usage_update`.
  return readsTelemetryLabel(part.event) || readsTelemetryLabel(telemetryKind(part.data));
}

/**
 * Keep the part, drop the payload the console never reads.
 *
 * Removing it outright would renumber every later part, and both the client's
 * part conversion and the index-based transcript reads that follow this change
 * depend on positions being stable. `kind` is surfaced whenever the event has
 * one -- kept or stripped -- so its presence is never a back-channel for "the
 * payload was dropped".
 */
function shapeTelemetryPart(part: WebTelemetryPart): WebTelemetryPart {
  const kind = telemetryKind(part.data);
  const keepsData = part.data === undefined || keepsTelemetryData(part);
  if (keepsData && (kind === undefined || part.kind === kind)) return part;
  return {
    type: "telemetry",
    event: part.event,
    ...(kind === undefined ? {} : { kind }),
    ...(keepsData ? { data: part.data } : {}),
  };
}

/**
 * The head of an oversized payload, or `undefined` when it is small enough (or
 * cannot be serialized, in which case it is left exactly as stored).
 */
function payloadPreview(value: unknown): { readonly preview: unknown; readonly length: number } | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : jsonTextOf(value);
  if (text === undefined || text.length <= TOOL_PAYLOAD_PREVIEW_CHARS) return undefined;
  return { preview: text.slice(0, TOOL_PAYLOAD_PREVIEW_CHARS), length: text.length };
}

/** `undefined` for anything JSON cannot express, which is then left as stored. */
function jsonTextOf(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function shapeToolCall(call: WebToolCall): WebToolCall {
  // AskUser's arguments and answer ARE the card the console renders, and they
  // are bounded at the emitter. `structuredResult` is never touched anywhere:
  // it is the machine-readable outcome, bounded at the emitter too.
  if (call.toolName === "AskUser") return call;
  const args = payloadPreview(call.args);
  const result = payloadPreview(call.result);
  if (args === undefined && result === undefined) return call;
  return {
    ...call,
    ...(args === undefined ? {} : { args: args.preview, argsTruncated: true, argsBytes: args.length }),
    ...(result === undefined ? {} : { result: result.preview, resultTruncated: true, resultBytes: result.length }),
  };
}

function shapeToolCallPart(part: WebToolCallPart): WebToolCallPart {
  return { ...shapeToolCall(part), type: "tool-call" };
}

/**
 * An oversized ARGUMENTS OBJECT with its string leaves cut back to fit, rather
 * than replaced by the head of its JSON text.
 *
 * A delegation's arguments are not opaque the way an arbitrary tool's are: the
 * console reads `prompt` out of them for the row summary and the Task note, and
 * a JSON-text head is neither. Nothing is added or removed, so the object keeps
 * its shape and every key keeps its place, and the longest string pays first.
 *
 * Termination is the bounded pass count, NOT an assumption that every slice
 * shrinks the serialization: cutting between a surrogate pair leaves a lone
 * surrogate that `JSON.stringify` writes as `\udXXX`, which can make one pass
 * longer than the last. Anything still over budget after eight passes falls
 * back to the whole-value head.
 */
function shapedArgsObject(args: unknown): { readonly preview: unknown; readonly length: number } | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const original = jsonTextOf(args);
  if (original === undefined || original.length <= TOOL_PAYLOAD_PREVIEW_CHARS) return undefined;
  let shaped: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (let pass = 0; pass < 8; pass += 1) {
    const text = jsonTextOf(shaped);
    if (text === undefined) return undefined;
    if (text.length <= TOOL_PAYLOAD_PREVIEW_CHARS) return { preview: shaped, length: original.length };
    const longest = Object.entries(shaped)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 1)
      .sort(([, left], [, right]) => right.length - left.length)[0];
    if (longest === undefined) return undefined;
    const [key, value] = longest;
    const keep = Math.max(1, value.length - (text.length - TOOL_PAYLOAD_PREVIEW_CHARS));
    shaped = { ...shaped, [key]: value.slice(0, keep) };
  }
  // Too many oversized leaves to fit: fall back to the whole-value head rather
  // than serve an object that is still over budget.
  return undefined;
}

function shapeSubagentPart(part: WebSubagentPart): WebSubagentPart {
  const args = shapedArgsObject(part.args) ?? payloadPreview(part.args);
  const result = payloadPreview(part.result);
  return {
    ...part,
    ...(args === undefined ? {} : { args: args.preview, argsTruncated: true, argsBytes: args.length }),
    ...(result === undefined ? {} : { result: result.preview, resultTruncated: true, resultBytes: result.length }),
    calls: part.calls.map(shapeToolCall),
  };
}

function formatQuotedTurn(quote: string, text: string): string {
  const blockquote = quote
    .trim()
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join("\n");
  return `Quoted context:\n${blockquote}\n\n${text}`;
}

function assertMonitorWakeAddress(input: DeliverWebMonitorNotificationInput): void {
  const originConversation = input.monitor.origin.conversationId.split("#", 1)[0];
  const expectedDeliveryKey = `monitor:${input.monitor.monitorId}:${String(input.monitor.counters.seq)}`;
  if (input.monitor.origin.channel !== "web"
    || originConversation !== `web:${input.threadId}`
    || input.deliveryKey !== expectedDeliveryKey) {
    throw new WebConsoleError(
      "invalid_notification",
      "The Monitor wake origin or delivery key does not match its web destination.",
      409,
    );
  }
}

function monitorWakePayloadSha256(monitor: MonitorProjection, wakePrompt: string): string {
  return createHash("sha256")
    .update(canonicalJson(monitor))
    .update("\0")
    .update(wakePrompt)
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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
  /** Test/embedding seam. Production uses the pinned-address HTTPS sender. */
  readonly pushSendImpl?: WebPushSend;
  /** Test/embedding seam for registration and send-time DNS validation. */
  readonly pushDnsResolver?: WebPushDnsResolver;
  readonly pushDispatchIntervalMs?: number;
  readonly pushRandom?: () => number;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly controller: AbortController;
  readonly client: OperatorClient;
  readonly completion: Promise<void>;
}

interface ActiveLiveInput {
  readonly threadId: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

type HostWakeReceipt = NonNullable<DeliverWebNotificationResult["delivery"]>;

interface AgentConnection {
  readonly client: OperatorClient;
  readonly info: OperatorInfo;
}

interface AskWatch {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

type WebRichReplyPart =
  | Extract<WebMessagePart, { type: "attachment" }>
  | Extract<WebMessagePart, { type: "mcp_app" }>;

export interface DeliverWebThreadNotificationInput {
  readonly sourceId: string;
  readonly triggerKind: WebThreadNotificationTriggerKind;
  readonly deliveryKey: string;
  readonly text: string;
  readonly jobId?: string;
  readonly runId?: string;
}

export interface DeliverWebProcessJobNotificationInput {
  readonly sourceId: string;
  readonly triggerKind: "job";
  readonly deliveryKey: string;
  readonly threadId: string;
  readonly processJob: ProcessJobProjection;
  /** Present only for the terminal wake delivery, not lifecycle-only updates. */
  readonly wakePrompt?: string;
  readonly text?: string;
  readonly parts?: readonly AgentReplyPart[];
}

export interface DeliverWebMonitorNotificationInput {
  readonly sourceId: string;
  readonly triggerKind: "monitor";
  readonly deliveryKey: string;
  readonly threadId: string;
  readonly monitor: MonitorProjection;
  readonly wakePrompt: string;
}

export type DeliverWebNotificationInput =
  | DeliverWebThreadNotificationInput
  | DeliverWebProcessJobNotificationInput
  | DeliverWebMonitorNotificationInput;

export interface DeliverWebNotificationResult {
  readonly thread?: WebThread;
  readonly duplicate: boolean;
  readonly tombstoned?: true;
  readonly delivery?: {
    readonly delivered: boolean;
    readonly disposition?: "steered" | "follow_up";
    readonly code?: string;
    readonly retryable?: boolean;
    readonly ambiguous?: boolean;
  };
}

export interface WebUploadReservation {
  readonly attachment: StoredAttachment;
  readonly maxBytes: number;
  release(): void;
}

/**
 * One admitted model reference. `source` records who said it: a `/v1/models`
 * page is the live word on the models it serves, while the `modelOptions` seed
 * only proves the ref is selectable and never describes a ladder.
 */
interface CatalogModelRecord {
  readonly source: "page" | "shortlist";
  readonly efforts: readonly string[] | undefined;
}

/** One agent generation's admitted refs. See `reconcileModelCatalogCache`. */
interface CatalogCacheEntry {
  readonly generation: string;
  readonly models: Map<string, CatalogModelRecord>;
}

export class WebService {
  readonly store: WebStore;
  private readonly options: CreateWebServiceOptions;
  private readonly lease: WebStateLease;
  private readonly subscribers = new Set<(event: WebEvent) => boolean | void>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly activeLiveInputs = new Map<string, ActiveLiveInput>();
  private readonly drainingLiveInputThreads = new Set<string>();
  private readonly activeUploads = new Map<string, number>();
  private readonly activeNotifications = new Map<string, Promise<DeliverWebNotificationResult>>();
  /** One serialization lane shared by queued user input and every host wake kind. */
  private readonly hostWakeTails = new Map<string, Promise<void>>();
  private readonly hostWakeReservations = new Map<string, number>();
  private readonly activeHostWakes = new Map<string, Promise<HostWakeReceipt>>();
  private readonly allowlist = new Set(DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST);
  private readonly attachmentTurnBudget: WeightedTurnBudget;
  private readonly pushIdentity: WebPushIdentity;
  private readonly pushDispatcher: WebPushDispatcher;
  private readonly pushAckKey = randomBytes(32);
  private readonly replyAccessKey: Buffer;
  private readonly askWatches = new Map<string, AskWatch>();
  private connections = new Map<string, AgentConnection>();
  /** Bounded catalog-admitted model refs per agent, seeded from `modelOptions`
   *  and appended to by every proxied `/v1/models` page. Admission is `has`,
   *  metadata is `get`. Map preserves insertion order, so evicting the oldest
   *  entry is deleting the head. Scoped to the agent GENERATION that filled it
   *  (see `reconcileModelCatalogCache`), because a source id outlives the
   *  process behind it. */
  private readonly modelCatalogCache = new Map<string, CatalogCacheEntry>();
  /** Parts whose durable copy is being fetched, so concurrent reads fetch once. */
  private persistingReplyImages = new Set<string>();
  private discoveryTimer: ReturnType<typeof setInterval> | undefined;
  private purgeTimer: ReturnType<typeof setInterval> | undefined;
  private purgePromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private refreshController: AbortController | undefined;
  private eventSequence = 0;
  private stopped = false;

  private constructor(
    store: WebStore,
    lease: WebStateLease,
    options: CreateWebServiceOptions,
    pushIdentity: WebPushIdentity,
    pushSubject: string,
    replyAccessKey: Buffer,
  ) {
    this.store = store;
    this.lease = lease;
    this.options = options;
    this.pushIdentity = pushIdentity;
    this.replyAccessKey = replyAccessKey;
    this.attachmentTurnBudget = new WeightedTurnBudget(
      options.maxActiveAttachmentTurnBytes ?? WEB_MAX_ACTIVE_ATTACHMENT_TURN_BYTES,
      options.maxQueuedAttachmentTurns ?? WEB_MAX_QUEUED_ATTACHMENT_TURNS,
    );
    this.pushDispatcher = new WebPushDispatcher(store, pushIdentity, pushSubject, {
      ...(options.pushSendImpl === undefined ? {} : { send: options.pushSendImpl }),
      ...(options.pushDnsResolver === undefined ? {} : { resolve: options.pushDnsResolver }),
      ...(options.pushDispatchIntervalMs === undefined ? {} : { intervalMs: options.pushDispatchIntervalMs }),
      ...(options.pushRandom === undefined ? {} : { random: options.pushRandom }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      beforeSend: (event, signal) => this.pushEventStillRelevant(event, signal),
    });
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
    let service: WebService | undefined;
    try {
      const pushIdentity = store.ensureWebPushIdentity(generateWebPushIdentity);
      const replyAccessKey = Buffer.from(
        store.ensureReplyAccessKey(() => randomBytes(32).toString("base64url")),
        "base64url",
      );
      const pushSubject = resolveWebPushSubject(options.env?.MONO_AGENT_WEB_PUSH_SUBJECT);
      service = new WebService(store, lease, options, pushIdentity, pushSubject, replyAccessKey);
      await store.purgePartialUploadFiles();
      await service.purgeOrphans();
      await service.refreshAgents();
      service.startTimers();
      service.pushDispatcher.start();
      return service;
    } catch (error) {
      if (service === undefined) {
        store.close();
        await lease.release();
      } else {
        await service.stop();
      }
      throw error;
    }
  }

  async bootstrap(scope: WebBootstrapScope = {}): Promise<Omit<WebBootstrap, "console">> {
    const currentThreadId = this.store.currentThreadId();
    const currentThread = currentThreadId === undefined ? undefined : this.store.getThread(currentThreadId);
    const discoveredCurrentThreadId = currentThread !== undefined
      && this.store.getAgent(currentThread.sourceId) !== undefined
      ? currentThreadId
      : undefined;
    const agents = this.store.listAgents();
    const threadsSourceId = this.bootstrapSourceId(scope.sourceId, currentThread, agents);
    const archived = scope.archived ?? false;
    const page = threadsSourceId === null
      ? { threads: [] as readonly WebThread[] }
      : this.store.listThreadsPage({
        sourceId: threadsSourceId,
        archived,
        limit: scope.limit ?? WEB_THREAD_PAGE_DEFAULT,
      });
    return {
      version: WEB_API_VERSION,
      push: {
        applicationServerKey: this.pushIdentity.publicKey,
        keyFingerprint: this.pushIdentity.fingerprint,
        serviceWorkerVersion: WEB_PUSH_SERVICE_WORKER_VERSION,
      },
      agents,
      threads: page.threads,
      threadsSourceId,
      threadsNextCursor: page.nextCursor ?? null,
      ...(discoveredCurrentThreadId === undefined ? {} : { currentThreadId: discoveredCurrentThreadId }),
      limits: {
        maxFileBytes: DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
        maxFilesPerTurn: WEB_MAX_FILES_PER_TURN,
        maxTurnBytes: WEB_MAX_TURN_ATTACHMENT_BYTES,
        accept: DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
      },
    };
  }

  /**
   * The one bucket a bootstrap answers with.
   *
   * An absent or unknown `sourceId` is the ordinary case, not an error: the
   * first request a fresh console makes has no selection to name, and a
   * console whose stored agent has since gone away must still get a console.
   * The chain is the one the browser resolves its own selection with -- the
   * agent of the conversation the console was last in, else the first agent
   * that can answer, else the first agent at all.
   */
  private bootstrapSourceId(
    requested: string | undefined,
    currentThread: WebThread | undefined,
    agents: readonly WebAgentSummary[],
  ): string | null {
    if (requested !== undefined && agents.some((agent) => agent.sourceId === requested)) return requested;
    const current = currentThread === undefined
      ? undefined
      : agents.find((agent) => agent.sourceId === currentThread.sourceId);
    return current?.sourceId
      ?? agents.find((agent) => agent.status !== "offline")?.sourceId
      ?? agents[0]?.sourceId
      ?? null;
  }

  createThread(sourceId: string): WebThread {
    const thread = this.store.createThread(sourceId);
    this.emitThread("threads.changed", { thread });
    return thread;
  }

  thread(id: string, options: WebTranscriptShape = {}): WebThreadDetail {
    const detail = this.store.getThreadDetail(id);
    if (detail === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    return this.decorateThreadDetail(detail, options);
  }

  threadsPage(input: {
    readonly sourceId: string;
    readonly archived: boolean;
    readonly limit?: number;
    readonly before?: string;
  }): WebThreadPage {
    return this.store.listThreadsPage(input);
  }

  /**
   * Read-only, so it emits nothing: a search changes no state that another
   * console tab needs to hear about.
   */
  searchThreads(input: SearchWebThreadsInput): WebThreadSearchPage {
    return this.store.searchThreads(input);
  }

  messagePage(
    threadId: string,
    input: { readonly limit?: number; readonly before?: string } & WebTranscriptShape,
  ): WebMessagePage {
    // The store pages; the shape is a view concern and has no business reaching it.
    const { full, ...query } = input;
    const page = this.store.listMessagesPage(threadId, query);
    const shape: WebTranscriptShape = full === undefined ? {} : { full };
    return { ...page, messages: page.messages.map((message) => this.shapeMessage(message, shape)) };
  }

  /**
   * The untruncated payloads of ONE tool call, for a transcript that was served
   * a preview of it.
   *
   * Addressed by (conversation, message, tool call) rather than by tool-call id
   * alone: the id is not a capability, and a lookup that took it on its own
   * would hand any caller any conversation's transcript.
   */
  toolCallPart(threadId: string, messageId: string, toolCallId: string): WebMessagePart {
    const thread = this.store.getThread(threadId);
    const message = this.store.getMessage(messageId);
    if (thread === undefined || message === undefined || message.threadId !== thread.id) {
      throw new WebConsoleError("tool_call_not_found", "The tool call is unavailable.", 404);
    }
    const owned = message.parts.find(
      (part): part is WebToolCallPart | WebSubagentPart =>
        (part.type === "tool-call" || part.type === "subagent") && part.toolCallId === toolCallId,
    );
    if (owned !== undefined) return owned;
    for (const part of message.parts) {
      if (part.type !== "subagent") continue;
      const call = part.calls.find((candidate) => candidate.toolCallId === toolCallId);
      // A subagent's child owns no part of its own, so it answers as the
      // tool-call part it would have been outside the delegation.
      if (call !== undefined) return { type: "tool-call", ...call };
    }
    throw new WebConsoleError("tool_call_not_found", "The tool call is unavailable.", 404);
  }

  /**
   * Re-mint a browser capability from the authoritative durable message. The
   * HTTP route supplies exact-origin console authority; stale access tokens are
   * deliberately not accepted as renewable credentials.
   */
  replyPartAccess(
    threadId: string,
    messageId: string,
    partId: string,
    type: "attachment" | "mcp_app",
  ): WebRichReplyPart {
    const { message, part } = this.requireReplyPart(threadId, messageId, partId, type);
    this.assertReplyPartRetained(part);
    return this.decorateReplyPart(message, part);
  }

  async replyAttachment(
    threadId: string,
    messageId: string,
    partId: string,
    expires: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly part: Extract<WebMessagePart, { type: "attachment" }>;
    readonly response: Response;
  }> {
    const { thread, part } = this.authorizeReplyPart(
      threadId,
      messageId,
      partId,
      "attachment",
      expires,
      token,
    );
    const connection = this.connections.get(thread.sourceId);
    if (connection === undefined || connection.info.replyAttachments?.version !== 1) {
      throw new WebConsoleError("reply_attachment_unavailable", "The attachment source is offline or incompatible.", 409);
    }
    const attachment: AgentReplyAttachmentPart = {
      type: "attachment",
      id: part.id,
      reference: { scheme: "mono-agent-artifact", id: part.artifactId },
      name: part.name,
      mediaType: part.mediaType,
      sizeBytes: part.sizeBytes,
      integrityId: part.integrityId,
      ...(part.expiresAt === undefined ? {} : { expiresAt: part.expiresAt }),
    };
    const response = await connection.client.replyArtifact(
      this.conversationIdForThread(thread.id),
      attachment,
      signal,
    );
    return { part, response };
  }

  async mcpAppResource(
    threadId: string,
    messageId: string,
    partId: string,
    expires: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<AgentMcpAppResource> {
    const { thread, part } = this.authorizeReplyPart(
      threadId,
      messageId,
      partId,
      "mcp_app",
      expires,
      token,
    );
    const connection = this.connections.get(thread.sourceId);
    if (connection === undefined || connection.info.mcpApps?.bridgeVersion !== 1) {
      throw new WebConsoleError("mcp_app_unavailable", "The MCP App source is offline or incompatible.", 409);
    }
    const resource = await connection.client.mcpAppResource(
      this.conversationIdForThread(thread.id),
      part.invocationId,
      part.connectionId,
      signal,
    );
    if (
      resource.app.invocationId !== part.invocationId
      || resource.app.connectionId !== part.connectionId
      || resource.app.resourceUri !== part.resourceUri
      || resource.app.protocolVersion !== part.protocolVersion
    ) {
      throw new WebConsoleError("mcp_app_identity_mismatch", "The MCP App identity changed after publication.", 409);
    }
    return resource;
  }

  async mcpAppRequest(
    threadId: string,
    messageId: string,
    partId: string,
    expires: string,
    token: string,
    input: Pick<AgentMcpAppHostRequest, "method" | "params" | "confirmed">,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { thread, part } = this.authorizeReplyPart(
      threadId,
      messageId,
      partId,
      "mcp_app",
      expires,
      token,
    );
    const confirmationRequired = input.method === "tools/call"
      || input.method === "ui/open-link"
      || input.method === "ui/update-model-context";
    if (confirmationRequired && input.confirmed !== true) {
      throw new WebConsoleError("mcp_app_confirmation_required", "Confirm this MCP App action before continuing.", 409);
    }
    const connection = this.connections.get(thread.sourceId);
    if (connection === undefined || connection.info.mcpApps?.bridgeVersion !== 1) {
      throw new WebConsoleError("mcp_app_unavailable", "The MCP App source is offline or incompatible.", 409);
    }
    return await connection.client.mcpAppRequest(
      this.conversationIdForThread(thread.id),
      {
        invocationId: part.invocationId,
        connectionId: part.connectionId,
        method: input.method,
        ...(input.params === undefined ? {} : { params: input.params }),
        ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
      },
      signal,
    );
  }

  async registerWebPushSubscription(input: {
    readonly endpoint: string;
    readonly p256dh: string;
    readonly auth: string;
    readonly expirationTime?: number;
    readonly siteOrigin: string;
    readonly previousSubscriptionId?: string;
    readonly previousEndpoint?: string;
  }): Promise<WebPushSubscriptionStatus> {
    if (input.previousSubscriptionId !== undefined && input.previousEndpoint !== undefined) {
      throw new WebConsoleError(
        "invalid_push_subscription",
        "A replacement may identify the previous subscription by id or endpoint, but not both.",
        400,
      );
    }
    validateWebPushKeys(input.p256dh, input.auth);
    const endpoint = await validateWebPushEndpoint(input.endpoint, this.options.pushDnsResolver);
    const previousEndpoint = input.previousEndpoint === undefined
      ? undefined
      : normalizeWebPushEndpoint(input.previousEndpoint);
    if (input.expirationTime !== undefined
      && (!Number.isSafeInteger(input.expirationTime) || input.expirationTime <= this.currentDate().getTime())) {
      throw new WebConsoleError("invalid_push_subscription", "The push subscription expiration is invalid.", 400);
    }
    return this.store.registerWebPushSubscription({
      endpoint: endpoint.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      ...(input.expirationTime === undefined ? {} : { expirationTime: input.expirationTime }),
      siteOrigin: input.siteOrigin,
      keyFingerprint: this.pushIdentity.fingerprint,
      ...(input.previousSubscriptionId === undefined ? {} : { previousSubscriptionId: input.previousSubscriptionId }),
      ...(previousEndpoint === undefined ? {} : { previousEndpoint }),
    });
  }

  webPushSubscription(id: string): WebPushSubscriptionStatus {
    const subscription = this.store.getWebPushSubscription(id);
    if (subscription === undefined) {
      throw new WebConsoleError("push_subscription_not_found", "Notification subscription not found.", 404);
    }
    return subscription;
  }

  disableWebPushSubscription(id: string): void {
    this.store.disableWebPushSubscription(id);
  }

  testWebPushSubscription(id: string): WebPushSubscriptionStatus {
    this.store.enqueueWebPushTest(id);
    this.pushDispatcher.wake();
    return this.webPushSubscription(id);
  }

  acknowledgeWebPushEvent(eventId: string, subscriptionId: string, token: string): void {
    if (!this.validPushAckToken(eventId, token)) return;
    this.store.acknowledgeWebPushEvent(eventId, subscriptionId);
  }

  webPushDegraded(): boolean {
    return this.pushDispatcher.isDegraded();
  }

  async pendingAsk(threadId: string): Promise<ChannelAskSnapshot | undefined> {
    const thread = this.store.getThread(threadId);
    if (thread === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    threadId = thread.id;
    const connection = this.connections.get(thread.sourceId);
    if (connection === undefined) throw new WebConsoleError("agent_offline", "This agent is offline.", 409);
    if (!connection.info.supportsAskUser) return undefined;
    const snapshot = await connection.client.pendingAsk(
      this.store.cronConversationIdForThread(thread.id) ?? `web:${thread.id}`,
      AbortSignal.timeout(INFO_TIMEOUT_MS),
    );
    if (!this.stopped && snapshot !== undefined && isFuturePendingAsk(snapshot, this.currentDate())) {
      this.enqueueAskPush(thread.id, snapshot);
    }
    return snapshot;
  }

  async ask(threadId: string, interactionId: string): Promise<ChannelAskSnapshot | undefined> {
    const thread = this.store.getThread(threadId);
    if (thread === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    const connection = this.connections.get(thread.sourceId);
    if (connection === undefined) throw new WebConsoleError("agent_offline", "This agent is offline.", 409);
    if (!connection.info.supportsAskById) return undefined;
    return await connection.client.ask(interactionId, AbortSignal.timeout(INFO_TIMEOUT_MS));
  }

  async submitAsk(
    threadId: string,
    interactionId: string,
    answers: readonly ChannelAskAnswer[],
  ): Promise<ChannelAskSubmissionResult> {
    const thread = this.store.getThread(threadId);
    if (thread === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    const connection = this.connections.get(thread.sourceId);
    if (connection === undefined || !connection.info.supportsAskUser) {
      throw new WebConsoleError("ask_user_unavailable", "This agent does not support interactive questions.", 409);
    }
    const conversationId = this.store.cronConversationIdForThread(thread.id) ?? `web:${thread.id}`;
    const result = await connection.client.submitAsk(conversationId, interactionId, answers);
    if (result.accepted) this.store.staleWebPushEvent(`ask:${interactionId}`, "answered");
    return result;
  }

  patchThread(id: string, patch: PatchWebThreadInput): WebThread {
    if (patch.ifRunConfigUnset === true) {
      // Compare-and-set for the console's one-time adoption of a browser-local
      // override. Whoever set an override first keeps it; the loser adopts what
      // it reads back, and no event is emitted because nothing changed.
      //
      // The check and the write are one `BEGIN IMMEDIATE` inside the store, not
      // two calls from here: this request handler is synchronous, so no other
      // HTTP request can interleave, but the process lease is held on a
      // separate database file and does not stop a second connection to the
      // state DB from writing between a bare read and a bare write.
      const result = this.store.patchThreadIfRunConfigUnset(id, patch);
      if (!result.applied) return result.thread;
      this.emitThread("thread.changed", { thread: result.thread });
      this.emitThread("threads.changed", { thread: result.thread });
      return result.thread;
    }
    const thread = this.store.patchThread(id, patch);
    this.emitThread("thread.changed", { thread });
    this.emitThread("threads.changed", { thread });
    return thread;
  }

  async deleteThread(id: string): Promise<void> {
    const resolved = this.store.getThread(id)?.id;
    if (resolved === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    if (this.activeTurns.has(resolved)) {
      throw new WebConsoleError("turn_active", "Cancel the active turn before deleting this conversation.", 409);
    }
    const result = await this.store.deleteArchivedThread(resolved);
    if (result.orphanedFiles > 0) {
      this.options.logger?.warn?.("Deleted a web conversation with attachment files deferred to orphan cleanup.", {
        threadId: resolved,
        count: result.orphanedFiles,
      });
    }
    this.emitThread("thread.changed", { threadId: resolved, removed: true });
    this.emitThread("threads.changed", { threadId: resolved, removed: true });
  }

  patchAgent(sourceId: string, patch: PatchWebAgentInput): WebAgentSummary {
    const agent = this.store.setAgentPinned(sourceId, patch.pinned);
    // A pin says exactly what it changed. The payload-less form means "discovery
    // saw something move", which costs every open console a bootstrap plus its
    // skills and cron -- for one boolean the pinning tab already applied from
    // this call's own response.
    const payload: WebAgentsChangedPayload = { sourceId: agent.sourceId, pinned: agent.pinned === true };
    this.emit("agents.changed", undefined, payload);
    return agent;
  }

  agentSkills(sourceId: string): WebSkillRegistry {
    const agent = this.store.getAgent(sourceId);
    if (agent === undefined) throw new WebConsoleError("agent_not_found", "Agent not found.", 404);
    const connection = this.connections.get(sourceId);
    if (connection === undefined || agent.status === "offline") {
      return { status: "offline", items: [] };
    }
    return connection.info.skills ?? { status: "unsupported", items: [] };
  }

  async cronOverview(sourceId: string): Promise<WebCronOverview> {
    const agent = this.store.getAgent(sourceId);
    if (agent === undefined) throw new WebConsoleError("agent_not_found", "Agent not found.", 404);
    const connection = this.connections.get(sourceId);
    if (connection?.info.cron?.read === true) {
      const overview = await connection.client.cronOverview(AbortSignal.timeout(INFO_TIMEOUT_MS));
      const synced = this.store.syncCronOverviewResult({ sourceId, ...overview });
      if (synced.changed) {
        this.emit("cron.changed", undefined, { sourceId });
        this.emit("threads.changed");
      }
      return synced.overview;
    }
    const stored = this.store.storedCronOverview(sourceId);
    if (stored !== undefined) return { ...stored, actionsEnabled: false };
    throw new WebConsoleError(
      "cron_unavailable",
      "This agent does not expose first-class cron operator state.",
      404,
    );
  }

  async cronRuns(
    sourceId: string,
    jobId: string,
    input: { readonly limit: number; readonly before?: string },
  ): Promise<WebCronRunPage> {
    const agent = this.store.getAgent(sourceId);
    if (agent === undefined) throw new WebConsoleError("agent_not_found", "Agent not found.", 404);
    const connection = this.connections.get(sourceId);
    if (connection?.info.cron?.read !== true) {
      if (this.store.cronThread(sourceId, jobId) === undefined) {
        throw new WebConsoleError("cron_job_not_found", "Cron job not found for this agent.", 404);
      }
      if (input.before !== undefined) return { runs: [] };
      const stored = this.store.storedCronRuns(sourceId, jobId, input.limit);
      return stored.messages === undefined
        ? stored
        : { ...stored, messages: stored.messages.map((message) => this.shapeMessage(message)) };
    }
    const page = await connection.client.cronRuns(jobId, {
      limit: input.limit,
      ...(input.before === undefined ? {} : { before: input.before }),
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    const reconciled = this.store.reconcileCronRunsResult(sourceId, jobId, page.runs);
    if (reconciled.changed) {
      this.emitStoredThread(this.store.cronThread(sourceId, jobId)?.id, ["thread.changed", "threads.changed"]);
    }
    return { ...page, messages: reconciled.messages.map((message) => this.shapeMessage(message)) };
  }

  async cronRun(sourceId: string, jobId: string, runId: string): Promise<WebMessage> {
    const connection = this.requireCronConnection(sourceId, false);
    const run = await connection.client.cronRun(jobId, runId, AbortSignal.timeout(INFO_TIMEOUT_MS));
    const reconciled = this.store.reconcileCronRunsResult(sourceId, jobId, [run]);
    const message = reconciled.messages[0];
    if (message === undefined) {
      throw new WebConsoleError("invalid_operator_cron", "Cron detail did not reconcile a message.", 502);
    }
    if (reconciled.changed) {
      this.emitStoredThread(message.threadId, ["thread.changed", "threads.changed"]);
    }
    return this.shapeMessage(message);
  }

  async agentModels(sourceId: string, input: {
    readonly provider?: string;
    readonly q?: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<WebModelPage> {
    const agent = this.store.getAgent(sourceId);
    if (agent === undefined) throw new WebConsoleError("agent_not_found", "Agent not found.", 404);
    const connection = this.connections.get(sourceId);
    if (connection === undefined) throw new WebConsoleError("agent_offline", "This agent is offline.", 409);
    const generation = this.modelCatalogCache.get(sourceId)?.generation;
    const page = await connection.client.models({
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.q === undefined ? {} : { q: input.q }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: input.limit,
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    // Every proxied page widens the per-agent catalog cache, the only feed
    // (besides `modelOptions` keys) that makes tier-2 model admission possible,
    // and the only place the effort ladder a catalog model advertises is ever
    // seen -- `modelOptions` never describes it, so dropping it here is what
    // left effort validation with nothing to judge against.
    //
    // Admitted under the generation the request was ISSUED under, never under
    // whatever is current when it answers. A discovery refresh can retire this
    // agent's generation inside the await above, and keyed by source id alone
    // the reply -- fetched from a process that is gone -- was written straight
    // into the freshly reconciled map, where `source: "page"` overwrites
    // unconditionally. Generation 1's ladder then judged generation 2's turns.
    this.admitCatalogRefs(sourceId, generation, page.models.flatMap((model) => {
      const record: CatalogModelRecord = { source: "page", efforts: advertisedEffortLevels(model) };
      // The wire carries provider-local ids while every selection surface
      // speaks the canonical `<provider>:<model>` reference. Admit both, or a
      // turn is judged against metadata the page did advertise but under a
      // name nothing ever asks for.
      const reference = model.provider ? `${model.provider}:${model.id}` : model.id;
      const entries: (readonly [string, CatalogModelRecord])[] = [[model.id, record]];
      if (reference !== model.id) entries.push([reference, record]);
      return entries;
    }));
    return page;
  }

  async cronConfigView(sourceId: string): Promise<WebChannelConfigView> {
    const connection = this.requireCronConnection(sourceId, false);
    return await connection.client.cronConfigView(AbortSignal.timeout(INFO_TIMEOUT_MS));
  }

  async cronRunNow(
    sourceId: string,
    jobId: string,
    input: { readonly idempotencyKey: string; readonly confirmationToken?: string },
  ): Promise<WebCronMutationResult<{ readonly run: WebCronRunSummary }>> {
    const connection = this.requireCronConnection(sourceId, true);
    const result = await connection.client.cronRunNow(jobId, input, AbortSignal.timeout(INFO_TIMEOUT_MS));
    if (result.kind === "completed") {
      const reconciled = this.store.reconcileCronRunsResult(sourceId, jobId, [result.value.run]);
      if (reconciled.changed) {
        this.emitStoredThread(this.store.cronThread(sourceId, jobId)?.id, ["thread.changed", "threads.changed"]);
      }
    }
    return result;
  }

  async cronSetEffectiveEnabled(
    sourceId: string,
    jobId: string,
    enabled: boolean,
    input: { readonly idempotencyKey: string; readonly confirmationToken?: string },
  ): Promise<WebCronMutationResult<{ readonly job: WebCronOverview["jobs"][number] }>> {
    const connection = this.requireCronConnection(sourceId, true);
    const result = await connection.client.cronSetEffectiveEnabled(
      jobId,
      enabled,
      input,
      AbortSignal.timeout(INFO_TIMEOUT_MS),
    );
    if (result.kind === "confirmation_required") return result;
    const refreshed = await connection.client.cronOverview(AbortSignal.timeout(INFO_TIMEOUT_MS));
    const synced = this.store.syncCronOverviewResult({ sourceId, ...refreshed });
    const overview = synced.overview;
    const job = overview.jobs.find((candidate) => candidate.jobId === jobId);
    if (job === undefined) throw new WebConsoleError("invalid_operator_cron", "Updated cron job disappeared.", 502);
    if (synced.changed) {
      this.emit("cron.changed", job.threadId, { sourceId, jobId });
      this.emitStoredThread(job.threadId, ["thread.changed", "threads.changed"]);
    }
    return { ...result, value: { job } };
  }

  async deliverNotification(input: DeliverWebNotificationInput): Promise<DeliverWebNotificationResult> {
    if (this.stopped) {
      throw new WebConsoleError("web_service_stopping", "The web service is stopping.", 409);
    }
    // Monitor wakes are addressed to a retained thread, so they must reach the
    // wake-specific retry/abandon path even after discovery has removed the
    // source from the picker. New source-scoped deliveries still refresh before
    // the store decides whether the agent exists.
    if (input.triggerKind !== "monitor" && this.store.getAgent(input.sourceId) === undefined) {
      await this.refreshAgents();
    }
    if (this.stopped) {
      throw new WebConsoleError("web_service_stopping", "The web service is stopping.", 409);
    }
    if (input.triggerKind === "monitor") {
      assertMonitorWakeAddress(input);
      const thread = this.store.getThread(input.threadId);
      if (thread === undefined || thread.sourceId !== input.sourceId) {
        return {
          duplicate: true,
          tombstoned: true,
          delivery: { delivered: false, code: "monitor_origin_mismatch", retryable: false },
        };
      }
      if (thread.archivedAt !== null || thread.trigger !== undefined) {
        return {
          thread,
          duplicate: false,
          delivery: { delivered: false, code: "monitor_wake_failed", retryable: false },
        };
      }
      const result = await this.deliverMonitorWake(input);
      return { thread, duplicate: result.duplicate, delivery: result.receipt };
    }
    if (input.triggerKind === "job") {
      // Destructured off: the card's message id is how this service addresses
      // the invalidation, and it is not part of the delivery result on the wire.
      const { messageId, ...completed } = this.store.upsertProcessJobCard({
        sourceId: input.sourceId,
        threadId: input.threadId,
        deliveryKey: input.deliveryKey,
        processJob: input.processJob,
        ...(input.text === undefined ? {} : { responseText: input.text }),
        ...(input.parts === undefined ? {} : { replyParts: input.parts }),
      });
      // Addressed, not searched. Scanning a page of the conversation meant a job
      // that finished behind thirty later messages emitted no invalidation at
      // all, and its card sat at "running" until something else forced a read.
      const message = this.store.getMessage(messageId);
      if (!completed.duplicate && message !== undefined) {
        this.emit("message.changed", input.threadId, { messageId: message.id, updatedAt: message.updatedAt });
      }
      // Read back rather than trusted: the shared notification result leaves the
      // conversation optional, and an event that carries `undefined` is exactly
      // the bare event this normalisation exists to remove.
      this.emitStoredThread(input.threadId, ["threads.changed", "thread.changed"]);
      if (input.wakePrompt === undefined) return completed;
      if (this.connections.get(input.sourceId) === undefined) await this.refreshAgents();
      if (this.stopped) {
        throw new WebConsoleError("web_service_stopping", "The web service is stopping.", 409);
      }
      const delivery = await this.deliverProcessJobWake(
        input as DeliverWebProcessJobNotificationInput & { readonly wakePrompt: string },
      );
      return { ...completed, delivery };
    }
    const reservation = this.store.reserveNotification(input);
    if (reservation.duplicate) return this.store.completeNotification(reservation);

    const activeKey = `${input.sourceId}\0${input.deliveryKey}`;
    const existing = this.activeNotifications.get(activeKey);
    if (existing !== undefined) return existing;
    const delivery = this.deliverNotificationOnce(reservation).finally(() => {
      this.activeNotifications.delete(activeKey);
    });
    this.activeNotifications.set(activeKey, delivery);
    return delivery;
  }

  /** Proxy one authenticated retained card to its exact agent/thread owner. */
  async threadJob(threadId: string, jobId: string): Promise<ProcessJobProjection> {
    const thread = this.store.getThread(threadId);
    if (thread === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    if (!this.store.processJobCardBelongsToThread(thread.sourceId, threadId, jobId)) {
      throw new WebConsoleError("process_job_not_found", "Process job was not found for this conversation.", 404);
    }
    const connection = this.connections.get(thread.sourceId);
    if (connection === undefined || connection.info.supportsJobs !== true) {
      throw new WebConsoleError("process_jobs_unavailable", "Process jobs are unavailable for this agent.", 409);
    }
    const job = await connection.client.getJob(jobId, AbortSignal.timeout(INFO_TIMEOUT_MS));
    if (job.jobId !== jobId
      || job.origin.channel !== "web"
      || job.origin.conversationId.split("#", 1)[0] !== `web:${threadId}`) {
      throw new WebConsoleError("process_job_not_found", "Process job was not found for this conversation.", 404);
    }
    return job;
  }

  async startTurn(threadId: string, input: StartWebTurnInput): Promise<{ readonly thread: WebThread; readonly turn: WebThread["runState"] }> {
    const text = input.text ?? "";
    const operatorText = input.quote === undefined ? text : formatQuotedTurn(input.quote.text, text);
    if (operatorText.length > WEB_MAX_TURN_TEXT_CHARACTERS) {
      throw new WebConsoleError(
        "turn_text_too_large",
        `The message and quote may contain at most ${WEB_MAX_TURN_TEXT_CHARACTERS} characters after formatting.`,
        413,
      );
    }
    const attachmentIds = input.attachmentIds ?? [];
    const thread = this.store.getThread(threadId);
    if (thread === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    threadId = thread.id;
    const agent = this.store.getAgent(thread.sourceId);
    const connection = this.connections.get(thread.sourceId);
    if (thread.trigger?.kind === "cron") throw cronChannelReadOnlyError();
    if (agent === undefined || connection === undefined || !thread.canSend) {
      throw new WebConsoleError("agent_offline", "This agent is offline. The conversation remains available read-only.", 409);
    }
    // The per-thread override is server state now, so it governs turns this
    // server starts too -- process-job follow-ups and other assistant-owned
    // wakes omit model/effort and would otherwise silently run on the agent
    // default, ignoring the selection made in that very conversation. An
    // explicit request value still wins.
    const model = input.model ?? thread.runModel ?? undefined;
    const effort = input.effort ?? thread.runEffort ?? undefined;
    this.validateModelAndEffort(thread.sourceId, agent, model, effort);
    const started = this.store.beginTurn({ threadId, text, attachmentIds, ...(input.quote === undefined ? {} : { quote: input.quote }), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) });
    this.launchTurn(started, connection.client, operatorText);
    this.emit("turn.changed", threadId, { turn: started.thread.runState });
    this.emitThread("threads.changed", { thread: started.thread });
    return { thread: started.thread, turn: started.thread.runState };
  }

  submitLiveInput(threadId: string, text: string): WebLiveInputReceipt {
    if (this.stopped) {
      throw new WebConsoleError("web_service_stopping", "The web service is stopping.", 409);
    }
    const thread = this.store.getThread(threadId);
    if (thread === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    threadId = thread.id;
    const connection = this.connections.get(thread.sourceId);
    const active = this.activeTurns.get(threadId);
    const reserved = this.store.reserveLiveInput(threadId, text);
    this.emit("message.changed", threadId, { messageId: reserved.message.id, updatedAt: reserved.message.updatedAt });
    this.emitThread("threads.changed", { thread: reserved.thread });

    if (!reserved.offered || active === undefined || connection === undefined || !connection.info.supportsLiveInput) {
      const queued = reserved.offered ? this.store.queueLiveInput(reserved.input.id) ?? reserved.message : reserved.message;
      this.emit("message.changed", threadId, { messageId: queued.id, updatedAt: queued.updatedAt });
      void this.drainQueuedLiveInputs(threadId);
      return { message: queued, disposition: "queued" };
    }

    const controller = new AbortController();
    const completion = this.deliverLiveInput(
      reserved.input.id,
      threadId,
      active.client,
      controller,
      {
        conversationId: `web:${threadId}`,
        id: reserved.input.id,
        text: reserved.input.text,
        receivedAt: reserved.input.createdAt,
      },
    ).finally(() => {
      this.activeLiveInputs.delete(reserved.input.id);
    });
    this.activeLiveInputs.set(reserved.input.id, { threadId, controller, completion });
    return { message: reserved.message, disposition: "pending" };
  }

  async cancelTurn(threadId: string): Promise<WebThread> {
    const resolved = this.store.getThread(threadId)?.id;
    if (resolved === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    threadId = resolved;
    const active = this.activeTurns.get(threadId);
    const stored = this.store.activeTurn(threadId);
    if (stored === undefined) throw new WebConsoleError("no_active_turn", "This conversation has no active turn.", 409);
    const reason = createChannelUserCancelReason("Web");
    const liveInputs = [...this.activeLiveInputs.entries()]
      .filter(([, input]) => input.threadId === threadId);
    const cancelledInputs = this.store.cancelLiveInputs(threadId);
    for (const message of cancelledInputs) {
      this.emit("message.changed", threadId, { messageId: message.id, updatedAt: message.updatedAt });
    }
    for (const [, input] of liveInputs) {
      input.controller.abort(reason);
    }
    if (active !== undefined) {
      await active.client.cancel(stored.conversationId).catch((error: unknown) => {
        this.options.logger?.debug?.("Web turn cancel request failed.", { error: errorMessage(error) });
      });
      active.controller.abort(reason);
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
    const askWatches = [...this.askWatches.values()];
    for (const watch of askWatches) watch.controller.abort(new Error("Web service is stopping."));
    const active = [...this.activeTurns.values()];
    const activeLiveInputs = [...this.activeLiveInputs.entries()];
    const activeNotifications = [...this.activeNotifications.values()];
    const activeHostWakes = [...this.activeHostWakes.values()];
    const trackedIds = new Set(active.map((turn) => turn.turnId));
    for (const turnId of this.store.listActiveTurnIds()) {
      if (!trackedIds.has(turnId)) this.store.interruptTurn(turnId);
    }
    for (const turn of active) {
      this.store.interruptTurn(turn.turnId);
      turn.controller.abort(new WebTurnCancellation("shutdown", "Web service is stopping."));
    }
    for (const [id, input] of activeLiveInputs) {
      this.store.queueLiveInput(id);
      input.controller.abort(new WebTurnCancellation("shutdown", "Web service is stopping."));
    }
    await Promise.allSettled(active.map((turn) => turn.completion));
    await Promise.allSettled(activeLiveInputs.map(([, input]) => input.completion));
    await Promise.allSettled(activeHostWakes);
    await Promise.allSettled(activeNotifications);
    await Promise.allSettled(askWatches.map((watch) => watch.promise));
    await this.pushDispatcher.stopAndDrain(5_000);
    if (pendingRefresh !== undefined) await pendingRefresh.catch(() => undefined);
    if (pendingPurge !== undefined) await pendingPurge.catch(() => undefined);
    this.subscribers.clear();
    this.store.close();
    await this.lease.release();
  }

  private async runTurn(
    started: StoredTurnExecution,
    client: OperatorClient,
    controller: AbortController,
    operatorText: string,
    hostWakeDeliveryKey?: string,
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
        text: operatorText,
        attachments,
        signal: controller.signal,
        metadata: {
          web: {
            threadId: started.thread.id,
            turnId: started.turnId,
            ...modelMetadata,
            ...(hostWakeDeliveryKey === undefined && this.store.canApplyAgentTitle(started.thread.id)
              ? { conversationTitle: { schema: 1, writable: true } }
              : {}),
          },
          tui: modelMetadata,
        },
        ...(hostWakeDeliveryKey === undefined ? {} : { processJobWakeDeliveryKey: hostWakeDeliveryKey }),
        onFrame: (frame) => {
          this.observeAskUserFrame(started.thread.id, started.turnId, frame);
          this.observeConversationTitleFrame(started.thread.id, started.turnId, frame);
          coalescer.push(frame);
        },
      });
      await coalescer.flush();
      const silentMonitorWake = hostWakeDeliveryKey?.startsWith("monitor:") === true
        && (response.finalText === undefined || response.finalText.length === 0)
        && (response.parts === undefined || response.parts.length === 0);
      const detail = this.store.completeTurn(
        started.turnId,
        response.finalText,
        response.metadata,
        response.parts,
        {
          suppressResponsePush: silentMonitorWake,
          ...(hostWakeDeliveryKey === undefined ? {} : { monitorWakeDeliveryKey: hostWakeDeliveryKey }),
        },
      );
      this.emit("turn.changed", started.thread.id, { turn: detail.thread.runState });
      this.emitThread("thread.changed", { thread: detail.thread });
      this.emitThread("threads.changed", { thread: detail.thread });
      this.announcePushEvent(`turn:${started.turnId}:terminal`);
      // Detached: the turn is already finished and reported, and keeping a copy
      // must neither delay nor fail it. The agent is still connected here, which
      // is when a fetch is most likely to succeed.
      void this.persistReplyImages(started.thread.id, detail.messages);
    } catch (error) {
      let failure = error;
      try {
        await coalescer.flush();
      } catch (flushError) {
        failure = flushError;
      }
      const cancelled = isChannelUserCancelReason(controller.signal.reason)
        || controller.signal.reason instanceof WebTurnCancellation
        || (error as { cancelled?: unknown }).cancelled === true;
      const code = errorCode(failure);
      const detail = this.store.failTurn(started.turnId, {
        message: cancelled ? "Turn cancelled." : errorMessage(failure),
        ...(code === undefined ? {} : { code }),
        cancelled,
      });
      this.emit("turn.changed", started.thread.id, { turn: detail.thread.runState });
      this.emitThread("thread.changed", { thread: detail.thread });
      this.emitThread("threads.changed", { thread: detail.thread });
      this.announcePushEvent(`turn:${started.turnId}:terminal`);
    } finally {
      releaseAttachmentBudget?.();
      coalescer.close();
    }
  }

  private launchTurn(
    started: StoredTurnExecution,
    client: OperatorClient,
    operatorText: string,
    hostWakeDeliveryKey?: string,
  ): Promise<void> {
    const threadId = started.thread.id;
    const controller = new AbortController();
    const completion = this.runTurn(
      started,
      client,
      controller,
      operatorText,
      hostWakeDeliveryKey,
    ).finally(() => {
      const active = this.activeTurns.get(threadId);
      if (active?.turnId === started.turnId) this.activeTurns.delete(threadId);
      if (!this.stopped && !this.hostWakeReservations.has(threadId)) {
        void this.drainQueuedLiveInputs(threadId);
      }
    });
    this.activeTurns.set(threadId, { turnId: started.turnId, controller, client, completion });
    return completion;
  }

  private async deliverLiveInput(
    id: string,
    threadId: string,
    client: OperatorClient,
    controller: AbortController,
    input: Omit<Parameters<OperatorClient["liveInput"]>[0], "signal">,
  ): Promise<void> {
    let queued = false;
    let changedMessage: ReturnType<WebStore["markLiveInputApplied"]>;
    try {
      const result = await client.liveInput({ ...input, signal: controller.signal });
      if (result.status === "applied") {
        changedMessage = this.store.markLiveInputApplied(id);
      } else if (result.status === "discarded") {
        changedMessage = this.store.cancelLiveInput(id);
      } else {
        changedMessage = this.store.queueLiveInput(id);
        queued = changedMessage !== undefined;
      }
    } catch (error) {
      changedMessage = this.store.queueLiveInput(id);
      queued = changedMessage !== undefined;
      if (!controller.signal.aborted) {
        this.options.logger?.debug?.("Web live-input delivery failed; queued as a turn.", {
          threadId,
          error: errorMessage(error),
        });
      }
    }
    if (changedMessage !== undefined) {
      this.emit("message.changed", threadId, {
        messageId: changedMessage.id,
        updatedAt: changedMessage.updatedAt,
      });
    }
    this.emitStoredThread(threadId, ["threads.changed"]);
    if (queued && !this.stopped) await this.drainQueuedLiveInputs(threadId);
  }

  private async drainQueuedLiveInputs(threadId: string): Promise<void> {
    if (this.stopped
      || this.activeTurns.has(threadId)
      || this.hostWakeReservations.has(threadId)
      || this.drainingLiveInputThreads.has(threadId)) return;
    this.drainingLiveInputThreads.add(threadId);
    try {
      const thread = this.store.getThread(threadId);
      if (thread === undefined || thread.archivedAt !== null || !thread.canSend) return;
      const connection = this.connections.get(thread.sourceId);
      if (connection === undefined) return;
      const started = this.store.promoteNextQueuedLiveInput(threadId);
      if (started === undefined) return;
      this.launchTurn(started, connection.client, started.text);
      this.emit("message.changed", threadId, {
        messageId: started.assistantMessageId,
        updatedAt: started.thread.updatedAt,
      });
      this.emit("turn.changed", threadId, { turn: started.thread.runState });
      this.emitThread("threads.changed", { thread: started.thread });
    } finally {
      this.drainingLiveInputThreads.delete(threadId);
    }
  }

  private async deliverProcessJobWake(
    input: DeliverWebProcessJobNotificationInput & { readonly wakePrompt: string },
  ): Promise<HostWakeReceipt> {
    const activeKey = `${input.sourceId}\0${input.deliveryKey}`;
    const existing = this.activeHostWakes.get(activeKey);
    if (existing !== undefined) return await existing;

    const reservation = this.store.reserveProcessJobWake({
      sourceId: input.sourceId,
      threadId: input.threadId,
      jobId: input.processJob.jobId,
      deliveryKey: input.deliveryKey,
    });
    if (reservation.kind === "completed") {
      return { delivered: true, disposition: reservation.disposition };
    }
    if (reservation.kind === "uncertain") {
      return {
        delivered: false,
        code: "process_job_wake_ambiguous",
        retryable: false,
        ambiguous: true,
      };
    }

    this.retainHostWakeReservation(input.threadId);
    const previous = this.hostWakeTails.get(input.threadId) ?? Promise.resolve();
    const delivery = previous.catch(() => undefined).then(async (): Promise<HostWakeReceipt> => {
      const connection = this.connections.get(input.sourceId);
      if (connection === undefined) {
        this.store.abandonProcessJobWake({
          sourceId: input.sourceId,
          jobId: input.processJob.jobId,
          deliveryKey: input.deliveryKey,
        });
        return { delivered: false, code: "destination_channel_unavailable", retryable: true };
      }
      const active = this.activeTurns.get(input.threadId);
      if (active !== undefined && connection.info.supportsLiveInput) {
        try {
          const settlement = await active.client.liveInput({
            conversationId: `web:${input.threadId}`,
            id: input.deliveryKey,
            text: input.wakePrompt,
            receivedAt: new Date().toISOString(),
            deliveryKey: input.deliveryKey,
            signal: AbortSignal.timeout(10 * 60 * 1_000),
          });
          if (settlement.status === "applied") {
            this.store.completeProcessJobWake({
              sourceId: input.sourceId,
              jobId: input.processJob.jobId,
              deliveryKey: input.deliveryKey,
              disposition: "steered",
            });
            return { delivered: true, disposition: "steered" };
          }
        } catch (error) {
          this.options.logger?.warn?.("Web process-job steering outcome is unknown; automatic fallback is suppressed.", {
            threadId: input.threadId,
            error: errorMessage(error),
          });
          return {
            delivered: false,
            code: "process_job_wake_ambiguous",
            retryable: false,
            ambiguous: true,
          };
        }
      }

      if (active !== undefined) await active.completion;
      if (this.stopped) {
        this.store.abandonProcessJobWake({
          sourceId: input.sourceId,
          jobId: input.processJob.jobId,
          deliveryKey: input.deliveryKey,
        });
        return { delivered: false, code: "destination_channel_unavailable", retryable: true };
      }
      const refreshedConnection = this.connections.get(input.sourceId);
      if (refreshedConnection === undefined) {
        this.store.abandonProcessJobWake({
          sourceId: input.sourceId,
          jobId: input.processJob.jobId,
          deliveryKey: input.deliveryKey,
        });
        return { delivered: false, code: "destination_channel_unavailable", retryable: true };
      }
      let started;
      try {
        started = this.store.beginAssistantTurn({
          threadId: input.threadId,
          prompt: input.wakePrompt,
        });
      } catch (error) {
        this.store.abandonProcessJobWake({
          sourceId: input.sourceId,
          jobId: input.processJob.jobId,
          deliveryKey: input.deliveryKey,
        });
        return {
          delivered: false,
          code: errorCode(error) ?? "process_job_wake_failed",
          retryable: false,
        };
      }
      const completion = this.launchTurn(
        started,
        refreshedConnection.client,
        input.wakePrompt,
        input.deliveryKey,
      );
      this.emit("message.changed", input.threadId, {
        messageId: started.assistantMessageId,
        updatedAt: started.thread.updatedAt,
      });
      this.emit("turn.changed", input.threadId, { turn: started.thread.runState });
      this.emitThread("threads.changed", { thread: started.thread });
      await completion;
      if (this.store.turnStatus(started.turnId) !== "complete") {
        return {
          delivered: false,
          code: "process_job_wake_failed",
          retryable: false,
          ambiguous: true,
        };
      }
      this.store.completeProcessJobWake({
        sourceId: input.sourceId,
        jobId: input.processJob.jobId,
        deliveryKey: input.deliveryKey,
        disposition: "follow_up",
        turnId: started.turnId,
      });
      return { delivered: true, disposition: "follow_up" };
    });
    const tail = delivery.then(() => undefined, () => undefined);
    this.hostWakeTails.set(input.threadId, tail);
    this.activeHostWakes.set(activeKey, delivery);
    try {
      return await delivery;
    } finally {
      if (this.hostWakeTails.get(input.threadId) === tail) {
        this.hostWakeTails.delete(input.threadId);
      }
      if (this.activeHostWakes.get(activeKey) === delivery) {
        this.activeHostWakes.delete(activeKey);
      }
      this.releaseHostWakeReservation(input.threadId);
    }
  }

  private async deliverMonitorWake(
    input: DeliverWebMonitorNotificationInput,
  ): Promise<{ readonly receipt: HostWakeReceipt; readonly duplicate: boolean }> {
    const activeKey = `${input.sourceId}\0${input.deliveryKey}`;
    const reservation = this.store.reserveMonitorWake({
      sourceId: input.sourceId,
      threadId: input.threadId,
      monitorId: input.monitor.monitorId,
      deliveryKey: input.deliveryKey,
      payloadSha256: monitorWakePayloadSha256(input.monitor, input.wakePrompt),
      monitor: input.monitor,
    });
    if (reservation.kind === "completed") {
      return {
        receipt: { delivered: true, disposition: reservation.disposition },
        duplicate: true,
      };
    }
    if (reservation.kind === "uncertain") {
      const existing = this.activeHostWakes.get(activeKey);
      if (existing !== undefined) return { receipt: await existing, duplicate: true };
      return {
        receipt: {
          delivered: false,
          code: "monitor_wake_ambiguous",
          retryable: false,
          ambiguous: true,
        },
        duplicate: true,
      };
    }

    this.retainHostWakeReservation(input.threadId);
    const previous = this.hostWakeTails.get(input.threadId) ?? Promise.resolve();
    const delivery = previous.catch(() => undefined).then(async (): Promise<HostWakeReceipt> => {
      const abandon = (): void => this.store.abandonMonitorWake({
        sourceId: input.sourceId,
        monitorId: input.monitor.monitorId,
        deliveryKey: input.deliveryKey,
      });
      let connection = this.connections.get(input.sourceId);
      if (connection === undefined) {
        try {
          await this.refreshAgents();
        } catch (error) {
          abandon();
          this.options.logger?.debug?.("Web Monitor destination refresh failed before delivery.", {
            threadId: input.threadId,
            monitorId: input.monitor.monitorId,
            error: errorMessage(error),
          });
          return { delivered: false, code: "destination_channel_unavailable", retryable: true };
        }
        connection = this.connections.get(input.sourceId);
      }
      if (this.stopped || connection === undefined) {
        abandon();
        return { delivered: false, code: "destination_channel_unavailable", retryable: true };
      }
      const destination = this.store.getThread(input.threadId);
      if (destination === undefined
        || destination.sourceId !== input.sourceId
        || destination.archivedAt !== null
        || destination.trigger !== undefined) {
        abandon();
        return { delivered: false, code: "monitor_origin_mismatch", retryable: false };
      }
      const active = this.activeTurns.get(input.threadId);
      if (active !== undefined
        && connection.info.supportsLiveInput
        && input.wakePrompt.length <= AGENT_LIVE_INPUT_MAX_CHARACTERS) {
        try {
          this.store.setMonitorWakeSteeringTurn(input.sourceId, input.deliveryKey, active.turnId, true);
          const settlement = await active.client.liveInput({
            conversationId: `web:${input.threadId}`,
            id: input.deliveryKey,
            text: input.wakePrompt,
            receivedAt: new Date().toISOString(),
            deliveryKey: input.deliveryKey,
            signal: AbortSignal.timeout(10 * 60 * 1_000),
          });
          if (settlement.status === "applied") {
            const message = this.store.completeMonitorWake({
              sourceId: input.sourceId,
              monitorId: input.monitor.monitorId,
              deliveryKey: input.deliveryKey,
              disposition: "steered",
              turnId: active.turnId,
            });
            if (message !== undefined) {
              this.emit("message.changed", input.threadId, { messageId: message.id, updatedAt: message.updatedAt });
            }
            return { delivered: true, disposition: "steered" };
          }
          this.store.setMonitorWakeSteeringTurn(input.sourceId, input.deliveryKey, active.turnId, false);
        } catch (error) {
          this.options.logger?.warn?.("Web Monitor steering outcome is unknown; automatic fallback is suppressed.", {
            threadId: input.threadId,
            monitorId: input.monitor.monitorId,
            error: errorMessage(error),
          });
          return {
            delivered: false,
            code: "monitor_wake_ambiguous",
            retryable: false,
            ambiguous: true,
          };
        }
      }

      if (active !== undefined) await active.completion;
      if (this.stopped) {
        abandon();
        return { delivered: false, code: "destination_channel_unavailable", retryable: true };
      }
      const refreshedConnection = this.connections.get(input.sourceId);
      if (refreshedConnection === undefined) {
        abandon();
        return { delivered: false, code: "destination_channel_unavailable", retryable: true };
      }
      let started;
      try {
        started = this.store.beginAssistantTurn({
          threadId: input.threadId,
          prompt: input.wakePrompt,
          storedPrompt: "[Monitor wake]",
        });
      } catch (error) {
        abandon();
        return {
          delivered: false,
          code: errorCode(error) ?? "monitor_wake_failed",
          retryable: false,
        };
      }
      const completion = this.launchTurn(
        started,
        refreshedConnection.client,
        input.wakePrompt,
        input.deliveryKey,
      );
      this.emit("message.changed", input.threadId, {
        messageId: started.assistantMessageId,
        updatedAt: started.thread.updatedAt,
      });
      this.emit("turn.changed", input.threadId, { turn: started.thread.runState });
      this.emitThread("threads.changed", { thread: started.thread });
      await completion;
      if (this.store.turnStatus(started.turnId) !== "complete") {
        return {
          delivered: false,
          code: "monitor_wake_failed",
          retryable: false,
          ambiguous: true,
        };
      }
      const message = this.store.completeMonitorWake({
        sourceId: input.sourceId,
        monitorId: input.monitor.monitorId,
        deliveryKey: input.deliveryKey,
        disposition: "follow_up",
        turnId: started.turnId,
      });
      if (message !== undefined) {
        this.emit("message.changed", input.threadId, { messageId: message.id, updatedAt: message.updatedAt });
      }
      return { delivered: true, disposition: "follow_up" };
    });
    const tail = delivery.then(() => undefined, () => undefined);
    this.hostWakeTails.set(input.threadId, tail);
    this.activeHostWakes.set(activeKey, delivery);
    try {
      return { receipt: await delivery, duplicate: false };
    } finally {
      if (this.hostWakeTails.get(input.threadId) === tail) this.hostWakeTails.delete(input.threadId);
      if (this.activeHostWakes.get(activeKey) === delivery) this.activeHostWakes.delete(activeKey);
      this.releaseHostWakeReservation(input.threadId);
    }
  }

  private retainHostWakeReservation(threadId: string): void {
    this.hostWakeReservations.set(
      threadId,
      (this.hostWakeReservations.get(threadId) ?? 0) + 1,
    );
  }

  private releaseHostWakeReservation(threadId: string): void {
    const remaining = (this.hostWakeReservations.get(threadId) ?? 1) - 1;
    if (remaining > 0) this.hostWakeReservations.set(threadId, remaining);
    else this.hostWakeReservations.delete(threadId);
    if (!this.stopped) void this.drainQueuedLiveInputs(threadId);
  }

  private async deliverNotificationOnce(
    reservation: ReturnType<WebStore["reserveNotification"]>,
  ): Promise<DeliverWebNotificationResult> {
    let connection = this.connections.get(reservation.sourceId);
    if (connection === undefined) {
      await this.refreshAgents();
      connection = this.connections.get(reservation.sourceId);
    }
    if (connection === undefined) {
      throw new WebConsoleError("agent_offline", "The notification agent is offline.", 409);
    }
    if (!connection.info.supportsHistoryAppend) {
      throw new WebConsoleError(
        "history_record_unavailable",
        "The notification agent does not support durable history append.",
        409,
      );
    }
    await connection.client.recordVerbatim(
      this.store.notificationConversationId(reservation),
      reservation.text,
      reservation.deliveryKey,
    );
    const completed = this.store.completeNotification(reservation);
    if (completed.thread === undefined) {
      if (completed.tombstoned === true) return completed;
      throw new WebConsoleError("storage_corrupt", "A new notification completed without a conversation.", 500);
    }
    this.emitThread("threads.changed", { thread: completed.thread });
    this.emitThread("thread.changed", { thread: completed.thread });
    if (!completed.duplicate) {
      this.announcePushEvent(notificationPushLogicalKey(reservation.sourceId, reservation.deliveryKey));
    }
    return completed;
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
      const changed = this.store.markDiscoveredAgentsOffline();
      this.connections = new Map();
      if (changed) this.emit("agents.changed");
      return;
    }

    const nextConnections = new Map<string, AgentConnection>();
    // What the cache is allowed to survive: the same process, at the same
    // endpoint, since the same start. Anything else is a new generation whose
    // catalog the previous one cannot speak for.
    const generations = new Map(discovered.map((agent) => [
      agent.source.sourceId,
      agentGeneration(agent),
    ]));
    this.reconcileModelCatalogCache(generations);
    const summaries = await Promise.all(discovered.map(async (agent): Promise<WebAgentSummary> => {
      const generation = generations.get(agent.source.sourceId)!;
      if (agent.baseUrl === undefined) return offlineSummary(agent, generation);
      const client = new OperatorClient({
        baseUrl: agent.baseUrl,
        ...(agent.apiKey === undefined ? {} : { apiKey: agent.apiKey }),
        ...(agent.processJobsBearer === undefined ? {} : { processJobsBearer: agent.processJobsBearer }),
        ...(agent.monitorsBearer === undefined ? {} : { monitorsBearer: agent.monitorsBearer }),
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      });
      try {
        const info = await client.info(AbortSignal.any([signal, AbortSignal.timeout(INFO_TIMEOUT_MS)]));
        nextConnections.set(agent.source.sourceId, { client, info });
        this.seedModelCatalogFromOptions(agent.source.sourceId, generation, info.modelOptions);
        const efforts = collectEfforts(info);
        return {
          sourceId: agent.source.sourceId,
          generation,
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
          ...(info.providers === undefined ? {} : { providers: info.providers }),
          ...(info.cron === undefined ? {} : { cron: info.cron }),
          ...(info.supportsAskById ? { supportsAskById: true } : {}),
          updatedAt: agent.source.updatedAt,
        };
      } catch (error) {
        this.options.logger?.debug?.("Discovered agent operator probe failed.", {
          sourceId: agent.source.sourceId,
          error: errorMessage(error),
        });
        return offlineSummary(agent, generation);
      }
    }));
    this.connections = nextConnections;
    const agentsChanged = this.store.replaceAgents(summaries);
    const cronChangedSources = new Set<string>();
    await Promise.all([...nextConnections.entries()].map(async ([sourceId, connection]) => {
      if (connection.info.cron?.read !== true) return;
      try {
        const overview = await connection.client.cronOverview(
          AbortSignal.any([signal, AbortSignal.timeout(INFO_TIMEOUT_MS)]),
        );
        const synced = this.store.syncCronOverviewResult({ sourceId, ...overview });
        if (synced.changed) cronChangedSources.add(sourceId);
      } catch (error) {
        this.options.logger?.debug?.("Cron operator refresh failed; retaining the last authoritative snapshot.", {
          sourceId,
          error: errorMessage(error),
        });
      }
    }));
    if (agentsChanged) this.emit("agents.changed");
    for (const sourceId of cronChangedSources) this.emit("cron.changed", undefined, { sourceId });
    if (cronChangedSources.size > 0) this.emit("threads.changed");
    for (const threadId of this.store.queuedLiveInputThreadIds()) {
      void this.drainQueuedLiveInputs(threadId);
    }
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
    this.store.purgeWebPushState();
    const partialCount = await this.store.purgePartialUploadFiles(before);
    const count = await this.store.purgeStagedAttachments(before);
    const unreferencedCount = await this.store.purgeUnreferencedAttachmentFiles();
    if (count > 0 || partialCount > 0 || unreferencedCount > 0) {
      this.options.logger?.info?.("Purged orphaned web uploads.", { count, partialCount, unreferencedCount });
    }
  }

  /**
   * A listing event that names a conversation AND describes it.
   *
   * The id comes off the payload, so the two can never disagree: an event that
   * named one conversation while carrying another would have every console
   * apply the wrong row.
   */
  private emitThread(type: "thread.changed" | "threads.changed", payload: WebThreadChangedPayload): void {
    this.emit(type, "thread" in payload ? payload.thread.id : payload.threadId, payload);
  }

  /**
   * The same, for a write whose caller kept no snapshot of what it produced --
   * a cron reconcile, a live-input hand-off -- so the store is the only place
   * the fresh summary can come from.
   *
   * A conversation that is no longer there leaves nothing to describe, and the
   * bulk form is the only honest scope left for a listing that did change.
   */
  private emitStoredThread(
    threadId: string | undefined,
    types: readonly ("thread.changed" | "threads.changed")[],
  ): void {
    const thread = threadId === undefined ? undefined : this.store.getThread(threadId);
    if (thread === undefined) {
      this.emit("threads.changed");
      return;
    }
    for (const type of types) this.emitThread(type, { thread });
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

  private observeAskUserFrame(threadId: string, turnId: string, frame: AgentStreamWireFrame): void {
    if (this.stopped || frame.kind !== "event" || frame.event.type !== "tool_call_started"
      || toolNameLeaf(frame.event.name).toLowerCase().replace(/[^a-z0-9]+/gu, "") !== "askuser") return;
    const key = `${threadId}\0${turnId}`;
    if (this.askWatches.has(key)) return;
    const controller = new AbortController();
    let promise: Promise<void>;
    promise = this.watchForPendingAsk(threadId, turnId, controller.signal).finally(() => {
      if (this.askWatches.get(key)?.promise === promise) this.askWatches.delete(key);
    });
    this.askWatches.set(key, { controller, promise });
  }

  private observeConversationTitleFrame(threadId: string, turnId: string, frame: AgentStreamWireFrame): void {
    if (this.stopped || this.store.activeTurn(threadId)?.id !== turnId) return;
    const title = conversationTitleFromFrame(frame);
    if (title === undefined) return;
    try {
      const thread = this.store.applyAgentTitle(threadId, title);
      if (thread === undefined) return;
      this.emitThread("thread.changed", { thread });
      this.emitThread("threads.changed", { thread });
    } catch (error) {
      this.options.logger?.warn?.("Agent conversation-title update failed; the turn is continuing.", {
        threadId,
        turnId,
        error: errorMessage(error),
      });
    }
  }

  private async watchForPendingAsk(threadId: string, turnId: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + ASK_DISCOVERY_TIMEOUT_MS;
    let delayMs = 100;
    while (!this.stopped && !signal.aborted && Date.now() < deadline) {
      if (this.store.activeTurn(threadId)?.id !== turnId) return;
      const thread = this.store.getThread(threadId);
      const connection = thread === undefined ? undefined : this.connections.get(thread.sourceId);
      if (connection !== undefined && connection.info.supportsAskUser) {
        try {
          const snapshot = await connection.client.pendingAsk(
            this.store.cronConversationIdForThread(threadId) ?? `web:${threadId}`,
            AbortSignal.any([signal, AbortSignal.timeout(INFO_TIMEOUT_MS)]),
          );
          if (snapshot !== undefined) {
            if (isFuturePendingAsk(snapshot, this.currentDate())) {
              if (this.stopped || signal.aborted) return;
              this.enqueueAskPush(threadId, snapshot);
            }
            return;
          }
        } catch (error) {
          if (signal.aborted || this.stopped) return;
          this.options.logger?.debug?.("Web Push AskUser discovery retry failed.", {
            threadId,
            error: errorMessage(error),
          });
        }
      }
      await abortableDelay(delayMs, signal);
      delayMs = Math.min(1_000, delayMs * 2);
    }
  }

  private enqueueAskPush(threadId: string, snapshot: ChannelAskSnapshot): void {
    const question = snapshot.questions[snapshot.activeQuestionIndex];
    if (this.stopped || question === undefined || !isFuturePendingAsk(snapshot, this.currentDate())) return;
    const thread = this.store.getThread(threadId);
    if (thread === undefined) return;
    const agent = this.store.getAgent(thread.sourceId);
    const event = this.store.enqueueWebPushEvent({
      logicalKey: `ask:${snapshot.interactionId}`,
      kind: "input.required",
      threadId,
      sourceId: thread.sourceId,
      title: `${agent?.label ?? "mono-agent"} needs input`,
      body: `${question.header}: ${question.question}`,
      // Push delivery remains bounded even when the underlying AskUser wait is
      // unbounded. Expiring this notification does not expire the interaction.
      expiresAt: snapshot.expiresAt
        ?? new Date(this.currentDate().getTime() + ASK_PUSH_DELIVERY_TTL_MS).toISOString(),
    });
    if (event !== undefined) this.announcePushEvent(event.logicalKey);
  }

  private async pushEventStillRelevant(
    event: StoredWebPushEvent,
    signal: AbortSignal,
  ): Promise<"current" | "stale" | "unknown"> {
    if (event.kind !== "input.required") return "current";
    if (event.threadId === undefined || !event.logicalKey.startsWith("ask:")) return "stale";
    const interactionId = event.logicalKey.slice("ask:".length);
    const thread = this.store.getThread(event.threadId);
    const connection = thread === undefined ? undefined : this.connections.get(thread.sourceId);
    if (connection === undefined || !connection.info.supportsAskUser) return "unknown";
    try {
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(INFO_TIMEOUT_MS)]);
      const snapshot = connection.info.supportsAskById
        ? await connection.client.ask(interactionId, boundedSignal)
        : await connection.client.pendingAsk(
            this.store.cronConversationIdForThread(event.threadId) ?? `web:${event.threadId}`,
            boundedSignal,
          );
      return snapshot?.interactionId === interactionId
        && snapshot.status === "pending"
        && (snapshot.expiresAt === null
          || new Date(snapshot.expiresAt).getTime() > this.currentDate().getTime())
        ? "current"
        : "stale";
    } catch {
      return "unknown";
    }
  }

  private requireCronConnection(sourceId: string, actions: boolean): AgentConnection {
    if (this.store.getAgent(sourceId) === undefined) {
      throw new WebConsoleError("agent_not_found", "Agent not found.", 404);
    }
    const connection = this.connections.get(sourceId);
    if (connection === undefined || connection.info.cron?.read !== true) {
      throw new WebConsoleError("cron_unavailable", "Cron operator state is unavailable for this agent.", 409);
    }
    if (actions && connection.info.cron.actions !== true) {
      throw new WebConsoleError(
        "cron_actions_disabled",
        "Cron actions require this agent's authenticated operator capability.",
        403,
      );
    }
    return connection;
  }

  /**
   * Tier-2 admission: the catalog cache, seeded from `modelOptions` keys and
   * appended to by every proxied `/v1/models` page.
   *
   * Both feeds cross an await between deciding what to admit and admitting it,
   * so both name the generation they read. A write whose generation is no
   * longer the one on file is dropped outright rather than filed under the
   * successor: it describes a process that has been replaced, and admitting it
   * is exactly the cross-generation contamination `reconcileModelCatalogCache`
   * exists to prevent. Nothing is created here either -- an entry exists for
   * every discovered source from the moment a refresh reconciles it, and a
   * source with no entry is one discovery has dropped.
   *
   * @returns whether the refs were admitted.
   */
  private admitCatalogRefs(
    sourceId: string,
    generation: string | undefined,
    refs: readonly (readonly [string, CatalogModelRecord])[],
  ): boolean {
    if (generation === undefined) return false;
    const entry = this.modelCatalogCache.get(sourceId);
    if (entry === undefined || entry.generation !== generation) return false;
    for (const [ref, record] of refs) this.admitModelRef(entry.models, ref, record);
    return true;
  }

  /**
   * Bind the cache to the agent process that filled it, and to nothing else.
   * A source id outlives the process behind it: reconfigure an agent and
   * restart it and the next generation advertises a different catalog under
   * the same id. Keyed by id alone, generation 1's ladder judged generation
   * 2's turns and rejected grades the running agent accepts, with no way to
   * clear it short of restarting the console.
   *
   * The single place the cache is scoped, so there is one answer to "whose
   * catalog is this". Runs before the per-agent probes of a refresh, so a seed
   * or a proxied page during that refresh files under the current generation.
   * Sources discovery no longer reports are dropped outright, or a retired
   * agent's refs would accumulate for the life of the process.
   */
  private reconcileModelCatalogCache(
    generations: ReadonlyMap<string, string>,
  ): void {
    for (const sourceId of [...this.modelCatalogCache.keys()]) {
      if (!generations.has(sourceId)) this.modelCatalogCache.delete(sourceId);
    }
    for (const [sourceId, generation] of generations) {
      if (this.modelCatalogCache.get(sourceId)?.generation === generation) continue;
      this.modelCatalogCache.set(sourceId, { generation, models: new Map() });
    }
  }

  private seedModelCatalogFromOptions(
    sourceId: string,
    generation: string,
    modelOptions: Readonly<Record<string, WebModelOption>> | undefined,
  ): void {
    if (modelOptions === undefined) return;
    // `modelOptions` stays the authority for the refs it names, so the seed
    // only records admission; recording a ladder here would shadow it.
    this.admitCatalogRefs(
      sourceId,
      generation,
      Object.keys(modelOptions).map((key) => [key, { source: "shortlist", efforts: undefined }] as const),
    );
  }

  private admitModelRef(
    entries: Map<string, CatalogModelRecord>,
    ref: string,
    record: CatalogModelRecord,
  ): void {
    const known = entries.get(ref);
    if (known !== undefined) {
      // A page is the live word on what it serves, so its metadata replaces
      // whatever is held -- including replacing a ladder with silence, which
      // is how a re-fetched catalog heals a model whose grades changed. The
      // shortlist seed only records admission and must never shadow a page.
      // Re-setting an existing key leaves its eviction position alone.
      if (record.source === "page") entries.set(ref, record);
      return;
    }
    entries.set(ref, record);
    if (entries.size > MODEL_CATALOG_CACHE_CAP) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
  }

  private validateModelAndEffort(
    sourceId: string,
    agent: WebAgentSummary,
    model: string | undefined,
    effort: string | undefined,
  ): void {
    if (model !== undefined && !this.modelAdmitted(sourceId, agent, model)) {
      throw new WebConsoleError("invalid_model", "This agent did not advertise the selected model.", 400);
    }
    // Both ends resolve a blank selection to the same route -- the browser fell
    // back to the first shortlist entry while this stopped at `defaultModel`,
    // so any `/v1/info` omitting `model` had the picker offering one ladder and
    // this rejecting from another.
    const effectiveModel = effectiveModelForAgent(agent, model);
    // `modelOptions` only ever covers the configured shortlist, so a model
    // reached through the provider catalog has no entry there. `effort-ladder`
    // holds the tiering, and the browser runs the exact same function, so the
    // picker cannot offer a grade this rejects or hide one it accepts.
    const cached = effectiveModel === undefined
      ? undefined
      : this.modelCatalogCache.get(sourceId)?.models.get(effectiveModel);
    const allowedEfforts = effortLevelsForModel(agent, effectiveModel, cached?.efforts);
    if (effort !== undefined && !allowedEfforts.includes(effort)) {
      throw new WebConsoleError("invalid_effort", "This agent did not advertise the selected effort for this model.", 400);
    }
  }

  private modelAdmitted(sourceId: string, agent: WebAgentSummary, model: string): boolean {
    // Tier 1: the configured-route shortlist — unchanged, always allowed.
    if (agent.models === undefined ? model === agent.defaultModel : agent.models.includes(model)) return true;
    // Tier 2: a model reached only through the catalog cache.
    const cached = this.modelCatalogCache.get(sourceId);
    if (cached !== undefined && cached.models.has(model)) return true;
    // Tier 3: syntactic `<provider>:<model>` floor. The web package has no pi-ai
    // access, so a well-formed ref passes here and the agent itself is the real
    // gate at turn time.
    return modelPassesSyntacticFloor(model);
  }

  private authorizeReplyPart<T extends "attachment" | "mcp_app">(
    threadId: string,
    messageId: string,
    partId: string,
    type: T,
    expires: string,
    token: string,
  ): {
    readonly thread: WebThread;
    readonly part: Extract<WebMessagePart, { type: T }>;
  } {
    const access = this.replyAccessTokenStatus(threadId, messageId, type, partId, expires, token);
    if (access === "invalid") {
      throw new WebConsoleError("reply_part_not_found", "The reply part is unavailable.", 404);
    }
    const { thread, part } = this.requireReplyPart(threadId, messageId, partId, type);
    this.assertReplyPartRetained(part);
    if (access === "expired") {
      throw new WebConsoleError(
        "reply_access_expired",
        "Reply access expired. Refresh this reply part and try again.",
        410,
      );
    }
    return { thread, part };
  }

  private requireReplyPart<T extends "attachment" | "mcp_app">(
    threadId: string,
    messageId: string,
    partId: string,
    type: T,
  ): {
    readonly thread: WebThread;
    readonly message: WebMessage;
    readonly part: Extract<WebMessagePart, { type: T }>;
  } {
    const thread = this.store.getThread(threadId);
    const message = this.store.getMessage(messageId);
    if (thread === undefined || message === undefined || message.threadId !== thread.id) {
      throw new WebConsoleError("reply_part_not_found", "The reply part is unavailable.", 404);
    }
    const matches = message.parts.filter(
      (part): part is Extract<WebMessagePart, { type: T }> => part.type === type && part.id === partId,
    );
    if (matches.length !== 1) {
      throw new WebConsoleError("reply_part_not_found", "The reply part is unavailable.", 404);
    }
    const part = matches[0]!;
    return { thread, message, part };
  }

  private assertReplyPartRetained(part: WebRichReplyPart): void {
    const expiresAt = (part as WebRichReplyPart).expiresAt;
    if (expiresAt !== undefined && Date.parse(expiresAt) <= this.currentDate().getTime()) {
      throw new WebConsoleError("reply_part_expired", "The reply part has expired.", 410);
    }
  }

  private decorateThreadDetail(detail: WebThreadDetail, options: WebTranscriptShape = {}): WebThreadDetail {
    // Backfill: messages that predate this feature, and any turn whose own
    // attempt failed or was interrupted. Idempotent and guarded, so repeated
    // reads of the same thread fetch each image at most once.
    void this.persistReplyImages(detail.thread.id, detail.messages);
    return { ...detail, messages: detail.messages.map((message) => this.shapeMessage(message, options)) };
  }

  /**
   * The one boundary every browser-facing message crosses: it mints the
   * short-lived reply capabilities, and it puts the transcript on a diet.
   *
   * Shaping lives HERE and never in the store. The store's parts feed the
   * sidebar preview, the streamed-text split, and the transcript deltas that
   * follow this change, all of which need the payloads whole and the indexes
   * exactly as recorded.
   */
  private shapeMessage(message: WebMessage, options: WebTranscriptShape = {}): WebMessage {
    const parts = message.parts.map((part): WebMessagePart => {
      if (part.type === "attachment" || part.type === "mcp_app") return this.decorateReplyPart(message, part);
      if (options.full === true) return part;
      if (part.type === "telemetry") return shapeTelemetryPart(part);
      if (part.type === "tool-call") return shapeToolCallPart(part);
      if (part.type === "subagent") return shapeSubagentPart(part);
      return part;
    });
    return { ...message, parts };
  }

  /**
   * Keeps the console's own copy of an image the agent published.
   *
   * Reply artifacts are proxied from the agent and never stored, so without this
   * a generated image dies at the agent's retention deadline and shows broken
   * whenever that agent is stopped. Raster types only: `image/svg+xml` is active
   * content, is refused inline by both the client and `setReplyDownloadHeaders`,
   * and is deliberately never persisted either.
   *
   * Entirely best-effort. Every failure leaves the part on its existing
   * capability path, because a stored copy is an optimisation and a turn must
   * never fail over one.
   */
  private async persistReplyImages(threadId: string, messages: readonly WebMessage[]): Promise<void> {
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "attachment") continue;
        if (!REPLY_IMAGE_MEDIA_TYPES.has(part.mediaType.toLowerCase())) continue;
        if (part.sizeBytes > DEFAULT_AGENT_ATTACHMENT_MAX_BYTES) continue;
        if (this.store.storedReplyAttachment(message.id, part.id) !== undefined) continue;
        const key = WebStore.replyAttachmentId(message.id, part.id);
        if (this.persistingReplyImages.has(key)) continue;
        this.persistingReplyImages.add(key);
        try {
          await this.persistReplyImage(threadId, message, part);
        } catch (error) {
          this.options.logger?.debug?.("Web reply image was not persisted.", {
            threadId,
            messageId: message.id,
            partId: part.id,
            error: errorMessage(error),
          });
        } finally {
          this.persistingReplyImages.delete(key);
        }
      }
    }
  }

  private async persistReplyImage(
    threadId: string,
    message: WebMessage,
    part: Extract<WebMessagePart, { type: "attachment" }>,
  ): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (thread === undefined) return;
    const connection = this.connections.get(thread.sourceId);
    if (connection === undefined || connection.info.replyAttachments?.version !== 1) return;

    const response = await connection.client.replyArtifact(
      this.conversationIdForThread(thread.id),
      {
        type: "attachment",
        id: part.id,
        reference: { scheme: "mono-agent-artifact", id: part.artifactId },
        name: part.name,
        mediaType: part.mediaType,
        sizeBytes: part.sizeBytes,
        integrityId: part.integrityId,
        ...(part.expiresAt === undefined ? {} : { expiresAt: part.expiresAt }),
      },
    );
    if (!response.ok || response.body === null) return;
    const bytes = Buffer.from(await response.arrayBuffer());

    // The same pair the browser checks before handing a download to the user. A
    // copy that fails either is not written at all, so a corrupt artifact can
    // never be served from a stable URL that outlives its source.
    if (bytes.byteLength !== part.sizeBytes) return;
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== part.integrityId.toLowerCase()) return;

    const storageName = `${randomUUID()}.bin`;
    const destination = this.store.attachmentPath({ storageName });
    const staging = `${destination}.partial-${randomUUID()}`;
    await writeFile(staging, bytes, { mode: 0o600 });
    try {
      await rename(staging, destination);
    } catch (error) {
      await unlink(staging).catch(() => undefined);
      throw error;
    }
    try {
      this.store.recordReplyAttachment({
        threadId: thread.id,
        messageId: message.id,
        partId: part.id,
        name: part.name,
        contentType: part.mediaType,
        sizeBytes: bytes.byteLength,
        storageName,
      });
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
  }

  private decorateReplyPart(message: WebMessage, part: WebRichReplyPart): WebRichReplyPart {
    // A durable copy is resolved before the retention gate below, because
    // outliving that deadline is the entire reason it was kept.
    const stored = part.type === "attachment"
      ? this.store.storedReplyAttachment(message.id, part.id)
      : undefined;
    const storedUrl = stored === undefined
      ? {}
      : { storedUrl: `/api/v1/uploads/${encodeURIComponent(stored.id)}/content` } as const;
    const now = this.currentDate().getTime();
    const retentionDeadline = part.expiresAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(part.expiresAt);
    const expiresAt = Math.min(now + REPLY_ACCESS_TTL_MS, retentionDeadline);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return part.type === "attachment" ? { ...part, ...storedUrl } : part;
    }
    const expires = String(Math.floor(expiresAt / 1_000));
    const token = this.replyAccessToken(message.threadId, message.id, part.type, part.id, expires);
    const base = `/api/v1/threads/${encodeURIComponent(message.threadId)}`
      + `/messages/${encodeURIComponent(message.id)}`;
    const query = new URLSearchParams({ expires, token }).toString();
    return part.type === "attachment"
      ? {
          ...part,
          ...storedUrl,
          contentUrl: `${base}/reply-attachments/${encodeURIComponent(part.id)}/content?${query}`,
        }
      : {
          ...part,
          resourceUrl: `${base}/mcp-apps/${encodeURIComponent(part.id)}?${query}`,
          bridgeUrl: `${base}/mcp-apps/${encodeURIComponent(part.id)}/requests?${query}`,
        };
  }

  private replyAccessToken(
    threadId: string,
    messageId: string,
    type: "attachment" | "mcp_app",
    partId: string,
    expires: string,
  ): string {
    return createHmac("sha256", this.replyAccessKey)
      .update(["v1", threadId, messageId, type, partId, expires].join("\0"))
      .digest("base64url");
  }

  private replyAccessTokenStatus(
    threadId: string,
    messageId: string,
    type: "attachment" | "mcp_app",
    partId: string,
    expires: string,
    supplied: string,
  ): "valid" | "expired" | "invalid" {
    if (!/^\d{10,13}$/u.test(expires) || !/^[A-Za-z0-9_-]{43}$/u.test(supplied)) return "invalid";
    const expiresMs = Number(expires) * 1_000;
    if (!Number.isSafeInteger(expiresMs)) return "invalid";
    const expected = Buffer.from(this.replyAccessToken(threadId, messageId, type, partId, expires), "utf8");
    const candidate = Buffer.from(supplied, "utf8");
    if (candidate.byteLength !== expected.byteLength || !timingSafeEqual(candidate, expected)) return "invalid";
    const now = this.currentDate().getTime();
    if (expiresMs > now + REPLY_ACCESS_TTL_MS + 1_000) return "invalid";
    return expiresMs <= now ? "expired" : "valid";
  }

  private conversationIdForThread(threadId: string): string {
    return this.store.cronConversationIdForThread(threadId) ?? `web:${threadId}`;
  }

  private currentDate(): Date {
    return this.options.clock?.() ?? new Date();
  }

  private announcePushEvent(logicalKey: string): void {
    const event = this.store.webPushEventByLogicalKey(logicalKey);
    if (event === undefined) return;
    this.pushDispatcher.wake();
    if (event.kind === "test" || event.threadId === undefined) return;
    this.emit("push.pending", event.threadId, {
      eventId: event.id,
      threadId: event.threadId,
      ackToken: this.pushAckToken(event.id),
    });
  }

  private pushAckToken(eventId: string): string {
    return createHmac("sha256", this.pushAckKey).update(eventId).digest("base64url").slice(0, 32);
  }

  private validPushAckToken(eventId: string, supplied: string): boolean {
    if (!/^[A-Za-z0-9_-]{32}$/u.test(supplied)) return false;
    const expected = Buffer.from(this.pushAckToken(eventId), "utf8");
    const candidate = Buffer.from(supplied, "utf8");
    return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
  }

  private activeReservedUploadBytes(): number {
    let total = 0;
    for (const bytes of this.activeUploads.values()) total += bytes;
    return total;
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolvePromise();
    };
    const timer = setTimeout(done, delayMs);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
  });
}

function isFuturePendingAsk(snapshot: ChannelAskSnapshot, now: Date): boolean {
  if (snapshot.status !== "pending") return false;
  if (snapshot.expiresAt === null) return true;
  const expiresAt = new Date(snapshot.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

const STREAM_FLUSH_INTERVAL_MS = 50;
const ASK_PUSH_DELIVERY_TTL_MS = 24 * 60 * 60 * 1_000;

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

/**
 * The identity of the agent PROCESS behind a source id. `sourceId` is stable
 * across restarts by design, so it cannot scope anything the running process
 * told us: a reconfigured agent restarts at a new endpoint, with a new pid and
 * a new `startedAt`, and advertises a different catalog under the same id.
 * Deliberately excludes `updatedAt`, which every heartbeat moves.
 *
 * This is what the model catalog cache is scoped to -- and, since the browser
 * caches the same `/v1/models` pages and had nothing generation-shaped to
 * watch, what `WebAgentSummary.generation` carries to it.
 *
 * Hashed because it now goes on the wire: the raw form names the agent's
 * operator endpoint and pid, and the console has no reason to hand those to a
 * page. The token only has to be stable while one process lives and different
 * once it is replaced, which a digest of those three fields is.
 *
 * Length-prefixed rather than `|`-joined. A separator that can occur inside a
 * field is not a separator: two different accepted tuples whose parts happen to
 * contain the delimiter flatten to the same string and hash to the same token,
 * and two distinct processes sharing a generation is precisely the state the
 * token exists to make impossible. Nothing first-party produces such a tuple
 * today, which is why this is robustness rather than a live defect --- but a
 * digest whose only defence is what its inputs happen to look like is one
 * unrelated change away from being wrong.
 *
 * Hashed as UTF-16 code units for the same reason the prefix replaced the
 * delimiter. UTF-8 has no encoding for an unpaired surrogate, so a lone high
 * surrogate and a lone low surrogate both became the replacement character and
 * two different one-character fields -- identically length-prefixed -- hashed
 * alike. `utf16le` is a lossless transcription of exactly the code units the
 * length prefix counts, so what is hashed is what was measured.
 */
export function agentGeneration(agent: DiscoveredOperatorAgent): string {
  const parts = [
    agent.baseUrl ?? "",
    String(agent.source.pid ?? ""),
    agent.source.startedAt,
  ];
  return createHash("sha256")
    .update(parts.map((part) => `${String(part.length)}:${part}`).join(""), "utf16le")
    .digest("hex")
    .slice(0, 16);
}

function offlineSummary(agent: DiscoveredOperatorAgent, generation: string): WebAgentSummary {
  return {
    sourceId: agent.source.sourceId,
    generation,
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
  // Same rule as every other effort decision, so the union an agent advertises
  // cannot disagree with what a turn on one of those models may carry.
  return [...new Set(models.flatMap((model) => effortLevelsForModel(info, model, undefined)))];
}

/**
 * Tier 3: the syntactic floor. `@mono-agent/web` may not import pi-ai, so this
 * cannot be authoritative -- the agent is. It exists to reject obvious garbage,
 * and it must not be looser than the runtime parser, or a reference the console
 * accepts is silently ignored and the turn runs on the default model instead.
 */
function modelPassesSyntacticFloor(model: string): boolean {
  const separator = model.indexOf(":");
  if (separator <= 0 || separator >= model.length - 1) return false;
  const provider = model.slice(0, separator);
  const rest = model.slice(separator + 1);
  // Provider ids are lowercase kebab/alphanumeric; the model half may carry
  // further colons and slashes but must not be blank or padded.
  return /^[a-z0-9][a-z0-9-]*$/u.test(provider) && rest.trim() === rest && rest.trim().length > 0;
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
