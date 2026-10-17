// Common tool budgets, compaction policy and prompt override contracts.

/**
 * @typedef {Object} RuntimeToolLimits
 * Typed per-run tool-output limits. Every
 * field is optional; an omitted field falls back to the kernel default (see
 * resolveAgentCompactionPolicy, agent/compaction.js).
 * @property {number} [toolTextLimitChars]        Max chars of a builtin tool's text result.
 * @property {number} [bashOutputLimitChars]      Max chars of bash stdout/stderr.
 * @property {number} [mcpTextLimitChars]         Max chars of an MCP tool's text result.
 * @property {number} [searchResultLimit]         Max Grep/search hits returned.
 * @property {number} [imageInlineMaxBytes]       Max bytes of an inlined image result.
 * @property {number} [toolPayloadMaxBytes]       Hard cap on a single tool_result payload.
 * @property {number} [mcpCallTimeoutMs]          Per-MCP-call inactivity timeout.
 * @property {number} [mcpCallMaxTotalTimeoutMs]  Hard wall-clock cap for one MCP call.
 * @property {number} [bashTimeoutMs]             Foreground ceiling and default for
 *   Bash/Exec timeouts on the Pi bridge, applied by `normalizePiBuiltinToolParams`
 *   (defaults to 120_000). Background hand-offs deliberately ignore it: a process job is
 *   bounded by the host's `processJobs.maxRuntimeMs` instead.
 */

/**
 * @typedef {Object} RuntimeCompactionPolicy
 * Typed per-run context-compaction policy. Every field is
 * optional; omitted scalar budgets resolve adaptively against the effective
 * model context window.
 * @property {"auto"|"none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"|"ultra"} [effort] Independent summary reasoning; default auto chooses none or the lowest supported level.
 * @property {number} [failureCooldownMs] Cross-run summary failure suppression; default 900000, 0 disables.
 * @property {boolean} [enabled]              Whether auto-compaction runs at all.
 * @property {number} [triggerRatio]          Fraction of the context window that arms the proactive trigger.
 * @property {number} [keepRecentTokens]      Recent-token budget preserved across a compaction.
 * @property {number} [summaryMaxTokens]      Combined output-token budget for generated compaction summaries.
 * @property {number} [minSavingsTokens]      Minimum token savings required for proactive compaction; reactive recovery accepts any positive reduction.
 * @property {boolean} [fixedOverheadEnabled] Whether the system-prompt + tool-schema overhead correction is folded into the trigger.
 * @property {number} [contextWindowOverride] Persistent correction for provider context-window metadata; learned overflow evidence may lower it process-locally (applied at resolveLiveCompactionPolicy).
 */

/**
 * @typedef {Object} RuntimePromptOverrides
 * Optional overrides for the kernel's built-in prompt fragments. Precedence is
 * run over host over the kernel default: an absent field leaves the built-in
 * string in place. Supplied on both TurnHostOptions (host default) and
 * RuntimeRunOptions (per-run).
 * @property {(systemPrompt: string) => string} [structuredOutputInstruction]
 *   Replaces the StructuredOutput system-prompt instruction (receives the raw
 *   system prompt, returns the augmented one). Only applied when an outputSchema is active.
 * @property {() => string} [structuredOutputFinalization]
 *   Replaces the structured-output finalization re-prompt.
 * @property {() => string} [emptyReplyFinalization]
 *   Replaces the single plain-text finalization re-prompt after an empty reply.
 * @property {(body: string) => string} [liveInputGuidance]
 *   Replaces the live-input steering wrapper (receives the raw guidance body).
 */

export type RuntimeToolLimits = {
  /**
   * Max chars of a builtin tool's text result.
   */
  toolTextLimitChars?: number;
  /**
   * Max chars of bash stdout/stderr.
   */
  bashOutputLimitChars?: number;
  /**
   * Max chars of an MCP tool's text result.
   */
  mcpTextLimitChars?: number;
  /**
   * Max Grep/search hits returned.
   */
  searchResultLimit?: number;
  /**
   * Max bytes of an inlined image result.
   */
  imageInlineMaxBytes?: number;
  /**
   * Hard cap on a single tool_result payload.
   */
  toolPayloadMaxBytes?: number;
  /**
   * Per-MCP-call inactivity timeout.
   */
  mcpCallTimeoutMs?: number;
  /**
   * Hard wall-clock cap for one MCP call.
   */
  mcpCallMaxTotalTimeoutMs?: number;
  /**
   * Foreground ceiling and default for
   * Bash/Exec timeouts on the Pi bridge, applied by `normalizePiBuiltinToolParams`
   * (defaults to 120_000). Background hand-offs deliberately ignore it: a process job is
   * bounded by the host's `processJobs.maxRuntimeMs` instead.
   */
  bashTimeoutMs?: number;
};

/**
 * Typed per-run context-compaction policy. Every field is
 * optional; omitted scalar budgets resolve adaptively against the effective
 * model context window.
 */
export type RuntimeCompactionPolicy = {
  /**
   * Independent summary reasoning; default auto chooses none or the lowest supported level.
   */
  effort?: "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /**
   * Cross-run summary failure suppression; default 900000, 0 disables.
   */
  failureCooldownMs?: number;
  /**
   * Whether auto-compaction runs at all.
   */
  enabled?: boolean;
  /**
   * Fraction of the context window that arms the proactive trigger.
   */
  triggerRatio?: number;
  /**
   * Recent-token budget preserved across a compaction.
   */
  keepRecentTokens?: number;
  /**
   * Combined output-token budget for generated compaction summaries.
   */
  summaryMaxTokens?: number;
  /**
   * Minimum token savings required for proactive compaction; reactive recovery accepts any positive reduction.
   */
  minSavingsTokens?: number;
  /**
   * Whether the system-prompt + tool-schema overhead correction is folded into the trigger.
   */
  fixedOverheadEnabled?: boolean;
  /**
   * Persistent correction for provider context-window metadata; learned overflow evidence may lower it process-locally (applied at resolveLiveCompactionPolicy).
   */
  contextWindowOverride?: number;
};

/**
 * Optional overrides for the kernel's built-in prompt fragments. Precedence is
 * run over host over the kernel default: an absent field leaves the built-in
 * string in place. Supplied on both TurnHostOptions (host default) and
 * RuntimeRunOptions (per-run).
 */
export type RuntimePromptOverrides = {
  /**
   * Replaces the StructuredOutput system-prompt instruction (receives the raw
   * system prompt, returns the augmented one). Only applied when an outputSchema is active.
   */
  structuredOutputInstruction?: (systemPrompt: string) => string;
  /**
   * Replaces the structured-output finalization re-prompt.
   */
  structuredOutputFinalization?: () => string;
  /**
   * Replaces the single plain-text finalization re-prompt after an empty reply.
   */
  emptyReplyFinalization?: () => string;
  /**
   * Replaces the live-input steering wrapper (receives the raw guidance body).
   */
  liveInputGuidance?: (body: string) => string;
};
