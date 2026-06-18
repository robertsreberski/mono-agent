import { join, resolve } from "node:path";

import { DEFAULT_MAX_STRING_BYTES, mkdir, safeArtifactName, writeJsonAtomic } from "./artifact-fs.js";
import { errorFailureKind, errorToJson, redactJsonValue } from "./redaction.js";
import type { JsonlRunRecorderOptions, RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "./types.js";

// `redactJsonValue` is re-exported so existing importers (recorder.test.ts
// imports it via "../recorder.js") keep their import surface unchanged.
export { redactJsonValue };

export type ObservabilityErrorCode = "invalid_recorder_options" | "artifact_write_failed";
export type ObservabilityErrorDetails = Record<string, unknown> & { readonly code: ObservabilityErrorCode };

export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode;
  readonly details: ObservabilityErrorDetails;

  constructor(code: ObservabilityErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ObservabilityError";
    this.code = code;
    this.details = { ...details, code };
  }
}

class JsonlRunRecorder implements RunRecorder {
  private readonly runId: string;
  private readonly conversationId: string;
  private readonly artifactDir: string;
  private readonly clock: () => number;
  private readonly maxStringBytes: number;
  private readonly startedAt: number;
  private readonly startedAtIso: string;
  private readonly events: RuntimeEventLike[] = [];
  private readonly userInput: string | undefined;

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
    this.userInput =
      typeof options.userInput === "string"
        ? (redactJsonValue(options.userInput, this.maxStringBytes) as string)
        : undefined;
    this.startedAt = this.clock();
    this.startedAtIso = new Date(this.startedAt).toISOString();
  }

  async start(): Promise<RunSummary> {
    return await this.writeArtifacts(this.buildSummary("running", undefined, {}));
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
    const now = this.clock();
    const nowIso = new Date(now).toISOString();
    const summary: RunSummary = {
      runId: this.runId,
      conversationId: this.conversationId,
      status,
      ...(failureKind === undefined ? {} : { failureKind }),
      startedAt: this.startedAtIso,
      ...(status === "running" ? {} : { endedAt: nowIso }),
      updatedAt: nowIso,
      durationMs: Math.max(0, now - this.startedAt),
      ...(result.usage === undefined ? {} : { usage: redactJsonValue(result.usage, this.maxStringBytes) }),
      ...(result.cost === undefined ? {} : { cost: redactJsonValue(result.cost, this.maxStringBytes) }),
      ...(result.providerSessionId === undefined ? {} : { providerSessionId: result.providerSessionId }),
      eventCount: this.events.length,
      artifactPaths: this.artifactPaths(),
      ...(this.userInput === undefined ? {} : { userInput: this.userInput }),
      ...(result.runtimeWarnings === undefined ? {} : { runtimeWarnings: redactJsonValue(result.runtimeWarnings, this.maxStringBytes) }),
      ...(result.diagnostics === undefined ? {} : { diagnostics: redactJsonValue(result.diagnostics, this.maxStringBytes) }),
      ...(result.capabilitiesUsed === undefined ? {} : { capabilitiesUsed: redactJsonValue(result.capabilitiesUsed, this.maxStringBytes) }),
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
      await writeJsonAtomic(eventsPath, eventsJsonl.length === 0 ? "" : `${eventsJsonl}\n`);
      await writeJsonAtomic(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
      return summary;
    } catch (error) {
      throw new ObservabilityError("artifact_write_failed", "Unable to write run artifacts.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createJsonlRunRecorder(options: JsonlRunRecorderOptions): RunRecorder {
  return new JsonlRunRecorder(options);
}

function normalizeId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ObservabilityError("invalid_recorder_options", `${field} must be a non-empty string.`, { field });
  }
  return value.trim();
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
