import type { MemoryLabelHit } from "../store/db-labels.js";
import { canonicalMemoryLabel, isStructuredFact, type MemoryLabel } from "./labels.js";
import { automaticIntentEligible, recallLineStatus } from "./recall.js";

/** Retention (including Remember) is not authorship evidence. */
function authority(label: MemoryLabel): number {
  return label.kind === "lesson" ? 0 : label.attribution === "user-stated" ? 2 : label.attribution === "document" ? 1 : 0;
}

function eligible(hit: MemoryLabelHit, asOf: string, now?: string, intentExpiry = false): boolean {
  if (intentExpiry && !automaticIntentEligible(hit)) return false;
  if (!hit.active || hit.type !== "note" || hit.status !== "open"
    || recallLineStatus(hit, asOf, now) !== "current") return false;
  const label = hit.label;
  if (label.kind === "lesson") return label.verified;
  if (label.attribution === "unknown") return false;
  return label.kind !== "fact" || ((label.validFrom === undefined || label.validFrom <= asOf)
    && (label.validTo === undefined || asOf <= label.validTo));
}

const EXCLUSIVE_KEYS = new Set(["birth_date", "full_name", "preferred_name", "home_location", "work_location"]);

/**
 * Current accepted notes only. For representable contradictions, the strongest
 * authorship wins; unresolved equal-authority values omit both whole lines.
 * Entity readers supply competing labels outside the retrieved score window,
 * but never add retrieval candidates or change a relevance score/budget.
 * Coarse facts and preferences do not encode comparable values.
 */
export function semanticRecallAuthorities(
  labels: readonly MemoryLabelHit[],
  labelsForEntity: ((entityId: string, date?: string) => readonly MemoryLabelHit[]) | undefined,
  asOf: string,
  now?: string,
  intentExpiry = false,
): ReadonlyMap<string, number> {
  const supported = labels.filter((hit) => eligible(hit, asOf, now, intentExpiry));
  const entities = new Map<string, readonly MemoryLabelHit[]>();
  const excluded = new Set<string>();
  for (const hit of supported) {
    const label = hit.label;
    if (!isStructuredFact(label) || !EXCLUSIVE_KEYS.has(label.key)) continue;
    let peers = entities.get(label.entityId);
    if (peers === undefined) {
      // Missing conflict evidence fails closed for structured assertions.
      if (labelsForEntity === undefined) { excluded.add(hit.memoryId); continue; }
      peers = labelsForEntity(label.entityId, asOf).filter((peer) => eligible(peer, asOf, now, intentExpiry));
      entities.set(label.entityId, peers);
    }
    const value = canonicalMemoryLabel({ v: 1, kind: "fact", entityId: label.entityId,
      key: label.key, value: label.value, attribution: "unknown" });
    if (peers.some((peer) => isStructuredFact(peer.label) && peer.label.key === label.key
      && authority(peer.label) >= authority(label)
      && canonicalMemoryLabel({ v: 1, kind: "fact", entityId: peer.label.entityId,
        key: peer.label.key, value: peer.label.value, attribution: "unknown" }) !== value)) excluded.add(hit.memoryId);
  }
  const result = new Map<string, number>();
  for (const hit of supported) {
    if (!excluded.has(hit.memoryId)) result.set(hit.memoryId, Math.max(result.get(hit.memoryId) ?? 0, authority(hit.label)));
  }
  return result;
}
