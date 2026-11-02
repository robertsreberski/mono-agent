import { LEGACY_TOOL_ALIASES } from "../tools/known-tools.js";

/** App-owned request servers only. MemoryRecall deliberately has no policy gate. */
export const APP_OWNED_MCP_SERVERS: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(Object.entries({
  "mono-agent-conversation-history": ["ConversationHistory"],
  "mono-agent-session-history": ["SessionHistory"],
  "mono-agent-run-history": ["RunHistory"],
  "mono-agent-memory-journal": [],
  "mono-agent-memory-write": [],
  "mono-agent-provider-usage": [],
  "mono-agent-conversation-title": [],
  "mono-agent-suggest-replies": [],
  "mono-agent-restart-proposal": [],
  "mono-agent-reply-artifacts": [],
  "mono-agent-peer-agent": [],
  "mono-agent-console-projects": [],
  "mono-agent-adapter-send": ["SlackSendMessage", "TelegramSendMessage", "TelegramSendFile"],
}).map(([name, aliases]) => [name, Object.freeze(aliases)])));

/**
 * Cloneable, non-authorizing matching data consumed by Pi's MCP bridge. Attach
 * only at app factories, never by guessing ownership from a discovered name.
 * Legacy history aliases are bare-only; adapter aliases also accept MCP spelling.
 */
export function appOwnedMcpServerSpec(serverName: string, spec: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(APP_OWNED_MCP_SERVERS, serverName)) return spec;
  const aliases: Record<string, string[]> = {};
  for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
    if (!APP_OWNED_MCP_SERVERS[serverName]!.includes(canonical)) continue;
    (aliases[canonical] ??= []).push(legacy);
    if (serverName === "mono-agent-adapter-send") aliases[canonical]!.push(`mcp__${serverName}__${legacy}`);
  }
  if (serverName === "mono-agent-reply-artifacts") aliases.PublishReplyFile = ["publish_reply_file"];
  // Mutate only this freshly created spec: spreading would drop existing
  // non-enumerable sandbox/private-capability metadata.
  return Object.assign(spec, { appOwnedTools: { version: 1, aliases } });
}
