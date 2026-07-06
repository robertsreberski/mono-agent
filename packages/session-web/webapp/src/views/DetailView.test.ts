import { describe, expect, test } from "vitest";

import { boundaryStepLabel, boundaryStepMeta, timelineEmptyMessage } from "./DetailView";

describe("timelineEmptyMessage", () => {
  test("shows a live waiting state for running runs with no timeline items", () => {
    expect(timelineEmptyMessage("running", 0)).toBe("Waiting for live events...");
  });

  test("shows a captured-empty state for terminal runs with no timeline items", () => {
    expect(timelineEmptyMessage("succeeded", 0)).toBe("No timeline events captured.");
  });

  test("does not show an empty state once timeline items are present", () => {
    expect(timelineEmptyMessage("running", 1)).toBeUndefined();
  });
});

describe("boundary timeline helpers", () => {
  test("formats known boundary kinds for compact display", () => {
    expect(boundaryStepLabel("rollover")).toBe("Session rollover");
    expect(boundaryStepLabel("isolated")).toBe("Isolated session");
    expect(boundaryStepLabel("resume_replay")).toBe("Resume replay");
  });

  test("keeps boundary identity metadata in a mobile-safe single line", () => {
    expect(boundaryStepMeta({
      k: "boundary",
      ts: "2026-07-06T10:00:00.000Z",
      kind: "rollover",
      previousConversationId: "chat:old",
      baseConversationId: "chat:base",
      conversationId: "chat:new",
      providerSessionId: "provider-1",
      reason: "daily partition changed",
    })).toBe("previous chat:old | base chat:base | current chat:new | provider provider-1");
  });
});
