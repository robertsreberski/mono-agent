import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compact, compactWithRequest, prepareCompaction } from "../compaction-kit/compaction.js";
import { HARNESS_CONTEXT } from "../context.js";

// Captured before the pin bump using the published 0.99.2 helpers, not generated
// from the implementation under test. The deterministic provider is synthetic.
const baseline = JSON.parse(readFileSync(new URL("./fixtures/compaction-baseline.json", import.meta.url), "utf8"));
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
      "Keep queue details.", "off", undefined, undefined, HARNESS_CONTEXT);
    expect(requests).toEqual(baseline.requests);
    expect(result).toEqual(baseline.result);
  });
});


it("retains the previous checkpoint when splitting its first retained turn", async () => {
  const user = { role: "user", content: "Fictional large request ".repeat(500), timestamp: 1 };
  const reply = { role: "assistant", content: [{ type: "text", text: "Recent work ".repeat(100) }], timestamp: 2 };
  const prepared = prepareCompaction([
    { type: "compaction", id: "checkpoint", seq: 1, summary: "Keep the fictional constraint.", retainedTail: [user], timestamp: 1 },
    { type: "message", id: "reply", message: reply },
  ], { keepRecentTokens: 100, reserveTokens: 4000 });
  expect(prepared.value.isSplitTurn).toBe(true);
  expect(prepared.value.messagesToSummarize).toEqual([]);
  expect(prepared.value.turnPrefixMessages).toEqual([user]);
  let requests = 0;
  const result = await compactWithRequest(prepared.value,
    { model: { maxTokens: 4096, reasoning: false } }, async () => {
      requests++;
      return { stopReason: "stop", content: [{ type: "text", text: "Prefix summary" }], usage: {} };
    }, HARNESS_CONTEXT);
  expect(requests).toBe(1);
  expect(result.value.summary).toContain("Keep the fictional constraint.");
  expect(result.value.summary).toContain("Prefix summary");
  expect(result.value.summary).not.toContain("No prior history.");
});
