import { resolve } from "node:path";
import process from "node:process";

import {
  listRecordedRuns,
  ObservabilityReadError,
  readRecordedRun,
  redactJsonValue,
  truncateVisibleText,
} from "@mono-agent/observability";
import type {
  JsonlRunReaderOptions,
  RecordedRunDetail,
  RecordedRunListResult,
} from "@mono-agent/observability";

import { resolveAppArtifactDir } from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import * as ui from "./ui.js";

export const RUN_INSPECTION_MAX_RUNS = 50;
export const RUN_INSPECTION_MAX_EVENTS = 500;
export const RUN_INSPECTION_MAX_STRING_BYTES = 32 * 1_024;
const RUN_INSPECTION_MAX_WARNINGS = 50;

interface RunInspectionCommonArgs {
  readonly configPath?: string;
  readonly artifactDir?: string;
  readonly includeMemory?: boolean;
  readonly json?: boolean;
}

export type RunInspectionArgs = RunInspectionCommonArgs & (
  | { readonly mode: "list"; readonly runId?: never }
  | { readonly mode: "show"; readonly runId: string }
);

export interface RunInspectionDependencies {
  readonly resolveArtifactDir: (input: MonoAgentAppConfigInput) => Promise<string>;
  readonly listRuns: (options: JsonlRunReaderOptions) => Promise<RecordedRunListResult>;
  readonly readRun: (options: JsonlRunReaderOptions, runId: string) => Promise<RecordedRunDetail | undefined>;
}

const DEFAULT_DEPENDENCIES: RunInspectionDependencies = {
  resolveArtifactDir: resolveAppArtifactDir,
  listRuns: listRecordedRuns,
  readRun: readRecordedRun,
};

/**
 * Read-only, offline run inspection. Persisted artifacts are trusted local input,
 * but every emitted value is independently redacted, bounded and terminal-safe.
 */
export async function runInspection(
  args: RunInspectionArgs,
  dependencies: RunInspectionDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  let artifactDir: string;
  try {
    const cwd = process.cwd();
    artifactDir = args.artifactDir === undefined
      ? await dependencies.resolveArtifactDir({
          env: process.env,
          cwd,
          configPath: resolve(cwd, args.configPath ?? "mono-agent.config.json"),
        })
      : resolve(cwd, args.artifactDir);
  } catch {
    writeRunInspectionFailure(args.json === true, "runs_read_failed");
    return 1;
  }

  if (args.mode === "list") {
    try {
      const result = await dependencies.listRuns({
        artifactDir,
        scope: args.includeMemory === true ? "all" : "agent",
        maxRuns: RUN_INSPECTION_MAX_RUNS,
        maxStringBytes: RUN_INSPECTION_MAX_STRING_BYTES,
      });
      const output = {
        ok: true,
        totalRuns: result.totalRuns,
        runs: result.runs,
        warnings: boundWarnings(result.warnings),
      } as const;
      if (args.json === true) {
        writeSafeJson(output);
      } else {
        process.stdout.write(renderRunList(output));
      }
      return 0;
    } catch {
      writeRunInspectionFailure(args.json === true, "runs_read_failed");
      return 1;
    }
  }

  try {
    const readerOptions = {
      artifactDir,
      maxEventsPerRun: RUN_INSPECTION_MAX_EVENTS,
      eventSelection: "head-tail",
      maxStringBytes: RUN_INSPECTION_MAX_STRING_BYTES,
    } as const;
    // A root-level agent run wins an identical-id collision. The memory namespace
    // is consulted only when explicitly requested and the agent scope had no hit.
    const agentRun = await dependencies.readRun({ ...readerOptions, scope: "agent" }, args.runId);
    const run = agentRun ?? (args.includeMemory === true
      ? await dependencies.readRun({ ...readerOptions, scope: "memory" }, args.runId)
      : undefined);
    if (run === undefined) {
      writeRunInspectionFailure(args.json === true, "run_not_found");
      return 1;
    }
    const output = {
      ok: true,
      run: {
        summary: run.summary,
        events: run.events,
        warnings: boundWarnings(run.warnings),
      },
    } as const;
    if (args.json === true) {
      writeSafeJson(output);
    } else {
      process.stdout.write(renderRunDetail(output.run));
    }
    return 0;
  } catch (error) {
    if (error instanceof ObservabilityReadError && error.code === "invalid_run_id") {
      writeRunInspectionUsageFailure(args.json === true);
      return 2;
    }
    writeRunInspectionFailure(args.json === true, "runs_read_failed");
    return 1;
  }
}

export function isRunInspectionInvocation(argv: readonly string[]): boolean {
  if (argv[0] !== "runs") return false;
  const mode = argv.slice(1).find((token) => ["report", "audit", "list", "show"].includes(token));
  return mode === "list" || mode === "show";
}

export function writeRunInspectionUsageFailure(json: boolean): void {
  const message = "Usage: mono-agent runs list [--artifacts <path>] [--include-memory] [--json] | mono-agent runs show <run-id> [--artifacts <path>] [--include-memory] [--json]";
  if (json) {
    writeSafeJson({ ok: false, error: { code: "runs_usage", message } });
  } else {
    process.stderr.write(ui.errorLine(`runs_usage: ${message}`));
  }
}

type RunInspectionFailureCode = "run_not_found" | "runs_read_failed";

function writeRunInspectionFailure(json: boolean, code: RunInspectionFailureCode): void {
  const message = code === "run_not_found"
    ? "Recorded run was not found."
    : "Unable to read recorded runs.";
  if (json) {
    writeSafeJson({ ok: false, error: { code, message } });
  } else {
    process.stderr.write(ui.errorLine(`${code}: ${message}`));
  }
}

function boundWarnings(warnings: readonly string[]): readonly string[] {
  if (warnings.length <= RUN_INSPECTION_MAX_WARNINGS) return warnings;
  const retained = RUN_INSPECTION_MAX_WARNINGS - 1;
  return [
    ...warnings.slice(0, retained),
    `${String(warnings.length - retained)} additional warnings omitted.`,
  ];
}

function writeSafeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(safeRunOutput(value), null, 2)}\n`);
}

function renderRunList(result: {
  readonly totalRuns: number;
  readonly runs: RecordedRunListResult["runs"];
  readonly warnings: readonly string[];
}): string {
  let output = `Recorded runs: ${String(result.totalRuns)} total (showing ${String(result.runs.length)})\n`;
  for (const run of result.runs) {
    const failure = run.failureKind === undefined ? "" : `/${safeString(run.failureKind)}`;
    const namespace = run.summaryFileName?.startsWith("memory/") === true ? "memory" : "agent";
    output += `${safeString(run.runId)}  ${safeString(run.status)}${failure}`
      + `  namespace=${namespace}`
      + `  source=${safeOptional(run.source)}`
      + `  started=${safeOptional(run.startedAt)}`
      + `  updated=${safeString(run.updatedAt)}`
      + `  model=${safeOptional(run.model)}`
      + `  durationMs=${String(run.durationMs)}`
      + `  events=${String(run.eventCount)}\n`;
  }
  return output + renderWarnings(result.warnings);
}

function renderRunDetail(run: RecordedRunDetail): string {
  const safeSummary = safeRunOutput(run.summary);
  let output = `Run summary\n${JSON.stringify(safeSummary, null, 2)}\n`;
  output += renderWarnings(run.warnings);
  output += `Events (${String(run.events.length)})\n`;
  for (const event of run.events) {
    output += `[${String(event.index)}] ${safeString(event.category)} ${safeString(event.label)}`;
    if (event.timestamp !== undefined) output += ` at ${safeString(event.timestamp)}`;
    output += `\n  ${safeString(event.summary)}\n`;
    output += `  payload: ${JSON.stringify(safeRunOutput(event.payload))}\n`;
  }
  return output;
}

function renderWarnings(warnings: readonly string[]): string {
  if (warnings.length === 0) return "";
  let output = "Warnings\n";
  for (const warning of warnings) output += `  ${safeString(warning)}\n`;
  return output;
}

function safeOptional(value: string | undefined): string {
  return value === undefined ? "-" : safeString(value);
}

function safeString(value: string): string {
  const redacted = redactJsonValue(value, RUN_INSPECTION_MAX_STRING_BYTES, {
    contentPatternRedaction: true,
  });
  return truncateVisibleText(escapeOutputControls(String(redacted)), RUN_INSPECTION_MAX_STRING_BYTES);
}

/** Apply the public structured-key redactor and closed credential scanner first. */
function safeRunOutput(value: unknown): unknown {
  const redacted = redactJsonValue(value, RUN_INSPECTION_MAX_STRING_BYTES, {
    contentPatternRedaction: true,
  });
  return escapeOutputValue(redacted);
}

function escapeOutputValue(value: unknown): unknown {
  if (typeof value === "string") return truncateVisibleText(escapeOutputControls(value), RUN_INSPECTION_MAX_STRING_BYTES);
  if (Array.isArray(value)) return value.map((entry) => escapeOutputValue(entry));
  if (value === null || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  const occupied = new Set<string>();
  for (const [rawKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const safeKey = safeString(rawKey);
    let key = safeKey;
    if (occupied.has(key)) {
      let suffixIndex = 2;
      do {
        const suffix = `#${String(suffixIndex)}`;
        key = `${truncateVisibleText(safeKey, RUN_INSPECTION_MAX_STRING_BYTES - suffix.length)}${suffix}`;
        suffixIndex += 1;
      } while (occupied.has(key));
    }
    Object.defineProperty(output, key, {
      value: escapeOutputValue(entryValue),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    occupied.add(key);
  }
  return output;
}

/** Escape C0/C1, line separators and bidi controls as inert, inspectable text. */
function escapeOutputControls(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029
      || /\p{Bidi_Control}/u.test(character)
    ) {
      escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}
