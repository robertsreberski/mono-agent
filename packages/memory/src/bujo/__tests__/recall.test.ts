import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../../store/index.js";
import { fakeEmbeddings } from "./helpers.js";
import { composeRecallBlock, selectAutomaticRecallHits } from "../recall.js";
import { automaticRecallEvidenceProfile, hasAutomaticRecallEvidence } from "../recall-evidence.js";

describe("selectAutomaticRecallHits", () => {
  it("keeps a strong multi-hit answer cluster while dropping high-similarity adjacent noise", () => {
    const hits = [
      { id: "primary", score: 1.005 },
      { id: "supporting", score: 0.798 },
      { id: "adjacent-noise", score: 0.751 },
      { id: "weak-noise", score: 0.62 },
    ];

    expect(selectAutomaticRecallHits(hits).map((hit) => hit.id)).toEqual(["primary", "supporting"]);
  });

  it("keeps a lone paraphrase hit but abstains when even the strongest result is weak", () => {
    expect(selectAutomaticRecallHits([{ id: "paraphrase", score: 0.722 }, { id: "noise", score: 0.51 }]))
      .toEqual([{ id: "paraphrase", score: 0.722 }]);
    expect(selectAutomaticRecallHits([{ id: "noise", score: 0.64 }])).toEqual([]);
  });

  it("requires answer-bearing evidence after score selection", () => {
    const answer = {
      score: 1.005,
      record: { text: "Morgan selected cobalt as the deployment color." },
    };
    const adjacent = {
      score: 0.798,
      record: { text: "Morgan's office is in Amsterdam." },
    };

    expect(selectAutomaticRecallHits([answer, adjacent], {
      query: "What deployment color did Morgan select?",
    })).toEqual([answer]);
    expect(selectAutomaticRecallHits([answer, adjacent], {
      query: "What is Morgan's phone number?",
    })).toEqual([]);
  });

  it("does not splice a query subject and requested attribute across disjoint records", () => {
    const office = {
      score: 0.91,
      record: { text: "Morgan's office is in Amsterdam." },
    };
    const unrelatedPhone = {
      score: 0.89,
      record: { text: "Taylor's phone number is 555-0100." },
    };

    expect(selectAutomaticRecallHits([office, unrelatedPhone], {
      query: "What is Morgans phone number?",
    })).toEqual([]);

    expect(selectAutomaticRecallHits([
      { score: 0.93, record: { text: "Morgan selected cobalt as the deployment color." } },
      { score: 0.91, record: { text: "Morgan drives a hatchback car." } },
    ], { query: "What color is Morgans car?" })).toEqual([]);
  });
});

describe("hasAutomaticRecallEvidence", () => {
  const records = [
    "Morgan selected cobalt as the deployment color.",
    "Database rollouts use a blue-green deployment strategy.",
    "The release train now leaves on Thursday.",
    "The API launch date is 2026-08-14.",
    "Project Atlas is led by Morgan.",
    "Morgan's office is in Amsterdam.",
    "The team orders soup for lunch on rainy days.",
  ].map((text) => ({ record: { text } }));

  it.each([
    "Which shade was picked for deployments?",
    "How are database changes released?",
    "Which city is the person leading Atlas based in?",
    "When does the release train depart now?",
    "What day is the API launch?",
  ])("keeps answer-bearing paraphrase: %s", (query) => {
    expect(hasAutomaticRecallEvidence(query, records)).toBe(true);
  });

  it.each([
    "What is Morgans favorite food?",
    "What is Morgans phone number?",
    "Which cloud provider hosts Project Atlas?",
    "Who approved the blue-green deployment strategy?",
    "What time does the release train leave on Thursday?",
    "Where will the API launch event be held?",
    "What is Project Atlas budget?",
    "Does Morgan work remotely?",
    "Who chose the database vendor?",
    "What color is Morgans car?",
    "What did you send in the last message?",
  ])("rejects missing or conversation-relative evidence: %s", (query) => {
    expect(hasAutomaticRecallEvidence(query, records)).toBe(false);
  });

  it("exposes a deterministic profile without record or provider identifiers", () => {
    expect(automaticRecallEvidenceProfile("What is Morgan's phone number?")).toEqual({
      anchors: ["morgan"],
      required: ["phone"],
    });
  });

  it("requires multi-record evidence to share a named-entity path", () => {
    expect(hasAutomaticRecallEvidence("What is Morgans phone number?", [
      { record: { text: "Morgan's office is in Amsterdam." } },
      { record: { text: "Taylor's phone number is 555-0100." } },
    ])).toBe(false);

    expect(hasAutomaticRecallEvidence("Who approved the blue-green deployment strategy?", [
      { record: { text: "Database rollouts use a blue-green deployment strategy." } },
      { record: { text: "Taylor approved the travel policy." } },
    ])).toBe(false);

    expect(hasAutomaticRecallEvidence("What color is Morgans car?", [
      { record: { text: "Morgan selected cobalt as the deployment color." } },
      { record: { text: "Morgan drives a hatchback car." } },
    ])).toBe(false);
  });
});

describe("composeRecallBlock", () => {
  it("renders a markdown block with the most relevant memories and a source label", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert({ id: "a", type: "note", status: "open", text: "Morgan prefers opt-in memory.", salience: 0.9, isInsight: true, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    await db.upsert({ id: "b", type: "task", status: "open", text: "Ship the substrate.", salience: 0.6, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    const block = await composeRecallBlock(db, "Morgan memory preferences", { topK: 5 });
    expect(block).toBeDefined();
    assert(block);
    expect(block.kind).toBe("markdown");
    expect(block.source).toBe("memory-bujo");
    expect(block.content).toContain("Morgan prefers opt-in memory.");
    expect(block.truncated).toBe(false);
    db.close();
  });

  it("renders the marker from type AND status (a done task is not shown as open)", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert({ id: "open", type: "task", status: "open", text: "open task about widgets.", salience: 0.6, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    await db.upsert({ id: "done", type: "task", status: "done", text: "done task about widgets.", salience: 0.6, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    await db.upsert({ id: "sched", type: "task", status: "scheduled", text: "scheduled task about widgets.", salience: 0.6, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    const block = await composeRecallBlock(db, "widgets", { topK: 10 });
    expect(block).toBeDefined();
    assert(block);
    expect(block.content).toContain("- [ ] open task about widgets.");
    expect(block.content).toContain("- [x] done task about widgets.");
    expect(block.content).toContain("- [<] scheduled task about widgets.");
    db.close();
  });

  it("truncates to the byte budget and flags it", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    for (let i = 0; i < 20; i += 1) {
      await db.upsert({ id: `m${i}`, type: "note", status: "open", text: `memory fact number ${i} about cats`, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    }
    const block = await composeRecallBlock(db, "cats", { topK: 20, maxBytes: 120 });
    expect(block).toBeDefined();
    assert(block);
    expect(Buffer.byteLength(block.content, "utf8")).toBeLessThanOrEqual(120);
    expect(block.truncated).toBe(true);
    db.close();
  });

  it("abstains when vector neighbours have no relevant evidence", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert({ id: "garden", type: "note", status: "open", text: "roses need compost", salience: 1, isInsight: true, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 99, lastAccessedAt: "2026-06-15T09:00:00.000Z", tags: [], source: {} });

    const block = await composeRecallBlock(db, "quarterly finance forecast", { topK: 5 });

    expect(block).toBeUndefined();
    expect(db.audit().access.totalCount).toBe(99);
    db.close();
  });
});
