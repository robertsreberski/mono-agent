/** Retrieval output must not recursively become another retained evidence body. */

/** App-owned unified history surface. Both the bare name and the exact MCP
 * spelling are only treated as history while the unified mode is active
 * (see NestedHistoryOptions): server names are not reserved, so a user MCP
 * server called `mono-agent-history` — or any third-party tool called
 * `History` — keeps its ordinary retention while the legacy surfaces are
 * offered. Never suffix-match: `mcp__other-server__History` is never nested. */
export const HISTORY_TOOL_NAME = "History";
export const HISTORY_MCP_SERVER_NAME = "mono-agent-history";
export const HISTORY_MCP_TOOL_NAME = `mcp__${HISTORY_MCP_SERVER_NAME}__${HISTORY_TOOL_NAME}`;

const LEGACY_HISTORY_TOOL_ALIASES = ["ConversationHistory", "conversation_history", "SessionHistory", "session_history", "RunHistory", "run_history"] as const;

export interface NestedHistoryOptions {
  /** Set while the unified app-owned History surface is active. Both the
   * bare `History` name and the exact `mcp__mono-agent-history__History`
   * spelling are only treated as nested history then, so third-party tools
   * keep their ordinary retention while the legacy surfaces are offered. */
  readonly unifiedHistory?: boolean;
}

/** Unified History scopes offered for this request. Present on
 * HistoryToolAvailability.history while the unified surface is active. */
export interface UnifiedHistoryAvailability {
  readonly said: boolean;
  readonly tools: boolean;
  readonly runs: boolean;
}

export function isNestedHistoryTool(name: string, options?: NestedHistoryOptions): boolean {
  if (name === HISTORY_MCP_TOOL_NAME || name === HISTORY_TOOL_NAME) return options?.unifiedHistory === true;
  return LEGACY_HISTORY_TOOL_ALIASES
    .some((alias) => name === alias || name.endsWith(`__${alias}`));
}

export const NESTED_HISTORY_OMISSION = "[nested history-tool result omitted; inspect the referenced source directly]";
