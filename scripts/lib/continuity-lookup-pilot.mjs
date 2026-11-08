// Artifact contracts only. Nothing in this module dispatches or grants authority.
import { readFile } from "node:fs/promises";
import { digest } from "./continuity-dataset.mjs";
import { sha256, LOOKUP_TIMING, LOOKUP_PILOT_MEASURED_ROLES } from "./continuity-lookup.mjs";
import { LOOKUP_ASSUMPTIONS } from "./continuity-lookup-guard.mjs";
import { registerLookup, lookupWorkload, validateRegistration, requireLookup } from "./continuity-lookup-roles.mjs";
import { offlineCatalog, estimateExternalLookup, LOOKUP_EXPECTED_SCENARIO } from "../continuity-lookup-estimate.mjs";

export const LOOKUP_FAUX_AUTHORIZATION_DOMAIN = "mono-agent/lookup-pilot/faux-consumed-v1\0";
export const LOOKUP_PILOT_SCHEMA = "continuity-lookup-pilot-descriptor-v1";
export const LOOKUP_PILOT_REGISTRATION = "continuity-lookup-pilot-registration-v1";
export const LOOKUP_CACHE_POLICY = "controller-issued-transport-key-v1";
export const LOOKUP_ACCOUNTING = Object.freeze({
  version: "lookup-accounting-v1", lost: "incomplete", ownAbort: "incomplete",
  repeatedLossCode: "lookup_repeated_loss", consecutiveLossLimit: 2,
  total: "sum(complete settled)+sum(max(retained hold,known partial))+sum(active holds)",
  admission: "T+Rmax<=C", concurrency: 1,
});
const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
const need = requireLookup;
// Exact decimal rational arithmetic, including exponent notation from JSON numbers.
function decimal(value) {
  need(typeof value === "number" && Number.isFinite(value) && value >= 0, "lookup_cap_invalid");
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split("."), shift = Number(exponent) - fraction.length;
  const n = BigInt(whole + fraction);
  return shift >= 0 ? [n * 10n ** BigInt(shift), 1n] : [n, 10n ** BigInt(-shift)];
}
function add([a, b], [c, d]) {
  const n = a * d + c * b, denominator = b * d;
  let x = n < 0n ? -n : n, y = denominator;
  while (y) [x, y] = [y, x % y];
  return [n / x, denominator / x];
}
const mul = ([a, b], n) => [a * BigInt(n), b];
const usd = ([n, d]) => Number(n) / Number(d);
const less = ([a, b], [c, d]) => a * d < c * b;
const max = values => values.map(decimal).reduce((a, b) => less(a, b) ? b : a);
function catalogRates(catalog, assumptions) {
  need(catalog?.model === "openai-codex:gpt-6.1-sol" && /^[a-f0-9]{64}$/u.test(catalog.fileSha256 ?? "")
    && catalog.maxTokens === assumptions.outputMax && catalog.contextWindow >= assumptions.inputMax, "lookup_catalog_binding_mismatch");
  const cost = catalog.cost, tiers = cost?.tiers ?? [];
  need(Array.isArray(tiers) && tiers.every(t => Number.isSafeInteger(t.inputTokensAbove) && t.inputTokensAbove >= 0)
    && new Set(tiers.map(t => t.inputTokensAbove)).size === tiers.length, "lookup_catalog_binding_mismatch");
  const all = [cost, ...tiers];
  need(all.every(rate => rate && ["input", "output", "cacheRead", "cacheWrite"].every(k => typeof rate[k] === "number" && Number.isFinite(rate[k]) && rate[k] >= 0)), "lookup_catalog_binding_mismatch");
  need(same(Object.fromEntries(Object.keys(assumptions.rates).map(k => [k, cost[k]])), assumptions.rates), "lookup_catalog_binding_mismatch");
  return [cost, ...tiers.filter(t => t.inputTokensAbove < assumptions.inputMax)];
}
function requestMaximum(catalog, assumptions) {
  const applicable = catalogRates(catalog, assumptions);
  const input = max(applicable.flatMap(rate => [rate.input, rate.cacheRead, rate.cacheWrite]));
  const output = max(applicable.map(rate => rate.output));
  const result = mul(add(mul(input, assumptions.inputMax), mul(output, assumptions.outputMax)), assumptions.tierMultiplierMax);
  result[1] *= 1000000n;
  need(!less(result, decimal(3.92)) && !less(decimal(3.92), result), "lookup_catalog_binding_mismatch");
  return result;
}
function scenarioCall(catalog, input, output, { numerator: cached, denominator: parts } = LOOKUP_EXPECTED_SCENARIO.cachedInput) {
  let rate = catalog.cost, threshold = -1;
  for (const tier of catalog.cost.tiers ?? []) if (input > tier.inputTokensAbove && tier.inputTokensAbove > threshold) { rate = tier; threshold = tier.inputTokensAbove; }
  const inputRate = add(mul(decimal(rate.input), parts - cached), mul(decimal(rate.cacheRead), cached));
  const result = add(mul(inputRate, input), mul(decimal(rate.output), output * parts));
  result[1] *= BigInt(parts) * 1000000n; // exact cached/uncached split, default service tier
  return result;
}
/** E is a scenario, not an invoice or permission. Full-upfront is comparison only. */
export function estimateLookupPilot({ workload, catalog, capUSD, assumptions = LOOKUP_ASSUMPTIONS }) {
  need(same(assumptions, LOOKUP_ASSUMPTIONS), "lookup_assumptions_mismatch");
  const rmax = requestMaximum(catalog, assumptions), cap = decimal(capUSD);
  need(!less(cap, rmax) && cap[0] * 100n % cap[1] === 0n
    && cap[0] * 100n / cap[1] < 10n ** 15n, "lookup_cap_invalid"); // <15 significant digits: the float dollar value round-trips
  const legacy = estimateExternalLookup({ workload, catalog }); // retains complete inventory/context checks
  let expected = [0n, 1n], eligible = 0;
  for (const path of workload.policy.budget.paths) if (LOOKUP_PILOT_MEASURED_ROLES.includes(path.role) && path.feasibility.classification === "feasible") {
    eligible++;
    const S = LOOKUP_EXPECTED_SCENARIO, initial = path.initialTokens + S.inputAllowanceTokens, later = initial + S.laterInputIncrementTokens;
    for (const input of [initial, ...Array(S.requestsPerSlot - 1).fill(later)]) expected = add(expected, scenarioCall(catalog, input, Math.min(S.outputTokensPerRequest, workload.outputLimit.tokens)));
  }
  const headroom = add(cap, [-rmax[0], rmax[1]]);
  const skipped = legacy.planned - eligible;
  // Corrected full-upfront comparison: ten maximum requests per eligible slot, 25% buffer, ceil cents.
  const upfront = mul(rmax, eligible * 10 * 125), cents = (upfront[0] + upfront[1] - 1n) / upfront[1];
  return { schema: "continuity-lookup-pilot-estimate-v1", executionKind: "offline-estimate", authorizedSpend: false,
    expectedUSD: usd(expected), rmaxUSD: usd(rmax), capUSD: usd(cap), lastAdmissibleHeadroomUSD: usd(headroom),
    capOverExpected: expected[0] === 0n ? null : usd([cap[0] * expected[1], cap[1] * expected[0]]),
    fullUpfrontComparisonUSD: Number(cents) / 100, eligible, skipped,
    scenario: { version: LOOKUP_EXPECTED_SCENARIO.version, requests: LOOKUP_EXPECTED_SCENARIO.requestsPerSlot, lookups: LOOKUP_EXPECTED_SCENARIO.lookupsPerSlot,
      laterInputIncrementTokens: LOOKUP_EXPECTED_SCENARIO.laterInputIncrementTokens,
      cacheFraction: `${LOOKUP_EXPECTED_SCENARIO.cachedInput.numerator}/${LOOKUP_EXPECTED_SCENARIO.cachedInput.denominator}`,
      outputTokensPerRound: LOOKUP_EXPECTED_SCENARIO.outputTokensPerRequest, inputAllowanceTokens: LOOKUP_EXPECTED_SCENARIO.inputAllowanceTokens,
      margin: LOOKUP_EXPECTED_SCENARIO.margin, serviceTier: "default", measurement: false },
    assumptions, assumptionsSha256: digest(assumptions), catalogSha256: digest(catalog) };
}
export function lookupPilotDescriptor({ workload, catalog, capUSD, scheduleSeed, runDeadlineMs, assumptions = LOOKUP_ASSUMPTIONS }) {
  const estimate = estimateLookupPilot({ workload, catalog, capUSD, assumptions });
  need(Number.isSafeInteger(scheduleSeed) && scheduleSeed >= 0 && Number.isSafeInteger(runDeadlineMs) && runDeadlineMs > 0, "lookup_pilot_not_ready");
  const schedule = { version: "seeded-pair-block-interleaved-roles-v1", seed: scheduleSeed,
    inventorySha256: digest(workload.policy.budget.paths), selectionSha256: digest(workload.lookupSelection) };
  return { schema: LOOKUP_PILOT_SCHEMA, capPolicy: "cap-gated-v1", capUSD: estimate.capUSD, rmaxUSD: estimate.rmaxUSD, concurrency: 1,
    assumptions, assumptionsSha256: digest(assumptions), catalogSha256: digest(catalog),
    outputCap: "catalog_max_assumed", inputEnvelope: "assumed-v1", cacheKeyPolicy: LOOKUP_CACHE_POLICY,
    schedule, scheduleSha256: digest(schedule), deadlines: { ...LOOKUP_TIMING, runDeadlineMs }, accounting: LOOKUP_ACCOUNTING };
}
/** Separate schema wraps an unchanged full-upfront registration; C is never its legacy cap. */
export async function registerLookupPilot({ capUSD, scheduleSeed, runDeadlineMs, ...options }) {
  need(options.lookupSource, "incompatible_lookup_registration");
  const workload = await lookupWorkload({ ...options, inputRoots: [options.checkouts?.R0?.path, options.checkouts?.Rpack?.path] });
  const catalog = await offlineCatalog(workload.reader.model);
  const comparison = estimateExternalLookup({ workload, catalog });
  const registration = await registerLookup({ ...options, catalogCapUSD: comparison.catalogCapUSD });
  need(registration.schema === "continuity-lookup-registration-v2", "incompatible_lookup_registration");
  const descriptor = lookupPilotDescriptor({ workload: registration.common, catalog: registration.common.catalog, capUSD, scheduleSeed, runDeadlineMs });
  return validateLookupPilotRegistration({ schema: LOOKUP_PILOT_REGISTRATION, registration, descriptor });
}
export async function validateLookupPilotRegistration(pilot) {
  need(pilot?.schema === LOOKUP_PILOT_REGISTRATION && pilot.registration?.schema === "continuity-lookup-registration-v2", "incompatible_lookup_registration");
  await validateRegistration(pilot.registration);
  const { common } = pilot.registration, d = pilot.descriptor;
  need(common.reader.model === "openai-codex:gpt-6.1-sol" && common.reader.effort === "high", "lookup_pilot_not_ready");
  const catalog = await offlineCatalog(common.reader.model);
  need(same(catalog, common.catalog), "lookup_catalog_binding_mismatch");
  need(same(d?.assumptions, LOOKUP_ASSUMPTIONS) && d.assumptionsSha256 === digest(LOOKUP_ASSUMPTIONS), "lookup_assumptions_mismatch");
  const expected = lookupPilotDescriptor({ workload: common, catalog, capUSD: d.capUSD, scheduleSeed: d.schedule?.seed, runDeadlineMs: d.deadlines?.runDeadlineMs });
  need(same(pilot, { schema: LOOKUP_PILOT_REGISTRATION, registration: pilot.registration, descriptor: expected }), "lookup_pilot_not_ready");
  return pilot;
}
export async function readLookupPilotRegistration(path, hash) {
  const bytes = await readFile(path);
  need(/^[a-f0-9]{64}$/u.test(hash ?? "") && sha256(bytes) === hash, "lookup_registration_hash_mismatch");
  return validateLookupPilotRegistration(JSON.parse(bytes));
}
