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
  it("boosts recent, salient, insight memories", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const base = { rrfScore: 1, salience: 0.5, isInsight: false, lastAccessedAt: "2026-06-15T00:00:00.000Z" };
    const old = reScore({ ...base, lastAccessedAt: "2026-01-01T00:00:00.000Z" }, DEFAULT_WEIGHTS, 0.995, now);
    const fresh = reScore(base, DEFAULT_WEIGHTS, 0.995, now);
    const insight = reScore({ ...base, isInsight: true }, DEFAULT_WEIGHTS, 0.995, now);
    expect(fresh).toBeGreaterThan(old);
    expect(insight).toBeGreaterThan(fresh);
  });

  it("returns a finite score (no NaN) for a malformed lastAccessedAt", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const score = reScore(
      { rrfScore: 1, salience: 0.5, isInsight: false, lastAccessedAt: "not-a-date" },
      DEFAULT_WEIGHTS,
      0.995,
      now,
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
