import { resolveAgentCompactionPolicy } from "@mono-agent/agent-runtime/agent/compaction.js";

import type { RuntimeCompactionPolicy, RuntimePolicies, RuntimeToolLimits } from "./types.js";

/**
 * Host-side migration helper: project a legacy flat settings bag (the
 * `agent_tool_*` / `agent_mcp_*` / `agent_compaction_*` keys) into the typed
 * `toolLimits` / `compaction` policy objects a host now passes on
 * RuntimeRunOptions. Pass the result's fields straight through to `run()`.
 *
 * This is the SUPPORTED replacement for handing the kernel `runOptions.settings`
 * (which the kernel still accepts as a deprecated per-group fallback, emitting a
 * `deprecated_settings_option` warning when consumed). Resolution reuses the
 * kernel's own clamp/mapper (`resolveAgentCompactionPolicy`) so the produced
 * values are byte-identical to what the deprecated shim would have resolved —
 * only the transport (typed objects vs. the flat bag) differs. The model-derived
 * fields the mapper computes (contextWindow / triggerTokens) are intentionally
 * NOT projected: they are re-derived at run time against the live model, so the
 * typed objects carry only the run-tunable INPUTS.
 *
 * Fields with no legacy settings equivalent — `toolLimits.bashTimeoutMs` and
 * `compaction.contextWindowOverride` — are omitted here; set them directly on the
 * typed objects if needed.
 */
export function resolveRuntimePolicies(settings?: Record<string, unknown>): RuntimePolicies {
  const resolved = resolveAgentCompactionPolicy(settings ?? {}, {});
  const toolLimits: RuntimeToolLimits = {
    toolTextLimitChars: resolved.toolTextLimitChars,
    bashOutputLimitChars: resolved.bashOutputLimitChars,
    mcpTextLimitChars: resolved.mcpTextLimitChars,
    searchResultLimit: resolved.searchResultLimit,
    imageInlineMaxBytes: resolved.imageInlineMaxBytes,
    toolPayloadMaxBytes: resolved.toolPayloadMaxBytes,
    mcpCallTimeoutMs: resolved.mcpCallTimeoutMs,
    mcpCallMaxTotalTimeoutMs: resolved.mcpCallMaxTotalTimeoutMs,
  };
  const compaction: RuntimeCompactionPolicy = {
    enabled: resolved.enabled,
    triggerRatio: resolved.triggerRatio,
    keepRecentTokens: resolved.keepRecentTokens,
    summaryMaxTokens: resolved.summaryMaxTokens,
    minSavingsTokens: resolved.compactionMinSavingsTokens,
    fixedOverheadEnabled: resolved.fixedOverheadEnabled,
  };
  return { toolLimits, compaction };
}
