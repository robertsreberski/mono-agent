import type { ExtractedEntity } from "./entities.js";

/**
 * Entity extraction is otherwise stateless: each turn sees only its own text,
 * so the same real-world thing acquires a fresh id every time it is mentioned.
 * In one observed graph the same curtains existed as `project:black-curtains`,
 * `object:curtain` (minted three minutes later in the same session), and
 * `product:magnetic-blackout-curtain-panels` two days on, with no edge between
 * them — so nothing downstream could tell they were one thing.
 *
 * This module picks a small, relevant set of ids the extractor already knows
 * about and offers them back as reuse candidates. Selection is lexical and
 * deterministic: no model call, no embeddings, no network, and no automatic
 * merging of anything already stored. The model still decides whether a turn
 * genuinely refers to a known entity; a wrong guess costs one redundant node,
 * exactly as today, rather than corrupting an existing one.
 */

/** Hints offered per turn. Enough to cover a topic, small enough to stay cheap. */
export const MAX_KNOWN_ENTITY_HINTS = 24;
/** Names are bounded at 160 in the graph; the prompt only needs the gist. */
const MAX_HINT_NAME_CHARS = 80;
/** Below this length a token carries no topical signal ("of", "to", "a"). */
const MIN_TOKEN_CHARS = 3;

interface ScoredHint {
  readonly entity: ExtractedEntity;
  readonly score: number;
  readonly createdAt: string;
  readonly associations: number;
}

/**
 * A reuse hint. When several known ids share one folded name, the first of
 * them (most associations, then the ordinary deterministic order) is the
 * preferred id and every other one names it in `preferredId`, so the model is
 * told which id to reuse instead of being offered equal-looking aliases.
 */
export interface KnownEntityHint extends ExtractedEntity {
  readonly preferredId?: string;
}

/** Known graph entity with its optional association count (graph usage). */
export type KnownEntity = ExtractedEntity & { readonly createdAt?: string; readonly associations?: number };

/** Case-, accent- and whitespace-insensitive name key used to spot duplicate ids. */
export function foldEntityName(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

/**
 * Fold trivial plurals so "curtains" in the turn matches a stored "curtain".
 * Deliberately cruder than a stemmer: this only chooses what to *show* the
 * model, and an over-eager rule would fill the prompt with false neighbours.
 */
function stem(token: string): string {
  return token.length > MIN_TOKEN_CHARS && token.endsWith("s") ? token.slice(0, -1) : token;
}

function tokenize(value: string): Set<string> {
  const tokens = value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens.filter((token) => token.length >= MIN_TOKEN_CHARS).map(stem));
}

/**
 * Rank known entities by how much of their name and id the turn actually
 * mentions. An entity sharing no token with the turn is not a candidate:
 * offering unrelated ids invites the model to attach a fact to the wrong node,
 * which is worse than the duplicate this feature exists to prevent.
 */
export function selectKnownEntityHints(
  text: string,
  known: readonly KnownEntity[],
  limit: number = MAX_KNOWN_ENTITY_HINTS,
): KnownEntityHint[] {
  if (limit <= 0) return [];
  const turnTokens = tokenize(text);
  if (turnTokens.size === 0) return [];

  const scored: ScoredHint[] = [];
  const seen = new Set<string>();
  for (const entity of known) {
    if (typeof entity?.id !== "string" || typeof entity.name !== "string") continue;
    if (seen.has(entity.id)) continue;
    seen.add(entity.id);
    let score = 0;
    for (const token of tokenize(`${entity.name} ${entity.id}`)) {
      if (turnTokens.has(token)) score += 1;
    }
    if (score === 0) continue;
    const associations = typeof entity.associations === "number" && Number.isFinite(entity.associations) ? entity.associations : 0;
    scored.push({ entity, score, createdAt: entity.createdAt ?? "", associations });
  }

  // Strongest overlap first, then most recent, then id — fully deterministic so
  // the same turn against the same graph always produces the same prompt.
  scored.sort((left, right) => right.score - left.score
    || right.createdAt.localeCompare(left.createdAt)
    || left.entity.id.localeCompare(right.entity.id));

  // Ids sharing one folded name stay adjacent, most-associated first: the
  // established node is the one the graph already uses, so it is the preferred
  // reuse target. Same-name ids remain visible because two different people
  // can share a first name; the model still decides.
  const groups = new Map<string, ScoredHint[]>();
  for (const hint of scored) {
    const key = foldEntityName(hint.entity.name);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [hint]);
    else group.push(hint);
  }
  const ordered: KnownEntityHint[] = [];
  for (const group of groups.values()) {
    // Stable sort keeps the ordinary order as the deterministic tie-break.
    const members = [...group].sort((left, right) => right.associations - left.associations);
    const preferred = members[0]!.entity.id;
    for (const { entity } of members) {
      const hint: KnownEntityHint = entity.type === undefined
        ? { id: entity.id, name: entity.name }
        : { id: entity.id, name: entity.name, type: entity.type };
      ordered.push(members.length > 1 && entity.id !== preferred ? { ...hint, preferredId: preferred } : hint);
    }
  }
  return ordered.slice(0, limit);
}

function clampName(name: string): string {
  const collapsed = name.replace(/\s+/gu, " ").trim();
  return [...collapsed].length > MAX_HINT_NAME_CHARS
    ? `${[...collapsed].slice(0, MAX_HINT_NAME_CHARS - 1).join("")}…`
    : collapsed;
}

/** Render the reuse block, or an empty string when there is nothing to offer. */
export function renderKnownEntityHints(hints: readonly KnownEntityHint[]): string {
  if (hints.length === 0) return "";
  const duplicated = new Set(hints.flatMap((hint) => hint.preferredId === undefined ? [] : [hint.preferredId]));
  const lines = hints.map((hint) => {
    const base = hint.type === undefined
      ? `- ${hint.id} — ${clampName(hint.name)}`
      : `- ${hint.id} — ${clampName(hint.name)} (${hint.type})`;
    if (hint.preferredId !== undefined) return `${base} — duplicate name; reuse ${hint.preferredId} unless this is a different thing`;
    return duplicated.has(hint.id) ? `${base} — preferred id for this name` : base;
  });
  return `\nKNOWN ENTITIES already in the graph, most relevant to this turn first:\n${lines.join("\n")}\n`;
}

/** One folded name shared by several entity ids, for operator merge review. */
export interface DuplicateEntityName {
  readonly name: string;
  readonly types: readonly string[];
  readonly associations: number;
  readonly ids: readonly { readonly id: string; readonly name: string; readonly type?: string; readonly associations: number }[];
}

/** Read-only: every folded name with more than one entity id, busiest first. */
export function findDuplicateEntityNames(
  graph: {
    readonly entities: readonly { readonly id: string; readonly name: string; readonly type?: string }[];
    readonly associations: readonly { readonly entityId: string }[];
  },
): DuplicateEntityName[] {
  const counts = new Map<string, number>();
  for (const { entityId } of graph.associations) counts.set(entityId, (counts.get(entityId) ?? 0) + 1);
  const groups = new Map<string, Map<string, { id: string; name: string; type?: string; associations: number }>>();
  for (const entity of graph.entities) {
    if (typeof entity?.id !== "string" || typeof entity.name !== "string") continue;
    const key = foldEntityName(entity.name);
    if (key.length === 0) continue;
    const group = groups.get(key) ?? new Map();
    // Graph rows are append-only; the last record for an id wins, as on read.
    group.set(entity.id, { id: entity.id, name: entity.name, ...(entity.type === undefined ? {} : { type: entity.type }),
      associations: counts.get(entity.id) ?? 0 });
    groups.set(key, group);
  }
  const duplicates: DuplicateEntityName[] = [];
  for (const [name, group] of groups) {
    if (group.size < 2) continue;
    const ids = [...group.values()].sort((left, right) => right.associations - left.associations || left.id.localeCompare(right.id));
    duplicates.push({ name, types: [...new Set(ids.map(({ type }) => type ?? "untyped"))].sort(),
      associations: ids.reduce((sum, { associations }) => sum + associations, 0), ids });
  }
  return duplicates.sort((left, right) => right.associations - left.associations
    || right.ids.length - left.ids.length || left.name.localeCompare(right.name));
}
