import { expect, it } from "vitest";
import { deriveUpkeepAccounting, forwardUpkeepAccounting, mergeForwardedUpkeepAccounting, parseForwardedUpkeepAccounting } from "../upkeep-accounting.js";
const full = { version: 1, usageIncluded: false, operationId: "fictional-op", databaseId: "database", incarnation: "epoch", recorderNamespace: "/home/example", logicalConversationId: "logical", runId: "run", conversationId: "conversation", model: "fictional:extractor", budget: "bootstrap", phase: "dispatch", invocation: "uncertain", outcome: "uncertain", inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null } as const;
const dispatch = forwardUpkeepAccounting(full);
const result = { ...dispatch, phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, costUsd: 0.02 } as const;
it("shares once-only nullable cost derivation without storage identity leakage", () => {
  expect(parseForwardedUpkeepAccounting(dispatch)).toEqual(dispatch);
  expect(JSON.stringify(dispatch)).not.toContain("/home/example");
  expect(mergeForwardedUpkeepAccounting([dispatch, result, dispatch, result])).toEqual([result]);
  expect(deriveUpkeepAccounting([dispatch], { totalUsd: 1 })).toMatchObject({ cost: { totalUsd: null, knownCostUsd: 1, partial: true }, tokensPartial: true });
  expect(deriveUpkeepAccounting([result, dispatch, result], { totalUsd: 1 })).toMatchObject({ cost: { totalUsd: 1.02, knownCostUsd: 1.02, partial: false }, tokens: { input: 10, cacheRead: 2, cacheWrite: 3, output: 4 }, tokensPartial: false });
});
it("rejects host-local fields, invalid numbers, executable properties and conflicts", () => {
  let getters = 0;
  for (const value of [full, { ...result, extra: "not forwarded" }, { ...result, costUsd: -1 }, { ...result, inputTokens: 1.5 }, Object.defineProperty({ ...result }, "costUsd", { get() { getters++; return 0.02; } })]) expect(() => parseForwardedUpkeepAccounting(value)).toThrow();
  expect(getters).toBe(0);
  expect(() => mergeForwardedUpkeepAccounting([result, { ...result, model: "fictional:other" }])).toThrow();
  expect(() => mergeForwardedUpkeepAccounting([result, { ...result, costUsd: 2 }])).toThrow();
});
it("retains a known price with incomplete counters and refuses overflow as complete", () => {
  expect(deriveUpkeepAccounting([{ ...result, outputTokens: null }])).toMatchObject({ cost: { totalUsd: 0.02, partial: false }, tokensPartial: true });
  expect(deriveUpkeepAccounting([{ ...result, inputTokens: Number.MAX_SAFE_INTEGER }, { ...result, operationId: "another" }]).tokensPartial).toBe(true);
});

it("derives identical totals for differently ordered operation replay", () => {
  const rows = [0.1, 0.2, 0.3].map((costUsd, index) => ({ ...result, operationId: `operation-${index}`, costUsd }));
  expect(deriveUpkeepAccounting(rows)).toEqual(deriveUpkeepAccounting([...rows].reverse()));
});
