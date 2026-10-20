import type { JournalEntry, JournalKind } from "./journal-types.js";
// @ts-check
// Deterministic storage plans. No provider, tool or host dispatch capabilities.
import { createHash } from "node:crypto";
import { canonicalHostJournalAuthority } from "./header-authority.js";
import { JournalValidator, validateJournalHeader } from "./journal-schema.js";
import { JOURNAL_FORMAT } from "./journal-types.js";
const digest = (value: any) => createHash("sha256").update(value).digest("hex");
function timestamp(value: any): any { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid managed journal timestamp"); return value; }
export function managedJournalId(handleId: any): string { return digest(`mono-host-journal-v1\0${handleId}`); }
/**
 * The initialized epoch is published atomically, not header then four writes.
 */
export function guardedEpochPlan(options: any): { header: { format: string; version: number; ownershipSchemaVersion: number; ownership: { kind: string; }; initialHandle: { id: any; }; id: any; cwd: string; createdAt: any; journalId: string; hostAuthority: { version: any; rootId: any; authorityId: any; ownerKey: any; historyBucket: any; }; }; records: JournalEntry[]; bytes: Buffer<ArrayBuffer>; } {
  if (!/^[a-f0-9]{64}$/.test(options.id)) throw new TypeError("Invalid managed epoch handle");
  const time = timestamp(options.timestamp), hash = digest(`initialize:${options.id}`), turnId = `synthetic:initialize:${hash}`;
  const header = { format: JOURNAL_FORMAT, version: 2, ownershipSchemaVersion: 1, ownership: { kind: "unbound" },
    initialHandle: { id: options.id }, id: options.id, cwd: ".", createdAt: time,
    journalId: managedJournalId(options.id), hostAuthority: canonicalHostJournalAuthority(options.hostAuthority) };
  validateJournalHeader(header);
  const rows: [JournalKind, Record<string, any>][] = [["turn_start", { config: { cause: "initialize" }, identitySource: "synthetic", baselineTipId: null }],
    ["owner_binding", { kind: "unbound" }], ["handle_binding", { handleId: options.id, baseRevision: null, model: null }],
    ["turn_end", { status: "completed", tipId: null, finalOperationId: null, consumedInputIds: [] }]];
  const records: JournalEntry[] = rows.map(([kind, payload]: [JournalKind, Record<string, any>], index: number) => ({ schemaVersion: 2, id: `initialize:${hash}:${index}`,
    parentId: index ? `initialize:${hash}:${index - 1}` : null, seq: index + 1, timestamp: time, turnId, kind, payload }));
  const validator = new JournalValidator(); for (const record of records) validator.apply(record);
  return { header, records, bytes: Buffer.from([header, ...records].map((record: { format: string; version: number; ownershipSchemaVersion: number; ownership: { kind: string; }; initialHandle: { id: any; }; id: any; cwd: string; createdAt: any; journalId: string; hostAuthority: { version: any; rootId: any; authorityId: any; ownerKey: any; historyBucket: any; }; } | JournalEntry) => JSON.stringify(record)).join("\n") + "\n") };
}
