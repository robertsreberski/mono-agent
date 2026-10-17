import { expect, it } from "vitest";
import { effectivePayloadEffort } from "../../providers/pi/effective-effort.js";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai";
it("reports serialized max to high mapping, not configured max", async () => {
  const model = { api: "openai-completions", provider: "faux", id: "fictional", baseUrl: "https://fictional.invalid/v1", reasoning: true,
    input: ["text"], contextWindow: 100000, maxTokens: 2048, thinkingLevelMap: { max: "high" },
    compat: { supportsReasoningEffort: true }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let effort;
  const stream = streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Fictional query", timestamp: 0 }] }), {
    apiKey: "fictional-test-key", reasoning: "max", maxRetries: 0,
    onPayload(payload) { effort = effectivePayloadEffort(payload, model); throw new Error("Captured"); },
    fetch() { throw new Error("No network"); },
  });
  await stream.result();
  expect(effort).toBe("high");
});
it("uses active Anthropic effort, Google casing and honest budget-only unknowns", () => {
  expect(effectivePayloadEffort({ output_config: { effort: "high" }, messages: [
    { role: "system", output_config: { effort: "max" } }, { role: "system", output_config: { effort: "low" } }],
  }, { api: "anthropic-messages", reasoning: true, compat: { supportsMidConvoEffort: true } })).toBe("low");
  expect(effectivePayloadEffort({ config: { thinkingConfig: { thinkingLevel: "LOW" } } }, { api: "google-generative-ai", reasoning: true })).toBe("low");
  expect(effectivePayloadEffort({ config: { thinkingConfig: { thinkingBudget: 2048 } } }, { api: "google-generative-ai", reasoning: true })).toBeUndefined();
  expect(effectivePayloadEffort({ thinking: { type: "disabled" } }, { api: "anthropic-messages", reasoning: true })).toBe("none");
});
