import type { InstanceUsage } from "./subagent-instances.js";
import type { SubagentDisposition } from "./subagent-managed-turn.js";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ProcessIncarnation } from "./process-incarnation.js";

/** App-private, bounded evidence. Reporting terminality never discharges ownership. */
export interface SubagentExecutionOwnership {
  schemaVersion: 1;
  registryRoot?: string;
  disposition?: SubagentDisposition;
  usage?: InstanceUsage;
  instanceIncarnation: string;
  turnToken: string;
  owner: { pid: number; incarnation: ProcessIncarnation; settlement: "not_started" | "running" | "settled" | "dead" | "unknown" };
  revoked: boolean;
  publication: { sequence: number; state: "pending" | "confirmed"; receiptPending?: boolean };
  command?: SubagentOwnedCommand;
  /** Host-bound attempt/call keys. Never evict keys while the turn can execute. */
  seenCalls: string[];
}

export interface SubagentOwnedCommand {
  id: string;
  callKey: string;
  tool: "Exec" | "Bash";
  state: "preparing" | "attested" | "running" | "terminating" | "cleanup_unknown" | "released";
  cwd: string;
  sandboxSettingsPath: string | null;
  pid: number | null;
  pgid: number | null;
  incarnation: ProcessIncarnation | null;
  deadlineAt: number;
  budgetMs?: number;
}

export const SUBAGENT_OWNERSHIP_MAX_BYTES = 40 * 1024;
export const SUBAGENT_COMMAND_MAX_BYTES = 4 * 1024;
export const SUBAGENT_SEEN_CALLS_MAX_COUNT = 256;
export const SUBAGENT_SEEN_CALLS_MAX_BYTES = 32 * 1024;

/** Minimal shape accepted by all ownership/retention/admission consumers. */
interface OwnershipRecord {
  readonly kind?: "internal";
  readonly childStillBusy?: boolean;
  readonly subagentOwnership?: SubagentExecutionOwnership;
}

/** U: a child lease or its command remains unresolved, even after a terminal wake. */
export function hasUnresolvedSubagentOwnership(record: OwnershipRecord): boolean {
  if (record.kind !== "internal") return false;
  const ownership = record.subagentOwnership;
  if (ownership === undefined) return record.childStillBusy === true; // Legacy is not cleanup proof.
  return ["running", "unknown"].includes(ownership.owner.settlement)
    || (ownership.command !== undefined && ownership.command.state !== "released");
}

/** A confirmed job must retain its evidence until the registry certificate is acknowledged. */
export function hasPendingSubagentReleaseReceipt(record: OwnershipRecord): boolean {
  const owner = record.kind === "internal" ? record.subagentOwnership : undefined;
  return owner !== undefined && (owner.publication.receiptPending === true
    // Older confirmed managed records did not acknowledge certificate durability.
    || (owner.publication.receiptPending === undefined && owner.registryRoot !== undefined
      && owner.disposition !== undefined && !hasUnresolvedSubagentOwnership(record)));
}
/** P includes the registry release-certificate acknowledgement, not just job confirmation. */
export function hasPendingSubagentPublication(record: OwnershipRecord): boolean {
  return record.kind === "internal" && (record.subagentOwnership?.publication.state === "pending" || hasPendingSubagentReleaseReceipt(record));
}

/** H: shared pin for recovery, retention, capacity and shutdown. */
export function hasSubagentObligation(record: OwnershipRecord): boolean {
  return hasUnresolvedSubagentOwnership(record) || hasPendingSubagentPublication(record);
}

/** Validate before a durable store or registry can act on owner identity. */
export function isSubagentExecutionOwnership(value: unknown): value is SubagentExecutionOwnership {
  if (!object(value) || !exact(value, ["schemaVersion", "instanceIncarnation", "turnToken", "owner", "revoked", "publication", "seenCalls",
    ...["command", "registryRoot", "disposition", "usage"].filter((key) => Object.hasOwn(value, key))])
    || (value.registryRoot !== undefined && !canonicalPath(value.registryRoot))
    || (value.usage !== undefined && !usage(value.usage))
    || (value.disposition !== undefined && !disposition(value.disposition))
    || value.schemaVersion !== 1 || !uuid(value.instanceIncarnation) || !uuid(value.turnToken)
    || typeof value.revoked !== "boolean" || !object(value.owner)
    || !exact(value.owner, ["pid", "incarnation", "settlement"]) || !positive(value.owner.pid)
    || !incarnation(value.owner.incarnation)
    || !["not_started", "running", "settled", "dead", "unknown"].includes(String(value.owner.settlement))
    || !object(value.publication) || !exact(value.publication, ["sequence", "state", ...(Object.hasOwn(value.publication, "receiptPending") ? ["receiptPending"] : [])])
    || (value.publication.receiptPending !== undefined && typeof value.publication.receiptPending !== "boolean")
    || !positive(value.publication.sequence) || !["pending", "confirmed"].includes(String(value.publication.state))
    || !Array.isArray(value.seenCalls) || value.seenCalls.length > SUBAGENT_SEEN_CALLS_MAX_COUNT
    || !value.seenCalls.every((key) => text(key, 512)) || new Set(value.seenCalls).size !== value.seenCalls.length
    || Buffer.byteLength(JSON.stringify(value.seenCalls), "utf8") > SUBAGENT_SEEN_CALLS_MAX_BYTES
    || (value.command !== undefined && (!isSubagentOwnedCommand(value.command) || !value.seenCalls.includes(value.command.callKey)))) return false;
  if (["settled", "dead", "unknown"].includes(String(value.owner.settlement)) && !value.revoked) return false;
  if (value.owner.settlement === "not_started" && (value.command !== undefined || value.seenCalls.length > 0)) return false;
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= SUBAGENT_OWNERSHIP_MAX_BYTES;
}

export function isSubagentOwnedCommand(value: unknown): value is SubagentOwnedCommand {
  if (!object(value) || !exact(value, ["id", "callKey", "tool", "state", "cwd", "sandboxSettingsPath", "pid", "pgid", "incarnation", "deadlineAt", ...(Object.hasOwn(value, "budgetMs") ? ["budgetMs"] : [])])
    || !uuid(value.id) || !text(value.callKey, 512) || !["Exec", "Bash"].includes(String(value.tool))
    || !["preparing", "attested", "running", "terminating", "cleanup_unknown", "released"].includes(String(value.state))
    || !canonicalPath(value.cwd) || !positive(value.deadlineAt) || (value.budgetMs !== undefined && !positive(value.budgetMs))
    || !(value.pid === null || positive(value.pid)) || value.pgid !== value.pid
    || !(value.incarnation === null || incarnation(value.incarnation))
    || ((value.pid === null) !== (value.incarnation === null))
    || !(value.sandboxSettingsPath === null || (canonicalPath(value.sandboxSettingsPath)
      && basename(value.sandboxSettingsPath) === "settings.json"
      && /^mono-agent-srt-settings-[A-Za-z0-9_-]{6,}$/u.test(basename(dirname(value.sandboxSettingsPath)))))) return false;
  if (value.state === "preparing" && value.pid !== null) return false;
  if (["attested", "running", "terminating"].includes(String(value.state)) && value.pid === null) return false;
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= SUBAGENT_COMMAND_MAX_BYTES;
}

function incarnation(value: unknown): value is ProcessIncarnation {
  return object(value) && exact(value, ["schema", "bootSessionId", "processStartId"])
    && value.schema === "mono-agent.process-incarnation.v1" && text(value.bootSessionId, 256) && text(value.processStartId, 256);
}
function canonicalPath(value: unknown): value is string {
  return text(value, 2048) && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}
function uuid(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function text(value: unknown, bytes: number): value is string { return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= bytes; }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }

function disposition(value: unknown): value is SubagentDisposition {
  return object(value) && exact(value, ["status", "continuity", ...["reason", "closeAfterSuccess"].filter((key) => Object.hasOwn(value, key))])
    && (value.closeAfterSuccess === undefined || typeof value.closeAfterSuccess === "boolean")
    && ["ok", "awaiting_reply", "failed", "timeout", "cancelled", "empty", "interrupted", "busy"].includes(String(value.status))
    && ["retained", "lost", "unknown"].includes(String(value.continuity))
    && (value.reason === undefined || ["continuation_not_started", "settlement_unknown", "session_continuity_lost", "timeout", "cancelled", "failed", "empty", "interrupted"].includes(String(value.reason)));
}

function usage(value: unknown): value is InstanceUsage {
  return object(value) && exact(value, ["input", "output", "cacheRead", "cacheWrite", "costUsd"])
    && ["input", "output", "cacheRead", "cacheWrite"].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    && typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0;
}
