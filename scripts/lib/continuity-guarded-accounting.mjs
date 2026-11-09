// Shared guarded-run mechanics; policy is selected only by a closed protocol id.

import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
const instances = new Map();
export function guardedAccounting(id) {
  const protocol = guardedProtocol(id);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, id));
  return instances.get(protocol);
}
function bind(protocol, id) {
  const outcomeCodes = Object.freeze({ settled: [null], lost: [null], own_abort_after_send: [null], integrity_stop: protocol.policy.INTEGRITY_STOPS });
  function need(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
  const fixedCode = code => protocol.policy.PILOT_STOPS.includes(code) ? code : protocol.codes.ipc_invalid;
  function money(value) {
    need(typeof value === "number" && Number.isFinite(value) && value >= 0, "unpriced_reservation");
    const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e"), [whole, fraction = ""] = mantissa.split(".");
    const shift = Number(exponent) - fraction.length;
    let n = BigInt(whole + fraction) * protocol.policy.USD_UNITS, d = 1n;
    if (shift >= 0) n *= 10n ** BigInt(shift); else d = 10n ** BigInt(-shift);
    need(n % d === 0n, "unpriced_reservation"); return n / d;
  }
  const dollars = units => Number(BigInt(units)) / Number(protocol.policy.USD_UNITS);
  const count = n => Number.isSafeInteger(n) && n >= 0;
  const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k));
  function priceUsage(raw, tier) {
    need(keys(raw, ["input_tokens", "output_tokens", "input_tokens_details", "output_tokens_details"])
      && count(raw.input_tokens) && count(raw.output_tokens), protocol.codes.invalid_usage);
    const input = raw.input_tokens_details ?? {}, output = raw.output_tokens_details ?? {};
    need(keys(input, ["cached_tokens", "cache_write_tokens"]) && keys(output, ["reasoning_tokens"])
      && [input.cached_tokens ?? 0, input.cache_write_tokens ?? 0, output.reasoning_tokens ?? 0].every(count), protocol.codes.invalid_usage);
    const cached = BigInt(input.cached_tokens ?? 0), written = BigInt(input.cache_write_tokens ?? 0), tokens = BigInt(raw.input_tokens);
    const invalid = raw.input_tokens < 1 || cached + written > tokens || (output.reasoning_tokens ?? 0) > raw.output_tokens;
    const uncached = tokens > cached + written ? tokens - cached - written : 0n;
    const units = (uncached * protocol.pricing.input + cached * protocol.pricing.cacheRead + written * protocol.pricing.cacheWrite + BigInt(raw.output_tokens) * protocol.pricing.output)
      * (tier === "flex" ? protocol.pricing.flex : tier === "default" ? protocol.pricing.normal : protocol.pricing.maximum);
    return { invalid, units: units.toString(), rawUsage: structuredClone(raw), tier: ["default", "flex", "priority"].includes(tier) ? tier : null,
      sharedCost: invalid ? dollars(units) : settledCost(raw, tier) };
  }
  function settleHold(hold, outcome, raw, tier) {
    need(keys(outcome, ["kind", "code", "cost"]) && Object.hasOwn(protocol.policy.OUTCOMES, outcome.kind), protocol.codes.permit_invalid);
    // A pre-admission refusal has no permit and cannot erase an admitted hold.
    need(outcome.kind !== "refused_pre_send", protocol.codes.permit_invalid);
    need(outcomeCodes[outcome.kind]?.includes(outcome.code ?? null), protocol.codes.ipc_invalid);
    need(outcome.kind !== "own_abort_after_send" || hold.consumed, protocol.codes.permit_invalid);
    const priced = raw === null ? null : priceUsage(raw, tier);
    need(tier == null || ["default", "flex", "priority"].includes(tier), protocol.codes.unknown_tier);
    need(!priced?.invalid || outcome.kind === "integrity_stop", protocol.codes.invalid_usage);
    need(outcome.cost === undefined || priced && !priced.invalid && outcome.cost === priced.sharedCost, protocol.codes.hold_exceeded);
    need(outcome.kind !== "settled" || priced && hold.consumed, protocol.codes.permit_invalid);
    return { ...hold, settlement: { kind: outcome.kind, code: outcome.code ?? null, rawUsage: priced?.rawUsage ?? null,
      tier: priced?.tier ?? null, knownUnits: priced?.units ?? "0" } };
  }
  function accountRun(slots) {
    let complete = 0n, retained = 0n, active = 0n, partial = 0n, admitted = 0, invalid = 0, incomplete = 0, completed = 0, losses = 0;
    for (const slot of slots) {
      const holds = slot.holds ?? [];
      if (!holds.length) continue;
      admitted++;
      for (const hold of holds) {
        const s = hold.settlement, reserve = BigInt(hold.reservedUnits), known = BigInt(s?.knownUnits ?? "0");
        partial += known;
        if (s?.kind === "settled") complete += known;
        else if (s || slot.terminal || hold.revoked) retained += reserve > known ? reserve : known;
        else active += reserve;
      }
      if (!slot.terminal) continue;
      if (["lost", "own_abort_after_send", "refused_pre_send"].includes(slot.terminal)) incomplete++;
      else if (["completed", "wrong"].includes(slot.terminal)) completed++;
      else invalid++;
      if (slot.terminal === "lost") losses++;
      else if (slot.terminal !== "own_abort_after_send") losses = 0;
    }
    return { completeUnits: complete.toString(), retainedUnits: retained.toString(), activeUnits: active.toString(),
      knownPartialUnits: partial.toString(), totalUnits: (complete + retained + active).toString(),
      admitted, invalid, incomplete, completed, consecutiveProviderLosses: losses };
  }
  function stopReason(spend, capUnits, nextUnits = "0") {
    if (spend.consecutiveProviderLosses >= protocol.lossLimit) return protocol.codes.repeated_loss;
    if (spend.invalid * protocol.invalidRateDenominator > spend.admitted) return "invalid_unit_rate";
    if (BigInt(spend.totalUnits) + BigInt(nextUnits) > BigInt(capUnits)) return "budget_admission";
    return null;
  }
  function settledCost(usage, tier) {
    const cached = usage.input_tokens_details?.cached_tokens ?? 0, written = usage.input_tokens_details?.cache_write_tokens ?? 0;
    // Accumulate integer tenths-of-a-microdollar; return floating-point dollars.
    const p = protocol.pricing;
    const cachedRead = p.cacheRead === 1n ? cached : cached * Number(p.cacheRead);
    const tenths = (usage.input_tokens - cached - written) * Number(p.input) + cachedRead + written * Number(p.cacheWrite) + usage.output_tokens * Number(p.output);
    return tenths * (tier === "flex" ? 0.5 : tier === "default" ? 1 : 2) / protocol.pricing.floatUnits;
  }
  return Object.freeze({ need, fixedCode, money, dollars, priceUsage, settleHold, accountRun, stopReason, settledCost });
}
