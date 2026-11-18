import type { HistoryToolAvailability, ToolPolicyInput } from "@mono-agent/conversation";
export const HISTORY_MCP_SERVER_NAME = "mono-agent-history";
export const HISTORY_TOOL_NAME = "History";
export const HISTORY_SCOPES = ["said", "tools", "runs"] as const;
export type HistoryScope = (typeof HISTORY_SCOPES)[number];
type Policy = Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">;
export const HISTORY_MCP_TOOL_NAME = `mcp__${HISTORY_MCP_SERVER_NAME}__${HISTORY_TOOL_NAME}`;
const NAMES = [HISTORY_TOOL_NAME, HISTORY_MCP_TOOL_NAME, `mcp__${HISTORY_MCP_SERVER_NAME}__*`];
export function resolveHistoryScopes(policy: Policy, capabilities: HistoryToolAvailability = { said: true, tools: true, runs: true }): readonly HistoryScope[] {
  const allowed = policy.allowedTools ?? [], denied = policy.disallowedTools ?? [];
  return Object.freeze(denied.includes("*") || NAMES.some(name => denied.includes(name))
    || !(allowed.includes("*") || NAMES.some(name => allowed.includes(name))) ? [] : HISTORY_SCOPES.filter(scope => capabilities[scope]));
}
/** Resolve only explicit app-owned metadata, after every request policy layer. */
export function historyToolAvailabilityForRuntime(runtime: Readonly<Record<string, unknown>>): HistoryToolAvailability {
  const none = { said: false, tools: false, runs: false };
  const servers = runtime.mcpServers as Record<string, { appOwnedTools?: { version?: unknown; aliases?: unknown; historyScopes?: unknown } }> | undefined;
  const descriptor = servers?.[HISTORY_MCP_SERVER_NAME]?.appOwnedTools;
  const scopes = descriptor?.historyScopes;
  if (descriptor?.version !== 1 || !isRecord(descriptor.aliases) || Object.keys(descriptor.aliases).length !== 0 || !Object.values(descriptor.aliases).every(values => Array.isArray(values) && values.every(value => typeof value === "string"))
    || !isRecord(scopes) || Object.keys(scopes).sort().join() !== "runs,said,tools" || !HISTORY_SCOPES.every(scope => typeof scopes[scope] === "boolean")) return none;
  const allowed = Array.isArray(runtime.allowedTools) ? runtime.allowedTools as string[] : ["*"];
  const disallowed = Array.isArray(runtime.disallowedTools) ? runtime.disallowedTools as string[] : [];
  const permitted = resolveHistoryScopes({ allowedTools: allowed, disallowedTools: disallowed }, scopes as unknown as HistoryToolAvailability);
  return { said: permitted.includes("said"), tools: permitted.includes("tools"), runs: permitted.includes("runs") };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null;
}
