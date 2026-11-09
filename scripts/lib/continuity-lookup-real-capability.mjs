// Lookup API adapter; no duplicated guarded-run mechanics.
import { guardedRealCapability } from "./continuity-guarded-real-capability.mjs";
import { LOOKUP_PILOT_MEASURED_ROLES } from "./continuity-lookup.mjs";
import process from "node:process";
import { assertLookupPilotEntry } from "./continuity-lookup-pilot-entry.mjs";
const fail = (code = "lookup_pilot_capability_invalid") => { throw Object.assign(new Error(code), { code }); };
const need = ok => { if (!ok) fail(); };
export async function verifyLookupRealAssignment(a, ready = true) {
  assertLookupPilotEntry();
  if (Object.hasOwn(process.env, "CI")) fail("paid_mode_refused_in_ci");
  if (Object.hasOwn(process.env, "CONTINUITY_DEBUG")) fail("lookup_debug_forbidden");
  try { return await verifyAssignment(a, ready); } catch (error) { fail(["lookup_preparation_invalid", "lookup_pilot_role_not_measured"].includes(error.code) ? error.code : undefined); }
}
async function verifyAssignment(a, ready) {
  need(!Object.hasOwn(process.env, "CI") && !Object.hasOwn(process.env, "CONTINUITY_DEBUG"));
  const [{ ROOT, verifyRoleRequest, roleBinding }, { validateLookupPilotRegistration }, auth, stateModule, identity, runtime] = await Promise.all([
    import("./continuity-lookup-roles.mjs"), import("./continuity-lookup-pilot.mjs"), import("./continuity-lookup-authorization.mjs"),
    import("./continuity-lookup-pilot-state.mjs"), import("./continuity-process-identity.mjs"), import("./continuity-lookup-pilot-runtime.mjs"),
  ]);
  need(a?.authorization?.schema === auth.LOOKUP_AUTHORIZATION_SCHEMA && a.recovery !== true && process.connected);
  await validateLookupPilotRegistration(a.pilot);
  const { digest } = await import("./continuity-dataset.mjs"), registration = a.pilot.registration;
  const role = registration.roles.find(r => r.id === a.slot.roleId), corpus = registration.common.corpora.find(c => c.suite === a.slot.suite);
  if (role && !LOOKUP_PILOT_MEASURED_ROLES.includes(role.id)) fail("lookup_pilot_role_not_measured");
  need(role && corpus && ROOT === registration.codes[a.slot.code]?.path
    && stateModule.samePilot(a.roleRequest.binding, roleBinding(registration, role, corpus))
    && stateModule.samePilot(a.roleRequest.common, registration.common)
    && stateModule.samePilot(a.roleRequest.build, registration.codes[a.slot.code].build));
  await verifyRoleRequest(ROOT, a.roleRequest, a.plan);
  const state = await stateModule.readPilotPrivate(stateModule.pilotStatePath(a.outputRoot)), slot = state.slots[a.index];
  runtime.assertLookupCacheAssignment(state, a);
  need(state.schema === stateModule.LOOKUP_REAL_CONTROLLER && state.recovery === false && state.stop === null
    && state.binding === digest(a.pilot)
    && state.cursor === a.index && slot.terminal === null
    && typeof state.controller.startIdentity === "string" && state.controller.startIdentity.length > 0
    && typeof slot.worker?.startIdentity === "string" && slot.worker.startIdentity.length > 0
    && state.runId === a.runId && state.epoch === a.epoch && state.controller.pid === process.ppid
    && identity.lookupProcessStartIdentity(process.ppid) === state.controller.startIdentity
    && slot?.worker?.pid === process.pid && slot.worker.startIdentity === identity.lookupProcessStartIdentity(process.pid)
    && slot.slotId === a.slotId && stateModule.samePilot(state.schedule, stateModule.lookupPilotSchedule(a.pilot))
    && stateModule.samePilot(state.schedule[a.index], a.slot) && a.slot.roleId === a.roleRequest.binding.id
    && a.slot.code === a.roleRequest.binding.code && (!ready || slot.ready === true));
  await (await import("./continuity-lookup-preparation.mjs")).verifyLookupPreparation(a, state, ready);
  const handle = await auth.validateLookupAuthorization({ ...a.authorization, outputRoot: a.outputRoot });
  need(auth.lookupAuthorizationBindsPilot(handle, a.pilot));
  await auth.verifyLookupConsumption(handle, { runId: state.runId, controllerEpoch: state.epoch, controller: state.controller });
  return { state, handle };
}
export const isRealLookupSend = (send) => guardedRealCapability("lookup-pilot").isRealLookupSend(send);
export const realLookupSendForGuard = (send, permit, contract) => guardedRealCapability("lookup-pilot").realLookupSendForGuard(send, permit, contract);
export const isRealLookupDecorator = (decorator) => guardedRealCapability("lookup-pilot").isRealLookupDecorator(decorator);
export const realLookupSendBinds = (send, profile) => guardedRealCapability("lookup-pilot").realLookupSendBinds(send, profile);
export async function createLookupRealSend(a, resolvedSafety) { return guardedRealCapability("lookup-pilot").createLookupRealSend(a, resolvedSafety); }
