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
const safeLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim();
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

/** Only labelled, host-scoped background. Never alters the ordinary answer-evidence gate. */
export function formatMemoryBackground(
  store: LabelRecallStore,
  query: string,
  conversationId: string,
  options: MemoryLoadOptions,
  hits: readonly MemoryRecallHit[],
  byteBudget = MAX_BACKGROUND_BYTES,
): { readonly content: string; readonly truncated: boolean } | undefined {
  if (store.guidanceForScope === undefined || store.labelsForEntity === undefined) return undefined;
  const date = options.hostDate;
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined;
  const scopes = ["agent"];
  if (scopeId(conversationId)) scopes.push(`conversation:${conversationId}`);
  if (options.senderToken !== undefined && /^[a-f0-9]{32}$/u.test(options.senderToken)) scopes.push(`user:${options.senderToken}`);
  // No project scope: the harness has no host-confirmed active project id.
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

  const entities: Array<{ id: string; name: string }> = [];
  for (const entity of store.findMemoryEntitiesByNames?.(entityNamesInQuery(query)) ?? []) {
    if (PERSON_ID.test(entity.id) && entity.id.length <= 96) entities.push({ id: entity.id, name: entity.name });
  }
  for (const id of query.match(/\bperson:[a-z0-9]+(?:-[a-z0-9]+)*\b/gu) ?? []) {
    if (id.length <= 96 && PERSON_ID.test(id) && !entities.some((entity) => entity.id === id)) {
      entities.push({ id, name: id });
    }
  }
  const explicitIds = new Set(query.match(/\bperson:[a-z0-9]+(?:-[a-z0-9]+)*\b/gu) ?? []);
  const ambiguous = new Set(entities.filter((entity) => !explicitIds.has(entity.id)
    && entities.some((other) => other.id !== entity.id && fold(other.name) === fold(entity.name)))
    .map((entity) => entity.id));
  const cards: string[] = [];
  for (const entity of entities.filter((entry) => !ambiguous.has(entry.id)).slice(0, 3)) {
    const facts = store.labelsForEntity(entity.id, date).filter((hit) => hit.label.kind === "fact" && hit.active
      && (hit.label.attribution === "user-stated" || hit.label.attribution === "document"));
    const parts: string[] = [];
    for (const key of [...new Set(facts.map((hit) => hit.label.kind === "fact" ? hit.label.key : ""))]) {
      const candidates = facts.filter((hit) => hit.label.kind === "fact" && hit.label.key === key && hit.currentAt);
      if (candidates.length === 0) continue;
      if (candidates.some((hit) => hit.conflict)) {
        parts.push(`${key}: conflicting values — ask`);
        continue;
      }
      for (const hit of candidates) {
        if (hit.label.kind !== "fact") continue;
        const value = hit.label.value;
        const display = value.type === "date" ? value.date : value.type === "text" ? value.text
          : value.type === "entity" ? value.entityId : `${value.role} ${value.targetEntityId}`;
        parts.push(`${key === "birth_date" ? "born" : key.replaceAll("_", " ")}: ${safeLine(display)} (${hit.label.attribution === "user-stated" ? "you said" : "document"}, recorded ${hit.createdAt.slice(0, 10)})`);
        if (key === "birth_date" && value.type === "date") {
          const age = ageAt(value.date, date);
          if (age !== undefined) parts.push(`age ${age}`);
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
  return selected.length > 1 ? { content: selected.join("\n"), truncated }
    : truncated ? { content: "", truncated: true } : undefined;
}
