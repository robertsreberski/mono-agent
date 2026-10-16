import type { RuntimeEventLike } from "@mono-agent/turn/host/types";
export const DIRECT_TOOL_EVENT_TYPES = new Set([
  "bash",
  "collab_agent_tool_call",
  "command_execution",
  "dynamic_tool_call",
  "file_change",
  "image_generation",
  "image_view",
  "mcp_tool_call",
  "sleep",
  "subagent_activity",
  "tool_call",
  "tool_result",
  "tool_use",
  "web_search",
]);

function normalizedEventType(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[./-]+/gu, "_").toLowerCase()
    : "";
}

export function toolActionInEvent(event: RuntimeEventLike): string | undefined {
  const eventType = normalizedEventType(event.type);
  if (DIRECT_TOOL_EVENT_TYPES.has(eventType)) {
    return eventType;
  }
  const item = event.item;
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const itemType = normalizedEventType((item as Record<string, unknown>).type);
    if (DIRECT_TOOL_EVENT_TYPES.has(itemType)) {
      return itemType;
    }
  }
  const message = event.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return undefined;
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      continue;
    }
    const blockType = normalizedEventType((block as Record<string, unknown>).type);
    if (blockType === "tool_use" || blockType === "tool_call" || blockType === "tool_result") {
      return blockType;
    }
  }
  return undefined;
}
