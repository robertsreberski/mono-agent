import { types as nodeUtilTypes } from "node:util";

export type AgentRequestMetadata = Record<string, unknown>;
export type AgentResponseMetadata = Record<string, unknown>;
export {
  MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES,
  PROCESS_JOB_ERROR_CODES,
  PROCESS_JOB_PUBLIC_ERROR_MESSAGES,
  PROCESS_JOB_STATES,
  isProcessJobErrorCode,
  isProcessJobState,
  parseProcessJobProjection,
  parseProcessJobProjections,
  processJobPublicError,
} from "./process-jobs.js";
export type {
  ProcessJobErrorCode,
  ProcessJobOperator,
  ProcessJobProjection,
  ProcessJobProjectionError,
  ProcessJobProjectionLimits,
  ProcessJobProjectionOrigin,
  ProcessJobProjectionOutput,
  ProcessJobProjectionTimestamps,
  ProcessJobProjectionWake,
  ProcessJobState,
  ProcessJobWakeState,
} from "./process-jobs.js";
export type {
  MemoryBlock,
  MemoryCompletedTurn,
  MemoryCompletedTurnAdmissionStatus,
  MemoryCompletedTurnResult,
  MemoryLoadOptions,
  MemoryStore,
  MemoryWriteResult,
} from "./memory.js";

/**
 * Reserved final-text token a notify-enabled cron/webhook turn emits to suppress
 * its own notification ("nothing worth reporting"). Single source of truth shared
 * by the harness (which instructs the agent) and the app (which matches it before
 * delivery). Matched trimmed + case-insensitively, as the whole text or as its
 * final line; never substring-matched. See `classifyNotifySuppression`.
 */
export const NOTHING_TO_REPORT_SENTINEL = "NOTHING_TO_REPORT";

/**
 * How a notify turn's final text suppresses its own delivery, if at all.
 *
 * `narrated-sentinel` is the off-contract-but-unambiguous case: the model wrote
 * out its reasoning and *then* emitted the marker on its own last line. The
 * harness asks for the sentinel alone, and most models comply, but a fallback
 * model narrating first still plainly decided to stay silent — delivering its
 * scratch work instead is the worst available reading of that.
 */
export type NotifySuppression = "none" | "empty" | "sentinel" | "narrated-sentinel";

/**
 * Classify a notify turn's final text.
 *
 * Anchored to the final line, never a substring search: a report that merely
 * mentions the sentinel mid-body is still delivered, because the marker only
 * carries meaning where a final answer ends.
 */
export function classifyNotifySuppression(text: string | undefined): NotifySuppression {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) {
    return "empty";
  }
  if (trimmed.toUpperCase() === NOTHING_TO_REPORT_SENTINEL) {
    return "sentinel";
  }
  const finalLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  return finalLine.toUpperCase() === NOTHING_TO_REPORT_SENTINEL ? "narrated-sentinel" : "none";
}

/** Whether a notify-enabled turn's final text intentionally suppresses delivery. */
export function suppressesNotification(text: string | undefined): boolean {
  return classifyNotifySuppression(text) !== "none";
}

/**
 * A multimodal attachment that accompanies a request — an image to be fed to a
 * vision model, or a document whose bytes (and/or extracted text) can be inlined
 * into the prompt. Transport-agnostic: channels populate it; runtimes consume it.
 */
export interface AgentAttachment {
  readonly kind: "image" | "document";
  /** MIME type, e.g. "image/png" or "application/pdf". */
  readonly mimeType: string;
  /** Raw attachment bytes, base64-encoded. */
  readonly data: string;
  /** Original file name, when known. */
  readonly name?: string;
  /** Size of the decoded bytes, when known. */
  readonly sizeBytes?: number;
  /** Extracted text for documents, when available. */
  readonly text?: string;
  /** Media duration in seconds (audio/video), when the transport reports it. */
  readonly durationSeconds?: number;
}

/** Default decoded-byte ceiling shared by transports that ingest attachments. */
export const DEFAULT_AGENT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Maximum serialized size of an agent's `/v1/info` body.
 *
 * Load-bearing in both directions, which is why it lives here rather than beside
 * either user. The operator adapter sheds optional fields to stay under it; the
 * console's operator client reads at most this many bytes and rejects a larger
 * body wholesale. A producer that exceeded a consumer that had drifted smaller
 * would not degrade the agent — it would show it OFFLINE, on a 5 s poll, behind
 * a debug-level log. One export removes the possibility.
 */
export const MAX_INFO_BODY_BYTES = 1024 * 1024;

/**
 * Wire bounds for `/v1/info`'s provider summary, shared for the same reason as
 * {@link MAX_INFO_BODY_BYTES}: two independently chosen limits on one wire lose
 * content silently, and neither half can see the other's number.
 *
 * They were chosen independently once, and both ways cost the operator a
 * provider. The producer built the summary against a 256-byte id bound while
 * the console dropped anything over 128. And the producer admitted the agent's
 * OWN route providers first — the ones every model selection actually needs —
 * into a list the console then cut at 64, so a 71-entry catalog handed the
 * console 64 declared vendors and not the route provider the prioritization
 * existed to save.
 *
 * A count window is not a licence to truncate arbitrarily: the producer must
 * place what the console cannot do without inside the first
 * {@link MAX_INFO_PROVIDER_ITEMS} entries, and the console parses that same
 * window. Bytes stay bounded by the producer's own provider slice and, behind
 * it, {@link MAX_INFO_BODY_BYTES}.
 */
export const MAX_INFO_PROVIDER_ITEMS = 64;
/**
 * Byte bound on one provider id / label in `/v1/info.providers`.
 *
 * A display bound, never a validity one: config validation length-bounds
 * neither, so a 129-byte provider id is a route that resolves and runs. The
 * console must therefore accept everything the catalog is willing to publish,
 * or the operator loses a working provider to a number nobody chose together.
 */
export const MAX_INFO_PROVIDER_ID_BYTES = 256;
/** Byte bound on one provider label; an over-long label degrades to the id. */
export const MAX_INFO_PROVIDER_LABEL_BYTES = 256;

/**
 * Transport-neutral MIME types accepted by the built-in attachment flows.
 * Keeping this list beside {@link AgentAttachment} prevents browser and chat
 * adapters from drifting into subtly different upload behavior.
 */
export const DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/webm",
  "audio/flac",
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/webm",
];

/** Classify an allowed MIME type into the runtime's two attachment kinds. */
export function agentAttachmentKindFromMimeType(mimeType: string): AgentAttachment["kind"] {
  return mimeType.trim().toLowerCase().startsWith("image/") ? "image" : "document";
}

/**
 * Decode the text payloads transports inline for the model. Binary and
 * application/* documents deliberately return undefined, matching the
 * established Telegram behavior.
 */
export function decodeAgentAttachmentText(
  mimeType: string,
  bytes: Uint8Array,
): string | undefined {
  if (!mimeType.trim().toLowerCase().startsWith("text/")) {
    return undefined;
  }
  // `ignoreBOM: true` means treat a leading BOM as ordinary decoded text,
  // matching Node Buffer's established Telegram UTF-8 behavior exactly.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/**
 * Host-owned destination for a later reply.  This is deliberately separate
 * from {@link AgentRequestBase.conversationId}: the latter may be rewritten for
 * session rollover, while this value identifies the channel conversation that
 * can actually receive a reply.  Hosts must not copy it into model prompts,
 * tool arguments, or run artifacts.
 *
 * Note the narrower claim since {@link AgentSurface} arrived: what stays out of
 * the prompt is the ROUTE -- this composite id, which pins a specific thread --
 * not the fact of which channel the turn is happening in.
 */
export interface AgentReplyTarget {
  readonly conversationId: string;
}

/**
 * Which surface the current turn is happening on: a DM, a named channel, or a
 * group chat.
 *
 * EXPLICITLY MODEL-VISIBLE, including `id`. Agent behaviour legitimately differs
 * by surface -- a Slack channel run wakes only on `app_mention` so a follow-up
 * needs another mention while a DM run does not; a channel has several readers
 * and a DM has one; a multi-channel deployment scopes tone and topic per channel
 * -- and an agent that cannot tell which surface it is on cannot apply any of it.
 *
 * On exposing `id`: this is a deliberate, operator-chosen relaxation of the older
 * "no physical identity in a prompt" rule, taken so the agent can name its
 * surface unambiguously. The residual risk is concrete rather than theoretical:
 * the optional `SlackSendMessage` tool takes a raw channel id, so a deployment
 * that enables it with `allowAllChannels` lets the model post to any channel
 * whose id it has seen. A deployment with an explicit channel allowlist -- the
 * default posture -- is unaffected, since the allowlist is what bounds delivery.
 *
 * What this type still does NOT carry, and must not:
 *
 * - A thread timestamp, or any {@link AgentReplyTarget} conversation id. The
 *   model learns the channel, never the exact thread to deliver into.
 * - {@link AgentMessageSender.id}. A Slack user id doubles as a DM channel id
 *   with a DIFFERENT surface's identity, so it stays host-only; a DM's own
 *   channel id here is the surface the turn is already on.
 * - A callback URL or delivery token of any kind.
 *
 * `name` is user-controlled on every channel (anyone who can rename a channel
 * controls it), so the harness sanitizes it exactly like a display name and it
 * is evidence of a name rather than proof of one.
 */
export interface AgentSurface {
  /**
   * `dm` — one other reader. `channel` — a named, shared, potentially large
   * audience. `group` — a multi-party chat that is not a named channel (a
   * Telegram group, a Slack multi-person DM).
   */
  readonly kind: "dm" | "channel" | "group";
  /**
   * Model-visible human name for the surface: a Slack channel name without `#`,
   * a Telegram chat title, or a DM counterpart's handle without `@`. Absent when
   * the channel cannot resolve one (e.g. Slack without `channels:read`).
   */
  readonly name?: string;
  /**
   * Model-visible platform id for THIS conversation's channel or chat — a Slack
   * `C…`/`D…`/`G…` id, a Telegram numeric chat id. Never a thread id.
   */
  readonly id?: string;
  /**
   * What the channel will actually do with a long answer, so the agent composes
   * to the real limit instead of inventing one per skill. Sourced from the
   * transport's own budget, so it cannot drift from what is enforced.
   */
  readonly messageBudget?: AgentSurfaceMessageBudget;
}

export interface AgentSurfaceMessageBudget {
  /** Per-message character budget the transport chunks at. */
  readonly maxChars: number;
  /**
   * Where the overflow goes: `thread` continues under the first message (Slack),
   * `follow_up` posts further messages in the same conversation (Telegram).
   */
  readonly overflow: "thread" | "follow_up";
}

/**
 * Who produced the current message, in transport-neutral form.
 *
 * EXPLICITLY MODEL-VISIBLE, the opposite polarity to {@link AgentReplyTarget}
 * and {@link AgentContinuationTurn}: the harness renders `displayName`/`handle`
 * into the turn so the agent knows who is speaking in a group chat, attributes
 * the persisted history turn to that person, and labels the memory capture.
 *
 * `id` is the sole exception and stays HOST-ONLY. It is a physical channel
 * identity and an actionable delivery target -- a Slack user id doubles as a DM
 * channel id, so it would hand the model a route to a DIFFERENT surface than the
 * one this turn is on. ({@link AgentSurface.id} is model-visible precisely
 * because it names the surface already in play.) Hosts may use it for
 * bookkeeping and traces only.
 *
 * `displayName` and `handle` are user-controlled on every channel, so they are
 * evidence of a name, never proof of identity. `isBot` is the only trustworthy
 * discriminator here because it comes from the transport, not from the user.
 *
 * Identity is per channel. Nothing here implies a cross-channel identity map.
 */
export interface AgentMessageSender {
  /** Host-only platform participant id; never model-visible. */
  readonly id?: string;
  /** Model-visible human name, e.g. "Alice Chen". User-controlled. */
  readonly displayName?: string;
  /** Model-visible platform handle without a leading `@`, e.g. "alice". User-controlled. */
  readonly handle?: string;
  /** Transport-asserted: this sender is a bot or app rather than a human. */
  readonly isBot?: boolean;
}

/**
 * One message that landed in this conversation BEFORE the current one and that
 * the agent has not seen -- a group chat that kept talking between turns.
 *
 * EXPLICITLY MODEL-VISIBLE background context. Channels produce it however they
 * like: Slack pulls `conversations.replies`/`history` from a watermark when it
 * is triggered, Telegram buffers ambiently when opted in. The harness renders it
 * as a bounded, fenced, explicitly untrusted transcript on the user message and
 * never writes it to durable history or long-term memory.
 */
export interface AgentPrecedingMessage {
  readonly sender?: AgentMessageSender;
  readonly text: string;
  /** ISO-8601 transport timestamp, when known. */
  readonly timestamp?: string;
}

/**
 * Harness-enforced bounds for {@link AgentRequestBase.precedingMessages}. They
 * live here so adapters can pre-trim to the same numbers the harness enforces.
 */
export const AGENT_PRECEDING_MESSAGES_MAX_COUNT = 30;
export const AGENT_PRECEDING_MESSAGE_MAX_TEXT_BYTES = 2 * 1024;
export const AGENT_PRECEDING_MESSAGES_MAX_TOTAL_BYTES = 16 * 1024;
/** Harness-enforced bound for one rendered {@link AgentMessageSender} label. */
export const AGENT_MESSAGE_SENDER_LABEL_MAX_CHARS = 64;

/** One host-owned message in a pinned continuation origin snapshot. */
export interface AgentContinuationContextMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name?: string;
  readonly timestamp?: string;
  readonly runId?: string;
  readonly idempotencyKey?: string;
}

/**
 * Exact bounded conversation context committed by the origin run. The host
 * pins this snapshot before returning a successful answer; continuation
 * synthesis consumes these bytes instead of consulting mutable/latest history.
 */
export interface AgentContinuationOriginContext {
  readonly schemaVersion: 1;
  /** Exact history identity, including an explicit rollover bucket. */
  readonly conversationId: string;
  readonly originRunId: string;
  readonly historyBoundary: string;
  readonly capturedAt: string;
  readonly messages: readonly AgentContinuationContextMessage[];
}

export const AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES = 64;
export const AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGE_BYTES = 64 * 1024;
export const AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_BYTES = 256 * 1024;

/** Deep host-boundary validation shared by harness and durable continuation storage. */
export function assertAgentContinuationOriginContext(
  value: unknown,
): asserts value is AgentContinuationOriginContext {
  if (!isPlainRecord(value)
    || !hasOnlyContinuationKeys(value, ["schemaVersion", "conversationId", "originRunId", "historyBoundary", "capturedAt", "messages"])
    || value.schemaVersion !== 1
    || !boundedContinuationString(value.conversationId, 2_048)
    || !boundedContinuationString(value.originRunId, 512)
    || !boundedContinuationString(value.historyBoundary, 512)
    || value.historyBoundary !== value.originRunId
    || !validContinuationDate(value.capturedAt)
    || !Array.isArray(value.messages)
    || value.messages.length < 2
    || value.messages.length > AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES) {
    throw new TypeError("Continuation origin context has an invalid envelope.");
  }
  for (const message of value.messages) {
    if (!isPlainRecord(message)
      || !hasOnlyContinuationKeys(message, ["role", "content", "name", "timestamp", "runId", "idempotencyKey"])
      || (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool")
      || typeof message.content !== "string"
      || continuationUtf8Bytes(message.content) > AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGE_BYTES
      || !optionalBoundedContinuationString(message.name, 512)
      || (message.timestamp !== undefined && !validContinuationDate(message.timestamp))
      || !optionalBoundedContinuationString(message.runId, 512)
      || !optionalBoundedContinuationString(message.idempotencyKey, 512)) {
      throw new TypeError("Continuation origin context contains an invalid message.");
    }
  }
  const user = value.messages.at(-2);
  const assistant = value.messages.at(-1);
  if (user?.role !== "user"
    || assistant?.role !== "assistant"
    || user.runId !== value.originRunId
    || assistant.runId !== value.originRunId
    || user.timestamp !== value.capturedAt
    || assistant.timestamp !== value.capturedAt) {
    throw new TypeError("Continuation origin context does not end with its completed origin turn.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Continuation origin context is not serializable.");
  }
  if (continuationUtf8Bytes(serialized) > AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_BYTES) {
    throw new TypeError("Continuation origin context exceeds its byte limit.");
  }
}

function continuationUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyContinuationKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function boundedContinuationString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && continuationUtf8Bytes(value) <= maxBytes;
}

function optionalBoundedContinuationString(value: unknown, maxBytes: number): boolean {
  return value === undefined || (typeof value === "string" && continuationUtf8Bytes(value) <= maxBytes);
}

function validContinuationDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/**
 * Host-only controls for a framework-owned continuation synthesis turn.
 *
 * A continuation turn is an isolated, tool-free reconstruction from a pinned
 * origin snapshot. Legacy/detached callers may omit `originContext`; an
 * interactive durable continuation must provide it. `originRunId` is trace
 * correlation, not an implicit history boundary. Its synthetic prompt and
 * generated answer are not committed to conversation history; the continuation
 * service commits the answer only after native channel delivery succeeds.
 */
interface AgentContinuationTurnBase {
  readonly continuationId: string;
  readonly originRunId: string;
  readonly toolsDisabled: true;
  readonly deferHistoryCommit: true;
}

/** Host-only continuation controls with impossible context states excluded at compile time. */
export type AgentContinuationTurn = AgentContinuationTurnBase & (
  | {
      readonly originContextPolicy: "pinned";
      readonly historyBoundary: string;
      readonly originContext: AgentContinuationOriginContext;
    }
  | {
      readonly originContextPolicy: "detached_latest";
      readonly historyBoundary?: never;
      readonly originContext?: never;
    }
);

export interface AgentRequestBase {
  readonly conversationId: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
  readonly metadata?: AgentRequestMetadata;
  readonly attachments?: readonly AgentAttachment[];
  /**
   * Host-only environment passed to process tools for this one request. It is
   * deliberately kept out of metadata, prompts, history, traces, and MCP
   * server startup. Adapters must validate this boundary before constructing
   * it; runtimes still treat it as immutable per-run data.
   */
  readonly toolEnvironment?: AgentToolEnvironment;
  /**
   * Who is speaking this turn. EXPLICITLY MODEL-VISIBLE (name and handle only;
   * `sender.id` stays host-only) -- contrast `replyTo`/`continuation` below.
   * Channels with no human identity (cron, webhook, single-user CLI) omit it and
   * the turn is byte-identical to one built before this field existed.
   */
  readonly sender?: AgentMessageSender;
  /**
   * Messages that arrived in this conversation since the agent's last turn,
   * OLDEST FIRST. EXPLICITLY MODEL-VISIBLE background context: rendered as a
   * bounded untrusted transcript on the user message, never persisted.
   */
  readonly precedingMessages?: readonly AgentPrecedingMessage[];
  /**
   * Which surface this turn is on. EXPLICITLY MODEL-VISIBLE in full, including
   * `id` -- see {@link AgentSurface} for what it deliberately still excludes.
   * Channels with no surface of their own (cron, webhook, single-user CLI) omit
   * it and the turn is byte-identical to one built before this field existed.
   */
  readonly surface?: AgentSurface;
  /** Host-only physical reply destination; never model-visible. */
  readonly replyTo?: AgentReplyTarget;
  /** Host-only continuation synthesis controls; never model-visible. */
  readonly continuation?: AgentContinuationTurn;
}

export interface AgentToolEnvironment {
  readonly schema: 1;
  readonly values: Readonly<Record<string, string>>;
  readonly pathPrepend?: readonly string[];
}

/** Stable MCP Apps extension identifier negotiated between a host and server. */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

/** Spec MIME type used for MCP App resources. */
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/** MCP Apps protocol revisions implemented by the built-in web host, newest first. */
export const MCP_APP_SUPPORTED_VERSIONS = ["2026-01-26", "2025-11-21"] as const;

/**
 * Opaque durable reference to an app-owned artifact. The identifier is safe to
 * carry over ordinary transports; bytes and local paths are deliberately not
 * representable here.
 */
export interface AgentReplyArtifactReference {
  readonly scheme: "mono-agent-artifact";
  readonly id: string;
}

/** A generated file published alongside an assistant reply. */
export interface AgentReplyAttachmentPart {
  readonly type: "attachment";
  /** Stable part id within the reply. */
  readonly id: string;
  readonly reference: AgentReplyArtifactReference;
  /** Sanitized display-only filename; never a filesystem path. */
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  /** Content-addressed integrity id, currently `sha256:<lowercase hex>`. */
  readonly integrityId: string;
  /** ISO-8601 retention deadline, when the publisher assigned one. */
  readonly expiresAt?: string;
}

/** A spec-negotiated MCP App invocation available to a capable host. */
export interface AgentReplyMcpAppPart {
  readonly type: "mcp_app";
  /** Durable app invocation id, also used to isolate bridge instances. */
  readonly id: string;
  readonly invocationId: string;
  readonly connectionId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly resourceUri: string;
  readonly mediaType: typeof MCP_APP_RESOURCE_MIME_TYPE;
  readonly protocolVersion: (typeof MCP_APP_SUPPORTED_VERSIONS)[number];
  readonly title?: string;
  readonly description?: string;
  /** ISO-8601 retention deadline for the persisted private host state. */
  readonly expiresAt?: string;
}

/** One rich reply part failed while other text/parts remained deliverable. */
export interface AgentReplyPartFailure {
  readonly type: "failure";
  readonly id: string;
  readonly code:
    | "app_capability_mismatch"
    | "app_connection_closed"
    | "app_resource_invalid"
    | "artifact_expired"
    | "artifact_integrity_failed"
    | "artifact_missing"
    | "artifact_publish_failed"
    | "artifact_too_large"
    | "reply_part_too_large"
    | "unsupported_destination";
  readonly message: string;
  readonly relatedPartId?: string;
}

/**
 * Additive rich reply surface. Unknown future part records remain wire-tolerant
 * but are ignored by consumers until they understand their `type`.
 */
export type AgentReplyPart =
  | AgentReplyAttachmentPart
  | AgentReplyMcpAppPart
  | AgentReplyPartFailure;

export interface AgentMessageFinishOptions {
  readonly parts?: readonly AgentReplyPart[];
  /**
   * Human destinations render concise diagnostics for unsupported parts.
   * Machine/verbatim transports explicitly select `none` so model output stays
   * byte-for-byte suitable for downstream parsing or notification delivery.
   */
  readonly unsupportedPartFallback?: "human" | "none";
}

/** Authorized, integrity-checked artifact stream returned by a responder. */
export interface AgentReplyArtifactStream {
  readonly attachment: AgentReplyAttachmentPart;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface AgentReplyArtifactOpenRequest {
  readonly conversationId: string;
  readonly reference: AgentReplyArtifactReference;
  /** Reject a durable record that no longer matches the message metadata. */
  readonly expectedIntegrityId?: string;
}

/** Private host payload used to initialize one sandboxed MCP App instance. */
export interface AgentMcpAppResource {
  readonly app: AgentReplyMcpAppPart;
  readonly html: string;
  readonly toolInput?: unknown;
  readonly toolResult?: unknown;
  readonly resourceMetadata?: Readonly<Record<string, unknown>>;
  /** False after restart, expiry, or an originating MCP disconnect. */
  readonly connected: boolean;
}

export interface AgentMcpAppLoadRequest {
  readonly conversationId: string;
  readonly invocationId: string;
  readonly connectionId: string;
}

export interface AgentMcpAppHostRequest extends AgentMcpAppLoadRequest {
  readonly method: "resources/read" | "tools/call" | "ui/open-link" | "ui/update-model-context";
  readonly params?: unknown;
  /** Host UI confirmation bound to this exact request. */
  readonly confirmed?: boolean;
}

export interface AgentResponse {
  readonly text?: string;
  readonly metadata?: AgentResponseMetadata;
  readonly parts?: readonly AgentReplyPart[];
}

export type SessionToolHistoryTerminalState =
  | "success"
  | "rejected"
  | "error"
  | "exit_nonzero"
  | "timeout"
  | "signal"
  | "cancelled"
  | "interrupted";

/** Same persisted record metadata used by model history and client rendering. */
export interface SessionToolHistoryEventMetadata {
  readonly recordId?: string;
  readonly sequence?: number;
  readonly persistence: "persisted" | "failed";
  readonly terminalState?: SessionToolHistoryTerminalState;
  readonly truncated?: boolean;
  readonly originalBytes?: number;
  readonly retainedBytes?: number;
  readonly artifactReferences?: readonly {
    readonly id: string;
    readonly available: boolean;
  }[];
  readonly errorCode?: string;
  /** Historical tool content is data, never executable instruction. */
  readonly untrusted: true;
}

export type AgentStreamEvent =
  | {
      readonly type: "assistant_thought";
      readonly text: string;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "tool_call_started";
      readonly id: string;
      readonly name: string;
      readonly arguments?: unknown;
      readonly history?: SessionToolHistoryEventMetadata;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "tool_call_completed";
      readonly id: string;
      readonly name?: string;
      readonly arguments?: unknown;
      readonly content?: unknown;
      /**
       * An MCP tool's machine-readable result, when it returned one. `content` is the
       * model-facing text and is deliberately lossy; a renderer that needs the tool's
       * actual outcome fields (AskUser's `interactionId`/`answered`, for instance) must
       * read them here. Bounded at the emitter — see `structuredContentFromToolResult`.
       */
      readonly structuredContent?: unknown;
      readonly isError?: boolean;
      /** Wall-clock tool execution time, when the runtime reported it. */
      readonly executionMs?: number;
      readonly history?: SessionToolHistoryEventMetadata;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "tool_call_progress";
      readonly id: string;
      readonly name?: string;
      /** Partial tool output captured while the tool is still running. */
      readonly partialResult?: unknown;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "usage_update";
      readonly model?: string;
      /** Cumulative run cost in USD, when the runtime prices the model. */
      readonly cumulativeUsd?: number;
      readonly tokens?: {
        readonly input: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheCreation: number;
      };
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "provider_status";
      readonly kind:
        | "request_started"
        | "request_completed"
        | "failover_started"
        | "failover_completed"
        /** A same-model retry is about to run after a transient provider failure. */
        | "retry_started";
      readonly model?: string;
      readonly from?: string;
      readonly to?: string;
      /** Index of the route in the fallback chain. Stable across same-model retries. */
      readonly attemptIndex?: number;
      /** Which retry of `attemptIndex` this is: 1 for the first retry, 2 for the second. */
      readonly retryIndex?: number;
      /**
       * Classified failure subkind that caused this transition ("overloaded",
       * "rate_limited", "context_limit", …), on `failover_started` and
       * `retry_started`. Absent when the router could not classify it.
       */
      readonly reason?: string;
      readonly durationMs?: number;
      readonly cancelled?: boolean;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "memory_recalled";
      readonly source?: string;
      readonly bytes?: number;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      /**
       * Catch-all for low-frequency runtime telemetry (cache_hit/cache_miss,
       * capabilities_resolved, provider_bridge_latency, …) so new kinds ride
       * through without further union growth. Consumers render or ignore by
       * `kind`; `data` is the raw event payload minus its `type`.
       */
      readonly type: "runtime_telemetry";
      readonly kind: string;
      readonly data?: Record<string, unknown>;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "runtime_warning";
      readonly message: string;
      readonly warningKind?: string;
      readonly metadata?: AgentResponseMetadata;
    };

export interface AgentMessageStream {
  status?(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace?(text: string): Promise<void>;
  event?(event: AgentStreamEvent): Promise<void>;
  finish?(finalText?: string, options?: AgentMessageFinishOptions): Promise<void>;
}

/** Maximum characters accepted by the in-flight steering mailbox. */
export const AGENT_LIVE_INPUT_MAX_CHARACTERS = 8_000;

/** Maximum live messages retained by one active logical turn. */
export const AGENT_LIVE_INPUT_MAX_MESSAGES = 100;

/** One transport-neutral follow-up offered to the currently running turn. */
export interface AgentLiveInputRequest {
  readonly conversationId: string;
  /** Stable transport message id, used to make duplicate delivery idempotent. */
  readonly id: string;
  readonly text: string;
  /** ISO-8601 transport receipt time, preserved in canonical history. */
  readonly receivedAt: string;
  /**
   * Host-owned durable delivery identity for a background wake. The responder
   * uses it only to recover private wake context; it is never added to prompts
   * or canonical history.
   */
  readonly deliveryKey?: string;
  /**
   * Exact active run selected by the host wake coordinator. Ordinary channel
   * callers leave this unset; the mailbox rejects a stale/mismatched target.
   */
  readonly targetRunId?: string;
}

export type AgentLiveInputUnavailableReason =
  | "inactive"
  | "unsupported"
  | "too_large"
  | "full"
  | "invalid";

export type AgentLiveInputSettlement =
  | { readonly status: "applied"; readonly runId: string }
  | { readonly status: "requeue"; readonly reason: "unsupported" | "closed" | "failed" }
  | { readonly status: "discarded"; readonly reason: "cancelled" };

/**
 * Immediate ownership result for a live follow-up. An accepted offer remains
 * represented by the caller's reserved normal-turn queue slot until `settled`
 * says whether that reservation should become a no-op or run normally.
 */
export type AgentLiveInputOffer =
  | { readonly status: "unavailable"; readonly reason: AgentLiveInputUnavailableReason }
  | { readonly status: "accepted"; readonly settled: Promise<AgentLiveInputSettlement> };

export interface AgentResponder<
  Request extends AgentRequestBase = AgentRequestBase,
  Stream extends AgentMessageStream = AgentMessageStream,
  Response extends AgentResponse = AgentResponse,
> {
  respond(request: Request, stream: Stream): Promise<Response>;
  /**
   * Optional: offer a text follow-up to the active turn without starting a
   * parallel response. Callers reserve their ordinary queue position first so
   * an unsupported or end-of-turn race can deterministically requeue it.
   */
  offerLiveInput?(request: AgentLiveInputRequest): AgentLiveInputOffer;
  /**
   * Optional: abort the in-flight turn for a conversation and clear any queued
   * follow-ups. Channels call this on an explicit user cancel (e.g. /cancel).
   */
  cancel?(conversationId: string, reason?: unknown): void;
  /**
   * Optional: record a message that a channel posted VERBATIM to `conversationId`
   * without running a turn (native cron/webhook notification delivery). The text
   * is appended to the conversation's durable history — and any warm provider
   * session for it is retired — so a later user reply resumes with the delivered
   * message in context. No model call happens here; the text was already posted.
   */
  deliverVerbatim?(
    conversationId: string,
    text: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
  /**
   * Optional app-owned generated-file resolver. Implementations authenticate by
   * exact conversation ownership and return a bounded stream, never a path.
   */
  openReplyArtifact?(request: AgentReplyArtifactOpenRequest): Promise<AgentReplyArtifactStream>;
  /** Load private MCP App resource/input/result state for one authorized host instance. */
  loadMcpApp?(request: AgentMcpAppLoadRequest): Promise<AgentMcpAppResource>;
  /** Execute one bounded host/app bridge request against the originating MCP connection. */
  requestMcpApp?(request: AgentMcpAppHostRequest): Promise<unknown>;
}

export interface AgentResponseCancelledErrorOptions {
  readonly reason?: unknown;
}

/**
 * Stable abort reason for an explicit channel-user cancellation such as
 * `/cancel`. Adapters use this to distinguish a command they already
 * acknowledged from provider, transport, or shutdown cancellation, whose
 * existing terminal delivery behavior must remain unchanged.
 */
export class ChannelUserCancelReason extends Error {
  readonly channel: string;
  /** Cross-package brand; survives duplicate package identities. */
  readonly channelUserCancel = true as const;

  constructor(channel: string) {
    const normalizedChannel = channel.trim();
    if (normalizedChannel.length === 0) {
      throw new TypeError("Channel user cancel reason requires a channel name.");
    }
    super(`Cancelled by ${normalizedChannel} user.`);
    this.name = "ChannelUserCancelReason";
    this.channel = normalizedChannel;
  }
}

/** Create the branded reason passed to responder and adapter abort controllers. */
export function createChannelUserCancelReason(channel: string): ChannelUserCancelReason {
  return new ChannelUserCancelReason(channel);
}

/** Recognize a channel-user cancellation across duplicate package identities. */
export function isChannelUserCancelReason(
  reason: unknown,
): reason is ChannelUserCancelReason {
  return hasOwnTrueDataProperty(reason, "channelUserCancel");
}

export class AgentResponseCancelledError extends Error {
  readonly reason?: unknown;
  /**
   * Stable brand so the guard recognizes cancellation even across duplicate
   * class identities (e.g. two copies of this package in a dependency graph),
   * without string-matching subclass `name`s.
   */
  readonly agentResponseCancelled = true as const;

  constructor(
    message = "Agent response was cancelled.",
    options: AgentResponseCancelledErrorOptions = {},
  ) {
    super(message);
    this.name = "AgentResponseCancelledError";
    if (options.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}

export function isAgentResponseCancelledError(
  error: unknown,
): error is AgentResponseCancelledError {
  return hasOwnTrueDataProperty(error, "agentResponseCancelled");
}

/** Read one exact cross-package brand without invoking accessors or Proxy traps. */
function hasOwnTrueDataProperty(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.value === true;
  } catch {
    return false;
  }
}

export { CodedError, isCodedError } from "./coded-error.js";
export {
  MAX_AGENT_REPLY_PARTS,
  serializeAgentStreamFrame,
  parseAgentStreamFrame,
  frameFeedingMessageStream,
} from "./stream-wire.js";
export type { AgentStreamWireFrame } from "./stream-wire.js";
export {
  isAgentReplyPartDeliveryOutcomes,
  sanitizeReplyPartDeliveryOutcomes,
  unsupportedReplyPartDeliveryOutcomes,
} from "./reply-part-outcomes.js";
export type {
  AgentReplyPartDeliveryOutcome,
  AgentReplyPartDeliveryType,
} from "./reply-part-outcomes.js";
export {
  BufferedMessageStream,
} from "./buffered-message-stream.js";
export type {
  BufferedMessageStreamOptions,
} from "./buffered-message-stream.js";
export {
  DEFAULT_EMPTY_FINAL_TEXT,
  DEFAULT_MAX_MESSAGE_CHARS,
  buildStreamingTailPreview,
  normalizeTrailing,
  splitTextByCodePoints,
  splitTextForChat,
} from "./stream-text.js";
export {
  formatLiveInputActivityLine,
  formatProviderStatusLine,
  isSubagentLaunchToolName,
  setToolActivityPathRoots,
  splitSubagentToolName,
  SUBAGENT_TOOL_SEPARATOR,
  toolHintFor,
  toolNameLeaf,
} from "./tool-hints.js";
export type { ToolActivityLineOptions } from "./tool-hints.js";
export {
  ResilientMessageStream,
  ChannelDeliveryError,
  appendReplyPartFallback,
} from "./resilient-message-stream.js";
export type {
  ChannelTransport,
  ChannelDeliveryDisposition,
  ChannelFailureCertainty,
  ChannelMessageContentKind,
  ChannelSendOutcome,
  MessageRef,
  ResilientMessageStreamOptions,
  ResilientMessageStreamLogger,
  ResilientAgentMessageStream,
} from "./resilient-message-stream.js";
export type {
  ChannelConfigInput,
  ChannelConfigViewField,
  ChannelConfigViewFieldSource,
  ChannelConfigViewSection,
  ChannelDriver,
  ChannelId,
  ChannelAskAnswer,
  ChannelAskOption,
  ChannelAskQuestion,
  ChannelAskSnapshot,
  ChannelAskStatus,
  ChannelAskSubmission,
  ChannelAskSubmissionResult,
  ChannelInteractionHub,
  ChannelInteractionSink,
  ChannelLogger,
  ChannelStartInput,
  ChannelStatus,
  NotifyDeliveryResult,
  NotifyDeliveryContext,
  NotifyDestination,
  ProcessJobWakeDeliveryInput,
  ProcessJobWakeDeliveryResult,
  ProcessJobWakeDisposition,
  RunningChannel,
  RunningProcessJobChannel,
} from "./channel.js";
export { isDeliverableConversation } from "./channel.js";
export {
  encodeJsonEnvValue,
  fieldSpecMappings,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readChoice,
  readCsv,
  readInteger,
  readJsonSection,
  readRecord,
  readRequired,
  readString,
  redactedSecret,
} from "./config-loader.js";
export type {
  ConfigErrorFactory,
  EnvEncodeKind,
  JsonEnvFieldSpec,
  JsonEnvMapping,
  RedactedSecretValue,
} from "./config-loader.js";
export {
  assertSafeBind,
  BoundedHttpResponseWriter,
  close,
  closeServerBounded,
  hostForUrl,
  isLoopbackHost,
  isWildcardHost,
  listen,
  normalizeHostForBind,
} from "./host-safety.js";
export type { BoundedHttpResponseWriterOptions, ListenErrorFactories } from "./host-safety.js";
export {
  bearerTokensEqual,
  generateBearerToken,
  readAuthorizationBearer,
} from "./bearer.js";
export { sanitizeInboundHttpHeaders } from "./http-headers.js";
export type { InboundHttpHeaders } from "./http-headers.js";
export {
  SettingsJsonError,
  readSettingsJson,
  writeSettingsJson,
} from "./json-source.js";
export type {
  ReadSettingsJsonResult,
  SettingsJsonErrorCode,
  SettingsJsonErrorDetails,
} from "./json-source.js";
export type {
  SettingsJson,
  SettingsJsonValue,
  SettingsPrimitive,
} from "./types.js";
export {
  CronOperatorWireError,
  MAX_CRON_OPERATOR_CONVERSATION_ID_BYTES,
  MAX_CRON_OPERATOR_CURSOR_BYTES,
  MAX_CRON_OPERATOR_DEGRADED_REASON_BYTES,
  MAX_CRON_OPERATOR_DETAIL_ARTIFACT_ID_BYTES,
  MAX_CRON_OPERATOR_DETAIL_ERROR_BYTES,
  MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES,
  MAX_CRON_OPERATOR_DETAIL_EVENTS,
  MAX_CRON_OPERATOR_DETAIL_FAILURE_KIND_BYTES,
  MAX_CRON_OPERATOR_DETAIL_TEXT_BYTES,
  MAX_CRON_OPERATOR_EXPRESSION_BYTES,
  MAX_CRON_OPERATOR_JOB_ID_BYTES,
  MAX_CRON_OPERATOR_JOBS,
  MAX_CRON_OPERATOR_RESPONSE_BYTES,
  MAX_CRON_OPERATOR_RUN_ID_BYTES,
  MAX_CRON_OPERATOR_RUN_PAGE,
  MAX_CRON_OPERATOR_SUMMARY_ARTIFACT_ID_BYTES,
  MAX_CRON_OPERATOR_SUMMARY_ERROR_BYTES,
  MAX_CRON_OPERATOR_SUMMARY_FAILURE_KIND_BYTES,
  MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES,
  MAX_CRON_OPERATOR_SUMMARY_TEXT_BYTES,
  MAX_CRON_OPERATOR_TIMEZONE_BYTES,
  parseCronOperatorJob,
  parseCronOperatorOverview,
  parseCronOperatorRunDetail,
  parseCronOperatorRunPage,
  parseCronOperatorRunSummary,
} from "./cron-operator-wire.js";
export type {
  CronOperatorHealth,
  CronOperatorJob,
  CronOperatorOverview,
  CronOperatorRun,
  CronOperatorRunBase,
  CronOperatorRunDetail,
  CronOperatorRunPage,
  CronOperatorRunStatus,
  CronOperatorRunSummary,
  CronOperatorRunTrigger,
  CronOperatorRunTruncatedField,
} from "./cron-operator-wire.js";
