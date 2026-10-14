import { expect, it, vi } from "vitest";
import { recognizesTurnCommit, validateTurnHistoryV3 } from "../durable-turn-history.js";
import type { TurnHistoryV3 } from "../durable-turn-history.js";
import type { HistoryMessage } from "../context/index.js";
const hash = "a".repeat(64);
const receipt = { version: 1 as const, turnId: "fictional-turn", inputDigest: hash, candidateDigest: hash, journalId: "fictional-journal", tipId: "fictional-tip", baseRevision: 0, committedRevision: 1, outcome: "completed" as const };
const record = (): TurnHistoryV3 => ({ version: 3, conversationId: "fictional-bucket", messages: [{ role: "assistant", content: "Fictional reply." }], providerSession: { epoch: hash, modelKey: "openai:fictional-model", revision: 1 }, lastCommit: receipt });
const validate = (value: unknown): HistoryMessage => {
  if (!value || typeof value !== "object" || !("content" in value) || typeof value.content !== "string") throw new Error("Invalid fictional canonical message");
  return value as HistoryMessage;
};
it("validates canonical v3 through the existing message validator rather than private result projection", () => {
  const messageValidation = vi.fn(validate); validateTurnHistoryV3(record(), messageValidation); expect(messageValidation).toHaveBeenCalledOnce();
  expect(() => validateTurnHistoryV3({ ...record(), messages: [{ role: "assistant", content: {} }] }, validate)).toThrow("canonical message");
});
it("recognizes the last receipt after every committed message is evicted", () => {
  const value = { ...record(), messages: [] }; validateTurnHistoryV3(value, validate);
  expect(recognizesTurnCommit(value, value.conversationId, receipt.turnId, hash, hash)).toBe(true);
  expect(recognizesTurnCommit(value, "foreign-bucket", receipt.turnId, hash, hash)).toBe(false);
  expect(recognizesTurnCommit(value, value.conversationId, "other-turn", hash, hash)).toBe(false);
  expect(() => recognizesTurnCommit(value, value.conversationId, receipt.turnId, hash, "b".repeat(64))).toThrow("conflicts");
});
it("permits an explicit cold native boundary while preserving canonical idempotency", () => {
  const value = { ...record(), providerSession: { ...record().providerSession, epoch: "b".repeat(64), revision: 0 } };
  expect(() => validateTurnHistoryV3(value, validate)).not.toThrow();
  expect(recognizesTurnCommit(value, value.conversationId, receipt.turnId, hash, hash)).toBe(true);
  expect(() => validateTurnHistoryV3({ ...record(), providerSession: { ...record().providerSession, revision: 2 } }, validate)).not.toThrow();
});
it.each(["deliveryKey", "ownerText", "runtime", "metadata"])("rejects an extra v3 canonical/receipt/provider field %s", (key) => {
  expect(() => validateTurnHistoryV3({ ...record(), [key]: "fictional" }, validate)).toThrow();
  expect(() => validateTurnHistoryV3({ ...record(), lastCommit: { ...receipt, [key]: "fictional" } }, validate)).toThrow();
  expect(() => validateTurnHistoryV3({ ...record(), providerSession: { ...record().providerSession, [key]: "fictional" } }, validate)).toThrow();
});
it("rejects over-limit message count and malformed model references without a new history limit", () => {
  expect(() => validateTurnHistoryV3({ ...record(), messages: Array.from({ length: 65 }, () => record().messages[0]) }, validate)).toThrow();
  expect(() => validateTurnHistoryV3({ ...record(), providerSession: { ...record().providerSession, modelKey: "not-a-model-reference" } }, validate)).toThrow();
});
