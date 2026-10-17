// Per-request capability telemetry. Each provider populates what it can
// attest to for *this* call; unknown values are `null` (not `false`) so
// hosts can tell "feature off" from "we don't know". This is the per-call
// counterpart to the static `runtimeCapabilities()` (which describes the
// backend in general).
//
// Fields:
//   prompt_cache_active        — true/false/null (null = unknown for this provider)
//   thinking_enabled           — true/false/null
//   structured_output_enforced — true/false (request-time signal; never null)
//   subagent_invoked           — true/false/null
//   mcp_servers_used           — string[] of MCP server names that ran
//   native_subagents_used      — string[] of native subagent names that ran
//   tool_compaction_applied    — true/false (derived from runtimeWarnings)
//   context_compaction_applied — true/false/null

export const UNKNOWN_CAPABILITY: null = null;

export function buildCapabilitiesUsed({
  promptCacheActive = UNKNOWN_CAPABILITY,
  thinkingEnabled = UNKNOWN_CAPABILITY,
  structuredOutputEnforced = false,
  subagentInvoked = UNKNOWN_CAPABILITY,
  mcpServersUsed = [],
  nativeSubagentsUsed = [],
  toolCompactionApplied = false,
  contextCompactionApplied = UNKNOWN_CAPABILITY,
}: { promptCacheActive?: unknown; thinkingEnabled?: unknown; structuredOutputEnforced?: unknown; subagentInvoked?: unknown; mcpServersUsed?: unknown; nativeSubagentsUsed?: unknown; toolCompactionApplied?: unknown; contextCompactionApplied?: unknown } = {}): {
  prompt_cache_active: boolean | null;
  thinking_enabled: boolean | null;
  structured_output_enforced: boolean;
  subagent_invoked: boolean | null;
  mcp_servers_used: any[];
  native_subagents_used: any[];
  tool_compaction_applied: boolean;
  context_compaction_applied: boolean | null;
} {
  return {
    prompt_cache_active: tristate(promptCacheActive),
    thinking_enabled: tristate(thinkingEnabled),
    structured_output_enforced: !!structuredOutputEnforced,
    subagent_invoked: tristate(subagentInvoked),
    mcp_servers_used: stringList(mcpServersUsed),
    native_subagents_used: stringList(nativeSubagentsUsed),
    tool_compaction_applied: !!toolCompactionApplied,
    context_compaction_applied: tristate(contextCompactionApplied),
  };
}

function tristate(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  return UNKNOWN_CAPABILITY;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => entry.trim());
}

export function toolCompactionAppliedFromWarnings(runtimeWarnings: Array<{ warning_kind?: unknown } | null | undefined> = []): boolean {
  if (!Array.isArray(runtimeWarnings)) return false;
  return runtimeWarnings.some((warning) => warning?.warning_kind === "tool_payload_truncated");
}
