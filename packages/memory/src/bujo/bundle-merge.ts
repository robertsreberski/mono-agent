import { createHash } from "node:crypto";

import type { EntityRecord, MemoryRecord } from "../store/index.js";

import { parseDailyFile } from "./grammar.js";
import {
  mergeEntityRecord,
  projectCanonicalGraph,
  type CanonicalGraphRecords,
} from "./graph.js";
import { assertCanonicalDailySourcePath } from "./path-safety.js";
import type { CanonicalMergeSnapshot } from "./rebuild.js";
import {
  mergeReplayProjection,
  REPLAY_PROJECTION_FILE,
  serializeReplayProjection,
  type ReplayProjectionDelta,
  type ReplayProjectionV1,
} from "./replay-projection.js";

/**
 * Pure, I/O-free reconciliation of two canonical BuJo corpora.
 *
 * Everything here operates on parsed bytes so a merge can be fully validated
 * before any destination file is touched. Bullets are carried as their
 * *verbatim* markdown blocks rather than re-serialized from `MemoryRecord`,
 * because `MemoryRecord` drops `refs` — re-serializing would silently discard
 * markdown-only provenance.
 *
 * Composite keys and digest inputs are built with `JSON.stringify` rather than
 * delimiter joins so no field value can forge a key boundary.
 */

const LEGACY_DAILY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/u;

export type MemoryBundleIdConflictPolicy = "fail" | "skip";
export type MemoryBundleEntityConflictPolicy = "target" | "source";

export interface MemoryBundleMergeOptions {
  /** Behaviour when an incoming memory id already exists with different bytes. Default `"fail"`. */
  readonly onConflict?: MemoryBundleIdConflictPolicy;
  /** Which side wins an entity-slug collision. Default `"target"`. */
  readonly entityConflict?: MemoryBundleEntityConflictPolicy;
}

export interface MemoryBundleDailyAppend {
  /** Destination-relative canonical daily path: `daily/<date>.md` or root legacy `<date>.md`. */
  readonly relativePath: string;
  /** Verbatim two-line bullet blocks, in incoming order. */
  readonly blocks: readonly string[];
}

export interface MemoryBundleEntityDiscard {
  readonly entityId: string;
  readonly fields: readonly string[];
}

export interface MemoryBundleMergeCounts {
  readonly newMemories: number;
  readonly identicalMemories: number;
  readonly conflictingMemories: number;
  readonly targetDailyFiles: number;
  readonly newEntities: number;
  readonly discardedEntities: number;
  readonly newRelations: number;
  readonly newAssociations: number;
  readonly skippedAssociations: number;
  readonly newTerminals: number;
  readonly skippedTerminals: number;
  readonly newSupersedes: number;
  readonly skippedSupersedes: number;
  readonly newThreads: number;
  readonly skippedThreads: number;
  readonly derivedAssociationsAdded: number;
  readonly derivedAssociationsRemoved: number;
}

export interface MemoryBundleMergePlan {
  readonly dailyAppends: readonly MemoryBundleDailyAppend[];
  readonly graphLines: readonly string[];
  readonly replayDelta: ReplayProjectionDelta;
  readonly importedMemoryIds: readonly string[];
  readonly identicalMemoryIds: readonly string[];
  readonly skippedMemoryIds: readonly string[];
  readonly entityDiscards: readonly MemoryBundleEntityDiscard[];
  /** Pre-existing destination memories that GAIN a derived association from imported entities. */
  readonly derivedAssociationsAdded: readonly string[];
  /** Pre-existing destination memories that LOSE a derived association. Gated by an explicit flag. */
  readonly derivedAssociationsRemoved: readonly string[];
  readonly counts: MemoryBundleMergeCounts;
  /** Independently derived commitment to the exact post-write canonical corpus. */
  readonly expectedSourceFingerprint: string;
  /** Commitment to the exact ordered write plan; apply must reproduce it. */
  readonly digest: string;
}

export type MemoryBundleMergeErrorCode =
  | "id_conflict"
  | "unsupported_daily_path"
  | "replay_conflict";

export class MemoryBundleMergeError extends Error {
  constructor(readonly code: MemoryBundleMergeErrorCode, message: string, cause?: unknown) {
    super(`memory-bundle: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "MemoryBundleMergeError";
  }
}

interface BulletEntry {
  readonly id: string;
  readonly raw: string;
  readonly relativePath: string;
}

interface DerivedPair {
  readonly memoryId: string;
  readonly entityId: string;
}

export function mergeCanonicalMemoryBundles(
  destination: CanonicalMergeSnapshot,
  incoming: CanonicalMergeSnapshot,
  options: MemoryBundleMergeOptions = {},
): MemoryBundleMergePlan {
  const onConflict = options.onConflict ?? "fail";
  const entityConflict = options.entityConflict ?? "target";

  const destinationBullets = readBullets(destination);
  const incomingBullets = readBullets(incoming);
  const destinationPaths = new Set(destination.daily.map((source) => source.relativePath));

  const imported: BulletEntry[] = [];
  const identical: string[] = [];
  const skipped: string[] = [];
  for (const entry of incomingBullets.values()) {
    const existing = destinationBullets.get(entry.id);
    if (existing === undefined) {
      imported.push(entry);
      continue;
    }
    if (existing.raw === entry.raw) {
      // Re-importing the same bundle is a no-op rather than a conflict.
      identical.push(entry.id);
      continue;
    }
    skipped.push(entry.id);
  }
  if (skipped.length > 0 && onConflict === "fail") {
    // Capture ids are sha256(runId) plus an ordinal and memory ids are ULIDs,
    // so a collision is never evidence of the same fact. Renaming is
    // impossible without rewriting every graph association and replay endpoint
    // that references the id, so the only safe policies are fail or keep-target.
    throw new MemoryBundleMergeError(
      "id_conflict",
      `${skipped.length} incoming memory id(s) already exist with different content; `
      + "re-run with --on-conflict skip to keep the destination's version.",
    );
  }

  const importedIds = new Set(imported.map((entry) => entry.id));
  const skippedIds = new Set(skipped);
  const dailyAppends = groupDailyAppends(imported, destinationPaths);

  const graph = mergeGraph(destination, incoming, importedIds, skippedIds, entityConflict);
  // A skipped collision keeps the destination memory, not the incoming memory
  // that merely shares its id. Replay authority describing the rejected memory
  // must therefore be dropped just like its graph associations. Keeping even
  // one terminal or edge endpoint would apply lifecycle semantics from the
  // wrong memory and can make the written corpus unrebuildable.
  const replay = filterSkippedReplayEntries(incoming.replay, skippedIds);
  const replayDelta = replay.delta;
  const mergedReplay = assertReplayMergeable(destination.replay, replayDelta);

  const drift = derivedAssociationDrift(destination, graph.mergedRecords, graph.mergedGraph);

  const counts: MemoryBundleMergeCounts = {
    newMemories: imported.length,
    identicalMemories: identical.length,
    conflictingMemories: skipped.length,
    targetDailyFiles: dailyAppends.length,
    newEntities: graph.newEntities,
    discardedEntities: graph.discards.length,
    newRelations: graph.newRelations,
    newAssociations: graph.newAssociations,
    skippedAssociations: graph.skippedAssociations,
    newTerminals: replayDelta.terminals?.length ?? 0,
    skippedTerminals: replay.skippedTerminals,
    newSupersedes: replayDelta.supersedes?.length ?? 0,
    skippedSupersedes: replay.skippedSupersedes,
    newThreads: replayDelta.threads?.length ?? 0,
    skippedThreads: replay.skippedThreads,
    derivedAssociationsAdded: drift.added.length,
    derivedAssociationsRemoved: drift.removed.length,
  };

  const expectedSourceFingerprint = expectedMergedSourceFingerprint(
    destination,
    dailyAppends,
    graph.lines,
    replayDelta,
    mergedReplay,
  );

  const plan = {
    dailyAppends,
    graphLines: graph.lines,
    replayDelta,
    importedMemoryIds: imported.map((entry) => entry.id),
    identicalMemoryIds: identical,
    skippedMemoryIds: skipped,
    entityDiscards: graph.discards,
    derivedAssociationsAdded: drift.added,
    derivedAssociationsRemoved: drift.removed,
    counts,
    expectedSourceFingerprint,
  };
  return { ...plan, digest: digestMergePlan(plan, onConflict, entityConflict) };
}

interface FilteredReplayDelta {
  readonly delta: ReplayProjectionDelta;
  readonly skippedTerminals: number;
  readonly skippedSupersedes: number;
  readonly skippedThreads: number;
}

function filterSkippedReplayEntries(
  incoming: ReplayProjectionV1,
  skippedIds: ReadonlySet<string>,
): FilteredReplayDelta {
  const terminals = incoming.terminals.filter((entry) => !skippedIds.has(entry.id));
  const supersedes = incoming.supersedes.filter(
    (entry) => !skippedIds.has(entry.src) && !skippedIds.has(entry.dst),
  );
  const threads = incoming.threads.filter(
    (entry) => !skippedIds.has(entry.src) && !skippedIds.has(entry.dst),
  );
  return {
    delta: { terminals, supersedes, threads },
    skippedTerminals: incoming.terminals.length - terminals.length,
    skippedSupersedes: incoming.supersedes.length - supersedes.length,
    skippedThreads: incoming.threads.length - threads.length,
  };
}

function readBullets(snapshot: CanonicalMergeSnapshot): Map<string, BulletEntry> {
  const bullets = new Map<string, BulletEntry>();
  for (const source of snapshot.daily) {
    // A non-dated name under daily/ indexes fine but can never be rewritten by
    // migrate or forget, so it must not enter a merge in either direction.
    try {
      assertCanonicalDailySourcePath(source.relativePath);
    } catch (error) {
      throw new MemoryBundleMergeError(
        "unsupported_daily_path",
        `canonical source "${source.relativePath}" is not a dated daily file.`,
        error,
      );
    }
    const parsed = parseDailyFile(source.bytes.toString("utf8"));
    for (const line of parsed.lines) {
      if (line.bullet === undefined) continue;
      bullets.set(line.bullet.id, {
        id: line.bullet.id,
        raw: line.raw,
        relativePath: source.relativePath,
      });
    }
  }
  return bullets;
}

/**
 * Resolve every imported bullet onto a canonical destination daily path.
 *
 * A root-legacy incoming file promotes into `daily/<date>.md` unless the
 * destination still keeps that date in the legacy layout, mirroring the
 * "daily wins" precedence the rebuild planner applies.
 */
function groupDailyAppends(
  imported: readonly BulletEntry[],
  destinationPaths: ReadonlySet<string>,
): MemoryBundleDailyAppend[] {
  const grouped = new Map<string, string[]>();
  for (const entry of imported) {
    const target = LEGACY_DAILY_FILE.test(entry.relativePath) && !destinationPaths.has(entry.relativePath)
      ? `daily/${entry.relativePath}`
      : entry.relativePath;
    assertCanonicalDailySourcePath(target);
    const blocks = grouped.get(target);
    if (blocks === undefined) grouped.set(target, [entry.raw]);
    else blocks.push(entry.raw);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([relativePath, blocks]) => ({ relativePath, blocks }));
}

interface GraphMergeResult {
  readonly lines: readonly string[];
  readonly discards: readonly MemoryBundleEntityDiscard[];
  readonly newEntities: number;
  readonly newRelations: number;
  readonly newAssociations: number;
  readonly skippedAssociations: number;
  readonly mergedGraph: CanonicalGraphRecords;
  readonly mergedRecords: readonly MemoryRecord[];
}

function mergeGraph(
  destination: CanonicalMergeSnapshot,
  incoming: CanonicalMergeSnapshot,
  importedIds: ReadonlySet<string>,
  skippedIds: ReadonlySet<string>,
  entityConflict: MemoryBundleEntityConflictPolicy,
): GraphMergeResult {
  const destinationEntities = new Map(destination.graph.entities.map((entity) => [entity.id, entity]));
  const lines: string[] = [];
  const discards: MemoryBundleEntityDiscard[] = [];
  const mergedEntities = new Map(destinationEntities);
  let newEntities = 0;

  for (const entity of incoming.graph.entities) {
    const existing = destinationEntities.get(entity.id);
    if (existing === undefined) {
      lines.push(JSON.stringify({ ...entity, kind: "entity" }));
      mergedEntities.set(entity.id, entity);
      newEntities += 1;
      continue;
    }
    const fields = changedEntityFields(existing, entity);
    if (fields.length === 0) continue;
    if (entityConflict === "target") {
      // The agent being kept alive owns its curated entity metadata; the
      // incoming values are reported rather than applied.
      discards.push({ entityId: entity.id, fields });
      continue;
    }
    // Source wins: re-assert through the append-log fold so the earlier
    // createdAt is preserved instead of regressing to the incoming record's.
    const merged = mergeEntityRecord(existing, entity);
    lines.push(JSON.stringify({ ...merged, kind: "entity" }));
    mergedEntities.set(entity.id, merged);
  }

  const relationKeys = new Set(
    destination.graph.relations.map((relation) => pairKey(relation.src, relation.dst, relation.relation)),
  );
  const mergedRelations = [...destination.graph.relations];
  let newRelations = 0;
  for (const relation of incoming.graph.relations) {
    const key = pairKey(relation.src, relation.dst, relation.relation);
    if (relationKeys.has(key)) continue;
    if (!mergedEntities.has(relation.src) || !mergedEntities.has(relation.dst)) continue;
    relationKeys.add(key);
    lines.push(JSON.stringify({ ...relation, kind: "relation" }));
    mergedRelations.push(relation);
    newRelations += 1;
  }

  const associationKeys = new Set(
    destination.graph.associations.map((association) => pairKey(association.memoryId, association.entityId)),
  );
  const destinationMemoryIds = new Set(destination.records.map((record) => record.id));
  const mergedAssociations = [...destination.graph.associations];
  let newAssociations = 0;
  let skippedAssociations = 0;
  for (const association of incoming.graph.associations) {
    const key = pairKey(association.memoryId, association.entityId);
    if (associationKeys.has(key)) continue;
    // A conflicting id kept the destination's bullet, so the incoming
    // association describes a *different* memory that merely shares an id.
    // Attaching it to the surviving memory would be a silent semantic error.
    if (skippedIds.has(association.memoryId)) {
      skippedAssociations += 1;
      continue;
    }
    if (!importedIds.has(association.memoryId) && !destinationMemoryIds.has(association.memoryId)) {
      skippedAssociations += 1;
      continue;
    }
    if (!mergedEntities.has(association.entityId)) {
      skippedAssociations += 1;
      continue;
    }
    associationKeys.add(key);
    // provenance is carried verbatim: the strict parser accepts only the two
    // known literals, and repairability analysis depends on the distinction.
    lines.push(JSON.stringify({ ...association, kind: "association" }));
    mergedAssociations.push(association);
    newAssociations += 1;
  }

  const mergedRecords = [
    ...destination.records,
    ...incoming.records.filter((record) => importedIds.has(record.id)),
  ];
  return {
    lines,
    discards,
    newEntities,
    newRelations,
    newAssociations,
    skippedAssociations,
    mergedGraph: {
      entities: [...mergedEntities.values()],
      relations: mergedRelations,
      associations: mergedAssociations,
    },
    mergedRecords,
  };
}

function changedEntityFields(current: EntityRecord, next: EntityRecord): string[] {
  const fields: string[] = [];
  if (current.name !== next.name) fields.push("name");
  if (current.type !== next.type) fields.push("type");
  if (current.summary !== next.summary) fields.push("summary");
  return fields;
}

function assertReplayMergeable(base: ReplayProjectionV1, delta: ReplayProjectionDelta): ReplayProjectionV1 {
  try {
    // Delegates every lifecycle conflict rule already owned by the replay
    // authority: conflicting authority for one key, duplicate supersede
    // destinations, terminal/supersede topology conflicts, cycles across the
    // union, thread fan-out, and the entry/byte caps.
    return mergeReplayProjection(base, delta);
  } catch (error) {
    throw new MemoryBundleMergeError(
      "replay_conflict",
      `replay projections cannot be merged: ${(error as Error).message}`,
      error,
    );
  }
}

/**
 * Reproduce the exact canonical bytes the apply phase will write, without I/O.
 *
 * This is intentionally separate from the post-write fingerprint reader. Apply
 * compares that independent plan commitment with the rebuilt root, so a valid
 * but unplanned source mutation cannot bless itself by being read twice.
 */
function expectedMergedSourceFingerprint(
  destination: CanonicalMergeSnapshot,
  dailyAppends: readonly MemoryBundleDailyAppend[],
  graphLines: readonly string[],
  replayDelta: ReplayProjectionDelta,
  mergedReplay: ReplayProjectionV1,
): string {
  const daily = new Map(destination.daily.map((source) => [source.relativePath, Buffer.from(source.bytes)]));
  for (const append of dailyAppends) {
    const existing = daily.get(append.relativePath) ?? Buffer.alloc(0);
    const date = /^(?:daily\/)?(\d{4}-\d{2}-\d{2})\.md$/u.exec(append.relativePath)?.[1];
    if (date === undefined) throw new Error(`memory-bundle: unsupported daily target ${append.relativePath}.`);
    const body = append.blocks.map((block) => `${block}\n`).join("");
    daily.set(
      append.relativePath,
      Buffer.concat([
        existing,
        Buffer.from(`${existing.length === 0 ? `# ${date}\n\n` : ""}${body}`, "utf8"),
      ]),
    );
  }

  const nestedDailyNames = new Set(
    [...daily.keys()].filter((path) => path.startsWith("daily/")).map((path) => path.slice("daily/".length)),
  );
  const dailyEntries = [
    ...[...daily.entries()]
      .filter(([path]) => LEGACY_DAILY_FILE.test(path) && !nestedDailyNames.has(path))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ...[...daily.entries()]
      .filter(([path]) => path.startsWith("daily/"))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ];

  let graphBytes = destination.graphBytes;
  if (graphLines.length > 0) {
    graphBytes = Buffer.concat([
      graphBytes ?? Buffer.alloc(0),
      Buffer.from(graphLines.map((line) => `${line}\n`).join(""), "utf8"),
    ]);
  }

  const replayEntries = (replayDelta.terminals?.length ?? 0)
    + (replayDelta.supersedes?.length ?? 0)
    + (replayDelta.threads?.length ?? 0);
  const replayBytes = replayEntries === 0
    ? destination.replayBytes
    : Buffer.from(serializeReplayProjection(mergedReplay), "utf8");
  const entries = [
    ...dailyEntries,
    ...(graphBytes === undefined ? [] : [["graph.jsonl", graphBytes] as const]),
    ...(replayBytes === undefined ? [] : [[REPLAY_PROJECTION_FILE, replayBytes] as const]),
  ];
  const hash = createHash("sha256");
  for (const [relativePath, bytes] of entries) {
    hash.update(String(Buffer.byteLength(relativePath)));
    hash.update("\0");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

interface DerivedAssociationDrift {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Measure how importing entities rewires memories the operator never imported.
 *
 * `projectCanonicalGraph` derives a `legacy-name-match` association for every
 * memory that has no canonical association but whose text contains a unique
 * entity name. Adding an entity therefore attaches it to pre-existing
 * destination memories, and adding a second entity whose normalized name
 * collides with an existing one disables that whole name group, *removing*
 * associations the destination previously derived. Both are deterministic, so
 * neither surfaces as a rebuild failure — only as a silent semantic change.
 */
function derivedAssociationDrift(
  destination: CanonicalMergeSnapshot,
  mergedRecords: readonly MemoryRecord[],
  mergedGraph: CanonicalGraphRecords,
): DerivedAssociationDrift {
  const before = derivedAssociations(destination.graph, destination.records);
  const after = derivedAssociations(mergedGraph, mergedRecords);
  const destinationMemoryIds = new Set(destination.records.map((record) => record.id));
  const removed = [...before.entries()]
    .filter(([key]) => !after.has(key))
    .map(([, pair]) => describePair(pair))
    .sort();
  // Only pre-existing destination memories count as drift; a fresh association
  // on a freshly imported memory is the expected outcome, not a surprise.
  const added = [...after.entries()]
    .filter(([key, pair]) => !before.has(key) && destinationMemoryIds.has(pair.memoryId))
    .map(([, pair]) => describePair(pair))
    .sort();
  return { added, removed };
}

function derivedAssociations(
  graph: CanonicalGraphRecords,
  records: readonly MemoryRecord[],
): Map<string, DerivedPair> {
  const projection = projectCanonicalGraph(graph, records);
  const pairs = new Map<string, DerivedPair>();
  for (const association of projection.associations) {
    if (association.provenance !== "legacy-name-match") continue;
    pairs.set(pairKey(association.memoryId, association.entityId), {
      memoryId: association.memoryId,
      entityId: association.entityId,
    });
  }
  return pairs;
}

function describePair(pair: DerivedPair): string {
  return `${pair.memoryId} -> ${pair.entityId}`;
}

function pairKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function digestMergePlan(
  plan: Omit<MemoryBundleMergePlan, "digest">,
  onConflict: MemoryBundleIdConflictPolicy,
  entityConflict: MemoryBundleEntityConflictPolicy,
): string {
  // A structured, order-preserving commitment to exactly what apply will write.
  const commitment = [
    ["policy", onConflict, entityConflict],
    plan.dailyAppends.map((append) => [append.relativePath, append.blocks]),
    plan.graphLines,
    [
      plan.replayDelta.terminals ?? [],
      plan.replayDelta.supersedes ?? [],
      plan.replayDelta.threads ?? [],
    ],
    plan.skippedMemoryIds,
    plan.entityDiscards.map((discard) => [discard.entityId, discard.fields]),
    plan.derivedAssociationsAdded,
    plan.derivedAssociationsRemoved,
    plan.expectedSourceFingerprint,
  ];
  return createHash("sha256").update(JSON.stringify(commitment), "utf8").digest("hex");
}
