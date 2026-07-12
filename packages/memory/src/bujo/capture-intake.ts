import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import type {
  MemoryCompletedTurn,
  MemoryCompletedTurnAdmissionStatus,
} from "@mono-agent/agent-contracts";

import { acquireMemoryWriterLease } from "./generations.js";
import { findRetainedCaptureIntent } from "./capture-outbox.js";
import {
  canonicalMemoryRootPath,
  readCanonicalFileSnapshot,
  removeCanonicalFile,
  writeCanonicalFileAtomic,
  type CanonicalFileIdentity,
} from "./path-safety.js";

export const COMPLETED_TURN_INTAKE_SCHEMA_VERSION = 1;

const INTAKE_ROOT = ".capture-intake";
const STATES = ["pending", "dead", "resolved"] as const;
const FILE_NAME = /^[a-f0-9]{64}\.json$/u;
const ORPHAN_TEMP_NAME = /^\.[a-f0-9]{64}\.json-[a-f0-9-]{36}\.tmp$/u;
const ID = /^[a-f0-9]{64}$/u;
const SAFE_REASON = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_RUN_ID_BYTES = 1_024;
const MAX_CONVERSATION_ID_BYTES = 4_096;
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_CAPTURE_TEXT_BYTES = 512 * 1024;
const MAX_RECORD_BYTES = 640 * 1024;
const DEFAULT_MAX_ACTIVE_RECORDS = 4_096;
const DEFAULT_MAX_ATTEMPTS = 16;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 6 * 60 * 60_000;
const DEFAULT_RESOLVED_RETENTION = 4_096;
const MAX_FILES_PER_STATE = DEFAULT_MAX_ACTIVE_RECORDS + 1;

type IntakeState = (typeof STATES)[number];
type FailureCode = "model_output" | "provider" | "processing";
type ResolutionOutcome = "captured" | "summary_only" | "operator_resolved";

interface IntakePayload {
  readonly runId: string;
  readonly conversationId: string;
  readonly summary: string;
  readonly captureText?: string;
}

interface PendingRecord extends IntakePayload {
  readonly schemaVersion: typeof COMPLETED_TURN_INTAKE_SCHEMA_VERSION;
  readonly state: "pending";
  readonly id: string;
  readonly payloadHash: string;
  readonly admittedAt: string;
  readonly revision: number;
  readonly attempt: number;
  readonly nextAttemptAt: string;
  readonly summaryWritten: boolean;
  readonly lastError?: FailureCode;
}

interface DeadRecord extends IntakePayload {
  readonly schemaVersion: typeof COMPLETED_TURN_INTAKE_SCHEMA_VERSION;
  readonly state: "dead";
  readonly id: string;
  readonly payloadHash: string;
  readonly admittedAt: string;
  readonly revision: number;
  readonly attempt: number;
  readonly deadAt: string;
  readonly summaryWritten: boolean;
  readonly lastError: FailureCode;
}

interface ResolvedRecord {
  readonly schemaVersion: typeof COMPLETED_TURN_INTAKE_SCHEMA_VERSION;
  readonly state: "resolved";
  readonly id: string;
  readonly payloadHash: string;
  readonly admittedAt: string;
  readonly resolvedAt: string;
  readonly revision: number;
  readonly attempt: number;
  readonly outcome: ResolutionOutcome;
  readonly reason?: string;
}

type IntakeRecord = PendingRecord | DeadRecord | ResolvedRecord;

interface LocatedRecord<T extends IntakeRecord = IntakeRecord> {
  readonly record: T;
  readonly relativePath: string;
  readonly identity: CanonicalFileIdentity;
  readonly bytes: number;
}

export interface CompletedTurnIntakeAdmission {
  readonly id: string;
  readonly source: string;
  readonly bytesWritten: number;
  readonly admissionStatus: MemoryCompletedTurnAdmissionStatus;
}

export interface CompletedTurnIntakeItem {
  readonly id: string;
  readonly state: IntakeState;
  readonly admittedAt: string;
  readonly attempt: number;
  readonly revision: number;
  readonly due: boolean;
  readonly lastError?: FailureCode;
}

export interface CompletedTurnIntakeSnapshot {
  readonly pending: number;
  readonly dead: number;
  readonly resolved: number;
  readonly due: number;
  /** Crash-window source/destination pairs that a writer can retire safely. */
  readonly transitioning: number;
  readonly retrying: number;
  readonly accepting: boolean;
  readonly shutdown: "running" | "drained" | "pending" | "timed_out";
}

export interface CompletedTurnIntakeInspection {
  readonly schemaVersion: typeof COMPLETED_TURN_INTAKE_SCHEMA_VERSION;
  readonly items: readonly CompletedTurnIntakeItem[];
  readonly snapshot: Omit<CompletedTurnIntakeSnapshot, "accepting" | "shutdown" | "retrying">;
}

export interface CompletedTurnIntakeAudit {
  readonly valid: boolean;
  readonly inspection?: CompletedTurnIntakeInspection;
  /** Metadata-only codes. Paths, payloads, model text, and provider errors are never exposed. */
  readonly issues: readonly ("invalid_layout" | "invalid_record" | "capacity_exceeded" | "state_conflict")[];
}

export interface CompletedTurnIntakeManagerOptions {
  readonly root: string;
  readonly clock: () => Date;
  readonly writeSummary: (
    turn: MemoryCompletedTurn,
    id: string,
    admittedAt: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly capture: (
    turn: MemoryCompletedTurn,
    id: string,
    admittedAt: string,
    signal: AbortSignal,
  ) => Promise<"captured" | "summary_only">;
  /** Retire a run-owned semantic plan only after its resolved receipt is durable. */
  readonly afterResolved?: (id: string) => void | Promise<void>;
  /** Startup cleanup for receipts published before a crash interrupted plan retirement. */
  readonly cleanupResolved?: (ids: readonly string[]) => void;
  readonly warn?: (message: string) => void;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly maxActiveRecords?: number;
  readonly resolvedRetention?: number;
  /** Test-only crash seam after the run-derived summary is durable but before intake state advances. */
  readonly afterSummaryPersisted?: (id: string) => void;
}

/**
 * Durable, idempotent completed-turn admission and serialized restartable processing.
 *
 * Admission performs no provider work. It returns only after a private pending
 * record and its containing directory entry have been fsynced. The worker is a
 * projection of that durable tree; it is deliberately unbounded in memory up
 * to the bounded on-disk record count and therefore cannot silently drop an
 * already-admitted turn under queue pressure.
 */
export class CompletedTurnIntakeManager {
  private readonly root: string;
  private readonly clock: () => Date;
  private readonly writeSummary: CompletedTurnIntakeManagerOptions["writeSummary"];
  private readonly capture: CompletedTurnIntakeManagerOptions["capture"];
  private readonly warn: (message: string) => void;
  private readonly afterResolved: ((id: string) => void | Promise<void>) | undefined;
  private readonly cleanupResolved: ((ids: readonly string[]) => void) | undefined;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxActiveRecords: number;
  private readonly resolvedRetention: number;
  private readonly afterSummaryPersisted: ((id: string) => void) | undefined;
  private accepting = true;
  private stopped = false;
  private timedOut = false;
  private activeController: AbortController | undefined;
  private worker: Promise<void> | undefined;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: CompletedTurnIntakeManagerOptions) {
    this.root = canonicalMemoryRootPath(options.root, true);
    this.clock = options.clock;
    this.writeSummary = options.writeSummary;
    this.capture = options.capture;
    this.warn = options.warn ?? (() => {});
    this.afterResolved = options.afterResolved;
    this.cleanupResolved = options.cleanupResolved;
    this.maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, "maxAttempts");
    this.retryBaseMs = positiveInteger(options.retryBaseMs, DEFAULT_RETRY_BASE_MS, "retryBaseMs");
    this.retryMaxMs = positiveInteger(options.retryMaxMs, DEFAULT_RETRY_MAX_MS, "retryMaxMs");
    this.maxActiveRecords = positiveInteger(options.maxActiveRecords, DEFAULT_MAX_ACTIVE_RECORDS, "maxActiveRecords");
    this.resolvedRetention = positiveInteger(
      options.resolvedRetention,
      DEFAULT_RESOLVED_RETENTION,
      "resolvedRetention",
    );
    this.afterSummaryPersisted = options.afterSummaryPersisted;
    if (intakeLayoutExists(this.root)) {
      ensureLayout(this.root, false);
      retireOrphanIntakeTemps(this.root);
      recoverStateConflicts(this.root);
      const inspection = inspectCompletedTurnIntake(this.root, this.clock());
      if (inspection.snapshot.pending + inspection.snapshot.dead > this.maxActiveRecords) {
        throw new Error("memory-bujo: completed-turn intake active-record capacity is exceeded.");
      }
      this.cleanupResolved?.(
        inspection.items.filter((item) => item.state === "resolved").map((item) => item.id),
      );
      this.scheduleWorker();
    }
  }

  /** Synchronously validate and durably publish one completed turn. */
  admit(turn: MemoryCompletedTurn): CompletedTurnIntakeAdmission {
    if (!this.accepting || this.stopped) {
      throw new Error("memory-bujo: completed-turn intake is closing or closed.");
    }
    const payload = validatePayload(turn);
    ensureLayout(this.root, true);
    const id = idFor(payload.runId);
    const payloadHash = hashPayload(payload);
    const existing = locateById(this.root, id);
    if (existing.length > 0) {
      if (existing.some(({ record }) => record.payloadHash !== payloadHash)) {
        throw new Error("memory-bujo: completed-turn run id conflicts with an already admitted payload.");
      }
      const preferred = preferredRecord(existing)!;
      return {
        id,
        source: join(this.root, preferred.relativePath),
        bytesWritten: 0,
        admissionStatus: "duplicate",
      };
    }

    const counts = inspectCompletedTurnIntake(this.root, this.clock()).snapshot;
    if (counts.pending + counts.dead >= this.maxActiveRecords) {
      throw new Error("memory-bujo: completed-turn intake is full; admission was not published.");
    }
    const admittedAt = canonicalNow(this.clock);
    const record: PendingRecord = {
      schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
      state: "pending",
      id,
      payloadHash,
      runId: payload.runId,
      conversationId: payload.conversationId,
      summary: payload.summary,
      ...(payload.captureText === undefined ? {} : { captureText: payload.captureText }),
      admittedAt,
      revision: 0,
      attempt: 0,
      nextAttemptAt: admittedAt,
      summaryWritten: false,
    };
    const written = writeRecord(this.root, "pending", record);
    this.scheduleWorker();
    return {
      id,
      source: join(this.root, written.relativePath),
      bytesWritten: written.bytes,
      admissionStatus: "admitted",
    };
  }

  /** Process all records due at the current clock and await the active attempt. */
  async flush(): Promise<void> {
    if (this.stopped) return;
    this.clearWakeTimer();
    this.startWorker();
    await this.worker;
  }

  stopAccepting(): void {
    this.accepting = false;
    this.clearWakeTimer();
  }

  abortForShutdown(timedOut: boolean): void {
    this.accepting = false;
    this.stopped = true;
    this.timedOut = timedOut;
    this.clearWakeTimer();
    this.activeController?.abort(new Error("completed-turn intake shutdown"));
  }

  finishShutdown(): void {
    this.accepting = false;
    this.stopped = true;
    this.clearWakeTimer();
  }

  snapshot(): CompletedTurnIntakeSnapshot {
    const inspection = inspectCompletedTurnIntake(this.root, this.clock());
    const pending = inspection.snapshot.pending;
    return {
      ...inspection.snapshot,
      retrying: this.activeController === undefined ? 0 : 1,
      accepting: this.accepting && !this.stopped,
      shutdown: this.timedOut
        ? "timed_out"
        : !this.stopped
          ? "running"
          : pending > 0
            ? "pending"
            : "drained",
    };
  }

  private scheduleWorker(): void {
    if (this.stopped || this.worker !== undefined) return;
    setImmediate(() => this.startWorker()).unref?.();
  }

  private startWorker(): void {
    if (this.stopped || this.worker !== undefined) return;
    let workerFaulted = false;
    this.worker = this.runWorker().catch(() => {
      workerFaulted = true;
      safeWarn(this.warn, "completed-turn intake worker paused; durable state remains for restart or retry.");
    }).finally(() => {
      this.worker = undefined;
      if (!this.stopped && !workerFaulted) {
        try { this.scheduleNextWake(); } catch {
          safeWarn(this.warn, "completed-turn intake wake scheduling failed; durable state remains for restart.");
        }
      }
    });
  }

  private async runWorker(): Promise<void> {
    recoverStateConflicts(this.root);
    for (;;) {
      if (this.stopped) return;
      const due = listRecords(this.root, "pending")
        .filter((located): located is LocatedRecord<PendingRecord> => located.record.state === "pending")
        .filter(({ record }) => Date.parse(record.nextAttemptAt) <= this.clock().getTime())
        .sort(compareLocated)[0];
      if (due === undefined) return;
      await this.processOne(due);
    }
  }

  private async processOne(initial: LocatedRecord<PendingRecord>): Promise<void> {
    const controller = new AbortController();
    this.activeController = controller;
    let current = initial;
    try {
      const turn = payloadOf(current.record);
      if (!current.record.summaryWritten) {
        await this.writeSummary(turn, current.record.id, current.record.admittedAt, controller.signal);
        controller.signal.throwIfAborted();
        this.afterSummaryPersisted?.(current.record.id);
        const advanced: PendingRecord = { ...current.record, summaryWritten: true };
        current = replaceRecord(this.root, current, advanced);
      }
      const outcome = await this.capture(turn, current.record.id, current.record.admittedAt, controller.signal);
      controller.signal.throwIfAborted();
      resolvePending(this.root, current, outcome, canonicalNow(this.clock));
      await this.afterResolved?.(current.record.id);
      pruneResolved(this.root, this.resolvedRetention, current.record.id);
    } catch (error) {
      if (controller.signal.aborted || this.stopped) return;
      const logical = preferredRecord(locateById(this.root, current.record.id));
      // A state transition publishes its higher revision before retiring the
      // source. If retirement itself failed, the destination already owns the
      // logical turn and the lower pending source must never be rewritten to
      // the same revision.
      if (logical === undefined || logical.record.state !== "pending") {
        safeWarn(this.warn, "completed-turn intake transition published; deferred cleanup remains for startup.");
        throw error;
      }
      const latest = logical as LocatedRecord<PendingRecord>;
      const attempt = latest.record.attempt + 1;
      const lastError = failureCode(error);
      if (attempt >= this.maxAttempts) {
        moveToDead(this.root, latest, attempt, lastError, canonicalNow(this.clock));
        safeWarn(this.warn, "completed-turn capture reached its retry limit; a durable dead letter remains.");
      } else {
        const now = this.clock();
        const nextAttemptAt = new Date(now.getTime() + retryDelay(
          attempt,
          this.retryBaseMs,
          this.retryMaxMs,
        )).toISOString();
        replaceRecord(this.root, latest, {
          ...latest.record,
          attempt,
          nextAttemptAt,
          lastError,
        });
        safeWarn(this.warn, "completed-turn capture failed; a durable retry is scheduled.");
      }
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private scheduleNextWake(): void {
    if (this.stopped || this.wakeTimer !== undefined) return;
    const next = listRecords(this.root, "pending")
      .filter((located): located is LocatedRecord<PendingRecord> => located.record.state === "pending")
      .sort((left, right) => left.record.nextAttemptAt.localeCompare(right.record.nextAttemptAt))[0];
    if (next === undefined) return;
    const delay = Math.max(0, Date.parse(next.record.nextAttemptAt) - this.clock().getTime());
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.startWorker();
    }, delay);
    this.wakeTimer.unref?.();
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }
}

/** Strict metadata-only inspection. Any unsafe/corrupt entry rejects the whole result. */
export function inspectCompletedTurnIntake(
  root: string,
  now = new Date(),
): CompletedTurnIntakeInspection {
  const canonicalRoot = canonicalMemoryRootPath(root, false);
  if (!intakeLayoutExists(canonicalRoot)) {
    return {
      schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
      items: [],
      snapshot: { pending: 0, dead: 0, resolved: 0, due: 0, transitioning: 0 },
    };
  }
  ensureLayout(canonicalRoot, false);
  const physical = STATES.flatMap((state) => listRecords(canonicalRoot, state));
  const { located, transitioning } = logicalRecords(physical);
  const items = located.map(({ record }) => ({
    id: record.id,
    state: record.state,
    admittedAt: record.admittedAt,
    attempt: record.attempt,
    revision: record.revision,
    due: record.state === "pending" && Date.parse(record.nextAttemptAt) <= now.getTime(),
    ...(record.state === "resolved" ? {} : record.lastError === undefined ? {} : { lastError: record.lastError }),
  })).sort((left, right) => left.id.localeCompare(right.id) || left.state.localeCompare(right.state));
  return {
    schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
    items,
    snapshot: {
      pending: items.filter((item) => item.state === "pending").length,
      dead: items.filter((item) => item.state === "dead").length,
      resolved: items.filter((item) => item.state === "resolved").length,
      due: items.filter((item) => item.due).length,
      transitioning,
    },
  };
}

function intakeLayoutExists(root: string): boolean {
  try {
    lstatSync(join(root, INTAKE_ROOT));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Non-throwing audit wrapper for health/CLI consumers. */
export function auditCompletedTurnIntake(root: string, now = new Date()): CompletedTurnIntakeAudit {
  try {
    const inspection = inspectCompletedTurnIntake(root, now);
    if (inspection.snapshot.pending + inspection.snapshot.dead > DEFAULT_MAX_ACTIVE_RECORDS) {
      return { valid: false, inspection, issues: ["capacity_exceeded"] };
    }
    return { valid: true, inspection, issues: [] };
  } catch (error) {
    const message = reasonOf(error);
    const issue = /capacity|bounded file count/iu.test(message)
      ? "capacity_exceeded"
      : /conflict|multiple states/iu.test(message)
      ? "state_conflict"
      : /directory|layout/iu.test(message)
        ? "invalid_layout"
        : "invalid_record";
    return { valid: false, issues: [issue] };
  }
}

/** Retry selected dead letters (or make selected pending work due) while no store owns the root. */
export function retryCompletedTurnIntake(
  root: string,
  options: { readonly id?: string; readonly now?: Date } = {},
): { readonly retried: number } {
  if (options.id !== undefined) assertId(options.id);
  const lease = acquireMemoryWriterLease(root);
  try {
    ensureLayout(lease.root, true);
    retireOrphanIntakeTemps(lease.root);
    recoverStateConflicts(lease.root);
    const now = (options.now ?? new Date()).toISOString();
    let retried = 0;
    for (const located of listRecords(lease.root, "dead")) {
      if (located.record.state !== "dead" || (options.id !== undefined && located.record.id !== options.id)) continue;
      const pending: PendingRecord = {
        schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
        state: "pending",
        id: located.record.id,
        payloadHash: located.record.payloadHash,
        runId: located.record.runId,
        conversationId: located.record.conversationId,
        summary: located.record.summary,
        ...(located.record.captureText === undefined ? {} : { captureText: located.record.captureText }),
        admittedAt: located.record.admittedAt,
        revision: located.record.revision + 1,
        attempt: 0,
        nextAttemptAt: now,
        summaryWritten: located.record.summaryWritten,
      };
      moveRecord(lease.root, located, "pending", pending);
      retried += 1;
    }
    for (const located of listRecords(lease.root, "pending")) {
      if (located.record.state !== "pending" || (options.id !== undefined && located.record.id !== options.id)) continue;
      if (Date.parse(located.record.nextAttemptAt) <= Date.parse(now)) continue;
      replaceRecord(
        lease.root,
        located as LocatedRecord<PendingRecord>,
        { ...located.record, nextAttemptAt: now },
      );
      retried += 1;
    }
    return { retried };
  } finally {
    lease.release();
  }
}

/** Explicitly resolve pending/dead work without claiming that semantic capture completed. */
export function resolveCompletedTurnIntake(
  root: string,
  id: string,
  reason: string,
  now = new Date(),
): { readonly resolved: boolean } {
  assertId(id);
  if (!SAFE_REASON.test(reason)) throw new Error("memory-bujo: intake resolution reason must be a bounded slug.");
  const lease = acquireMemoryWriterLease(root);
  try {
    ensureLayout(lease.root, true);
    retireOrphanIntakeTemps(lease.root);
    recoverStateConflicts(lease.root);
    const source = preferredRecord(locateById(lease.root, id));
    if (source === undefined || source.record.state === "resolved") return { resolved: false };
    if (findRetainedCaptureIntent(lease.root, id) !== undefined) {
      throw new Error("memory-bujo: intake resolution requires retained semantic-plan recovery first.");
    }
    const receipt: ResolvedRecord = {
      schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
      state: "resolved",
      id,
      payloadHash: source.record.payloadHash,
      admittedAt: source.record.admittedAt,
      resolvedAt: now.toISOString(),
      revision: source.record.revision + 1,
      attempt: source.record.attempt,
      outcome: "operator_resolved",
      reason,
    };
    moveRecord(lease.root, source, "resolved", receipt);
    pruneResolved(lease.root, DEFAULT_RESOLVED_RETENTION, id);
    return { resolved: true };
  } finally {
    lease.release();
  }
}

function ensureLayout(root: string, create: boolean): void {
  const canonicalRoot = canonicalMemoryRootPath(root, create);
  let parent = canonicalRoot;
  for (const component of [INTAKE_ROOT, ...STATES]) {
    if (component === INTAKE_ROOT) {
      parent = ensureDirectory(parent, join(canonicalRoot, component), create, component);
      continue;
    }
    ensureDirectory(parent, join(parent, component), create, `${INTAKE_ROOT}/${component}`);
  }
  assertIntakeRootEntries(canonicalRoot);
}

function assertIntakeRootEntries(root: string): void {
  const path = join(root, INTAKE_ROOT);
  const before = lstatSync(path);
  assertSecureDirectory(before, INTAKE_ROOT);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    assertSameNode(before, fstatSync(fd));
    const names = readdirSync(path, { encoding: "utf8" }).sort();
    if (names.length !== STATES.length || names.some((name, index) => name !== [...STATES].sort()[index])) {
      throw new Error("memory-bujo: completed-turn intake root contains an unknown entry.");
    }
    assertSameNode(before, lstatSync(path));
  } finally {
    closeSync(fd);
  }
}

function ensureDirectory(parent: string, path: string, create: boolean, label: string): string {
  const parentBefore = lstatSync(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error("memory-bujo: completed-turn intake parent layout is unsafe.");
  }
  let created = false;
  if (!create) {
    let existing: Stats;
    try {
      existing = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("memory-bujo: completed-turn intake layout is missing.");
      }
      throw error;
    }
    assertSecureDirectory(existing, label);
    const parentAfter = lstatSync(parent);
    assertSecureParentIdentity(parentBefore, parentAfter);
    return path;
  }
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("memory-bujo: completed-turn intake layout is missing.");
      }
      throw error;
    }
  }
  const stat = lstatSync(path);
  assertSecureDirectory(stat, label);
  const parentAfter = lstatSync(parent);
  assertSecureParentIdentity(parentBefore, parentAfter);
  if (created) fsyncSecureDirectory(parent, parentBefore);
  return path;
}

function listRecords(root: string, state: IntakeState): LocatedRecord[] {
  return listStateNames(root, state).flatMap((name) => {
    if (FILE_NAME.test(name)) return [readRecord(root, state, name.slice(0, -5))];
    if (ORPHAN_TEMP_NAME.test(name)) {
      validateOrphanTemp(root, state, name);
      return [];
    }
    throw new Error("memory-bujo: completed-turn intake has an invalid record name.");
  });
}

function listStateNames(root: string, state: IntakeState): string[] {
  const directory = join(root, INTAKE_ROOT, state);
  const parent = lstatSync(join(root, INTAKE_ROOT));
  assertSecureDirectory(parent, INTAKE_ROOT);
  const before = lstatSync(directory);
  assertSecureDirectory(before, `${INTAKE_ROOT}/${state}`);
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  let names: string[];
  try {
    const opened = fstatSync(fd);
    assertSecureDirectory(opened, `${INTAKE_ROOT}/${state}`);
    assertSameNode(before, opened);
    names = readdirSync(directory, { encoding: "utf8" }).sort();
    if (names.length > MAX_FILES_PER_STATE) {
      throw new Error("memory-bujo: completed-turn intake state exceeds its bounded file count.");
    }
    assertSameNode(opened, lstatSync(directory));
    assertSameNode(parent, lstatSync(join(root, INTAKE_ROOT)));
  } finally {
    closeSync(fd);
  }
  return names;
}

function validateOrphanTemp(
  root: string,
  state: IntakeState,
  name: string,
): NonNullable<ReturnType<typeof readCanonicalFileSnapshot>> {
  const relativePath = `${INTAKE_ROOT}/${state}/${name}`;
  const snapshot = readCanonicalFileSnapshot(root, relativePath, { maxBytes: MAX_RECORD_BYTES });
  if (snapshot === undefined || (snapshot.identity.mode & 0o777) !== FILE_MODE
    || snapshot.identity.nlink !== 1
    || (typeof process.getuid === "function" && snapshot.identity.uid !== process.getuid())) {
    throw new Error("memory-bujo: completed-turn intake orphan temp has unsafe identity.");
  }
  return snapshot;
}

function retireOrphanIntakeTemps(root: string): void {
  for (const state of STATES) {
    for (const name of listStateNames(root, state)) {
      if (FILE_NAME.test(name)) continue;
      if (!ORPHAN_TEMP_NAME.test(name)) {
        throw new Error("memory-bujo: completed-turn intake has an invalid record name.");
      }
      const snapshot = validateOrphanTemp(root, state, name);
      removeCanonicalFile(root, `${INTAKE_ROOT}/${state}/${name}`, snapshot.identity);
    }
  }
}

function readRecord(root: string, state: IntakeState, id: string): LocatedRecord {
  assertId(id);
  const relativePath = recordPath(state, id);
  const snapshot = readCanonicalFileSnapshot(root, relativePath, { maxBytes: MAX_RECORD_BYTES });
  if (snapshot === undefined) throw new Error("memory-bujo: completed-turn intake record disappeared.");
  if ((snapshot.identity.mode & 0o777) !== FILE_MODE
    || snapshot.identity.nlink !== 1
    || (typeof process.getuid === "function" && snapshot.identity.uid !== process.getuid())) {
    throw new Error("memory-bujo: completed-turn intake record has unsafe permissions or ownership.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.content) as unknown;
  } catch {
    throw new Error("memory-bujo: completed-turn intake record is not valid JSON.");
  }
  const record = validateRecord(parsed, state, id);
  return {
    record,
    relativePath,
    identity: snapshot.identity,
    bytes: Buffer.byteLength(snapshot.content, "utf8"),
  };
}

function writeRecord(root: string, state: IntakeState, record: IntakeRecord): LocatedRecord {
  if (record.state !== state) throw new Error("memory-bujo: completed-turn intake state/path mismatch.");
  validateRecord(record, state, record.id);
  const relativePath = recordPath(state, record.id);
  const data = serializeRecord(record);
  writeCanonicalFileAtomic(root, relativePath, data);
  const verified = readRecord(root, state, record.id);
  if (createHash("sha256").update(data).digest("hex")
    !== createHash("sha256").update(readCanonicalFileSnapshot(root, relativePath)!.content).digest("hex")) {
    throw new Error("memory-bujo: completed-turn intake durability verification failed.");
  }
  return verified;
}

function replaceRecord<T extends PendingRecord>(
  root: string,
  current: LocatedRecord<PendingRecord>,
  next: T,
): LocatedRecord<T> {
  const materialized = { ...next, revision: current.record.revision + 1 } as T;
  const data = serializeRecord(materialized);
  writeCanonicalFileAtomic(root, current.relativePath, data, current.identity);
  return readRecord(root, "pending", next.id) as LocatedRecord<T>;
}

function moveRecord(
  root: string,
  source: LocatedRecord,
  state: IntakeState,
  target: IntakeRecord,
): LocatedRecord {
  if (target.revision !== source.record.revision + 1) {
    throw new Error("memory-bujo: completed-turn intake transition revision is not monotonic.");
  }
  const existing = locateById(root, target.id).find((candidate) => candidate.record.state === state);
  let written: LocatedRecord;
  if (existing === undefined) {
    written = writeRecord(root, state, target);
  } else {
    if (existing.record.payloadHash !== target.payloadHash || serializeRecord(existing.record) !== serializeRecord(target)) {
      throw new Error("memory-bujo: completed-turn intake destination conflicts with source state.");
    }
    written = existing;
  }
  removeCanonicalFile(root, source.relativePath, source.identity);
  return written;
}

function resolvePending(
  root: string,
  source: LocatedRecord<PendingRecord>,
  outcome: "captured" | "summary_only",
  resolvedAt: string,
): void {
  const receipt: ResolvedRecord = {
    schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
    state: "resolved",
    id: source.record.id,
    payloadHash: source.record.payloadHash,
    admittedAt: source.record.admittedAt,
    resolvedAt,
    revision: source.record.revision + 1,
    attempt: source.record.attempt,
    outcome,
  };
  moveRecord(root, source, "resolved", receipt);
}

function moveToDead(
  root: string,
  source: LocatedRecord<PendingRecord>,
  attempt: number,
  lastError: FailureCode,
  deadAt: string,
): void {
  const dead: DeadRecord = {
    schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
    state: "dead",
    id: source.record.id,
    payloadHash: source.record.payloadHash,
    runId: source.record.runId,
    conversationId: source.record.conversationId,
    summary: source.record.summary,
    ...(source.record.captureText === undefined ? {} : { captureText: source.record.captureText }),
    admittedAt: source.record.admittedAt,
    revision: source.record.revision + 1,
    attempt,
    deadAt,
    summaryWritten: source.record.summaryWritten,
    lastError,
  };
  moveRecord(root, source, "dead", dead);
}

function recoverStateConflicts(root: string): void {
  const records = STATES.flatMap((state) => listRecords(root, state));
  const grouped = new Map<string, LocatedRecord[]>();
  for (const located of records) {
    const group = grouped.get(located.record.id) ?? [];
    group.push(located);
    grouped.set(located.record.id, group);
  }
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    const keep = preferredRecord(group)!;
    for (const extra of group) {
      if (extra === keep) continue;
      removeCanonicalFile(root, extra.relativePath, extra.identity);
    }
  }
}

function logicalRecords(records: readonly LocatedRecord[]): {
  readonly located: LocatedRecord[];
  readonly transitioning: number;
} {
  const grouped = new Map<string, LocatedRecord[]>();
  for (const located of records) {
    const group = grouped.get(located.record.id) ?? [];
    group.push(located);
    grouped.set(located.record.id, group);
  }
  let transitioning = 0;
  const located: LocatedRecord[] = [];
  for (const group of grouped.values()) {
    if (group.length > 1) transitioning += 1;
    located.push(preferredRecord(group)!);
  }
  return { located, transitioning };
}

function locateById(root: string, id: string): LocatedRecord[] {
  assertId(id);
  const found: LocatedRecord[] = [];
  for (const state of STATES) {
    try {
      found.push(readRecord(root, state, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found;
}

function preferredRecord(records: readonly LocatedRecord[]): LocatedRecord | undefined {
  if (records.length === 0) return undefined;
  if (records.length > 2 || new Set(records.map(({ record }) => record.payloadHash)).size !== 1) {
    throw new Error("memory-bujo: completed-turn intake states have a payload or transition conflict.");
  }
  const ordered = [...records].sort((left, right) => right.record.revision - left.record.revision);
  if (ordered.length > 1 && ordered[0]!.record.revision === ordered[1]!.record.revision) {
    throw new Error("memory-bujo: completed-turn intake states have a conflicting equal revision.");
  }
  if (ordered.length > 1 && ordered[0]!.record.revision !== ordered[1]!.record.revision + 1) {
    throw new Error("memory-bujo: completed-turn intake states have a conflicting revision gap.");
  }
  if (ordered.length > 1) {
    const transition = `${ordered[1]!.record.state}->${ordered[0]!.record.state}`;
    if (!new Set(["pending->dead", "pending->resolved", "dead->pending", "dead->resolved"]).has(transition)) {
      throw new Error("memory-bujo: completed-turn intake states have an invalid transition direction.");
    }
  }
  return ordered[0];
}

function pruneResolved(root: string, retain: number, preserveId?: string): void {
  const resolved = listRecords(root, "resolved")
    .filter((located): located is LocatedRecord<ResolvedRecord> => located.record.state === "resolved")
    .sort((left, right) => left.record.resolvedAt.localeCompare(right.record.resolvedAt)
      || left.record.id.localeCompare(right.record.id));
  const removeCount = Math.max(0, resolved.length - retain);
  const removable = preserveId === undefined
    ? resolved
    : resolved.filter(({ record }) => record.id !== preserveId);
  for (const located of removable.slice(0, removeCount)) {
    removeCanonicalFile(root, located.relativePath, located.identity);
  }
}

function validateRecord(value: unknown, state: IntakeState, expectedId: string): IntakeRecord {
  if (!isRecord(value)
    || value.schemaVersion !== COMPLETED_TURN_INTAKE_SCHEMA_VERSION
    || value.state !== state
    || value.id !== expectedId
    || idFor(String(value.runId ?? "")) !== expectedId && state !== "resolved") {
    throw new Error("memory-bujo: completed-turn intake record envelope is malformed.");
  }
  assertId(expectedId);
  if (!ID.test(String(value.payloadHash ?? "")) || !canonicalTimestamp(value.admittedAt)
    || !validAttempt(value.attempt) || !validAttempt(value.revision)) {
    throw new Error("memory-bujo: completed-turn intake record metadata is malformed.");
  }
  if (state === "resolved") {
    if (!hasOnlyKeys(value, [
      "schemaVersion", "state", "id", "payloadHash", "admittedAt", "resolvedAt", "revision", "attempt", "outcome", "reason",
    ]) || !canonicalTimestamp(value.resolvedAt)
      || (value.outcome !== "captured" && value.outcome !== "summary_only" && value.outcome !== "operator_resolved")
      || (value.outcome === "operator_resolved"
        ? typeof value.reason === "string" && SAFE_REASON.test(value.reason)
        : value.reason === undefined) === false) {
      throw new Error("memory-bujo: completed-turn resolved receipt is malformed.");
    }
    return value as unknown as ResolvedRecord;
  }
  const payload = validatePayload({
    runId: value.runId as string,
    conversationId: value.conversationId as string,
    summary: value.summary as string,
    ...(value.captureText === undefined ? {} : { captureText: value.captureText as string }),
  });
  if (hashPayload(payload) !== value.payloadHash || idFor(payload.runId) !== value.id) {
    throw new Error("memory-bujo: completed-turn intake payload commitment is invalid.");
  }
  if (typeof value.summaryWritten !== "boolean") {
    throw new Error("memory-bujo: completed-turn intake summary state is malformed.");
  }
  if (state === "pending") {
    if (!hasOnlyKeys(value, [
      "schemaVersion", "state", "id", "payloadHash", "runId", "conversationId", "summary", "captureText",
      "admittedAt", "revision", "attempt", "nextAttemptAt", "summaryWritten", "lastError",
    ]) || !canonicalTimestamp(value.nextAttemptAt)
      || (value.lastError !== undefined && !validFailureCode(value.lastError))) {
      throw new Error("memory-bujo: completed-turn pending record is malformed.");
    }
    return value as unknown as PendingRecord;
  }
  if (!hasOnlyKeys(value, [
    "schemaVersion", "state", "id", "payloadHash", "runId", "conversationId", "summary", "captureText",
    "admittedAt", "revision", "attempt", "deadAt", "summaryWritten", "lastError",
  ]) || !canonicalTimestamp(value.deadAt) || !validFailureCode(value.lastError)) {
    throw new Error("memory-bujo: completed-turn dead letter is malformed.");
  }
  return value as unknown as DeadRecord;
}

function validatePayload(value: MemoryCompletedTurn): IntakePayload {
  if (!isRecord(value) || !hasOnlyKeys(value, ["runId", "conversationId", "summary", "captureText"])) {
    throw new Error("memory-bujo: completed-turn payload has unknown or missing fields.");
  }
  const runId = boundedText(value.runId, "runId", MAX_RUN_ID_BYTES, false);
  const conversationId = boundedText(value.conversationId, "conversationId", MAX_CONVERSATION_ID_BYTES, false);
  const summary = boundedText(value.summary, "summary", MAX_SUMMARY_BYTES, true);
  if (summary.includes("<!--mem") || /[\p{Zl}\p{Zp}]/u.test(summary)) {
    throw new Error("memory-bujo: completed-turn summary contains a reserved delimiter or line separator.");
  }
  let captureText: string | undefined;
  if (value.captureText !== undefined) {
    captureText = boundedText(value.captureText, "captureText", MAX_CAPTURE_TEXT_BYTES, true);
  }
  return { runId, conversationId, summary, ...(captureText === undefined ? {} : { captureText }) };
}

function boundedText(value: unknown, label: string, maxBytes: number, allowLayoutWhitespace: boolean): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0
    || Buffer.byteLength(value, "utf8") > maxBytes
    || /[\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
    || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || (!allowLayoutWhitespace && /[\r\n\t]/u.test(value))) {
    throw new Error(`memory-bujo: completed-turn ${label} is invalid or exceeds its bound.`);
  }
  return value;
}

function payloadOf(record: PendingRecord | DeadRecord): MemoryCompletedTurn {
  return {
    runId: record.runId,
    conversationId: record.conversationId,
    summary: record.summary,
    ...(record.captureText === undefined ? {} : { captureText: record.captureText }),
  };
}

function idFor(runId: string): string {
  return createHash("sha256").update(runId, "utf8").digest("hex");
}

function hashPayload(payload: IntakePayload): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function serializeRecord(record: IntakeRecord): string {
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("memory-bujo: completed-turn intake record exceeds its durable bound.");
  }
  return serialized;
}

function recordPath(state: IntakeState, id: string): string {
  return `${INTAKE_ROOT}/${state}/${id}.json`;
}

function assertId(id: string): void {
  if (!ID.test(id)) throw new Error("memory-bujo: completed-turn intake id is invalid.");
}

function canonicalNow(clock: () => Date): string {
  const date = clock();
  if (!Number.isFinite(date.getTime())) throw new Error("memory-bujo: completed-turn intake clock is invalid.");
  return date.toISOString();
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validAttempt(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
}

function validFailureCode(value: unknown): value is FailureCode {
  return value === "model_output" || value === "provider" || value === "processing";
}

function failureCode(error: unknown): FailureCode {
  if (isRecord(error) && error.name === "MemoryModelOutputError") return "model_output";
  if (isRecord(error) && error.name === "MemoryModelError") return "provider";
  return "processing";
}

function retryDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * (2 ** Math.min(Math.max(0, attempt - 1), 20)));
}

function compareLocated(left: LocatedRecord<PendingRecord>, right: LocatedRecord<PendingRecord>): number {
  return left.record.nextAttemptAt.localeCompare(right.record.nextAttemptAt)
    || left.record.admittedAt.localeCompare(right.record.admittedAt)
    || left.record.id.localeCompare(right.record.id);
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new Error(`memory-bujo: completed-turn intake ${label} must be a positive integer.`);
  }
  return selected;
}

function assertSecureDirectory(stat: Stats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== DIRECTORY_MODE
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`memory-bujo: completed-turn intake directory "${label}" must be owner-only and not a symlink.`);
  }
}

function assertSameNode(left: Stats, right: Stats): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error("memory-bujo: completed-turn intake directory changed during access.");
  }
}

function assertSecureParentIdentity(before: Stats, after: Stats): void {
  if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("memory-bujo: completed-turn intake parent changed during layout validation.");
  }
}

function fsyncSecureDirectory(path: string, expected: Stats): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    assertSameNode(expected, opened);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeWarn(warn: (message: string) => void, message: string): void {
  try { warn(message); } catch { /* Diagnostics cannot poison durable work. */ }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
