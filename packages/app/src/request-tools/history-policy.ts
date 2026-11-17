import type { HistoryToolAvailability, ToolPolicyInput, UnifiedHistoryAvailability } from "@mono-agent/conversation";

export const HISTORY_MCP_SERVER_NAME = "mono-agent-history";
export const HISTORY_TOOL_NAME = "History";
export const HISTORY_SCOPES = ["said", "tools", "runs"] as const;
export type HistoryScope = (typeof HISTORY_SCOPES)[number];
type Policy = Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">;

export const HISTORY_SCOPE_ALIASES = Object.freeze({
  said: Object.freeze(["ConversationHistory", "conversation_history", "mcp__mono-agent-conversation-history__ConversationHistory", "mcp__mono-agent-conversation-history__*"]),
  tools: Object.freeze(["SessionHistory", "session_history", "mcp__mono-agent-session-history__SessionHistory", "mcp__mono-agent-session-history__*"]),
  runs: Object.freeze(["RunHistory", "run_history", "mcp__mono-agent-run-history__RunHistory", "mcp__mono-agent-run-history__*"]),
});
const UNIFIED_ALIASES = Object.freeze([HISTORY_TOOL_NAME, `mcp__${HISTORY_MCP_SERVER_NAME}__History`, `mcp__${HISTORY_MCP_SERVER_NAME}__*`]);

/** Config-time scope grants. An old-name deny removes only its own scope. */
export function resolveHistoryScopes(policy: Policy, capabilities: UnifiedHistoryAvailability = { said: true, tools: true, runs: true }): readonly HistoryScope[] {
  const allowed = new Set(policy.allowedTools ?? []), denied = new Set(policy.disallowedTools ?? []);
  if (denied.has("*") || UNIFIED_ALIASES.some(alias => denied.has(alias))) return Object.freeze([]);
  const all = allowed.has("*") || UNIFIED_ALIASES.some(alias => allowed.has(alias));
  return Object.freeze(HISTORY_SCOPES.filter(scope => capabilities[scope]
    && !HISTORY_SCOPE_ALIASES[scope].some(alias => denied.has(alias))
    && (all || HISTORY_SCOPE_ALIASES[scope].some(alias => allowed.has(alias)))));
}

/** Only permitted old aliases reach Pi: config denies cannot hide other scopes. */
export function historyPolicyAliases(scopes: readonly HistoryScope[]): readonly string[] {
  return Object.freeze(scopes.flatMap(scope => HISTORY_SCOPE_ALIASES[scope]));
}

/** Match Pi's effective MCP predicate against the exact prepared descriptor.
 * A later deny of any frozen alias hides the entire tool (fail closed).
 */
export function unifiedHistoryAvailability(runtime: Readonly<Record<string, unknown>>): HistoryToolAvailability {
  const servers = runtime.mcpServers as Record<string, { appOwnedTools?: { version?: unknown; aliases?: Record<string, unknown> } }> | undefined;
  const descriptor = servers?.[HISTORY_MCP_SERVER_NAME]?.appOwnedTools;
  const aliases = descriptor?.aliases?.History;
  const none = { conversationHistory: false, sessionHistory: false, history: { said: false, tools: false, runs: false } };
  if (descriptor?.version !== 1 || !isRecord(descriptor) || !isRecord(descriptor.aliases)
    || !Object.values(descriptor.aliases).every(values => Array.isArray(values) && values.every(value => typeof value === "string"))
    || !Array.isArray(aliases) || !aliases.every((alias): alias is string => typeof alias === "string")) return none;
  const names = [...UNIFIED_ALIASES, ...aliases];
  const denied = new Set(Array.isArray(runtime.disallowedTools) ? runtime.disallowedTools : []);
  const allowed = Array.isArray(runtime.allowedTools) ? new Set(runtime.allowedTools) : undefined;
  if (denied.has("*") || names.some(name => denied.has(name))
    || (allowed !== undefined && !allowed.has("*") && !names.some(name => allowed.has(name)))) return none;
  return { conversationHistory: false, sessionHistory: false, history: {
    said: aliases.includes("ConversationHistory"), tools: aliases.includes("SessionHistory"), runs: aliases.includes("RunHistory"),
  } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
