import { expect, it } from "vitest";
import { buildHeadline } from "../ui/views/replay-detail.js";

it("shows cancellation as the run outcome, not a provider failover", () => {
  const text = buildHeadline({
    detail: {
      summary: { runId: "cancel", conversationId: "web:test", status: "cancelled", durationMs: 10,
        eventCount: 0, updatedAt: "2026-09-14T00:00:00.000Z",
        failoverHistory: [{ model: "openai-codex:model", failureKind: "cancelled" }] },
      events: [], warnings: [],
    },
    timeline: [], turns: [],
  });
  expect(text).toContain("cancelled");
  expect(text).not.toContain("failover:");
});
