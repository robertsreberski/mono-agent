import { createHistoryRuntimeExtension } from "../../request-tools/history.js";
import { resolveHistoryScopes, HISTORY_MCP_SERVER_NAME, HISTORY_TOOL_NAME, type HistoryScope } from "../../request-tools/history-policy.js";
import type { RuntimeOptionsExtension } from "../../composition/runtime-option-extensions.js";
export { HISTORY_MCP_SERVER_NAME, HISTORY_TOOL_NAME };
export { handleSaidHistoryRequest } from "../../request-tools/history-said.js";
export { handleToolsHistoryRequest } from "../../request-tools/history-tools.js";
export { handleRunsHistoryRequest } from "../../request-tools/history-runs.js";
const extension = (scope: HistoryScope, options: {historyRoot?: string; artifactDir?: string; rollover?: "none" | "daily"; onUnavailable?: (error: unknown) => void}): RuntimeOptionsExtension => createHistoryRuntimeExtension({
  historyRoot: options.historyRoot ?? "/fictional-unused-history", artifactDir: options.artifactDir ?? "/fictional-unused-artifacts", policy: {allowedTools: ["History"]},
  capabilities: {said: scope === "said", tools: scope !== "said", runs: scope === "runs"},
  ...(options.rollover === undefined ? {} : {scopeRollovers: {[scope]: options.rollover}}),
  ...(options.onUnavailable === undefined ? {} : {onUnavailable: options.onUnavailable}),
})!;
export const createSaidHistoryExtension = (options: Parameters<typeof extension>[1]) => extension("said", options);
export const createToolsHistoryExtension = (options: Parameters<typeof extension>[1]) => extension("tools", options);
export const createRunsHistoryExtension = (options: Parameters<typeof extension>[1]) => extension("runs", options);
export const isHistoryAllowed = (policy?: {allowedTools?: readonly string[]; disallowedTools?: readonly string[]}) => resolveHistoryScopes(policy ?? {}).length > 0;
/** Adapt scope-internal test cases to the sole public request contract. */
export function scopedCall(client: {callTool: (request: any) => any}, scope: HistoryScope, request: any) {
  const args = {...request.arguments};
  if (scope === "runs") { if (args.action === "inspect") args.action = "get"; else if (args.action === "list") args.action = "search"; }
  return client.callTool({...request, name: "History", arguments: {scope, ...args}});
}
