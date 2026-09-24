/**
 * Exact-match anchors for embedding-first recall: names, numbers and dates.
 * Shared generic words are deliberately not anchors; semantic similarity
 * carries them. Matching is Unicode-aware and accent-insensitive.
 */

/** Largest semantic bonus a record can earn by containing every query anchor. */
export const ANCHOR_BOOST = 0.15;

// Capitalized question/imperative words that start queries in the languages the
// capture pipeline sees most often. They are never names.
const NON_NAME_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "did", "do", "does", "for", "from",
  "had", "has", "have", "how", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "our",
  "please", "remind", "show", "tell", "that", "the", "this", "to", "was", "we", "were", "what",
  "when", "where", "which", "who", "whom", "whose", "why", "will", "with", "would", "you", "your",
  // Dutch, German, Italian, Spanish, French question words and articles.
  "wat", "wanneer", "waar", "wie", "welke", "hoe", "de", "het", "een",
  "was", "wann", "wo", "wer", "welche", "wie", "der", "die", "das",
  "cosa", "quando", "dove", "chi", "quale", "come", "il", "lo", "la", "le", "gli", "di",
  "qué", "que", "cuándo", "donde", "dónde", "quién", "cuál", "cómo", "el", "los", "las",
  "quoi", "quand", "où", "qui", "quel", "quelle", "comment", "les", "du", "des",
].map(fold));

const WORD = /[\p{L}\p{N}]+/gu;

export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("und");
}

/** Folded word set of a text. */
export function anchorWords(text: string): ReadonlySet<string> {
  return new Set((text.match(WORD) ?? []).map(fold));
}

/** Folded words that are capitalized somewhere other than the start of a sentence. */
function properNouns(text: string): Set<string> {
  const out = new Set<string>();
  for (const sentence of text.split(/[.!?\n]+\s*/u)) {
    const words = sentence.match(WORD) ?? [];
    for (const word of words.slice(1)) if (/^\p{Lu}/u.test(word)) out.add(fold(word));
  }
  return out;
}

/**
 * Query anchors: words with a digit (numbers, years, date parts), capitalized
 * query words that are not question/imperative words, and query words that the
 * candidate records spell as proper nouns (so lower-case queries still anchor
 * names).
 */
export function queryAnchors(query: string, candidateTexts: readonly string[]): ReadonlySet<string> {
  const anchors = new Set<string>();
  const recordNames = new Set<string>();
  for (const text of candidateTexts) for (const word of properNouns(text)) recordNames.add(word);
  for (const raw of query.match(WORD) ?? []) {
    const word = fold(raw);
    if (NON_NAME_WORDS.has(word)) continue;
    if (/\p{N}/u.test(word) || /^\p{Lu}/u.test(raw) || recordNames.has(word)) anchors.add(word);
  }
  return anchors;
}

/** Fraction of query anchors present in a record, 0 when the query has none. */
export function anchorCoverage(anchors: ReadonlySet<string>, text: string): number {
  if (anchors.size === 0) return 0;
  const words = anchorWords(text);
  let matched = 0;
  for (const anchor of anchors) if (words.has(anchor)) matched += 1;
  return matched / anchors.size;
}
