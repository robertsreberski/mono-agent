// Lookup API adapter. All guarded mechanics live in the protocol-neutral core.
import { guardedAccounting } from "./continuity-guarded-accounting.mjs";
export { LOOKUP_PILOT_STOPS, LOOKUP_GUARD_STOPS, LOOKUP_INTEGRITY_STOPS, LOOKUP_SLOT_TERMINALS, USD_UNITS } from "./continuity-lookup-guarded-policy.mjs";
export function pilotNeed(ok, code) { return guardedAccounting("lookup-pilot").need(ok, code); }
export const fixedPilotCode = (code) => guardedAccounting("lookup-pilot").fixedCode(code);
export function lookupMoney(value) { return guardedAccounting("lookup-pilot").money(value); }
export const lookupDollars = (units) => guardedAccounting("lookup-pilot").dollars(units);
export function priceLookupUsage(raw, tier) { return guardedAccounting("lookup-pilot").priceUsage(raw, tier); }
export function settleLookupHold(hold, outcome, raw, tier) { return guardedAccounting("lookup-pilot").settleHold(hold, outcome, raw, tier); }
export function accountLookupPilot(slots) { return guardedAccounting("lookup-pilot").accountRun(slots); }
export function lookupPilotStopReason(spend, capUnits, nextUnits = "0") { return guardedAccounting("lookup-pilot").stopReason(spend, capUnits, nextUnits); }
