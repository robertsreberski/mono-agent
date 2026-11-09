// Lookup API adapter; no duplicated guarded-run mechanics.
import { guardedIPC } from "./continuity-guarded-ipc.mjs";

export async function verifyLookupPilotParent(assignment) { const verify = guardedIPC("lookup-pilot").verifyLookupPilotParent; return verify(assignment); }
export async function createLookupPilotIPC(assignment) { return guardedIPC("lookup-pilot").createLookupPilotIPC(assignment); }
