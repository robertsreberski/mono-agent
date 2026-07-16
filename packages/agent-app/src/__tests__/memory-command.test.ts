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
const deniedMemorySearchCodes = [
  "invalid_index_options",
  "index_read_failed",
  "index_write_failed",
] as const satisfies readonly MemorySearchErrorCode[];

describe("isFtsFallbackEligible", () => {
  it.each(fallbackMemorySearchCodes)("accepts the typed provider failure code %s", (code) => {
    expect(isFtsFallbackEligible(semanticSettings, new MemorySearchError(code, "provider unavailable"))).toBe(true);
  });

  it.each(deniedMemorySearchCodes)("rejects the typed index failure code %s", (code) => {
    expect(isFtsFallbackEligible(semanticSettings, new MemorySearchError(code, "index failure"))).toBe(false);
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

  it("bounds a huge root AggregateError fan-out before reading or enqueueing every entry", () => {
    const error = new AggregateError(new Array(200_000).fill(null), "many failures");

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("bounds a huge nested AggregateError fan-out before reading or enqueueing every entry", () => {
    const nested = new AggregateError(new Array(200_000).fill(null), "many nested failures");
    const error = new AggregateError([nested], "fetch failed");

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("recognizes a network failure at the exact traversal bound", () => {
    const failures = Array.from({ length: 16 }, () => new Error("unrelated failure"));
    failures[15] = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });

    expect(isFtsFallbackEligible(semanticSettings, new AggregateError(failures, "fetch failed"))).toBe(true);
  });

  it("does not read or recognize a network failure beyond the traversal bound", () => {
    const error = new AggregateError(new Array<Error | null>(17).fill(null), "fetch failed");
    let beyondBoundReads = 0;
    Object.defineProperty(error.errors, 16, {
      configurable: true,
      get() {
        beyondBoundReads += 1;
        return Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
      },
    });

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
    expect(beyondBoundReads).toBe(0);
  });

  it("terminates on cyclic cause graphs", () => {
    const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    error.cause = error;

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
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
