import { CANCELLED_TURN_HISTORY_KEY_PREFIX, FAILED_TURN_HISTORY_KEY_PREFIX } from "./harness/turn-continuity.js";
import type { RuntimeSessionTurnDescriptor, RuntimeSessionTurnReconciliationResult } from "@mono-agent/runtime-adapter";
import type { HistoryMessage } from "./context/index.js";
import { sha256, validatePendingTurnPayload } from "./durable-turn-contract.js";
import type { PendingTurnPayload, PendingTurnCandidate, DurableTurnOutcome } from "./durable-turn-contract.js";

export function pendingTurnDescriptor(payload: PendingTurnPayload): RuntimeSessionTurnDescriptor {
  const identity = payload.identity;
  return Object.freeze({ kind: "host" as const, ownerKey: identity.ownerKey, historyBucket: identity.historyBucket,
    turnId: identity.turnId, handleId: identity.handleId, baseRevision: identity.baseRevision,
    reconciliation: Object.freeze({ version: 1 as const, purpose: identity.purpose, fenceDigest: identity.fenceDigest,
      initialInputId: payload.inputs.find((input) => input.kind === "initial")?.id ?? null }) });
}
export function turnInputDigest(payload: PendingTurnPayload): string { return sha256(Buffer.from(JSON.stringify(payload.inputs))); }
export function turnCandidateDigest(payload: PendingTurnPayload): string { return sha256(Buffer.from(JSON.stringify(payload.candidate ?? null))); }

/** Defense-in-depth over the storage-only native matcher. No partial operation adoption. */
export function assertWholeTurnMatch(payload: PendingTurnPayload, result: Extract<RuntimeSessionTurnReconciliationResult, { status: "matched" }>): void {
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
  const operations = new Set<string>(); let startSeq = -1;
  for (const operation of result.operations) {
    if (operations.has(operation.operationId) || !Number.isSafeInteger(operation.startSeq) || operation.startSeq <= startSeq
      || operation.endSeq === null || operation.endSeq <= operation.startSeq || operation.status === null
      || (operation.parentOperationId !== null && !operations.has(operation.parentOperationId))) throw new Error("Native ordered operation evidence mismatch");
    operations.add(operation.operationId); startSeq = operation.startSeq;
  }
  if (result.finalOperationId !== (result.operations.at(-1)?.operationId ?? null)) throw new Error("Native final operation mismatch");
  if (result.outcome === "completed" && (result.operations.at(-1)?.status !== "completed" || !result.seal
    || result.seal.outcome !== "completed")) throw new Error("Native completion is not sealed");
}

export interface TurnSettlement {
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
  let outcome: DurableTurnOutcome = matched?.outcome ?? "interrupted";
  const detached = payload.disposition === "detached";
  if (payload.disposition === "cancelled") outcome = "cancelled";
  else if (detached) outcome = payload.candidate?.outcome ?? "interrupted";
  else if (payload.disposition === "failed" && matched && (matched.outcome === "completed" || matched.outcome === "failed")) outcome = "failed";
  const seal = matched?.commitCandidate ?? matched?.seal?.result;
  const useHost = payload.candidate && (detached || ((payload.disposition === "cancelled" || payload.disposition === "failed") && payload.candidate.outcome === outcome));
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
    if (initial.kind === "initial") messages.push({ role: "user", content: initial.persistText, timestamp: initial.timestamp,
      runId: payload.identity.turnId, ...(initial.senderLabel === undefined ? {} : { name: initial.senderLabel }) });
    for (const id of detached ? payload.candidate?.consumedInputIds ?? matched?.consumedInputIds ?? [] : matched?.consumedInputIds ?? []) {
      const input = payload.inputs.find((entry) => entry.id === id);
      if (input?.kind === "live") messages.push({ role: "user", content: input.persistText, timestamp: input.receivedAt, runId: payload.identity.turnId });
    }
    if (candidate?.text !== null && candidate?.text !== undefined) messages.push({ role: "assistant", content: candidate.text,
      timestamp: candidate.timestamp, runId: payload.identity.turnId,
      ...(outcome === "cancelled" || outcome === "failed" ? { idempotencyKey: `${outcome === "cancelled" ? CANCELLED_TURN_HISTORY_KEY_PREFIX : FAILED_TURN_HISTORY_KEY_PREFIX}${payload.identity.turnId}` } : {}) });
  }
  return { outcome, ...(candidate === undefined ? {} : { candidate }), messages,
    nativeReusable: matched !== undefined && !detached && matched.currentTipId === matched.tipId
      && (payload.identity.purpose === "compaction" || matched.consumedInputIds.includes(pendingTurnDescriptor(payload).reconciliation!.initialInputId!)),
    journalId: matched?.journalId ?? null, tipId: matched?.tipId ?? null };
}
