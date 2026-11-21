// Shared Pi 1.6.0 Codex wire validation. No authority, transport, or pricing.
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CACHE_ANCHOR_EFFORT = "medium";
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validCodexOutputLimit(body, outputMax) {
  // The field is optional (not every model supports it). This is a wire
  // bound only: admission and settlement still use their existing worst case.
  const cap = body.max_output_tokens;
  return !Object.hasOwn(body, "max_output_tokens")
    || Number.isSafeInteger(cap) && cap >= 16 && cap <= outputMax;
}

export function validCodexReasoning(body, expectedEffort) {
  const items = body.input;
  if (!Array.isArray(items)) return false;
  let configured = false;
  for (const [index, item] of items.entries()) {
    if (item?.type !== "configuration_update") continue;
    configured = true;
    if (!exactKeys(item, ["type", "reasoning"]) || !exactKeys(item.reasoning, ["effort"]) || !EFFORTS.has(item.reasoning.effort)) return false;
    // Historical updates prefix replayed assistant output. Only the last
    // item can select the next inference effort; an update in a user/tool
    // position or a second consecutive update is not a Pi wire shape.
    if (index < items.length - 1) {
      const next = items[index + 1];
      if (!(next?.type === "reasoning" || next?.type === "function_call" || next?.type === "message" && next.role === "assistant")) return false;
    }
  }
  const final = items.at(-1);
  if (configured && (body.reasoning?.effort !== CACHE_ANCHOR_EFFORT || final?.type !== "configuration_update")) return false;
  if (expectedEffort === undefined) return true;
  const effective = configured ? final.reasoning.effort : body.reasoning?.effort;
  return expectedEffort === "off" ? effective === undefined || effective === "none" : effective === expectedEffort;
}
