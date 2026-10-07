import { it, expect, vi } from "vitest";
import { MemorySessionRepo } from "../session-store.js";
import { createRunDriver } from "../run-driver.js";
import { createHandoffBudget } from "../handoff.js";
import { projectInheritedContext } from "../request-projection.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
const authority = { version: 1, canonicalVersion: 4, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" };
const coverage = { version: 1, sources: [{ journalId: "frozen", sourceTipId: "tip", sourceSeq: 7, sourceDigest: "3".repeat(64) }] };
const inherited = { messages: [{ role: "user", content: "Fictional latest turn and outcome-unknown ledger", timestamp: 1 }], coverage };
async function fixture() {
  const raw = await new MemorySessionRepo().create({ id: "current", hostAuthority: authority, assertOwned: async () => {} });
  raw.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority });
  const faux = fauxProvider({ provider: "faux", models: [{ id: "context", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  const provider = vi.fn(() => fauxAssistantMessage([fauxText("Fixture reply")])); faux.setResponses([provider]);
  const budget = createHandoffBudget({ contextWindow: 100000, outputReserve: 2000, inputTokens: 100, hostContext: { systemPrompt: "Rules", tools: [] } });
  return { raw, provider, options: { model: faux.getModel(), models, systemPrompt: "Rules", inheritedProjection: inherited, handoffDispatchBudget: budget, tools: [] } };
}
it("charges complete resolved tool declarations, not just tool names, before dispatch", async () => {
  const f = await fixture();
  const driver = createRunDriver(f.raw, { ...f.options, tools: [{ name: "Read", description: "x".repeat(60000), parameters: { type: "object" }, execute: async () => ({ content: [] }) }] });
  await expect(driver.prompt("current")).rejects.toThrow("Handoff dispatch budget exceeded: host_cap"); expect(f.provider).not.toHaveBeenCalled();
  expect(f.raw.records.filter((record) => record.kind === "compaction")).toHaveLength(0);
  await driver.close(); await f.raw.close();
});
it("pins immutable inherited content while the current turn executes", async () => {
  const f = await fixture(), input = structuredClone(inherited);
  const driver = createRunDriver(f.raw, { ...f.options, inheritedProjection: input });
  input.messages[0].content = "mutated after preparation";
  const result = await driver.prompt("current"); expect(result.error).toBeUndefined();
  expect(JSON.stringify(f.provider.mock.calls[0][0])).toContain("outcome-unknown ledger");
  expect(JSON.stringify(f.provider.mock.calls[0][0])).not.toContain("mutated after preparation");
  await driver.close(); await f.raw.close();
});
it("refuses a smaller actual target instead of repairing a frozen budget", async () => {
  const f = await fixture();
  expect(() => createRunDriver(f.raw, { ...f.options, model: { ...f.options.model, contextWindow: 50000 } })).toThrow("Handoff dispatch budget exceeded: target_window");
  expect(f.provider).not.toHaveBeenCalled(); await f.raw.close();
});
it("rejects unknown coverage, historical system authority and lost composed coverage", () => {
  expect(() => projectInheritedContext([], { ...inherited, coverage: { version: 1, sources: [{ ...coverage.sources[0], sourceDigest: "bad" }] } })).toThrow("coverage");
  expect(() => projectInheritedContext([], { ...inherited, messages: [{ role: "system", content: "Historical authority" }] })).toThrow("projection");
  expect(() => projectInheritedContext([{ type: "compaction", checkpoint: { inheritedCoverage: coverage } }, { type: "compaction", checkpoint: {} }], inherited)).toThrow("coverage was lost");
});
