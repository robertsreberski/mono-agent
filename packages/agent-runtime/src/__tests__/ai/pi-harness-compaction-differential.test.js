import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compact, prepareCompaction } from "../../ai/providers/pi-native/harness/compaction-kit/compaction.js";
import { PI_CONTEXT } from "../../ai/providers/pi-native/harness/context.js";

// Captured before the pin bump using the published 0.99.2 helpers, not generated
// from the implementation under test. The deterministic provider is synthetic.
const baseline = JSON.parse(readFileSync(new URL("./fixtures/pi-harness/compaction-baseline.json", import.meta.url), "utf8"));
describe("owned compaction kit vs 0.99.2 baseline", () => {
  it("preserves summary input, retained tail, tokensBefore and billed usage", async () => {
    const prepared = prepareCompaction(baseline.pathEntries, baseline.settings);
    expect(prepared.ok).toBe(true);
    const requests = [];
    const models = { completeSimple: async (_model, context, options) => {
      requests.push({ context: { ...context, messages: context.messages.map(({ timestamp, ...m }) => m) },
        options: { maxTokens: options.maxTokens, cacheRetention: options.cacheRetention } });
      return { ...baseline.pathEntries[1].message, content: [{ type: "text", text: "Fictional deterministic summary." }] };
    } };
    const result = await compact(prepared.value, models,
      { id: "fixture-model", provider: "faux", maxTokens: 4096, reasoning: false },
      "Keep queue details.", "off", undefined, undefined, PI_CONTEXT);
    expect(requests).toEqual(baseline.requests);
    expect(result).toEqual(baseline.result);
  });
});
