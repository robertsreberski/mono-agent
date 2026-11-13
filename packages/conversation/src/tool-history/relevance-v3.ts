import { englishStopWords } from "./relevance-stopwords.js";
import type { ContinuityKind } from "./continuity-contracts.js";
import { expression, matchingText, retainedPosition, relevanceMatch, relevanceQuery } from "./relevance.js";

// V3 is independent of the frozen v1/v2 scoring pipelines.
// Even the worst secondary advantage cannot compensate for one full content hit.
export const CONTENT_MATCH_SCORE = 2_000_000;
export const INTENT_MATCH_CAP = 250_000;
export const SECONDARY_MIN = -160_000 - 60_000;
export const SECONDARY_MAX = 600_000 + 100_000 + 65_535 + INTENT_MATCH_CAP
  + 160_000 + 80_000 + 80_000 + 60_000;
if (SECONDARY_MAX - SECONDARY_MIN >= CONTENT_MATCH_SCORE) throw new Error("secondary_score_range");

// Fixed, bounded English discovery vocabulary, not a semantic/authority model.
const correctionWords = ["correction", "corrected", "changed", "revised", "amended", "instead", "actually", "edit", "edited", "update", "updated"];
const eventWords = ["event", "happened", "occurred", "scheduled", "moved", "cancelled", "postponed", "decided", "requested", "reported", "original", "previous"];
const historicalWords = new Set(["historical", "history", "original", "originally", "previous", "previously", "earlier", "prior", "initial", "initially", "predecessor", "before-correction"]);
const currentWords = new Set(["current", "currently", "latest", "now", "today"]);
const intentWords = new Set([...correctionWords, ...eventWords, ...historicalWords, ...currentWords,
  "change", "revision", "request", "decision", "corrections", "events", "used"]);
// One general morphology definition drives record signals and query intent;
// lexical content matching itself is not stemmed or broadened.
const correctionVocabulary = "corrections?|correct(?:s|ed|ing)?|chang(?:e[sd]?|ing)|revis(?:e[sd]?|ing)|amend(?:s|ed|ing)?|fix(?:es|ed|ing)?|reschedul(?:e[sd]?|ing)|mov(?:e[sd]?|ing)|instead|actually|edit(?:s|ed|ing)?|updat(?:e[sd]?|ing)";
const correction = new RegExp(`\\b(?:${correctionVocabulary})\\b`, "giu");
const correctionTerm = new RegExp(`^(?:${correctionVocabulary})$`, "iu");
const isIntent = (term: string) => intentWords.has(term) || correctionTerm.test(term);
const eventVocabulary = "scheduled|moved|cancelled|canceled|postponed|decided|requested|reported|original|occurred|happened";
const event = new RegExp(`\\b(?:${eventVocabulary})\\b`, "giu");
const hypothetical = /\b(?:hypothetical(?:ly)?|suppos(?:e|ing)|imagine|counterfactual|what\s+if|for\s+example)\b|\bif\b[^;.!?\n]*\b(?:would|could|might|had|were)\b|(?:^|,)\s*(?:had\s+(?:[\p{L}\p{N}'’-]+\s+){1,8}been\b|were\s+\p{L})/iu;
// An opener begins a token, never the closing delimiter in a quoted name or
// an apostrophe inside a contraction. Both signal vocabularies are shared with
// record qualification, including their inflections and both cancel spellings.
const quoted = new RegExp(`\\bquot(?:e|ed|ation)\\b|\x60\x60\x60|^\\s*>|(?:^|[\\s\\p{Ps}\\p{Pi}])["'“‘\x60][^"'”’\x60\\n]*\\b(?:${correctionVocabulary}|${eventVocabulary})\\b`, "iu");
// Negation must precede the signal in the same clause, within three words.
// It does not veto a separate factual clause (or a later permission disclaimer).
const negated = /\b(?:not|never|no|without|cannot|can['’]t|isn['’]t|wasn['’]t|didn['’]t|hasn['’]t|haven['’]t|won['’]t|don['’]t|doesn['’]t)(?:\s+[\p{L}\p{N}'’-]+){0,3}\s*$/iu;
const userKinds = new Set<ContinuityKind>(["user", "owner", "other-user"]);
const echoKinds = new Set<ContinuityKind>(["assistant", "summary"]);
const globalPattern = (pattern: RegExp) => new RegExp(pattern.source, pattern.flags + "g");

export function contentFirstQuery(text: string) {
  const base = relevanceQuery(text);
  // Purpose has a passive frame with an immediate infinitive head. Inverted
  // questions may place a short noun phrase after the auxiliary, but not an
  // embedded relative clause or a new personal subject ("that we used to ...").
  // The frame supplies the grammatical verb slot; no corpus-specific verb list.
  const directPurpose = /\b(?:am|is|are|was|were|be|been|being)\s+(?:being\s+)?used\s+to\s+([\p{L}]+)/iu.exec(text);
  const questionPurpose = /\b(?:what|which|how|why)(?:\s+[\p{L}]+){0,4}\s+(?:am|is|are|was|were|be|been|being)\s+(?:(?!(?:that|which|who|whom|whose|where|when|if|because|while|although|whether|and|or|but|we|i|you|he|she)\b)[\p{L}\p{N}_'’-]+\s+){1,6}used\s+to\s+([\p{L}]+)/iu.exec(text);
  const head = (directPurpose ?? questionPurpose)?.[1]?.toLowerCase();
  const purpose = head !== undefined && (!englishStopWords.has(head) || ["be", "do", "have"].includes(head));
  const historical = !base.terms.some(term => currentWords.has(term))
    && (base.terms.some(term => historicalWords.has(term)) || (!purpose && /\bused\s+to\b/iu.test(text)));
  const wantsCorrection = base.terms.some(term => correctionTerm.test(term) || term === "revision");
  const wantsEvent = historical || base.terms.some(term => eventWords.includes(term) || ["request", "decision", "events"].includes(term));
  const nonStop = base.terms.map((term, index) => ({ term, pattern: base.patterns[index]! })).filter(({ term }) => !englishStopWords.has(term));
  const regular = nonStop.filter(({ term }) => !isIntent(term));
  // Intent-only queries still have literal anchors. With no non-stop terms at
  // all, preserve v1 eligibility rather than silently manufacturing no matches.
  const content = (regular.length ? regular : nonStop).map(entry => ({ ...entry, global: globalPattern(entry.pattern) }));
  const fallbackV1 = content.length === 0;
  // Components must be whole delimiter-separated units, never arbitrary
  // substrings. Numeric identifiers retain their entire spelling: expanding
  // ACT-77 to ACT would admit ACT-770. Pure numeric components are never added.
  const components = content.map(({ term }) => {
    if (!/\p{L}/u.test(term) || term.length < 3) return undefined;
    const values = [term, ...(/\p{N}/u.test(term) ? [] : term.split(/[-_.:/]/u).filter(part => part.length >= 4))];
    const patterns = [...new Set(values)].slice(0, 4).map(value => expression(value, true, true));
    // One body scan per term's component group, not up to four scans (including
    // a duplicate of the full term). All construction stays on the query path.
    const pattern = new RegExp(patterns.map(part => `(?:${part.source})`).join("|"), "iv");
    return { pattern, global: globalPattern(pattern) };
  });
  const expansions = [...new Set([...(wantsCorrection ? correctionWords : []), ...(wantsEvent ? eventWords : [])])].slice(0, 24).map(word => expression(word, true));
  // Literal intent is a single bounded tie-breaker. When intent terms become
  // content fallback, do not count them again; stop words never earn intent credit.
  const intentPatterns = regular.length ? nonStop.filter(({ term }) => isIntent(term)).map(entry => entry.pattern) : [];
  return { ...base, base, content, components, fallbackV1, historical, wantsCorrection, wantsEvent, expansions, intentPatterns,
    intent: historical || wantsCorrection || wantsEvent,
    // Complementary windows prioritize true content, then its component groups;
    // never spend a second window on a stop word or an intent-only fallback.
    patterns: [...regular.map(entry => entry.pattern), ...components.flatMap((entry, index) => entry && !isIntent(content[index]!.term) ? [entry.pattern] : [])] };
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

export function contentFirstMatch(text: string, query: ReturnType<typeof contentFirstQuery>, kind: ContinuityKind) {
  if (query.mode === "literal" || query.fallbackV1) return relevanceMatch(text, query.base);
  const { expanded, searchable } = matchingText(text);
  let full = 0, component = 0, first = Number.MAX_SAFE_INTEGER, last = 0, firstEnd = 0;
  let firstGlobal: RegExp | undefined;
  for (let index = 0; index < query.content.length; index++) {
    const entry = query.content[index]!;
    let match = entry.pattern.exec(searchable), global = entry.global;
    if (match) full++;
    else {
      const candidate = query.components[index];
      if (candidate) {
        match = candidate.pattern.exec(searchable);
        if (match) { global = candidate.global; component++; }
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
  let score = full * CONTENT_MATCH_SCORE + Math.min(600_000, component * 200_000)
    + (phrase ? 100_000 : 0) + Math.max(0, 65_535 - (last - first));
  if (query.intentPatterns.some(pattern => pattern.test(searchable))) score += INTENT_MATCH_CAP;
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
