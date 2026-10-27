import type { DatabaseSync } from "node:sqlite";
import { parseAgentUpkeepAccounting, type AgentUpkeepAccounting } from "@mono-agent/contracts";
import { exportUpkeepAccounting, UpkeepAccountingExportError } from "@mono-agent/observability";
import type { ContinuityUpkeepReceipt } from "@mono-agent/turn/host";
import type { UpkeepReservation } from "./admission.js";

type Row = { operation_id: string; phase: string; payload: string; attempts: number; origin_seen: number };
const tableExists = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
const tokenCount = (n: unknown): number | null => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
const MAX_ATTEMPTS = 3, BATCH_LIMIT = 32, BACKOFF_MS = 1_000;

export function upkeepAccounting(r: UpkeepReservation, receipt?: ContinuityUpkeepReceipt): AgentUpkeepAccounting {
  if (receipt && (receipt.operationId !== r.operationId || receipt.model !== r.model)) throw new TypeError("Conflicting upkeep identity");
  const notInvoked = receipt && !receipt.providerInvoked && receipt.status === "skipped" && ["model_identity", "input_budget", "cap_unsupported", "model_headroom"].includes(receipt.reason);
  const invoked = receipt?.providerInvoked === true;
  // Legacy inputTokens folded cache categories together. Only the original
  // split providerUsage (or the new explicit counters) can establish input.
  const input = receipt?.providerUsage?.input ?? (receipt?.cacheReadTokens !== undefined && receipt.cacheWriteTokens !== undefined ? receipt.inputTokens : null);
  return parseAgentUpkeepAccounting({ version: 1, usageIncluded: false,
    operationId: r.operationId, databaseId: r.databaseId, incarnation: r.incarnation,
    runId: r.runId, conversationId: r.conversationId, logicalConversationId: r.logicalId,
    recorderNamespace: r.recorderNamespace, model: r.model, budget: r.budget,
    phase: receipt ? "result" : "dispatch", invocation: invoked ? "invoked" : notInvoked ? "not_invoked" : "uncertain",
    outcome: invoked ? receipt!.status : notInvoked ? "skipped" : "uncertain",
    inputTokens: invoked ? tokenCount(input) : notInvoked ? 0 : null,
    cacheReadTokens: invoked ? tokenCount(receipt!.cacheReadTokens ?? receipt!.providerUsage?.cacheRead) : notInvoked ? 0 : null,
    cacheWriteTokens: invoked ? tokenCount(receipt!.cacheWriteTokens ?? receipt!.providerUsage?.cacheWrite) : notInvoked ? 0 : null,
    outputTokens: invoked ? tokenCount(receipt!.outputTokens) : notInvoked ? 0 : null,
    costUsd: invoked ? receipt!.costUsd ?? null : notInvoked ? 0 : null });
}

/** Called in the same FULL transaction as admission. No second operation journal. */
export function queueUpkeepAccounting(db: DatabaseSync, a: AgentUpkeepAccounting): void {
  const payload = JSON.stringify(parseAgentUpkeepAccounting(a));
  const old = db.prepare("SELECT payload FROM continuity_upkeep_accounting WHERE operation_id=? AND phase=?").get(a.operationId, a.phase) as { payload: string } | undefined;
  if (old) { if (old.payload !== payload) throw new TypeError("Conflicting upkeep outbox"); return; }
  db.prepare("INSERT INTO continuity_upkeep_accounting(operation_id,phase,payload) VALUES (?,?,?)").run(a.operationId, a.phase, payload);
}

/** A rejected namespace or corrupt legacy row is terminal degradation, not work. */
export function failUpkeepAccounting(db: DatabaseSync, operationId: string, phase: string, code: "invalid_journal" | "namespace_invalid"): void {
  db.prepare("INSERT OR IGNORE INTO continuity_upkeep_accounting(operation_id,phase,payload,exported,error) VALUES (?,?,'{}','failed',?)").run(operationId, phase, code);
}

/** Additive retry metadata; upgrades do not reset an operation's attempt budget. */
export function createUpkeepAccountingSchema(db: DatabaseSync): void {
  if (tableExists(db, "continuity_upkeep_accounting")) {
    const columns = db.prepare("PRAGMA table_info(continuity_upkeep_accounting)").all() as { name: string }[];
    if (!columns.some(c => c.name === "attempts")) db.exec("ALTER TABLE continuity_upkeep_accounting ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0; ALTER TABLE continuity_upkeep_accounting ADD COLUMN next_attempt_ms INTEGER NOT NULL DEFAULT 0;");
    if (!columns.some(c => c.name === "origin_seen")) db.exec("ALTER TABLE continuity_upkeep_accounting ADD COLUMN origin_seen INTEGER NOT NULL DEFAULT 0");
    // The previous version left these permanent failures pending as '{}'.
    db.exec("UPDATE continuity_upkeep_accounting SET exported='failed',error='invalid_journal' WHERE exported IS NULL AND payload='{}'");
    return;
  }
  db.exec(`CREATE TABLE continuity_upkeep_accounting (
    operation_id TEXT NOT NULL,phase TEXT NOT NULL,payload TEXT NOT NULL,
    exported TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER NOT NULL DEFAULT 0,origin_seen INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(operation_id,phase));`);
  if (!tableExists(db, "continuity_upkeep_operations")) return;
  for (const row of db.prepare("SELECT operation_id,reservation,outcome FROM continuity_upkeep_operations WHERE state IN ('dispatch_started','uncertain','terminal') OR outcome IS NOT NULL").all() as { operation_id: string; reservation: string; outcome: string | null }[]) {
    let phase = "dispatch";
    try {
      const r = JSON.parse(row.reservation) as UpkeepReservation;
      if (r.operationId !== row.operation_id) throw new TypeError("Conflicting upkeep identity");
      queueUpkeepAccounting(db, upkeepAccounting(r));
      if (row.outcome) { phase = "result"; queueUpkeepAccounting(db, upkeepAccounting(r, JSON.parse(row.outcome))); }
    } catch { failUpkeepAccounting(db, row.operation_id, phase, "invalid_journal"); }
  }
}

export function upkeepAccountingDegradation(db: DatabaseSync): number {
  return tableExists(db, "continuity_upkeep_accounting") ? Number((db.prepare("SELECT count(*) n FROM continuity_upkeep_accounting WHERE error IS NOT NULL").get() as { n: number }).n) : 0;
}

/** Recovery batches are bounded; mutations target only their own queued phase.
 * Attempts are durably consumed BEFORE I/O, including process death during I/O. */
export async function replayUpkeepAccounting(db: DatabaseSync, options: {
  readonly operationId?: string; readonly phase?: "dispatch" | "result";
  readonly now?: () => number; readonly exporter?: typeof exportUpkeepAccounting;
} = {}): Promise<number> {
  prepareUpkeepAccounting(db);
  if (!tableExists(db, "continuity_upkeep_accounting")) return 0;
  const now = options.now ?? Date.now, timestamp = now();
  db.prepare("UPDATE continuity_upkeep_accounting SET exported='failed',error=coalesce(error,'export_interrupted') WHERE exported IS NULL AND attempts>=?").run(MAX_ATTEMPTS);
  const target = options.operationId === undefined ? "" : " AND operation_id=? AND phase=?";
  const args = options.operationId === undefined ? [timestamp, BATCH_LIMIT] : [timestamp, options.operationId, options.phase!, BATCH_LIMIT];
  for (const row of db.prepare(`SELECT operation_id,phase,payload,attempts,origin_seen FROM continuity_upkeep_accounting WHERE exported IS NULL AND next_attempt_ms<=?${target} ORDER BY rowid LIMIT ?`).all(...args) as Row[]) {
    const attempts = row.attempts + 1;
    db.prepare("UPDATE continuity_upkeep_accounting SET attempts=?,next_attempt_ms=?,error=coalesce(error,'export_interrupted') WHERE operation_id=? AND phase=?").run(attempts, now() + BACKOFF_MS * 2 ** (attempts - 1), row.operation_id, row.phase);
    try {
      let accounting: AgentUpkeepAccounting;
      try { accounting = parseAgentUpkeepAccounting(JSON.parse(row.payload)); } catch { throw new UpkeepAccountingExportError("invalid_payload"); }
      const result = await (options.exporter ?? exportUpkeepAccounting)(accounting, {
        originPreviouslySeen: row.origin_seen === 1,
        onOriginSeen: () => { db.prepare("UPDATE continuity_upkeep_accounting SET origin_seen=1 WHERE operation_id=? AND phase=?").run(row.operation_id, row.phase); },
      });
      if (result === "pending") {
        db.prepare("UPDATE continuity_upkeep_accounting SET exported=?,error='origin_pending' WHERE operation_id=? AND phase=?").run(attempts >= MAX_ATTEMPTS ? "failed" : null, row.operation_id, row.phase);
      } else db.prepare("UPDATE continuity_upkeep_accounting SET exported=?,error=NULL WHERE operation_id=? AND phase=?").run(result, row.operation_id, row.phase);
    } catch (error) {
      const permanent = error instanceof UpkeepAccountingExportError;
      const code = permanent ? error.code : "export_io";
      db.prepare("UPDATE continuity_upkeep_accounting SET exported=?,error=? WHERE operation_id=? AND phase=?").run(permanent || attempts >= MAX_ATTEMPTS ? "failed" : null, code, row.operation_id, row.phase);
    }
  }
  db.exec("DELETE FROM continuity_upkeep_accounting WHERE exported IN ('exported','pruned') AND operation_id NOT IN (SELECT operation_id FROM continuity_upkeep_operations)");
  return upkeepAccountingDegradation(db);
}

/** Backfill before retention/reset can erase legacy operation evidence. */
export function prepareUpkeepAccounting(db: DatabaseSync): void {
  if (!tableExists(db, "continuity_upkeep_operations")) return;
  if (!tableExists(db, "continuity_upkeep_accounting") && !db.prepare("SELECT 1 FROM continuity_upkeep_operations WHERE state IN ('dispatch_started','uncertain','terminal') OR outcome IS NOT NULL LIMIT 1").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try { createUpkeepAccountingSchema(db); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Serialized exports, independent of the admission/RPC tail. Slow filesystem
 * work cannot change a dispatch/outcome acknowledgement or block the next one.
 * Overflow remains durable for recovery, rather than growing an in-memory tail. */
export function createUpkeepAccountingExportQueue(db: DatabaseSync, onDegradation: (count: number) => void,
  defaults: Pick<Parameters<typeof replayUpkeepAccounting>[1] & {}, "now" | "exporter"> = {}) {
  let tail = Promise.resolve(), queued = 0;
  const report = (count: number) => { try { onDegradation(count); } catch { /* diagnostics only */ } };
  return {
    schedule(target: { operationId?: string; phase?: "dispatch" | "result" } = {}) {
      if (queued >= BATCH_LIMIT) { report(Math.max(1, upkeepAccountingDegradation(db))); return; }
      queued++;
      tail = tail.then(async () => { report(await replayUpkeepAccounting(db, { ...defaults, ...target })); })
        .catch(() => report(1)).finally(() => { queued--; });
    },
    async flush() { await tail; },
  };
}
