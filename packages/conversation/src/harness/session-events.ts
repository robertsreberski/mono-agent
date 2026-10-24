import type { prepareHarnessContext } from "./context-preparation.js";
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

/** Sizes of supplied replay evidence, never provider occupancy or completeness. */
export function reconstructionFacts(prepared: Pick<Awaited<ReturnType<typeof prepareHarnessContext>>,
  "history" | "toolHistoryProjection" | "toolProjectionRecords">) {
  const coverageStartTimestamp = prepared.history.find((message) => message.timestamp !== undefined)?.timestamp;
  return {
    replayedMessageCount: prepared.history.length,
    toolProjectionBytes: Buffer.byteLength(prepared.toolHistoryProjection ?? "", "utf8"),
    ...(prepared.toolProjectionRecords === undefined ? {} : { toolProjectionRecords: prepared.toolProjectionRecords }),
    ...(coverageStartTimestamp === undefined ? {} : { coverageStartTimestamp }),
  };
}
