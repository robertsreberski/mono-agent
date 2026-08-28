import type { AgentStreamWireFrame } from "@mono-agent/agent-contracts";

export const SET_CONVERSATION_TITLE_TOOL_NAME = "SetConversationTitle";
export const SET_CONVERSATION_TITLE_MAX_CHARACTERS = 80;
const SET_CONVERSATION_TITLE_MCP_TOOL_NAME =
  "mcp__mono-agent-conversation-title__SetConversationTitle";

/** Accept only the successful structured result emitted by the app-owned title tool. */
export function conversationTitleFromFrame(frame: AgentStreamWireFrame): string | undefined {
  if (
    frame.kind !== "event"
    || frame.event.type !== "tool_call_completed"
    || frame.event.isError === true
    || typeof frame.event.name !== "string"
    || (
      frame.event.name !== SET_CONVERSATION_TITLE_TOOL_NAME
      && frame.event.name !== SET_CONVERSATION_TITLE_MCP_TOOL_NAME
    )
  ) return undefined;
  const structured = record(frame.event.structuredContent);
  if (structured?.schema !== 1 || typeof structured.title !== "string") return undefined;
  return normalizeConversationTitle(structured.title);
}

function normalizeConversationTitle(value: string): string | undefined {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return undefined;
  const title = value.trim().replace(/\s+/gu, " ");
  if (title.length === 0 || title.length > SET_CONVERSATION_TITLE_MAX_CHARACTERS) return undefined;
  return title;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
