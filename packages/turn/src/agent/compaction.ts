// @ts-check

import { DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS } from "../tools/mcp/timeouts.js";

// Pure runtime compaction policy and context-pressure heuristics.
// The engine owns compaction execution over native session evidence.

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_TRIGGER_RATIO = 0.90;
// Absolute proactive ceiling. Large-window models otherwise let one
// conversation grow towards ~90% of a 1M window before compacting, paying for
// that whole prefix on every request. The ceiling only moves the proactive
// trigger; it never refuses a request or changes the usable window. 0 disables.
const DEFAULT_MAX_INPUT_TOKENS = 200_000;
const MIN_MAX_INPUT_TOKENS = 32_000;
const MAX_MAX_INPUT_TOKENS = 10_000_000;
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

function clampNumber(value: any, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function clampInteger(value: any, fallback: number, min: number, max: number): number {
  return Math.floor(clampNumber(value, fallback, min, max));
}

// Omitted (or null) selects the default ceiling; an explicit 0 is the opt-out.
function resolveMaxInputTokens(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_MAX_INPUT_TOKENS;
  if (Number(value) === 0) return 0;
  return clampInteger(value, DEFAULT_MAX_INPUT_TOKENS, MIN_MAX_INPUT_TOKENS, MAX_MAX_INPUT_TOKENS);
}


export function resolveAgentCompactionPolicy({ toolLimits = {}, compaction = {} }: { toolLimits?: import("../contracts/policy.js").RuntimeToolLimits | undefined; compaction?: import("../contracts/policy.js").RuntimeCompactionPolicy | undefined; } | undefined = {}, model: { contextWindow?: number | undefined; } | null | undefined = {}): AgentCompactionPolicy {
  const contextWindow = clampInteger(model?.contextWindow, DEFAULT_CONTEXT_WINDOW, 32000, 10_000_000);
  const triggerRatio = clampNumber(
    compaction.triggerRatio,
    DEFAULT_TRIGGER_RATIO,
    0.2,
    0.95,
  );
  // Scale-aware reserve: the headroom leaves room for the pending response
  // and the compaction request itself, which is an absolute quantity — not a
  // quarter of an ever-growing window. At 10% with a 16k floor / 48k ceiling,
  // a 200k-400k window reaches a configured 0.9, a 128k window is held at
  // 87.5% by the floor, and very large windows stop reserving absurd amounts.
  const safetyHeadroom = clampInteger(contextWindow * 0.10, 16000, 16000, 48000);
  // Add a tiny scale-aware epsilon before flooring so decimal ratios such as
  // a configured ratio of 0.70 do not lose a token to IEEE-754 representation
  // (372000 * 0.70 is otherwise 260399.99999999997 in JavaScript).
  const ratioTrigger = Math.floor((contextWindow * triggerRatio) + (Number.EPSILON * contextWindow));
  const reserveTrigger = Math.max(1, contextWindow - safetyHeadroom);
  const windowTriggerTokens = Math.min(ratioTrigger, reserveTrigger);
  // The absolute ceiling binds only when it is strictly below the
  // window-derived trigger, so smaller windows keep today's trigger exactly.
  const maxInputTokens = resolveMaxInputTokens(compaction.maxInputTokens);
  const ceilingBinds = maxInputTokens > 0 && maxInputTokens < windowTriggerTokens;
  const adaptiveKeepRecentTokens = clampInteger(contextWindow * 0.10, 4000, 4000, 20000);
  const adaptiveSummaryMaxTokens = clampInteger(contextWindow * 0.04, 2000, 2000, 12000);
  const adaptiveMinSavingsTokens = clampInteger(contextWindow * 0.10, 4000, 4000, 20000);
  return {
    enabled: compaction.enabled !== false,
    effort: compaction.effort || "auto",
    failureCooldownMs: clampInteger(compaction.failureCooldownMs, 900000, 0, 86400000),
    contextWindow,
    triggerRatio,
    triggerTokens: ceilingBinds ? maxInputTokens : windowTriggerTokens,
    windowTriggerTokens,
    maxInputTokens,
    triggerSource: ceilingBinds ? "max_input_tokens" : ratioTrigger <= reserveTrigger ? "ratio" : "reserve",
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

/**
 * Anti-thrash floor for the absolute ceiling. After an accepted compaction the
 * request still carries the stable fixed overhead plus the summary and the
 * retained tail; a ceiling below `fixedOverhead + summaryMaxTokens +
 * keepRecentTokens + compactionMinSavingsTokens` would re-arm immediately and
 * pay for a summary that cannot meet the savings minimum on every turn. Lift a
 * binding ceiling to that floor, never above the window-derived trigger. Ratio-
 * or reserve-bound policies are returned unchanged.
 */
export function liftCompactionCeilingFloor(policy: AgentCompactionPolicy, fixedOverheadTokens: number): { policy: AgentCompactionPolicy; floorTokens: number | null; } {
  if (policy.triggerSource !== "max_input_tokens") return { policy, floorTokens: null };
  const overhead = Math.max(0, Math.ceil(Number(fixedOverheadTokens) || 0));
  const floorTokens = overhead + policy.summaryMaxTokens + policy.keepRecentTokens + policy.compactionMinSavingsTokens;
  if (floorTokens <= policy.triggerTokens) return { policy, floorTokens: null };
  return {
    policy: {
      ...policy,
      triggerTokens: Math.min(floorTokens, policy.windowTriggerTokens),
      triggerSource: "max_input_tokens_floor",
    },
    floorTokens,
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
export function estimateFixedOverheadTokens({ systemPrompt, tools, messages }: { systemPrompt?: string | undefined; tools?: any[] | undefined; messages?: any[] | undefined; } | undefined = {}): { systemPromptTokens: number; toolSchemaTokens: number; userMessageTokens: number; fixedOverheadTokens: number; } {
  const tokensForChars = (value: unknown) => Math.ceil(String(value ?? "").length / 4);

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

export function isLikelyContextTermination(message: string, diagnostics: { [x: string]: any; } | undefined = {}): boolean {
  const text = String(message || "");
  if (!/terminated|aborted before final output|aborted before final|stream.*aborted|context window|context budget/i.test(text)) return false;
  const compactions = Number(diagnostics.context_compactions) || 0;
  if (compactions > 0) return true;
  const estimate = Number(diagnostics.context_tokens_estimate_max || diagnostics.context_tokens_estimate || 0);
  const trigger = Number(diagnostics.context_compaction_trigger_tokens || 0);
  return Boolean(trigger > 0 && estimate >= trigger * 0.85);
}

export type AgentCompactionPolicy = {
  effort: string;
  failureCooldownMs: number;
  enabled: boolean;
  contextWindow: number;
  triggerRatio: number;
  /** Effective proactive trigger: min(ratio trigger, reserve trigger, maxInputTokens). */
  triggerTokens: number;
  /** Window-derived trigger before the absolute ceiling: min(ratio trigger, reserve trigger). */
  windowTriggerTokens: number;
  /** Resolved absolute proactive ceiling; 0 when disabled. */
  maxInputTokens: number;
  /**
   * Which arm binds triggerTokens. `max_input_tokens_floor` means a binding
   * ceiling was lifted to the fixed-overhead floor (see liftCompactionCeilingFloor).
   */
  triggerSource: "ratio" | "reserve" | "max_input_tokens" | "max_input_tokens_floor";
  keepRecentTokens: number;
  summaryMaxTokens: number;
  fixedOverheadEnabled: boolean;
  compactionMinSavingsTokens: number;
  toolTextLimitChars: number;
  bashOutputLimitChars: number;
  mcpTextLimitChars: number;
  searchResultLimit: number;
  imageInlineMaxBytes: number;
  toolPayloadMaxBytes: number;
  mcpCallTimeoutMs: number;
  mcpCallMaxTotalTimeoutMs: number;
};
