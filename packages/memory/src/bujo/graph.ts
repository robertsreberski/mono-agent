import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityRecord, EntityRelationRecord, MemoryEntityAssociation } from "../store/index.js";

const GRAPH_FILE = "graph.jsonl";

type GraphLine =
  | ({ readonly kind: "entity" } & EntityRecord)
  | ({ readonly kind: "relation" } & EntityRelationRecord)
  | ({ readonly kind: "association" } & MemoryEntityAssociation);

function graphPath(root: string): string {
  return join(root, GRAPH_FILE);
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
  const path = graphPath(root);
  if (!existsSync(path)) return { entities: [], relations: [], associations: [] };

  const raw = readFileSync(path, "utf8");
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

/** Append one precise memory/entity association to canonical graph evidence. */
export function appendAssociation(root: string, record: MemoryEntityAssociation): void {
  const current = readGraph(root).associations.find(
    (association) => association.memoryId === record.memoryId && association.entityId === record.entityId,
  );
  if (current !== undefined && (current.provenance === "capture" || record.provenance !== "capture")) return;
  mkdirSync(root, { recursive: true });
  const line: GraphLine = { kind: "association", ...record };
  appendFileSync(graphPath(root), `${JSON.stringify(line)}\n`, "utf8");
}

/** Append a single entity record to `<root>/graph.jsonl` (mkdir root if needed). */
export function appendEntity(root: string, record: EntityRecord): void {
  const current = readGraph(root).entities.find((entity) => entity.id === record.id);
  const recordToAppend = current === undefined ? record : mergeEntityRecord(current, record);
  if (current !== undefined && entityRecordsEqual(current, recordToAppend)) {
    return;
  }
  mkdirSync(root, { recursive: true });
  const line: GraphLine = { kind: "entity", ...recordToAppend };
  appendFileSync(graphPath(root), `${JSON.stringify(line)}\n`, "utf8");
}

/** Append a single relation record to `<root>/graph.jsonl` (mkdir root if needed). */
export function appendRelation(root: string, record: EntityRelationRecord): void {
  const exists = readGraph(root).relations.some(
    (relation) =>
      relation.src === record.src &&
      relation.dst === record.dst &&
      relation.relation === record.relation,
  );
  if (exists) {
    return;
  }
  mkdirSync(root, { recursive: true });
  const line: GraphLine = { kind: "relation", ...record };
  appendFileSync(graphPath(root), `${JSON.stringify(line)}\n`, "utf8");
}

function entityRecordsEqual(a: EntityRecord, b: EntityRecord): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.type === b.type &&
    a.summary === b.summary
  );
}

function mergeEntityRecord(current: EntityRecord, next: EntityRecord): EntityRecord {
  return {
    ...next,
    ...(next.type === undefined && current.type !== undefined ? { type: current.type } : {}),
    ...(next.summary === undefined && current.summary !== undefined ? { summary: current.summary } : {}),
    ...(next.updatedAt === undefined && current.updatedAt !== undefined ? { updatedAt: current.updatedAt } : {}),
  };
}
