import { describe, expect, it } from "vitest";

import { MemorySearchError, type EmbeddingProvider } from "../../search/index.js";
import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, type: "note", status: "open", text, salience: 0.5, isInsight: false,
    createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {}, ...over,
  };
}

function switchableEmbeddings(dim = 64): EmbeddingProvider & {
  failure: unknown;
  calls: number;
} {
  const healthy = fakeEmbeddings(dim);
  return {
    id: healthy.id,
    failure: undefined,
    calls: 0,
    async embed(texts) {
      this.calls += 1;
      if (this.failure !== undefined) throw this.failure;
      return await healthy.embed(texts);
    },
  };
}

describe("recall", () => {
  it("ranks the topically-matching memory first via hybrid search", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "the cat sat on the mat"));
    await db.upsert(note("b", "stock market crash wiped out savings"));
    await db.upsert(note("c", "a cat themed cafe downtown"));
    const hits = await db.recall("cat mat", { topK: 3 });
    expect(hits[0]?.record.id).toBe("a"); // shares both query tokens (cat, mat)
    expect(hits.map((h) => h.record.id)).toContain("c"); // shares one (cat); b shares none
    db.close();
  });

  it("excludes invalidated/dropped memories by default", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "cat one", { status: "invalidated" }));
    await db.upsert(note("b", "cat two", { status: "dropped" }));
    await db.upsert(note("c", "cat three"));
    const hits = await db.recall("cat", { topK: 5 });
    expect(hits.map((h) => h.record.id)).toEqual(["c"]);
    db.close();
  });

  it("bumps access_count and last_accessed_at on returned memories", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64, clock: () => new Date("2026-06-16T00:00:00.000Z") });
    await db.upsert(note("a", "cat"));
    await db.recall("cat", { topK: 1 });
    const got = db.get("a");
    expect(got?.accessCount).toBe(1);
    expect(got?.lastAccessedAt).toBe("2026-06-16T00:00:00.000Z");
    db.close();
  });

  it("can recall without mutating access metadata", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64, clock: () => new Date("2026-06-16T00:00:00.000Z") });
    await db.upsert(note("a", "cat"));
    const hits = await db.recall("cat", { topK: 1, trackAccess: false });
    const got = db.get("a");
    expect(hits[0]?.record.accessCount).toBe(0);
    expect(hits[0]?.record.lastAccessedAt).toBeUndefined();
    expect(got?.accessCount).toBe(0);
    expect(got?.lastAccessedAt).toBeUndefined();
    db.close();
  });

  it("keeps alternating query rankings stable regardless of access history", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("cats", "cats prefer quiet window seats", { accessCount: 900, lastAccessedAt: "2026-06-15T23:59:59.000Z" }));
    await db.upsert(note("deploy", "deploy pipeline uses blue green releases"));

    const before = (await db.recall("deploy pipeline", { topK: 1 })).at(0)?.record.id;
    for (let index = 0; index < 20; index += 1) {
      await db.recall(index % 2 === 0 ? "quiet window cats" : "deploy pipeline", { topK: 2 });
    }
    const after = (await db.recall("deploy pipeline", { topK: 1 })).at(0)?.record.id;

    expect(before).toBe("deploy");
    expect(after).toBe("deploy");
    db.close();
  });

  it("excludes memories whose validTo has passed, unless includeInvalid", async () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });
    await db.upsert(note("expired", "cat expired note", { validTo: "2026-01-01T00:00:00.000Z" }));
    await db.upsert(note("future", "cat future note", { validTo: "2026-12-31T00:00:00.000Z" }));
    expect((await db.recall("cat", { topK: 5 })).map((h) => h.record.id)).toEqual(["future"]);
    expect((await db.recall("cat", { topK: 5, includeInvalid: true })).map((h) => h.record.id).sort()).toEqual([
      "expired",
      "future",
    ]);
    db.close();
  });

  it("filters invalid candidates before the bounded FTS limit so they cannot crowd out a live answer", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    for (let index = 0; index < 250; index += 1) {
      await db.upsert(note(`stale-${String(index).padStart(3, "0")}`, "The release train now leaves on Tuesday.", {
        status: "invalidated",
      }));
    }
    await db.upsert(note("live-thursday", "The release train now leaves on Thursday."));

    const hits = await db.recall("When does the release train now leave?", {
      topK: 50,
      trackAccess: false,
    });

    expect(hits.map((hit) => hit.record.id)).toEqual(["live-thursday"]);
    db.close();
  });

  it("boundedly over-fetches vector-only candidates when stale nearest neighbours consume the KNN budget", async () => {
    const constantEmbeddings = {
      id: "constant-8",
      embed: async (texts: readonly string[]) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
    };
    const db = openMemoryDb({ path: ":memory:", embeddings: constantEmbeddings, dim: 8 });
    for (let index = 0; index < 250; index += 1) {
      await db.upsert(note(`stale-vector-${String(index).padStart(3, "0")}`, "obsolete unrelated archive", {
        status: "invalidated",
      }));
    }
    await db.upsert(note("live-vector", "current semantic answer"));

    const hits = await db.recall("needle with no lexical overlap", {
      topK: 50,
      trackAccess: false,
    });

    expect(hits.map((hit) => hit.record.id)).toEqual(["live-vector"]);
    db.close();
  });

  it.each([
    "embedding_request_failed",
    "embedding_circuit_open",
    "embedding_response_invalid",
  ] as const)("retains ranked lexical hits with explicit status for %s", async (code) => {
    const embeddings = switchableEmbeddings();
    const db = openMemoryDb({ path: ":memory:", embeddings, dim: 64 });
    await db.upsertMany([
      note("target", "The deploy pipeline uses blue green releases."),
      note("noise", "Lunch preferences are unrelated."),
    ]);
    embeddings.calls = 0;
    embeddings.failure = new MemorySearchError(code, "private provider detail must not escape");

    const outcome = await db.recallWithOutcome("deploy pipeline releases", {
      topK: 5,
      trackAccess: false,
    });

    expect(outcome).toMatchObject({
      retrievalMode: "lexical_only",
      degradation: { code: "embedding_unavailable" },
      hits: [expect.objectContaining({ record: expect.objectContaining({ id: "target" }) })],
    });
    expect(outcome.hits[0]?.score).toBeGreaterThan(0);
    expect(embeddings.calls).toBe(1);
    expect(db.get("target")?.accessCount).toBe(0);
    db.close();
  });

  it("keeps healthy hybrid ranking identical on strict and status-bearing surfaces", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsertMany([
      note("target", "The deploy pipeline uses blue green releases."),
      note("other", "Morgan prefers quiet mornings."),
    ]);

    const strict = await db.recall("deploy pipeline releases", { topK: 5, trackAccess: false });
    const outcome = await db.recallWithOutcome("deploy pipeline releases", { topK: 5, trackAccess: false });

    expect(outcome.retrievalMode).toBe("hybrid");
    expect(outcome.degradation).toBeUndefined();
    expect(outcome.hits).toEqual(strict);
    db.close();
  });

  it("keeps legacy recall strict while the opt-in outcome can degrade", async () => {
    const embeddings = switchableEmbeddings();
    const db = openMemoryDb({ path: ":memory:", embeddings, dim: 64 });
    await db.upsert(note("target", "The deploy pipeline uses blue green releases."));
    const failure = new MemorySearchError("embedding_request_failed", "provider unavailable");
    embeddings.failure = failure;

    await expect(db.recall("deploy pipeline", { trackAccess: false })).rejects.toBe(failure);
    await expect(db.recallWithOutcome("deploy pipeline", { trackAccess: false })).resolves.toMatchObject({
      retrievalMode: "lexical_only",
      degradation: { code: "embedding_unavailable" },
    });
    db.close();
  });

  it("treats an unconfigured lexical store as healthy, not degraded", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    await db.upsert(note("target", "The deploy pipeline uses blue green releases."));

    await expect(db.recallWithOutcome("deploy pipeline", { trackAccess: false })).resolves.toMatchObject({
      retrievalMode: "lexical_only",
      hits: [expect.objectContaining({ record: expect.objectContaining({ id: "target" }) })],
    });
    expect((await db.recallWithOutcome("deploy pipeline", { trackAccess: false })).degradation).toBeUndefined();
    db.close();
  });

  it("does not mask cancellation, dimension mismatch, unknown provider errors, or closed databases", async () => {
    const embeddings = switchableEmbeddings();
    const db = openMemoryDb({ path: ":memory:", embeddings, dim: 64 });
    await db.upsert(note("target", "The deploy pipeline uses blue green releases."));

    const abort = new AbortController();
    abort.abort(new Error("caller cancelled"));
    embeddings.calls = 0;
    await expect(db.recallWithOutcome("deploy pipeline", { abortSignal: abort.signal })).rejects.toThrow(/cancelled/u);
    expect(embeddings.calls).toBe(0);

    embeddings.failure = new Error("programming invariant failed");
    await expect(db.recallWithOutcome("deploy pipeline")).rejects.toThrow(/programming invariant/u);

    embeddings.failure = undefined;
    embeddings.embed = async () => [[1, 2, 3]];
    await expect(db.recallWithOutcome("deploy pipeline")).rejects.toThrow(/dimension mismatch/iu);

    db.close();
    await expect(db.recallWithOutcome("deploy pipeline")).rejects.toThrow();
  });
});
