import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MemoryCompletedTurn, MemoryWriteResult } from "@mono-agent/agent-contracts";
import { createAgentHarness } from "@mono-agent/agent-harness";
import { createBujoMemoryStore } from "@mono-agent/memory/bujo";
import { MemorySearchError } from "@mono-agent/memory/search";
import { openMemoryDb, type MemoryRecord } from "@mono-agent/memory/store";
import { describe, expect, it } from "vitest";

import {
  createSharedMemoryRecallRuntimeExtension,
  MemoryRetrievalService,
  normalizeMemoryRecallQuery,
  type SharedRecallStore,
} from "../memory-retrieval.js";

function fakeStore(options: { readonly fail?: boolean; readonly disputed?: boolean } = {}): SharedRecallStore & { readonly queries: string[]; readonly accesses: string[][] } {
  const queries: string[] = [];
  const accesses: string[][] = [];
  return {
    queries,
    accesses,
    async load() { return undefined; },
    async recall(query) {
      queries.push(query);
      if (options.fail) throw new Error("embedding endpoint offline");
      if (query.includes("unrelated")) {
        return [{ score: 0.05, record: { id: "low", text: "low confidence neighbour" } }];
      }
      if (query.includes("a-team")) {
        // Scope "-team" only matches "A-team" if the leading article is wrongly stripped.
        return [{ score: 1.005, record: { id: "prefix", text: "Mira selected cobalt as the color for -team." } }];
      }
      if (query.includes("velin")) {
        const hits = [
          { score: 1.005, record: { id: "scoped", text: "Mira selected cobalt as the color for the Velin launch." } },
          { score: 0.751, record: { id: "adjacent", text: "Mira's office is in Amsterdam." } },
        ];
        // A contradictory record that score order alone would have hidden.
        if (options.disputed === true) {
          hits.push({ score: 0.7, record: { id: "conflict", text: "Mira selected teal as the color for the Velin launch." } });
        }
        return hits;
      }
      if (query.includes("launch color")) {
        return [
          { score: 1.005, record: { id: "answer", text: "Morgan selected cobalt as the launch color." } },
          { score: 0.751, record: { id: "adjacent", text: "Morgan's office is in Amsterdam." } },
          { score: 0.708, record: { id: "other", text: "The launch date is 2026-08-14." } },
        ];
      }
      return Array.from({ length: 12 }, (_, index) => ({
        score: 0.95 - index * 0.01,
        record: {
          id: `hit-${index}`,
          text: `Morgan selected cobalt-${index} as the deployment color.`,
          type: "task" as const,
          status: index === 0 ? "done" as const : "open" as const,
          isInsight: index === 0,
        },
      }));
    },
    recordAccess(ids) { accesses.push([...ids]); },
    async appendHostSummary(conversationId): Promise<MemoryWriteResult> {
      return { conversationId, source: "fake", bytesWritten: 0 };
    },
    async close() {},
  };
}

describe("MemoryRetrievalService", () => {
  it("forwards chronological browse only when the local store affirms the capability", async () => {
    const absent = new MemoryRetrievalService(fakeStore());
    expect(absent.supportsJournalBrowse()).toBe(false);

    let journalSupported = true;
    const store = Object.assign(fakeStore(), {
      tier: () => "journal" as const,
      supportsJournalBrowse: () => journalSupported,
      browseJournal: async () => ({
        records: [],
        rangeScanComplete: true,
        truncatedBy: [],
        nonJournalProvenanceExcluded: false,
      }),
    });
    const service = new MemoryRetrievalService(store);
    expect(service.supportsJournalBrowse()).toBe(true);
    expect(service.tier()).toBe("journal");
    await expect(service.browseJournal({
      fromInclusive: "2026-09-01T00:00:00.000Z",
      toExclusive: "2026-09-02T00:00:00.000Z",
      maxEntries: 10,
      maxBytes: 1_000,
    })).resolves.toMatchObject({ records: [], rangeScanComplete: true });

    journalSupported = false;
    expect(service.supportsJournalBrowse()).toBe(false);
    await expect(service.browseJournal({
      fromInclusive: "2026-09-01T00:00:00.000Z",
      toExclusive: "2026-09-02T00:00:00.000Z",
      maxEntries: 10,
      maxBytes: 1_000,
    })).rejects.toThrow(/no chronological journal surface/iu);
  });

  it("exposes and delegates strong completed-turn admission only when the backend supports it", async () => {
    const admissions: MemoryCompletedTurn[] = [];
    const store = fakeStore();
    store.persistCompletedTurn = async (turn) => {
      admissions.push(turn);
      return {
        id: "stable-store-id",
        runId: turn.runId,
        conversationId: turn.conversationId,
        source: "fake",
        bytesWritten: Buffer.byteLength(turn.summary, "utf8"),
        admissionStatus: "admitted",
      };
    };
    const service = new MemoryRetrievalService(store);
    const turn = {
      runId: "run-strong",
      conversationId: "conversation",
      summary: "Host-observed completed turn.",
    };

    await expect(service.persistCompletedTurn?.(turn)).resolves.toMatchObject({
      id: "stable-store-id",
      runId: "run-strong",
      admissionStatus: "admitted",
    });
    expect(admissions).toEqual([turn]);

    const legacyService = new MemoryRetrievalService(fakeStore());
    expect(legacyService.persistCompletedTurn).toBeUndefined();
  });

  it("shares one normalized backend lookup between automatic and tool recall in a turn", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);

    const block = await service.load("conversation", "  What deployment color\ndid Morgan select?  ", { turnId: "turn-1" });
    const hits = await service.recallForTurn("turn-1", "what deployment color did morgan select?", { topK: 8 });
    await service.recallForTurn("turn-1", "different query", { topK: 8 });

    expect(block).toBeDefined();
    expect(block?.content.match(/deployment color/gu)).toHaveLength(5);
    expect(block?.content).toContain("- [x] Morgan selected cobalt-0 as the deployment color. *");
    expect(Buffer.byteLength(block?.content ?? "", "utf8")).toBeLessThanOrEqual(8_000);
    expect(hits).toHaveLength(8);
    expect(store.queries).toEqual(["what deployment color did morgan select?", "different query"]);
    expect(store.accesses.flat()).toEqual([
      "hit-0", "hit-1", "hit-2", "hit-3", "hit-4", "hit-5", "hit-6", "hit-7",
    ]);
  });

  it("renders first-party report evidence verbatim and shares its turn-scoped lookup with explicit recall", async () => {
    const store = fakeStore();
    store.recall = async (query) => {
      store.queries.push(query);
      return [{
        score: 0.99,
        record: {
          id: "attributed-port",
          text: "Avery reports that their service port is 8443.",
          type: "note" as const,
          status: "open" as const,
          isInsight: false,
        },
      }];
    };
    const service = new MemoryRetrievalService(store);
    const query = "What is Avery's service port?";

    const block = await service.load("private:conversation-a", query, { turnId: "turn-attributed" });
    const hits = await service.recallForTurn("turn-attributed", query.toLowerCase());

    expect(block?.content).toContain("Avery reports that their service port is 8443.");
    expect(block?.content).not.toContain("Avery's service port is 8443.");
    expect(hits.map((hit) => hit.record.text)).toEqual(["Avery reports that their service port is 8443."]);
    expect(store.queries).toEqual([query.toLowerCase()]);
    expect(store.accesses).toEqual([["attributed-port"]]);
  });

  it("abstains from automatic injection below the confidence floor", async () => {
    const service = new MemoryRetrievalService(fakeStore());
    await expect(service.load("conversation", "unrelated topic", { turnId: "turn-2" })).resolves.toBeUndefined();
  });

  it("bypasses automatic durable lookup for the exact last-message question but keeps qualified history searchable", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);

    await expect(service.load(
      "telegram:123",
      "What did you send in the last message?",
      { turnId: "turn-current-history" },
    )).resolves.toBeUndefined();
    expect(store.queries).toEqual([]);

    await service.load(
      "telegram:123",
      "What did Alice send in her last message?",
      { turnId: "turn-current-history" },
    );
    expect(store.queries).toEqual(["what did alice send in her last message?"]);
  });

  it("drops high-similarity adjacent results outside the top-relative confidence band", async () => {
    const service = new MemoryRetrievalService(fakeStore());
    const block = await service.load("conversation", "What launch color did Morgan select?", { turnId: "turn-calibrated" });
    expect(block?.content).toContain("selected cobalt as the launch color");
    expect(block?.content).not.toContain("office");
  });

  it("injects a scope-qualified choice answer and reuses the same backend lookup for the tool", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);
    const query = "What color did Mira select for the Velin launch?";

    const block = await service.load("conversation", query, { turnId: "turn-velin" });
    const hits = await service.recallForTurn("turn-velin", "what color did mira select for the velin launch?", { topK: 8 });

    expect(block?.content).toContain("Mira selected cobalt as the color for the Velin launch.");
    expect(block?.content).not.toContain("Amsterdam");
    expect(hits).toHaveLength(2);
    expect(store.queries).toEqual(["what color did mira select for the velin launch?"]);
  });

  it("abstains when the stored scope only shares an article-like prefix with the asked one", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);

    // The record's scope is "-team", not the asked "A-team".
    await expect(service.load(
      "conversation",
      "What color did Mira select for A-team?",
      { turnId: "turn-a-team" },
    )).resolves.toBeUndefined();
    expect(store.accesses.flat()).toEqual([]);
  });

  it("abstains from automatic injection when a disputed scoped choice is in reach, leaving the tool usable", async () => {
    const store = fakeStore({ disputed: true });
    const service = new MemoryRetrievalService(store);
    const query = "What color did Mira select for the Velin launch?";

    await expect(service.load("conversation", query, { turnId: "turn-disputed" })).resolves.toBeUndefined();
    // Abstaining automatically must not mark any record as served.
    expect(store.accesses.flat()).toEqual([]);

    // The explicit tool still sees the records and can present both to the model.
    const hits = await service.recallForTurn("turn-disputed", "what color did mira select for the velin launch?", { topK: 8 });
    expect(hits.map((hit) => hit.record.id)).toContain("conflict");
    // Still one shared backend lookup; abstention paid for no extra retrieval.
    expect(store.queries).toEqual(["what color did mira select for the velin launch?"]);
  });

  it("injects a scheduled fact, but a late conflict blocks automatic context while explicit recall stays raw", async () => {
    const query = "When is the Project Atlas production migration scheduled?";
    const target = {
      score: 0.99,
      record: {
        id: "atlas-schedule",
        text: "Project Atlas production migration is scheduled for 20 November 2026 at 08:30 Europe/Paris.",
      },
    };
    const distractors = [
      { score: 0.98, record: { id: "owner", text: "Priya owns the Project Atlas database cutover." } },
      { score: 0.97, record: { id: "downtime", text: "The approved downtime budget for Project Atlas is 30 minutes." } },
      { score: 0.96, record: { id: "other-project", text: "Project Boreal production migration is scheduled for 20 November 2026 at 08:30 Europe/Paris." } },
    ];

    const cleanStore = fakeStore();
    cleanStore.recall = async (backendQuery) => {
      cleanStore.queries.push(backendQuery);
      return [target, ...distractors];
    };
    const cleanService = new MemoryRetrievalService(cleanStore);
    const block = await cleanService.load("conversation", query, { turnId: "turn-scheduled" });
    expect(block?.content).toContain(target.record.text);
    expect(block?.content).not.toContain("owns");
    expect(block?.content).not.toContain("downtime");
    expect(block?.content).not.toContain("Boreal");

    const conflict = {
      score: 0.1,
      record: {
        id: "atlas-late-conflict",
        text: "Project Atlas production migration is scheduled for 21 November 2026 at 08:30 Europe/Paris.",
      },
    };
    const lateFillers = Array.from({ length: 48 }, (_, index) => ({
      score: 0.95 - index * 0.01,
      record: { id: `adjacent-${index}`, text: `Unrelated archive record ${index}.` },
    }));
    const disputedStore = fakeStore();
    disputedStore.recall = async (backendQuery) => {
      disputedStore.queries.push(backendQuery);
      return [target, ...lateFillers, conflict];
    };
    const disputedService = new MemoryRetrievalService(disputedStore);

    await expect(disputedService.load("conversation", query, { turnId: "turn-scheduled-conflict" }))
      .resolves.toBeUndefined();
    const explicitHits = await disputedService.recallForTurn(
      "turn-scheduled-conflict",
      query,
      { topK: 50, trackAccess: false },
    );
    expect(explicitHits).toHaveLength(50);
    expect(explicitHits.map((hit) => hit.record.id)).toContain("atlas-schedule");
    expect(explicitHits.map((hit) => hit.record.id)).toContain("atlas-late-conflict");
    expect(disputedStore.queries).toEqual([query.toLowerCase()]);
    expect(disputedStore.accesses).toEqual([]);
  });

  it("normalizes Unicode, case, and whitespace deterministically", () => {
    expect(normalizeMemoryRecallQuery("  ＤEPLOY\n\tPipeline  ")).toBe("deploy pipeline");
  });

  it("preserves capitalized query-local entity evidence for graph expansion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-graph-evidence-"));
    const db = openMemoryDb({ path: join(dir, "memory.db") });
    const record = (id: string, text: string): MemoryRecord => ({
      id,
      type: "note",
      status: "open",
      text,
      salience: 0.5,
      isInsight: false,
      createdAt: "2026-07-11T00:00:00.000Z",
      accessCount: 0,
      tags: [],
      source: {},
    });
    const seed = record("seed-morgan", "Morgan anchors this memory.");
    const target = record("target-taylor", "Taylor uses cobalt.");
    try {
      await db.upsertMany([seed, target]);
      for (const [id, name] of [["person:morgan", "Morgan"], ["person:taylor", "Taylor"], ["person:jordan", "Jordan"]] as const) {
        db.upsertEntity({ id, name, type: "person", createdAt: "2026-07-11T00:00:00.000Z" });
      }
      db.addEntityRelation("person:morgan", "person:taylor", "mentors", "2026-07-11T00:00:00.000Z");
      db.associateMemory({ memoryId: seed.id, entityId: "person:morgan", provenance: "capture", createdAt: seed.createdAt });
      db.associateMemory({ memoryId: target.id, entityId: "person:taylor", provenance: "capture", createdAt: target.createdAt });

      const direct = [{ score: 1, record: seed }];
      const expansionQueries: string[] = [];
      const store = fakeStore();
      store.recall = async (query) => {
        store.queries.push(query);
        return direct;
      };
      store.supportsGraphExpansion = () => true;
      store.expandGraph = (query, hits, options) => {
        expansionQueries.push(query);
        const additions = db.expandEntityRelations(hits.map((hit) => hit.record.id), {
          query,
          maxAdditions: 5,
        });
        return [...hits, ...additions.map((item) => ({ score: 0.9, record: item }))]
          .slice(0, options?.topK ?? 8);
      };
      const query = "Does Morgan mentor Jordan or Taylor?";
      expect((await store.expandGraph(query.toLowerCase(), direct, { topK: 8 })).map((hit) => hit.record.id))
        .toContain(target.id);

      const service = new MemoryRetrievalService(store);
      const hits = await service.recallForTurn("turn-capitalized-graph", query, { topK: 8, expandHops: 1 });
      expect(hits.map((hit) => hit.record.id)).toEqual([seed.id]);
      expect(store.queries).toEqual([query.toLowerCase()]);
      expect(expansionQueries.at(-1)).toBe(query);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects degraded blocks below the minimum meaningful budget without recording unserved hits", async () => {
    const degradedStore = () => {
      const store = fakeStore();
      store.recallWithOutcome = async (query) => {
        store.queries.push(query);
        return {
          hits: [
            { score: 1.005, record: { id: "first", text: "Morgan selected cobalt as the deployment color." } },
            { score: 1.005, record: { id: "second", text: "Morgan selected azure as the deployment color." } },
          ],
          retrievalMode: "lexical_only" as const,
          degradation: { code: "embedding_unavailable" as const },
        };
      };
      return store;
    };
    const minimumBlock = "## Memory degraded: lexical-only\n\n- Morgan selected cobalt as the deployment color.";
    const minimumBytes = Buffer.byteLength(minimumBlock, "utf8");

    const tinyStore = degradedStore();
    const tiny = new MemoryRetrievalService(tinyStore, { maxBytes: 1 });
    await expect(tiny.load("conversation", "What deployment color did Morgan select?", { turnId: "turn-one-byte" })).rejects.toThrow(
      "Semantic memory retrieval is unavailable; the memory byte budget cannot include lexical-only evidence.",
    );
    expect(tinyStore.accesses).toEqual([]);

    const belowStore = degradedStore();
    const below = new MemoryRetrievalService(belowStore, { maxBytes: minimumBytes - 1 });
    await expect(below.load("conversation", "What deployment color did Morgan select?", { turnId: "turn-below-minimum" })).rejects.toThrow(
      "Semantic memory retrieval is unavailable; the memory byte budget cannot include lexical-only evidence.",
    );
    expect(belowStore.accesses).toEqual([]);

    const boundaryStore = degradedStore();
    const boundary = new MemoryRetrievalService(boundaryStore, { maxBytes: minimumBytes });
    await expect(boundary.load("conversation", "What deployment color did Morgan select?", { turnId: "turn-minimum" })).resolves.toEqual({
      kind: "markdown",
      content: minimumBlock,
      source: "memory",
      truncated: true,
    });
    expect(boundaryStore.accesses).toEqual([["first", "second"]]);
  });

  it("drops the query cache when the logical turn is released", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);
    await service.load("conversation", "deploy pipeline", { turnId: "turn-release" });
    service.releaseTurn("turn-release");
    await service.recallForTurn("turn-release", "deploy pipeline");
    expect(store.queries).toEqual(["deploy pipeline", "deploy pipeline"]);
  });
});

describe("shared MemoryRecall MCP", () => {
  it("shares one degraded lookup across automatic and explicit recall while preserving status through graph expansion", async () => {
    const store = fakeStore();
    let outcomeCalls = 0;
    let expansionCalls = 0;
    store.recallWithOutcome = async (query) => {
      outcomeCalls += 1;
      store.queries.push(query);
      return {
        hits: [{ score: 1.005, record: { id: "answer", text: "Morgan selected cobalt as the launch color." } }],
        retrievalMode: "lexical_only",
        degradation: { code: "embedding_unavailable" },
      };
    };
    store.expandGraph = (_query, direct) => {
      expansionCalls += 1;
      return direct;
    };
    const service = new MemoryRetrievalService(store, { maxBytes: 120 });
    const query = "What launch color did Morgan select?";
    await expect(service.recallForTurn("turn-degraded", query)).rejects.toThrow(
      "Memory recall is degraded; use status-bearing recall to inspect lexical-only results.",
    );
    expect(store.accesses).toEqual([]);
    await expect(service.recallOutcomeForTurn("turn-degraded", query, { trackAccess: false })).resolves.toMatchObject({
      retrievalMode: "lexical_only",
      degradation: { code: "embedding_unavailable" },
      hits: [expect.objectContaining({ record: expect.objectContaining({ id: "answer" }) })],
    });
    expect(store.accesses).toEqual([]);

    const block = await service.load("conversation", query, { turnId: "turn-degraded" });
    expect(block?.content).toContain("## Memory (recalled; lexical-only — semantic retrieval unavailable)");
    expect(block?.content).toContain("Morgan selected cobalt");
    expect(Buffer.byteLength(block?.content ?? "", "utf8")).toBeLessThanOrEqual(120);

    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-degraded" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({ name: "MemoryRecall", arguments: { query, limit: 5 } });
      expect(result.structuredContent).toMatchObject({
        degraded: true,
        retrievalMode: "lexical_only",
        degradation: { code: "embedding_unavailable" },
        hits: [expect.objectContaining({ id: "answer" })],
      });
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("showing lexical-only matches") }),
      ]));
      expect(outcomeCalls).toBe(1);
      expect(expansionCalls).toBe(1);
      expect(store.accesses).toEqual([["answer"]]);
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup();
    }
  });

  it("keeps zero-hit degradation visible and redacts a recognized provider error across outcome and MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "mono-agent-memory-redaction-"));
    const privateDetail = "PRIVATE_PROVIDER_SENTINEL_do_not_surface";
    let providerCalls = 0;
    const store = createBujoMemoryStore({
      root,
      tier: "journal",
      dim: 4,
      embeddings: {
        id: "recognized-error-redaction:4",
        async embed() {
          providerCalls += 1;
          throw new MemorySearchError("embedding_request_failed", privateDetail, {
            providerDetail: privateDetail,
          });
        },
      },
    });
    const service = new MemoryRetrievalService(store);
    const query = "What launch color did Morgan select?";
    await expect(service.load("conversation", query, { turnId: "turn-degraded-empty" })).rejects.toThrow(
      "Semantic memory retrieval is unavailable; lexical-only recall found no eligible automatic evidence.",
    );
    const outcome = await service.recallOutcomeForTurn("turn-degraded-empty", query, { trackAccess: false });
    expect(outcome).toMatchObject({
      hits: [],
      retrievalMode: "lexical_only",
      degradation: { code: "embedding_unavailable" },
    });
    expect(JSON.stringify(outcome)).not.toContain(privateDetail);

    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-degraded-empty" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({ name: "MemoryRecall", arguments: { query } });
      expect(result.structuredContent).toMatchObject({
        hits: [],
        degraded: true,
        retrievalMode: "lexical_only",
        degradation: { code: "embedding_unavailable" },
      });
      expect(JSON.stringify(result)).not.toContain(privateDetail);
      expect(providerCalls).toBe(1);
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not query the configured backend for the exact Telegram last-message question", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);
    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-last-message" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({
        name: "MemoryRecall",
        arguments: { query: "What did you send in the last message?" },
      });
      expect(result.structuredContent).toMatchObject({ hits: [], conversationRelative: true });
      expect(store.queries).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup();
    }
  });

  it("accepts a second client initialize on the same per-run endpoint (model failover)", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);
    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-failover" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const first = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await first.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    } finally {
      await first.close().catch(() => undefined);
    }
    // A failover attempt builds a fresh client and re-sends `initialize` to the
    // same still-open per-run endpoint; it must be accepted, not rejected with
    // "Server already initialized".
    const second = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await second.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await second.callTool({
        name: "MemoryRecall",
        arguments: { query: "deploy pipeline" },
      });
      expect(result.isError).not.toBe(true);
      expect(store.queries).toContain("deploy pipeline");
    } finally {
      await second.close().catch(() => undefined);
      await extension.cleanup();
    }
  });

  it("keeps graph expansion explicit-only while reusing one raw backend lookup", async () => {
    const store = fakeStore();
    let expansionCalls = 0;
    store.recall = async (query) => {
      store.queries.push(query);
      return [
        { score: 1, record: { id: "seed", text: "Taylor joined the Atlas project." } },
        ...Array.from({ length: 8 }, (_, index) => ({
          score: 0.9 - index * 0.01,
          record: { id: `distractor-${index}`, text: `Unrelated planning note ${index}.` },
        })),
        { score: 0.1, record: { id: "graph-target", text: "Morgan manages Taylor and uses cobalt." } },
      ];
    };
    store.expandGraph = (_query, direct, options) => {
      expansionCalls += 1;
      const target = direct.find((hit) => hit.record.id === "graph-target");
      return target === undefined
        ? direct.slice(0, options?.topK ?? 8)
        : [target, ...direct.filter((hit) => hit.record.id !== target.record.id)].slice(0, options?.topK ?? 8);
    };
    const service = new MemoryRetrievalService(store);
    const query = "Who manages Taylor?";
    await expect(service.load("conversation", query, { turnId: "turn-graph" })).resolves.toBeUndefined();

    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-graph" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({ name: "MemoryRecall", arguments: { query, limit: 5 } });
      expect(result.structuredContent).toMatchObject({
        hits: expect.arrayContaining([expect.objectContaining({ id: "graph-target" })]),
      });
      const servedIds = (result.structuredContent as { hits: Array<{ id: string }> }).hits.map((hit) => hit.id);
      expect(store.queries).toEqual(["who manages taylor?"]);
      expect(expansionCalls).toBe(1);
      expect(store.accesses).toEqual([servedIds]);
      expect(servedIds).not.toContain("distractor-7");
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup();
    }
  });

  it("serves the shared store over a per-turn loopback endpoint", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);
    await service.load("conversation", "deploy pipeline", { turnId: "turn-http" });
    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-http" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["MemoryRecall"]);
      const result = await client.callTool({ name: "MemoryRecall", arguments: { query: " DEPLOY pipeline ", limit: 8 } });
      expect(result.structuredContent).toMatchObject({ hits: expect.any(Array) });
      expect(store.queries).toEqual(["deploy pipeline"]);
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup();
    }
  });

  it("reports backend failure as an honest degraded tool result", async () => {
    const service = new MemoryRetrievalService(fakeStore({ fail: true }));
    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-fail" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({ name: "MemoryRecall", arguments: { query: "deploy" } });
      expect(result.structuredContent).toMatchObject({ hits: [], degraded: true });
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("temporarily unavailable") }),
      ]));
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup();
    }
  });

  it("omits the tool and reports degradation when its loopback endpoint cannot start", async () => {
    const warnings: unknown[] = [];
    const service = new MemoryRetrievalService(fakeStore());
    const extension = await createSharedMemoryRecallRuntimeExtension(service, {
      listen: async () => { throw new Error("loopback unavailable"); },
      onUnavailable: (error) => { warnings.push(error); },
    })({ runId: "turn-startup-fail" });

    expect(extension.runtimeOptions.mcpServers).toEqual({});
    expect(warnings).toEqual([expect.objectContaining({ message: "loopback unavailable" })]);
    await expect(extension.cleanup()).resolves.toBeUndefined();
  });

  it("continues the provider turn when the loopback endpoint cannot start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-retrieval-"));
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const warnings: unknown[] = [];
    const seenMcpServers: unknown[] = [];
    try {
      const service = new MemoryRetrievalService(fakeStore());
      const harness = createAgentHarness({
        identityPath,
        model: {
          provider: "openai-codex",
          model: "gpt-5.5",
          reference: "openai-codex:gpt-5.5",
        },
        runtime: {
          async run(_prompt, options) {
            seenMcpServers.push(options.mcpServers);
            return { text: "provider still ran" };
          },
        },
        runtimeOptionsForRequest: createSharedMemoryRecallRuntimeExtension(service, {
          listen: async () => { throw new Error("loopback unavailable"); },
          onUnavailable: (error) => { warnings.push(error); },
        }),
      });

      const response = await harness.run({
        conversationId: "turn-startup-degraded",
        userMessage: "hello",
        abortSignal: new AbortController().signal,
      });
      expect(response.text).toBe("provider still ran");
      expect(response.failure).toBeUndefined();
      expect(seenMcpServers).toEqual([{}]);
      expect(warnings).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("continues the provider turn and warns when a tiny budget cannot carry degraded evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-retrieval-degraded-"));
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const store = fakeStore();
    store.recallWithOutcome = async (query) => {
      store.queries.push(query);
      return {
        hits: [{ score: 1, record: { id: "tiny-budget-hit", text: "Morgan selected cobalt as the launch color." } }],
        retrievalMode: "lexical_only",
        degradation: { code: "embedding_unavailable" },
      };
    };
    const events: Array<Record<string, unknown>> = [];
    try {
      const service = new MemoryRetrievalService(store, { maxBytes: 1 });
      const harness = createAgentHarness({
        identityPath,
        model: {
          provider: "openai-codex",
          model: "gpt-5.5",
          reference: "openai-codex:gpt-5.5",
        },
        runtime: {
          async run() { return { text: "provider still ran" }; },
        },
        memory: service,
      });

      const response = await harness.run({
        conversationId: "turn-degraded-empty",
        userMessage: "What launch color did Morgan select?",
        abortSignal: new AbortController().signal,
        onEvent: (event) => events.push(event as Record<string, unknown>),
      });

      expect(response.text).toBe("provider still ran");
      expect(response.failure).toBeUndefined();
      expect(events).toContainEqual(expect.objectContaining({
        type: "runtime_warning",
        warning_kind: "memory_degraded",
      }));
      expect(store.accesses).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("releases the shared turn cache before admitting another run after an abort-ignoring provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-retrieval-abort-"));
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const releases: Array<() => void> = [];
    let runtimeCalls = 0;
    try {
      const service = new MemoryRetrievalService(fakeStore());
      const activeTurnCount = (): number => (service as unknown as { turns: Map<string, unknown> }).turns.size;
      const harness = createAgentHarness({
        identityPath,
        model: {
          provider: "openai-codex",
          model: "gpt-5.5",
          reference: "openai-codex:gpt-5.5",
        },
        runtime: {
          async run() {
            runtimeCalls += 1;
            await new Promise<void>((resolve) => { releases.push(resolve); });
            return { text: "late provider answer" };
          },
        },
        memory: service,
        concurrency: { maxConcurrentRuns: 1 },
        runtimeOptionsForRequest: createSharedMemoryRecallRuntimeExtension(service),
      });

      const zombies: Array<Promise<unknown>> = [];
      for (let index = 0; index < 3; index += 1) {
        const abort = new AbortController();
        zombies.push(harness.run({
          conversationId: `zombie-${index}`,
          userMessage: "deploy pipeline",
          abortSignal: abort.signal,
        }));
        for (let attempt = 0; attempt < 40 && runtimeCalls <= index; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(runtimeCalls).toBe(index + 1);
        expect(activeTurnCount()).toBe(1);
        abort.abort(new Error("cancelled"));
        for (let attempt = 0; attempt < 40 && activeTurnCount() !== 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(activeTurnCount()).toBe(0);
      }

      for (const release of releases) release();
      await expect(Promise.all(zombies)).resolves.toEqual(
        Array.from({ length: 3 }, () => expect.objectContaining({
          failure: expect.objectContaining({ kind: "cancelled" }),
        })),
      );
      expect(activeTurnCount()).toBe(0);
    } finally {
      for (const release of releases) release();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("MemoryRetrievalService.remember cache coherence", () => {
  it("drops the per-turn recall cache so a stored fact is visible in the same run", async () => {
    // Recall memoizes per turn. Without invalidation a query answered before the
    // write keeps returning its stale empty result, contradicting the
    // immediate-recall guarantee the Remember tool reports.
    const hits: { readonly score: number; readonly record: { id: string; text: string } }[] = [];
    const store = {
      async load() { return undefined; },
      async appendHostSummary() { return { conversationId: "c", source: "s", bytesWritten: 0 }; },
      async recall() { return [...hits]; },
      supportsRemember: () => true,
      async remember(_conversationId: string, text: string) {
        hits.push({ score: 1, record: { id: "RM-1", text } });
        return { id: "RM-1", source: "daily/x.md", text, duplicate: false };
      },
      async close() {},
    };
    const service = new MemoryRetrievalService(store as never, {});

    expect(await service.recallForTurn("turn-1", "squash merges")).toHaveLength(0);
    await service.remember("conv-1", "Robert prefers squash merges.");
    const after = await service.recallForTurn("turn-1", "squash merges");

    expect(after.map((hit) => hit.record.text)).toContain("Robert prefers squash merges.");
  });

  it("keeps the cache when the fact was already stored", async () => {
    // A duplicate changes nothing durable, so dropping every turn cache would
    // make concurrent turns repeat identical backend searches.
    let recallCalls = 0;
    const store = {
      async load() { return undefined; },
      async appendHostSummary() { return { conversationId: "c", source: "s", bytesWritten: 0 }; },
      async recall() { recallCalls += 1; return []; },
      supportsRemember: () => true,
      async remember(_conversationId: string, text: string) {
        return { id: "RM-1", source: "daily/x.md", text, duplicate: true };
      },
      async close() {},
    };
    const service = new MemoryRetrievalService(store as never, {});

    await service.recallForTurn("turn-1", "squash merges");
    expect(recallCalls).toBe(1);
    await service.remember("conv-1", "Robert prefers squash merges.");
    await service.recallForTurn("turn-1", "squash merges");

    expect(recallCalls).toBe(1);
  });
});
