import { toolNameLeaf } from "@mono-agent/contracts";
import { CANCELLED_TURN_HISTORY_KEY_PREFIX, FAILED_TURN_HISTORY_KEY_PREFIX } from "../../harness/turn-continuity.js";
import type { RuntimeSessionTurnDescriptor, RuntimeSessionTurnReconciliationResult } from "@mono-agent/turn/host/types";
import type { HistoryMessage } from "../../context/index.js";
import { sha256, validatePendingTurnPayload } from "./contract.js";
import type { PendingTurnPayload, PendingTurnCandidate, DurableTurnOutcome } from "./contract.js";

export function pendingTurnDescriptor(payload: PendingTurnPayload): RuntimeSessionTurnDescriptor {
  const identity = payload.identity;
  return Object.freeze({ kind: "host" as const, ownerKey: identity.ownerKey, historyBucket: identity.historyBucket,
    turnId: identity.turnId, handleId: identity.handleId, baseRevision: identity.baseRevision,
    reconciliation: Object.freeze({ version: 1 as const, purpose: identity.purpose, fenceDigest: identity.fenceDigest,
      initialInputId: payload.inputs.find((input) => input.kind === "initial")?.id ?? null }) });
}
export function turnInputDigest(payload: PendingTurnPayload): string { return sha256(Buffer.from(JSON.stringify(payload.inputs))); }
export function turnCandidateDigest(payload: PendingTurnPayload): string { return sha256(Buffer.from(JSON.stringify(payload.candidate ?? null))); }

type MatchedTurn = Extract<RuntimeSessionTurnReconciliationResult, { status: "matched" }>;

/** Legacy manual no-op bug: a declined cut sealed success over a failed op.
 * Never adopt execution, changed context, inputs, or partial operation work. */
function isLegacyFailedCompactionNoop(payload: PendingTurnPayload, result: MatchedTurn): boolean {
  const operation = result.operations[0];
  return payload.identity.purpose === "compaction" && payload.inputs.length === 0
    && result.inputs.length === 0 && result.admittedInputs.length === 0 && result.consumedInputIds.length === 0
    && result.outcome === "completed" && result.seal?.outcome === "completed"
    && result.operations.length === 1 && operation?.type === "compaction" && operation.cause === "manual"
    && operation.parentOperationId === null && !operation.suspended
    && (operation.status === "failed" || operation.status === "aborted")
    && result.tipId === result.baselineTipId && result.currentTipId === result.baselineTipId
    && operation.baselineTipId === result.baselineTipId && operation.tipId === result.baselineTipId
    && result.interruptionEvidence.length === 0;
}

/** Defense-in-depth over the storage-only native matcher. No partial operation adoption. */
function assertWholeTurnMatch(payload: PendingTurnPayload, result: Extract<RuntimeSessionTurnReconciliationResult, { status: "matched" }>): void {
  const descriptor = pendingTurnDescriptor(payload);
  if (result.turnId !== descriptor.turnId || result.handleId !== descriptor.handleId) throw new Error("Native turn identity mismatch");
  for (const key of ["kind", "ownerKey", "historyBucket", "turnId", "handleId", "baseRevision"] as const) {
    if (result.binding[key] !== descriptor[key]) throw new Error("Native turn binding mismatch");
  }
  for (const key of ["version", "purpose", "fenceDigest", "initialInputId"] as const) {
    if (result.binding.reconciliation?.[key] !== descriptor.reconciliation![key]) throw new Error("Native reconciliation binding mismatch");
  }
  const expected = new Map(payload.inputs.map((input) => [input.id, input]));
  const consumed = new Set(result.consumedInputIds);
  if (consumed.size !== result.consumedInputIds.length || [...consumed].some((id) => !expected.has(id))) throw new Error("Native consumed identity mismatch");
  for (const input of result.inputs) {
    const admitted = expected.get(input.id);
    if (!admitted || !input.complete || input.requestDigest !== admitted.requestDigest
      || (input.placement !== admitted.placement && !(input.placement === "replay" && admitted.kind === "initial"))) throw new Error("Native consumed input mismatch");
  }
  for (const input of result.admittedInputs) {
    const admitted = expected.get(input.id);
    if (!admitted || input.requestDigest !== admitted.requestDigest || input.placement !== admitted.placement) throw new Error("Native admitted input mismatch");
  }
  type Operation = MatchedTurn["operations"][number];
  const operations = new Set<string>(), sequences = new Set<number>();
  const active: Operation[] = [];
  let startSeq = -1, finalOperation: Operation | undefined;
  for (const operation of result.operations) {
    while (active.length && active.at(-1)!.endSeq! < operation.startSeq) active.pop();
    const parent = active.at(-1);
    if (operations.has(operation.operationId) || !Number.isSafeInteger(operation.startSeq) || operation.startSeq <= startSeq
      || operation.startSeq < 0 || operation.endSeq === null || !Number.isSafeInteger(operation.endSeq)
      || operation.endSeq <= operation.startSeq || operation.status === null
      || sequences.has(operation.startSeq) || sequences.has(operation.endSeq)
      || operation.parentOperationId !== (parent?.operationId ?? null)
      || (parent && (active.length !== 1 || parent.type !== "prompt" || operation.type !== "compaction"
        || operation.endSeq >= parent.endSeq!))) throw new Error("Native ordered operation evidence mismatch");
    operations.add(operation.operationId); startSeq = operation.startSeq;
    sequences.add(operation.startSeq); sequences.add(operation.endSeq); active.push(operation);
    // Nested compactions start after their prompt and finish before it.
    // The journal's final operation is the last one closed, not started.
    if (!finalOperation || operation.endSeq > finalOperation.endSeq!) finalOperation = operation;
  }
  if (result.finalOperationId !== (finalOperation?.operationId ?? null)) throw new Error("Native final operation mismatch");
  // Manual compaction can close without an operation when the retained tail
  // is already too small. Its completed turn seal still proves the no-op;
  // execution always requires the final completed prompt operation.
  if (result.outcome === "completed" && ((!finalOperation && payload.identity.purpose !== "compaction")
    || (finalOperation && payload.identity.purpose === "execution" && finalOperation.type !== "prompt")
    || (finalOperation && finalOperation.status !== "completed") || !result.seal
    || result.seal.outcome !== "completed") && !isLegacyFailedCompactionNoop(payload, result)) throw new Error("Native completion is not sealed");
}

interface TurnSettlement {
  readonly outcome: DurableTurnOutcome;
  readonly candidate?: PendingTurnCandidate;
  readonly messages: readonly HistoryMessage[];
  readonly nativeReusable: boolean;
  readonly journalId: string | null;
  readonly tipId: string | null;
}
const interruptionText = "The previous turn was interrupted. Draft output may be lost and tool outcomes may be unknown. No tools were replayed; send a new message to continue.";
export function projectTurnSettlement(payload: PendingTurnPayload, result: RuntimeSessionTurnReconciliationResult, timestamp: string): TurnSettlement {
  validatePendingTurnPayload(payload);
  const matched = result.status === "matched" ? result : undefined;
  if (matched) assertWholeTurnMatch(payload, matched);
  else if (result.status === "mismatch" && result.reason !== "unbound_turn") throw new Error(`Native reconciliation mismatch: ${result.reason}`);
  const legacyCompactionNoop = matched !== undefined && isLegacyFailedCompactionNoop(payload, matched);
  let outcome: DurableTurnOutcome = legacyCompactionNoop ? "failed" : matched?.outcome ?? "interrupted";
  const detached = payload.disposition === "detached";
  if (!legacyCompactionNoop && payload.disposition === "cancelled") outcome = "cancelled";
  else if (!legacyCompactionNoop && detached) outcome = payload.candidate?.outcome ?? "interrupted";
  else if (payload.disposition === "failed" && (result.status === "absent" || (matched && (matched.outcome === "completed" || matched.outcome === "failed")))) outcome = "failed";
  const seal = matched?.commitCandidate ?? matched?.seal?.result;
  const useHost = payload.candidate && (detached || (outcome === "completed" && payload.candidate.initialTimestamp !== undefined) || ((payload.disposition === "cancelled" || payload.disposition === "failed") && payload.candidate.outcome === outcome));
  let candidate: PendingTurnCandidate | undefined;
  if (payload.identity.purpose === "execution") {
    candidate = useHost ? payload.candidate : outcome === "completed" && seal
      ? { outcome, text: seal.text, timestamp, error: null, failureKind: null, ...(seal.turnDisposition === "silent" ? { silent: "finish_silently" as const } : {}) }
      : { outcome, text: outcome === "interrupted" ? interruptionText : outcome === "cancelled" ? "The previous turn was cancelled. No tools were replayed." : "The previous turn failed. No tools were replayed.",
        timestamp, error: null, failureKind: outcome === "failed" ? seal?.failureKind ?? "failed" : outcome };
    // A completed execution without the final seal's candidate is not success.
    if (outcome === "completed" && !useHost && !seal) {
      outcome = "interrupted";
      candidate = { outcome, text: interruptionText, timestamp, error: null, failureKind: "interrupted" };
    }
    if (detached && !payload.candidate) candidate = { outcome: "interrupted", text: `${interruptionText} A detached attempt had no durable host candidate; later attempt outcomes may be unknown.`, timestamp, error: null, failureKind: "interrupted" };
    if (candidate!.outcome !== outcome) candidate = { ...candidate!, outcome };
    if (!useHost && outcome !== "completed" && matched) {
      const classification = outcome === "failed" && ["usage_limit", "context_limit", "provider_unavailable", "auth_required", "timeout"].includes(seal?.failureKind ?? "")
        ? ` Failure category: ${seal!.failureKind}.` : "";
      const calls = matched.interruptionEvidence.flatMap((account) => account.calls);
      const observed = calls.filter((call) => call.cause === "observed_outcome").length;
      const skipped = calls.filter((call) => call.cause === "skipped").length;
      const unknown = calls.length - observed - skipped;
      candidate = { ...candidate!, text: `${candidate!.text}${classification} Recovery evidence: ${observed} observed tool outcomes; ${unknown} unknown; ${skipped} skipped.${matched.operations.some((operation) => operation.suspended) ? " Suspended work was not resumed." : ""}` };
    }
  }
  const messages: HistoryMessage[] = [];
  if (payload.identity.purpose === "execution") {
    const initial = payload.inputs.find((input) => input.kind === "initial")!;
    if (initial.kind === "initial") messages.push({ role: "user", content: initial.persistText, timestamp: candidate?.initialTimestamp ?? initial.timestamp,
      runId: payload.identity.turnId, ...(initial.senderLabel === undefined ? {} : { name: initial.senderLabel }) });
    const consumedIds = detached ? payload.candidate?.consumedInputIds ?? matched?.consumedInputIds ?? [] : matched?.consumedInputIds ?? [];
    for (const id of consumedIds) {
      const input = payload.inputs.find((entry) => entry.id === id);
      if (input?.kind === "live") messages.push({ role: "user", content: input.persistText, timestamp: input.receivedAt, runId: payload.identity.turnId });
    }
    if (candidate?.text !== null && candidate?.text !== undefined) messages.push({ role: "assistant", content: candidate.text,
      timestamp: candidate.timestamp, runId: payload.identity.turnId,
      ...(outcome === "cancelled" || outcome === "failed" ? { idempotencyKey: `${outcome === "cancelled" ? CANCELLED_TURN_HISTORY_KEY_PREFIX : FAILED_TURN_HISTORY_KEY_PREFIX}${payload.identity.turnId}` } : {}) });
    if (outcome !== "completed" && matched?.interruptionEvidence.some((account) => account.calls.some((call) =>
      call.admission === "started" && call.cause !== "observed_outcome" && call.cause !== "skipped"
      && toolNameLeaf(call.name).toLowerCase().replace(/[^a-z0-9]+/gu, "") === "askuser"))) {
      messages.push({ role: "assistant", content: "The question was interrupted. Answer in a new message; no tool was replayed.",
        timestamp: candidate?.timestamp ?? timestamp, runId: payload.identity.turnId });
    }
    const unconsumed = payload.inputs.filter((input) => input.kind === "live" && !consumedIds.includes(input.id)).length;
    // Completed turns can return unconsumed inputs to the caller for requeue.
    // Keep the recovery notice outside the bounded runtime candidate. The canonical
    // receipt commits it with this turn, including when candidate text is null.
    if (outcome !== "completed" && unconsumed > 0) messages.push({ role: "assistant",
      content: `Some messages sent during the previous turn (${unconsumed} total) were not confirmed as applied and were not replayed. Resend them if still needed.`,
      timestamp: candidate?.timestamp ?? timestamp, runId: payload.identity.turnId });
  }
  return { outcome, ...(candidate === undefined ? {} : { candidate }), messages,
    nativeReusable: matched !== undefined && !detached && !(matched.outcome === "completed" && outcome !== "completed") && matched.currentTipId === matched.tipId
      && (payload.identity.purpose === "compaction" || matched.consumedInputIds.includes(pendingTurnDescriptor(payload).reconciliation!.initialInputId!)),
    journalId: matched?.journalId ?? null, tipId: matched?.tipId ?? null };
}
