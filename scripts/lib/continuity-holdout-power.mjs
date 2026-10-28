import { clopperPearson, logGamma, tQuantile } from "./continuity-holdout-statistics.mjs";

export function safetyPower(risk, n = 128) {
  if (!(risk > 0 && risk < 1)) throw new Error("invalid_power_risk");
  const accepted = size => Array.from({ length: size + 1 }, (_, k) => k).filter(k => clopperPearson(k, size).upper <= 0.05);
  const perCorpus = accepted(n), combined = new Set(accepted(2 * n));
  const pmf = k => Math.exp(logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(risk) + (n - k) * Math.log1p(-risk));
  const single = perCorpus.reduce((sum, k) => sum + pmf(k), 0);
  let bothCorpora = 0;
  for (const a of perCorpus) for (const b of perCorpus) if (combined.has(a + b)) bothCorpora += pmf(a) * pmf(b);
  return { risk, conversationsPerCorpus: n, largestAcceptedCount: Math.max(...perCorpus), largestCombinedAcceptedCount: Math.max(...combined),
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
  const values = [-1 / 15, 2 / 15, 6 / 15], mean = 0.04, second = mean ** 2 + 0.12 ** 2 * 2 / (1 + rho);
  const probabilities = values.map((x, i) => { const [a, b] = values.filter((_, j) => j !== i); return (second - (a + b) * mean + a * b) / ((x - a) * (x - b)); });
  if (probabilities.some(p => p < 0 || p > 1)) throw new Error("invalid_power_distribution");
  return { values, probabilities };
}
export function simulatePower({ seed = 572913, replications = 100000, scenarios = POWER_SCENARIOS } = {}) {
  if (!Number.isSafeInteger(replications) || replications < 100000 || !Number.isSafeInteger(seed) || seed <= 0 || seed > 0xffffffff) throw new Error("invalid_power_design");
  let state = seed;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const t128 = tQuantile(0.95, 127), t256 = tQuantile(0.95, 255), exact = [0.005, 0.01].map(q => safetyPower(q));
  const maximum = exact[0].largestAcceptedCount, combinedMaximum = exact[0].largestCombinedAcceptedCount;
  const lower = (sum, squares, n, t) => sum / n - t * Math.sqrt(Math.max(0, (squares - sum * sum / n) / (n - 1)) / n);
  const results = scenarios.map(s => {
    const rho = s.repeatCorrelation, w = s.familyWeight, effectiveRho = rho + (1 - rho) * w * w;
    const { values, probabilities: p } = effectDistribution(effectiveRho);
    const categorical = () => { const u = next(); return u < p[0] ? values[0] : u < p[0] + p[1] ? values[1] : values[2]; };
    let joint = 0, safety = 0, benefit = 0;
    for (let replication = 0; replication < replications; replication++) {
      const sum = [0, 0], squares = [0, 0], harmful = [0, 0];
      for (let family = 0; family < 16; family++) {
        const group = family < 8 ? 0 : 1, familyValue = categorical();
        const familyRisk = w === 0 ? s.risk : next() < 0.5 ? 0 : 2 * s.risk;
        const draw = () => w > 0 && next() < w ? familyValue : categorical();
        for (let conversation = 0; conversation < 16; conversation++) {
          const first = draw(), second = next() < rho ? first : draw(), difference = (first + second) / 2;
          sum[group] += difference; squares[group] += difference * difference;
          if (next() < familyRisk) harmful[group]++;
        }
      }
      const safe = harmful.every(k => k <= maximum && k / 3840 <= 0.005) && harmful[0] + harmful[1] <= combinedMaximum;
      const beneficial = lower(sum[0], squares[0], 128, t128) > 0 && lower(sum[1], squares[1], 128, t128) > 0
        && lower(sum[0] + sum[1], squares[0] + squares[1], 256, t256) > 0.02;
      if (safe) safety++; if (beneficial) benefit++; if (safe && beneficial) joint++;
    }
    const power = joint / replications;
    return { ...s, effectiveRepeatCorrelation: effectiveRho, effectValuesPerRepeat: values, effectProbabilities: p,
      safetyPower: safety / replications, benefitPower: benefit / replications, jointAcceptancePower: power, monteCarloSE: Math.sqrt(power * (1 - power) / replications) };
  });
  return { schema: "holdout-power-v1", seed, replications, exactSafety: exact, scenarios: results,
    assumptions: ["256 conversations, 128 per corpus, 16 families of 16; families are disjoint across corpora.",
      "Discrete repeat differences in 15-probe increments; marginal true benefit .04 and SD of two-repeat conversation differences .12.",
      "Ledger correct fraction is 14/15 in each repeat; pack correct fraction is ledger minus the simulated repeat difference (always in [0,1]). Accuracy floor therefore passes.",
      "Both comparator harmful indicators are identical; each harmful conversation contributes one non-abstaining ledger error, all other incorrect answers abstain. Exact enumeration also reports independent-comparator safety power.",
      "For heterogeneous scenarios a family draws risk 0 or 2q equiprobably, and a shared effect value is used with the stated familyWeight on each draw. Repeat correlation includes that shared family component. Residual within-family dependence makes these sensitivity analyses, not family-cluster calibration of conversation-level gates.",
      "Joint power is conditional on complete data/integrity and a passing complete audit (zero audit findings). These assumptions are not model-quality measurements or an audit-power estimate."] };
}
export function powerMarkdown(report) {
  return ["# Holdout planned-design power", "", `Seed ${report.seed}; ${report.replications} replications per scenario.`, "", ...report.assumptions.map(a => `- ${a}`), "",
    "| Scenario | Safety | Benefit | Joint acceptance | MC SE |", "| --- | ---: | ---: | ---: | ---: |",
    ...report.scenarios.map(s => `| ${s.name} | ${s.safetyPower.toFixed(6)} | ${s.benefitPower.toFixed(6)} | ${s.jointAcceptancePower.toFixed(6)} | ${s.monteCarloSE.toFixed(6)} |`), ""].join("\n");
}
