import { describe, expect, it } from "vitest";
import { isConversationMarker } from "../conversation-markers.js";
import { composeConversationMarkers } from "../project-context.js";

describe("compaction conversation markers", () => {
  const marker = { type: "conversation-marker" as const, kind: "compaction" as const, at: "2026-01-15T10:00:00Z", operationId: "fictional-op", trigger: "manual" as const, status: "succeeded" as const, tokensBefore: 183_400, tokensAfter: 41_300 };
  it("validates terminal outcomes without accepting invalid counts or state", () => {
    expect(isConversationMarker(marker)).toBe(true);
    expect(isConversationMarker({ ...marker, status: "running" })).toBe(false);
    expect(isConversationMarker({ ...marker, tokensAfter: -1 })).toBe(false);
    expect(isConversationMarker({ ...marker, operationId: "" })).toBe(false);
    expect(isConversationMarker({ ...marker, status: "skipped", reason: "model_changed" })).toBe(true);
    expect(isConversationMarker({ ...marker, status: "failed", reason: "private provider error" })).toBe(false);
  });
  it("dispatches short prose for succeeded and failed compaction", () => {
    expect(composeConversationMarkers([marker])).toContain("context compacted (manual) at");
    expect(composeConversationMarkers([marker])).toContain("183,400 → about 41,300 tokens");
    const failed = composeConversationMarkers([{ ...marker, status: "failed" as const, trigger: "automatic" as const }]);
    expect(failed).toContain("context compaction failed (automatic)");
    expect(failed).not.toContain("183,400");
    expect(failed).not.toContain("41,300");
    const skipped = composeConversationMarkers([{ ...marker, status: "skipped" as const, reason: "model_changed" as const }]);
    expect(skipped).toContain(": model changed");
    expect(skipped).not.toContain("183,400");
  });
});
