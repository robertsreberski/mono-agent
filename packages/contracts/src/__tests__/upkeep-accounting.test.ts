import { expect, it } from "vitest";
import { parseAgentUpkeepAccounting, mergeAgentUpkeepAccounting } from "../upkeep-accounting.js";

const dispatch = { version: 1, usageIncluded: false, operationId: "operation", databaseId: "database", incarnation: "incarnation",
  runId: "origin-run", conversationId: "conversation", logicalConversationId: "logical", recorderNamespace: "/home/example/runs", model: "fictional:extractor", budget: "bootstrap", phase: "dispatch", invocation: "uncertain", outcome: "uncertain",
  inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null };
const result = { ...dispatch, phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 2, costUsd: 0.25 };
it("validates closed, nullable, content-free v1 evidence and result precedence in either order", () => {
  expect(parseAgentUpkeepAccounting(dispatch)).toEqual(dispatch);
  expect(mergeAgentUpkeepAccounting([dispatch, result, dispatch, result])).toEqual([result]);
  expect(mergeAgentUpkeepAccounting([result, dispatch])).toEqual([result]);
  expect(parseAgentUpkeepAccounting({ ...result, inputTokens: null, costUsd: null })).toMatchObject({ inputTokens: null, costUsd: null });
});
it.each([NaN, Infinity, -1, "0", undefined, 1.5])("rejects invalid token counter %s", inputTokens => {
  expect(() => parseAgentUpkeepAccounting({ ...result, inputTokens })).toThrow();
});
it.each([
  { version: 2 }, { usageIncluded: true }, { text: "Fictional evidence" }, { inputTokens: 0 }, { runId: "" },
  { costUsd: -1 }, { budget: "unknown" }, { invocation: "not_invoked" }, { outcome: "valid" },
])("rejects invalid or content-bearing dispatch fields %o", extra => {
  expect(() => parseAgentUpkeepAccounting({ ...dispatch, ...extra })).toThrow();
});
it("never invokes getters and rejects origin/model/budget or same-phase conflicts", () => {
  expect(() => parseAgentUpkeepAccounting({ ...dispatch, get inputTokens() { throw new Error("getter invoked"); } })).toThrow("Invalid upkeep accounting");
  for (const key of ["runId", "conversationId", "databaseId", "incarnation", "model", "recorderNamespace", "budget"]) {
    expect(() => mergeAgentUpkeepAccounting([dispatch, { ...result, [key]: key === "budget" ? "incremental" : "other" }])).toThrow("Conflicting upkeep identity");
  }
  expect(() => mergeAgentUpkeepAccounting([result, { ...result, costUsd: 1 }])).toThrow("Conflicting upkeep evidence");
});
it("allows proven non-invocation only with zero counters and uncertain results only with nulls", () => {
  const skipped = { ...result, invocation: "not_invoked", outcome: "skipped", inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 };
  expect(parseAgentUpkeepAccounting(skipped)).toEqual(skipped);
  expect(() => parseAgentUpkeepAccounting({ ...skipped, costUsd: null })).toThrow();
  expect(() => parseAgentUpkeepAccounting({ ...dispatch, phase: "result", costUsd: 0 })).toThrow();
});
