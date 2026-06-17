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
  if (/rate limit|too many requests/i.test(text)) return false;
  return /context[_ ]length[_ ]exceeded|exceeds the context window|too many tokens|maximum context length|token limit exceeded|prompt is too long/i.test(text);
}
