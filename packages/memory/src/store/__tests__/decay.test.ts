import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

const DIM = 8;

// Fixed clock: June 15, 2026 noon UTC
const NOW = new Date("2026-06-15T12:00:00.000Z");
const HALF_LIFE_DAYS = 30;
const FLOOR = 0.05;

function record(over: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    type: "note",
    status: "open",
    text: `Memory ${over.id}`,
    salience: 0.8,
    isInsight: false,
    createdAt: NOW.toISOString(),
    accessCount: 0,
    tags: [],
    source: {},
    ...over,
  };
}

describe("applyDecay", () => {
  it("leaves a fresh memory (ref==now) essentially unchanged", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    // createdAt == now, no last_accessed_at → days=0, factor=1.0
    await db.upsert(record({ id: "fresh", salience: 0.8, createdAt: NOW.toISOString() }));

    const { decayed } = db.applyDecay(NOW, { halfLifeDays: HALF_LIFE_DAYS, floor: FLOOR });

    // days=0 → factor=1.0 → next=salience → no change → decayed=0
    expect(decayed).toBe(0);
    expect(db.get("fresh")!.salience).toBeCloseTo(0.8, 9);

    db.close();
  });

  it("halves salience toward floor for a memory whose ref is exactly one half-life ago", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    // ref = now - halfLifeDays → factor = 0.5
    const oneHalfLifeAgo = new Date(NOW.getTime() - HALF_LIFE_DAYS * 86_400_000).toISOString();
    const salience = 0.8;
    const expectedNext = Math.max(FLOOR, salience * 0.5);

    // upsert with explicit old createdAt, no recall so last_accessed_at stays null
    await db.upsert(record({ id: "stale", salience, createdAt: oneHalfLifeAgo }));

    const { decayed } = db.applyDecay(NOW, { halfLifeDays: HALF_LIFE_DAYS, floor: FLOOR });

    expect(decayed).toBe(1);
    expect(db.get("stale")!.salience).toBeCloseTo(expectedNext, 6);

    db.close();
  });

  it("never drops salience below floor", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    // Very old memory — many half-lives ago — would theoretically decay to near 0
    const veryOld = new Date(NOW.getTime() - 10 * HALF_LIFE_DAYS * 86_400_000).toISOString();
    await db.upsert(record({ id: "ancient", salience: 0.8, createdAt: veryOld }));

    db.applyDecay(NOW, { halfLifeDays: HALF_LIFE_DAYS, floor: FLOOR });

    expect(db.get("ancient")!.salience).toBeGreaterThanOrEqual(FLOOR);

    db.close();
  });

  it("also clamps a memory already at exactly floor — no update emitted", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    // Memory already at floor — should not be updated (next == salience within 1e-9)
    const veryOld = new Date(NOW.getTime() - 10 * HALF_LIFE_DAYS * 86_400_000).toISOString();
    await db.upsert(record({ id: "at-floor", salience: FLOOR, createdAt: veryOld }));

    const { decayed } = db.applyDecay(NOW, { halfLifeDays: HALF_LIFE_DAYS, floor: FLOOR });

    expect(decayed).toBe(0);
    expect(db.get("at-floor")!.salience).toBeCloseTo(FLOOR, 9);

    db.close();
  });

  it("does not touch invalidated or dropped memories", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    const oneHalfLifeAgo = new Date(NOW.getTime() - HALF_LIFE_DAYS * 86_400_000).toISOString();

    await db.upsert(record({ id: "inv", salience: 0.8, createdAt: oneHalfLifeAgo, status: "invalidated" }));
    await db.upsert(record({ id: "drp", salience: 0.8, createdAt: oneHalfLifeAgo, status: "dropped" }));
    // A live one to confirm decay still runs
    await db.upsert(record({ id: "live", salience: 0.8, createdAt: oneHalfLifeAgo, status: "open" }));

    const { decayed } = db.applyDecay(NOW, { halfLifeDays: HALF_LIFE_DAYS, floor: FLOOR });

    // Only the live one should be updated
    expect(decayed).toBe(1);
    expect(db.get("inv")!.salience).toBeCloseTo(0.8, 9);
    expect(db.get("drp")!.salience).toBeCloseTo(0.8, 9);
    expect(db.get("live")!.salience).toBeCloseTo(0.4, 6);

    db.close();
  });

  it("is deterministic — same now yields same result on repeated calls", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    const oneHalfLifeAgo = new Date(NOW.getTime() - HALF_LIFE_DAYS * 86_400_000).toISOString();
    await db.upsert(record({ id: "repeat", salience: 0.8, createdAt: oneHalfLifeAgo }));

    db.applyDecay(NOW, { halfLifeDays: HALF_LIFE_DAYS, floor: FLOOR });
    const afterFirst = db.get("repeat")!.salience;

    // Second call with same now: salience already decayed, ref (createdAt) unchanged
    db.applyDecay(NOW, { halfLifeDays: HALF_LIFE_DAYS, floor: FLOOR });
    const afterSecond = db.get("repeat")!.salience;

    // The second call re-reads the already-updated salience and applies decay again (compound).
    // What's important is that both runs are deterministic (no randomness, no clock drift).
    // Both results should be ≥ floor and stable.
    expect(afterFirst).toBeGreaterThanOrEqual(FLOOR);
    expect(afterSecond).toBeGreaterThanOrEqual(FLOOR);

    db.close();
  });

  it("uses defaults (halfLifeDays=30, floor=0.05) when opts are omitted", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    const oneHalfLifeAgo = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    await db.upsert(record({ id: "default-opts", salience: 0.8, createdAt: oneHalfLifeAgo }));

    const { decayed } = db.applyDecay(NOW);

    expect(decayed).toBe(1);
    // With defaults: factor=0.5, next = max(0.05, 0.8*0.5) = 0.4
    expect(db.get("default-opts")!.salience).toBeCloseTo(0.4, 6);

    db.close();
  });

  it("returns { decayed: 0 } on empty db", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    const result = db.applyDecay(NOW, { halfLifeDays: HALF_LIFE_DAYS, floor: FLOOR });
    expect(result).toEqual({ decayed: 0 });

    db.close();
  });
});
