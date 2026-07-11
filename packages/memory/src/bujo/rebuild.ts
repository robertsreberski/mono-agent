import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";

import { DEFAULT_VEC_DIM, openMemoryDb } from "../store/index.js";
import type {
  EntityRecord,
  EntityRelationRecord,
  MemoryDb,
  MemoryEntityAssociation,
  MemoryRecord,
} from "../store/index.js";
import type { EmbeddingProvider } from "../search/index.js";

import { normalizedContentHash } from "./daily.js";
import { parseDailyFile } from "./grammar.js";
import { readGraph } from "./graph.js";
import type { BujoTier, Bullet } from "./types.js";
import {
  MANAGED_INDEX_SCHEMA_VERSION,
  MEMORY_REBUILD_POLICY_VERSION,
  acquireMemoryWriterLease,
  activateManagedIndex,
  assertManagedManifestState,
  assertSafeDirectory,
  assertSafeRegularFile,
  canonicalMemoryRoot,
  captureManagedManifestState,
  createManagedGeneration,
  fsyncDirectory,
  managedGenerationDbPath,
  readManagedIndexManifest,
  resolveActiveMemoryDbPath,
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
  const dailyDir = join(root, "daily");
  let files: string[];
  try {
    files = readdirSync(dailyDir).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    // Only a missing directory means "empty". Re-throw permission/IO errors (EACCES, EIO, …) so a
    // transient fault can't silently produce an empty rebuild — db.rebuild() deletes every row first.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    files = [];
  }
  const records: MemoryRecord[] = [];
  for (const file of files) {
    const parsed = parseDailyFile(readFileSync(join(dailyDir, file), "utf8"));
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
      db.upsertEntity(entity);
    } catch {
      // Per-item isolation: a single corrupt entity must not abort the rebuild
    }
  }
  for (const relation of g.relations) {
    try {
      db.addEntityRelation(relation.src, relation.dst, relation.relation);
    } catch {
      // Per-item isolation
    }
  }
  for (const association of g.associations) {
    try {
      db.associateMemory(association);
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

interface StrictGraph {
  readonly entities: readonly EntityRecord[];
  readonly relations: readonly EntityRelationRecord[];
  readonly associations: readonly MemoryEntityAssociation[];
  readonly derivedLegacyAssociations: number;
}

interface BuildPlan {
  readonly records: readonly MemoryRecord[];
  readonly contentHashes: ReadonlyMap<string, string>;
  readonly graph: StrictGraph;
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
  let candidateName: string | undefined;
  let activated = false;
  try {
    const root = lease.root;
    const rootIdentity = identityOf(root);
    const manifestState = captureManagedManifestState(root);
    const priorManifest = readManagedIndexManifest(root);
    assertNoActiveSqliteWriter(resolveActiveMemoryDbPath(root));
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

    const db = openMemoryDb({
      path: generation.dbPath,
      ...(options.embeddings === undefined ? {} : { embeddings: options.embeddings }),
      ...(options.dim === undefined ? {} : { dim: options.dim }),
    });
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
      for (const entity of plan.graph.entities) db.upsertEntity(entity);
      for (const relation of plan.graph.relations) {
        db.addEntityRelation(relation.src, relation.dst, relation.relation, relation.createdAt);
      }
      for (const association of plan.graph.associations) db.associateMemory(association);
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
      await options.hooks?.afterCandidateBuilt?.();
      db.checkpoint();
    } finally {
      db.close();
    }
    await options.hooks?.afterCandidateClosed?.();
    fsyncFile(generation.dbPath);
    fsyncDirectory(generation.dir);
    validateCandidate(generation.dbPath, descriptor, plan);
    const candidateDbIdentity = identityOf(generation.dbPath);
    const candidateDigest = fileDigest(generation.dbPath);
    await options.hooks?.afterCandidateValidated?.();
    await options.hooks?.beforeSourceCas?.();
    const rollback = await snapshotCurrentRollback(root, priorManifest?.active, rollbackSnapshot);
    const rollbackPath = rollback === undefined ? undefined : managedGenerationDbPath(root, rollback.name, true);
    const rollbackIdentity = rollbackPath === undefined ? undefined : identityOf(rollbackPath);
    const rollbackDigest = rollbackPath === undefined ? undefined : fileDigest(rollbackPath);
    if (rollbackPath !== undefined && rollback !== undefined) validateRetainedGeneration(rollbackPath, rollback);
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
      assertSameIdentity(generation.dir, generationIdentity, "candidate generation");
      assertSameIdentity(generation.dbPath, candidateDbIdentity, "candidate database");
      if (fileDigest(generation.dbPath) !== candidateDigest) {
        throw new Error("memory-rebuild: candidate database changed after validation.");
      }
      validateCandidate(generation.dbPath, descriptor, plan);
      if (rollbackPath !== undefined && rollbackIdentity !== undefined && rollbackDigest !== undefined && rollback !== undefined) {
        assertSameIdentity(rollbackPath, rollbackIdentity, "retained rollback database");
        if (fileDigest(rollbackPath) !== rollbackDigest) {
          throw new Error("memory-rebuild: retained rollback database changed after validation.");
        }
        validateRetainedGeneration(rollbackPath, rollback);
      }
      assertManagedManifestState(root, manifestState);
    };
    assertFinalCas();
    const nextManifest: ManagedIndexManifest = {
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      active: descriptor,
      ...(rollback === undefined ? {} : { rollback }),
    };
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
  } catch (error) {
    // A generation referenced by a renamed manifest must never be deleted. Other
    // candidates are intentionally retained as orphans for explicit inspection;
    // the resolver never auto-adopts them.
    if (activated && candidateName === undefined) throw new Error("memory-rebuild: activated generation identity was lost.");
    throw error;
  } finally {
    lease.release();
  }
}

/** Atomically swap active/rollback after validating the retained target. No provider call is made. */
export async function rollbackMemoryIndex(options: SafeMemoryIndexOptions): Promise<SafeMemoryIndexResult> {
  assertSafeRebuildOptions(options);
  const lease = acquireMemoryWriterLease(options.root);
  try {
    const root = lease.root;
    const rootIdentity = identityOf(root);
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
    validateRetainedGeneration(targetPath, target);
    const targetIdentity = identityOf(targetPath);
    const targetDigest = fileDigest(targetPath);
    const currentPath = managedGenerationDbPath(root, manifest.active.name, true);
    validateRetainedGeneration(currentPath, manifest.active);
    const currentIdentity = identityOf(currentPath);
    const currentDigest = fileDigest(currentPath);
    const next: ManagedIndexManifest = {
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      active: target,
      rollback: manifest.active,
    };
    const assertFinalRollbackCas = (): void => {
      assertSameIdentity(root, rootIdentity, "memory root");
      assertSameIdentity(targetPath, targetIdentity, "rollback target database");
      assertSameIdentity(currentPath, currentIdentity, "current active database");
      if (fileDigest(targetPath) !== targetDigest || fileDigest(currentPath) !== currentDigest) {
        throw new Error("memory-rebuild: active or rollback database changed after validation.");
      }
      if (snapshotCanonicalSources(root, target.tier).fingerprint !== target.sourceFingerprint) {
        throw new Error("memory-rebuild: canonical source changed before rollback activation.");
      }
      validateRetainedGeneration(targetPath, target);
      validateRetainedGeneration(currentPath, manifest.active);
      assertManagedManifestState(root, manifestState);
    };
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
      rollback: managedGenerationDbPath(root, manifest.active.name, true),
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
    lease.release();
  }
}

function snapshotCanonicalSources(root: string, tier: BujoTier): SourceSnapshot {
  const canonicalRoot = canonicalMemoryRoot(root, false);
  const dailyDir = join(canonicalRoot, "daily");
  const files: SourceFileSnapshot[] = [];
  const dailyNames = new Set<string>();
  if (existsSync(dailyDir)) {
    assertSafeDirectory(canonicalRoot, dailyDir, "canonical daily source directory");
    for (const name of readdirSync(dailyDir).filter((file) => file.endsWith(".md")).sort()) {
      dailyNames.add(name);
    }
  }
  // Older stores placed dated logs at the root. A canonical daily/<date>.md
  // wins when both layouts contain the same date, matching operator preview.
  for (const name of readdirSync(canonicalRoot).filter((file) => LEGACY_DAILY_FILE.test(file)).sort()) {
    if (dailyNames.has(name)) continue;
    const path = join(canonicalRoot, name);
    files.push(readStableSourceFile(canonicalRoot, path, name));
  }
  if (existsSync(dailyDir)) {
    for (const name of [...dailyNames].sort()) {
      const path = join(dailyDir, name);
      files.push(readStableSourceFile(canonicalRoot, path, `daily/${name}`));
    }
  }
  let graph: SourceFileSnapshot | undefined;
  const graphPath = join(canonicalRoot, "graph.jsonl");
  if (tier === "bujo" && existsSync(graphPath)) graph = readStableSourceFile(canonicalRoot, graphPath, "graph.jsonl");
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

function readStableSourceFile(root: string, path: string, relativePath: string): SourceFileSnapshot {
  assertSafeRegularFile(root, path, `canonical source ${relativePath}`);
  const before = identityOf(path);
  const bytes = readFileSync(path);
  const after = identityOf(path);
  if (!sameIdentity(before, after) || bytes.length !== after.size) {
    throw new Error(`memory-rebuild: canonical source ${relativePath} changed while it was read.`);
  }
  return { relativePath, bytes };
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

  const graph = tier === "bujo" ? parseStrictGraph(snapshot.graph, records) : emptyGraph();
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

function parseStrictGraph(source: SourceFileSnapshot | undefined, memories: ReadonlyMap<string, MemoryRecord>): StrictGraph {
  if (source === undefined) return emptyGraph();
  const entities = new Map<string, EntityRecord>();
  const relations = new Map<string, EntityRelationRecord>();
  const associations = new Map<string, MemoryEntityAssociation>();
  const lines = source.bytes.toString("utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]?.trim() ?? "";
    if (raw.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`memory-rebuild: malformed graph JSON at graph.jsonl:${index + 1}.`);
    }
    if (!isRecord(value)) throw new Error(`memory-rebuild: graph record at line ${index + 1} is not an object.`);
    if (value.kind === "entity") {
      const entity = strictEntity(value, index + 1);
      // graph.jsonl is an append log: validated later records update earlier
      // names/types/summaries for the same stable entity id.
      entities.set(entity.id, entity);
    } else if (value.kind === "relation") {
      const relation = strictRelation(value, index + 1);
      relations.set(`${relation.src}\0${relation.dst}\0${relation.relation}`, relation);
    } else if (value.kind === "association") {
      const association = strictAssociation(value, index + 1);
      associations.set(`${association.memoryId}\0${association.entityId}`, association);
    } else {
      throw new Error(`memory-rebuild: unknown graph kind at graph.jsonl:${index + 1}.`);
    }
  }
  for (const relation of relations.values()) {
    if (!entities.has(relation.src) || !entities.has(relation.dst)) {
      throw new Error(`memory-rebuild: graph relation has an orphan endpoint (${relation.src} -> ${relation.dst}).`);
    }
  }
  for (const association of associations.values()) {
    if (!memories.has(association.memoryId) || !entities.has(association.entityId)) {
      throw new Error(`memory-rebuild: graph association has an orphan endpoint (${association.memoryId} -> ${association.entityId}).`);
    }
  }
  let derivedLegacyAssociations = 0;
  const uniqueNames = new Map<string, EntityRecord | undefined>();
  for (const entity of entities.values()) {
    const key = normalizedNameWords(entity.name).join("\0");
    if (key.length === 0) continue;
    uniqueNames.set(key, uniqueNames.has(key) ? undefined : entity);
  }
  const memoriesWithCanonicalAssociations = new Set(
    [...associations.values()].map((association) => association.memoryId),
  );
  for (const memory of memories.values()) {
    if (memoriesWithCanonicalAssociations.has(memory.id)) continue;
    const memoryWords = normalizedNameWords(memory.text);
    for (const [key, entity] of uniqueNames) {
      if (entity === undefined) continue;
      const words = key.split("\0");
      if (!containsPhrase(memoryWords, words)) continue;
      const associationKey = `${memory.id}\0${entity.id}`;
      if (associations.has(associationKey)) continue;
      associations.set(associationKey, {
        memoryId: memory.id,
        entityId: entity.id,
        provenance: "legacy-name-match",
        createdAt: memory.createdAt,
      });
      derivedLegacyAssociations += 1;
    }
  }
  return {
    entities: [...entities.values()],
    relations: [...relations.values()],
    associations: [...associations.values()],
    derivedLegacyAssociations,
  };
}

function strictEntity(value: Record<string, unknown>, line: number): EntityRecord {
  const id = requiredString(value.id, "entity id", line);
  const name = requiredString(value.name, "entity name", line);
  const createdAt = requiredTimestamp(value.createdAt, "entity createdAt", line);
  const type = optionalString(value.type);
  const summary = optionalString(value.summary);
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
    throw new Error(`memory-rebuild: invalid association provenance at graph.jsonl:${line}.`);
  }
  return {
    memoryId: requiredString(value.memoryId, "association memoryId", line),
    entityId: requiredString(value.entityId, "association entityId", line),
    provenance,
    createdAt: requiredTimestamp(value.createdAt, "association createdAt", line),
  };
}

function validateCandidate(path: string, descriptor: ManagedGeneration, plan: BuildPlan): void {
  const db = readOnlyDb(path, descriptor);
  try {
    validateDb(db, descriptor);
    const state = db.validationSnapshot();
    const expectedVectors = descriptor.tier === "lite" ? 0 : plan.records.length;
    if (state.memories !== plan.records.length || state.ftsRows !== plan.records.length || state.ftsMismatches !== 0) {
      throw new Error("memory-rebuild: candidate memory/FTS coverage validation failed.");
    }
    const actualMemories = plan.records.map((record) => db.get(record.id));
    if (stableJson(actualMemories.map(memoryPayload)) !== stableJson(plan.records.map(memoryPayload))) {
      throw new Error("memory-rebuild: candidate memory payload validation failed.");
    }
    if (state.vectors !== expectedVectors || state.vectorOrphans !== 0) {
      throw new Error("memory-rebuild: candidate vector coverage validation failed.");
    }
    if (state.entities !== plan.graph.entities.length || state.relations !== plan.graph.relations.length
      || state.associations !== plan.graph.associations.length || state.relationOrphans !== 0 || state.associationOrphans !== 0) {
      throw new Error("memory-rebuild: candidate graph coverage or endpoint validation failed.");
    }
    const actualEntities = plan.graph.entities.map((entity) => db.getEntity(entity.id));
    const actualRelations = [...new Set(plan.graph.relations.map((relation) => relation.src))]
      .flatMap((src) => db.relationsFor(src));
    const actualAssociations = [...new Set(plan.graph.associations.map((association) => association.memoryId))]
      .flatMap((memoryId) => db.associationsForMemory(memoryId));
    if (stableJson(actualEntities) !== stableJson(plan.graph.entities)
      || stableJson(actualRelations) !== stableJson(plan.graph.relations)
      || stableJson(actualAssociations) !== stableJson(plan.graph.associations)) {
      throw new Error("memory-rebuild: candidate graph payload validation failed.");
    }
    if (descriptor.tier === "journal") {
      if (state.contentHashes !== plan.contentHashes.size || state.contentHashOrphans !== 0) {
        throw new Error("memory-rebuild: Journal content-hash bijection validation failed.");
      }
      const actual = db.contentHashRecords();
      for (const hash of actual) {
        const record = db.get(hash.memoryId);
        if (record === undefined || normalizedContentHash(record.text) !== hash.contentHash
          || plan.contentHashes.get(hash.contentHash) !== hash.memoryId) {
          throw new Error("memory-rebuild: Journal content-hash correctness validation failed.");
        }
      }
    } else if (state.contentHashes !== 0) {
      throw new Error("memory-rebuild: non-Journal candidate unexpectedly contains content hashes.");
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
    if (state.ftsRows !== state.memories || state.ftsMismatches !== 0 || state.vectorOrphans !== 0
      || state.contentHashOrphans !== 0 || state.relationOrphans !== 0 || state.associationOrphans !== 0) {
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

async function adoptLegacyRollback(
  root: string,
): Promise<ManagedGeneration | undefined> {
  const legacyPath = join(root, "memory.db");
  if (!existsSync(legacyPath)) return undefined;
  assertSafeRegularFile(root, legacyPath, "legacy memory database");
  const generation = createManagedGeneration(root);
  const actualDimension = await backupRawSqlite(legacyPath, generation.dbPath);
  const copy = openMemoryDb({ path: generation.dbPath, dim: actualDimension });
  let embeddingModel: string | undefined;
  let tier: BujoTier;
  let sourceFingerprint: string;
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
    const source = snapshotCanonicalSources(root, tier);
    sourceFingerprint = source.fingerprint;
    copy.setIndexMetadata({
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      policyVersion: MEMORY_REBUILD_POLICY_VERSION,
      tier,
      sourceFingerprint,
      generation: generation.name,
      createdAt,
      ...(embeddingModel === undefined ? {} : { embeddingModel, dimension: actualDimension }),
    });
    copy.checkpoint();
  } finally {
    copy.close();
  }
  const descriptor: ManagedGeneration = {
    name: generation.name,
    tier,
    sourceFingerprint,
    policyVersion: MEMORY_REBUILD_POLICY_VERSION,
    createdAt,
    origin: "legacy-snapshot",
    ...(embeddingModel === undefined ? {} : { embeddingModel, dimension: actualDimension }),
  };
  fsyncFile(generation.dbPath);
  fsyncDirectory(generation.dir);
  validateRetainedGeneration(generation.dbPath, descriptor);
  return descriptor;
}

async function snapshotCurrentRollback(
  root: string,
  active: ManagedGeneration | undefined,
  snapshot: SourceSnapshot,
): Promise<ManagedGeneration | undefined> {
  if (active === undefined) return await adoptLegacyRollback(root);
  if (active.sourceFingerprint === snapshot.fingerprint) {
    validateRetainedGeneration(managedGenerationDbPath(root, active.name, true), active);
    return active;
  }
  return await snapshotDatabaseForRollback(
    root,
    managedGenerationDbPath(root, active.name, true),
    snapshot,
    active.tier,
    active,
  );
}

async function snapshotDatabaseForRollback(
  root: string,
  sourcePath: string,
  snapshot: SourceSnapshot,
  tier: BujoTier,
  preservedIdentity?: ManagedGeneration,
): Promise<ManagedGeneration> {
  const generation = createManagedGeneration(root);
  const actualDimension = await backupRawSqlite(sourcePath, generation.dbPath);
  const source = openMemoryDb({ path: generation.dbPath, dim: actualDimension });
  let embeddingModel: string | undefined;
  try {
    const models = source.validationSnapshot().embeddingModels;
    if (models.length > 1) throw new Error("memory-rebuild: active index contains multiple embedding model identities.");
    embeddingModel = preservedIdentity?.embeddingModel ?? models[0];
  } finally {
    source.close();
  }
  const createdAt = new Date().toISOString();
  const descriptor: ManagedGeneration = {
    name: generation.name,
    tier,
    sourceFingerprint: snapshot.fingerprint,
    policyVersion: MEMORY_REBUILD_POLICY_VERSION,
    createdAt,
    origin: "legacy-snapshot",
    ...(preservedIdentity?.skippedRawRecords === undefined ? {} : { skippedRawRecords: preservedIdentity.skippedRawRecords }),
    ...(preservedIdentity?.skippedUnstructuredRecords === undefined ? {} : { skippedUnstructuredRecords: preservedIdentity.skippedUnstructuredRecords }),
    ...(preservedIdentity?.skippedMissingIdentityRecords === undefined ? {} : { skippedMissingIdentityRecords: preservedIdentity.skippedMissingIdentityRecords }),
    ...(preservedIdentity?.missingIdentityLocations === undefined ? {} : { missingIdentityLocations: preservedIdentity.missingIdentityLocations }),
    ...(preservedIdentity?.skippedLegacySourceRecords === undefined ? {} : { skippedLegacySourceRecords: preservedIdentity.skippedLegacySourceRecords }),
    ...(preservedIdentity?.legacySourceLocations === undefined ? {} : { legacySourceLocations: preservedIdentity.legacySourceLocations }),
    ...(preservedIdentity?.skippedJournalDuplicateRecords === undefined ? {} : { skippedJournalDuplicateRecords: preservedIdentity.skippedJournalDuplicateRecords }),
    ...(preservedIdentity?.parsedSourceItems === undefined ? {} : { parsedSourceItems: preservedIdentity.parsedSourceItems }),
    ...(preservedIdentity?.derivedLegacyAssociations === undefined ? {} : { derivedLegacyAssociations: preservedIdentity.derivedLegacyAssociations }),
    ...(embeddingModel === undefined ? {} : {
      embeddingModel,
      dimension: preservedIdentity?.dimension ?? actualDimension,
    }),
  };
  const copy = openMemoryDb({ path: generation.dbPath, dim: actualDimension });
  try {
    copy.setIndexMetadata({
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      policyVersion: MEMORY_REBUILD_POLICY_VERSION,
      tier,
      sourceFingerprint: snapshot.fingerprint,
      generation: generation.name,
      createdAt,
      ...(preservedIdentity?.skippedRawRecords === undefined ? {} : { skippedRawRecords: preservedIdentity.skippedRawRecords }),
      ...(preservedIdentity?.skippedUnstructuredRecords === undefined ? {} : { skippedUnstructuredRecords: preservedIdentity.skippedUnstructuredRecords }),
      ...(preservedIdentity?.skippedMissingIdentityRecords === undefined ? {} : { skippedMissingIdentityRecords: preservedIdentity.skippedMissingIdentityRecords }),
      ...(preservedIdentity?.missingIdentityLocations === undefined ? {} : { missingIdentityLocations: preservedIdentity.missingIdentityLocations }),
      ...(preservedIdentity?.skippedLegacySourceRecords === undefined ? {} : { skippedLegacySourceRecords: preservedIdentity.skippedLegacySourceRecords }),
      ...(preservedIdentity?.legacySourceLocations === undefined ? {} : { legacySourceLocations: preservedIdentity.legacySourceLocations }),
      ...(preservedIdentity?.skippedJournalDuplicateRecords === undefined ? {} : { skippedJournalDuplicateRecords: preservedIdentity.skippedJournalDuplicateRecords }),
      ...(preservedIdentity?.parsedSourceItems === undefined ? {} : { parsedSourceItems: preservedIdentity.parsedSourceItems }),
      ...(preservedIdentity?.derivedLegacyAssociations === undefined ? {} : { derivedLegacyAssociations: preservedIdentity.derivedLegacyAssociations }),
      ...(embeddingModel === undefined ? {} : {
        embeddingModel,
        dimension: preservedIdentity?.dimension ?? actualDimension,
      }),
    });
    copy.checkpoint();
  } finally {
    copy.close();
  }
  fsyncFile(generation.dbPath);
  fsyncDirectory(generation.dir);
  validateRetainedGeneration(generation.dbPath, descriptor);
  return descriptor;
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

function emptyGraph(): StrictGraph {
  return { entities: [], relations: [], associations: [], derivedLegacyAssociations: 0 };
}

function isLegacyHostObservation(text: string): boolean {
  return text.startsWith("Host-observed completed turn.")
    || text.startsWith("Host-observed completed trigger turn.");
}

function normalizedNameWords(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsPhrase(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((word, offset) => haystack[index + offset] === word)) return true;
  }
  return false;
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

function memoryPayload(record: MemoryRecord | undefined): unknown {
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
    ...(record.validTo === undefined ? {} : { validTo: record.validTo }),
    ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
    ...(record.supersededAt === undefined ? {} : { supersededAt: record.supersededAt }),
    ...(record.dueAt === undefined ? {} : { dueAt: record.dueAt }),
    ...(record.collection === undefined ? {} : { collection: record.collection }),
    tags: [...record.tags],
    source: { ...record.source },
  };
}

function requiredString(value: unknown, label: string, line: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`memory-rebuild: missing ${label} at graph.jsonl:${line}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredTimestamp(value: unknown, label: string, line: number): string {
  const timestamp = requiredString(value, label, line);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`memory-rebuild: invalid ${label} at graph.jsonl:${line}.`);
  return timestamp;
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
