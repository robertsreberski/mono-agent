// @ts-check
// Deterministic storage plans. No provider, tool or host dispatch capabilities.
import { createHash } from "node:crypto";
import { canonicalHostJournalAuthority } from "./header-authority.js";
import { JournalValidator, validateJournalHeader } from "./journal-schema.js";
import { JOURNAL_FORMAT } from "./journal-types.js";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
function timestamp(value) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid managed journal timestamp"); return value; }
/** @param {any} options @param {{seq:number,parentId:string|null,tip:string|null}} source */
export function modelChangeRecords(options, source) {
  const hash = digest(options.switchId), turnId = `synthetic:model-change:${hash}`, time = timestamp(options.timestamp);
  const payload = ordered({ version: 1, switchId: options.switchId, from: options.from, to: options.to,
    source: "host-handoff", checkpointId: null, artifactRef: options.artifactRef });
  /** @param {string} suffix @param {import("./journal-types.js").JournalKind} kind @param {any} data @param {number} index @param {2|3} [schemaVersion] @returns {import("./journal-types.js").JournalEntry} */
  const row = (suffix, kind, data, index, schemaVersion = 2) => ({ schemaVersion, id: `model-change${suffix}:${hash}`,
    parentId: index ? `model-change${index === 1 ? "-start" : ""}:${hash}` : source.parentId,
    seq: source.seq + index + 1, timestamp: time, turnId, kind, payload: data });
  return [row("-start", "turn_start", { config: { cause: "model-change" }, identitySource: "synthetic", baselineTipId: source.tip }, 0),
    row("", "model_change", payload, 1, 3),
    row("-end", "turn_end", { status: "completed", tipId: source.tip, finalOperationId: null, consumedInputIds: [] }, 2)];
}
export function managedJournalId(handleId) { return digest(`mono-host-journal-v1\0${handleId}`); }
/** The initialized epoch is published atomically, not header then four writes.
 * @param {any} options */
export function guardedEpochPlan(options) {
  if (!/^[a-f0-9]{64}$/.test(options.id)) throw new TypeError("Invalid managed epoch handle");
  const time = timestamp(options.timestamp), hash = digest(`initialize:${options.id}`), turnId = `synthetic:initialize:${hash}`;
  const header = { format: JOURNAL_FORMAT, version: 2, ownershipSchemaVersion: 2, ownership: { kind: "unbound" },
    initialHandle: { id: options.id }, id: options.id, cwd: ".", createdAt: time,
    journalId: managedJournalId(options.id), hostAuthority: canonicalHostJournalAuthority(options.hostAuthority) };
  validateJournalHeader(header);
  /** @type {[import("./journal-types.js").JournalKind, Record<string,any>][]} */
  const rows = [["turn_start", { config: { cause: "initialize" }, identitySource: "synthetic", baselineTipId: null }],
    ["owner_binding", { kind: "unbound" }], ["handle_binding", { handleId: options.id, baseRevision: null, model: null }],
    ["turn_end", { status: "completed", tipId: null, finalOperationId: null, consumedInputIds: [] }]];
  /** @type {import("./journal-types.js").JournalEntry[]} */
  const records = rows.map(([kind, payload], index) => ({ schemaVersion: 2, id: `initialize:${hash}:${index}`,
    parentId: index ? `initialize:${hash}:${index - 1}` : null, seq: index + 1, timestamp: time, turnId, kind, payload }));
  const validator = new JournalValidator(); for (const record of records) validator.apply(record);
  return { header, records, bytes: Buffer.from([header, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n") };
}
