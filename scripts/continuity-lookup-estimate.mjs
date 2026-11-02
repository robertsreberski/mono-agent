#!/usr/bin/env node
// Sensitivity arithmetic, not execution or spending authority. No network/provider imports.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { digest, loadTraces, traceTokenShape } from "./lib/continuity-dataset.mjs";
import { LOOKUP_BUDGET, LOOKUP_TIMING, LOOKUP_ROLES, LOOKUP_SOULS, sha256 } from "./lib/continuity-lookup.mjs";
import { ROOT, lookupWorkload, readRegistration, requireLookup } from "./lib/continuity-lookup-roles.mjs";
import { parseLookupOptions, workloadOptions, WORKLOAD_FLAGS } from "./continuity-lookup-compare.mjs";

export const ESTIMATE_PROFILES = Object.freeze([
  { id: "sol", model: "openai-codex:gpt-6.1-sol", purpose: "first qualification profile; not authorized by this estimate" },
  { id: "luna", model: "openai-codex:gpt-6-luna", purpose: "development screening only" },
  { id: "opus", model: "anthropic:claude-opus-5-5", purpose: "separate sensitivity; never pooled with Sol" },
].map(Object.freeze));
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
const HELP = `continuity-lookup-estimate [--registration FILE --sha256 FILE_SHA256 | workload options]
  [--suites original,hard,hard-distractors] [--traces ID,...] [--probe-limit N] [--repeats N]
  [--opus-model REF] (default fixed sensitivity profile anthropic:claude-opus-5-5)
Offline only: local catalog prices, no providers, builds, credentials or spending authorization.`;
export async function main(argv = process.argv.slice(2), { stdout = console.log } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { stdout(HELP); return 0; }
  const flags = parseLookupOptions(argv, ["--registration", "--sha256", "--opus-model", ...WORKLOAD_FLAGS]);
  requireLookup(!flags["--registration"] || !WORKLOAD_FLAGS.some(flag => flags[flag]), "lookup_estimate_workload_conflict");
  requireLookup(Boolean(flags["--registration"]) === Boolean(flags["--sha256"]), "lookup_registration_hash_required");
  const registration = flags["--registration"] ? await readRegistration(flags["--registration"], flags["--sha256"]) : null;
  const workload = registration?.common ?? await lookupWorkload(workloadOptions(flags));
  const profiles = ESTIMATE_PROFILES.map(profile => profile.id === "opus" && flags["--opus-model"] ? { ...profile, model: flags["--opus-model"] } : profile);
  const prices = await offlinePrices(profiles);
  const result = await estimateLookup({ workload, profiles, prices });
  result.workloadDigest = digest(workload);
  result.registrationDigest = registration ? digest(registration) : null;
  result.pricingSource = { source: "installed local Pi catalog (offline)", lockfileSha256: sha256(await readFile(join(ROOT, "pnpm-lock.yaml"))) };
  stdout(JSON.stringify(result, null, 2)); return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`continuity-lookup-estimate: ${typeof error?.code === "string" ? error.code : "failed"}`); process.exitCode = 1; });
}
