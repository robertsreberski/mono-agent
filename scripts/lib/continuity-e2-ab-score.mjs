// Observational History A/B scoring. Never the release gate: `qualification` is
// always false. Each answer is classified by the frozen `scoreE2` on that single
// answer, then crossed with whether the probe looked anything up. Lookups come
// only from the phase's validated probe receipts; an item whose receipts are
// missing or inconsistent is reported as such, never as "no lookup".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./continuity-observation-input.mjs";
import { scoreE2 } from "./continuity-e2-score.mjs";
import { EVALUATOR_SCHEMA, digest } from "./continuity-recorded-schema.mjs";
import { assertE2HistoryAbBinding, e2AbArmLetters } from "./continuity-e2-ab.mjs";
import { E2_AB_ARM_SURFACES, historyCallScope, historyToolName } from "./continuity-e2-history.mjs";
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
const SCOPES = Object.freeze(["said", "tools", "runs"]);
const RECEIPT_SCHEMA = "continuity-e2-probe-receipt-v1";
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const sha = v => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const bounded = v => object(v) && typeof v.text === "string" && count(v.bytes) && count(v.capturedBytes) && sha(v.sha256) && typeof v.truncated === "boolean";
/**
 * Read one phase's `probe-receipts/` as `{ ordinal, value }` in name order. Torn
 * or unpublished entries keep their place as `value: null`; an absent directory
 * is an empty stream (every answered item is then unverified).
 */
export function readE2AbReceipts(directory) {
  let names; try { names = readdirSync(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  need(names.length <= 3 * 4096);
  const entries = [];
  for (const name of names.sort()) {
    const match = /^(\d{6})\.json$/u.exec(name);
    if (!match) { if (!/^\.claim-\d{6}\.json$/u.test(name)) entries.push({ ordinal: null, value: null }); continue; }
    let value = null; try { value = JSON.parse(readFileSync(join(directory, name), "utf8")); } catch { /* torn entry: inconsistent stream */ }
    entries.push({ ordinal: Number(match[1]), value });
  }
  return entries;
}
/**
 * Per registered (row, repeat): `{ status: "verified", scopes }` only when the
 * arm's receipt stream is contiguous and well-formed and the item has exactly one
 * `settled` receipt whose call/response counts match the paired call receipts.
 * Otherwise `missing` (no settled receipt) or `inconsistent`.
 */
export function e2AbLookupEvidence(historyAb, arm, receipts) {
  assertE2HistoryAbBinding(historyAb);
  const toolName = historyToolName(E2_AB_ARM_SURFACES[arm].historySurface), items = new Map();
  for (const id of historyAb.rows) for (const repeat of [1, 2]) items.set(`${id}\u0000${repeat}`, { call: [], response: [], settled: [] });
  let stream = Array.isArray(receipts) && receipts.every((r, i) => r?.ordinal === i + 1), slotId, checkpoint;
  for (const { value: v } of Array.isArray(receipts) ? receipts : []) {
    const ordinal = typeof v?.rowId === "string" ? historyAb.rows.indexOf(v.rowId) + 1 : 0;
    const ok = object(v) && v.schema === RECEIPT_SCHEMA && ["call", "response", "settled"].includes(v.phase) && v.arm === arm && ordinal > 0 && v.itemOrdinal === ordinal
      && [1, 2].includes(v.repeat) && v.branch === historyAb.frozen.branch && count(v.checkpoint) && (checkpoint ??= v.checkpoint) === v.checkpoint
      && typeof v.slotId === "string" && (slotId ??= v.slotId) === v.slotId;
    if (!ok) { stream = false; continue; }
    items.get(`${v.rowId}\u0000${v.repeat}`)[v.phase].push(v);
  }
  const result = new Map();
  for (const [key, { call, response, settled }] of items) {
    if (!stream) { result.set(key, { status: "inconsistent" }); continue; }
    if (!settled.length) { result.set(key, { status: call.length || response.length ? "inconsistent" : "missing" }); continue; }
    const s = settled[0], scopes = { said: 0, tools: 0, runs: 0 }, ids = new Set();
    let ok = settled.length === 1 && count(s.requests) && s.calls === call.length && s.responses === response.length && s.unanswered === 0 && call.length === response.length;
    for (const c of ok ? call : []) {
      const name = c.tool?.text;
      ok &&= bounded(c.tool) && !c.tool.truncated && (name === toolName || name.endsWith(`__${toolName}`)) && bounded(c.callId) && bounded(c.arguments)
        && SCOPES.includes(c.scope) && count(c.requestOrdinal) && c.requestOrdinal >= 1 && c.requestOrdinal <= s.requests && !ids.has(c.callId.sha256);
      if (!ok) break;
      ids.add(c.callId.sha256);
      // Re-derive the scope from the captured call where it was captured whole.
      if (!c.arguments.truncated) {
        let input; try { input = JSON.parse(c.arguments.text); } catch { ok = false; break; }
        ok = (historyCallScope(name, input) ?? (name.endsWith("ConversationHistory") ? "said" : undefined)) === c.scope;
        if (!ok) break;
      }
      scopes[c.scope]++;
    }
    // Every response answers exactly one captured call of this item.
    const answered = new Set();
    for (const r of ok ? response : []) {
      ok &&= bounded(r.callId) && ids.has(r.callId.sha256) && !answered.has(r.callId.sha256) && typeof r.isError === "boolean";
      if (!ok) break;
      answered.add(r.callId.sha256);
    }
    result.set(key, ok ? { status: "verified", scopes } : { status: "inconsistent" });
  }
  return result;
}
function tally(rows) {
  const answered = rows.filter(r => r.outcome !== "missing"), verified = answered.filter(r => r.lookupEvidence === "verified"), looked = verified.filter(r => r.lookup);
  const result = { answers: answered.length, lookups: looked.length, lookupRate: verified.length ? looked.length / verified.length : null,
    lookupEvidence: { verified: verified.length, missing: answered.filter(r => r.lookupEvidence === "missing").length, inconsistent: answered.filter(r => r.lookupEvidence === "inconsistent").length },
    correct: 0, wrongWithoutLookup: 0, wrongAfterLookup: 0, wrongLookupUnverified: 0, abstain: 0, correctWithoutLookup: 0, correctLookupUnverified: 0, other: {}, missing: rows.length - answered.length,
    byScope: Object.fromEntries(SCOPES.map(scope => [scope, verified.filter(r => r.scopes[scope] > 0).length])) };
  for (const r of answered) {
    const known = r.lookupEvidence === "verified";
    if (r.outcome === "correct") { result.correct++; if (!known) result.correctLookupUnverified++; else if (!r.lookup) result.correctWithoutLookup++; }
    else if (r.outcome === "wrong") result[!known ? "wrongLookupUnverified" : r.lookup ? "wrongAfterLookup" : "wrongWithoutLookup"]++;
    else if (r.outcome === "abstain") result.abstain++;
    else result.other[r.classification] = (result.other[r.classification] ?? 0) + 1;
  }
  return result;
}
/**
 * `arms` maps each registered arm letter to `{ answers, receipts }`: the phase's
 * `answers.json` and its `probe-receipts/` stream (see `readE2AbReceipts`).
 * Output is content-free: row ids, repeat ordinals, frozen classifications,
 * receipt-derived lookup counts and evidence status only.
 */
export function scoreE2HistoryAb({ historyAb, evaluator, arms }) {
  assertE2HistoryAbBinding(historyAb);
  need(evaluator?.schema === EVALUATOR_SCHEMA && Array.isArray(evaluator.keys) && arms && typeof arms === "object"
    && Object.keys(arms).sort().join() === [...e2AbArmLetters(historyAb)].sort().join());
  const keys = new Map(historyAb.rows.map(id => [id, evaluator.keys.find(k => k.id === id)]));
  need([...keys.values()].every(Boolean));
  const report = { schema: E2_AB_SCORE_SCHEMA, qualification: false, gate: "not-applicable-observational", scorer: "frozen-scoreE2-single-answer",
    lookupSource: "validated-probe-receipts", mapping: { ...OUTCOME }, keysDigest: digest(JSON.stringify(evaluator)), rows: historyAb.rows.length, primaryRows: historyAb.primary.length, arms: [] };
  for (const arm of e2AbArmLetters(historyAb)) {
    const { answers, receipts } = arms[arm];
    need(answers?.schema === "continuity-e2-answers-v1" && Array.isArray(answers.answers) && Array.isArray(receipts));
    const evidence = e2AbLookupEvidence(historyAb, arm, receipts), rows = [];
    for (const id of historyAb.rows) for (const repeat of [1, 2]) {
      const matches = answers.answers.filter(a => a?.id === id && a.repeat === repeat);
      need(matches.length <= 1);
      if (!matches.length) { rows.push({ id, repeat, classification: null, outcome: "missing", lookupEvidence: null, lookup: null, scopes: null }); continue; }
      const seen = evidence.get(`${id}\u0000${repeat}`), verified = seen.status === "verified";
      const classification = classifyE2AbAnswer(matches[0], keys.get(id));
      rows.push({ id, repeat, classification, outcome: OUTCOME[classification] ?? "other", lookupEvidence: seen.status,
        lookup: verified ? SCOPES.some(scope => seen.scopes[scope] > 0) : null, scopes: verified ? seen.scopes : null });
    }
    need(answers.answers.length === rows.filter(r => r.outcome !== "missing").length);
    report.arms.push({ arm, overall: tally(rows), primary: tally(rows.filter(r => historyAb.primary.includes(r.id))), items: rows });
  }
  return report;
}
