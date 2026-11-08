#!/usr/bin/env node
// Sensitivity arithmetic, not execution or spending authority. No network/provider imports.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { digest, loadTraces, traceTokenShape } from "./lib/continuity-dataset.mjs";
import { LOOKUP_BUDGET, LOOKUP_TIMING, LOOKUP_ROLES, LOOKUP_SOULS, assertExternalPolicy, sha256 } from "./lib/continuity-lookup.mjs";
import { ROOT, lookupWorkload, readRegistration, requireLookup } from "./lib/continuity-lookup-roles.mjs";
import { parseLookupOptions, workloadOptions, WORKLOAD_FLAGS } from "./continuity-lookup-compare.mjs";

export const ESTIMATE_PROFILES = Object.freeze([
  { id: "sol", model: "openai-codex:gpt-6.1-sol", purpose: "first qualification profile; not authorized by this estimate" },
  { id: "luna", model: "openai-codex:gpt-6-luna", purpose: "development screening only" },
  { id: "opus", model: "anthropic:claude-opus-5-5", purpose: "separate sensitivity; never pooled with Sol" },
].map(Object.freeze));
/** Expected-value scenario E only, never a safety bound. Calibrated from the completed
 * Sol pilot's counts (240 slots, 748 requests): means of 3.117 requests and 2.329
 * ConversationHistory calls per slot, 116.8 output tokens per request, 7,362.5
 * later-request input tokens above the slot's first request and 32.5% uncached input.
 * Each takes a 1.25 margin, rounded conservatively. The first request keeps the
 * model-independent inventory bound (frozen initialTokens, ceil(bytes/3)) + 900.
 */
export const LOOKUP_EXPECTED_SCENARIO = Object.freeze({
  version: "pilot-calibrated-v1", requestsPerSlot: 4, lookupsPerSlot: 3, inputAllowanceTokens: 900,
  laterInputIncrementTokens: 9216, outputTokensPerRequest: 150,
  cachedInput: Object.freeze({ numerator: 19, denominator: 32 }), serviceTier: "default", margin: 1.25, measurement: false,
});
const finitePrice = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** Only the installed local catalog. Missing prices are not zero or invented. */
export async function offlinePrices(profiles, root = ROOT) {
  const result = {};
  for (const { model } of profiles) {
    requireLookup(/^[a-z0-9-]+:[A-Za-z0-9._/-]+$/u.test(model), "invalid_model_reference");
    const colon = model.indexOf(":"), provider = model.slice(0, colon), id = model.slice(colon + 1);
    let catalog;
    try { catalog = JSON.parse(await readFile(join(root, "packages/turn/node_modules/@earendil-works/pi-ai/dist/providers/data", `${provider}.json`), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const cost = Object.values(catalog).flatMap(models => Object.values(models)).find(entry => entry?.id === id)?.cost;
    if (cost) result[model] = { input: cost.input, output: cost.output, cacheRead: cost.cacheRead ?? null,
      ...(cost.tiers === undefined ? {} : { tiers: cost.tiers }) };
  }
  return result;
}

/** Same tier semantics as telemetry/cost.ts -> Pi calculateCost: highest STRICTLY
 * exceeded input threshold, including cached input. Kept pure: those modules also
 * import provider/auth code, which this offline estimator must not load.
 */
export function priceLookupCall(price, inputTokens, outputTokens, cacheFraction) {
  if (!price || price.tiers !== undefined && (!Array.isArray(price.tiers)
    || price.tiers.some(tier => !finitePrice(tier.inputTokensAbove)))) return { usd: null, tierInputTokensAbove: null };
  let rates = price, threshold = null;
  for (const tier of price.tiers ?? []) if (inputTokens > tier.inputTokensAbove && (threshold === null || tier.inputTokensAbove > threshold)) {
    rates = tier; threshold = tier.inputTokensAbove;
  }
  const known = finitePrice(rates.input) && finitePrice(rates.output) && (cacheFraction === 0 || finitePrice(rates.cacheRead));
  return { tierInputTokensAbove: threshold, usd: known
    ? (inputTokens * ((1 - cacheFraction) * rates.input + cacheFraction * (rates.cacheRead ?? 0)) + outputTokens * rates.output) / 1e6 : null };
}

export async function estimateLookup({ workload, profiles = ESTIMATE_PROFILES, prices = {} }) {
  const shapes = new Map();
  for (const corpus of workload.corpora) {
    const loaded = await loadTraces({ suite: corpus.suite });
    for (const trace of loaded.traces) shapes.set(`${corpus.suite}/${trace.id}`, traceTokenShape(trace));
  }
  const soulBytes = Object.fromEntries(await Promise.all(Object.entries(LOOKUP_SOULS).map(async ([id, soul]) => [id, (await readFile(join(ROOT, "scripts/fixtures", soul.file))).length])));
  const perRole = {}, probeGroups = [];
  for (const role of LOOKUP_ROLES) {
    let probes = 0, initialTokens = 0;
    for (const corpus of workload.corpora) for (const trace of corpus.traces) {
      const shape = shapes.get(`${corpus.suite}/${trace.id}`);
      requireLookup(shape, "lookup_estimate_unknown_trace");
      const n = trace.probes.length * workload.repeats;
      const reference = LOOKUP_BUDGET.paths.filter(path => path.traceId === trace.id && path.arm === role.arm);
      const observed = Math.max(0, ...reference.map(path => Math.ceil(path.initialContextBytes / 3)));
      const measuredBound = Math.max(0, ...reference.map(path => path.initialTokens));
      const soulDelta = Math.max(0, Math.ceil((soulBytes[role.soul] - soulBytes.S0) / 3));
      // Frozen B2 clause: 270 bytes / 90 conservative tokens. These additions are
      // estimator allowances, not a remeasurement or change to the registered budget.
      const guidanceDelta = role.code === "Rpack" ? 90 : 0;
      const fallback = role.arm === "native-lookup" ? Math.max(150000, shape.full) : shape.cold + 12000;
      const initial = Math.max(observed, measuredBound, fallback) + soulDelta + guidanceDelta;
      probes += n; initialTokens += n * initial;
      probeGroups.push({ count: n, initialTokens: initial });
    }
    perRole[role.id] = { probes, initialTokens };
  }
  const totalProbes = Object.values(perRole).reduce((sum, row) => sum + row.probes, 0);
  const scenarios = [];
  for (const calls of [0, 2, LOOKUP_BUDGET.callBudget]) for (const bytes of [0, Math.floor(LOOKUP_BUDGET.byteBudget / 2), LOOKUP_BUDGET.byteBudget]) {
    if (calls === 0 && bytes > 0) continue;
    const rounds = calls + 1, histogram = new Map();
    for (const group of probeGroups) for (let round = 0; round < rounds; round++) {
      // Same conservative replay bound as referenceFeasibility: one token per
      // returned byte and rounds^2 * 300 assistant-history input across the probe.
      const input = group.initialTokens + (round === 0 ? 0 : bytes) + rounds * 300;
      histogram.set(input, (histogram.get(input) ?? 0) + group.count);
    }
    const inputCalls = [...histogram].sort(([a], [b]) => a - b).map(([inputTokens, count]) => ({ inputTokens, outputTokens: 300, count }));
    const inputTokens = inputCalls.reduce((sum, call) => sum + call.inputTokens * call.count, 0);
    const outputTokens = totalProbes * rounds * 300;
    scenarios.push({ lookupCallsPerProbe: calls, returnedBytesPerProbe: bytes, roundsPerProbe: rounds,
      totalLookupCalls: calls * totalProbes, totalReturnedBytes: bytes * totalProbes, inputTokens, outputTokens, inputCalls });
  }
  return { schema: "continuity-lookup-estimate-v1", executionKind: "offline-estimate", authorizedSpend: false,
    purpose: "Workload and sensitivity only; not power, significance, model benefit, an invoice guarantee or spending authorization",
    assumptions: { tokenHeuristic: "max(frozen observed context bytes/3, frozen initial bound, source shape); not a model tokenizer",
      packAllowanceTokens: 12000, nativeFloorTokens: 150000, rpackGuidanceAllowanceTokens: 90, soulDeltaTokens: Math.ceil((soulBytes.S1 - soulBytes.S0) / 3),
      outputTokensPerRound: 300, assistantHistoryInput: "rounds^2 * 300 across each probe",
      returnedBytes: "one token per returned byte; replay all returned bytes in every subsequent input round",
      cacheFractions: [0, 0.5, 0.9], prices: "local Pi catalog USD per million tokens; per-call tiers use total input including cache; absent/invalid rates stay unknown",
      excluded: ["provider minimums/fees", "reasoning/output variance beyond the 300-token scenario", "cache writes", "model-specific context feasibility", "scheduling and checkpoint replay wall time"] },
    latency: { ...LOOKUP_TIMING, sequentialProbeDeadlineEnvelopeMs: totalProbes * LOOKUP_TIMING.deadlineMs,
      limitation: "Configured limits, not measured latency or a completion promise; deadline, cleanup, turn and hard watchdog differ. No concurrency speedup assumed." },
    workload: { suites: workload.corpora.map(c => c.suite), repeats: workload.repeats, roles: perRole, probes: totalProbes,
      checkpoints: LOOKUP_ROLES.length * workload.corpora.reduce((sum, c) => sum + c.traces.length, 0) * workload.repeats,
      maxLookupCalls: totalProbes * LOOKUP_BUDGET.callBudget, maxReturnedBytes: totalProbes * LOOKUP_BUDGET.byteBudget },
    profiles: profiles.map(profile => {
      const price = prices[profile.model];
      const known = finitePrice(price?.input) && finitePrice(price?.output);
      return { ...profile, priceStatus: known ? "local-catalog-estimate" : "unknown_price", price: price ?? null,
        scenarios: scenarios.map(scenario => ({ ...scenario, costSensitivityUSD: [0, .5, .9].map(cacheFraction => {
          let total = 0, unknownCalls = 0, tieredCalls = 0;
          for (const call of scenario.inputCalls) {
            const cost = priceLookupCall(price, call.inputTokens, call.outputTokens, cacheFraction);
            if (cost.usd === null) unknownCalls += call.count; else total += cost.usd * call.count;
            if (cost.tierInputTokensAbove !== null) tieredCalls += call.count;
          }
          return { cacheFraction, usd: unknownCalls ? null : total, unknownCalls, tieredCalls };
        }) })) };
    }) };
}
/** A selected-reader catalog is mandatory for external numerical approval. */
export async function offlineCatalog(model, root = ROOT) {
  requireLookup(/^[a-z0-9-]+:[A-Za-z0-9._/-]+$/u.test(model ?? ""), "invalid_model_reference");
  const colon = model.indexOf(":"), provider = model.slice(0, colon), id = model.slice(colon + 1);
  let bytes;
  try { bytes = await readFile(join(root, "packages/turn/node_modules/@earendil-works/pi-ai/dist/providers/data", `${provider}.json`)); }
  catch { requireLookup(false, "lookup_catalog_missing"); }
  const entry = Object.values(JSON.parse(bytes)).flatMap(models => Object.values(models)).find(row => row?.id === id);
  requireLookup(entry, "lookup_catalog_model_missing");
  return { model, fileSha256: sha256(bytes), contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, cost: entry.cost };
}
// Catalog rates are decimal dollars, so ceil-to-cents must not round a binary
// accumulation error up into another cent. This envelope has one rate per call.
function reservationEnvelope(price, input, output, trials) {
  const threshold = priceLookupCall(price, input, output, 0).tierInputTokensAbove;
  const rates = threshold === null ? price : price.tiers.find(t => t.inputTokensAbove === threshold);
  const fraction = value => {
    const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
    const [whole, decimals = ""] = mantissa.split("."), shift = Number(exponent) - decimals.length;
    const n = BigInt(whole + decimals);
    return shift >= 0 ? { n: n * 10n ** BigInt(shift), d: 1n } : { n, d: 10n ** BigInt(-shift) };
  };
  const a = fraction(rates.input), b = fraction(rates.output), scale = a.d > b.d ? a.d : b.d;
  const n = (a.n * (scale / a.d) * BigInt(input) + b.n * (scale / b.d) * BigInt(output)) * BigInt(trials) * 10n;
  const d = scale * 1000000n, cents = (n * 125n + d - 1n) / d;
  const usd = Number(n) / Number(d);
  requireLookup(Number.isFinite(usd) && Number.isSafeInteger(Number(cents)), "lookup_catalog_envelope_unrepresentable");
  return { usd, capUSD: Number(cents) / 100 };
}
export function estimateExternalLookup({ workload, catalog, outputLimit = workload.outputLimit }) {
  requireLookup(workload.lookupSource && workload.policy && workload.repeats === 1, "lookup_external_policy_required");
  assertExternalPolicy(workload.policy, { source: workload.corpora[0].source, selection: workload.corpora.flatMap(c => c.traces), lookupSelection: workload.lookupSelection });
  requireLookup(catalog?.model === workload.reader.model && /^[a-f0-9]{64}$/u.test(catalog.fileSha256 ?? ""), "lookup_catalog_binding_mismatch");
  const positive = n => Number.isSafeInteger(n) && n > 0;
  requireLookup(positive(catalog.contextWindow) && positive(catalog.maxTokens) && catalog.maxTokens <= catalog.contextWindow, "lookup_catalog_limits_missing");
  const price = catalog.cost;
  requireLookup(price && (price.tiers === undefined || Array.isArray(price.tiers)), "lookup_catalog_rates_missing");
  requireLookup(price && [price, ...(price.tiers ?? [])].every(rate => [rate.input, rate.output, rate.cacheRead].every(finitePrice))
    && (price.tiers === undefined || Array.isArray(price.tiers) && price.tiers.every(t => finitePrice(t.inputTokensAbove))
      && new Set(price.tiers.map(t => t.inputTokensAbove)).size === price.tiers.length), "lookup_catalog_rates_missing");
  requireLookup(positive(outputLimit?.tokens) && ["enforced", "catalog_max"].includes(outputLimit.source)
    && outputLimit.tokens <= catalog.maxTokens && (outputLimit.source !== "catalog_max" || outputLimit.tokens === catalog.maxTokens), "lookup_output_limit_required");
  const paths = workload.policy.budget.paths;
  const selection = workload.corpora.flatMap(c => c.traces);
  // Revalidate complete slot coverage rather than silently dropping unknown slots.
  const keys = LOOKUP_ROLES.flatMap(r => selection.flatMap(t => t.probes.map(p => `${r.id}/${t.id}/${p}`))).sort();
  requireLookup(digest(keys) === digest(paths.map(p => `${p.role}/${p.traceId}/${p.probeId}`).sort()), "lookup_inventory_scope_mismatch");
  requireLookup(paths.every(p => ["feasible", "budget-infeasible"].includes(p.feasibility?.classification)), "lookup_inventory_unknown");
  const roles = Object.fromEntries(LOOKUP_ROLES.map(r => [r.id, { planned: 0, eligible: 0, skipped: 0, expectedUSD: 0, reservationUSD: 0, expectedLookupOverheadUSD: 0 }]));
  const trials = [];
  for (const p of paths) {
    const row = roles[p.role]; row.planned++;
    if (p.feasibility.classification === "budget-infeasible") {
      row.skipped++; trials.push({ role: p.role, traceId: p.traceId, probeId: p.probeId, eligible: false, expectedUSD: 0, reservationUSD: 0 }); continue;
    }
    requireLookup(positive(p.initialTokens) && p.initialTokens + workload.policy.budget.byteBudget + 3000 + workload.policy.budget.contextMarginTokens <= catalog.contextWindow, "lookup_catalog_context_incompatible");
    row.eligible++;
    const S = LOOKUP_EXPECTED_SCENARIO, first = p.initialTokens + S.inputAllowanceTokens, cached = S.cachedInput.numerator / S.cachedInput.denominator;
    const calls = [first, ...Array(S.requestsPerSlot - 1).fill(first + S.laterInputIncrementTokens)];
    requireLookup(calls.every(input => input <= catalog.contextWindow), "lookup_catalog_context_incompatible");
    const expectedCalls = calls.map(input => priceLookupCall(price, input, Math.min(S.outputTokensPerRequest, outputLimit.tokens), cached));
    const expectedUSD = expectedCalls.reduce((sum, call) => sum + call.usd, 0);
    // Ten rounds, no cache. Full catalog context on EVERY round bounds all replay,
    // tool schemas, reasoning history and wrappers without assuming output=300.
    const reservedCall = priceLookupCall(price, catalog.contextWindow, outputLimit.tokens, 0);
    const reservationUSD = 10 * reservedCall.usd;
    const baseline = expectedCalls[0].usd;
    row.expectedUSD += expectedUSD; row.reservationUSD += reservationUSD; row.expectedLookupOverheadUSD += expectedUSD - baseline;
    trials.push({ role: p.role, traceId: p.traceId, probeId: p.probeId, eligible: true, expectedUSD, reservationUSD,
      expectedLookupOverheadUSD: expectedUSD - baseline, expectedTieredCalls: expectedCalls.filter(c => c.tierInputTokensAbove !== null).length,
      reservationTieredCalls: reservedCall.tierInputTokensAbove === null ? 0 : 10 });
  }
  // Compensated sums avoid inventing an extra cap cent from repeated float
  // additions (for example 64 * 18.24 catalog dollars).
  const sum = values => {
    let total = 0, correction = 0;
    for (const value of values) { const y = value - correction, next = total + y; correction = (next - total) - y; total = next; }
    return total;
  };
  for (const [id, role] of Object.entries(roles)) for (const key of ["expectedUSD", "reservationUSD", "expectedLookupOverheadUSD"])
    role[key] = sum(trials.filter(t => t.role === id).map(t => t[key] ?? 0));
  const total = key => sum(Object.values(roles).map(r => r[key]));
  for (const role of Object.values(roles)) role.reservationUSD = reservationEnvelope(price, catalog.contextWindow, outputLimit.tokens, role.eligible).usd;
  for (const trial of trials) if (trial.eligible) trial.reservationUSD = reservationEnvelope(price, catalog.contextWindow, outputLimit.tokens, 1).usd;
  const expectedUSD = total("expectedUSD");
  const envelope = reservationEnvelope(price, catalog.contextWindow, outputLimit.tokens, total("eligible"));
  const reservationUSD = envelope.usd, catalogCapUSD = envelope.capUSD;
  return { schema: "continuity-lookup-estimate-v2", executionKind: "offline-estimate", authorizedSpend: false,
    planned: paths.length, eligible: total("eligible"), skipped: total("skipped"), roles, trials, catalog, outputLimit,
    expectedUSD, worstUSD: reservationUSD, reservationUSD, catalogCapUSD, capOverExpected: expectedUSD > 0 ? catalogCapUSD / expectedUSD : null,
    expectedLookupOverheadUSD: total("expectedLookupOverheadUSD"),
    tokenEnvelope: { roundsPerEligibleTrial: 10, inputTokensPerCall: catalog.contextWindow, outputTokensPerCall: outputLimit.tokens,
      totalInputTokens: total("eligible") * 10 * catalog.contextWindow, totalOutputTokens: total("eligible") * 10 * outputLimit.tokens },
    assumptions: { expected: "pilot-calibrated-v1: four requests (three lookups), first request initialTokens + 900, each later request +9216 input tokens, 19/32 cached input, up to 150 output tokens/request; scenario, not measurement",
      expectedScenario: LOOKUP_EXPECTED_SCENARIO,
      reservation: "10 rounds, no cache, full catalog context per call including replay, explicit outputLimit",
      cap: "ceil-to-cents(1.25 * sum eligible reservations); run-wide, not per shard",
      ignoredTransport: ["repeats", "shardCostCapUSD", "legacy statistical gates"],
      quota: "catalog-equivalent dollars do not predict subscription quota or invoices; no spending authority",
      output: outputLimit.source === "enforced" ? "execution enforcement must be proved separately" : "catalog maximum, not a lower enforceable transport limit" } };
}
const HELP = `continuity-lookup-estimate [--registration FILE --sha256 FILE_SHA256 | workload options]
  [--suites original,hard,hard-distractors|holdout] [--traces ID,...] [--probe-limit N] [--repeats N]
  External: --corpus-manifest FILE --manifest-sha256 SHA --statistical-spec FILE --selection-seed N [--per-group 2]
    --lookup-policy FILE --lookup-policy-sha256 SHA --output-limit N --output-limit-source enforced|catalog_max
  [--opus-model REF] (default fixed sensitivity profile anthropic:claude-opus-5-5)
Offline only: local catalog prices, no providers, builds, credentials or spending authorization.`;
export async function main(argv = process.argv.slice(2), { stdout = console.log } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { stdout(HELP); return 0; }
  const flags = parseLookupOptions(argv, ["--registration", "--sha256", "--opus-model", ...WORKLOAD_FLAGS]);
  requireLookup(!flags["--registration"] || !WORKLOAD_FLAGS.some(flag => flags[flag] !== undefined), "lookup_estimate_workload_conflict");
  requireLookup(Boolean(flags["--registration"]) === Boolean(flags["--sha256"]), "lookup_registration_hash_required");
  let registration = null, pilot = null;
  if (flags["--registration"]) {
    requireLookup(/^[a-f0-9]{64}$/u.test(flags["--sha256"] ?? ""), "lookup_registration_hash_required");
    const bytes = await readFile(flags["--registration"]);
    requireLookup(sha256(bytes) === flags["--sha256"], "lookup_registration_hash_mismatch");
    const artifact = JSON.parse(bytes);
    requireLookup(artifact && typeof artifact === "object", "incompatible_lookup_registration");
    if (artifact.schema === "continuity-lookup-pilot-registration-v1") {
      const { validateLookupPilotRegistration } = await import("./lib/continuity-lookup-pilot.mjs");
      pilot = await validateLookupPilotRegistration(JSON.parse(bytes)); registration = pilot.registration;
    } else registration = await readRegistration(flags["--registration"], flags["--sha256"]);
  }
  const workload = registration?.common ?? await lookupWorkload(workloadOptions(flags));
  const profiles = ESTIMATE_PROFILES.map(profile => profile.id === "opus" && flags["--opus-model"] ? { ...profile, model: flags["--opus-model"] } : profile);
  const prices = await offlinePrices(profiles);
  const result = pilot ? (await import("./lib/continuity-lookup-pilot.mjs")).estimateLookupPilot({ workload, catalog: workload.catalog, capUSD: pilot.descriptor.capUSD })
    : workload.lookupSource ? estimateExternalLookup({ workload, catalog: await offlineCatalog(workload.reader.model) })
    : await estimateLookup({ workload, profiles, prices });
  if (!pilot && workload.lookupSource && workload.catalogCapUSD !== undefined) requireLookup(result.catalogCapUSD === workload.catalogCapUSD, "lookup_catalog_cap_mismatch");
  result.workloadDigest = digest(workload);
  result.registrationDigest = registration ? digest(pilot ?? registration) : null;
  result.pricingSource = { source: "installed local Pi catalog (offline)", lockfileSha256: sha256(await readFile(join(ROOT, "pnpm-lock.yaml"))) };
  stdout(JSON.stringify(result, null, 2)); return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`continuity-lookup-estimate: ${typeof error?.code === "string" ? error.code : "failed"}`); process.exitCode = 1; });
}
