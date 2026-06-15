/** Extract the first top-level JSON value (object or array) from an LLM completion, tolerating prose/code fences. */
export function parseJsonLoose<T>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = fenced?.[1] ?? text;
  const start = body.search(/[[{]/u);
  if (start === -1) return undefined;
  // Walk to the matching close bracket from `start`.
  const open = body[start]; const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === undefined) break;
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === open) depth += 1; else if (ch === close) { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return undefined;
  try { return JSON.parse(body.slice(start, end + 1)) as T; } catch { return undefined; }
}
