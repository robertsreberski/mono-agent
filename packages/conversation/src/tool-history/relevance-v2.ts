import type { ContinuityKind } from "./continuity-contracts.js";
import { expression, matchingText, retainedPosition, relevanceMatch, relevanceQuery } from "./relevance.js";

// Fixed, bounded English discovery vocabulary, not a semantic/authority model.
const correctionWords = ["correction", "corrected", "changed", "revised", "amended", "instead", "actually", "edit", "edited", "update", "updated"];
const eventWords = ["event", "happened", "occurred", "scheduled", "moved", "cancelled", "postponed", "decided", "requested", "reported", "original", "previous"];
const historicalWords = new Set(["historical", "history", "original", "originally", "previous", "previously", "earlier", "prior", "initial", "initially", "predecessor", "before-correction"]);
const currentWords = new Set(["current", "currently", "latest", "now", "today"]);
const intentWords = new Set([...correctionWords, ...eventWords, ...historicalWords, ...currentWords,
  "change", "revision", "request", "decision", "corrections", "events", "what", "which", "when", "how", "was", "were", "the", "a", "an", "of", "for", "to", "and", "or", "is", "it", "did", "in", "on", "at", "used"]);
const correction = /\b(?:correction|corrected|changed|revised|amended|instead|actually|edit(?:ed)?|updat(?:e|ed))\b/giu;
const event = /\b(?:scheduled|moved|cancelled|canceled|postponed|decided|requested|reported|original|occurred|happened)\b/giu;
const hypothetical = /\b(?:hypothetical(?:ly)?|suppos(?:e|ing)|imagine|counterfactual|what\s+if|for\s+example)\b|\bif\b[^;.!?\n]*\b(?:would|could|might)\b/iu;
const quoted = /\bquot(?:e|ed|ation)\b|```|^\s*>|["“`][^"”`\n]*\b(?:correction|corrected|changed|revised|amended|instead|actually|updated|scheduled|moved|original|requested)\b/iu;
// Negation must precede the signal in the same clause, within three words.
// It does not veto a separate factual clause (or a later permission disclaimer).
const negated = /\b(?:not|never|no|without|cannot|can't|isn't|wasn't|didn't|hasn't|haven't|won't|don't|doesn't)(?:\s+[\p{L}\p{N}'’-]+){0,3}\s*$/iu;
const userKinds = new Set<ContinuityKind>(["user", "owner", "other-user"]);
const echoKinds = new Set<ContinuityKind>(["assistant", "summary"]);
const globalPattern = (pattern: RegExp) => new RegExp(pattern.source, pattern.flags + "g");

export function evidenceQuery(text: string) {
  const base = relevanceQuery(text);
  const historical = !base.terms.some(term => currentWords.has(term))
    && (base.terms.some(term => historicalWords.has(term)) || /\bused\s+to\b/iu.test(text));
  const wantsCorrection = base.terms.some(term => correctionWords.includes(term) || ["change", "revision", "corrections"].includes(term));
  const wantsEvent = historical || base.terms.some(term => eventWords.includes(term) || ["request", "decision", "events"].includes(term));
  const content = base.terms.map((term, index) => ({ term, pattern: base.patterns[index]! })).filter(({ term }) => !intentWords.has(term))
    .map(entry => ({ ...entry, global: globalPattern(entry.pattern) }));
  // Components must be whole delimiter-separated units, never arbitrary
  // substrings. Numeric identifiers retain their entire spelling: expanding
  // ACT-77 to ACT would admit ACT-770. Pure numeric components are never added.
  const components = content.map(({ term }) => {
    if (!/\p{L}/u.test(term) || term.length < 3) return [];
    const values = [term, ...(/\p{N}/u.test(term) ? [] : term.split(/[-_.:/]/u).filter(part => part.length >= 4))];
    return [...new Set(values)].slice(0, 4).map(value => {
      const pattern = expression(value, true, true);
      return { pattern, global: globalPattern(pattern) };
    });
  });
  const expansions = [...new Set([...(wantsCorrection ? correctionWords : []), ...(wantsEvent ? eventWords : [])])].slice(0, 24).map(word => expression(word, true));
  const intentPatterns = base.patterns.filter((_pattern, index) => intentWords.has(base.terms[index]!));
  return { ...base, base, content, components, historical, wantsCorrection, wantsEvent, expansions, intentPatterns,
    intent: historical || wantsCorrection || wantsEvent,
    // Complementary preview selection may also find the lower-weight component.
    patterns: [...base.patterns, ...components.flat().map(entry => entry.pattern)] };
}

function repeated(pattern: RegExp, context: string): boolean {
  pattern.lastIndex = 0;
  let count = 0;
  while (count < 3 && pattern.exec(context)) count++;
  pattern.lastIndex = 0;
  return count === 3;
}
function signal(pattern: RegExp, clause: string): boolean {
  pattern.lastIndex = 0;
  let found = false, match: RegExpExecArray | null;
  while ((match = pattern.exec(clause)) !== null) {
    if (!negated.test(clause.slice(Math.max(0, match.index - 64), match.index))) { found = true; break; }
  }
  pattern.lastIndex = 0;
  return found;
}
function signals(context: string) {
  let hasCorrection = false, hasEvent = false;
  for (const clause of context.split(/[.!?;\n]+/u)) {
    if (hypothetical.test(clause) || quoted.test(clause)) continue;
    hasCorrection ||= signal(correction, clause);
    hasEvent ||= signal(event, clause);
  }
  return { hasCorrection, hasEvent };
}

export function evidenceMatch(text: string, query: ReturnType<typeof evidenceQuery>, kind: ContinuityKind) {
  if (query.mode === "literal") return relevanceMatch(text, query.base);
  // All lexical v2 paths, including ordinary questions, need a content anchor.
  // A stop-word/intent-only query cannot confer relevance. V1 is unchanged.
  if (query.content.length === 0) return undefined;
  const { expanded, searchable } = matchingText(text);
  let full = 0, component = 0, first = Number.MAX_SAFE_INTEGER, last = 0, firstEnd = 0;
  let firstGlobal: RegExp | undefined;
  for (let index = 0; index < query.content.length; index++) {
    const entry = query.content[index]!;
    let match = entry.pattern.exec(searchable), global = entry.global;
    if (match) full++;
    else {
      for (const candidate of query.components[index]!) {
        match = candidate.pattern.exec(searchable);
        if (match) { global = candidate.global; component++; break; }
      }
    }
    if (!match) continue;
    if (match.index < first) { first = match.index; firstEnd = first + match[0].length; firstGlobal = global; }
    last = Math.max(last, match.index);
  }
  if (firstGlobal === undefined) return undefined;
  const phrase = query.base.phrase.exec(searchable);
  const start = retainedPosition(text, phrase?.index ?? first, expanded);
  const end = retainedPosition(text, phrase ? phrase.index + phrase[0].length : firstEnd, expanded);
  let score = full * 1_000_000 + Math.min(600_000, component * 200_000)
    + (phrase ? 100_000 : 0) + Math.max(0, 65_535 - (last - first));
  let intentCount = 0;
  for (const pattern of query.intentPatterns) if (pattern.test(searchable) && ++intentCount === 3) break;
  score += intentCount * 20_000;
  if (!query.intent) return { score, position: start, end };
  // Only local, bounded evidence around this record's hit is considered. No
  // adjacent-turn inference, event-date interpretation or global echo collection.
  const context = text.slice(Math.max(0, start - 192), Math.min(text.length, end + 384));
  const repeats = repeated(firstGlobal, expanded ? context.toLowerCase() : context);
  const echo = query.historical && echoKinds.has(kind);
  const { hasCorrection, hasEvent } = repeats || echo ? { hasCorrection: false, hasEvent: false } : signals(context);
  if (hasCorrection && (query.wantsCorrection || query.historical)) score += 160_000;
  if (hasEvent && query.wantsEvent) score += 80_000;
  if (hasCorrection && (query.wantsCorrection || query.historical) && userKinds.has(kind) && Buffer.byteLength(text) <= 256) score += 80_000;
  if ((hasCorrection || hasEvent) && !echo) {
    let count = 0;
    for (const pattern of query.expansions) if (pattern.test(context) && ++count === 6) break;
    score += count * 10_000;
  }
  if (echo) score -= 40_000 + (!hasCorrection && !hasEvent ? 120_000 : 0);
  if (query.historical && repeats) score -= 60_000;
  return { score, position: start, end };
}
