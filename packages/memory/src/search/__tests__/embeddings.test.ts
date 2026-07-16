import { describe, expect, it } from "vitest";

import {
  createEmbeddingProvider,
  LmStudioEmbeddingProvider,
  MemorySearchError,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from "../index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type ProviderFactory = (fetchImpl: typeof fetch) => {
  embed(texts: readonly string[]): Promise<number[][]>;
};

const providerFactories = [
  ["Ollama", (fetchImpl) => new OllamaEmbeddingProvider({ model: "test-model", fetchImpl })],
  ["LM Studio", (fetchImpl) => new LmStudioEmbeddingProvider({ model: "test-model", fetchImpl })],
  ["OpenAI", (fetchImpl) => new OpenAIEmbeddingProvider({ model: "test-model", apiKey: "test-key", fetchImpl })],
] as const satisfies readonly (readonly [string, ProviderFactory])[];

async function rejectionOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

describe("embedding provider failure taxonomy", () => {
  it.each(providerFactories)("wraps malformed successful %s JSON as an invalid response with its cause", async (_label, createProvider) => {
    const fetchImpl = (async () => new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    const error = await rejectionOf(createProvider(fetchImpl).embed(["text"]));

    expect(error).toBeInstanceOf(MemorySearchError);
    expect(error).toMatchObject({ code: "embedding_response_invalid" });
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it.each(providerFactories)("keeps non-OK %s responses in the request-failed category", async (_label, createProvider) => {
    const fetchImpl = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;

    const error = await rejectionOf(createProvider(fetchImpl).embed(["text"]));

    expect(error).toBeInstanceOf(MemorySearchError);
    expect(error).toMatchObject({ code: "embedding_request_failed" });
  });

  it.each(providerFactories)("preserves structured %s network failures unchanged", async (_label, createProvider) => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const networkFailure = Object.assign(new TypeError("fetch failed"), { cause });
    const fetchImpl = (async () => {
      throw networkFailure;
    }) as typeof fetch;

    expect(await rejectionOf(createProvider(fetchImpl).embed(["text"]))).toBe(networkFailure);
  });
});

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

  it.each([
    ["an empty vector", [[]]],
    ["a NaN component", [[Number.NaN]]],
    ["an infinite component", [[Number.POSITIVE_INFINITY]]],
  ])("rejects %s from the shared response validator", async (_name, embeddings) => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ embeddings }),
    }) as Response) as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ model: "m", fetchImpl });

    await expect(provider.embed(["x"])).rejects.toThrow(/non-empty array of finite numbers/u);
  });
});

describe("LmStudioEmbeddingProvider", () => {
  it("posts to the default service root without an authorization header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] });
    }) as typeof fetch;

    const provider = new LmStudioEmbeddingProvider({ model: "nomic-embed", fetchImpl });
    await expect(provider.embed(["a", "b"])).resolves.toEqual([[1, 0], [0, 1]]);

    expect(provider.id).toBe("lmstudio:nomic-embed");
    expect(calls[0]?.url).toBe("http://localhost:1234/v1/embeddings");
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ model: "nomic-embed", input: ["a", "b"] });
  });

  it("treats a configured endpoint as a service root and sends a resolved key", async () => {
    const calls: Array<{ url: string; headers: RequestInit["headers"] }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers });
      return jsonResponse({ data: [{ embedding: [1] }] });
    }) as typeof fetch;

    const provider = new LmStudioEmbeddingProvider({
      model: "embed-model",
      endpoint: "http://127.0.0.1:1234/",
      apiKey: "resolved-token",
      fetchImpl,
    });
    await provider.embed(["a"]);

    expect(calls).toEqual([{
      url: "http://127.0.0.1:1234/v1/embeddings",
      headers: { "content-type": "application/json", authorization: "Bearer resolved-token" },
    }]);
  });

  it("does not authenticate with a blank unresolved key", async () => {
    let headers: RequestInit["headers"];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headers = init?.headers;
      return jsonResponse({ data: [{ embedding: [1] }] });
    }) as typeof fetch;
    const provider = new LmStudioEmbeddingProvider({ model: "embed-model", apiKey: "   ", fetchImpl });

    await provider.embed(["a"]);

    expect(headers).toEqual({ "content-type": "application/json" });
  });

  it.each([
    "file:///tmp/lmstudio.sock",
    "http://user:pass@localhost:1234",
    "http://localhost:1234?route=elsewhere",
    "http://localhost:1234#fragment",
  ])("rejects invalid service root %s", (endpoint) => {
    expect(() => new LmStudioEmbeddingProvider({ model: "embed-model", endpoint })).toThrow(/service root|absolute HTTP/u);
  });

  it("uses the shared OpenAI-compatible response validator", async () => {
    const fetchImpl = (async () => jsonResponse({ data: [{ embedding: [] }] })) as typeof fetch;
    const provider = new LmStudioEmbeddingProvider({ model: "embed-model", fetchImpl });

    await expect(provider.embed(["a"])).rejects.toThrow(/non-empty array of finite numbers/u);
  });
});

describe("OpenAIEmbeddingProvider", () => {
  it("keeps the OpenAI endpoint, authorization, identity, and response contract", async () => {
    const calls: Array<{ url: string; headers: RequestInit["headers"] }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers });
      return jsonResponse({ data: [{ embedding: [1, 2] }] });
    }) as typeof fetch;
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      apiKey: "openai-key",
      fetchImpl,
    });

    await expect(provider.embed(["a"])).resolves.toEqual([[1, 2]]);
    expect(provider.id).toBe("openai:text-embedding-3-small");
    expect(calls).toEqual([{
      url: "https://api.openai.com/v1/embeddings",
      headers: { "content-type": "application/json", authorization: "Bearer openai-key" },
    }]);
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

  it("builds an LM Studio provider without requiring an API key", () => {
    const provider = createEmbeddingProvider({ provider: "lmstudio", model: "nomic-embed" });
    expect(provider.id).toBe("lmstudio:nomic-embed");
  });
});
