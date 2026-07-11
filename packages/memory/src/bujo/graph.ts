import type { EntityRecord, EntityRelationRecord, MemoryEntityAssociation } from "../store/index.js";
import { appendCanonicalFile, readCanonicalFileSnapshot } from "./path-safety.js";

const GRAPH_FILE = "graph.jsonl";

type GraphLine =
  | ({ readonly kind: "entity" } & EntityRecord)
  | ({ readonly kind: "relation" } & EntityRelationRecord)
  | ({ readonly kind: "association" } & MemoryEntityAssociation);

export interface GraphBatchInput {
  readonly entities?: readonly EntityRecord[];
  readonly relations?: readonly EntityRelationRecord[];
  readonly associations?: readonly MemoryEntityAssociation[];
}

export interface GraphBatchResult {
  readonly entities: readonly EntityRecord[];
  readonly relations: readonly EntityRelationRecord[];
  readonly associations: readonly MemoryEntityAssociation[];
}

/**
 * Read the canonical graph.jsonl at `<root>/graph.jsonl`.
 * Missing file → `{entities:[], relations:[]}`.
 * Malformed lines are skipped defensively (never throws).
 * Dedupes on read: entities by `id` keeping the LAST occurrence;
 * relations by `src|dst|relation` keeping the last.
 */
export function readGraph(root: string): {
  entities: EntityRecord[];
  relations: EntityRelationRecord[];
  associations: MemoryEntityAssociation[];
} {
  const snapshot = readCanonicalFileSnapshot(root, GRAPH_FILE, { allowMissing: true });
  if (snapshot === undefined) return { entities: [], relations: [], associations: [] };
  const raw = snapshot.content;
  const entityMap = new Map<string, EntityRecord>();
  const relationMap = new Map<string, EntityRelationRecord>();
  const associationMap = new Map<string, MemoryEntityAssociation>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // skip malformed lines
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const rec = parsed as Record<string, unknown>;
    if (rec["kind"] === "entity") {
      const { kind: _kind, ...rest } = rec;
      const entity = rest as unknown as EntityRecord;
      if (typeof entity.id === "string" && entity.id.length > 0) {
        entityMap.set(entity.id, entity);
      }
    } else if (rec["kind"] === "relation") {
      const { kind: _kind, ...rest } = rec;
      const relation = rest as unknown as EntityRelationRecord;
      if (
        typeof relation.src === "string" &&
        typeof relation.dst === "string" &&
        typeof relation.relation === "string"
      ) {
        const key = `${relation.src}|${relation.dst}|${relation.relation}`;
        relationMap.set(key, relation);
      }
    } else if (rec["kind"] === "association") {
      const { kind: _kind, ...rest } = rec;
      const association = rest as unknown as MemoryEntityAssociation;
      if (
        typeof association.memoryId === "string"
        && association.memoryId.length > 0
        && typeof association.entityId === "string"
        && association.entityId.length > 0
        && (association.provenance === "capture" || association.provenance === "legacy-name-match")
        && typeof association.createdAt === "string"
        && association.createdAt.length > 0
      ) {
        associationMap.set(`${association.memoryId}|${association.entityId}`, association);
      }
    }
  }

  return {
    entities: Array.from(entityMap.values()),
    relations: Array.from(relationMap.values()),
    associations: Array.from(associationMap.values()),
  };
}

/**
 * Merge a capture's graph evidence with one source read and one append.
 * Returned records are the exact canonical forms callers must mirror to DB.
 */
export function appendGraphBatch(root: string, input: GraphBatchInput): GraphBatchResult {
  const current = readGraph(root);
  const originalEntities = new Map(current.entities.map((record) => [record.id, record]));
  const originalRelations = new Map(current.relations.map((record) => [relationKey(record), record]));
  const originalAssociations = new Map(current.associations.map((record) => [associationKey(record), record]));
  const entities = new Map(originalEntities);
  const relations = new Map(originalRelations);
  const associations = new Map(originalAssociations);
  const touchedEntities = new Set<string>();
  const touchedRelations = new Set<string>();
  const touchedAssociations = new Set<string>();

  for (const record of input.entities ?? []) {
    const prior = entities.get(record.id);
    entities.set(record.id, prior === undefined ? record : mergeEntityRecord(prior, record));
    touchedEntities.add(record.id);
  }
  for (const record of input.relations ?? []) {
    const key = relationKey(record);
    if (!relations.has(key)) relations.set(key, record);
    touchedRelations.add(key);
  }
  for (const record of input.associations ?? []) {
    const key = associationKey(record);
    const prior = associations.get(key);
    if (prior === undefined) {
      associations.set(key, record);
    } else if (prior.provenance !== "capture" && record.provenance === "capture") {
      associations.set(key, { ...record, createdAt: prior.createdAt });
    }
    touchedAssociations.add(key);
  }

  const lines: GraphLine[] = [];
  for (const key of touchedEntities) {
    const record = entities.get(key)!;
    const prior = originalEntities.get(key);
    if (prior === undefined || !entityRecordsEqual(prior, record)) lines.push({ kind: "entity", ...record });
  }
  for (const key of touchedRelations) {
    const record = relations.get(key)!;
    if (!originalRelations.has(key)) lines.push({ kind: "relation", ...record });
  }
  for (const key of touchedAssociations) {
    const record = associations.get(key)!;
    const prior = originalAssociations.get(key);
    if (prior === undefined || prior.provenance !== record.provenance || prior.createdAt !== record.createdAt) {
      lines.push({ kind: "association", ...record });
    }
  }
  if (lines.length > 0) {
    appendCanonicalFile(root, GRAPH_FILE, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }

  return {
    entities: [...touchedEntities].map((key) => entities.get(key)!),
    relations: [...touchedRelations].map((key) => relations.get(key)!),
    associations: [...touchedAssociations].map((key) => associations.get(key)!),
  };
}

/** Append one precise memory/entity association and return its canonical merged record. */
export function appendAssociation(root: string, record: MemoryEntityAssociation): MemoryEntityAssociation {
  return appendGraphBatch(root, { associations: [record] }).associations[0]!;
}

/** Append an entity and return the exact canonical merged record. */
export function appendEntity(root: string, record: EntityRecord): EntityRecord {
  return appendGraphBatch(root, { entities: [record] }).entities[0]!;
}

/** Append a single relation record to `<root>/graph.jsonl` (mkdir root if needed). */
export function appendRelation(root: string, record: EntityRelationRecord): void {
  appendGraphBatch(root, { relations: [record] });
}

function relationKey(record: Pick<EntityRelationRecord, "src" | "dst" | "relation">): string {
  return `${record.src}|${record.dst}|${record.relation}`;
}

function associationKey(record: Pick<MemoryEntityAssociation, "memoryId" | "entityId">): string {
  return `${record.memoryId}|${record.entityId}`;
}

function entityRecordsEqual(a: EntityRecord, b: EntityRecord): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.type === b.type &&
    a.summary === b.summary &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt
  );
}

function mergeEntityRecord(current: EntityRecord, next: EntityRecord): EntityRecord {
  const type = next.type ?? current.type;
  const summary = next.summary ?? current.summary;
  const merged: EntityRecord = {
    id: next.id,
    name: next.name,
    createdAt: current.createdAt,
    ...(type === undefined ? {} : { type }),
    ...(summary === undefined ? {} : { summary }),
  };
  const changed = current.name !== merged.name
    || current.type !== merged.type
    || current.summary !== merged.summary;
  return {
    ...merged,
    ...(changed
      ? { updatedAt: next.updatedAt ?? next.createdAt }
      : current.updatedAt === undefined ? {} : { updatedAt: current.updatedAt }),
  };
}
