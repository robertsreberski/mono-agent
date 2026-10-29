import { logGamma, STATISTICAL_SPEC, validateStatisticalSpec, safetyCuts, gateEvaluator } from "./continuity-holdout-statistics.mjs";

export function safetyPower(risk, n = STATISTICAL_SPEC.design.conversationsPerCorpus, statisticalSpec = STATISTICAL_SPEC) {
  validateStatisticalSpec(statisticalSpec);
  if (!(risk > 0 && risk < 1)) throw new Error("invalid_power_risk");
  const maximum = safetyCuts(n, statisticalSpec).passMaximum, combinedMaximum = safetyCuts(2 * n, statisticalSpec).passMaximum;
  const perCorpus = Array.from({ length: maximum + 1 }, (_, k) => k);
  const pmf = k => Math.exp(logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(risk) + (n - k) * Math.log1p(-risk));
  const single = perCorpus.reduce((sum, k) => sum + pmf(k), 0);
  let bothCorpora = 0;
  for (const a of perCorpus) for (const b of perCorpus) if (a + b <= combinedMaximum) bothCorpora += pmf(a) * pmf(b);
  return { risk, conversationsPerCorpus: n, largestAcceptedCount: maximum, largestCombinedAcceptedCount: combinedMaximum,
    individualGatePower: single, bothCorporaAndCombined: bothCorpora, bothComparatorsShared: bothCorpora, bothComparatorsIndependent: bothCorpora ** 2 };
}
export const POWER_SCENARIOS = Object.freeze([0.005, 0.01].flatMap(risk => [
  { name: `risk-${risk}-independent-repeats`, risk, repeatCorrelation: 0, familyWeight: 0 },
  { name: `risk-${risk}-correlated-repeats`, risk, repeatCorrelation: 0.5, familyWeight: 0 },
  { name: `risk-${risk}-family-heterogeneity`, risk, repeatCorrelation: 0.5, familyWeight: 0.4 },
  { name: `risk-${risk}-high-repeat-correlation`, risk, repeatCorrelation: 0.9, familyWeight: 0.4 },
]));

/** Discrete 15-probe repeat effects, with exact mean .04 and conversation-bundle SD .12. */
export function effectDistribution(rho) {
  const probes = STATISTICAL_SPEC.design.probes, values = [-1 / probes, 2 / probes, 6 / probes], mean = 0.04, second = mean ** 2 + 0.12 ** 2 * 2 / (1 + rho);
  const probabilities = values.map((x, i) => { const [a, b] = values.filter((_, j) => j !== i); return (second - (a + b) * mean + a * b) / ((x - a) * (x - b)); });
  if (probabilities.some(p => p < 0 || p > 1)) throw new Error("invalid_power_distribution");
  return { values, probabilities };
}
export function simulatePower({ seed = 572913, replications = 100000, scenarios = POWER_SCENARIOS, statisticalSpec = STATISTICAL_SPEC } = {}) {
  if (!Number.isSafeInteger(replications) || replications < 100000 || !Number.isSafeInteger(seed) || seed <= 0 || seed > 0xffffffff) throw new Error("invalid_power_design");
  let state = seed;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  validateStatisticalSpec(statisticalSpec);
  const d = statisticalSpec.design, n = d.conversationsPerCorpus, total = n * d.corpora.length, bundleSize = d.probes * d.repeats;
  const evaluator = gateEvaluator(statisticalSpec), exact = [0.005, 0.01].map(q => safetyPower(q, n, statisticalSpec));
  const results = scenarios.map(s => {
    const rho = s.repeatCorrelation, w = s.familyWeight, effectiveRho = rho + (1 - rho) * w * w;
    const { values, probabilities: p } = effectDistribution(effectiveRho);
    const categorical = () => { const u = next(); return u < p[0] ? values[0] : u < p[0] + p[1] ? values[1] : values[2]; };
    let joint = 0, safety = 0, benefit = 0;
    for (let replication = 0; replication < replications; replication++) {
      const sum = [0, 0], squares = [0, 0], harmful = [0, 0];
      for (let family = 0; family < d.families; family++) {
        const group = family < d.families / d.corpora.length ? 0 : 1, familyValue = categorical();
        const familyRisk = w === 0 ? s.risk : next() < 0.5 ? 0 : 2 * s.risk;
        const draw = () => w > 0 && next() < w ? familyValue : categorical();
        for (let conversation = 0; conversation < d.conversationsPerFamily; conversation++) {
          const first = draw(), second = next() < rho ? first : draw(), difference = (first + second) / 2;
          sum[group] += difference; squares[group] += difference * difference;
          if (next() < familyRisk) harmful[group]++;
        }
      }
      const safe = harmful.every(k => evaluator.safety(k, n) === "pass" && evaluator.wrongRate(k, n * bundleSize) === "pass")
        && evaluator.safety(harmful[0] + harmful[1], total) === "pass";
      const beneficial = evaluator.benefit(sum[0], squares[0], n, false).status === "pass"
        && evaluator.benefit(sum[1], squares[1], n, false).status === "pass"
        && evaluator.benefit(sum[0] + sum[1], squares[0] + squares[1], total, true).status === "pass";
      const accurate = evaluator.accuracy(total * (d.probes - 1) * d.repeats, 0, total * bundleSize) === "pass";
      if (safe) safety++; if (beneficial) benefit++; if (safe && beneficial && accurate) joint++;
    }
    const power = joint / replications;
    return { ...s, effectiveRepeatCorrelation: effectiveRho, effectValuesPerRepeat: values, effectProbabilities: p,
      safetyPower: safety / replications, benefitPower: benefit / replications, jointAcceptancePower: power, monteCarloSE: Math.sqrt(power * (1 - power) / replications) };
  });
  return { schema: "holdout-power-v1", seed, replications, statisticalSpec, exactSafety: exact, scenarios: results,
    assumptions: [`${total} conversations, ${n} per corpus, ${d.families} families of ${d.conversationsPerFamily}; families are disjoint across corpora.`,
      "Discrete repeat differences in 15-probe increments; marginal true benefit .04 and SD of two-repeat conversation differences .12.",
      "Ledger correct fraction is 14/15 in each repeat; pack correct fraction is ledger minus the simulated repeat difference (always in [0,1]). The configured accuracy floor is evaluated, not assumed to pass.",
      "Both comparator harmful indicators are identical; each harmful conversation contributes one non-abstaining ledger error, all other incorrect answers abstain. Exact enumeration also reports independent-comparator safety power.",
      "For heterogeneous scenarios a family draws risk 0 or 2q equiprobably, and a shared effect value is used with the stated familyWeight on each draw. Repeat correlation includes that shared family component. Residual within-family dependence makes these sensitivity analyses, not family-cluster calibration of conversation-level gates.",
      "Missing-slot tolerance is not modeled; complete-data gateEvaluator power semantics are unchanged.",
      "Joint power is conditional on complete data/integrity and a passing complete audit (zero audit findings). These assumptions are not model-quality measurements or an audit-power estimate."] };
}
export function powerMarkdown(report) {
  return ["# Holdout planned-design power", "", `Seed ${report.seed}; ${report.replications} replications per scenario.`, "", ...report.assumptions.map(a => `- ${a}`), "",
    "| Scenario | Safety | Benefit | Joint acceptance | MC SE |", "| --- | ---: | ---: | ---: | ---: |",
    ...report.scenarios.map(s => `| ${s.name} | ${s.safetyPower.toFixed(6)} | ${s.benefitPower.toFixed(6)} | ${s.jointAcceptancePower.toFixed(6)} | ${s.monteCarloSE.toFixed(6)} |`), ""].join("\n");
}
