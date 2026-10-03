import {
  projectCanonicalGraph,
  type CanonicalGraphProjection,
  type CanonicalGraphRecords,
  type GraphProjectionMemory,
} from "./graph.js";

interface CachedCanonicalProjection {
  readonly sourceFingerprint: string;
  readonly projection: CanonicalGraphProjection;
}

let cached: CachedCanonicalProjection | undefined;

/**
 * Reuse only the deterministic, source-derived graph projection. The caller
 * still re-reads and fingerprints every canonical byte and rechecks DB parity.
 */
export function projectCanonicalGraphForAudit(
  sourceFingerprint: string,
  canonical: CanonicalGraphRecords,
  memories: readonly GraphProjectionMemory[],
): CanonicalGraphProjection {
  if (cached?.sourceFingerprint === sourceFingerprint) return cached.projection;
  const projection = projectCanonicalGraph(canonical, memories);
  cached = { sourceFingerprint, projection };
  return projection;
}

/** Test-only reset for keeping module-level audit cache cases independent. */
export function resetCanonicalProjectionAuditCacheForTest(): void {
  cached = undefined;
}
