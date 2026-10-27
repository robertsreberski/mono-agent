import type { DatabaseSync } from "node:sqlite";
import { parseAgentUpkeepAccounting, type AgentUpkeepAccounting } from "@mono-agent/contracts";
import { exportUpkeepAccounting, UpkeepAccountingExportError } from "@mono-agent/observability";
import type { ContinuityUpkeepReceipt } from "@mono-agent/turn/host";
import type { UpkeepReservation } from "./admission.js";

type Row = { operation_id: string; phase: string; payload: string; attempts: number; origin_seen: number };
const tableExists = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
const tokenCount = (n: unknown): number | null => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
const MAX_ATTEMPTS = 3, BATCH_LIMIT = 32, BACKOFF_MS = 1_000, FAILED_LIMIT = 128;
type AccountingWrite = <T>(operation: () => T) => T;

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

/** Corrupt legacy evidence is terminal degradation, not retry work. */
export function failUpkeepAccounting(db: DatabaseSync, operationId: string, phase: string, code: "invalid_journal"): void {
  db.prepare("INSERT OR IGNORE INTO continuity_upkeep_accounting(operation_id,phase,payload,exported,error) VALUES (?,?,'{}','failed',?)").run(operationId, phase, code);
}

/** Additive retry metadata; upgrades do not reset an operation's attempt budget. */
export function createUpkeepAccountingSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS continuity_upkeep_accounting_counters (key TEXT PRIMARY KEY,value INTEGER NOT NULL)");
  if (tableExists(db, "continuity_upkeep_accounting")) {
    const columns = db.prepare("PRAGMA table_info(continuity_upkeep_accounting)").all() as { name: string }[];
    if (!columns.some(c => c.name === "attempts")) db.exec("ALTER TABLE continuity_upkeep_accounting ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0; ALTER TABLE continuity_upkeep_accounting ADD COLUMN next_attempt_ms INTEGER NOT NULL DEFAULT 0;");
    if (!columns.some(c => c.name === "origin_seen")) db.exec("ALTER TABLE continuity_upkeep_accounting ADD COLUMN origin_seen INTEGER NOT NULL DEFAULT 0");
    // The previous version left these permanent failures pending as '{}'.
    db.exec("UPDATE continuity_upkeep_accounting SET exported='failed',error='invalid_journal' WHERE exported IS NULL AND payload='{}'");
    pruneFailedUpkeepAccounting(db); return;
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
  pruneFailedUpkeepAccounting(db);
}

/** Inside the secure transaction: count failure evidence before reclaiming it. */
export function pruneFailedUpkeepAccounting(db: DatabaseSync): void {
  if (!tableExists(db, "continuity_upkeep_accounting")) return;
  const orphaned = Number((db.prepare("SELECT count(*) n FROM continuity_upkeep_accounting WHERE exported='failed' AND operation_id NOT IN (SELECT operation_id FROM continuity_upkeep_operations)").get() as { n: number }).n);
  db.exec("DELETE FROM continuity_upkeep_accounting WHERE exported IN ('exported','pruned','failed') AND operation_id NOT IN (SELECT operation_id FROM continuity_upkeep_operations)");
  const removed = orphaned + Number(db.prepare("DELETE FROM continuity_upkeep_accounting WHERE rowid IN (SELECT rowid FROM continuity_upkeep_accounting WHERE exported='failed' ORDER BY rowid DESC LIMIT -1 OFFSET ?)").run(FAILED_LIMIT).changes);
  if (removed) db.prepare("INSERT INTO continuity_upkeep_accounting_counters VALUES ('failed_evicted',?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value").run(removed);
}
export function upkeepAccountingDiagnostics(db: DatabaseSync): { pending: number; failed: number; evicted: number } {
  if (!tableExists(db, "continuity_upkeep_accounting")) return { pending: 0, failed: 0, evicted: 0 };
  const counts = db.prepare("SELECT count(CASE WHEN exported IS NULL THEN 1 END) pending,count(CASE WHEN exported='failed' THEN 1 END) failed FROM continuity_upkeep_accounting").get() as { pending: number; failed: number };
  const evicted = tableExists(db, "continuity_upkeep_accounting_counters") ? Number((db.prepare("SELECT value FROM continuity_upkeep_accounting_counters WHERE key='failed_evicted'").get() as { value: number } | undefined)?.value ?? 0) : 0;
  return { ...counts, evicted };
}
export function upkeepAccountingDegradation(db: DatabaseSync): number {
  const { failed, evicted } = upkeepAccountingDiagnostics(db); return failed + evicted;
}
type ReplayOptions = {
  readonly operationId?: string; readonly phase?: "dispatch" | "result";
  readonly now?: () => number; readonly exporter?: typeof exportUpkeepAccounting;
  readonly closing?: () => boolean; readonly stopped?: () => boolean;
};
/** Every write, including migration and pre-I/O attempts, uses the owner's secure
 * transaction/busy deadline. Never hold that transaction across filesystem I/O. */
export async function replayUpkeepAccounting(db: DatabaseSync, write: AccountingWrite, options: ReplayOptions = {}): Promise<number> {
  prepareUpkeepAccounting(db, write);
  if (!tableExists(db, "continuity_upkeep_accounting")) return 0;
  const now = options.now ?? Date.now, timestamp = now();
  write(() => {
    db.prepare("UPDATE continuity_upkeep_accounting SET exported='failed',error=coalesce(error,'export_interrupted') WHERE exported IS NULL AND attempts>=?").run(MAX_ATTEMPTS);
    pruneFailedUpkeepAccounting(db);
  });
  const target = options.operationId === undefined ? "" : " AND operation_id=? AND phase=?";
  const args = options.operationId === undefined ? [timestamp, BATCH_LIMIT] : [timestamp, options.operationId, options.phase!, BATCH_LIMIT];
  for (const row of db.prepare(`SELECT operation_id,phase,payload,attempts,origin_seen FROM continuity_upkeep_accounting WHERE exported IS NULL AND next_attempt_ms<=?${target} ORDER BY rowid LIMIT ?`).all(...args) as Row[]) {
    if (options.closing?.() || options.stopped?.()) return 0;
    const attempts = row.attempts + 1;
    let attemptRecorded = false;
    try {
      write(() => db.prepare("UPDATE continuity_upkeep_accounting SET attempts=?,next_attempt_ms=?,error=coalesce(error,'export_interrupted') WHERE operation_id=? AND phase=?").run(attempts, now() + BACKOFF_MS * 2 ** (attempts - 1), row.operation_id, row.phase));
      attemptRecorded = true;
      let accounting: AgentUpkeepAccounting;
      try { accounting = parseAgentUpkeepAccounting(JSON.parse(row.payload)); } catch { throw new UpkeepAccountingExportError("invalid_payload"); }
      const result = await (options.exporter ?? exportUpkeepAccounting)(accounting, {
        originPreviouslySeen: row.origin_seen === 1,
        onOriginSeen: () => { if (!options.stopped?.()) write(() => db.prepare("UPDATE continuity_upkeep_accounting SET origin_seen=1 WHERE operation_id=? AND phase=?").run(row.operation_id, row.phase)); },
      });
      if (options.stopped?.()) return 0;
      write(() => {
        if (result === "pending") {
          db.prepare("UPDATE continuity_upkeep_accounting SET exported=?,error='origin_pending' WHERE operation_id=? AND phase=?").run(attempts >= MAX_ATTEMPTS ? "failed" : null, row.operation_id, row.phase);
          pruneFailedUpkeepAccounting(db);
        } else db.prepare("UPDATE continuity_upkeep_accounting SET exported=?,error=NULL WHERE operation_id=? AND phase=?").run(result, row.operation_id, row.phase);
      });
    } catch (error) {
      if (options.stopped?.()) return 0;
      if (!attemptRecorded) throw error; // No I/O or second failing write without a durable attempt.
      const permanent = error instanceof UpkeepAccountingExportError, code = permanent ? error.code : "export_io";
      write(() => { db.prepare("UPDATE continuity_upkeep_accounting SET exported=?,error=? WHERE operation_id=? AND phase=?").run(permanent || attempts >= MAX_ATTEMPTS ? "failed" : null, code, row.operation_id, row.phase); pruneFailedUpkeepAccounting(db); });
    }
  }
  if (options.stopped?.()) return 0;
  write(() => pruneFailedUpkeepAccounting(db));
  return upkeepAccountingDegradation(db);
}
/** Backfill before retention/reset can erase legacy operation evidence. */
export function prepareUpkeepAccounting(db: DatabaseSync, write: AccountingWrite): void {
  if (!tableExists(db, "continuity_upkeep_operations")) return;
  if (!tableExists(db, "continuity_upkeep_accounting") && !db.prepare("SELECT 1 FROM continuity_upkeep_operations WHERE state IN ('dispatch_started','uncertain','terminal') OR outcome IS NOT NULL LIMIT 1").get()) return;
  write(() => createUpkeepAccountingSchema(db));
}

/** One in-flight batch, 32 queued targets, cooperative recovery slices and an
 * unref'ed retry timer. Closing abandons durable queued work, never ownership. */
export function createUpkeepAccountingExportQueue(db: DatabaseSync, onDegradation: (count: number) => void,
  defaults: Pick<ReplayOptions, "now" | "exporter"> & { write: AccountingWrite }) {
  const now = defaults.now ?? Date.now;
  let running: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false, abandoned = false, sweep = false, lastCount = upkeepAccountingDegradation(db);
  let failedSlices = 0, retryAfter = 0, sliceFailureReported = false;
  const targets: { operationId?: string; phase?: "dispatch" | "result" }[] = [];
  const report = (count: number) => {
    if (!closing && count > lastCount) { try { onDegradation(count); } catch { /* diagnostics only */ } }
    lastCount = count;
  };
  const failedSlice = () => {
    sweep = true;
    retryAfter = now() + Math.min(60_000, BACKOFF_MS * 2 ** Math.min(failedSlices++, 6));
    // A failed metadata transaction is an actual pipeline failure, not a
    // warning about normal pending evidence. Do not query a possibly broken DB.
    if (!closing && !sliceFailureReported) {
      sliceFailureReported = true;
      try { onDegradation(1); } catch { /* diagnostics only */ }
    }
  };
  const dueAt = (): number | undefined => {
    if (!tableExists(db, "continuity_upkeep_accounting")) return undefined;
    const row = db.prepare("SELECT min(CASE WHEN attempts>=3 THEN 0 ELSE next_attempt_ms END) n FROM continuity_upkeep_accounting WHERE exported IS NULL").get() as { n: number | null };
    return row.n ?? undefined;
  };
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const arm = () => {
    if (closing || running) return;
    clearTimer(); let next: number | undefined;
    try { next = targets.length || sweep ? now() : dueAt(); } catch { failedSlice(); next = retryAfter; }
    if (next === undefined) return;
    timer = setTimeout(() => { timer = undefined; sweep = true; kick(); }, Math.min(2_147_483_647, Math.max(0, Math.max(next, retryAfter) - now()))); timer.unref();
  };
  const kick = () => {
    if (closing || running) return;
    if (now() < retryAfter) { arm(); return; }
    running = Promise.resolve().then(async () => {
      const started = performance.now();
      while (!closing && (targets.length || sweep)) {
        const target = targets.shift(); if (!target) sweep = false;
        const count = await replayUpkeepAccounting(db, defaults.write, { ...defaults, ...target, closing: () => closing, stopped: () => abandoned });
        if (closing) return;
        const due = dueAt(); failedSlices = 0; retryAfter = 0;
        report(count);
        if ((due ?? Infinity) <= now()) sweep = true;
        if (performance.now() - started >= 200) break;
      }
    }).catch(() => { if (!closing) failedSlice(); })
      .finally(() => { running = undefined; arm(); });
  };
  return {
    schedule(target: { operationId?: string; phase?: "dispatch" | "result" } = {}) {
      if (closing) return;
      clearTimer();
      if (target.operationId && targets.length < BATCH_LIMIT) targets.push(target);
      else sweep = true;
      kick();
    },
    async flush() {
      while (!closing && (running || targets.length || sweep)) {
        if (now() < retryAfter) return; // Flush current due work, not future backoff.
        kick(); await running;
      }
    },
    async close(waitMs = 1_000) {
      closing = true; clearTimer(); targets.length = 0; sweep = false;
      if (running) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([running, new Promise<void>(resolve => { timeout = setTimeout(resolve, Math.max(0, waitMs)); })]); }
        finally { if (timeout) clearTimeout(timeout); }
      }
      abandoned = true; // No late origin observation/ack may touch a closed DB.
    },
  };
}
