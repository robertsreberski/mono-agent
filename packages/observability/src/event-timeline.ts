import type {
  RecordedRunEvent,
  RecordedRunTimelineItem,
} from "./types.js";

type AssistantStreamKind = "thinking" | "text";

interface AssistantStreamChunk {
  readonly kind: AssistantStreamKind;
  readonly text: string | undefined;
}

const SUMMARY_MAX_CHARS = 220;

export function combineRecordedRunEvents(events: readonly RecordedRunEvent[]): readonly RecordedRunTimelineItem[] {
  const timeline: RecordedRunTimelineItem[] = [];
  let index = 0;
  while (index < events.length) {
    const current = events[index];
    if (current === undefined) {
      break;
    }
    const currentChunk = assistantStreamChunk(current);
    if (currentChunk === undefined) {
      timeline.push(singleEventItem(current));
      index += 1;
      continue;
    }

    const group = [current];
    const chunks = [currentChunk];
    let nextIndex = index + 1;
    while (nextIndex < events.length) {
      const next = events[nextIndex];
      const nextChunk = next === undefined ? undefined : assistantStreamChunk(next);
      if (next === undefined || nextChunk === undefined || nextChunk.kind !== currentChunk.kind) {
        break;
      }
      group.push(next);
      chunks.push(nextChunk);
      nextIndex += 1;
    }

    timeline.push(group.length === 1 ? singleEventItem(current) : combinedEventItem(group, chunks));
    index = nextIndex;
  }
  return timeline;
}

function singleEventItem(event: RecordedRunEvent): RecordedRunTimelineItem {
  return {
    ...event,
    sourceEventCount: 1,
    sourceEventStartIndex: event.index,
    sourceEventEndIndex: event.index,
  };
}

function combinedEventItem(
  events: readonly RecordedRunEvent[],
  chunks: readonly AssistantStreamChunk[],
): RecordedRunTimelineItem {
  const first = events[0];
  const firstChunk = chunks[0];
  if (first === undefined || firstChunk === undefined) {
    throw new Error("combinedEventItem requires at least one source event");
  }
  const last = events[events.length - 1] ?? first;
  const kind = firstChunk.kind;
  const summary = compactString(chunks.map((chunk) => chunk.text ?? "").join("") || events.map((event) => event.summary).join(" "));
  return {
    index: first.index,
    ...(first.type === undefined ? {} : { type: first.type }),
    category: kind === "thinking" ? "thinking" : "message",
    ...(first.timestamp === undefined ? {} : { timestamp: first.timestamp }),
    label: kind === "thinking" ? "Assistant thoughts" : "Assistant message",
    summary,
    payload: {
      type: "assistant.timeline.combined",
      contentKind: kind,
      sourceEventCount: events.length,
      sourceEventStartIndex: first.index,
      sourceEventEndIndex: last.index,
      preview: summary,
    },
    sourceEventCount: events.length,
    sourceEventStartIndex: first.index,
    sourceEventEndIndex: last.index,
  };
}

function assistantStreamChunk(event: RecordedRunEvent): AssistantStreamChunk | undefined {
  if (event.type !== "assistant" || !isRecord(event.payload)) {
    return undefined;
  }
  const message = event.payload.message;
  if (!isRecord(message) || !Array.isArray(message.content) || message.content.length === 0) {
    return undefined;
  }

  let kind: AssistantStreamKind | undefined;
  const texts: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || (block.type !== "thinking" && block.type !== "text")) {
      return undefined;
    }
    if (kind === undefined) {
      kind = block.type;
    } else if (kind !== block.type) {
      return undefined;
    }
    const text = blockText(block, block.type);
    if (text !== undefined) {
      texts.push(text);
    }
  }
  if (kind === undefined) {
    return undefined;
  }
  return {
    kind,
    text: texts.length > 0 ? texts.join("") : undefined,
  };
}

function blockText(block: Record<string, unknown>, kind: AssistantStreamKind): string | undefined {
  const value = kind === "thinking"
    ? stringField(block, "thinking") ?? stringField(block, "text") ?? stringField(block, "content")
    : stringField(block, "text") ?? stringField(block, "content");
  return value;
}

function compactString(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= SUMMARY_MAX_CHARS) {
    return compact;
  }
  return `${compact.slice(0, SUMMARY_MAX_CHARS)}…`;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
