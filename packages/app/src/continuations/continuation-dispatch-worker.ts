import type { DurableContinuationRecord } from "./continuation-store.js";
import {
  ContinuationOperationTimeoutError,
  ContinuationServiceStoppingError,
  ContinuationSynthesisUnavailableError,
} from "./continuation-service-errors.js";
import {
  backoffMs,
  boundedHistoryErrorCode,
  clearLease,
  errorRecord,
  expire,
  requireLease,
  requireRecord,
  safeReason,
  synthesisInput,
} from "./continuation-service-helpers.js";
import {
  DEFAULT_DELIVERY_ATTEMPTS,
  MAX_TEXT_CHARS,
  ORIGIN_CONTEXT_UNAVAILABLE_TEXT,
  type ContinuationSynthesisAvailability,
  type ResolvedOriginContext,
} from "./continuation-service-types.js";
import {
  TERMINAL_CONTINUATION_STATES,
  type ContinuationNativeDeliveryResult,
} from "./continuations.js";
import type { ContinuationDispatchDependencies } from "./operation-ports.js";

export function createContinuationDispatchOperations(dependencies: ContinuationDispatchDependencies) {
  async function recover(startup = false): Promise<void> {
    const now = dependencies.now().getTime();
    const current = await dependencies.store.list();
    const needsRecovery = current.some((record) =>
      !TERMINAL_CONTINUATION_STATES.has(record.state)
      && (startup || !dependencies.isSupervised(record.continuationId))
      && (
        (startup && record.originContextState === "pending")
        || (startup && record.leaseOwner !== undefined)
        || Date.parse(record.deadline) <= now
        || (record.leaseUntil !== undefined && Date.parse(record.leaseUntil) <= now)
      ));
    if (!needsRecovery) return;
    await dependencies.store.mutate((records) => {
      for (const record of records.values()) {
        if (TERMINAL_CONTINUATION_STATES.has(record.state)) continue;
        if (startup && record.originContextState === "pending") {
          record.originContextState = "abandoned";
          delete record.originContextRef;
          record.updatedAt = dependencies.now().toISOString();
          record.lastError = errorRecord(
            "origin_context_unavailable",
            "The service restarted before the origin context was pinned.",
            record.updatedAt,
          );
          clearLease(record);
        }
        if (!startup && dependencies.isSupervised(record.continuationId)) continue;
        const abandonedAtStartup = startup && record.leaseOwner !== undefined;
        const leaseExpired = record.leaseUntil !== undefined && Date.parse(record.leaseUntil) <= now;
        if (record.deliveryStartedAt !== undefined
          && (abandonedAtStartup || leaseExpired || Date.parse(record.deadline) <= now)) {
          record.state = "delivery_unknown";
          record.lastError = errorRecord(
            "delivery_outcome_unknown",
            "Process stopped after native delivery began; automatic replay is unsafe.",
            dependencies.now().toISOString(),
          );
          clearLease(record);
          continue;
        }
        if (Date.parse(record.deadline) <= now) {
          expire(record, dependencies.now().toISOString());
          continue;
        }
        if (!abandonedAtStartup && !leaseExpired) continue;
        if (record.state === "synthesizing") {
          if (record.synthesizedText !== undefined) {
            record.state = "ready_to_deliver";
            clearLease(record);
          } else {
            record.state = "dead_lettered";
            record.lastError = errorRecord(
              "synthesis_outcome_unknown",
              "Process stopped after synthesis began; synthesis was not repeated.",
              dependencies.now().toISOString(),
            );
            clearLease(record);
          }
        } else {
          clearLease(record);
        }
      }
    });
  }

  async function processDue(limit = dependencies.limits.maxConcurrent): Promise<number> {
    if (dependencies.isStopped()) return 0;
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("Continuation process limit must be a non-negative safe integer.");
    }
    const jobs = await dependencies.startDueJobs(limit);
    const outcomes = await Promise.all(jobs);
    return outcomes.filter(Boolean).length;
  }

  async function processOne(id: string): Promise<boolean> {
    dependencies.throwIfStopping();
    const leased = await acquireLease(id);
    if (leased === undefined) return false;
    dependencies.throwIfStopping();
    let record = leased;
    if (record.originContextState === "pending") {
      await deferOriginContext(record.continuationId);
      return true;
    }
    if (record.synthesizedText === undefined && record.mode !== "silent") {
      const originContext = await dependencies.resolveOriginContext(record);
      if (originContext.kind === "pending") {
        await deferOriginContext(record.continuationId);
        return true;
      }
      if (originContext.kind === "invalid") {
        await deadLetter(
          record.continuationId,
          originContext.code,
          "Pinned continuation binding failed integrity verification; native delivery was blocked.",
        );
        return true;
      }
      if (originContext.kind === "unavailable") {
        record = await prepareOriginContextFallback(record.continuationId);
      } else {
        const available = await synthesisAvailable(record, originContext);
        if (!available.ready) {
          await deferSynthesis(record.continuationId, available.code, available.reason, available.retryAfterMs);
          return true;
        }
        record = await synthesize(record, originContext);
      }
      if (record.state !== "ready_to_deliver") return true;
    } else if (record.state !== "ready_to_deliver") {
      record = await markReady(record.continuationId);
    }
    if (await expireBeforeDeliveryIfNeeded(record.continuationId)) return true;
    dependencies.throwIfStopping();

    if (record.mode === "silent") {
      await markDelivered(record.continuationId, { kind: "silent", deliveredAt: dependencies.now().toISOString() });
      return true;
    }
    if (record.mode === "capture") {
      await markDelivered(record.continuationId, { kind: "captured", deliveredAt: dependencies.now().toISOString() });
      return true;
    }
    if (record.mode === "notify_if_actionable" && record.actionable === false) {
      await markDelivered(record.continuationId, { kind: "suppressed", deliveredAt: dependencies.now().toISOString() });
      return true;
    }
    await deliver(record);
    return true;
  }

  async function synthesisAvailable(
    record: DurableContinuationRecord,
    originContext: Extract<ResolvedOriginContext, { readonly kind: "ready" }>,
  ): Promise<ContinuationSynthesisAvailability> {
    if (dependencies.synthesisPreflight === undefined) return { ready: true };
    try {
      return await dependencies.runBoundedOperation(
        "synthesis",
        Math.min(dependencies.limits.synthesisTimeoutMs, 30_000),
        async () => await dependencies.synthesisPreflight?.(synthesisInput(record, originContext)) ?? { ready: true },
      );
    } catch (error) {
      if (error instanceof ContinuationServiceStoppingError) throw error;
      return {
        ready: false,
        code: error instanceof ContinuationOperationTimeoutError
          ? "synthesis_preflight_timeout"
          : "synthesis_preflight_failed",
        reason: safeReason(error),
      };
    }
  }

  async function deferOriginContext(id: string): Promise<DurableContinuationRecord> {
    return await dependencies.store.mutate((records) => {
      const current = requireRecord(records, id);
      requireLease(current, dependencies.instanceId);
      current.synthesisDeferrals += 1;
      const at = dependencies.now();
      current.state = "result_received";
      current.updatedAt = at.toISOString();
      current.nextAttemptAt = new Date(at.getTime() + backoffMs(
        current.synthesisDeferrals,
        1_000,
        5 * 60 * 1_000,
      )).toISOString();
      current.lastError = errorRecord(
        "origin_context_pending",
        "The origin run has not committed its pinned context yet.",
        current.updatedAt,
      );
      clearLease(current);
      return structuredClone(current);
    });
  }

  async function prepareOriginContextFallback(id: string): Promise<DurableContinuationRecord> {
    return await dependencies.store.mutate((records) => {
      const current = requireRecord(records, id);
      requireLease(current, dependencies.instanceId);
      current.synthesizedText = ORIGIN_CONTEXT_UNAVAILABLE_TEXT;
      current.completionKind = "origin_context_unavailable";
      current.state = "ready_to_deliver";
      current.updatedAt = dependencies.now().toISOString();
      delete current.nextAttemptAt;
      delete current.synthesisStartedAt;
      return structuredClone(current);
    });
  }

  async function deferSynthesis(
    id: string,
    code: string,
    reason: string,
    retryAfterMs = 1_000,
    consumedAttempt = false,
  ): Promise<DurableContinuationRecord> {
    return await dependencies.store.mutate((records) => {
      const current = requireRecord(records, id);
      requireLease(current, dependencies.instanceId);
      const at = dependencies.now();
      current.state = "result_received";
      current.updatedAt = at.toISOString();
      current.nextAttemptAt = new Date(at.getTime() + Math.max(0, retryAfterMs)).toISOString();
      current.lastError = errorRecord(code, reason, current.updatedAt);
      delete current.synthesisStartedAt;
      if (consumedAttempt) current.synthesisAttempts = Math.max(0, current.synthesisAttempts - 1);
      clearLease(current);
      return structuredClone(current);
    });
  }

  async function expireBeforeDeliveryIfNeeded(id: string): Promise<boolean> {
    const now = dependencies.now();
    return await dependencies.store.mutate((records) => {
      const current = requireRecord(records, id);
      requireLease(current, dependencies.instanceId);
      if (Date.parse(current.deadline) > now.getTime()) return false;
      expire(current, now.toISOString());
      return true;
    });
  }

  async function acquireLease(id: string): Promise<DurableContinuationRecord | undefined> {
    const now = dependencies.now();
    return await dependencies.store.mutate((records) => {
      const record = records.get(id);
      if (record === undefined || TERMINAL_CONTINUATION_STATES.has(record.state)) return undefined;
      if (record.leaseUntil !== undefined && Date.parse(record.leaseUntil) > now.getTime()) return undefined;
      if (Date.parse(record.deadline) <= now.getTime()) {
        expire(record, now.toISOString());
        return undefined;
      }
      record.leaseOwner = dependencies.instanceId;
      record.leaseUntil = new Date(now.getTime() + dependencies.leaseMs).toISOString();
      record.updatedAt = now.toISOString();
      return structuredClone(record);
    });
  }

  async function synthesize(
    record: DurableContinuationRecord,
    originContext: Extract<ResolvedOriginContext, { readonly kind: "ready" }>,
  ): Promise<DurableContinuationRecord> {
    const startedAt = dependencies.now().toISOString();
    const prepared = await dependencies.store.mutate((records) => {
      dependencies.throwIfStopping();
      const current = requireRecord(records, record.continuationId);
      requireLease(current, dependencies.instanceId);
      current.state = "synthesizing";
      current.synthesisAttempts += 1;
      current.synthesisStartedAt = startedAt;
      current.updatedAt = startedAt;
      delete current.nextAttemptAt;
      return structuredClone(current);
    });
    try {
      const result = await dependencies.runBoundedOperation(
        "synthesis",
        dependencies.limits.synthesisTimeoutMs,
        async () => await dependencies.synthesize(synthesisInput(prepared, originContext)),
      );
      dependencies.throwIfStopping();
      const text = result.text.trim();
      if (text.length === 0 || text.length > MAX_TEXT_CHARS) {
        throw new Error(text.length === 0
          ? "Synthesis returned empty text."
          : "Synthesis exceeded the 200,000 character limit.");
      }
      return await dependencies.store.mutate((records) => {
        const current = requireRecord(records, prepared.continuationId);
        requireLease(current, dependencies.instanceId);
        current.synthesizedText = text;
        current.completionKind = "synthesized";
        if (result.actionable !== undefined) current.actionable = result.actionable;
        current.state = "ready_to_deliver";
        current.updatedAt = dependencies.now().toISOString();
        delete current.lastError;
        delete current.synthesisStartedAt;
        return structuredClone(current);
      });
    } catch (error) {
      if (error instanceof ContinuationServiceStoppingError) throw error;
      if (error instanceof ContinuationSynthesisUnavailableError) {
        return await deferSynthesis(
          prepared.continuationId,
          error.code,
          error.message,
          error.retryAfterMs,
          true,
        );
      }
      return await dependencies.store.mutate((records) => {
        const current = requireRecord(records, prepared.continuationId);
        requireLease(current, dependencies.instanceId);
        const at = dependencies.now().toISOString();
        current.lastError = errorRecord(
          error instanceof ContinuationOperationTimeoutError
            ? "synthesis_timeout_outcome_unknown"
            : "synthesis_failed",
          safeReason(error),
          at,
        );
        current.updatedAt = at;
        clearLease(current);
        current.state = "dead_lettered";
        return structuredClone(current);
      });
    }
  }

  async function markReady(id: string): Promise<DurableContinuationRecord> {
    return await dependencies.store.mutate((records) => {
      const record = requireRecord(records, id);
      requireLease(record, dependencies.instanceId);
      record.state = "ready_to_deliver";
      record.updatedAt = dependencies.now().toISOString();
      return structuredClone(record);
    });
  }

  async function deliver(record: DurableContinuationRecord): Promise<void> {
    if (record.replyToConversationId === undefined || record.synthesizedText === undefined) {
      await deadLetter(record.continuationId, "missing_delivery_binding", "Continuation has no bound native destination or synthesized text.");
      return;
    }
    const started = await dependencies.store.mutate((records) => {
      dependencies.throwIfStopping();
      const current = requireRecord(records, record.continuationId);
      requireLease(current, dependencies.instanceId);
      current.deliveryAttempts += 1;
      const at = dependencies.now().toISOString();
      current.deliveryStartedAt = at;
      current.updatedAt = at;
      return structuredClone(current);
    });
    const conversationId = started.replyToConversationId;
    const text = started.synthesizedText;
    if (conversationId === undefined || text === undefined) {
      await deadLetter(started.continuationId, "missing_delivery_binding", "Continuation delivery binding disappeared before native delivery.");
      return;
    }
    let result: ContinuationNativeDeliveryResult;
    try {
      result = await dependencies.runBoundedOperation(
        "delivery",
        dependencies.limits.deliveryTimeoutMs,
        async () => await dependencies.deliver({
          continuationId: started.continuationId,
          conversationId,
          text,
          deliveryKey: `continuation:${started.continuationId}`,
        }),
      );
      dependencies.throwIfStopping();
    } catch (error) {
      if (error instanceof ContinuationServiceStoppingError) throw error;
      result = {
        kind: "unknown",
        code: error instanceof ContinuationOperationTimeoutError
          ? "delivery_timeout_outcome_unknown"
          : "delivery_threw",
        reason: safeReason(error),
      };
    }
    await dependencies.store.mutate((records) => {
      const current = requireRecord(records, started.continuationId);
      requireLease(current, dependencies.instanceId);
      const at = dependencies.now().toISOString();
      current.updatedAt = at;
      clearLease(current);
      if (result.kind === "delivered") {
        current.state = "delivered";
        delete current.deliveryStartedAt;
        delete current.nextAttemptAt;
        delete current.lastError;
        current.receipt = {
          kind: "delivered",
          deliveredAt: at,
          ...(result.deliveryId === undefined ? {} : { deliveryId: result.deliveryId }),
          ...(result.channelId === undefined ? {} : { channelId: result.channelId }),
          ...(result.historyRecorded === undefined ? {} : { historyRecorded: result.historyRecorded }),
          ...(result.historyRecorded !== false || result.historyErrorCode === undefined
            ? {}
            : { historyErrorCode: boundedHistoryErrorCode(result.historyErrorCode) }),
        };
      } else if (result.kind === "retryable" && current.deliveryAttempts < DEFAULT_DELIVERY_ATTEMPTS) {
        current.state = "delivery_retry";
        delete current.deliveryStartedAt;
        current.lastError = errorRecord(result.code, result.reason, at);
        const delay = result.retryAfterMs ?? backoffMs(current.deliveryAttempts, 1_000, 60 * 60 * 1_000);
        current.nextAttemptAt = new Date(dependencies.now().getTime() + delay).toISOString();
      } else if (result.kind === "unknown") {
        current.state = "delivery_unknown";
        current.lastError = errorRecord(result.code, result.reason, at);
      } else {
        current.state = "dead_lettered";
        delete current.deliveryStartedAt;
        const code = result.kind === "retryable" ? "delivery_attempts_exhausted" : result.code;
        current.lastError = errorRecord(code, result.reason, at);
      }
    });
  }

  async function markDelivered(
    id: string,
    receipt: NonNullable<DurableContinuationRecord["receipt"]>,
  ): Promise<void> {
    await dependencies.store.mutate((records) => {
      const record = requireRecord(records, id);
      requireLease(record, dependencies.instanceId);
      record.state = "delivered";
      record.receipt = receipt;
      record.updatedAt = receipt.deliveredAt;
      delete record.nextAttemptAt;
      delete record.lastError;
      clearLease(record);
    });
  }

  async function deadLetter(id: string, code: string, reason: string): Promise<void> {
    await dependencies.store.mutate((records) => {
      const record = requireRecord(records, id);
      record.state = "dead_lettered";
      record.updatedAt = dependencies.now().toISOString();
      record.lastError = errorRecord(code, reason, record.updatedAt);
      clearLease(record);
    });
  }
  return { recover, processDue, processOne };
}
