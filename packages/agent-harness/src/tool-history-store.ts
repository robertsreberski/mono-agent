import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

import { redactJsonValue } from "@mono-agent/observability";
import type {
  RuntimeToolLifecycleEvent,
  RuntimeToolLifecyclePersistence,
  RuntimeToolLifecycleSink,
  RuntimeToolLifecycleTerminalState,
} from "@mono-agent/runtime-adapter";

import {
  canonicalToolArtifactRoot,
  toolHistoryArtifactAvailable,
} from "./tool-history-artifacts.js";

export const TOOL_HISTORY_DIRECTORY = "tool-history";
export const TOOL_HISTORY_DATABASE = "tool-lifecycles.sqlite";
export const TOOL_HISTORY_OWNER_DATABASE = "tool-lifecycles-owner.sqlite";
export const TOOL_HISTORY_SCHEMA = "mono-agent.session-tool-history.v1";
export const TOOL_HISTORY_APPLICATION_ID = 0x4d415448;
export const TOOL_HISTORY_USER_VERSION = 2;
export const TOOL_HISTORY_PERSISTENCE_CEILING_MS = 250;
export const TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS = 10_000;
const TOOL_HISTORY_MAINTENANCE_CEILING_MS = 2_000;

export interface ToolHistoryRetentionOptions {
  readonly maxCompletedCalls?: number;
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
  readonly maxTombstones?: number;
  readonly tombstoneMaxAgeMs?: number;
}

export interface ToolHistoryWriterOptions {
  readonly root: string;
  /** Host-only root under which provider-reported artifact files may exist. */
  readonly artifactRoot?: string;
  readonly retention?: ToolHistoryRetentionOptions;
  readonly persistenceCeilingMs?: number;
  readonly ownerAcquireCeilingMs?: number;
  readonly onWarning?: (message: string) => void;
}

export interface ToolHistoryRunBinding {
  readonly conversationId: string;
  readonly logicalConversationId: string;
  readonly runId: string;
  readonly isolated: boolean;
}

export interface ToolHistoryArtifactReference {
  readonly id: string;
  readonly available: boolean;
}

export interface ToolHistoryRecordProjection {
  readonly recordId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly phase: "invocation" | "result";
  readonly sequence: number;
  readonly state?: RuntimeToolLifecycleTerminalState;
  readonly failureKind?: string;
  readonly detailCode?: string;
  readonly payload: unknown;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
  readonly isolated: boolean;
  readonly recovered: boolean;
  readonly runStartedAtMs: number;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly executionMs?: number;
  readonly artifactReferences: readonly ToolHistoryArtifactReference[];
  readonly untrusted: true;
}

export interface ToolHistorySearchInput {
  readonly logicalConversationId: string;
  readonly currentRunId: string;
  readonly query?: string;
  readonly tools?: readonly string[];
  readonly states?: readonly RuntimeToolLifecycleTerminalState[];
  readonly runIds?: readonly string[];
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly includeIsolated?: boolean;
  readonly limit?: number;
  readonly before?: ToolHistorySearchCursor;
}

export interface ToolHistorySearchCursor {
  readonly runStartedAtMs: number;
  readonly runId: string;
  readonly startSequence: number;
  readonly toolCallId: string;
  /** Opaque invocation id is the final cross-rollover ordering tie-breaker. */
  readonly recordId: string;
}

export interface ToolHistorySearchItem {
  readonly recordId: string;
  readonly resultRecordId?: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startSequence: number;
  readonly endSequence?: number;
  readonly state?: RuntimeToolLifecycleTerminalState;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
  readonly isolated: boolean;
  readonly recovered: boolean;
  readonly preview: string;
  readonly truncated: boolean;
  readonly artifactReferences: readonly ToolHistoryArtifactReference[];
  readonly untrusted: true;
}

export interface ToolHistorySearchPage {
  readonly items: readonly ToolHistorySearchItem[];
  readonly next?: ToolHistorySearchCursor;
}

export interface ToolHistoryProjectionItem {
  readonly call: ToolHistorySearchItem;
  readonly invocation: ToolHistoryGetResult;
  readonly result?: ToolHistoryGetResult;
}

export interface ToolHistoryGetInput {
  readonly logicalConversationId: string;
  readonly currentRunId: string;
  readonly recordId?: string;
  readonly toolCallId?: string;
  readonly includeIsolated?: boolean;
  readonly chunkOffset?: number;
  readonly chunkBytes?: number;
}

export interface ToolHistoryGetResult {
  readonly record?: ToolHistoryRecordProjection;
  readonly tombstone?: {
    readonly recordId: string;
    readonly reason: string;
    readonly removedAtMs: number;
  };
  readonly chunk?: string;
  readonly nextOffset?: number;
  readonly untrusted: true;
}

export interface ToolHistoryStats {
  readonly calls: number;
  readonly records: number;
  readonly tombstones: number;
  readonly dangling: number;
  readonly orphanResults: number;
  readonly recovered: number;
  /** Distinct unresolved lifecycle-write incidents; the matching phase/run retry clears each one. */
  readonly writeFailures: number;
  /** Distinct unresolved conflicts; the matching canonical binding/phase retry clears each one. */
  readonly idempotencyConflicts: number;
  /** Unresolved failures since the latest successful retention pass. */
  readonly maintenanceFailures: number;
  /** Unresolved failures since the latest successful writer recovery. */
  readonly recoveryFailures: number;
  /** Bytes of bounded payload counted by the retention contract. */
  readonly retainedBytes: number;
  /** Physical SQLite allocation, reported separately from retained payload. */
  readonly bytes: number;
  readonly journalPresent: boolean;
  readonly limits: Required<ToolHistoryRetentionOptions>;
}

interface WorkerRequest {
  readonly id: number;
  readonly operation: string;
  readonly payload?: unknown;
}

interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly code?: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

interface RegistryEntry {
  readonly writer: ToolHistoryWriter;
  readonly artifactRoot: string;
  references: number;
}

const PROCESS_WRITERS = new Map<string, Promise<RegistryEntry>>();

export interface ToolHistoryWriterHandle {
  readonly writer: ToolHistoryWriter;
  release(): Promise<void>;
}

/** Share exactly one worker-thread writer per real history root in this process. */
export async function acquireToolHistoryWriter(
  options: ToolHistoryWriterOptions,
): Promise<ToolHistoryWriterHandle> {
  if (!isAbsolute(options.root)) throw new TypeError("tool history root must be absolute.");
  const root = canonicalHistoryRoot(options.root);
  const artifactRoot = normalizedArtifactRoot(options.artifactRoot, root);
  for (;;) {
    let entryPromise = PROCESS_WRITERS.get(root);
    if (entryPromise === undefined) {
      entryPromise = (async () => {
        const writer = await ToolHistoryWriter.open(options);
        return { writer, artifactRoot, references: 0 };
      })();
      PROCESS_WRITERS.set(root, entryPromise);
      entryPromise.catch(() => {
        if (PROCESS_WRITERS.get(root) === entryPromise) PROCESS_WRITERS.delete(root);
      });
    }
    const entry = await entryPromise;
    if (entry.artifactRoot !== artifactRoot) {
      throw new ToolHistoryWriterError(
        "history_artifact_root_mismatch",
        "One canonical history root cannot use multiple artifact roots.",
      );
    }
    // A final release can delete this registry entry while an earlier acquire
    // is suspended on the already-resolved promise. Retry instead of reviving
    // the writer that release is closing.
    if (PROCESS_WRITERS.get(root) !== entryPromise) continue;
    entry.references += 1;
    let released = false;
    return {
      writer: entry.writer,
      async release(): Promise<void> {
        if (released) return;
        released = true;
        entry.references -= 1;
        if (entry.references > 0) return;
        if (PROCESS_WRITERS.get(root) === entryPromise) PROCESS_WRITERS.delete(root);
        await entry.writer.close();
      },
    };
  }
}

export class ToolHistoryWriter {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly persistenceCeilingMs: number;
  private readonly onWarning: ((message: string) => void) | undefined;
  private requestId = 0;
  private closed = false;
  private readonly warnedKinds = new Set<string>();

  private constructor(worker: Worker, options: ToolHistoryWriterOptions) {
    this.worker = worker;
    this.persistenceCeilingMs = positiveInteger(
      options.persistenceCeilingMs ?? TOOL_HISTORY_PERSISTENCE_CEILING_MS,
      "persistenceCeilingMs",
    );
    this.onWarning = options.onWarning;
    worker.on("message", (response: WorkerResponse) => this.handleResponse(response));
    worker.on("error", (error) => {
      this.closed = true;
      this.failPending(new ToolHistoryWriterError(workerErrorCode(error), reasonOf(error)));
    });
    worker.on("exit", (code) => {
      const wasClosed = this.closed;
      this.closed = true;
      if (this.pending.size > 0) {
        this.failPending(new Error(`Tool history writer exited with code ${String(code)}.`));
      } else if (!wasClosed && code !== 0) {
        this.failPending(new Error(`Tool history writer exited with code ${String(code)}.`));
      }
    });
  }

  static async open(options: ToolHistoryWriterOptions): Promise<ToolHistoryWriter> {
    if (!isAbsolute(options.root)) throw new TypeError("tool history root must be absolute.");
    const lexicalRoot = resolve(options.root);
    const root = canonicalHistoryRoot(options.root);
    const lexicalArtifactRoot = requestedArtifactRoot(options.artifactRoot, lexicalRoot);
    const artifactRoot = canonicalToolArtifactRoot(lexicalArtifactRoot);
    const workerUrl = import.meta.url.endsWith(".ts")
      ? new URL("../dist/tool-history-writer-worker.js", import.meta.url)
      : new URL("./tool-history-writer-worker.js", import.meta.url);
    if (import.meta.url.endsWith(".ts")) {
      assertToolHistoryWorkerBuildFresh(
        fileURLToPath(new URL("./tool-history-writer-worker.ts", import.meta.url)),
        fileURLToPath(workerUrl),
      );
    }
    const worker = new Worker(workerUrl, {
      workerData: {
        root,
        artifactRoot,
        artifactRootAliases: [artifactRoot, lexicalArtifactRoot],
        retention: options.retention,
        ownerAcquireCeilingMs: options.ownerAcquireCeilingMs ?? TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS,
      },
    });
    const writer = new ToolHistoryWriter(worker, options);
    try {
      await writer.request("ready", undefined, (options.ownerAcquireCeilingMs ?? TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS) + 1_000);
      // request() releases the startup reference once the pending map drains.
      // An idle sidecar must not prolong a one-shot CLI process; every later
      // awaited operation temporarily references it again until it settles.
      return writer;
    } catch (error) {
      writer.closed = true;
      await worker.terminate().catch(() => undefined);
      throw error;
    }
  }

  createSink(binding: ToolHistoryRunBinding): RuntimeToolLifecycleSink {
    return async (event) => await this.persist(binding, event);
  }

  async persist(
    binding: ToolHistoryRunBinding,
    event: RuntimeToolLifecycleEvent,
  ): Promise<RuntimeToolLifecyclePersistence> {
    try {
      const value = await this.request(
        event.phase === "invocation" ? "invocation" : "result",
        { binding, event },
        this.persistenceCeilingMs,
      ) as RuntimeToolLifecyclePersistence;
      return value;
    } catch (error) {
      const code = error instanceof ToolHistoryWriterError ? error.code : "history_write_failed";
      this.warnOnce(code, `Tool lifecycle persistence failed (${code}); streaming continues with an explicit failure marker.`);
      if (code !== "history_idempotency_conflict") {
        this.postBestEffort("write_failure", {
          binding,
          phase: event.phase,
          toolCallId: event.toolCallId,
          code,
          message: reasonOf(error),
        });
      }
      return { persistence: "failed", errorCode: code };
    }
  }

  async finishRun(binding: ToolHistoryRunBinding, status: string, failureKind?: string): Promise<void> {
    await this.request("finish_run", { binding, status, failureKind }, this.persistenceCeilingMs).catch((error) => {
      this.warnOnce("run_finalize_failed", `Tool history run finalization failed: ${reasonOf(error)}`);
      this.postBestEffort("write_failure", {
        binding,
        phase: "finish_run",
        status,
        code: "run_finalize_failed",
        message: reasonOf(error),
      });
    });
  }

  async resetConversation(logicalConversationId: string): Promise<void> {
    await this.request(
      "reset_conversation",
      { logicalConversationId },
      TOOL_HISTORY_MAINTENANCE_CEILING_MS,
    );
  }

  async stats(): Promise<ToolHistoryStats> {
    return await this.request("stats", undefined, TOOL_HISTORY_MAINTENANCE_CEILING_MS) as ToolHistoryStats;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.request("close", undefined, TOOL_HISTORY_MAINTENANCE_CEILING_MS).catch(() => undefined);
    await this.worker.terminate().catch(() => undefined);
  }

  private async request(operation: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed && operation !== "close") throw new ToolHistoryWriterError("history_writer_closed", "Tool history writer is closed.");
    const id = ++this.requestId;
    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.unrefIfIdle();
        rejectPromise(new ToolHistoryWriterError(
          "history_persistence_timeout",
          `Tool history ${operation} exceeded the ${String(timeoutMs)} ms host wait ceiling.`,
        ));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.worker.ref();
      try {
        this.worker.postMessage({ id, operation, ...(payload === undefined ? {} : { payload }) } satisfies WorkerRequest);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        this.unrefIfIdle();
        rejectPromise(error);
      }
    });
  }

  private postBestEffort(operation: string, payload: unknown): void {
    if (this.closed) return;
    try { this.worker.postMessage({ id: ++this.requestId, operation, payload } satisfies WorkerRequest); }
    catch { /* a failed writer cannot persist its own degradation counter */ }
  }

  private handleResponse(response: WorkerResponse): void {
    if (response.id === 0 && !response.ok) {
      this.failPending(new ToolHistoryWriterError(
        response.code ?? "history_writer_start_failed",
        response.error ?? "Tool history writer failed during startup.",
      ));
      return;
    }
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new ToolHistoryWriterError(response.code ?? "history_write_failed", response.error ?? "Tool history operation failed."));
    this.unrefIfIdle();
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.unrefIfIdle();
  }

  private unrefIfIdle(): void {
    if (this.pending.size === 0) this.worker.unref();
  }

  private warnOnce(kind: string, message: string): void {
    if (this.warnedKinds.has(kind)) return;
    this.warnedKinds.add(kind);
    try { this.onWarning?.(message); } catch { /* diagnostics are best-effort */ }
  }
}

/** Vitest runs source TS but the worker must execute compiled JS. Fail stale. */
export function assertToolHistoryWorkerBuildFresh(sourcePath: string, distPath: string): void {
  let sourceMtime: number;
  let distMtime: number;
  try {
    sourceMtime = statSync(sourcePath).mtimeMs;
    distMtime = statSync(distPath).mtimeMs;
  } catch {
    throw new ToolHistoryWriterError(
      "history_worker_build_stale",
      "Tool history worker output is missing; build @mono-agent/agent-harness before focused tests.",
    );
  }
  if (distMtime < sourceMtime) {
    throw new ToolHistoryWriterError(
      "history_worker_build_stale",
      "Tool history worker output predates its source; rebuild @mono-agent/agent-harness before focused tests.",
    );
  }
}

export class ToolHistoryWriterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolHistoryWriterError";
    this.code = code;
  }
}

/** Read-only bounded query surface used by projection, SessionHistory, purge, and doctor. */
export class ToolHistoryReader {
  readonly root: string;
  readonly databasePath: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new TypeError("tool history root must be absolute.");
    this.root = resolve(root);
    this.databasePath = join(this.root, TOOL_HISTORY_DIRECTORY, TOOL_HISTORY_DATABASE);
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
        invocation: this.getFromDatabase(database, {
          logicalConversationId,
          currentRunId,
          recordId: call.recordId,
          chunkBytes: 2 * 1024,
        }),
        ...(call.resultRecordId === undefined
          ? {}
          : {
            result: this.getFromDatabase(database, {
              logicalConversationId,
              currentRunId,
              recordId: call.resultRecordId,
              chunkBytes: 4 * 1024,
            }),
          }),
      }));
    } finally {
      database.close();
    }
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
    const clauses = ["r.logical_id = ?", "c.run_id <> ?", "c.end_seq IS NOT NULL"];
    const values: (string | number)[] = [
      normalizeId(input.logicalConversationId, "logicalConversationId"),
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
        WHERE tr.record_id=? AND r.logical_id=? AND tr.run_id<>? AND c.end_seq IS NOT NULL
          AND (?=1 OR r.isolated=0)
      `).get(input.recordId, logicalId, currentRunId, includeIsolated) as Record<string, unknown> | undefined;
    } else if (input.toolCallId !== undefined) {
      row = database.prepare(`
        SELECT tr.*, c.tool_name, c.state, c.failure_kind, c.detail_code,
               c.started_at_ms, c.ended_at_ms, c.duration_ms, c.recovered, r.isolated,
               r.started_at_ms AS run_started_at_ms
        FROM tool_records tr
        JOIN tool_calls c ON c.conversation_id=tr.conversation_id AND c.run_id=tr.run_id AND c.tool_call_id=tr.tool_call_id
        JOIN runs r ON r.conversation_id=c.conversation_id AND r.run_id=c.run_id
        WHERE tr.tool_call_id=? AND r.logical_id=? AND tr.run_id<>? AND c.end_seq IS NOT NULL
          AND (?=1 OR r.isolated=0)
        ORDER BY r.started_at_ms DESC, tr.run_id DESC, tr.seq DESC, tr.record_id DESC LIMIT 1
      `).get(input.toolCallId, logicalId, currentRunId, includeIsolated) as Record<string, unknown> | undefined;
    }
    if (row === undefined && (input.recordId !== undefined || input.toolCallId !== undefined)) {
      const tombstone = input.recordId !== undefined
        ? database.prepare(`
          SELECT t.record_id, t.reason, t.removed_at_ms
          FROM tombstones t JOIN runs r ON r.conversation_id=t.conversation_id AND r.run_id=t.run_id
          WHERE t.record_id=? AND r.logical_id=? AND t.run_id<>?
            AND (?=1 OR r.isolated=0)
        `).get(input.recordId, logicalId, currentRunId, includeIsolated) as Record<string, unknown> | undefined
        : input.toolCallId === undefined
          ? undefined
          : database.prepare(`
          SELECT t.record_id, t.reason, t.removed_at_ms
          FROM tombstones t JOIN runs r ON r.conversation_id=t.conversation_id AND r.run_id=t.run_id
          WHERE t.tool_call_id=? AND r.logical_id=? AND t.run_id<>?
            AND (?=1 OR r.isolated=0)
          ORDER BY r.started_at_ms DESC, t.run_id DESC,
            CASE t.phase WHEN 'result' THEN 1 ELSE 0 END DESC, t.record_id DESC LIMIT 1
          `).get(input.toolCallId, logicalId, currentRunId, includeIsolated) as Record<string, unknown> | undefined;
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

  private openReadOnly(options: { readonly zeroLengthAsAbsent?: boolean } = {}): DatabaseSync | undefined {
    try {
      assertSecureReadableDirectory(join(this.root, TOOL_HISTORY_DIRECTORY));
      const fileSize = assertSecureReadableFile(this.databasePath);
      if (options.zeroLengthAsAbsent === true && fileSize === 0) return undefined;
      const database = new DatabaseSync(this.databasePath, { readOnly: true });
      database.exec("PRAGMA busy_timeout=250");
      validateDatabase(database);
      return database;
    } catch (error) {
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

function assertSecureReadableDirectory(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history directory must be a non-symlink directory.");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && Number(info.uid) !== uid) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history directory must be owned by the current user.");
  }
  if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== 0o700) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history directory must have mode 0700.");
  }
}

function assertSecureReadableFile(path: string): number {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || Number(info.nlink) !== 1) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history database must be a single-link non-symlink regular file.");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && Number(info.uid) !== uid) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history database must be owned by the current user.");
  }
  if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== 0o600) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history database must have mode 0600.");
  }
  return Number(info.size);
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

export function toolHistoryRecordId(
  conversationId: string,
  runId: string,
  toolCallId: string,
  phase: "invocation" | "result",
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([conversationId, runId, toolCallId, phase]))
    .digest("base64url");
  return `sth1_${digest}`;
}

const DAILY_ROLLOVER_SUFFIX = /#\d{4}-\d{2}-\d{2}$/u;

/** Normalize only configured daily rollover buckets; natural '#' ids remain opaque otherwise. */
export function toolHistoryLogicalConversationId(
  conversationId: string,
  rollover: "none" | "daily" | undefined,
): string {
  return rollover === "daily" ? conversationId.replace(DAILY_ROLLOVER_SUFFIX, "") : conversationId;
}

function validateDatabase(database: DatabaseSync): void {
  const application = database.prepare("PRAGMA application_id").get() as Record<string, unknown>;
  const version = database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  if (Number(Object.values(application)[0]) !== TOOL_HISTORY_APPLICATION_ID || Number(Object.values(version)[0]) !== TOOL_HISTORY_USER_VERSION) {
    throw new ToolHistoryWriterError(
      "history_schema_unsupported",
      "Tool history schema is unsupported. Downgrade is blocked until persisted conversation state is purged.",
    );
  }
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
    retainedBytes: numberField(counts, "retained_bytes"),
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

function artifactReferences(database: DatabaseSync, conversationId: string, runId: string, toolCallId: string): ToolHistoryArtifactReference[] {
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
  const end = Math.min(encoded.byteLength, offset + maxBytes);
  let safeEnd = end;
  while (safeEnd > offset && ((encoded[safeEnd] ?? 0) & 0b1100_0000) === 0b1000_0000) safeEnd -= 1;
  return {
    text: encoded.subarray(offset, safeEnd).toString("utf8"),
    ...(safeEnd < encoded.byteLength ? { nextOffset: safeEnd } : {}),
  };
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function canonicalHistoryRoot(path: string): string {
  const normalized = resolve(path);
  mkdirSync(normalized, { recursive: true, mode: 0o700 });
  assertSecureReadableDirectory(normalized);
  return realpathSync(normalized);
}

function normalizedArtifactRoot(value: string | undefined, historyRoot: string): string {
  return canonicalToolArtifactRoot(requestedArtifactRoot(value, historyRoot));
}

function requestedArtifactRoot(value: string | undefined, historyRoot: string): string {
  const requested = value ?? join(historyRoot, "..", "artifacts", "tool-output");
  if (!isAbsolute(requested)) throw new TypeError("tool history artifact root must be absolute.");
  return resolve(requested);
}

function normalizeId(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 4 * 1024
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty control-free string no larger than 4096 bytes.`);
  }
  return value.trim();
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workerErrorCode(error: Error): string {
  if (/^history_[a-z0-9_]+$/u.test(error.name)) return error.name;
  const message = error.message.toLocaleLowerCase();
  if (message.includes("remained owned beyond")) return "history_writer_in_use";
  if (message.includes("schema is newer or foreign")) return "history_schema_unsupported";
  if (message.includes("unsupported entry")) return "history_entry_unsupported";
  return "history_writer_start_failed";
}
