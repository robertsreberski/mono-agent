import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  buildRunReadableSpans,
  createDeterministicIdFactory,
  postOtlpProtobuf,
  serializeTraceSpans,
} from "@mono-agent/observability-otel";
import type {
  RunExportContext,
  RunSummary,
  RuntimeEventLike,
} from "@mono-agent/observability";

import {
  resolveAppArtifactDir,
  resolveAppObservabilityExporters,
  resolveAppTraceSourceId,
  resolveAppTraceSourceLabel,
} from "./app-config.js";
import type { MonoAgentAppConfigInput, ResolvedExporter } from "./app-config.js";

const SUMMARY_SUFFIX = ".summary.json";
const EVENTS_SUFFIX = ".events.jsonl";
// Backfill is a deliberate foreground batch (not the live best-effort path), so
// a single very large run gets a generous POST budget regardless of the live
// exporter's small default timeout.
const BACKFILL_TIMEOUT_MS = 60_000;
// Phoenix has a bounded span-ingestion queue and returns 503 under backpressure
// when a large batch arrives faster than it drains. Retry transient failures
// with exponential backoff so a full backfill completes instead of dropping
// runs; deterministic ids make every retry idempotent.
const BACKFILL_MAX_ATTEMPTS = 6;
const BACKFILL_BASE_BACKOFF_MS = 500;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/** True for a thrown OTLP error whose status is transient (5xx/429/408) or a non-HTTP (network) error. */
export function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const match = /responded (\d{3})/u.exec(message);
  if (match === null) {
    return true; // network/timeout/abort — worth a retry
  }
  return RETRYABLE_STATUSES.has(Number(match[1]));
}

export interface BackfillOptions {
  /** Export exactly this run id; mutually exclusive with `all`. */
  readonly run?: string;
  /** Export every run found in the artifact dir. */
  readonly all?: boolean;
  /** Only runs whose `startedAt` is >= this ISO instant. */
  readonly since?: string;
  /** Only runs whose `startedAt` is <= this ISO instant. */
  readonly until?: string;
  /** Map + serialize but do not POST; report span counts and byte sizes. */
  readonly dryRun?: boolean;
}

export interface BackfillRunArtifacts {
  readonly summary: RunSummary;
  readonly events: RuntimeEventLike[];
  readonly warnings: readonly string[];
}

/**
 * Read a run's on-disk artifacts directly into the shapes the OTLP mapping
 * needs. Deliberately bypasses `readRecordedRun` (which returns the classified
 * `RecordedRunEvent` shape and caps events at a maximum) so backfill exports a
 * faithful, uncapped copy: `summary.json` parses straight to `RunSummary`, and
 * each `events.jsonl` line is a raw `RuntimeEventLike`.
 */
export async function readRunArtifacts(artifactDir: string, runId: string): Promise<BackfillRunArtifacts> {
  const warnings: string[] = [];
  const summaryRaw = await readFile(join(artifactDir, `${runId}${SUMMARY_SUFFIX}`), "utf8");
  const summary = JSON.parse(summaryRaw) as RunSummary;

  let events: RuntimeEventLike[] = [];
  try {
    const eventsRaw = await readFile(join(artifactDir, `${runId}${EVENTS_SUFFIX}`), "utf8");
    events = parseEventsJsonl(eventsRaw, warnings);
  } catch {
    warnings.push(`No ${EVENTS_SUFFIX} for ${runId}; exporting a root-span-only trace.`);
  }
  return { summary, events, warnings };
}

function parseEventsJsonl(raw: string, warnings: string[]): RuntimeEventLike[] {
  const events: RuntimeEventLike[] = [];
  const lines = raw.split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      events.push(JSON.parse(trimmed) as RuntimeEventLike);
    } catch {
      warnings.push(`Skipped malformed event line ${index + 1}.`);
    }
  });
  return events;
}

/**
 * Derive the run's [start, end] in epoch nanoseconds from the recorded summary.
 * Unlike the live exporter (which stamps wall-clock `now()`), backfill must use
 * the historical timestamps so Phoenix shows the run on its real time axis.
 * `endedAt` is missing for runs that never finished (≈crashed/running) — fall
 * back to `startedAt + durationMs`.
 */
export function runStartEndNanos(summary: RunSummary): { start: bigint; end: bigint } {
  const startMs = summary.startedAt !== undefined ? Date.parse(summary.startedAt) : Number.NaN;
  const safeStartMs = Number.isNaN(startMs) ? 0 : startMs;
  const endMsRaw = summary.endedAt !== undefined ? Date.parse(summary.endedAt) : Number.NaN;
  const endMs = Number.isNaN(endMsRaw) ? safeStartMs + (summary.durationMs ?? 0) : endMsRaw;
  return {
    start: BigInt(Math.trunc(safeStartMs)) * 1_000_000n,
    end: BigInt(Math.trunc(endMs < safeStartMs ? safeStartMs : endMs)) * 1_000_000n,
  };
}

function resolveProjectName(exporter: ResolvedExporter, sourceLabel: string, sourceId: string): string {
  return exporter.projectName ?? sourceLabel ?? sourceId ?? "default";
}

/** POST one run's protobuf body, retrying transient failures (e.g. Phoenix 503 backpressure) with backoff. */
async function postWithRetry(exporter: ResolvedExporter, projectName: string, body: Uint8Array): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= BACKFILL_MAX_ATTEMPTS; attempt += 1) {
    try {
      await postOtlpProtobuf({
        endpoint: exporter.endpoint,
        headers: { "x-project-name": projectName, ...(exporter.headers ?? {}) },
        body,
        timeoutMs: BACKFILL_TIMEOUT_MS,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === BACKFILL_MAX_ATTEMPTS || !isRetryable(error)) {
        throw error;
      }
      await delay(BACKFILL_BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/** List run ids (base names) present in an artifact dir, sorted oldest-first by id. */
async function listRunIds(artifactDir: string): Promise<string[]> {
  const entries = await readdir(artifactDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SUMMARY_SUFFIX))
    .map((entry) => entry.name.slice(0, -SUMMARY_SUFFIX.length))
    .sort();
}

function withinWindow(summary: RunSummary, since?: string, until?: string): boolean {
  if (since === undefined && until === undefined) {
    return true;
  }
  const startedMs = summary.startedAt !== undefined ? Date.parse(summary.startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) {
    return false;
  }
  if (since !== undefined && startedMs < Date.parse(since)) {
    return false;
  }
  if (until !== undefined && startedMs > Date.parse(until)) {
    return false;
  }
  return true;
}

type RunOutcome =
  | { readonly runId: string; readonly status: "ok"; readonly spanCount: number; readonly bytes: number; readonly dryRun: boolean }
  | { readonly runId: string; readonly status: "skip"; readonly reason: string }
  | { readonly runId: string; readonly status: "fail"; readonly reason: string };

/**
 * Export already-recorded runs to the configured Phoenix exporter. Returns one
 * outcome per attempted run; a single run's network failure is non-fatal (it
 * becomes a `fail` outcome) so a partial backfill still reports. Trace/span ids
 * are deterministic (keyed on run id) so re-running is idempotent: Phoenix
 * overwrites rather than duplicating.
 */
export async function backfillRuns(
  input: MonoAgentAppConfigInput,
  options: BackfillOptions,
): Promise<{ readonly artifactDir: string; readonly endpoint: string; readonly outcomes: RunOutcome[] }> {
  const exporters = await resolveAppObservabilityExporters(input);
  const exporter = exporters[0];
  if (exporter === undefined) {
    throw new Error("No observability exporter configured; add an observability.exporters phoenix entry.");
  }
  const artifactDir = await resolveAppArtifactDir(input);
  const sourceId = await resolveAppTraceSourceId(input);
  const sourceLabel = await resolveAppTraceSourceLabel(input);
  const projectName = resolveProjectName(exporter, sourceLabel, sourceId);
  const includeSensitiveData = exporter.includeSensitiveData ?? false;

  const runIds = options.run !== undefined ? [options.run] : await listRunIds(artifactDir);

  const outcomes: RunOutcome[] = [];
  for (const runId of runIds) {
    try {
      const { summary, events } = await readRunArtifacts(artifactDir, runId);
      if (!withinWindow(summary, options.since, options.until)) {
        outcomes.push({ runId, status: "skip", reason: "outside --since/--until window" });
        continue;
      }
      const context: RunExportContext = {
        runId: summary.runId,
        conversationId: summary.conversationId,
        sourceId,
        sourceLabel,
        configPath: input.configPath,
        artifactDir,
        includeSensitiveData,
        // Recorded since this feature shipped; absent for older runs (input then
        // falls back to the run descriptor on the root span).
        ...(typeof summary.userInput === "string" ? { userInput: summary.userInput } : {}),
      };
      const { start, end } = runStartEndNanos(summary);
      const spans = buildRunReadableSpans({
        summary,
        events,
        context,
        projectName,
        startTimeUnixNanos: start,
        endTimeUnixNanos: end,
        idFactory: createDeterministicIdFactory(summary.runId),
      });
      const body = serializeTraceSpans(spans);
      if (options.dryRun !== true) {
        await postWithRetry(exporter, projectName, body);
      }
      outcomes.push({ runId, status: "ok", spanCount: spans.length, bytes: body.length, dryRun: options.dryRun === true });
    } catch (error) {
      outcomes.push({ runId, status: "fail", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { artifactDir, endpoint: exporter.endpoint, outcomes };
}

export interface RunBackfillArgs {
  readonly configPath?: string;
  readonly run?: string;
  readonly all: boolean;
  readonly since?: string;
  readonly until?: string;
  readonly dryRun: boolean;
}

/** CLI entry: resolve config, run the backfill, and print a per-run report. */
export async function runBackfill(args: RunBackfillArgs): Promise<number> {
  if (args.run === undefined && !args.all) {
    process.stderr.write("mono-agent backfill requires --run <id> or --all.\n");
    return 2;
  }
  const cwd = process.cwd();
  const input: MonoAgentAppConfigInput = {
    env: process.env,
    cwd,
    configPath: resolve(cwd, args.configPath ?? "mono-agent.config.json"),
  };

  let result;
  try {
    result = await backfillRuns(input, {
      ...(args.run === undefined ? {} : { run: args.run }),
      all: args.all,
      ...(args.since === undefined ? {} : { since: args.since }),
      ...(args.until === undefined ? {} : { until: args.until }),
      dryRun: args.dryRun,
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  process.stdout.write(
    `Backfilling from ${result.artifactDir} -> ${result.endpoint}${args.dryRun ? " (dry run)" : ""}\n`,
  );
  let ok = 0;
  let failed = 0;
  let totalBytes = 0;
  for (const outcome of result.outcomes) {
    if (outcome.status === "ok") {
      ok += 1;
      totalBytes += outcome.bytes;
      process.stdout.write(
        `  [ok]   ${outcome.runId} (${outcome.spanCount} spans, ${outcome.bytes} bytes)${outcome.dryRun ? " [not sent]" : ""}\n`,
      );
    } else if (outcome.status === "skip") {
      process.stdout.write(`  [skip] ${outcome.runId} (${outcome.reason})\n`);
    } else {
      failed += 1;
      process.stdout.write(`  [fail] ${outcome.runId} (${outcome.reason})\n`);
    }
  }
  process.stdout.write(`\n${ok} run(s) exported, ${failed} failed, ${totalBytes} bytes total.\n`);
  return failed > 0 ? 1 : 0;
}
