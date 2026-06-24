import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_MAX_EVENTS_PER_RUN,
  DEFAULT_MAX_RUNS,
  DEFAULT_MAX_STRING_BYTES,
  errorMessage,
  isErrno,
  isRecord,
  minInteger,
  normalizeRunId as normalizeRunIdGuard,
  positiveInteger,
  safeArtifactName,
  safeJoin as safeJoinGuard,
  stringField,
  writeJsonAtomic,
} from "./artifact-fs.js";
import { buildEventDescriptors, classifyRecordedRunEvent } from "./event-classify.js";
import { redactJsonValue } from "./recorder.js";
import { normalizeFailoverHistory } from "./run-export-mapping.js";
import {
  EVENTS_SUFFIX,
  SUMMARY_SUFFIX,
  isRunSummaryStatus,
  isStaleRunningSummary,
} from "./summary-schema.js";
import type {
  JsonlRunReaderOptions,
  RecordedRunDetail,
  RecordedRunEvent,
  RecordedRunListItem,
  RecordedRunListResult,
  RunSummary,
  RunSummaryStatus,
  RuntimeEventLike,
} from "./types.js";

export { classifyRecordedRunEvent };

interface NormalizedReaderOptions {
  readonly artifactDir: string;
  readonly maxRuns: number;
  readonly maxEventsPerRun: number;
  readonly maxStringBytes: number;
}

interface ParsedSummaryFile {
  readonly fileName: string;
  readonly summary: RunSummary;
  readonly updatedAt: string;
  readonly mtimeMs: number;
}

export type ObservabilityReadErrorCode = "invalid_reader_options" | "invalid_run_id";
export type ObservabilityReadErrorDetails = Record<string, unknown> & { readonly code: ObservabilityReadErrorCode };

export class ObservabilityReadError extends Error {
  readonly code: ObservabilityReadErrorCode;
  readonly details: ObservabilityReadErrorDetails;

  constructor(code: ObservabilityReadErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ObservabilityReadError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export async function listRecordedRuns(options: JsonlRunReaderOptions): Promise<RecordedRunListResult> {
  const normalized = normalizeReaderOptions(options);
  const { summaries, warnings } = await loadSummaryFiles(normalized);
  return {
    runs: [...summaries]
      // Newest first by logical update time, with file mtime then runId as deterministic
      // tiebreakers — two runs finishing in the same millisecond share an `updatedAt`, and
      // without a tiebreaker their order (and any top-N slice) is unstable.
      .sort(
        (a: ParsedSummaryFile, b: ParsedSummaryFile) =>
          summaryUpdatedAtMs(b) - summaryUpdatedAtMs(a)
          || b.mtimeMs - a.mtimeMs
          || b.summary.runId.localeCompare(a.summary.runId),
      )
      .slice(0, normalized.maxRuns)
      .map((entry) => summaryToListItem(entry.summary, entry.updatedAt, normalized.maxStringBytes)),
    warnings,
  };
}

export interface ReconcileStaleRunsResult {
  /** runIds whose summaries were rewritten from "running" to "interrupted". */
  readonly reconciled: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Reclaims orphaned run summaries: a process that dies mid-run (OOM/SIGKILL/crash) leaves its
 * summary stuck at status "running" forever, so `status`/observability show a ghost run that never
 * ends. On startup the host calls this to rewrite any "running" summary that began BEFORE this
 * process started to status "interrupted" (failureKind "process_death"). Runs started at/after
 * `startedBeforeMs` belong to the live process and are left untouched — so this is safe to call
 * once at startup, before new runs begin. Read-only-safe and best-effort: a bad file is skipped
 * with a warning, never thrown.
 */
export async function reconcileStaleRunArtifacts(
  artifactDir: string,
  options: { readonly startedBeforeMs: number; readonly clock?: () => number },
): Promise<ReconcileStaleRunsResult> {
  const warnings: string[] = [];
  const reconciled: string[] = [];
  const now = (options.clock ?? (() => Date.now()))();
  const nowIso = new Date(now).toISOString();

  let entries;
  try {
    entries = await readdir(resolve(artifactDir), { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { reconciled, warnings };
    }
    return { reconciled, warnings: [`Unable to read artifact directory: ${errorMessage(error)}.`] };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SUMMARY_SUFFIX)) {
      continue;
    }
    const filePath = safeJoin(resolve(artifactDir), entry.name);
    let parsed: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
      if (!isRecord(raw)) {
        continue;
      }
      parsed = raw;
    } catch {
      continue; // unreadable/invalid summary — leave it for the reader's own warnings
    }
    // Only reclaim runs that began before this process started — a live run of THIS process
    // (started at/after the cutoff) is genuinely in flight and must not be touched.
    if (!isStaleRunningSummary(parsed, options.startedBeforeMs)) {
      continue;
    }
    const updated = {
      ...parsed,
      status: "interrupted",
      failureKind: typeof parsed.failureKind === "string" ? parsed.failureKind : "process_death",
      endedAt: typeof parsed.endedAt === "string" ? parsed.endedAt : nowIso,
      updatedAt: nowIso,
    };
    try {
      await writeJsonAtomic(filePath, `${JSON.stringify(updated, null, 2)}\n`);
      reconciled.push(typeof parsed.runId === "string" ? parsed.runId : entry.name.slice(0, -SUMMARY_SUFFIX.length));
    } catch (error) {
      warnings.push(`Unable to reconcile ${entry.name}: ${errorMessage(error)}.`);
    }
  }

  return { reconciled, warnings };
}

export async function readRecordedRun(
  options: JsonlRunReaderOptions,
  runId: string,
): Promise<RecordedRunDetail | undefined> {
  const normalized = normalizeReaderOptions(options);
  const normalizedRunId = normalizeRunId(runId);
  const baseName = safeArtifactName(normalizedRunId);
  const summaryPath = safeJoin(normalized.artifactDir, `${baseName}${SUMMARY_SUFFIX}`);
  const warnings: string[] = [];

  const summary = await readSummaryFile(summaryPath, `${baseName}${SUMMARY_SUFFIX}`, normalized, warnings);
  if (summary === undefined || summary.summary.runId !== normalizedRunId) {
    return undefined;
  }

  const eventsPath = safeJoin(normalized.artifactDir, `${baseName}${EVENTS_SUFFIX}`);
  const events = await readEventsFile(eventsPath, normalized, warnings);

  return {
    summary: summaryToListItem(summary.summary, summary.updatedAt, normalized.maxStringBytes),
    events,
    warnings,
  };
}

async function loadSummaryFiles(normalized: NormalizedReaderOptions): Promise<{
  readonly summaries: readonly ParsedSummaryFile[];
  readonly warnings: readonly string[];
}> {
  const warnings: string[] = [];
  let entries;
  try {
    entries = await readdir(normalized.artifactDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { summaries: [], warnings };
    }
    return {
      summaries: [],
      warnings: [`Unable to read artifact directory: ${errorMessage(error)}.`],
    };
  }

  const summaries: ParsedSummaryFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SUMMARY_SUFFIX)) {
      continue;
    }
    const filePath = safeJoin(normalized.artifactDir, entry.name);
    const parsed = await readSummaryFile(filePath, entry.name, normalized, warnings);
    if (parsed !== undefined) {
      summaries.push(parsed);
    }
  }
  return { summaries, warnings };
}

async function readSummaryFile(
  filePath: string,
  fileName: string,
  normalized: NormalizedReaderOptions,
  warnings: string[],
): Promise<ParsedSummaryFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    warnings.push(`Unable to read ${fileName}: ${errorMessage(error)}.`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`Skipping ${fileName}: invalid JSON (${errorMessage(error)}).`);
    return undefined;
  }

  const summary = coerceRunSummary(parsed, fileName, warnings, normalized.maxStringBytes);
  if (summary === undefined) {
    return undefined;
  }

  let stats;
  try {
    stats = await stat(filePath);
  } catch (error) {
    warnings.push(`Unable to stat ${fileName}: ${errorMessage(error)}.`);
    return undefined;
  }

  return {
    fileName,
    summary,
    updatedAt: stats.mtime.toISOString(),
    mtimeMs: stats.mtimeMs,
  };
}

async function readEventsFile(
  filePath: string,
  normalized: NormalizedReaderOptions,
  warnings: string[],
): Promise<readonly RecordedRunEvent[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      warnings.push("Event artifact is missing for this run.");
      return [];
    }
    warnings.push(`Unable to read event artifact: ${errorMessage(error)}.`);
    return [];
  }

  const events: RecordedRunEvent[] = [];
  const lines = raw.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    if (events.length >= normalized.maxEventsPerRun) {
      warnings.push(`Event list was capped at ${normalized.maxEventsPerRun} events.`);
      break;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      events.push(toRecordedEvent(parsed, events.length, normalized.maxStringBytes));
    } catch (error) {
      warnings.push(`Skipping malformed event line ${i + 1}: ${errorMessage(error)}.`);
    }
  }
  return events;
}

function coerceRunSummary(
  value: unknown,
  fileName: string,
  warnings: string[],
  maxStringBytes: number,
): RunSummary | undefined {
  if (!isRecord(value)) {
    warnings.push(`Skipping ${fileName}: summary is not an object.`);
    return undefined;
  }
  const runId = stringField(value, "runId");
  const conversationId = stringField(value, "conversationId");
  const status = isRunSummaryStatus(value.status) ? value.status : undefined;
  const durationMs = finiteNumberField(value, "durationMs");
  const eventCount = integerNumberField(value, "eventCount");
  if (runId === undefined || conversationId === undefined || status === undefined || durationMs === undefined || eventCount === undefined) {
    warnings.push(`Skipping ${fileName}: summary is missing required run metadata.`);
    return undefined;
  }

  const failureKind = stringField(value, "failureKind");
  const error = stringField(value, "error");
  const failoverHistory = normalizeFailoverHistory(value.failoverHistory);
  const startedAt = stringField(value, "startedAt");
  const endedAt = stringField(value, "endedAt");
  const updatedAt = stringField(value, "updatedAt");
  const providerSessionId = providerSessionIdField(value.providerSessionId);
  const artifactPaths = Array.isArray(value.artifactPaths) ? value.artifactPaths.filter((entry): entry is string => typeof entry === "string") : [];
  const summary: RunSummary = {
    runId,
    conversationId,
    status,
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(error === undefined ? {} : { error: redactJsonValue(error, maxStringBytes) as string }),
    ...(failoverHistory === undefined ? {} : { failoverHistory }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    durationMs,
    ...(value.usage === undefined ? {} : { usage: redactJsonValue(value.usage, maxStringBytes) }),
    ...(value.cost === undefined ? {} : { cost: redactJsonValue(value.cost, maxStringBytes) }),
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    eventCount,
    artifactPaths,
    ...(value.runtimeWarnings === undefined ? {} : { runtimeWarnings: redactJsonValue(value.runtimeWarnings, maxStringBytes) }),
    ...(value.diagnostics === undefined ? {} : { diagnostics: redactJsonValue(value.diagnostics, maxStringBytes) }),
    ...(value.capabilitiesUsed === undefined ? {} : { capabilitiesUsed: redactJsonValue(value.capabilitiesUsed, maxStringBytes) }),
  };
  return summary;
}

function summaryToListItem(summary: RunSummary, updatedAt: string, maxStringBytes: number): RecordedRunListItem {
  return {
    runId: summary.runId,
    conversationId: summary.conversationId,
    status: summary.status,
    ...(summary.failureKind === undefined ? {} : { failureKind: summary.failureKind }),
    ...(summary.error === undefined ? {} : { error: summary.error }),
    ...(summary.failoverHistory === undefined ? {} : { failoverHistory: summary.failoverHistory }),
    ...(summary.startedAt === undefined ? {} : { startedAt: summary.startedAt }),
    ...(summary.endedAt === undefined ? {} : { endedAt: summary.endedAt }),
    durationMs: summary.durationMs,
    eventCount: summary.eventCount,
    updatedAt: summary.updatedAt ?? updatedAt,
    ...(summary.usage === undefined ? {} : { usage: redactJsonValue(summary.usage, maxStringBytes) }),
    ...(summary.cost === undefined ? {} : { cost: redactJsonValue(summary.cost, maxStringBytes) }),
    ...(summary.providerSessionId === undefined ? {} : { providerSessionId: summary.providerSessionId }),
    ...(summary.runtimeWarnings === undefined ? {} : { runtimeWarnings: redactJsonValue(summary.runtimeWarnings, maxStringBytes) }),
    ...(summary.diagnostics === undefined ? {} : { diagnostics: redactJsonValue(summary.diagnostics, maxStringBytes) }),
    ...(summary.capabilitiesUsed === undefined ? {} : { capabilitiesUsed: redactJsonValue(summary.capabilitiesUsed, maxStringBytes) }),
  };
}

function toRecordedEvent(raw: unknown, index: number, maxStringBytes: number): RecordedRunEvent {
  const payload = redactJsonValue(raw, maxStringBytes);
  const record = isRecord(payload) ? payload : {};
  const type = stringField(record, "type");
  const timestamp = stringField(record, "timestamp") ?? stringField(record, "createdAt") ?? stringField(record, "time");
  // Use the shared single-source-of-truth descriptors so the reader and the
  // export path always agree on category/label/summary. buildEventDescriptors
  // redacts the raw event itself (mirroring the prior inline path: redact ->
  // classify -> eventLabel/eventSummary), so we pass the RAW event in.
  const { category, label, summary } = buildEventDescriptors(raw as RuntimeEventLike, maxStringBytes);
  return {
    index,
    ...(type === undefined ? {} : { type }),
    category,
    ...(timestamp === undefined ? {} : { timestamp }),
    label,
    summary,
    payload,
  };
}

function normalizeReaderOptions(options: JsonlRunReaderOptions): NormalizedReaderOptions {
  if (typeof options.artifactDir !== "string" || options.artifactDir.trim().length === 0) {
    throw new ObservabilityReadError("invalid_reader_options", "artifactDir must be a non-empty path.");
  }
  const raiseOptions = (message: string, field: string): never => {
    throw new ObservabilityReadError("invalid_reader_options", message, { field });
  };
  return {
    artifactDir: resolve(options.artifactDir),
    maxRuns: positiveInteger(options.maxRuns, DEFAULT_MAX_RUNS, "maxRuns", raiseOptions),
    maxEventsPerRun: positiveInteger(options.maxEventsPerRun, DEFAULT_MAX_EVENTS_PER_RUN, "maxEventsPerRun", raiseOptions),
    maxStringBytes: minInteger(options.maxStringBytes, DEFAULT_MAX_STRING_BYTES, 64, "maxStringBytes", raiseOptions),
  };
}

function normalizeRunId(runId: string): string {
  return normalizeRunIdGuard(runId, (message) => {
    throw new ObservabilityReadError("invalid_run_id", message);
  });
}

function safeJoin(root: string, fileName: string): string {
  return safeJoinGuard(root, fileName, () => {
    throw new ObservabilityReadError("invalid_run_id", "Resolved artifact path escapes artifactDir.");
  });
}

function summaryUpdatedAtMs(entry: ParsedSummaryFile): number {
  const parsed = entry.summary.updatedAt === undefined ? Number.NaN : Date.parse(entry.summary.updatedAt);
  return Number.isFinite(parsed) ? parsed : entry.mtimeMs;
}

function providerSessionIdField(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function finiteNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
