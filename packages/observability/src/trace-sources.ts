import { readdir, readFile, rm, stat } from "node:fs/promises";
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
  PruneTraceSourcesOptions,
  PruneTraceSourcesResult,
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

/** Default retention window for {@link pruneTraceSources}: 7 days. */
export const DEFAULT_PRUNE_TRACE_SOURCES_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * Merge {@link listTraceSources} results from several registries (e.g. an
 * agent's own config-local registry plus the machine-wide global one) by
 * `sourceId`: a source unique to any list is kept as-is, and a source present
 * in more than one keeps whichever copy has the fresher `updatedAt` heartbeat
 * (earlier lists win ties). Object identity is preserved — a winner is the
 * exact item from the list it came from, so callers can attribute it back to
 * its origin registry, and its absolute `artifactDir`/`configPath` ride
 * along. The union is sorted like `listTraceSources` output (fresher first).
 */
export function mergeTraceSources(
  ...lists: ReadonlyArray<readonly TraceSourceListItem[]>
): TraceSourceListItem[] {
  const bySourceId = new Map<string, TraceSourceListItem>();
  // Later-processed entries win ties (>=), so process lists back-to-front to
  // give EARLIER lists tie precedence.
  for (let index = lists.length - 1; index >= 0; index -= 1) {
    for (const source of lists[index] ?? []) {
      const existing = bySourceId.get(source.sourceId);
      if (existing === undefined || Date.parse(source.updatedAt) >= Date.parse(existing.updatedAt)) {
        bySourceId.set(source.sourceId, source);
      }
    }
  }
  return [...bySourceId.values()].sort(compareSources);
}

/**
 * Delete stale, dead manifests from a registry directory: registrations pile
 * up over time from ephemeral/test runs and crashed processes, and nothing
 * else ever removes them. A manifest is removed only when BOTH hold: its
 * heartbeat (`updatedAt`) is older than `olderThanMs` (default
 * {@link DEFAULT_PRUNE_TRACE_SOURCES_OLDER_THAN_MS}), AND its `pid` is not
 * alive (a manifest with no recorded pid cannot be verified alive, so it is
 * treated as prunable once it is old enough). A live pid is never removed
 * regardless of age, and a fresh-but-dead manifest (a just-crashed process)
 * is kept so `status`/the picker still surface it as stopped/failed.
 *
 * Never throws: an unreadable registry directory, a per-file read/parse
 * failure, or a delete race (another writer already removed the file) are all
 * swallowed so this can always be called fire-and-forget.
 */
export async function pruneTraceSources(options: PruneTraceSourcesOptions): Promise<PruneTraceSourcesResult> {
  const olderThanMs = options.olderThanMs ?? DEFAULT_PRUNE_TRACE_SOURCES_OLDER_THAN_MS;
  const isAlive = options.isAlive ?? defaultPidIsAlive;
  const now = options.clock?.() ?? Date.now();

  let registryDir: string;
  let entries;
  try {
    registryDir = resolve(options.registryDir);
    entries = await readdir(registryDir, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(MANIFEST_SUFFIX)) {
      continue;
    }
    try {
      const path = safeJoin(registryDir, entry.name);
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const pid = typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
      if (pid !== undefined && isAlive(pid)) {
        continue;
      }
      const updatedAtMs = typeof parsed.updatedAt === "string" ? Date.parse(parsed.updatedAt) : NaN;
      if (!Number.isFinite(updatedAtMs) || now - updatedAtMs < olderThanMs) {
        continue;
      }
      await rm(path, { force: true });
      removed += 1;
    } catch {
      // Malformed manifest or a concurrent-writer race: leave it for the next pass.
      continue;
    }
  }
  return { removed };
}

function defaultPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return isErrno(error, "EPERM");
  }
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
      runs.push({ ...run, traceSource: source });
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
  return run === undefined ? undefined : { traceSource: source, run };
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
    schema: "agent-runtime.trace-source.v1",
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
  if (value.schema !== "agent-runtime.trace-source.v1") {
    warnings.push(`Skipping ${fileName}: manifest schema is not agent-runtime.trace-source.v1.`);
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
  const bySource = b.traceSource.sourceId.localeCompare(a.traceSource.sourceId);
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
