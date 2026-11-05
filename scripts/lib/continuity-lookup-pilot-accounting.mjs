import { LOOKUP_OUTCOMES, LOOKUP_GUARD_POLICY_REFUSALS, lookupSettledCost } from "./continuity-lookup-guard.mjs";

export const LOOKUP_PILOT_STOPS = Object.freeze([...new Set([...LOOKUP_GUARD_POLICY_REFUSALS,
  "completed", "auth_failure", "lookup_auth_failure", "lookup_account_mismatch", "lookup_quota_exhausted",
  "unpriced_reservation", "invalid_unit_rate", "budget_admission", "lookup_run_deadline", "lookup_worker_timeout",
  "lookup_unreconciled_processes", "lookup_repeated_loss", "lookup_ipc_invalid", "lookup_ipc_disconnected",
  "lookup_preparation_invalid", "lookup_preparation_timeout", "lookup_persist_failed", "lookup_receipt_invalid", "lookup_arrival_persist_failed", "lookup_arrival_receipt_invalid", "lookup_worker_lost", "lookup_recovery_only",
  "lookup_invalid_usage", "lookup_unknown_tier", "lookup_hold_exceeded", "lookup_input_envelope_violated",
  "lookup_output_envelope_violated", "lookup_reasoning_envelope_violated", "lookup_body_mismatch",
  "lookup_permit_invalid", "lookup_settlement_failed", "lookup_stop_failed", "lookup_payload_repeated",
  "lookup_headers_forbidden", "lookup_prompt_cache_key_forbidden", "lookup_send_mismatch", "lookup_duplicate_terminal",
])]);
// Only guard-owned causes may cross the worker stop API; lifecycle/completion remain controller-owned.
export const LOOKUP_GUARD_STOPS = Object.freeze([...new Set([...LOOKUP_GUARD_POLICY_REFUSALS,
  "auth_failure", "lookup_auth_failure", "lookup_account_mismatch", "lookup_quota_exhausted", "lookup_settlement_failed",
  "lookup_invalid_usage", "lookup_unknown_tier", "lookup_hold_exceeded", "lookup_input_envelope_violated",
  "lookup_output_envelope_violated", "lookup_reasoning_envelope_violated", "lookup_body_mismatch", "lookup_permit_invalid",
  "lookup_arrival_persist_failed", "lookup_arrival_receipt_invalid", "lookup_payload_repeated", "lookup_headers_forbidden", "lookup_prompt_cache_key_forbidden", "lookup_send_mismatch", "lookup_duplicate_terminal",
])]);
export const LOOKUP_INTEGRITY_STOPS = Object.freeze(LOOKUP_GUARD_STOPS.filter(code => !["auth_failure", "lookup_auth_failure", "lookup_account_mismatch", "lookup_quota_exhausted"].includes(code)));
const outcomeCodes = Object.freeze({ settled: [null], lost: [null], own_abort_after_send: [null], integrity_stop: LOOKUP_INTEGRITY_STOPS });
export const LOOKUP_SLOT_TERMINALS = Object.freeze(["completed", "wrong", "lost", "own_abort_after_send", "pilot_empty_final_output", "store_degraded", "boundary_unverified", "pressure_unverified", "integrity_stop", "refused_pre_send", "unadmitted", "skipped"]);
export function pilotNeed(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
export const fixedPilotCode = code => LOOKUP_PILOT_STOPS.includes(code) ? code : "lookup_ipc_invalid";
export const USD_UNITS = 20000000n; // half of one tenth-microdollar; exact even for flex
export function lookupMoney(value) {
  pilotNeed(typeof value === "number" && Number.isFinite(value) && value >= 0, "unpriced_reservation");
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e"), [whole, fraction = ""] = mantissa.split(".");
  const shift = Number(exponent) - fraction.length;
  let n = BigInt(whole + fraction) * USD_UNITS, d = 1n;
  if (shift >= 0) n *= 10n ** BigInt(shift); else d = 10n ** BigInt(-shift);
  pilotNeed(n % d === 0n, "unpriced_reservation"); return n / d;
}
export const lookupDollars = units => Number(BigInt(units)) / Number(USD_UNITS);
const count = n => Number.isSafeInteger(n) && n >= 0;
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k));
/** Only numeric counters survive, including on integrity outcomes. No model event is retained. */
export function priceLookupUsage(raw, tier) {
  pilotNeed(keys(raw, ["input_tokens", "output_tokens", "input_tokens_details", "output_tokens_details"])
    && count(raw.input_tokens) && count(raw.output_tokens), "lookup_invalid_usage");
  const input = raw.input_tokens_details ?? {}, output = raw.output_tokens_details ?? {};
  pilotNeed(keys(input, ["cached_tokens", "cache_write_tokens"]) && keys(output, ["reasoning_tokens"])
    && [input.cached_tokens ?? 0, input.cache_write_tokens ?? 0, output.reasoning_tokens ?? 0].every(count), "lookup_invalid_usage");
  const cached = BigInt(input.cached_tokens ?? 0), written = BigInt(input.cache_write_tokens ?? 0), tokens = BigInt(raw.input_tokens);
  const invalid = raw.input_tokens < 1 || cached + written > tokens || (output.reasoning_tokens ?? 0) > raw.output_tokens;
  const uncached = tokens > cached + written ? tokens - cached - written : 0n;
  const units = (uncached * 20n + cached + written * 25n + BigInt(raw.output_tokens) * 100n)
    * (tier === "flex" ? 1n : tier === "default" ? 2n : 4n);
  return { invalid, units: units.toString(), rawUsage: structuredClone(raw), tier: ["default", "flex", "priority"].includes(tier) ? tier : null,
    sharedCost: invalid ? lookupDollars(units) : lookupSettledCost(raw, tier) };
}
export function settleLookupHold(hold, outcome, raw, tier) {
  pilotNeed(keys(outcome, ["kind", "code", "cost"]) && Object.hasOwn(LOOKUP_OUTCOMES, outcome.kind), "lookup_permit_invalid");
  // A pre-admission refusal has no permit and cannot erase an admitted hold.
  pilotNeed(outcome.kind !== "refused_pre_send", "lookup_permit_invalid");
  pilotNeed(outcomeCodes[outcome.kind]?.includes(outcome.code ?? null), "lookup_ipc_invalid");
  pilotNeed(outcome.kind !== "own_abort_after_send" || hold.consumed, "lookup_permit_invalid");
  const priced = raw === null ? null : priceLookupUsage(raw, tier);
  pilotNeed(tier == null || ["default", "flex", "priority"].includes(tier), "lookup_unknown_tier");
  pilotNeed(!priced?.invalid || outcome.kind === "integrity_stop", "lookup_invalid_usage");
  pilotNeed(outcome.cost === undefined || priced && !priced.invalid && outcome.cost === priced.sharedCost, "lookup_hold_exceeded");
  pilotNeed(outcome.kind !== "settled" || priced && hold.consumed, "lookup_permit_invalid");
  return { ...hold, settlement: { kind: outcome.kind, code: outcome.code ?? null, rawUsage: priced?.rawUsage ?? null,
    tier: priced?.tier ?? null, knownUnits: priced?.units ?? "0" } };
}
/** Each request belongs to exactly one category; never add a partial on top of its retained hold. */
export function accountLookupPilot(slots) {
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
export function lookupPilotStopReason(spend, capUnits, nextUnits = "0") {
  if (spend.consecutiveProviderLosses >= 2) return "lookup_repeated_loss";
  if (spend.invalid * 10 > spend.admitted) return "invalid_unit_rate";
  if (BigInt(spend.totalUnits) + BigInt(nextUnits) > BigInt(capUnits)) return "budget_admission";
  return null;
}
