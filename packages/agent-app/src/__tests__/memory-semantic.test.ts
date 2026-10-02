import { describe, expect, it } from "vitest";
import type { MemoryDb } from "@mono-agent/memory/store";
import { formatMemoryBackground, formatMemoryProfile } from "../memory-guidance.js";
import { MemoryRetrievalService, type SharedRecallStore } from "../memory-retrieval.js";

type LabelHit = ReturnType<MemoryDb["labelsForEntity"]>[number];
const date = "2031-05-17";
const labels: LabelHit[] = [
  { memoryId: "event", ordinal: 0, label: { v: 1, kind: "preference", scope: "agent", attribution: "user-stated" },
    text: "An inspection was completed.", type: "event", status: "open", active: true, conflict: false, createdAt: `${date}T09:00:00.000Z` },
  { memoryId: "unknown", ordinal: 0, label: { v: 1, kind: "preference", scope: "agent", attribution: "unknown" },
    text: "Use unconfirmed advice.", type: "note", status: "open", active: true, conflict: false, createdAt: `${date}T09:00:00.000Z` },
  { memoryId: "known", ordinal: 0, label: { v: 1, kind: "preference", scope: "agent", attribution: "user-stated" },
    text: "Use numbered repair instructions.", type: "note", status: "open", active: true, conflict: false, createdAt: `${date}T09:00:00.000Z` },
];
const hits = [...labels.map((label) => ({ score: 0.9, record: { id: label.memoryId, text: label.text,
  type: label.type!, status: "open" as const, createdAt: label.createdAt } })),
  { score: 0.89, record: { id: "unlabelled", text: "An unlabelled legacy line.", type: "note" as const, status: "open" as const, createdAt: `${date}T09:00:00.000Z` } }];
function store(tier: "bujo" | "journal" | "lite" = "bujo"): SharedRecallStore {
  return { load: async () => undefined, close: async () => {}, tier: () => tier,
    recall: async () => hits, recallWithOutcome: async () => ({ hits, retrievalMode: "hybrid" }),
    labelsForMemories: () => labels, labelsForEntity: () => [], guidanceForScope: (scope) => scope === "agent" ? labels : [],
  };
}
const options = { ownerTurn: true as const, hostLocalDate: date, hostDate: date, hostInstant: `${date}T12:00:00.000Z`, turnId: "fictional-turn" };

describe("semantic-only automatic app memory", () => {
  it("applies note/label eligibility to similarity, guidance and the optional profile; deliberate recall is unchanged", async () => {
    for (const profileEnabled of [false, true]) {
      const service = new MemoryRetrievalService(store(), { semanticOnly: true, profileEnabled });
      const block = await service.load("fictional-chat", "How should repair instructions be presented?", options);
      expect(block?.content).toContain("Use numbered repair instructions.");
      expect(block?.content).not.toMatch(/inspection|unconfirmed|unlabelled/u);
      expect(block?.traceContent).toBe(false);
      expect((await service.recallForTurn("fictional-turn", "How should repair instructions be presented?")).map((hit) => hit.record.id))
        .toEqual(["event", "unknown", "known", "unlabelled"]);
    }
  });

  it("keeps BuJo flags-off and Lite/Journal automatic output byte-identical", async () => {
    for (const tier of ["bujo", "lite", "journal"] as const) {
      const legacy = await new MemoryRetrievalService(store(tier)).load("chat", "A sufficiently long fictional query", options);
      const off = await new MemoryRetrievalService(store(tier), { semanticOnly: false }).load("chat", "A sufficiently long fictional query", options);
      expect(off).toEqual(legacy);
      if (tier !== "bujo") {
        const ignored = await new MemoryRetrievalService(store(tier), { semanticOnly: true }).load("chat", "A sufficiently long fictional query", options);
        expect(ignored).toEqual(legacy);
      }
    }
  });

  it("filters labelled background even when similarity is suppressed for a short turn", async () => {
    const service = new MemoryRetrievalService(store(), { semanticOnly: true });
    const block = await service.load("chat", "Repair?", options);
    expect(block?.content).toContain("Working preferences"); expect(block?.content).toContain("Use numbered");
    expect(block?.content).not.toMatch(/inspection|unconfirmed/u);
  });

  it("fails closed on missing/unavailable semantic labels and warns with stable codes only", async () => {
    const backend = store(); backend.labelsForMemories = () => { throw new Error("fictional backend detail"); };
    backend.guidanceForScope = () => { throw new Error("fictional background detail"); };
    const warnings: string[] = [];
    const service = new MemoryRetrievalService(backend, { semanticOnly: true });
    expect(await service.load("chat", "A sufficiently long fictional query", { ...options, onWarning: (code) => { warnings.push(code); } })).toBeUndefined();
    expect(warnings).toEqual(["memory_recall_unavailable"]);
  });

  it("checks other labels on a preference source before rendering guidance or profile", () => {
    const preference = { ...labels[2]!, memoryId: "shared" };
    const facts: LabelHit[] = ["Avery", "Morgan"].map((value, index) => ({ ...preference, memoryId: index === 0 ? "shared" : "peer",
      label: { v: 1, kind: "fact", entityId: "person:avery", key: "preferred_name", value: { type: "text", text: value }, attribution: "user-stated" } }));
    const backend = store(); backend.guidanceForScope = () => [preference];
    backend.labelsForMemories = () => [preference, facts[0]!];
    backend.labelsForEntity = (entity) => entity === "person:avery" ? facts : [];
    expect(formatMemoryProfile(backend, date, Infinity, options.hostInstant, true).content).toBe("");
    const candidates = [{ score: 0.9, record: { id: "shared", text: preference.text } }];
    expect(formatMemoryBackground(backend, "fictional query", "chat", options, candidates, 1024, new Set(), true)).toBeUndefined();
  });

  it("omits representable equal-authority contradictions from cards, profile and similarity without withdrawing source labels", async () => {
    const conflict: LabelHit[] = ["Avery", "Morgan"].map((value, index) => ({ memoryId: `conflict-${index}`, ordinal: 0,
      label: { v: 1, kind: "fact", entityId: "person:owner", key: "preferred_name", value: { type: "text", text: value }, attribution: "user-stated" },
      text: `Owner prefers the name ${value}.`, type: "note", status: "open", active: true, currentAt: true, conflict: true, createdAt: `${date}T09:00:00.000Z` }));
    const backend = store(); backend.labelsForEntity = () => conflict; backend.guidanceForScope = () => [];
    backend.labelsForMemories = () => conflict;
    const candidates = conflict.map((label) => ({ score: 0.9, record: { id: label.memoryId, text: label.text, type: "note" as const, status: "open" as const } }));
    backend.recallWithOutcome = async () => ({ retrievalMode: "hybrid", hits: candidates });
    expect(formatMemoryProfile(backend, date, Infinity, options.hostInstant, true).content).toBe("");
    expect(formatMemoryBackground(backend, "person:owner", "chat", options, candidates, 1024, new Set(), true)).toBeUndefined();
    const service = new MemoryRetrievalService(backend, { semanticOnly: true, profileEnabled: true });
    expect(await service.load("chat", "What name should the owner use?", options)).toBeUndefined();
    expect(backend.labelsForEntity("person:owner")).toEqual(conflict);
  });
});
