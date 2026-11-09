// Lookup protocol adapter; shared mechanics are owned by the guarded core.
import { guardedSnapshot } from "./continuity-guarded-snapshot.mjs";
export { LOOKUP_PREFLIGHT, LOOKUP_TREE_LIMITS } from "./continuity-lookup-guarded-policy.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
export function lookupPilotServesArm(arm) { return guardedProtocol("lookup-pilot").hooks.servesArm(arm); }
export function assertLookupPilotArm(arm) { return guardedProtocol("lookup-pilot").hooks.assertArm(arm); }
export async function writeLookupPreparation(a, checkpoint) { return guardedSnapshot("lookup-pilot").writeLookupPreparation(a, checkpoint); }
export async function writeLookupPreflight(a, checkpoint) { return guardedSnapshot("lookup-pilot").writeLookupPreflight(a, checkpoint); }
export async function lookupPreflightDigest(a) { return guardedSnapshot("lookup-pilot").lookupPreflightDigest(a); }
export async function lookupPreparationDigest(a) { return guardedSnapshot("lookup-pilot").lookupPreparationDigest(a); }
export async function verifyLookupPreparation(a, state, restored = false) { return guardedSnapshot("lookup-pilot").verifyLookupPreparation(a, state, restored); }
export async function restoreLookupPreparation(a) { return guardedSnapshot("lookup-pilot").restoreLookupPreparation(a); }
export async function removeLookupWorkTree(root) { return guardedSnapshot("lookup-pilot").removeLookupWorkTree(root); }
export async function restoreLookupPreflight(a) { return guardedSnapshot("lookup-pilot").restoreLookupPreflight(a); }
export function lookupPreparedBoundary(pilot, arm, work, conversationId) { return guardedSnapshot("lookup-pilot").lookupPreparedBoundary(pilot, arm, work, conversationId); }
export async function lookupPreparationStats(root) { return guardedSnapshot("lookup-pilot").lookupPreparationStats(root); }
export async function lookupRetainedBytes(slotRoot) { return guardedSnapshot("lookup-pilot").lookupRetainedBytes(slotRoot); }
