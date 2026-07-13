import { afterEach, describe, it, expect, vi } from "vitest";

import { readEmbeddings } from "../cli-env.js";

describe("memory-bujo CLI env: readEmbeddings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns undefined when no provider is configured (lite/FTS-only — no embedding service needed)", () => {
    expect(readEmbeddings({})).toBeUndefined();
    expect(readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "  " })).toBeUndefined();
  });

  it("throws on an unsupported provider rather than silently downgrading", () => {
    expect(() => readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollma" })).toThrow(/unsupported/u);
  });

  it("throws on a set-but-invalid dim", () => {
    for (const dim of ["abc", "0", "-1", "1.5"]) {
      expect(() =>
        readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama", MONO_AGENT_MEMORY_EMBEDDINGS_DIM: dim }),
      ).toThrow(/MONO_AGENT_MEMORY_EMBEDDINGS_DIM/u);
    }
  });

  it("builds a provider with default model/dim when only the provider is set", () => {
    const result = readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama" });
    expect(result).toBeDefined();
    expect(result?.dim).toBe(768);
    expect(result?.provider).toBeDefined();
  });

  it("keeps the standalone OpenAI default model unchanged", () => {
    const result = readEmbeddings({
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "test-key",
    });

    expect(result?.provider.id).toBe("openai:nomic-embed-text:v1.5");
  });

  it("builds a keyless LM Studio provider with its provider-specific default model", () => {
    const result = readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "lmstudio" });

    expect(result?.provider.id).toBe("lmstudio:text-embedding-nomic-embed-text-v1.5");
    expect(result?.dim).toBe(768);
  });

  it("fails closed when apiKeyEnv names an unset variable", () => {
    expect(() => readEmbeddings({
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "lmstudio",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "embed-model",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "LM_STUDIO_API_KEY",
    })).toThrow(/declares LM_STUDIO_API_KEY/u);
  });

  it("does not substitute a literal key when a declared apiKeyEnv is unset", () => {
    expect(() => readEmbeddings({
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "lmstudio",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "embed-model",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "LM_STUDIO_API_KEY",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "must-not-be-used",
    })).toThrow(/declares LM_STUDIO_API_KEY/u);
  });

  it("sends the resolved apiKeyEnv value to LM Studio", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const result = readEmbeddings({
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "lmstudio",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "embed-model",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "LM_STUDIO_API_KEY",
      LM_STUDIO_API_KEY: "resolved-token",
    });

    await result?.provider.embed(["probe"]);

    expect(calls[0]?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer resolved-token",
    });
  });
});
