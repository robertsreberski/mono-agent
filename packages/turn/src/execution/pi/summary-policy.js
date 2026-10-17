import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";

/** Resolve summary policy independently of conversation reasoning. */
export function summaryThinkingLevel(model, effort = "auto") {
  if (!model?.reasoning) return "off";
  const levels = getSupportedThinkingLevels(model);
  const requested = effort === "auto"
    ? levels.includes("off") ? "off" : levels.includes("low") ? "low" : levels[0]
    : effort === "none" ? "off" : effort === "ultra" ? "max" : effort;
  return clampThinkingLevel(model, /** @type {import('@earendil-works/pi-ai').ModelThinkingLevel} */ (requested));
}

/** @param {any} model @param {any} context @param {any} options @param {string} effort */
/** The kit supplies the text target (including its existing split-turn division).
 * Adaptive thinking shares that ceiling, unlike Pi's legacy Anthropic adjustment.
 */
/** @param {any} model @param {any} context @param {any} options @param {string} effort */
export function summaryRequestOptions(model, context, options = {}, effort = "auto") {
  const level = summaryThinkingLevel(model, effort);
  const textTargetTokens = options.maxTokens ?? model.maxTokens;
  const reasoningAllowance = level !== "off" && model.api === "anthropic-messages"
    && model.compat?.forceAdaptiveThinking === true
    ? Math.min(8192, Math.max(2048, Math.ceil(textTargetTokens / 2))) : 0;
  const maxTokens = clampMaxTokensToContext(model, { ...context, messages: context.messages ?? [] },
    Math.min(model.maxTokens, textTargetTokens + reasoningAllowance));
  return {
    options: { ...options, reasoning: level === "off" ? undefined : level, maxTokens,
      transport: "sse", maxRetries: 0 },
    metadata: { requestedEffort: effort, effectiveEffort: level === "off" ? "none" : level,
      textTargetTokens, reasoningAllowance, providerMaxTokens: maxTokens },
  };
}
