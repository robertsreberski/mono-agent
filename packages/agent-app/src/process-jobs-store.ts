import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  isProcessJobErrorCode,
  isProcessJobState,
  type ProcessJobErrorCode,
  type ProcessJobProjection,
  type ProcessJobState,
} from "@mono-agent/agent-contracts";

import { PROCESS_JOBS_CAPS, type ProcessJobsSettings } from "./process-jobs-config.js";
import {
  processIncarnationFromJson,
  type ProcessIncarnation,
} from "./process-incarnation.js";
import { secureFileReplace } from "./secure-file-replace.js";
import {
  readBoundedOwnerOnlyFile,
  syncDirectory,
} from "./continuation-store-fs.js";

export const PROCESS_JOB_RECORD_SCHEMA = 1;
export const PROCESS_JOB_RECORDS_DIRECTORY = "records-v1";
export const PROCESS_JOB_ARTIFACTS_DIRECTORY = "artifacts";
export const PROCESS_JOB_MANIFEST_FILE = "process-jobs-store-v1.json";
export const PROCESS_JOB_TRANSACTION_FILE = "process-jobs-transaction-v1.json";
export const PROCESS_JOB_SECRET_FILE = "process-jobs-secret";
export const PROCESS_JOB_ROLLBACK_GUARD = "PROCESS-JOBS-STORE-V1";
export const PROCESS_JOB_ROLLBACK_GUARD_CONTENT =
  "This state directory uses mono-agent process-job records v1. Older runtimes must not open it.\n";

const MAX_RECORD_BYTES = 128 * 1024;
const MAX_TRANSACTION_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_GUARD_BYTES = 4 * 1024;

export interface ProcessJobOriginRecord {
  readonly conversationId: string;
  readonly baseConversationId: string;
  readonly bucket: string | null;
  readonly replyToConversationId: string;
  readonly normalizedReplyTarget: string;
  readonly runId: string;
  readonly historyBoundary: string;
  readonly channel: "slack" | "telegram" | "web";
}

export interface DurableProcessJobRecord {
  readonly schemaVersion: typeof PROCESS_JOB_RECORD_SCHEMA;
  generation: string;
  readonly jobId: string;
  readonly tool: "Exec" | "Bash";
  state: ProcessJobState;
  readonly summary: string;
  readonly agentIncarnation: ProcessIncarnation;
  processIncarnation?: ProcessIncarnation;
  pid: number | null;
  pgid: number | null;
  readonly sandboxSettingsPath: string | null;
  readonly argvSummary: string;
  readonly cwd: string;
  readonly envKeys: readonly string[];
  readonly origin: ProcessJobOriginRecord;
  readonly chainDepth: number;
  readonly maxRuntimeMs: number;
  readonly maxOutputBytes: number;
  readonly previewChars: number;
  readonly admittedAt: string;
  readonly queueDeadlineAt: string;
  startedAt: string | null;
  runtimeDeadlineAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  preview: string;
  stdoutRef: string | null;
  stderrRef: string | null;
  cancelRequested: boolean;
  wake: {
    state: "pending" | "delivered" | "failed";
    attempts: number;
    readonly deliveryKey: string;
    lastAttemptAt: string | null;
    /** Private durable proof that the last adapter result explicitly permitted retry. */
    retrySafe?: boolean;
  };
  lastError: { readonly code: ProcessJobErrorCode; readonly message: string } | null;
}

interface ProcessJobStoreManifest {
  readonly schemaVersion: 1;
  readonly generation: string;
  readonly updatedAt: string;
  readonly rollbackGuardRequired: true;
  readonly records: number;
}

interface ProcessJobTransaction {
  readonly schemaVersion: 1;
  readonly generation: string;
  readonly createdAt: string;
  readonly write: DurableProcessJobRecord | null;
  readonly delete: string | null;
}

export interface ProcessJobStore {
  readonly stateDir: string;
  readonly recordsDir: string;
  readonly artifactsDir: string;
  get(jobId: string): Promise<DurableProcessJobRecord | undefined>;
  list(): Promise<readonly DurableProcessJobRecord[]>;
  mutate<T>(operation: (records: Map<string, DurableProcessJobRecord>) => T | Promise<T>): Promise<T>;
  ensureArtifacts(jobId: string): Promise<{ readonly stdoutRef: string; readonly stderrRef: string }>;
  discardArtifacts(jobId: string): Promise<void>;
  writeArtifact(jobId: string, stream: "stdout" | "stderr", contents: string): Promise<void>;
  applyRetention(settings: ProcessJobsSettings, now?: Date): Promise<void>;
}

/** Open and recover the independent per-record v1 process-job store. */
export async function openProcessJobStore(
  agentRoot: string,
  stateDir: string,
): Promise<ProcessJobStore> {
  const { root, confined } = await resolveConfinedStateDirectory(agentRoot, stateDir);
  await ensureConfinedPrivateDirectory(root, confined);
  const recordsDir = join(confined, PROCESS_JOB_RECORDS_DIRECTORY);
  const artifactsDir = join(confined, PROCESS_JOB_ARTIFACTS_DIRECTORY);
  await ensureConfinedPrivateDirectory(root, recordsDir);
  await ensureConfinedPrivateDirectory(root, artifactsDir);
  const manifestPath = join(confined, PROCESS_JOB_MANIFEST_FILE);
  const transactionPath = join(confined, PROCESS_JOB_TRANSACTION_FILE);
  const guardPath = join(confined, PROCESS_JOB_ROLLBACK_GUARD);
  await ensureRollbackGuard(guardPath);

  let manifest = await readManifest(manifestPath);
  const transaction = await readTransaction(transactionPath);
  if (transaction !== undefined) {
    await applyTransaction(recordsDir, transaction);
    manifest = await persistManifest(manifestPath, transaction.generation, await recordCount(recordsDir));
    await rm(transactionPath, { force: true });
    await syncDirectory(confined);
  }

  const records = await loadRecords(recordsDir);
  if (manifest === undefined) {
    manifest = await persistManifest(manifestPath, randomUUID(), records.size);
  } else if (manifest.records !== records.size) {
    throw new Error("Process-job manifest record count does not match the durable record set.");
  }
  await removeOrphanArtifacts(artifactsDir, records);

  let tail: Promise<void> = Promise.resolve();
  let poisoned: unknown;
  const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      if (poisoned !== undefined) throw poisoned;
      return await operation();
    } finally {
      release();
    }
  };

  const store: ProcessJobStore = {
    stateDir: confined,
    recordsDir,
    artifactsDir,
    async get(jobId) {
      return await withLock(async () => clone(records.get(jobId)));
    },
    async list() {
      return await withLock(async () => [...records.values()].map((record) => structuredClone(record)));
    },
    async mutate(operation) {
      return await withLock(async () => {
        const before = cloneMap(records);
        const draft = cloneMap(records);
        const result = await operation(draft);
        try {
          await persistDiff(confined, recordsDir, transactionPath, manifestPath, before, draft);
        } catch (error) {
          poisoned = error;
          throw error;
        }
        replaceMap(records, draft);
        return result;
      });
    },
    async ensureArtifacts(jobId) {
      assertJobId(jobId);
      const directory = join(artifactsDir, jobId);
      let existed = true;
      try { await lstat(directory); }
      catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
        existed = false;
      }
      try {
        await ensureConfinedPrivateDirectory(root, directory);
        const stdoutRef = `${PROCESS_JOB_ARTIFACTS_DIRECTORY}/${jobId}/stdout.log`;
        const stderrRef = `${PROCESS_JOB_ARTIFACTS_DIRECTORY}/${jobId}/stderr.log`;
        for (const path of [join(directory, "stdout.log"), join(directory, "stderr.log")]) {
          try {
            assertPrivateFile(await lstat(path), path, 0o600);
          } catch (error) {
            if (!isErrno(error, "ENOENT")) throw error;
            await replacePrivateFile(path, "", 0o600);
          }
        }
        return { stdoutRef, stderrRef };
      } catch (error) {
        // A rejected admission must not accumulate half-created artifact
        // directories. Never remove a directory that predated this unique id;
        // open-time orphan recovery remains the crash-only fallback.
        if (!existed) {
          try {
            await rm(directory, { recursive: true, force: true });
            await syncDirectory(artifactsDir);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Process-job artifact admission and rejected-artifact cleanup both failed.",
            );
          }
        }
        throw error;
      }
    },
    async discardArtifacts(jobId) {
      assertJobId(jobId);
      await rm(join(artifactsDir, jobId), { recursive: true, force: true });
      await syncDirectory(artifactsDir);
    },
    async writeArtifact(jobId, stream, contents) {
      assertJobId(jobId);
      const path = join(artifactsDir, jobId, `${stream}.log`);
      await replacePrivateFile(path, contents, 0o600);
      await syncDirectory(dirname(path));
    },
    async applyRetention(settings, now = new Date()) {
      const artifactDirectoriesToRemove = await this.mutate(async (draft) => {
        const terminal = [...draft.values()]
          .filter((record) => isTerminalProcessJobState(record.state))
          .sort((left, right) => terminalTime(left) - terminalTime(right)
            || left.jobId.localeCompare(right.jobId));
        // A pending wake is still live state. Retiring its record or artifacts
        // would erase the durable delivery obligation or evidence it references.
        const retireable = terminal.filter((record) => record.wake.state !== "pending");
        const cutoff = now.getTime() - settings.retention.maxAgeMs;
        const remove = new Set(
          retireable.filter((record) => terminalTime(record) < cutoff).map((record) => record.jobId),
        );
        const retained = retireable.filter((record) => !remove.has(record.jobId));
        while (retained.length > settings.retention.maxRecords) {
          const next = retained.shift();
          if (next === undefined) break;
          remove.add(next.jobId);
        }
        for (const jobId of remove) draft.delete(jobId);
        const artifactRemovals = new Set(remove);
        const artifactRecords = terminal.filter((record) => !remove.has(record.jobId));
        let artifactBytes = await retainedArtifactBytes(artifactsDir, artifactRecords, new Set());
        for (const record of artifactRecords) {
          if (artifactBytes <= settings.retention.artifactMaxBytes) break;
          if (record.wake.state === "pending") continue;
          artifactBytes -= await artifactDirectoryBytes(join(artifactsDir, record.jobId));
          artifactRemovals.add(record.jobId);
          const mutable = draft.get(record.jobId);
          if (mutable !== undefined) {
            mutable.stdoutRef = null;
            mutable.stderrRef = null;
          }
        }
        return [...artifactRemovals];
      });
      // Records and ref removals reach durable storage first. A crash after
      // that point can leave only orphan artifacts, which open-time recovery
      // removes; it can never leave a retained record pointing at output that
      // was deleted before its transaction committed.
      for (const jobId of artifactDirectoriesToRemove) {
        await rm(join(artifactsDir, jobId), { recursive: true, force: true });
      }
      if (artifactDirectoriesToRemove.length > 0) await syncDirectory(artifactsDir);
    },
  };
  return store;
}

/** Prepare only the confined private state root, before acquiring its live-owner lock. */
export async function prepareProcessJobStateDirectory(agentRoot: string, stateDir: string): Promise<string> {
  const { root, confined } = await resolveConfinedStateDirectory(agentRoot, stateDir);
  await ensureConfinedPrivateDirectory(root, confined);
  return confined;
}

export async function loadOrCreateProcessJobSecret(stateDir: string): Promise<Buffer> {
  const path = join(stateDir, PROCESS_JOB_SECRET_FILE);
  try {
    const encoded = (await readBoundedOwnerOnlyFile(path, 256, "Process-job operator secret")).trim();
    const secret = Buffer.from(encoded, "base64url");
    if (secret.length !== 32 || secret.toString("base64url") !== encoded) {
      throw new Error(`Process-job operator secret has invalid contents: ${path}`);
    }
    return secret;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  const secret = randomBytes(32);
  await replacePrivateFile(path, `${secret.toString("base64url")}\n`, 0o600);
  await syncDirectory(stateDir);
  return secret;
}

export function processJobOperatorToken(secret: Uint8Array): string {
  if (secret.byteLength !== 32) throw new Error("Process-job operator secret must contain exactly 32 bytes.");
  return createHmac("sha256", secret).update("mono-agent-process-job-operator-v1").digest("base64url");
}

export function projectProcessJob(record: DurableProcessJobRecord): ProcessJobProjection {
  return {
    schema: "mono-agent.process-job-projection.v1",
    jobId: record.jobId,
    tool: record.tool,
    state: record.state,
    summary: record.summary,
    origin: {
      conversationId: record.origin.conversationId,
      channel: record.origin.channel,
      runId: record.origin.runId,
      historyBoundary: record.origin.historyBoundary,
      bucket: record.origin.bucket,
    },
    timestamps: {
      admittedAt: record.admittedAt,
      queueDeadlineAt: record.queueDeadlineAt,
      startedAt: record.startedAt,
      runtimeDeadlineAt: record.runtimeDeadlineAt,
      completedAt: record.completedAt,
    },
    limits: {
      maxRuntimeMs: record.maxRuntimeMs,
      maxOutputBytes: record.maxOutputBytes,
      previewChars: record.previewChars,
      chainDepth: record.chainDepth,
    },
    output: {
      stdoutBytes: record.stdoutBytes,
      stderrBytes: record.stderrBytes,
      truncated: record.truncated,
      preview: record.preview,
      stdoutRef: record.stdoutRef,
      stderrRef: record.stderrRef,
    },
    wake: {
      state: record.wake.state,
      attempts: record.wake.attempts,
      deliveryKey: record.wake.deliveryKey,
      lastAttemptAt: record.wake.lastAttemptAt,
    },
    exitCode: record.exitCode,
    signal: record.signal,
    durationMs: record.durationMs,
    cancelRequested: record.cancelRequested,
    lastError: record.lastError,
  };
}

export function isTerminalProcessJobState(state: ProcessJobState): boolean {
  return state === "succeeded"
    || state === "failed"
    || state === "timed_out"
    || state === "cancelled"
    || state === "spawn_failed"
    || state === "queue_expired"
    || state === "interrupted";
}

async function persistDiff(
  stateDir: string,
  recordsDir: string,
  transactionPath: string,
  manifestPath: string,
  before: Map<string, DurableProcessJobRecord>,
  after: Map<string, DurableProcessJobRecord>,
): Promise<void> {
  // Validate the complete draft before publishing a transaction marker. A
  // caller bug must not strand malformed recovery input in otherwise healthy
  // owner state.
  for (const [jobId, record] of after) {
    assertJobId(jobId);
    assertDurableRecord(record);
    if (record.jobId !== jobId) throw new Error("Process-job record key does not match its job id.");
  }
  const changes: Array<{
    readonly write: DurableProcessJobRecord | null;
    readonly delete: string | null;
    readonly countDelta: -1 | 0 | 1;
  }> = [];
  for (const [jobId, record] of after) {
    const previous = before.get(jobId);
    if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(record)) {
      changes.push({ write: structuredClone(record), delete: null, countDelta: previous === undefined ? 1 : 0 });
    }
  }
  for (const jobId of before.keys()) {
    if (!after.has(jobId)) changes.push({ write: null, delete: jobId, countDelta: -1 });
  }
  let durableCount = before.size;
  for (const change of changes) {
    const generation = randomUUID();
    if (change.write !== null) change.write.generation = generation;
    const transaction: ProcessJobTransaction = {
      schemaVersion: 1,
      generation,
      createdAt: new Date().toISOString(),
      write: change.write,
      delete: change.delete,
    };
    await writeBoundedJson(transactionPath, transaction, MAX_TRANSACTION_BYTES);
    await applyTransaction(recordsDir, transaction);
    durableCount += change.countDelta;
    // Each transaction is independently reopenable. A crash between changes
    // may expose a safe prefix, but never a manifest whose count describes
    // records that have not reached disk yet; the idempotent caller can retry.
    await persistManifest(manifestPath, generation, durableCount);
    await rm(transactionPath, { force: true });
    await syncDirectory(stateDir);
    if (change.write !== null) after.set(change.write.jobId, change.write);
  }
  if (durableCount !== after.size) throw new Error("Process-job durable count diverged during mutation.");
}

async function applyTransaction(recordsDir: string, transaction: ProcessJobTransaction): Promise<void> {
  if (transaction.write !== null) {
    const record = { ...transaction.write, generation: transaction.generation };
    assertDurableRecord(record);
    await writeBoundedJson(join(recordsDir, `${record.jobId}.json`), record, MAX_RECORD_BYTES);
  } else if (transaction.delete !== null) {
    assertJobId(transaction.delete);
    await rm(join(recordsDir, `${transaction.delete}.json`), { force: true });
  }
  await syncDirectory(recordsDir);
}

async function loadRecords(recordsDir: string): Promise<Map<string, DurableProcessJobRecord>> {
  const records = new Map<string, DurableProcessJobRecord>();
  for (const entry of await readdir(recordsDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      await rm(join(recordsDir, entry.name), { force: true });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new Error(`Process-job record directory contains an unsupported entry: ${entry.name}`);
    }
    const path = join(recordsDir, entry.name);
    const value = parseJson(await readBoundedOwnerOnlyFile(path, MAX_RECORD_BYTES, "Process-job record"), path);
    assertDurableRecord(value);
    if (entry.name !== `${value.jobId}.json` || records.has(value.jobId)) {
      throw new Error(`Process-job record filename is invalid or duplicated: ${entry.name}`);
    }
    records.set(value.jobId, structuredClone(value));
  }
  return records;
}

async function readTransaction(path: string): Promise<ProcessJobTransaction | undefined> {
  let text: string;
  try {
    text = await readBoundedOwnerOnlyFile(path, MAX_TRANSACTION_BYTES, "Process-job transaction");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const value = parseJson(text, path);
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "generation", "createdAt", "write", "delete"])
    || value.schemaVersion !== 1
    || !isUuid(value.generation)
    || !isIso(value.createdAt)
    || !((value.write === null && typeof value.delete === "string")
      || (value.delete === null && isRecord(value.write)))) {
    throw new Error(`Process-job transaction has a malformed schema: ${path}`);
  }
  if (value.write !== null) assertDurableRecord(value.write);
  else assertJobId(value.delete as string);
  return value as unknown as ProcessJobTransaction;
}

async function readManifest(path: string): Promise<ProcessJobStoreManifest | undefined> {
  let text: string;
  try {
    text = await readBoundedOwnerOnlyFile(path, MAX_MANIFEST_BYTES, "Process-job manifest");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const value = parseJson(text, path);
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "generation", "updatedAt", "rollbackGuardRequired", "records"])
    || value.schemaVersion !== 1
    || !isUuid(value.generation)
    || !isIso(value.updatedAt)
    || value.rollbackGuardRequired !== true
    || !nonNegativeInteger(value.records)) {
    throw new Error(`Process-job manifest has a malformed schema: ${path}`);
  }
  return value as unknown as ProcessJobStoreManifest;
}

async function persistManifest(path: string, generation: string, records: number): Promise<ProcessJobStoreManifest> {
  const manifest: ProcessJobStoreManifest = {
    schemaVersion: 1,
    generation,
    updatedAt: new Date().toISOString(),
    rollbackGuardRequired: true,
    records,
  };
  await writeBoundedJson(path, manifest, MAX_MANIFEST_BYTES);
  return manifest;
}

async function ensureRollbackGuard(path: string): Promise<void> {
  try {
    const current = await readBoundedOwnerOnlyFile(path, MAX_GUARD_BYTES, "Process-job rollback guard");
    if (current !== PROCESS_JOB_ROLLBACK_GUARD_CONTENT) {
      throw new Error(`Process-job rollback guard contents are invalid: ${path}`);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    await replacePrivateFile(path, PROCESS_JOB_ROLLBACK_GUARD_CONTENT, 0o600);
    await syncDirectory(dirname(path));
  }
}

async function writeBoundedJson(path: string, value: unknown, maxBytes: number): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > maxBytes) {
    throw new Error(`Process-job durable file exceeds its ${String(maxBytes)} byte limit: ${path}`);
  }
  await replacePrivateFile(path, contents, 0o600);
  await syncDirectory(dirname(path));
}

async function replacePrivateFile(path: string, contents: string, mode: number): Promise<void> {
  let expected: Stats | undefined;
  try {
    expected = await lstat(path);
    assertPrivateFile(expected, path, mode);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  await secureFileReplace({
    path,
    contents,
    mode,
    target: {
      expected: expected === undefined
        ? { kind: "missing" }
        : {
            kind: "present",
            validate: async (candidate) => {
              try {
                const current = await lstat(candidate);
                assertPrivateFile(current, candidate, mode);
                return current.dev === expected!.dev && current.ino === expected!.ino;
              } catch {
                return false;
              }
            },
            invalidError: () => new Error(`Process-job private file changed before replacement: ${path}`),
          },
      recovery: "restore-previous",
    },
  });
}

async function ensureConfinedPrivateDirectory(root: string, path: string): Promise<void> {
  assertLexicallyInside(root, path);
  const rel = relative(root, path);
  let current = root;
  await assertBaseDirectory(current);
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    await assertPrivateDirectory(current);
  }
}

async function assertBaseDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Agent root is not a real directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Agent root is not owned by the current user: ${path}`);
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Process-job state path is not a real directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Process-job state directory is not owned by the current user: ${path}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
  }
}

function assertPrivateFile(info: Stats, path: string, mode: number): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`Process-job durable path is not a single-link regular file: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Process-job durable file is not owned by the current user: ${path}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o777) !== mode) {
    throw new Error(`Process-job durable file permissions are not owner-only: ${path}`);
  }
}

function assertDurableRecord(value: unknown): asserts value is DurableProcessJobRecord {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion", "generation", "jobId", "tool", "state", "summary", "agentIncarnation",
      ...(Object.prototype.hasOwnProperty.call(value, "processIncarnation") ? ["processIncarnation"] : []),
      "pid", "pgid", "sandboxSettingsPath", "argvSummary", "cwd", "envKeys", "origin", "chainDepth",
      "maxRuntimeMs", "maxOutputBytes", "previewChars", "admittedAt", "queueDeadlineAt", "startedAt",
      "runtimeDeadlineAt", "completedAt", "exitCode", "signal", "durationMs", "stdoutBytes", "stderrBytes",
      "truncated", "preview", "stdoutRef", "stderrRef", "cancelRequested", "wake", "lastError",
    ])
    || value.schemaVersion !== 1
    || !isUuid(value.generation)
    || !isJobId(value.jobId)
    || (value.tool !== "Exec" && value.tool !== "Bash")
    || !isProcessJobState(value.state)
    || !boundedString(value.summary, 8_000)
    || processIncarnationFromJson(value.agentIncarnation) === undefined
    || (value.processIncarnation !== undefined && processIncarnationFromJson(value.processIncarnation) === undefined)
    || !nullablePositiveInteger(value.pid)
    || !nullablePositiveInteger(value.pgid)
    || (value.pgid !== null && value.pgid !== value.pid)
    || (value.state === "running"
      && (value.pid === null || value.pgid !== value.pid || value.processIncarnation === undefined))
    || !nullableSandboxSettingsPath(value.sandboxSettingsPath)
    || !boundedString(value.argvSummary, 8_000)
    || !boundedString(value.cwd, 16_384)
    || !stringArray(value.envKeys, 512, 512)
    || !isProcessJobOriginRecord(value.origin)
    || !nonNegativeInteger(value.chainDepth)
    || !boundedPositiveInteger(value.maxRuntimeMs, PROCESS_JOBS_CAPS.maxRuntimeMs)
    || !boundedPositiveInteger(value.maxOutputBytes, PROCESS_JOBS_CAPS.maxOutputBytes)
    || !boundedPositiveInteger(value.previewChars, PROCESS_JOBS_CAPS.previewChars)
    || Number(value.chainDepth) > PROCESS_JOBS_CAPS.maxChainDepth
    || !isIso(value.admittedAt)
    || !isIso(value.queueDeadlineAt)
    || !nullableIso(value.startedAt)
    || !nullableIso(value.runtimeDeadlineAt)
    || !nullableIso(value.completedAt)
    || !nullableInteger(value.exitCode)
    || !nullableString(value.signal, 128)
    || !nullableNonNegativeInteger(value.durationMs)
    || !nonNegativeInteger(value.stdoutBytes)
    || !nonNegativeInteger(value.stderrBytes)
    || typeof value.truncated !== "boolean"
    || !boundedCharacters(value.preview, PROCESS_JOBS_CAPS.previewChars)
    || (typeof value.preview === "string" && value.preview.length > Number(value.previewChars))
    || !nullableArtifactRef(value.stdoutRef, value.jobId as string, "stdout.log")
    || !nullableArtifactRef(value.stderrRef, value.jobId as string, "stderr.log")
    || typeof value.cancelRequested !== "boolean"
    || !validWake(value.wake)
    || !validLastError(value.lastError)
    || !validDurableLifecycle(value)) {
    throw new Error("Process-job record has a malformed schema.");
  }
}

function validDurableLifecycle(value: Record<string, unknown>): boolean {
  const noProcessOwner = value.pid === null
    && value.pgid === null
    && value.processIncarnation === undefined
    && value.startedAt === null
    && value.runtimeDeadlineAt === null;
  const completeProcessOwner = typeof value.pid === "number"
    && value.pgid === value.pid
    && value.processIncarnation !== undefined
    && typeof value.startedAt === "string"
    && typeof value.runtimeDeadlineAt === "string";
  if (value.state === "queued" && !noProcessOwner) return false;
  if (value.state === "starting" && !noProcessOwner && !completeProcessOwner) return false;
  if (value.state === "running" && !completeProcessOwner) return false;
  const terminal = isProcessJobState(value.state) && isTerminalProcessJobState(value.state);
  if (terminal !== (value.completedAt !== null)) return false;
  if (!terminal) {
    const wake = value.wake as DurableProcessJobRecord["wake"];
    if (wake.state !== "pending"
      || wake.attempts !== 0
      || wake.lastAttemptAt !== null
      || wake.retrySafe === true) return false;
  }
  return true;
}

/** Validate the exact durable wake identity, including its normalized base. */
export function isProcessJobOriginRecord(value: unknown): value is ProcessJobOriginRecord {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "conversationId", "baseConversationId", "bucket", "replyToConversationId",
      "normalizedReplyTarget", "runId", "historyBoundary", "channel",
    ])
    || !boundedNonEmptyString(value.conversationId, 2_048)
    || !boundedNonEmptyString(value.baseConversationId, 2_048)
    || !nullableString(value.bucket, 512)
    || !boundedNonEmptyString(value.replyToConversationId, 2_048)
    || !boundedNonEmptyString(value.normalizedReplyTarget, 2_048)
    || !boundedNonEmptyString(value.runId, 512)
    || !boundedNonEmptyString(value.historyBoundary, 512)
    || (value.channel !== "slack" && value.channel !== "telegram" && value.channel !== "web")) {
    return false;
  }
  const conversation = splitProcessJobConversationId(value.conversationId);
  return conversation !== undefined
    && conversation.baseConversationId === value.baseConversationId
    && conversation.bucket === value.bucket
    && isCanonicalProcessJobBase(value.baseConversationId, value.channel)
    && value.replyToConversationId === value.baseConversationId
    && value.normalizedReplyTarget === value.baseConversationId
    && value.historyBoundary === value.runId;
}

function splitProcessJobConversationId(
  value: string,
): { readonly baseConversationId: string; readonly bucket: string | null } | undefined {
  if (value !== value.trim()) return undefined;
  const hash = value.indexOf("#");
  if (hash < 0) return { baseConversationId: value, bucket: null };
  if (hash === 0 || hash === value.length - 1 || value.indexOf("#", hash + 1) >= 0) return undefined;
  const baseConversationId = value.slice(0, hash);
  const bucket = value.slice(hash + 1);
  if (bucket !== bucket.trim()) return undefined;
  return { baseConversationId, bucket };
}

function isCanonicalProcessJobBase(
  value: string,
  channel: ProcessJobOriginRecord["channel"],
): boolean {
  const prefix = `${channel}:`;
  if (!value.startsWith(prefix)) return false;
  const destination = value.slice(prefix.length);
  if (channel === "telegram") {
    const chatId = Number(destination);
    return /^-?\d+$/u.test(destination)
      && Number.isSafeInteger(chatId)
      && String(chatId) === destination;
  }
  if (channel === "web") return destination !== "new" && /^[^\s:#]+$/u.test(destination);
  const parts = destination.split(":");
  const channelId = parts[0];
  const threadTs = parts[1];
  return (parts.length === 1 || parts.length === 2)
    && typeof channelId === "string"
    && /^(?:C|D|G)[A-Z0-9]+$/u.test(channelId)
    && (threadTs === undefined || /^\d+\.\d+$/u.test(threadTs));
}

function nullableSandboxSettingsPath(value: unknown): value is string | null {
  if (value === null) return true;
  if (!boundedNonEmptyString(value, 16_384) || !isAbsolute(value) || resolve(value) !== value) return false;
  return basename(value) === "settings.json"
    && /^mono-agent-srt-settings-[A-Za-z0-9_-]{6,}$/u.test(basename(dirname(value)));
}

function validWake(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, [
      "state", "attempts", "deliveryKey", "lastAttemptAt",
      ...(Object.prototype.hasOwnProperty.call(value, "retrySafe") ? ["retrySafe"] : []),
    ])
    && (value.state === "pending" || value.state === "delivered" || value.state === "failed")
    && nonNegativeInteger(value.attempts)
    && boundedNonEmptyString(value.deliveryKey, 512)
    && nullableIso(value.lastAttemptAt)
    && (value.retrySafe === undefined || typeof value.retrySafe === "boolean");
}

function validLastError(value: unknown): boolean {
  return value === null || (isRecord(value)
    && hasExactKeys(value, ["code", "message"])
    && isProcessJobErrorCode(value.code)
    && boundedNonEmptyString(value.message, 8_000));
}

async function removeOrphanArtifacts(
  artifactsDir: string,
  records: ReadonlyMap<string, DurableProcessJobRecord>,
): Promise<void> {
  for (const entry of await readdir(artifactsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isJobId(entry.name)) {
      throw new Error(`Process-job artifact directory contains an unsupported entry: ${entry.name}`);
    }
    const path = join(artifactsDir, entry.name);
    const record = records.get(entry.name);
    if (record === undefined || (record.stdoutRef === null && record.stderrRef === null)) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    await assertPrivateDirectory(path);
    await artifactDirectoryBytes(path);
  }
  for (const record of records.values()) {
    if (record.stdoutRef !== null) {
      await assertReferencedArtifact(join(artifactsDir, record.jobId, "stdout.log"));
    }
    if (record.stderrRef !== null) {
      await assertReferencedArtifact(join(artifactsDir, record.jobId, "stderr.log"));
    }
  }
}

async function assertReferencedArtifact(path: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(`Process-job referenced artifact is missing: ${path}`);
    }
    throw error;
  }
  assertPrivateFile(info, path, 0o600);
}

async function retainedArtifactBytes(
  artifactsDir: string,
  records: readonly DurableProcessJobRecord[],
  removed: ReadonlySet<string>,
): Promise<number> {
  let bytes = 0;
  for (const record of records) {
    if (!removed.has(record.jobId)) bytes += await artifactDirectoryBytes(join(artifactsDir, record.jobId));
  }
  return bytes;
}

async function artifactDirectoryBytes(path: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name.endsWith(".tmp") && entry.isFile() && !entry.isSymbolicLink()) {
        await rm(join(path, entry.name), { force: true });
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || (entry.name !== "stdout.log" && entry.name !== "stderr.log")) {
        throw new Error(`Process-job artifact directory contains an unsupported entry: ${entry.name}`);
      }
      const artifactPath = join(path, entry.name);
      const info = await lstat(artifactPath);
      assertPrivateFile(info, artifactPath, 0o600);
      total += info.size;
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return total;
}

function terminalTime(record: DurableProcessJobRecord): number {
  return Date.parse(record.completedAt ?? record.startedAt ?? record.admittedAt);
}

function clone(record: DurableProcessJobRecord | undefined): DurableProcessJobRecord | undefined {
  return record === undefined ? undefined : structuredClone(record);
}

function cloneMap(records: Map<string, DurableProcessJobRecord>): Map<string, DurableProcessJobRecord> {
  return new Map([...records].map(([key, value]) => [key, structuredClone(value)]));
}

function replaceMap(target: Map<string, DurableProcessJobRecord>, source: Map<string, DurableProcessJobRecord>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, structuredClone(value));
}

function parseJson(text: string, path: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new Error(`Process-job durable file contains invalid JSON: ${path}`, { cause: error }); }
}

function assertLexicallyInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new Error(`Process-job state directory escapes the agent root: ${path}`);
  }
}

async function resolveConfinedStateDirectory(
  agentRoot: string,
  stateDir: string,
): Promise<{ readonly root: string; readonly confined: string }> {
  const lexicalRoot = resolve(agentRoot);
  const root = await realpath(lexicalRoot).catch(() => lexicalRoot);
  const candidate = resolve(stateDir);

  // Callers loaded through process-jobs-config already pass a canonical path.
  // Direct store callers may retain a platform alias for the same root (for
  // example macOS /var versus /private/var) or a symlink spelling of cwd. Map
  // only a lexically confined suffix onto the attested real root; every child
  // component is still lstat-checked before it is used.
  const canonicalRelative = relative(root, candidate);
  if (canonicalRelative.length > 0 && isConfinedRelative(canonicalRelative)) {
    return { root, confined: candidate };
  }
  const lexicalRelative = relative(lexicalRoot, candidate);
  if (lexicalRelative.length > 0 && isConfinedRelative(lexicalRelative)) {
    return { root, confined: resolve(root, lexicalRelative) };
  }
  throw new Error(`Process-job state directory escapes the agent root: ${candidate}`);
}

function isConfinedRelative(path: string): boolean {
  return path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith("/") && !path.startsWith("\\");
}

function assertJobId(value: string): void {
  if (!isJobId(value)) throw new Error("Process-job id is invalid.");
}

function isJobId(value: unknown): value is string {
  return isUuid(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function recordCount(recordsDir: string): Promise<number> {
  return readdir(recordsDir).then((entries) => entries.filter((entry) => entry.endsWith(".json")).length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= max;
}

function boundedCharacters(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function boundedNonEmptyString(value: unknown, max: number): value is string {
  return boundedString(value, max) && value.trim().length > 0;
}

function nullableString(value: unknown, max: number): boolean {
  return value === null || boundedString(value, max);
}

function stringArray(value: unknown, maxItems: number, maxBytes: number): boolean {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((item) => boundedNonEmptyString(item, maxBytes));
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function boundedPositiveInteger(value: unknown, max: number): boolean {
  return positiveInteger(value) && Number(value) <= max;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nullablePositiveInteger(value: unknown): boolean {
  return value === null || positiveInteger(value);
}

function nullableInteger(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value);
}

function nullableNonNegativeInteger(value: unknown): boolean {
  return value === null || nonNegativeInteger(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function nullableIso(value: unknown): boolean {
  return value === null || isIso(value);
}

function nullableArtifactRef(value: unknown, jobId: string, name: string): boolean {
  return value === null || value === `${PROCESS_JOB_ARTIFACTS_DIRECTORY}/${jobId}/${name}`;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
