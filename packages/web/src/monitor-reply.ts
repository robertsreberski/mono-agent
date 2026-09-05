import { classifyNotifySuppression } from "@mono-agent/agent-contracts";
import type { WebMessagePart } from "./contracts.js";

/** Call only after the store verifies a host-owned Monitor delivery association. */
export function normalizeMonitorTerminalReply(parts: readonly WebMessagePart[]): {
  parts: WebMessagePart[];
  changed: boolean;
} {
  const explicit = parts.flatMap((part, index) => isAssistantMessageBoundary(part, "assistant_message_boundary") ? [index] : []);
  // Current Pi emits usage and an explicit boundary for the same message.
  // Usage is a compatibility fallback, never an additional message end.
  const boundaries = explicit.length > 0 ? explicit
    : parts.flatMap((part, index) => isAssistantMessageBoundary(part, "context_usage") ? [index] : []);
  const lastBoundary = boundaries.at(-1) ?? -1;
  const hasTrailingContent = parts.slice(lastBoundary + 1).some((part) => part.type === "text" || part.type === "reasoning");
  const end = lastBoundary >= 0 && !hasTrailingContent ? lastBoundary : parts.length;
  let start = end === lastBoundary ? (boundaries.at(-2) ?? -1) + 1 : lastBoundary + 1;
  // Older providers without explicit boundaries still separate tool messages.
  for (let index = start; index < end; index += 1) {
    if (parts[index]?.type === "tool-call" || parts[index]?.type === "subagent") start = index + 1;
  }
  const textParts = parts.slice(start, end).filter((part) => part.type === "text");
  // Without a provider boundary, separate prose parts may be separate assistant
  // messages. Do not concatenate a prior answer into a narrated no-op reply.
  if ((boundaries.length === 0 || start === 0) && textParts.length > 1) return { parts: [...parts], changed: false };
  const text = textParts.map((part) => part.text).join("");
  const suppression = classifyNotifySuppression(text);
  if (suppression !== "sentinel" && suppression !== "narrated-sentinel") {
    return { parts: [...parts], changed: false };
  }
  return {
    parts: parts.filter((part, index) => part.type !== "text" || index < start || index >= end),
    changed: true,
  };
}

export function hasMonitorReplyContent(parts: readonly WebMessagePart[]): boolean {
  return parts.some((part) => part.type === "text" ? part.text.trim().length > 0
    : part.type === "attachment" || part.type === "mcp_app" || part.type === "failure");
}

/** Match the settled console's answer selection, excluding earlier commentary. */
export function monitorReplyText(parts: readonly WebMessagePart[]): string {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === "text") return part.text;
  }
  return "";
}

/** Same bounded legacy telemetry unwrapping contract as the console runtime. */
function isAssistantMessageBoundary(part: WebMessagePart, kind: "assistant_message_boundary" | "context_usage"): boolean {
  if (part.type !== "telemetry") return false;
  let current = part.data;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || seen.has(current)) return false;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.kind === kind) return true;
    current = record.data;
  }
  return false;
}
