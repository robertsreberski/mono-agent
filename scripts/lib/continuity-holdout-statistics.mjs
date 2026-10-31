// Pure pre-registered statistics: no I/O, clock, provider or independent-probe inference.
import { isDeepStrictEqual } from "node:util";
import spec from "../continuity-holdout/statistical-spec.json" with { type: "json" };
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export const STATISTICAL_SPEC = freeze(spec);
export const HOLDOUT_ARMS = Object.freeze(["native", "cold-rebuild", "continuity-pack-cold", "continuity-ledger-cold"]);
const check = (ok, code) => { if (!ok) throw new Error(code); };
export function validateStatisticalSpec(value) {
  check(value?.schema === spec.schema, "incompatible_statistical_spec_version");
  const expected = structuredClone(spec), d = value?.design;
  const integer = x => Number.isSafeInteger(x) && x > 0;
  check(d && [d.conversationsPerCorpus, d.families, d.conversationsPerFamily, d.shards, d.perCorpusPerShard].every(integer)
    && Number.isSafeInteger(d.conversationsPerCorpus * spec.design.corpora.length * spec.design.probes * spec.design.repeats * HOLDOUT_ARMS.length)
    && d.conversationsPerCorpus >= 2 && d.families % spec.design.corpora.length === 0
    && d.families * d.conversationsPerFamily === d.conversationsPerCorpus * spec.design.corpora.length
    && d.shards * d.perCorpusPerShard === d.conversationsPerCorpus && Number.isFinite(d.shardCostCapUSD) && d.shardCostCapUSD > 0, "invalid_statistical_design");
  for (const key of ["conversationsPerCorpus", "families", "conversationsPerFamily", "shards", "perCorpusPerShard", "shardCostCapUSD"]) expected.design[key] = d[key];
  check(isDeepStrictEqual(value, expected), "unregistered_statistical_spec");
  return true;
}
export function validateHoldoutConversations(conversations, statisticalSpec = spec) {
  validateStatisticalSpec(statisticalSpec);
  const d = statisticalSpec.design, total = d.conversationsPerCorpus * d.corpora.length;
  check(Array.isArray(conversations) && conversations.length === total && new Set(conversations.map(c => c.id)).size === total
    && d.corpora.every(corpus => conversations.filter(c => c.corpus === corpus).length === d.conversationsPerCorpus)
    && conversations.every(c => typeof c.id === "string" && !c.id.includes("/") && typeof c.family === "string"
      && Array.isArray(c.probes) && c.probes.length === d.probes && new Set(c.probes).size === d.probes
      && c.probes.every(p => typeof p === "string" && !p.includes("/"))), "invalid_planned_holdout");
  const families = new Map();
  for (const c of conversations) { if (!families.has(c.family)) families.set(c.family, []); families.get(c.family).push(c); }
  check(families.size === d.families && [...families.values()].every(rows => rows.length === d.conversationsPerFamily
    && new Set(rows.map(c => c.corpus)).size === 1), "invalid_holdout_family_layout");
  return true;
}
const lanczos = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
export function logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  z--; let x = 0.9999999999998099;
  for (let i = 0; i < lanczos.length; i++) x += lanczos[i] / (z + i + 1);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function fraction(a, b, x) {
  const tiny = 1e-300, safe = n => Math.abs(n) < tiny ? tiny : n;
  let c = 1, d = 1 / safe(1 - (a + b) * x / (a + 1)), h = d;
  for (let m = 1; m <= 300; m++) {
    let aa = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 / safe(1 + aa * d); c = safe(1 + aa / c); h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 / safe(1 + aa * d); c = safe(1 + aa / c);
    const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 3e-14) return h;
  }
  throw new Error("beta_nonconvergence");
}
export function betaCdf(x, a, b) {
  check(a > 0 && b > 0 && x >= 0 && x <= 1, "invalid_beta_arguments");
  if (x === 0 || x === 1) return x;
  const scale = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? scale * fraction(a, b, x) / a : 1 - scale * fraction(b, a, 1 - x) / b;
}
export function betaQuantile(p, a, b) {
  check(p > 0 && p < 1 && a > 0 && b > 0, "invalid_beta_arguments");
  let lo = 0, hi = 1;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (betaCdf(mid, a, b) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export function clopperPearson(k, n, confidence = 0.95) {
  check(Number.isSafeInteger(n) && n > 0 && Number.isSafeInteger(k) && k >= 0 && k <= n && confidence > 0 && confidence < 1, "invalid_binomial_counts");
  return { lower: k === 0 ? 0 : betaQuantile(1 - confidence, k, n - k + 1), upper: k === n ? 1 : betaQuantile(confidence, k + 1, n - k) };
}
export function tCdf(t, df) {
  check(df > 0 && Number.isFinite(t), "invalid_t_arguments");
  const tail = betaCdf(df / (df + t * t), df / 2, 0.5) / 2;
  return t >= 0 ? 1 - tail : tail;
}
export function tQuantile(p, df) {
  check(p > 0.5 && p < 1 && df > 0, "invalid_t_arguments");
  let lo = 0, hi = 1;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 90; i++) { const mid = (lo + hi) / 2; if (tCdf(mid, df) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export function pairedMoments(sum, squares, n, confidence = spec.confidence) {
  check(n >= 2 && Number.isFinite(sum) && Number.isFinite(squares), "invalid_paired_sample");
  const mean = sum / n, sd = Math.sqrt(Math.max(0, (squares - sum * sum / n) / (n - 1)));
  const radius = critical(confidence, n) * sd / Math.sqrt(n);
  return { n, mean, sd, lower: mean - radius, upper: mean + radius };
}
export function pairedT(values, confidence = spec.confidence) {
  check(values.length >= 2 && values.every(Number.isFinite), "invalid_paired_sample");
  return pairedMoments(values.reduce((a, b) => a + b, 0), values.reduce((s, v) => s + v * v, 0), values.length, confidence);
}
export const intervalStatus = (interval, threshold, upperIsPass) => upperIsPass
  ? interval.upper <= threshold ? "pass" : interval.lower > threshold ? "fail" : "inconclusive"
  : interval.lower > threshold ? "pass" : interval.upper <= threshold ? "fail" : "inconclusive";
const criticals = new Map();
function critical(confidence, n) {
  const key = `${confidence}/${n}`;
  if (!criticals.has(key)) criticals.set(key, tQuantile(confidence, n - 1));
  return criticals.get(key);
}
/** G families are random scenario types. Combined inference pools ALL family means.
 * Adjusted Fisher-Pearson sample skewness; G=2 uses zero (mechanics only).
 * One-family fixtures cannot support inference and never pass an interval gate. */
export function familyMoments(sum, squares, cubes, n, confidence = spec.confidence) {
  if (n < 2) return { n, mean: sum / n, estimable: false, lower: null, upper: null, se: null, skew: null };
  const base = pairedMoments(sum, squares, n, confidence);
  // Raw moment cancellation must not manufacture variance/skew for constant families.
  if (base.sd ** 2 * (n - 1) <= 64 * Number.EPSILON * Math.max(squares, sum * sum / n)) base.sd = 0;
  const se = base.sd / Math.sqrt(n);
  const centeredCube = cubes - 3 * base.mean * squares + 2 * n * base.mean ** 3;
  const skew = base.sd > 0 && n > 2 ? n * centeredCube / ((n - 1) * (n - 2) * base.sd ** 3) : 0;
  const t = critical(confidence, n), correction = skew * (1 + 2 * t * t) / (6 * Math.sqrt(n));
  const upperAdjustment = Math.max(0, correction), lowerAdjustment = Math.max(0, -correction);
  return { ...base, estimable: true, se, skew, upperAdjustment, lowerAdjustment,
    upper: base.mean + se * (t + upperAdjustment), lower: base.mean - se * (t + lowerAdjustment) };
}
export function familyT(values, confidence = spec.confidence) {
  return familyMoments(values.reduce((a, b) => a + b, 0), values.reduce((a, b) => a + b * b, 0), values.reduce((a, b) => a + b ** 3, 0), values.length, confidence);
}
/** Balanced one-way random-effects ICC, not truncated at zero. Zero variance -> ICC=0.
 * Sums are conversation squares and family-mean squares; m is registered size. */
export function familyDependence(sum, conversationSquares, familySquares, g, m) {
  if (g < 2 || m < 2) return { icc: null, designEffect: null };
  const between = Math.max(0, m * (familySquares - (sum / m) ** 2 / g) / (g - 1));
  const within = Math.max(0, (conversationSquares - m * familySquares) / (g * (m - 1)));
  const denominator = between + (m - 1) * within;
  const icc = denominator === 0 ? 0 : (between - within) / denominator;
  return { icc, designEffect: 1 + (m - 1) * icc };
}
/** Shared complete-data scoring/power gates use moments of FAMILY means. */
export function gateEvaluator(statisticalSpec = spec) {
  validateStatisticalSpec(statisticalSpec);
  const evaluate = (sum, squares, cubes, g, threshold, upper) => {
    const interval = familyMoments(sum, squares, cubes, g, statisticalSpec.confidence);
    return { interval, status: interval.estimable ? intervalStatus(interval, threshold, upper) : "inconclusive" };
  };
  return {
    safety: (sum, squares, cubes, g, comparator) => {
      check(Object.hasOwn(statisticalSpec.safety.maximumByComparator, comparator), "invalid_safety_comparator");
      return evaluate(sum, squares, cubes, g, statisticalSpec.safety.maximumByComparator[comparator], true);
    },
    benefit: (sum, squares, cubes, g, combined) => evaluate(sum, squares, cubes, g,
      combined ? statisticalSpec.benefit.combinedMinimumExclusive : statisticalSpec.benefit.corpusMinimumExclusive, false),
    wrongRate: (wrong, denominator, complete = true) => wrong / denominator > statisticalSpec.safety.wrongRateMaximum ? "fail" : complete ? "pass" : "inconclusive",
    accuracy: (correct, missing, denominator, complete = true) => (correct + missing) / denominator < statisticalSpec.accuracyMinimum ? "fail" : complete ? "pass" : "inconclusive",
  };
}
/** Conservative skew-adjusted FAMILY completion envelope.
 * For x_f in [lo_f,hi_f], mean is in [sum(lo)/G,sum(hi)/G]. Centered SS <=
 * sum(max(lo²,hi²)) - min(sum(x)²)/G, giving SEmax. For standardized z_f,
 * sum(z²)=G-1 and |sum(z³)| <= (sum(z²))^(3/2) by the l3/l2 norm inequality.
 * Thus adjusted sample |skew| <= G*sqrt(G-1)/(G-2). Both tighten-only radii
 * are <= SEmax*(t+skewMax*(1+2t²)/(6sqrt(G))). Subtracting/adding that radius
 * from the smallest/largest possible mean bounds EVERY completion's L/U.
 * No monotonicity of skewness or endpoint-filling shortcut is assumed. */
export function familyCompletionBounds(bounds, confidence = spec.confidence) {
  const g = bounds.length;
  check(g > 0 && bounds.every(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi) && lo >= -1 && hi <= 1 && lo <= hi), "invalid_completion_bounds");
  if (g < 2) return { lower: -Infinity, upper: Infinity };
  if (bounds.every(([lo, hi]) => lo === hi)) { const result = familyT(bounds.map(([lo]) => lo), confidence); return { lower: result.lower, upper: result.upper }; }
  const low = bounds.reduce((s, b) => s + b[0], 0), high = bounds.reduce((s, b) => s + b[1], 0);
  const squares = bounds.reduce((s, [lo, hi]) => s + Math.max(lo * lo, hi * hi), 0);
  const nearest = low > 0 ? low : high < 0 ? high : 0;
  const se = Math.sqrt((Math.max(0, squares - nearest * nearest / g) + 64 * Number.EPSILON * g * g) / (g * (g - 1)));
  const t = critical(confidence, g), maxSkew = g > 2 ? g * Math.sqrt(g - 1) / (g - 2) : 0;
  const radius = se * (t + maxSkew * (1 + 2 * t * t) / (6 * Math.sqrt(g)));
  return { lower: low / g - radius, upper: high / g + radius };
}
function familySample(rows, bounds, confidence) {
  const groups = new Map();
  rows.forEach((row, i) => { if (!groups.has(row.family)) groups.set(row.family, []); groups.get(row.family).push(bounds[i]); });
  const familyBounds = [...groups.values()].map(group => [0, 1].map(i => group.reduce((s, b) => s + b[i], 0) / group.length));
  const values = familyBounds.map(([lo]) => lo), g = values.length;
  const interval = familyT(values, confidence), completion = familyCompletionBounds(familyBounds, confidence);
  const complete = bounds.every(([lo, hi]) => lo === hi);
  const dependence = complete ? familyDependence(bounds.reduce((s, [lo]) => s + lo, 0), bounds.reduce((s, [lo]) => s + lo * lo, 0), values.reduce((s, v) => s + v * v, 0), g, rows.length / g) : { icc: null, designEffect: null };
  return { g, interval: { ...interval, ...dependence }, completion };
}
/** Conservative bound for EVERY completion's t upper endpoint, not the invalid '+1 maximizes lower' shortcut.
 * mean <= sum(hi)/n. Sum of centered squares <= sum(max(lo²,hi²)) - min(sum(x)²)/n.
 * This relaxation can be loose: failure is reported only when its upper bound establishes failure. */
export function completionUpperBound(bounds, confidence = spec.confidence) {
  check(bounds.length >= 2 && bounds.every(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi) && lo >= -1 && hi <= 1 && lo <= hi), "invalid_completion_bounds");
  if (bounds.every(([lo, hi]) => lo === hi)) return pairedT(bounds.map(([lo]) => lo), confidence).upper;
  const n = bounds.length, low = bounds.reduce((s, b) => s + b[0], 0), high = bounds.reduce((s, b) => s + b[1], 0);
  const squares = bounds.reduce((s, [lo, hi]) => s + Math.max(lo * lo, hi * hi), 0);
  const nearest = low > 0 ? low : high < 0 ? high : 0;
  return high / n + critical(confidence, n) * Math.sqrt((Math.max(0, squares - nearest * nearest / n) + 64 * Number.EPSILON * n * n) / (n * (n - 1)));
}
/** Lower bound on EVERY completion's t lower endpoint, by reflection of the upper relaxation. */
export function completionLowerBound(bounds, confidence = spec.confidence) {
  const upper = completionUpperBound(bounds.map(([lo, hi]) => [-hi, -lo]), confidence);
  return bounds.every(([lo, hi]) => lo === hi) ? pairedT(bounds.map(([lo]) => lo), confidence).lower : -upper;
}
const OUTCOMES = new Set(["correct", "stale", "conflicted", "violation", "leaked", "abstained", "empty", "wrong", "fabricated"]);
const validTrial = row => row?.status === "completed" && typeof row.score?.pass === "boolean" && OUTCOMES.has(row.score?.outcome)
  && row.score.pass === (row.score.outcome === "correct");
const wrongTrial = row => validTrial(row) && !row.score.pass && !["abstained", "empty"].includes(row.score.outcome);

/** Pure analysis defaults to NOT a measurement; callers must explicitly supply validated real execution provenance. */
export function holdoutStatistics({ conversations, trials, audit = null, statisticalSpec = spec, measurement = false }) {
  validateHoldoutConversations(conversations, statisticalSpec);
  const d = statisticalSpec.design, bundleSize = d.probes * d.repeats, evaluator = gateEvaluator(statisticalSpec);
  const repeats = Array.from({ length: d.repeats }, (_, i) => i + 1);
  const byId = new Map(conversations.map(c => [c.id, c])), slots = new Map(); let unknown = 0, notStartedPlaceholders = 0;
  for (const row of trials) {
    if (row?.status === "not_started" && Object.keys(row).length === 1) { notStartedPlaceholders++; continue; }
    const c = byId.get(row?.traceId);
    if (!c || !c.probes.includes(row.probeId) || !HOLDOUT_ARMS.includes(row.arm) || !repeats.includes(row.repeat)) { unknown++; continue; }
    const key = `${row.traceId}/${row.arm}/${row.repeat}/${row.probeId}`;
    const prior = slots.get(key); slots.set(key, prior === undefined ? row : null);
  }
  const bundles = conversations.map(c => {
    const arms = Object.fromEntries(HOLDOUT_ARMS.map(arm => {
      const rows = repeats.flatMap(repeat => c.probes.map(id => slots.get(`${c.id}/${arm}/${repeat}/${id}`)));
      return [arm, { complete: rows.every(validTrial), missing: rows.filter(r => !validTrial(r)).length,
        correct: rows.filter(r => validTrial(r) && r.score.pass).length, wrong: rows.filter(wrongTrial).length }];
    }));
    return { ...c, arms, complete: Object.values(arms).every(a => a.complete) };
  });
  const gates = [], add = (name, status) => gates.push({ name, status }), scopes = {};
  for (const corpus of [...d.corpora, "combined"]) {
    const rows = bundles.filter(c => corpus === "combined" || c.corpus === corpus), n = rows.length, denominator = n * bundleSize;
    const complete = unknown === 0 && rows.every(c => c.complete), ledger = statisticalSpec.safety.treatment, pack = statisticalSpec.benefit.comparator;
    const correct = rows.reduce((s, c) => s + c.arms[ledger].correct, 0), wrong = rows.reduce((s, c) => s + c.arms[ledger].wrong, 0);
    const missing = rows.reduce((s, c) => s + c.arms[ledger].missing, 0), safety = {};
    for (const comparator of statisticalSpec.safety.comparators) {
      const bounds = rows.map(c => { const l = c.arms[ledger], p = c.arms[comparator];
        return [(l.wrong - p.wrong - p.missing) / bundleSize, (l.wrong + l.missing - p.wrong) / bundleSize]; });
      const sample = familySample(rows, bounds, statisticalSpec.confidence);
      const result = complete ? sample.interval : null;
      const worstCompletionUpper = sample.completion.upper, bestCompletionLower = sample.completion.lower;
      const margin = statisticalSpec.safety.maximumByComparator[comparator];
      const status = result ? result.estimable ? intervalStatus(result, margin, true) : "inconclusive"
        : worstCompletionUpper <= margin ? "pass" : bestCompletionLower > margin ? "fail" : "inconclusive";
      safety[comparator] = { n, families: sample.g, margin, interval: result, worstCompletionUpper, bestCompletionLower, status };
      add(`${corpus}:safety:${comparator}`, status);
    }
    // Any-wrong risks and both discordance directions are descriptive, never gates.
    const descriptive = Object.fromEntries(HOLDOUT_ARMS.map(arm => {
      const count = key => rows.reduce((s, c) => s + c.arms[arm][key], 0);
      return [arm, { complete: rows.every(c => c.arms[arm].complete), correct: count("correct"), wrong: count("wrong"), missing: count("missing"),
        missingRate: count("missing") / denominator,
        abstainedOrEmptyRate: (denominator - count("correct") - count("wrong") - count("missing")) / denominator,
        abstainedOrEmpty: denominator - count("correct") - count("wrong") - count("missing"),
        correctRate: count("correct") / denominator, wrongRate: count("wrong") / denominator,
        anyWrongConversations: rows.filter(c => c.arms[arm].wrong > 0).length,
        anyWrongRisk: rows.filter(c => c.arms[arm].wrong > 0).length / n }];
    }));
    const discordances = Object.fromEntries(HOLDOUT_ARMS.filter(a => a !== ledger).map(comparator => [comparator, {
      ledgerOnlyKnownWrong: rows.filter(c => c.arms[ledger].wrong > 0 && c.arms[comparator].complete && c.arms[comparator].wrong === 0).length,
      comparatorOnlyKnownWrong: rows.filter(c => c.arms[comparator].wrong > 0 && c.arms[ledger].complete && c.arms[ledger].wrong === 0).length,
      bothKnownWrong: rows.filter(c => c.arms[ledger].wrong > 0 && c.arms[comparator].wrong > 0).length,
      bothComplete: rows.filter(c => c.arms[ledger].complete && c.arms[comparator].complete).length,
    }]));
    const bounds = rows.map(c => { const l = c.arms[ledger], p = c.arms[pack]; return [(l.correct - p.correct - p.missing) / bundleSize, (l.correct + l.missing - p.correct) / bundleSize]; });
    const sample = familySample(rows, bounds, statisticalSpec.confidence);
    const benefit = complete ? sample.interval : null, bestCompletionUpper = sample.completion.upper;
    const threshold = corpus === "combined" ? statisticalSpec.benefit.combinedMinimumExclusive : statisticalSpec.benefit.corpusMinimumExclusive;
    const worstCompletionLower = sample.completion.lower;
    const benefitStatus = benefit ? benefit.estimable ? intervalStatus(benefit, threshold, false) : "inconclusive"
      : bestCompletionUpper <= threshold ? "fail" : worstCompletionLower > threshold ? "pass" : "inconclusive";
    add(`${corpus}:benefit`, benefitStatus);
    const observedWrongStatus = evaluator.wrongRate(wrong, denominator, complete);
    const wrongStatus = observedWrongStatus === "inconclusive" && (wrong + missing) / denominator <= statisticalSpec.safety.wrongRateMaximum ? "pass" : observedWrongStatus;
    add(`${corpus}:wrong-rate`, wrongStatus);
    scopes[corpus] = { plannedConversations: n, families: sample.g, plannedAnswers: denominator, complete, worstCase: !complete, safety, descriptive, discordances, benefit, benefitStatus, bestCompletionUpper, worstCompletionLower,
      ledgerCorrect: correct, ledgerMissing: missing, ledgerAccuracy: correct / denominator, bestCompletionAccuracy: (correct + missing) / denominator,
      ledgerWrong: wrong, ledgerWrongRate: wrong / denominator, wrongStatus };
  }
  const integrity = unknown === 0 && bundles.every(c => c.complete), planned = conversations.length * bundleSize;
  const missingPerArm = Object.fromEntries(HOLDOUT_ARMS.map(arm => [arm, bundles.reduce((n, c) => n + c.arms[arm].missing, 0)]));
  const maximumMissingPerArm = Math.floor(planned * statisticalSpec.missingData.worstCaseCompletion.maximumMissingFractionPerArm);
  const withinMissingCap = Object.values(missingPerArm).every(n => n <= maximumMissingPerArm);
  add("integrity", unknown === 0 && withinMissingCap ? "pass" : "inconclusive");
  const observedAccuracy = evaluator.accuracy(scopes.combined.ledgerCorrect, scopes.combined.ledgerMissing, scopes.combined.plannedAnswers, integrity);
  add("accuracy", observedAccuracy === "inconclusive" && scopes.combined.ledgerAccuracy >= statisticalSpec.accuracyMinimum ? "pass" : observedAccuracy);
  let auditRates = null;
  const fields = ["published", "audited", "labelFindings", "contextFindings", "falselySupersededCurrent", "bindingErrors"], a = statisticalSpec.audit;
  if (audit && fields.every(k => Number.isSafeInteger(audit[k]) && audit[k] >= 0) && audit.published > 0 && audit.audited <= audit.published
    && audit.labelFindings <= audit.audited && audit.contextFindings <= audit.audited && typeof audit.complete === "boolean") {
    const complete = audit.complete && audit.audited === audit.published;
    auditRates = { ...audit, labelRate: audit.labelFindings / audit.published, contextRate: audit.contextFindings / audit.published };
    add("audit-label", audit.labelFindings * a.referenceDenominator > a.labelNumerator * audit.published ? "fail" : complete ? "pass" : "inconclusive");
    add("audit-context", audit.contextFindings * a.referenceDenominator > a.contextNumerator * audit.published ? "fail" : complete ? "pass" : "inconclusive");
    add("audit-provenance", audit.falselySupersededCurrent > a.falselySupersededMaximum || audit.bindingErrors > a.bindingErrorsMaximum ? "fail" : complete ? "pass" : "inconclusive");
    if (!complete) add("audit-material", "inconclusive");
  } else add("audit-material", "inconclusive");
  const status = gates.some(g => g.status === "fail") ? "fail" : gates.some(g => g.status !== "pass") ? "inconclusive" : "pass";
  if (!measurement) for (const scope of Object.values(scopes)) {
    scope.wrongStatus = scope.benefitStatus = "not_a_measurement";
    for (const safety of Object.values(scope.safety)) safety.status = "not_a_measurement";
  }
  return { schema: "holdout-statistics-v2", unit: "family", pairing: "conversation", measurement, scopes, plannedAnswersPerArm: conversations.length * bundleSize, audit: auditRates,
    integrity: { complete: integrity, missingPerArm, maximumMissingPerArm, withinMissingCap, worstCase: !integrity && unknown === 0 && withinMissingCap, unknownTrials: unknown, notStartedPlaceholders, incompleteConversations: bundles.filter(c => !c.complete).map(c => c.id) },
    decision: measurement ? { status, reasons: gates.filter(g => g.status !== "pass").map(g => `${g.name}:${g.status}`), gates }
      : { status: "inconclusive", reasons: ["not_a_measurement"], gates: [] } };
}
