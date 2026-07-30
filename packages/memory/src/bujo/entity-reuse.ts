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
  known: readonly (ExtractedEntity & { readonly createdAt?: string })[],
  limit: number = MAX_KNOWN_ENTITY_HINTS,
): ExtractedEntity[] {
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
    scored.push({ entity, score, createdAt: entity.createdAt ?? "" });
  }

  // Strongest overlap first, then most recent, then id — fully deterministic so
  // the same turn against the same graph always produces the same prompt.
  scored.sort((left, right) => right.score - left.score
    || right.createdAt.localeCompare(left.createdAt)
    || left.entity.id.localeCompare(right.entity.id));

  return scored.slice(0, limit).map(({ entity }) => (
    entity.type === undefined
      ? { id: entity.id, name: entity.name }
      : { id: entity.id, name: entity.name, type: entity.type }
  ));
}

function clampName(name: string): string {
  const collapsed = name.replace(/\s+/gu, " ").trim();
  return [...collapsed].length > MAX_HINT_NAME_CHARS
    ? `${[...collapsed].slice(0, MAX_HINT_NAME_CHARS - 1).join("")}…`
    : collapsed;
}

/** Render the reuse block, or an empty string when there is nothing to offer. */
export function renderKnownEntityHints(hints: readonly ExtractedEntity[]): string {
  if (hints.length === 0) return "";
  const lines = hints.map((hint) => (
    hint.type === undefined
      ? `- ${hint.id} — ${clampName(hint.name)}`
      : `- ${hint.id} — ${clampName(hint.name)} (${hint.type})`
  ));
  return `\nKNOWN ENTITIES already in the graph, most relevant to this turn first:\n${lines.join("\n")}\n`;
}
