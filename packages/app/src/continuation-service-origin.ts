import {
  assertAgentContinuationOriginContext,
  type AgentContinuationOriginContext,
} from "@mono-agent/contracts";

import type { DurableContinuationRecord } from "./continuation-store.js";
import {
  ContinuationProtocolError,
} from "./continuation-service-errors.js";
import {
  errorRecord,
} from "./continuation-service-helpers.js";
import {
  type ClaimBinding,
  type ResolvedOriginContext,
} from "./continuation-service-types.js";
import {
  TERMINAL_CONTINUATION_STATES,
  continuationDigest,
} from "./continuations.js";
import type { ContinuationOriginDependencies } from "./continuations/operation-ports.js";

export function createContinuationOriginOperations(dependencies: ContinuationOriginDependencies) {
  async function requiresOriginContext(binding: ClaimBinding): Promise<boolean> {
    if (dependencies.isStopped() || binding.settled) return false;
    if (!binding.closed) {
      throw new Error("Continuation claims must be revoked before origin settlement is inspected.");
    }
    const drain = dependencies.claimDrain(binding);
    if (drain !== undefined) await drain;
    const finishOperation = dependencies.beginSettlement(binding);
    if (finishOperation === undefined) return false;
    try {
      if (binding.historyBoundary === undefined) {
        dependencies.settleBinding(binding);
        return false;
      }
      const required = (await dependencies.store.list()).some((record) =>
        record.claimFingerprint === binding.fingerprint
        && !TERMINAL_CONTINUATION_STATES.has(record.state));
      if (!required) dependencies.settleBinding(binding);
      return required;
    } finally {
      finishOperation();
    }
  }

  async function finalizeOriginContext(
    binding: ClaimBinding,
    snapshot: AgentContinuationOriginContext,
  ): Promise<void> {
    const finishOperation = dependencies.beginSettlement(binding);
    if (finishOperation === undefined) return;
    try {
      if (binding.historyBoundary === undefined) return;
      assertAgentContinuationOriginContext(snapshot);
      if (snapshot.conversationId !== binding.originConversationId
        || snapshot.originRunId !== binding.originRunId
        || snapshot.historyBoundary !== binding.historyBoundary) {
        throw new Error("Continuation origin context does not match its immutable claim binding.");
      }
      const matching = (await dependencies.store.list()).filter((record) =>
        record.claimFingerprint === binding.fingerprint
        && !TERMINAL_CONTINUATION_STATES.has(record.state));
      if (matching.length === 0) return;
      const pin = await dependencies.store.stageOriginContext(snapshot);
      try {
        await dependencies.store.mutate((records) => {
          const candidates = [...records.values()].filter((record) =>
            record.claimFingerprint === binding.fingerprint
            && !TERMINAL_CONTINUATION_STATES.has(record.state));
          for (const record of candidates) {
            if (record.originContextState === "pinned"
              || (record.originContextState === "pending" && record.originContextRef !== undefined)) {
              if (record.originContextDigest !== pin.reference.digest
                || record.originContextRef?.digest !== pin.reference.digest) {
                throw new Error("Continuation origin context conflicts with an existing pinned snapshot.");
              }
              continue;
            }
            if (record.originContextState !== "pending") {
              throw new Error(`Continuation origin context cannot be finalized from ${record.originContextState}.`);
            }
            record.originContextRef = pin.reference;
            record.originContextDigest = pin.reference.digest;
            record.originContextMessageCount = pin.reference.messageCount;
            record.originContextFingerprint = continuationDigest(
              `mono-agent-origin-context-binding-v2\0${record.claimFingerprint}\0${pin.reference.digest}`,
            );
            record.originContextBindingMac = dependencies.bindingMac(record, pin.reference);
            record.updatedAt = dependencies.now().toISOString();
          }
        });
      } finally {
        await pin.release();
      }
    } finally {
      finishOperation();
    }
  }

  async function activateOriginContext(binding: ClaimBinding): Promise<void> {
    const finishOperation = dependencies.beginSettlement(binding);
    if (finishOperation === undefined) return;
    try {
      await dependencies.store.activateOriginContextGroup({
        claimFingerprint: binding.fingerprint,
        activatedAt: dependencies.now().toISOString(),
      });
      dependencies.settleBinding(binding);
    } finally {
      finishOperation();
    }
  }

  async function abandonOriginContext(binding: ClaimBinding): Promise<void> {
    const finishOperation = dependencies.beginSettlement(binding);
    if (finishOperation === undefined) return;
    const at = dependencies.now().toISOString();
    try {
      await dependencies.store.mutate((records) => {
        for (const record of records.values()) {
          if (record.claimFingerprint !== binding.fingerprint || record.originContextState !== "pending") continue;
          record.originContextState = "abandoned";
          delete record.originContextRef;
          record.updatedAt = at;
          record.lastError = errorRecord(
            "origin_context_unavailable",
            "The origin run did not commit its pinned continuation context.",
            at,
          );
          delete record.nextAttemptAt;
        }
      });
      dependencies.settleBinding(binding);
      dependencies.scheduleProcess();
    } finally {
      finishOperation();
    }
  }

  async function resolveOriginContext(record: DurableContinuationRecord): Promise<ResolvedOriginContext> {
    if (record.originContextState === "detached_latest") return { kind: "ready", policy: "detached_latest" };
    if (record.originContextState === "pending") return { kind: "pending" };
    if (record.originContextState !== "pinned" || record.originContextRef === undefined) {
      return { kind: "unavailable" };
    }
    const expectedFingerprint = continuationDigest(
      `mono-agent-origin-context-binding-v2\0${record.claimFingerprint}\0${record.originContextRef.digest}`,
    );
    const expectedMac = dependencies.bindingMac(record, record.originContextRef);
    if (record.originContextDigest !== record.originContextRef.digest
      || record.originContextFingerprint !== expectedFingerprint
      || record.originContextBindingMac !== expectedMac) {
      return { kind: "invalid", code: "origin_context_binding_invalid" };
    }
    let snapshot: AgentContinuationOriginContext | undefined;
    try {
      snapshot = await dependencies.store.loadOriginContext(record.originContextRef);
    } catch {
      await markOriginContextUnavailable(record.continuationId, "origin_context_unreadable");
      return { kind: "unavailable" };
    }
    if (snapshot === undefined
      || snapshot.conversationId !== record.originConversationId
      || snapshot.originRunId !== record.originRunId
      || snapshot.historyBoundary !== record.historyBoundary) {
      await markOriginContextUnavailable(record.continuationId, "origin_context_missing_or_corrupt");
      return { kind: "unavailable" };
    }
    return { kind: "ready", policy: "pinned", snapshot };
  }

  async function markOriginContextUnavailable(id: string, code: string): Promise<void> {
    await dependencies.store.mutate((records) => {
      const current = records.get(id);
      if (current === undefined) throw new ContinuationProtocolError(404, "not_found", "Continuation not found.");
      if (current.leaseOwner !== dependencies.instanceId) {
        throw new ContinuationProtocolError(409, "lease_lost", "Continuation processing lease was lost.");
      }
      current.originContextState = "abandoned";
      delete current.originContextRef;
      current.updatedAt = dependencies.now().toISOString();
      current.lastError = errorRecord(code, "Pinned origin context is unavailable.", current.updatedAt);
    });
  }
  return { requiresOriginContext, finalizeOriginContext, activateOriginContext, abandonOriginContext, resolveOriginContext };
}
