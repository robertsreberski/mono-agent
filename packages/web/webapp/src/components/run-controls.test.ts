import { describe, expect, it } from "vitest";
import type { ThreadDetail, WebMessage } from "../types";
import { modelChangeNotice, modelChangeNoticeInput } from "./run-controls";

const assistantMessage = (
  id: string,
  attribution?: WebMessage["attribution"],
): WebMessage => ({
  id,
  threadId: "thread",
  role: "assistant",
  parts: [],
  attachments: [],
  createdAt: "2026-09-09T10:00:00.000Z",
  updatedAt: "2026-09-09T10:00:00.000Z",
  status: "complete",
  ...(attribution === undefined ? {} : { attribution }),
});

const detail = (messages: readonly WebMessage[]): ThreadDetail => ({
  thread: {
    id: "thread",
    sourceId: "agent",
    title: "Thread",
    archivedAt: null,
    projectId: null,
  tagIds: [],
    createdAt: "2026-09-09T10:00:00.000Z",
    updatedAt: "2026-09-09T10:00:00.000Z",
    revision: 1,
    messageCount: messages.length,
    runState: { status: "complete" },
    canSend: true,
    canUpload: true,
  },
  messages,
});

const attribution = (
  requestedModel: string,
  executedModel = requestedModel,
): NonNullable<WebMessage["attribution"]> => ({
  requested: { model: requestedModel, effort: "high" },
  executed: { model: executedModel, effort: "high" },
  disposition: requestedModel === executedModel ? "requested" : "fallback",
  transitions: [],
  retries: [],
});

describe("modelChangeNotice", () => {
  it("returns null without an assistant message", () => {
    expect(modelChangeNotice(modelChangeNoticeInput(detail([]), "provider:one"))).toBeNull();
  });

  it("keeps the notice out of a new-thread draft", () => {
    expect(modelChangeNotice(modelChangeNoticeInput(null, "provider:two"))).toBeNull();
  });

  it("returns null when assistant messages carry no attribution", () => {
    expect(modelChangeNotice(modelChangeNoticeInput(
      detail([assistantMessage("assistant")]),
      "provider:one",
    ))).toBeNull();
  });

  it("ignores effort when the selected and last requested models match", () => {
    expect(modelChangeNotice(modelChangeNoticeInput(
      detail([assistantMessage("assistant", attribution("provider:one"))]),
      "provider:one",
    ))).toBeNull();
  });

  it("reports a pending cold turn when the selected model differs", () => {
    expect(modelChangeNotice(modelChangeNoticeInput(
      detail([assistantMessage("assistant", attribution("provider:one"))]),
      "provider:two",
    ))).toEqual({ kind: "pending_cold_turn" });
  });

  it("compares against requested rather than a fallback's executed model", () => {
    expect(modelChangeNotice(modelChangeNoticeInput(
      detail([assistantMessage("assistant", attribution("provider:one", "provider:fallback"))]),
      "provider:one",
    ))).toBeNull();
  });

  it("uses the last attributed assistant message", () => {
    expect(modelChangeNoticeInput(detail([
      assistantMessage("first", attribution("provider:one")),
      assistantMessage("second"),
    ]), "provider:two").lastRequestedModel).toBe("provider:one");
  });
});
