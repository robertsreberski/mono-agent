import type { ContinuityPreviewRange } from "./continuity-contracts.js";
const expression = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");

/** Versioned lexical ranking, not a claim about truth, authority or supersession. */
export function relevanceQuery(query: string) {
  const folded = query.toLowerCase();
  const terms = [...new Set(folded.match(/[\p{L}\p{N}\p{M}_]+(?:[-.:/][\p{L}\p{N}\p{M}_]+)*/gu) ?? [])].slice(0, 16);
  return { folded, terms, patterns: terms.map(expression), phrase: expression(folded), mode: terms.length ? "relevance" as const : "literal" as const };
}
export function relevanceMatch(text: string, query: ReturnType<typeof relevanceQuery>): { score: number; position: number } | undefined {
  // Regex Unicode case folding avoids allocating a second full body. İ is the
  // Unicode lowercase expansion; retain lower()-style matching on that rare path.
  const expanded = text.includes("İ"), searchable = expanded ? text.toLowerCase() : text;
  const locate = (pattern: RegExp) => pattern.exec(searchable)?.index ?? -1;
  const originalPosition = (position: number) => {
    if (!expanded) return position;
    let original = 0, folded = 0;
    for (const character of text) { if (folded >= position) break; original += character.length; folded += character.toLowerCase().length; }
    return original;
  };
  const phrase = locate(query.phrase);
  if (query.mode === "literal") return phrase < 0 ? undefined : { score: 1, position: originalPosition(phrase) };
  // One position per distinct term: repeating a term cannot buy more coverage.
  const positions = query.patterns.map(locate).filter(position => position >= 0);
  if (!positions.length) return undefined;
  const first = Math.min(...positions), span = Math.max(...positions) - first;
  return { score: positions.length * 1_000_000 + (phrase >= 0 ? 100_000 : 0) + Math.max(0, 65_535 - span), position: originalPosition(phrase >= 0 ? phrase : first) };
}

/** Byte ranges refer to digest-verified sanitized retained text, not raw text. */
export function matchedPreview(text: string, position: number): { preview: string; previewRange: ContinuityPreviewRange } {
  const bytes = Buffer.from(text), matchByte = Buffer.byteLength(text.slice(0, position));
  let start = Math.max(0, matchByte - 160);
  while (start > 0 && continuation(bytes[start])) start--;
  let end = Math.min(bytes.length, start + 512);
  while (end > start && continuation(bytes[end])) end--;
  // Prefer a nearby line/sentence boundary, retaining negation before the hit.
  const lead = bytes.subarray(start, matchByte).toString("utf8");
  const boundary = Math.max(lead.lastIndexOf("\n"), lead.lastIndexOf(". "));
  if (boundary >= 0) start += Buffer.byteLength(lead.slice(0, boundary + 1));
  return { preview: bytes.subarray(start, end).toString("utf8"), previewRange: {
    start, end, clippedBefore: start > 0, clippedAfter: end < bytes.length, complete: false,
  } };
}
function continuation(byte: number | undefined): boolean { return byte !== undefined && (byte & 0xc0) === 0x80; }
