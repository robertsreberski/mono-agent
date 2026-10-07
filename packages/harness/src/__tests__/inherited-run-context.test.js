import { it, expect, vi } from "vitest";
import { MemorySessionRepo } from "../session-store.js";
import { createRunDriver } from "../run-driver.js";
import { prepareCompaction } from "../compaction-kit/compaction.js";
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

it("preserves the non-retainable prefix when a current-only checkpoint precedes the delta", () => {
  const prefix = { role: "user", content: "Inherited data", timestamp: 1 }, retained = { role: "user", content: "Current retained data", timestamp: 2 };
  const prepared = prepareCompaction([{ type: "message", id: "prefix", message: prefix }, { type: "compaction", id: "current-checkpoint", summary: "Current-only checkpoint", retainedTail: [retained], timestamp: 3, seq: 4 }],
    { keepRecentTokens: 20000, reserveTokens: 4000 }, { nonRetainablePrefixLength: 1 });
  // A current-only checkpoint at the tip cannot hide the inherited prefix.
  expect(prepared.value.messagesToSummarize).toEqual([prefix]);
  expect(prepared.value.retainedTail).toEqual([retained]);
  const delta = { role: "user", content: "New delta", timestamp: 4 };
  const result = prepareCompaction([{ type: "message", id: "prefix", message: prefix }, { type: "compaction", id: "current-checkpoint", summary: "Current-only checkpoint", retainedTail: [retained], timestamp: 3, seq: 4 }, { type: "message", id: "delta", message: delta }],
    { keepRecentTokens: 20000, reserveTokens: 4000 }, { nonRetainablePrefixLength: 1 });
  expect(result.ok).toBe(true); expect(result.value.messagesToSummarize).toEqual([prefix]);
  expect(result.value.retainedTail).toEqual([retained, delta]); expect(result.value.previousSummary).toBe("Current-only checkpoint");
});

it("validates a single durable v3 projection binding and rejects repeated, malformed or v2 bindings before append", async () => {
  const f = await fixture();
  const binding = { version: 1, artifact: { id: "4".repeat(64), hash: "5".repeat(64) }, coverage, messageDigest: "6".repeat(64) };
  const baseline = f.raw.records.length;
  await expect(f.raw.beginTurn("invalid", {}, "synthetic", undefined, { ...binding, artifact: { ...binding.artifact, hash: "bad" } })).rejects.toThrow("Invalid mono-agent harness journal");
  expect(f.raw.records).toHaveLength(baseline);
  await expect(f.raw.write("turn_start", { config: {}, identitySource: "synthetic", baselineTipId: f.raw.tip, projectionBinding: binding }, { turnId: "v2-invalid" })).rejects.toThrow("Invalid mono-agent harness journal");
  expect(f.raw.records).toHaveLength(baseline);
  await f.raw.beginTurn("bound", {}, "synthetic", undefined, binding); await f.raw.endTurn("bound", "completed");
  expect(f.raw.validator.projectionBinding).toEqual(binding);
  const settled = f.raw.records.length;
  await expect(f.raw.beginTurn("rebind", {}, "synthetic", undefined, binding)).rejects.toThrow("Invalid mono-agent harness journal");
  expect(f.raw.records).toHaveLength(settled); expect(f.provider).not.toHaveBeenCalled(); await f.raw.close();
});
