import { classifyAssistantContent, compactString } from "./content.js";
import { isRecord, stringField } from "./guards.js";
import { DEFAULT_MAX_STRING_BYTES } from "./guards.js";
import { redactJsonValue } from "./redaction.js";
import type { RecordedRunEventCategory, RuntimeEventLike } from "./types.js";

/**
 * Node-free event classification + label/summary derivation shared by the
 * recorded-run reader and the export-mapping surface. {@link buildEventDescriptors}
 * is the single source of truth that bridges a RAW {@link RuntimeEventLike}
 * (what `onEvent` receives) to a {@link RecordedRunEventDescriptors} bundle; the
 * reader's `toRecordedEvent` and the export mapping both go through it so their
 * category/label/summary outputs always agree.
 */

export interface RecordedRunEventDescriptors {
  readonly category: RecordedRunEventCategory;
  readonly label: string;
  readonly summary: string;
}

export function classifyRecordedRunEvent(event: unknown): RecordedRunEventCategory {
  if (!isRecord(event)) {
    return "runtime";
  }
  const type = stringField(event, "type")?.toLowerCase() ?? "";
  if (
    type.includes("error") ||
    type.includes("failure") ||
    type.includes("failed") ||
    event.error !== undefined ||
    event.failureKind !== undefined
  ) {
    return "error";
  }
  if (
    type.includes("tool") ||
    stringField(event, "toolName") !== undefined ||
    stringField(event, "tool") !== undefined ||
    stringField(event, "tool_call_id") !== undefined ||
    stringField(event, "toolCallId") !== undefined
  ) {
    return "tool";
  }
  if (type.includes("thinking") || type.includes("reasoning") || type.includes("thought")) {
    return "thinking";
  }
  if (assistantMessageContentKind(event) === "thinking") {
    return "thinking";
  }
  // Runtime control events (e.g. `runtime_warning`) carry a human-readable
  // `message` string, so they must be classified by type BEFORE the generic
  // message-field heuristic below — otherwise they are mis-filed as "message".
  if (type === "runtime_warning") {
    return "runtime";
  }
  if (type === "assistant" || type === "user" || type.includes("message") || event.message !== undefined) {
    return "message";
  }
  return "runtime";
}

export function eventLabel(record: Record<string, unknown>, category: RecordedRunEventCategory, type: string | undefined): string {
  const toolName = stringField(record, "toolName") ?? stringField(record, "tool") ?? stringField(record, "name");
  if (category === "tool" && toolName !== undefined) {
    return `Tool: ${toolName}`;
  }
  const role = stringField(record, "role");
  if (category === "message" && role !== undefined) {
    return `Message: ${role}`;
  }
  if (category === "thinking") {
    return type ?? "Reasoning event";
  }
  if (category === "error") {
    return type ?? stringField(record, "failureKind") ?? "Error";
  }
  return type ?? "Runtime event";
}

export function eventSummary(
  record: Record<string, unknown>,
  category: RecordedRunEventCategory,
  payload: unknown,
  maxStringBytes: number,
): string {
  const direct = stringField(record, "summary") ?? stringField(record, "text") ?? stringField(record, "delta") ?? stringField(record, "error");
  if (direct !== undefined) {
    return compactString(direct);
  }
  const messageText = textFromMessage(record.message);
  if (messageText !== undefined) {
    return compactString(messageText);
  }
  if (category === "tool") {
    const status = stringField(record, "status") ?? stringField(record, "state");
    const toolName = stringField(record, "toolName") ?? stringField(record, "tool") ?? stringField(record, "name");
    if (toolName !== undefined && status !== undefined) {
      return `${toolName} — ${status}`;
    }
    if (toolName !== undefined) {
      return toolName;
    }
  }
  if (category === "thinking") {
    return "Runtime emitted a reasoning/thinking process event.";
  }
  return compactString(JSON.stringify(redactJsonValue(payload, maxStringBytes)));
}

export function textFromMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const content = value.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}

export function assistantMessageContentKind(event: Record<string, unknown>): "thinking" | "text" | undefined {
  if (stringField(event, "type") !== "assistant") {
    return undefined;
  }
  return classifyAssistantContent(event.message)?.kind;
}

/**
 * Single source of truth bridging a RAW {@link RuntimeEventLike} to its
 * {category, label, summary} descriptors. Mirrors the recorded-run reader's
 * `toRecordedEvent` parse path: redact the raw event first, classify the
 * redacted payload, then derive the label/summary from the redacted record.
 */
export function buildEventDescriptors(
  event: RuntimeEventLike,
  maxStringBytes = DEFAULT_MAX_STRING_BYTES,
): RecordedRunEventDescriptors {
  const payload = redactJsonValue(event, maxStringBytes);
  const category = classifyRecordedRunEvent(payload);
  const record = isRecord(payload) ? payload : {};
  const type = stringField(record, "type");
  return {
    category,
    label: eventLabel(record, category, type),
    summary: eventSummary(record, category, payload, maxStringBytes),
  };
}
