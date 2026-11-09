// Controller preparation policy; all journal, lease, IPC and consumption mechanics are shared.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { digest } from "./continuity-dataset.mjs";
import { ROOT } from "./continuity-observation-input.mjs";
import { E2_FAUX_AUTHORIZATION, E2_REGISTRATION_SCHEMA, E2_PLAN_SCHEMA, E2_ASSUMPTIONS, E2_FAUX_CONTROLLER, E2_REAL_CONTROLLER, E2_INPUT_LIMITS, E2_ARTIFACT_LIMITS } from "./continuity-e2-policy.mjs";
const need = (ok, code = "e2_pilot_faux_required") => { if (!ok) throw Object.assign(Error(code), { code }); };
const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
export const e2CacheKey = key => typeof key === "string" && /^[\x21-\x7e]{1,64}$/u.test(key);
export const e2CacheIssuer = runId => { need(typeof runId === "string" && /^[A-Za-z0-9-]{1,36}$/u.test(runId), "e2_cache_assignment_invalid"); return `e2-${runId}-${randomBytes(12).toString("hex")}`; };
export function e2CacheAssignment(state, a) {
  const keys = state.slots.map(s => s.cacheKey);
  need(state.cacheKeysUnique === true && keys.every(e2CacheKey) && new Set(keys).size === keys.length && Number.isSafeInteger(a.index)
    && a.index >= 0 && keys[a.index] === a.cacheKey, "e2_cache_assignment_invalid");
}
export function e2Watchdog(authorization, deadlines, deadlineAt, now = Date.now()) {
  const requested = authorization.timeoutMs ?? deadlines.childWatchdogMs;
  const valid = n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
  need([requested, deadlines.childWatchdogMs, deadlines.deadlineMs].every(valid) && requested <= deadlines.childWatchdogMs && Number.isSafeInteger(deadlineAt) && Number.isSafeInteger(now), "e2_ipc_invalid");
  return Math.min(requested, deadlines.deadlineMs, Math.max(1, deadlineAt - now));
}
export const e2ValidTimeout = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
export const e2Work = a => join(a.outputRoot, "work", "phases", a.slotId);
export function e2PhaseAssignment(a, state) {
  need([E2_FAUX_CONTROLLER, E2_REAL_CONTROLLER].includes(state.schema) && a.pilot.registration.code.path === ROOT
    && same(state.schedule[a.index], a.slot) && state.slots[a.index]?.slotId === a.slotId && !state.slots[a.index].preparation, "e2_preparation_invalid");
}
export async function prepareE2Controller(options) {
  // Native phase adapters are not yet installed. Never burn real authority in this slice.
  if (options.real !== false) throw Object.assign(Error("e2_pilot_real_route_unavailable"), { code: "e2_pilot_real_route_unavailable" });
  const { pilot, authorization, outputRoot } = options;
  need(Object.keys(options).sort().join() === "authorization,outputRoot,pilot,real" && pilot?.schema === E2_REGISTRATION_SCHEMA
    && pilot.descriptor.schema === E2_PLAN_SCHEMA && same(pilot.descriptor.assumptions, E2_ASSUMPTIONS) && pilot.registration.code.path === ROOT
    && authorization?.schema === E2_FAUX_AUTHORIZATION && authorization.outputRoot === outputRoot);
  const [{ loadE2Catalog, e2RequestPrice }, { e2CapUnits, validateE2Deadlines }, { externalDirectory }] = await Promise.all([
    import("./continuity-e2-pricing.mjs"), import("./continuity-e2-registration.mjs"), import("./continuity-holdout-files.mjs"),
  ]);
  e2CapUnits(pilot.descriptor.capUnits); validateE2Deadlines(pilot.descriptor.deadlines);
  need(same(pilot.registration.catalog, await loadE2Catalog()));
  for (const r of pilot.registration.roles) e2RequestPrice(pilot.registration.catalog.find(c => c.model === r.model), { inputTokens: r.maxInputTokens, maxOutputTokens: r.maxOutputTokens });
  const schedule = pilot.registration.schedule;
  need(Array.isArray(schedule) && schedule.length > 0 && schedule.length <= E2_INPUT_LIMITS.phases
    && schedule.every(s => /^[a-f0-9]{64}$/u.test(s?.slotId) && s.eligible === true && Array.isArray(s.budgets) && s.budgets.length > 0
      && s.budgets.every(b => Number.isSafeInteger(b?.maxRequests) && b.maxRequests > 0 && b.maxRequests <= E2_ARTIFACT_LIMITS.requests))
    && new Set(schedule.map(s => s.slotId)).size === schedule.length, "e2_registration_invalid");
  need(await externalDirectory(outputRoot) === outputRoot);
  return { pilot, authorization, outputRoot, real: false, authorizationHandle: null, schedule };
}
export async function e2ControllerBindings() {
  const [{ guardedState }, { guardedLease }, { guardedChildEnvironment }, { guardedAuthorization }] = await Promise.all([
    import("./continuity-guarded-state.mjs"), import("./continuity-guarded-lease.mjs"), import("./continuity-guarded-child-environment.mjs"), import("./continuity-guarded-authorization.mjs"),
  ]);
  return { readPrivate: guardedState("e2-validation").readPrivate, acquireLease: guardedLease("e2-validation").acquireLease,
    assertLease: guardedLease("e2-validation").assertLease, childEnvironment: guardedChildEnvironment("e2-validation").childEnvironment,
    consumeAuthorization: guardedAuthorization("e2-validation").consumeAuthorization };
}
