import type { MemoryLoadOptions } from "@mono-agent/agent-contracts";
import { createHash } from "node:crypto";
import type { EntityRecord, MemoryDb } from "@mono-agent/memory/store";
import type { MemoryRecallHit } from "./memory-recall.js";

type MemoryLabelHit = ReturnType<MemoryDb["labelsForEntity"]>[number];
export interface LabelRecallStore {
  labelsForEntity?(id: string, date?: string): readonly MemoryLabelHit[];
  guidanceForScope?(scope: string): readonly MemoryLabelHit[];
  findMemoryEntitiesByNames?(names: readonly string[]): readonly EntityRecord[];
  /** Labels on these memory ids; used only to show a recalled line's attribution. */
  labelsForMemories?(memoryIds: readonly string[]): readonly MemoryLabelHit[];
}

const MAX_BACKGROUND_BYTES = 1024;
/** Absolute floor for preference/lesson background; the relative rule below does the real work. */
const GUIDANCE_FLOOR = 0.35;
/**
 * Raw embedding scores sit in a narrow provider-specific band (most unrelated
 * lines score within ~0.1 of each other), so an absolute floor alone admits
 * nearly every labelled line. A preference or lesson must also lead the median
 * candidate score by this margin (when at least five candidates exist) and rank
 * among the first GUIDANCE_MAX_RANK hits.
 */
export const GUIDANCE_MARGIN = 0.1;
export const GUIDANCE_MAX_RANK = 8;
const GUIDANCE_MIN_CANDIDATES = 5;

/** Minimum score a labelled guidance line needs among these retrieved hits. */
export function guidanceScoreFloor(scores: readonly number[]): number {
  // Too few candidates carry no distribution; keep the absolute floor alone.
  if (scores.length < GUIDANCE_MIN_CANDIDATES) return GUIDANCE_FLOOR;
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.max(GUIDANCE_FLOOR, median + GUIDANCE_MARGIN);
}
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

/** Reader-facing age on `date`: years, then months under one year and weeks (or days) under one month. */
export function ageAt(birth: string, date: string): string | undefined {
  const [year, month, day] = birth.split("-").map(Number);
  const [nowYear, nowMonth, nowDay] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined || nowYear === undefined || nowMonth === undefined || nowDay === undefined) return undefined;
  const age = nowYear - year - (nowMonth < month || (nowMonth === month && nowDay < day) ? 1 : 0);
  if (age < 0 || age > 130) return undefined;
  if (age >= 1) return `age ${age}`;
  const months = (nowYear - year) * 12 + nowMonth - month - (nowDay < day ? 1 : 0);
  if (months >= 1) return `age ${months} ${months === 1 ? "month" : "months"}`;
  const days = Math.round((Date.UTC(nowYear, nowMonth - 1, nowDay) - Date.UTC(year, month - 1, day)) / 86_400_000);
  if (days < 0) return undefined;
  const weeks = Math.floor(days / 7);
  return weeks >= 1 ? `age ${weeks} ${weeks === 1 ? "week" : "weeks"}` : `age ${days} ${days === 1 ? "day" : "days"}`;
}

type FactLabel = Extract<MemoryLabelHit["label"], { kind: "fact" }>;

/** Reader-facing key: `other:` is a schema namespace, not part of the meaning. */
export function factKeyLabel(key: string): string {
  if (key === "birth_date") return "born";
  return key.replace(/^other:/u, "").replace(/[-_]+/gu, " ");
}

/** Reader-facing value text; never the JSON encoding. */
export function factValueText(value: NonNullable<FactLabel["value"]>): string {
  return value.type === "date" ? value.date : value.type === "text" ? value.text
    : value.type === "entity" ? value.entityId : `${value.role} ${value.targetEntityId}`;
}

const keyText = (key: string): string => key.replace(/^other:/u, "").replace(/[-_]+/gu, " ");

export function memoryGuidanceScopes(conversationId?: string, options: MemoryLoadOptions = {}): string[] {
  const scopes = ["agent"];
  if (conversationId !== undefined && conversationId.length > 0) scopes.push(`conversation:${scopeId(conversationId)
    && !conversationId.startsWith("h_") ? conversationId
      : `h_${createHash("sha256").update(conversationId).digest("hex")}`}`);
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

/**
 * Only labelled, host-scoped background for an owner turn. Triggers are
 * language-neutral: preferences and verified lessons by retrieval score within
 * their scope, person cards by an exact entity name or id in the message. No
 * question grammar decides what a card shows; the main model judges relevance.
 */
export function formatMemoryBackground(
  store: LabelRecallStore,
  query: string,
  conversationId: string,
  options: MemoryLoadOptions,
  hits: readonly MemoryRecallHit[],
  byteBudget = MAX_BACKGROUND_BYTES,
  /** Memory ids already shown in the possibly-relevant block. */
  shownMemoryIds: ReadonlySet<string> = new Set(),
): { readonly content: string; readonly truncated: boolean } | undefined {
  if (store.guidanceForScope === undefined || store.labelsForEntity === undefined) return undefined;
  const date = options.hostDate;
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined;
  const scopes = memoryGuidanceScopes(conversationId, options);
  const scores = new Map(hits.map((hit) => [hit.record.id, hit.score]));
  const floor = guidanceScoreFloor(hits.map((hit) => hit.score));
  const ranked = new Set([...hits].sort((a, b) => b.score - a.score).slice(0, GUIDANCE_MAX_RANK).map((hit) => hit.record.id));
  // Opposite statements may both appear; the main model judges them.
  const guidance = scopes.flatMap((scope) => store.guidanceForScope!(scope))
    .filter((hit) => hit.active && (hit.label.kind === "preference" || (hit.label.kind === "lesson" && hit.label.verified))
      && ranked.has(hit.memoryId) && (scores.get(hit.memoryId) ?? 0) >= floor && !shownMemoryIds.has(hit.memoryId))
    .sort((a, b) => (scores.get(b.memoryId) ?? 0) - (scores.get(a.memoryId) ?? 0) || a.memoryId.localeCompare(b.memoryId))
    .filter((hit, index, all) => all.findIndex((other) => other.text === hit.text) === index);

  const entities = resolveMemoryEntities(store, query);
  const explicitIds = new Set(query.match(/\bperson:[a-z0-9]+(?:-[a-z0-9]+)*\b/gu) ?? []);
  const ambiguous = new Set(entities.filter((entity) => !explicitIds.has(entity.id)
    && entities.some((other) => other.id !== entity.id && fold(other.name) === fold(entity.name)))
    .map((entity) => entity.id));
  // A named person gets the whole current card; conflicting values ask.
  const cards: string[] = [];
  for (const entity of entities.filter((entry) => !ambiguous.has(entry.id)).slice(0, 3)) {
    const facts = store.labelsForEntity(entity.id, date).filter((hit) => hit.label.kind === "fact" && hit.label.key !== undefined && hit.active
      && (hit.label.attribution === "user-stated" || hit.label.attribution === "document"));
    const parts: string[] = [];
    for (const key of [...new Set(facts.flatMap((hit) => hit.label.kind === "fact" && hit.label.key !== undefined ? [hit.label.key] : []))]) {
      const candidates = facts.filter((hit) => hit.label.kind === "fact" && hit.label.key === key && hit.currentAt);
      if (candidates.length === 0) continue;
      const distinct = new Set(candidates.flatMap((hit) => hit.label.kind === "fact" && hit.label.value !== undefined
        ? [fold(factValueText(hit.label.value))] : []));
      if (candidates.some((hit) => hit.conflict) || distinct.size > 1) {
        parts.push(`${keyText(key)}: conflicting values — ask`);
        continue;
      }
      for (const hit of candidates) {
        if (hit.label.kind !== "fact" || hit.label.value === undefined) continue;
        const value = hit.label.value;
        parts.push(`${factKeyLabel(key)}: ${safeLine(factValueText(value))} (${hit.label.attribution === "user-stated" ? "you said" : "document"}, recorded ${hit.createdAt.slice(0, 10)})`);
        if (key === "birth_date" && value.type === "date") {
          const age = ageAt(value.date, date);
          if (age !== undefined) parts.push(age);
        }
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
  return selected.length > 1 ? { content: selected.join("\n"), truncated } : truncated ? { content: "", truncated } : undefined;
}
