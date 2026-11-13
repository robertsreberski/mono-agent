import { describe, expect, it } from "vitest";
import { compareRankings, loadRankingFixture } from "../continuity-ranking-compare.mjs";

describe("production ranking comparison", () => {
  it("ranks every predeclared fictional retention case first and recovers every required source", () => {
    const report = compareRankings(loadRankingFixture("continuity-ranking-retention4"));
    for (const row of report.cases) {
      expect(row.results[2].rank, row.name).toBe(1);
      expect(row.results[2].allRequiredRecovered, row.name).toBe(true);
      expect(row.results[2].allRequiredTop5, row.name).toBe(true);
    }
    expect(report.summary.map(row => row.version)).toEqual([1, 2, 3]);
    expect(report.summary[2].mrr).toBe(1);
  });

  it("enforces aggregate and per-case independent-set nonregression without changing its fixture", () => {
    const report = compareRankings(loadRankingFixture("continuity-ranking-heldout-independent"));
    for (const row of report.cases) {
      if (row.results[1].rank === 1) expect(row.results[2].rank, row.name).toBe(1);
    }
    for (const key of ["mrr", "top1", "top5", "top10", "allRequiredRecovered", "allRequiredTop5"]) {
      expect(report.summary[2][key], key).toBeGreaterThanOrEqual(report.summary[1][key]);
    }
  });

  it("reports missing required sources and reciprocal ranks rather than crediting an echo", () => {
    const report = compareRankings({ cases: [{ name: "missing-control", query: "copper", expectedFirst: 0, required: [0, 1],
      records: [{ kind: "user", text: "unrelated" }, { kind: "user", text: "copper" }] }] });
    for (const row of report.cases[0].results) {
      expect(row.rank).toBeNull(); expect(row.requiredRanks).toEqual([null, 1]);
      expect(row.allRequiredRecovered).toBe(false);
    }
    expect(report.summary.every(row => row.mrr === 0 && row.top1 === 0 && row.allRequiredRecovered === 0)).toBe(true);
  });
});
