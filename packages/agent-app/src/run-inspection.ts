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
import { firstCliPositional } from "./cli-args.js";
import * as ui from "./ui.js";

export const RUN_INSPECTION_MAX_RUNS = 50;
export const RUN_INSPECTION_MAX_EVENTS = 500;
export const RUN_INSPECTION_MAX_STRING_BYTES = 32 * 1_024;
const RUN_INSPECTION_MAX_WARNINGS = 50;

// The longest public high-confidence pattern is 523 ASCII bytes
// (`github_pat_`/`sk-svcacct-` plus the maximum bounded body). Let the reader
// retain that much lookahead so the output scanner sees a credential crossing
// the final 32 KiB display boundary before this module applies the final cap.
const MAX_CREDENTIAL_PATTERN_BYTES = 523;
const RUN_INSPECTION_READER_MAX_STRING_BYTES =
  RUN_INSPECTION_MAX_STRING_BYTES + MAX_CREDENTIAL_PATTERN_BYTES;
const TRUNCATED_BYTES_MARKER = /…\[truncated [1-9]\d* bytes\]$/u;
const SENSITIVE_KEY_PATTERN =
  /(token|password|authorization|api[_-]?key|cookie|credentials?|private[_-]?key|client[_-]?secret|bearer|secret)/iu;
const SENSITIVE_COMPOUND_KEY_PATTERN = /(?:^|_)(?:encryption_key|database_url)$/u;

// These are the closed numeric observability/count fields that remain useful
// and cannot carry a credential. Numeric values under every other sensitive
// key are redacted by this CLI boundary, overriding the shared telemetry-safe
// numeric exemption without changing shared redactor behavior.
const SAFE_SENSITIVE_NUMERIC_KEYS = new Set([
  "input",
  "input_tokens",
  "inputTokens",
  "output",
  "output_tokens",
  "outputTokens",
  "cachedInput",
  "cached_input",
  "cachedInputTokens",
  "cached_input_tokens",
  "cacheRead",
  "cache_read",
  "cacheCreation",
  "cache_creation",
  "cacheReadTokens",
  "cache_read_tokens",
  "cacheCreationTokens",
  "cache_creation_tokens",
  "cacheWrite",
  "cache_write",
  "cacheWriteTokens",
  "cache_write_tokens",
  "total",
  "total_tokens",
  "totalTokens",
  "reasoning",
  "reasoning_tokens",
  "reasoningTokens",
  "generatedSummaryTokens",
  "tailEstimateTokens",
  "credentialCount",
  "credential_count",
  "bearerCount",
  "bearer_count",
  "tokenCount",
  "token_count",
]);

interface CredentialPrefixShape {
  readonly prefix: string;
  readonly body: RegExp;
  readonly maxBodyCharacters: number;
}

const CREDENTIAL_PREFIX_SHAPES: readonly CredentialPrefixShape[] = [
  { prefix: "sk-", body: /^[A-Za-z0-9]*$/u, maxBodyCharacters: 48 },
  { prefix: "sk-proj-", body: /^[A-Za-z0-9_-]*$/u, maxBodyCharacters: 512 },
  { prefix: "sk-svcacct-", body: /^[A-Za-z0-9_-]*$/u, maxBodyCharacters: 512 },
  { prefix: "ghp_", body: /^[A-Za-z0-9]*$/u, maxBodyCharacters: 36 },
  { prefix: "github_pat_", body: /^[A-Za-z0-9_]*$/u, maxBodyCharacters: 512 },
  { prefix: "AKIA", body: /^[A-Z0-9]*$/u, maxBodyCharacters: 16 },
  { prefix: "xoxb-", body: /^[A-Za-z0-9-]*$/u, maxBodyCharacters: 512 },
  { prefix: "xoxa-", body: /^[A-Za-z0-9-]*$/u, maxBodyCharacters: 512 },
  { prefix: "xoxp-", body: /^[A-Za-z0-9-]*$/u, maxBodyCharacters: 512 },
  { prefix: "xoxr-", body: /^[A-Za-z0-9-]*$/u, maxBodyCharacters: 512 },
  { prefix: "xoxs-", body: /^[A-Za-z0-9-]*$/u, maxBodyCharacters: 512 },
  { prefix: "xapp-", body: /^[A-Za-z0-9-]*$/u, maxBodyCharacters: 512 },
];

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
        maxStringBytes: RUN_INSPECTION_READER_MAX_STRING_BYTES,
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
      maxStringBytes: RUN_INSPECTION_READER_MAX_STRING_BYTES,
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
  const mode = firstCliPositional(argv.slice(1));
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
  const boundarySafe = omitPotentialCredentialAtTruncationBoundary(String(redacted));
  return truncateVisibleText(escapeOutputControls(boundarySafe), RUN_INSPECTION_MAX_STRING_BYTES);
}

/** Apply the public structured-key redactor and closed credential scanner first. */
function safeRunOutput(value: unknown): unknown {
  const sharedRedacted = redactJsonValue(value, RUN_INSPECTION_MAX_STRING_BYTES, {
    contentPatternRedaction: true,
  });
  return escapeOutputValue(redactNumericCredentialValues(sharedRedacted));
}

function redactNumericCredentialValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactNumericCredentialValues(entry));
  if (value === null || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const nextValue = typeof entryValue === "number"
      && isSensitiveOutputKey(key)
      && !SAFE_SENSITIVE_NUMERIC_KEYS.has(key)
      ? "[redacted]"
      : redactNumericCredentialValues(entryValue);
    Object.defineProperty(output, key, {
      value: nextValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function isSensitiveOutputKey(key: string): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key)) return true;
  const normalized = key
    .trim()
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLocaleLowerCase("en-US")
    .replace(/[\s.-]+/gu, "_");
  return SENSITIVE_COMPOUND_KEY_PATTERN.test(normalized);
}

/**
 * A legacy artifact can already end in a canonical truncation marker with only
 * a credential prefix retained. The public scanner cannot match an incomplete
 * token, so conservatively redact a supported prefix touching that boundary.
 */
function omitPotentialCredentialAtTruncationBoundary(value: string): string {
  const marker = TRUNCATED_BYTES_MARKER.exec(value);
  if (marker === null) return value;
  const head = value.slice(0, marker.index);
  for (const shape of CREDENTIAL_PREFIX_SHAPES) {
    const start = head.lastIndexOf(shape.prefix);
    if (start < 0) continue;
    const body = head.slice(start + shape.prefix.length);
    if (body.length <= shape.maxBodyCharacters && shape.body.test(body)) {
      return `${head.slice(0, start)}[redacted]${marker[0]}`;
    }
  }
  return value;
}

function escapeOutputValue(value: unknown): unknown {
  if (typeof value === "string") {
    const boundarySafe = omitPotentialCredentialAtTruncationBoundary(value);
    return truncateVisibleText(escapeOutputControls(boundarySafe), RUN_INSPECTION_MAX_STRING_BYTES);
  }
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
