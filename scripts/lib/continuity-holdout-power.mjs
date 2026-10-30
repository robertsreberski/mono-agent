import { STATISTICAL_SPEC, validateStatisticalSpec, gateEvaluator } from "./continuity-holdout-statistics.mjs";

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
export const POWER_SCENARIOS = Object.freeze([
  ...qualities.flatMap(s => [0, 0.5, 0.9].map(repeatCorrelation => ({ ...s, name: `${s.name}-rho-${repeatCorrelation}`, repeatCorrelation, familyWeight: 0, errorCount: 3 }))),
  ...qualities.filter(s => ["improved-target", "pack-null", "native-null"].includes(s.name)).map(s => ({ ...s, name: `${s.name}-family-sensitivity`, repeatCorrelation: 0.5, familyWeight: 0.4, errorCount: 6 })),
]);

/** Coherent 15-answer repeat counts, including concentrated errors and abstentions.
 * Half of repeats share uniforms across arms; half have independent arm uniforms.
 * Correct/wrong/abstention are mutually exclusive and sum to 15 for every arm.
 */
export function repeatBundle(next, quality, errorCount = 3, probes = 15) {
  const shared = next() < 0.5, error = next(), abstention = next();
  return Object.fromEntries(["native", "pack", "ledger"].map(arm => {
    const [correctRate, wrongRate] = quality[arm], u = shared ? error : next(), v = shared ? abstention : next();
    const wrong = u < wrongRate * probes / errorCount ? errorCount : 0;
    const remaining = probes - wrong, abstentionCount = Math.min(6, remaining);
    const conditionalAbstentions = remaining * (1 - correctRate - wrongRate) / (1 - wrongRate);
    const abstained = v < conditionalAbstentions / abstentionCount ? abstentionCount : 0;
    return [arm, { correct: remaining - abstained, wrong, abstained }];
  }));
}
function validateScenario(s, probes) {
  if (![s.repeatCorrelation, s.familyWeight].every(x => x >= 0 && x <= 1)
    || !Number.isSafeInteger(s.errorCount) || s.errorCount < 1 || s.errorCount > probes
    || !["native", "pack", "ledger"].every(arm => {
      const q = s.quality?.[arm];
      // Ensure the two-point distributions can realize these expectations, even after an error.
      return q?.length === 2 && q.every(x => Number.isFinite(x) && x >= 0 && x <= 1)
        && q[0] + q[1] <= 1 && q[1] < 1 && q[1] * probes <= s.errorCount
        && probes * (1 - q[0] - q[1]) / (1 - q[1]) <= Math.min(6, probes - s.errorCount);
    })) throw new Error("invalid_power_scenario");
}
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
export function simulatePower({ seed = 572913, replications = 100000, scenarios = POWER_SCENARIOS, statisticalSpec = STATISTICAL_SPEC } = {}) {
  if (!Number.isSafeInteger(replications) || replications < 100000 || !Number.isSafeInteger(seed) || seed <= 0 || seed > 0xffffffff) throw new Error("invalid_power_design");
  let state = seed;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  validateStatisticalSpec(statisticalSpec);
  const d = statisticalSpec.design, n = d.conversationsPerCorpus, total = 2 * n, size = d.probes * d.repeats;
  const evaluator = gateEvaluator(statisticalSpec);
  const results = scenarios.map(s => {
    validateScenario(s, d.probes);
    const atoms = bundleDistribution(s.quality, s.errorCount, d.probes);
    let cumulative = 0;
    const cdf = atoms.map(a => (cumulative += a.probability));
    const draw = () => { const u = next(); let lo = 0, hi = cdf.length - 1;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (u < cdf[mid]) hi = mid; else lo = mid + 1; }
      return atoms[lo]; };
    const counts = {}, scopes = [...d.corpora, "combined"];
    for (const scope of scopes) for (const gate of ["pack", "native", "wrong-rate", "benefit", "accuracy"]) counts[`${scope}:${gate}`] = 0;
    let joint = 0;
    for (let replication = 0; replication < replications; replication++) {
      const moments = [Array(8).fill(0), Array(8).fill(0)];
      for (let family = 0; family < d.families; family++) {
        const group = family < d.families / 2 ? 0 : 1;
        const familyBundle = s.familyWeight > 0 ? draw() : null;
        const repeat = () => s.familyWeight > 0 && next() < s.familyWeight ? familyBundle : draw();
        for (let conversation = 0; conversation < d.conversationsPerFamily; conversation++) {
          const a = repeat(), b = next() < s.repeatCorrelation ? a : repeat();
          const wrong = a.bundle.ledger.wrong + b.bundle.ledger.wrong, correct = a.bundle.ledger.correct + b.bundle.ledger.correct;
          const pack = (a.pack + b.pack) / 2;
          const native = (a.native + b.native) / 2;
          const benefit = (a.benefit + b.benefit) / 2;
          const m = moments[group];
          m[0] += pack; m[1] += pack * pack; m[2] += native; m[3] += native * native;
          m[4] += benefit; m[5] += benefit * benefit; m[6] += wrong; m[7] += correct;
        }
      }
      moments.push(moments[0].map((v, i) => v + moments[1][i]));
      let accepted = true;
      for (let i = 0; i < scopes.length; i++) {
        const m = moments[i], count = i === 2 ? total : n, denominator = count * size;
        const passes = {
          pack: evaluator.safety(m[0], m[1], count, "continuity-pack-cold").status === "pass",
          native: evaluator.safety(m[2], m[3], count, "native").status === "pass",
          "wrong-rate": evaluator.wrongRate(m[6], denominator) === "pass",
          benefit: evaluator.benefit(m[4], m[5], count, i === 2).status === "pass",
          accuracy: evaluator.accuracy(m[7], 0, denominator) === "pass",
        };
        for (const [gate, pass] of Object.entries(passes)) {
          if (pass) counts[`${scopes[i]}:${gate}`]++;
          // Accuracy is registered only combined; all other gates are necessary in every scope.
          if ((gate !== "accuracy" || i === 2) && !pass) accepted = false;
        }
      }
      if (accepted) joint++;
    }
    const gatePassRates = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / replications]));
    const power = joint / replications;
    const nullRejectionRates = s.boundary ? Object.fromEntries(Object.entries(gatePassRates).filter(([key]) => {
      if (s.boundary === "benefit:combined") return key === "combined:benefit";
      if (s.boundary === "benefit:corpus") return key !== "combined:benefit" && key.endsWith(":benefit");
      if (s.boundary === "accuracy") return key === "combined:accuracy";
      return key.endsWith(`:${s.boundary}`);
    })) : null;
    return { ...s, gatePassRates, nullRejectionRates, jointAcceptancePower: power, monteCarloSE: Math.sqrt(power * (1 - power) / replications) };
  });
  return { schema: "holdout-power-v2", seed, replications, statisticalSpec, scenarios: results,
    assumptions: [`${total} conversations, ${n} per corpus, ${d.families} disjoint families of ${d.conversationsPerFamily}. Each corpus has the same stated quality distribution.`,
      "Each repeat has coherent native/pack/ledger counts in 15 slots. Wrong counts are 0 or errorCount (3; 6 in concentration/family sensitivities); abstentions are 0 or 6 conditional on remaining slots. Expected correct/wrong fractions equal the scenario inputs. Positions within a repeat do not affect the gates.",
      "Half of repeat draws share error/abstention uniforms across arms, half use independent uniforms. Repeat 2 copies repeat 1 with probability rho (0/0.5/0.9), otherwise redraws. This induces the stated repeat correlation with no independent-probe inference.",
      "Main scenarios have independent conversations conditional on a fixed family layout. Sensitivities reuse a family repeat bundle with probability .4, with extra error concentration; residual family dependence is not family-cluster calibration. Their effective repeat correlation is rho + (1-rho)*.4^2.",
      "Null rejection means a gate passes at its true boundary (rejecting non-inferiority/benefit null). Paired interval gates target at most 5%; the observed wrong/accuracy point thresholds are NOT level-5% tests and may pass near 50% at their boundaries. No simultaneous-coverage claim.",
      "Joint acceptance calls every actual gateEvaluator gate, conditional on complete data, admissible execution and a passing certified audit. Cold-rebuild is descriptive only and not simulated. Missingness, provider behavior and audit power are not modeled.",
      "These are assumed count-mixture distributions, not estimated model performance. Poor power/calibration blocks freezing a study; never loosen the approved margins in response."] };
}
export function powerMarkdown(report) {
  const rate = x => x.toFixed(6);
  return ["# Holdout v2 planned-design power and null calibration", "", `Seed ${report.seed}; ${report.replications} replications per scenario.`, "", ...report.assumptions.map(a => `- ${a}`), "",
    "| Scenario | Joint acceptance | MC SE | Boundary rejection rates (corpus 1 / corpus 2 / combined, as applicable) |",
    "| --- | ---: | ---: | --- |",
    ...report.scenarios.map(s => `| ${s.name} | ${rate(s.jointAcceptancePower)} | ${rate(s.monteCarloSE)} | ${s.nullRejectionRates ? Object.entries(s.nullRejectionRates).map(([k, v]) => `${k}: ${rate(v)}`).join("; ") : "—"} |`), ""].join("\n");
}
