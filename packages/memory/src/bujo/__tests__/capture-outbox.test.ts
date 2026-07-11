import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { replayCaptureOutbox, writeCaptureIntent, type CaptureIntentAction } from "../capture-outbox.js";
import { appendBullet, dailyFilePath, rewriteBullet } from "../daily.js";
import { parseDailyFile } from "../grammar.js";
import { appendEntity, readGraph } from "../graph.js";
import { readCanonicalFileSnapshot } from "../path-safety.js";
import type { Bullet } from "../types.js";
import { openMemoryDb, type MemoryRecord } from "../../store/index.js";

const NOW = new Date("2026-07-11T09:00:00.000Z");

describe("capture outbox", () => {
  it("completes an ADD from the exact pre-mutation state after an immediate crash", () => {
    const root = tempRoot();
    const item = bullet("ADD", "A prepared capture survives an immediate crash.");
    const file = relative(root, dailyFilePath(root, NOW));
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      vector: [1, 0],
      threads: [],
    };
    writeCaptureIntent(root, [action], {
      entities: [{ id: "concept:crash", name: "Crash", type: "concept", createdAt: NOW.toISOString() }],
      associations: [{
        memoryId: item.id,
        entityId: "concept:crash",
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }],
    }, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:outbox"),
      dim: 2,
    });
    try {
      replayCaptureOutbox(root, db);
      expect(db.get(item.id)?.text).toBe(item.text);
      expect(db.hasVector(item.id)).toBe(true);
      expect(db.associationsForMemory(item.id)).toEqual([
        expect.objectContaining({ entityId: "concept:crash", provenance: "capture" }),
      ]);
      expect(parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets).toEqual([item]);
    } finally {
      db.close();
    }
  });

  it("converges instead of throwing when a pre-existing entity row diverges from the canonical record", () => {
    const root = tempRoot();
    const item = bullet("PAOLA-ADD", "Paola owns the capture that used to wedge the outbox.");
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      vector: [1, 0],
      threads: [],
    }], {
      // Capture-time entity: no summary, capture-time createdAt — exactly the shape
      // graphForPreparedActions emits.
      entities: [{ id: "person:paola", name: "Paola", type: "person", createdAt: NOW.toISOString() }],
    }, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:diverged-entity"),
      dim: 2,
    });
    try {
      // The live wedge shape: a DB row predating the memory rework carries a stale
      // summary and an old created_at, with NO graph.jsonl line to reconcile against.
      db.upsertEntity({
        id: "person:paola",
        name: "Paola",
        type: "person",
        summary: "stale",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
      });

      expect(() => replayCaptureOutbox(root, db)).not.toThrow();

      // The dumb-mirror upsert overwrote the diverged row to the canonical record:
      // summary cleared, updatedAt cleared, created_at taken from the canonical entity.
      expect(db.getEntity("person:paola")).toEqual({
        id: "person:paola",
        name: "Paola",
        type: "person",
        createdAt: NOW.toISOString(),
      });
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("converges when graph.jsonl and the index disagree on createdAt/summary", () => {
    const root = tempRoot();
    const createdAtA = "2025-01-01T00:00:00.000Z";
    // Canonical graph line: authoritative createdAt A and a summary S.
    appendEntity(root, {
      id: "person:paola",
      name: "Paola",
      type: "person",
      summary: "canonical summary",
      createdAt: createdAtA,
    });
    const item = bullet("PAOLA-GRAPH", "Paola's capture reconciles against the canonical graph line.");
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      vector: [1, 0],
      threads: [],
    }], {
      entities: [{ id: "person:paola", name: "Paola", type: "person", createdAt: NOW.toISOString() }],
    }, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:graph-index-disagree"),
      dim: 2,
    });
    try {
      // Index row disagrees with the graph line: createdAt B and no summary.
      db.upsertEntity({
        id: "person:paola",
        name: "Paola",
        type: "person",
        createdAt: "2025-06-06T00:00:00.000Z",
      });

      expect(() => replayCaptureOutbox(root, db)).not.toThrow();

      // Convergence to the merged canonical record: createdAt A + summary S.
      expect(db.getEntity("person:paola")).toEqual({
        id: "person:paola",
        name: "Paola",
        type: "person",
        summary: "canonical summary",
        createdAt: createdAtA,
      });
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("finishes mixed applied/before ADD, UPDATE, SUPERSEDE, and NOOP actions in one intent", () => {
    const root = tempRoot();
    const added = bullet("ADDED", "The add action was already applied.");
    const updateBefore = bullet("UPDATE", "Update before state.");
    const updateAfter = { ...updateBefore, text: "Update after state." };
    const old = bullet("OLD", "Supersede before state.");
    const replacement = bullet("NEW", "Supersede replacement state.");
    const noop = bullet("NOOP", "Noop exact state.");
    appendBullet(root, updateBefore, NOW);
    appendBullet(root, old, NOW);
    appendBullet(root, noop, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const actions: CaptureIntentAction[] = [{
      candidateIndex: 0,
      kind: "add",
      id: added.id,
      after: { file, bullet: added },
      record: memoryRecord(added, file),
      threads: [],
    }, {
      candidateIndex: 1,
      kind: "update",
      id: updateBefore.id,
      before: { file, bullet: updateBefore },
      after: { file, bullet: updateAfter },
      record: memoryRecord(updateAfter, file),
    }, {
      candidateIndex: 2,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record: memoryRecord(replacement, file),
      at: NOW.toISOString(),
    }, {
      candidateIndex: 3,
      kind: "noop",
      id: noop.id,
      expected: { file, bullet: noop },
    }];
    writeCaptureIntent(root, actions, {}, NOW.toISOString());
    appendBullet(root, added, NOW);

    replayCaptureOutbox(root, undefined, { retainIntent: true });

    const replayed = parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets;
    expect(replayed.find((item) => item.id === added.id)).toEqual(added);
    expect(replayed.find((item) => item.id === updateBefore.id)).toEqual(updateAfter);
    expect(replayed.find((item) => item.id === old.id)?.status).toBe("invalidated");
    expect(replayed.find((item) => item.id === replacement.id)).toEqual(replacement);
    expect(replayed.find((item) => item.id === noop.id)).toEqual(noop);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("repairs a known supersede half-state before applying its graph", () => {
    const root = tempRoot();
    const old = bullet("OLD", "Atlas launches in July.");
    const replacement = bullet("NEW", "Atlas launches in August.");
    appendBullet(root, old, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const record = memoryRecord(replacement, file);
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record,
      at: NOW.toISOString(),
    };
    writeCaptureIntent(root, [action], {
      entities: [{ id: "project:atlas", name: "Atlas", type: "project", createdAt: NOW.toISOString() }],
      associations: [{
        memoryId: replacement.id,
        entityId: "project:atlas",
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }],
    }, NOW.toISOString());

    // Simulate a process dying after append-new but before invalidating old.
    appendBullet(root, replacement, NOW);
    replayCaptureOutbox(root, undefined, { retainIntent: true });

    const daily = readCanonicalFileSnapshot(root, file)!;
    const parsed = parseDailyFile(daily.content);
    expect(parsed.bullets.find((item) => item.id === old.id)?.status).toBe("invalidated");
    expect(parsed.bullets.find((item) => item.id === replacement.id)?.text).toBe(replacement.text);
    expect(readGraph(root).associations).toEqual([
      expect.objectContaining({ memoryId: replacement.id, entityId: "project:atlas" }),
    ]);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("fails closed when canonical state matches neither the before nor after outcome", () => {
    const root = tempRoot();
    const before = bullet("TARGET", "Morgan prefers blue deployments.");
    const after = { ...before, text: "Morgan prefers reviewed blue deployments." };
    appendBullet(root, before, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "update",
      id: before.id,
      before: { file, bullet: before },
      after: { file, bullet: after },
      record: memoryRecord(after, file),
    };
    writeCaptureIntent(root, [action], {
      entities: [{ id: "concept:review", name: "Review", type: "concept", createdAt: NOW.toISOString() }],
      associations: [{
        memoryId: before.id,
        entityId: "concept:review",
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }],
    }, NOW.toISOString());
    expect(rewriteBullet(root, file, before.id, { text: "A conflicting external rewrite." })).toBe(true);

    expect(() => replayCaptureOutbox(root, undefined, { retainIntent: true }))
      .toThrow(/conflicts with canonical action update/iu);
    expect(readGraph(root).associations).toEqual([]);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("rejects a symlinked outbox directory without writing outside the memory root", () => {
    const root = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(root, ".capture-outbox"), "dir");

    expect(() => writeCaptureIntent(root, [], {}, NOW.toISOString())).toThrow(/directory.*symlink/iu);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects an oversized graph plan before publishing an intent", () => {
    const root = tempRoot();
    const entities = Array.from({ length: 17 }, (_, index) => ({
      id: `concept:${index}`,
      name: `Concept ${index}`,
      createdAt: NOW.toISOString(),
    }));

    expect(() => writeCaptureIntent(root, [], { entities }, NOW.toISOString())).toThrow(/schema|bound/iu);
    expect(existsSync(join(root, ".capture-outbox"))).toBe(false);
  });

  it("stores a valid eight-action 16,384-dimension batch within the encoded intent bound", () => {
    const root = tempRoot();
    const file = relative(root, dailyFilePath(root, NOW));
    const vector = Array.from({ length: 16_384 }, (_, index) => (index % 17) / 17);
    const actions: CaptureIntentAction[] = Array.from({ length: 8 }, (_, candidateIndex) => {
      const item = bullet(`HIGH-${candidateIndex}`, `High-dimension capture ${candidateIndex}.`);
      return {
        candidateIndex,
        kind: "add",
        id: item.id,
        after: { file, bullet: item },
        record: memoryRecord(item, file),
        vector,
        threads: [],
      };
    });

    writeCaptureIntent(root, actions, {}, NOW.toISOString());
    const [name] = readdirSync(join(root, ".capture-outbox"));
    expect(name).toBeDefined();
    expect(statSync(join(root, ".capture-outbox", name!)).size).toBeLessThan(2 * 1024 * 1024);
    replayCaptureOutbox(root, undefined, { retainIntent: true });
    expect(parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets).toHaveLength(8);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("rejects a replay vector that does not match the active database dimension", () => {
    const root = tempRoot();
    const item = bullet("WRONG-DIM", "Wrong-dimension replay sentinel.");
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      vector: [1, 0, 0],
      threads: [],
    }], {
      entities: [{ id: "concept:dimension", name: "Dimension", type: "concept", createdAt: NOW.toISOString() }],
      associations: [{
        memoryId: item.id,
        entityId: "concept:dimension",
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }],
    }, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:wrong-dim"),
      dim: 2,
    });
    try {
      expect(() => replayCaptureOutbox(root, db)).toThrow(/dimension mismatch.*expected 2.*got 3/iu);
      expect(db.count()).toBe(0);
      expect(existsSync(dailyFilePath(root, NOW))).toBe(false);
      expect(readGraph(root)).toEqual({ entities: [], relations: [], associations: [] });
      expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("preflights every canonical action before applying the first one", () => {
    const root = tempRoot();
    const first = bullet("FIRST", "This valid ADD must remain unapplied.");
    const conflictBefore = bullet("CONFLICT", "Expected before state.");
    const conflictAfter = { ...conflictBefore, text: "Expected after state." };
    appendBullet(root, { ...conflictBefore, text: "External conflicting state." }, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: first.id,
      after: { file, bullet: first },
      record: memoryRecord(first, file),
      threads: [],
    }, {
      candidateIndex: 1,
      kind: "update",
      id: conflictBefore.id,
      before: { file, bullet: conflictBefore },
      after: { file, bullet: conflictAfter },
      record: memoryRecord(conflictAfter, file),
    }], {}, NOW.toISOString());

    expect(() => replayCaptureOutbox(root, undefined, { retainIntent: true }))
      .toThrow(/conflicts with canonical action update/iu);
    const replayed = parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets;
    expect(replayed.some((item) => item.id === first.id)).toBe(false);
    expect(replayed.find((item) => item.id === conflictBefore.id)?.text).toBe("External conflicting state.");
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("rejects a tampered record-to-bullet binding and keeps the intent pending", () => {
    const root = tempRoot();
    const item = bullet("BOUND", "Canonical binding sentinel.");
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      threads: [],
    }], {}, NOW.toISOString());
    const [name] = readdirSync(join(root, ".capture-outbox"));
    const path = join(root, ".capture-outbox", name!);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { actions: Array<{ record: { text: string } }> };
    raw.actions[0]!.record.text = "Tampered SQLite text.";
    writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");

    expect(() => replayCaptureOutbox(root, undefined, { retainIntent: true }))
      .toThrow(/does not match.*canonical bullet/iu);
    expect(existsSync(dailyFilePath(root, NOW))).toBe(false);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("rejects memory-id overlap across queued intents before applying either intent", () => {
    const root = tempRoot();
    const item = bullet("OVERLAP", "Only one durable intent may own a memory id.");
    const file = relative(root, dailyFilePath(root, NOW));
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      threads: [],
    };
    writeCaptureIntent(root, [action], {}, NOW.toISOString());
    writeCaptureIntent(root, [action], {}, NOW.toISOString());

    expect(() => replayCaptureOutbox(root, undefined, { retainIntent: true })).toThrow(/queued intents.*overlap/iu);
    expect(existsSync(dailyFilePath(root, NOW))).toBe(false);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(2);
  });

  it("rejects a divergent supersede DB target before changing canonical source", () => {
    const root = tempRoot();
    const old = bullet("OLD-POISON", "The canonical old value.");
    const replacement = bullet("NEW-POISON", "The replacement value.");
    appendBullet(root, old, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record: memoryRecord(replacement, file),
      at: NOW.toISOString(),
    }], {}, NOW.toISOString());
    const db = openMemoryDb({ path: join(root, "memory.db") });
    try {
      db.upsertLexical({ ...memoryRecord(old, file), text: "A divergent SQLite value." });

      expect(() => replayCaptureOutbox(root, db)).toThrow(/supersede target.*conflicts.*active index/iu);

      const canonical = parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets;
      expect(canonical).toEqual([old]);
      expect(db.get(old.id)?.text).toBe("A divergent SQLite value.");
      expect(db.get(replacement.id)).toBeUndefined();
      expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("preserves live access and SQLite-only state while replaying an UPDATE", () => {
    const root = tempRoot();
    const before = bullet("LIVE-UPDATE", "Before durable replay.");
    const after = { ...before, text: "After durable replay." };
    appendBullet(root, before, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "update",
      id: before.id,
      before: { file, bullet: before },
      after: { file, bullet: after },
      record: memoryRecord(after, file),
    }], {}, NOW.toISOString());
    const db = openMemoryDb({ path: join(root, "memory.db") });
    const lastAccessedAt = "2026-07-11T09:30:00.000Z";
    try {
      db.upsertLexical({
        ...memoryRecord(before, file),
        accessCount: 5,
        lastAccessedAt,
        validFrom: "2026-07-01T00:00:00.000Z",
        collection: "live-state",
        tags: ["latest"],
        source: { file, line: 3, session: "live-session" },
      });

      replayCaptureOutbox(root, db);

      expect(db.get(before.id)).toMatchObject({
        text: after.text,
        accessCount: 5,
        lastAccessedAt,
        validFrom: "2026-07-01T00:00:00.000Z",
        collection: "live-state",
        tags: ["latest"],
        source: { file, line: 3, session: "live-session" },
      });
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "capture-outbox-"));
}

function noCallEmbeddings(id: string) {
  return {
    id,
    embed: async (_texts: readonly string[]): Promise<number[][]> => {
      throw new Error("stored outbox vectors must not call the embedding provider");
    },
  };
}

function bullet(id: string, text: string): Bullet {
  return {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.7,
    isInsight: false,
    createdAt: NOW.toISOString(),
    refs: [],
  };
}

function memoryRecord(item: Bullet, file: string): MemoryRecord {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    text: item.text,
    salience: item.salience,
    isInsight: item.isInsight,
    createdAt: item.createdAt,
    accessCount: 0,
    tags: [],
    source: { file },
  };
}
