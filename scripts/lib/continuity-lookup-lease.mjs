// Lookup API adapter. All guarded mechanics live in the protocol-neutral core.
import { guardedLease } from "./continuity-guarded-lease.mjs";
export const isLookupLeaseFile = (path, stat) => guardedLease("lookup-pilot").isLeaseFile(path, stat);
export function markLookupLeaseCompromised(stat) { return guardedLease("lookup-pilot").markLeaseCompromised(stat); }
export async function acquireLookupPilotLease(root) { return guardedLease("lookup-pilot").acquireLease(root); }
export async function assertLookupPilotLease(handle, root, controller) { return guardedLease("lookup-pilot").assertLease(handle, root, controller); }
export async function readLookupPilotLease(root, controller) { return guardedLease("lookup-pilot").readLease(root, controller); }
