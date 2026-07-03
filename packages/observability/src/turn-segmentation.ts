import { firstToolResultBlock } from "./event-classify.js";
import { isRecord } from "./guards.js";
import type { RecordedRunTimelineItem, TimelineTurn } from "./types.js";

/**
 * Split a run's timeline into agent-loop turns. One recorded run corresponds
 * to one user request; within that run, each turn is delimited by a round
 * trip through a tool: turn 0 starts at the first item, and a new turn starts
 * at the item immediately AFTER each `user` `tool_result` item. Degrades
 * gracefully — no boundaries found yields exactly one turn covering every
 * item, empty input yields an empty array, and malformed/foreign event
 * shapes are simply not treated as boundaries (never thrown).
 */
export function segmentTimelineTurns(items: readonly RecordedRunTimelineItem[]): readonly TimelineTurn[] {
  if (items.length === 0) {
    return [];
  }

  const startIndices: number[] = [0];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const nextIndex = index + 1;
    if (item !== undefined && nextIndex < items.length && isToolResultItem(item)) {
      startIndices.push(nextIndex);
    }
  }

  return startIndices.map((startItemIndex, turnIndex) => {
    const endItemIndex = (startIndices[turnIndex + 1] ?? items.length) - 1;
    const turnItems = items.slice(startItemIndex, endItemIndex + 1);
    return buildTurn(turnIndex, startItemIndex, endItemIndex, turnItems);
  });
}

function buildTurn(
  turnIndex: number,
  startItemIndex: number,
  endItemIndex: number,
  turnItems: readonly RecordedRunTimelineItem[],
): TimelineTurn {
  const startedAt = firstTimestamp(turnItems);
  const durationMs = computeDurationMs(startedAt, turnItems);
  const thinkingChars = turnItems.reduce(
    (sum, item) => sum + (item.category === "thinking" ? item.contentChars ?? 0 : 0),
    0,
  );
  const toolCalls = turnItems.filter((item) => item.category === "tool" && item.type === "assistant").length;
  return {
    turnIndex,
    startItemIndex,
    endItemIndex,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    thinkingChars,
    toolCalls,
  };
}

function firstTimestamp(items: readonly RecordedRunTimelineItem[]): string | undefined {
  for (const item of items) {
    if (item.timestamp !== undefined) {
      return item.timestamp;
    }
  }
  return undefined;
}

function computeDurationMs(startedAt: string | undefined, items: readonly RecordedRunTimelineItem[]): number | undefined {
  if (startedAt === undefined) {
    return undefined;
  }
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) {
    return undefined;
  }
  const last = items[items.length - 1];
  const endTimestamp = last?.endTimestamp ?? last?.timestamp;
  if (endTimestamp === undefined) {
    return undefined;
  }
  const endMs = Date.parse(endTimestamp);
  return Number.isFinite(endMs) ? endMs - startMs : undefined;
}

/**
 * A turn boundary: a `user` event whose message content carries a
 * `tool_result` block. Reuses {@link firstToolResultBlock} (Task 2's
 * block-detection helper) against the item's underlying payload rather than
 * re-walking content blocks here. Any non-record/foreign payload shape simply
 * fails the check instead of throwing.
 */
function isToolResultItem(item: RecordedRunTimelineItem): boolean {
  if (item.type !== "user" || !isRecord(item.payload)) {
    return false;
  }
  return firstToolResultBlock(item.payload) !== undefined;
}
