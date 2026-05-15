import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { JsonlRunRecorderOptions, RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "./types.js";

const DEFAULT_MAX_STRING_BYTES = 4_096;
const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|api[_-]?key|cookie)/iu;

export class ObservabilityError extends Error {
  readonly code: "invalid_recorder_options" | "artifact_write_failed";
  readonly details: Record<string, unknown>;

  constructor(code: ObservabilityError["code"], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ObservabilityError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export class JsonlRunRecorder implements RunRecorder {
  private readonly runId: string;
  private readonly conversationId: string;
  private readonly artifactDir: string;
  private readonly clock: () => number;
  private readonly maxStringBytes: number;
  private readonly startedAt: number;
  private readonly events: RuntimeEventLike[] = [];

  constructor(options: JsonlRunRecorderOptions) {
    this.runId = normalizeId(options.runId, "runId");
    this.conversationId = normalizeId(options.conversationId, "conversationId");
    if (typeof options.artifactDir !== "string" || options.artifactDir.trim().length === 0) {
      throw new ObservabilityError("invalid_recorder_options", "artifactDir must be a non-empty path.");
    }
    if (options.maxStringBytes !== undefined && (!Number.isInteger(options.maxStringBytes) || options.maxStringBytes < 64)) {
      throw new ObservabilityError("invalid_recorder_options", "maxStringBytes must be an integer of at least 64.");
    }
    this.artifactDir = resolve(options.artifactDir);
    this.clock = options.clock ?? (() => Date.now());
    this.maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
    this.startedAt = this.clock();
  }

  onEvent(event: RuntimeEventLike): void {
    this.events.push(redactJsonValue(event, this.maxStringBytes) as RuntimeEventLike);
  }

  async finish(result: RuntimeResultLike): Promise<RunSummary> {
    const status = result.cancelled === true ? "cancelled" : runtimeFailureKind(result) === undefined ? "succeeded" : "failed";
    const baseSummary = this.buildSummary(status, runtimeFailureKind(result), result);
    return await this.writeArtifacts(baseSummary);
  }

  async fail(error: unknown): Promise<RunSummary> {
    const failureKind = errorFailureKind(error);
    const summary = this.buildSummary("failed", failureKind, {
      diagnostics: {
        error: redactJsonValue(errorToJson(error), this.maxStringBytes),
      },
    });
    return await this.writeArtifacts(summary);
  }

  private buildSummary(status: RunSummary["status"], failureKind: string | undefined, result: RuntimeResultLike): RunSummary {
    const summary: RunSummary = {
      runId: this.runId,
      conversationId: this.conversationId,
      status,
      ...(failureKind === undefined ? {} : { failureKind }),
      durationMs: Math.max(0, this.clock() - this.startedAt),
      ...(result.usage === undefined ? {} : { usage: redactJsonValue(result.usage, this.maxStringBytes) }),
      ...(result.providerSessionId === undefined ? {} : { providerSessionId: result.providerSessionId }),
      eventCount: this.events.length,
      artifactPaths: this.artifactPaths(),
      ...(result.runtimeWarnings === undefined ? {} : { runtimeWarnings: redactJsonValue(result.runtimeWarnings, this.maxStringBytes) }),
      ...(result.diagnostics === undefined ? {} : { diagnostics: redactJsonValue(result.diagnostics, this.maxStringBytes) }),
    };
    return summary;
  }

  private artifactPaths(): readonly string[] {
    const base = safeArtifactName(this.runId);
    return [join(this.artifactDir, `${base}.events.jsonl`), join(this.artifactDir, `${base}.summary.json`)];
  }

  private async writeArtifacts(summary: RunSummary): Promise<RunSummary> {
    const [eventsPath, summaryPath] = summary.artifactPaths;
    if (eventsPath === undefined || summaryPath === undefined) {
      throw new ObservabilityError("artifact_write_failed", "Recorder artifact paths were not generated.");
    }
    try {
      await mkdir(this.artifactDir, { recursive: true });
      const eventsJsonl = this.events.map((event) => JSON.stringify(event)).join("\n");
      await writeFile(eventsPath, eventsJsonl.length === 0 ? "" : `${eventsJsonl}\n`, "utf8");
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      return summary;
    } catch (error) {
      throw new ObservabilityError("artifact_write_failed", "Unable to write run artifacts.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createJsonlRunRecorder(options: JsonlRunRecorderOptions): JsonlRunRecorder {
  return new JsonlRunRecorder(options);
}

export function redactJsonValue(value: unknown, maxStringBytes = DEFAULT_MAX_STRING_BYTES): unknown {
  return redact(value, maxStringBytes, 0, undefined, new WeakSet<object>());
}

function redact(value: unknown, maxStringBytes: number, depth: number, key: string | undefined, seen: WeakSet<object>): unknown {
  if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value, maxStringBytes);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value instanceof Error) {
    return errorToJson(value);
  }
  if (depth >= 12) {
    return "[max-depth]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, maxStringBytes, depth + 1, undefined, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    out[entryKey] = redact(entryValue, maxStringBytes, depth + 1, entryKey, seen);
  }
  return out;
}

function truncateString(value: string, maxStringBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxStringBytes) {
    return value;
  }
  return `${value.slice(0, maxStringBytes)}…[truncated ${bytes - maxStringBytes} bytes]`;
}

function normalizeId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ObservabilityError("invalid_recorder_options", `${field} must be a non-empty string.`, { field });
  }
  return value.trim();
}

function safeArtifactName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "run";
}

function runtimeFailureKind(result: RuntimeResultLike): string | undefined {
  if (typeof result.failureKind === "string" && result.failureKind.trim().length > 0) {
    return result.failureKind;
  }
  if (typeof result.error === "string" && result.error.trim().length > 0) {
    return "runtime_error";
  }
  return undefined;
}

function errorFailureKind(error: unknown): string {
  if (typeof error === "object" && error !== null && "failureKind" in error) {
    const failureKind = (error as { readonly failureKind?: unknown }).failureKind;
    if (typeof failureKind === "string" && failureKind.trim().length > 0) {
      return failureKind;
    }
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return "exception";
}

function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { message: String(error) };
}
