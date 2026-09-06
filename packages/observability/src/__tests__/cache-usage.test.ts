import { describe, expect, it } from "vitest";
import { cacheUsageMetrics } from "../cache-usage.js";

describe("cacheUsageMetrics", () => {
  it("preserves measured zero and computes a weighted ratio", () => {
    expect(cacheUsageMetrics({ input_tokens: 20, cache_read_tokens: 80, cache_creation_tokens: 0 })).toEqual({ inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0, inputTotalTokens: 100, cacheHitRatio: 0.8 });
    expect(cacheUsageMetrics({ input_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })).toEqual({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, inputTotalTokens: 0 });
  });
  it("does not manufacture metrics from absent or invalid counters", () => {
    expect(cacheUsageMetrics({ input_tokens: 20, cache_read_tokens: -1 })).toEqual({ inputTokens: 20 });
  });
});
