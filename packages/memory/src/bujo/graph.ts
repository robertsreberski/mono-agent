import { createHash } from "node:crypto";

import type {
  EntityRecord,
  EntityRelationRecord,
  MemoryEntityAssociation,
  MemoryRecord,
} from "../store/index.js";
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

export type GraphProjectionMemory = Pick<MemoryRecord, "id" | "status" | "text" | "createdAt">;

export interface CanonicalGraphRecords {
  readonly entities: readonly EntityRecord[];
  readonly relations: readonly EntityRelationRecord[];
  readonly associations: readonly MemoryEntityAssociation[];
}

export interface CanonicalGraphProjection extends CanonicalGraphRecords {
  readonly collectionSupports: readonly {
    readonly memoryId: string;
    readonly entityId: string;
    readonly collection: string;
  }[];
  readonly derivedLegacyAssociations: number;
}

export type CanonicalGraphIssueCode =
  | "malformed-json"
  | "unknown-kind"
  | "invalid-record"
  | "orphan-endpoint"
  | "invalid-projection";

/** Content-free strict canonical graph failure suitable for health reporting. */
export class CanonicalGraphValidationError extends Error {
  constructor(
    readonly code: CanonicalGraphIssueCode,
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "CanonicalGraphValidationError";
  }
}

export interface StrictCanonicalGraphSnapshot {
  readonly fingerprint: string;
  readonly records: CanonicalGraphRecords;
}

/** Read and strictly validate one identity-stable canonical graph snapshot. */
export function readCanonicalGraphStrictSnapshot(root: string): StrictCanonicalGraphSnapshot {
  const snapshot = readCanonicalFileSnapshot(root, GRAPH_FILE, { allowMissing: true });
  const hash = createHash("sha256");
  if (snapshot === undefined) {
    hash.update("missing\0");
  } else {
    hash.update("present\0");
    hash.update(snapshot.content);
  }
  return {
    fingerprint: hash.digest("hex"),
    records: parseCanonicalGraphStrict(snapshot?.content),
  };
}

/** Strict parser shared by safe rebuild and provider-free parity. */
export function parseCanonicalGraphStrict(content: string | undefined): CanonicalGraphRecords {
  if (content === undefined) return emptyCanonicalGraphRecords();
  const entities = new Map<string, EntityRecord>();
  const relations = new Map<string, EntityRelationRecord>();
  const associations = new Map<string, MemoryEntityAssociation>();
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index]?.trim() ?? "";
    if (raw.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw graphValidationError("malformed-json", `memory-rebuild: malformed graph JSON at graph.jsonl:${line}.`, line);
    }
    if (!isRecord(value)) {
      throw graphValidationError("invalid-record", `memory-rebuild: graph record at line ${line} is not an object.`, line);
    }
    if (value.kind === "entity") {
      const entity = strictEntity(value, line);
      // graph.jsonl is an append log: validated later records update earlier
      // names/types/summaries for the same stable entity id.
      entities.set(entity.id, entity);
    } else if (value.kind === "relation") {
      const relation = strictRelation(value, line);
      relations.set(strictRelationKey(relation), relation);
    } else if (value.kind === "association") {
      const association = strictAssociation(value, line);
      associations.set(strictAssociationKey(association), association);
    } else {
      throw graphValidationError("unknown-kind", `memory-rebuild: unknown graph kind at graph.jsonl:${line}.`, line);
    }
  }
  for (const relation of relations.values()) {
    if (!entities.has(relation.src) || !entities.has(relation.dst)) {
      throw graphValidationError(
        "orphan-endpoint",
        `memory-rebuild: graph relation has an orphan endpoint (${relation.src} -> ${relation.dst}).`,
      );
    }
  }
  for (const association of associations.values()) {
    if (!entities.has(association.entityId)) {
      throw graphValidationError(
        "orphan-endpoint",
        `memory-rebuild: graph association has an orphan entity endpoint (${association.memoryId} -> ${association.entityId}).`,
      );
    }
  }
  return {
    entities: [...entities.values()],
    relations: [...relations.values()],
    associations: [...associations.values()],
  };
}

/** Apply the exact deterministic graph projection used by safe BuJo rebuild. */
export function projectCanonicalGraph(
  canonical: CanonicalGraphRecords,
  memoriesInput: readonly GraphProjectionMemory[],
): CanonicalGraphProjection {
  const entities = new Map(canonical.entities.map((entity) => [entity.id, entity]));
  const associations = new Map(
    canonical.associations.map((association) => [strictAssociationKey(association), association]),
  );
  const memories = new Map(
    memoriesInput
      .filter((memory) => !isLegacyHostObservation(memory.text))
      .map((memory) => [memory.id, memory]),
  );
  for (const association of associations.values()) {
    if (!memories.has(association.memoryId) || !entities.has(association.entityId)) {
      throw graphValidationError(
        "orphan-endpoint",
        `memory-rebuild: graph association has an orphan endpoint (${association.memoryId} -> ${association.entityId}).`,
      );
    }
  }

  const collectionSupports: Array<{ memoryId: string; entityId: string; collection: string }> = [];
  for (const memory of memories.values()) {
    if (memory.status !== "migrated") continue;
    const collectionAssociations = [...associations.values()].filter((association) => {
      if (association.memoryId !== memory.id) return false;
      return entities.get(association.entityId)?.type === "collection";
    });
    if (collectionAssociations.length > 1) {
      throw graphValidationError(
        "invalid-projection",
        `memory-rebuild: migrated memory ${memory.id} has ambiguous collection associations.`,
      );
    }
    if (collectionAssociations.length === 0) continue;
    const entityId = collectionAssociations[0]!.entityId;
    const collection = entityId.startsWith("collection:") ? entityId.slice("collection:".length) : "";
    if (collection.length === 0) {
      throw graphValidationError(
        "invalid-projection",
        `memory-rebuild: migrated memory ${memory.id} has an invalid collection entity.`,
      );
    }
    collectionSupports.push({ memoryId: memory.id, entityId, collection });
  }

  let derivedLegacyAssociations = 0;
  const uniqueNames = new Map<string, EntityRecord | undefined>();
  for (const entity of entities.values()) {
    const key = normalizedNameWords(entity.name).join("\0");
    if (key.length === 0) continue;
    uniqueNames.set(key, uniqueNames.has(key) ? undefined : entity);
  }
  const memoriesWithCanonicalAssociations = new Set(
    canonical.associations.map((association) => association.memoryId),
  );
  for (const memory of memories.values()) {
    if (memoriesWithCanonicalAssociations.has(memory.id)) continue;
    const memoryWords = normalizedNameWords(memory.text);
    for (const [key, entity] of uniqueNames) {
      if (entity === undefined) continue;
      const words = key.split("\0");
      if (!containsPhrase(memoryWords, words)) continue;
      const keyForAssociation = strictAssociationKey({ memoryId: memory.id, entityId: entity.id });
      if (associations.has(keyForAssociation)) continue;
      associations.set(keyForAssociation, {
        memoryId: memory.id,
        entityId: entity.id,
        provenance: "legacy-name-match",
        createdAt: memory.createdAt,
      });
      derivedLegacyAssociations += 1;
    }
  }
  return {
    entities: [...canonical.entities],
    relations: [...canonical.relations],
    associations: [...associations.values()],
    collectionSupports,
    derivedLegacyAssociations,
  };
}

export function emptyCanonicalGraphProjection(): CanonicalGraphProjection {
  return {
    entities: [],
    relations: [],
    associations: [],
    collectionSupports: [],
    derivedLegacyAssociations: 0,
  };
}

/** Raw host observations are audit-only and never enter the curated BuJo projection. */
export function isLegacyHostObservation(text: string): boolean {
  return text.startsWith("Host-observed completed turn.")
    || text.startsWith("Host-observed completed trigger turn.");
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

function emptyCanonicalGraphRecords(): CanonicalGraphRecords {
  return { entities: [], relations: [], associations: [] };
}

function strictEntity(value: Record<string, unknown>, line: number): EntityRecord {
  const id = requiredString(value.id, "entity id", line);
  const name = requiredString(value.name, "entity name", line);
  const createdAt = requiredTimestamp(value.createdAt, "entity createdAt", line);
  const type = optionalString(value.type, "entity type", line);
  const summary = optionalString(value.summary, "entity summary", line);
  return {
    id,
    name,
    createdAt,
    ...(type === undefined ? {} : { type }),
    ...(summary === undefined ? {} : { summary }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: requiredTimestamp(value.updatedAt, "entity updatedAt", line) }),
  };
}

function strictRelation(value: Record<string, unknown>, line: number): EntityRelationRecord {
  return {
    src: requiredString(value.src, "relation src", line),
    dst: requiredString(value.dst, "relation dst", line),
    relation: requiredString(value.relation, "relation label", line),
    createdAt: requiredTimestamp(value.createdAt, "relation createdAt", line),
  };
}

function strictAssociation(value: Record<string, unknown>, line: number): MemoryEntityAssociation {
  const provenance = value.provenance;
  if (provenance !== "capture" && provenance !== "legacy-name-match") {
    throw graphValidationError(
      "invalid-record",
      `memory-rebuild: invalid association provenance at graph.jsonl:${line}.`,
      line,
    );
  }
  return {
    memoryId: requiredString(value.memoryId, "association memoryId", line),
    entityId: requiredString(value.entityId, "association entityId", line),
    provenance,
    createdAt: requiredTimestamp(value.createdAt, "association createdAt", line),
  };
}

function requiredString(value: unknown, label: string, line: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw graphValidationError(
      "invalid-record",
      `memory-rebuild: missing ${label} at graph.jsonl:${line}.`,
      line,
    );
  }
  return value;
}

function optionalString(value: unknown, label: string, line: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw graphValidationError(
      "invalid-record",
      `memory-rebuild: invalid ${label} at graph.jsonl:${line}.`,
      line,
    );
  }
  return value;
}

function requiredTimestamp(value: unknown, label: string, line: number): string {
  const timestamp = requiredString(value, label, line);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw graphValidationError(
      "invalid-record",
      `memory-rebuild: invalid ${label} at graph.jsonl:${line}.`,
      line,
    );
  }
  return timestamp;
}

function graphValidationError(
  code: CanonicalGraphIssueCode,
  message: string,
  line?: number,
): CanonicalGraphValidationError {
  return new CanonicalGraphValidationError(code, message, line);
}

function strictRelationKey(record: Pick<EntityRelationRecord, "src" | "dst" | "relation">): string {
  return `${record.src}\0${record.dst}\0${record.relation}`;
}

function strictAssociationKey(record: Pick<MemoryEntityAssociation, "memoryId" | "entityId">): string {
  return `${record.memoryId}\0${record.entityId}`;
}

function normalizedNameWords(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsPhrase(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    if (needle.every((word, index) => haystack[offset + index] === word)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
