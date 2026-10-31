import { STATISTICAL_SPEC, validateStatisticalSpec, gateEvaluator, familyDependence, familyMoments } from "./continuity-holdout-statistics.mjs";

const target = { ledger: [0.95, 0.01], pack: [0.87, 0.015], native: [0.98, 0.005] };
const qualities = [
  { name: "Sol-like", quality: { ledger: [0.919, 0.04], pack: [0.723, 0.0583], native: [1, 0] } },
  { name: "improved-target", quality: target },
  { name: "pack-null", boundary: "pack", quality: { ...target, pack: [0.87, 0.005] } },
  { name: "native-null", boundary: "native", quality: { ...target, ledger: [0.95, 0.02], native: [1, 0] } },
  { name: "absolute-null", boundary: "wrong-rate", quality: { ...target, ledger: [0.95, 0.02], native: [0.98, 0.015] } },
  { name: "combined-benefit-null", boundary: "benefit:combined", quality: { ...target, pack: [0.93, 0.015] } },
  { name: "corpus-benefit-null", boundary: "benefit:corpus", quality: { ...target, pack: [0.95, 0.015] } },
  { name: "accuracy-null", boundary: "accuracy", quality: { ...target, ledger: [0.91875, 0.01] } },
];
const grid = [0, 0.1, 0.2, 0.35].flatMap(icc => [0, 0.5, 0.9].map(repeatCorrelation => ({ icc, repeatCorrelation })));
const scenarios = [
  ...qualities.flatMap(s => grid.map(g => ({ ...s, ...g, name: `${s.name}-icc-${g.icc}-rho-${g.repeatCorrelation}`, effect: "dirichlet", errorCount: 3 }))),
  ...qualities.map(s => ({ ...s, name: `${s.name}-right-skew`, icc: 0.2, repeatCorrelation: 0.5, effect: "rare-shift", errorCount: 3 })),
  ...grid.map(g => ({ ...qualities[1], ...g, name: `target-reference-16x16-icc-${g.icc}-rho-${g.repeatCorrelation}`, effect: "dirichlet", errorCount: 3, reference: true })),
  ...qualities.filter(s => ["improved-target", "pack-null", "native-null"].includes(s.name)).flatMap(s => [false, true].map(reference => ({ ...s,
    name: `${s.name}-bundle-reuse-stress-${reference ? "16x16" : "128x2"}`, repeatCorrelation: 0.5, effect: "reuse", errorCount: 6, stress: true, reference }))),
];
// Keep the confidence-calibration/target prefix identical to the approved exploration.
const calibrationScenario = s => !s.stress && !s.reference && (s.name.startsWith("improved-target")
  || ["pack", "native", "benefit:combined", "benefit:corpus"].includes(s.boundary));
export const POWER_SCENARIOS = Object.freeze([...scenarios.filter(calibrationScenario), ...scenarios.filter(s => !calibrationScenario(s))]);
/** Exact finite mixture of repeatBundle; pre-enumeration avoids simulating individual answers. */
export function bundleDistribution(quality, errorCount = 3, probes = 15) {
  const arms = ["native", "pack", "ledger"], atoms = [];
  for (let mask = 0; mask < 64; mask++) {
    let independent = 1, errorLo = 0, errorHi = 1, abstentionLo = 0, abstentionHi = 1;
    const bundle = {};
    for (let i = 0; i < 3; i++) {
      const arm = arms[i], [correctRate, wrongRate] = quality[arm];
      const error = Boolean(mask & (1 << i)), abstention = Boolean(mask & (1 << (i + 3)));
      const errorP = wrongRate * probes / errorCount, wrong = error ? errorCount : 0;
      const remaining = probes - wrong, abstentionCount = Math.min(6, remaining);
      const abstentionP = remaining * (1 - correctRate - wrongRate) / ((1 - wrongRate) * abstentionCount);
      independent *= (error ? errorP : 1 - errorP) * (abstention ? abstentionP : 1 - abstentionP);
      if (error) errorHi = Math.min(errorHi, errorP); else errorLo = Math.max(errorLo, errorP);
      if (abstention) abstentionHi = Math.min(abstentionHi, abstentionP); else abstentionLo = Math.max(abstentionLo, abstentionP);
      bundle[arm] = { wrong, correct: remaining - (abstention ? abstentionCount : 0) };
    }
    const probability = (independent + Math.max(0, errorHi - errorLo) * Math.max(0, abstentionHi - abstentionLo)) / 2;
    if (probability > 0) atoms.push({ probability, bundle,
      pack: (bundle.ledger.wrong - bundle.pack.wrong) / probes,
      native: (bundle.ledger.wrong - bundle.native.wrong) / probes,
      benefit: (bundle.ledger.correct - bundle.pack.correct) / probes });
  }
  return atoms;
}
/** Integrate fresh family Dirichlet arm-mixture random effects exactly with a Polya urn.
 * p_f ~ Dirichlet(kappa*p): E[p_f]=p, Cov(E[X|f])=r Var(X), r=1/(kappa+1).
 * For two-repeat conversation X, conditional copy probability rho gives a=(1+rho)/2:
 * ICC(X) = r / (a+(1-a)r). Solve r=ICC*a/(1-ICC*(1-a)). This holds for BOTH D
 * comparisons and benefit, not just arm errors. Null superpopulation means remain EXACTLY
 * the scenario means since E[p_f]=p. No pilot/observed-study fitting or Monte Carlo centering.
 * The urn samples only genuinely new conditional draws; forced repeat copies add no draws.
 */
export function familyEffectParameters(icc, rho) {
  const a = (1 + rho) / 2, r = icc * a / (1 - icc * (1 - a));
  return { r, kappa: r === 0 ? Infinity : 1 / r - 1, marginalRepeatCorrelation: rho + (1 - rho) * r };
}
export function simulatePower({ seed = 572913, replications = 100000, scenarios = POWER_SCENARIOS, statisticalSpec = STATISTICAL_SPEC } = {}) {
  if (!Number.isSafeInteger(replications) || replications < 100000 || !Number.isSafeInteger(seed) || seed <= 0 || seed > 0xffffffff) throw new Error("invalid_power_design");
  validateStatisticalSpec(statisticalSpec);
  let state = seed;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const evaluator = gateEvaluator(statisticalSpec), d = statisticalSpec.design, scopes = [...d.corpora, "combined"];
  const results = scenarios.map(s => {
    if (!["dirichlet", "rare-shift", "reuse"].includes(s.effect) || !(s.errorCount > 0) || !(s.icc >= 0 && s.icc < 1 || s.stress)
      || !(s.repeatCorrelation >= 0 && s.repeatCorrelation <= 1)) throw new Error("invalid_power_scenario");
    const atoms = bundleDistribution(s.quality, s.errorCount, d.probes);
    let cumulative = 0;
    const cdf = atoms.map(a => (cumulative += a.probability));
    const draw = () => { const u = next(); let lo = 0, hi = cdf.length - 1;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (u < cdf[mid]) hi = mid; else lo = mid + 1; } return atoms[lo]; };
    const m = s.reference ? Math.min(16, d.conversationsPerCorpus) : d.conversationsPerFamily, families = 2 * d.conversationsPerCorpus / m, g = families / 2;
    const parameters = s.stress ? { r: 0.16, kappa: null, marginalRepeatCorrelation: s.repeatCorrelation + (1 - s.repeatCorrelation) * 0.16 } : familyEffectParameters(s.icc, s.repeatCorrelation);
    const badProbability = atoms.reduce((sum, a) => sum + (a.bundle.ledger.wrong > 0 ? a.probability : 0), 0);
    const counts = {}, diagnostics = {};
    for (const scope of scopes) for (const gate of ["pack", "native", "wrong-rate", "benefit", "accuracy"]) counts[`${scope}:${gate}`] = 0;
    for (const scope of scopes) for (const gate of ["pack", "native", "benefit", "wrong-rate", "accuracy"]) diagnostics[`${scope}:${gate}`] = { icc: 0, designEffect: 0, skew: 0 };
    let joint = 0;
    for (let replication = 0; replication < replications; replication++) {
      const moments = [Array(22).fill(0), Array(22).fill(0)];
      for (let family = 0; family < families; family++) {
        const row = moments[family < g ? 0 : 1], urn = [], fs = Array(5).fill(0), cs = Array(5).fill(0);
        const anchor = s.effect === "reuse" || s.effect === "rare-shift" ? draw() : null;
        const shifted = s.effect === "rare-shift" && next() < parameters.r;
        const repeat = () => {
          if (s.effect === "reuse") return next() < 0.4 ? anchor : draw();
          if (s.effect === "rare-shift") return shifted ? anchor : draw();
          const atom = urn.length > 0 && next() < urn.length / (parameters.kappa + urn.length) ? urn[Math.floor(next() * urn.length)] : draw();
          urn.push(atom); return atom;
        };
        for (let conversation = 0; conversation < m; conversation++) {
          const a = repeat(), b = next() < s.repeatCorrelation ? a : repeat();
          const values = [(a.pack + b.pack) / 2, (a.native + b.native) / 2, (a.benefit + b.benefit) / 2,
            (a.bundle.ledger.wrong + b.bundle.ledger.wrong) / 30, (a.bundle.ledger.correct + b.bundle.ledger.correct) / 30];
          for (let j = 0; j < 5; j++) { fs[j] += values[j]; cs[j] += values[j] ** 2; }
          row[20] += a.bundle.ledger.wrong + b.bundle.ledger.wrong; row[21] += a.bundle.ledger.correct + b.bundle.ledger.correct;
        }
        for (let j = 0; j < 5; j++) { const v = fs[j] / m, k = 4 * j; row[k] += v; row[k + 1] += v * v; row[k + 2] += v ** 3; row[k + 3] += cs[j]; }
      }
      moments.push(moments[0].map((v, i) => v + moments[1][i]));
      let accepted = true;
      for (let i = 0; i < scopes.length; i++) {
        const row = moments[i], G = i === 2 ? families : g, denominator = G * m * d.probes * d.repeats;
        const pack = evaluator.safety(row[0], row[1], row[2], G, "continuity-pack-cold");
        const native = evaluator.safety(row[4], row[5], row[6], G, "native");
        const benefit = evaluator.benefit(row[8], row[9], row[10], G, i === 2);
        const passes = { pack: pack.status === "pass", native: native.status === "pass", benefit: benefit.status === "pass",
          "wrong-rate": evaluator.wrongRate(row[20], denominator) === "pass", accuracy: evaluator.accuracy(row[21], 0, denominator) === "pass" };
        for (const [gate, pass] of Object.entries(passes)) {
          if (pass) counts[`${scopes[i]}:${gate}`]++;
          if ((gate !== "accuracy" || i === 2) && !pass) accepted = false;
        }
        for (const [j, gate] of ["pack", "native", "benefit", "wrong-rate", "accuracy"].entries()) {
          const k = 4 * j, dependence = familyDependence(row[k] * m, row[k + 3], row[k + 1], G, m), out = diagnostics[`${scopes[i]}:${gate}`];
          out.icc += dependence.icc ?? 0; out.designEffect += dependence.designEffect ?? 0; out.skew += familyMoments(row[k], row[k + 1], row[k + 2], G).skew ?? 0;
        }
      }
      if (accepted) joint++;
    }
    const estimate = count => { const rate = count / replications; return { rate, monteCarloSE: Math.sqrt(rate * (1 - rate) / replications) }; };
    const gatePassRates = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, estimate(v)]));
    const nullRejectionRates = s.boundary ? Object.fromEntries(Object.entries(gatePassRates).filter(([key]) => {
      if (s.boundary === "benefit:combined") return key === "combined:benefit";
      if (s.boundary === "benefit:corpus") return key !== "combined:benefit" && key.endsWith(":benefit");
      if (s.boundary === "accuracy") return key === "combined:accuracy";
      return key.endsWith(`:${s.boundary}`);
    })) : null;
    for (const row of Object.values(diagnostics)) for (const key of Object.keys(row)) row[key] /= replications;
    return { ...s, families, conversationsPerFamily: m, ...parameters,
      probabilityNoBadFamilyDrawn: s.stress ? (1 - badProbability) ** families : null,
      gatePassRates, nullRejectionRates, diagnostics, jointAcceptance: estimate(joint) };
  });
  const maxima = {};
  for (const s of results.filter(s => !s.stress)) for (const [gate, estimate] of Object.entries(s.nullRejectionRates ?? {}).filter(([gate]) => /:(?:pack|native|benefit)$/u.test(gate))) {
    if (!maxima[gate] || estimate.rate > maxima[gate].rate) maxima[gate] = { ...estimate, scenario: s.name };
  }
  return { schema: "holdout-power-v2", seed, replications, statisticalSpec, scenarios: results, calibrationMaximum: maxima,
    calibrationCriterion: "Every non-stress confidence-bound gate/scope boundary pass rate <= 0.055; observed-wrong and accuracy point rules are excluded.",
    calibrationPass: Object.keys(maxima).length === 0 ? null : Object.values(maxima).every(x => x.rate <= 0.055),
    assumptions: ["One-sided confidence is pack 97%, native 95%, benefit 95%; each critical value also enters its tighten-only skew term. Pack 95% was anti-conservative for lumpy errors at the tiny margin. The 65-scenario confidence-calibration/target prefix preserves the exploratory B RNG stream; all other scenarios follow.",
      "Families are freshly sampled scenario types each replication. Main DGP uses Dirichlet random family outcome-mixture probabilities, inducing per-arm correct/wrong shifts with exactly preserved superpopulation means. Polya-urn integration is exact, not the stress model.",
      "Target ICC is for conversation-paired D (and benefit), not marginal wrong indicators. With r=1/(kappa+1), a=(1+rho)/2, ICC=r/(a+(1-a)r). rho is CONDITIONAL repeat copying; marginal repeat correlation is rho+(1-rho)r and is reported.",
      "Coherent 15-slot arm bundles use concentrated 0/3 errors and 0/6 abstentions conditional on remaining slots; half share cross-arm uniforms, half are independent. Simulated abstentions are pure whole-answer expressions, not substantive hedges or missing text. These count-mixture assumptions are not model-performance estimates.",
      "The non-stress right-skew variant uses a rare all-mass family arm shift with probability r, otherwise the baseline distribution; it preserves all means and target ICC exactly. Bundle-reuse stress instead mixes .4 family anchor + .6 baseline, with 0/6 errors. P(no bad family drawn) means no anchor with any ledger error among all families.",
      "128 families of 2 per corpus is registered; 16 families of 16 per corpus is reference only. Combined bounds pool all families. Diagnostics are averages of realized ANOVA ICC, design effect and family-mean sample skew across replications.",
      "Joint acceptance uses actual family/skew gateEvaluator, conditional on complete data, admission and passing certified audit. Point-rule wrong/accuracy boundary pass probabilities near 50% are expected, not nominal confidence tests. Stress is reported, excluded from calibration criterion. No simultaneous-coverage claim; no paid/provider runs."] };
}
export function powerMarkdown(report) {
  const f = x => x.toFixed(6);
  return ["# Family-clustered holdout power and calibration", "", `Seed ${report.seed}; ${report.replications} replications/scenario. Calibration criterion (confidence-bound gates only) holds: ${report.calibrationPass}.`, "", `One-sided confidence: pack ${report.statisticalSpec.confidenceByGate.pack * 100}%; native ${report.statisticalSpec.confidenceByGate.native * 100}%; benefit ${report.statisticalSpec.confidenceByGate.benefit * 100}%.`, "", ...report.assumptions.map(a => `- ${a}`), "",
    "| Gate/scope | Max non-stress boundary pass | MC SE | Scenario |", "| --- | ---: | ---: | --- |",
    ...Object.entries(report.calibrationMaximum).map(([k, x]) => `| ${k} | ${f(x.rate)} | ${f(x.monteCarloSE)} | ${x.scenario} |`), "",
    "| Scenario | Joint acceptance (MC SE) | Boundary pass (MC SE) by scope | ICC / DE / skew (C1,C2,pooled) | P(no bad family) |", "| --- | --- | --- | --- | --- |",
    ...report.scenarios.map(s => `| ${s.name} | ${f(s.jointAcceptance.rate)} (${f(s.jointAcceptance.monteCarloSE)}) | ${Object.entries(s.nullRejectionRates ?? {}).map(([k, x]) => `${k}: ${f(x.rate)} (${f(x.monteCarloSE)})`).join("; ")} | ${Object.entries(s.diagnostics).filter(([k]) => !s.boundary || k.endsWith(`:${s.boundary.split(":")[0]}`)).map(([k, x]) => `${k}: ${f(x.icc)}/${f(x.designEffect)}/${f(x.skew)}`).join("; ")} | ${s.probabilityNoBadFamilyDrawn === null ? "—" : f(s.probabilityNoBadFamilyDrawn)} |`), ""].join("\n");
}
