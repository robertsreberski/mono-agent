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
} from "./artifact-fs.js";
import { classifyAssistantContent, compactString } from "./content.js";
import { redactJsonValue } from "./recorder.js";
import type {
  JsonlRunReaderOptions,
  RecordedRunDetail,
  RecordedRunEvent,
  RecordedRunEventCategory,
  RecordedRunListItem,
  RecordedRunListResult,
  RunSummary,
  RunSummaryStatus,
} from "./types.js";

const SUMMARY_SUFFIX = ".summary.json";
const EVENTS_SUFFIX = ".events.jsonl";

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
      .sort((a: ParsedSummaryFile, b: ParsedSummaryFile) => summaryUpdatedAtMs(b) - summaryUpdatedAtMs(a))
      .slice(0, normalized.maxRuns)
      .map((entry) => summaryToListItem(entry.summary, entry.updatedAt, normalized.maxStringBytes)),
    warnings,
  };
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

export function classifyRecordedRunEvent(event: unknown): RecordedRunEventCategory {
  if (!isRecord(event)) {
    return "runtime";
  }
  const type = stringField(event, "type")?.toLowerCase() ?? "";
  if (
    type.includes("error") ||
    type.includes("failure") ||
    type.includes("failed") ||
    event.error !== undefined ||
    event.failureKind !== undefined
  ) {
    return "error";
  }
  if (
    type.includes("tool") ||
    stringField(event, "toolName") !== undefined ||
    stringField(event, "tool") !== undefined ||
    stringField(event, "tool_call_id") !== undefined ||
    stringField(event, "toolCallId") !== undefined
  ) {
    return "tool";
  }
  if (type.includes("thinking") || type.includes("reasoning") || type.includes("thought")) {
    return "thinking";
  }
  if (assistantMessageContentKind(event) === "thinking") {
    return "thinking";
  }
  if (type === "assistant" || type === "user" || type.includes("message") || event.message !== undefined) {
    return "message";
  }
  return "runtime";
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
  const status = runSummaryStatus(value.status);
  const durationMs = finiteNumberField(value, "durationMs");
  const eventCount = integerNumberField(value, "eventCount");
  if (runId === undefined || conversationId === undefined || status === undefined || durationMs === undefined || eventCount === undefined) {
    warnings.push(`Skipping ${fileName}: summary is missing required run metadata.`);
    return undefined;
  }

  const failureKind = stringField(value, "failureKind");
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
  const category = classifyRecordedRunEvent(payload);
  const record = isRecord(payload) ? payload : {};
  const type = stringField(record, "type");
  const timestamp = stringField(record, "timestamp") ?? stringField(record, "createdAt") ?? stringField(record, "time");
  return {
    index,
    ...(type === undefined ? {} : { type }),
    category,
    ...(timestamp === undefined ? {} : { timestamp }),
    label: eventLabel(record, category, type),
    summary: eventSummary(record, category, payload, maxStringBytes),
    payload,
  };
}

function eventLabel(record: Record<string, unknown>, category: RecordedRunEventCategory, type: string | undefined): string {
  const toolName = stringField(record, "toolName") ?? stringField(record, "tool") ?? stringField(record, "name");
  if (category === "tool" && toolName !== undefined) {
    return `Tool: ${toolName}`;
  }
  const role = stringField(record, "role");
  if (category === "message" && role !== undefined) {
    return `Message: ${role}`;
  }
  if (category === "thinking") {
    return type ?? "Reasoning event";
  }
  if (category === "error") {
    return type ?? stringField(record, "failureKind") ?? "Error";
  }
  return type ?? "Runtime event";
}

function eventSummary(
  record: Record<string, unknown>,
  category: RecordedRunEventCategory,
  payload: unknown,
  maxStringBytes: number,
): string {
  const direct = stringField(record, "summary") ?? stringField(record, "text") ?? stringField(record, "delta") ?? stringField(record, "error");
  if (direct !== undefined) {
    return compactString(direct);
  }
  const messageText = textFromMessage(record.message);
  if (messageText !== undefined) {
    return compactString(messageText);
  }
  if (category === "tool") {
    const status = stringField(record, "status") ?? stringField(record, "state");
    const toolName = stringField(record, "toolName") ?? stringField(record, "tool") ?? stringField(record, "name");
    if (toolName !== undefined && status !== undefined) {
      return `${toolName} — ${status}`;
    }
    if (toolName !== undefined) {
      return toolName;
    }
  }
  if (category === "thinking") {
    return "Runtime emitted a reasoning/thinking process event.";
  }
  return compactString(JSON.stringify(redactJsonValue(payload, maxStringBytes)));
}

function textFromMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const content = value.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}

function assistantMessageContentKind(event: Record<string, unknown>): "thinking" | "text" | undefined {
  if (stringField(event, "type") !== "assistant") {
    return undefined;
  }
  return classifyAssistantContent(event.message)?.kind;
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

function runSummaryStatus(value: unknown): RunSummaryStatus | undefined {
  return value === "running" || value === "succeeded" || value === "failed" || value === "cancelled" ? value : undefined;
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
