import { describe, expect, it } from "vitest";

import type { RecordedRunListItem } from "@mono-agent/observability";

import { buildRunsHealthDisplay } from "../runs-health.js";

describe("buildRunsHealthDisplay", () => {
  it("surfaces explicit user cancellation without degrading health", () => {
    const run: RecordedRunListItem = {
      runId: "run-cancelled-user",
      conversationId: "telegram:42",
      status: "cancelled",
      failureKind: "cancelled_user",
      durationMs: 10,
      eventCount: 0,
      updatedAt: "2026-07-12T08:00:00.000Z",
    };

    const display = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [run],
      warnings: [],
      nowMs: Date.parse("2026-07-12T08:01:00.000Z"),
    });

    expect(display.status).toBe("ok");
    expect(display.details).toContain(
      "User-cancelled runs: 1 (expected lifecycle outcome; health unchanged).",
    );
    expect(display.details.join("\n")).not.toContain("[WARN]");
  });
});
