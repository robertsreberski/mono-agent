// Context-compaction policy + heuristics for the pi-native bridge.
//
// The hand-rolled in-loop compaction manager (transformContext/afterToolCall)
// was retired with the legacy pi-sdk Agent path — the sole pi bridge uses
// pi-agent-core's AgentHarness, which owns compaction via harness.compact().
// What remains here are two pure helpers the bridge still consumes:
//   - resolveAgentCompactionPolicy: derives the context-window compaction
//     trigger and the tool-output payload limits from settings + the running
//     model. Pure (no Agent loop), so the bridge computes it directly.
//   - isLikelyContextTermination: classifies a provider error/termination as a
//     context-pressure event.

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_TRIGGER_RATIO = 0.85;
const DEFAULT_KEEP_RECENT_TOKENS = 24000;
const DEFAULT_SUMMARY_MAX_TOKENS = 16000;
const DEFAULT_MIN_SAVINGS_TOKENS = 20000;
const DEFAULT_TOOL_PAYLOAD_COMPACTION_TRIGGER_CHARS = 0;
const DEFAULT_TOOL_PRUNE_TRIGGER_TOKENS = 40000;
// intelligence-ramp Phase 3: lifted from 16K/20K/12K. Mid-task tool reads
// (large file edits, long bash output, deep MCP results) were being silently
// clipped before the agent could reason about them. The 256KB hard ceiling
// in tool-bloat.js still protects against runaway payloads.
const DEFAULT_TOOL_TEXT_LIMIT_CHARS = 64000;
const DEFAULT_BASH_OUTPUT_LIMIT_CHARS = 64000;
const DEFAULT_MCP_TEXT_LIMIT_CHARS = 48000;
const DEFAULT_SEARCH_RESULT_LIMIT = 100;
// Images are returned to vision models whole (a Read of an image attachment, an
// MCP screenshot). The byte size is large but token cost is driven by image
// tokens, not base64 length, so allow multi-MB screenshots through instead of
// clipping them to a "[truncated]" summary the model can't see. Clamp ceiling
// (10MB) is enforced in resolveAgentCompactionPolicy.
const DEFAULT_IMAGE_INLINE_MAX_BYTES = 5_000_000;
const DEFAULT_TOOL_PAYLOAD_MAX_BYTES = 262144;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 120000;

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function clampInteger(value, fallback, min, max) {
  return Math.floor(clampNumber(value, fallback, min, max));
}

export function resolveAgentCompactionPolicy(settings = {}, model = {}) {
  const contextWindow = clampInteger(model?.contextWindow, DEFAULT_CONTEXT_WINDOW, 32000, 10_000_000);
  const triggerRatio = clampNumber(
    settings.agent_compaction_trigger_ratio,
    DEFAULT_TRIGGER_RATIO,
    0.2,
    0.95,
  );
  const reserveTokens = Math.max(16000, Math.min(64000, Math.floor(contextWindow * 0.25)));
  const ratioTrigger = Math.floor(contextWindow * triggerRatio);
  const reserveTrigger = Math.max(1, contextWindow - reserveTokens);
  return {
    enabled: settings.agent_compaction_enabled !== false,
    contextWindow,
    triggerRatio,
    triggerTokens: Math.min(ratioTrigger, reserveTrigger),
    keepRecentTokens: clampInteger(settings.agent_compaction_keep_recent_tokens, DEFAULT_KEEP_RECENT_TOKENS, 4000, 200000),
    summaryMaxTokens: clampInteger(settings.agent_compaction_summary_max_tokens, DEFAULT_SUMMARY_MAX_TOKENS, 1000, 64000),
    compactionMinSavingsTokens: clampInteger(settings.agent_compaction_min_savings_tokens, DEFAULT_MIN_SAVINGS_TOKENS, 0, 500000),
    toolPayloadCompactionTriggerChars: clampInteger(
      settings.agent_tool_payload_compaction_trigger_chars,
      DEFAULT_TOOL_PAYLOAD_COMPACTION_TRIGGER_CHARS,
      0,
      10 * 1024 * 1024,
    ),
    toolPruneTriggerTokens: clampInteger(settings.agent_tool_prune_trigger_tokens, DEFAULT_TOOL_PRUNE_TRIGGER_TOKENS, 0, 500000),
    toolTextLimitChars: clampInteger(settings.agent_tool_text_limit_chars, DEFAULT_TOOL_TEXT_LIMIT_CHARS, 1000, 200000),
    bashOutputLimitChars: clampInteger(settings.agent_bash_output_limit_chars, DEFAULT_BASH_OUTPUT_LIMIT_CHARS, 1000, 200000),
    mcpTextLimitChars: clampInteger(settings.agent_mcp_text_limit_chars, DEFAULT_MCP_TEXT_LIMIT_CHARS, 1000, 200000),
    searchResultLimit: clampInteger(settings.agent_search_result_limit, DEFAULT_SEARCH_RESULT_LIMIT, 10, 1000),
    imageInlineMaxBytes: clampInteger(settings.agent_image_inline_max_bytes, DEFAULT_IMAGE_INLINE_MAX_BYTES, 0, 10 * 1024 * 1024),
    toolPayloadMaxBytes: clampInteger(settings.agent_tool_payload_max_bytes, DEFAULT_TOOL_PAYLOAD_MAX_BYTES, 0, 16 * 1024 * 1024),
    mcpCallTimeoutMs: clampInteger(settings.agent_mcp_call_timeout_ms, DEFAULT_MCP_CALL_TIMEOUT_MS, 1000, Number.MAX_SAFE_INTEGER),
  };
}

export function isLikelyContextTermination(message, diagnostics = {}) {
  const text = String(message || "");
  if (!/terminated|aborted before final output|aborted before final|stream.*aborted|context window|context budget/i.test(text)) return false;
  const compactions = Number(diagnostics.context_compactions) || 0;
  if (compactions > 0) return true;
  const estimate = Number(diagnostics.context_tokens_estimate_max || diagnostics.context_tokens_estimate || 0);
  const trigger = Number(diagnostics.context_compaction_trigger_tokens || 0);
  return Boolean(trigger > 0 && estimate >= trigger * 0.85);
}
