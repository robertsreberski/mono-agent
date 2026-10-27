import type { UpkeepMutation, UpkeepAdmission, UpkeepReservation } from "../continuity/admission.js";
import type { LedgerGeneration } from "../continuity/ledger.js";
import type { ContinuityGapInput } from "./continuity-contracts.js";
import type { RuntimeToolLifecycleEvent, RuntimeToolLifecyclePersistence, RuntimeToolLifecycleSink } from "@mono-agent/turn/host/types";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { canonicalToolArtifactRoot } from "./artifacts.js";
import { ToolHistoryPersistenceCoordinator, type ToolHistoryRequestSettlement } from "./persistence-coordinator.js";
import { TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS, TOOL_HISTORY_PERSISTENCE_CEILING_MS, type ToolHistoryRunBinding, type ToolHistoryStats, type ToolHistoryWriterOptions, type WorkerRequest, type WorkerResponse } from "./contracts.js";
import { ToolHistoryWriterError } from "./errors.js";
import { canonicalHistoryRoot, positiveInteger, requestedArtifactRoot } from "./paths.js";

import { validateContinuityPreparation, validateContinuityPublication } from "./continuity-storage.js";
import type { ContinuityPin, ContinuityPreparation, ContinuityPublication, ContinuityReceipt, ContinuityReconciliation, ContinuityReconciliationResult } from "./continuity-contracts.js";

const TOOL_HISTORY_RECONCILIATION_CEILING_MS = 10_000;
const TOOL_HISTORY_MAINTENANCE_CEILING_MS = 10_000;

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
    // A worker can die while several configured responders still reference its
    // process entry. The dead handles remain releasable, but no new acquisition
    // may revive that writer or wait for every old reference to drain.
    if (entry.writer.isClosed) {
      if (PROCESS_WRITERS.get(root) === entryPromise) PROCESS_WRITERS.delete(root);
      continue;
    }
    // A final release can delete this registry entry while an earlier acquire
    // is suspended on the already-resolved promise. Retry instead of reviving
    // the writer that release is closing.
    if (PROCESS_WRITERS.get(root) !== entryPromise) continue;
    if (options.continuityEnabled === true) await entry.writer.enableContinuity();
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
  private readonly persistenceCoordinator: ToolHistoryPersistenceCoordinator;
  private readonly onWarning: ((message: string) => void) | undefined;
  private requestId = 0;
  private closed = false;
  private readonly warnedKinds = new Set<string>();

  /** True after graceful close or worker failure; a host must reacquire. */
  get isClosed(): boolean {
    return this.closed;
  }

  private constructor(worker: Worker, options: ToolHistoryWriterOptions) {
    this.worker = worker;
    this.persistenceCeilingMs = positiveInteger(
      options.persistenceCeilingMs ?? TOOL_HISTORY_PERSISTENCE_CEILING_MS,
      "persistenceCeilingMs",
    );
    this.persistenceCoordinator = new ToolHistoryPersistenceCoordinator(this.persistenceCeilingMs);
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
      ? new URL("../../dist/tool-history/writer-worker.js", import.meta.url)
      : new URL("./writer-worker.js", import.meta.url);
    if (import.meta.url.endsWith(".ts")) {
      assertToolHistoryWorkerBuildFresh(
        fileURLToPath(new URL("./writer-worker.ts", import.meta.url)),
        fileURLToPath(workerUrl),
      );
    }
    const worker = new Worker(workerUrl, {
      workerData: {
        root,
        continuityEnabled: options.continuityEnabled === true,
        artifactRoot,
        artifactRootAliases: [artifactRoot, lexicalArtifactRoot],
        retention: options.retention,
        ownerAcquireCeilingMs: options.ownerAcquireCeilingMs ?? TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS,
      },
    });
    const writer = new ToolHistoryWriter(worker, options);
    // Keep the whole public open alive, including worker termination after a
    // startup failure. The request timer alone is cleared when readiness
    // rejects and cannot reference the remaining cleanup await.
    const startupReference = setInterval(() => undefined, 60_000);
    try {
      const ready = await writer.request("ready", undefined, (options.ownerAcquireCeilingMs ?? TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS) + 1_000) as { accountingDegraded?: number };
      if (ready.accountingDegraded) { try { options.onWarning?.("Upkeep accounting degraded: durable exports are pending or failed."); } catch { /* diagnostics only */ } }
      // request() unreferences the worker once its pending map drains, and the
      // outer startup reference is cleared when this public promise settles.
      // An idle sidecar must not prolong a one-shot CLI process; every later
      // awaited operation temporarily references the worker until it settles.
      return writer;
    } catch (error) {
      writer.closed = true;
      await worker.terminate().catch(() => undefined);
      throw error;
    } finally {
      clearInterval(startupReference);
    }
  }

  createSink(binding: ToolHistoryRunBinding): RuntimeToolLifecycleSink {
    return async (event) => await this.persist(binding, event);
  }

  async persist(
    binding: ToolHistoryRunBinding,
    event: RuntimeToolLifecycleEvent,
  ): Promise<RuntimeToolLifecyclePersistence> {
    const foreground = await this.persistenceCoordinator.track(
      toolHistoryRunKey(binding),
      this.request(
        event.phase === "invocation" ? "invocation" : "result",
        { binding, event },
        Math.max(this.persistenceCeilingMs, TOOL_HISTORY_RECONCILIATION_CEILING_MS),
      ) as Promise<RuntimeToolLifecyclePersistence>,
      (settlement) => this.reportLifecycleSettlement(binding, event, settlement),
    );
    if (foreground.status === "deferred") return { persistence: "deferred" };
    if (foreground.settlement.status === "fulfilled") return foreground.settlement.value;
    return {
      persistence: "failed",
      errorCode: toolHistoryPersistenceErrorCode(foreground.settlement.error),
    };
  }

  async finishRun(
    binding: ToolHistoryRunBinding,
    status: string,
    failureKind?: string,
    cancellationReasonCode?: string,
  ): Promise<void> {
    const payload = { binding, status, failureKind, cancellationReasonCode };
    const startedAt = performance.now();
    const boundary = this.persistenceCoordinator.boundaryForRun(toolHistoryRunKey(binding));
    const drained = await this.persistenceCoordinator.waitForBoundary(
      boundary,
      TOOL_HISTORY_RECONCILIATION_CEILING_MS,
    );
    const remainingMs = remainingCeilingMs(startedAt, TOOL_HISTORY_RECONCILIATION_CEILING_MS);
    if (!drained || remainingMs === 0) {
      this.postBestEffort("finish_run", payload);
      this.reportRunFinalizationFailure(
        binding,
        status,
        new ToolHistoryWriterError(
          "history_persistence_timeout",
          `Tool history run reconciliation exceeded the ${String(TOOL_HISTORY_RECONCILIATION_CEILING_MS)} ms host wait ceiling.`,
        ),
      );
      return;
    }
    await this.request("finish_run", payload, remainingMs).catch((error) => {
      this.reportRunFinalizationFailure(binding, status, error);
    });
  }

  async replayUpkeepAccounting(): Promise<void> {
    const degraded = await this.request("upkeep_accounting_replay", undefined, TOOL_HISTORY_MAINTENANCE_CEILING_MS);
    if (degraded) { try { this.onWarning?.("Upkeep accounting degraded: durable exports are pending or failed."); } catch { /* diagnostics only */ } }
  }

  /** Upgrade only through an explicit host capability, using the existing worker owner. */
  async enableContinuity(): Promise<void> {
    await this.request("enable_continuity", undefined, TOOL_HISTORY_MAINTENANCE_CEILING_MS);
  }

  async recordContinuityGap(input: ContinuityGapInput): Promise<void> {
    await this.request("continuity_gap", input, TOOL_HISTORY_MAINTENANCE_CEILING_MS);
  }

  async mutateUpkeep(input: UpkeepMutation): Promise<UpkeepAdmission | null> {
    // Fit the worker's 128 KiB reservation plus 16 KiB terminal receipt.
    if (Buffer.byteLength(JSON.stringify(input)) > 160 * 1024) {
      if (input.kind === "dispatch") throw new ToolHistoryWriterError("upkeep_dispatch_rejected", "Upkeep payload bound.");
      throw new TypeError("Upkeep payload bound.");
    }
    return await this.request("continuity_upkeep", input, TOOL_HISTORY_MAINTENANCE_CEILING_MS) as UpkeepAdmission | null;
  }

  async publishLedger(input: LedgerGeneration, reservation?: UpkeepReservation): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(input)) > 128 * 1024) throw new TypeError("Ledger payload bound.");
    await this.request("continuity_ledger", { generation: input, reservation }, TOOL_HISTORY_MAINTENANCE_CEILING_MS);
  }

  async prepareContinuity(input: ContinuityPreparation): Promise<ContinuityReceipt> {
    // Bound selected fields before structured-cloning them to the worker.
    validateContinuityPreparation(input);
    return await this.request("continuity_prepare", input, TOOL_HISTORY_MAINTENANCE_CEILING_MS) as ContinuityReceipt;
  }

  async commitContinuity(input: ContinuityPublication): Promise<void> {
    validateContinuityPublication(input, true);
    await this.request("continuity_commit", input, TOOL_HISTORY_MAINTENANCE_CEILING_MS);
  }

  async reconcileContinuity(input: ContinuityReconciliation): Promise<ContinuityReconciliationResult> {
    validateContinuityPublication(input);
    return await this.request("continuity_reconcile", input, TOOL_HISTORY_MAINTENANCE_CEILING_MS) as ContinuityReconciliationResult;
  }

  async pinContinuity(pin: ContinuityPin): Promise<void> {
    await this.request("continuity_pin", pin, TOOL_HISTORY_MAINTENANCE_CEILING_MS);
  }

  async unpinContinuity(pin: ContinuityPin): Promise<void> {
    await this.request("continuity_unpin", pin, TOOL_HISTORY_MAINTENANCE_CEILING_MS);
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
    const startedAt = performance.now();
    const drained = await this.persistenceCoordinator.waitForBoundary(
      this.persistenceCoordinator.boundaryForAll(),
      TOOL_HISTORY_MAINTENANCE_CEILING_MS,
    );
    const remainingMs = remainingCeilingMs(startedAt, TOOL_HISTORY_MAINTENANCE_CEILING_MS);
    if (drained && remainingMs > 0) {
      await this.request("close", undefined, remainingMs).catch(() => undefined);
    }
    await this.worker.terminate().catch(() => undefined);
  }

  private reportLifecycleSettlement(
    binding: ToolHistoryRunBinding,
    event: RuntimeToolLifecycleEvent,
    settlement: ToolHistoryRequestSettlement<RuntimeToolLifecyclePersistence>,
  ): void {
    if (settlement.status === "fulfilled") return;
    const code = toolHistoryPersistenceErrorCode(settlement.error);
    this.warnOnce(code, `Tool lifecycle persistence failed (${code}); streaming continues with an explicit failure marker.`);
    if (code === "history_idempotency_conflict") return;
    this.postBestEffort("write_failure", {
      binding,
      phase: event.phase,
      toolCallId: event.toolCallId,
      code,
      message: reasonOf(settlement.error),
    });
  }

  private reportRunFinalizationFailure(
    binding: ToolHistoryRunBinding,
    status: string,
    error: unknown,
  ): void {
    this.warnOnce("run_finalize_failed", `Tool history run finalization failed: ${reasonOf(error)}`);
    this.postBestEffort("write_failure", {
      binding,
      phase: "finish_run",
      status,
      code: "run_finalize_failed",
      message: reasonOf(error),
    });
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
    if (response.id === 0 && response.ok && (response.value as { accountingDegraded?: unknown } | undefined)?.accountingDegraded) {
      try { this.onWarning?.("Upkeep accounting degraded: durable exports are pending or failed."); } catch { /* diagnostics only */ }
      return;
    }
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
      "Tool history worker output is missing; build @mono-agent/conversation before focused tests.",
    );
  }
  if (distMtime < sourceMtime) {
    throw new ToolHistoryWriterError(
      "history_worker_build_stale",
      "Tool history worker output predates its source; rebuild @mono-agent/conversation before focused tests.",
    );
  }
}

function toolHistoryRunKey(binding: ToolHistoryRunBinding): string {
  return JSON.stringify([binding.conversationId, binding.runId]);
}

function toolHistoryPersistenceErrorCode(error: unknown): string {
  return error instanceof ToolHistoryWriterError ? error.code : "history_write_failed";
}

function remainingCeilingMs(startedAt: number, ceilingMs: number): number {
  return Math.max(0, ceilingMs - Math.ceil(performance.now() - startedAt));
}

function normalizedArtifactRoot(value: string | undefined, historyRoot: string): string {
  return canonicalToolArtifactRoot(requestedArtifactRoot(value, historyRoot));
}

export function reasonOf(error: unknown): string {
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
