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
import { digest as canonicalDigest } from "./continuity-dataset.mjs";
import { assertE2HistoryAbBinding, e2AbArmLetters } from "./continuity-e2-ab.mjs";
import { E2_AB_ARM_SURFACES, e2AbSlotArm, historyCallScope, historyServerName, historyToolName } from "./continuity-e2-history.mjs";
import { E2_PROBE_RECEIPT_LIMITS } from "./continuity-e2-probe-receipts.mjs";
// The receipt writer's fixed caps for the tool name and call id captures.
const TOOL_CAPTURE_BYTES = 256, CALL_ID_CAPTURE_BYTES = 1024;
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
const TRUNCATION_MARKER = "\n[probe receipt truncated]";
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const sha = v => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const keys = (v, required, optional = []) => object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const bounded = v => keys(v, ["text", "bytes", "capturedBytes", "sha256", "truncated"]) && typeof v.text === "string" && count(v.bytes) && count(v.capturedBytes) && sha(v.sha256) && typeof v.truncated === "boolean";
// A whole capture: its text is exactly the recorded bytes, recomputed here.
const intact = (v, limit) => bounded(v) && !v.truncated && v.bytes <= limit && v.capturedBytes === v.bytes
  && Buffer.byteLength(v.text) === v.bytes && digest(Buffer.from(v.text)) === v.sha256;
// A truncated capture keeps a UTF-8-safe prefix: its lengths are recomputed; the full-content digest cannot be.
const prefixed = (v, limit) => bounded(v) && v.truncated && v.bytes > limit && v.capturedBytes <= limit && v.text.endsWith(TRUNCATION_MARKER)
  && Buffer.byteLength(v.text.slice(0, -TRUNCATION_MARKER.length)) === v.capturedBytes;
/**
 * Expected receipt provenance for every registered arm, taken from the
 * registration alone: its canonical digest (the paid adapter's receipt
 * binding), the arm's one schedule slot, the frozen branch and the single
 * global checkpoint that carries the registered rows.
 */
export function e2AbReceiptExpectations(pilot) {
  const r = pilot?.registration;
  need(object(r) && r.replayArm === "history-ab" && Array.isArray(r.schedule) && Array.isArray(r.probeCounts));
  const historyAb = assertE2HistoryAbBinding(r.historyAb), active = r.probeCounts.filter(c => object(c) && c.questions > 0);
  need(active.length === 1 && count(active[0].checkpoint) && active[0].questions === historyAb.rows.length && count(active[0].lookupRounds));
  const { checkpoint, lookupRounds } = active[0], registrationSha256 = canonicalDigest(pilot), arms = {};
  for (const arm of e2AbArmLetters(historyAb)) {
    const slots = r.schedule.filter(slot => slot?.arm === e2AbSlotArm(arm));
    need(slots.length === 1 && sha(slots[0].slotId) && Array.isArray(slots[0].budgets) && slots[0].budgets.every(b => b?.checkpoint === checkpoint));
    arms[arm] = { registrationSha256, slotId: slots[0].slotId, arm, branch: historyAb.frozen.branch, checkpoint };
  }
  need(r.schedule.length === Object.keys(arms).length);
  return { historyAb, registrationSha256, lookupRounds, arms };
}
/** Bind the scorer's inputs to the registered bytes: the registration by its sha256, the keys by the registration's own binding. */
export function e2AbScoringInputs({ registrationBytes, registrationSha256, keysBytes }) {
  need(Buffer.isBuffer(registrationBytes) && sha(registrationSha256) && digest(registrationBytes) === registrationSha256 && Buffer.isBuffer(keysBytes));
  let pilot, evaluator; try { pilot = JSON.parse(registrationBytes); evaluator = JSON.parse(keysBytes); } catch { need(false); }
  need(object(pilot?.registration?.keys) && digest(keysBytes) === pilot.registration.keys.sha256);
  return { pilot, evaluator };
}
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
const BINDING = ["schema", "phase", "slotId", "registrationSha256", "branch", "checkpoint", "repeat", "itemOrdinal", "arm", "rowId"];
const CALL = ["requestOrdinal", "tool", "scope", "callId", "arguments"];
const RECEIPT_KEYS = Object.freeze({ call: [[...BINDING, ...CALL], ["requestContext"]], response: [[...BINDING, ...CALL, "isError", "response", "metadata"], ["requestContext"]],
  settled: [[...BINDING, "requests", "calls", "responses", "unanswered"], []] });
const callFields = v => Object.fromEntries([...CALL, "requestContext"].filter(k => Object.hasOwn(v, k)).map(k => [k, v[k]]));
/**
 * Per registered (row, repeat): `{ status: "verified", scopes }` only when the
 * arm's receipt stream is contiguous, every receipt is bound to the EXPECTED
 * registration, slot, arm, branch and checkpoint and to a registered row and
 * repeat, probes appear once each in registered order and close with exactly
 * one `settled` receipt, and every captured tool name, call id, argument and
 * result matches its recorded hash and lengths. Otherwise `missing` (no receipt
 * at all) or `inconsistent`; neither can be scored as a lookup cross.
 */
export function e2AbLookupEvidence(historyAb, arm, receipts, expected, lookupRounds) {
  assertE2HistoryAbBinding(historyAb);
  need(object(expected) && expected.arm === arm && sha(expected.registrationSha256) && sha(expected.slotId) && expected.branch === historyAb.frozen.branch && count(expected.checkpoint) && count(lookupRounds));
  const surface = E2_AB_ARM_SURFACES[arm].historySurface, toolName = historyToolName(surface), toolNames = [toolName, `mcp__${historyServerName(surface)}__${toolName}`];
  const position = v => (historyAb.rows.indexOf(v.rowId)) * 2 + v.repeat - 1, blocks = new Map();
  let stream = Array.isArray(receipts) && receipts.every((r, i) => r?.ordinal === i + 1), current;
  for (const { value: v } of stream ? receipts : []) {
    const ordinal = typeof v?.rowId === "string" ? historyAb.rows.indexOf(v.rowId) + 1 : 0;
    // Provenance comes from the registration, never from the receipt itself.
    const ok = object(v) && v.schema === RECEIPT_SCHEMA && Object.hasOwn(RECEIPT_KEYS, v.phase) && keys(v, ...RECEIPT_KEYS[v.phase])
      && v.registrationSha256 === expected.registrationSha256 && v.slotId === expected.slotId && v.arm === arm
      && v.branch === expected.branch && v.checkpoint === expected.checkpoint && ordinal > 0 && v.itemOrdinal === ordinal && [1, 2].includes(v.repeat);
    if (!ok) { stream = false; break; }
    const at = position(v);
    if (current?.position !== at) {
      // A probe starts only after the previous one settled, once, in registered order.
      if (current && !current.settled || current && at <= current.position) { stream = false; break; }
      current = { position: at, entries: [], settled: null }; blocks.set(at, current);
    } else if (current.settled) { stream = false; break; }
    if (v.phase === "settled") current.settled = v; else current.entries.push(v);
  }
  const result = new Map();
  for (const id of historyAb.rows) for (const repeat of [1, 2]) {
    const key = `${id}\u0000${repeat}`, block = blocks.get(position({ rowId: id, repeat }));
    if (!stream) { result.set(key, { status: "inconsistent" }); continue; }
    if (!block) { result.set(key, { status: "missing" }); continue; }
    const s = block.settled, calls = new Map(), scopes = { said: 0, tools: 0, runs: 0 };
    let ok = s !== null && count(s.requests) && s.requests >= 1 && s.requests <= lookupRounds + 1 && count(s.calls) && count(s.responses) && s.unanswered === 0, responses = 0;
    for (const e of ok ? block.entries : []) {
      if (e.phase === "call") {
        let input;
        ok = intact(e.tool, TOOL_CAPTURE_BYTES) && toolNames.includes(e.tool.text) && intact(e.callId, CALL_ID_CAPTURE_BYTES) && !calls.has(e.callId.sha256)
          && intact(e.arguments, E2_PROBE_RECEIPT_LIMITS.argumentsBytes) && SCOPES.includes(e.scope)
          // Lookups happen only in the R lookup rounds; the final request is tool-free.
          && count(e.requestOrdinal) && e.requestOrdinal >= 1 && e.requestOrdinal <= Math.min(s.requests, lookupRounds)
          && (e.requestContext === undefined || keys(e.requestContext, ["bytes", "sha256"]) && count(e.requestContext.bytes) && sha(e.requestContext.sha256));
        // The scope is re-derived from the integrity-checked argument bytes.
        if (ok) { try { input = JSON.parse(e.arguments.text); } catch { ok = false; } }
        ok &&= object(input) && (historyCallScope(e.tool.text, input) ?? (e.tool.text.endsWith("ConversationHistory") ? "said" : undefined)) === e.scope;
        if (!ok) break;
        calls.set(e.callId.sha256, { fields: callFields(e), answered: false }); scopes[e.scope]++;
      } else {
        // Every response follows and answers exactly one captured call, carrying that call's exact capture.
        const call = intact(e.callId, CALL_ID_CAPTURE_BYTES) ? calls.get(e.callId.sha256) : undefined;
        ok = call !== undefined && !call.answered && canonicalDigest(callFields(e)) === canonicalDigest(call.fields) && typeof e.isError === "boolean"
          && (intact(e.response, E2_PROBE_RECEIPT_LIMITS.responseBytes) || prefixed(e.response, E2_PROBE_RECEIPT_LIMITS.responseBytes))
          && (intact(e.metadata, E2_PROBE_RECEIPT_LIMITS.metadataBytes) || prefixed(e.metadata, E2_PROBE_RECEIPT_LIMITS.metadataBytes));
        if (ok && !e.metadata.truncated) { try { ok = object(JSON.parse(e.metadata.text)); } catch { ok = false; } }
        if (!ok) break;
        call.answered = true; responses++;
      }
    }
    ok &&= s.calls === calls.size && s.responses === responses && calls.size === responses;
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
 * `pilot` is the registration (see `e2AbScoringInputs`); every receipt is bound
 * to its expectations. `arms` maps each registered arm letter to
 * `{ answers, receipts }`: the phase's `answers.json` and its `probe-receipts/`
 * stream (see `readE2AbReceipts`). Output is content-free: row ids, repeat
 * ordinals, frozen classifications, receipt-derived lookup counts and evidence status only.
 */
export function scoreE2HistoryAb({ pilot, evaluator, arms }) {
  const expected = e2AbReceiptExpectations(pilot), { historyAb } = expected;
  need(evaluator?.schema === EVALUATOR_SCHEMA && Array.isArray(evaluator.keys) && arms && typeof arms === "object"
    && Object.keys(arms).sort().join() === [...e2AbArmLetters(historyAb)].sort().join());
  const keyed = new Map(historyAb.rows.map(id => [id, evaluator.keys.find(k => k.id === id)]));
  need([...keyed.values()].every(Boolean));
  const report = { schema: E2_AB_SCORE_SCHEMA, qualification: false, gate: "not-applicable-observational", scorer: "frozen-scoreE2-single-answer",
    lookupSource: "validated-probe-receipts", registrationSha256: expected.registrationSha256, mapping: { ...OUTCOME }, keysDigest: digest(JSON.stringify(evaluator)),
    rows: historyAb.rows.length, primaryRows: historyAb.primary.length, arms: [] };
  for (const arm of e2AbArmLetters(historyAb)) {
    const { answers, receipts } = arms[arm];
    need(answers?.schema === "continuity-e2-answers-v1" && Array.isArray(answers.answers) && Array.isArray(receipts));
    const evidence = e2AbLookupEvidence(historyAb, arm, receipts, expected.arms[arm], expected.lookupRounds), rows = [];
    for (const id of historyAb.rows) for (const repeat of [1, 2]) {
      const matches = answers.answers.filter(a => a?.id === id && a.repeat === repeat);
      need(matches.length <= 1);
      if (!matches.length) { rows.push({ id, repeat, classification: null, outcome: "missing", lookupEvidence: null, lookup: null, scopes: null }); continue; }
      const seen = evidence.get(`${id}\u0000${repeat}`), verified = seen.status === "verified";
      const classification = classifyE2AbAnswer(matches[0], keyed.get(id));
      rows.push({ id, repeat, classification, outcome: OUTCOME[classification] ?? "other", lookupEvidence: seen.status,
        lookup: verified ? SCOPES.some(scope => seen.scopes[scope] > 0) : null, scopes: verified ? seen.scopes : null });
    }
    need(answers.answers.length === rows.filter(r => r.outcome !== "missing").length);
    report.arms.push({ arm, slotId: expected.arms[arm].slotId, overall: tally(rows), primary: tally(rows.filter(r => historyAb.primary.includes(r.id))), items: rows });
  }
  return report;
}
