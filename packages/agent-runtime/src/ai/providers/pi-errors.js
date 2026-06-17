// Shared pi error-normalization helpers.
//
// Extracted so the pi-native bridge does not have to import from a sibling
// provider module. Both the message-normalizer (unwrap nested provider error
// envelopes) and the context-limit classifier are pure string helpers with no
// runtime dependencies.

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export function normalizePiErrorMessage(message) {
  const text = String(message || "").trim();
  if (!text) return null;
  const codexMatch = /^Codex error:\s*(\{[\s\S]*\})$/i.exec(text);
  const parsed = tryParseJson(codexMatch ? codexMatch[1] : text);
  const nested = parsed?.error || parsed;
  if (typeof nested?.message === "string" && nested.message.trim()) return nested.message.trim();
  if (typeof nested?.error?.message === "string" && nested.error.message.trim()) return nested.error.message.trim();
  return text;
}

export function isContextLimitError(message) {
  const text = String(message || "");
  // Rate-limit wording takes precedence: it is a throttle, not a context overflow.
  if (/rate limit|too many requests/i.test(text)) return false;
  // Broadened to catch the many ways providers phrase a context/token overflow:
  // "context length/window/budget", "max(imum) tokens", "token limit",
  // "too many tokens", "prompt (is) too long", "exceeds the context/maximum/max",
  // "input tokens/exceeds", "output token(s)", "token(s) exceed".
  return /context[_ ](?:length|window|budget)|max(?:imum)?[_ ]?tokens?|token[_ ]limit|too[_ ]many[_ ]tokens?|prompt[_ ](?:is[_ ])?too[_ ]long|exceeds?[_ ](?:the context|maximum|max)|input[_ ](?:tokens?|exceeds)|output[_ ]tokens?|tokens?[_ ]exceed/i.test(text);
}
