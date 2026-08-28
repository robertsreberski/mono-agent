import { describe, expect, it } from "vitest";

import { conversationTitleFromFrame } from "../conversation-title.js";

function completed(overrides: Record<string, unknown> = {}) {
  return {
    kind: "event" as const,
    event: {
      type: "tool_call_completed" as const,
      id: "title-call",
      name: "mcp__mono-agent-conversation-title__SetConversationTitle",
      structuredContent: { schema: 1, title: "  Durable\n topic title  " },
      ...overrides,
    },
  };
}

describe("conversationTitleFromFrame", () => {
  it("accepts the successful app-owned title result and normalizes whitespace", () => {
    expect(conversationTitleFromFrame(completed())).toBe("Durable topic title");
    expect(conversationTitleFromFrame(completed({ name: "SetConversationTitle" }))).toBe("Durable topic title");
  });

  it.each([
    completed({ isError: true }),
    completed({ name: "OtherTool" }),
    completed({ name: "mcp__untrusted-server__SetConversationTitle" }),
    completed({ structuredContent: { schema: 2, title: "Wrong schema" } }),
    completed({ structuredContent: { schema: 1, title: "x".repeat(81) } }),
    completed({ structuredContent: { schema: 1, title: "bad\u0000title" } }),
    { kind: "event", event: { type: "tool_call_started", id: "title-call", name: "SetConversationTitle" } },
  ])("ignores unsuccessful, foreign, or malformed frames", (frame) => {
    expect(conversationTitleFromFrame(frame as never)).toBeUndefined();
  });
});
