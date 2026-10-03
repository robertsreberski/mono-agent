import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../../store/index.js";
import {
  adoptEmbeddingIndexIdentity,
  configuredEmbeddingIdentity,
  createCircuitBreakerEmbeddingProvider,
  createEmbeddingProvider,
  effectiveEmbeddingIdentity,
  embeddingPrefixesForIdentity,
  legacyEmbeddingIdentity,
  modelInstructionPreset,
  type EmbeddingProvider,
} from "../index.js";

function recordingOllama(model: string, instructions?: "auto" | "search" | "none" | "query" | "qwen3") {
  const sent: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    sent.push(...body.input);
    return new Response(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0, 0]) }), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = createEmbeddingProvider({
    provider: "ollama",
    model,
    ...(instructions === undefined ? {} : { instructions }),
  }, fetchImpl);
  return { provider, sent };
}

describe("embedding instruction presets", () => {
  it.each([
    ["nomic-embed-text:v1.5", "search"],
    ["nomic-embed-text", "search"],
    ["bge-m3:latest", "none"],
    ["BAAI/bge-m3", "none"],
    ["snowflake-arctic-embed2:latest", "query"],
    ["Snowflake/snowflake-arctic-embed-l-v2.0", "query"],
    ["qwen3-embedding:0.6b", "qwen3"],
    ["text-embedding-3-small", "search"],
    ["mxbai-embed-large", "search"],
  ] as const)("maps %s to %s", (model, preset) => {
    expect(modelInstructionPreset(model)).toBe(preset);
  });

  it("keeps the historical identity and prefixes for search-preset models", () => {
    expect(configuredEmbeddingIdentity({ provider: "ollama", model: "nomic-embed-text:v1.5" }))
      .toBe("ollama:nomic-embed-text:v1.5");
    expect(legacyEmbeddingIdentity({ provider: "ollama", model: "nomic-embed-text:v1.5" })).toBeUndefined();
    expect(embeddingPrefixesForIdentity("ollama:nomic-embed-text:v1.5"))
      .toEqual({ query: "search_query: ", document: "search_document: " });
    const { provider } = recordingOllama("nomic-embed-text:v1.5");
    expect(provider.id).toBe("ollama:nomic-embed-text:v1.5");
    expect(provider.legacyId).toBeUndefined();
  });

  it("suffixes the identity for other presets and keeps the legacy identity only for auto", () => {
    expect(configuredEmbeddingIdentity({ provider: "ollama", model: "bge-m3:latest" }))
      .toBe("ollama:bge-m3:latest#instructions=none");
    expect(legacyEmbeddingIdentity({ provider: "ollama", model: "bge-m3:latest" })).toBe("ollama:bge-m3:latest");
    expect(legacyEmbeddingIdentity({ provider: "ollama", model: "bge-m3:latest", instructions: "none" }))
      .toBeUndefined();
    expect(configuredEmbeddingIdentity({ provider: "ollama", model: "bge-m3:latest", instructions: "search" }))
      .toBe("ollama:bge-m3:latest");
    expect(configuredEmbeddingIdentity({ provider: "ollama", model: "nomic-embed-text:v1.5", instructions: "none" }))
      .toBe("ollama:nomic-embed-text:v1.5#instructions=none");
    expect(effectiveEmbeddingIdentity({ provider: "ollama", model: "bge-m3:latest" }, "ollama:bge-m3:latest"))
      .toBe("ollama:bge-m3:latest");
    expect(effectiveEmbeddingIdentity({ provider: "ollama", model: "bge-m3:latest" }, undefined))
      .toBe("ollama:bge-m3:latest#instructions=none");
    expect(effectiveEmbeddingIdentity(
      { provider: "ollama", model: "bge-m3:latest", instructions: "none" },
      "ollama:bge-m3:latest",
    )).toBe("ollama:bge-m3:latest#instructions=none");
  });

  it("fails closed on an unknown instructions suffix", () => {
    expect(() => embeddingPrefixesForIdentity("ollama:x#instructions=future")).toThrow(/unsupported/u);
    expect(() => embeddingPrefixesForIdentity("ollama:x#instructions=search")).toThrow(/unsupported/u);
  });

  it("forwards the legacy identity through the circuit breaker and adopts it only for an exact match", () => {
    const { provider } = recordingOllama("bge-m3:latest");
    const breaker = createCircuitBreakerEmbeddingProvider(provider);
    expect(breaker.id).toBe("ollama:bge-m3:latest#instructions=none");
    expect(breaker.legacyId).toBe("ollama:bge-m3:latest");
    expect(adoptEmbeddingIndexIdentity(breaker, "ollama:bge-m3:latest").id).toBe("ollama:bge-m3:latest");
    expect(adoptEmbeddingIndexIdentity(breaker, "ollama:other:latest")).toBe(breaker);
    expect(adoptEmbeddingIndexIdentity(breaker, undefined)).toBe(breaker);
  });

  it.each([
    ["nomic-embed-text:v1.5", undefined, "search_query: when?", "search_document: Morgan was born in May."],
    ["bge-m3:latest", undefined, "when?", "Morgan was born in May."],
    ["snowflake-arctic-embed2:latest", undefined, "query: when?", "Morgan was born in May."],
    [
      "qwen3-embedding:0.6b",
      undefined,
      "Instruct: Given a question, retrieve memory notes that answer it\nQuery:when?",
      "Morgan was born in May.",
    ],
    ["bge-m3:latest", "search", "search_query: when?", "search_document: Morgan was born in May."],
  ] as const)("sends %s (%s) the preset prefixes", async (model, instructions, query, document) => {
    const { provider, sent } = recordingOllama(model, instructions);
    const db = openMemoryDb({ path: ":memory:", embeddings: provider, dim: 4 });
    try {
      await db.upsert({
        id: "m1", type: "note", status: "open", text: "Morgan was born in May.", salience: 0.5,
        isInsight: false, createdAt: "2026-07-10T12:00:00.000Z", accessCount: 0, tags: [], source: {},
      });
      await db.recall("when?", { trackAccess: false });
      expect(sent).toEqual([document, query]);
      expect(db.get("m1")?.embeddingModel).toBe(provider.id);
    } finally {
      db.close();
    }
  });

  it("serves an adopted legacy identity with the historical prefixes", async () => {
    const { provider, sent } = recordingOllama("bge-m3:latest");
    const adopted: EmbeddingProvider = adoptEmbeddingIndexIdentity(provider, "ollama:bge-m3:latest");
    const db = openMemoryDb({ path: ":memory:", embeddings: adopted, dim: 4 });
    try {
      await db.upsert({
        id: "m1", type: "note", status: "open", text: "Morgan was born in May.", salience: 0.5,
        isInsight: false, createdAt: "2026-07-10T12:00:00.000Z", accessCount: 0, tags: [], source: {},
      });
      await db.recall("when?", { trackAccess: false });
      expect(sent).toEqual(["search_document: Morgan was born in May.", "search_query: when?"]);
      expect(db.get("m1")?.embeddingModel).toBe("ollama:bge-m3:latest");
    } finally {
      db.close();
    }
  });
});
