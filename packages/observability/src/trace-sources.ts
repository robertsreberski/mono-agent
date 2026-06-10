import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_MAX_EVENTS_PER_RUN,
  DEFAULT_MAX_STRING_BYTES,
  errorMessage,
  isErrno,
  isRecord,
  mkdir,
  minInteger,
  normalizeRunId as normalizeRunIdGuard,
  positiveInteger,
  safeJoin as safeJoinGuard,
  stringField,
  writeJsonAtomic,
} from "./artifact-fs.js";
import { listRecordedRuns, readRecordedRun } from "./recorded-runs.js";
import { redactJsonValue } from "./recorder.js";
import type {
  JsonlRunReaderOptions,
  RegisterTraceSourceOptions,
  TraceRunDetail,
  TraceRunListItem,
  TraceRunListOptions,
  TraceRunListResult,
  TraceSourceHandle,
  TraceSourceListItem,
  TraceSourceListResult,
  TraceSourceManifest,
  TraceSourceRegistryOptions,
  TraceSourceStatus,
  UpdateTraceSourceOptions,
} from "./types.js";

const DEFAULT_STALE_AFTER_MS = 30_000;
const MANIFEST_SUFFIX = ".json";
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const DEFAULT_MAX_RUNS = 100;

export type TraceSourceRegistryErrorCode =
  | "invalid_registry_options"
  | "invalid_source_id"
  | "invalid_run_id"
  | "manifest_write_failed";
export type TraceSourceRegistryErrorDetails = Record<string, unknown> & { readonly code: TraceSourceRegistryErrorCode };

export class TraceSourceRegistryError extends Error {
  readonly code: TraceSourceRegistryErrorCode;
  readonly details: TraceSourceRegistryErrorDetails;

  constructor(code: TraceSourceRegistryErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TraceSourceRegistryError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export async function registerTraceSource(options: RegisterTraceSourceOptions): Promise<TraceSourceHandle> {
  const normalized = normalizeRegistryOptions(options);
  const sourceId = normalizeSourceId(options.sourceId ?? sourceIdFromLabel(options.label));
  const label = normalizeNonEmpty(options.label, "label");
  const artifactDir = resolvePath(options.artifactDir, "artifactDir");
  const startedAt = options.startedAt ?? isoNow(normalized.clock);
  let manifest = buildManifest({
    sourceId,
    label,
    artifactDir,
    status: options.status ?? "running",
    startedAt,
    updatedAt: isoNow(normalized.clock),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    ...(options.transports === undefined ? {} : { transports: options.transports }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  });

  await writeManifest(normalized.registryDir, manifest);
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const heartbeatMs = options.heartbeatMs;
  const writePatch = async (patch: UpdateTraceSourceOptions): Promise<TraceSourceManifest> => {
    manifest = buildManifest({
      ...manifest,
      ...patch,
      updatedAt: isoNow(normalized.clock),
    });
    await writeManifest(normalized.registryDir, manifest);
    return manifest;
  };

  if (heartbeatMs !== undefined) {
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 250) {
      throw new TraceSourceRegistryError("invalid_registry_options", "heartbeatMs must be an integer of at least 250.", {
        field: "heartbeatMs",
      });
    }
    heartbeatTimer = setInterval(() => {
      void writePatch({});
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  return {
    get manifest() {
      return manifest;
    },
    update: writePatch,
    async heartbeat() {
      return await writePatch({});
    },
    async stop(patch = {}) {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      return await writePatch({ ...patch, status: patch.status ?? "stopped" });
    },
  };
}

export async function listTraceSources(options: TraceSourceRegistryOptions): Promise<TraceSourceListResult> {
  const normalized = normalizeRegistryOptions(options);
  const { manifests, warnings } = await readManifestFiles(normalized);
  return {
    registryDir: normalized.registryDir,
    sources: manifests.map((manifest) => toListItem(manifest, normalized)).sort(compareSources),
    warnings,
  };
}

export async function listTraceRuns(options: TraceRunListOptions): Promise<TraceRunListResult> {
  const normalized = normalizeRunListOptions(options);
  const sourceResult = await listTraceSources(normalized);
  const warnings = [...sourceResult.warnings];
  const runs: TraceRunListItem[] = [];

  for (const source of sourceResult.sources) {
    if (!(await artifactDirExists(source.artifactDir))) {
      warnings.push(`Source ${source.sourceId} artifact directory is missing: ${source.artifactDir}.`);
      continue;
    }
    const result = await listRecordedRuns(readerOptionsForSource(source.artifactDir, normalized));
    warnings.push(...result.warnings.map((warning) => `Source ${source.sourceId}: ${warning}`));
    for (const run of result.runs) {
      runs.push({ ...run, source });
    }
  }

  return {
    registryDir: normalized.registryDir,
    sources: sourceResult.sources,
    runs: runs
      .sort(compareTraceRuns)
      .slice(0, normalized.maxRuns),
    warnings,
  };
}

export async function readTraceRun(
  options: TraceRunListOptions,
  sourceId: string,
  runId: string,
): Promise<TraceRunDetail | undefined> {
  const normalized = normalizeRunListOptions(options);
  const normalizedSourceId = normalizeSourceId(sourceId);
  normalizeRunId(runId);
  const sourceResult = await listTraceSources(normalized);
  const source = sourceResult.sources.find((entry) => entry.sourceId === normalizedSourceId);
  if (source === undefined) {
    return undefined;
  }
  const run = await readRecordedRun(readerOptionsForSource(source.artifactDir, normalized), runId);
  return run === undefined ? undefined : { source, run };
}

function buildManifest(input: {
  readonly sourceId: string;
  readonly label: string;
  readonly artifactDir: string;
  readonly pid?: number;
  readonly status: TraceSourceStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly transports?: readonly string[];
  readonly configPath?: string;
  readonly metadata?: Record<string, unknown>;
}): TraceSourceManifest {
  return {
    schema: "worklab.trace-source.v1",
    sourceId: normalizeSourceId(input.sourceId),
    label: normalizeNonEmpty(input.label, "label"),
    artifactDir: resolvePath(input.artifactDir, "artifactDir"),
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    status: input.status,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    ...(input.transports === undefined ? {} : { transports: input.transports.map((transport) => transport.trim()).filter(Boolean) }),
    ...(input.configPath === undefined ? {} : { configPath: resolve(input.configPath) }),
    ...(input.metadata === undefined ? {} : { metadata: redactJsonValue(input.metadata) as Record<string, unknown> }),
  };
}

async function readManifestFiles(normalized: NormalizedRegistryOptions): Promise<{
  readonly manifests: readonly TraceSourceManifest[];
  readonly warnings: readonly string[];
}> {
  let entries;
  try {
    entries = await readdir(normalized.registryDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { manifests: [], warnings: [] };
    }
    return { manifests: [], warnings: [`Unable to read trace registry: ${errorMessage(error)}.`] };
  }

  const manifests: TraceSourceManifest[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(MANIFEST_SUFFIX)) {
      continue;
    }
    const path = safeJoin(normalized.registryDir, entry.name);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const manifest = coerceManifest(parsed, entry.name, warnings);
      if (manifest !== undefined) {
        manifests.push(manifest);
      }
    } catch (error) {
      warnings.push(`Skipping ${entry.name}: invalid JSON (${errorMessage(error)}).`);
    }
  }
  return { manifests, warnings };
}

function coerceManifest(value: unknown, fileName: string, warnings: string[]): TraceSourceManifest | undefined {
  if (!isRecord(value)) {
    warnings.push(`Skipping ${fileName}: manifest is not an object.`);
    return undefined;
  }
  if (value.schema !== "worklab.trace-source.v1") {
    warnings.push(`Skipping ${fileName}: manifest schema is not worklab.trace-source.v1.`);
    return undefined;
  }
  const sourceId = stringField(value, "sourceId");
  const label = stringField(value, "label");
  const artifactDir = stringField(value, "artifactDir");
  const status = sourceStatus(value.status);
  const startedAt = stringField(value, "startedAt");
  const updatedAt = stringField(value, "updatedAt");
  if (
    sourceId === undefined ||
    label === undefined ||
    artifactDir === undefined ||
    status === undefined ||
    startedAt === undefined ||
    updatedAt === undefined
  ) {
    warnings.push(`Skipping ${fileName}: manifest is missing required source metadata.`);
    return undefined;
  }
  try {
    const pid = typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : undefined;
    const transports = Array.isArray(value.transports) ? value.transports.filter((item): item is string => typeof item === "string") : undefined;
    const configPath = stringField(value, "configPath");
    const metadata = isRecord(value.metadata) ? value.metadata : undefined;
    return buildManifest({
      sourceId,
      label,
      artifactDir,
      status,
      startedAt,
      updatedAt,
      ...(pid === undefined ? {} : { pid }),
      ...(transports === undefined ? {} : { transports }),
      ...(configPath === undefined ? {} : { configPath }),
      ...(metadata === undefined ? {} : { metadata }),
    });
  } catch (error) {
    warnings.push(`Skipping ${fileName}: ${errorMessage(error)}.`);
    return undefined;
  }
}

function toListItem(manifest: TraceSourceManifest, normalized: NormalizedRegistryOptions): TraceSourceListItem {
  const warnings: string[] = [];
  const updatedAtMs = Date.parse(manifest.updatedAt);
  const stale = manifest.status === "running" &&
    Number.isFinite(updatedAtMs) &&
    normalized.clock() - updatedAtMs > normalized.staleAfterMs;
  if (stale) {
    warnings.push(`Source ${manifest.sourceId} heartbeat is stale.`);
  }
  const health = manifest.status === "failed"
    ? "failed"
    : manifest.status === "stopped"
      ? "stopped"
      : stale
        ? "stale"
        : "running";
  return { ...manifest, health, warnings };
}

async function writeManifest(registryDir: string, manifest: TraceSourceManifest): Promise<void> {
  try {
    await mkdir(registryDir, { recursive: true });
    const path = manifestPath(registryDir, manifest.sourceId);
    await writeJsonAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    throw new TraceSourceRegistryError("manifest_write_failed", "Unable to write trace source manifest.", {
      cause: errorMessage(error),
    });
  }
}

function manifestPath(registryDir: string, sourceId: string): string {
  return safeJoin(registryDir, `${normalizeSourceId(sourceId)}${MANIFEST_SUFFIX}`);
}

interface NormalizedRegistryOptions {
  readonly registryDir: string;
  readonly staleAfterMs: number;
  readonly clock: () => number;
}

interface NormalizedRunListOptions extends NormalizedRegistryOptions {
  readonly maxRuns: number;
  readonly maxEventsPerRun: number;
  readonly maxStringBytes: number;
}

function raiseRegistryOption(message: string, field: string): never {
  throw new TraceSourceRegistryError("invalid_registry_options", message, { field });
}

function normalizeRunListOptions(options: TraceRunListOptions): NormalizedRunListOptions {
  return {
    ...normalizeRegistryOptions(options),
    maxRuns: positiveInteger(options.maxRuns, DEFAULT_MAX_RUNS, "maxRuns", raiseRegistryOption),
    maxEventsPerRun: positiveInteger(options.maxEventsPerRun, DEFAULT_MAX_EVENTS_PER_RUN, "maxEventsPerRun", raiseRegistryOption),
    maxStringBytes: minInteger(options.maxStringBytes, DEFAULT_MAX_STRING_BYTES, 64, "maxStringBytes", raiseRegistryOption),
  };
}

function normalizeRegistryOptions(options: TraceSourceRegistryOptions): NormalizedRegistryOptions {
  if (typeof options.registryDir !== "string" || options.registryDir.trim().length === 0) {
    throw new TraceSourceRegistryError("invalid_registry_options", "registryDir must be a non-empty path.");
  }
  return {
    registryDir: resolve(options.registryDir),
    staleAfterMs: positiveInteger(options.staleAfterMs, DEFAULT_STALE_AFTER_MS, "staleAfterMs", raiseRegistryOption),
    clock: options.clock ?? (() => Date.now()),
  };
}

function readerOptionsForSource(artifactDir: string, options: NormalizedRunListOptions): JsonlRunReaderOptions {
  return {
    artifactDir,
    maxRuns: options.maxRuns,
    maxEventsPerRun: options.maxEventsPerRun,
    maxStringBytes: options.maxStringBytes,
  };
}

function normalizeSourceId(sourceId: string): string {
  const normalized = normalizeNonEmpty(sourceId, "sourceId");
  if (!SOURCE_ID_PATTERN.test(normalized) || normalized.includes("..")) {
    throw new TraceSourceRegistryError("invalid_source_id", "sourceId must contain only letters, numbers, dot, underscore, or hyphen and cannot contain '..'.");
  }
  return normalized;
}

function normalizeRunId(runId: string): string {
  return normalizeRunIdGuard(
    runId,
    (message) => {
      throw new TraceSourceRegistryError("invalid_run_id", message);
    },
    () => {
      throw new TraceSourceRegistryError("invalid_registry_options", "runId must be a non-empty string.", { field: "runId" });
    },
  );
}

function sourceIdFromLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "source";
}

function sourceStatus(value: unknown): TraceSourceStatus | undefined {
  return value === "running" || value === "stopped" || value === "failed" ? value : undefined;
}

function compareSources(a: TraceSourceListItem, b: TraceSourceListItem): number {
  const byUpdated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return byUpdated === 0 ? a.sourceId.localeCompare(b.sourceId) : byUpdated;
}

function runUpdatedAtMs(run: TraceRunListItem): number {
  const parsed = Date.parse(run.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareTraceRuns(a: TraceRunListItem, b: TraceRunListItem): number {
  const byUpdated = runUpdatedAtMs(b) - runUpdatedAtMs(a);
  if (byUpdated !== 0) {
    return byUpdated;
  }
  const bySource = b.source.sourceId.localeCompare(a.source.sourceId);
  if (bySource !== 0) {
    return bySource;
  }
  return b.runId.localeCompare(a.runId);
}

async function artifactDirExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    return false;
  }
}

function resolvePath(path: string, field: string): string {
  return resolve(normalizeNonEmpty(path, field));
}

function normalizeNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TraceSourceRegistryError("invalid_registry_options", `${field} must be a non-empty string.`, { field });
  }
  return value.trim();
}

function safeJoin(root: string, fileName: string): string {
  return safeJoinGuard(root, fileName, () => {
    throw new TraceSourceRegistryError("invalid_source_id", "Resolved manifest path escapes registryDir.");
  });
}

function isoNow(clock: () => number): string {
  return new Date(clock()).toISOString();
}
