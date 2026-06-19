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

// Best-effort extraction of the model's real context-window ceiling from an
// overflow error. Providers usually state the limit ("maximum context length is
// 200000 tokens", "context window of 128000", "this model supports at most
// 32768 tokens"). We use the discovered value to lower the proactive compaction
// trigger on the running model so a wrong/default contextWindow self-corrects.
// Returns the smallest plausible token count found, or null.
export function parseContextLimitFromError(message) {
  const text = String(message || "");
  if (!text) return null;
  // Capture a number that sits next to context/window/token wording, tolerating
  // separators in large numbers (e.g. "128,000" or "128 000"). Phrases like
  // "however you requested 210000 tokens" would over-count the limit, so we
  // anchor on max/limit/context/window wording and take the smallest match.
  const patterns = [
    /(?:maximum|max(?:imum)?)\s+context\s+(?:length|window)\s*(?:is|of|=|:)?\s*([\d][\d,_ ]*)/ig,
    /context\s+(?:length|window|budget)\s*(?:is|of|=|:)?\s*([\d][\d,_ ]*)/ig,
    /(?:maximum|max(?:imum)?|at most|supports?(?:\s+up\s+to)?)\s+([\d][\d,_ ]*)\s*(?:input\s+)?tokens?/ig,
    /(?:token|context)\s+limit\s*(?:is|of|=|:)?\s*([\d][\d,_ ]*)/ig,
  ];
  const found = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(String(m[1]).replace(/[,_ ]/g, ""));
      // Guard against matching small token counts (e.g. "8 tokens") that are not
      // a real window; a context window is at least a few thousand tokens.
      if (Number.isFinite(n) && n >= 1000) found.push(n);
    }
  }
  if (found.length === 0) return null;
  return Math.min(...found);
}
