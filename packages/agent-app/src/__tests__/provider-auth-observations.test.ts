import { describe, expect, it } from "vitest";

import { createProviderAuthObservationTracker } from "../provider-auth-observations.js";

describe("provider auth observations", () => {
  it("attributes fallback failures, verifies only the successful provider, and clears later failures", () => {
    let now = Date.parse("2026-09-06T12:00:00.000Z");
    const tracker = createProviderAuthObservationTracker(() => now);
    tracker.observe({
      runId: "run-1", conversationId: "web:1", status: "succeeded", durationMs: 1, eventCount: 0, artifactPaths: [],
      model: "openai-codex:gpt-5.6-terra",
      failoverHistory: [{ model: "anthropic:claude-sonnet-4-5", failureKind: "provider_auth" }],
    });
    expect(tracker.get("anthropic")?.failure).toMatchObject({ kind: "provider_auth", message: "Provider rejected the configured credential." });
    expect(tracker.get("openai-codex")?.verifiedAt).toBe("2026-09-06T12:00:00.000Z");

    now += 1_000;
    tracker.observe({
      runId: "run-2", conversationId: "web:1", status: "succeeded", durationMs: 1, eventCount: 0, artifactPaths: [],
      model: "anthropic:claude-sonnet-4-5",
    });
    expect(tracker.get("anthropic")).toEqual({ verifiedAt: "2026-09-06T12:00:01.000Z" });
  });

  it("expires failure warnings after 24 hours without inventing verification", () => {
    let now = 1_000;
    const tracker = createProviderAuthObservationTracker(() => now);
    tracker.observe({
      runId: "run", conversationId: "web:1", status: "failed", durationMs: 1, eventCount: 0, artifactPaths: [],
      model: "openai:gpt-5.5", failureKind: "provider_unavailable", error: "raw secret-shaped provider text",
    });
    expect(tracker.get("openai")?.failure?.message).toBe("Provider was unavailable.");
    now += 24 * 60 * 60 * 1_000;
    expect(tracker.get("openai")).toBeUndefined();
  });

  it("retains only current used providers and caps pre-status observations", () => {
    const tracker = createProviderAuthObservationTracker(() => Date.parse("2026-09-06T12:00:00.000Z"));
    for (let index = 0; index < 70; index += 1) {
      tracker.observe({
        runId: `run-${index}`,
        conversationId: "web:1",
        durationMs: 1,
        eventCount: 0,
        artifactPaths: [],
        status: "failed",
        model: `provider-${index}:model`,
        failureKind: "provider_unavailable",
      });
    }
    expect(tracker.get("provider-0")).toBeUndefined();
    expect(tracker.get("provider-69")).toBeDefined();
    tracker.retainProviders(["provider-69"]);
    expect(tracker.get("provider-68")).toBeUndefined();
    expect(tracker.get("provider-69")).toBeDefined();
  });
});
