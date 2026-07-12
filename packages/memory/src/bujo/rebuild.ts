import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";

import { DEFAULT_VEC_DIM, openMemoryDb } from "../store/index.js";
import type {
  MemoryDb,
  MemoryRecord,
} from "../store/index.js";
import type { EmbeddingProvider } from "../search/index.js";

import { normalizedContentHash } from "./daily.js";
import { parseDailyFile } from "./grammar.js";
import {
  emptyCanonicalGraphProjection,
  isLegacyHostObservation,
  parseCanonicalGraphStrict,
  projectCanonicalGraph,
  readGraph,
  type CanonicalGraphProjection,
} from "./graph.js";
import {
  assertNoPendingCaptureIntent,
  hasPendingCaptureIntent,
  replayCaptureOutbox,
} from "./capture-outbox.js";
import { assertNoPendingMigrateDecision } from "./migrate.js";
import {
  listCanonicalFileNames,
  listCanonicalRootFileNames,
  readCanonicalFileSnapshot,
} from "./path-safety.js";
import type { BujoTier, Bullet } from "./types.js";
import {
  MANAGED_INDEX_SCHEMA_VERSION,
  MEMORY_REBUILD_POLICY_VERSION,
  acquireMemoryWriterLease,
  activateManagedIndex,
  assertManagedLayoutState,
  assertManagedManifestState,
  assertSafeRegularFile,
  captureManagedLayoutState,
  captureManagedManifestState,
  createManagedGeneration,
  fsyncDirectory,
  managedGenerationDbPath,
  readManagedIndexManifest,
  type ManagedGeneration,
  type ManagedIndexManifest,
} from "./generations.js";

/**
 * Rebuild the SQLite index from canonical markdown. No LLM — re-embeds via the db's provider.
 *
 * After indexing memory bullets, reads `graph.jsonl` and mirrors entities/relations into the db.
 * Note: memory↔entity `about` edges are NOT stored in markdown/graph.jsonl (P2 known lossiness)
 * and are intentionally NOT rebuilt here. This is documented and deferred to P3+.
 */
export async function rebuildFromMarkdown(root: string, db: MemoryDb): Promise<{ indexed: number }> {
  const files = listCanonicalFileNames(root, "daily", {
    allowMissing: true,
    include: (name) => name.endsWith(".md"),
  });
  const records: MemoryRecord[] = [];
  for (const file of files) {
    const snapshot = readCanonicalFileSnapshot(root, `daily/${file}`);
    if (snapshot === undefined) throw new Error(`memory-rebuild: canonical source daily/${file} disappeared.`);
    const parsed = parseDailyFile(snapshot.content);
    // Use the real 1-based file line number (not the bullet ordinal) so source.line points at the
    // actual markdown line for provenance / jump-to-source.
    parsed.lines.forEach((line) => {
      if (line.bullet !== undefined) {
        records.push(toRecord(line.bullet, `daily/${file}`, line.lineNumber));
      }
    });
  }
  const result = await db.rebuild(records);

  // Ingest entity graph — db.rebuild already wiped the entity tables, so start fresh.
  // No LLM: graph.jsonl is the canonical source written by captureTurn.
  const g = readGraph(root);
  for (const entity of g.entities) {
    try {
      db.mirrorCanonicalEntity(entity);
    } catch {
      // Per-item isolation: a single corrupt entity must not abort the rebuild
    }
  }
  for (const relation of g.relations) {
    try {
      db.mirrorCanonicalRelation(relation);
    } catch {
      // Per-item isolation
    }
  }
  for (const association of g.associations) {
    try {
      db.mirrorCanonicalAssociation(association);
    } catch {
      // Candidate validation reports orphan endpoints; a malformed canonical
      // association does not prevent preservation of the remaining source.
    }
  }

  return result;
}

function toRecord(bullet: Bullet, file: string, line: number): MemoryRecord {
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    ...(bullet.dueAt !== undefined ? { dueAt: bullet.dueAt } : {}),
    tags: [],
    source: { file, line },
  };
}

export interface SafeMemoryRebuildHooks {
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterCandidateBuilt?: () => void | Promise<void>;
  readonly afterCandidateClosed?: () => void | Promise<void>;
  readonly afterCandidateValidated?: () => void | Promise<void>;
  readonly beforeSourceCas?: () => void | Promise<void>;
  readonly afterManifestTempFsync?: () => void | Promise<void>;
  readonly afterManifestRename?: () => void | Promise<void>;
  readonly afterManifestDirFsync?: () => void | Promise<void>;
}

export interface SafeMemoryIndexOptions {
  readonly root: string;
  readonly tier: BujoTier;
  readonly embeddings?: EmbeddingProvider;
  readonly dim?: number;
  readonly hooks?: SafeMemoryRebuildHooks;
}

export interface SafeMemoryIndexResult {
  readonly active: string;
  readonly rollback?: string;
  readonly indexed: number;
  readonly sourceFingerprint: string;
  readonly generation: string;
  readonly skippedRawRecords: number;
  readonly skippedUnstructuredRecords: number;
  readonly skippedMissingIdentityRecords: number;
  readonly missingIdentityLocations: readonly string[];
  readonly skippedLegacySourceRecords: number;
  readonly legacySourceLocations: readonly string[];
  readonly skippedJournalDuplicateRecords: number;
  readonly parsedSourceItems: number;
  readonly derivedLegacyAssociations: number;
}

interface SourceFileSnapshot {
  readonly relativePath: string;
  readonly bytes: Buffer;
}

interface SourceSnapshot {
  readonly fingerprint: string;
  readonly daily: readonly SourceFileSnapshot[];
  readonly graph?: SourceFileSnapshot;
}

interface BuildPlan {
  readonly records: readonly MemoryRecord[];
  readonly contentHashes: ReadonlyMap<string, string>;
  readonly graph: CanonicalGraphProjection;
  readonly skippedRawRecords: number;
  readonly skippedUnstructuredRecords: number;
  readonly skippedMissingIdentityRecords: number;
  readonly missingIdentityLocations: readonly string[];
  readonly skippedLegacySourceRecords: number;
  readonly legacySourceLocations: readonly string[];
  readonly skippedJournalDuplicateRecords: number;
  readonly parsedSourceItems: number;
}

/**
 * Build and validate a new generation beside the active index, then atomically switch one manifest.
 * This path never accepts an LLM and never reads BuJo audit files.
 */
export async function safeRebuildMemoryIndex(options: SafeMemoryIndexOptions): Promise<SafeMemoryIndexResult> {
  assertSafeRebuildOptions(options);
  const lease = acquireMemoryWriterLease(options.root);
  let sourceFence: SqliteWriterFence | undefined;
  let candidateName: string | undefined;
  let activated = false;
  try {
    const root = lease.root;
    const rootIdentity = identityOf(root);
    const layoutState = captureManagedLayoutState(root);
    const manifestState = captureManagedManifestState(root);
    const priorManifest = readManagedIndexManifest(root);
    assertManagedManifestState(root, manifestState);
    const priorActivePath = activeDbPathFromManifest(root, priorManifest);
    const hasPriorActiveDb = existsSync(priorActivePath);
    assertNoActiveSqliteWriter(priorActivePath);
    // A paid migration decision is a separate transaction whose vector and
    // source outcome must be recovered by migrate() under the current identity.
    // Refuse before capture replay can touch canonical Markdown or graph data.
    assertNoPendingMigrateDecision(root);
    let stagedCaptureForCandidate = false;
    if (hasPendingCaptureIntent(root)) {
      assertManagedManifestState(root, manifestState);
      if (hasPriorActiveDb) {
        // A current index gives the durable action its original provider and
        // lifecycle identity. Validate it before any source write, finish the
        // transaction there, and retire it before the rebuild snapshot.
        validateCurrentReplayDb(priorActivePath, priorManifest?.active);
        const priorReplay = openCurrentReplayDb(priorActivePath, priorManifest);
        try {
          replayCaptureOutbox(root, priorReplay);
          priorReplay.checkpoint();
        } finally {
          priorReplay.close();
        }
        fsyncFile(priorActivePath);
      } else {
        if (options.tier !== "bujo") {
          throw new Error(
            `memory-rebuild: pending capture without an active index can only recover into BuJo, not ${options.tier}.`,
          );
        }
        // With no index, stage only rebuildable BuJo source. The candidate
        // completes and retires the intent before manifest activation.
        replayCaptureOutbox(root, undefined, { retainIntent: true });
        stagedCaptureForCandidate = true;
      }
      assertManagedManifestState(root, manifestState);
    }
    // Pin and fence the complete prior SQLite state before any model/provider
    // or test-hook await. The configured process is stopped, so any competing
    // SQLite writer is a violation rather than useful concurrency.
    sourceFence = hasPriorActiveDb ? acquireSqliteWriterFences([priorActivePath]) : undefined;
    // Pin the complete prior SQLite state before any model/provider or test
    // hook await. A later rollback snapshot may trust vectors that cannot be
    // regenerated without a paid call, so concurrent mutation must be caught.
    const priorActiveIntegrity = hasPriorActiveDb
      ? logicalIntegrityDigest(priorActivePath, priorManifest?.active)
      : "";
    const snapshot = snapshotCanonicalSources(root, options.tier);
    const rollbackSnapshot = priorManifest === undefined || priorManifest.active.tier === options.tier
      ? snapshot
      : snapshotCanonicalSources(root, priorManifest.active.tier);
    await options.hooks?.afterSnapshot?.();
    const plan = buildPlan(snapshot, options.tier);
    const generation = createManagedGeneration(root);
    candidateName = generation.name;
    const generationIdentity = identityOf(generation.dir);
    const createdAt = new Date().toISOString();
    const descriptor: ManagedGeneration = {
      name: generation.name,
      tier: options.tier,
      sourceFingerprint: snapshot.fingerprint,
      policyVersion: MEMORY_REBUILD_POLICY_VERSION,
      createdAt,
      origin: "rebuild",
      skippedRawRecords: plan.skippedRawRecords,
      skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
      skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
      missingIdentityLocations: plan.missingIdentityLocations,
      skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
      legacySourceLocations: plan.legacySourceLocations,
      skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
      parsedSourceItems: plan.parsedSourceItems,
      derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
      ...(options.embeddings === undefined ? {} : { embeddingModel: options.embeddings.id }),
      ...(options.dim === undefined ? {} : { dimension: options.dim }),
    };

    let openCandidateIdentity!: { readonly dev: number; readonly ino: number; readonly size: number };
    const assertOpenCandidateLocation = (): void => {
      assertManagedLayoutState(root, layoutState);
      assertSameIdentity(generation.dir, generationIdentity, "candidate generation");
      assertSameIdentity(generation.dbPath, openCandidateIdentity, "candidate database");
    };
    const guardedEmbeddings = options.embeddings === undefined ? undefined : {
      id: options.embeddings.id,
      embed: async (texts: readonly string[]): Promise<number[][]> => {
        assertOpenCandidateLocation();
        const vectors = await options.embeddings!.embed(texts);
        // The provider is the only awaited seam between preparing user text
        // and persisting it. Re-pin before returning vectors to MemoryDb.
        assertOpenCandidateLocation();
        return vectors;
      },
    };
    const db = openMemoryDb({
      path: generation.dbPath,
      ...(guardedEmbeddings === undefined ? {} : { embeddings: guardedEmbeddings }),
      ...(options.dim === undefined ? {} : { dim: options.dim }),
    });
    openCandidateIdentity = identityOf(generation.dbPath);
    let stagedReplayIntegrity: string | undefined;
    try {
      await db.rebuild(plan.records);
      for (const [contentHash, memoryId] of plan.contentHashes) {
        const record = db.get(memoryId);
        if (record?.source.file === undefined) throw new Error("memory-rebuild: Journal record lost source provenance.");
        db.recordContentHash({
          contentHash,
          memoryId,
          sourceFile: record.source.file,
          createdAt: record.createdAt,
        });
      }
      for (const entity of plan.graph.entities) db.mirrorCanonicalEntity(entity);
      for (const relation of plan.graph.relations) db.mirrorCanonicalRelation(relation);
      for (const association of plan.graph.associations) db.mirrorCanonicalAssociation(association);
      for (const support of plan.graph.collectionSupports) {
        db.addEdge(support.memoryId, support.entityId, "supports");
      }
      db.setIndexMetadata({
        schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
        policyVersion: MEMORY_REBUILD_POLICY_VERSION,
        tier: options.tier,
        sourceFingerprint: snapshot.fingerprint,
        generation: generation.name,
        createdAt,
        skippedRawRecords: plan.skippedRawRecords,
        skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
        skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
        missingIdentityLocations: plan.missingIdentityLocations,
        skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
        legacySourceLocations: plan.legacySourceLocations,
        skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
        parsedSourceItems: plan.parsedSourceItems,
        derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
        ...(options.embeddings === undefined ? {} : { embeddingModel: options.embeddings.id }),
        ...(options.dim === undefined ? {} : { dimension: options.dim }),
      });
      if (stagedCaptureForCandidate) {
        replayCaptureOutbox(root, db);
        // The durable intent is the exact authority for the lifecycle/thread
        // state that canonical Markdown cannot reconstruct. Pin that known-good
        // replay result before exposing any hook or other asynchronous seam.
        stagedReplayIntegrity = db.logicalIntegrityDigest();
      }
      await options.hooks?.afterCandidateBuilt?.();
      db.checkpoint();
    } finally {
      db.close();
    }
    await options.hooks?.afterCandidateClosed?.();
    if (stagedReplayIntegrity !== undefined
      && logicalIntegrityDigest(generation.dbPath, descriptor) !== stagedReplayIntegrity) {
      throw new Error("memory-rebuild: staged capture candidate changed after exact durable replay.");
    }
    fsyncFile(generation.dbPath);
    fsyncDirectory(generation.dir);
    validateCandidate(generation.dbPath, descriptor, plan, stagedCaptureForCandidate);
    const candidateDbIdentity = identityOf(generation.dbPath);
    const candidateDigest = fileDigest(generation.dbPath);
    const candidateLogicalDigest = logicalIntegrityDigest(generation.dbPath, descriptor);
    await options.hooks?.afterCandidateValidated?.();
    await options.hooks?.beforeSourceCas?.();
    let rollback = await snapshotCurrentRollback(
      root,
      priorManifest?.active,
      rollbackSnapshot,
      priorActiveIntegrity,
    );
    const tentativeRollbackPath = rollback === undefined ? undefined : managedGenerationDbPath(root, rollback.name, true);
    if (tentativeRollbackPath !== undefined && rollback !== undefined) {
      validateRollbackSnapshot(tentativeRollbackPath, rollback, buildPlan(rollbackSnapshot, rollback.tier));
      if (!retainedVectorsMatchCandidate(generation.dbPath, descriptor, tentativeRollbackPath, rollback)) {
        rollback = undefined;
      }
    }
    const rollbackPath = rollback === undefined ? undefined : managedGenerationDbPath(root, rollback.name, true);
    const rollbackIdentity = rollbackPath === undefined ? undefined : identityOf(rollbackPath);
    const rollbackDigest = rollbackPath === undefined ? undefined : fileDigest(rollbackPath);
    // This is the final source/root/candidate CAS. All potentially long awaited
    // candidate and rollback work has completed; activation performs only the
    // same-directory manifest transaction after this point.
    const assertFinalCas = (): void => {
      const finalSnapshot = snapshotCanonicalSources(root, options.tier);
      if (finalSnapshot.fingerprint !== snapshot.fingerprint) {
        throw new Error("memory-rebuild: canonical source fingerprint changed concurrently; active index was not switched.");
      }
      if (rollback !== undefined
        && snapshotCanonicalSources(root, rollback.tier).fingerprint !== rollback.sourceFingerprint) {
        throw new Error("memory-rebuild: rollback source domain changed concurrently; active index was not switched.");
      }
      assertSameIdentity(root, rootIdentity, "memory root");
      assertManagedLayoutState(root, layoutState);
      assertSameIdentity(generation.dir, generationIdentity, "candidate generation");
      assertSameIdentity(generation.dbPath, candidateDbIdentity, "candidate database");
      if (fileDigest(generation.dbPath) !== candidateDigest) {
        throw new Error("memory-rebuild: candidate database changed after validation.");
      }
      if (logicalIntegrityDigest(generation.dbPath, descriptor) !== candidateLogicalDigest) {
        throw new Error("memory-rebuild: candidate logical state changed after validation.");
      }
      validateCandidate(generation.dbPath, descriptor, plan, stagedCaptureForCandidate);
      if (rollbackPath !== undefined && rollbackIdentity !== undefined && rollbackDigest !== undefined && rollback !== undefined) {
        assertSameIdentity(rollbackPath, rollbackIdentity, "retained rollback database");
        if (fileDigest(rollbackPath) !== rollbackDigest) {
          throw new Error("memory-rebuild: retained rollback database changed after validation.");
        }
        validateRollbackSnapshot(rollbackPath, rollback, buildPlan(rollbackSnapshot, rollback.tier));
      }
      assertManagedManifestState(root, manifestState);
    };
    const nextManifest: ManagedIndexManifest = {
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      active: descriptor,
      ...(rollback === undefined ? {} : { rollback }),
    };
    const activationFence = acquireSqliteWriterFences([
      generation.dbPath,
      ...(rollbackPath === undefined ? [] : [rollbackPath]),
    ]);
    try {
      assertFinalCas();
      await activateManagedIndex(root, nextManifest, {
        ...options.hooks,
        beforeManifestRename: assertFinalCas,
      });
      activated = true;
      return {
        active: generation.dbPath,
        ...(rollback === undefined ? {} : { rollback: managedGenerationDbPath(root, rollback.name, true) }),
        indexed: plan.records.length,
        sourceFingerprint: snapshot.fingerprint,
        generation: generation.name,
        skippedRawRecords: plan.skippedRawRecords,
        skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
        skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
        missingIdentityLocations: plan.missingIdentityLocations,
        skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
        legacySourceLocations: plan.legacySourceLocations,
        skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
        parsedSourceItems: plan.parsedSourceItems,
        derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
      };
    } finally {
      activationFence.release();
    }
  } catch (error) {
    // A generation referenced by a renamed manifest must never be deleted. Other
    // candidates are intentionally retained as orphans for explicit inspection;
    // the resolver never auto-adopts them.
    if (activated && candidateName === undefined) throw new Error("memory-rebuild: activated generation identity was lost.");
    throw error;
  } finally {
    try {
      sourceFence?.release();
    } finally {
      lease.release();
    }
  }
}

/** Atomically swap active/rollback after validating the retained target. No provider call is made. */
export async function rollbackMemoryIndex(options: SafeMemoryIndexOptions): Promise<SafeMemoryIndexResult> {
  assertSafeRebuildOptions(options);
  const lease = acquireMemoryWriterLease(options.root);
  let sourceFence: SqliteWriterFence | undefined;
  try {
    const root = lease.root;
    assertNoPendingMigrateDecision(root);
    assertNoPendingCaptureIntent(root);
    const rootIdentity = identityOf(root);
    const layoutState = captureManagedLayoutState(root);
    const manifestState = captureManagedManifestState(root);
    const manifest = readManagedIndexManifest(root);
    if (manifest?.rollback === undefined) throw new Error("memory-rebuild: no retained rollback generation is available.");
    assertNoActiveSqliteWriter(managedGenerationDbPath(root, manifest.active.name, true));
    const target = manifest.rollback;
    assertConfiguredIdentity(target, options);
    const snapshot = snapshotCanonicalSources(root, target.tier);
    if (snapshot.fingerprint !== target.sourceFingerprint) {
      throw new Error("memory-rebuild: canonical source changed after the retained generation; stale rollback refused.");
    }
    const targetPath = managedGenerationDbPath(root, target.name, true);
    const targetPlan = buildPlan(snapshot, target.tier);
    validateRollbackSnapshot(targetPath, target, targetPlan);
    const targetIdentity = identityOf(targetPath);
    const targetDigest = fileDigest(targetPath);
    const currentPath = managedGenerationDbPath(root, manifest.active.name, true);
    sourceFence = acquireSqliteWriterFences([currentPath]);
    const currentIdentity = identityOf(currentPath);
    const currentDigest = fileDigest(currentPath);
    let currentIntegrity: string | undefined;
    try {
      currentIntegrity = logicalIntegrityDigest(currentPath, manifest.active);
    } catch {
      // A damaged current active must not prevent rescue to a verified target.
      // It simply cannot be advertised as the next one-command rollback.
    }
    const outgoingSnapshot = snapshotCanonicalSources(root, manifest.active.tier);
    let outgoing: ManagedGeneration | undefined;
    if (currentIntegrity !== undefined) {
      try {
        outgoing = await snapshotCurrentRollback(
          root,
          manifest.active,
          outgoingSnapshot,
          currentIntegrity,
        );
      } catch (error) {
        // Semantic/coverage divergence omits the outgoing snapshot. A concurrent
        // mutation is different: preserve the original failure and do not swap.
        assertSameIdentity(currentPath, currentIdentity, "current active database");
        if (fileDigest(currentPath) !== currentDigest
          || logicalIntegrityDigest(currentPath, manifest.active) !== currentIntegrity) {
          throw error;
        }
        outgoing = undefined;
      }
    }
    const outgoingPath = outgoing === undefined ? undefined : managedGenerationDbPath(root, outgoing.name, true);
    const outgoingIdentity = outgoingPath === undefined ? undefined : identityOf(outgoingPath);
    const outgoingDigest = outgoingPath === undefined ? undefined : fileDigest(outgoingPath);
    const outgoingPlan = outgoing === undefined ? undefined : buildPlan(outgoingSnapshot, outgoing.tier);
    if (outgoingPath !== undefined && outgoing !== undefined && outgoingPlan !== undefined) {
      validateRollbackSnapshot(outgoingPath, outgoing, outgoingPlan);
    }
    const next: ManagedIndexManifest = {
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      active: target,
      ...(outgoing === undefined ? {} : { rollback: outgoing }),
    };
    const assertFinalRollbackCas = (): void => {
      assertSameIdentity(root, rootIdentity, "memory root");
      assertManagedLayoutState(root, layoutState);
      assertSameIdentity(targetPath, targetIdentity, "rollback target database");
      assertSameIdentity(currentPath, currentIdentity, "current active database");
      if (fileDigest(targetPath) !== targetDigest || fileDigest(currentPath) !== currentDigest) {
        throw new Error("memory-rebuild: active or rollback database changed after validation.");
      }
      if (currentIntegrity !== undefined
        && logicalIntegrityDigest(currentPath, manifest.active) !== currentIntegrity) {
        throw new Error("memory-rebuild: current active logical state changed during rollback.");
      }
      if (snapshotCanonicalSources(root, target.tier).fingerprint !== target.sourceFingerprint) {
        throw new Error("memory-rebuild: canonical source changed before rollback activation.");
      }
      validateRollbackSnapshot(targetPath, target, targetPlan);
      if (outgoingPath !== undefined && outgoingIdentity !== undefined && outgoingDigest !== undefined
        && outgoing !== undefined && outgoingPlan !== undefined) {
        assertSameIdentity(outgoingPath, outgoingIdentity, "outgoing rollback database");
        if (fileDigest(outgoingPath) !== outgoingDigest) {
          throw new Error("memory-rebuild: outgoing rollback database changed after validation.");
        }
        if (snapshotCanonicalSources(root, outgoing.tier).fingerprint !== outgoing.sourceFingerprint) {
          throw new Error("memory-rebuild: outgoing rollback source changed before activation.");
        }
        validateRollbackSnapshot(outgoingPath, outgoing, outgoingPlan);
      }
      assertManagedManifestState(root, manifestState);
    };
    const activationFence = acquireSqliteWriterFences([
      targetPath,
      ...(outgoingPath === undefined ? [] : [outgoingPath]),
    ]);
    try {
      assertFinalRollbackCas();
      await activateManagedIndex(root, next, {
        ...options.hooks,
        beforeManifestRename: assertFinalRollbackCas,
      });
      const inspected = readOnlyDb(targetPath, target);
      let indexed: number;
      try {
        indexed = inspected.validationSnapshot().memories;
      } finally {
        inspected.close();
      }
      return {
        active: targetPath,
        ...(outgoingPath === undefined ? {} : { rollback: outgoingPath }),
        indexed,
        sourceFingerprint: target.sourceFingerprint,
        generation: target.name,
        skippedRawRecords: target.skippedRawRecords ?? 0,
        skippedUnstructuredRecords: target.skippedUnstructuredRecords ?? 0,
        skippedMissingIdentityRecords: target.skippedMissingIdentityRecords ?? 0,
        missingIdentityLocations: target.missingIdentityLocations ?? [],
        skippedLegacySourceRecords: target.skippedLegacySourceRecords ?? 0,
        legacySourceLocations: target.legacySourceLocations ?? [],
        skippedJournalDuplicateRecords: target.skippedJournalDuplicateRecords ?? 0,
        parsedSourceItems: target.parsedSourceItems ?? indexed,
        derivedLegacyAssociations: target.derivedLegacyAssociations ?? 0,
      };
    } finally {
      activationFence.release();
    }
  } finally {
    try {
      sourceFence?.release();
    } finally {
      lease.release();
    }
  }
}

function snapshotCanonicalSources(root: string, tier: BujoTier): SourceSnapshot {
  const files: SourceFileSnapshot[] = [];
  const dailyNames = new Set(listCanonicalFileNames(root, "daily", {
    allowMissing: true,
    include: (name) => name.endsWith(".md"),
  }));
  // Older stores placed dated logs at the root. A canonical daily/<date>.md
  // wins when both layouts contain the same date, matching operator preview.
  for (const name of listCanonicalRootFileNames(root, { include: (file) => LEGACY_DAILY_FILE.test(file) })) {
    if (dailyNames.has(name)) continue;
    files.push(readStableSourceFile(root, name));
  }
  for (const name of [...dailyNames].sort()) {
    files.push(readStableSourceFile(root, `daily/${name}`));
  }
  let graph: SourceFileSnapshot | undefined;
  if (tier === "bujo") {
    const graphSnapshot = readCanonicalFileSnapshot(root, "graph.jsonl", { allowMissing: true });
    if (graphSnapshot !== undefined) {
      graph = { relativePath: "graph.jsonl", bytes: Buffer.from(graphSnapshot.content, "utf8") };
    }
  }
  const hash = createHash("sha256");
  for (const file of [...files, ...(graph === undefined ? [] : [graph])]) {
    hash.update(String(Buffer.byteLength(file.relativePath)));
    hash.update("\0");
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.bytes.length));
    hash.update("\0");
    hash.update(file.bytes);
  }
  return { fingerprint: hash.digest("hex"), daily: files, ...(graph === undefined ? {} : { graph }) };
}

function readStableSourceFile(root: string, relativePath: string): SourceFileSnapshot {
  const snapshot = readCanonicalFileSnapshot(root, relativePath);
  if (snapshot === undefined) throw new Error(`memory-rebuild: canonical source ${relativePath} disappeared.`);
  return { relativePath, bytes: Buffer.from(snapshot.content, "utf8") };
}

function buildPlan(snapshot: SourceSnapshot, tier: BujoTier): BuildPlan {
  const rawRecords: MemoryRecord[] = [];
  let skippedUnstructuredRecords = 0;
  const missingIdentityLocations: string[] = [];
  const legacySourceLocations: string[] = [];
  for (const source of snapshot.daily) {
    const content = source.bytes.toString("utf8");
    const parsed = parseDailyFile(content);
    for (const line of parsed.lines) {
      if (line.bullet === undefined) {
        if (line.raw.includes("<!--mem")) {
          if (isMissingOnlyIdentity(line.raw)) {
            missingIdentityLocations.push(`${source.relativePath}:${line.lineNumber}`);
            continue;
          }
          if (isLegacySourceRecord(line.raw)) {
            legacySourceLocations.push(`${source.relativePath}:${line.lineNumber}`);
            continue;
          }
          throw new Error(`memory-rebuild: malformed memory bullet at ${source.relativePath}:${line.lineNumber}.`);
        }
        if (CANONICAL_VISIBLE_BULLET.test(line.raw)) skippedUnstructuredRecords += 1;
        continue;
      }
      assertStrictBulletRaw(line.raw, source.relativePath, line.lineNumber);
      if (!Number.isFinite(Date.parse(line.bullet.createdAt))) {
        throw new Error(`memory-rebuild: invalid memory timestamp at ${source.relativePath}:${line.lineNumber}.`);
      }
      rawRecords.push(toRecord(line.bullet, source.relativePath, line.lineNumber));
    }
  }

  const records = new Map<string, MemoryRecord>();
  const contentHashes = new Map<string, string>();
  let skippedRawRecords = 0;
  let skippedJournalDuplicateRecords = 0;
  for (const record of rawRecords) {
    if (tier === "bujo" && isLegacyHostObservation(record.text)) {
      skippedRawRecords += 1;
      continue;
    }
    if (tier === "journal") {
      const hash = normalizedContentHash(record.text);
      if (contentHashes.has(hash)) {
        skippedJournalDuplicateRecords += 1;
        continue;
      }
      const canonical = { ...record, id: `J-${hash}` };
      records.set(canonical.id, canonical);
      contentHashes.set(hash, canonical.id);
      continue;
    }
    const existing = records.get(record.id);
    if (existing !== undefined) {
      throw new Error(`memory-rebuild: duplicate canonical memory id ${record.id}.`);
    }
    records.set(record.id, record);
  }

  const graph = tier === "bujo"
    ? projectCanonicalGraph(parseCanonicalGraphStrict(snapshot.graph?.bytes.toString("utf8")), [...records.values()])
    : emptyCanonicalGraphProjection();
  for (const support of graph.collectionSupports) {
    const record = records.get(support.memoryId);
    if (record === undefined) throw new Error("memory-rebuild: collection support lost its memory endpoint.");
    records.set(record.id, { ...record, collection: support.collection });
  }
  const parsedSourceItems = rawRecords.length + skippedUnstructuredRecords
    + missingIdentityLocations.length + legacySourceLocations.length;
  const accountedSourceItems = records.size + skippedRawRecords + skippedUnstructuredRecords
    + missingIdentityLocations.length + legacySourceLocations.length + skippedJournalDuplicateRecords;
  if (accountedSourceItems !== parsedSourceItems) {
    throw new Error(`memory-rebuild: source accounting mismatch (${accountedSourceItems}/${parsedSourceItems}).`);
  }
  return {
    records: [...records.values()],
    contentHashes,
    graph,
    skippedRawRecords,
    skippedUnstructuredRecords,
    skippedMissingIdentityRecords: missingIdentityLocations.length,
    missingIdentityLocations,
    skippedLegacySourceRecords: legacySourceLocations.length,
    legacySourceLocations,
    skippedJournalDuplicateRecords,
    parsedSourceItems,
  };
}

function validateCandidate(
  path: string,
  descriptor: ManagedGeneration,
  plan: BuildPlan,
  allowReplayedLifecycle = false,
): void {
  const db = readOnlyDb(path, descriptor);
  try {
    validateDb(db, descriptor);
    const parityError = buildPlanParityError(db, descriptor.tier, plan, {
      allowReplayedLifecycle,
      allowNoncanonicalEdges: allowReplayedLifecycle,
    });
    if (parityError !== undefined) throw new Error(parityError);
  } finally {
    db.close();
  }
}

interface BuildPlanParityOptions {
  readonly allowReplayedLifecycle: boolean;
  readonly allowReplaySourceRepair?: boolean;
  readonly allowJournalVectorBacklog?: boolean;
  readonly allowNoncanonicalEdges?: boolean;
  readonly allowJournalHashRepair?: boolean;
}

function buildPlanParityError(
  db: MemoryDb,
  tier: BujoTier,
  plan: BuildPlan,
  options: BuildPlanParityOptions,
): string | undefined {
  const state = db.validationSnapshot();
  if (state.memories !== plan.records.length || state.ftsRows !== plan.records.length || state.ftsMismatches !== 0) {
    return "memory-rebuild: candidate memory/FTS coverage validation failed.";
  }
  const actualMemories = plan.records.map((record) => db.get(record.id));
  if (stableJson(actualMemories.map((record) => memoryPayload(
    record,
    options.allowReplayedLifecycle,
    options.allowReplaySourceRepair === true,
  ))) !== stableJson(plan.records.map((record) => memoryPayload(
    record,
    options.allowReplayedLifecycle,
    options.allowReplaySourceRepair === true,
  )))) {
    return "memory-rebuild: candidate memory payload validation failed.";
  }
  if (options.allowReplaySourceRepair === true && actualMemories.some((record, index) => {
    const expected = plan.records[index];
    return record?.source.line !== undefined && record.source.line !== expected?.source.line;
  })) {
    return "memory-rebuild: candidate memory payload validation failed.";
  }
  const invalidVectorCoverage = tier === "lite"
    ? state.vectors !== 0
    : tier === "bujo" || options.allowJournalVectorBacklog !== true
      ? state.vectors !== plan.records.length
      : false;
  if (invalidVectorCoverage || state.vectorOrphans !== 0) {
    return "memory-rebuild: candidate vector coverage validation failed.";
  }
  if (state.entities !== plan.graph.entities.length || state.relations !== plan.graph.relations.length
    || state.associations !== plan.graph.associations.length || state.relationOrphans !== 0 || state.associationOrphans !== 0) {
    return "memory-rebuild: candidate graph coverage or endpoint validation failed.";
  }
  const actualEntities = plan.graph.entities.map((entity) => db.getEntity(entity.id));
  const actualRelations = [...new Set(plan.graph.relations.map((relation) => relation.src))]
    .flatMap((src) => db.relationsFor(src));
  const actualAssociations = [...new Set(plan.graph.associations.map((association) => association.memoryId))]
    .flatMap((memoryId) => db.associationsForMemory(memoryId));
  if (stableJson(actualEntities) !== stableJson(plan.graph.entities)
    || stableJson(actualRelations) !== stableJson(plan.graph.relations)
    || stableJson(actualAssociations) !== stableJson(plan.graph.associations)) {
    return "memory-rebuild: candidate graph payload validation failed.";
  }
  const expectedEdges = plan.graph.collectionSupports.map((support) => ({
    src: support.memoryId,
    dst: support.entityId,
    kind: "supports",
    weight: 1,
  }));
  const actualEdges = db.allEdges().map(({ createdAt: _createdAt, ...edge }) => edge);
  if (options.allowNoncanonicalEdges === true) {
    for (const expected of expectedEdges) {
      if (!actualEdges.some((edge) => stableJson([edge]) === stableJson([expected]))) {
        return "memory-rebuild: candidate collection support validation failed.";
      }
    }
  } else if (stableJson(actualEdges) !== stableJson(expectedEdges)) {
    return "memory-rebuild: candidate edge inventory validation failed.";
  }
  if (tier === "journal") {
    if (state.contentHashes !== plan.contentHashes.size || state.contentHashOrphans !== 0) {
      return "memory-rebuild: Journal content-hash bijection validation failed.";
    }
    const actual = db.contentHashRecords();
    for (const hash of actual) {
      const record = db.get(hash.memoryId);
      if (record === undefined || normalizedContentHash(record.text) !== hash.contentHash
        || plan.contentHashes.get(hash.contentHash) !== hash.memoryId) {
        return "memory-rebuild: Journal content-hash correctness validation failed.";
      }
    }
    if (options.allowJournalHashRepair !== true) {
      const expected = [...plan.contentHashes].map(([contentHash, memoryId]) => {
        const record = plan.records.find((candidate) => candidate.id === memoryId);
        return {
          contentHash,
          memoryId,
          sourceFile: record?.source.file,
          createdAt: record?.createdAt,
        };
      });
      if (stableJson(actual) !== stableJson(expected)) {
        return "memory-rebuild: Journal content-hash provenance validation failed.";
      }
    }
  } else if (state.contentHashes !== 0) {
    return "memory-rebuild: non-Journal candidate unexpectedly contains content hashes.";
  }
  return undefined;
}

function hasTierExactSourceParity(
  path: string,
  descriptor: ManagedGeneration,
  plan: BuildPlan,
  allowReplaySourceRepair: boolean,
): boolean {
  const db = readOnlyDb(path, descriptor);
  try {
    return buildPlanParityError(db, descriptor.tier, plan, {
      allowReplayedLifecycle: allowReplaySourceRepair,
      allowReplaySourceRepair,
      allowJournalVectorBacklog: true,
      allowNoncanonicalEdges: allowReplaySourceRepair,
      allowJournalHashRepair: allowReplaySourceRepair,
    }) === undefined;
  } finally {
    db.close();
  }
}

function validateRollbackSnapshot(path: string, descriptor: ManagedGeneration, plan: BuildPlan): void {
  const db = readOnlyDb(path, descriptor);
  try {
    validateDb(db, descriptor);
    const parityError = buildPlanParityError(db, descriptor.tier, plan, {
      allowReplayedLifecycle: false,
      allowJournalVectorBacklog: true,
    });
    if (parityError !== undefined) {
      throw new Error(`memory-rebuild: rollback source parity validation failed: ${parityError.replace(/^memory-rebuild: /u, "")}`);
    }
    if (descriptor.integrityDigest === undefined) {
      throw new Error("memory-rebuild: rollback generation has no trusted logical integrity digest; run rebuild first.");
    }
    if (db.logicalIntegrityDigest() !== descriptor.integrityDigest) {
      throw new Error("memory-rebuild: rollback logical integrity digest changed after retention.");
    }
  } finally {
    db.close();
  }
}

function validateRetainedGeneration(path: string, descriptor: ManagedGeneration): void {
  const db = readOnlyDb(path, descriptor);
  try {
    validateDb(db, descriptor);
    const state = db.validationSnapshot();
    const invalidTierVectorCoverage = descriptor.tier === "lite"
      ? state.vectors !== 0
      : descriptor.tier === "bujo"
        ? state.vectors !== state.memories
        : false;
    if (state.ftsRows !== state.memories || state.ftsMismatches !== 0 || state.vectorOrphans !== 0
      || invalidTierVectorCoverage || state.contentHashOrphans !== 0
      || state.relationOrphans !== 0 || state.associationOrphans !== 0) {
      throw new Error("memory-rebuild: retained rollback generation failed coverage validation.");
    }
  } finally {
    db.close();
  }
}

function validateDb(db: MemoryDb, descriptor: ManagedGeneration): void {
  if (db.integrityCheck().toLowerCase() !== "ok") throw new Error("memory-rebuild: SQLite integrity check failed.");
  const metadata = db.indexMetadata();
  if (metadata === undefined
    || metadata.schemaVersion !== MANAGED_INDEX_SCHEMA_VERSION
    || metadata.policyVersion !== descriptor.policyVersion
    || metadata.tier !== descriptor.tier
    || metadata.sourceFingerprint !== descriptor.sourceFingerprint
    || metadata.generation !== descriptor.name
    || metadata.createdAt !== descriptor.createdAt
    || metadata.embeddingModel !== descriptor.embeddingModel
    || metadata.dimension !== descriptor.dimension
    || metadata.skippedRawRecords !== descriptor.skippedRawRecords
    || metadata.skippedUnstructuredRecords !== descriptor.skippedUnstructuredRecords
    || metadata.skippedMissingIdentityRecords !== descriptor.skippedMissingIdentityRecords
    || stableJson(metadata.missingIdentityLocations ?? []) !== stableJson(descriptor.missingIdentityLocations ?? [])
    || metadata.skippedLegacySourceRecords !== descriptor.skippedLegacySourceRecords
    || stableJson(metadata.legacySourceLocations ?? []) !== stableJson(descriptor.legacySourceLocations ?? [])
    || metadata.skippedJournalDuplicateRecords !== descriptor.skippedJournalDuplicateRecords
    || metadata.parsedSourceItems !== descriptor.parsedSourceItems
    || metadata.derivedLegacyAssociations !== descriptor.derivedLegacyAssociations) {
    throw new Error("memory-rebuild: candidate metadata does not match its manifest generation.");
  }
  const expectedDimension = descriptor.dimension ?? DEFAULT_VEC_DIM;
  if (db.vectorDimension() !== expectedDimension) throw new Error("memory-rebuild: actual vector DDL dimension does not match metadata.");
  const state = db.validationSnapshot();
  if (state.vectorIdentityMissing !== 0) {
    throw new Error("memory-rebuild: vector rows have incomplete embedding model/dimension identity.");
  }
  if (descriptor.embeddingModel === undefined
    ? state.embeddingModels.length !== 0 || state.embeddingDimensions.length !== 0
    : state.embeddingModels.some((model) => model !== descriptor.embeddingModel)
      || state.embeddingDimensions.some((dimension) => dimension !== descriptor.dimension)) {
    throw new Error("memory-rebuild: embedding model/dimension identity validation failed.");
  }
}

function openCurrentReplayDb(
  path: string,
  manifest: ManagedIndexManifest | undefined,
): MemoryDb {
  if (manifest !== undefined) {
    const active = manifest.active;
    return openMemoryDb({
      path,
      ...(active.embeddingModel === undefined ? {} : { embeddings: noCallEmbeddings(active.embeddingModel) }),
      ...(active.dimension === undefined ? {} : { dim: active.dimension }),
    });
  }

  // A pre-managed database has no manifest descriptor. Read its actual vec DDL
  // and persisted model identity before reopening writable; the provider stub
  // supplies identity only and must never perform a paid embedding call.
  const probe = openMemoryDb({ path, readOnly: true });
  let dimension: number;
  let embeddingModel: string | undefined;
  try {
    dimension = probe.vectorDimension();
    const state = probe.validationSnapshot();
    if (state.embeddingModels.length > 1) {
      throw new Error("memory-rebuild: active legacy index contains multiple embedding model identities.");
    }
    embeddingModel = probe.indexMetadata()?.embeddingModel ?? state.embeddingModels[0];
    if (state.vectors > 0 && embeddingModel === undefined) {
      throw new Error(
        "memory-rebuild: active legacy vectors have no embedding model identity; recover them under their prior configuration.",
      );
    }
  } finally {
    probe.close();
  }
  return openMemoryDb({
    path,
    dim: dimension,
    ...(embeddingModel === undefined ? {} : { embeddings: noCallEmbeddings(embeddingModel) }),
  });
}

function activeDbPathFromManifest(root: string, manifest: ManagedIndexManifest | undefined): string {
  if (manifest !== undefined) return managedGenerationDbPath(root, manifest.active.name, true);
  const path = join(root, "memory.db");
  if (existsSync(path)) assertSafeRegularFile(root, path, "legacy memory database");
  return path;
}

function validateCurrentReplayDb(path: string, descriptor: ManagedGeneration | undefined): void {
  if (descriptor !== undefined) {
    validateRetainedGeneration(path, descriptor);
    return;
  }
  const db = openMemoryDb({ path, readOnly: true });
  try {
    if (db.integrityCheck().toLowerCase() !== "ok") {
      throw new Error("memory-rebuild: active legacy SQLite integrity check failed.");
    }
    const actualDimension = db.vectorDimension();
    const metadata = db.indexMetadata();
    const state = db.validationSnapshot();
    if (state.ftsRows !== state.memories || state.ftsMismatches !== 0 || state.vectorOrphans !== 0
      || state.vectorIdentityMissing !== 0 || state.contentHashOrphans !== 0
      || state.relationOrphans !== 0 || state.associationOrphans !== 0) {
      throw new Error("memory-rebuild: active legacy index failed replay coverage validation.");
    }
    if (state.embeddingModels.length > 1 || state.embeddingDimensions.length > 1
      || state.embeddingDimensions.some((dimension) => dimension !== actualDimension)
      || (state.vectors > 0 && (state.embeddingModels.length !== 1 || state.embeddingDimensions.length !== 1))
      || (metadata?.dimension !== undefined && metadata.dimension !== actualDimension)
      || (metadata?.embeddingModel !== undefined
        && state.embeddingModels.some((model) => model !== metadata.embeddingModel))) {
      throw new Error("memory-rebuild: active legacy embedding identity does not match its actual vector DDL.");
    }
  } finally {
    db.close();
  }
}

function noCallEmbeddings(id: string): EmbeddingProvider {
  return {
    id,
    embed: async (): Promise<number[][]> => {
      throw new Error("memory-rebuild: durable replay must not call the embedding provider.");
    },
  };
}

async function adoptLegacyRollback(
  root: string,
  expectedIntegrity?: string,
): Promise<ManagedGeneration | undefined> {
  const legacyPath = join(root, "memory.db");
  if (!existsSync(legacyPath)) return undefined;
  assertSafeRegularFile(root, legacyPath, "legacy memory database");
  const legacyIntegrity = logicalIntegrityDigest(legacyPath);
  if (expectedIntegrity !== undefined && legacyIntegrity !== expectedIntegrity) {
    throw new Error("memory-rebuild: legacy database changed concurrently before it could be retained.");
  }
  const generation = createManagedGeneration(root);
  const actualDimension = await backupRawSqlite(legacyPath, generation.dbPath);
  if (logicalIntegrityDigest(legacyPath) !== legacyIntegrity) {
    throw new Error("memory-rebuild: legacy database changed concurrently while it was being retained.");
  }
  if (logicalIntegrityDigest(generation.dbPath) !== legacyIntegrity) {
    throw new Error("memory-rebuild: legacy backup does not match the pinned source state.");
  }
  const copy = openMemoryDb({ path: generation.dbPath, dim: actualDimension });
  let embeddingModel: string | undefined;
  let tier!: BujoTier;
  const createdAt = new Date().toISOString();
  try {
    const state = copy.validationSnapshot();
    const models = state.embeddingModels;
    if (models.length > 1) throw new Error("memory-rebuild: legacy index contains multiple embedding model identities.");
    const priorMetadata = copy.indexMetadata();
    embeddingModel = priorMetadata?.embeddingModel ?? models[0];
    const semantic = state.vectors > 0 || embeddingModel !== undefined;
    if (priorMetadata?.tier === "lite" || priorMetadata?.tier === "journal" || priorMetadata?.tier === "bujo") {
      tier = priorMetadata.tier;
    } else if (!semantic) {
      tier = "lite";
    } else {
      tier = state.entities > 0 || state.relations > 0 || state.associations > 0 || existsSync(join(root, "graph.jsonl"))
        ? "bujo"
        : "journal";
    }
    if (tier === "lite") {
      if (semantic || actualDimension !== DEFAULT_VEC_DIM) {
        throw new Error(
          "memory-rebuild: legacy index identity cannot be represented as Lite; first rebuild it under its prior semantic configuration.",
        );
      }
      embeddingModel = undefined;
    } else if (embeddingModel === undefined) {
      throw new Error(
        "memory-rebuild: legacy semantic index has no embedding-model identity; first rebuild it under its prior configuration.",
      );
    }
  } finally {
    copy.close();
  }
  const source = snapshotCanonicalSources(root, tier);
  const plan = buildPlan(source, tier);
  const descriptorBase: ManagedGeneration = {
    name: generation.name,
    tier,
    sourceFingerprint: source.fingerprint,
    policyVersion: MEMORY_REBUILD_POLICY_VERSION,
    createdAt,
    origin: "legacy-snapshot",
    skippedRawRecords: plan.skippedRawRecords,
    skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
    skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
    missingIdentityLocations: plan.missingIdentityLocations,
    skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
    legacySourceLocations: plan.legacySourceLocations,
    skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
    parsedSourceItems: plan.parsedSourceItems,
    derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
    ...(embeddingModel === undefined ? {} : { embeddingModel, dimension: actualDimension }),
  };

  // A pre-managed database remains byte-for-byte preserved at memory.db even
  // when it differs from canonical source, but it must not be advertised as a
  // one-command rollback. Only an exact, repairable mirror becomes managed.
  if (!hasTierExactSourceParity(generation.dbPath, descriptorBase, plan, true)) return undefined;
  normalizeRollbackToPlan(generation.dbPath, plan);
  if (!hasTierExactSourceParity(generation.dbPath, descriptorBase, plan, false)) return undefined;

  const managed = openMemoryDb({ path: generation.dbPath, dim: actualDimension });
  let integrityDigest!: string;
  try {
    managed.setIndexMetadata({
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      policyVersion: MEMORY_REBUILD_POLICY_VERSION,
      tier,
      sourceFingerprint: source.fingerprint,
      generation: generation.name,
      createdAt,
      skippedRawRecords: plan.skippedRawRecords,
      skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
      skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
      missingIdentityLocations: plan.missingIdentityLocations,
      skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
      legacySourceLocations: plan.legacySourceLocations,
      skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
      parsedSourceItems: plan.parsedSourceItems,
      derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
      ...(embeddingModel === undefined ? {} : { embeddingModel, dimension: actualDimension }),
    });
    managed.checkpoint();
    integrityDigest = managed.logicalIntegrityDigest();
  } finally {
    managed.close();
  }
  const descriptor: ManagedGeneration = { ...descriptorBase, integrityDigest };
  fsyncFile(generation.dbPath);
  fsyncDirectory(generation.dir);
  validateRollbackSnapshot(generation.dbPath, descriptor, plan);
  return descriptor;
}

async function snapshotCurrentRollback(
  root: string,
  active: ManagedGeneration | undefined,
  snapshot: SourceSnapshot,
  expectedIntegrity: string,
): Promise<ManagedGeneration | undefined> {
  if (active === undefined) return await adoptLegacyRollback(root, expectedIntegrity);
  const sourcePath = managedGenerationDbPath(root, active.name, true);
  if (logicalIntegrityDigest(sourcePath, active) !== expectedIntegrity) {
    throw new Error("memory-rebuild: active database changed concurrently before it could be retained.");
  }
  validateRetainedGeneration(sourcePath, active);
  // Never turn the formerly writable active path into an immutable rollback
  // in place. An online backup gets its own generation, canonical repair, WAL
  // boundary, and logical commitment before the manifest can advertise it.
  return await snapshotDatabaseForRollback(
    root,
    sourcePath,
    snapshot,
    active,
    expectedIntegrity,
  );
}

async function snapshotDatabaseForRollback(
  root: string,
  sourcePath: string,
  snapshot: SourceSnapshot,
  preservedIdentity: ManagedGeneration,
  expectedIntegrity: string,
): Promise<ManagedGeneration | undefined> {
  const tier = preservedIdentity.tier;
  const plan = buildPlan(snapshot, tier);
  if (!hasTierExactSourceParity(sourcePath, preservedIdentity, plan, true)) return undefined;

  const generation = createManagedGeneration(root);
  const actualDimension = await backupRawSqlite(sourcePath, generation.dbPath);
  if (logicalIntegrityDigest(sourcePath, preservedIdentity) !== expectedIntegrity) {
    throw new Error("memory-rebuild: active database changed concurrently while it was being retained.");
  }
  if (logicalIntegrityDigest(generation.dbPath, preservedIdentity) !== expectedIntegrity) {
    throw new Error("memory-rebuild: retained backup does not match the pinned active database state.");
  }
  // Re-check the online copy before changing its metadata. A concurrent source
  // mutation may produce a structurally valid backup that no longer mirrors
  // the canonical tier snapshot; such a copy must never be stamped as current.
  if (!hasTierExactSourceParity(generation.dbPath, preservedIdentity, plan, true)) return undefined;
  normalizeRollbackToPlan(generation.dbPath, plan);
  if (!hasTierExactSourceParity(generation.dbPath, preservedIdentity, plan, false)) return undefined;

  const embeddingModel = preservedIdentity.embeddingModel;
  const createdAt = new Date().toISOString();
  const descriptorBase: ManagedGeneration = {
    name: generation.name,
    tier,
    sourceFingerprint: snapshot.fingerprint,
    policyVersion: MEMORY_REBUILD_POLICY_VERSION,
    createdAt,
    origin: "legacy-snapshot",
    skippedRawRecords: plan.skippedRawRecords,
    skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
    skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
    missingIdentityLocations: plan.missingIdentityLocations,
    skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
    legacySourceLocations: plan.legacySourceLocations,
    skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
    parsedSourceItems: plan.parsedSourceItems,
    derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
    ...(embeddingModel === undefined ? {} : {
      embeddingModel,
      dimension: preservedIdentity.dimension ?? actualDimension,
    }),
  };
  const copy = openMemoryDb({ path: generation.dbPath, dim: actualDimension });
  let integrityDigest!: string;
  try {
    copy.setIndexMetadata({
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      policyVersion: MEMORY_REBUILD_POLICY_VERSION,
      tier,
      sourceFingerprint: snapshot.fingerprint,
      generation: generation.name,
      createdAt,
      skippedRawRecords: plan.skippedRawRecords,
      skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
      skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
      missingIdentityLocations: plan.missingIdentityLocations,
      skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
      legacySourceLocations: plan.legacySourceLocations,
      skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
      parsedSourceItems: plan.parsedSourceItems,
      derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
      ...(embeddingModel === undefined ? {} : {
        embeddingModel,
        dimension: preservedIdentity.dimension ?? actualDimension,
      }),
    });
    copy.checkpoint();
    integrityDigest = copy.logicalIntegrityDigest();
  } finally {
    copy.close();
  }
  const descriptor: ManagedGeneration = { ...descriptorBase, integrityDigest };
  fsyncFile(generation.dbPath);
  fsyncDirectory(generation.dir);
  validateRollbackSnapshot(generation.dbPath, descriptor, plan);
  return descriptor;
}

function normalizeRollbackToPlan(path: string, plan: BuildPlan): void {
  const raw = new BetterSqlite3(path, { fileMustExist: true });
  try {
    const update = raw.prepare(
      `UPDATE memories
       SET valid_from = ?, valid_to = ?, superseded_by = ?, superseded_at = ?,
           source_session = ?, source_file = ?, source_line = ?
       WHERE id = ?`,
    );
    const insertEdge = raw.prepare(
      `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'supports', 1.0, ?)`,
    );
    const insertHash = raw.prepare(
      `INSERT INTO content_hashes (content_hash, memory_id, source_file, created_at) VALUES (?, ?, ?, ?)`,
    );
    const normalize = raw.transaction(() => {
      for (const record of plan.records) {
        const result = update.run(
          record.validFrom ?? null,
          record.validTo ?? null,
          record.supersededBy ?? null,
          record.supersededAt ?? null,
          record.source.session ?? null,
          record.source.file ?? null,
          record.source.line ?? null,
          record.id,
        );
        if (result.changes !== 1) {
          throw new Error("memory-rebuild: rollback normalization lost a canonical memory row.");
        }
      }
      raw.prepare(`DELETE FROM edges`).run();
      for (const support of plan.graph.collectionSupports) {
        const record = plan.records.find((candidate) => candidate.id === support.memoryId);
        insertEdge.run(support.memoryId, support.entityId, record?.createdAt ?? new Date(0).toISOString());
      }
      raw.prepare(`DELETE FROM content_hashes`).run();
      for (const [contentHash, memoryId] of plan.contentHashes) {
        const record = plan.records.find((candidate) => candidate.id === memoryId);
        if (record?.source.file === undefined) {
          throw new Error("memory-rebuild: rollback Journal normalization lost source provenance.");
        }
        insertHash.run(contentHash, memoryId, record.source.file, record.createdAt);
      }
    });
    normalize();
    raw.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    raw.close();
  }
}

function assertConfiguredIdentity(target: ManagedGeneration, options: SafeMemoryIndexOptions): void {
  if (target.tier !== options.tier
    || target.embeddingModel !== options.embeddings?.id
    || target.dimension !== options.dim) {
    throw new Error(
      `memory-rebuild: rollback target requires tier=${target.tier}, model=${target.embeddingModel ?? "none"}, `
      + `dim=${target.dimension ?? "none"}; revert configuration before rollback.`,
    );
  }
}

function assertSafeRebuildOptions(options: SafeMemoryIndexOptions): void {
  if (options.tier === "lite") {
    if (options.embeddings !== undefined || options.dim !== undefined) {
      throw new Error("memory-rebuild: lite rebuild rejects embeddings and dimensions.");
    }
    return;
  }
  if (options.embeddings === undefined || options.dim === undefined || !Number.isInteger(options.dim) || options.dim <= 0) {
    throw new Error(`memory-rebuild: ${options.tier} rebuild requires embeddings and an explicit positive dimension.`);
  }
}

function readOnlyDb(path: string, descriptor: ManagedGeneration): MemoryDb {
  return openMemoryDb({ path, readOnly: true, dim: descriptor.dimension ?? DEFAULT_VEC_DIM });
}

function identityOf(path: string): { readonly dev: number; readonly ino: number; readonly size: number } {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("memory-rebuild: identity target became a symlink.");
  return { dev: stat.dev, ino: stat.ino, size: stat.size };
}

function sameIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSameIdentity(
  path: string,
  expected: { readonly dev: number; readonly ino: number },
  label: string,
): void {
  if (!sameIdentity(identityOf(path), expected)) throw new Error(`memory-rebuild: ${label} was replaced concurrently.`);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function logicalIntegrityDigest(path: string, descriptor?: ManagedGeneration): string {
  const db = openMemoryDb({
    path,
    readOnly: true,
    dim: descriptor?.dimension ?? DEFAULT_VEC_DIM,
  });
  try {
    return db.logicalIntegrityDigest();
  } finally {
    db.close();
  }
}

/**
 * When the new candidate re-embedded the exact same source with the exact same
 * provider identity, it is an independent vector oracle we already paid for.
 * Journal may retain missing vectors, but every vector it does retain must
 * equal the candidate. Other tier/model/source migrations have no comparable
 * no-call oracle and rely on the pinned online-backup commitment instead.
 */
function retainedVectorsMatchCandidate(
  candidatePath: string,
  candidate: ManagedGeneration,
  retainedPath: string,
  retained: ManagedGeneration,
): boolean {
  if (candidate.tier !== retained.tier
    || candidate.sourceFingerprint !== retained.sourceFingerprint
    || candidate.embeddingModel !== retained.embeddingModel
    || candidate.dimension !== retained.dimension) return true;
  const candidateDb = readOnlyDb(candidatePath, candidate);
  const retainedDb = readOnlyDb(retainedPath, retained);
  try {
    const expected = new Map(candidateDb.vectorPayloadDigests().map((entry) => [entry.memoryId, entry.sha256]));
    return retainedDb.vectorPayloadDigests().every((entry) => expected.get(entry.memoryId) === entry.sha256);
  } finally {
    retainedDb.close();
    candidateDb.close();
  }
}

function stableJson(values: readonly unknown[]): string {
  return JSON.stringify(values.map(canonicalJsonValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

function memoryPayload(
  record: MemoryRecord | undefined,
  omitReplayedLifecycle = false,
  omitRepairableSourceProvenance = false,
): unknown {
  if (record === undefined) return undefined;
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    text: record.text,
    salience: record.salience,
    isInsight: record.isInsight,
    createdAt: record.createdAt,
    ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
    ...(omitReplayedLifecycle || record.validTo === undefined ? {} : { validTo: record.validTo }),
    ...(omitReplayedLifecycle || record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
    ...(omitReplayedLifecycle || record.supersededAt === undefined ? {} : { supersededAt: record.supersededAt }),
    ...(record.dueAt === undefined ? {} : { dueAt: record.dueAt }),
    ...(record.collection === undefined ? {} : { collection: record.collection }),
    tags: [...record.tags],
    source: omitRepairableSourceProvenance
      ? { ...(record.source.file === undefined ? {} : { file: record.source.file }) }
      : { ...record.source },
  };
}

const LEGACY_DAILY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/u;
const CANONICAL_VISIBLE_BULLET = /^- (?:\[[ x><~]\]|◦|–) /u;
const VALID_BULLET_TYPES = new Set(["task", "event", "note"]);
const VALID_BULLET_STATUSES = new Set(["open", "done", "scheduled", "migrated", "dropped", "invalidated"]);

function assertStrictBulletRaw(raw: string, file: string, line: number): void {
  const match = /<!--mem\s+(.+?)-->/u.exec(raw);
  if (match === null) throw new Error(`memory-rebuild: canonical bullet metadata is missing at ${file}:${line}.`);
  const fields = new Map<string, string>();
  for (const pair of (match[1] ?? "").trim().split(/\s+/u)) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error(`memory-rebuild: malformed bullet metadata at ${file}:${line}.`);
    const key = pair.slice(0, separator);
    if (fields.has(key)) throw new Error(`memory-rebuild: duplicate bullet metadata key ${key} at ${file}:${line}.`);
    fields.set(key, pair.slice(separator + 1));
  }
  const required = ["id", "type", "status", "salience", "isInsight", "created", "refs"];
  if (required.some((key) => !fields.has(key))) {
    throw new Error(`memory-rebuild: incomplete bullet metadata at ${file}:${line}.`);
  }
  if (!VALID_BULLET_TYPES.has(fields.get("type") ?? "") || !VALID_BULLET_STATUSES.has(fields.get("status") ?? "")) {
    throw new Error(`memory-rebuild: invalid bullet type/status at ${file}:${line}.`);
  }
  if (!Number.isFinite(Number(fields.get("salience")))) {
    throw new Error(`memory-rebuild: invalid bullet salience at ${file}:${line}.`);
  }
  if (fields.get("isInsight") !== "0" && fields.get("isInsight") !== "1") {
    throw new Error(`memory-rebuild: invalid bullet isInsight at ${file}:${line}.`);
  }
  if (!Number.isFinite(Date.parse(fields.get("created") ?? ""))) {
    throw new Error(`memory-rebuild: invalid bullet created timestamp at ${file}:${line}.`);
  }
  const due = fields.get("due");
  if (due !== undefined && !Number.isFinite(Date.parse(due))) {
    throw new Error(`memory-rebuild: invalid bullet due timestamp at ${file}:${line}.`);
  }
}

function isMissingOnlyIdentity(raw: string): boolean {
  if (!CANONICAL_VISIBLE_BULLET.test(raw)) return false;
  const match = /<!--mem\s+(.+?)-->/u.exec(raw);
  if (match === null) return false;
  const fields = new Map<string, string>();
  for (const pair of (match[1] ?? "").trim().split(/\s+/u)) {
    const separator = pair.indexOf("=");
    if (separator <= 0) return false;
    const key = pair.slice(0, separator);
    if (fields.has(key)) return false;
    fields.set(key, pair.slice(separator + 1));
  }
  if ((fields.get("id") ?? "") !== "") return false;
  const requiredWithoutIdentity = ["type", "status", "salience", "isInsight", "created", "refs"];
  if (requiredWithoutIdentity.some((key) => !fields.has(key))) return false;
  if (!VALID_BULLET_TYPES.has(fields.get("type") ?? "") || !VALID_BULLET_STATUSES.has(fields.get("status") ?? "")) return false;
  if (!Number.isFinite(Number(fields.get("salience")))) return false;
  if (fields.get("isInsight") !== "0" && fields.get("isInsight") !== "1") return false;
  if (!Number.isFinite(Date.parse(fields.get("created") ?? ""))) return false;
  const due = fields.get("due");
  return due === undefined || Number.isFinite(Date.parse(due));
}

function isLegacySourceRecord(raw: string): boolean {
  if (raw.includes("\n") || !raw.startsWith("- ")) return false;
  if ((raw.match(/<!--mem/gu) ?? []).length !== 1 || (raw.match(/-->/gu) ?? []).length !== 1) return false;
  const match = /<!--mem\s+(.+?)-->\s*$/u.exec(raw);
  if (match === null) return false;
  const fields = new Map<string, string>();
  for (const pair of (match[1] ?? "").trim().split(/\s+/u)) {
    const separator = pair.indexOf("=");
    if (separator <= 0) return false;
    const key = pair.slice(0, separator);
    if (fields.has(key)) return false;
    fields.set(key, pair.slice(separator + 1));
  }
  const keys = [...fields.keys()].sort();
  if (stableJson(keys) !== stableJson(["salience", "source", "status", "type"])) return false;
  if (!VALID_BULLET_TYPES.has(fields.get("type") ?? "") || !VALID_BULLET_STATUSES.has(fields.get("status") ?? "")) return false;
  if (!Number.isFinite(Number(fields.get("salience")))) return false;
  return (fields.get("source") ?? "").length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface SqliteWriterFence {
  release(): void;
}

/** Hold BEGIN IMMEDIATE on every activation input so WAL writers cannot cross validation + rename. */
function acquireSqliteWriterFences(paths: readonly string[]): SqliteWriterFence {
  const databases: BetterSqlite3.Database[] = [];
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const errors: unknown[] = [];
    for (const db of databases.reverse()) {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } catch (error) {
        errors.push(error);
      }
      try {
        db.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "memory-rebuild: SQLite writer fence release failed.");
  };
  try {
    for (const path of [...new Set(paths)].sort()) {
      const db = new BetterSqlite3(path, { fileMustExist: true, timeout: 0 });
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        db.close();
        throw error;
      }
      databases.push(db);
    }
  } catch (error) {
    try {
      release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "memory-rebuild: SQLite writer fence acquisition failed.");
    }
    throw new Error(
      `memory-rebuild: a SQLite writer owns an activation database; stop it and retry. ${reasonOf(error)}`,
    );
  }
  return { release };
}

function assertNoActiveSqliteWriter(path: string): void {
  if (!existsSync(path)) return;
  const db = new BetterSqlite3(path, { fileMustExist: true, timeout: 0 });
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw new Error(`memory-rebuild: active legacy SQLite writer detected; stop the configured agent first. ${reasonOf(error)}`);
  } finally {
    db.close();
  }
}

async function backupRawSqlite(sourcePath: string, destinationPath: string): Promise<number> {
  const db = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_vec'`,
    ).get() as { sql: string } | undefined;
    const dimension = Number(row?.sql.match(/embedding\s+float\[(\d+)\]/iu)?.[1] ?? DEFAULT_VEC_DIM);
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("memory-rebuild: legacy vector table has an invalid dimension.");
    }
    await db.backup(destinationPath);
    return dimension;
  } finally {
    db.close();
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
