import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  appendGraphBatch,
  createBujoMemoryStore,
  resolveActiveMemoryDbPath,
  safeRebuildMemoryIndex,
} from "@mono-agent/memory/bujo";
import type { BujoMemoryStore } from "@mono-agent/memory/bujo";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { EmbeddingProvider } from "@mono-agent/memory/search";
import { openMemoryDb } from "@mono-agent/memory/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MEMORY_RECALL_MCP_SERVER_NAME,
  createMemoryEmbeddingProvider,
  createMemoryRecallServer,
  createRecallStore,
  rankExplicitHits,
  resolveMemoryRecallSettings,
} from "../memory-recall.js";
import type { MemoryRecallBujoSettings, MemoryRecallSettings } from "../memory-recall.js";
import { readLabelSections } from "../memory-label-sections.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-memory-recall-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/** Build a MonoAgentConfig whose only meaningful field for recall is the memory block. */
function configWithMemory(memory: MonoAgentConfig["memory"]): MonoAgentConfig {
  return { memory } as unknown as MonoAgentConfig;
}

/** Narrow recall settings to the configured local shape. */
function bujo(settings: MemoryRecallSettings | undefined): MemoryRecallBujoSettings {
  if (settings === undefined) {
    throw new Error("expected bujo recall settings");
  }
  return settings;
}

describe("resolveMemoryRecallSettings", () => {
  it("returns undefined when memory is unconfigured", () => {
    expect(resolveMemoryRecallSettings(configWithMemory(undefined))).toBeUndefined();
  });

  it("bypasses only the live tool gate for previews and preserves built-in secret precedence", () => {
    const memory = {
      mode: "journal",
      path: "/memory",
      maxBytes: 64_000,
      writeMode: "append-host-summary",
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        endpoint: "https://api.openai.com/v1",
        apiKey: "resolved-secret",
        apiKeyEnv: "MEMORY_EMBEDDINGS_KEY",
        dim: 768,
        timeoutMs: 4_000,
        circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
      },
    } satisfies NonNullable<MonoAgentConfig["memory"]>;
    const liveConfig = configWithMemory({ ...memory, recallTool: { enabled: true } });
    const previewConfig = configWithMemory({ ...memory, recallTool: { enabled: false } });

    expect(resolveMemoryRecallSettings(previewConfig)).toBeUndefined();
    const previewSettings = resolveMemoryRecallSettings(previewConfig, { ignoreRecallToolGate: true });
    expect(previewSettings).toEqual(resolveMemoryRecallSettings(liveConfig));
    expect(previewSettings).toEqual({
      root: "/memory",
      tier: "journal",
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        endpoint: "https://api.openai.com/v1",
        apiKey: "resolved-secret",
        apiKeyEnv: "MEMORY_EMBEDDINGS_KEY",
        dim: 768,
        timeoutMs: 4_000,
        circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
      },
    });
  });

  it("defaults the recall tool on for a programmatic memory config that omits recallTool", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "lite",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
      }),
    );
    expect(settings).toEqual({ root: "/memory", tier: "lite" });
  });

  it("returns root WITHOUT embeddings when explicitly enabled on a no-embeddings (lite) store", () => {
    // F12: the operator opts in to FTS-only recall despite no embeddings default.
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "lite",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        recallTool: { enabled: true },
      }),
    );
    expect(settings).toEqual({ root: "/memory", tier: "lite" });
    expect(bujo(settings).embeddings).toBeUndefined();
  });

  it("carries embeddings timeout + circuit-breaker tuning into the recall settings", () => {
    // F11: the resilience knobs must reach the recall store, not be dropped.
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          timeoutMs: 4_000,
          circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
        },
        recallTool: { enabled: true },
      }),
    );
    expect(bujo(settings).embeddings).toMatchObject({
      timeoutMs: 4_000,
      circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
    });
  });

  it("forwards the apiKeyEnv NAME instead of the resolved secret value (F13)", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKey: "resolved-secret",
          apiKeyEnv: "MY_OPENAI_KEY",
        },
        recallTool: { enabled: true },
      }),
    );
    expect(bujo(settings).embeddings?.apiKeyEnv).toBe("MY_OPENAI_KEY");
  });

  it("returns root + embeddings when enabled with embeddings", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          endpoint: "https://api.openai.com/v1",
          apiKey: "secret",
          dim: 1536,
        },
        recallTool: { enabled: true },
      }),
    );
    expect(settings).toEqual({
      root: "/memory",
      tier: "journal",
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        endpoint: "https://api.openai.com/v1",
        apiKey: "secret",
        dim: 1536,
      },
    });
  });

  it("preserves the exact LM Studio embedding identity and service root", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "lmstudio",
          model: "text-embedding-test",
          endpoint: "http://localhost:1234",
          dim: 4,
        },
      }),
    );

    expect(settings).toEqual({
      root: "/memory",
      tier: "journal",
      embeddings: {
        provider: "lmstudio",
        model: "text-embedding-test",
        endpoint: "http://localhost:1234",
        dim: 4,
      },
    });
  });
});

describe("MemoryRecall MCP tool (FTS, hermetic)", () => {
  it("routes last-message questions to active history without searching durable memory", async () => {
    let recallCalls = 0;
    const store = {
      async recall() {
        recallCalls += 1;
        return [{ score: 0.99, record: { id: "old", text: "an unrelated old message" } }];
      },
      async close() {},
    };
    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools[0]?.description).toMatch(/Do not use MemoryRecall.*current or last message/iu);
      expect(tools.tools[0]?.description).toMatch(/pick up, continue, or recover interrupted work.*RunHistory with \{\} first/iu);
      expect(tools.tools[0]?.description).not.toMatch(/original.*automatic lookup/iu);
      expect(tools.tools[0]?.inputSchema).toMatchObject({
        type: "object",
        required: ["query"],
        properties: { query: expect.any(Object), limit: expect.any(Object) },
      });
      const properties = (tools.tools[0]?.inputSchema as {
        properties?: Record<string, { description?: string }>
      }).properties;
      expect(properties).not.toHaveProperty("useOriginalQuery");
      expect(properties?.kind?.description).toContain("local BuJo memory");
      expect(properties?.about?.description).toContain("Guidance is empty in about mode");
      for (const query of [
        "What did you send in the last message?",
        "What was your previous reply?",
        "What was the last message?",
        "What did you say?",
        "What did you just send?",
        "What happened in this conversation?",
      ]) {
        const result = (await client.callTool({ name: "MemoryRecall", arguments: { query } })) as {
          content: Array<{ type: string; text: string }>;
          structuredContent?: { hits: unknown[]; conversationRelative?: boolean };
        };
        expect(result.structuredContent, query).toMatchObject({ hits: [], conversationRelative: true });
        expect(result.content[0]?.text, query).toMatch(/active conversation|current conversation history/iu);
      }
      expect(recallCalls).toBe(0);

      for (const query of [
        "What did you send Casey for her birthday last year?",
        "What did you say our durable deployment policy was?",
        "What did Alice's last message say?",
        "What was the last message from the deploy bot?",
      ]) {
        const result = await client.callTool({ name: "MemoryRecall", arguments: { query } });
        expect(result.structuredContent, query).toMatchObject({
          hits: [expect.objectContaining({ id: "old" })],
        });
      }
      expect(recallCalls).toBe(4);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("answers a tools/call against a lite (FTS-only) store", async () => {
    // No embeddings → lite tier → FTS-only recall, so the test needs no Ollama/OpenAI.
    const store = createBujoMemoryStore({ root: dir });
    await store.persistCompletedTurn({ runId: "fixture-1", conversationId: "conv-1", summary: "The deploy pipeline uses blue-green releases on Fridays." });
    await store.flush();
    await store.persistCompletedTurn({ runId: "fixture-2", conversationId: "conv-1", summary: "Lunch preferences are irrelevant noise." });

    await store.flush();

    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["MemoryRecall"]);

      const result = (await client.callTool({
        name: "MemoryRecall",
        arguments: { query: "deploy pipeline releases" },
      })) as { content: Array<{ type: string; text: string }>; structuredContent?: { hits: Array<{ text: string }> } };

      const text = result.content.map((part) => part.text).join("\n");
      expect(text).toContain("blue-green releases");
      expect(result.structuredContent?.hits.some((hit) => hit.text.includes("blue-green releases"))).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("returns a no-match message when nothing matches", async () => {
    const store = createBujoMemoryStore({ root: dir });
    await store.persistCompletedTurn({ runId: "fixture-3", conversationId: "conv-1", summary: "An unrelated note about gardening." });
    await store.flush();
    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "MemoryRecall",
        arguments: { query: "quantum chromodynamics lattice gauge" },
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: {
          hits: unknown[];
          navigation?: { relatedTools: Array<{ tool: string; arguments: Record<string, unknown> }> };
        };
      };
      expect(result.content[0]?.text).toMatch(/No memories matched/u);
      expect(result.content[0]?.text).toMatch(/RunHistory with \{\} first/u);
      expect(result.structuredContent?.hits).toEqual([]);
      expect(result.structuredContent?.navigation?.relatedTools).toEqual([expect.objectContaining({
        tool: "RunHistory",
        arguments: {},
      })]);
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("keeps a non-BuJo tier on the direct limit without graph prefetch", async () => {
    const recalls: Array<{ readonly topK?: number; readonly trackAccess?: boolean }> = [];
    let expansions = 0;
    const store = {
      async recall(_query: string, options?: { readonly topK?: number; readonly trackAccess?: boolean }) {
        recalls.push(options ?? {});
        return [{ score: 0.9, record: { id: "direct", text: "Morgan prefers cobalt." } }];
      },
      supportsGraphExpansion: () => false,
      expandGraph() {
        expansions += 1;
        return [];
      },
      async close() {},
    };
    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: "MemoryRecall", arguments: { query: "Morgan preference", limit: 3 } });
      expect(recalls).toEqual([{ topK: 3, trackAccess: false }]);
      expect(expansions).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("createRecallStore", () => {
  it("builds a keyless LM Studio provider with the exact root and identity", async () => {
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: readonly string[] };
      return new Response(JSON.stringify({
        data: body.input.map(() => ({ embedding: [1, 0, 0, 0] })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const provider = await createMemoryEmbeddingProvider({
      provider: "lmstudio",
      model: "text-embedding-test",
      endpoint: "http://localhost:1234",
    });
    await expect(provider.embed(["remember this"])).resolves.toEqual([[1, 0, 0, 0]]);

    expect(provider.id).toBe("lmstudio:text-embedding-test");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:1234/v1/embeddings",
      expect.objectContaining({ headers: { "content-type": "application/json" } }),
    );
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toMatch(/Authorization|11434|ollama/iu);
  });

  it("fails before provider construction when a declared credential has no resolved value", async () => {
    await expect(createMemoryEmbeddingProvider({
      provider: "lmstudio",
      model: "text-embedding-test",
      apiKeyEnv: "LM_STUDIO_API_KEY",
    })).rejects.toThrow(/LM_STUDIO_API_KEY.*no resolved value/iu);
  });

  it("resolves a declared apiKeyEnv at use and sends it as the bearer token", async () => {
    // Without resolve-at-use the loader carries only the name, so the provider
    // would fail to authenticate even with the variable set.
    vi.stubEnv("RECALL_TEST_API_KEY", "env-resolved-secret");
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: readonly string[] };
      return new Response(JSON.stringify({
        data: body.input.map(() => ({ embedding: [1, 0, 0] })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const provider = await createMemoryEmbeddingProvider({
      provider: "lmstudio",
      model: "text-embedding-test",
      endpoint: "http://localhost:1234",
      apiKeyEnv: "RECALL_TEST_API_KEY",
    });
    await expect(provider.embed(["remember this"])).resolves.toEqual([[1, 0, 0]]);

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.["authorization"]).toBe("Bearer env-resolved-secret");
  });

  it("builds an FTS-only store when settings carry no embeddings (F12)", async () => {
    // No embeddings → lite tier → FTS recall answers without any Ollama/OpenAI backend.
    await seedRecallMemory(dir, "The deploy pipeline uses blue-green releases on Fridays.");
    const store = (await createRecallStore({ root: dir })) as unknown as BujoMemoryStore;
    try {
      expect(store.tier()).toBe("lite");
      const hits = await store.recall("deploy pipeline releases");
      expect(hits.some((hit) => hit.record.text.includes("blue-green releases"))).toBe(true);
      await expect(store.persistCompletedTurn({ runId: "rejected-write", conversationId: "conv-2", summary: "Recall must not write." })).rejects.toThrow(/read.?only/iu);
    } finally {
      await store.close();
    }
  });

  it("opens the managed active generation instead of a stale legacy database", async () => {
    await seedRecallMemory(dir, "The active generation contains the cobalt launch plan.");
    await safeRebuildMemoryIndex({ root: dir, tier: "lite" });
    const activePath = await resolveActiveMemoryDbPath(dir);
    expect(activePath).not.toBe(join(dir, "memory.db"));

    const legacy = openMemoryDb({ path: join(dir, "memory.db") });
    try {
      legacy.upsertLexical(memoryRecord("LEGACY-ONLY", "Stale legacy database sentinel."));
    } finally {
      legacy.close();
    }

    const store = await createRecallStore({ root: dir });
    try {
      const activeHits = await store.recall("cobalt launch plan", { trackAccess: false });
      expect(activeHits.some((hit) => hit.record.text.includes("cobalt launch plan"))).toBe(true);
      const staleHits = await store.recall("stale legacy database sentinel", { trackAccess: false });
      expect(staleHits).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("applies the embeddings timeout + circuit breaker so a dead backend fast-fails (F11)", async () => {
    // Unreachable endpoint + tiny timeout + a one-failure breaker: the first embed fails and trips
    // the breaker OPEN, so a subsequent recall fast-fails (no 30s hang, no inner provider call).
    await seedRecallMemory(dir, "Anything that needs an embedding.");
    const store = await createRecallStore({
      root: dir,
      embeddings: {
        provider: "ollama",
        model: "nomic-embed-text:v1.5",
        endpoint: "http://127.0.0.1:1",
        timeoutMs: 50,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      },
    }) as unknown as BujoMemoryStore;
    try {
      // The recall-only store never writes; the first lookup trips the breaker.
      await expect(store.recall("anything")).rejects.toThrow();
      // With the breaker OPEN, a subsequent recall fast-fails without re-hitting the dead backend.
      await expect(store.recall("anything")).rejects.toThrow(/circuit is open/u);
    } finally {
      await store.close();
    }
  });

  it("opens managed BuJo generations for semantic and pinned FTS recall without losing graph capability", async () => {
    await seedRecallMemory(dir, "The cobalt launch plan uses blue-green deployment.");
    await seedRecallMemory(dir, "Taylor owns the incident checklist for midnight incidents.");
    const legacy = openMemoryDb({ path: join(dir, "memory.db") });
    const records = legacy.topSalient(10);
    legacy.close();
    const launch = records.find((record) => record.text.includes("cobalt launch plan"))!;
    const incident = records.find((record) => record.text.includes("incident checklist"))!;
    appendGraphBatch(dir, {
      entities: [
        { id: "project:launch", name: "Launch", type: "project", createdAt: "2026-07-11T09:00:00.000Z" },
        { id: "person:taylor", name: "Taylor", type: "person", createdAt: "2026-07-11T09:00:00.000Z" },
      ],
      relations: [{
        src: "project:launch",
        dst: "person:taylor",
        relation: "supported by",
        createdAt: "2026-07-11T09:00:00.000Z",
      }],
      associations: [
        { memoryId: launch.id, entityId: "project:launch", provenance: "capture", createdAt: "2026-07-11T09:00:00.000Z" },
        { memoryId: incident.id, entityId: "person:taylor", provenance: "capture", createdAt: "2026-07-11T09:00:00.000Z" },
      ],
    });
    const embeddings = deterministicEmbeddings("ollama:test-embed", 8);
    await safeRebuildMemoryIndex({ root: dir, tier: "bujo", embeddings, dim: 8 });
    const activePath = await resolveActiveMemoryDbPath(dir);

    let fetchCalls = 0;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        embeddings: body.input.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const semantic = await createRecallStore({
      root: dir,
      tier: "bujo",
      dbPath: activePath,
      embeddings: { provider: "ollama", model: "test-embed", dim: 8 },
    }) as BujoMemoryStore;
    try {
      expect(semantic.tier()).toBe("bujo");
      expect(semantic.supportsGraphExpansion()).toBe(true);
      const hits = await semantic.recall("cobalt launch plan", { trackAccess: false });
      expect(hits.some((hit) => hit.record.text.includes("cobalt launch plan"))).toBe(true);
      const expanded = semantic.expandGraph("Who is Launch supported by?", [{ record: launch, score: 0.9 }], { topK: 5 });
      expect(expanded.some((hit) => hit.record.text.includes("incident checklist"))).toBe(true);
      expect(fetchCalls).toBeGreaterThan(0);
    } finally {
      await semantic.close();
    }

    const fallback = await createRecallStore({
      root: dir,
      tier: "bujo",
      dbPath: activePath,
      ftsOnlyFallback: true,
    }) as BujoMemoryStore;
    try {
      expect(fallback.tier()).toBe("bujo");
      expect(fallback.supportsGraphExpansion()).toBe(true);
      const hits = await fallback.recall("cobalt launch plan", { trackAccess: false });
      expect(hits.some((hit) => hit.record.text.includes("cobalt launch plan"))).toBe(true);
      const expanded = fallback.expandGraph("Who is Launch supported by?", [{ record: launch, score: 0.9 }], { topK: 5 });
      expect(expanded.some((hit) => hit.record.text.includes("incident checklist"))).toBe(true);
      expect(await resolveActiveMemoryDbPath(dir)).toBe(activePath);
    } finally {
      await fallback.close();
    }
  });
});

async function seedRecallMemory(root: string, text: string): Promise<void> {
  const store = createBujoMemoryStore({ root });
  try {
    await store.remember("conv-1", text);
  } finally {
    await store.close();
  }
}

function memoryRecord(id: string, text: string) {
  return {
    id,
    type: "note" as const,
    status: "open" as const,
    text,
    salience: 0.5,
    isInsight: false,
    createdAt: "2026-07-11T09:00:00.000Z",
    accessCount: 0,
    tags: [] as readonly string[],
    source: {},
  };
}

function deterministicEmbeddings(id: string, dim: number): EmbeddingProvider {
  return {
    id,
    embed: async (texts) => texts.map((text) => {
      const vector = new Array<number>(dim).fill(0);
      for (const [index, byte] of Buffer.from(text).entries()) {
        vector[index % dim] = (vector[index % dim] ?? 0) + byte / 255;
      }
      return vector;
    }),
  };
}

describe("explicit-only coverage scoring", () => {
  it.each([
    ["When is Morgan's birth date and age?", "Morgan's birth date is 17 May", "Morgan's age is uncertain"],
    ["Quando è la data di nascita di Morgan?", "La data di nascita di Morgan è maggio", "Morgan ha avuto un raffreddore"],
    ["Wat is de geboortedatum van Morgan?", "De geboortedatum van Morgan is mei", "Morgan heeft een verkoudheid"],
  ])("distinguishes multi-term coverage without changing original backend hits: %s", (query, complete, partial) => {
    const hits = [
      { score: 0.99, record: { id: "partial", text: partial } },
      { score: 0.98, record: { id: "complete", text: complete } },
    ];
    const ranked = rankExplicitHits(query, hits);
    expect(ranked[0]?.record.id).toBe("complete");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(hits[0]?.score).toBe(0.99);
  });
});

describe("backend-agnostic recall server", () => {
  it("names all ambiguous identities and ranks current facts ahead of older history with a visible cap", () => {
    const entities = [{ id: "person:morgan", name: "Morgan", createdAt: "2026-09-06T00:00:00.000Z" },
      { id: "person:morgan-two", name: "Mórgan", createdAt: "2026-09-06T00:00:00.000Z" }];
    const store = {
      findMemoryEntitiesByNames: (names: readonly string[]) => names.includes("morgan") ? entities : [],
      labelsForEntity: (id: string) => Array.from({ length: 14 }, (_, index) => ({
        memoryId: `${id}-${index}`, ordinal: 0, text: "Morgan was born 1990-05-17.",
        status: index === 13 ? "open" : "invalidated", active: index === 13,
        currentAt: index === 13, conflict: false, createdAt: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        label: { v: 1 as const, kind: "fact" as const, entityId: id, key: "birth_date",
          value: { type: "date" as const, date: "1990-05-17" }, attribution: "user-stated" as const },
      })),
      guidanceForScope: () => [],
    };
    const result = readLabelSections(store, { query: "Morgan", about: "Morgan", kind: "fact" }, { hostDate: "2026-09-24" });
    expect(result?.text).toContain("Ambiguous name — 2 entities, specify an entity id");
    expect(result?.text).toContain("[person:morgan]");
    expect(result?.text).toContain("[person:morgan-two]");
    expect(result?.factSheet?.[0]).toMatchObject({ entityId: "person:morgan", current: true });
    expect(result?.factSheetTruncated).toBe(true);
    expect(result?.text).toContain("Fact sheet truncated");
    const exact = readLabelSections(store, { query: "Morgan", about: "person:morgan", kind: "fact" }, { hostDate: "2026-09-24" });
    expect(exact?.factSheet?.every((entry) => entry.entityId === "person:morgan")).toBe(true);
  });

  it("serves this speaker before the conversation and agent under a bounded guidance cap", () => {
    const token = "a".repeat(32);
    const store = {
      labelsForEntity: () => [],
      guidanceForScope: (scope: string) => Array.from({ length: 5 }, (_, index) => ({
        memoryId: `${scope}-${index}`, ordinal: 0, text: `Guidance ${index} for ${scope}.`,
        status: "open", active: true, conflict: false, createdAt: "2026-09-06T00:00:00.000Z",
        label: { v: 1 as const, kind: "preference" as const, scope, attribution: "user-stated" as const },
      })),
    };
    const result = readLabelSections(store, { query: "notes", kind: "preference" },
      { conversationId: "conv", senderToken: token, hostDate: "2026-09-24" });
    expect(result?.preferencesAndLessons?.[0]?.scope).toBe(`user:${token}`);
    expect(result?.preferencesAndLessons?.[5]?.scope).toBe("conversation:conv");
    expect(result?.preferencesAndLessonsTruncated).toBe(true);
    expect(result?.text).toContain("Preferences & lessons truncated");
  });
  it("prepends labelled fact/history/conflicts and scoped guidance in both modes without filtering ordinary hits", async () => {
    const birth = (id: string, active: boolean) => ({ memoryId: id, ordinal: 0,
      text: "Morgan was born 1990-05-17.", status: active ? "open" : "invalidated", active,
      conflict: active, currentAt: active, createdAt: "2026-09-06T00:00:00.000Z",
      label: { v: 1 as const, kind: "fact" as const, entityId: "person:morgan", key: "birth_date",
        value: { type: "date" as const, date: "1990-05-17" }, attribution: "user-stated" as const } });
    const store = {
      recall: async () => [{ score: 0.9, record: { id: "hit", text: "Morgan's birthday was noted.", createdAt: "2026-09-06" } }],
      recallOriginalWithOutcome: async () => ({ available: true as const, query: "Morgan birthday",
        outcome: { hits: [{ score: 0.9, record: { id: "hit", text: "Morgan's birthday was noted." } }], retrievalMode: "hybrid" as const } }),
      labelsForEntity: () => [birth("current", true), birth("past", false)],
      guidanceForScope: (scope: string) => scope === "agent" ? [{ memoryId: "guidance", ordinal: 0,
        text: "Keep reports concise.", status: "open", active: true, conflict: false,
        createdAt: "2026-09-06T00:00:00.000Z", label: { v: 1 as const, kind: "preference" as const,
          scope: "agent", attribution: "user-stated" as const } }] : [],
      findMemoryEntitiesByNames: (names: readonly string[]) => names.includes("morgan")
        ? [{ id: "person:morgan", name: "Morgan", createdAt: "2026-09-06T00:00:00.000Z" }] : [],
      close: async () => {},
    };
    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "label-recall", version: "0.1.0" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    try {
      const factResult = await client.callTool({ name: "MemoryRecall", arguments: { query: "Morgan birthday", about: "morgan", kind: "fact" } });
      expect(factResult.structuredContent).toMatchObject({ hits: [{ id: "hit" }], factSheet: [
        { current: true, conflict: true, attribution: "user-stated" }, { current: false, conflict: false }],
      });
      expect(factResult.structuredContent).not.toHaveProperty("preferencesAndLessons");
      const lessonResult = await client.callTool({ name: "MemoryRecall", arguments: { useOriginalQuery: true, kind: "preference" } });
      expect(lessonResult.structuredContent).toMatchObject({ queryMode: "original", hits: [{ id: "hit" }],
        preferencesAndLessons: [{ scope: "agent", text: "Keep reports concise." }] });
      expect(lessonResult.structuredContent).not.toHaveProperty("factSheet");
      expect(JSON.stringify(lessonResult.content)).toContain("Preferences & lessons:");
      const absent = await client.callTool({ name: "MemoryRecall", arguments: { query: "Morgan birthday", about: "unmatched" } });
      expect(absent.structuredContent).toMatchObject({ factSheet: [] });
    } finally { await client.close(); await server.close(); }
  });
  it("renders source and validity dates on direct or graph-expanded records when supplied", async () => {
    const store = {
      recall: async () => [{ score: 0.9, record: { id: "a", text: "Morgan was born in May" } }],
      expandGraph: async () => [{ score: 0.9, record: { id: "b", text: "Morgan birth date", createdAt: "2026-09-20T00:00:00.000Z", validFrom: "1990-05-17T00:00:00.000Z" } }],
      close: async () => {},
    };
    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "dated-recall", version: "0.1.0" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    try {
      const result = await client.callTool({ name: "MemoryRecall", arguments: { query: "Morgan birth date" } });
      expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("recorded 2026-09-20T00:00:00.000Z") })]);
      expect(result.structuredContent).toMatchObject({ hits: [{ id: "b", createdAt: "2026-09-20T00:00:00.000Z", validFrom: "1990-05-17T00:00:00.000Z" }] });
    } finally { await client.close(); await server.close(); }
  });

  it("answers a tools/call against a recall-capable store (backend-agnostic server)", async () => {
    const fakeStore = {
      recall: async () => [{ score: 0.9, record: { id: "m1", text: "user prefers dark mode" } }],
      close: async () => {},
    };
    const server = createMemoryRecallServer(fakeStore);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "MemoryRecall",
        arguments: { query: "preferences" },
      })) as { content: Array<{ type: string; text: string }>; structuredContent?: { hits: Array<{ text: string }> } };
      const text = result.content.map((part) => part.text).join("\n");
      expect(text).toContain("user prefers dark mode");
      expect(result.structuredContent?.hits[0]?.text).toBe("user prefers dark mode");
      expect(result.structuredContent).not.toHaveProperty("factSheet");
      expect(result.structuredContent).not.toHaveProperty("preferencesAndLessons");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("MEMORY_RECALL_MCP_SERVER_NAME", () => {
  it("is the stable server name the app injects", () => {
    expect(MEMORY_RECALL_MCP_SERVER_NAME).toBe("mono-agent-memory");
  });
});
