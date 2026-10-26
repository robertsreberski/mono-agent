import type { LedgerProgress } from "../tool-history/continuity-contracts.js";
import { createProgressSchema, dispatchProgress } from "./progress.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ContinuityUpkeepReceipt } from "@mono-agent/turn/host";
import { LedgerError } from "./ledger-error.js";
import { ledgerHash } from "./ledger.js";

export interface UpkeepScope { readonly logicalId: string; readonly conversationId: string }
export interface UpkeepFence extends UpkeepScope {
  readonly databaseId: string; readonly incarnation: string; readonly fence: number; readonly ownerToken: string;
}
export interface UpkeepAdmission extends UpkeepFence { readonly bootstrap: boolean; readonly uncertain?: boolean }
export interface UpkeepReservation extends UpkeepFence {
  readonly operationId: string; readonly runId: string; readonly recorderNamespace: string;
  readonly model: string; readonly manifest: string; readonly parent: string | null;
  readonly budget: "bootstrap" | "incremental"; readonly progress?: LedgerProgress;
}
export type UpkeepMutation =
  | { readonly kind: "inspect"; readonly scope: UpkeepScope }
  | { readonly kind: "claim"; readonly expected: UpkeepFence; readonly ownerToken: string }
  | { readonly kind: "reserve"; readonly reservation: UpkeepReservation }
  | { readonly kind: "dispatch"; readonly reservation: UpkeepReservation }
  | { readonly kind: "outcome"; readonly reservation: UpkeepReservation; readonly receipt: ContinuityUpkeepReceipt };
type Row = Record<string, any>;
const NON_INVOCATION = new Set(["model_identity", "input_budget", "cap_unsupported", "model_headroom"]);
function fail(): never { throw new Error("upkeep_admission_conflict"); }

/** Additive v3 tables. Never attached to ledger/source cascades or retention.
 * Exhaustion stops admission rather than discarding anti-repurchase evidence. */
export function createUpkeepSchema(db: DatabaseSync): void {
  createProgressSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS continuity_upkeep_identity (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS continuity_upkeep_scopes (
      logical_id TEXT NOT NULL, conversation_id TEXT NOT NULL, incarnation TEXT NOT NULL,
      fence INTEGER NOT NULL, owner_token TEXT NOT NULL,
      PRIMARY KEY(logical_id,conversation_id));
    CREATE TABLE IF NOT EXISTS continuity_upkeep_admissions (
      logical_id TEXT NOT NULL, conversation_id TEXT NOT NULL, incarnation TEXT NOT NULL, bootstrap_operation TEXT,
      PRIMARY KEY(logical_id,conversation_id,incarnation));
    CREATE TABLE IF NOT EXISTS continuity_upkeep_operations (
      operation_id TEXT PRIMARY KEY, logical_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      incarnation TEXT NOT NULL, fence INTEGER NOT NULL, owner_token TEXT NOT NULL,
      reservation TEXT NOT NULL, selection_key TEXT NOT NULL, budget TEXT NOT NULL,
      state TEXT NOT NULL, outcome TEXT);
    CREATE INDEX IF NOT EXISTS continuity_upkeep_scope_operations ON continuity_upkeep_operations(logical_id,conversation_id,incarnation);`);
  if (!db.prepare("SELECT id FROM continuity_upkeep_identity").get()) db.prepare("INSERT INTO continuity_upkeep_identity VALUES (?)").run(randomUUID());
}
function scopeRow(db: DatabaseSync, scope: UpkeepScope): Row {
  return db.prepare("SELECT s.*,a.bootstrap_operation FROM continuity_upkeep_scopes s JOIN continuity_upkeep_admissions a USING(logical_id,conversation_id,incarnation) WHERE logical_id=? AND conversation_id=?").get(scope.logicalId, scope.conversationId) as Row ?? fail();
}
function identity(db: DatabaseSync, root: string): string {
  return ledgerHash(JSON.stringify([root, (db.prepare("SELECT id FROM continuity_upkeep_identity").get() as Row).id]));
}
function view(db: DatabaseSync, root: string, scope: UpkeepScope): UpkeepAdmission {
  const row = scopeRow(db, scope);
  return { ...scope, databaseId: identity(db, root), incarnation: row.incarnation, fence: row.fence, ownerToken: row.owner_token, bootstrap: row.bootstrap_operation === null, ...(db.prepare("SELECT 1 FROM continuity_upkeep_operations WHERE logical_id=? AND conversation_id=? AND incarnation=? AND state IN ('dispatch_started','uncertain')").get(scope.logicalId, scope.conversationId, row.incarnation) ? { uncertain: true } : {}) };
}
export function assertUpkeepFence(db: DatabaseSync, root: string, fence: UpkeepFence): Row {
  const row = scopeRow(db, fence);
  if (identity(db, root) !== fence.databaseId || row.incarnation !== fence.incarnation || row.fence !== fence.fence || row.owner_token !== fence.ownerToken) fail();
  return row;
}
function operation(db: DatabaseSync, root: string, reservation: UpkeepReservation): Row {
  assertUpkeepFence(db, root, reservation);
  const row = db.prepare("SELECT * FROM continuity_upkeep_operations WHERE operation_id=?").get(reservation.operationId) as Row;
  if (!row || row.reservation !== JSON.stringify(reservation)) fail();
  return row;
}
export function assertUpkeepPublication(db: DatabaseSync, root: string, reservation: UpkeepReservation): void {
  if (operation(db, root, reservation).state !== "terminal") fail();
}

/** All calls run in the writer's FULL transaction. Claim requires canonical
 * ownership in the caller; expiry of an RPC waiter is NEVER ownership proof. */
export function mutateUpkeep(db: DatabaseSync, root: string, request: UpkeepMutation): UpkeepAdmission | null {
  createUpkeepSchema(db);
  if (request.kind === "inspect") {
    const s = request.scope;
    if (!s.logicalId || !s.conversationId || s.logicalId.length > 4096 || s.conversationId.length > 4096) fail();
    if (!db.prepare("SELECT 1 FROM continuity_upkeep_scopes WHERE logical_id=? AND conversation_id=?").get(s.logicalId, s.conversationId)) {
      if (Number((db.prepare("SELECT count(*) n FROM continuity_upkeep_scopes").get() as Row).n) >= 4096) fail();
      const incarnation = randomUUID();
      db.prepare("INSERT INTO continuity_upkeep_scopes VALUES (?,?,?,0,'')").run(s.logicalId, s.conversationId, incarnation);
      db.prepare("INSERT INTO continuity_upkeep_admissions VALUES (?,?,?,NULL)").run(s.logicalId, s.conversationId, incarnation);
    }
    return view(db, root, s);
  }
  if (request.kind === "claim") {
    const { expected, ownerToken } = request;
    if (!ownerToken || ownerToken.length > 256) fail();
    const row = scopeRow(db, expected);
    // Identical acknowledgement replay, including after the caller lost its waiter.
    if (identity(db, root) === expected.databaseId && row.incarnation === expected.incarnation && row.fence === expected.fence + 1 && row.owner_token === ownerToken) return view(db, root, expected);
    assertUpkeepFence(db, root, expected);
    db.prepare("UPDATE continuity_upkeep_scopes SET fence=fence+1,owner_token=? WHERE logical_id=? AND conversation_id=?").run(ownerToken, expected.logicalId, expected.conversationId);
    // Only this newly installed fence can release pre-barrier reservations.
    db.prepare("UPDATE continuity_upkeep_operations SET state='released' WHERE logical_id=? AND conversation_id=? AND incarnation=? AND state='reserved'").run(expected.logicalId, expected.conversationId, expected.incarnation);
    return view(db, root, expected);
  }
  const r = request.reservation, scope = assertUpkeepFence(db, root, r), serialized = JSON.stringify(r);
  if (Buffer.byteLength(serialized) > 131072 || !r.operationId || !r.runId || !r.recorderNamespace || !r.model || !/^[a-f0-9]{64}$/u.test(r.manifest)) fail();
  if (request.kind === "reserve") {
    const old = db.prepare("SELECT reservation FROM continuity_upkeep_operations WHERE operation_id=?").get(r.operationId) as Row | undefined;
    if (old) { if (old.reservation !== serialized) fail(); return null; }
    // Reserve bytes for the largest future outcome; acknowledgement replay is free.
    if (Number((db.prepare("SELECT coalesce(sum(length(CAST(reservation AS BLOB))+16384),0) n FROM continuity_upkeep_operations").get() as Row).n) + Buffer.byteLength(serialized) + 16384 > 32 * 1024 * 1024) fail();
    if (r.budget !== (scope.bootstrap_operation === null ? "bootstrap" : "incremental")) fail();
    // Until progressive source reconciliation exists, conservatively stop this
    // scope on unresolved dispatch. A smaller incremental selection must not
    // repurchase part of an uncertain 128k bootstrap after restart.
    if (db.prepare("SELECT 1 FROM continuity_upkeep_operations WHERE logical_id=? AND conversation_id=? AND incarnation=? AND state IN ('dispatch_started','uncertain')").get(r.logicalId, r.conversationId, r.incarnation)) throw new LedgerError("upkeep_repeat_suppressed");
    const key = ledgerHash(JSON.stringify([r.manifest, r.parent]));
    // Model changes, lost receipts and restarts do not repurchase uncertain work.
    if (db.prepare("SELECT 1 FROM continuity_upkeep_operations WHERE logical_id=? AND conversation_id=? AND incarnation=? AND selection_key=? AND state<>'released'").get(r.logicalId, r.conversationId, r.incarnation, key)) throw new LedgerError("upkeep_repeat_suppressed");
    if (Number((db.prepare("SELECT count(*) n FROM continuity_upkeep_operations").get() as Row).n) >= 16384) fail();
    db.prepare("INSERT INTO continuity_upkeep_operations VALUES (?,?,?,?,?,?,?,?,?,'reserved',NULL)").run(r.operationId, r.logicalId, r.conversationId, r.incarnation, r.fence, r.ownerToken, serialized, key, r.budget);
    return null;
  }
  const row = operation(db, root, r);
  if (request.kind === "dispatch") {
    if (row.state === "dispatch_started") return null;
    if (row.state !== "reserved") fail();
    if (r.budget === "bootstrap") {
      if (scope.bootstrap_operation !== null) fail();
      db.prepare("UPDATE continuity_upkeep_admissions SET bootstrap_operation=? WHERE logical_id=? AND conversation_id=?").run(r.operationId, r.logicalId, r.conversationId);
    }
    dispatchProgress(db, r);
    db.prepare("UPDATE continuity_upkeep_operations SET state='dispatch_started' WHERE operation_id=?").run(r.operationId);
    return null;
  }
  if (request.receipt.operationId !== r.operationId || request.receipt.model !== r.model) fail();
  const outcome = JSON.stringify(request.receipt);
  if (Buffer.byteLength(outcome) > 16384) fail();
  if (row.outcome !== null) { if (row.outcome !== outcome) fail(); return null; }
  if (row.state !== "dispatch_started") fail();
  const released = !request.receipt.providerInvoked && request.receipt.status === "skipped" && NON_INVOCATION.has(request.receipt.reason);
  db.prepare("UPDATE continuity_upkeep_operations SET state=?,outcome=? WHERE operation_id=?").run(released ? "released" : request.receipt.providerInvoked ? "terminal" : "uncertain", outcome, r.operationId);
  db.prepare("UPDATE continuity_upkeep_offers SET state=? WHERE operation_id=?").run(released ? "unrepresented" : request.receipt.providerInvoked ? "failed" : "uncertain", r.operationId);
  if (released && scope.bootstrap_operation === r.operationId) db.prepare("UPDATE continuity_upkeep_admissions SET bootstrap_operation=NULL WHERE logical_id=? AND conversation_id=?").run(r.logicalId, r.conversationId);
  return null;
}

/** Explicit user reset/delete only. Keep a tombstone incarnation so queued old
 * claims, reservations, outcomes and publications cannot resurrect deleted state. */
export function resetUpkeep(db: DatabaseSync, kind: "logical" | "physical", id: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_scopes'").get()) return;
  const column = kind === "logical" ? "logical_id" : "conversation_id";
  db.prepare(`DELETE FROM continuity_upkeep_offers WHERE ${column}=?`).run(id);
  db.prepare(`DELETE FROM continuity_upkeep_progress WHERE ${column}=?`).run(id);
  db.prepare(`DELETE FROM continuity_upkeep_operations WHERE ${column}=?`).run(id);
  db.prepare(`DELETE FROM continuity_upkeep_admissions WHERE ${column}=?`).run(id);
  db.prepare(`UPDATE continuity_upkeep_scopes SET incarnation=?,fence=fence+1,owner_token='' WHERE ${column}=?`).run(randomUUID(), id);
  db.prepare(`INSERT INTO continuity_upkeep_admissions SELECT logical_id,conversation_id,incarnation,NULL FROM continuity_upkeep_scopes WHERE ${column}=?`).run(id);
}
