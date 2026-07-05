/** Extract the first top-level JSON value (object or array) from an LLM completion, tolerating prose/code fences. */
export function parseJsonLoose<T>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = fenced?.[1] ?? text;
  // Scan EVERY bracket-like start, not just the first: prose, markdown citations (`[1]`), or
  // pseudocode can put a stray `[`/`{` ahead of the real payload. Keep the LARGEST value that
  // actually parses, so a trivial "[1]" citation loses to the real object/array later on.
  let best: { value: unknown; len: number } | undefined;
  for (let i = 0; i < body.length; i += 1) {
    const open = body[i];
    if (open !== "[" && open !== "{") continue;
    const end = matchingClose(body, i, open);
    if (end === -1) continue;
    const slice = body.slice(i, end + 1);
    try {
      const value = JSON.parse(slice) as unknown;
      if (best === undefined || slice.length > best.len) best = { value, len: slice.length };
      i = end; // this span parsed — skip the nested brackets it already covers
    } catch {
      // Not valid JSON at this position; try the next bracket.
    }
  }
  return best?.value as T | undefined;
}

/** Index of the bracket closing `body[start]` (an `[` or `{`), respecting strings/escapes; -1 if unbalanced. */
function matchingClose(body: string, start: number, open: "[" | "{"): number {
  const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === undefined) break;
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === open) depth += 1; else if (ch === close) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}
