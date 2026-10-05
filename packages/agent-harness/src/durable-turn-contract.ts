import { assertSessionModelKey } from "./session-runtime.js";
import { digestNativeTurnInput, formatLiveInputGuidance } from "@mono-agent/runtime-adapter";
import type { RuntimePromptOverrides, RuntimeSessionTurnDescriptor } from "@mono-agent/runtime-adapter";
import { createHash } from "node:crypto";

export class DurableTurnAlreadyCommittedError extends Error {
  readonly code = "ERR_HISTORY_TURN_ALREADY_COMMITTED";
  constructor() { super("This turn is already canonically committed; use a new turn id."); }
}

/** Private P2b wire contracts; not execution or authority to recover a turn. */
export const PENDING_TURN_DIRECTORY = ".pending-turns";
export const MAX_PENDING_TURN_BYTES = 16 * 1024 * 1024;
export const MAX_TURN_FENCE_BYTES = 1024;
export const PENDING_GENERATION_PATTERN = /^[a-f0-9]{32}$/u;
export const PENDING_FILE_PATTERN = /^([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{32})\.json$/u;
export type DurableTurnOutcome = "completed" | "failed" | "cancelled" | "interrupted";

export interface PendingTurnIdentity {
  readonly purpose: "execution" | "compaction";
  readonly ownerKey: string;
  readonly historyBucket: string;
  readonly turnId: string;
  readonly handleId: string;
  readonly modelKey: string;
  readonly baseRevision: number;
  readonly fenceDigest: string;
}
export type PendingTurnInput =
  | { readonly kind: "initial"; readonly id: string; readonly placement: "initial"; readonly requestDigest: string; readonly persistText: string; readonly timestamp: string; readonly senderLabel?: string }
  | { readonly kind: "live"; readonly id: string; readonly placement: "live"; readonly requestDigest: string; readonly persistText: string; readonly receivedAt: string }
  | { readonly kind: "wake"; readonly id: string; readonly placement: "live"; readonly requestDigest: string };
export interface PendingTurnCandidate {
  readonly outcome: DurableTurnOutcome;
  readonly text: string | null;
  readonly timestamp: string;
  readonly error: string | null;
  readonly failureKind: string | null;
  readonly silent?: "finish_silently";
  readonly consumedInputIds?: readonly string[];
  /** Host-built completion capture time; presence certifies a live canonical candidate. */
  readonly initialTimestamp?: string;
}
export interface PendingTurnPayload {
  readonly version: 1;
  readonly identity: PendingTurnIdentity;
  readonly inputs: readonly PendingTurnInput[];
  readonly disposition: "admitted" | "cancelled" | "failed" | "completed" | "detached";
  readonly candidate?: PendingTurnCandidate;
}
export interface PendingTurnPointer { readonly generation: string; readonly sha256: string }
export interface DurableTurnFence {
  readonly version: 5;
  readonly kind: "execution" | "compaction" | "retirement";
  readonly conversationKey: string;
  readonly logicalConversationKey: string;
  readonly epoch: string;
  readonly providerSessionId: string;
  readonly modelKey: string;
  readonly revision: number;
  readonly runIdDigest: string;
  readonly payload?: PendingTurnPointer;
}
export interface DurableTurnReceipt {
  readonly version: 1;
  readonly turnId: string;
  readonly inputDigest: string;
  readonly candidateDigest: string;
  readonly journalId: string | null;
  readonly tipId: string | null;
  readonly baseRevision: number;
  readonly committedRevision: number;
  readonly outcome: DurableTurnOutcome;
}
const digest = /^[a-f0-9]{64}$/u;
const outcomes = new Set(["completed", "failed", "cancelled", "interrupted"]);
function invalid(): never { throw new TypeError("Invalid durable turn contract"); }
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) invalid();
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const names = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || names.some((key) => !required.includes(key) && !optional.includes(key))) invalid();
}
function text(value: unknown, maxBytes = 4096, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.length) || Buffer.byteLength(value) > maxBytes) invalid();
}
function hash(value: unknown): asserts value is string { if (typeof value !== "string" || !digest.test(value)) invalid(); }
function revision(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); }
function timestamp(value: unknown): void { text(value, 128); if (!Number.isFinite(Date.parse(value))) invalid(); }

export function validatePendingTurnPayload(value: unknown): asserts value is PendingTurnPayload {
  object(value); keys(value, ["version", "identity", "inputs", "disposition"], ["candidate"]);
  if (value.version !== 1 || !["admitted", "cancelled", "failed", "completed", "detached"].includes(value.disposition as string)) invalid();
  const identity = value.identity; object(identity);
  keys(identity, ["purpose", "ownerKey", "historyBucket", "turnId", "handleId", "modelKey", "baseRevision", "fenceDigest"]);
  if (!["execution", "compaction"].includes(identity.purpose as string)) invalid();
  for (const key of ["ownerKey", "historyBucket", "turnId", "handleId", "modelKey"]) text(identity[key]);
  assertSessionModelKey(identity.modelKey); revision(identity.baseRevision); hash(identity.fenceDigest);
  if (!Array.isArray(value.inputs) || value.inputs.length > 101) invalid();
  const ids = new Set<string>(); let initials = 0;
  for (const input of value.inputs) {
    object(input);
    if (input.kind === "initial") {
      keys(input, ["kind", "id", "placement", "requestDigest", "persistText", "timestamp"], ["senderLabel"]);
      if (input.placement !== "initial") invalid(); initials += 1;
      text(input.persistText, 64 * 1024, true); timestamp(input.timestamp);
      if (input.senderLabel !== undefined) text(input.senderLabel, 4096);
    } else if (input.kind === "live") {
      keys(input, ["kind", "id", "placement", "requestDigest", "persistText", "receivedAt"]);
      if (input.placement !== "live") invalid(); text(input.persistText, 64 * 1024, true);
      if ((input.persistText as string).length > 8000) invalid(); timestamp(input.receivedAt);
    } else if (input.kind === "wake") {
      keys(input, ["kind", "id", "placement", "requestDigest"]); if (input.placement !== "live") invalid();
    } else invalid();
    text(input.id, 512); hash(input.requestDigest); if (ids.has(input.id)) invalid(); ids.add(input.id);
  }
  if (identity.purpose === "execution" ? initials !== 1 : value.inputs.length !== 0) invalid();
  if (value.candidate !== undefined) {
    const candidate = value.candidate; object(candidate);
    keys(candidate, ["outcome", "text", "timestamp", "error", "failureKind"], ["silent", "consumedInputIds", "initialTimestamp"]);
    if (!outcomes.has(candidate.outcome as string)) invalid();
    for (const key of ["text", "error", "failureKind"]) if (candidate[key] !== null) text(candidate[key], key === "text" ? 64 * 1024 : 4096, true);
    timestamp(candidate.timestamp);
    if (candidate.initialTimestamp !== undefined) { timestamp(candidate.initialTimestamp); if (candidate.outcome !== "completed") invalid(); }
    if (candidate.consumedInputIds !== undefined) {
      if (!Array.isArray(candidate.consumedInputIds) || candidate.consumedInputIds.length > 101
        || new Set(candidate.consumedInputIds).size !== candidate.consumedInputIds.length) invalid();
      for (const id of candidate.consumedInputIds) { text(id, 512); if (!ids.has(id as string)) invalid(); }
    }
    if (candidate.silent !== undefined && candidate.silent !== "finish_silently") invalid();
    if (candidate.outcome === "completed" && (candidate.error !== null || candidate.failureKind !== null)) invalid();
    if (identity.purpose === "compaction") invalid();
  }
}
/** Explicit privacy builder: never spreads transport metadata or candidate objects. */
export function createPendingTurnInput(source: PendingTurnInput): PendingTurnInput {
  const common = { kind: source.kind, id: source.id, placement: source.placement, requestDigest: source.requestDigest };
  if (source.kind === "wake") return { kind: "wake", id: source.id, placement: "live", requestDigest: source.requestDigest };
  if (source.kind === "live") return { kind: "live", id: source.id, placement: "live", requestDigest: source.requestDigest, persistText: source.persistText, receivedAt: source.receivedAt };
  return { kind: "initial", id: common.id, placement: "initial", requestDigest: common.requestDigest, persistText: source.persistText, timestamp: source.timestamp,
    ...(source.senderLabel === undefined ? {} : { senderLabel: source.senderLabel }) };
}
/** Native prompt decoration/attachments participate only in the digest, never canonical payload text. */
export function createPendingInitialInput(source: { readonly id: string; readonly persistText: string; readonly timestamp: string; readonly senderLabel?: string }, nativeContent: unknown): PendingTurnInput {
  return createPendingTurnInput({ kind: "initial", id: source.id, placement: "initial", requestDigest: digestNativeTurnInput(nativeContent), persistText: source.persistText,
    timestamp: source.timestamp, ...(source.senderLabel === undefined ? {} : { senderLabel: source.senderLabel }) });
}
/** Internal wake bodies are hashed through the same guidance formatter but are not persisted. */
export function createPendingLiveInput(source: { readonly id: string; readonly persistText: string; readonly receivedAt: string }, nativeBody: string,
  kind: "live" | "wake", prompts?: RuntimePromptOverrides): PendingTurnInput {
  const requestDigest = digestNativeTurnInput(formatLiveInputGuidance(nativeBody, prompts));
  return kind === "wake" ? { kind: "wake", id: source.id, placement: "live", requestDigest }
    : { kind: "live", id: source.id, placement: "live", requestDigest, persistText: source.persistText, receivedAt: source.receivedAt };
}
export function createPendingTurnCandidate(source: PendingTurnCandidate): PendingTurnCandidate {
  return { outcome: source.outcome, text: source.text, timestamp: source.timestamp, error: source.error, failureKind: source.failureKind,
    ...(source.silent === undefined ? {} : { silent: source.silent }),
    ...(source.consumedInputIds === undefined ? {} : { consumedInputIds: [...source.consumedInputIds] }),
    ...(source.initialTimestamp === undefined ? {} : { initialTimestamp: source.initialTimestamp }) };
}
/** Explicit payload publication builder, excluding runtime/transport/controller extras at all layers. */
export function createPendingTurnPayload(identity: PendingTurnIdentity, inputs: readonly PendingTurnInput[],
  disposition: PendingTurnPayload["disposition"], candidate?: PendingTurnCandidate): PendingTurnPayload {
  const result: PendingTurnPayload = { version: 1, identity: { purpose: identity.purpose, ownerKey: identity.ownerKey, historyBucket: identity.historyBucket,
    turnId: identity.turnId, handleId: identity.handleId, modelKey: identity.modelKey, baseRevision: identity.baseRevision, fenceDigest: identity.fenceDigest },
    inputs: inputs.map(createPendingTurnInput), disposition, ...(candidate === undefined ? {} : { candidate: createPendingTurnCandidate(candidate) }) };
  validatePendingTurnPayload(result); return result;
}
export function serializePendingTurnPayload(value: PendingTurnPayload): Buffer {
  validatePendingTurnPayload(value);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_PENDING_TURN_BYTES) throw new RangeError("Pending turn payload exceeds 16 MiB");
  return bytes;
}
export function parsePendingTurnPayload(bytes: Buffer): PendingTurnPayload {
  if (bytes.byteLength > MAX_PENDING_TURN_BYTES) throw new RangeError("Pending turn payload exceeds 16 MiB");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validatePendingTurnPayload(value); return value;
}
export function pendingPayloadName(conversationKey: string, runIdDigest: string, generation: string): string {
  hash(conversationKey); hash(runIdDigest); if (!PENDING_GENERATION_PATTERN.test(generation)) invalid();
  return `${conversationKey}.${runIdDigest}.${generation}.json`;
}
export function validateTurnPointer(value: unknown): asserts value is PendingTurnPointer {
  object(value); keys(value, ["generation", "sha256"]); if (typeof value.generation !== "string" || !PENDING_GENERATION_PATTERN.test(value.generation)) invalid(); hash(value.sha256);
}
export function validateDurableTurnFence(value: unknown): asserts value is DurableTurnFence {
  object(value); keys(value, ["version", "kind", "conversationKey", "logicalConversationKey", "epoch", "providerSessionId", "modelKey", "revision", "runIdDigest"], ["payload"]);
  if (value.version !== 5 || !["execution", "compaction", "retirement"].includes(value.kind as string)) invalid();
  for (const key of ["conversationKey", "logicalConversationKey", "epoch", "providerSessionId", "runIdDigest"]) hash(value[key]);
  text(value.modelKey); assertSessionModelKey(value.modelKey); revision(value.revision);
  if (value.kind === "retirement" ? value.payload !== undefined : value.payload === undefined) invalid();
  if (value.payload !== undefined) validateTurnPointer(value.payload);
}
export function serializeDurableTurnFence(value: DurableTurnFence): Buffer {
  validateDurableTurnFence(value); const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_TURN_FENCE_BYTES) throw new RangeError("Dirty fence exceeds 1 KiB"); return bytes;
}
/** Stable admission identity: immutable payload generations may replace its pointer. */
export function durableTurnFenceDigest(value: DurableTurnFence): string {
  validateDurableTurnFence(value);
  return sha256(Buffer.from(JSON.stringify({ version: value.version, kind: value.kind, conversationKey: value.conversationKey,
    logicalConversationKey: value.logicalConversationKey, epoch: value.epoch, providerSessionId: value.providerSessionId,
    modelKey: value.modelKey, revision: value.revision, runIdDigest: value.runIdDigest })));
}
export function validateDurableTurnReceipt(value: unknown): asserts value is DurableTurnReceipt {
  object(value); keys(value, ["version", "turnId", "inputDigest", "candidateDigest", "journalId", "tipId", "baseRevision", "committedRevision", "outcome"]);
  if (value.version !== 1 || !outcomes.has(value.outcome as string)) invalid();
  text(value.turnId, 512); hash(value.inputDigest); hash(value.candidateDigest);
  for (const key of ["journalId", "tipId"]) if (value[key] !== null) text(value[key], 512);
  revision(value.baseRevision); revision(value.committedRevision);
  if (value.committedRevision !== (value.baseRevision as number) + 1) invalid();
}
export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Protected router acknowledgement is scoped to the entire original binding. */
export function assertDetachedTurnDescriptor(actual: RuntimeSessionTurnDescriptor, expected: RuntimeSessionTurnDescriptor): void {
  for (const key of ["kind", "ownerKey", "historyBucket", "turnId", "handleId", "baseRevision"] as const) {
    if (actual[key] !== expected[key]) throw new Error("Detached attempt owner mismatch.");
  }
  for (const key of ["version", "purpose", "fenceDigest", "initialInputId"] as const) {
    if (actual.reconciliation?.[key] !== expected.reconciliation?.[key]) throw new Error("Detached reconciliation binding mismatch.");
  }
}
