import { createHash } from "node:crypto";

import { assertSafeRelative, isSha256 } from "./durable-root-swap.js";

/**
 * On-disk contract for a portable memory bundle.
 *
 * A bundle is a directory, not an archive: the monorepo carries no archive
 * dependency and `copyTreeDurably` already provides no-follow, mode-preserving,
 * fsync-verified tree movement. Operators compress or copy it themselves.
 *
 * `source/` is deliberately shaped exactly like a memory root, so
 * `readBujoCanonicalSourceFingerprint` and the rebuild planner run against it
 * verbatim — validating a bundle is literally "parse it as a root".
 */

export const MEMORY_BUNDLE_SCHEMA_VERSION = 1;
export const MEMORY_BUNDLE_MANIFEST_FILE = "manifest.json";
/** The only directory an import ever reads. */
export const MEMORY_BUNDLE_SOURCE_DIR = "source";
/** Non-canonical companions. Copied for the operator; never imported. */
export const MEMORY_BUNDLE_EXTRAS_DIR = "extras";

export type MemoryBundleScope = "canonical" | "canonical+extras";

export interface MemoryBundleCounts {
  readonly dailyFiles: number;
  readonly memories: number;
  readonly graphEntities: number;
  readonly graphRelations: number;
  readonly graphAssociations: number;
  readonly replayTerminals: number;
  readonly replaySupersedes: number;
  readonly replayThreads: number;
}

export interface MemoryExportBundleManifest {
  readonly schemaVersion: typeof MEMORY_BUNDLE_SCHEMA_VERSION;
  readonly operation: "memory-export-bundle";
  readonly status: "complete";
  readonly tier: "bujo";
  readonly scope: MemoryBundleScope;
  /** sha256 of the exporting root's canonical path. Provenance only, never an import gate. */
  readonly sourceRootFingerprint: string;
  /** `readBujoCanonicalSourceFingerprint` of the exporting root at export time. */
  readonly sourceFingerprint: string;
  /** `memoryTreeFingerprint` of `<bundle>/source`; binds the exact copied bytes and modes. */
  readonly treeFingerprint: string;
  readonly extrasTreeFingerprint?: string;
  /**
   * ADVISORY PROVENANCE ONLY. Import re-embeds every record under the importing
   * agent's own provider, so these must never gate an import — a 768-dimension
   * bundle is expected to import cleanly into a 1536-dimension agent.
   */
  readonly embeddingModel?: string;
  readonly dimension?: number;
  readonly agentSourceId?: string;
  /** Present when exported over unreplayed durable work via `--allow-pending`. */
  readonly pendingWork?: true;
  readonly createdAt: string;
  readonly counts: MemoryBundleCounts;
  /** sha256 over the canonically serialized payload minus this field. */
  readonly bundleDigest: string;
}

export type MemoryBundleManifestPayload = Omit<MemoryExportBundleManifest, "bundleDigest">;

const COUNT_KEYS = [
  "dailyFiles",
  "memories",
  "graphEntities",
  "graphRelations",
  "graphAssociations",
  "replayTerminals",
  "replaySupersedes",
  "replayThreads",
] as const;

const MANIFEST_KEYS = new Set<string>([
  "schemaVersion",
  "operation",
  "status",
  "tier",
  "scope",
  "sourceRootFingerprint",
  "sourceFingerprint",
  "treeFingerprint",
  "extrasTreeFingerprint",
  "embeddingModel",
  "dimension",
  "agentSourceId",
  "pendingWork",
  "createdAt",
  "counts",
  "bundleDigest",
]);

/**
 * Digest the manifest payload in a key order fixed by this module, so the
 * commitment is independent of JSON property order on disk.
 */
export function memoryBundleDigest(payload: MemoryBundleManifestPayload): string {
  const ordered: unknown[] = [
    payload.schemaVersion,
    payload.operation,
    payload.status,
    payload.tier,
    payload.scope,
    payload.sourceRootFingerprint,
    payload.sourceFingerprint,
    payload.treeFingerprint,
    payload.extrasTreeFingerprint ?? null,
    payload.embeddingModel ?? null,
    payload.dimension ?? null,
    payload.agentSourceId ?? null,
    payload.pendingWork ?? null,
    payload.createdAt,
    COUNT_KEYS.map((key) => payload.counts[key]),
  ];
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

export function completeMemoryBundleManifest(
  payload: MemoryBundleManifestPayload,
): MemoryExportBundleManifest {
  return { ...payload, bundleDigest: memoryBundleDigest(payload) };
}

/**
 * Strict parser: exact key set, literal discriminators, sha256-shaped
 * fingerprints, non-negative integer counts. Anything else fails closed before
 * a single destination byte is touched.
 */
export function parseMemoryExportBundleManifest(value: unknown): MemoryExportBundleManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory-bundle: manifest is invalid");
  }
  const manifest = value as Record<string, unknown>;
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.has(key)) throw new Error("memory-bundle: manifest is invalid");
  }
  if (manifest.schemaVersion !== MEMORY_BUNDLE_SCHEMA_VERSION
    || manifest.operation !== "memory-export-bundle"
    || manifest.status !== "complete"
    || manifest.tier !== "bujo"
    || (manifest.scope !== "canonical" && manifest.scope !== "canonical+extras")
    || !isSha256(manifest.sourceRootFingerprint)
    || !isSha256(manifest.sourceFingerprint)
    || !isSha256(manifest.treeFingerprint)
    || !isSha256(manifest.bundleDigest)
    || typeof manifest.createdAt !== "string" || manifest.createdAt.length === 0
    || (manifest.extrasTreeFingerprint !== undefined && !isSha256(manifest.extrasTreeFingerprint))
    || (manifest.embeddingModel !== undefined && typeof manifest.embeddingModel !== "string")
    || (manifest.dimension !== undefined
      && (!Number.isInteger(manifest.dimension) || Number(manifest.dimension) <= 0))
    || (manifest.agentSourceId !== undefined && typeof manifest.agentSourceId !== "string")
    || (manifest.pendingWork !== undefined && manifest.pendingWork !== true)) {
    throw new Error("memory-bundle: manifest is invalid");
  }
  const counts = manifest.counts;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("memory-bundle: manifest is invalid");
  }
  const countRecord = counts as Record<string, unknown>;
  if (Object.keys(countRecord).length !== COUNT_KEYS.length) {
    throw new Error("memory-bundle: manifest is invalid");
  }
  for (const key of COUNT_KEYS) {
    const count = countRecord[key];
    if (!Number.isInteger(count) || Number(count) < 0) {
      throw new Error("memory-bundle: manifest is invalid");
    }
  }
  const parsed = manifest as unknown as MemoryExportBundleManifest;
  if (memoryBundleDigest(parsed) !== parsed.bundleDigest) {
    throw new Error("memory-bundle: manifest digest does not match its payload");
  }
  // The bundle-relative source layout is fixed; reject any attempt to smuggle
  // an escaping path through a future field by validating the constants too.
  assertSafeRelative(MEMORY_BUNDLE_SOURCE_DIR);
  assertSafeRelative(MEMORY_BUNDLE_MANIFEST_FILE);
  return parsed;
}
