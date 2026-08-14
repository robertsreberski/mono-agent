import { describe, expect, it } from "vitest";

import type {
  EntityRecord,
  EntityRelationRecord,
  MemoryEntityAssociation,
  MemoryRecord,
} from "../../store/index.js";

import {
  MemoryBundleMergeError,
  mergeCanonicalMemoryBundles,
  type MemoryBundleMergeOptions,
} from "../bundle-merge.js";
import { serializeBullet } from "../grammar.js";
import type { CanonicalMergeSnapshot } from "../rebuild.js";
import {
  emptyReplayProjection,
  replayProjectionAuthorityId,
  type ReplayProjectionSupersede,
  type ReplayProjectionTerminal,
  type ReplayProjectionThread,
  type ReplayProjectionV1,
} from "../replay-projection.js";
import type { Bullet } from "../types.js";

/**
 * The merge engine is pure, so these fixtures are hand-built canonical
 * snapshots rather than on-disk roots. Bullets are serialized through the
 * production grammar so the "verbatim block" contract is exercised for real.
 */

interface BulletSpec {
  readonly id: string;
  readonly text: string;
  readonly status?: Bullet["status"];
  readonly type?: Bullet["type"];
  readonly createdAt?: string;
  readonly refs?: readonly string[];
  readonly salience?: number;
}

interface SnapshotSpec {
  readonly daily?: Readonly<Record<string, readonly BulletSpec[]>>;
  readonly entities?: readonly EntityRecord[];
  readonly relations?: readonly EntityRelationRecord[];
  readonly associations?: readonly MemoryEntityAssociation[];
  readonly replay?: ReplayProjectionV1;
}

function bulletOf(spec: BulletSpec): Bullet {
  return {
    id: spec.id,
    type: spec.type ?? "note",
    status: spec.status ?? "open",
    text: spec.text,
    salience: spec.salience ?? 0.5,
    isInsight: false,
    createdAt: spec.createdAt ?? "2026-07-30T05:00:00.000Z",
    refs: spec.refs ?? [],
  };
}

function recordOf(bullet: Bullet, file: string, line: number): MemoryRecord {
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    tags: [],
    source: { file, line },
  };
}

function snapshot(spec: SnapshotSpec): CanonicalMergeSnapshot {
  const daily: { relativePath: string; bytes: Buffer }[] = [];
  const records: MemoryRecord[] = [];
  for (const [relativePath, bullets] of Object.entries(spec.daily ?? {})) {
    const heading = `# ${relativePath.replace(/^daily\//u, "").replace(/\.md$/u, "")}`;
    const blocks = bullets.map((entry) => serializeBullet(bulletOf(entry)));
    daily.push({ relativePath, bytes: Buffer.from(`${heading}\n\n${blocks.join("\n")}\n`, "utf8") });
    bullets.forEach((entry, index) => {
      records.push(recordOf(bulletOf(entry), relativePath, 3 + index * 2));
    });
  }
  return {
    fingerprint: "0".repeat(64),
    daily,
    records,
    graph: {
      entities: spec.entities ?? [],
      relations: spec.relations ?? [],
      associations: spec.associations ?? [],
    },
    replay: spec.replay ?? emptyReplayProjection(),
  };
}

function entity(id: string, name: string, extra: Partial<EntityRecord> = {}): EntityRecord {
  return { id, name, createdAt: "2026-07-01T00:00:00.000Z", ...extra };
}

function authority(seed: string): { authorityKind: "capture"; authorityId: string } {
  return { authorityKind: "capture", authorityId: replayProjectionAuthorityId(seed) };
}

function terminal(id: string, at: string, seed = id): ReplayProjectionTerminal {
  return { id, at, ...authority(seed) };
}

function supersede(src: string, dst: string, at: string, seed = `${src}->${dst}`): ReplayProjectionSupersede {
  return { src, dst, at, ...authority(seed) };
}

function thread(src: string, dst: string, seed = `${src}~${dst}`): ReplayProjectionThread {
  return { src, dst, weight: 1, at: "2026-07-30T06:00:00.000Z", ...authority(seed) };
}

function projection(delta: Partial<ReplayProjectionV1>): ReplayProjectionV1 {
  return { schemaVersion: 1, terminals: [], supersedes: [], threads: [], ...delta };
}

function merge(
  destination: CanonicalMergeSnapshot,
  incoming: CanonicalMergeSnapshot,
  options?: MemoryBundleMergeOptions,
) {
  return mergeCanonicalMemoryBundles(destination, incoming, options);
}

describe("canonical memory bundle merge", () => {
  it("unions disjoint corpora and preserves bullets verbatim, refs included", () => {
    const destination = snapshot({ daily: { "daily/2026-07-30.md": [{ id: "A", text: "target fact" }] } });
    const incoming = snapshot({
      daily: {
        "daily/2026-07-30.md": [{ id: "B", text: "source fact", refs: ["x", "y"] }],
        "daily/2026-07-31.md": [{ id: "C", text: "later fact" }],
      },
    });

    const plan = merge(destination, incoming);

    expect(plan.importedMemoryIds).toEqual(["B", "C"]);
    expect(plan.counts.newMemories).toBe(2);
    expect(plan.counts.targetDailyFiles).toBe(2);
    const sameDay = plan.dailyAppends.find((append) => append.relativePath === "daily/2026-07-30.md");
    // refs survive only because the raw markdown block is carried through;
    // re-serializing from MemoryRecord would silently drop them.
    expect(sameDay?.blocks[0]).toContain("refs=x,y");
    expect(sameDay?.blocks[0]).toContain("source fact");
  });

  it("treats a byte-identical bullet as idempotent rather than a conflict", () => {
    const shared = { id: "A", text: "shared fact" } as const;
    const destination = snapshot({ daily: { "daily/2026-07-30.md": [shared] } });
    const incoming = snapshot({ daily: { "daily/2026-07-30.md": [shared] } });

    const plan = merge(destination, incoming);

    expect(plan.identicalMemoryIds).toEqual(["A"]);
    expect(plan.importedMemoryIds).toEqual([]);
    expect(plan.dailyAppends).toEqual([]);
  });

  it("fails closed on an id collision with different content, and skips on request", () => {
    const destination = snapshot({ daily: { "daily/2026-07-30.md": [{ id: "A", text: "target text" }] } });
    const incoming = snapshot({ daily: { "daily/2026-07-30.md": [{ id: "A", text: "source text" }] } });

    expect(() => merge(destination, incoming)).toThrow(MemoryBundleMergeError);
    expect(() => merge(destination, incoming)).toThrow(/already exist with different content/iu);

    const skipped = merge(destination, incoming, { onConflict: "skip" });
    expect(skipped.skippedMemoryIds).toEqual(["A"]);
    expect(skipped.counts.conflictingMemories).toBe(1);
    expect(skipped.dailyAppends).toEqual([]);
  });

  it("promotes a root-legacy incoming date into daily/ unless the destination keeps the legacy layout", () => {
    const incoming = snapshot({ daily: { "2026-07-30.md": [{ id: "B", text: "legacy layout fact" }] } });

    const promoted = merge(snapshot({ daily: { "daily/2026-07-29.md": [{ id: "A", text: "a" }] } }), incoming);
    expect(promoted.dailyAppends[0]?.relativePath).toBe("daily/2026-07-30.md");

    const retained = merge(snapshot({ daily: { "2026-07-30.md": [{ id: "A", text: "a" }] } }), incoming);
    expect(retained.dailyAppends[0]?.relativePath).toBe("2026-07-30.md");
  });

  it("appends a modern incoming date to the destination's root-legacy layout", () => {
    const destinationBullet = { id: "DEST-LEGACY", text: "destination legacy fact" } as const;
    const incomingBullet = { id: "INCOMING-DAILY", text: "incoming modern fact" } as const;
    const destination = snapshot({ daily: { "2026-07-30.md": [destinationBullet] } });
    const incoming = snapshot({ daily: { "daily/2026-07-30.md": [incomingBullet] } });

    const plan = merge(destination, incoming);
    const expectedCorpus = snapshot({
      daily: { "2026-07-30.md": [destinationBullet, incomingBullet] },
    });
    const expectedCommitment = merge(expectedCorpus, snapshot({}));

    expect(plan.dailyAppends).toEqual([{
      relativePath: "2026-07-30.md",
      blocks: [serializeBullet(bulletOf(incomingBullet))],
    }]);
    expect(plan.importedMemoryIds).toEqual(["INCOMING-DAILY"]);
    expect(plan.counts).toMatchObject({
      newMemories: 1,
      identicalMemories: 0,
      conflictingMemories: 0,
      targetDailyFiles: 1,
    });
    expect(plan.expectedSourceFingerprint).toBe(expectedCommitment.expectedSourceFingerprint);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.digest).not.toBe(merge(
      snapshot({ daily: { "daily/2026-07-30.md": [destinationBullet] } }),
      incoming,
    ).digest);
  });

  it("refuses a non-dated daily source that could never be migrated or forgotten", () => {
    const incoming = snapshot({ daily: { "daily/custom-notes.md": [{ id: "B", text: "b" }] } });

    expect(() => merge(snapshot({}), incoming)).toThrow(MemoryBundleMergeError);
    expect(() => merge(snapshot({}), incoming)).toThrow(/not a dated daily file/iu);
  });

  describe("entity graph", () => {
    it("keeps the destination's curated entity metadata and reports the discard", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "a" }] },
        entities: [entity("person:morgan", "Morgan", { summary: "curated by target" })],
      });
      const incoming = snapshot({
        daily: { "daily/2026-07-31.md": [{ id: "B", text: "b" }] },
        entities: [entity("person:morgan", "Morgan", { summary: "from source" })],
      });

      const plan = merge(destination, incoming);

      expect(plan.entityDiscards).toEqual([{ entityId: "person:morgan", fields: ["summary"] }]);
      expect(plan.graphLines).toEqual([]);
      expect(plan.counts.newEntities).toBe(0);
    });

    it("re-asserts the source entity while preserving the earlier createdAt under source policy", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "a" }] },
        entities: [entity("person:morgan", "Morgan", { summary: "curated by target" })],
      });
      const incoming = snapshot({
        daily: { "daily/2026-07-31.md": [{ id: "B", text: "b" }] },
        entities: [
          { id: "person:morgan", name: "Morgan", createdAt: "2026-07-20T00:00:00.000Z", summary: "from source" },
        ],
      });

      const plan = merge(destination, incoming, { entityConflict: "source" });

      const line = JSON.parse(plan.graphLines[0] ?? "{}") as Record<string, unknown>;
      expect(line.summary).toBe("from source");
      // The append log is last-wins, so a raw concatenation would regress
      // createdAt to the incoming record's later timestamp.
      expect(line.createdAt).toBe("2026-07-01T00:00:00.000Z");
      expect(plan.entityDiscards).toEqual([]);
    });

    it("drops relations and associations whose endpoints do not survive the merge", () => {
      const destination = snapshot({ daily: { "daily/2026-07-30.md": [{ id: "A", text: "target text" }] } });
      const incoming = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "source text" }, { id: "B", text: "b" }] },
        entities: [entity("person:morgan", "Morgan")],
        associations: [
          { memoryId: "A", entityId: "person:morgan", provenance: "capture", createdAt: "2026-07-30T05:00:00.000Z" },
          { memoryId: "B", entityId: "person:morgan", provenance: "capture", createdAt: "2026-07-30T05:00:00.000Z" },
        ],
      });

      const plan = merge(destination, incoming, { onConflict: "skip" });

      // "A" lost to the destination's bullet, so its association would be an
      // orphan endpoint at rebuild; "B" was imported and keeps its own.
      expect(plan.counts.newAssociations).toBe(1);
      expect(plan.graphLines.some((line) => line.includes('"memoryId":"B"'))).toBe(true);
      expect(plan.graphLines.some((line) => line.includes('"memoryId":"A"'))).toBe(false);
    });

    it("carries association provenance verbatim", () => {
      const incoming = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "B", text: "b" }] },
        entities: [entity("person:morgan", "Morgan")],
        associations: [
          {
            memoryId: "B",
            entityId: "person:morgan",
            provenance: "legacy-name-match",
            createdAt: "2026-07-30T05:00:00.000Z",
          },
        ],
      });

      const plan = merge(snapshot({}), incoming);

      expect(plan.graphLines.some((line) => line.includes('"provenance":"legacy-name-match"'))).toBe(true);
    });
  });

  describe("derived association drift", () => {
    it("reports pre-existing destination memories that gain a foreign entity association", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "Morgan shipped the release" }] },
      });
      const incoming = snapshot({
        daily: { "daily/2026-07-31.md": [{ id: "B", text: "unrelated" }] },
        entities: [entity("person:morgan", "Morgan")],
      });

      const plan = merge(destination, incoming);

      // "A" was never imported, yet importing the entity attaches it.
      expect(plan.derivedAssociationsAdded).toEqual(["A -> person:morgan"]);
      expect(plan.counts.derivedAssociationsAdded).toBe(1);
    });

    it("reports removals when a colliding entity name disables an existing name group", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "Morgan shipped the release" }] },
        entities: [entity("person:morgan", "Morgan")],
      });
      const incoming = snapshot({
        daily: { "daily/2026-07-31.md": [{ id: "B", text: "unrelated" }] },
        entities: [entity("contact:morgan", "Morgan")],
      });

      const plan = merge(destination, incoming);

      // Two distinct ids normalize to the same name, so the whole group is
      // disabled and the destination's own derived association disappears.
      expect(plan.derivedAssociationsRemoved).toEqual(["A -> person:morgan"]);
      expect(plan.counts.derivedAssociationsRemoved).toBe(1);
    });

    it("does not report drift for associations on freshly imported memories", () => {
      const incoming = snapshot({
        daily: { "daily/2026-07-31.md": [{ id: "B", text: "Morgan shipped the release" }] },
        entities: [entity("person:morgan", "Morgan")],
      });

      const plan = merge(snapshot({}), incoming);

      expect(plan.derivedAssociationsAdded).toEqual([]);
      expect(plan.derivedAssociationsRemoved).toEqual([]);
    });
  });

  describe("replay projection", () => {
    it("carries every incoming entry with its authority binding intact", () => {
      const incoming = snapshot({
        daily: {
          "daily/2026-07-30.md": [
            { id: "B", text: "b", status: "dropped", type: "task" },
            { id: "C", text: "c" },
          ],
        },
        replay: projection({ terminals: [terminal("B", "2026-07-30T09:00:00.000Z")] }),
      });

      const plan = merge(snapshot({}), incoming);

      expect(plan.replayDelta.terminals).toHaveLength(1);
      expect(plan.replayDelta.terminals?.[0]).toMatchObject({
        id: "B",
        at: "2026-07-30T09:00:00.000Z",
        authorityKind: "capture",
      });
      expect(plan.counts.newTerminals).toBe(1);
    });

    it("drops an incoming terminal for a skipped conflicting memory and reports the omission", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "destination version", type: "task" }] },
      });
      const incoming = snapshot({
        daily: {
          "daily/2026-07-30.md": [
            { id: "A", text: "incoming terminal version", status: "dropped", type: "task" },
          ],
        },
        replay: projection({ terminals: [terminal("A", "2026-07-30T09:00:00.000Z")] }),
      });

      const plan = merge(destination, incoming, { onConflict: "skip" });

      expect(plan.replayDelta).toEqual({ terminals: [], supersedes: [], threads: [] });
      expect(plan.counts).toEqual({
        newMemories: 0,
        identicalMemories: 0,
        conflictingMemories: 1,
        targetDailyFiles: 0,
        newEntities: 0,
        discardedEntities: 0,
        newRelations: 0,
        newAssociations: 0,
        skippedAssociations: 0,
        newTerminals: 0,
        skippedTerminals: 1,
        newSupersedes: 0,
        skippedSupersedes: 0,
        newThreads: 0,
        skippedThreads: 0,
        derivedAssociationsAdded: 0,
        derivedAssociationsRemoved: 0,
      });
    });

    it("drops an incoming supersede when either endpoint is a skipped conflicting memory", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "B", text: "destination B" }] },
      });
      const incoming = snapshot({
        daily: {
          "daily/2026-07-31.md": [
            { id: "A", text: "incoming A", status: "invalidated" },
            { id: "B", text: "incoming B" },
          ],
        },
        replay: projection({ supersedes: [supersede("A", "B", "2026-07-30T05:00:00.000Z")] }),
      });

      const plan = merge(destination, incoming, { onConflict: "skip" });

      expect(plan.importedMemoryIds).toEqual(["A"]);
      expect(plan.replayDelta.supersedes).toEqual([]);
      expect(plan.counts).toEqual({
        newMemories: 1,
        identicalMemories: 0,
        conflictingMemories: 1,
        targetDailyFiles: 1,
        newEntities: 0,
        discardedEntities: 0,
        newRelations: 0,
        newAssociations: 0,
        skippedAssociations: 0,
        newSupersedes: 0,
        skippedSupersedes: 1,
        newTerminals: 0,
        skippedTerminals: 0,
        newThreads: 0,
        skippedThreads: 0,
        derivedAssociationsAdded: 0,
        derivedAssociationsRemoved: 0,
      });
    });

    it("drops an incoming thread when a skipped conflicting memory is an endpoint", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "destination A" }] },
      });
      const incoming = snapshot({
        daily: {
          "daily/2026-07-31.md": [
            { id: "A", text: "incoming A" },
            { id: "B", text: "incoming B" },
          ],
        },
        replay: projection({ threads: [thread("A", "B")] }),
      });

      const plan = merge(destination, incoming, { onConflict: "skip" });

      expect(plan.replayDelta.threads).toEqual([]);
      expect(plan.counts).toEqual({
        newMemories: 1,
        identicalMemories: 0,
        conflictingMemories: 1,
        targetDailyFiles: 1,
        newEntities: 0,
        discardedEntities: 0,
        newRelations: 0,
        newAssociations: 0,
        skippedAssociations: 0,
        newTerminals: 0,
        skippedTerminals: 0,
        newSupersedes: 0,
        skippedSupersedes: 0,
        newThreads: 0,
        skippedThreads: 1,
        derivedAssociationsAdded: 0,
        derivedAssociationsRemoved: 0,
      });
    });

    it("fails closed when both sides claim a different terminal authority for one id", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "a", status: "dropped", type: "task" }] },
        replay: projection({ terminals: [terminal("A", "2026-07-30T09:00:00.000Z", "target")] }),
      });
      const incoming = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "a", status: "dropped", type: "task" }] },
        replay: projection({ terminals: [terminal("A", "2026-07-30T10:00:00.000Z", "source")] }),
      });

      expect(() => merge(destination, incoming)).toThrow(/conflicting terminal authority/iu);
    });

    it("fails closed on a duplicate supersede destination across the boundary", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "a" }, { id: "Z", text: "z" }] },
        replay: projection({ supersedes: [supersede("A", "Z", "2026-07-30T09:00:00.000Z")] }),
      });
      const incoming = snapshot({
        daily: { "daily/2026-07-31.md": [{ id: "B", text: "b" }, { id: "Z2", text: "z2" }] },
        replay: projection({ supersedes: [supersede("B", "Z", "2026-07-31T09:00:00.000Z")] }),
      });

      expect(() => merge(destination, incoming)).toThrow(/duplicate supersede destination/iu);
    });

    it("fails closed on a supersede cycle that only exists after the union", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "a" }, { id: "B", text: "b" }] },
        replay: projection({ supersedes: [supersede("A", "B", "2026-07-30T09:00:00.000Z")] }),
      });
      const incoming = snapshot({
        daily: { "daily/2026-07-31.md": [{ id: "A", text: "a" }, { id: "B", text: "b" }] },
        replay: projection({ supersedes: [supersede("B", "A", "2026-07-31T09:00:00.000Z")] }),
      });

      expect(() => merge(destination, incoming, { onConflict: "skip" })).toThrow(/cycle/iu);
    });

    it("fails closed when the merged thread fan-out from one source exceeds five", () => {
      const destination = snapshot({
        daily: { "daily/2026-07-30.md": [{ id: "A", text: "a" }] },
        replay: projection({
          threads: [thread("A", "T1"), thread("A", "T2"), thread("A", "T3")],
        }),
      });
      const incoming = snapshot({
        daily: { "daily/2026-07-31.md": [{ id: "B", text: "b" }] },
        replay: projection({
          threads: [thread("A", "T4"), thread("A", "T5"), thread("A", "T6")],
        }),
      });

      expect(() => merge(destination, incoming)).toThrow(/exceeds five edges/iu);
    });
  });

  it("produces a digest that commits to the exact ordered write plan", () => {
    const destination = snapshot({ daily: { "daily/2026-07-30.md": [{ id: "A", text: "a" }] } });
    const incoming = snapshot({ daily: { "daily/2026-07-31.md": [{ id: "B", text: "b" }] } });
    const other = snapshot({ daily: { "daily/2026-07-31.md": [{ id: "B", text: "different" }] } });

    expect(merge(destination, incoming).digest).toBe(merge(destination, incoming).digest);
    expect(merge(destination, other).digest).not.toBe(merge(destination, incoming).digest);
    expect(merge(destination, incoming, { entityConflict: "source" }).digest)
      .not.toBe(merge(destination, incoming).digest);
  });
});
