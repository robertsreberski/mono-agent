import { createHash } from "node:crypto";
import type { HistoryMessage } from "../../context/index.js";
import type { NativeTurnHistory } from "../model-switch/contract.js";
import { validateNativeTurnHistory } from "../model-switch/contract.js";
import type { DurableTurnReceipt } from "../pending-turn/contract.js";
import { serializeDurableTurnFence,validateDurableTurnFence } from "../pending-turn/contract.js";
import { validateTurnHistoryV3 } from "../pending-turn/canonical-record.js";
import { assertSessionModelKey } from "../../sessions/model-key.js";
import { logicalConversationIdForFence,normalizeConversationId,normalizeRunId } from "./identity.js";
import { DEFAULT_MAX_MESSAGES,LEGACY_STORE_VERSION,MAX_DIRTY_FENCE_BYTES,MAX_MESSAGE_CONTENT_BYTES,MAX_MESSAGE_ENVELOPE_BYTES,MAX_MESSAGE_SERIALIZED_BYTES,MAX_STORE_FILE_BYTES,PROVIDER_STORE_VERSION,STORE_VERSION,type CanonicalHistoryFile,type DirtyFence,type LoadedHistoryRecord } from "./record-contracts.js";

const MAX_APPEND_MESSAGES = DEFAULT_MAX_MESSAGES;

export function historyRecordVersion(record: LoadedHistoryRecord | CanonicalHistoryFile): string {
  return createHash("sha256")
    .update("mono-agent-history-version-v1\0")
    .update(JSON.stringify({
      sourceVersion: "sourceVersion" in record ? record.sourceVersion : record.version,
      conversationId: record.conversationId,
      messages: record.messages,
      providerSession: record.providerSession,
      lastCommit: record.lastCommit,
      ...nativeExtension(record),
    }), "utf8")
    .digest("hex");
}

export function validateAppendMessages(messages: readonly HistoryMessage[]): readonly HistoryMessage[] {
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array.");
  if (messages.length > MAX_APPEND_MESSAGES) {
    throw new TypeError(`append accepts at most ${MAX_APPEND_MESSAGES} messages.`);
  }
  return Array.from(messages, (message) => validateAndCloneMessage(message));
}

export function validateAndCloneMessage(value: HistoryMessage): HistoryMessage {
  if (!isRecord(value)) throw new TypeError("Each history message must be an object.");
  const allowed = new Set(["role", "content", "name", "timestamp", "runId", "idempotencyKey"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`History message contains unsupported field ${key}.`);
  }
  if (!(["system", "user", "assistant", "tool"] as const).includes(value.role)) {
    throw new TypeError("History message role is invalid.");
  }
  if (typeof value.content !== "string") throw new TypeError("History message content must be a string.");
  const contentBytes = Buffer.byteLength(value.content, "utf8");
  if (contentBytes > MAX_MESSAGE_CONTENT_BYTES) {
    throw new TypeError(`History message content must not exceed ${MAX_MESSAGE_CONTENT_BYTES} UTF-8 bytes.`);
  }
  const optional = ["name", "timestamp", "runId", "idempotencyKey"] as const;
  for (const field of optional) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      throw new TypeError(`History message ${field} must be a string when present.`);
    }
  }
  const clone = cloneMessage(value);
  const envelope = { ...clone, content: "" };
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_MESSAGE_ENVELOPE_BYTES) {
    throw new TypeError(`History message metadata must not exceed ${MAX_MESSAGE_ENVELOPE_BYTES} serialized UTF-8 bytes.`);
  }
  if (Buffer.byteLength(JSON.stringify(clone), "utf8") > MAX_MESSAGE_SERIALIZED_BYTES) {
    throw new TypeError("History message cannot be represented within its serialized safety limit.");
  }
  return clone;
}

export function cloneMessage(message: HistoryMessage): HistoryMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
  };
}

export function lastCommitBinding(record: { readonly lastCommit?: DurableTurnReceipt }): { readonly lastCommit?: DurableTurnReceipt } {
  return record.lastCommit === undefined ? {} : { lastCommit: { ...record.lastCommit } };
}

export function nativeExtension(record: { readonly conversationId: string; readonly native?: NativeTurnHistory["native"]; readonly lastSwitch?: NativeTurnHistory["lastSwitch"] }) {
  return record.native === undefined ? {} : { native: structuredClone(record.native),
    ...(record.lastSwitch === undefined ? {} : { lastSwitch: structuredClone(record.lastSwitch) }) };
}
/** Preserve authority/projection/switch receipt only for a proven same-epoch
 * write. Never invent a native journal or drop its authority. */
export function preserveNativeHistory(existing: LoadedHistoryRecord | CanonicalHistoryFile, next: CanonicalHistoryFile): CanonicalHistoryFile {
  if (existing.native === undefined) return next;
  if (next.conversationId !== existing.conversationId || next.providerSession.epoch !== existing.providerSession?.epoch
    || next.providerSession.modelKey !== existing.providerSession.modelKey) {
    return next; // The owner-held native lifecycle planner must complete this candidate.
  }
  const record = { ...next, version: 3, ...nativeExtension(existing) };
  validateNativeTurnHistory(record, (message) => validateAndCloneMessage(message as HistoryMessage));
  return record;
}

export function serializeHistoryFile(record: CanonicalHistoryFile): Buffer {
  if (record.native !== undefined) validateNativeTurnHistory(record, (message) => validateAndCloneMessage(message as HistoryMessage));
  else validateTurnHistoryV3(record, (message) => validateAndCloneMessage(message as HistoryMessage));
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.byteLength > MAX_STORE_FILE_BYTES) {
    throw new Error(`Serialized conversation history exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
  }
  return bytes;
}

export function serializeDirtyFence(value: Omit<DirtyFence, "path" | "mtimeMs">): Buffer {
  if (value.kind !== undefined) return serializeDurableTurnFence({ version: 6, kind: value.kind, conversationKey: value.conversationKey,
    logicalConversationKey: value.logicalConversationKey!, epoch: value.epoch, providerSessionId: value.providerSessionId!, modelKey: value.modelKey!,
    revision: value.revision, runIdDigest: value.runIdDigest, ...(value.payload === undefined ? {} : { payload: value.payload }) });
  if (value.modelKey !== undefined) {
    assertSessionModelKey(value.modelKey);
    if (value.logicalConversationKey === undefined || value.providerSessionId === undefined) {
      throw new Error("Bound dirty fences require logical and provider session identities.");
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(value.conversationKey)) {
    throw new Error("History dirty fence has an invalid conversation key.");
  }
  if (value.logicalConversationKey !== undefined && !/^[a-f0-9]{64}$/u.test(value.logicalConversationKey)) {
    throw new Error("History dirty fence has an invalid logical conversation key.");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.epoch)) {
    throw new Error("History dirty fence has an invalid provider epoch.");
  }
  if (value.providerSessionId !== undefined && !/^[a-f0-9]{64}$/u.test(value.providerSessionId)) {
    throw new Error("History dirty fence has an invalid provider session id.");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error("History dirty fence has an invalid provider revision.");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.runIdDigest)) {
    throw new Error("History dirty fence has an invalid run digest.");
  }
  const bytes = Buffer.from(`${JSON.stringify({
    version: value.modelKey !== undefined ? 4 : value.logicalConversationKey !== undefined
      ? 3
      : value.providerSessionId === undefined ? 1 : 2,
    conversationKey: value.conversationKey,
    ...modelBinding(value.modelKey),
    ...(value.logicalConversationKey === undefined
      ? {}
      : { logicalConversationKey: value.logicalConversationKey }),
    epoch: value.epoch,
    ...(value.providerSessionId === undefined ? {} : { providerSessionId: value.providerSessionId }),
    revision: value.revision,
    runIdDigest: value.runIdDigest,
  })}\n`, "utf8");
  if (bytes.byteLength > MAX_DIRTY_FENCE_BYTES) {
    throw new Error(`History dirty fence exceeds the ${MAX_DIRTY_FENCE_BYTES}-byte limit.`);
  }
  return bytes;
}

export function parseHistoryFile(bytes: Buffer, path: string): LoadedHistoryRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TruncatedHistoryRecordError(`History file ${path} is not valid JSON.`);
  }
  if (!isRecord(value)) throw new Error(`History file ${path} must contain an object.`);
  if (typeof value.conversationId !== "string" || !Array.isArray(value.messages)) {
    throw new Error(`History file ${path} has an unsupported schema.`);
  }
  const conversationId = normalizeConversationId(value.conversationId);
  if (conversationId !== value.conversationId) {
    throw new Error(`History file ${path} contains a non-canonical conversation id.`);
  }
  if (value.messages.length > DEFAULT_MAX_MESSAGES) {
    throw new Error(`History file ${path} exceeds the ${DEFAULT_MAX_MESSAGES}-message limit.`);
  }
  const messages = value.messages.map((message) => validateAndCloneMessage(message as HistoryMessage));
  const keys = Object.keys(value).sort().join(",");
  if (value.version === LEGACY_STORE_VERSION && keys === "conversationId,messages,version") {
    return { sourceVersion: LEGACY_STORE_VERSION, conversationId, messages };
  }
  if (value.version === STORE_VERSION) {
    if (value.native !== undefined) {
      validateNativeTurnHistory(value, (message) => validateAndCloneMessage(message as HistoryMessage));
      if (value.native.authority.ownerKey !== logicalConversationIdForFence(conversationId)) throw new Error("Native canonical authority does not belong to the managed conversation");
    } else validateTurnHistoryV3(value, (message) => validateAndCloneMessage(message as HistoryMessage));
    return { sourceVersion: STORE_VERSION, conversationId, messages, providerSession: { ...value.providerSession },
      ...lastCommitBinding(value), ...nativeExtension(value) };
  }
  if (
    value.version !== PROVIDER_STORE_VERSION
    || keys !== "conversationId,messages,providerSession,version"
    || !isRecord(value.providerSession)
  ) {
    throw new Error(`History file ${path} has an unsupported schema.`);
  }
  const providerKeys = Object.keys(value.providerSession).sort().join(",");
  if (
    providerKeys !== "epoch"
    && providerKeys !== "dirtyRunId,epoch"
    && providerKeys !== "epoch,revision"
    && providerKeys !== "dirtyRunId,epoch,revision"
    && providerKeys !== "epoch,modelKey,revision"
    && providerKeys !== "dirtyRunId,epoch,modelKey,revision"
  ) {
    throw new Error(`History file ${path} has an unsupported provider session schema.`);
  }
  if (typeof value.providerSession.epoch !== "string" || !/^[a-f0-9]{64}$/u.test(value.providerSession.epoch)) {
    throw new Error(`History file ${path} has an invalid provider session epoch.`);
  }
  if ("modelKey" in value.providerSession) assertSessionModelKey(value.providerSession.modelKey);
  let revision: number | undefined;
  if (value.providerSession.revision !== undefined) {
    revision = value.providerSession.revision as number;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(`History file ${path} has an invalid provider session revision.`);
    }
  }
  let dirtyRunId: string | undefined;
  if (value.providerSession.dirtyRunId !== undefined) {
    dirtyRunId = normalizeRunId(value.providerSession.dirtyRunId as string);
    if (dirtyRunId !== value.providerSession.dirtyRunId) {
      throw new Error(`History file ${path} has a non-canonical dirty run id.`);
    }
  }
  return {
    sourceVersion: PROVIDER_STORE_VERSION,
    conversationId,
    messages,
    providerSession: {
      epoch: value.providerSession.epoch,
      ...modelBinding(value.providerSession.modelKey as string | undefined),
      ...(revision === undefined ? {} : { revision }),
      ...(dirtyRunId === undefined ? {} : { dirtyRunId }),
    },
  };
}

export class TruncatedHistoryRecordError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function modelBinding(modelKey: string | undefined): { readonly modelKey?: string } {
  return modelKey === undefined ? {} : { modelKey };
}

export function parseDirtyFence(bytes: Buffer, path: string): DirtyFence {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`History dirty fence ${path} is not valid JSON.`);
    }
    if (isRecord(value) && value.version === 6 && value.kind !== "model-switch") {
      validateDurableTurnFence(value);
      return { path, kind: value.kind, conversationKey: value.conversationKey, logicalConversationKey: value.logicalConversationKey,
        epoch: value.epoch, providerSessionId: value.providerSessionId, modelKey: value.modelKey, revision: value.revision, runIdDigest: value.runIdDigest,
        ...(value.payload === undefined ? {} : { payload: value.payload }) };
    }
    const keys = isRecord(value) ? Object.keys(value).sort().join(",") : "";
    const legacy = isRecord(value)
      && value.version === 1
      && keys === "conversationKey,epoch,revision,runIdDigest,version";
    const current = isRecord(value)
      && value.version === 2
      && keys === "conversationKey,epoch,providerSessionId,revision,runIdDigest,version"
      && typeof value.providerSessionId === "string"
      && /^[a-f0-9]{64}$/u.test(value.providerSessionId);
    const logical = isRecord(value)
      && value.version === 3
      && keys === "conversationKey,epoch,logicalConversationKey,providerSessionId,revision,runIdDigest,version"
      && typeof value.logicalConversationKey === "string"
      && /^[a-f0-9]{64}$/u.test(value.logicalConversationKey)
      && typeof value.providerSessionId === "string"
      && /^[a-f0-9]{64}$/u.test(value.providerSessionId);
    const bound = isRecord(value)
      && value.version === 4
      && keys === "conversationKey,epoch,logicalConversationKey,modelKey,providerSessionId,revision,runIdDigest,version"
      && typeof value.logicalConversationKey === "string"
      && /^[a-f0-9]{64}$/u.test(value.logicalConversationKey)
      && typeof value.providerSessionId === "string"
      && /^[a-f0-9]{64}$/u.test(value.providerSessionId);
    if (bound && isRecord(value)) assertSessionModelKey(value.modelKey);
    if (
      !isRecord(value)
      || (!legacy && !current && !logical && !bound)
      || typeof value.conversationKey !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.conversationKey)
      || typeof value.epoch !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.epoch)
      || !Number.isSafeInteger(value.revision)
      || (value.revision as number) < 0
      || typeof value.runIdDigest !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.runIdDigest)
    ) {
      throw new Error(`History dirty fence ${path} has an unsupported schema.`);
    }
    return {
      path,
      ...(bound ? { modelKey: value.modelKey as string } : {}),
      conversationKey: value.conversationKey,
      ...(logical || bound ? { logicalConversationKey: value.logicalConversationKey as string } : {}),
      epoch: value.epoch,
      ...(current || logical || bound ? { providerSessionId: value.providerSessionId as string } : {}),
      revision: value.revision as number,
      runIdDigest: value.runIdDigest,
    };
}
