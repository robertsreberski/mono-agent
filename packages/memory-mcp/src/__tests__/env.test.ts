import { describe, it, expect } from "vitest";

import { readEmbeddings, readLlm } from "../env.js";

describe("memory-mcp env: readEmbeddings", () => {
  it("returns undefined when the provider is unset or empty (embeddings off)", () => {
    expect(readEmbeddings({})).toBeUndefined();
    expect(readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "   " })).toBeUndefined();
  });

  it("throws on a set-but-unsupported provider instead of silently disabling embeddings", () => {
    expect(() => readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollma" })).toThrow(/unsupported/u);
    expect(() => readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai2" })).toThrow(
      /MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER/u,
    );
  });

  it("resolves a supported provider with defaults and optional dim", () => {
    expect(readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama" })).toEqual({
      provider: "ollama",
      model: "nomic-embed-text:v1.5",
    });
    expect(
      readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai", MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "1536" }),
    ).toMatchObject({ provider: "openai", dim: 1536 });
  });

  it("throws on a set-but-invalid dim instead of forwarding it into an opaque db error", () => {
    for (const dim of ["abc", "0", "-5", "1.5", "12abc"]) {
      expect(() =>
        readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama", MONO_AGENT_MEMORY_EMBEDDINGS_DIM: dim }),
      ).toThrow(/MONO_AGENT_MEMORY_EMBEDDINGS_DIM/u);
    }
  });

  it("ignores an empty dim (embeddings provider default applies)", () => {
    expect(
      readEmbeddings({ MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama", MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "  " }),
    ).not.toHaveProperty("dim");
  });
});

describe("memory-mcp env: readLlm", () => {
  it("returns undefined without a model", () => {
    expect(readLlm({})).toBeUndefined();
  });

  it("resolves model and optional endpoint", () => {
    expect(readLlm({ MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest" })).toEqual({ model: "qwen3.6:latest" });
    expect(
      readLlm({ MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest", MONO_AGENT_MEMORY_LLM_ENDPOINT: "http://x:11434" }),
    ).toEqual({ model: "qwen3.6:latest", endpoint: "http://x:11434" });
  });

  it("resolves an optional positive-integer timeout override", () => {
    expect(
      readLlm({ MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest", MONO_AGENT_MEMORY_LLM_TIMEOUT_MS: "180000" }),
    ).toEqual({ model: "qwen3.6:latest", timeoutMs: 180000 });
  });

  it("omits the timeout when unset or empty (client default applies)", () => {
    expect(readLlm({ MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest", MONO_AGENT_MEMORY_LLM_TIMEOUT_MS: "  " })).toEqual({
      model: "qwen3.6:latest",
    });
  });

  it("throws on a non-integer or non-positive timeout (misconfiguration, not silent)", () => {
    expect(() =>
      readLlm({ MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest", MONO_AGENT_MEMORY_LLM_TIMEOUT_MS: "soon" }),
    ).toThrow("MONO_AGENT_MEMORY_LLM_TIMEOUT_MS");
    expect(() =>
      readLlm({ MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest", MONO_AGENT_MEMORY_LLM_TIMEOUT_MS: "0" }),
    ).toThrow("MONO_AGENT_MEMORY_LLM_TIMEOUT_MS");
  });
});
