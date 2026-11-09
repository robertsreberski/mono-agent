// Lookup API adapter. All guarded mechanics live in the protocol-neutral core.
import { guardedReport } from "./continuity-guarded-report.mjs";
export function lookupPilotReceipt(state, index) { return guardedReport("lookup-pilot").slotReceipt(state, index); }
export function aggregateLookupPilot(state, receipts) { return guardedReport("lookup-pilot").aggregateRun(state, receipts); }
