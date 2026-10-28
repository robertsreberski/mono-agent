// Pure pre-registered statistics: no I/O, clock, provider or independent-probe inference.
import { isDeepStrictEqual } from "node:util";
import spec from "../continuity-holdout/statistical-spec.json" with { type: "json" };
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export const STATISTICAL_SPEC = freeze(spec);
export const HOLDOUT_ARMS = Object.freeze(["native", "cold-rebuild", "continuity-pack-cold", "continuity-ledger-cold"]);
export function validateStatisticalSpec(value) {
  if (!isDeepStrictEqual(value, spec)) throw new Error("unregistered_statistical_spec");
  return true;
}
const check = (ok, code) => { if (!ok) throw new Error(code); };
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
export function pairedT(values, confidence = 0.95) {
  check(values.length >= 2 && values.every(Number.isFinite), "invalid_paired_sample");
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
  const radius = tQuantile(confidence, values.length - 1) * sd / Math.sqrt(values.length);
  return { n: values.length, mean, sd, lower: mean - radius, upper: mean + radius };
}
const inference = (interval, threshold, upperIsPass) => upperIsPass
  ? interval.upper <= threshold ? "pass" : interval.lower > threshold ? "fail" : "inconclusive"
  : interval.lower > threshold ? "pass" : interval.upper <= threshold ? "fail" : "inconclusive";
const validTrial = row => row?.status === "completed" && typeof row.score?.pass === "boolean" && typeof row.score?.abstained === "boolean";

/** Inputs are all planned conversations, never only observed ones. Audit counts are PR3's unique-entry totals. */
export function holdoutStatistics({ conversations, trials, audit = null, statisticalSpec = spec }) {
  validateStatisticalSpec(statisticalSpec);
  check(Array.isArray(conversations) && conversations.length === 256 && new Set(conversations.map(c => c.id)).size === 256
    && spec.design.corpora.every(corpus => conversations.filter(c => c.corpus === corpus).length === 128)
    && conversations.every(c => Array.isArray(c.probes) && c.probes.length === 15 && new Set(c.probes).size === 15), "invalid_planned_holdout");
  const byId = new Map(conversations.map(c => [c.id, c])), slots = new Map(); let unknown = 0;
  for (const row of trials) {
    const c = byId.get(row.traceId);
    if (!c || !c.probes.includes(row.probeId) || !HOLDOUT_ARMS.includes(row.arm) || ![1, 2].includes(row.repeat)) { unknown++; continue; }
    const key = `${row.traceId}/${row.arm}/${row.repeat}/${row.probeId}`;
    const prior = slots.get(key); slots.set(key, prior === undefined ? row : null); // A duplicate invalidates the slot, never last-wins.
  }
  const bundles = conversations.map(c => {
    const arms = Object.fromEntries(HOLDOUT_ARMS.map(arm => {
      const rows = [1, 2].flatMap(repeat => c.probes.map(id => slots.get(`${c.id}/${arm}/${repeat}/${id}`)));
      return [arm, { complete: rows.every(validTrial), correct: rows.filter(r => validTrial(r) && r.score.pass).length,
        wrong: rows.filter(r => validTrial(r) && !r.score.pass && !r.score.abstained).length }];
    }));
    return { ...c, arms, complete: Object.values(arms).every(a => a.complete) };
  });
  const gates = [], add = (name, status) => gates.push({ name, status });
  const scopes = {};
  for (const corpus of [...spec.design.corpora, "combined"]) {
    const rows = bundles.filter(c => corpus === "combined" || c.corpus === corpus), n = rows.length, denominator = n * 30;
    const complete = unknown === 0 && rows.every(c => c.complete), ledger = spec.safety.treatment, pack = spec.benefit.comparator;
    const correct = rows.reduce((s, c) => s + c.arms[ledger].correct, 0), wrong = rows.reduce((s, c) => s + c.arms[ledger].wrong, 0);
    const safety = {};
    for (const comparator of spec.safety.comparators) {
      const harmful = rows.filter(c => c.arms[ledger].wrong > 0 && c.arms[comparator].wrong === 0).length;
      const interval = complete ? clopperPearson(harmful, n, spec.confidence) : null;
      const status = interval ? inference(interval, spec.safety.maximum, true) : "inconclusive";
      safety[comparator] = { harmful: complete ? harmful : null, n, interval, status }; add(`${corpus}:safety:${comparator}`, status);
    }
    const benefit = complete ? pairedT(rows.map(c => (c.arms[ledger].correct - c.arms[pack].correct) / 30), spec.confidence) : null;
    const benefitStatus = benefit ? inference(benefit, corpus === "combined" ? 0.02 : 0, false) : "inconclusive";
    add(`${corpus}:benefit`, benefitStatus);
    const wrongStatus = complete ? wrong / denominator <= spec.safety.wrongRateMaximum ? "pass" : "fail" : "inconclusive";
    add(`${corpus}:wrong-rate`, wrongStatus);
    scopes[corpus] = { plannedConversations: n, plannedAnswers: denominator, complete, safety, benefit, benefitStatus,
      ledgerCorrect: correct, ledgerAccuracy: correct / denominator, ledgerWrong: complete ? wrong : null,
      ledgerWrongRate: complete ? wrong / denominator : null, wrongStatus };
  }
  const integrity = unknown === 0 && bundles.every(c => c.complete);
  add("integrity", integrity ? "pass" : "inconclusive");
  add("accuracy", scopes.combined.ledgerAccuracy >= spec.accuracyMinimum ? "pass" : integrity ? "fail" : "inconclusive");
  let auditRates = null;
  const fields = ["published", "audited", "labelFindings", "contextFindings", "falselySupersededCurrent", "bindingErrors"];
  if (audit && fields.every(k => Number.isSafeInteger(audit[k]) && audit[k] >= 0) && audit.published > 0 && audit.audited === audit.published
    && audit.labelFindings <= audit.published && audit.contextFindings <= audit.published && audit.complete === true) {
    auditRates = { ...audit, labelRate: audit.labelFindings / audit.published, contextRate: audit.contextFindings / audit.published };
    add("audit-label", audit.labelFindings * 363 <= 10 * audit.published ? "pass" : "fail");
    add("audit-context", audit.contextFindings * 363 <= 5 * audit.published ? "pass" : "fail");
    add("audit-provenance", audit.falselySupersededCurrent === 0 && audit.bindingErrors === 0 ? "pass" : "fail");
  } else add("audit-material", "inconclusive");
  const status = gates.some(g => g.status === "fail") ? "fail" : gates.some(g => g.status !== "pass") ? "inconclusive" : "pass";
  return { schema: "holdout-statistics-v1", unit: "conversation", scopes, plannedAnswersPerArm: 7680, audit: auditRates,
    integrity: { complete: integrity, unknownTrials: unknown, incompleteConversations: bundles.filter(c => !c.complete).map(c => c.id) },
    decision: { status, reasons: gates.filter(g => g.status !== "pass").map(g => `${g.name}:${g.status}`), gates } };
}
