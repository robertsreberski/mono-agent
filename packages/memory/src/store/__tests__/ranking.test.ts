import { describe, expect, it } from "vitest";

import { rrfFuse, reScore } from "../ranking.js";
import { ftsQuery } from "../fts.js";
import { DEFAULT_WEIGHTS } from "../types.js";

describe("rrfFuse", () => {
  it("rewards items ranked high in either list; top of both wins", () => {
    const vec = ["a", "b", "c"];
    const kw = ["a", "d", "b"];
    const fused = rrfFuse([vec, kw], 60);
    expect(fused[0]?.id).toBe("a"); // appears in both, high in both
    expect(fused.map((f) => f.id)).toContain("d");
  });
});

describe("reScore", () => {
  it("uses relevance with salience and insight tie-breakers", () => {
    const base = { rrfScore: 1, salience: 0.5, isInsight: false };
    const fresh = reScore(base, DEFAULT_WEIGHTS);
    const insight = reScore({ ...base, isInsight: true }, DEFAULT_WEIGHTS);
    expect(fresh).toBe(1.005);
    expect(insight).toBeGreaterThan(fresh);
  });

  it("returns a finite score from relevance and bounded tie-breakers", () => {
    const score = reScore(
      { rrfScore: 1, salience: 0.5, isInsight: false },
      DEFAULT_WEIGHTS,
    );
    expect(Number.isNaN(score)).toBe(false);
  });
});

describe("ftsQuery", () => {
  it("quotes tokens and ORs them, dropping punctuation", () => {
    expect(ftsQuery("cat's pricing? plan!")).toBe('"cat" OR "s" OR "pricing" OR "plan"');
  });
  it("returns empty string for tokenless input", () => {
    expect(ftsQuery("!?  ")).toBe("");
  });
});
