// Explicit split is execution-equivalent but remains digest-bound JSON. Builders
// omit it to preserve legacy raw and canonical registration digests.
// Shared offline selector. Omitted/split leave legacy request and artifact shapes intact.
import { fail } from "./continuity-observation-input.mjs";
export function e2HistorySurface(surface = "split") {
  if (!["split", "unified"].includes(surface)) fail("E2_ARGUMENTS_INVALID");
  return surface;
}
export const historySurfaceBinding = surface => e2HistorySurface(surface) === "unified" ? { historySurface: "unified" } : {};
export const historyToolName = surface => e2HistorySurface(surface) === "unified" ? "History" : "ConversationHistory";
export const historyServerName = surface => e2HistorySurface(surface) === "unified" ? "mono-agent-history" : "mono-agent-conversation-history";
export const historyConfig = surface => e2HistorySurface(surface) === "unified" ? { history: { unified: true } } : {};
export const historyArguments = (surface, args, scope = "said") => e2HistorySurface(surface) === "unified" ? { scope, ...args } : args;
export function assertHistorySurfaceBinding(registration, value) {
  if (e2HistorySurface(registration.historySurface) !== e2HistorySurface(value.historySurface)) fail("e2_authorization_binding_mismatch");
}
// Keep scope attribution explicit: tools/runs are not conversation-text lookups.
export function historyCallScope(name, args) {
  if (["ConversationHistory", "conversation_history", "mcp__mono-agent-conversation-history__ConversationHistory"].includes(name)) return "said";
  if (["SessionHistory", "session_history", "mcp__mono-agent-session-history__SessionHistory"].includes(name)) return "tools";
  if (["RunHistory", "run_history", "mcp__mono-agent-run-history__RunHistory"].includes(name)) return "runs";
  if (["History", "mcp__mono-agent-history__History"].includes(name) && ["said", "tools", "runs"].includes(args?.scope)) return args.scope;
  return undefined;
}

// Both the lookup safety guard and paid E2 config guard consume this selector.
export const LOOKUP_TOOL_ALLOWLIST_V1 = Object.freeze({ version: "v1", tools: Object.freeze(["ConversationHistory"]) });
export const LOOKUP_TOOL_ALLOWLIST_V2 = Object.freeze({ version: "v2", tools: Object.freeze(["ConversationHistory", "History"]) });
export const lookupToolAllowlist = surface => e2HistorySurface(surface) === "unified" ? LOOKUP_TOOL_ALLOWLIST_V2 : LOOKUP_TOOL_ALLOWLIST_V1;
