import type {
  CanonicalGraphSnapshot,
  EntityRecord,
  EntityRelationRecord,
  MemoryDb,
  MemoryEntityAssociation,
} from "../store/index.js";

import { hasPendingCaptureIntent } from "./capture-outbox.js";
import {
  CanonicalGraphValidationError,
  emptyCanonicalGraphProjection,
  projectCanonicalGraph,
  readCanonicalGraphStrictSnapshot,
  type CanonicalGraphIssueCode,
  type CanonicalGraphProjection,
  type StrictCanonicalGraphSnapshot,
} from "./graph.js";
import { hasPendingMigrateDecision } from "./migrate.js";
import type { BujoTier } from "./types.js";

const MAX_AUDIT_ATTEMPTS = 2;

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

export type CanonicalGraphParityStatus = "match" | "mismatch" | "in_progress" | "invalid";

export type CanonicalGraphParityIssueCode = CanonicalGraphIssueCode
  | "canonical-read-failed"
  | "durable-state-invalid"
  | "active-index-invalid"
  | "tier-conflict";

export interface CanonicalGraphParityIssue {
  readonly code: CanonicalGraphParityIssueCode;
  readonly line?: number;
}

export interface CanonicalGraphMutationState {
  readonly capturePending: boolean;
  readonly migrationPending: boolean;
  readonly sourceChanged: boolean;
}

export interface CanonicalGraphParityOptions {
  /** Explicit tier for an unmanaged index; managed metadata must agree when both are present. */
  readonly tier?: BujoTier;
}

/** Exact tier-aware canonical graph projection versus active SQLite parity. */
export interface CanonicalGraphParityResult {
  readonly status: CanonicalGraphParityStatus;
  readonly tier: BujoTier;
  readonly matches: boolean;
  readonly issues: readonly CanonicalGraphParityIssue[];
  readonly mutation: CanonicalGraphMutationState;
  readonly entities: CanonicalGraphParitySection;
  readonly relations: CanonicalGraphParitySection;
  readonly associations: CanonicalGraphParitySection;
}

/**
 * Compare the active tier's canonical graph projection with an already-open index.
 *
 * The audit is provider-free and content-free. It fails closed on invalid
 * canonical graph records, distinguishes admitted durable mutation from stable
 * divergence, and retries one torn source/index observation before reporting.
 */
export function auditCanonicalGraphParity(
  root: string,
  db: MemoryDb,
  options: CanonicalGraphParityOptions = {},
): CanonicalGraphParityResult {
  const resolvedTier = resolveTier(db, options);
  if (resolvedTier.issue !== undefined) {
    return invalidResult(resolvedTier.tier, resolvedTier.issue);
  }
  const tier = resolvedTier.tier;

  for (let attempt = 1; attempt <= MAX_AUDIT_ATTEMPTS; attempt += 1) {
    const mutationBefore = inspectMutation(root);
    if (mutationBefore.issue !== undefined) return invalidResult(tier, mutationBefore.issue);
    if (mutationInProgress(mutationBefore.state)) return inProgressResult(tier, mutationBefore.state);

    let canonicalBefore: StrictCanonicalGraphSnapshot;
    try {
      canonicalBefore = canonicalSnapshotForTier(root, tier);
    } catch (error) {
      const transient = inspectMutation(root);
      if (transient.issue !== undefined) return invalidResult(tier, transient.issue);
      if (mutationInProgress(transient.state)) return inProgressResult(tier, transient.state);
      if (attempt < MAX_AUDIT_ATTEMPTS) continue;
      return invalidResult(tier, issueFromCanonicalError(error));
    }

    let active: CanonicalGraphSnapshot;
    try {
      active = db.canonicalGraphSnapshot();
    } catch {
      return invalidResult(tier, { code: "active-index-invalid" });
    }

    let canonicalAfter: StrictCanonicalGraphSnapshot;
    try {
      canonicalAfter = canonicalSnapshotForTier(root, tier);
    } catch (error) {
      const transient = inspectMutation(root);
      if (transient.issue !== undefined) return invalidResult(tier, transient.issue);
      if (mutationInProgress(transient.state)) return inProgressResult(tier, transient.state);
      if (attempt < MAX_AUDIT_ATTEMPTS) continue;
      return invalidResult(tier, issueFromCanonicalError(error));
    }

    const mutationAfter = inspectMutation(root);
    if (mutationAfter.issue !== undefined) return invalidResult(tier, mutationAfter.issue);
    if (mutationInProgress(mutationAfter.state)) return inProgressResult(tier, mutationAfter.state);
    if (canonicalBefore.fingerprint !== canonicalAfter.fingerprint) {
      if (attempt < MAX_AUDIT_ATTEMPTS) continue;
      return inProgressResult(tier, { ...mutationAfter.state, sourceChanged: true });
    }

    let expected: CanonicalGraphProjection;
    try {
      expected = tier === "bujo"
        ? projectCanonicalGraph(canonicalAfter.records, active.memories)
        : emptyCanonicalGraphProjection();
    } catch (error) {
      if (attempt < MAX_AUDIT_ATTEMPTS) continue;
      return invalidResult(tier, issueFromCanonicalError(error));
    }

    const entities = compareEntities(expected.entities, active.entities);
    const relations = compareRelations(expected.relations, active.relations);
    const associations = compareAssociations(expected.associations, active.associations);
    const matches = sectionMatches(entities) && sectionMatches(relations) && sectionMatches(associations);
    if (!matches && attempt < MAX_AUDIT_ATTEMPTS) continue;
    return {
      status: matches ? "match" : "mismatch",
      tier,
      matches,
      issues: [],
      mutation: noMutation(),
      entities,
      relations,
      associations,
    };
  }

  return inProgressResult(tier, { ...noMutation(), sourceChanged: true });
}

interface MutationInspection {
  readonly state: CanonicalGraphMutationState;
  readonly issue?: CanonicalGraphParityIssue;
}

function inspectMutation(root: string): MutationInspection {
  try {
    return {
      state: {
        capturePending: hasPendingCaptureIntent(root),
        migrationPending: hasPendingMigrateDecision(root),
        sourceChanged: false,
      },
    };
  } catch {
    return { state: noMutation(), issue: { code: "durable-state-invalid" } };
  }
}

function canonicalSnapshotForTier(root: string, tier: BujoTier): StrictCanonicalGraphSnapshot {
  if (tier === "bujo") return readCanonicalGraphStrictSnapshot(root);
  return { fingerprint: `ignored:${tier}`, records: emptyCanonicalGraphProjection() };
}

function resolveTier(
  db: MemoryDb,
  options: CanonicalGraphParityOptions,
): { readonly tier: BujoTier; readonly issue?: CanonicalGraphParityIssue } {
  let managedTier: BujoTier | undefined;
  try {
    managedTier = db.indexMetadata()?.tier;
  } catch {
    return { tier: options.tier ?? "bujo", issue: { code: "active-index-invalid" } };
  }
  if (managedTier !== undefined && options.tier !== undefined && managedTier !== options.tier) {
    return { tier: managedTier, issue: { code: "tier-conflict" } };
  }
  return { tier: managedTier ?? options.tier ?? "bujo" };
}

function invalidResult(tier: BujoTier, issue: CanonicalGraphParityIssue): CanonicalGraphParityResult {
  return {
    status: "invalid",
    tier,
    matches: false,
    issues: [issue],
    mutation: noMutation(),
    entities: emptySection(),
    relations: emptySection(),
    associations: emptySection(),
  };
}

function inProgressResult(tier: BujoTier, mutation: CanonicalGraphMutationState): CanonicalGraphParityResult {
  return {
    status: "in_progress",
    tier,
    matches: false,
    issues: [],
    mutation,
    entities: emptySection(),
    relations: emptySection(),
    associations: emptySection(),
  };
}

function issueFromCanonicalError(error: unknown): CanonicalGraphParityIssue {
  if (error instanceof CanonicalGraphValidationError) {
    return {
      code: error.code,
      ...(error.line === undefined ? {} : { line: error.line }),
    };
  }
  return { code: "canonical-read-failed" };
}

function mutationInProgress(state: CanonicalGraphMutationState): boolean {
  return state.capturePending || state.migrationPending || state.sourceChanged;
}

function noMutation(): CanonicalGraphMutationState {
  return { capturePending: false, migrationPending: false, sourceChanged: false };
}

function emptySection(): CanonicalGraphParitySection {
  return {
    canonical: 0,
    active: 0,
    matched: 0,
    missing: 0,
    extra: 0,
    mismatched: 0,
    payloadMismatches: 0,
    timestampMismatches: 0,
    provenanceMismatches: 0,
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
