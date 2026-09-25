/**
 * Precision-first evidence gate for automatic prompt injection.
 *
 * Recognized `DirectFactQuery` shapes (query -> one acceptable record):
 *
 * 1. named-property: `What is Morgan's phone number?`
 *    -> `Morgan's phone number is 555-0100.`
 * 2. choice: `What deployment color did Morgan select?`
 *    -> `Morgan selected cobalt as the deployment color.`
 * 3. event-time: `When does the release train depart now?`
 *    -> `The release train now leaves on Thursday.`
 * 4. copular-time: `What day is the API launch?`
 *    -> `The API launch date is 2026-08-14.`
 * 5. scheduled copular-time: `When is the Atlas migration scheduled?`
 *    -> `The Atlas migration is scheduled for 2026-08-14 at 09:30.`
 * 6. location: `Where does Morgan work?`
 *    -> `Morgan works in Amsterdam.`
 * 7. scoped-choice: `What color did Mira select for the Velin launch?`
 *    -> `Mira selected cobalt as the color for the Velin launch.`
 *    The record must name the property *and* the scope. A scope is not a
 *    property, so `Mira selected cobalt for the Velin launch.` stays rejected:
 *    it never states that cobalt is the *color*. Scope identity is compared
 *    conservatively (see `scopeIdentity`), and contradictory values for the
 *    same subject/property/scope abstain instead of injecting either.
 *
 * `parseDirectFactQuery` accepts only those finite query grammars;
 * `matchesDirectFact` then requires one record to satisfy the corresponding
 * fact grammar, subject, property/predicate, and answer kind. Three exact
 * first-party report envelopes may carry the same inner property, choice, or
 * location grammar when the textual reporter equals the queried subject. The
 * original attributed record is returned unchanged; this is evidence matching,
 * not speaker authentication or factual verification. Reporter pairing is an
 * exact case-insensitive textual comparison and never uses the broader proper-
 * name stemming retained by canonical direct facts. Other reported speech,
 * ambiguous relations, unsafe clauses, negation, and unknown values
 * fail closed instead of being automatically injected.
 *
 * Owner turns (host-stamped `ownerTurn`, never model text) add two narrow
 * forms. A first-person question with exactly one `my` and no other first-person
 * word is read as a question about the owner, whom capture records as `the
 * user`: `What is my tax residence?` -> `The user's tax residence is Poland.`
 * And the owner-report envelope `The user reports|reported|said|stated|
 * confirmed [that] <inner>` is unwrapped, where `<inner>` must itself be one of
 * the canonical shapes above (`their` reads as the owner). The unwrapped record
 * counts as attributed, so a disagreeing answer in the cohort abstains. On any
 * other turn these forms stay rejected: `my` could be anyone in a group chat.
 *
 * Questions are normalized before parsing: `what's`/`where's`/`when's` expand,
 * a trailing `now`/`right now`/`currently` is dropped, and in an all-lower-case
 * question a possessive (`morgan's`) is read as the name it marks. The owner
 * subject `User` counts as that one name, so `The user's employer is Initech`
 * still abstains (a second proper name) exactly as for any other subject.
 *
 * This is intentionally not a general natural-language parser. A semantically
 * relevant record outside these shapes remains available through the default-on
 * MemoryRecall tool.
 */

export interface RecallEvidenceHit {
  readonly record: { readonly text: string };
}

/** Host-stamped turn facts; never derived from model or record text. */
export interface RecallEvidenceContext {
  /** The operator's own authenticated turn (web/tui/acp human turn). */
  readonly ownerTurn?: boolean;
}

/** Lower-case possessors that never name a subject (`today's`, `everyone's`). */
const NON_NAME_POSSESSORS = new Set([
  "today", "tomorrow", "yesterday", "tonight", "everyone", "everybody", "someone", "somebody",
  "anyone", "anybody", "nobody", "it", "that", "this", "one", "user",
]);

const OWNER_REPORT = /^(?:the\s+)?user\s+(?:reports|reported|says|said|states|stated|confirms|confirmed)\s+(?:that\s+)?(.+)$/iu;

const STOP_CONCEPTS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does",
  "for", "from", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our",
  "please", "remind", "show", "status", "that", "the", "this", "to", "was", "we", "were",
  "what", "when", "where", "which", "who", "with", "would", "you", "person", "project",
  "repeated", "tell", "event",
]);

const ENTITY_EXCLUSIONS = new Set([
  "what", "which", "who", "where", "when", "how", "does", "did", "the", "project",
  "remind", "show", "tell", "please",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december",
]);

const DAY_OR_MONTH = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/iu;
const DATE_VALUE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/u;
const CLOCK_VALUE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/gu;
const TIME_VALUE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b(?:noon|midnight)\b/iu;
const PHONE_VALUE = /\b(?:\+?\d[\d .()-]{5,}\d|\d{3}[- .]\d{3,})\b/u;
const SELF_RELATIVE_MESSAGE = /\b(?:your|my)\s+(?:last|previous|most recent|immediately preceding)\s+(?:message|reply|response)\b/iu;
const CURRENT_CONVERSATION = /\b(?:current|this)\s+(?:conversation|chat|thread)\b/iu;
const BARE_SEND_OR_SAY = /^\s*what did you (?:just\s+)?(?:send|say)(?:\s+just now)?\s*[?!.]*\s*$/iu;
const SEND_OR_SAY_RELATIVE = /^\s*what did you (?:send|say)\s+(?:in\s+)?(?:the\s+)?(?:last|previous|most recent|immediately preceding)\s+(?:message|reply|response)\s*[?!.]*\s*$/iu;
const UNQUALIFIED_RELATIVE_MESSAGE = /^\s*(?:what (?:was|is)|repeat|show me)\s+(?:the\s+)?(?:last|previous|most recent|immediately preceding)\s+(?:message|reply|response)\s*[?!.]*\s*$/iu;
const DURABLE_HISTORY_QUALIFIER = /\b(?:archive|archived|history|historical|yesterday|last\s+(?:week|month|year))\b|\b(?:in|during|from)\s+(?:19|20)\d{2}\b/iu;

/** True when the answer belongs to active conversation history, never durable memory. */
export function isConversationRelativeQuery(query: string): boolean {
  const normalized = query.normalize("NFKC");
  if (DURABLE_HISTORY_QUALIFIER.test(normalized)) return false;
  return SELF_RELATIVE_MESSAGE.test(normalized)
    || CURRENT_CONVERSATION.test(normalized)
    || BARE_SEND_OR_SAY.test(normalized)
    || SEND_OR_SAY_RELATIVE.test(normalized)
    || UNQUALIFIED_RELATIVE_MESSAGE.test(normalized);
}

// Ambiguous roles and relations are explicit-tool territory. In particular,
// automatic context never tries to resolve who/manager/lead/approval queries.
const ACTOR_OR_RELATION_QUERY = /\b(?:who|whose|manager|manages?|managed|lead|leads|leading|led|approve|approves|approved|approving|approval)\b/iu;
const UNSAFE_FACT_LANGUAGE = /\b(?:and|but|or|while|whereas|although|because|if|unless|since|that|which|who|after|before)\b|[,:;\n\r]/iu;
export const REPORTED_OR_DITRANSITIVE = /\b(?:gave|give|gives|told|tell|tells|asked|ask|asks|said|say|says|reported|reports|discussed|discusses|mentioned|mentions|informed|informs|showed|shows|sent|sends)\b/iu;
export const NEGATION_OR_UNKNOWN = /\b(?:no|not|never|neither|unknown|unset|tbd|none)\b/iu;
export const ATTRIBUTED_REPORT_EXCLUSION = /\b(?:assistant|quote|quoted|quotes|quoting|quotation|pasted|claim|claimed|claims|claiming|unconfirmed|unverified|unchecked|uncertain|uncertainty|unclear|unsure|doubtful|alleged|allegedly|apparently|maybe|perhaps|possibly|probably|rumor|rumored|rumoured|supposedly|seemingly|without|correction|corrected|correcting|incorrect|wrong|erroneous)\b/iu;
const ATTRIBUTED_REPORT_CORRECTION = /\b(?:correction|corrected|correcting|incorrect|wrong|erroneous|previously|formerly|now|instead|rather)\b/iu;
const ATTRIBUTED_REPORT_QUOTATION = /["'“”‘’«»‹›]/u;
const SCHEDULED_TEMPORAL_ATTRIBUTION = /\baccording\s+to\b/iu;
const ATTRIBUTED_REPORT_UNSAFE_UNICODE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const ATTRIBUTED_REPORT_NORMALIZED_SYNTAX = /["'“”‘’«»‹›,:;?!.\s]/u;

const ALIASES: Readonly<Record<string, string>> = {
  based: "location", city: "location", located: "location", location: "location",
  office: "location", venue: "location", where: "location", held: "location",
  car: "vehicle", cars: "vehicle", automobile: "vehicle", vehicle: "vehicle",
  changes: "deploy", change: "deploy", deployed: "deploy", deployment: "deploy",
  deployments: "deploy", released: "deploy", releasing: "deploy", rollout: "deploy",
  rollouts: "deploy", shipped: "deploy", shipping: "deploy",
  chose: "choose", chosen: "choose", chooses: "choose", picked: "choose",
  selecting: "choose", selected: "choose", select: "choose",
  colour: "color", shade: "color",
  departed: "depart", departure: "depart", departs: "depart", leave: "depart", leaves: "depart",
  date: "temporal", day: "temporal", when: "temporal",
  favourite: "preference", favorite: "preference", preferred: "preference", prefers: "preference",
  phone: "phone", telephone: "phone",
  time: "time_of_day",
};

/**
 * Singular tokens whose trailing `s` must survive the narrow suffix heuristic.
 * Both concept and proper-name canonicalization consult this one list; add a
 * documented entry here instead of embedding another literal carve-out.
 */
const TRAILING_S_SINGULARS = new Set([
  "atlas", // Proper noun; stripping the suffix would corrupt the anchor to "atla".
]);

type AnswerKind = "generic" | "location" | "temporal" | "time";

type DirectFactQuery = DirectFactQueryShape & { readonly ownerTurn?: boolean };

type DirectFactQueryShape =
  | { readonly kind: "named-property"; readonly subject: string; readonly reporterSubject: string; readonly property: string; readonly answerKind: AnswerKind }
  | { readonly kind: "choice"; readonly subject: string; readonly reporterSubject: string; readonly property: string }
  | { readonly kind: "scoped-choice"; readonly subject: string; readonly reporterSubject: string; readonly property: string; readonly scope: string }
  | { readonly kind: "event-time"; readonly subject: string; readonly predicate: string; readonly answerKind: "temporal" | "time" }
  | { readonly kind: "copular-time"; readonly subject: string; readonly answerKind: "temporal" | "time"; readonly scheduled: boolean }
  | { readonly kind: "location"; readonly subject: string; readonly reporterSubject: string; readonly predicate: string };

/** Return score-ordered records that independently match a canonical direct fact. */
export function selectAnswerBearingRecallHits<T extends RecallEvidenceHit>(
  query: string,
  hits: readonly T[],
  context: RecallEvidenceContext = {},
): readonly T[] {
  if (hits.length === 0 || isConversationRelativeQuery(query)) return [];
  const directFact = parseDirectFactQuery(query, context);
  if (directFact === undefined) return [];
  // Two different answers to the same scoped or explicitly scheduled question
  // cannot both be injected. The same applies when at least one answer uses the
  // bounded first-party report wrapper: dropping that qualified disagreement
  // would silently make an unqualified record look confirmed by omission.
  if (hasConflictingValues(directFact, hits, requiresCanonicalConflictGuard(directFact))) return [];
  return hits.filter((hit) => matchesDirectFact(directFact, hit.record.text));
}

/**
 * True when the bounded candidate set already contains contradictory answers to
 * a scoped-choice question. Callers pass the hits they have retrieved; this
 * makes no extra lookup and therefore claims nothing about the wider corpus.
 * Score floors and top-N slicing must not hide such a record, so automatic
 * callers check this against their full candidate set before selecting.
 */
export function hasConflictingScopedChoiceEvidence(
  query: string,
  hits: readonly RecallEvidenceHit[],
  context: RecallEvidenceContext = {},
): boolean {
  const directFact = parseDirectFactQuery(query, context);
  if (directFact === undefined || directFact.kind !== "scoped-choice") return false;
  return hasConflictingValues(directFact, hits, true);
}

/**
 * Full-candidate conflict guard for automatic injection. Canonical-only
 * abstention applies to scoped choices and explicitly scheduled temporal
 * questions; other families abstain when a bounded first-party report disagrees
 * with another answer in the cohort.
 */
export function hasConflictingAutomaticRecallEvidence(
  query: string,
  hits: readonly RecallEvidenceHit[],
  context: RecallEvidenceContext = {},
): boolean {
  const directFact = parseDirectFactQuery(query, context);
  if (directFact === undefined) return false;
  return hasConflictingValues(directFact, hits, requiresCanonicalConflictGuard(directFact));
}

function requiresCanonicalConflictGuard(query: DirectFactQuery): boolean {
  return query.kind === "scoped-choice" || (query.kind === "copular-time" && query.scheduled);
}

function hasConflictingValues(
  query: DirectFactQuery,
  hits: readonly RecallEvidenceHit[],
  includeCanonicalOnly: boolean,
): boolean {
  const values = new Set<string>();
  let hasAttributed = false;
  for (const hit of hits) {
    const parsed = directFactValue(query, hit.record.text);
    if (parsed === undefined) {
      const qualifiedConflict = firstPartyPropertyConflictValue(query, hit.record.text);
      if (qualifiedConflict === undefined) continue;
      // A same-subject/property correction is deliberately not parsed into a
      // replacement value. Its ambiguity is enough to prevent automatic use of
      // another candidate that may be the obsolete value.
      if (qualifiedConflict.ambiguousCorrection) return true;
      values.add(qualifiedConflict.value);
      hasAttributed = true;
    } else {
      values.add(parsed.value);
      hasAttributed ||= parsed.attributed;
    }
    // Canonical-only conflicts are guarded for scoped choices and scheduled
    // temporal questions. Other direct-fact families abstain solely when a
    // bounded attributed answer enters the cohort.
    if (values.size > 1 && (includeCanonicalOnly || hasAttributed)) return true;
  }
  return false;
}

export function hasAutomaticRecallEvidence(
  query: string,
  hits: readonly RecallEvidenceHit[],
  context: RecallEvidenceContext = {},
): boolean {
  return selectAnswerBearingRecallHits(query, hits, context).length > 0;
}

function parseDirectFactQuery(rawQuery: string, context: RecallEvidenceContext = {}): DirectFactQuery | undefined {
  const query = normalizeQuestion(rawQuery, context);
  if (query === undefined || ACTOR_OR_RELATION_QUERY.test(query)) return undefined;
  const parsed = parseDirectFactShape(query);
  if (parsed === undefined) return undefined;
  return context.ownerTurn === true ? { ...parsed, ownerTurn: true } : parsed;
}

function parseDirectFactShape(query: string): DirectFactQueryShape | undefined {

  // A final standalone `scheduled` is a predicate marker, not a named property.
  // Parse this anchored form before the single-name property grammar can consume
  // ordinary event names such as `Solstice` or `Atlas migration`.
  const scheduledTime = /^(when\s+is|what\s+(?:date|day|time)\s+is)\s+(.+?)\s+scheduled$/iu.exec(query);
  if (scheduledTime !== null) {
    const subject = conservativeTemporalSubjectIdentity(scheduledTime[2]!);
    if (subject === undefined) return undefined;
    return {
      kind: "copular-time",
      subject,
      answerKind: /time/iu.test(scheduledTime[1]!) ? "time" : "temporal",
      scheduled: true,
    };
  }

  const namedProperty = parseNamedPropertyQuery(query);
  if (namedProperty !== undefined) return namedProperty;

  const choice = /^(?:what|which)\s+(.+?)\s+did\s+([A-Z][A-Za-z0-9-]*)\s+(select|choose|pick)$/iu.exec(query);
  if (choice !== null) {
    return {
      kind: "choice",
      subject: canonicalName(choice[2]!.toLowerCase()),
      reporterSubject: textualReporterIdentity(choice[2]!),
      property: canonicalPhrase(choice[1]!),
    };
  }

  // Scope-qualified choice. Only reachable for questions the unscoped grammar
  // above already rejects, so existing unscoped behaviour is unchanged.
  const scopedChoice = /^(?:what|which)\s+(.+?)\s+did\s+([A-Z][A-Za-z0-9-]*)\s+(?:select|choose|pick)\s+for\s+(.+)$/iu.exec(query);
  if (scopedChoice !== null) {
    const scope = scopeIdentity(scopedChoice[3]!);
    if (scope === undefined) return undefined;
    return {
      kind: "scoped-choice",
      subject: canonicalName(scopedChoice[2]!.toLowerCase()),
      reporterSubject: textualReporterIdentity(scopedChoice[2]!),
      property: canonicalPhrase(scopedChoice[1]!),
      scope,
    };
  }

  const eventTime = /^(when|what\s+day|which\s+day|what\s+time)\s+does\s+(?:the\s+)?(.+?)\s+(?:now\s+)?(leave|depart|start|launch)(?:\s+now)?$/iu.exec(query);
  if (eventTime !== null) {
    return {
      kind: "event-time",
      subject: canonicalPhrase(eventTime[2]!),
      predicate: canonicalPredicate(eventTime[3]!),
      answerKind: /time/iu.test(eventTime[1]!) ? "time" : "temporal",
    };
  }

  const copularTime = /^(when\s+is|what\s+(?:date|day|time)\s+is)\s+(?:the\s+)?(.+)$/iu.exec(query);
  if (copularTime !== null) {
    return {
      kind: "copular-time",
      subject: canonicalTemporalSubject(copularTime[2]!),
      answerKind: /time/iu.test(copularTime[1]!) ? "time" : "temporal",
      scheduled: false,
    };
  }

  const location = /^where\s+does\s+([A-Z][A-Za-z0-9-]*)\s+(work|live)$/iu.exec(query);
  if (location !== null) {
    return {
      kind: "location",
      subject: canonicalName(location[1]!.toLowerCase()),
      reporterSubject: textualReporterIdentity(location[1]!),
      predicate: canonicalPredicate(location[2]!),
    };
  }

  return undefined;
}

function parseNamedPropertyQuery(query: string): DirectFactQueryShape | undefined {
  const anchor = singleNamedAnchor(query);
  if (anchor === undefined) return undefined;

  const simple = /^(what|where|when)\s+(?:is|was)\s+([A-Z][A-Za-z0-9-]*(?:['’]s)?)\s+(.+)$/iu.exec(query);
  if (simple !== null && possessiveSubject(simple[2]!) === anchor) {
    const questionWord = simple[1]!.toLowerCase();
    const property = canonicalPhrase(simple[3]!);
    return {
      kind: "named-property",
      subject: anchor,
      reporterSubject: textualReporterIdentity(simple[2]!),
      property,
      answerKind: questionWord === "where"
        ? "location"
        : questionWord === "when"
          ? "temporal"
          : answerKindForProperty(property),
    };
  }

  const aspect = /^(?:what|which)\s+(.+?)\s+(?:is|was)\s+([A-Z][A-Za-z0-9-]*(?:['’]s)?)\s+(.+)$/iu.exec(query);
  if (aspect !== null && possessiveSubject(aspect[2]!) === anchor) {
    const property = canonicalPhrase(`${aspect[3]!} ${aspect[1]!}`);
    return {
      kind: "named-property",
      subject: anchor,
      reporterSubject: textualReporterIdentity(aspect[2]!),
      property,
      answerKind: answerKindForProperty(property),
    };
  }
  return undefined;
}

const SCOPED_CHOICE_FACT = /^([A-Z][A-Za-z0-9-]*)\s+(?:selected|chose|picked)\s+(.+?)\s+as\s+(?:the\s+)?(.+?)\s+for\s+(.+)$/iu;

interface DirectFactValue {
  readonly value: string;
  readonly attributed: boolean;
}

/**
 * NFKC is used only to discover hidden unsafe syntax. Parsing and rendering keep
 * the original bytes: compatibility punctuation must not be silently folded
 * into an admissible report.
 */
function attributedReportIsSafe(rawText: string): boolean {
  if (ATTRIBUTED_REPORT_UNSAFE_UNICODE.test(rawText)) return false;
  const normalized = rawText.normalize("NFKC");
  if (ATTRIBUTED_REPORT_UNSAFE_UNICODE.test(normalized)
    || ATTRIBUTED_REPORT_QUOTATION.test(normalized)
    || [...rawText].some((character) => {
      const folded = character.normalize("NFKC");
      return folded !== character && ATTRIBUTED_REPORT_NORMALIZED_SYNTAX.test(folded);
    })) return false;
  const safetyText = normalized.trim().replace(/[?!.]+$/u, "").replace(/\s+/gu, " ");
  return safetyText.length > 0
    && !/[?!.]/u.test(safetyText)
    && !/[,:;\n\r]/u.test(safetyText)
    && !ATTRIBUTED_REPORT_EXCLUSION.test(safetyText);
}

/**
 * Convert only three exact first-party report envelopes into the canonical
 * sentence shapes the existing direct-fact grammar already understands. This
 * is query-text evidence matching, not authentication of the named reporter or
 * verification of the proposition. The stored/rendered text is never changed.
 */
function firstPartyReportInner(query: DirectFactQuery, rawText: string): string | undefined {
  if (!("reporterSubject" in query) || !attributedReportIsSafe(rawText)) return undefined;
  const text = rawText.trim().replace(/[?!.]+$/u, "").replace(/\s+/gu, " ");

  // Owner-report envelope: only on a host-stamped owner turn. The inner clause
  // must itself be a canonical shape; `their` reads as the owner.
  if (query.ownerTurn === true) {
    const owner = OWNER_REPORT.exec(text);
    if (owner !== null) return ownerSubjectText(owner[1]!.replace(/^their\s+/iu, "User's "));
  }

  const property = /^([A-Z][A-Za-z0-9-]*)\s+reports\s+that\s+their\s+(.+?)\s+(is|was)\s+(.+)$/iu.exec(text);
  if (property !== null && textualReporterIdentity(property[1]!) === query.reporterSubject) {
    return `${property[1]}'s ${property[2]} ${property[3]} ${property[4]}`;
  }

  const choice = /^([A-Z][A-Za-z0-9-]*)\s+reports\s+(selecting|choosing|picking)\s+(.+?)\s+as\s+(?:the\s+)?(.+)$/iu.exec(text);
  if (choice !== null && textualReporterIdentity(choice[1]!) === query.reporterSubject) {
    const verb = choice[2]!.toLowerCase() === "choosing"
      ? "chose"
      : choice[2]!.toLowerCase() === "picking"
        ? "picked"
        : "selected";
    return `${choice[1]} ${verb} ${choice[3]} as the ${choice[4]}`;
  }

  const location = /^([A-Z][A-Za-z0-9-]*)\s+reports\s+(working|living)\s+(in|at)\s+(.+)$/iu.exec(text);
  if (location !== null && textualReporterIdentity(location[1]!) === query.reporterSubject) {
    const verb = location[2]!.toLowerCase() === "living" ? "lives" : "works";
    return `${location[1]} ${verb} ${location[3]} ${location[4]}`;
  }
  return undefined;
}

type FirstPartyPropertyConflict =
  | { readonly ambiguousCorrection: true }
  | { readonly ambiguousCorrection: false; readonly value: string };

/**
 * A qualified/unsafe first-party property report is never selectable, but its
 * leading direct value can still prevent a contradictory canonical record from
 * being injected as if the disagreement were absent. Correction language is an
 * unconditional same-property abstention signal: choosing either an old or a
 * replacement value would require semantic inference this gate does not make.
 */
function firstPartyPropertyConflictValue(
  query: DirectFactQuery,
  rawText: string,
): FirstPartyPropertyConflict | undefined {
  if (query.kind !== "named-property" || ATTRIBUTED_REPORT_UNSAFE_UNICODE.test(rawText)) return undefined;
  const text = rawText.trim().replace(/[?!.]+$/u, "").replace(/\s+/gu, " ");
  const match = /^([A-Z][A-Za-z0-9-]*)\s+reports\s+that\s+their\s+(.+?)\s+(?:is|was)\s+(.+)$/iu.exec(text);
  if (match === null || textualReporterIdentity(match[1]!) !== query.reporterSubject
    || canonicalPhrase(match[2]!) !== query.property) return undefined;
  const ambiguousCorrection = ATTRIBUTED_REPORT_CORRECTION.test(rawText.normalize("NFKC"));
  const value = match[3]!.split(/\s+(?:and|but|because|if|unless|since|which|who|after|before)\b|[,;:]/iu, 1)[0]?.trim();
  if (ambiguousCorrection) return { ambiguousCorrection: true };
  if (value === undefined || !hasAnswerValue(query.answerKind, query.property, value)) return undefined;
  return { value: identityText(value), ambiguousCorrection: false };
}

function normalizedDirectFact(
  query: DirectFactQuery,
  rawText: string,
): { readonly text: string; readonly attributed: boolean } | undefined {
  const inner = firstPartyReportInner(query, rawText);
  const text = normalizeFactText(inner ?? (query.ownerTurn === true ? ownerSubjectText(rawText) : rawText));
  if (text === undefined) return undefined;
  return { text, attributed: inner !== undefined };
}

function directFactValue(query: DirectFactQuery, rawText: string): DirectFactValue | undefined {
  if (query.kind === "event-time" || query.kind === "copular-time") {
    return directTemporalFactValue(query, rawText);
  }

  const normalized = normalizedDirectFact(query, rawText);
  if (normalized === undefined) return undefined;
  const { text, attributed } = normalized;

  if (query.kind === "scoped-choice") {
    const match = SCOPED_CHOICE_FACT.exec(text);
    if (match === null) return undefined;
    if (canonicalName(match[1]!.toLowerCase()) !== query.subject) return undefined;
    if (canonicalPhrase(match[3]!) !== query.property) return undefined;
    if (scopeIdentity(match[4]!) !== query.scope) return undefined;
    // The <=1 proper-name guard still applies, but only outside the scope span:
    // names inside the scope are already pinned by the identity check above.
    const outsideScope = text.slice(0, text.length - match[4]!.length);
    if (properNameConcepts(outsideScope, true).size > 1) return undefined;
    if (!hasAnswerValue("generic", query.property, match[2]!)) return undefined;
    return { value: identityText(match[2]!), attributed };
  }

  if (query.kind === "named-property") {
    const match = /^([A-Z][A-Za-z0-9-]*)['’]s\s+(.+?)\s+(?:is|was)\s+(.+)$/iu.exec(text);
    if (match === null) return undefined;
    if (canonicalName(match[1]!.toLowerCase()) !== query.subject) return undefined;
    if (canonicalPhrase(match[2]!) !== query.property) return undefined;
    if (query.answerKind !== "location" && properNameConcepts(text, true).size > 1) return undefined;
    if (!hasAnswerValue(query.answerKind, query.property, match[3]!)) return undefined;
    return { value: identityText(match[3]!), attributed };
  }

  if (query.kind === "choice") {
    const match = /^([A-Z][A-Za-z0-9-]*)\s+(?:selected|chose|picked)\s+(.+?)\s+as\s+(?:the\s+)?(.+)$/iu.exec(text);
    if (match === null
      || canonicalName(match[1]!.toLowerCase()) !== query.subject
      || canonicalPhrase(match[3]!) !== query.property
      || properNameConcepts(text, true).size > 1
      || !hasAnswerValue("generic", query.property, match[2]!)) return undefined;
    return { value: identityText(match[2]!), attributed };
  }

  const match = /^([A-Z][A-Za-z0-9-]*)\s+(works|lives)\s+(in|at)\s+(.+)$/iu.exec(text);
  if (match === null
    || canonicalName(match[1]!.toLowerCase()) !== query.subject
    || canonicalPredicate(match[2]!) !== query.predicate
    || !hasAnswerValue("location", "location", `${match[3]!} ${match[4]!}`)) return undefined;
  return { value: identityText(match[4]!), attributed };
}

function directTemporalFactValue(
  query: Extract<DirectFactQuery, { readonly kind: "event-time" | "copular-time" }>,
  rawText: string,
): DirectFactValue | undefined {
  // Inspect scheduled records before whitespace/sentence normalization can erase
  // control or format syntax. Other established temporal families retain their
  // existing behavior.
  if (query.kind === "copular-time" && query.scheduled
    && ATTRIBUTED_REPORT_UNSAFE_UNICODE.test(rawText)) return undefined;
  const text = normalizeFactSyntax(rawText);
  if (text === undefined) return undefined;

  if (query.kind === "event-time") {
    const match = /^(?:the\s+)?(.+?)\s+(?:now\s+)?(leaves|departs|starts|launches)\s+(?:on|at)\s+(.+)$/iu.exec(text);
    if (match === null
      || !temporalFactLanguageIsSafe(text, match[3]!)
      || canonicalPhrase(match[1]!) !== query.subject
      || canonicalPredicate(match[2]!) !== query.predicate
      || !hasAnswerValue(query.answerKind, "temporal", match[3]!)) return undefined;
    return { value: identityText(match[3]!), attributed: false };
  }

  if (query.scheduled) {
    const match = /^(.+?)\s+(?:is|was)\s+scheduled\s+(?:for|on|at)\s+(.+)$/iu.exec(text);
    if (match === null
      || !scheduledTemporalFactLanguageIsSafe(text, match[2]!)
      || conservativeTemporalSubjectIdentity(match[1]!) !== query.subject
      || !hasAnswerValue(query.answerKind, "temporal", match[2]!)) return undefined;
    return { value: identityText(match[2]!), attributed: false };
  }

  const match = /^(?:the\s+)?(.+?)\s+(?:is|was)\s+(.+)$/iu.exec(text);
  if (match === null
    || !temporalFactLanguageIsSafe(text, match[2]!)
    || canonicalTemporalSubject(match[1]!) !== query.subject
    || !hasAnswerValue(query.answerKind, "temporal", match[2]!)) return undefined;
  return { value: identityText(match[2]!), attributed: false };
}

function matchesDirectFact(query: DirectFactQuery, rawText: string): boolean {
  return directFactValue(query, rawText) !== undefined;
}

function normalizeQuestion(value: string, context: RecallEvidenceContext = {}): string | undefined {
  let normalized = value.trim().replace(/[?!.]+$/u, "").replace(/\s+/gu, " ")
    .replace(/^(what|where|when)['’]s\b/iu, "$1 is")
    .replace(/\s+(?:right\s+now|now|currently)$/iu, "");
  // An all-lower-case question still marks its subject with a possessive.
  if (!/\p{Lu}/u.test(normalized)) {
    normalized = normalized.replace(/\b([a-z][a-z0-9-]*)(?=['’]s\b)/gu,
      (name) => ENTITY_EXCLUSIONS.has(name) || NON_NAME_POSSESSORS.has(name)
        ? name : `${name[0]!.toUpperCase()}${name.slice(1)}`);
  }
  // Owner turn: one `my` and no other first-person word asks about the owner.
  if (context.ownerTurn === true && (normalized.match(/\bmy\b/giu) ?? []).length === 1
    && !/\b(?:i|me|mine|we|us|our|ours)\b/iu.test(normalized)) {
    normalized = normalized.replace(/\bmy\b/iu, "User's");
  }
  return normalized.length === 0 ? undefined : normalized;
}

/** Owner records say `the user`; read `The user's X` as the canonical `User's X`. */
function ownerSubjectText(value: string): string {
  return value.trim().replace(/^the\s+user(?=['’]s\b)/iu, "User");
}

function normalizeFactText(value: string): string | undefined {
  const normalized = normalizeFactSyntax(value);
  return normalized !== undefined && factLanguageIsSafe(normalized) ? normalized : undefined;
}

function normalizeFactSyntax(value: string): string | undefined {
  const normalized = value.trim()
    .replace(/\b([ap])\.m\./giu, "$1m")
    .replace(/[?!.]+$/u, "")
    .replace(/\s+/gu, " ");
  return normalized.length === 0 ? undefined : normalized;
}

function factLanguageIsSafe(value: string): boolean {
  return !/[?!.]/u.test(value)
    && !UNSAFE_FACT_LANGUAGE.test(value)
    && !REPORTED_OR_DITRANSITIVE.test(value)
    && !NEGATION_OR_UNKNOWN.test(value);
}

/**
 * Permit a colon only inside a complete valid 24-hour clock token in the
 * temporal answer span. Masking happens solely for the safety check; matching,
 * conflict identity, and rendering retain the original text and punctuation.
 */
function temporalFactLanguageIsSafe(text: string, answer: string): boolean {
  const answerOffset = text.length - answer.length;
  if (answerOffset < 0 || text.slice(answerOffset) !== answer) return false;
  const maskedAnswer = answer.replace(CLOCK_VALUE, (clock) => clock.replace(":", ""));
  return factLanguageIsSafe(`${text.slice(0, answerOffset)}${maskedAnswer}`);
}

/**
 * Scheduled payloads are canonical evidence, not a report envelope. Reject
 * quotation, uncertainty, and postpositive attribution in the answer itself.
 * NFKC is used only for safety discovery of compatibility punctuation and
 * folded forbidden language; parsing, value identity, and rendering continue
 * to use the original text.
 */
function scheduledTemporalFactLanguageIsSafe(text: string, answer: string): boolean {
  if (!temporalFactLanguageIsSafe(text, answer) || hasCompatibilityPunctuation(answer)) return false;
  const safetyText = text.normalize("NFKC");
  const safetyAnswer = answer.normalize("NFKC");
  return temporalFactLanguageIsSafe(safetyText, safetyAnswer)
    && !ATTRIBUTED_REPORT_QUOTATION.test(safetyAnswer)
    && !ATTRIBUTED_REPORT_EXCLUSION.test(safetyAnswer)
    && !SCHEDULED_TEMPORAL_ATTRIBUTION.test(safetyAnswer);
}

function hasCompatibilityPunctuation(value: string): boolean {
  return [...value].some((character) => {
    const folded = character.normalize("NFKC");
    return folded !== character && /[\p{P}\p{S}]/u.test(folded);
  });
}

function hasAnswerValue(kind: AnswerKind, property: string, rawValue: string): boolean {
  const value = rawValue.trim();
  if (value.length === 0 || REPORTED_OR_DITRANSITIVE.test(value) || NEGATION_OR_UNKNOWN.test(value)) return false;
  if (property.split(" ").includes("phone")) return PHONE_VALUE.test(value);
  if (kind === "location") return /^(?:in|at)\s+\S+/iu.test(value);
  if (kind === "time") return TIME_VALUE.test(value);
  if (kind === "temporal") return TIME_VALUE.test(value) || DATE_VALUE.test(value) || DAY_OR_MONTH.test(value);
  return /[A-Za-z0-9]/u.test(value);
}

function answerKindForProperty(property: string): AnswerKind {
  const words = new Set(property.split(" "));
  if (words.has("time_of_day")) return "time";
  if (words.has("temporal")) return "temporal";
  if (words.has("location")) return "location";
  return "generic";
}

function possessiveSubject(token: string): string {
  // Strip the possessive suffix itself: dropping only the apostrophe left
  // short names (`Alex's` -> `alexs`) unequal to their own anchor.
  const lower = token.toLowerCase().replace(/[’']s$/u, "").replace(/[’']/gu, "");
  return canonicalName(lower);
}

/** Exact identity for the attributed-report boundary; deliberately no stemming. */
function textualReporterIdentity(token: string): string {
  return token.trim().replace(/(?:['’]s)$/iu, "").toLowerCase();
}

function singleNamedAnchor(text: string): string | undefined {
  const anchors = [...properNameConcepts(text)];
  return anchors.length === 1 ? anchors[0] : undefined;
}

function canonicalTemporalSubject(text: string): string {
  return canonicalPhrase(text).replace(/(?:^|\s)(?:temporal|time_of_day)$/u, "").trim();
}

/**
 * Exact event identity for newly supported scheduled questions. Unlike the
 * legacy temporal canonicalizer, this retains project words, one-character
 * tokens, digits, punctuation, order, and repetition.
 */
function conservativeTemporalSubjectIdentity(raw: string): string | undefined {
  const identity = identityText(raw).replace(/^(?:the|a|an)(?:\s+|$)/u, "").trim();
  return identity.length === 0 ? undefined : identity;
}

function canonicalPredicate(value: string): string {
  const word = canonicalConcept(value.toLowerCase());
  if (word === "depart") return "depart";
  if (/^(?:start|starts)$/u.test(word)) return "start";
  if (/^(?:launch|launches)$/u.test(word)) return "launch";
  if (/^(?:work|works)$/u.test(word)) return "work";
  if (/^(?:live|lives)$/u.test(word)) return "live";
  return word;
}

function canonicalPhrase(text: string): string {
  return [...concepts(text)].join(" ");
}

/**
 * Case, whitespace and Unicode *compatibility* folding (NFKC). NFKC is broader
 * than width folding: it also maps superscript/circled forms onto their plain
 * characters, so `release²` and `release2` share one identity. This matches the
 * NFKC the app already applies to the query before the gate and the backend
 * cache, so identities stay consistent across both. Everything NFKC preserves
 * -- letters, digits, punctuation, order and repetition -- stays identifying.
 */
function identityText(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Conservative scope identity.
 *
 * A scope names one specific project or event, so identity-bearing tokens,
 * their order, repetition, digits and punctuation must all survive. Only case,
 * whitespace, Unicode compatibility forms (see `identityText`) and a single
 * standalone leading article are normalized. `canonicalPhrase` must NEVER be
 * used here: it drops stop words and one-character tokens, folds plurals,
 * applies property aliases and de-duplicates, which would equate `Project A`/
 * `Project B`, `launch 1`/`launch 2` and `Bora Bora`/`Bora`. An empty result
 * is not a scope.
 */
function scopeIdentity(raw: string): string | undefined {
  // The article must be a standalone word: followed by real whitespace, or the
  // whole scope. A word boundary alone would also match punctuation, stripping
  // the identifying prefix of `A-team`, `an-1` or `A’s launch`.
  const identity = identityText(raw).replace(/^(?:the|a|an)(?:\s+|$)/u, "").trim();
  return identity.length === 0 ? undefined : identity;
}

export function automaticRecallEvidenceProfile(query: string): {
  readonly anchors: readonly string[];
  readonly required: readonly string[];
} {
  const anchors = properNameConcepts(query);
  const required = concepts(query);
  for (const anchor of anchors) required.delete(anchor);
  if (/\bwho\b/iu.test(query)) required.add("actor");
  if (/\bwhere\b|\bcity\b|\bvenue\b|\bheld\b/iu.test(query)) required.add("location");
  if (/\bwhen\b|\bwhat\s+day\b/iu.test(query)) required.add("temporal");
  if (/\bwhat\s+time\b/iu.test(query)) {
    required.delete("temporal");
    required.add("time_of_day");
  }
  if (/\bphone\s+number\b/iu.test(query)) required.delete("number");
  return { anchors: [...anchors].sort(), required: [...required].sort() };
}

function concepts(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
    if (raw.length <= 1 || STOP_CONCEPTS.has(raw)) continue;
    const concept = canonicalConcept(raw);
    if (!STOP_CONCEPTS.has(concept)) out.add(concept);
  }
  return out;
}

function properNameConcepts(text: string, document = false): Set<string> {
  const out = new Set<string>();
  const tokens = text.match(/[A-Za-z][A-Za-z0-9]*/gu) ?? [];
  for (const [index, raw] of tokens.entries()) {
    const lower = raw.toLowerCase();
    if (ENTITY_EXCLUSIONS.has(lower)) continue;
    const proper = /^[A-Z]/u.test(raw) || /^[A-Z0-9]{2,}$/u.test(raw);
    if (!proper) continue;
    if (document && index === 0 && ["database", "nightly", "release", "project", "the"].includes(lower)) continue;
    out.add(canonicalName(lower));
  }
  return out;
}

function canonicalConcept(token: string): string {
  const alias = ALIASES[token];
  if (alias !== undefined) return alias;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 4 && !TRAILING_S_SINGULARS.has(token)) return token.slice(0, -1);
  return token;
}

function canonicalName(token: string): string {
  if (token.endsWith("s") && token.length > 5 && !TRAILING_S_SINGULARS.has(token)) return token.slice(0, -1);
  return token;
}
