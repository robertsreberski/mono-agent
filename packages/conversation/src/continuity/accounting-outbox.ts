import type { DatabaseSync } from "node:sqlite";
import { parseAgentUpkeepAccounting, type AgentUpkeepAccounting } from "@mono-agent/contracts";
import { exportUpkeepAccounting } from "@mono-agent/observability";
import type { ContinuityUpkeepReceipt } from "@mono-agent/turn/host";
import type { UpkeepReservation } from "./admission.js";

type Row = { operation_id: string; phase: string; payload: string };
const tableExists = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);

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
    inputTokens: invoked ? input : notInvoked ? 0 : null,
    cacheReadTokens: invoked ? receipt!.cacheReadTokens ?? receipt!.providerUsage?.cacheRead ?? null : notInvoked ? 0 : null,
    cacheWriteTokens: invoked ? receipt!.cacheWriteTokens ?? receipt!.providerUsage?.cacheWrite ?? null : notInvoked ? 0 : null,
    outputTokens: invoked ? receipt!.outputTokens ?? null : notInvoked ? 0 : null,
    costUsd: invoked ? receipt!.costUsd ?? null : notInvoked ? 0 : null });
}

/** Called in the same FULL transaction as admission. No second operation journal. */
export function queueUpkeepAccounting(db: DatabaseSync, a: AgentUpkeepAccounting): void {
  const payload = JSON.stringify(parseAgentUpkeepAccounting(a));
  const old = db.prepare("SELECT payload FROM continuity_upkeep_accounting WHERE operation_id=? AND phase=?").get(a.operationId, a.phase) as { payload: string } | undefined;
  if (old) { if (old.payload !== payload) throw new TypeError("Conflicting upkeep outbox"); return; }
  db.prepare("INSERT INTO continuity_upkeep_accounting(operation_id,phase,payload) VALUES (?,?,?)").run(a.operationId, a.phase, payload);
}

/** One additive backfill also handles journal-only upgrades with upkeep disabled. */
export function createUpkeepAccountingSchema(db: DatabaseSync): void {
  if (tableExists(db, "continuity_upkeep_accounting")) return;
  db.exec(`CREATE TABLE continuity_upkeep_accounting (
    operation_id TEXT NOT NULL,phase TEXT NOT NULL,payload TEXT NOT NULL,
    exported TEXT,error TEXT,PRIMARY KEY(operation_id,phase));`);
  if (!tableExists(db, "continuity_upkeep_operations")) return;
  for (const row of db.prepare("SELECT operation_id,reservation,outcome FROM continuity_upkeep_operations WHERE state IN ('dispatch_started','uncertain','terminal') OR outcome IS NOT NULL").all() as { operation_id: string; reservation: string; outcome: string | null }[]) {
    // Invalid legacy evidence is degradation, never an invented zero or a
    // reason to disable all history. Retain a content-free pending failure.
    let phase = "dispatch";
    try {
      const r = JSON.parse(row.reservation) as UpkeepReservation;
      if (r.operationId !== row.operation_id) throw new TypeError("Conflicting upkeep identity");
      queueUpkeepAccounting(db, upkeepAccounting(r));
      if (row.outcome) { phase = "result"; queueUpkeepAccounting(db, upkeepAccounting(r, JSON.parse(row.outcome))); }
    } catch {
      db.prepare("INSERT INTO continuity_upkeep_accounting(operation_id,phase,payload,error) VALUES (?,?,'{}','invalid_journal')").run(row.operation_id, phase);
    }
  }
}

/** Retries pending exports, including after a lost export acknowledgement.
 * Failures remain pending and visible; a pruned origin is never recreated. */
export async function replayUpkeepAccounting(db: DatabaseSync): Promise<number> {
  if (!tableExists(db, "continuity_upkeep_operations")) return 0;
  if (!tableExists(db, "continuity_upkeep_accounting")) {
    if (!db.prepare("SELECT 1 FROM continuity_upkeep_operations WHERE state IN ('dispatch_started','uncertain','terminal') OR outcome IS NOT NULL LIMIT 1").get()) return 0;
    db.exec("BEGIN IMMEDIATE");
    try { createUpkeepAccountingSchema(db); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  for (const row of db.prepare("SELECT operation_id,phase,payload FROM continuity_upkeep_accounting WHERE exported IS NULL").all() as Row[]) {
    try {
      const result = await exportUpkeepAccounting(JSON.parse(row.payload));
      db.prepare("UPDATE continuity_upkeep_accounting SET exported=?,error=NULL WHERE operation_id=? AND phase=?").run(result, row.operation_id, row.phase);
    } catch {
      db.prepare("UPDATE continuity_upkeep_accounting SET error='export_failed' WHERE operation_id=? AND phase=?").run(row.operation_id, row.phase);
    }
  }
  db.exec("DELETE FROM continuity_upkeep_accounting WHERE exported IS NOT NULL AND operation_id NOT IN (SELECT operation_id FROM continuity_upkeep_operations)");
  return Number((db.prepare("SELECT count(*) n FROM continuity_upkeep_accounting WHERE error IS NOT NULL").get() as { n: number }).n);
}
