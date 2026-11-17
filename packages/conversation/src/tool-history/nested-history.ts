/** Retrieval output must not recursively become another retained evidence body. */
export const HISTORY_TOOL_NAME = "History";
export const HISTORY_MCP_SERVER_NAME = "mono-agent-history";
export const HISTORY_MCP_TOOL_NAME = `mcp__${HISTORY_MCP_SERVER_NAME}__${HISTORY_TOOL_NAME}`;

// Historical names classify retained data only; they never authorize calls.
const LEGACY_HISTORY_TOOL_ALIASES = ["ConversationHistory", "conversation_history", "SessionHistory", "session_history", "RunHistory", "run_history"] as const;
export interface NestedHistoryOptions {
  /** Positive ownership supplied by the app host, never inferred from a name. */
  readonly appOwnedHistory?: boolean;
}
export interface HistoryToolAvailability {
  readonly said: boolean;
  readonly tools: boolean;
  readonly runs: boolean;
}
export function isNestedHistoryTool(name: string, options?: NestedHistoryOptions): boolean {
  if (name === HISTORY_MCP_TOOL_NAME || name === HISTORY_TOOL_NAME) return options?.appOwnedHistory === true;
  return LEGACY_HISTORY_TOOL_ALIASES.some(alias => name === alias || name.endsWith(`__${alias}`));
}
export const NESTED_HISTORY_OMISSION = "[nested history-tool result omitted; inspect the referenced source directly]";
