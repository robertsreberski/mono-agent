/** Retrieval output must not recursively become another retained evidence body. */

/** App-owned unified history surface. The bare name is only treated as
 * history while the unified mode is active (see NestedHistoryOptions);
 * the exact MCP spelling is always app-owned. Never suffix-match:
 * `mcp__other-server__History` stays ordinary third-party evidence. */
export const HISTORY_TOOL_NAME = "History";
export const HISTORY_MCP_SERVER_NAME = "mono-agent-history";
export const HISTORY_MCP_TOOL_NAME = `mcp__${HISTORY_MCP_SERVER_NAME}__${HISTORY_TOOL_NAME}`;

const LEGACY_HISTORY_TOOL_ALIASES = ["ConversationHistory", "conversation_history", "SessionHistory", "session_history", "RunHistory", "run_history"] as const;

export interface NestedHistoryOptions {
  /** Set while the unified app-owned History surface is active. Bare
   * `History` is only treated as nested history then, so a third-party
   * tool that happens to be called `History` keeps its ordinary
   * retention while the legacy surfaces are offered. */
  readonly unifiedHistory?: boolean;
}

/** Unified History scopes offered for this request. Present on
 * HistoryToolAvailability.history while the unified surface is active. */
export interface UnifiedHistoryAvailability {
  readonly said: boolean;
  readonly tools: boolean;
  readonly runs: boolean;
}

/** `scope "said"` / `scopes "said", "tools"` phrase for unified guidance;
 * undefined when no scope is offered. Order is fixed: said, tools, runs. */
export function unifiedHistoryScopePhrase(scopes: UnifiedHistoryAvailability): string | undefined {
  const names = [...(scopes.said ? [`"said"`] : []), ...(scopes.tools ? [`"tools"`] : []), ...(scopes.runs ? [`"runs"`] : [])];
  if (names.length === 0) return undefined;
  return `${names.length === 1 ? "scope" : "scopes"} ${names.join(", ")}`;
}

export function isNestedHistoryTool(name: string, options?: NestedHistoryOptions): boolean {
  if (name === HISTORY_MCP_TOOL_NAME) return true;
  if (name === HISTORY_TOOL_NAME) return options?.unifiedHistory === true;
  return LEGACY_HISTORY_TOOL_ALIASES
    .some((alias) => name === alias || name.endsWith(`__${alias}`));
}

export const NESTED_HISTORY_OMISSION = "[nested history-tool result omitted; inspect the referenced source directly]";
