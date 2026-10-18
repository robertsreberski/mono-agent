import type { Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { summaryRequestOptions, summaryThinkingLevel } from "../../execution/pi/compaction/summary-policy.js";
import { summaryModels } from "../../execution/pi/compaction/compaction-summary.js";
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
  const requests: Array<{ effectiveEffort: string; status: string; costUsd: number }> = [];
  const fake = { completeSimple: async (_model: unknown, _context: unknown, options: { reasoning: string; maxTokens: number }) => ({ role: "assistant", timestamp: 0,
    stopReason: options.reasoning === "low" && options.maxTokens > 12000 / (split ? 1.3 : 1) * (split ? 0.5 : 0.8) ? "stop" : "length",
    content: options.reasoning === "low" ? [{ type: "text", text: "Morgan: finish the pending tests. No deployment approved." }] : [],
    usage: { input: 500000, output: 12000, cost: { total: 2.5 } } }) };
  const preparation = { messagesToSummarize: [{ role: "user", content: "Fictional work", timestamp: 0 }],
    turnPrefixMessages: split ? [{ role: "user", content: "Pending turn", timestamp: 0 }] : [],
    retainedTail: [], isSplitTurn: split, tokensBefore: 500000, fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { reserveTokens: split ? 9231 : 15000, keepRecentTokens: 4000 } };
  const facade = summaryModels(fake, { operationId: "fake-adaptive", focus: "Summarize.", requests } as Parameters<typeof summaryModels>[1]);
  const outcome = await compact(preparation, facade, model, undefined, "max", undefined, undefined, ENGINE_CONTEXT);
  expect(outcome.ok).toBe(true);
  expect(requests).toHaveLength(split ? 2 : 1);
  expect(requests.every((row) => row.effectiveEffort === "low" && row.status === "succeeded" && row.costUsd === 2.5)).toBe(true);
});
it("bounds shared Google thinking budgets instead of inheriting conversation reasoning", () => {
  const context = { messages: [] };
  const { options } = summaryRequestOptions({ ...model, api: "google-generative-ai" }, context, { maxTokens: 2000 }, "low");
  expect(options.thinkingBudgets.low).toBe(976);
  expect(options.maxTokens).toBe(2000);
  expect(summaryRequestOptions({ ...model, api: "google-generative-ai" }, context, { maxTokens: 1000 }, "low").options.thinkingBudgets.low).toBe(128);
});
it.each([1, 512, 1000])("refuses a model-clamped %i-token answer below the useful minimum", (maxTokens) => {
  const policy = summaryRequestOptions({ ...model, reasoning: false, maxTokens }, { messages: [] }, { maxTokens: 2000 });
  expect(policy.canDispatch).toBe(false);
  expect(policy.metadata.minimumAnswerTokens).toBe(1024);
});
it("refuses adaptive thinking when its allowance leaves no useful answer", () => {
  expect(summaryRequestOptions({ ...model, maxTokens: 2048 }, { messages: [] }, { maxTokens: 12000 }).canDispatch).toBe(false);
});
it("fits legacy thinking once inside the actual available context", () => {
  const policy = summaryRequestOptions({ ...model, compat: {}, contextWindow: 14000 }, { messages: [] }, { maxTokens: 12000 });
  expect(policy.canDispatch).toBe(true);
  expect(policy.metadata.providerMaxTokens).toBeLessThanOrEqual(policy.metadata.availableProviderTokens);
  expect(policy.metadata.providerMaxTokens - policy.options.maxTokens).toBe(2048);
});
it("preserves intentional small split-summary targets when they fit", () => {
  const policy = summaryRequestOptions({ ...model, reasoning: false }, { messages: [] }, { maxTokens: 384 });
  expect(policy.canDispatch).toBe(true);
  expect(policy.options.maxTokens).toBe(384);
  expect(policy.metadata.minimumAnswerTokens).toBe(384);
});
it("gives level-based Gemini bounded answer headroom and no ignored budget controls", () => {
  const gemini = { ...model, api: "google-generative-ai", id: "gemini-3.1-pro-preview" };
  const policy = summaryRequestOptions(gemini, { messages: [] }, { maxTokens: 12000 });
  expect(policy.options.reasoning).toBe("low");
  expect(policy.options.thinkingBudgets).toBeUndefined();
  expect(policy.options.maxTokens).toBe(18000);
  expect(policy.metadata.reasoningAllowance).toBe(6000);
  expect(policy.canDispatch).toBe(true);
  expect(summaryRequestOptions({ ...gemini, maxTokens: 6000 }, { messages: [] }, { maxTokens: 12000 }).canDispatch).toBe(false);
});
it("sends the enlarged cap with Gemini thinkingLevel, not an ignored thinkingBudget", async () => {
  const { streamSimple } = await import("@earendil-works/pi-ai/api/google-generative-ai");
  const gemini = { ...model, id: "gemini-3.1-pro-preview", provider: "google", api: "google-generative-ai", input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const policy = summaryRequestOptions(gemini, { messages: [] }, { maxTokens: 12000 });
  let payload: { config: { maxOutputTokens: number; thinkingConfig: { thinkingLevel: string; thinkingBudget?: number } } };
  const stream = streamSimple(gemini as Model<"google-generative-ai">, { messages: [{ role: "user", content: "Fictional summary", timestamp: 0 }] } as Parameters<typeof streamSimple>[1], {
    ...policy.options, apiKey: "fictional-test-key", onPayload: (value) => { payload = value as typeof payload; throw new Error("Captured before network"); } });
  expect((await stream.result()).errorMessage).toContain("Captured before network");
  expect(payload!.config.maxOutputTokens).toBe(18000);
  expect(payload!.config.thinkingConfig.thinkingLevel).toBe("LOW");
  expect(payload!.config.thinkingConfig.thinkingBudget).toBeUndefined();
});

it("reserves shared-cap reasoning room for other always-on reasoning families", () => {
  const policy = summaryRequestOptions({ ...model, api: "openai-responses" }, { messages: [] }, { maxTokens: 12000 });
  expect(policy.options.maxTokens).toBe(18000);
  expect(policy.metadata.reasoningAllowance).toBe(6000);
  expect(policy.canDispatch).toBe(true);
});
