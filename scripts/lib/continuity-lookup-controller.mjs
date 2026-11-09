import { LOOKUP_PREFLIGHT, lookupPreflightDigest } from "./continuity-lookup-preparation.mjs";
import { lookupChildEnvironment, lookupChildImports } from "./continuity-lookup-child-environment.mjs";
import { assertLookupPilotArm, lookupPreparationDigest } from "./continuity-lookup-preparation.mjs";
import { armById } from "./continuity-arms.mjs";
import { LOOKUP_PRE_SEND_REFUSALS, LOOKUP_GUARD_POLICY_REFUSALS } from "./continuity-lookup-guard.mjs";
import { assertLookupCacheAssignment, issueLookupCacheKey, lookupPilotWatchdog, validLookupPilotTimeout } from "./continuity-lookup-pilot-runtime.mjs";
import { acquireLookupPilotLease, assertLookupPilotLease } from "./continuity-lookup-lease.mjs";
import { LOOKUP_FAUX_AUTHORIZATION_DOMAIN, validateLookupPilotRegistration } from "./continuity-lookup-pilot.mjs";
import { ROOT, verifyRegisteredCheckouts, roleBinding, rolePlan } from "./continuity-lookup-roles.mjs";
import { aggregateLookupPilot, lookupPilotReceipt } from "./continuity-lookup-pilot-report.mjs";
import { accountLookupPilot, lookupMoney, lookupPilotStopReason, settleLookupHold, priceLookupUsage, pilotNeed, fixedPilotCode, LOOKUP_SLOT_TERMINALS, LOOKUP_PILOT_STOPS, LOOKUP_GUARD_STOPS, LOOKUP_INTEGRITY_STOPS } from "./continuity-lookup-pilot-accounting.mjs";
import { LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER, LOOKUP_PILOT_IPC, requireFauxPilot, readPilotPrivate, pilotStatePath, samePilot, pilotHash, pilotId, lookupPilotSchedule } from "./continuity-lookup-pilot-state.mjs";
// Lookup API adapter; no duplicated guarded-run mechanics.
import { guardedController } from "./continuity-guarded-controller.mjs";
export { lookupPilotSchedule } from "./continuity-lookup-pilot-state.mjs";
export async function createLookupPilotController(options) { return guardedController("lookup-pilot").createLookupPilotController(options); }
export async function reconcileLookupPilot(outputRoot) { return guardedController("lookup-pilot").reconcileLookupPilot(outputRoot); }
export async function runLookupPilot(options) { return guardedController("lookup-pilot").runLookupPilot(options); }
export async function runLookupPreparationSlot(journal, pilot, root, index) { return guardedController("lookup-pilot").runLookupPreparationSlot(journal, pilot, root, index); }

/** Source-owned composition only; callers cannot replace these bindings. */
export function lookupControllerBindings() { return { acquireLease: acquireLookupPilotLease, assertLease: assertLookupPilotLease, readPrivate: readPilotPrivate, consumeAuthorization: async (...args) => (await import("./continuity-lookup-authorization.mjs")).consumeLookupAuthorization(...args), childEnvironment: lookupChildEnvironment }; }
