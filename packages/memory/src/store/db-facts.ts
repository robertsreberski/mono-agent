import { createHash } from "node:crypto";

import { MemoryDbGraph } from "./db-graph.js";

export interface DbFactClaim {
  readonly factId: string;
  readonly entityId: string;
  readonly key: string;
  readonly valueType: string;
  readonly valueJson: string;
  readonly claimJson: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly recordedAt: string;
}
export interface DbFactSource {
  readonly factId: string;
  readonly memoryId: string;
  readonly sourceTextSha256: string;
  readonly attribution: string;
  readonly recordedAt: string;
}
export interface DbFactSupersede {
  readonly oldFactId: string;
  readonly newFactId: string;
  readonly at: string;
}
export interface DbFactProjection {
  readonly claims: readonly DbFactClaim[];
  readonly sources: readonly DbFactSource[];
  readonly supersedes: readonly DbFactSupersede[];
}
export interface DbFactActiveClaim extends DbFactClaim {
  readonly active: boolean;
  readonly supportingMemoryIds: readonly string[];
  /** At the explicitly requested civil date; absent when no date is supplied. */
  readonly currentAt?: boolean;
  /** Conflicting singleton value (or overlapping location intervals). */
  readonly conflict: boolean;
}

/** Immutable facts; only the lifecycle of the joined canonical memory is mutable. */
export class MemoryDbFacts extends MemoryDbGraph {
  replaceFactProjection(projection: DbFactProjection): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM entity_fact_supersedes").run();
      this.db.prepare("DELETE FROM entity_fact_sources").run();
      this.db.prepare("DELETE FROM entity_facts").run();
      const insertClaim = this.db.prepare(`INSERT INTO entity_facts
        (fact_id, entity_id, fact_key, value_type, value_json, claim_json, valid_from, valid_to, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertSource = this.db.prepare(`INSERT INTO entity_fact_sources
        (fact_id, memory_id, source_text_sha256, attribution, recorded_at) VALUES (?, ?, ?, ?, ?)`);
      const insertEdge = this.db.prepare(`INSERT INTO entity_fact_supersedes
        (old_fact_id, new_fact_id, recorded_at) VALUES (?, ?, ?)`);
      const claimIds = new Set(projection.claims.map((claim) => claim.factId));
      const memoryIds = new Set((this.db.prepare("SELECT id FROM memories").all() as Array<{ id: string }>).map((row) => row.id));
      for (const claim of projection.claims) {
        if (!this.db.prepare("SELECT 1 FROM entities WHERE id = ?").get(claim.entityId)) {
          throw new Error("memory-store: fact claim has an orphan entity endpoint.");
        }
        insertClaim.run(claim.factId, claim.entityId, claim.key, claim.valueType, claim.valueJson,
          claim.claimJson, claim.validFrom ?? null, claim.validTo ?? null, claim.recordedAt);
      }
      for (const source of projection.sources) {
        if (!claimIds.has(source.factId) || !memoryIds.has(source.memoryId)) {
          throw new Error("memory-store: fact source has an orphan claim or memory endpoint.");
        }
        insertSource.run(source.factId, source.memoryId, source.sourceTextSha256, source.attribution, source.recordedAt);
      }
      for (const edge of projection.supersedes) {
        if (!claimIds.has(edge.oldFactId) || !claimIds.has(edge.newFactId)) {
          throw new Error("memory-store: fact correction has an orphan endpoint.");
        }
        insertEdge.run(edge.oldFactId, edge.newFactId, edge.at);
      }
    })();
  }

  factProjection(): DbFactProjection {
    const tables = (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('entity_facts','entity_fact_sources','entity_fact_supersedes')`).all() as Array<{ name: string }>);
    if (tables.length === 0) return { claims: [], sources: [], supersedes: [] }; // read-only legacy index
    if (tables.length !== 3) throw new Error("memory-store: partial typed fact schema; stopped-store rebuild required.");
    const claims = (this.db.prepare(`SELECT fact_id AS factId, entity_id AS entityId, fact_key AS key,
      value_type AS valueType, value_json AS valueJson, claim_json AS claimJson,
      valid_from AS validFrom, valid_to AS validTo, recorded_at AS recordedAt
      FROM entity_facts ORDER BY fact_id`).all() as Array<DbFactClaim & { validFrom: string | null; validTo: string | null }>).map(
      ({ validFrom, validTo, ...claim }) => ({ ...claim,
        ...(validFrom === null ? {} : { validFrom }), ...(validTo === null ? {} : { validTo }) }),
    );
    const sources = this.db.prepare(`SELECT fact_id AS factId, memory_id AS memoryId,
      source_text_sha256 AS sourceTextSha256, attribution, recorded_at AS recordedAt
      FROM entity_fact_sources ORDER BY fact_id, memory_id, source_text_sha256`).all() as DbFactSource[];
    const supersedes = this.db.prepare(`SELECT old_fact_id AS oldFactId, new_fact_id AS newFactId,
      recorded_at AS at FROM entity_fact_supersedes ORDER BY old_fact_id`).all() as DbFactSupersede[];
    return { claims, sources, supersedes };
  }

  /** Query-time support; dates constrain currentAt, never erase historical claims. */
  activeFactClaims(asOfDate?: string): readonly DbFactActiveClaim[] {
    if (asOfDate !== undefined && !isCivilDate(asOfDate)) {
      throw new Error("memory-store: fact query date must be a real ISO civil date.");
    }
    const { claims, sources, supersedes } = this.factProjection();
    const memorySources = this.db.prepare(`SELECT id, status, text FROM memories`).all() as
      Array<{ id: string; status: string; text: string }>;
    const memories = new Map(memorySources.map((row) => [row.id, row]));
    const corrected = new Set(supersedes.map((edge) => edge.oldFactId));
    const live = new Map<string, string[]>();
    for (const source of sources) {
      const memory = memories.get(source.memoryId);
      if (memory === undefined || memory.status === "invalidated" || memory.status === "dropped"
        || createHash("sha256").update(memory.text).digest("hex") !== source.sourceTextSha256) continue;
      const supported = live.get(source.factId) ?? [];
      if (!supported.includes(memory.id)) supported.push(memory.id);
      live.set(source.factId, supported);
    }
    const active = claims.map((claim) => ({ ...claim,
      supportingMemoryIds: (live.get(claim.factId) ?? []).sort(),
      active: !corrected.has(claim.factId) && (live.get(claim.factId)?.length ?? 0) > 0,
    }));
    const groups = new Map<string, typeof active>();
    for (const claim of active) {
      if (!claim.active || !isExclusiveKey(claim.key)) continue;
      const key = `${claim.entityId}\0${claim.key}`;
      groups.set(key, [...(groups.get(key) ?? []), claim]);
    }
    return active.map((claim) => ({ ...claim,
      ...(asOfDate === undefined ? {} : { currentAt: claim.active
        && (claim.validFrom === undefined || claim.validFrom <= asOfDate)
        && (claim.validTo === undefined || asOfDate <= claim.validTo) }),
      conflict: claim.active && (groups.get(`${claim.entityId}\0${claim.key}`) ?? []).some((other) =>
        other.factId !== claim.factId && other.valueJson !== claim.valueJson
        && (isSingletonKey(claim.key) || intervalsOverlap(claim, other))),
    }));
  }
}

function isSingletonKey(key: string): boolean {
  return key === "birth_date" || key === "full_name" || key === "preferred_name";
}
function isExclusiveKey(key: string): boolean {
  return isSingletonKey(key) || key === "home_location" || key === "work_location";
}
function intervalsOverlap(left: DbFactClaim, right: DbFactClaim): boolean {
  return (left.validFrom === undefined || right.validTo === undefined || left.validFrom <= right.validTo)
    && (right.validFrom === undefined || left.validTo === undefined || right.validFrom <= left.validTo);
}
function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(`${value}T`);
}
