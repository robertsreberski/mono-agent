import { describe, expect, it } from "vitest";
import { isConversationMarker } from "./conversation-markers";

describe("compaction marker validation", () => {
  const marker = { type: "conversation-marker", kind: "compaction", at: "2026-01-15T10:00:00Z", operationId: "fictional-op", trigger: "automatic", status: "skipped" };
  it("accepts terminal markers and rejects unknown or malformed kinds", () => {
    expect(isConversationMarker(marker)).toBe(true);
    expect(isConversationMarker({ ...marker, status: "running" })).toBe(false);
    expect(isConversationMarker({ ...marker, kind: "future" })).toBe(false);
    expect(isConversationMarker({ ...marker, tokensBefore: Number.NaN })).toBe(false);
  });
});
