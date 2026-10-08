import { createHash } from "node:crypto";
import { assertSessionModelKey } from "./session-runtime.js";
import { validateTurnHistoryV3 } from "./durable-turn-history.js";
import type { TurnHistoryV3 } from "./durable-turn-history.js";
import type { HistoryMessage } from "./context/index.js";
import type { RuntimeNativeJournalAuthority, RuntimeHandoffBudget } from "@mono-agent/runtime-adapter";

/** Private additive storage contracts. No host dispatch/admission opts in yet. */
export class ModelSwitchCapacityError extends Error {
  readonly code = "ERR_MODEL_SWITCH_CAPACITY";
}
export const MODEL_SWITCH_DIRECTORY = ".model-switches";
export const MAX_MODEL_SWITCH_BYTES = 16 * 1024 * 1024;
export const MAX_MODEL_SWITCH_FENCE_BYTES = 1024;
export const MAX_JOURNAL_CHAIN = 32;
export const MODEL_SWITCH_BILLING_POLICY = "mono-switch-two-producers-v1";
export interface JournalProvenance { readonly provider: string; readonly api: string; readonly model: string; readonly account: string | null }
export interface CanonicalJournalDescriptor {
  readonly journalId: string;
  readonly epoch: string;
  readonly ordinal: number;
  readonly handleId: string;
  readonly predecessorJournalId: string | null;
  readonly ownerKey: string;
  readonly historyBucket: string;
  readonly sourceTipId: string | null;
  readonly sourceSeq: number;
  readonly sourceDigest: string;
  readonly provenance: JournalProvenance;
}
export interface HandoffReference { readonly id: string; readonly hash: string }
export interface ModelSwitchReceipt {
  /** Cold transitions have no accepted handoff or native model_change event. */
  readonly kind?: "cold";
  readonly messageDigest?: string;
  readonly version: 1;
  readonly switchId: string;
  readonly intentDigest: string;
  readonly fromEpoch: string;
  readonly toEpoch: string;
  readonly artifact: HandoffReference | null;
}
export interface TurnHistoryV4 extends Omit<TurnHistoryV3, "version" | "providerSession"> {
  readonly version: 4;
  readonly providerSession: { readonly epoch: string; readonly revision: number; readonly modelKey: string };
  readonly native: { readonly authority: RuntimeNativeJournalAuthority; readonly chain: readonly CanonicalJournalDescriptor[]; readonly projection: HandoffReference | null };
  readonly lastSwitch?: ModelSwitchReceipt;
}
export interface ModelSwitchReservation {
  readonly canonicalBytes: number;
  readonly artifactBytes: number;
  readonly retainedNativeBytes: number;
  readonly headerCopyBytes: number;
  readonly pendingBytes: number;
}
export interface ModelSwitchIdentity {
  readonly ownerKey: string;
  readonly historyBucket: string;
  readonly switchId: string;
  readonly sourceCanonicalDigest: string;
  readonly sourceRevision: number;
  readonly sources: readonly CanonicalJournalDescriptor[];
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
  readonly version: 1;
  readonly identity: ModelSwitchIdentity;
  readonly reservation: ModelSwitchReservation;
  readonly billingPolicy: typeof MODEL_SWITCH_BILLING_POLICY;
  /** Stable explicit-message identity for generation zero; never its text. */
  readonly initialMessageDigest?: string;
  readonly authorizationGeneration: number;
  readonly authorizations: readonly SummaryAuthorization[];
  readonly attempts: readonly SummaryAttempt[];
  readonly phase: "outgoing" | "checkpoint" | "incoming" | "pending" | "ready";
  readonly artifact: HandoffReference | null;
  /** Optional for legacy administrative plans; configured preparation persists it. */
  readonly frozenBudget?: RuntimeHandoffBudget;
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
export interface StoredHandoff {
  readonly version: 1;
  readonly switchId: string;
  readonly ownerKey: string;
  readonly historyBucket: string;
  /** The sole stored content body. Native events/canonical state contain references only. */
  readonly artifact: Record<string, unknown>;
}
const hashPattern = /^[a-f0-9]{64}$/u;
export function switchInvalid(): never { throw new TypeError("Invalid model-switch storage contract"); }
export function switchObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) switchInvalid();
}
export function switchKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) switchInvalid();
}
function text(value: unknown, max = 512): asserts value is string { if (typeof value !== "string" || !value.length || value.length > max || value.includes("\0")) switchInvalid(); }
export function switchHash(value: unknown): asserts value is string { if (typeof value !== "string" || !hashPattern.test(value)) switchInvalid(); }
export function switchNumber(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) switchInvalid(); }
export function validateSwitchReference(value: unknown): asserts value is HandoffReference {
  switchObject(value); switchKeys(value, ["id", "hash"]); switchHash(value.id); switchHash(value.hash);
}
function provenance(value: unknown): void {
  switchObject(value); switchKeys(value, ["provider", "api", "model", "account"]);
  for (const key of ["provider", "api", "model"]) text(value[key]); if (value.account !== null) text(value.account);
}
export function validateJournalChain(value: unknown, ownerKey: string, historyBucket: string): asserts value is readonly CanonicalJournalDescriptor[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_JOURNAL_CHAIN) switchInvalid();
  const journals = new Set<string>(), epochs = new Set<string>(), handles = new Set<string>();
  let predecessor: string | null = null;
  for (let index = 0; index < value.length; index++) {
    const segment: unknown = value[index]; switchObject(segment);
    switchKeys(segment, ["journalId", "epoch", "ordinal", "handleId", "predecessorJournalId", "ownerKey", "historyBucket", "sourceTipId", "sourceSeq", "sourceDigest", "provenance"]);
    text(segment.journalId); switchHash(segment.epoch); switchHash(segment.handleId); switchHash(segment.sourceDigest); switchNumber(segment.sourceSeq);
    if (segment.ownerKey !== ownerKey || segment.historyBucket !== historyBucket || segment.predecessorJournalId !== predecessor || segment.ordinal !== index
      || journals.has(segment.journalId) || epochs.has(segment.epoch) || handles.has(segment.handleId)) switchInvalid();
    if (segment.sourceTipId !== null) text(segment.sourceTipId);
    provenance(segment.provenance); journals.add(segment.journalId); epochs.add(segment.epoch); handles.add(segment.handleId); predecessor = segment.journalId;
  }
}
export function validateSwitchAuthority(value: unknown): asserts value is RuntimeNativeJournalAuthority {
  switchObject(value); switchKeys(value, ["version", "canonicalVersion", "rootId", "authorityId", "ownerKey", "historyBucket"]);
  if (value.version !== 1 || value.canonicalVersion !== 4) switchInvalid(); switchHash(value.rootId); switchHash(value.authorityId); text(value.ownerKey); text(value.historyBucket);
}
export function validateTurnHistoryV4(value: unknown, validateMessage: (message: unknown) => HistoryMessage): asserts value is TurnHistoryV4 {
  switchObject(value); switchKeys(value, ["version", "conversationId", "messages", "providerSession", "native"], ["lastCommit", "lastSwitch"]);
  if (value.version !== 4) switchInvalid();
  validateTurnHistoryV3({ version: 3, conversationId: value.conversationId, messages: value.messages, providerSession: value.providerSession,
    ...(value.lastCommit === undefined ? {} : { lastCommit: value.lastCommit }) }, validateMessage);
  switchObject(value.providerSession); assertSessionModelKey(value.providerSession.modelKey);
  const native = value.native; switchObject(native); switchKeys(native, ["authority", "chain", "projection"]); validateSwitchAuthority(native.authority);
  if (native.authority.historyBucket !== value.conversationId) switchInvalid();
  validateJournalChain(native.chain, native.authority.ownerKey, native.authority.historyBucket);
  if (native.chain.at(-1)!.epoch !== value.providerSession.epoch) switchInvalid();
  if (native.projection !== null) validateSwitchReference(native.projection);
  if (value.lastSwitch !== undefined) {
    const receipt = value.lastSwitch; switchObject(receipt); switchKeys(receipt, ["version", "switchId", "intentDigest", "fromEpoch", "toEpoch", "artifact", ...(receipt.kind === "cold" ? ["kind", "messageDigest"] : [])]);
    if (receipt.kind === "cold") { switchHash(receipt.messageDigest); if (receipt.artifact !== null) switchInvalid(); }
    if (receipt.version !== 1) switchInvalid(); for (const key of ["switchId", "intentDigest", "fromEpoch", "toEpoch"]) switchHash(receipt[key]);
    // Like the P2 last-commit receipt, this records its own transition. Later
    // cold rotations/context publication must not erase or rebind that receipt.
    if (receipt.fromEpoch === receipt.toEpoch) switchInvalid();
    if (receipt.artifact !== null) validateSwitchReference(receipt.artifact);
  }
}
/** Binding recognition is NOT proof that projection is ready for dispatch. */
export function recognizesModelSwitchBinding(record: Pick<TurnHistoryV4, "conversationId" | "lastSwitch">, identity: ModelSwitchIdentity): boolean {
  const receipt = record.lastSwitch;
  if (!receipt || record.conversationId !== identity.historyBucket || receipt.switchId !== identity.switchId) return false;
  if (receipt.intentDigest !== switchDigest(identity) || receipt.fromEpoch !== identity.sources.at(-1)?.epoch || receipt.toEpoch !== identity.targetEpoch) {
    throw new Error("Canonical model-switch receipt conflicts with durable intent");
  }
  return true;
}
export function reservationBytes(value: ModelSwitchReservation): number {
  switchObject(value); switchKeys(value, ["canonicalBytes", "artifactBytes", "retainedNativeBytes", "headerCopyBytes", "pendingBytes"]);
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
  switchObject(value); switchKeys(value, ["version", "identity", "reservation", "billingPolicy", "authorizationGeneration", "authorizations", "attempts", "phase", "artifact"], ["frozenBudget", "initialMessageDigest"]);
  if (value.version !== 1 || value.billingPolicy !== MODEL_SWITCH_BILLING_POLICY || !["outgoing", "checkpoint", "incoming", "pending", "ready"].includes(value.phase as string)) switchInvalid();
  if (value.initialMessageDigest !== undefined) switchHash(value.initialMessageDigest);
  if (value.frozenBudget !== undefined) { validateFrozenHandoffBudget(value.frozenBudget); if (switchDigest(value.frozenBudget) !== (value.identity as ModelSwitchIdentity).frozenBudgetDigest) switchInvalid(); }
  const identity = value.identity; switchObject(identity);
  switchKeys(identity, ["ownerKey", "historyBucket", "switchId", "sourceCanonicalDigest", "sourceRevision", "sources", "fromModelKey", "toModelKey", "targetProvenance", "targetEpoch", "projectionPolicy", "timestamp", "frozenBudgetDigest"]);
  text(identity.ownerKey); text(identity.historyBucket); text(identity.projectionPolicy); switchNumber(identity.timestamp);
  for (const key of ["switchId", "sourceCanonicalDigest", "targetEpoch", "frozenBudgetDigest"]) switchHash(identity[key]); switchNumber(identity.sourceRevision);
  assertSessionModelKey(identity.fromModelKey); assertSessionModelKey(identity.toModelKey); if (identity.fromModelKey === identity.toModelKey) switchInvalid();
  provenance(identity.targetProvenance);
  const { switchId, ...coordinates } = identity; switchHash(switchId);
  if (switchId !== switchDigest(coordinates)) switchInvalid();
  validateJournalChain(identity.sources, identity.ownerKey, identity.historyBucket); if (identity.sources.some((source) => source.epoch === identity.targetEpoch)) switchInvalid();
  reservationBytes(value.reservation as unknown as ModelSwitchReservation); switchNumber(value.authorizationGeneration);
  if (!Array.isArray(value.authorizations) || value.authorizations.length > 32 || !Array.isArray(value.attempts) || value.attempts.length > 66) switchInvalid();
  const messages = new Set<string>(value.initialMessageDigest === undefined ? [] : [value.initialMessageDigest as string]);
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
export function summaryAttemptId(switchId: string, generation: number, producer: SummaryAttempt["producer"]): string { return switchDigest({ switchId, generation, producer, policy: MODEL_SWITCH_BILLING_POLICY }); }
export function switchConversationKey(bucket: string): string { return createHash("sha256").update("mono-agent-history-v1\0").update(bucket).digest("hex"); }
export function serializeModelSwitchState(value: ModelSwitchState): Buffer {
  validateModelSwitchState(value); return boundedSwitchBytes(value, MAX_MODEL_SWITCH_BYTES);
}
export function boundedSwitchBytes(value: unknown, maximum: number): Buffer {
  const bytes = Buffer.from(`${canonicalSwitchJSON(value)}\n`); if (bytes.byteLength > maximum) throw new RangeError("Model-switch artifact exceeds its serialized limit"); return bytes;
}
