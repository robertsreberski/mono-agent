import { MemorySearchError } from "@mono-agent/memory/search";
import type { MemorySearchErrorCode } from "@mono-agent/memory/search";
import { describe, expect, it } from "vitest";

import { isFtsFallbackEligible } from "../memory-command.js";
import type { MemoryRecallSettings } from "../memory-recall.js";

const semanticSettings: MemoryRecallSettings = {
  root: "/memory",
  embeddings: { provider: "ollama", model: "test-embed" },
};

const fallbackMemorySearchCodes = [
  "embedding_circuit_open",
  "embedding_request_failed",
  "embedding_response_invalid",
  "invalid_embedding_options",
] as const satisfies readonly MemorySearchErrorCode[];

describe("isFtsFallbackEligible", () => {
  it.each(fallbackMemorySearchCodes)("accepts the typed provider failure code %s", (code) => {
    expect(isFtsFallbackEligible(semanticSettings, new MemorySearchError(code, "provider unavailable"))).toBe(true);
  });

  it("accepts a real fetch failure with a structured network cause", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    });
    const error = Object.assign(new TypeError("fetch failed"), { cause });

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(true);
  });

  it("accepts bounded AggregateError network causes", () => {
    const nested = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
    const error = new AggregateError([new AggregateError([nested], "nested fetch failures")], "fetch failed");

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(true);
  });

  it("accepts provider aborts and timeouts represented as AbortError", () => {
    const timeout = new DOMException("This operation was aborted", "AbortError");

    expect(isFtsFallbackEligible(semanticSettings, timeout)).toBe(true);
  });

  it.each([
    ["a bare TypeError", new TypeError("request failed")],
    [
      "a programming TypeError whose message mentions ECONNREFUSED",
      new TypeError("Cannot read properties of undefined (reading 'ECONNREFUSED')"),
    ],
    ["an invariant Error whose message mentions embedding", new Error("embedding adapter invariant violated")],
    [
      "a fetch-shaped TypeError with an unknown cause code",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("permission denied"), { code: "EACCES" }),
      }),
    ],
    [
      "a TypeError with only a top-level network code",
      Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }),
    ],
    [
      "an untyped lookalike provider error",
      Object.assign(new Error("provider failed"), {
        name: "MemorySearchError",
        code: "embedding_request_failed",
      }),
    ],
    ["a typed index error", new MemorySearchError("index_read_failed", "index read failed")],
    ["an unknown non-error cause", { cause: { code: "ECONNREFUSED" } }],
  ])("rejects %s", (_label, error) => {
    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("never falls back without configured local embeddings", () => {
    const providerError = new MemorySearchError("embedding_request_failed", "provider unavailable");

    expect(isFtsFallbackEligible({ root: "/memory" }, providerError)).toBe(false);
    expect(isFtsFallbackEligible({
      supermemory: { baseUrl: "https://example.invalid", container: "agent" },
    }, providerError)).toBe(false);
  });
});
