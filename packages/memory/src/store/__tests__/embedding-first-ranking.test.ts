import { describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../../search/index.js";
import { anchorCoverage, queryAnchors } from "../anchors.js";
import { openMemoryDb, type MemoryRecord } from "../index.js";

const QUERY_AXIS = [1, 0, 0, 0];

/** Vectors with an exact cosine similarity to the query axis. */
function provider(similarities: Readonly<Record<string, number>>): EmbeddingProvider {
  return {
    id: "test:fixed-cosine",
    embed: async (texts) => texts.map((raw) => {
      const text = raw.replace(/^search_(query|document): /u, "");
      const cosine = similarities[text];
      if (cosine === undefined) return QUERY_AXIS;
      return [cosine, Math.sqrt(1 - cosine * cosine), 0, 0];
    }),
  };
}

function note(id: string, text: string): MemoryRecord {
  return {
    id, type: "note", status: "open", text, salience: 0.5, isInsight: false,
    createdAt: "2026-07-10T12:00:00.000Z", accessCount: 0, tags: [], source: {},
  };
}

async function scores(
  records: readonly MemoryRecord[],
  similarities: Readonly<Record<string, number>>,
  query: string,
): Promise<Map<string, number>> {
  const db = openMemoryDb({ path: ":memory:", embeddings: provider(similarities), dim: 4 });
  try {
    await db.upsertMany(records);
    const hits = await db.recall(query, { topK: 20, trackAccess: false });
    return new Map(hits.map((hit) => [hit.record.id, hit.score]));
  } finally {
    db.close();
  }
}

describe("embedding-first recall ranking", () => {
  it("lets an exact name outrank a slightly closer generic-word neighbour", async () => {
    const answer = note("answer", "Morgan selected teal as the dashboard color.");
    const trap = note("trap", "The dashboard color review compared dashboard color palettes.");
    const result = await scores([answer, trap], {
      [answer.text]: 0.74,
      [trap.text]: 0.8,
    }, "What dashboard color did Morgan select?");
    expect(result.get("answer")!).toBeGreaterThan(result.get("trap")!);
  });

  it("does not saturate relevance from shared generic words", async () => {
    const unrelated = note("generic", "The dashboard color palette uses a dark theme.");
    const result = await scores([unrelated], { [unrelated.text]: 0.3 }, "What dashboard color did Morgan select?");
    // Two shared generic words used to give full lexical confidence (~1.0).
    expect(result.get("generic")!).toBeLessThan(0.1);
  });

  it("boosts exact dates and numbers", async () => {
    const dated = note("dated", "Taylor Brooks was born on 1988-11-02.");
    const other = note("other", "Morgan Reyes was born on 1990-05-17.");
    const result = await scores([dated, other], { [dated.text]: 0.7, [other.text]: 0.7 }, "Who was born on 1988-11-02?");
    expect(result.get("dated")! - result.get("other")!).toBeCloseTo(0.9 * 0.15, 2);
  });

  it("matches whole dates and numeric identifiers, not their component numbers", async () => {
    const exact = note("exact", "Taylor Brooks was born on 1988-11-02.");
    const sibling = note("sibling", "Riley Brooks was born on 1988-12-02.");
    const result = await scores(
      [exact, sibling],
      { [exact.text]: 0.7, [sibling.text]: 0.7 },
      "who was born on 1988-11-02?",
    );
    expect(result.get("exact")! - result.get("sibling")!).toBeCloseTo(0.9 * 0.15, 2);
    const anchors = queryAnchors("Was invoice 4471 paid on 17/05/2026?", []);
    expect([...anchors].sort()).toEqual(["17/05/2026", "4471"]);
    expect(anchorCoverage(anchors, "Invoice 4471 was paid on 17/05/2026.")).toBe(1);
    expect(anchorCoverage(anchors, "Invoice 44 was paid on 17/05/2025 for 71 items.")).toBe(0);
  });

  it("matches names across accents and in multilingual records", async () => {
    const dutch = note("dutch", "Zoë de Vries viert haar verjaardag op 12 maart.");
    const italian = note("italian", "Il compleanno di Luca Bianchi è il 3 luglio.");
    const result = await scores([dutch, italian], { [dutch.text]: 0.6, [italian.text]: 0.6 }, "When is Zoe's birthday?");
    expect(result.get("dutch")!).toBeGreaterThan(result.get("italian")!);
  });

  it("matches decomposed and composed diacritics as the same name", () => {
    const decomposed = "When does Ju\u0308rgen move to Leipzig?";
    const anchors = queryAnchors(decomposed, []);
    expect(anchors.has("jurgen")).toBe(true);
    expect(anchorCoverage(anchors, "J\u00fcrgen Wei\u00df zieht nach Leipzig.")).toBe(1);
    expect(anchorCoverage(queryAnchors("When does J\u00fcrgen move?", []), "Ju\u0308rgen moves in May.")).toBe(1);
  });

  it("anchors lower-case query names that records spell as proper nouns", () => {
    const records = ["Yesterday Sam Okafor drove a blue hatchback.", "The car wash opens at nine."];
    expect([...queryAnchors("what car does sam okafor drive", records)].sort()).toEqual(["okafor", "sam"]);
    expect([...queryAnchors("When was Morgan born on 17 May?", [])].sort()).toEqual(["17", "may", "morgan"]);
    expect([...queryAnchors("When was Morgan born on 1990-05-17?", [])].sort()).toEqual(["1990-05-17", "morgan"]);
    expect(anchorCoverage(new Set(["zoe", "12"]), "Zoë viert op 12 maart.")).toBe(1);
  });

  it("keeps lexical-only scores unchanged", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    try {
      await db.upsertMany([note("fact", "Morgan selected cobalt as the deployment color.")]);
      const [hit] = await db.recall("What deployment color did Morgan select?", { trackAccess: false });
      expect(hit?.score).toBe(1); // relevance 1 plus tie-breakers, clamped
    } finally {
      db.close();
    }
  });

  it("scores FTS-only candidates by their stored vector", async () => {
    // A generous candidate budget of one keeps the FTS-only record out of the
    // vector candidate list, so its cosine comes from the stored vector.
    const near = note("near", "A calm autumn walk by the canal.");
    const lexical = note("lexical", "Morgan booked the autumn canal tour.");
    const db = openMemoryDb({
      path: ":memory:",
      embeddings: provider({ [near.text]: 0.9, [lexical.text]: 0.3 }),
      dim: 4,
    });
    try {
      await db.upsertMany([near, lexical]);
      const hits = await db.recall("Morgan autumn canal", { topK: 5, candidates: 1, trackAccess: false });
      const byId = new Map(hits.map((hit) => [hit.record.id, hit.score]));
      // Cosine 0.3 is below the semantic floor; only the Morgan anchor counts.
      expect(byId.get("lexical")!).toBeLessThan(0.3);
      expect(byId.get("near")!).toBeGreaterThan(0.8);
    } finally {
      db.close();
    }
  });
});

describe("name-anchor calibration", () => {
  it("does not let a name alone lift an unrelated record above the true answer to the same query", async () => {
    // One query, two hits: a record that only shares the person's name, and the
    // true answer, which does not repeat the name. A full 0.15 name bonus put
    // the name-only record first (0.76 + 0.15 > 0.86).
    const named = note("named", "Morgan reviewed the quarterly garden plan.");
    const answer = note("answer", "The team retrospective happens every second Friday.");
    const result = await scores([named, answer], { [named.text]: 0.76, [answer.text]: 0.86 },
      "How often does Morgan's team retrospective happen?");
    expect(result.get("answer")!).toBeGreaterThan(result.get("named")!);
  });

  it("keeps the full bonus for numbers and dates and a smaller one for names", async () => {
    const { anchorBoost, ANCHOR_BOOST, NAME_ANCHOR_BOOST } = await import("../anchors.js");
    expect(anchorBoost(new Set(["1988-11-02"]), "Taylor was born on 1988-11-02.")).toBeCloseTo(ANCHOR_BOOST, 6);
    expect(anchorBoost(new Set(["morgan"]), "Morgan likes tea.")).toBeCloseTo(NAME_ANCHOR_BOOST, 6);
    expect(anchorBoost(new Set(["morgan", "4471"]), "Morgan paid invoice 4471."))
      .toBeCloseTo((ANCHOR_BOOST + NAME_ANCHOR_BOOST) / 2, 6);
    expect(anchorBoost(new Set(), "Morgan")).toBe(0);
  });
});
