#!/usr/bin/env node
// Fictional, provider-free ranking comparison. Build conversation first.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { relevancePipeline } from "../packages/conversation/dist/tool-history/relevance-pipeline.js";

export function compareRankings(fixture) {
  const versions = [1, 2, 3];
  const cases = fixture.cases.map(scenario => {
    const required = scenario.required ?? [scenario.expectedFirst];
    const results = versions.map(version => {
      const pipeline = relevancePipeline(version, scenario.query);
      const ranked = scenario.records.flatMap((record, index) => {
        const match = pipeline.match(record.text, record.kind);
        return match ? [{ index, recordId: `fiction-${index}`, ordinal: index + 1,
          score: pipeline.query.mode === "literal" ? 1 : match.score }] : [];
      }).sort(pipeline.compare);
      const rankOf = index => { const position = ranked.findIndex(row => row.index === index); return position < 0 ? null : position + 1; };
      const requiredRanks = required.map(rankOf);
      return { version, rank: rankOf(scenario.expectedFirst), requiredRanks,
        allRequiredRecovered: requiredRanks.every(rank => rank !== null),
        allRequiredTop5: requiredRanks.every(rank => rank !== null && rank <= 5),
        order: ranked.map(row => row.index), scores: ranked.map(row => row.score) };
    });
    return { name: scenario.name, results };
  });
  const summary = versions.map((version, index) => {
    const rows = cases.map(row => row.results[index]);
    return { version, cases: rows.length,
      mrr: rows.reduce((total, row) => total + (row.rank === null ? 0 : 1 / row.rank), 0) / rows.length,
      ...Object.fromEntries([1, 5, 10].map(k => [`top${k}`, rows.filter(row => row.rank !== null && row.rank <= k).length])),
      allRequiredRecovered: rows.filter(row => row.allRequiredRecovered).length,
      allRequiredTop5: rows.filter(row => row.allRequiredTop5).length };
  });
  return { cases, summary };
}

export function loadRankingFixture(name) {
  return JSON.parse(readFileSync(new URL(`../packages/conversation/src/__tests__/fixtures/${name}.json`, import.meta.url), "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const name of ["continuity-ranking-retention4", "continuity-ranking-heldout-independent"]) {
    console.log(JSON.stringify({ fixture: name, ...compareRankings(loadRankingFixture(name)) }, null, 2));
  }
}
