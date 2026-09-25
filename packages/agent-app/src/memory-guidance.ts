import type { MemoryLoadOptions } from "@mono-agent/agent-contracts";
import type { EntityRecord, MemoryDb } from "@mono-agent/memory/store";
import type { MemoryRecallHit } from "./memory-recall.js";

type MemoryLabelHit = ReturnType<MemoryDb["labelsForEntity"]>[number];
export interface LabelRecallStore {
  labelsForEntity?(id: string, date?: string): readonly MemoryLabelHit[];
  guidanceForScope?(scope: string): readonly MemoryLabelHit[];
  findMemoryEntitiesByNames?(names: readonly string[]): readonly EntityRecord[];
}

const MAX_BACKGROUND_BYTES = 1024;
const GUIDANCE_FLOOR = 0.35;
const PERSON_ID = /^person:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const scopeId = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u.test(value);
export const safeLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim();
const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("und");

/** Only name-sized, bounded query tokens reach SQLite; names are exact, never aliases. */
function entityNamesInQuery(query: string): string[] {
  const tokens = [...query.matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map(([word]) => word);
  const names = new Set<string>();
  for (let i = 0; i < tokens.length && names.size < 48; i++) {
    const first = tokens[i]!;
    if (!/^\p{Lu}/u.test(first)) continue;
    for (let count = 1; count <= 3 && i + count <= tokens.length && names.size < 48; count++) {
      const candidate = tokens.slice(i, i + count).join(" ");
      if ((count > 1 || [...first].length >= 3) && candidate.length <= 160) names.add(fold(candidate));
    }
  }
  return [...names];
}

function ageAt(birth: string, date: string): number | undefined {
  const [year, month, day] = birth.split("-").map(Number);
  const [nowYear, nowMonth, nowDay] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined || nowYear === undefined || nowMonth === undefined || nowDay === undefined) return undefined;
  const age = nowYear - year - (nowMonth < month || (nowMonth === month && nowDay < day) ? 1 : 0);
  return age >= 0 && age <= 130 ? age : undefined;
}

type FactLabel = Extract<MemoryLabelHit["label"], { kind: "fact" }>;

/** Reader-facing key: `other:` is a schema namespace, not part of the meaning. */
export function factKeyLabel(key: string): string {
  if (key === "birth_date") return "born";
  return key.replace(/^other:/u, "").replace(/[-_]+/gu, " ");
}

/** Reader-facing value text; never the JSON encoding. */
export function factValueText(value: FactLabel["value"]): string {
  return value.type === "date" ? value.date : value.type === "text" ? value.text
    : value.type === "entity" ? value.entityId : `${value.role} ${value.targetEntityId}`;
}

// Question words that ask about a birth date without naming the key.
const KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  birth_date: ["birth", "birthday", "born", "age", "old", "birthdate"],
};
const QUESTION_FILLER = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "can", "could", "did", "do", "does", "for", "from",
  "give", "has", "have", "he", "her", "his", "how", "i", "in", "is", "it", "know", "me", "my", "of", "on",
  "or", "our", "please", "remind", "s", "she", "show", "tell", "that", "the", "their", "them", "they",
  "this", "to", "was", "we", "were", "what", "whats", "when", "where", "which", "who", "whom", "whose",
  "why", "with", "would", "you", "your", "now", "current", "currently", "right", "anything", "something",
  "everything", "info", "information", "details", "person", "card",
]);
const stem = (word: string): string => word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

/** Content words a question asks about, excluding the named entities themselves. */
function questionConcepts(query: string, names: readonly string[]): Set<string> {
  const nameWords = new Set(names.flatMap((name) => fold(name).split(/[^\p{L}\p{N}]+/u)));
  const out = new Set<string>();
  for (const [word] of fold(query).replace(/['’]s\b/gu, "").matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!QUESTION_FILLER.has(word) && !nameWords.has(word) && !/^person$/u.test(word)) out.add(stem(word));
  }
  return out;
}

/** A key answers the question when one of its words (or a key alias) is asked about. */
function keyRelevant(key: string, concepts: ReadonlySet<string>): boolean {
  const words = [...fold(key.replace(/^other:/u, "")).split(/[^\p{L}\p{N}]+/u), ...(KEY_ALIASES[key] ?? [])]
    .filter((word) => word.length > 1 && word !== "date");
  return words.some((word) => concepts.has(stem(word)));
}

export function memoryGuidanceScopes(conversationId?: string, options: MemoryLoadOptions = {}): string[] {
  const scopes = ["agent"];
  if (conversationId !== undefined && scopeId(conversationId)) scopes.push(`conversation:${conversationId}`);
  if (options.senderToken !== undefined && /^[a-f0-9]{32}$/u.test(options.senderToken)) scopes.push(`user:${options.senderToken}`);
  // No project scope: the harness has no host-confirmed active project id.
  return scopes;
}

/** Exact-name graph lookup (or explicit person ID); bounded as in automatic recall. */
export function resolveMemoryEntities(store: LabelRecallStore, query: string, about = false): Array<{ id: string; name: string }> {
  const entities: Array<{ id: string; name: string }> = [];
  const names = about ? [fold(query.trim())].filter((name) => name.length > 0 && name.length <= 160)
    : entityNamesInQuery(query);
  for (const entity of store.findMemoryEntitiesByNames?.(names) ?? []) {
    if (PERSON_ID.test(entity.id) && entity.id.length <= 96) entities.push({ id: entity.id, name: entity.name });
  }
  const ids = about ? [query.trim()] : query.match(/\bperson:[a-z0-9]+(?:-[a-z0-9]+)*\b/gu) ?? [];
  for (const id of ids) {
    if (id.length <= 96 && PERSON_ID.test(id) && !entities.some((entity) => entity.id === id)) {
      entities.push({ id, name: id });
    }
  }
  // Preserve every bounded SQL match until ambiguity is checked by the caller.
  return entities;
}

/** Only labelled, host-scoped background. Never alters the ordinary answer-evidence gate. */
export function formatMemoryBackground(
  store: LabelRecallStore,
  query: string,
  conversationId: string,
  options: MemoryLoadOptions,
  hits: readonly MemoryRecallHit[],
  byteBudget = MAX_BACKGROUND_BYTES,
): {
  readonly content: string;
  readonly truncated: boolean;
  /** Current, user-stated/document fact labels whose key the question asks about. */
  readonly facts?: readonly string[];
} | undefined {
  if (store.guidanceForScope === undefined || store.labelsForEntity === undefined) return undefined;
  const date = options.hostDate;
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined;
  const scopes = memoryGuidanceScopes(conversationId, options);
  const scores = new Map(hits.map((hit) => [hit.record.id, hit.score]));
  const applicable = scopes.flatMap((scope) => store.guidanceForScope!(scope))
    .filter((hit) => hit.active && (hit.label.kind === "preference" || (hit.label.kind === "lesson" && hit.label.verified))
      && (scores.get(hit.memoryId) ?? 0) >= GUIDANCE_FLOOR);
  // Abstain on opposite statements about an otherwise identical action, across scopes too.
  const normalized = (text: string): string => fold(text).replace(/\b(?:not|never|don't)\b/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const contradictory = new Set<string>();
  for (const hit of applicable) {
    const other = applicable.find((candidate) => candidate !== hit && candidate.label.kind === hit.label.kind
      && normalized(candidate.text) === normalized(hit.text)
      && /\b(?:not|never|don't)\b/iu.test(candidate.text) !== /\b(?:not|never|don't)\b/iu.test(hit.text));
    if (other !== undefined) contradictory.add(hit.memoryId);
  }
  const guidance = applicable.filter((hit) => !contradictory.has(hit.memoryId))
    .sort((a, b) => (scores.get(b.memoryId) ?? 0) - (scores.get(a.memoryId) ?? 0) || a.memoryId.localeCompare(b.memoryId))
    .filter((hit, index, all) => all.findIndex((other) => other.text === hit.text) === index);

  const entities = resolveMemoryEntities(store, query);
  const explicitIds = new Set(query.match(/\bperson:[a-z0-9]+(?:-[a-z0-9]+)*\b/gu) ?? []);
  const ambiguous = new Set(entities.filter((entity) => !explicitIds.has(entity.id)
    && entities.some((other) => other.id !== entity.id && fold(other.name) === fold(entity.name)))
    .map((entity) => entity.id));
  // Relevance: a question that asks something beyond the name gets only the
  // keys it asks about, as direct facts; unrelated keys are never injected. A
  // bare mention (`Morgan`, `Tell me about Morgan`) keeps the whole background
  // card. Conflicting values stay background and prompt a question.
  const concepts = questionConcepts(query, entities.map((entity) => entity.name));
  const bare = concepts.size === 0;
  const cards: string[] = [];
  const direct: string[] = [];
  for (const entity of entities.filter((entry) => !ambiguous.has(entry.id)).slice(0, 3)) {
    const facts = store.labelsForEntity(entity.id, date).filter((hit) => hit.label.kind === "fact" && hit.active
      && (hit.label.attribution === "user-stated" || hit.label.attribution === "document"));
    const parts: string[] = [];
    for (const key of [...new Set(facts.map((hit) => hit.label.kind === "fact" ? hit.label.key : ""))]) {
      const relevant = keyRelevant(key, concepts);
      if (!bare && !relevant) continue;
      const candidates = facts.filter((hit) => hit.label.kind === "fact" && hit.label.key === key && hit.currentAt);
      if (candidates.length === 0) continue;
      if (candidates.some((hit) => hit.conflict)) {
        parts.push(`${key.replace(/^other:/u, "").replace(/[-_]+/gu, " ")}: conflicting values — ask`);
        continue;
      }
      for (const hit of candidates) {
        if (hit.label.kind !== "fact") continue;
        const value = hit.label.value;
        const values = [`${factKeyLabel(key)}: ${safeLine(factValueText(value))} (${hit.label.attribution === "user-stated" ? "you said" : "document"}, recorded ${hit.createdAt.slice(0, 10)})`];
        if (key === "birth_date" && value.type === "date") {
          const age = ageAt(value.date, date);
          if (age !== undefined) values.push(`age ${age}`);
        }
        if (relevant) direct.push(`${safeLine(entity.name)} — ${values.join("; ")}`);
        else parts.push(...values);
      }
    }
    if (parts.length > 0) cards.push(`${safeLine(entity.name)}: ${parts.join("; ")}`);
  }

  const selected = ["## Memory (background — not direct evidence)"];
  const limit = Math.max(0, Math.min(MAX_BACKGROUND_BYTES, byteBudget));
  let truncated = guidance.length > 3 || entities.length > 3;
  function addSection(title: string, lines: readonly string[]): void {
    let added = false;
    for (const line of lines) {
      const next = [...selected, ...(added ? [] : [title]), `- ${line}`];
      if (Buffer.byteLength(next.join("\n"), "utf8") > limit) { truncated = true; continue; }
      selected.splice(0, selected.length, ...next);
      added = true;
    }
  }
  addSection("Working preferences & lessons:", guidance.slice(0, 3).map((hit) => safeLine(hit.text)));
  addSection("Person card:", cards);
  const facts = direct.slice(0, 3).map((line) => line.slice(0, 240));
  truncated ||= direct.length > 3;
  const withFacts = facts.length > 0 ? { facts } : {};
  return selected.length > 1 ? { content: selected.join("\n"), truncated, ...withFacts }
    : truncated || facts.length > 0 ? { content: "", truncated, ...withFacts } : undefined;
}
