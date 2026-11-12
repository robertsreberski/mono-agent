import type { ContinuityKind } from "./continuity-contracts.js";
import { expression, relevanceMatch, relevanceQuery } from "./relevance.js";

// Fixed, bounded English discovery vocabulary, not a semantic/authority model.
const correctionWords = ["correction", "corrected", "changed", "revised", "amended", "instead", "actually", "edit", "edited", "update", "updated"];
const eventWords = ["event", "happened", "occurred", "scheduled", "moved", "cancelled", "postponed", "decided", "requested", "reported", "original", "previous"];
const historicalWords = new Set(["historical", "history", "earlier", "original", "previous", "predecessor", "first", "before", "past", "when", "old", "prior", "initial"]);
const currentWords = new Set(["current", "currently", "latest", "now", "today"]);
const intentWords = new Set([...correctionWords, ...eventWords, ...historicalWords, ...currentWords,
  "change", "revision", "request", "decision", "corrections", "events", "what", "which", "was", "were", "the", "a", "an", "of", "for", "to", "and", "or", "is", "it", "did"]);
const correction = /\b(?:correction|corrected|changed|revised|amended|instead|actually|edit(?:ed)?|updat(?:e|ed))\b/iu;
const event = /\b(?:scheduled|moved|cancelled|canceled|postponed|decided|requested|reported|original report|occurred|happened)\b/iu;
const qualified = /\b(?:quot(?:e|ed|ation)|hypothetical|example|suppose|might|would|if|not approved|not a decision|not a correction)\b|```|^\s*>|["“][^"”\n]*\b(?:correction|changed|instead|revised)\b/imu;
const userKinds = new Set<ContinuityKind>(["user", "owner", "other-user"]);

export function evidenceQuery(text: string) {
  const base = relevanceQuery(text);
  const historical = !base.terms.some(term => currentWords.has(term)) && base.terms.some(term => historicalWords.has(term));
  const wantsCorrection = base.terms.some(term => correctionWords.includes(term) || ["change", "revision", "corrections"].includes(term));
  const wantsEvent = historical || base.terms.some(term => eventWords.includes(term) || ["request", "decision", "events"].includes(term));
  const content = base.terms.map((term, index) => ({ term, pattern: base.patterns[index]! })).filter(({ term }) => !intentWords.has(term));
  // Components must be whole delimiter-separated units, never arbitrary
  // substrings. Numeric identifiers retain their entire spelling: expanding
  // ACT-77 to ACT would admit ACT-770. Pure numeric components are never added.
  const components = content.map(({ term }) => {
    if (!/\p{L}/u.test(term) || term.length < 3) return [];
    const values = [term, ...(/\p{N}/u.test(term) ? [] : term.split(/[-_.:/]/u).filter(part => part.length >= 4))];
    return [...new Set(values)].slice(0, 4).map(value => expression(value, true, true));
  });
  const expansions = [...new Set([...(wantsCorrection ? correctionWords : []), ...(wantsEvent ? eventWords : [])])].slice(0, 24).map(word => expression(word, true));
  return { ...base, base, content, components, historical, wantsCorrection, wantsEvent, expansions,
    intent: historical || wantsCorrection || wantsEvent,
    // Complementary preview selection may also find the lower-weight component.
    patterns: [...base.patterns, ...components.flat()] };
}

export function evidenceMatch(text: string, query: ReturnType<typeof evidenceQuery>, kind: ContinuityKind) {
  if (query.mode === "literal" || query.content.length === 0) return relevanceMatch(text, query.base);
  if (!query.intent) {
    const original = relevanceMatch(text, query.base);
    if (original) return original;
    // Most absent scans have no component hits either. Avoid per-record arrays
    // and intermediate match/filter collections on that capacity-critical path.
    const componentText = text.includes("İ") ? text.toLowerCase() : text;
    let found = false;
    for (const patterns of query.components) {
      for (const pattern of patterns) if (pattern.test(componentText)) { found = true; break; }
      if (found) break;
    }
    if (!found) return undefined;
  }
  // Match the same Unicode case-folding representation as the frozen v1 matcher.
  const expanded = text.includes("İ"), searchable = expanded ? text.toLowerCase() : text;
  const full = query.content.map(({ pattern }) => pattern.exec(searchable));
  const component = query.components.map((patterns, index) => full[index] ? null : patterns.map(pattern => pattern.exec(searchable)).find(Boolean) ?? null);
  const anchors = [...full.filter(Boolean), ...component.filter(Boolean)] as RegExpExecArray[];
  // Expansion/intent vocabulary alone cannot make a specific query eligible.
  if (!anchors.length) return undefined;
  const first = anchors.reduce((a, b) => a.index <= b.index ? a : b);
  const position = (index: number) => {
    if (!expanded) return index;
    let originalIndex = 0, foldedIndex = 0;
    for (const character of text) { if (foldedIndex >= index) break; originalIndex += character.length; foldedIndex += character.toLowerCase().length; }
    return originalIndex;
  };
  const phrase = query.base.phrase.exec(searchable), selected = phrase ?? first;
  const start = position(selected.index), end = position(selected.index + selected[0].length);
  const span = Math.max(...anchors.map(match => match.index)) - first.index;
  let score = full.filter(Boolean).length * 1_000_000 + Math.min(600_000, component.filter(Boolean).length * 200_000)
    + (phrase ? 100_000 : 0) + Math.max(0, 65_535 - span);
  // Original intent terms outrank expansions but cannot swamp a content term.
  score += Math.min(60_000, query.base.patterns.filter((pattern, index) => intentWords.has(query.base.terms[index]!) && pattern.test(searchable)).length * 20_000);
  if (!query.intent) return { score, position: start, end };
  // Only local, bounded evidence around this record's hit is considered. No
  // adjacent-turn inference, event-date interpretation or global echo collection.
  const context = text.slice(Math.max(0, start - 192), Math.min(text.length, end + 384));
  const repeated = [...context.matchAll(new RegExp(expression(first[0], true).source, "giv"))].length > 2;
  const usable = !qualified.test(context) && !repeated;
  const hasCorrection = usable && correction.test(context), hasEvent = usable && event.test(context);
  if (hasCorrection && (query.wantsCorrection || query.historical)) score += 160_000;
  if (hasEvent && query.wantsEvent) score += 80_000;
  if (hasCorrection && (query.wantsCorrection || query.historical) && userKinds.has(kind) && Buffer.byteLength(text) <= 256) score += 80_000;
  if (usable) score += Math.min(60_000, query.expansions.filter(pattern => pattern.test(context)).length * 10_000);
  if (query.historical && kind === "assistant") score -= 40_000 + (!hasCorrection && !hasEvent ? 120_000 : 0);
  if (query.historical && repeated) score -= 60_000;
  return { score, position: start, end };
}
