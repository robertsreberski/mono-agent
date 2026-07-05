import { describe, expect, it } from "vitest";

import { createEmbeddingProvider, MemorySearchError, OllamaEmbeddingProvider } from "../index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OllamaEmbeddingProvider", () => {
  it("posts to /api/embed and returns the embedding vectors", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return jsonResponse({ embeddings: [[1, 0, 0], [0, 1, 0]] });
    }) as typeof fetch;

    const provider = new OllamaEmbeddingProvider({ model: "nomic-embed-text", fetchImpl });
    const vectors = await provider.embed(["a", "b"]);

    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(calls[0]?.url).toBe("http://localhost:11434/api/embed");
    expect(calls[0]?.body).toEqual({ model: "nomic-embed-text", input: ["a", "b"] });
    expect(provider.id).toBe("ollama:nomic-embed-text");
  });

  it("throws on non-OK responses", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ model: "m", fetchImpl });
    await expect(provider.embed(["x"])).rejects.toThrow(MemorySearchError);
  });

  it("throws when the response shape is wrong", async () => {
    const fetchImpl = (async () => jsonResponse({ embeddings: [[1, 2]] })) as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ model: "m", fetchImpl });
    await expect(provider.embed(["x", "y"])).rejects.toThrow(/unexpected/u);
  });

  it("short-circuits empty input without calling fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({ embeddings: [] });
    }) as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ model: "m", fetchImpl });
    expect(await provider.embed([])).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("createEmbeddingProvider", () => {
  it("builds an Ollama provider", () => {
    const provider = createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text" });
    expect(provider.id).toBe("ollama:nomic-embed-text");
  });

  it("requires an API key for OpenAI", () => {
    expect(() => createEmbeddingProvider({ provider: "openai", model: "text-embedding-3-small" })).toThrow(/API key/u);
  });
});
