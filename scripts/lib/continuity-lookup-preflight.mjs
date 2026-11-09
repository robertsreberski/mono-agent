import { validateLookupPilotRegistration } from "./continuity-lookup-pilot.mjs";
import { verifyRegisteredCheckouts } from "./continuity-lookup-roles.mjs";
import { lookupPilotSchedule, pilotStatePath } from "./continuity-lookup-pilot-state.mjs";
import { LOOKUP_PREFLIGHT, LOOKUP_TREE_LIMITS, lookupPreparationStats, restoreLookupPreflight, removeLookupWorkTree, lookupRetainedBytes } from "./continuity-lookup-preparation.mjs";
import { runLookupPreparationSlot } from "./continuity-lookup-controller.mjs";
import { lookupPilotWatchdog, validLookupPilotTimeout } from "./continuity-lookup-pilot-runtime.mjs";
// Lookup protocol adapter; shared mechanics are owned by the guarded core.
import { guardedPreflight } from "./continuity-guarded-preflight.mjs";

export async function runLookupPreparationPreflight(pilot, {timeoutMs, outputRoot} = {}) { return guardedPreflight("lookup-pilot").runLookupPreparationPreflight(pilot, { timeoutMs, outputRoot }); }

/** Preserve the existing offline composition boundary without injecting callbacks. */
export function lookupPreflightBindings() { return { validateRegistration: validateLookupPilotRegistration, verifyCheckouts: verifyRegisteredCheckouts, schedule: lookupPilotSchedule, runPreparationSlot: runLookupPreparationSlot, restorePreflight: restoreLookupPreflight, preparationStats: lookupPreparationStats, removeWorkTree: removeLookupWorkTree, retainedBytes: lookupRetainedBytes }; }
