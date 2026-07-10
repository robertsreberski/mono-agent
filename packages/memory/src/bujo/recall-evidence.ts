/**
 * Precision-first answer-evidence gate for automatic prompt injection.
 *
 * Embedding similarity answers "is this about the same topic?", not "does this
 * record contain the attribute the question asks for?". This deterministic
 * pass therefore checks the bounded candidate texts for the query subject and
 * requested answer concepts. It performs no model/embedding calls and works on
 * local and plugin-backed hits alike.
 */

export interface RecallEvidenceHit {
  readonly record: { readonly text: string };
}

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
const TIME_VALUE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b(?:noon|midnight)\b/iu;
const CONVERSATION_RELATIVE = /\b(?:last|previous|immediately preceding)\s+(?:message|reply|response)\b|\bwhat did you (?:send|say)\b/iu;
const HOP_RELATION_CONCEPTS = new Set(["lead", "manage"]);

const ALIASES: Readonly<Record<string, string>> = {
  approved: "approve", approving: "approve", approval: "approve",
  based: "location", city: "location", located: "location", location: "location",
  office: "location", venue: "location", where: "location", held: "location",
  car: "vehicle", cars: "vehicle", automobile: "vehicle", vehicle: "vehicle",
  changes: "deploy", change: "deploy", deployed: "deploy", deployment: "deploy",
  deployments: "deploy", released: "deploy", releasing: "deploy", rollout: "deploy",
  rollouts: "deploy", shipped: "deploy", shipping: "deploy",
  chose: "choose", chosen: "choose", chooses: "choose", picked: "choose",
  selecting: "choose", selected: "choose", select: "choose",
  colour: "color", shade: "color",
  currently: "current", now: "current",
  decided: "decide", decision: "decide", decisions: "decide",
  departed: "depart", departure: "depart", departs: "depart", leave: "depart", leaves: "depart",
  date: "temporal", day: "temporal", when: "temporal",
  favourite: "preference", favorite: "preference", preferred: "preference", prefers: "preference",
  breakfast: "food", dinner: "food", lunch: "food", meal: "food", soup: "food",
  hosted: "hosting", hosts: "hosting", host: "hosting", cloud: "hosting", provider: "hosting",
  leading: "lead", leads: "lead", led: "lead",
  managed: "manage", manager: "manage", manages: "manage", managing: "manage",
  reported: "manage", reporting: "manage", reports: "manage", supervisor: "manage",
  phone: "phone", telephone: "phone",
  remotely: "remote", hybrid: "remote",
  required: "require", requires: "require",
  time: "time_of_day",
  vendor: "vendor", supplier: "vendor",
  working: "work", works: "work",
};

/** Return the smallest score-ordered subset that collectively carries the requested answer evidence. */
export function selectAnswerBearingRecallHits<T extends RecallEvidenceHit>(
  query: string,
  hits: readonly T[],
): readonly T[] {
  if (hits.length === 0 || CONVERSATION_RELATIVE.test(query)) return [];

  const queryProfile = queryEvidenceProfile(query);
  if (queryProfile.required.size === 0) return [];

  const independentlyAnswerBearing = hits.filter((hit) => coversProfile(queryProfile, [hit]));
  let linkedAnswerChain: readonly T[] = [];
  for (const component of entityConnectedComponents(hits)) {
    if (component.length < 2 || !isAnswerBearingComponent(queryProfile, component)) continue;
    const chosen = [...component];
    // Prefer earlier (higher-ranked) records, but retain any bridge record
    // needed to keep the answer evidence associated by a named entity.
    for (let index = chosen.length - 1; index >= 0; index -= 1) {
      const without = chosen.filter((_, candidate) => candidate !== index);
      if (isAnswerBearingComponent(queryProfile, without)) chosen.splice(index, 1);
    }
    linkedAnswerChain = chosen;
    break;
  }

  const retained = new Set([...independentlyAnswerBearing, ...linkedAnswerChain]);
  return hits.filter((hit) => retained.has(hit));
}

/** True only when the selected texts collectively carry the requested answer evidence. */
export function hasAutomaticRecallEvidence(query: string, hits: readonly RecallEvidenceHit[]): boolean {
  return selectAnswerBearingRecallHits(query, hits).length > 0;
}

interface QueryEvidenceProfile {
  readonly anchors: Set<string>;
  readonly required: Set<string>;
  readonly relations: Set<string>;
  readonly answerAspects: Set<string>;
}

function coversProfile(
  queryProfile: QueryEvidenceProfile,
  hits: readonly RecallEvidenceHit[],
): boolean {
  const documentConcepts = new Set<string>();
  for (const hit of hits) {
    for (const concept of documentEvidenceConcepts(hit.record.text)) documentConcepts.add(concept);
  }

  return isSubset(queryProfile.anchors, documentConcepts)
    && isSubset(queryProfile.required, documentConcepts);
}

/**
 * Split candidates into components connected only by shared proper-name
 * entities. Generic concepts such as `actor`, `phone`, or `deploy` must never
 * associate otherwise unrelated records merely because retrieval returned
 * them together.
 */
function entityConnectedComponents<T extends RecallEvidenceHit>(hits: readonly T[]): readonly (readonly T[])[] {
  const entities = hits.map((hit) => documentEntityConcepts(hit.record.text));
  const remaining = new Set(hits.map((_, index) => index));
  const components: T[][] = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as number;
    remaining.delete(seed);
    const indices = [seed];
    for (let cursor = 0; cursor < indices.length; cursor += 1) {
      const current = indices[cursor]!;
      for (const candidate of [...remaining]) {
        if (!intersects(entities[current]!, entities[candidate]!)) continue;
        remaining.delete(candidate);
        indices.push(candidate);
      }
    }
    components.push(indices.sort((left, right) => left - right).map((index) => hits[index]!));
  }
  return components;
}

function isAnswerBearingComponent(
  queryProfile: QueryEvidenceProfile,
  hits: readonly RecallEvidenceHit[],
): boolean {
  if (hits.length === 0 || !coversProfile(queryProfile, hits)) return false;
  if (hits.length === 1) return true;

  const entities = hits.map((hit) => documentEntityConcepts(hit.record.text));
  if (queryProfile.anchors.size > 0
    && !entities.some((candidate) => intersects(candidate, queryProfile.anchors))) return false;

  const visited = new Set([0]);
  const queue = [0];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (let candidate = 0; candidate < hits.length; candidate += 1) {
      if (visited.has(candidate) || !intersects(entities[current]!, entities[candidate]!)) continue;
      visited.add(candidate);
      queue.push(candidate);
    }
  }
  return visited.size === hits.length && hasExplicitRelationshipPath(queryProfile, hits);
}

/**
 * Multi-record unions are reserved for an explicit relationship hop in the
 * question. One record must bind the query anchor to a named bridge through
 * that relationship; another must bind the same bridge to the requested
 * answer aspect. This prevents same-subject cross-products such as combining
 * Morgan's deployment color with Morgan's car type to invent a car color.
 */
function hasExplicitRelationshipPath(
  queryProfile: QueryEvidenceProfile,
  hits: readonly RecallEvidenceHit[],
): boolean {
  if (queryProfile.anchors.size === 0
    || queryProfile.relations.size === 0
    || queryProfile.answerAspects.size === 0) return false;

  for (const relationHit of hits) {
    const relationEvidence = documentEvidenceConcepts(relationHit.record.text);
    if (!isSubset(queryProfile.anchors, relationEvidence)
      || !isSubset(queryProfile.relations, relationEvidence)) continue;
    const relationEntities = documentEntityConcepts(relationHit.record.text);

    for (const answerHit of hits) {
      if (answerHit === relationHit) continue;
      const answerEvidence = documentEvidenceConcepts(answerHit.record.text);
      if (!isSubset(queryProfile.answerAspects, answerEvidence)) continue;
      if (intersects(relationEntities, documentEntityConcepts(answerHit.record.text))) return true;
    }
  }
  return false;
}

export function automaticRecallEvidenceProfile(query: string): {
  readonly anchors: readonly string[];
  readonly required: readonly string[];
} {
  const profile = queryEvidenceProfile(query);
  return {
    anchors: [...profile.anchors].sort(),
    required: [...profile.required].sort(),
  };
}

function queryEvidenceProfile(query: string): QueryEvidenceProfile {
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
  const relations = new Set([...required].filter((concept) => HOP_RELATION_CONCEPTS.has(concept)));
  const answerAspects = new Set([...required].filter((concept) => !relations.has(concept)));
  return { anchors, required, relations, answerAspects };
}

function documentEvidenceConcepts(text: string): Set<string> {
  const out = concepts(text);
  const entities = documentEntityConcepts(text);
  for (const anchor of entities) out.add(anchor);
  if (entities.size > 0) out.add("actor");
  if (DAY_OR_MONTH.test(text) || DATE_VALUE.test(text)) out.add("temporal");
  if (TIME_VALUE.test(text)) {
    out.add("temporal");
    out.add("time_of_day");
  }
  return out;
}

function documentEntityConcepts(text: string): Set<string> {
  return properNameConcepts(text, true);
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
    // Sentence-initial domain nouns are not actors/entities. Named people and
    // acronyms remain useful even at index zero.
    if (document && index === 0 && ["database", "nightly", "release", "project", "the"].includes(lower)) {
      continue;
    }
    out.add(canonicalName(lower));
  }
  return out;
}

function canonicalConcept(token: string): string {
  const alias = ALIASES[token];
  if (alias !== undefined) return alias;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 4 && token !== "atlas") return token.slice(0, -1);
  return token;
}

function canonicalName(token: string): string {
  if (token.endsWith("s") && token.length > 5 && token !== "atlas") return token.slice(0, -1);
  return token;
}

function isSubset(expected: ReadonlySet<string>, actual: ReadonlySet<string>): boolean {
  for (const value of expected) if (!actual.has(value)) return false;
  return true;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}
