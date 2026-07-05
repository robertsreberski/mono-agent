import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import {
  errorMessage,
  isErrno,
  isRecord,
  safeJoin as safeJoinGuard,
} from "./artifact-fs.js";
import {
  EVENTS_SUFFIX,
  SUMMARY_SUFFIX,
  isRunSummaryStatus,
} from "./summary-schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneRunArtifactsOptions {
  readonly artifactDir: string;
  readonly maxAgeDays?: number;
  readonly maxCount?: number;
  readonly dryRun?: boolean;
  readonly clock?: () => number;
  readonly shouldContinue?: () => boolean;
}

export interface PruneRunArtifactsResult {
  readonly artifactDir: string;
  readonly dryRun: boolean;
  readonly scannedSummaryFiles: number;
  readonly parsedSummaryFiles: number;
  readonly eligibleRunCount: number;
  readonly skippedRunningCount: number;
  readonly prunedRunCount: number;
  /**
   * Number of deterministic sibling artifact files removed. In dry-run mode,
   * this is the number of existing sibling files that would be removed.
   */
  readonly removedFileCount: number;
  readonly prunedRunIds: readonly string[];
  /**
   * Absolute paths removed. In dry-run mode, these are the planned removals.
   */
  readonly removedFilePaths: readonly string[];
  readonly warnings: readonly string[];
}

interface ParsedRetentionSummary {
  readonly fileName: string;
  readonly runId: string;
  readonly updatedAtMs: number;
  readonly mtimeMs: number;
  readonly summaryPath: string;
  readonly eventsPath: string;
}

interface NormalizedRetentionOptions {
  readonly artifactDir: string;
  readonly dryRun: boolean;
  readonly now: number;
  readonly maxAgeMs?: number;
  readonly maxCount?: number;
  readonly shouldContinue?: () => boolean;
}

export async function pruneRunArtifacts(options: PruneRunArtifactsOptions): Promise<PruneRunArtifactsResult> {
  const warnings: string[] = [];
  const normalized = normalizeRetentionOptions(options, warnings);
  if (normalized === undefined) {
    return emptyResult(resolveSafe(options.artifactDir), options.dryRun === true, warnings);
  }

  let entries;
  try {
    entries = await readdir(normalized.artifactDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      warnings.push(`Artifact directory does not exist: ${normalized.artifactDir}.`);
    } else {
      warnings.push(`Unable to read artifact directory: ${errorMessage(error)}.`);
    }
    return emptyResult(normalized.artifactDir, normalized.dryRun, warnings);
  }

  const summaryFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SUMMARY_SUFFIX))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const terminalSummaries: ParsedRetentionSummary[] = [];
  let parsedSummaryFiles = 0;
  let skippedRunningCount = 0;

  for (const fileName of summaryFiles) {
    const parsed = await readRetentionSummary(normalized.artifactDir, fileName, warnings);
    if (parsed === undefined) {
      continue;
    }
    parsedSummaryFiles += 1;
    if (parsed === "running") {
      skippedRunningCount += 1;
      continue;
    }
    terminalSummaries.push(parsed);
  }

  const pruned = selectPrunableSummaries(terminalSummaries, normalized);
  const removedFilePaths: string[] = [];
  const prunedRunIds: string[] = [];
  for (const summary of pruned) {
    if (normalized.shouldContinue?.() === false) {
      warnings.push("Artifact retention cancelled before all selected runs were pruned.");
      break;
    }
    const eventRemoval = await removeArtifactFile(summary.eventsPath, normalized.dryRun, warnings);
    if (eventRemoval.removed) {
      removedFilePaths.push(summary.eventsPath);
    }
    if (eventRemoval.failed) {
      warnings.push(`Keeping summary ${summary.summaryPath} so event deletion can be retried.`);
      continue;
    }
    if (normalized.shouldContinue?.() === false) {
      warnings.push("Artifact retention cancelled before removing selected run summaries.");
      break;
    }
    const summaryRemoval = await removeArtifactFile(summary.summaryPath, normalized.dryRun, warnings);
    if (summaryRemoval.removed) {
      removedFilePaths.push(summary.summaryPath);
      prunedRunIds.push(summary.runId);
    }
  }

  return {
    artifactDir: normalized.artifactDir,
    dryRun: normalized.dryRun,
    scannedSummaryFiles: summaryFiles.length,
    parsedSummaryFiles,
    eligibleRunCount: terminalSummaries.length,
    skippedRunningCount,
    prunedRunCount: prunedRunIds.length,
    removedFileCount: removedFilePaths.length,
    prunedRunIds,
    removedFilePaths,
    warnings,
  };
}

async function readRetentionSummary(
  artifactDir: string,
  fileName: string,
  warnings: string[],
): Promise<ParsedRetentionSummary | "running" | undefined> {
  const summaryPath = safeJoin(artifactDir, fileName);
  let raw: string;
  try {
    raw = await readFile(summaryPath, "utf8");
  } catch (error) {
    warnings.push(`Skipping ${fileName}: unable to read (${errorMessage(error)}).`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`Skipping ${fileName}: invalid JSON (${errorMessage(error)}).`);
    return undefined;
  }
  if (!isRecord(parsed)) {
    warnings.push(`Skipping ${fileName}: summary is not an object.`);
    return undefined;
  }

  const runId = typeof parsed.runId === "string" && parsed.runId.trim().length > 0 ? parsed.runId.trim() : undefined;
  if (runId === undefined) {
    warnings.push(`Skipping ${fileName}: summary is missing runId.`);
    return undefined;
  }
  if (!isRunSummaryStatus(parsed.status)) {
    warnings.push(`Skipping ${fileName}: summary has missing or unrecognized status.`);
    return undefined;
  }
  if (parsed.status === "running") {
    return "running";
  }

  let stats;
  try {
    stats = await lstat(summaryPath);
  } catch (error) {
    warnings.push(`Skipping ${fileName}: unable to stat summary (${errorMessage(error)}).`);
    return undefined;
  }

  const baseName = fileName.slice(0, -SUMMARY_SUFFIX.length);
  const updatedAtMs = summaryUpdatedAtMs(parsed, stats.mtimeMs);
  return {
    fileName,
    runId,
    updatedAtMs,
    mtimeMs: stats.mtimeMs,
    summaryPath,
    eventsPath: safeJoin(artifactDir, `${baseName}${EVENTS_SUFFIX}`),
  };
}

function selectPrunableSummaries(
  summaries: readonly ParsedRetentionSummary[],
  options: NormalizedRetentionOptions,
): readonly ParsedRetentionSummary[] {
  const selected = new Map<string, ParsedRetentionSummary>();
  if (options.maxAgeMs !== undefined) {
    for (const summary of summaries) {
      if (options.now - summary.updatedAtMs > options.maxAgeMs) {
        selected.set(summary.fileName, summary);
      }
    }
  }
  if (options.maxCount !== undefined) {
    const newestFirst = [...summaries].sort(compareNewestFirst);
    for (const summary of newestFirst.slice(options.maxCount)) {
      selected.set(summary.fileName, summary);
    }
  }
  return [...selected.values()].sort(compareOldestFirst);
}

async function removeArtifactFile(
  filePath: string,
  dryRun: boolean,
  warnings: string[],
): Promise<{ readonly removed: boolean; readonly failed: boolean }> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { removed: false, failed: false };
    }
    warnings.push(`Unable to inspect artifact file ${filePath}: ${errorMessage(error)}.`);
    return { removed: false, failed: true };
  }
  if (!stats.isFile()) {
    warnings.push(`Skipping non-file artifact path ${filePath}.`);
    return { removed: false, failed: true };
  }
  if (dryRun) {
    return { removed: true, failed: false };
  }
  try {
    await rm(filePath, { force: true });
    return { removed: true, failed: false };
  } catch (error) {
    warnings.push(`Unable to remove artifact file ${filePath}: ${errorMessage(error)}.`);
    return { removed: false, failed: true };
  }
}

function normalizeRetentionOptions(
  options: PruneRunArtifactsOptions,
  warnings: string[],
): NormalizedRetentionOptions | undefined {
  if (typeof options.artifactDir !== "string" || options.artifactDir.trim().length === 0) {
    warnings.push("artifactDir must be a non-empty path.");
    return undefined;
  }
  const now = options.clock?.() ?? Date.now();
  if (!Number.isFinite(now)) {
    warnings.push("clock must return a finite epoch millisecond value.");
    return undefined;
  }

  const maxAgeMs = normalizeMaxAgeMs(options.maxAgeDays, warnings);
  const maxCount = normalizeMaxCount(options.maxCount, warnings);
  if (maxAgeMs === undefined && maxCount === undefined) {
    warnings.push("No retention limit provided; set maxAgeDays or maxCount to prune run artifacts.");
    return undefined;
  }

  return {
    artifactDir: resolve(options.artifactDir),
    dryRun: options.dryRun === true,
    now,
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    ...(maxCount === undefined ? {} : { maxCount }),
    ...(options.shouldContinue === undefined ? {} : { shouldContinue: options.shouldContinue }),
  };
}

function normalizeMaxAgeMs(maxAgeDays: number | undefined, warnings: string[]): number | undefined {
  if (maxAgeDays === undefined) {
    return undefined;
  }
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    warnings.push("maxAgeDays must be a non-negative finite number; ignoring age retention.");
    return undefined;
  }
  return maxAgeDays * DAY_MS;
}

function normalizeMaxCount(maxCount: number | undefined, warnings: string[]): number | undefined {
  if (maxCount === undefined) {
    return undefined;
  }
  if (!Number.isInteger(maxCount) || maxCount < 0) {
    warnings.push("maxCount must be a non-negative integer; ignoring count retention.");
    return undefined;
  }
  return maxCount;
}

function summaryUpdatedAtMs(summary: Record<string, unknown>, fallbackMs: number): number {
  for (const field of ["updatedAt", "endedAt", "startedAt"] as const) {
    const value = summary[field];
    if (typeof value !== "string") {
      continue;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallbackMs;
}

function compareNewestFirst(a: ParsedRetentionSummary, b: ParsedRetentionSummary): number {
  return b.updatedAtMs - a.updatedAtMs
    || b.mtimeMs - a.mtimeMs
    || b.runId.localeCompare(a.runId);
}

function compareOldestFirst(a: ParsedRetentionSummary, b: ParsedRetentionSummary): number {
  return a.updatedAtMs - b.updatedAtMs
    || a.mtimeMs - b.mtimeMs
    || a.runId.localeCompare(b.runId);
}

function safeJoin(root: string, fileName: string): string {
  return safeJoinGuard(root, fileName, () => {
    throw new Error("Resolved artifact path escapes artifactDir.");
  });
}

function resolveSafe(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? resolve(value) : "";
}

function emptyResult(artifactDir: string, dryRun: boolean, warnings: readonly string[]): PruneRunArtifactsResult {
  return {
    artifactDir,
    dryRun,
    scannedSummaryFiles: 0,
    parsedSummaryFiles: 0,
    eligibleRunCount: 0,
    skippedRunningCount: 0,
    prunedRunCount: 0,
    removedFileCount: 0,
    prunedRunIds: [],
    removedFilePaths: [],
    warnings,
  };
}
