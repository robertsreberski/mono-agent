import type { RuntimeEventLike } from "@mono-agent/observability";

import type { RuntimeSessionRecord, RuntimeSessionSnapshot } from "../sessions/warm-store.js";
import type { ConversationHarnessSessionBoundary, ConversationHarnessSessionEvent } from "./contracts.js";

export function withSessionBoundaryTimestamp(event: ConversationHarnessSessionBoundary, timestamp: string): RuntimeEventLike {
  const context = event.context ?? (event.reason === "cancelled_turn_resume" || event.reason === "failed_turn_resume"
    ? "retained"
    : event.kind === "rollover" || event.kind === "isolated"
      || ["model_change", "legacy_unbound_model", "cancelled_turn_reseed", "failed_turn_reseed",
        "resume_error", "runtime_result", "detached_context"].includes(event.reason ?? "")
      ? "reconstructed" : undefined);
  return { ...event, ...(context === undefined ? {} : { context }), timestamp: event.timestamp ?? timestamp };
}

export function sessionEventFromRecord(
  kind: ConversationHarnessSessionEvent["kind"],
  record: RuntimeSessionRecord | RuntimeSessionSnapshot,
  reason: string | undefined,
  snapshot: ConversationHarnessSessionEvent["snapshot"],
): ConversationHarnessSessionEvent {
  return {
    kind,
    ...(record.modelKey === undefined ? {} : { modelKey: record.modelKey }),
    conversationId: record.conversationId,
    providerSessionId: record.providerSessionId,
    ...(record.providerSessionRevision === undefined
      ? {}
      : { providerSessionRevision: record.providerSessionRevision }),
    ...(record.historyVersion === undefined ? {} : { historyVersion: record.historyVersion }),
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    busy: record.busy,
    ...(reason === undefined ? {} : { reason }),
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}

/** Sizes of the resolved replay actually supplied, never the prepared blocks,
 * provider occupancy, or completeness. Call only after late header resolution. */
export function reconstructionFacts(prepared: {
  readonly history: readonly import("../context/index.js").HistoryMessage[];
  readonly toolHistoryProjection: string | undefined;
  readonly toolProjectionRecords?: number;
}) {
  const coverageStartTimestamp = prepared.history.find((message) => message.timestamp !== undefined)?.timestamp;
  return {
    replayedMessageCount: prepared.history.length,
    toolProjectionBytes: Buffer.byteLength(prepared.toolHistoryProjection ?? "", "utf8"),
    ...(prepared.toolProjectionRecords === undefined ? {} : { toolProjectionRecords: prepared.toolProjectionRecords }),
    ...(coverageStartTimestamp === undefined ? {} : { coverageStartTimestamp }),
  };
}
