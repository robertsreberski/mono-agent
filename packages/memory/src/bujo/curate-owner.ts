import { createHash } from "node:crypto";
import { listCanonicalFileNames, listCanonicalRootFileNames, readCanonicalFileSnapshot, writeCanonicalFileAtomic } from "./path-safety.js";
import { parseDailyFile } from "./grammar.js";
import { isLegacyHostObservation, projectCanonicalGraph, readCanonicalGraphStrictSnapshot } from "./graph.js";
import { isSkippedRawBujoRecord } from "./rebuild-source-validation.js";
import { labelsOf } from "./labels.js";
import { OWNER_ENTITY_ID } from "./entity-reuse.js";
import type { MemoryDb } from "../store/index.js";
import type { Bullet } from "./types.js";

/**
 * Operator-reviewed owner association backfill. Only durable structured labels
 * that explicitly bind `person:owner` qualify. Unlabelled legacy prose has no
 * language-independent proof of its speaker or grammatical subject; leave it
 * for operator review rather than guessing from words in the line.
 */
export type CurateOwnerAssociationReason = "owner-text" | "owner-bare" | "owner-label";
export interface CurateOwnerAssociation {
  readonly id: string;
  readonly textHash: string;
  readonly reason: CurateOwnerAssociationReason;
  readonly accepted: boolean;
}
export interface CurateOwnerBackfillScan {
  readonly associations: readonly CurateOwnerAssociation[];
  /** Counts only: live lines examined and why candidates were not proposed. */
  readonly counts: {
    readonly live: number; readonly alreadyLinked: number; /** Reserved for compatibility with existing count consumers; no prose is parsed. */
    readonly notProven: number; readonly proposed: number;
    /** Reserved for compatibility with existing count consumers. */
    readonly bare: number;
  };
}
export const MAX_CURATE_OWNER_ASSOCIATIONS = 8192;
const MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }

/** Why a bullet's own source proves the owner is its subject, or undefined. */
export function ownerAssociationReason(bullet: Pick<Bullet, "text" | "refs">): CurateOwnerAssociationReason | undefined {
  let labels;
  try { labels = labelsOf(bullet); } catch { labels = []; }
  if (labels.some((label) => (label.kind === "fact" && label.entityId === OWNER_ENTITY_ID)
    || (label.kind === "preference" && label.scope === "agent" && label.attribution === "user-stated"))) return "owner-label";
  return undefined;
}

function dailyPaths(root: string): string[] {
  return [...listCanonicalRootFileNames(root, { include: (name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name) }),
    ...listCanonicalFileNames(root, "daily", { allowMissing: true, include: (name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name) }).map((name) => `daily/${name}`)].sort();
}

/** Live canonical bullets by id; each daily file is parsed once. */
export function liveBullets(root: string): Map<string, Bullet> {
  const bullets = new Map<string, Bullet>();
  for (const file of dailyPaths(root)) {
    const snapshot = readCanonicalFileSnapshot(root, file);
    if (snapshot === undefined) continue;
    for (const bullet of parseDailyFile(snapshot.content).bullets) {
      if (isSkippedRawBujoRecord(bullet.id, bullet.text) || isLegacyHostObservation(bullet.text)) continue;
      if (bullet.status === "dropped" || bullet.status === "invalidated") continue;
      if (bullets.has(bullet.id)) throw new Error("memory-curate: duplicate canonical id");
      bullets.set(bullet.id, bullet);
    }
  }
  return bullets;
}

function ownerLinked(root: string): Set<string> {
  return new Set(readCanonicalGraphStrictSnapshot(root).records.associations
    .filter((association) => association.entityId === OWNER_ENTITY_ID).map((association) => association.memoryId));
}

/** Deterministic, read-only scan of every live canonical line. */
export function proposeOwnerAssociations(root: string): CurateOwnerBackfillScan {
  const linked = ownerLinked(root);
  const associations: CurateOwnerAssociation[] = [];
  let live = 0; let alreadyLinked = 0;
  for (const bullet of liveBullets(root).values()) {
    live++;
    const reason = ownerAssociationReason(bullet);
    if (reason === undefined) {
      continue;
    }
    if (linked.has(bullet.id)) { alreadyLinked++; continue; }
    if (associations.length >= MAX_CURATE_OWNER_ASSOCIATIONS) throw new Error("memory-curate: too many owner associations");
    associations.push({ id: bullet.id, textHash: hash(bullet.text), reason, accepted: reason !== "owner-bare" });
  }
  return { associations, counts: { live, alreadyLinked, notProven: 0, proposed: associations.length, bare: 0 } };
}

export function validateCurateOwnerAssociation(association: CurateOwnerAssociation): void {
  if (association === null || typeof association !== "object" || Array.isArray(association)
    || Object.keys(association).sort().join(",") !== "accepted,id,reason,textHash"
    || typeof association.id !== "string" || !MEMORY_ID.test(association.id)
    || typeof association.textHash !== "string" || !/^[a-f0-9]{64}$/u.test(association.textHash)
    || !["owner-text", "owner-bare", "owner-label"].includes(association.reason)
    || typeof association.accepted !== "boolean") {
    throw new Error("memory-curate: invalid owner association");
  }
}

/**
 * Pre-backup check of accepted owner associations against the current source:
 * the line must still be live and unchanged, still qualify for the same reason,
 * not be dropped by the same plan, and not already be linked to the owner.
 * When the same plan rewrites or relabels the line, its final text and
 * references must still prove the owner is the subject.
 */
export function previewOwnerAssociations(root: string, associations: readonly CurateOwnerAssociation[],
  droppedIds: ReadonlySet<string>, activeDb?: MemoryDb,
  finals: ReadonlyMap<string, Pick<Bullet, "text" | "refs">> = new Map()): readonly string[] {
  for (const association of associations) validateCurateOwnerAssociation(association);
  const accepted = associations.filter(({ accepted }) => accepted);
  if (accepted.length === 0) return [];
  if (accepted.length > MAX_CURATE_OWNER_ASSOCIATIONS) throw new Error("memory-curate: too many owner associations");
  const bullets = liveBullets(root);
  const linked = ownerLinked(root);
  const seen = new Set<string>();
  for (const association of accepted) {
    const bullet = bullets.get(association.id);
    if (seen.has(association.id) || droppedIds.has(association.id)) throw new Error("memory-curate: conflicting owner association");
    seen.add(association.id);
    if (bullet === undefined || hash(bullet.text) !== association.textHash
      || ownerAssociationReason(bullet) !== association.reason) throw new Error("memory-curate: stale owner association");
    const final = finals.get(association.id);
    if (final !== undefined && ownerAssociationReason(final) === undefined) {
      throw new Error("memory-curate: rewrite invalidates owner association");
    }
    if (linked.has(association.id)) throw new Error("memory-curate: owner association already exists");
    if (activeDb && !activeDb.get(association.id)) throw new Error("memory-curate: selected id is not in the active index");
  }
  return [...seen];
}

/**
 * Runs inside the curate root-swap transaction, after merges and drops, for
 * reviewed owner and person links alike. `person:owner` is created when a
 * link needs it. A canonical association suppresses name-derived (legacy)
 * associations for its memory, so the currently derived ones are recorded
 * alongside it and the line keeps every link it had before.
 */
export function applyEntityAssociations(root: string, db: MemoryDb,
  links: readonly { readonly memoryId: string; readonly entityId: string }[], now: () => Date): number {
  if (links.length === 0) return 0;
  const snapshot = readCanonicalGraphStrictSnapshot(root);
  const graph = snapshot.records;
  const createdAt = now().toISOString();
  const entities = [...graph.entities];
  if (links.some(({ entityId }) => entityId === OWNER_ENTITY_ID) && !entities.some(({ id }) => id === OWNER_ENTITY_ID)) {
    entities.push({ id: OWNER_ENTITY_ID, name: "Owner", type: "person", createdAt });
  }
  const known = new Set(entities.map(({ id }) => id));
  if (links.some(({ entityId }) => !known.has(entityId))) throw new Error("memory-curate: association refers to an unknown entity");
  const targets = new Set(links.map(({ memoryId }) => memoryId));
  const projection = projectCanonicalGraph({ ...graph, entities }, db.canonicalGraphSnapshot().memories);
  const kept = projection.associations.filter((association) => targets.has(association.memoryId)
    && association.provenance === "legacy-name-match");
  // Provenance `capture` is safe without a capture intent behind it:
  // - rebuild takes associations from canonical graph.jsonl, and its repair
  //   path (rebuild.ts safeRepairableAssociationInventory) requires `capture`
  //   rows to match exactly in both directions, repairing only derived
  //   `legacy-name-match` rows; it never drops or reinterprets a `capture` row;
  // - capture intents only exclude still-pending outbox keys from that
  //   comparison, and apply runs after durable-mutation recovery under the
  //   maintenance lease, so none are pending;
  // - graph appends and the SQLite upsert keep `capture` over a derived row and
  //   never downgrade it;
  // - operator merges already rewrite `capture` rows without an intent.
  // A distinct provenance would widen the public association type and every
  // validator for no behavioural difference.
  const associations = [...graph.associations, ...kept,
    ...links.map(({ memoryId, entityId }) => ({ memoryId, entityId, provenance: "capture" as const, createdAt }))];
  const lines = [
    ...entities.map((entity) => JSON.stringify({ ...entity, kind: "entity" })),
    ...graph.relations.map((relation) => JSON.stringify({ ...relation, kind: "relation" })),
    ...[...new Map(associations.map((association) => [`${association.memoryId}\0${association.entityId}`, association])).values()]
      .map((association) => JSON.stringify({ ...association, kind: "association" })),
  ].join("\n") + "\n";
  writeCanonicalFileAtomic(root, "graph.jsonl", lines, snapshot.identity);
  return new Set(links.map(({ memoryId, entityId }) => `${memoryId}\0${entityId}`)).size;
}
