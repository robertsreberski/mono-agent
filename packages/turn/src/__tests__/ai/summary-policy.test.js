import { expect, it } from "vitest";
import { summaryRequestOptions, summaryThinkingLevel } from "../../ai/providers/engine-turn/summary-policy.js";
import { summaryModels } from "../../ai/providers/engine-turn/compaction-summary.js";
import { compact } from "../../engine/compaction-kit/compaction.js";
import { ENGINE_CONTEXT } from "../../engine/context.js";

const model = { id: "fictional-adaptive", provider: "faux", api: "anthropic-messages", reasoning: true,
  contextWindow: 1000000, maxTokens: 128000, thinkingLevelMap: { off: null, minimal: null, max: "max" },
  compat: { forceAdaptiveThinking: true } };

it("chooses off when possible, low for mandatory thinking and clamps explicit effort", () => {
  expect(summaryThinkingLevel({ ...model, reasoning: false })).toBe("off");
  expect(summaryThinkingLevel({ ...model, thinkingLevelMap: {} })).toBe("off");
  expect(summaryThinkingLevel(model)).toBe("low");
  expect(summaryThinkingLevel(model, "none")).toBe("low");
  expect(summaryThinkingLevel(model, "max")).toBe("max");
});
it.each([12000, 64000, 7384])("reserves adaptive reasoning beyond text target %i without changing legacy behavior", (target) => {
  const context = { messages: [] };
  const { options, metadata } = summaryRequestOptions(model, context, { maxTokens: target });
  expect(options.reasoning).toBe("low");
  expect(options.maxTokens).toBe(target + Math.min(8192, Math.max(2048, Math.ceil(target / 2))));
  expect(metadata.textTargetTokens).toBe(target);
  expect(summaryRequestOptions({ ...model, compat: {} }, context, { maxTokens: target }).options.maxTokens).toBe(target);
  expect(summaryRequestOptions({ ...model, maxTokens: target }, context, { maxTokens: target }).options.maxTokens).toBe(target);
});
it.each([false, true])("real compact path survives fake adaptive thinking-only truncation (split %s)", async (split) => {
  const requests = [];
  const fake = { completeSimple: async (_model, _context, options) => ({ role: "assistant", timestamp: 0,
    stopReason: options.reasoning === "low" && options.maxTokens > 12000 / (split ? 1.3 : 1) * (split ? 0.5 : 0.8) ? "stop" : "length",
    content: options.reasoning === "low" ? [{ type: "text", text: "Morgan: finish the pending tests. No deployment approved." }] : [],
    usage: { input: 500000, output: 12000, cost: { total: 2.5 } } }) };
  const preparation = { messagesToSummarize: [{ role: "user", content: "Fictional work", timestamp: 0 }],
    turnPrefixMessages: split ? [{ role: "user", content: "Pending turn", timestamp: 0 }] : [],
    retainedTail: [], isSplitTurn: split, tokensBefore: 500000, fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { reserveTokens: split ? 9231 : 15000, keepRecentTokens: 4000 } };
  const facade = summaryModels(fake, { operationId: "fake-adaptive", focus: "Summarize.", requests });
  const outcome = await compact(preparation, facade, model, undefined, "max", undefined, undefined, ENGINE_CONTEXT);
  expect(outcome.ok).toBe(true);
  expect(requests).toHaveLength(split ? 2 : 1);
  expect(requests.every((row) => row.effectiveEffort === "low" && row.status === "succeeded" && row.costUsd === 2.5)).toBe(true);
});
