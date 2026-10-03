/**
 * Exact-match anchors for embedding-first recall: entity names, numbers and
 * dates. Shared generic words are deliberately not anchors; semantic
 * similarity carries them. Matching is Unicode-aware and accent-insensitive.
 */

/** Largest semantic bonus a record can earn by containing every numeric/date query anchor. */
export const ANCHOR_BOOST = 0.15;
/**
 * Largest bonus for name anchors. The embedding already carries a name, so a
 * full 0.15 counted it twice: every record about a named person outscored true
 * answers to other questions even when nothing in it answered this one. A
 * smaller name bonus still breaks near-ties toward the named record.
 */
export const NAME_ANCHOR_BOOST = 0.08;

// Whole numbers, dates, times and numeric identifiers stay one token
// (`1988-11-02`, `17/05/1990`, `08:30`, `4471`) so an anchor never matches a
// component number of a different date. Other words are letter/number runs.
const WORD = /\p{N}+(?:[-/.:]\p{N}+)*|[\p{L}\p{M}\p{N}]+/gu;

export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("und");
}

/** Tokens of a text after Unicode normalization (composed and decomposed forms agree). */
function words(text: string): string[] {
  return text.normalize("NFKC").match(WORD) ?? [];
}

/** Folded word set of a text. */
export function anchorWords(text: string): ReadonlySet<string> {
  return new Set(words(text).map(fold));
}

/**
 * Query anchors: whole numbers, dates and numeric identifiers, plus query words
 * that belong to the name of an entity associated with a candidate record. No
 * question-word or stop-word list: names come from the entity graph, so this
 * works the same in any language. Name words shorter than three letters are
 * too ambiguous to anchor.
 */
export function queryAnchors(query: string, entityNames: readonly string[]): ReadonlySet<string> {
  const anchors = new Set<string>();
  const nameWords = new Set<string>();
  for (const name of entityNames) for (const word of words(name)) if (!/\p{N}/u.test(word) && [...word].length >= 3) nameWords.add(fold(word));
  for (const raw of words(query)) {
    const word = fold(raw);
    if (/\p{N}/u.test(word) || nameWords.has(word)) anchors.add(word);
  }
  return anchors;
}

/**
 * Bonus for the query anchors a record contains: each anchor carries an equal
 * share, worth `ANCHOR_BOOST` for numbers/dates and `NAME_ANCHOR_BOOST` for names.
 */
export function anchorBoost(anchors: ReadonlySet<string>, text: string): number {
  if (anchors.size === 0) return 0;
  const words = anchorWords(text);
  let boost = 0;
  for (const anchor of anchors) {
    if (words.has(anchor)) boost += /\p{N}/u.test(anchor) ? ANCHOR_BOOST : NAME_ANCHOR_BOOST;
  }
  return boost / anchors.size;
}

/** Fraction of query anchors present in a record, 0 when the query has none. */
export function anchorCoverage(anchors: ReadonlySet<string>, text: string): number {
  if (anchors.size === 0) return 0;
  const words = anchorWords(text);
  let matched = 0;
  for (const anchor of anchors) if (words.has(anchor)) matched += 1;
  return matched / anchors.size;
}
