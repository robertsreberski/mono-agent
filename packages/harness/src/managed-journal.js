// @ts-check
// Deterministic storage plans. No provider, tool or host dispatch capabilities.
import { createHash } from "node:crypto";
import { canonicalHostJournalAuthority } from "./header-authority.js";
import { JournalValidator, validateJournalHeader } from "./journal-schema.js";
import { JOURNAL_FORMAT } from "./journal-types.js";
const digest = (value) => createHash("sha256").update(value).digest("hex");
function timestamp(value) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid managed journal timestamp"); return value; }
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
