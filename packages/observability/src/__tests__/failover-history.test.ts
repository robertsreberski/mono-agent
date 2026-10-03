import { describe, expect, it } from "vitest";

import { normalizeFailoverHistory } from "../failover-history.js";

describe("normalizeFailoverHistory", () => {
  it("normalizes router attempts and is idempotent", () => {
    const normalized = normalizeFailoverHistory([
      {
        model: { reference: "openai-codex:gpt" },
        failureKind: "provider_unavailable",
        retryableSubkind: "overloaded",
        requestId: "req-1",
        retryIndex: 1,
      },
      { model: "anthropic:claude", failureKind: "cancelled" },
    ]);
    expect(normalized).toEqual([
      {
        model: "openai-codex:gpt",
        failureKind: "provider_unavailable",
        subkind: "overloaded",
        requestId: "req-1",
        retryIndex: 1,
      },
      { model: "anthropic:claude", failureKind: "cancelled" },
    ]);
    expect(normalizeFailoverHistory(normalized)).toEqual(normalized);
  });

  it("drops unrecordable input", () => {
    expect(normalizeFailoverHistory(undefined)).toBeUndefined();
    expect(normalizeFailoverHistory([])).toBeUndefined();
    expect(normalizeFailoverHistory([{}, { model: null }])).toBeUndefined();
  });
});
