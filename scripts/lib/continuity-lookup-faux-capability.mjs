import { lookupPilotWork, lookupBodyBytes, lookupForwardedObserver } from "./continuity-lookup-pilot-runtime.mjs";
import { createLookupPilotIPC, verifyLookupPilotParent } from "./continuity-lookup-ipc.mjs";
import { ROOT, verifyRoleRequest } from "./continuity-lookup-roles.mjs";
import { LOOKUP_FAUX_CONTROLLER, readPilotPrivate, pilotStatePath } from "./continuity-lookup-pilot-state.mjs";
import { verifyLookupPreparation } from "./continuity-lookup-preparation.mjs";
import { createFauxLookupDecorator, LOOKUP_GUARD_CONTRACT } from "./continuity-lookup-guard.mjs";
// Lookup API adapter; no duplicated guarded-run mechanics.
import { guardedFauxCapability } from "./continuity-guarded-faux-capability.mjs";

export const isFauxLookupSend = (value) => guardedFauxCapability("lookup-pilot").isFauxLookupSend(value);
export const fauxLookupSendBinds = (send, profile) => guardedFauxCapability("lookup-pilot").fauxLookupSendBinds(send, profile);
export async function createLookupFauxSend(a, safety) { return guardedFauxCapability("lookup-pilot").createLookupFauxSend(a, safety); }

/** Source-selected faux composition; the one loopback send remains in the core. */
export function lookupFauxBindings() { return { readPrivate: readPilotPrivate, statePath: pilotStatePath, verifyParent: verifyLookupPilotParent, createIPC: createLookupPilotIPC, verifyPreparation: verifyLookupPreparation, guardContract: LOOKUP_GUARD_CONTRACT, createDecorator: createFauxLookupDecorator, verifyRole: async a => { if (ROOT !== a.pilot.registration.codes[a.slot.code].path) throw Object.assign(Error("lookup_pilot_faux_required"), { code: "lookup_pilot_faux_required" }); await verifyRoleRequest(ROOT, a.roleRequest, a.plan); } }; }
