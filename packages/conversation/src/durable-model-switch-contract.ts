import { createHash } from "node:crypto";
import { assertSessionModelKey } from "./sessions/model-key.js";
import { validateTurnHistoryV3 } from "./durable-turn-history.js";
import type { TurnHistoryV3 } from "./durable-turn-history.js";
import type { HistoryMessage } from "./context/index.js";
import type { RuntimeNativeJournalAuthority, RuntimeHandoffBudget } from "@mono-agent/turn/host/types";

export class ModelSwitchCapacityError extends Error {
  readonly code = "ERR_MODEL_SWITCH_CAPACITY";
}
/** The explicit message already authorized a retained switch intent's billing. */
export class ModelSwitchMessageConsumedError extends Error {
  readonly code = "ERR_MODEL_SWITCH_MESSAGE_CONSUMED";
  constructor() { super("This explicit message already authorized a model switch; it never authorizes paid work again"); this.name = "ModelSwitchMessageConsumedError"; }
}
export const MODEL_SWITCH_DIRECTORY = ".model-switches";
export const MAX_MODEL_SWITCH_BYTES = 16 * 1024 * 1024;
export const MAX_MODEL_SWITCH_FENCE_BYTES = 1024;
/** Upper bound of one deterministic guarded epoch initializer. */
export const MAX_NATIVE_EPOCH_BYTES = 8192;
export const MODEL_SWITCH_BILLING_POLICY = "mono-switch-two-producers-v1";
export interface JournalProvenance { readonly provider: string; readonly api: string; readonly model: string; readonly account: string | null }
/** Frozen outgoing journal of one switch intent. */
export interface CanonicalJournalDescriptor {
  readonly journalId: string;
  readonly epoch: string;
  readonly handleId: string;
  readonly ownerKey: string;
  readonly historyBucket: string;
  readonly sourceTipId: string | null;
  readonly sourceSeq: number;
  readonly sourceDigest: string;
  readonly provenance: JournalProvenance;
}
export interface HandoffReference { readonly id: string; readonly hash: string }
export interface ModelSwitchReceipt {
  readonly version: 1;
  readonly switchId: string;
  readonly intentDigest: string;
  readonly fromEpoch: string;
  readonly toEpoch: string;
  readonly artifact: HandoffReference;
}
/** One current guarded journal (derived from the epoch), one durable handoff
 * and the latest switch receipt. No epoch ancestry is retained. */
export interface NativeTurnHistory extends Omit<TurnHistoryV3, "version" | "providerSession" | "native" | "lastSwitch"> {
  readonly version: 3;
  readonly providerSession: { readonly epoch: string; readonly revision: number; readonly modelKey: string };
  readonly native: { readonly authority: RuntimeNativeJournalAuthority; readonly projection: HandoffReference | null };
  readonly lastSwitch?: ModelSwitchReceipt;
}
export interface ModelSwitchReservation {
  readonly canonicalBytes: number;
  readonly artifactBytes: number;
  /** The target epoch initializer; the outgoing journal is already charged. */
  readonly nativeBytes: number;
  readonly pendingBytes: number;
}
export interface ModelSwitchIdentity {
  readonly ownerKey: string;
  readonly historyBucket: string;
  readonly switchId: string;
  readonly sourceCanonicalDigest: string;
  readonly sourceRevision: number;
  readonly sourceEpoch: string;
  /** Null when the outgoing journal is definitively missing: canonical history is the evidence. */
  readonly source: CanonicalJournalDescriptor | null;
  readonly fromModelKey: string;
  readonly toModelKey: string;
  readonly targetProvenance: JournalProvenance;
  readonly targetEpoch: string;
  readonly projectionPolicy: string;
  readonly timestamp: number;
  readonly frozenBudgetDigest: string;
}
export interface SummaryAttempt {
  readonly id: string;
  readonly generation: number;
  readonly producer: "outgoing" | "incoming";
  readonly outcome: "started" | "rejected" | "accepted";
  readonly artifact: HandoffReference | null;
}
export interface SummaryAuthorization { readonly generation: number; readonly messageDigest: string }
export interface ModelSwitchState {
  readonly version: 2;
  readonly identity: ModelSwitchIdentity;
  readonly reservation: ModelSwitchReservation;
  readonly billingPolicy: typeof MODEL_SWITCH_BILLING_POLICY;
  /** Stable explicit-message identity for generation zero; never its text. */
  readonly initialMessageDigest: string;
  readonly authorizationGeneration: number;
  readonly authorizations: readonly SummaryAuthorization[];
  readonly attempts: readonly SummaryAttempt[];
  readonly phase: "outgoing" | "checkpoint" | "incoming" | "pending" | "ready";
  readonly artifact: HandoffReference | null;
  /** Frozen before producer admission. */
  readonly frozenBudget: RuntimeHandoffBudget;
}
export interface ModelSwitchPointer { readonly generation: string; readonly sha256: string }
export interface ModelSwitchFence {
  readonly version: 6;
  readonly kind: "model-switch";
  readonly conversationKey: string;
  readonly switchId: string;
  readonly targetEpoch: string;
  readonly payload: ModelSwitchPointer;
}
const hashPattern = /^[a-f0-9]{64}$/u;
function switchInvalid(): never { throw new TypeError("Invalid model-switch storage contract"); }
export function switchObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) switchInvalid();
}
export function switchKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) switchInvalid();
}
function text(value: unknown, max = 512): asserts value is string { if (typeof value !== "string" || !value.length || value.length > max || value.includes("\0")) switchInvalid(); }
export function switchHash(value: unknown): asserts value is string { if (typeof value !== "string" || !hashPattern.test(value)) switchInvalid(); }
function switchNumber(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) switchInvalid(); }
export function validateSwitchReference(value: unknown): asserts value is HandoffReference {
  switchObject(value); switchKeys(value, ["id", "hash"]); switchHash(value.id); switchHash(value.hash);
}
function provenance(value: unknown): void {
  switchObject(value); switchKeys(value, ["provider", "api", "model", "account"]);
  for (const key of ["provider", "api", "model"]) text(value[key]); if (value.account !== null) text(value.account);
}
function validateJournalDescriptor(value: unknown, ownerKey: string, historyBucket: string, epoch: string): asserts value is CanonicalJournalDescriptor {
  switchObject(value); switchKeys(value, ["journalId", "epoch", "handleId", "ownerKey", "historyBucket", "sourceTipId", "sourceSeq", "sourceDigest", "provenance"]);
  text(value.journalId); switchHash(value.handleId); switchHash(value.sourceDigest); switchNumber(value.sourceSeq);
  if (value.ownerKey !== ownerKey || value.historyBucket !== historyBucket || value.epoch !== epoch) switchInvalid();
  if (value.sourceTipId !== null) text(value.sourceTipId);
  provenance(value.provenance);
}
function validateSwitchAuthority(value: unknown): asserts value is RuntimeNativeJournalAuthority {
  switchObject(value); switchKeys(value, ["version", "rootId", "authorityId", "ownerKey", "historyBucket"]);
  if (value.version !== 1) switchInvalid(); switchHash(value.rootId); switchHash(value.authorityId); text(value.ownerKey); text(value.historyBucket);
}
export function validateNativeTurnHistory(value: unknown, validateMessage: (message: unknown) => HistoryMessage): asserts value is NativeTurnHistory {
  switchObject(value); switchKeys(value, ["version", "conversationId", "messages", "providerSession", "native"], ["lastCommit", "lastSwitch"]);
  if (value.version !== 3) switchInvalid();
  validateTurnHistoryV3({ version: 3, conversationId: value.conversationId, messages: value.messages, providerSession: value.providerSession,
    ...(value.lastCommit === undefined ? {} : { lastCommit: value.lastCommit }) }, validateMessage);
  switchObject(value.providerSession); assertSessionModelKey(value.providerSession.modelKey);
  const native = value.native; switchObject(native); switchKeys(native, ["authority", "projection"]); validateSwitchAuthority(native.authority);
  if (native.authority.historyBucket !== value.conversationId) switchInvalid();
  if (native.projection !== null) validateSwitchReference(native.projection);
  if (value.lastSwitch !== undefined) {
    const receipt = value.lastSwitch; switchObject(receipt); switchKeys(receipt, ["version", "switchId", "intentDigest", "fromEpoch", "toEpoch", "artifact"]);
    if (receipt.version !== 1) switchInvalid(); for (const key of ["switchId", "intentDigest", "fromEpoch", "toEpoch"]) switchHash(receipt[key]);
    // Like the P2 last-commit receipt, this records its own transition. Later
    // cold rotations must not erase or rebind that receipt.
    if (receipt.fromEpoch === receipt.toEpoch) switchInvalid();
    validateSwitchReference(receipt.artifact);
  }
}
/** Binding recognition is NOT proof that projection is ready for dispatch. */
export function recognizesModelSwitchBinding(record: Pick<NativeTurnHistory, "conversationId" | "lastSwitch">, identity: ModelSwitchIdentity): boolean {
  const receipt = record.lastSwitch;
  if (!receipt || record.conversationId !== identity.historyBucket || receipt.switchId !== identity.switchId) return false;
  if (receipt.intentDigest !== switchDigest(identity) || receipt.fromEpoch !== identity.sourceEpoch || receipt.toEpoch !== identity.targetEpoch) {
    throw new Error("Canonical model-switch receipt conflicts with durable intent");
  }
  return true;
}
export function reservationBytes(value: ModelSwitchReservation): number {
  switchObject(value); switchKeys(value, ["canonicalBytes", "artifactBytes", "nativeBytes", "pendingBytes"]);
  let sum = 0; for (const amount of Object.values(value)) { switchNumber(amount); sum += amount; if (!Number.isSafeInteger(sum)) switchInvalid(); } return sum;
}
/** Exact persisted budget, not an inferred/recomputed preparation allowance. */
export function validateFrozenHandoffBudget(value: unknown): asserts value is RuntimeHandoffBudget {
  switchObject(value); switchKeys(value, ["policy", "contextWindow", "outputReserve", "inputTokens", "hostCap", "hostContextDigest", "safety", "historyAllowance"]);
  for (const key of ["contextWindow", "outputReserve", "inputTokens", "hostCap", "safety"]) switchNumber(value[key]);
  switchHash(value.hostContextDigest);
  if (value.policy !== "mono-handoff-v1" || !(value.contextWindow as number) || !(value.outputReserve as number)
    || (value.hostCap as number) < 16384 || value.safety !== Math.max(4096, Math.ceil((value.contextWindow as number) * 0.05))
    || value.historyAllowance !== (value.contextWindow as number) - (value.outputReserve as number) - (value.inputTokens as number) - (value.hostCap as number) - (value.safety as number)) switchInvalid();
}

export function validateModelSwitchState(value: unknown): asserts value is ModelSwitchState {
  switchObject(value);
  switchKeys(value, ["version", "identity", "reservation", "billingPolicy", "authorizationGeneration", "authorizations", "attempts", "phase", "artifact", "frozenBudget", "initialMessageDigest"]);
  if (value.version !== 2 || value.billingPolicy !== MODEL_SWITCH_BILLING_POLICY || !["outgoing", "checkpoint", "incoming", "pending", "ready"].includes(value.phase as string)) switchInvalid();
  switchHash(value.initialMessageDigest);
  validateFrozenHandoffBudget(value.frozenBudget); if (switchDigest(value.frozenBudget) !== (value.identity as ModelSwitchIdentity).frozenBudgetDigest) switchInvalid();
  const identity = value.identity; switchObject(identity);
  switchKeys(identity, ["ownerKey", "historyBucket", "switchId", "sourceCanonicalDigest", "sourceRevision", "sourceEpoch", "source", "fromModelKey", "toModelKey", "targetProvenance", "targetEpoch", "projectionPolicy", "timestamp", "frozenBudgetDigest"]);
  text(identity.ownerKey); text(identity.historyBucket); text(identity.projectionPolicy); switchNumber(identity.timestamp);
  for (const key of ["switchId", "sourceCanonicalDigest", "sourceEpoch", "targetEpoch", "frozenBudgetDigest"]) switchHash(identity[key]); switchNumber(identity.sourceRevision);
  assertSessionModelKey(identity.fromModelKey); assertSessionModelKey(identity.toModelKey); if (identity.fromModelKey === identity.toModelKey) switchInvalid();
  provenance(identity.targetProvenance);
  const { switchId, ...coordinates } = identity; switchHash(switchId);
  if (switchId !== switchDigest(coordinates)) switchInvalid();
  if (identity.source !== null) validateJournalDescriptor(identity.source, identity.ownerKey, identity.historyBucket, identity.sourceEpoch as string);
  if (identity.sourceEpoch === identity.targetEpoch) switchInvalid();
  reservationBytes(value.reservation as unknown as ModelSwitchReservation); switchNumber(value.authorizationGeneration);
  if (!Array.isArray(value.authorizations) || !Array.isArray(value.attempts)) switchInvalid();
  const messages = new Set<string>([value.initialMessageDigest as string]);
  for (let index = 0; index < value.authorizations.length; index++) {
    const authorization: unknown = value.authorizations[index]; switchObject(authorization); switchKeys(authorization, ["generation", "messageDigest"]);
    switchHash(authorization.messageDigest); if (authorization.generation !== index + 1 || messages.has(authorization.messageDigest)) switchInvalid(); messages.add(authorization.messageDigest);
  }
  if (value.authorizationGeneration !== value.authorizations.length) switchInvalid();
  const attempts = new Set<string>();
  for (const attempt of value.attempts) {
    switchObject(attempt); switchKeys(attempt, ["id", "generation", "producer", "outcome", "artifact"]); switchHash(attempt.id); switchNumber(attempt.generation);
    if (attempt.generation > value.authorizationGeneration || !["outgoing", "incoming"].includes(attempt.producer as string) || !["started", "rejected", "accepted"].includes(attempt.outcome as string)) switchInvalid();
    const key = `${attempt.generation}:${attempt.producer}`;
    if (attempts.has(key) || attempt.id !== summaryAttemptId(switchId, attempt.generation, attempt.producer as SummaryAttempt["producer"])) switchInvalid(); attempts.add(key);
    if (attempt.outcome === "accepted" ? attempt.artifact === null : attempt.artifact !== null) switchInvalid();
    if (attempt.artifact !== null) validateSwitchReference(attempt.artifact);
  }
  if (value.phase === "ready" ? value.artifact === null : value.artifact !== null) switchInvalid();
  if (value.artifact !== null) validateSwitchReference(value.artifact);
}
export function validateModelSwitchFence(value: unknown): asserts value is ModelSwitchFence {
  switchObject(value); switchKeys(value, ["version", "kind", "conversationKey", "switchId", "targetEpoch", "payload"]);
  if (value.version !== 6 || value.kind !== "model-switch") switchInvalid(); for (const key of ["conversationKey", "switchId", "targetEpoch"]) switchHash(value[key]);
  switchObject(value.payload); switchKeys(value.payload, ["generation", "sha256"]); switchHash(value.payload.sha256);
  if (typeof value.payload.generation !== "string" || !/^[a-f0-9]{32}$/u.test(value.payload.generation)) switchInvalid();
}
export function canonicalSwitchJSON(value: unknown): string {
  const ordered = (item: unknown, depth = 0): unknown => {
    if (depth > 64) switchInvalid();
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((entry) => ordered(entry, depth + 1));
    switchObject(item); return Object.fromEntries(Object.keys(item).filter((key) => item[key] !== undefined).sort().map((key) => [key, ordered(item[key], depth + 1)]));
  };
  return JSON.stringify(ordered(value));
}
export function switchDigest(value: unknown): string { return createHash("sha256").update(canonicalSwitchJSON(value)).digest("hex"); }
/** Compare frozen coverage without obsolete account identity, preserving every
 * other descriptor field. Durable switch/artifact hashes remain unchanged. */
export function switchCoverageDigest(value: unknown): string {
  if (!Array.isArray(value)) return switchDigest(value);
  return switchDigest(value.map((source: unknown) => {
    switchObject(source); switchObject(source.provenance);
    const { account: _account, ...provenance } = source.provenance;
    return { ...source, provenance };
  }));
}
export function summaryAttemptId(switchId: string, generation: number, producer: SummaryAttempt["producer"]): string { return switchDigest({ switchId, generation, producer, policy: MODEL_SWITCH_BILLING_POLICY }); }
export function switchConversationKey(bucket: string): string { return createHash("sha256").update("mono-agent-history-v1\0").update(bucket).digest("hex"); }
export function serializeModelSwitchState(value: ModelSwitchState): Buffer {
  validateModelSwitchState(value); return boundedSwitchBytes(value, MAX_MODEL_SWITCH_BYTES);
}
export function boundedSwitchBytes(value: unknown, maximum: number): Buffer {
  const bytes = Buffer.from(`${canonicalSwitchJSON(value)}\n`); if (bytes.byteLength > maximum) throw new RangeError("Model-switch artifact exceeds its serialized limit"); return bytes;
}
