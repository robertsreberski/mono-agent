// Source-owned E2 assignment/safety adapters. No transport and no credential refresh.
import { env } from "node:process";
import { digest } from "./continuity-dataset.mjs";
import { ROOT } from "./continuity-observation-input.mjs";
import { guardedState } from "./continuity-guarded-state.mjs";
import { guardedLease } from "./continuity-guarded-lease.mjs";
import { guardedModels } from "./continuity-guarded-models.mjs";
import { guardedRealCapability } from "./continuity-guarded-real-capability.mjs";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { e2CacheAssignment } from "./continuity-e2-controller-policy.mjs";
import { E2_AUTHORIZATION_SCHEMA, E2_REAL_CONTROLLER } from "./continuity-e2-policy.mjs";
const need = (ok, code = "e2_pilot_capability_invalid") => { if (!ok) throw Object.assign(Error(code), { code }); };
const same = (a, b) => digest(a ?? null) === digest(b ?? null), controls = new WeakMap(), adapters = new WeakSet();
export const e2RuntimePlan = pilot => ({ schema: "continuity-e2-runtime-plan-v1", registrationSha256: digest(pilot) });
export const e2RoleRequest = (pilot, binding) => ({ schema: "continuity-e2-role-request-v1", binding, build: pilot.registration.build });
export function e2SlotRequest(pilot, slot) {
  return { code: pilot.registration.code, binding: { id: slot.roleId, code: slot.code, arm: "e2-validation" }, plan: e2RuntimePlan(pilot) };
}
export function assertE2Entry() {
  need(!Object.hasOwn(env, "CI"), "paid_mode_refused_in_ci"); need(!Object.hasOwn(env, "CONTINUITY_DEBUG"), "e2_debug_forbidden");
}
export async function verifyE2Assignment(a, ready = true) {
  assertE2Entry();
  const { guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");
  const auth = guardedAuthorization("e2-validation"), core = guardedState("e2-validation");
  need(a?.authorization?.schema === E2_AUTHORIZATION_SCHEMA && !a.recovery && process.connected && a.pilot?.registration?.code.path === ROOT);
  const { schema: _schema, ...args } = a.authorization;
  const handle = await auth.validate({ ...args, outputRoot: a.outputRoot });
  need(auth.bindsRegistration(handle, a.pilot), "e2_authorization_binding_mismatch");
  const state = await core.readPrivate(core.statePath(a.outputRoot)), slot = state.slots[a.index]; e2CacheAssignment(state, a);
  const expected = e2SlotRequest(a.pilot, a.slot);
  need(state.schema === E2_REAL_CONTROLLER && state.recovery === false && state.stop === null && state.binding === digest(a.pilot)
    && state.cursor === a.index && slot?.terminal === null && (!ready || slot.ready === true)
    && state.runId === a.runId && state.epoch === a.epoch && state.controller.pid === process.ppid
    && typeof state.controller.startIdentity === "string" && lookupProcessStartIdentity(process.ppid) === state.controller.startIdentity
    && slot.worker?.pid === process.pid && typeof slot.worker.startIdentity === "string" && lookupProcessStartIdentity(process.pid) === slot.worker.startIdentity
    && slot.slotId === a.slotId && same(state.schedule, a.pilot.registration.schedule) && same(state.schedule[a.index], a.slot)
    && same(a.plan, expected.plan) && same(a.roleRequest, e2RoleRequest(a.pilot, expected.binding)));
  await guardedLease("e2-validation").readLease(a.outputRoot, state.controller);
  await auth.verifyConsumption(handle, { runId: state.runId, controllerEpoch: state.epoch, controller: state.controller });
  return { state, handle };
}
export function assertE2Safety(value) { need(controls.has(value) && same(value.plan, controls.get(value).plan)); controls.get(value).actor.assertCurrentConfig(); }
export async function createE2PhaseAdapter(a) {
  await verifyE2Assignment(a);
  const plan = Object.freeze(e2RuntimePlan(a.pilot)), safety = Object.freeze({ plan, arm: Object.freeze({ id: "e2-validation" }) });
  const { createE2PaidModels } = await import("./continuity-e2-paid-models.mjs");
  const actor = await createE2PaidModels(a, safety); controls.set(safety, { actor, plan });
  const send = await guardedRealCapability("e2-validation").createLookupRealSend(a, safety);
  actor.attach(send); adapters.add(actor); return actor;
}
export function assertE2PhaseAdapter(actor) { need(adapters.has(actor)); }
export async function e2RealModules() {
  const { guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");
  const auth = guardedAuthorization("e2-validation"), models = guardedModels("e2-validation");
  return { assertRealPermitSource: models.assertRealLookupPermitSource, matchesAccount: auth.matchesAccountHandle,
    createIPC: async a => (await import("./continuity-guarded-ipc.mjs")).guardedIPC("e2-validation").createLookupPilotIPC(a),
    wrapModels(target, bindings) { assertE2Safety(bindings.resolvedSafety); return controls.get(bindings.resolvedSafety).actor.bind(target, bindings); } };
}
