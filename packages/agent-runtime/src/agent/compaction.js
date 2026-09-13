// @ts-check

// Context-compaction policy + heuristics for the pi-native bridge.
//
// The hand-rolled in-loop compaction manager (transformContext/afterToolCall)
// was retired with the legacy pi-sdk Agent path — the sole pi bridge uses
// pi-agent-core's AgentHarness, which owns compaction via harness.compact().
// What remains here are two pure helpers the bridge still consumes:
//   - resolveAgentCompactionPolicy: derives the context-window compaction
//     trigger and the tool-output payload limits from typed policies + the running
//     model. Pure (no Agent loop), so the bridge computes it directly.
//   - isLikelyContextTermination: classifies a provider error/termination as a
//     context-pressure event.

/**
 * @typedef {Object} AgentCompactionPolicy
 * @property {boolean} enabled
 * @property {number} contextWindow
 * @property {number} triggerRatio
 * @property {number} triggerTokens
 * @property {number} keepRecentTokens
 * @property {number} summaryMaxTokens
 * @property {boolean} fixedOverheadEnabled
 * @property {number} compactionMinSavingsTokens
 * @property {number} toolTextLimitChars
 * @property {number} bashOutputLimitChars
 * @property {number} mcpTextLimitChars
 * @property {number} searchResultLimit
 * @property {number} imageInlineMaxBytes
 * @property {number} toolPayloadMaxBytes
 * @property {number} mcpCallTimeoutMs
 * @property {number} mcpCallMaxTotalTimeoutMs
 */

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_TRIGGER_RATIO = 0.70;
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
// Hard wall clock for a single MCP tool call. Progress notifications reset the
// inactivity timeout above but must never extend a call past this cap (45 min) —
// sized for legitimately long tools (audio transcription, ask-the-user waits).
const DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS = 2_700_000;

/**
 * @param {*} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * @param {*} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInteger(value, fallback, min, max) {
  return Math.floor(clampNumber(value, fallback, min, max));
}

/**
 * @param {{toolLimits?: import('../ai/types.js').RuntimeToolLimits, compaction?: import('../ai/types.js').RuntimeCompactionPolicy}} [options]
 * @param {Object} [model]
 * @param {number} [model.contextWindow]
 * @returns {AgentCompactionPolicy}
 */
export function resolveAgentCompactionPolicy({ toolLimits = {}, compaction = {} } = {}, model = {}) {
  const contextWindow = clampInteger(model?.contextWindow, DEFAULT_CONTEXT_WINDOW, 32000, 10_000_000);
  const triggerRatio = clampNumber(
    compaction.triggerRatio,
    DEFAULT_TRIGGER_RATIO,
    0.2,
    0.95,
  );
  const safetyHeadroom = clampInteger(contextWindow * 0.25, 16000, 16000, 96000);
  // Add a tiny scale-aware epsilon before flooring so decimal ratios such as
  // 0.70 do not lose a token to IEEE-754 representation (372000 * 0.70 is
  // otherwise 260399.99999999997 in JavaScript).
  const ratioTrigger = Math.floor((contextWindow * triggerRatio) + (Number.EPSILON * contextWindow));
  const reserveTrigger = Math.max(1, contextWindow - safetyHeadroom);
  const adaptiveKeepRecentTokens = clampInteger(contextWindow * 0.10, 4000, 4000, 20000);
  const adaptiveSummaryMaxTokens = clampInteger(contextWindow * 0.04, 2000, 2000, 12000);
  const adaptiveMinSavingsTokens = clampInteger(contextWindow * 0.10, 4000, 4000, 20000);
  return {
    enabled: compaction.enabled !== false,
    contextWindow,
    triggerRatio,
    triggerTokens: Math.min(ratioTrigger, reserveTrigger),
    keepRecentTokens: clampInteger(
      compaction.keepRecentTokens,
      adaptiveKeepRecentTokens,
      4000,
      200000,
    ),
    summaryMaxTokens: clampInteger(
      compaction.summaryMaxTokens,
      adaptiveSummaryMaxTokens,
      1000,
      64000,
    ),
    // ON by default; the proactive fixed-overhead correction (system prompt +
    // tool schemas + per-turn message) is disabled only when explicitly false.
    // Read by the compaction driver off the resolved policy so it never has to
    // re-sniff the raw policy inputs.
    fixedOverheadEnabled: compaction.fixedOverheadEnabled !== false,
    compactionMinSavingsTokens: clampInteger(
      compaction.minSavingsTokens,
      adaptiveMinSavingsTokens,
      0,
      500000,
    ),
    toolTextLimitChars: clampInteger(toolLimits.toolTextLimitChars, DEFAULT_TOOL_TEXT_LIMIT_CHARS, 1000, 200000),
    bashOutputLimitChars: clampInteger(toolLimits.bashOutputLimitChars, DEFAULT_BASH_OUTPUT_LIMIT_CHARS, 1000, 200000),
    mcpTextLimitChars: clampInteger(toolLimits.mcpTextLimitChars, DEFAULT_MCP_TEXT_LIMIT_CHARS, 1000, 200000),
    searchResultLimit: clampInteger(toolLimits.searchResultLimit, DEFAULT_SEARCH_RESULT_LIMIT, 10, 1000),
    imageInlineMaxBytes: clampInteger(toolLimits.imageInlineMaxBytes, DEFAULT_IMAGE_INLINE_MAX_BYTES, 0, 10 * 1024 * 1024),
    toolPayloadMaxBytes: clampInteger(toolLimits.toolPayloadMaxBytes, DEFAULT_TOOL_PAYLOAD_MAX_BYTES, 0, 16 * 1024 * 1024),
    mcpCallTimeoutMs: clampInteger(toolLimits.mcpCallTimeoutMs, DEFAULT_MCP_CALL_TIMEOUT_MS, 1000, Number.MAX_SAFE_INTEGER),
    mcpCallMaxTotalTimeoutMs: clampInteger(
      toolLimits.mcpCallMaxTotalTimeoutMs,
      DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS,
      1000,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

// Estimate the FIXED per-request overhead the provider meters but the raw
// transcript estimate excludes: the system prompt, the tool/MCP schemas, and the
// per-turn user message(s). estimateCurrentContextTokens' raw branch sums ONLY
// session.buildContext().messages (the transcript), so on a seeded session whose
// last-assistant usage is stale/0 the proactive-compaction trigger under-counts
// and under-fires, letting the real request overflow the window. Adding this
// overhead to the raw estimate makes the trigger reflect what the provider counts.
//
// Uses Math.ceil(len/4) to mirror pi-ai's chars/4 heuristic — consistency with
// the transcript estimate matters more than precision. Pure + dependency-free.
/**
 * @param {Object} [options]
 * @param {string} [options.systemPrompt]
 * @param {Array<Object>} [options.tools]
 * @param {Array<Object>} [options.messages]
 * @returns {{systemPromptTokens: number, toolSchemaTokens: number, userMessageTokens: number, fixedOverheadTokens: number}}
 */
export function estimateFixedOverheadTokens({ systemPrompt, tools, messages } = {}) {
  const tokensForChars = (value) => Math.ceil(String(value ?? "").length / 4);

  const systemPromptTokens = tokensForChars(systemPrompt);

  let toolSchemaTokens = 0;
  for (const tool of Array.isArray(tools) ? tools : []) {
    try {
      const serialized = JSON.stringify({
        name: tool?.name,
        description: tool?.description,
        parameters: tool?.parameters ?? tool?.inputSchema ?? {},
      });
      toolSchemaTokens += tokensForChars(serialized);
    } catch {
      // Circular/unserializable tool schema — count it as 0 rather than throw.
    }
  }

  let userMessageTokens = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    try {
      userMessageTokens += tokensForChars(JSON.stringify(message?.content ?? ""));
    } catch {
      // Unserializable content — count it as 0 rather than throw.
    }
  }

  return {
    systemPromptTokens,
    toolSchemaTokens,
    userMessageTokens,
    fixedOverheadTokens: systemPromptTokens + toolSchemaTokens + userMessageTokens,
  };
}

/**
 * @param {string} message
 * @param {Object<string, *>} [diagnostics]
 * @returns {boolean}
 */
export function isLikelyContextTermination(message, diagnostics = {}) {
  const text = String(message || "");
  if (!/terminated|aborted before final output|aborted before final|stream.*aborted|context window|context budget/i.test(text)) return false;
  const compactions = Number(diagnostics.context_compactions) || 0;
  if (compactions > 0) return true;
  const estimate = Number(diagnostics.context_tokens_estimate_max || diagnostics.context_tokens_estimate || 0);
  const trigger = Number(diagnostics.context_compaction_trigger_tokens || 0);
  return Boolean(trigger > 0 && estimate >= trigger * 0.85);
}
