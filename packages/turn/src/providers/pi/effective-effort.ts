/** Read only the final provider-shaped effort; never retain payload text. */
export function effectivePayloadEffort(payload: any, model: any): string;
export function effectivePayloadEffort(payload: any, model: any): string | undefined {
  const bounded = (value: unknown) => typeof value === "string" && /^(none|off|minimal|low|medium|high|xhigh|max|ultra)$/i.test(value)
    ? value.toLowerCase() === "off" ? "none" : value.toLowerCase() : undefined;
  if (model.api === "anthropic-messages") {
    if (payload.thinking?.type === "disabled") return "none";
    if (model.compat?.supportsMidConvoEffort) {
      const active = payload.messages?.findLast((message: any) => message.role === "system" && message.output_config?.effort);
      return bounded(active?.output_config?.effort);
    }
    return bounded(payload.output_config?.effort) ?? (!model.reasoning ? "none" : undefined);
  }
  if (model.api === "openai-completions") {
    return bounded(payload.reasoning_effort) ?? (payload.thinking?.type === "disabled" || payload.enable_thinking === false || !model.reasoning ? "none" : undefined);
  }
  if (["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(model.api)) return bounded(payload.reasoning?.effort) ?? (!model.reasoning ? "none" : undefined);
  const thinking = payload.config?.thinkingConfig;
  return bounded(thinking?.thinkingLevel) ?? (thinking?.thinkingBudget === 0 || !model.reasoning ? "none" : undefined);
}
