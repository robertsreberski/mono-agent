import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rankDeliberateRecallHits } from "@mono-agent/memory/bujo";
import type { MemoryDb } from "@mono-agent/memory/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMemoryBackground, formatMemoryProfile } from "../memory-guidance.js";
import { createMemoryRecallServer, type MemoryRecallHit, type RecallCapableStore } from "../memory-recall.js";
import { createSharedMemoryRecallRuntimeExtension, MemoryRetrievalService, type SharedRecallStore } from "../memory-retrieval.js";

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
  it("ignores a dated structured competitor in profile authority and sends no spurious warm replacement", async () => {
    const { dueAt: _dueAt, ...base } = labels[2]!;
    const undated: LabelHit = { ...base, memoryId: "undated-workshop", text: "Owner uses the fictional cedar atelier.",
      label: { v: 1, kind: "fact", entityId: "person:owner", key: "work_location",
        value: { type: "text", text: "Cedar atelier" }, attribution: "user-stated" } };
    const dated: LabelHit = { ...undated, memoryId: "dated-workshop", dueAt: "2032-06-12", text: "Owner plans to use the fictional maple atelier.",
      label: { ...undated.label as Extract<LabelHit["label"], { kind: "fact" }>, value: { type: "text", text: "Maple atelier" } } };
    let rows = [undated];
    const store = backend(); store.guidanceForScope = () => []; store.labelsForEntity = () => rows;
    store.labelsForMemories = () => rows; store.recallWithOutcome = async () => ({ hits: [], retrievalMode: "hybrid" });
    const service = new MemoryRetrievalService(store, { semanticOnly: true, intentExpiry: true, profileEnabled: true });
    expect((await service.load("chat", "Where is the fictional workshop?", options))?.content).toContain(undated.text);
    service.recordInvocation(options.turnId); service.releaseTurn(options.turnId);
    rows = [undated, dated];
    expect(formatMemoryProfile(store, date, Infinity, now, true, false).entries).toEqual([]);
    expect(formatMemoryProfile(store, date, Infinity, now, true, true).entries.map((entry) => entry.id)).toEqual([undated.memoryId]);
    expect(await service.load("chat", "And that workshop?", { ...options, retainedContext: true,
      turnId: "fixture-dated-competitor", hostInstant: `${date}T12:01:00.000Z` })).toBeUndefined();
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
  it("keeps ended coarse fact rows historical and orders current rows first in standalone and shared tools", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
    const rows: LabelHit[] = [
      { ...labels[2]!, memoryId: "ended-fact", text: "Owner awaits a canoe lesson through June 9.", dueAt: "2032-06-09",
        label: { v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" } },
      { ...labels[2]!, memoryId: "offset-fact", text: "Owner awaits a mosaic class through June 10 in UTC+14:00.", dueAt: "2032-06-10T23:59:59.999+14:00",
        label: { v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" } },
      { ...labels[2]!, memoryId: "current-fact", text: "Owner enjoys imaginary mosaic patterns.", dueAt: "2032-06-12", createdAt: "2032-06-01T12:00:00.000Z",
        label: { v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" } },
      { ...labels[2]!, memoryId: "label-history", text: "Owner formerly preferred imaginary square patterns.", dueAt: "2032-06-12", currentAt: false,
        label: { v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" } },
    ];
    const candidates: MemoryRecallHit[] = rows.map((row) => ({ score: 0.9, record: { id: row.memoryId, text: row.text,
      type: "note", status: "open", dueAt: row.dueAt!, createdAt: row.createdAt } }));
    const store = backend(); store.guidanceForScope = () => []; store.labelsForEntity = () => rows; store.labelsForMemories = () => rows;
    store.recall = async () => candidates; store.recallWithOutcome = async () => ({ hits: candidates, retrievalMode: "hybrid" });
    const args = { query: "fictional mosaic lessons", about: "person:owner", kind: "fact" };
    type Data = { hits: Array<{ id: string; currentness: string }>; factSheet: Array<{ text: string; current: boolean }> };
    const standalone = (await call({ ...store, intentExpiryEnabled: () => true }, args)).structuredContent as Data;
    expect(standalone.hits.map((hit) => hit.currentness)).toEqual(["ended", "ended", "current", "current"]);
    expect(standalone.factSheet[0]).toMatchObject({ text: rows[2]!.text, current: true });
    expect(standalone.factSheet.filter((fact) => !fact.current)).toHaveLength(3);
    const off = (await call(store, args)).structuredContent as Data;
    expect(off.factSheet.find((fact) => fact.text === rows[0]!.text)?.current).toBe(true);

    const service = new MemoryRetrievalService(store, { intentExpiry: true });
    // The admitted turn precedes the explicit offset end; the tool's own later
    // observation must be used consistently for both hits and labelled sections.
    await service.load("chat", args.query, { ...options, hostInstant: `${date}T09:00:00.000Z` });
    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: options.turnId });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "fictional-expiry-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const shared = (await client.callTool({ name: "MemoryRecall", arguments: args })).structuredContent as Data;
      expect(shared.factSheet).toEqual(standalone.factSheet); expect(shared.hits).toEqual(standalone.hits);
    } finally { await client.close(); await extension.cleanup(); }
    vi.setSystemTime(new Date(`${date}T09:59:59.999Z`));
    const inclusive = (await call({ ...store, intentExpiryEnabled: () => true }, args)).structuredContent as Data;
    expect(inclusive.factSheet.find((fact) => fact.text === rows[1]!.text)?.current).toBe(true);
    vi.setSystemTime(new Date(`${date}T10:00:00.000Z`));
    const after = (await call({ ...store, intentExpiryEnabled: () => true }, args)).structuredContent as Data;
    expect(after.factSheet.find((fact) => fact.text === rows[1]!.text)?.current).toBe(false);
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
