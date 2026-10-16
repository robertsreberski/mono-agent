

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
