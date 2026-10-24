import { expect, it } from "vitest";
import { reconstructionFacts, withSessionBoundaryTimestamp } from "../harness/session-events.js";

it.each(["cancelled_turn_resume", "failed_turn_resume"])("classifies legacy retained %s boundaries", (reason) => {
  expect(withSessionBoundaryTimestamp({ type: "session_boundary", kind: "resume_replay", conversationId: "fictional", reason }, "2030-01-01T00:00:00Z"))
    .toMatchObject({ context: "retained", reason });
});
it("preserves explicit handoffs and original event fields", () => {
  expect(withSessionBoundaryTimestamp({ type: "session_boundary", kind: "resume_replay", context: "handoff",
    reason: "custom_handoff", conversationId: "fictional", timestamp: "2030-01-01T00:00:00Z" }, "later"))
    .toMatchObject({ context: "handoff", reason: "custom_handoff", timestamp: "2030-01-01T00:00:00Z" });
});
it("reports exact UTF-8 sizes and the first timestamped canonical message without content", () => {
  const facts = reconstructionFacts({ history: [
    { role: "user", content: "Fictional old message" },
    { role: "assistant", content: "Fictional answer", timestamp: "2030-01-01T00:00:00Z" },
  ], toolHistoryProjection: "é", toolProjectionRecords: 1 });
  expect(facts).toEqual({ replayedMessageCount: 2, toolProjectionBytes: 2, toolProjectionRecords: 1,
    coverageStartTimestamp: "2030-01-01T00:00:00Z" });
  expect(reconstructionFacts({ history: [], toolHistoryProjection: undefined })).toEqual({ replayedMessageCount: 0, toolProjectionBytes: 0 });
});

it("leaves an unknown legacy producer unclassified rather than guessing", () => {
  expect(withSessionBoundaryTimestamp({ type: "session_boundary", kind: "resume_replay",
    reason: "custom_boundary", conversationId: "fictional" }, "2030-01-01T00:00:00Z"))
    .not.toHaveProperty("context");
});
