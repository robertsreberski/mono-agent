import { Worker } from "node:worker_threads";

import type {
  BujoMemoryHealthOptions,
  BujoMemoryHealthReport,
  MemoryHealthIssueCode,
  MemoryHealthStatus,
} from "@mono-agent/memory/bujo";

const DEFAULT_MEMORY_HEALTH_REQUEST_TIMEOUT_MS = 15_000;

const HEALTH_STATUSES = new Set<MemoryHealthStatus>([
  "healthy",
  "in_progress",
  "degraded",
  "unhealthy",
  "unknown",
]);
const HEALTH_ISSUES = new Set<MemoryHealthIssueCode>([
  "manifest_missing",
  "manifest_invalid",
  "configured_identity_mismatch",
  "database_missing",
  "database_unavailable",
  "native_module_unavailable",
  "health_check_failed",
  "sqlite_integrity_failed",
  "metadata_mismatch",
  "fts_mismatch",
  "vector_mismatch",
  "orphaned_rows",
  "canonical_mismatch",
  "canonical_invalid",
  "mutation_in_progress",
  "intake_invalid",
  "intake_pending",
  "dead_letters",
  "outbox_invalid",
  "outbox_pending",
  "work_stalled",
  "temporary_artifacts",
  "runtime_missing",
  "runtime_stale",
  "runtime_invalid",
]);
const COUNT_KEYS = [
  "pending",
  "due",
  "dead",
  "outbox",
  "temporary",
  "memories",
  "vectors",
  "missingVectors",
] as const;

export interface MemoryHealthWorkerRequest {
  readonly type: "audit";
  readonly id: number;
  readonly options: BujoMemoryHealthOptions;
}

export type MemoryHealthWorkerResponse =
  | { readonly type: "result"; readonly id: number; readonly report: BujoMemoryHealthReport }
  | { readonly type: "error"; readonly id: number };

interface PendingAudit {
  readonly id: number;
  readonly resolve: (report: BujoMemoryHealthReport) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface MemoryHealthWorkerClientOptions {
  readonly workerUrl?: URL;
  readonly timeoutMs?: number;
  /** Clone-safe test fixture controls; production workers receive no worker data. */
  readonly workerData?: unknown;
}

/**
 * Owns the one idle audit worker for a controller. The worker is referenced only
 * while a request is pending, so an idle health observer cannot extend process life.
 */
export class MemoryHealthWorkerClient {
  private readonly workerUrl: URL;
  private readonly timeoutMs: number;
  private readonly workerData: unknown;
  private worker: Worker | undefined;
  private pending: PendingAudit | undefined;
  private retiring: Promise<void> | undefined;
  private requestId = 0;

  constructor(options: MemoryHealthWorkerClientOptions = {}) {
    this.workerUrl = options.workerUrl ?? new URL("./memory-health-worker.js", import.meta.url);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MEMORY_HEALTH_REQUEST_TIMEOUT_MS;
    this.workerData = options.workerData;
  }

  audit(options: BujoMemoryHealthOptions): Promise<BujoMemoryHealthReport> {
    if (this.pending !== undefined) {
      return Promise.reject(new Error("A memory health audit is already pending."));
    }
    // A replacement must not overlap a worker whose synchronous native call has
    // not acknowledged termination yet. The next periodic cycle can retry safely.
    if (this.retiring !== undefined) {
      return Promise.reject(new Error("The previous memory health worker is still retiring."));
    }

    let worker = this.worker;
    if (worker === undefined) {
      try {
        worker = this.createWorker();
      } catch {
        return Promise.reject(new Error("The memory health worker could not start."));
      }
      this.worker = worker;
    }

    const id = ++this.requestId;
    const activeWorker = worker;
    return new Promise<BujoMemoryHealthReport>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.pending = undefined;
        reject(new Error("The memory health audit timed out."));
        this.retire(activeWorker);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending = { id, resolve, reject, timer };
      activeWorker.ref();
      try {
        activeWorker.postMessage({ type: "audit", id, options } satisfies MemoryHealthWorkerRequest);
      } catch {
        clearTimeout(timer);
        this.pending = undefined;
        reject(new Error("The memory health worker could not accept the audit request."));
        this.retire(activeWorker);
      }
    });
  }

  /** Fence current work synchronously; termination continues without blocking lifecycle teardown. */
  invalidate(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The memory health audit was invalidated."));
    }
    if (this.worker !== undefined) this.retire(this.worker);
  }

  private createWorker(): Worker {
    const worker = new Worker(this.workerUrl, {
      ...(this.workerData === undefined ? {} : { workerData: this.workerData }),
      // Health output is metadata-only, but native/module diagnostics can still
      // contain local paths. Drain both streams rather than inheriting them.
      stdout: true,
      stderr: true,
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
    unrefWorkerOutputPort(worker);
    worker.on("message", (value: unknown) => this.handleMessage(worker, value));
    worker.once("error", () => this.handleFailure(worker, "The memory health worker failed."));
    worker.once("exit", () => this.handleFailure(worker, "The memory health worker exited before returning a result."));
    worker.unref();
    return worker;
  }

  private handleMessage(worker: Worker, value: unknown): void {
    if (worker !== this.worker) return;
    const pending = this.pending;
    if (pending === undefined) return;
    if (!isMemoryHealthWorkerResponse(value) || value.id !== pending.id) {
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(new Error("The memory health worker returned an invalid response."));
      this.retire(worker);
      return;
    }

    this.pending = undefined;
    clearTimeout(pending.timer);
    if (value.type === "result") pending.resolve(value.report);
    else pending.reject(new Error("The memory health audit failed."));
    unrefWorkerWhenIdle(worker);
  }

  private handleFailure(worker: Worker, message: string): void {
    if (worker !== this.worker) return;
    const pending = this.pending;
    this.pending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.retire(worker);
  }

  private retire(worker: Worker): void {
    if (this.worker !== worker || this.retiring !== undefined) return;
    this.worker = undefined;
    worker.unref();
    const retirement = worker.terminate().then(() => undefined, () => undefined);
    this.retiring = retirement;
    void retirement.finally(() => {
      if (this.retiring === retirement) this.retiring = undefined;
    });
  }
}

export function isMemoryHealthWorkerResponse(value: unknown): value is MemoryHealthWorkerResponse {
  if (!isRecord(value) || (value.type !== "result" && value.type !== "error") || !isPositiveInteger(value.id)) {
    return false;
  }
  return value.type === "error" || isBujoMemoryHealthReport(value.report);
}

function isBujoMemoryHealthReport(value: unknown): value is BujoMemoryHealthReport {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.backend !== "bujo"
    || (value.mode !== "lite" && value.mode !== "journal" && value.mode !== "bujo")
    || typeof value.status !== "string"
    || !HEALTH_STATUSES.has(value.status as MemoryHealthStatus)
    || typeof value.checkedAt !== "string"
    || Number.isNaN(Date.parse(value.checkedAt))
    || !Array.isArray(value.issues)
    || !value.issues.every((issue) => typeof issue === "string" && HEALTH_ISSUES.has(issue as MemoryHealthIssueCode))
    || !isRecord(value.counts)) {
    return false;
  }
  const counts = value.counts;
  return COUNT_KEYS.every((key) => isNonNegativeInteger(counts[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function unrefWorkerWhenIdle(worker: Worker): void {
  worker.unref();
  unrefWorkerOutputPort(worker);
  // Resuming intercepted output can lazily reference its MessagePort after the
  // first worker message. Repeat after that turn without making the repeat live.
  const settle = setImmediate(() => {
    worker.unref();
    unrefWorkerOutputPort(worker);
  });
  settle.unref?.();
}

function unrefWorkerOutputPort(worker: Worker): void {
  // Node references the private shared stdio MessagePort as soon as intercepted
  // streams are drained. Worker.unref() does not release that second reference,
  // and Readable exposes no public unref operation. Keep draining while using
  // the narrow runtime capability check so an idle audit worker cannot own exit.
  for (const stream of [worker.stdout, worker.stderr]) {
    if (stream === null) continue;
    const portSymbol = Object.getOwnPropertySymbols(stream)
      .find((symbol) => symbol.description === "kPort");
    if (portSymbol === undefined) continue;
    const port = (stream as unknown as Record<symbol, unknown>)[portSymbol];
    if (isRecord(port) && typeof port["unref"] === "function") {
      (port["unref"] as () => void)();
    }
  }
}
