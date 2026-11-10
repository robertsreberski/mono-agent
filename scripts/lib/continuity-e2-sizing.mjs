// Offline sizing normalization. No authorization/credential/registry imports or access.
import { PROTOCOL_SCHEMA, protocolDigest, assertE2CheckpointOrder, assertE2ProbeLookupRounds, SOL, LUNA } from "./continuity-e2-protocol.mjs";
import { requireE2PaidRole } from "./continuity-e2-roles.mjs";
import { E2_INPUT_LIMITS } from "./continuity-e2-policy.mjs";
import { validateE2Sizing, estimateE2Reservations } from "./continuity-e2-estimate.mjs";
export const E2_MAX_SIZING_RECORDS = E2_INPUT_LIMITS.sizingFiles;
const need = ok => { if (!ok) throw Object.assign(Error("E2_ESTIMATE_INVALID"), { code: "E2_ESTIMATE_INVALID" }); };
const ordinal = n => Number.isSafeInteger(n) && n >= 0;
const hash = s => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s);
// This is a metadata-only estimator check, not source/evidence validation or spending authority.
export function validateE2EstimateProtocol(protocol) {
  assertE2ProbeLookupRounds(protocol?.probeLookupRounds);
  need(protocol?.schema === PROTOCOL_SCHEMA && Array.isArray(protocol.branches) && protocol.branches.length === 2
    && protocol.branches[0]?.id === "main" && protocol.branches[1]?.id === "prefix");
  for (const branch of protocol.branches) {
    need(ordinal(branch.startTurn) && ordinal(branch.endTurn) && branch.startTurn <= branch.endTurn
      && Array.isArray(branch.models) && branch.models.length > 0 && branch.models.every(m => [SOL, LUNA].includes(m?.model))
      && Array.isArray(branch.checkpoints) && branch.checkpoints.length > 0 && branch.checkpoints.length <= 48);
    for (const c of branch.checkpoints) need(typeof c.name === "string" && c.name.length > 0 && ordinal(c.turn) && ordinal(c.message));
    assertE2CheckpointOrder(branch.checkpoints);
  }
  return protocol;
}
function sizingRow(row, checkpoint) {
  requireE2PaidRole(row); validateE2Sizing(row.size);
  need([SOL, LUNA].includes(row.model) && ordinal(row.maxOutputTokens) && row.maxOutputTokens > 0);
  return { checkpoint, role: row.role, paidRole: row.paidRole, model: row.model, maxOutputTokens: row.maxOutputTokens, size: row.size };
}
export function normalizeE2Sizing(protocol, sizing, checkpointOffset = 0) {
  validateE2EstimateProtocol(protocol); need(ordinal(checkpointOffset) && sizing?.semanticQualification === false && sizing.usage === "estimated-not-measured");
  const requests = [];
  if (sizing.schema === "continuity-e2-sizing-v1") {
    need(sizing.protocolDigest === protocolDigest(protocol) && hash(sizing.sourceDigest) && ["faux-short", "faux-max"].includes(sizing.summary)
      && Array.isArray(sizing.branches) && sizing.branches.length === protocol.branches.length);
    let checkpoint = checkpointOffset;
    for (const [index, branch] of sizing.branches.entries()) {
      const registered = protocol.branches[index];
      // Legacy records cannot prove which requests were paid, especially cancelled continuations.
      if (!Array.isArray(branch.requestSizing)) throw Object.assign(Error("E2_SIZING_PAID_ROLE_REQUIRED"), { code: "E2_SIZING_PAID_ROLE_REQUIRED" });
      need(branch.branch === index && branch.requestSizing.length > 0 && branch.requestSizing.length <= 100000);
      for (const row of branch.requestSizing) {
        need(ordinal(row.turn) && row.turn >= registered.startTurn && row.turn <= registered.endTurn && ordinal(row.message));
        let c = registered.checkpoints.findIndex(c => c.turn >= row.turn); if (c < 0) c = registered.checkpoints.length - 1;
        requests.push(sizingRow(row, checkpoint + c));
      }
      checkpoint += registered.checkpoints.length;
    }
    return { kind: "replay", scenario: sizing.summary, requests, checkpoints: checkpoint - checkpointOffset };
  }
  need(sizing.schema === "continuity-e2-proof-sizing-v1" && sizing.mode === "faux" && ["switch", "cancel", "idle", "pressure"].includes(sizing.arm)
    && Array.isArray(sizing.variants) && sizing.variants.length > 0 && sizing.variants.length <= 2);
  const seen = new Set();
  for (const [index, variant] of sizing.variants.entries()) {
    need(["ceiling", "restart"].includes(variant.variant) && !seen.has(variant.variant) && Array.isArray(variant.requests)
      && variant.requests.length > 0 && variant.requests.length <= 100000); seen.add(variant.variant);
    for (const [i, row] of variant.requests.entries()) { need(row.ordinal === i); requests.push(sizingRow(row, checkpointOffset + index)); }
  }
  return { kind: "proof", arm: sizing.arm, requests, checkpoints: sizing.variants.length };
}
export function estimateE2SizingSet({ protocol, roles, records, catalog, probeCounts = [] }) {
  validateE2EstimateProtocol(protocol); need(Array.isArray(records) && records.length > 0 && records.length <= E2_MAX_SIZING_RECORDS);
  const replay = [], proofs = [], arms = new Set(), scenarios = new Set(); let sourceDigest;
  const replayCheckpoints = protocol.branches.reduce((n, b) => n + b.checkpoints.length, 0);
  const hasReplay = records.some(r => r?.schema === "continuity-e2-sizing-v1");
  need(Array.isArray(probeCounts));
  const counts = new Map();
  for (const c of probeCounts) { need(ordinal(c?.checkpoint) && c.checkpoint < replayCheckpoints && ordinal(c.questions) && c.questions <= 48 && !counts.has(c.checkpoint)); counts.set(c.checkpoint, c.questions); }
  if (hasReplay && counts.size !== replayCheckpoints) throw Object.assign(Error("E2_PROBE_COUNTS_REQUIRED"), { code: "E2_PROBE_COUNTS_REQUIRED" });
  const questionCount = [...counts.values()].reduce((n, q) => n + q, 0); need(questionCount <= 48);
  let offset = hasReplay ? replayCheckpoints : 0;
  for (const record of records) {
    const normalized = normalizeE2Sizing(protocol, record, record.schema === "continuity-e2-sizing-v1" ? 0 : offset);
    if (normalized.kind === "replay") {
      need(!scenarios.has(normalized.scenario) && (sourceDigest === undefined || sourceDigest === record.sourceDigest));
      sourceDigest = record.sourceDigest; scenarios.add(normalized.scenario);
      normalized.requests = normalized.requests.flatMap(row => ["probe", "continuation"].includes(row.paidRole)
        ? Array.from({ length: counts.get(row.checkpoint) }, () => row) : [row]);
      replay.push(normalized);
    } else { need(!arms.has(normalized.arm)); arms.add(normalized.arm); for (const request of normalized.requests) proofs.push(request); offset += normalized.checkpoints; }
  }
  // Short/max faux summaries are alternatives, not two paid summary draws. Proof variants are planned distinct runs.
  const alternatives = replay.length ? replay : [{ scenario: "proof-only", requests: [] }];
  const estimates = alternatives.map(r => ({ scenario: r.scenario, ...estimateE2Reservations({ roles, requests: [...r.requests, ...proofs], catalog }) }));
  // Registration funds the union of per-role/checkpoint maximum budgets, not a sum
  // of alternative draws. Forecast that bound schedule at the largest observed size.
  const bound = new Map();
  for (const alternative of alternatives) {
    const groups = new Map();
    for (const row of alternative.requests) if (row.paidRole !== null) {
      const key = `${row.checkpoint}:${row.paidRole}:${row.model}`;
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
    }
    for (const [key, rows] of groups) {
      const previous = bound.get(key), largest = rows.reduce((a, b) => a.size.maximum >= b.size.maximum ? a : b);
      bound.set(key, { count: Math.max(previous?.count ?? 0, rows.length), row: previous?.row.size.maximum > largest.size.maximum ? previous.row : largest });
    }
  }
  const boundRequests = [...bound.values()].flatMap(({ count, row }) => Array.from({ length: count }, () => row));
  const fundedSchedule = estimateE2Reservations({ roles, requests: [...boundRequests, ...proofs], catalog });
  return { schema: "continuity-e2-cap-estimate-set-v1", semanticQualification: false, authorization: false,
    protocolValidation: "metadata-and-sizing-binding-only", scope: "provided-sizing-and-explicit-probe-counts-only",
    plannedReplayQuestions: questionCount, proofArms: arms.size, scenarios: estimates, fundedSchedule,
    forecastMinimumCapUnits: fundedSchedule.forecastMinimumCapUnits, forecastNoCacheMinimumCapUnits: fundedSchedule.forecastNoCacheMinimumCapUnits,
    largestReservationUnits: fundedSchedule.largestReservationUnits, worstCaseCapUnits: fundedSchedule.worstCaseCapUnits };
}
