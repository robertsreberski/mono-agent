import { describe, expect, it } from "vitest";

import {
  segmentTimelineTurns,
  type RecordedRunTimelineItem,
} from "../index.js";

function item(input: {
  readonly index: number;
  readonly category: RecordedRunTimelineItem["category"];
  readonly label: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly type?: string;
  readonly timestamp?: string | undefined;
  readonly endTimestamp?: string;
  readonly contentChars?: number;
}): RecordedRunTimelineItem {
  return {
    index: input.index,
    category: input.category,
    label: input.label,
    summary: input.summary,
    payload: input.payload,
    sourceEventCount: 1,
    sourceEventStartIndex: input.index,
    sourceEventEndIndex: input.index,
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
    ...(input.endTimestamp === undefined ? {} : { endTimestamp: input.endTimestamp }),
    ...(input.contentChars === undefined ? {} : { contentChars: input.contentChars }),
  };
}

/** thinking -> tool_use -> tool_result -> thinking -> text, optionally timestamped. */
function twoTurnFixture(withTimestamps: boolean): readonly RecordedRunTimelineItem[] {
  const ts = (n: number) => (withTimestamps ? `2026-07-01T00:00:0${n}.000Z` : undefined);
  return [
    item({
      index: 0,
      type: "assistant",
      category: "thinking",
      label: "Assistant thoughts",
      summary: "considering",
      payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "considering" }] } },
      contentChars: 23,
      timestamp: ts(0),
    }),
    item({
      index: 1,
      type: "assistant",
      category: "tool",
      label: "Tool: Read",
      summary: '{"path":"/etc/hosts"}',
      payload: {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/etc/hosts" } }] },
      },
      timestamp: ts(1),
    }),
    item({
      index: 2,
      type: "user",
      category: "tool",
      label: "Tool result",
      summary: "file contents",
      payload: {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }] },
      },
      timestamp: ts(2),
    }),
    item({
      index: 3,
      type: "assistant",
      category: "thinking",
      label: "Assistant thoughts",
      summary: "done reading",
      payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "done reading" }] } },
      contentChars: 10,
      timestamp: ts(3),
    }),
    item({
      index: 4,
      type: "assistant",
      category: "message",
      label: "Assistant message",
      summary: "Here is the file.",
      payload: { type: "assistant", message: { content: [{ type: "text", text: "Here is the file." }] } },
      timestamp: ts(4),
    }),
  ];
}

describe("segmentTimelineTurns", () => {
  it("splits a thinking -> tool_use -> tool_result -> thinking -> text run into 2 turns with correct indices/counts", () => {
    const turns = segmentTimelineTurns(twoTurnFixture(true));

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      turnIndex: 0,
      startItemIndex: 0,
      endItemIndex: 2,
      startedAt: "2026-07-01T00:00:00.000Z",
      durationMs: 2000,
      thinkingChars: 23,
      toolCalls: 1,
    });
    expect(turns[1]).toMatchObject({
      turnIndex: 1,
      startItemIndex: 3,
      endItemIndex: 4,
      startedAt: "2026-07-01T00:00:03.000Z",
      durationMs: 1000,
      thinkingChars: 10,
      toolCalls: 0,
    });
  });

  it("reports undefined startedAt/durationMs but correct counts when no item carries a timestamp", () => {
    const turns = segmentTimelineTurns(twoTurnFixture(false));

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ startItemIndex: 0, endItemIndex: 2, thinkingChars: 23, toolCalls: 1 });
    expect(turns[0]?.startedAt).toBeUndefined();
    expect(turns[0]?.durationMs).toBeUndefined();
    expect(turns[1]).toMatchObject({ startItemIndex: 3, endItemIndex: 4, thinkingChars: 10, toolCalls: 0 });
    expect(turns[1]?.startedAt).toBeUndefined();
    expect(turns[1]?.durationMs).toBeUndefined();
  });

  it("returns exactly one turn covering all items when there are no tool_result boundaries", () => {
    const items: readonly RecordedRunTimelineItem[] = [
      item({
        index: 0,
        type: "assistant",
        category: "thinking",
        label: "Assistant thoughts",
        summary: "considering",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "considering" }] } },
        contentChars: 11,
      }),
      item({
        index: 1,
        type: "assistant",
        category: "message",
        label: "Assistant message",
        summary: "done",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      }),
    ];

    const turns = segmentTimelineTurns(items);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turnIndex: 0, startItemIndex: 0, endItemIndex: 1, thinkingChars: 11, toolCalls: 0 });
  });

  it("returns an empty array for empty input", () => {
    expect(segmentTimelineTurns([])).toEqual([]);
  });

  it("does not open a new (empty) turn when a tool_result is the final item", () => {
    const items: readonly RecordedRunTimelineItem[] = [
      item({
        index: 0,
        type: "assistant",
        category: "tool",
        label: "Tool: Read",
        summary: "{}",
        payload: { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] } },
      }),
      item({
        index: 1,
        type: "user",
        category: "tool",
        label: "Tool result",
        summary: "ok",
        payload: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        },
      }),
    ];

    const turns = segmentTimelineTurns(items);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ startItemIndex: 0, endItemIndex: 1, toolCalls: 1 });
  });

  it("does not crash or create a boundary on a malformed user payload (content not an array)", () => {
    const items: readonly RecordedRunTimelineItem[] = [
      item({
        index: 0,
        type: "user",
        category: "message",
        label: "Message: user",
        summary: "weird shape",
        payload: { type: "user", message: { content: "not-an-array" } },
      }),
      item({
        index: 1,
        type: "assistant",
        category: "message",
        label: "Assistant message",
        summary: "ok",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      }),
    ];

    expect(() => segmentTimelineTurns(items)).not.toThrow();
    const turns = segmentTimelineTurns(items);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ startItemIndex: 0, endItemIndex: 1 });
  });

  it("does not crash on a user item with a non-record payload", () => {
    const items: readonly RecordedRunTimelineItem[] = [
      item({ index: 0, type: "user", category: "message", label: "Message: user", summary: "n/a", payload: "just a string" }),
      item({ index: 1, type: "assistant", category: "message", label: "assistant", summary: "ok", payload: {} }),
    ];

    expect(() => segmentTimelineTurns(items)).not.toThrow();
    expect(segmentTimelineTurns(items)).toHaveLength(1);
  });
});
