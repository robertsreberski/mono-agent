import { sanitizeVisibleText } from "@mono-agent/observability";
import type { HistoryMessage } from "../context/types.js";
import type { ContinuitySource } from "./continuity-contracts.js";
import type { PendingTurnInput } from "../history/pending-turn/contract.js";

/** Process-local host stamps, never decoded from pending/canonical JSON or text.
 * A restart before archival publication deliberately loses owner attribution. */
export interface StagedContinuityInput {
  readonly inputId: string;
  readonly requestDigest: string;
  readonly ownerText?: string;
  readonly source?: ContinuitySource;
}
const candidates = new WeakMap<object, string>();
/** A mailbox field is only a candidate until the host channel validates it. */
export function offerContinuityOwnerText(input: PendingTurnInput, text: string): void { candidates.set(input, text); }
export function continuityOwnerTextCandidate(input: PendingTurnInput): string | undefined { return candidates.get(input); }
const staged = new WeakMap<object, StagedContinuityInput>();
const quotations = new WeakMap<object, StagedContinuityInput>();

/** Call before admit/yield, using the actual input identity and decorated digest. */
export function stageContinuityInput(input: PendingTurnInput, ownerText?: string, logicalOwner?: object): void {
  if (!publishableInputId(input.id)) {
    staged.delete(input); if (logicalOwner) staged.delete(logicalOwner); return;
  }
  const stamp = Object.freeze({ inputId: input.id, requestDigest: input.requestDigest,
    ...(ownerText === undefined ? {} : { ownerText }) });
  staged.set(input, stamp);
  if (logicalOwner) staged.set(logicalOwner, stamp);
}
export function clearContinuityInput(logicalOwner: object): void { staged.delete(logicalOwner); }
export function stagedContinuityInput(input: PendingTurnInput): StagedContinuityInput | undefined {
  const stamp = staged.get(input);
  return stamp?.inputId === input.id && stamp.requestDigest === input.requestDigest ? stamp : undefined;
}
/** Mailbox acknowledgement keeps the stamp attached to the same logical offer. */
export function copyAppliedContinuityInput(logicalOwner: object, applied: object): void {
  const stamp = staged.get(logicalOwner);
  if (stamp) quotations.set(applied, stamp);
}
export function copyContinuityQuotation(from: object, to: object): void {
  const stamp = quotations.get(from);
  if (stamp) quotations.set(to, stamp);
}
export function bindContinuityQuotation(message: HistoryMessage, stamp: StagedContinuityInput): void {
  if (publishableInputId(stamp.inputId)) quotations.set(message, stamp);
}
export function continuityQuotation(message: HistoryMessage): StagedContinuityInput | undefined {
  return quotations.get(message);
}

const completedBatches = new WeakSet<object>();
/** Only host-completed turn construction may exceed the public 64-message append
 * bound; at most 100 admitted steers plus initial input and final answer. */
export function markContinuityTurnBatch(messages: readonly HistoryMessage[]): void {
  if (messages.length <= 102) completedBatches.add(messages);
}
export function isContinuityTurnBatch(messages: readonly HistoryMessage[]): boolean {
  return messages.length <= 102 && completedBatches.has(messages);
}

function publishableInputId(id: string): boolean {
  return id.length > 0 && Buffer.byteLength(id) <= 512 && !/[\u0000-\u001f\u007f/\\]/u.test(id)
    && sanitizeVisibleText(id, { omitFilesystemPaths: true }) === id;
}
