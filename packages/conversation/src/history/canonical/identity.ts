import { AGENT_CONTEXT_IMPORT_MAX_CONVERSATION_ID_BYTES } from "@mono-agent/contracts";
import type { RuntimeNativeJournalRef } from "@mono-agent/turn/host/types";
import { createHash } from "node:crypto";
import { stripDailyBucketSuffix } from "../conversation-id.js";
import { MAX_RUN_ID_BYTES } from "./record-contracts.js";

export function normalizeConversationId(conversationId: string): string {
  if (typeof conversationId !== "string") throw new TypeError("conversationId must be a non-empty string.");
  const normalized = conversationId.trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes === 0) throw new TypeError("conversationId must be a non-empty string.");
  if (bytes > AGENT_CONTEXT_IMPORT_MAX_CONVERSATION_ID_BYTES) {
    throw new TypeError(`conversationId must not exceed ${AGENT_CONTEXT_IMPORT_MAX_CONVERSATION_ID_BYTES} UTF-8 bytes.`);
  }
  if (normalized.includes("\0")) throw new TypeError("conversationId must not contain NUL bytes.");
  return normalized;
}



export function logicalConversationIdForFence(conversationId: string): string {
  conversationId = normalizeConversationId(conversationId);
  const logicalId = stripDailyBucketSuffix(conversationId);
  return logicalId.length === 0 ? conversationId : logicalId;
}

export function requiresExactConversationClaim(conversationId: string): boolean {
  return logicalConversationIdForFence(conversationId) !== conversationId;
}



export function normalizeRunId(runId: string): string {
  if (typeof runId !== "string") throw new TypeError("runId must be a non-empty string.");
  const normalized = runId.trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes === 0) throw new TypeError("runId must be a non-empty string.");
  if (bytes > MAX_RUN_ID_BYTES) throw new TypeError(`runId must not exceed ${MAX_RUN_ID_BYTES} UTF-8 bytes.`);
  if (normalized.includes("\0")) throw new TypeError("runId must not contain NUL bytes.");
  return normalized;
}

export function historyKey(conversationId: string): string {
  return createHash("sha256").update("mono-agent-history-v1\0").update(conversationId, "utf8").digest("hex");
}

export function digestRunId(runId: string): string {
  return createHash("sha256").update("mono-agent-provider-dirty-run-v1\0").update(runId, "utf8").digest("hex");
}

export function deriveProviderSessionId(conversationId: string, epoch: string): string {
  return createHash("sha256")
    .update("mono-agent-provider-session-v2\0")
    .update(conversationId, "utf8")
    .update("\0")
    .update(epoch, "utf8")
    .digest("hex");
}

function managedNativeJournalId(handleId: string): string { return createHash("sha256").update(`mono-host-journal-v1\0${handleId}`).digest("hex"); }
/** Every v5 epoch is a deterministic guarded journal derived from its handle. */
export function currentJournal(conversationId: string, epoch: string): RuntimeNativeJournalRef {
  const handleId = deriveProviderSessionId(conversationId, epoch); return { handleId, journalId: managedNativeJournalId(handleId) };
}
