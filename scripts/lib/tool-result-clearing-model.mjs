import { qualifiedEntry, qualificationIdentity } from './tool-result-clearing-qualification-id.mjs';
import { APIS } from './tool-result-clearing-reference.mjs';
export const MIN_RETENTION_SHARE = 0.5, MAX_FALLBACK_SHARE = 0.05;
export const SENSITIVITIES = [0, 0.05, 0.20];
export function gate({ pressured, conversations, cold, coldConversations = 0, opportunities, pressureReduction, costs, payload, missingEvidence = false, incomplete = false, codex = false }) {
  if (incomplete || missingEvidence || codex || pressured < 10 || conversations < 3 || cold < 10 || coldConversations < 3) return 'DEFER';
  return opportunities / cold >= 0.25 && pressureReduction >= 0.15
    && SENSITIVITIES.every(rate => costs.some(c => c.retrievalRate === rate)) && costs.every(x => Number.isFinite(x.listRatio) && Number.isFinite(x.quotaRatio) && x.listRatio <= 1.05 && x.quotaRatio <= 1.05)
    && payload === 'payload-preserving' ? 'BUILD' : 'STOP';
}
export function validateRoutes(input) {
  if (!Array.isArray(input) || !input.length) throw new Error('INPUT');
  const seen = new Set();
  return input.map(r => {
    if (!APIS.includes(r.api) || seen.has(r.api)) throw new Error('INPUT');
    seen.add(r.api);
    const keys = ['triggerTokens', 'drainTokens', 'summaryInputTokens', 'summaryOutputTokens', 'cacheMarginMs', 'quotaBudget'];
    if (keys.some(k => !Number.isFinite(r[k]) || r[k] < 0) || r.triggerTokens <= r.drainTokens || r.quotaBudget <= 0
      || !(r.cacheLifetimeMs === 'unknown' || Number.isFinite(r.cacheLifetimeMs) && r.cacheLifetimeMs >= 0)) throw new Error('INPUT');
    for (const view of ['prices', 'quota']) {
      if (['input', 'cacheRead', 'cacheWrite', 'output'].some(k => !Number.isFinite(r[view]?.[k]) || r[view][k] < 0)
        || r[view].input <= 0) throw new Error('INPUT');
    }
    // Explicit projection prevents untrusted labels/extra fields reaching the report.
    return Object.fromEntries(['api', ...keys, 'cacheLifetimeMs', 'prices', 'quota'].map(k => [k,
      ['prices', 'quota'].includes(k) ? Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map(n => [n, r[k][n]])) : r[k]]));
  });
}
export function classifyBoundary(estimate, gap, route) {
  return { pressured: estimate >= 0.75 * route.triggerTokens && estimate < route.triggerTokens,
    cold: gap !== null && route.cacheLifetimeMs !== 'unknown' && gap > route.cacheLifetimeMs + route.cacheMarginMs };
}
export const admitsBatch = net => net >= 20000;
export function budgetBatch(candidates, pinned, pinBytes, budget) {
  const batch = []; let used = pinBytes;
  for (const c of candidates) {
    if (c.category === 'ambiguous' || pinned.has(c.key) || used + c.size > budget) continue;
    batch.push(c); used += c.size;
  }
  return batch;
}
export function model(route, boundaries, retrievalRate) {
  const span = route.triggerTokens - route.drainTokens;
  const growth = boundaries.reduce((s, b) => s + b.growth, 0);
  const saved = boundaries.reduce((s, b) => s + b.saved, 0);
  const count = boundaries.reduce((s, b) => s + b.selected, 0);
  const retrieval = boundaries.reduce((s, b) => s + b.retrievalTokens, 0);
  const offPressure = growth / span;
  const savingsPerCycle = offPressure > 0 ? saved / offPressure : 0;
  const onPressure = (growth + retrievalRate * retrieval) / (span + savingsPerCycle);
  const extraSummary = savingsPerCycle + (offPressure > 0 ? Math.min(savingsPerCycle, count * 500 / offPressure) : 0);
  const summaryFitsWithinTrigger = route.summaryInputTokens + extraSummary + route.summaryOutputTokens <= route.triggerTokens;
  const pressureReduction = offPressure > 0 && summaryFitsWithinTrigger ? 1 - onPressure / offPressure : 0;
  const rates = [...new Set([...SENSITIVITIES, retrievalRate])].sort((a, b) => a - b);
  const costs = rates.map(rate => {
    const view = weights => {
      let off = 0, worstExtra = 0, prefixCostSum = 0, prefixTokensSum = 0;
      const delta = { retained: 0, removed: 0, summary: 0, retrieval: 0 };
      for (const b of boundaries) for (const request of b.requests ?? []) {
        const u = request.usage, prefix = u.input + u.cacheRead + u.cacheWrite;
        const prefixCost = u.input * weights.input + u.cacheRead * weights.cacheRead + u.cacheWrite * weights.cacheWrite;
        const blended = prefix ? prefixCost / prefix : 0;
        prefixCostSum += prefixCost; prefixTokensSum += prefix;
        off += prefixCost + u.output * weights.output;
        const removed = Math.min(request.activeSavings, prefix), retained = savingsPerCycle / 2;
        delta.retained += retained * blended;
        delta.removed -= removed * blended;
        delta.retrieval += rate * request.activeRetrieval * blended;
        // Informational only: reprice the remaining on-arm prefix at no less
        // than uncached input, without discounting a write-premium blend.
        worstExtra += (prefix - removed + retained + rate * request.activeRetrieval) * Math.max(0, weights.input - blended);
      }
      const summaryOff = route.summaryInputTokens * weights.input + route.summaryOutputTokens * weights.output
        + route.drainTokens * weights.cacheWrite;
      off += offPressure * summaryOff;
      const onCycles = (growth + rate * retrieval) / (span + savingsPerCycle);
      delta.summary = (onCycles - offPressure) * summaryOff + onCycles * extraSummary * weights.input;
      // Expected extra retrieval round trips use the cohort's token-weighted
      // observed prefix rate; output remains output-priced, not prefix-priced.
      const blended = prefixTokensSum ? prefixCostSum / prefixTokensSum : weights.input;
      const retrievalInput = rate * (count * route.triggerTokens + retrieval);
      delta.retrieval += retrievalInput * blended + rate * count * route.summaryOutputTokens * weights.output;
      worstExtra += retrievalInput * Math.max(0, weights.input - blended)
        + onCycles * route.drainTokens * Math.max(0, weights.input - weights.cacheWrite);
      const on = off + Object.values(delta).reduce((sum, x) => sum + x, 0);
      return { off, on, delta, worstOn: on + Math.max(0, worstExtra), ratio: off > 0 ? on / off : on > 0 ? null : 1 };
    };
    const list = view(route.prices), quota = view(route.quota);
    // Worst-case recache is reported separately; warm clearing is not enabled by this model.
    const rewrite = route.triggerTokens * boundaries.filter(b => b.saved > 0).length;
    return { retrievalRate: rate, listOff: list.off / 1e6, listOn: list.on / 1e6, listRatio: list.ratio,
      listDelta: Object.fromEntries(Object.entries(list.delta).map(([k, v]) => [k, v / 1e6])),
      quotaShareDelta: Object.fromEntries(Object.entries(quota.delta).map(([k, v]) => [k, v / route.quotaBudget])),
      allUncachedInformational: { gating: false, listOn: list.worstOn / 1e6, quotaShareOn: quota.worstOn / route.quotaBudget },
      quotaShareOff: quota.off / route.quotaBudget, quotaShareOn: quota.on / route.quotaBudget, quotaRatio: quota.ratio,
      warmUnknownWorstListOn: (list.on + rewrite * route.prices.cacheWrite) / 1e6,
      warmUnknownWorstQuotaShareOn: (quota.on + rewrite * route.quota.cacheWrite) / route.quotaBudget };
  });
  return { summaryFitsWithinTrigger, growthTokens: growth, savedTokens: saved, offPressure, onPressure, pressureReduction, costs };
}
export function reportRoute(route, boundaries, qualification, retrievalRate, incomplete) {
  const pressured = boundaries.filter(b => b.pressured);
  const cold = pressured.filter(b => b.cold);
  const modeled = model(route, boundaries, retrievalRate);
  const payload = qualifiedEntry(qualification, route.api);
  const status = !payload ? 'unqualified' : payload.status === 'payload-preserving' && payload.unintendedDifferences === 0 ? 'payload-preserving' : 'fails';
  const codex = route.api === 'openai-codex-responses';
  const codes = [];
  if (!payload) codes.push('PAYLOAD_UNQUALIFIED');
  if (boundaries.some(b => b.candidates > 0) && !boundaries.some(b => b.provenCandidates > 0)) codes.push('IDENTITY_UNPROVEN');
  const requests = boundaries.flatMap(b => b.requests ?? []);
  const fallbackRequests = requests.filter(r => r.source === 'character-heuristic').length;
  const fallbackShare = requests.length ? fallbackRequests / requests.length : 0;
  if (fallbackShare > MAX_FALLBACK_SHARE) codes.push('USAGE_FALLBACK_EXCESSIVE');
  const retained = new Map(boundaries.flatMap(b => b.retention ?? []).map(r => [r.key, r.matched]));
  const matched = [...retained.values()].filter(Boolean).length;
  const matchedShare = retained.size ? matched / retained.size : null;
  if (!matched) codes.push('RETENTION_UNMATCHED');
  else if (matchedShare !== null && matchedShare < MIN_RETENTION_SHARE) codes.push('RETENTION_COVERAGE_LOW');
  const evidence = { pressured: pressured.length, conversations: new Set(pressured.map(b => b.logical)).size,
    cold: cold.length, coldConversations: new Set(cold.map(b => b.logical)).size, opportunities: cold.filter(b => admitsBatch(b.saved)).length };
  if (evidence.cold < 10 || evidence.coldConversations < 3) codes.push('COLD_EVIDENCE_INSUFFICIENT');
  return { api: route.api, codes, piAiVersion: qualificationIdentity().piAiVersion,
    assumptions: { ...route, requestCount: requests.length, fallbackRequests, fallbackShare, maximumFallbackShare: MAX_FALLBACK_SHARE, minimumRetentionShare: MIN_RETENTION_SHARE, prefixRate: 'observed-blended-prefix' },
    retention: { provenResults: retained.size, matchedResults: matched, unmatchedResults: retained.size - matched, matchedShare }, counts: evidence,
    estimates: { usage: boundaries.filter(b => b.source === 'provider-usage-plus-heuristic').length,
      heuristic: boundaries.filter(b => b.source === 'character-heuristic').length },
    gaps: { underMinute: boundaries.filter(b => b.gap !== null && b.gap < 60000).length,
      underHour: boundaries.filter(b => b.gap >= 60000 && b.gap < 3600000).length,
      longer: boundaries.filter(b => b.gap >= 3600000).length,
      unknown: boundaries.filter(b => b.gap === null).length },
    upperBoundBoundaryTokens: boundaries.reduce((s, b) => s + (b.upperTokens ?? 0), 0),
    savingsHistogram: { none: boundaries.filter(b => b.saved === 0).length,
      under50k: boundaries.filter(b => admitsBatch(b.saved) && b.saved < 50000).length,
      larger: boundaries.filter(b => b.saved >= 50000).length },
    modeled, payload: status, ...(codex ? { wire: 'wire-unproven (transport)' } : {}),
    verdict: gate({ ...evidence, ...modeled, payload: status, missingEvidence: codes.some(c => ['PAYLOAD_UNQUALIFIED', 'IDENTITY_UNPROVEN', 'RETENTION_UNMATCHED', 'RETENTION_COVERAGE_LOW', 'USAGE_FALLBACK_EXCESSIVE'].includes(c)), incomplete, codex }) };
}
