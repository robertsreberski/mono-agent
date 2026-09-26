import { createHash } from "node:crypto";
import { readCanonicalGraphStrictSnapshot } from "./graph.js";
import { OWNER_ENTITY_ID } from "./entity-reuse.js";
import { liveBullets } from "./curate-owner.js";
import { unsafeCredentialContext } from "./text-safety.js";
import type { MemoryDb } from "../store/index.js";
import type { Bullet } from "./types.js";

/**
 * Operator-reviewed person links for lines that name a known person
 * (`memory curate prepare --limit 0 --link-people`).
 *
 * Coarse person labels are only derived for lines already associated with a
 * person entity. This module proposes those associations, model-free, from the
 * line's own text and the graph's `person:` display names, with no word lists
 * or language-specific grammar (`person-name`):
 *
 * The line contains one person entity's full display name, as a whole word
 * and with the same capitalisation. Only proper names qualify (every word
 * capitalised, letters and inner hyphens only); a name held by more than one
 * person entity (after the plan's merges) is ambiguous and never linked, and a
 * name used as a line-leading speaker label (`Name: ...`) is not a mention.
 * `person:owner` is never linked here, including through a name merged into
 * it; owner links come from `--owner-backfill`.
 *
 * Only live note/event lines outside credential contexts are considered. Links
 * start accepted; the operator rejects them in review. Apply writes them in
 * the curate root-swap transaction, like owner associations.
 */
export type CuratePersonAssociationReason = "person-name";
export interface CuratePersonAssociation {
  readonly id: string;
  readonly textHash: string;
  readonly entityId: string;
  readonly reason: CuratePersonAssociationReason;
  readonly accepted: boolean;
}
export interface CuratePersonLinkScan {
  readonly associations: readonly CuratePersonAssociation[];
  /** Counts only. */
  readonly counts: {
    /** Live note/event lines examined (credential contexts excluded). */
    readonly live: number;
    /** Live lines that already had any person association. */
    readonly linkedBefore: number;
    /** Name matches skipped because the line is already associated with that entity. */
    readonly alreadyLinked: number;
    readonly proposed: number;
    /** Distinct lines with at least one proposal that had no person association before. */
    readonly newlyLinkedLines: number;
    /** Distinct names held by more than one person entity, and lines skipped for naming one. */
    readonly ambiguousNames: number;
    readonly ambiguousLines: number;
    /** More proposals remain: apply this plan, then prepare again. */
    readonly more: boolean;
  };
}
/** Proposals per prepare pass; later passes continue where this one stopped. */
export const MAX_CURATE_PERSON_ASSOCIATIONS_PER_PASS = 1024;
/** Plan-level bound on stored person associations. */
export const MAX_CURATE_PERSON_ASSOCIATIONS = 8192;
const MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const PROPER_WORD = /^\p{Lu}\p{L}*(?:-\p{Lu}?\p{L}+)*$/u;

interface NameIndex {
  /** Unambiguous names (exact, case-sensitive) to their person id. */
  readonly names: ReadonlyMap<string, string>;
  readonly ambiguous: ReadonlySet<string>;
  readonly patterns: ReadonlyMap<string, RegExp>;
}

/** The display name when it is a proper name, else undefined. */
function properName(name: string): string | undefined {
  const words = name.trim().split(/\s+/u);
  if (words.length > 4 || !words.every((word) => PROPER_WORD.test(word))) return undefined;
  return words.join(" ");
}

function escapeName(name: string): string { return name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

/**
 * Person names from the canonical graph, after the given merges (`from` ids
 * resolve to their target). `person:owner`'s own display name is not used; a
 * name merged into it counts towards ambiguity like any other.
 */
function personNameIndex(entities: readonly { readonly id: string; readonly name: string }[],
  pairs: ReadonlyMap<string, string>): NameIndex {
  const holders = new Map<string, Set<string>>();
  for (const entity of entities) {
    const target = pairs.get(entity.id) ?? entity.id;
    const key = properName(entity.name);
    if (entity.id === OWNER_ENTITY_ID || !entity.id.startsWith("person:") || !target.startsWith("person:") || key === undefined) continue;
    const ids = holders.get(key) ?? new Set<string>();
    ids.add(target);
    holders.set(key, ids);
  }
  const names = new Map<string, string>();
  const ambiguous = new Set<string>();
  const patterns = new Map<string, RegExp>();
  for (const [key, ids] of [...holders].sort(([a], [b]) => a.localeCompare(b))) {
    if (ids.size > 1) ambiguous.add(key);
    else names.set(key, [...ids][0]!);
    // Whole word, same capitalisation; ambiguous names are matched only to count skipped lines.
    patterns.set(key, new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeName(key)}(?![\\p{L}\\p{N}_-])`, "gu"));
  }
  return { names, ambiguous, patterns };
}

/** Person ids the line's own text names, in name order; plus whether an ambiguous name was skipped. */
function personLinks(text: string, index: NameIndex): { readonly links: Set<string>; readonly ambiguous: boolean } {
  const links = new Set<string>();
  let ambiguous = false;
  for (const [key, pattern] of index.patterns) {
    // A line-leading `Name:` is a speaker label (a pasted log envelope), not a mention.
    if (![...text.matchAll(pattern)].some((match) => match.index !== 0 || text[key.length] !== ":")) continue;
    const entityId = index.names.get(key);
    if (entityId === undefined) { ambiguous = true; continue; }
    if (entityId !== OWNER_ENTITY_ID) links.add(entityId);
  }
  return { links, ambiguous };
}

function eligible(bullet: Pick<Bullet, "type" | "text">): boolean {
  return bullet.type !== "task" && !unsafeCredentialContext(bullet.text);
}

function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }

/** Existing person links by memory id, as they will be after `pairs`. */
function personLinked(associations: readonly { readonly memoryId: string; readonly entityId: string }[],
  pairs: ReadonlyMap<string, string>): Map<string, Set<string>> {
  const linked = new Map<string, Set<string>>();
  for (const association of associations) {
    const { memoryId } = association;
    const entityId = pairs.get(association.entityId) ?? association.entityId;
    if (!entityId.startsWith("person:")) continue;
    const ids = linked.get(memoryId) ?? new Set<string>();
    ids.add(entityId);
    linked.set(memoryId, ids);
  }
  return linked;
}

/**
 * Deterministic, read-only scan of every live canonical line (each daily file
 * parsed once), in canonical order, bounded per pass. `mergePairs` are the
 * plan's accepted operator merges (`from` to `to`). A line's links stay in one
 * pass, except that a line naming more people than the whole bound gets as
 * many as still fit; its remaining links come in the next pass.
 */
export function scanPersonAssociations(root: string, mergePairs: ReadonlyMap<string, string> = new Map(),
  max = MAX_CURATE_PERSON_ASSOCIATIONS_PER_PASS): CuratePersonLinkScan {
  if (!Number.isInteger(max) || max < 1 || max > MAX_CURATE_PERSON_ASSOCIATIONS) throw new Error("memory-curate: invalid limit");
  const graph = readCanonicalGraphStrictSnapshot(root).records;
  const index = personNameIndex(graph.entities, mergePairs);
  const linked = personLinked(graph.associations, mergePairs);
  const associations: CuratePersonAssociation[] = [];
  let live = 0; let linkedBefore = 0; let alreadyLinked = 0; let newlyLinkedLines = 0; let ambiguousLines = 0;
  let more = false;
  for (const bullet of liveBullets(root).values()) {
    if (!eligible(bullet)) continue;
    live++;
    const existing = linked.get(bullet.id);
    if (existing !== undefined) linkedBefore++;
    const { links, ambiguous } = personLinks(bullet.text, index);
    if (ambiguous) ambiguousLines++;
    let fresh = [...links].filter((entityId) => {
      if (existing?.has(entityId) !== true) return true;
      alreadyLinked++;
      return false;
    });
    if (fresh.length === 0 || more) continue;
    const room = max - associations.length;
    if (fresh.length > room) {
      more = true;
      // A line that could never fit one pass is split; any other line waits for the next pass.
      if (fresh.length <= max || room === 0) continue;
      fresh = fresh.slice(0, room);
    }
    if (existing === undefined) newlyLinkedLines++;
    const textHash = hash(bullet.text);
    for (const entityId of fresh) associations.push({ id: bullet.id, textHash, entityId, reason: "person-name", accepted: true });
  }
  return { associations, counts: { live, linkedBefore, alreadyLinked, proposed: associations.length, newlyLinkedLines,
    ambiguousNames: index.ambiguous.size, ambiguousLines, more } };
}

export function validateCuratePersonAssociation(association: CuratePersonAssociation): void {
  if (association === null || typeof association !== "object" || Array.isArray(association)
    || Object.keys(association).sort().join(",") !== "accepted,entityId,id,reason,textHash"
    || typeof association.id !== "string" || !MEMORY_ID.test(association.id)
    || typeof association.textHash !== "string" || !/^[a-f0-9]{64}$/u.test(association.textHash)
    || typeof association.entityId !== "string" || !ENTITY_ID.test(association.entityId) || !association.entityId.startsWith("person:")
    || association.entityId === OWNER_ENTITY_ID || association.reason !== "person-name"
    || typeof association.accepted !== "boolean") {
    throw new Error("memory-curate: invalid person association");
  }
}

export interface CuratePersonLink { readonly memoryId: string; readonly entityId: string }

/**
 * Pre-backup check of accepted person associations against the current
 * source and graph (after `mergePairs`): the line must still be live,
 * unchanged and eligible and its text must still name that person, both as
 * stored and as the same plan rewrites it; the same plan may not drop it, and
 * it must not already be associated with that person.
 */
export function previewPersonAssociations(root: string, associations: readonly CuratePersonAssociation[],
  mergePairs: ReadonlyMap<string, string>, droppedIds: ReadonlySet<string>, activeDb?: MemoryDb,
  finals: ReadonlyMap<string, Pick<Bullet, "text">> = new Map()): readonly CuratePersonLink[] {
  for (const association of associations) validateCuratePersonAssociation(association);
  if (associations.length > MAX_CURATE_PERSON_ASSOCIATIONS) throw new Error("memory-curate: too many person associations");
  const accepted = associations.filter(({ accepted }) => accepted);
  if (accepted.length === 0) return [];
  const graph = readCanonicalGraphStrictSnapshot(root).records;
  const index = personNameIndex(graph.entities, mergePairs);
  const linked = personLinked(graph.associations, mergePairs);
  const bullets = liveBullets(root);
  const seen = new Set<string>();
  const links: CuratePersonLink[] = [];
  for (const association of accepted) {
    const key = `${association.id}\0${association.entityId}`;
    if (seen.has(key) || droppedIds.has(association.id)) throw new Error("memory-curate: conflicting person association");
    seen.add(key);
    const bullet = bullets.get(association.id);
    if (bullet === undefined || !eligible(bullet) || hash(bullet.text) !== association.textHash
      || !personLinks(bullet.text, index).links.has(association.entityId)) {
      throw new Error("memory-curate: stale person association");
    }
    const final = finals.get(association.id);
    if (final !== undefined && (!eligible({ type: bullet.type, text: final.text })
      || !personLinks(final.text, index).links.has(association.entityId))) {
      throw new Error("memory-curate: rewrite invalidates person association");
    }
    if (linked.get(association.id)?.has(association.entityId) === true) throw new Error("memory-curate: person association already exists");
    if (activeDb && !activeDb.get(association.id)) throw new Error("memory-curate: selected id is not in the active index");
    links.push({ memoryId: association.id, entityId: association.entityId });
  }
  return links;
}
