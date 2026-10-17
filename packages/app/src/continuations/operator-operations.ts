import {
  ContinuationOperationTimeoutError,
  ContinuationProtocolError,
  ContinuationServiceStoppingError,
} from "../continuation-service-errors.js";
import {
  boundedHistoryErrorCode,
  clearLease,
  errorRecord,
  requireRecord,
  statusOfRequired,
} from "../continuation-service-helpers.js";
import {
  CONTINUATION_STATES,
  TERMINAL_CONTINUATION_STATES,
  type ContinuationHealthSnapshot,
  type ContinuationHistoryRecordResult,
  type ContinuationStatusSnapshot,
} from "../continuations.js";
import type { ContinuationOperatorDependencies } from "./operation-ports.js";

export function createContinuationOperatorOperations(dependencies: ContinuationOperatorDependencies) {
  async function retry(
    id: string,
    options?: { readonly allowUnknown?: boolean },
  ): Promise<ContinuationStatusSnapshot> {
    const record = await dependencies.store.mutate((records) => {
      const current = requireRecord(records, id);
      if (current.state === "delivery_unknown" && options?.allowUnknown !== true) {
        throw new ContinuationProtocolError(409, "delivery_unknown", "Resolve the ambiguous delivery before retrying.");
      }
      if (current.state !== "delivery_retry" && current.state !== "dead_lettered" && current.state !== "delivery_unknown") {
        throw new ContinuationProtocolError(409, "not_retryable", `Continuation state ${current.state} is not retryable.`);
      }
      if (current.synthesizedText === undefined && current.mode !== "silent") {
        throw new ContinuationProtocolError(
          409,
          "synthesis_not_retryable",
          "Continuation synthesis has no persisted output and cannot be repeated.",
        );
      }
      current.state = "ready_to_deliver";
      current.nextAttemptAt = dependencies.now().toISOString();
      delete current.deliveryStartedAt;
      delete current.lastError;
      current.updatedAt = dependencies.now().toISOString();
      clearLease(current);
      return structuredClone(current);
    });
    dependencies.scheduleProcess();
    return statusOfRequired(record);
  }

  async function cancel(id: string): Promise<ContinuationStatusSnapshot> {
    const record = await dependencies.store.mutate((records) => {
      const current = requireRecord(records, id);
      if (TERMINAL_CONTINUATION_STATES.has(current.state)) {
        if (current.state === "cancelled") return structuredClone(current);
        throw new ContinuationProtocolError(409, "already_terminal", `Continuation is already ${current.state}.`);
      }
      if (current.leaseOwner !== undefined || current.state === "synthesizing" || current.deliveryStartedAt !== undefined) {
        throw new ContinuationProtocolError(
          409,
          "continuation_in_flight",
          "Continuation has an active synthesis or native delivery; cancellation cannot make that side effect disappear.",
        );
      }
      current.state = "cancelled";
      current.updatedAt = dependencies.now().toISOString();
      current.lastError = errorRecord("cancelled_by_operator", "Continuation cancelled by the operator.", current.updatedAt);
      clearLease(current);
      return structuredClone(current);
    });
    return statusOfRequired(record);
  }

  async function resolveUnknown(
    id: string,
    outcome: { readonly kind: "delivered"; readonly deliveryId?: string }
      | { readonly kind: "not_delivered" }
      | { readonly kind: "dead_lettered" },
  ): Promise<ContinuationStatusSnapshot> {
    if (dependencies.isResolvingUnknown(id)) {
      throw new ContinuationProtocolError(409, "resolution_in_progress", "This ambiguous delivery is already being resolved.");
    }
    dependencies.beginResolvingUnknown(id);
    try {
      const current = await dependencies.store.get(id);
      if (current === undefined) throw new ContinuationProtocolError(404, "not_found", "Continuation not found.");
      if (current.state !== "delivery_unknown") {
        throw new ContinuationProtocolError(409, "not_delivery_unknown", "Only delivery_unknown continuations can be resolved.");
      }

      let history: ContinuationHistoryRecordResult | undefined;
      if (outcome.kind === "delivered") {
        if (dependencies.recordHistory === undefined
          || current.replyToConversationId === undefined
          || current.synthesizedText === undefined) {
          history = { recorded: false, code: "history_record_unavailable_after_ambiguous_delivery" };
        } else {
          try {
            history = await dependencies.runBoundedOperation(
              "delivery",
              dependencies.limits.deliveryTimeoutMs,
              async () => await dependencies.recordHistory?.({
                continuationId: current.continuationId,
                conversationId: current.replyToConversationId as string,
                text: current.synthesizedText as string,
                deliveryKey: `continuation:${current.continuationId}`,
              }) ?? { recorded: false, code: "history_record_unavailable_after_ambiguous_delivery" },
            );
          } catch (error) {
            if (error instanceof ContinuationServiceStoppingError) throw error;
            history = {
              recorded: false,
              code: error instanceof ContinuationOperationTimeoutError
                ? "history_record_timeout_after_ambiguous_delivery"
                : "history_record_failed_after_ambiguous_delivery",
            };
          }
        }
      }

      const record = await dependencies.store.mutate((records) => {
        const mutable = requireRecord(records, id);
        if (mutable.state !== "delivery_unknown") {
          throw new ContinuationProtocolError(409, "not_delivery_unknown", "Only delivery_unknown continuations can be resolved.");
        }
        const at = dependencies.now().toISOString();
        mutable.updatedAt = at;
        delete mutable.deliveryStartedAt;
        if (outcome.kind === "delivered") {
          const recorded = history?.recorded === true;
          mutable.state = "delivered";
          mutable.receipt = {
            kind: "delivered",
            deliveredAt: at,
            ...(outcome.deliveryId === undefined ? {} : { deliveryId: outcome.deliveryId }),
            historyRecorded: recorded,
            ...(recorded ? {} : {
              historyErrorCode: boundedHistoryErrorCode(
                history?.recorded === false
                  ? history.code
                  : "history_record_unavailable_after_ambiguous_delivery",
              ),
            }),
          };
          delete mutable.lastError;
        } else if (outcome.kind === "not_delivered") {
          mutable.state = "ready_to_deliver";
          mutable.nextAttemptAt = at;
          delete mutable.lastError;
        } else {
          mutable.state = "dead_lettered";
          mutable.lastError = errorRecord(
            "operator_dead_lettered",
            "Ambiguous delivery was dead-lettered by the operator.",
            at,
          );
        }
        return structuredClone(mutable);
      });
      if (outcome.kind === "not_delivered") dependencies.scheduleProcess();
      return statusOfRequired(record);
    } finally {
      dependencies.finishResolvingUnknown(id);
    }
  }

  async function health(): Promise<ContinuationHealthSnapshot> {
    const [records, storage] = await Promise.all([dependencies.store.list(), dependencies.store.stats()]);
    const counts = Object.fromEntries(CONTINUATION_STATES.map((state) => [state, 0])) as Record<
      (typeof CONTINUATION_STATES)[number],
      number
    >;
    let oldestPendingAt: string | undefined;
    let due = 0;
    const now = dependencies.now().getTime();
    for (const record of records) {
      counts[record.state] += 1;
      if (!TERMINAL_CONTINUATION_STATES.has(record.state)) {
        if (oldestPendingAt === undefined || record.createdAt < oldestPendingAt) oldestPendingAt = record.createdAt;
        if (record.nextAttemptAt === undefined || Date.parse(record.nextAttemptAt) <= now) due += 1;
      }
    }
    const pending = records.length - [...TERMINAL_CONTINUATION_STATES].reduce(
      (sum, state) => sum + counts[state],
      0,
    );
    const status = counts.delivery_unknown > 0 || counts.dead_lettered > 0
      ? "unhealthy"
      : pending > 0 || counts.expired > 0 || storage.historyDegraded > 0
        ? "degraded"
        : "healthy";
    return {
      status,
      checkedAt: dependencies.now().toISOString(),
      counts,
      pending,
      due,
      storage,
      ...(oldestPendingAt === undefined ? {} : { oldestPendingAt }),
    };
  }
  return { retry, cancel, resolveUnknown, health };
}
