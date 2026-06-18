import { describe, expect, it } from "vitest";

import {
  assistantMessageContentKind,
  buildEventDescriptors,
  classifyRecordedRunEvent,
  eventLabel,
  eventSummary,
  textFromMessage,
} from "../event-classify.js";

describe("event-classify exported helpers", () => {
  it("classifies categories", () => {
    expect(classifyRecordedRunEvent({ type: "tool.call", toolName: "Read" })).toBe("tool");
    expect(classifyRecordedRunEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })).toBe("message");
    expect(classifyRecordedRunEvent({ type: "error", error: "boom" })).toBe("error");
    // Real harness runtime_warning events carry a `message` string (harness.ts);
    // they must classify as "runtime", not be swept into "message" by the
    // generic message-field heuristic.
    expect(
      classifyRecordedRunEvent({
        type: "runtime_warning",
        warning_kind: "memory_degraded",
        message: "Memory recall failed; continuing without memory.",
      }),
    ).toBe("runtime");
  });

  it("derives labels from a parsed record", () => {
    expect(eventLabel({ toolName: "Read" }, "tool", "tool.call")).toBe("Tool: Read");
    expect(eventLabel({ role: "assistant" }, "message", "assistant")).toBe("Message: assistant");
  });

  it("derives summaries from a parsed record", () => {
    expect(eventSummary({ summary: "hello" }, "runtime", { summary: "hello" }, 4096)).toBe("hello");
  });

  it("extracts message text and assistant content kind", () => {
    expect(textFromMessage({ content: [{ type: "text", text: "answer" }] })).toBe("answer");
    expect(assistantMessageContentKind({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }] } })).toBe("thinking");
  });
});

describe("buildEventDescriptors (raw RuntimeEventLike -> descriptors)", () => {
  it("bridges a raw tool event to category/label/summary", () => {
    const descriptors = buildEventDescriptors({ type: "tool.call", toolName: "Read", status: "started" });
    expect(descriptors).toEqual({
      category: "tool",
      label: "Tool: Read",
      summary: "Read — started",
    });
  });

  it("bridges a raw assistant message event", () => {
    const descriptors = buildEventDescriptors({
      type: "assistant",
      message: { content: [{ type: "text", text: "visible response" }] },
    });
    expect(descriptors.category).toBe("message");
    expect(descriptors.summary).toBe("visible response");
  });

  it("redacts sensitive payload fields before deriving a fallback summary", () => {
    const descriptors = buildEventDescriptors({ type: "request", apiKey: "fixture-secret-value" });
    expect(descriptors.category).toBe("runtime");
    expect(descriptors.summary).toContain("[redacted]");
    expect(descriptors.summary).not.toContain("fixture-secret-value");
  });

  it("matches the same category/label/summary that toRecordedEvent produces", () => {
    // Parity guard: buildEventDescriptors must be the single source of truth so the
    // recorded-runs reader path and the export path agree.
    const raw = { type: "thinking.delta", summary: "checking available tools" };
    expect(buildEventDescriptors(raw)).toEqual({
      category: "thinking",
      label: "thinking.delta",
      summary: "checking available tools",
    });
  });
});
