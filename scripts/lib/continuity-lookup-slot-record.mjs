// Private, content-free per-slot lookup evidence. Counts, booleans and fixed codes only;
// never record IDs, digests, paths, questions, answers or retrieved text.
import { linkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { lookupPilotWork } from "./continuity-lookup-pilot-runtime.mjs";
import { readPilotPrivate } from "./continuity-lookup-pilot-state.mjs";

export const LOOKUP_SLOT_RECORD = "lookup-pilot-slot-lookup-v1";
const COUNTS = Object.freeze(["calls", "responses", "bytes", "searchPages", "getChunks", "rounds"]);
const KEYS = Object.freeze(["schema", "initiallyPresent", "initialContextBytes", "sourceAvailability", "sourceReturned",
  ...COUNTS, "exhausted", "witnessedRecovery"].sort());
const AVAILABILITY = Object.freeze(["retained", "protected", "unknown", "unavailable"]);
const EXHAUSTION = Object.freeze([null, "calls", "bytes", "latency"]);
const fail = () => { throw Object.assign(new Error("lookup_slot_record_invalid"), { code: "lookup_slot_record_invalid" }); };
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Sibling of preparation.json: outside the digested snapshot and the probe work tree. */
export const lookupSlotRecordPath = a => join(dirname(lookupPilotWork(a)), "lookup-record.json");

export function validateLookupSlotRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.getPrototypeOf(record) !== Object.prototype
    || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(KEYS) || record.schema !== LOOKUP_SLOT_RECORD
    || ![true, false, "unknown"].includes(record.initiallyPresent)
    || !(record.initialContextBytes === null || count(record.initialContextBytes))
    || (record.initiallyPresent !== "unknown" && record.initialContextBytes === null)
    || !AVAILABILITY.includes(record.sourceAvailability) || typeof record.sourceReturned !== "boolean"
    || !COUNTS.every(key => count(record[key])) || !EXHAUSTION.includes(record.exhausted)
    || typeof record.witnessedRecovery !== "boolean"
    || (record.witnessedRecovery && (record.initiallyPresent !== false || record.sourceAvailability !== "retained" || !record.sourceReturned))) fail();
  return record;
}

/** Explicit projection of a trial's lookup snapshot; every other field is dropped. */
export function lookupSlotRecord(lookup) {
  return Object.freeze(validateLookupSlotRecord({
    schema: LOOKUP_SLOT_RECORD, initiallyPresent: lookup?.initiallyPresent, initialContextBytes: lookup?.initialContextBytes ?? null,
    sourceAvailability: lookup?.source?.availability, sourceReturned: lookup?.sourceReturned,
    ...Object.fromEntries(COUNTS.map(key => [key, lookup?.[key]])), exhausted: lookup?.exhausted ?? null,
    witnessedRecovery: lookup?.witnessedRecovery,
  }));
}

/** Synchronous, owner-only and atomic: write an exclusive private temp file, then publish it
 * with an exclusive hard link, so a reader sees either no record or the complete record and an
 * existing entry (including a symlink) is never replaced or followed. Evidence only and
 * deliberately NOT crash-durable (no file or directory fsync): after an IPC stop the controller
 * contains the child within a short grace, so this write must never delay the child's done
 * message. Readers always validate; a leftover second link fails readPilotPrivate's nlink check.
 */
export function writeLookupSlotRecord(a, lookup) {
  const record = lookupSlotRecord(lookup), path = lookupSlotRecordPath(a), temp = `${path}.${randomUUID()}.pending`;
  try {
    writeFileSync(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    linkSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return record;
}
export async function readLookupSlotRecord(a) {
  return validateLookupSlotRecord(await readPilotPrivate(lookupSlotRecordPath(a)));
}
