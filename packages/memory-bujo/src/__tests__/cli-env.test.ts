import { describe, it, expect } from "vitest";

import { readEmbeddings } from "../cli-env.js";

describe("memory-bujo CLI env: readEmbeddings", () => {
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
});
