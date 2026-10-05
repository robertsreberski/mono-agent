import { assertSessionModelKey } from "./session-runtime.js";
import type { HistoryMessage } from "./context/index.js";
import { validateDurableTurnReceipt } from "./durable-turn-contract.js";
import type { DurableTurnReceipt } from "./durable-turn-contract.js";

/** Canonical P2b replacement; old v1/v2 readers reject the version explicitly. */
export interface TurnHistoryV3 {
  readonly version: 3;
  readonly conversationId: string;
  readonly messages: readonly HistoryMessage[];
  readonly providerSession: { readonly epoch: string; readonly revision: number; readonly modelKey?: string };
  readonly lastCommit?: DurableTurnReceipt;
}
export function validateTurnHistoryV3(value: unknown, validateMessage: (message: unknown) => HistoryMessage): asserts value is TurnHistoryV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid v3 history record");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (record.version !== 3 || !["conversationId,messages,providerSession,version", "conversationId,lastCommit,messages,providerSession,version"].includes(keys)
    || typeof record.conversationId !== "string" || !record.conversationId.length || record.conversationId !== record.conversationId.trim()
    || record.conversationId.includes("\0") || Buffer.byteLength(record.conversationId) > 4096 || !Array.isArray(record.messages) || record.messages.length > 64) {
    throw new TypeError("Invalid v3 history record");
  }
  for (const message of record.messages) validateMessage(message);
  const provider = record.providerSession;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new TypeError("Invalid v3 provider state");
  const state = provider as Record<string, unknown>, stateKeys = Object.keys(state).sort().join(",");
  if (!["epoch,revision", "epoch,modelKey,revision"].includes(stateKeys) || typeof state.epoch !== "string" || !/^[a-f0-9]{64}$/u.test(state.epoch)
    || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0 || (state.modelKey !== undefined && (typeof state.modelKey !== "string" || !state.modelKey.length))) {
    throw new TypeError("Invalid v3 provider state");
  }
  if (state.modelKey !== undefined) assertSessionModelKey(state.modelKey);
  if (record.lastCommit !== undefined) {
    validateDurableTurnReceipt(record.lastCommit);
    // A cold boundary may rotate the epoch/revision to zero after a native gap;
    // the last canonical commit receipt remains valid for duplicate settlement.
    if (state.revision !== 0 && state.revision !== record.lastCommit.committedRevision) throw new TypeError("V3 history receipt revision mismatch");
  }
}
/** Receipt identity is independent of retained messages, never a message scan. */
export function recognizesTurnCommit(record: Pick<TurnHistoryV3, "conversationId" | "lastCommit">, conversationId: string,
  turnId: string, inputDigest: string, candidateDigest: string): boolean {
  const receipt = record.lastCommit;
  if (!receipt || record.conversationId !== conversationId || receipt.turnId !== turnId) return false;
  validateDurableTurnReceipt(receipt);
  if (receipt.inputDigest !== inputDigest || receipt.candidateDigest !== candidateDigest) throw new Error("Canonical turn receipt conflicts with pending candidate");
  return true;
}
