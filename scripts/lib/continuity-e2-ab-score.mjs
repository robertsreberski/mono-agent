// Observational History A/B scoring. Never the release gate: `qualification` is
// always false. Each answer is classified by the frozen `scoreE2` on that single
// answer, then crossed with whether the probe looked anything up.
import { fail } from "./continuity-observation-input.mjs";
import { scoreE2 } from "./continuity-e2-score.mjs";
import { EVALUATOR_SCHEMA, digest } from "./continuity-recorded-schema.mjs";
import { assertE2HistoryAbBinding, e2AbArmLetters, E2_AB_LOOKUPS_SCHEMA } from "./continuity-e2-ab.mjs";
export const E2_AB_SCORE_SCHEMA = "continuity-e2-ab-score-v1";
const need = ok => { if (!ok) fail("E2_SCORING_INVALID"); };
const count = n => Number.isSafeInteger(n) && n >= 0;
// Frozen scoreE2 classes; anything else (inconclusive, expectedSafe, nonRatePass) is reported as-is.
const OUTCOME = Object.freeze({ ratePass: "correct", blocking: "wrong", rateMiss: "abstain" });
/** The frozen scorer's classification of exactly one answer. */
export function classifyE2AbAnswer(answer, key) {
  const single = { ...answer, repeat: 1 };
  const { report } = scoreE2({ schema: "continuity-e2-answers-v1", answers: [single] }, { schema: EVALUATOR_SCHEMA, keys: [key] });
  const counts = report.byCheckpointAndRepeat.find(row => row.repeat === 1).counts;
  const hits = Object.entries(counts).filter(([, n]) => n === 1);
  need(hits.length === 1 && Object.values(counts).reduce((n, v) => n + v, 0) === 1);
  return hits[0][0];
}
function tally(rows) {
  const n = rows.length, looked = rows.filter(r => r.lookup), result = { answers: n, lookups: looked.length, lookupRate: n ? looked.length / n : null,
    correct: 0, wrongWithoutLookup: 0, wrongAfterLookup: 0, abstain: 0, correctWithoutLookup: 0, other: {}, missing: 0,
    byScope: { said: rows.filter(r => r.scopes.said > 0).length, tools: rows.filter(r => r.scopes.tools > 0).length, runs: rows.filter(r => r.scopes.runs > 0).length } };
  for (const r of rows) {
    if (r.outcome === "missing") result.missing++;
    else if (r.outcome === "correct") { result.correct++; if (!r.lookup) result.correctWithoutLookup++; }
    else if (r.outcome === "wrong") result[r.lookup ? "wrongAfterLookup" : "wrongWithoutLookup"]++;
    else if (r.outcome === "abstain") result.abstain++;
    else result.other[r.classification] = (result.other[r.classification] ?? 0) + 1;
  }
  return result;
}
/**
 * `arms` maps each registered arm letter to `{ answers, lookups }` as written by
 * the A/B phase (`answers.json`, `lookups.json`). Output is content-free: row ids,
 * repeat ordinals, frozen classifications and lookup counts only.
 */
export function scoreE2HistoryAb({ historyAb, evaluator, arms }) {
  assertE2HistoryAbBinding(historyAb);
  need(evaluator?.schema === EVALUATOR_SCHEMA && Array.isArray(evaluator.keys) && arms && typeof arms === "object"
    && Object.keys(arms).sort().join() === [...e2AbArmLetters(historyAb)].sort().join());
  const keys = new Map(historyAb.rows.map(id => [id, evaluator.keys.find(k => k.id === id)]));
  need([...keys.values()].every(Boolean));
  const report = { schema: E2_AB_SCORE_SCHEMA, qualification: false, gate: "not-applicable-observational", scorer: "frozen-scoreE2-single-answer",
    mapping: { ...OUTCOME }, keysDigest: digest(JSON.stringify(evaluator)), rows: historyAb.rows.length, primaryRows: historyAb.primary.length, arms: [] };
  for (const arm of e2AbArmLetters(historyAb)) {
    const { answers, lookups } = arms[arm];
    need(answers?.schema === "continuity-e2-answers-v1" && Array.isArray(answers.answers) && lookups?.schema === E2_AB_LOOKUPS_SCHEMA && lookups.arm === arm && Array.isArray(lookups.lookups));
    const rows = [];
    for (const id of historyAb.rows) for (const repeat of [1, 2]) {
      const matches = answers.answers.filter(a => a?.id === id && a.repeat === repeat), seen = lookups.lookups.filter(l => l?.id === id && l.repeat === repeat);
      need(matches.length <= 1 && seen.length === matches.length);
      if (!matches.length) { rows.push({ id, repeat, classification: null, outcome: "missing", lookup: false, scopes: { said: 0, tools: 0, runs: 0 } }); continue; }
      const scopes = { said: seen[0].said, tools: seen[0].tools, runs: seen[0].runs };
      need(Object.values(scopes).every(count) && Object.keys(seen[0]).sort().join() === "id,repeat,runs,said,tools");
      const classification = classifyE2AbAnswer(matches[0], keys.get(id));
      rows.push({ id, repeat, classification, outcome: OUTCOME[classification] ?? "other", lookup: scopes.said + scopes.tools + scopes.runs > 0, scopes });
    }
    need(answers.answers.length === rows.filter(r => r.outcome !== "missing").length);
    report.arms.push({ arm, overall: tally(rows), primary: tally(rows.filter(r => historyAb.primary.includes(r.id))), items: rows });
  }
  return report;
}
