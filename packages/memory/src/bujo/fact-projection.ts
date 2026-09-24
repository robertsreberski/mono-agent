import type { DbFactProjection, DbFactClaim, DbFactSource, DbFactSupersede } from "../store/db-facts.js";
import type { MemoryRecord } from "../store/types.js";
import type { EntityRecord } from "../store/types.js";
import { canonicalFactJson, type FactLine } from "./fact-ledger.js";

/** Total provider-free projection. Unknown or orphan endpoints cannot be blessed. */
export function projectFactLedger(
  lines: readonly FactLine[],
  entities: readonly EntityRecord[],
  memories: readonly MemoryRecord[],
): DbFactProjection {
  const entityIds = new Set(entities.map((entity) => entity.id));
  const memoryIds = new Set(memories.map((memory) => memory.id));
  const claims = new Map<string, DbFactClaim>();
  const sources = new Map<string, DbFactSource>();
  const supersedes = new Map<string, DbFactSupersede>();
  for (const line of lines) {
    if (line.kind === "fact") {
      if (!entityIds.has(line.entityId) || !memoryIds.has(line.sourceMemoryId)
        || (line.value.type === "relationship" && !entityIds.has(line.value.targetEntityId))
        || (line.value.type === "entity" && !entityIds.has(line.value.entityId))) {
        throw new Error("memory-facts: fact claim has an orphan canonical entity or memory endpoint.");
      }
      claims.set(line.factId, {
        factId: line.factId, entityId: line.entityId, key: line.key, valueType: line.value.type,
        valueJson: canonicalFactJson(line.value), claimJson: JSON.stringify(line), recordedAt: line.recordedAt,
        ...(line.validFrom === undefined ? {} : { validFrom: line.validFrom }),
        ...(line.validTo === undefined ? {} : { validTo: line.validTo }),
      });
      sources.set(`${line.factId}\0${line.sourceMemoryId}\0${line.sourceTextSha256}`, {
        factId: line.factId, memoryId: line.sourceMemoryId, sourceTextSha256: line.sourceTextSha256,
        attribution: line.attribution, recordedAt: line.recordedAt,
      });
    } else if (line.kind === "fact-source") {
      if (!memoryIds.has(line.sourceMemoryId)) {
        throw new Error("memory-facts: fact source has an orphan canonical memory endpoint.");
      }
      sources.set(`${line.factId}\0${line.sourceMemoryId}\0${line.sourceTextSha256}`, {
        factId: line.factId, memoryId: line.sourceMemoryId, sourceTextSha256: line.sourceTextSha256,
        attribution: line.attribution, recordedAt: line.recordedAt,
      });
    } else {
      supersedes.set(line.oldFactId, { oldFactId: line.oldFactId, newFactId: line.newFactId, at: line.at });
    }
  }
  // SQLite's default BINARY collation orders UTF-8 bytes, not locale-sensitive
  // display strings. Parity compares these ordered rows byte-for-byte.
  const binary = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));
  const ordered = (...pairs: readonly (readonly [string, string])[]): number => {
    for (const [left, right] of pairs) {
      const result = binary(left, right);
      if (result !== 0) return result;
    }
    return 0;
  };
  return {
    claims: [...claims.values()].sort((a, b) => binary(a.factId, b.factId)),
    sources: [...sources.values()].sort((a, b) => ordered(
      [a.factId, b.factId], [a.memoryId, b.memoryId], [a.sourceTextSha256, b.sourceTextSha256])),
    supersedes: [...supersedes.values()].sort((a, b) => binary(a.oldFactId, b.oldFactId)),
  };
}
