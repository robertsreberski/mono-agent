import { classifyNotifySuppression } from "@mono-agent/agent-contracts";
import type { WebMessagePart } from "./contracts.js";

/** Call only after the store verifies a host-owned Monitor delivery association. */
export function normalizeMonitorTerminalReply(parts: readonly WebMessagePart[]): {
  parts: WebMessagePart[];
  changed: boolean;
} {
  const boundaries = parts.flatMap((part, index) => part.type === "telemetry"
    && part.data !== null && typeof part.data === "object" && !Array.isArray(part.data)
    && (part.data as Record<string, unknown>).type === "runtime_telemetry"
    && (part.data as Record<string, unknown>).kind === "assistant_message_boundary" ? [index] : []);
  const lastBoundary = boundaries.at(-1) ?? -1;
  const hasTrailingContent = parts.slice(lastBoundary + 1).some((part) => part.type === "text" || part.type === "reasoning");
  const end = lastBoundary >= 0 && !hasTrailingContent ? lastBoundary : parts.length;
  let start = end === lastBoundary ? (boundaries.at(-2) ?? -1) + 1 : lastBoundary + 1;
  // Older providers without explicit boundaries still separate tool messages.
  for (let index = start; index < end; index += 1) {
    if (parts[index]?.type === "tool-call" || parts[index]?.type === "subagent") start = index + 1;
  }
  const text = parts.slice(start, end)
    .filter((part) => part.type === "text").map((part) => part.text).join("");
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
