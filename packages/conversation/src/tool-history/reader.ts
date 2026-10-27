import { scanLedgerHistory } from "./ranked-scan.js";
import { readLedger } from "../continuity/ledger-storage.js";
import { inspectContinuityPurges, pendingContinuityPurges } from "./continuity-purge.js";
import { redactJsonValue } from "@mono-agent/observability";
import type { RuntimeToolLifecycleTerminalState } from "@mono-agent/turn/host/types";
import { existsSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toolHistoryArtifactAvailable } from "./artifacts.js";
import { TOOL_HISTORY_APPLICATION_ID, TOOL_HISTORY_DATABASE, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_USER_VERSION, type ToolHistoryArtifactReference, type ToolHistoryGetInput, type ToolHistoryGetResult, type ToolHistoryProjectionItem, type ToolHistoryRecordProjection, type ToolHistorySearchCursor, type ToolHistorySearchInput, type ToolHistorySearchItem, type ToolHistorySearchPage, type ToolHistoryStats } from "./contracts.js";
import { ToolHistoryWriterError } from "./errors.js";
import { assertSecureReadableDirectory, assertSecureReadableFile, normalizeId } from "./paths.js";
import { reasonOf } from "./writer.js";

import { CONTINUITY_USER_VERSION, type ContinuitySnapshotInput, type ContinuitySnapshot, type ContinuityCoverageGap, type ContinuityGapReason, type ContinuityGetInput, type ContinuityGetResult, type ContinuityRecordMetadata, type ContinuityScope, type ContinuitySearchInput, type ContinuitySearchPage } from "./continuity-contracts.js";
import { snapshotContinuity, continuitySnapshotVisible, getContinuity, latestContinuitySummary, searchContinuity } from "./continuity-reader.js";
import { assertContinuitySchema, hasContinuitySchema, readContinuityStats } from "./continuity-storage.js";

/** Read-only bounded query surface used by projection, SessionHistory, purge, and doctor. */
export class ToolHistoryReader {
  readonly root: string;
  readonly databasePath: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new TypeError("tool history root must be absolute.");
    this.root = resolve(root);
    this.databasePath = join(this.root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
  }

  /** Startup discovery only: never creates a database, schema, or paid work. */
  hasPendingUpkeepAccounting(): boolean {
    const db = this.openReadOnly({ zeroLengthAsAbsent: true, upgradePendingAsAbsent: true });
    if (!db) return false;
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_accounting'").get()) {
        const migrated = (db.prepare("PRAGMA table_info(continuity_upkeep_accounting)").all() as { name: string }[]).some(c => c.name === "next_attempt_ms");
        return !!db.prepare(`SELECT 1 FROM continuity_upkeep_accounting WHERE exported IS NULL${migrated ? " AND (attempts>=3 OR next_attempt_ms<=?)" : ""} LIMIT 1`).get(...(migrated ? [Date.now()] : []));
      }
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_operations'").get()) return false;
      return !!db.prepare("SELECT 1 FROM continuity_upkeep_operations WHERE state IN ('dispatch_started','uncertain','terminal') OR outcome IS NOT NULL LIMIT 1").get();
    } finally { db.close(); }
  }

  /** Read-only, content-free doctor surface, independent of runtime enablement. */
  continuityPurgeStatus(): { pending: number; invalid: number } {
    const result = inspectContinuityPurges(this.root);
    return { pending: result.pending.length, invalid: result.invalid };
  }

  protectedContinuityConversations(): readonly string[] {
    const database = this.openReadOnly();
    if (database === undefined) return [];
    try {
      if (!hasContinuitySchema(database)) return [];
      // Canonical active markers / dirty fences protect in-flight preparations.
      // A stranded preparation alone is not an indefinite retention lease.
      const rows = database.prepare(`SELECT DISTINCT g.conversation_id FROM continuity_generations g WHERE EXISTS (SELECT 1 FROM continuity_records r JOIN continuity_pins p USING(record_id) WHERE r.generation_id=g.generation_id AND p.owner_kind<>'summary')`).all() as Record<string, unknown>[];
      return rows.map((r) => r.conversation_id as string);
    } finally { database.close(); }
  }

  continuityGaps(logicalConversationId: string, limit = 10): { total: number; items: readonly ContinuityCoverageGap[] } {
    normalizeId(logicalConversationId, "logicalConversationId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new TypeError("Invalid continuity gap limit.");
    const database = this.openReadOnly();
    if (database === undefined) return { total: 0, items: [] };
    try {
      if (!hasContinuitySchema(database)) return { total: 0, items: [] };
      const total = Number((database.prepare("SELECT count(*) count FROM continuity_generations WHERE logical_id=? AND state='abandoned'").get(logicalConversationId) as Record<string, unknown>).count);
      const rows = database.prepare("SELECT generation_id,before_digest,after_digest,observed_digest,abandoned_at_ms,gap_reason FROM continuity_generations WHERE logical_id=? AND state='abandoned' ORDER BY abandoned_at_ms DESC,generation_id DESC LIMIT ?").all(logicalConversationId, limit) as Record<string, unknown>[];
      return { total, items: rows.map((r) => ({ generationId: r.generation_id as string, beforeDigest: r.before_digest as string | null,
        afterDigest: r.after_digest as string | null, observedDigest: r.observed_digest as string | null,
        detectedAtMs: Number(r.abandoned_at_ms), reason: r.gap_reason as ContinuityGapReason })) };
    } finally { database.close(); }
  }

  /** Also rechecked when a frozen pack is reused: purge always wins over caching. */
  continuitySuppressed(scope: ContinuityScope): boolean { return this.continuityPurgePending(scope); }

  continuitySnapshotVisible(input: ContinuitySnapshotInput, snapshot: ContinuitySnapshot): boolean {
    if (this.continuityPurgePending(input)) return false;
    const database = this.openReadOnly();
    if (!database) return false;
    try { return continuitySnapshotVisible(database, input, snapshot); } finally { database.close(); }
  }

  ledger(scope: ContinuityScope): ReturnType<typeof readLedger> {
    if (this.continuityPurgePending(scope)) return undefined;
    const database = this.openReadOnly(); if (!database) return undefined;
    try { database.exec("BEGIN"); const result = readLedger(database, scope); database.exec("COMMIT");
      return this.continuityPurgePending(scope) ? undefined : result;
    } finally { database.close(); }
  }

  snapshotContinuity(input: ContinuitySnapshotInput): ContinuitySnapshot {
    if (this.continuityPurgePending(input)) return { records: [], omitted: 0, gaps: 1, degradedReason: "purge_pending" };
    const database = this.openReadOnly();
    if (!database) return { records: [], omitted: 0, gaps: 1, degradedReason: "unavailable" };
    try {
      let snapshot: ContinuitySnapshot;
      if (input.selection === "upkeep") snapshot = scanLedgerHistory(database, input);
      else { database.exec("BEGIN"); snapshot = snapshotContinuity(database, input); database.exec("COMMIT"); }
      return this.continuityPurgePending(input) ? { records: [], omitted: 0, gaps: 1, degradedReason: "purge_pending" } : snapshot;
    } finally { database.close(); }
  }

  searchContinuity(input: ContinuitySearchInput): ContinuitySearchPage {
    if (this.continuityPurgePending(input)) return { available: false, items: [] };
    const database = this.openReadOnly();
    if (database === undefined) return { available: false, items: [] };
    try { return searchContinuity(database, input); } finally { database.close(); }
  }

  getContinuity(input: ContinuityGetInput): ContinuityGetResult {
    if (this.continuityPurgePending(input)) return { status: "unavailable", untrusted: true };
    const database = this.openReadOnly();
    if (database === undefined) return { status: "unavailable", untrusted: true };
    try { return getContinuity(database, input); } finally { database.close(); }
  }

  latestContinuitySummary(scope: ContinuityScope): ContinuityRecordMetadata | undefined {
    if (this.continuityPurgePending(scope)) return undefined;
    const database = this.openReadOnly();
    if (database === undefined) return undefined;
    try { return latestContinuitySummary(database, scope); } finally { database.close(); }
  }

  private continuityPurgePending(scope: ContinuityScope): boolean {
    try {
      const purges = pendingContinuityPurges(this.root);
      if (purges.some(purge => purge.conversationId === (purge.scope === "logical" ? scope.logicalConversationId : scope.currentConversationId))) return true;
      if (!purges.some(purge => purge.scope === "physical")) return false;
      const database = this.openReadOnly();
      if (!database) return false;
      try {
        return hasContinuitySchema(database) && purges.some(purge => purge.scope === "physical" && database.prepare(
          "SELECT 1 FROM continuity_generations WHERE conversation_id=? AND logical_id=? LIMIT 1"
        ).get(purge.conversationId, scope.logicalConversationId) !== undefined);
      } finally { database.close(); }
    } catch { return true; } // An unreadable purge intent cannot authorize disclosure.
  }

  async exists(): Promise<boolean> {
    try {
      const info = await lstat(this.databasePath);
      return info.isFile() && !info.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  search(input: ToolHistorySearchInput): ToolHistorySearchPage {
    const database = this.openReadOnly();
    if (database === undefined) return { items: [] };
    try {
      return this.searchFromDatabase(database, input);
    } finally {
      database.close();
    }
  }

  get(input: ToolHistoryGetInput): ToolHistoryGetResult {
    const database = this.openReadOnly();
    if (database === undefined) return { untrusted: true };
    try {
      return this.getFromDatabase(database, input);
    } finally {
      database.close();
    }
  }

  latestProjection(
    logicalConversationId: string,
    currentConversationId: string,
    currentRunId: string,
    limit = 32,
  ): readonly ToolHistoryProjectionItem[] {
    // Automatic enrichment is allowed to treat a crash-stale zero-byte file as
    // pristine. Explicit search/get/stats continue through the fail-closed path.
    const database = this.openReadOnly({ zeroLengthAsAbsent: true });
    if (database === undefined) return [];
    try {
      const calls: ToolHistorySearchItem[] = [];
      let before: ToolHistorySearchCursor | undefined;
      while (calls.length < Math.min(32, limit)) {
        const page = this.searchFromDatabase(database, {
          logicalConversationId,
          currentConversationId,
          currentRunId,
          limit: Math.min(10, Math.min(32, limit) - calls.length),
          ...(before === undefined ? {} : { before }),
        });
        calls.push(...page.items);
        if (page.next === undefined) break;
        before = page.next;
      }
      return calls.map((call) => ({
        call,
        invocation: this.completeRecordFromDatabase(database, {
          logicalConversationId,
          currentConversationId,
          currentRunId,
          recordId: call.recordId,
        }),
        ...(call.resultRecordId === undefined
          ? {}
          : {
            result: this.completeRecordFromDatabase(database, {
              logicalConversationId,
              currentConversationId,
              currentRunId,
              recordId: call.resultRecordId,
            }),
          }),
      }));
    } finally {
      database.close();
    }
  }

  private completeRecordFromDatabase(
    database: DatabaseSync,
    input: Omit<ToolHistoryGetInput, "chunkBytes" | "chunkOffset">,
  ): ToolHistoryGetResult {
    const first = this.getFromDatabase(database, { ...input, chunkBytes: 8 * 1024 });
    if (first.record === undefined) return first;
    // getFromDatabase already parsed the complete retention-bounded payload.
    // Serialize that one snapshot instead of presenting a prefix as complete
    // or issuing multiple reads that could observe different writer commits.
    const chunk = JSON.stringify(first.record.payload) ?? "null";
    const { nextOffset: _nextOffset, ...complete } = first;
    return { ...complete, chunk };
  }

  stats(): ToolHistoryStats | undefined {
    const database = this.openReadOnly();
    if (database === undefined) return undefined;
    try {
      return readStats(database, this.databasePath);
    } finally {
      database.close();
    }
  }

  private searchFromDatabase(
    database: DatabaseSync,
    input: ToolHistorySearchInput,
  ): ToolHistorySearchPage {
    const limit = Math.min(10, Math.max(1, input.limit ?? 5));
    const clauses = [
      "r.logical_id = ?",
      "NOT (c.conversation_id = ? AND c.run_id = ?)",
      "c.end_seq IS NOT NULL",
    ];
    const values: (string | number)[] = [
      normalizeId(input.logicalConversationId, "logicalConversationId"),
      normalizeId(input.currentConversationId, "currentConversationId"),
      normalizeId(input.currentRunId, "currentRunId"),
    ];
    if (input.includeIsolated !== true) clauses.push("r.isolated = 0");
    if (input.before !== undefined) {
      const before = input.before;
      clauses.push(`(
        r.started_at_ms < ?
        OR (r.started_at_ms = ? AND c.run_id < ?)
        OR (r.started_at_ms = ? AND c.run_id = ? AND c.start_seq < ?)
        OR (r.started_at_ms = ? AND c.run_id = ? AND c.start_seq = ? AND c.tool_call_id < ?)
        OR (r.started_at_ms = ? AND c.run_id = ? AND c.start_seq = ? AND c.tool_call_id = ? AND i.record_id < ?)
      )`);
      values.push(
        before.runStartedAtMs,
        before.runStartedAtMs, before.runId,
        before.runStartedAtMs, before.runId, before.startSequence,
        before.runStartedAtMs, before.runId, before.startSequence, before.toolCallId,
        before.runStartedAtMs, before.runId, before.startSequence, before.toolCallId, before.recordId,
      );
    }
    appendListFilter(clauses, values, "c.tool_name", input.tools);
    appendListFilter(clauses, values, "c.state", input.states);
    appendListFilter(clauses, values, "c.run_id", input.runIds);
    if (input.fromMs !== undefined) { clauses.push("c.started_at_ms >= ?"); values.push(input.fromMs); }
    if (input.toMs !== undefined) { clauses.push("c.started_at_ms <= ?"); values.push(input.toMs); }
    const queryTerms = normalizeQueryTerms(input.query);
    for (const term of queryTerms) {
      clauses.push("EXISTS (SELECT 1 FROM tool_records q WHERE q.conversation_id=c.conversation_id AND q.run_id=c.run_id AND q.tool_call_id=c.tool_call_id AND instr(q.search_text, ?) > 0)");
      values.push(term);
    }
    values.push(limit + 1);
    const rows = database.prepare(`
      SELECT c.conversation_id, c.run_id, c.tool_call_id, c.tool_name,
             c.start_seq, c.end_seq, c.state, c.started_at_ms, c.ended_at_ms,
             c.recovered, r.isolated, r.started_at_ms AS run_started_at_ms,
             i.record_id AS invocation_record_id, i.payload_json AS invocation_payload,
             i.truncated AS invocation_truncated,
             o.record_id AS result_record_id, o.payload_json AS result_payload,
             o.truncated AS result_truncated
      FROM tool_calls c
      JOIN runs r ON r.conversation_id=c.conversation_id AND r.run_id=c.run_id
      JOIN tool_records i ON i.conversation_id=c.conversation_id AND i.run_id=c.run_id
        AND i.tool_call_id=c.tool_call_id AND i.phase='invocation'
      LEFT JOIN tool_records o ON o.conversation_id=c.conversation_id AND o.run_id=c.run_id
        AND o.tool_call_id=c.tool_call_id AND o.phase='result'
      WHERE ${clauses.join(" AND ")}
      ORDER BY r.started_at_ms DESC, c.run_id DESC, c.start_seq DESC, c.tool_call_id DESC, i.record_id DESC
      LIMIT ?
    `).all(...values) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => this.searchItem(database, row)),
      ...(hasMore ? { next: searchCursorFromRow(selected.at(-1)) } : {}),
    };
  }

  private getFromDatabase(
    database: DatabaseSync,
    input: ToolHistoryGetInput,
  ): ToolHistoryGetResult {
    const logicalId = normalizeId(input.logicalConversationId, "logicalConversationId");
    const currentConversationId = normalizeId(input.currentConversationId, "currentConversationId");
    const currentRunId = normalizeId(input.currentRunId, "currentRunId");
    const includeIsolated = input.includeIsolated === true ? 1 : 0;
    let row: Record<string, unknown> | undefined;
    if (input.recordId !== undefined) {
      row = database.prepare(`
        SELECT tr.*, c.tool_name, c.state, c.failure_kind, c.detail_code,
               c.started_at_ms, c.ended_at_ms, c.duration_ms, c.recovered, r.isolated,
               r.started_at_ms AS run_started_at_ms
        FROM tool_records tr
        JOIN tool_calls c ON c.conversation_id=tr.conversation_id AND c.run_id=tr.run_id AND c.tool_call_id=tr.tool_call_id
        JOIN runs r ON r.conversation_id=c.conversation_id AND r.run_id=c.run_id
        WHERE tr.record_id=? AND r.logical_id=?
          AND NOT (tr.conversation_id=? AND tr.run_id=?) AND c.end_seq IS NOT NULL
          AND (?=1 OR r.isolated=0)
      `).get(input.recordId, logicalId, currentConversationId, currentRunId, includeIsolated) as Record<string, unknown> | undefined;
    } else if (input.toolCallId !== undefined) {
      row = database.prepare(`
        SELECT tr.*, c.tool_name, c.state, c.failure_kind, c.detail_code,
               c.started_at_ms, c.ended_at_ms, c.duration_ms, c.recovered, r.isolated,
               r.started_at_ms AS run_started_at_ms
        FROM tool_records tr
        JOIN tool_calls c ON c.conversation_id=tr.conversation_id AND c.run_id=tr.run_id AND c.tool_call_id=tr.tool_call_id
        JOIN runs r ON r.conversation_id=c.conversation_id AND r.run_id=c.run_id
        WHERE tr.tool_call_id=? AND r.logical_id=?
          AND NOT (tr.conversation_id=? AND tr.run_id=?) AND c.end_seq IS NOT NULL
          AND (?=1 OR r.isolated=0)
        ORDER BY r.started_at_ms DESC, tr.run_id DESC, tr.seq DESC, tr.record_id DESC LIMIT 1
      `).get(input.toolCallId, logicalId, currentConversationId, currentRunId, includeIsolated) as Record<string, unknown> | undefined;
    }
    if (row === undefined && (input.recordId !== undefined || input.toolCallId !== undefined)) {
      const tombstone = input.recordId !== undefined
        ? database.prepare(`
          SELECT t.record_id, t.reason, t.removed_at_ms
          FROM tombstones t JOIN runs r ON r.conversation_id=t.conversation_id AND r.run_id=t.run_id
          WHERE t.record_id=? AND r.logical_id=?
            AND NOT (t.conversation_id=? AND t.run_id=?)
            AND (?=1 OR r.isolated=0)
        `).get(input.recordId, logicalId, currentConversationId, currentRunId, includeIsolated) as Record<string, unknown> | undefined
        : input.toolCallId === undefined
          ? undefined
          : database.prepare(`
          SELECT t.record_id, t.reason, t.removed_at_ms
          FROM tombstones t JOIN runs r ON r.conversation_id=t.conversation_id AND r.run_id=t.run_id
          WHERE t.tool_call_id=? AND r.logical_id=?
            AND NOT (t.conversation_id=? AND t.run_id=?)
            AND (?=1 OR r.isolated=0)
          ORDER BY r.started_at_ms DESC, t.run_id DESC,
            CASE t.phase WHEN 'result' THEN 1 ELSE 0 END DESC, t.record_id DESC LIMIT 1
          `).get(input.toolCallId, logicalId, currentConversationId, currentRunId, includeIsolated) as Record<string, unknown> | undefined;
      if (tombstone !== undefined) {
        return {
          tombstone: {
            recordId: stringField(tombstone, "record_id"),
            reason: stringField(tombstone, "reason"),
            removedAtMs: numberField(tombstone, "removed_at_ms"),
          },
          untrusted: true,
        };
      }
    }
    if (row === undefined) return { untrusted: true };
    const record = this.recordProjection(database, row);
    const serialized = JSON.stringify(record.payload);
    const chunkBytes = Math.min(8 * 1024, Math.max(1, input.chunkBytes ?? 4 * 1024));
    const offset = Math.max(0, input.chunkOffset ?? 0);
    const chunk = utf8Slice(serialized, offset, chunkBytes);
    return {
      record,
      chunk: chunk.text,
      ...(chunk.nextOffset === undefined ? {} : { nextOffset: chunk.nextOffset }),
      untrusted: true,
    };
  }

  private openReadOnly(options: { readonly zeroLengthAsAbsent?: boolean; readonly upgradePendingAsAbsent?: boolean } = {}): DatabaseSync | undefined {
    let database: DatabaseSync | undefined;
    try {
      assertSecureReadableDirectory(join(this.root, TOOL_HISTORY_DIRECTORY));
      const fileSize = assertSecureReadableFile(this.databasePath);
      if (options.zeroLengthAsAbsent === true && fileSize === 0) return undefined;
      database = new DatabaseSync(this.databasePath, { readOnly: true });
      database.exec("PRAGMA busy_timeout=250");
      validateDatabase(database);
      return database;
    } catch (error) {
      database?.close();
      if (options.upgradePendingAsAbsent && error instanceof ToolHistoryWriterError && error.code === "history_schema_unsupported" && error.message.includes("upgrade-pending")) return undefined;
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || reasonOf(error).includes("unable to open database")) return undefined;
      throw error;
    }
  }

  private searchItem(database: DatabaseSync, row: Record<string, unknown>): ToolHistorySearchItem {
    const artifacts = artifactReferences(database, stringField(row, "conversation_id"), stringField(row, "run_id"), stringField(row, "tool_call_id"));
    const invocation = visibleToolPayload(parseJson(stringField(row, "invocation_payload")));
    const result = row.result_payload === null
      ? undefined
      : visibleToolPayload(parseJson(stringField(row, "result_payload")));
    const preview = boundedPreview({ arguments: invocation, result }, 1_024);
    return {
      recordId: stringField(row, "invocation_record_id"),
      ...(row.result_record_id === null ? {} : { resultRecordId: stringField(row, "result_record_id") }),
      conversationId: stringField(row, "conversation_id"),
      runId: stringField(row, "run_id"),
      toolCallId: stringField(row, "tool_call_id"),
      toolName: stringField(row, "tool_name"),
      startSequence: numberField(row, "start_seq"),
      ...(row.end_seq === null ? {} : { endSequence: numberField(row, "end_seq") }),
      ...(row.state === null ? {} : { state: stringField(row, "state") as RuntimeToolLifecycleTerminalState }),
      startedAtMs: numberField(row, "started_at_ms"),
      ...(row.ended_at_ms === null ? {} : { endedAtMs: numberField(row, "ended_at_ms") }),
      isolated: numberField(row, "isolated") === 1,
      recovered: numberField(row, "recovered") === 1,
      preview,
      truncated: numberField(row, "invocation_truncated") === 1 || numberField(row, "result_truncated", 0) === 1,
      artifactReferences: artifacts,
      untrusted: true,
    };
  }

  private recordProjection(database: DatabaseSync, row: Record<string, unknown>): ToolHistoryRecordProjection {
    return {
      recordId: stringField(row, "record_id"),
      conversationId: stringField(row, "conversation_id"),
      runId: stringField(row, "run_id"),
      toolCallId: stringField(row, "tool_call_id"),
      toolName: stringField(row, "tool_name"),
      phase: stringField(row, "phase") as "invocation" | "result",
      sequence: numberField(row, "seq"),
      ...(row.state === null ? {} : { state: stringField(row, "state") as RuntimeToolLifecycleTerminalState }),
      ...(row.failure_kind === null ? {} : { failureKind: stringField(row, "failure_kind") }),
      ...(row.detail_code === null ? {} : { detailCode: stringField(row, "detail_code") }),
      payload: visibleToolPayload(parseJson(stringField(row, "payload_json"))),
      originalBytes: numberField(row, "original_bytes"),
      retainedBytes: numberField(row, "retained_bytes"),
      truncated: numberField(row, "truncated") === 1,
      isolated: numberField(row, "isolated") === 1,
      recovered: numberField(row, "recovered") === 1,
      runStartedAtMs: numberField(row, "run_started_at_ms"),
      ...(row.started_at_ms === null ? {} : { startedAtMs: numberField(row, "started_at_ms") }),
      ...(row.ended_at_ms === null ? {} : { endedAtMs: numberField(row, "ended_at_ms") }),
      ...(row.duration_ms === null ? {} : { executionMs: numberField(row, "duration_ms") }),
      artifactReferences: artifactReferences(database, stringField(row, "conversation_id"), stringField(row, "run_id"), stringField(row, "tool_call_id")),
      untrusted: true,
    };
  }
}

function searchCursorFromRow(row: Record<string, unknown> | undefined): ToolHistorySearchCursor {
  return {
    runStartedAtMs: numberField(row, "run_started_at_ms"),
    runId: stringField(row, "run_id"),
    startSequence: numberField(row, "start_seq"),
    toolCallId: stringField(row, "tool_call_id"),
    recordId: stringField(row, "invocation_record_id"),
  };
}

export async function toolHistoryDiskUsage(root: string): Promise<{ files: number; bytes: number }> {
  const directory = join(resolve(root), TOOL_HISTORY_DIRECTORY);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: 0, bytes: 0 };
    throw error;
  }
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    files += 1;
    bytes += (await stat(join(directory, entry.name))).size;
  }
  return { files, bytes };
}

function validateDatabase(database: DatabaseSync): void {
  const application = database.prepare("PRAGMA application_id").get() as Record<string, unknown>;
  const version = database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  const applicationId = Number(Object.values(application)[0]);
  const userVersion = Number(Object.values(version)[0]);
  if (applicationId === TOOL_HISTORY_APPLICATION_ID && userVersion < TOOL_HISTORY_USER_VERSION) {
    throw new ToolHistoryWriterError(
      "history_schema_unsupported",
      `Tool history schema version ${String(userVersion)} is upgrade-pending; a writer must upgrade it to ${String(TOOL_HISTORY_USER_VERSION)} before read-only access.`,
    );
  }
  if (applicationId !== TOOL_HISTORY_APPLICATION_ID || (userVersion < TOOL_HISTORY_USER_VERSION || userVersion > CONTINUITY_USER_VERSION)) {
    throw new ToolHistoryWriterError(
      "history_schema_unsupported",
      "Tool history schema is unsupported because it is newer or foreign. Downgrade is blocked until persisted conversation state is purged.",
    );
  }
  if (userVersion === CONTINUITY_USER_VERSION) assertContinuitySchema(database);
}

function readStats(database: DatabaseSync, path: string): ToolHistoryStats {
  const limitsRows = database.prepare("SELECT key, value FROM metadata WHERE key LIKE 'limit_%'").all() as Record<string, unknown>[];
  const limits = Object.fromEntries(limitsRows.map((row) => [stringField(row, "key"), Number(row.value)]));
  const counts = database.prepare(`
    SELECT
      (SELECT count(*) FROM tool_calls) calls,
      (SELECT count(*) FROM tool_records) records,
      (SELECT count(*) FROM tombstones) tombstones,
      (SELECT count(*) FROM tool_calls WHERE end_seq IS NULL) dangling,
      (SELECT count(*) FROM tool_calls WHERE synthetic_start=1) orphan_results,
      (SELECT count(*) FROM tool_calls WHERE recovered=1) recovered,
      (SELECT coalesce(sum(retained_bytes),0) FROM tool_records) retained_bytes,
      (SELECT coalesce(sum(value),0) FROM writer_stats WHERE key='write_failures' OR key GLOB 'write_failures:*') write_failures,
      (SELECT coalesce(sum(value),0) FROM writer_stats WHERE key='idempotency_conflicts' OR key GLOB 'idempotency_conflicts:*') idempotency_conflicts,
      (SELECT coalesce(sum(value),0) FROM writer_stats WHERE key='maintenance_failures') maintenance_failures,
      (SELECT coalesce(sum(value),0) FROM writer_stats WHERE key='recovery_failures') recovery_failures
  `).get() as Record<string, unknown>;
  let bytes = 0;
  try { bytes = Number((database.prepare("PRAGMA page_count").get() as Record<string, unknown>).page_count)
      * Number((database.prepare("PRAGMA page_size").get() as Record<string, unknown>).page_size); } catch { /* surfaced by doctor elsewhere */ }
  return {
    calls: numberField(counts, "calls"),
    records: numberField(counts, "records"),
    tombstones: numberField(counts, "tombstones"),
    dangling: numberField(counts, "dangling"),
    orphanResults: numberField(counts, "orphan_results"),
    recovered: numberField(counts, "recovered"),
    writeFailures: numberField(counts, "write_failures"),
    idempotencyConflicts: numberField(counts, "idempotency_conflicts"),
    maintenanceFailures: numberField(counts, "maintenance_failures"),
    recoveryFailures: numberField(counts, "recovery_failures"),
    retainedBytes: numberField(counts, "retained_bytes") + (hasContinuitySchema(database) ? readContinuityStats(database).retainedBytes : 0),
    ...(hasContinuitySchema(database) ? { continuity: readContinuityStats(database) } : {}),
    bytes,
    journalPresent: existsSync(`${path}-journal`),
    limits: {
      maxCompletedCalls: limits.limit_max_completed_calls ?? 100_000,
      maxAgeMs: limits.limit_max_age_ms ?? 365 * 24 * 60 * 60 * 1_000,
      maxBytes: limits.limit_max_bytes ?? 256 * 1024 * 1024,
      maxTombstones: limits.limit_max_tombstones ?? 10_000,
      tombstoneMaxAgeMs: limits.limit_tombstone_max_age_ms ?? 30 * 24 * 60 * 60 * 1_000,
    },
  };
}

export function artifactReferences(database: DatabaseSync, conversationId: string, runId: string, toolCallId: string): ToolHistoryArtifactReference[] {
  const rows = database.prepare(`
    SELECT artifact_id, host_path FROM artifact_refs
    WHERE conversation_id=? AND run_id=? AND tool_call_id=? ORDER BY artifact_id
  `).all(conversationId, runId, toolCallId) as Record<string, unknown>[];
  const metadata = database.prepare("SELECT value FROM metadata WHERE key='artifact_root'").get() as Record<string, unknown> | undefined;
  const artifactRoot = typeof metadata?.value === "string" ? metadata.value : undefined;
  return rows.map((row) => ({
    id: stringField(row, "artifact_id"),
    available: artifactRoot !== undefined && toolHistoryArtifactAvailable(
      stringField(row, "host_path"),
      artifactRoot,
      runId,
    ),
  }));
}

function visibleToolPayload(value: unknown): unknown {
  return redactJsonValue(value, 4 * 1024, {
    contentPatternRedaction: true,
    visibleTextSanitization: {
      omitFilesystemPaths: true,
      omission: "[tool payload omitted because it contained a private host path]",
    },
  });
}

function appendListFilter(clauses: string[], values: (string | number)[], column: string, input: readonly unknown[] | undefined): void {
  if (input === undefined || input.length === 0) return;
  const bounded = input.slice(0, 20).map(String);
  clauses.push(`${column} IN (${bounded.map(() => "?").join(",")})`);
  values.push(...bounded);
}

function normalizeQueryTerms(query: string | undefined): string[] {
  if (query === undefined) return [];
  if (Buffer.byteLength(query, "utf8") > 512) throw new TypeError("SessionHistory query exceeds 512 bytes.");
  return [...new Set(query.toLowerCase().trim().split(/\s+/u).filter(Boolean))].slice(0, 16);
}

function boundedPreview(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(value);
  return utf8Slice(json, 0, maxBytes).text;
}

function utf8Slice(value: string, offset: number, maxBytes: number): { text: string; nextOffset?: number } {
  const encoded = Buffer.from(value, "utf8");
  if (offset >= encoded.byteLength) return { text: "" };
  // Continuation cursors emitted below always land on a scalar boundary. A
  // caller-supplied mid-scalar offset cannot be represented without either
  // splitting or skipping bytes, so terminate that malformed continuation.
  if (isUtf8ContinuationByte(encoded[offset] ?? 0)) return { text: "" };
  const end = Math.min(encoded.byteLength, offset + maxBytes);
  let safeEnd = end;
  while (safeEnd > offset && isUtf8ContinuationByte(encoded[safeEnd] ?? 0)) safeEnd -= 1;
  if (safeEnd === offset) {
    // A requested 1-3 byte page can begin with a wider scalar. Return that one
    // complete scalar (still at most four bytes) so the next cursor advances.
    safeEnd = offset + 1;
    while (safeEnd < encoded.byteLength && isUtf8ContinuationByte(encoded[safeEnd] ?? 0)) safeEnd += 1;
  }
  return {
    text: encoded.subarray(offset, safeEnd).toString("utf8"),
    ...(safeEnd < encoded.byteLength ? { nextOffset: safeEnd } : {}),
  };
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0b1100_0000) === 0b1000_0000;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return "[malformed persisted payload]"; }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  if (typeof value !== "string") throw new Error(`Tool history row is missing ${key}.`);
  return value;
}

function numberField(record: Record<string, unknown> | undefined, key: string, fallback?: number): number {
  const value = Number(record?.[key]);
  if (!Number.isFinite(value)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Tool history row is missing ${key}.`);
  }
  return value;
}
