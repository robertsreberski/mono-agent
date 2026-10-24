import type { RuntimeToolLifecycleEvent, RuntimeToolLifecycleTerminalState } from "@mono-agent/turn/host/types";
import { createHash } from "node:crypto";
import { stripDailyBucketSuffix } from "../history/conversation-id.js";

export const TOOL_HISTORY_DIRECTORY = "tool-history";
export const TOOL_HISTORY_DATABASE = "tool-lifecycles.sqlite";
export const TOOL_HISTORY_OWNER_DATABASE = "tool-lifecycles-owner.sqlite";
export const TOOL_HISTORY_SCHEMA = "mono-agent.session-tool-history.v1";
export const TOOL_HISTORY_APPLICATION_ID = 0x4d415448;
export const TOOL_HISTORY_USER_VERSION = 2;
export const TOOL_HISTORY_PERSISTENCE_CEILING_MS = 250;
export const TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS = 10_000;

export interface ToolHistoryRetentionOptions {
  readonly maxCompletedCalls?: number;
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
  readonly maxTombstones?: number;
  readonly tombstoneMaxAgeMs?: number;
}

export interface ToolHistoryWriterOptions {
  readonly root: string;
  /** Positive capture/migration capability. Absent/false preserves v2. */
  readonly continuityEnabled?: boolean;
  /** Host-only root under which provider-reported artifact files may exist. */
  readonly artifactRoot?: string;
  readonly retention?: ToolHistoryRetentionOptions;
  readonly persistenceCeilingMs?: number;
  readonly ownerAcquireCeilingMs?: number;
  readonly onWarning?: (message: string) => void;
}

export interface ToolHistoryRunBinding {
  readonly conversationId: string;
  readonly logicalConversationId: string;
  readonly runId: string;
  readonly isolated: boolean;
}

export interface ToolHistoryArtifactReference {
  readonly id: string;
  readonly available: boolean;
}

export interface ToolHistoryRecordProjection {
  readonly recordId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly phase: "invocation" | "result";
  readonly sequence: number;
  readonly state?: RuntimeToolLifecycleTerminalState;
  readonly failureKind?: string;
  readonly detailCode?: string;
  readonly payload: unknown;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
  readonly isolated: boolean;
  readonly recovered: boolean;
  readonly runStartedAtMs: number;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly executionMs?: number;
  readonly artifactReferences: readonly ToolHistoryArtifactReference[];
  readonly untrusted: true;
}

export interface ToolHistorySearchInput {
  readonly logicalConversationId: string;
  readonly currentConversationId: string;
  readonly currentRunId: string;
  readonly query?: string;
  readonly tools?: readonly string[];
  readonly states?: readonly RuntimeToolLifecycleTerminalState[];
  readonly runIds?: readonly string[];
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly includeIsolated?: boolean;
  readonly limit?: number;
  readonly before?: ToolHistorySearchCursor;
}

export interface ToolHistorySearchCursor {
  readonly runStartedAtMs: number;
  readonly runId: string;
  readonly startSequence: number;
  readonly toolCallId: string;
  /** Opaque invocation id is the final cross-rollover ordering tie-breaker. */
  readonly recordId: string;
}

export interface ToolHistorySearchItem {
  readonly recordId: string;
  readonly resultRecordId?: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startSequence: number;
  readonly endSequence?: number;
  readonly state?: RuntimeToolLifecycleTerminalState;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
  readonly isolated: boolean;
  readonly recovered: boolean;
  readonly preview: string;
  readonly truncated: boolean;
  readonly artifactReferences: readonly ToolHistoryArtifactReference[];
  readonly untrusted: true;
}

export interface ToolHistorySearchPage {
  readonly items: readonly ToolHistorySearchItem[];
  readonly next?: ToolHistorySearchCursor;
}

export interface ToolHistoryProjectionItem {
  readonly call: ToolHistorySearchItem;
  readonly invocation: ToolHistoryGetResult;
  readonly result?: ToolHistoryGetResult;
}

export interface ToolHistoryGetInput {
  readonly logicalConversationId: string;
  readonly currentConversationId: string;
  readonly currentRunId: string;
  readonly recordId?: string;
  readonly toolCallId?: string;
  readonly includeIsolated?: boolean;
  readonly chunkOffset?: number;
  readonly chunkBytes?: number;
}

export interface ToolHistoryGetResult {
  readonly record?: ToolHistoryRecordProjection;
  readonly tombstone?: {
    readonly recordId: string;
    readonly reason: string;
    readonly removedAtMs: number;
  };
  readonly chunk?: string;
  readonly nextOffset?: number;
  readonly untrusted: true;
}

export interface ToolHistoryStats {
  readonly continuity?: import("./continuity-contracts.js").ContinuityStats;
  readonly calls: number;
  readonly records: number;
  readonly tombstones: number;
  readonly dangling: number;
  readonly orphanResults: number;
  readonly recovered: number;
  /** Distinct unresolved lifecycle-write incidents; the matching phase/run retry clears each one. */
  readonly writeFailures: number;
  /** Distinct unresolved conflicts; the matching canonical binding/phase retry clears each one. */
  readonly idempotencyConflicts: number;
  /** Unresolved failures since the latest successful retention pass. */
  readonly maintenanceFailures: number;
  /** Unresolved failures since the latest successful writer recovery. */
  readonly recoveryFailures: number;
  /** Bytes of bounded payload counted by the retention contract. */
  readonly retainedBytes: number;
  /** Physical SQLite allocation, reported separately from retained payload. */
  readonly bytes: number;
  readonly journalPresent: boolean;
  readonly limits: Required<ToolHistoryRetentionOptions>;
}

export interface WorkerRequest {
  readonly id: number;
  readonly operation: string;
  readonly payload?: unknown;
}

export interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly code?: string;
}

export function toolHistoryRecordId(
  conversationId: string,
  runId: string,
  toolCallId: string,
  phase: "invocation" | "result",
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([conversationId, runId, toolCallId, phase]))
    .digest("base64url");
  return `sth1_${digest}`;
}

/** Normalize only configured daily rollover buckets; natural '#' ids remain opaque otherwise. */
export function toolHistoryLogicalConversationId(
  conversationId: string,
  rollover: "none" | "daily" | undefined,
): string {
  return rollover === "daily" ? stripDailyBucketSuffix(conversationId) : conversationId;
}



export interface WorkerInput {
  readonly root: string;
  readonly continuityEnabled?: boolean;
  readonly artifactRoot: string;
  readonly artifactRootAliases: readonly string[];
  readonly retention?: ToolHistoryRetentionOptions;
  readonly ownerAcquireCeilingMs?: number;
}

export interface LifecyclePayload {
  readonly binding: ToolHistoryRunBinding;
  readonly event: RuntimeToolLifecycleEvent;
}
