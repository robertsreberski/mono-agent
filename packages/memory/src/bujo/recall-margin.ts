/**
 * Clear-margin gate for automatic recall.
 *
 * The canonical direct-fact grammar (`recall-evidence.ts`) only accepts records
 * written as `X's Y is Z`. Real stores mostly hold ordinary single-clause
 * lines (`Morgan works at Initech as a data engineer.`). This gate accepts such
 * a line automatically only when all of these hold:
 *
 * 1. The question is a short direct question (`who`/`what`/`when`/`where`/
 *    `which`/`how old|much|many`), not about the current conversation.
 * 2. The top-ranked hit is one short clause: a single sentence of at most
 *    `CLEAR_MARGIN_MAX_WORDS` words, no subordinate clause and `and` only inside
 *    a comma list, with no negation, unknown, hedge, request
 *    or quotation language. An owner-report envelope (`The user said ...`) is
 *    unwrapped first.
 * 3. The line covers the question: it contains every content word of the
 *    question (names included, with small stem and synonym folding), and a
 *    date/time question needs a date or time value in the line. On a
 *    host-stamped owner turn a first-person question (`my`, `I`, `we`) is about the
 *    owner, whom capture records as `the user`: the line must say `user` or at
 *    least carry no other name's possessive (`Morgan's`). Elsewhere `my` could
 *    be anyone and the question abstains.
 * 4. The line leads the best hit that does not also pass (2) and (3) by at
 *    least `CLEAR_MARGIN`. Close hits that pass both are injected with it, up
 *    to `CLEAR_MARGIN_MAX_HITS`; more close candidates abstain.
 *
 * Choice, scoped-choice and scheduled questions never reach this gate: the
 * grammar in `recall-evidence.ts` decides their scope and conflict identity alone.
 *
 * Precision over recall: anything else abstains and stays available through
 * the MemoryRecall tool.
 */

import {
  ATTRIBUTED_REPORT_EXCLUSION,
  isConversationRelativeQuery,
  isIdentityBoundDirectFactQuery,
  NEGATION_OR_UNKNOWN,
  REPORTED_OR_DITRANSITIVE,
} from "./recall-evidence.js";

/** Minimum lead of the answer line over the next unrelated hit. */
export const CLEAR_MARGIN = 0.05;
/** Longest evidence line accepted by the clear-margin gate. */
export const CLEAR_MARGIN_MAX_WORDS = 30;
/** Most close, question-covering lines injected together. */
export const CLEAR_MARGIN_MAX_HITS = 3;

interface MarginHit {
  readonly score: number;
  readonly record?: { readonly text: string };
}

const QUESTION = /^(?:who|what|when|where|which|how\s+(?:old|much|many|long))\b/iu;
const FIRST_PERSON = /\b(?:i|my|me|mine|we|us|our)\b/iu;
const FILLER = new Set([
  "a", "about", "am", "an", "are", "at", "be", "by", "can", "could", "current", "currently", "day", "did", "do",
  "does", "for", "from", "has", "have", "how", "i", "in", "is", "it", "me", "mine", "much", "many", "my", "now",
  "of", "old", "on", "or", "our", "please", "remind", "right", "s", "tell", "the", "their", "this", "time", "to",
  "us", "was", "we", "were", "what", "when", "where", "which", "who", "whom", "whose", "will", "with", "you",
  "your", "date", "long", "again", "exactly",
]);
const SYNONYMS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["born", "birth", "birthday", "birthdate", "bday"]),
  new Set(["work", "job", "employer", "employ", "employed", "company"]),
  new Set(["live", "home", "reside", "resid", "address"]),
];
const DATE_OR_TIME = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b|\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b|\b\d{1,2}\s*(?:am|pm)\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b(?:noon|midnight|morning|evening|weekly|daily)\b/iu;
const OWNER_REPORT = /^(?:the\s+)?user\s+(?:reports|reported|says|said|states|stated|confirms|confirmed|mentioned|mentions|noted)\s+(?:that\s+)?/iu;
// Beyond the shared negation, reported-speech and hedge vocabularies: requests,
// advice and open questions are not answers.
const UNSAFE = /\b(?:nor|unsure|might|wants?\s+to\s+know|wondered|question|whether|if|remind|reminder|todo|draft|suggested|suggests|recommend|recommended|should|could|would)\b|["“”?]/iu;

const OTHER_POSSESSOR = /\b\p{Lu}[\p{L}\p{M}-]*['’]s\b/u;

// One clause: no subordinate or contrastive clause, and `and` only inside a
// comma list (`Mondays, Tuesdays and Fridays`), never joining two statements.
const SUBORDINATE = /\b(?:but|while|whereas|although|because|unless|since|which|who|whom|whose|after|before|so|then)\b|:(?!\d)/iu;
const joinsClauses = (line: string): boolean => SUBORDINATE.test(line) || (/\band\b/iu.test(line) && !line.includes(","));

const fold = (text: string): string => text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("und");
const words = (text: string): string[] => fold(text).replace(/['’]s\b/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];

function stem(word: string): string {
  let out = word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (out.length > suffix.length + 3 && out.endsWith(suffix)) { out = out.slice(0, -suffix.length); break; }
  }
  return out;
}

function covers(concept: string, lineWords: ReadonlySet<string>): boolean {
  if (lineWords.has(concept)) return true;
  const group = SYNONYMS.find((set) => set.has(concept));
  for (const word of lineWords) {
    if (stem(word) === concept || (group !== undefined && group.has(word))) return true;
  }
  return false;
}

function lineWordSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const word of words(text)) { set.add(word); set.add(stem(word)); }
  return set;
}

/** Content words the question asks about; undefined when the question is out of scope. */
function questionConcepts(query: string, ownerTurn: boolean): { concepts: string[]; owner: boolean; temporal: boolean } | undefined {
  const text = query.normalize("NFKC").trim();
  if (!QUESTION.test(text) || isConversationRelativeQuery(text)) return undefined;
  const all = words(text);
  if (all.length > 16) return undefined;
  const owner = FIRST_PERSON.test(text);
  // `my` is the owner only on a host-stamped owner turn; elsewhere it could be anyone.
  if (owner && !ownerTurn) return undefined;
  if (/\b(?:you|your)\b/iu.test(text)) return undefined;
  const concepts = [...new Set(all.filter((word) => !FILLER.has(word)).map(stem))];
  if (concepts.length === 0) return undefined;
  const temporal = /^(?:when|what\s+time|what\s+date|what\s+day|which\s+day)\b/iu.test(text);
  return { concepts, owner, temporal };
}

function evidenceLine(text: string): string | undefined {
  const line = text.trim().replace(OWNER_REPORT, "").replace(/[.!]+$/u, "").trim();
  if (line.length === 0 || /[.!;]\s+\S/u.test(line) || /[\n\r]/u.test(line)) return undefined;
  // `Assistant` inside a proper name (`Home Assistant`) is not the assistant speaking.
  const hedgeText = line.replace(/(?<=\S\s+)Assistant\b/gu, "");
  if (UNSAFE.test(line) || joinsClauses(line) || NEGATION_OR_UNKNOWN.test(line) || REPORTED_OR_DITRANSITIVE.test(line)
    || ATTRIBUTED_REPORT_EXCLUSION.test(hedgeText) || line.split(/\s+/u).length > CLEAR_MARGIN_MAX_WORDS) return undefined;
  return line;
}

/**
 * Return the one top hit accepted by the clear-margin rule, or an empty list.
 * Hits must be sorted by score, best first.
 */
export function selectClearMarginHit<T extends MarginHit>(
  query: string,
  hits: readonly T[],
  options: { readonly ownerTurn?: boolean; readonly window?: number } = {},
): readonly T[] {
  // Choice, scoped-choice and scheduled questions are decided by the canonical
  // grammar alone: its scope, conflict and identity rules must not be bypassed.
  if (isIdentityBoundDirectFactQuery(query, options.ownerTurn === true ? { ownerTurn: true } : {})) return [];
  const question = questionConcepts(query, options.ownerTurn === true);
  const top = hits[0];
  if (question === undefined || top?.record === undefined) return [];
  const coversQuestion = (text: string): boolean => {
    const set = lineWordSet(text);
    // `my` means the owner: the line must name the user, or at least not be
    // about somebody else's thing (`Morgan's blood type`).
    if (question.owner && !set.has("user") && OTHER_POSSESSOR.test(text.replace(/\buser['’]s\b/giu, ""))) return false;
    if (question.temporal && !DATE_OR_TIME.test(text)) return false;
    // `day care` also matches `daycare`.
    return question.concepts.every((concept, index, all) => covers(concept, set)
      || covers(`${all[index - 1] ?? ""}${concept}`, set) || covers(`${concept}${all[index + 1] ?? ""}`, set));
  };
  const line = evidenceLine(top.record.text);
  if (line === undefined || !coversQuestion(line)) return [];
  // The margin is measured against the best hit that does not answer the
  // question. Close hits that also cover it join the answer (at most
  // CLEAR_MARGIN_MAX_HITS); if there are more, nothing singles an answer out.
  const selected: T[] = [top];
  for (const hit of hits.slice(1, Math.max(2, options.window ?? 8))) {
    const text = hit.record?.text;
    if (text === undefined) return [];
    if (top.score - hit.score >= CLEAR_MARGIN) break;
    const other = evidenceLine(text);
    if (other === undefined || !coversQuestion(other)) return [];
    selected.push(hit);
    if (selected.length > CLEAR_MARGIN_MAX_HITS) return [];
  }
  return selected;
}
