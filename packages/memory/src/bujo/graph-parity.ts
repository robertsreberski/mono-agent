import type {
  EntityRecord,
  EntityRelationRecord,
  MemoryDb,
  MemoryEntityAssociation,
} from "../store/index.js";

import { readGraph } from "./graph.js";

/** Aggregate-only parity counters. No memory or entity content is returned. */
export interface CanonicalGraphParitySection {
  readonly canonical: number;
  readonly active: number;
  readonly matched: number;
  readonly missing: number;
  readonly extra: number;
  readonly mismatched: number;
  readonly payloadMismatches: number;
  readonly timestampMismatches: number;
  readonly provenanceMismatches: number;
}

/** Exact canonical graph.jsonl versus active SQLite projection parity. */
export interface CanonicalGraphParityResult {
  readonly matches: boolean;
  readonly entities: CanonicalGraphParitySection;
  readonly relations: CanonicalGraphParitySection;
  readonly associations: CanonicalGraphParitySection;
}

/**
 * Compare canonical graph.jsonl with an already-open active index.
 *
 * This is provider-free and content-free: it performs local reads only and
 * returns aggregate mismatch counts suitable for health/CLI surfaces.
 */
export function auditCanonicalGraphParity(root: string, db: MemoryDb): CanonicalGraphParityResult {
  const canonical = readGraph(root);
  const active = db.canonicalGraphSnapshot();
  const entities = compareEntities(canonical.entities, active.entities);
  const relations = compareRelations(canonical.relations, active.relations);
  const associations = compareAssociations(canonical.associations, active.associations);
  return {
    matches: sectionMatches(entities) && sectionMatches(relations) && sectionMatches(associations),
    entities,
    relations,
    associations,
  };
}

function compareEntities(
  canonical: readonly EntityRecord[],
  active: readonly EntityRecord[],
): CanonicalGraphParitySection {
  return compareByKey(canonical, active, (record) => record.id, (left, right) => ({
    payload: left.name !== right.name || left.type !== right.type || left.summary !== right.summary,
    timestamp: left.createdAt !== right.createdAt || left.updatedAt !== right.updatedAt,
    provenance: false,
  }));
}

function compareRelations(
  canonical: readonly EntityRelationRecord[],
  active: readonly EntityRelationRecord[],
): CanonicalGraphParitySection {
  return compareByKey(canonical, active, relationKey, (left, right) => ({
    payload: left.src !== right.src || left.dst !== right.dst || left.relation !== right.relation,
    timestamp: left.createdAt !== right.createdAt,
    provenance: false,
  }));
}

function compareAssociations(
  canonical: readonly MemoryEntityAssociation[],
  active: readonly MemoryEntityAssociation[],
): CanonicalGraphParitySection {
  return compareByKey(canonical, active, associationKey, (left, right) => ({
    payload: left.memoryId !== right.memoryId || left.entityId !== right.entityId,
    timestamp: left.createdAt !== right.createdAt,
    provenance: left.provenance !== right.provenance,
  }));
}

interface RecordMismatch {
  readonly payload: boolean;
  readonly timestamp: boolean;
  readonly provenance: boolean;
}

function compareByKey<T>(
  canonicalRecords: readonly T[],
  activeRecords: readonly T[],
  keyOf: (record: T) => string,
  mismatchOf: (canonical: T, active: T) => RecordMismatch,
): CanonicalGraphParitySection {
  const canonical = new Map(canonicalRecords.map((record) => [keyOf(record), record]));
  const active = new Map(activeRecords.map((record) => [keyOf(record), record]));
  let matched = 0;
  let missing = 0;
  let mismatched = 0;
  let payloadMismatches = 0;
  let timestampMismatches = 0;
  let provenanceMismatches = 0;
  for (const [key, expected] of canonical) {
    const actual = active.get(key);
    if (actual === undefined) {
      missing += 1;
      continue;
    }
    const mismatch = mismatchOf(expected, actual);
    if (!mismatch.payload && !mismatch.timestamp && !mismatch.provenance) {
      matched += 1;
      continue;
    }
    mismatched += 1;
    if (mismatch.payload) payloadMismatches += 1;
    if (mismatch.timestamp) timestampMismatches += 1;
    if (mismatch.provenance) provenanceMismatches += 1;
  }
  let extra = 0;
  for (const key of active.keys()) {
    if (!canonical.has(key)) extra += 1;
  }
  return {
    canonical: canonical.size,
    active: active.size,
    matched,
    missing,
    extra,
    mismatched,
    payloadMismatches,
    timestampMismatches,
    provenanceMismatches,
  };
}

function sectionMatches(section: CanonicalGraphParitySection): boolean {
  return section.missing === 0 && section.extra === 0 && section.mismatched === 0;
}

function relationKey(record: EntityRelationRecord): string {
  return `${record.src}\0${record.dst}\0${record.relation}`;
}

function associationKey(record: MemoryEntityAssociation): string {
  return `${record.memoryId}\0${record.entityId}`;
}
