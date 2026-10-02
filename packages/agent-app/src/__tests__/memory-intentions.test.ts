import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rankDeliberateRecallHits } from "@mono-agent/memory/bujo";
import type { MemoryDb } from "@mono-agent/memory/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMemoryBackground, formatMemoryProfile } from "../memory-guidance.js";
import { createMemoryRecallServer, type MemoryRecallHit, type RecallCapableStore } from "../memory-recall.js";
import { MemoryRetrievalService, type SharedRecallStore } from "../memory-retrieval.js";

type LabelHit = ReturnType<MemoryDb["labelsForEntity"]>[number];
const date = "2032-06-10"; const now = `${date}T12:00:00.000Z`;
const texts = ["Owner completed the canoe lesson.", "Właściciel porzucił kurs gry na flecie.",
  "Il proprietario attende una lezione di mosaico.", "La persona planea un curso de vela."];
const labels: LabelHit[] = texts.map((text, index) => ({ memoryId: `intention-${index}`, ordinal: 0, text,
  type: "note", status: index === 0 ? "done" : index === 1 ? "dropped" : "open", active: true, conflict: false,
  createdAt: now, currentAt: true, ...(index === 2 ? { dueAt: "2032-06-09" } : index === 3 ? { dueAt: "2032-06-12" } : {}),
  label: { v: 1, kind: "preference", scope: "agent", attribution: "user-stated" },
}));
const hits: MemoryRecallHit[] = labels.map((hit) => ({ score: 0.9, record: { id: hit.memoryId, text: hit.text, type: "note", status: hit.status as "open" | "done" | "dropped",
  createdAt: hit.createdAt, ...(hit.dueAt === undefined ? {} : { dueAt: hit.dueAt }) } }));
const options = { ownerTurn: true, hostLocalDate: date, hostDate: date, hostInstant: now, turnId: "fixture-cold", retainedContext: false } as const;
function backend(tier: "bujo" | "journal" | "lite" = "bujo"): SharedRecallStore {
  return { tier: () => tier, load: async () => undefined, close: async () => {}, recall: async () => hits,
    recallWithOutcome: async () => ({ hits, retrievalMode: "hybrid" }), labelsForMemories: () => labels,
    guidanceForScope: () => labels, labelsForEntity: () => labels.map((hit) => ({ ...hit,
      label: { v: 1, kind: "fact", entityId: "person:owner", key: "work_location", value: { type: "text", text: "Fictional workshop" }, attribution: "user-stated" } })),
  };
}
afterEach(() => { vi.useRealTimers(); });
async function call(store: RecallCapableStore, args: Record<string, unknown>) {
  const server = createMemoryRecallServer(store); const client = new Client({ name: "fictional-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try { return await client.callTool({ name: "MemoryRecall", arguments: args }); }
  finally { await client.close(); await server.close(); }
}
describe("conservative intention expiry across automatic app sections", () => {
  it.each([false, true])("excludes closed and all dated notes with semanticOnly=%s, including future/legacy dates", async (semanticOnly) => {
    const store = backend();
    expect(formatMemoryBackground(store, "person:owner", "chat", options, hits, 1024, new Set(), semanticOnly, true)).toBeUndefined();
    expect(formatMemoryProfile(store, date, Infinity, now, semanticOnly).content).toBe("");
    const service = new MemoryRetrievalService(store, { intentExpiry: true, semanticOnly, profileEnabled: true });
    expect(await service.load("chat", "Which fictional lessons are planned next?", options)).toBeUndefined();
    expect((await service.recallForTurn(options.turnId, "Which fictional lessons are planned next?")).map((hit) => hit.record.id)).toEqual(hits.map((hit) => hit.record.id));
  });
  it("keeps absent/off output identical and does not reinterpret Lite or Journal", async () => {
    for (const tier of ["bujo", "lite", "journal"] as const) {
      const legacy = await new MemoryRetrievalService(backend(tier)).load("chat", "Which fictional lessons are planned next?", options);
      expect(await new MemoryRetrievalService(backend(tier), { intentExpiry: false }).load("chat", "Which fictional lessons are planned next?", options)).toEqual(legacy);
      if (tier !== "bujo") expect(await new MemoryRetrievalService(backend(tier), { intentExpiry: true }).load("chat", "Which fictional lessons are planned next?", options)).toEqual(legacy);
    }
  });
  it("updates the profile once when an undated source ends, using invocation receipts", async () => {
    let done = false;
    const active: LabelHit = { ...labels[0]!, memoryId: "undated", status: "open", text: "Owner awaits the canoe lesson.",
      label: { v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" } };
    const store = backend(); store.guidanceForScope = () => [];
    store.labelsForEntity = () => [{ ...active, status: done ? "done" : "open" }];
    store.labelsForMemories = () => store.labelsForEntity!("person:owner");
    store.recallWithOutcome = async () => ({ retrievalMode: "hybrid", hits: [{ score: 0.9, record: { id: "undated", text: active.text, type: "note", status: done ? "done" : "open", createdAt: now } }] });
    const service = new MemoryRetrievalService(store, { intentExpiry: true, semanticOnly: true, profileEnabled: true, contextWindow: true });
    expect((await service.load("chat", "Which fictional lesson is planned?", options))?.content).toContain(active.text);
    service.recordInvocation(options.turnId); service.releaseTurn(options.turnId);
    done = true;
    const next = { ...options, retainedContext: true, turnId: "fixture-ended", hostInstant: `${date}T12:01:00.000Z` };
    const changed = await service.load("chat", "And that lesson?", next);
    expect(changed?.content).toContain("No active supported profile entries."); expect(changed?.content).not.toContain(active.text);
    service.recordInvocation(next.turnId); service.releaseTurn(next.turnId);
    expect(await service.load("chat", "And that lesson?", { ...next, turnId: "fixture-stable" })).toBeUndefined();
  });
});
describe("deliberate read policies", () => {
  it("marks a note's civil end only under reviewed intentExpiry, without affecting task deadlines", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(now));
    const store: RecallCapableStore = { close: async () => {}, recall: async () => hits,
      recallWithOutcome: async () => ({ hits: [hits[2]!, hits[3]!, { ...hits[2]!, record: { ...hits[2]!.record, type: "task" } }], retrievalMode: "hybrid" }) };
    const result = await call({ ...store, intentExpiryEnabled: () => true }, { query: "fictional lesson" });
    const data = result.structuredContent as { hits: Array<{ currentness: string; status: string }> };
    expect(data.hits.map((hit) => hit.currentness)).toEqual(["ended", "current", "current"]);
    expect(data.hits[0]!.status).toBe("open"); // expiry never completes the intention
    const degraded = await call({ ...store, intentExpiryEnabled: () => true,
      recallWithOutcome: async () => ({ hits: [hits[2]!], retrievalMode: "lexical_only", degradation: { code: "embedding_unavailable" } }) }, { query: "fictional lesson" });
    expect((degraded.structuredContent as typeof data).hits[0]!.currentness).toBe("ended");
    const baseline = await call(store, { query: "fictional lesson" });
    expect((baseline.structuredContent as typeof data).hits.map((hit) => hit.currentness)).toEqual(["current", "current", "current"]);
  });
  it("ranks deliberate original/query-local hits only after qualification; automatic lookup and base scores stay unchanged", async () => {
    const candidates: MemoryRecallHit[] = [{ score: 0.8, record: { id: "older", text: "Earlier kiln inspection.", type: "event", createdAt: "2031-01-01T12:00:00.000Z" } },
      { score: 0.79, record: { id: "newer", text: "Recent kiln inspection.", type: "event", createdAt: now } },
      { score: 0.64, record: { id: "weak", text: "Weak kiln mention.", type: "event", createdAt: now } }];
    const store = backend(); store.guidanceForScope = () => []; store.labelsForEntity = () => []; store.labelsForMemories = () => [];
    store.recall = async () => candidates; store.recallWithOutcome = async () => ({ hits: candidates, retrievalMode: "hybrid" });
    store.recencyEnabled = () => true; store.rankDeliberateRecall = (hits) => rankDeliberateRecallHits(hits, [], now);
    const service = new MemoryRetrievalService(store);
    const automatic = await service.load("chat", "Which kiln inspection was discussed?", options);
    expect(automatic?.content).toContain("Earlier kiln inspection"); expect(automatic?.content).toContain("Recent kiln inspection");
    expect((await service.recallForTurn(options.turnId, "Which kiln inspection was discussed?", { trackAccess: false })).map((hit) => hit.record.id)).toEqual(["older", "newer", "weak"]);
    const deliberate = await call(store, { query: "kiln inspection", limit: 1 });
    expect((deliberate.structuredContent as { hits: Array<{ id: string; score: number }> }).hits).toEqual([expect.objectContaining({ id: "newer", score: 0.79 })]);
    const original = await call({ ...store, recallOriginalWithOutcome: async () => ({ available: true, query: "kiln inspection", outcome: { hits: candidates, retrievalMode: "hybrid" } }) }, { useOriginalQuery: true });
    expect((original.structuredContent as { hits: Array<{ id: string }> }).hits.map((hit) => hit.id)).toEqual(["newer", "older", "weak"]);
  });
});
