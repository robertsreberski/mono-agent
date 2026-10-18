import { usesGoogleThinkingLevel } from "@earendil-works/pi-ai/api/google-shared";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { adjustMaxTokensForThinking, clampMaxTokensToContext, MIN_ANSWER_TOKENS } from "@earendil-works/pi-ai/api/simple-options";

/** Resolve summary policy independently of conversation reasoning. */
export function summaryThinkingLevel(model: any, effort: string = "auto"): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off" {
  if (!model?.reasoning) return "off";
  const levels = getSupportedThinkingLevels(model);
  const requested = effort === "auto"
    ? levels.includes("off") ? "off" : levels.includes("low") ? "low" : levels[0]
    : effort === "none" ? "off" : effort === "ultra" ? "max" : effort;
  return clampThinkingLevel(model, /** @type {import('@earendil-works/pi-ai').ModelThinkingLevel} */ ((requested) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"));
}

/** The kit supplies the text target (including its existing split-turn division).
 * Adaptive thinking shares that ceiling, unlike Pi's legacy Anthropic adjustment.
 * Explicit small text targets remain useful; a context/model clamp must not reduce
 * the answer below that target, or below Pi's minimum for larger targets.
 * @param {any} model @param {any} context @param {any} options @param {string} effort @param {number|undefined} minimumUsefulAnswer
 */
export function summaryRequestOptions(model: any, context: any, options: any = {}, effort: string = "auto", minimumUsefulAnswer: number | undefined = undefined): {
    canDispatch: boolean;
    options: any;
    metadata: {
        requestedEffort: string;
        effectiveEffort: string;
        textTargetTokens: any;
        minimumAnswerTokens: number;
        reasoningAllowance: number;
        providerMaxTokens: number;
        availableProviderTokens: number;
    };
} {
  const level = summaryThinkingLevel(model, effort);
  const textTargetTokens = options.maxTokens ?? model.maxTokens;
  const minimumAnswerTokens = Math.max(minimumUsefulAnswer ?? 0, Math.min(MIN_ANSWER_TOKENS, textTargetTokens));
  const availableProviderTokens = clampMaxTokensToContext(model, { ...context, messages: context.messages ?? [] }, model.maxTokens);
  const google = ["google-generative-ai", "google-vertex", "google-gemini-cli"].includes(model.api) && level !== "off";
  const googleBudgetBased = google && !usesGoogleThinkingLevel(model);
  const legacy = level !== "off" && model.api === "anthropic-messages" && model.compat?.forceAdaptiveThinking !== true;
  const sharedReasoning = level !== "off" && !legacy && !googleBudgetBased;
  let reasoningAllowance = sharedReasoning ? Math.min(8192, Math.max(2048, Math.ceil(textTargetTokens / 2))) : 0;
  if (legacy) reasoningAllowance = adjustMaxTokensForThinking(textTargetTokens, model.maxTokens, level, options.thinkingBudgets).thinkingBudget;
  // Pi adds legacy thinking itself. Reserve its room, but never add it twice.
  const maxTokens = legacy
    ? Math.max(1, Math.min(textTargetTokens, availableProviderTokens - reasoningAllowance))
    : Math.min(availableProviderTokens, textTargetTokens + reasoningAllowance);
  const googleBudget = Math.min(2048, Math.max(128, maxTokens - MIN_ANSWER_TOKENS));
  const providerMaxTokens = legacy
    ? adjustMaxTokensForThinking(maxTokens, model.maxTokens, level, options.thinkingBudgets).maxTokens : maxTokens;
  const requiredTokens = minimumAnswerTokens + (googleBudgetBased ? googleBudget : reasoningAllowance);
  return {
    canDispatch: providerMaxTokens >= requiredTokens && providerMaxTokens <= availableProviderTokens
      && (!legacy || reasoningAllowance >= MIN_ANSWER_TOKENS),
    options: { ...options,
      ...(googleBudgetBased ? { thinkingBudgets: Object.fromEntries(["minimal", "low", "medium", "high"].map((key: string) => [key, googleBudget])) } : {}),
      reasoning: level === "off" ? undefined : level, maxTokens,
      transport: "sse", maxRetries: 0 },
    metadata: { requestedEffort: effort, effectiveEffort: level === "off" ? "none" : level,
      textTargetTokens, minimumAnswerTokens, reasoningAllowance, providerMaxTokens, availableProviderTokens },
  };
}
