/**
 * The single source of truth for tool names, shared by the wizard, doctor, and
 * tests. Names are exact and case-sensitive, verified against the runtime's
 * `pi-bridge.js` (built-ins) and `adapter-send-tools.ts` (adapter send tools).
 */

import { ALLOW_ALL_TOOLS } from "@mono-agent/config";

/** Re-export the allow-all sentinel so agent-app callers share one canonical value. */
export { ALLOW_ALL_TOOLS };

/** Built-in tools gated by `tools.allowedTools` (pi-bridge.js). */
export const BUILTIN_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "WebSearch",
] as const;

/** Adapter send tools — require BOTH an `allowedTools` entry AND an enabled channel. */
export const ADAPTER_SEND_TOOL_NAMES = [
  "slack_send_message",
  "telegram_send_message",
  "telegram_ask",
  "telegram_send_document",
  "telegram_send_photo",
  "ask_user",
] as const;

/** Safe read-only default pre-checked for every new agent. */
export const DEFAULT_SAFE_TOOLS = ["Read", "Glob", "Grep"] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];
export type AdapterSendToolName = (typeof ADAPTER_SEND_TOOL_NAMES)[number];

/** All offline-knowable tool names (built-in ∪ adapter send). */
const KNOWN_TOOL_NAMES: readonly string[] = [...BUILTIN_TOOL_NAMES, ...ADAPTER_SEND_TOOL_NAMES];

/** True when `name` is a built-in or an adapter send tool (exact, case-sensitive match). */
export function isKnownToolName(name: string): boolean {
  return name === ALLOW_ALL_TOOLS || KNOWN_TOOL_NAMES.includes(name);
}

/** True when `list` contains the global allow-all sentinel (`"*"`). */
export function isAllowAllTools(list: readonly string[]): boolean {
  return list.includes(ALLOW_ALL_TOOLS);
}

/** True when `name` targets an MCP server tool (`mcp__…`) — cannot be validated offline. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * The closest known tool name for a typo, case-insensitive (e.g. `read` → `Read`),
 * else undefined. Used by doctor for "did you mean" hints. Matches
 * case-insensitively against BUILTIN ∪ ADAPTER_SEND.
 */
export function suggestToolName(name: string): string | undefined {
  const lowered = name.toLowerCase();
  return KNOWN_TOOL_NAMES.find((known) => known.toLowerCase() === lowered);
}
