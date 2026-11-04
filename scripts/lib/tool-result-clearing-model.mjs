import { APIS } from './tool-result-clearing-reference.mjs';
export const SENSITIVITIES = [0, 0.05, 0.20];
export function gate({ pressured, conversations, cold, opportunities, pressureReduction, costs, payload, incomplete = false, codex = false }) {
  if (incomplete || codex || pressured < 10 || conversations < 3 || cold === 0) return 'DEFER';
  return opportunities / cold >= 0.25 && pressureReduction >= 0.15
    && SENSITIVITIES.every(rate => costs.some(c => c.retrievalRate === rate)) && costs.every(x => x.listRatio <= 1.05 && x.quotaRatio <= 1.05)
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
      let off = 0, on = 0;
      const average = (route.triggerTokens + route.drainTokens) / 2;
      for (const b of boundaries) {
        const price = b.cold ? weights.cacheWrite : weights.cacheRead;
        off += average * price + b.growth * weights.input + (b.outputTokens ?? 0) * weights.output;
        // Conservative frozen-continuation bound: retained context costs S/2 longer.
        on += (average + savingsPerCycle / 2) * price + b.growth * weights.input + (b.outputTokens ?? 0) * weights.output;
      }
      const summaryOff = route.summaryInputTokens * weights.input + route.summaryOutputTokens * weights.output
        + route.drainTokens * weights.cacheWrite;
      // Charge delayed native growth plus at most 2,000 characters per cleared result.
      off += offPressure * summaryOff;
      on += (growth + rate * retrieval) / (span + savingsPerCycle) * (summaryOff + extraSummary * weights.input);
      // Full retrieval: round-trip context, escaped returned text, and retained-history growth.
      on += rate * (count * average + retrieval * (1 + boundaries.length / 2)) * weights.input;
      return { off, on, ratio: off > 0 ? on / off : 1 };
    };
    const list = view(route.prices), quota = view(route.quota);
    // Worst-case recache is reported separately; warm clearing is not enabled by this model.
    const rewrite = route.triggerTokens * boundaries.filter(b => b.saved > 0).length;
    return { retrievalRate: rate, listOff: list.off / 1e6, listOn: list.on / 1e6, listRatio: list.ratio,
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
  const payload = qualification?.routes?.find(r => r.api === route.api);
  const status = payload?.status === 'payload-preserving' && payload.unintendedDifferences === 0 ? 'payload-preserving' : 'fails';
  const codex = route.api === 'openai-codex-responses';
  const evidence = { pressured: pressured.length, conversations: new Set(pressured.map(b => b.logical)).size,
    cold: cold.length, opportunities: cold.filter(b => b.admissibleTokens >= 20000).length };
  return { api: route.api, assumptions: route, counts: evidence,
    estimates: { usage: boundaries.filter(b => b.source === 'provider-usage-plus-heuristic').length,
      heuristic: boundaries.filter(b => b.source === 'character-heuristic').length },
    gaps: { underMinute: boundaries.filter(b => b.gap !== null && b.gap < 60000).length,
      underHour: boundaries.filter(b => b.gap >= 60000 && b.gap < 3600000).length,
      longer: boundaries.filter(b => b.gap >= 3600000).length,
      unknown: boundaries.filter(b => b.gap === null).length },
    upperBoundBoundaryTokens: boundaries.reduce((s, b) => s + (b.upperTokens ?? 0), 0),
    savingsHistogram: { none: boundaries.filter(b => b.saved === 0).length,
      under50k: boundaries.filter(b => b.saved >= 20000 && b.saved < 50000).length,
      larger: boundaries.filter(b => b.saved >= 50000).length },
    modeled, payload: status, ...(codex ? { wire: 'wire-unproven (transport)' } : {}),
    verdict: gate({ ...evidence, ...modeled, payload: status, incomplete, codex }) };
}
