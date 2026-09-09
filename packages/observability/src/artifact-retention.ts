import { lstat, readdir, readFile, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";

import {
  artifactDirForKind,
  normalizeRunArtifactScope,
  relativeSummaryFileName,
  summaryMatchesArtifactScope,
  type SummaryFileLocation,
} from "./artifact-scope.js";
import {
  errorMessage,
  isErrno,
  isRecord,
  safeJoin as safeJoinGuard,
  sweepOrphanedAtomicWriteTemps,
} from "./artifact-fs.js";
import {
  EVENTS_SUFFIX,
  SUMMARY_SUFFIX,
  isRunSummaryStatus,
} from "./summary-schema.js";
import type { RunArtifactScope } from "./types.js";
import {
  canonicalToolArtifactRoot,
  toolOutputRunDirectoryName,
} from "./tool-output-path.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOOL_OUTPUT_RECENT_WRITE_GRACE_MS = 60 * 60 * 1000;

export interface PruneRunArtifactsOptions {
  readonly artifactDir: string;
  readonly scope?: RunArtifactScope;
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
  readonly scannedToolOutputDirectoryCount: number;
  readonly eligibleToolOutputDirectoryCount: number;
  readonly skippedActiveToolOutputDirectoryCount: number;
  readonly prunedToolOutputDirectoryCount: number;
  /** Absolute tool-output run directories removed, or planned in dry-run mode. */
  readonly removedDirectoryPaths: readonly string[];
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
  readonly scope: RunArtifactScope;
  readonly dryRun: boolean;
  readonly now: number;
  readonly maxAgeMs?: number;
  readonly maxCount?: number;
  readonly shouldContinue?: () => boolean;
}

interface ToolOutputDirectoryCandidate {
  readonly name: string;
  readonly path: string;
  readonly mtimeMs: number;
  readonly identity: FileIdentity;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export async function pruneRunArtifacts(options: PruneRunArtifactsOptions): Promise<PruneRunArtifactsResult> {
  const warnings: string[] = [];
  const normalized = normalizeRetentionOptions(options, warnings);
  if (normalized === undefined) {
    return emptyResult(resolveSafe(options.artifactDir), options.dryRun === true, warnings);
  }

  const terminalSummaries: ParsedRetentionSummary[] = [];
  let scannedSummaryFiles = 0;
  let parsedSummaryFiles = 0;
  let skippedRunningCount = 0;
  const protectedToolOutputDirectoryNames = new Set<string>();

  const topLevel = await loadRetentionNamespace(normalized, "agent", warnings, protectedToolOutputDirectoryNames, { includeUnknownWarnings: normalized.scope !== "memory" });
  const namespaces = normalized.scope === "memory" || normalized.scope === "all"
    ? [topLevel, await loadRetentionNamespace(normalized, "memory", warnings, protectedToolOutputDirectoryNames, { includeUnknownWarnings: true })]
    : [topLevel];

  for (const namespace of namespaces) {
    scannedSummaryFiles += namespace.scannedSummaryFiles;
    parsedSummaryFiles += namespace.parsedSummaryFiles;
    skippedRunningCount += namespace.skippedRunningCount;
    terminalSummaries.push(...namespace.terminalSummaries);
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

  const toolOutput = normalized.scope === "memory"
    ? emptyToolOutputRetentionResult()
    : await pruneToolOutputDirectories(normalized, protectedToolOutputDirectoryNames, warnings);

  return {
    artifactDir: normalized.artifactDir,
    dryRun: normalized.dryRun,
    scannedSummaryFiles,
    parsedSummaryFiles,
    eligibleRunCount: terminalSummaries.length,
    skippedRunningCount,
    prunedRunCount: prunedRunIds.length,
    removedFileCount: removedFilePaths.length,
    prunedRunIds,
    removedFilePaths,
    ...toolOutput,
    warnings,
  };
}

async function loadRetentionNamespace(
  normalized: NormalizedRetentionOptions,
  namespaceKind: "agent" | "memory",
  warnings: string[],
  protectedToolOutputDirectoryNames: Set<string>,
  options: { readonly includeUnknownWarnings: boolean },
): Promise<{
  readonly scannedSummaryFiles: number;
  readonly parsedSummaryFiles: number;
  readonly skippedRunningCount: number;
  readonly terminalSummaries: readonly ParsedRetentionSummary[];
}> {
  const artifactDir = artifactDirForKind(normalized.artifactDir, namespaceKind);
  let entries;
  try {
    entries = await readdir(artifactDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      if (namespaceKind === "agent") {
        warnings.push(`Artifact directory does not exist: ${normalized.artifactDir}.`);
      }
      return emptyRetentionNamespace();
    }
    warnings.push(`Unable to read artifact directory: ${errorMessage(error)}.`);
    return emptyRetentionNamespace();
  }

  if (!normalized.dryRun) {
    await sweepOrphanedAtomicWriteTemps(artifactDir, {
      nowMs: normalized.now,
      entryNames: entries.map((entry) => entry.name),
    });
  }

  const summaryFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SUMMARY_SUFFIX))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  let scannedSummaryFiles = 0;
  let parsedSummaryFiles = 0;
  let skippedRunningCount = 0;
  const terminalSummaries: ParsedRetentionSummary[] = [];

  for (const fileName of summaryFiles) {
    const location: SummaryFileLocation = {
      artifactDir,
      fileName,
      relativeFileName: relativeSummaryFileName(fileName, namespaceKind),
      namespaceKind,
    };
    const targetWarnings = options.includeUnknownWarnings ? warnings : [];
    const warningCountBefore = targetWarnings.length;
    const parsed = await readRetentionSummary(
      location,
      normalized,
      targetWarnings,
      protectedToolOutputDirectoryNames,
    );
    if (parsed === undefined) {
      if (options.includeUnknownWarnings && targetWarnings.length > warningCountBefore) {
        scannedSummaryFiles += 1;
      }
      continue;
    }
    if (parsed === "excluded") {
      continue;
    }
    scannedSummaryFiles += 1;
    parsedSummaryFiles += 1;
    if (parsed === "running") {
      skippedRunningCount += 1;
      continue;
    }
    terminalSummaries.push(parsed);
  }

  return { scannedSummaryFiles, parsedSummaryFiles, skippedRunningCount, terminalSummaries };
}

async function readRetentionSummary(
  location: SummaryFileLocation,
  normalized: NormalizedRetentionOptions,
  warnings: string[],
  protectedToolOutputDirectoryNames: Set<string>,
): Promise<ParsedRetentionSummary | "running" | "excluded" | undefined> {
  const summaryPath = safeJoin(location.artifactDir, location.fileName);
  let raw: string;
  try {
    raw = await readFile(summaryPath, "utf8");
  } catch (error) {
    protectToolOutputDirectoryForSummaryFile(location.fileName, protectedToolOutputDirectoryNames);
    warnings.push(`Skipping ${location.relativeFileName}: unable to read (${errorMessage(error)}).`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    protectToolOutputDirectoryForSummaryFile(location.fileName, protectedToolOutputDirectoryNames);
    warnings.push(`Skipping ${location.relativeFileName}: invalid JSON (${errorMessage(error)}).`);
    return undefined;
  }
  if (!isRecord(parsed)) {
    protectToolOutputDirectoryForSummaryFile(location.fileName, protectedToolOutputDirectoryNames);
    warnings.push(`Skipping ${location.relativeFileName}: summary is not an object.`);
    return undefined;
  }
  const matchesScope = summaryMatchesArtifactScope(location.namespaceKind, parsed, normalized.scope);
  const runId = typeof parsed.runId === "string" && parsed.runId.trim().length > 0 ? parsed.runId.trim() : undefined;
  if (runId !== undefined && (parsed.status === "running" || !isRunSummaryStatus(parsed.status))) {
    protectedToolOutputDirectoryNames.add(toolOutputRunDirectoryName(runId));
  }
  if (!matchesScope) return "excluded";
  if (runId === undefined) {
    protectToolOutputDirectoryForSummaryFile(location.fileName, protectedToolOutputDirectoryNames);
    warnings.push(`Skipping ${location.relativeFileName}: summary is missing runId.`);
    return undefined;
  }
  if (!isRunSummaryStatus(parsed.status)) {
    warnings.push(`Skipping ${location.relativeFileName}: summary has missing or unrecognized status.`);
    return undefined;
  }
  if (parsed.status === "running") {
    return "running";
  }

  let stats;
  try {
    stats = await lstat(summaryPath);
  } catch (error) {
    warnings.push(`Skipping ${location.relativeFileName}: unable to stat summary (${errorMessage(error)}).`);
    return undefined;
  }

  const baseName = location.fileName.slice(0, -SUMMARY_SUFFIX.length);
  const updatedAtMs = summaryUpdatedAtMs(parsed, stats.mtimeMs);
  return {
    fileName: location.relativeFileName,
    runId,
    updatedAtMs,
    mtimeMs: stats.mtimeMs,
    summaryPath,
    eventsPath: safeJoin(location.artifactDir, `${baseName}${EVENTS_SUFFIX}`),
  };
}

async function pruneToolOutputDirectories(
  normalized: NormalizedRetentionOptions,
  protectedNames: ReadonlySet<string>,
  warnings: string[],
): Promise<{
  readonly scannedToolOutputDirectoryCount: number;
  readonly eligibleToolOutputDirectoryCount: number;
  readonly skippedActiveToolOutputDirectoryCount: number;
  readonly prunedToolOutputDirectoryCount: number;
  readonly removedDirectoryPaths: readonly string[];
}> {
  let root: string;
  try {
    root = canonicalToolArtifactRoot(join(normalized.artifactDir, "tool-output"));
  } catch (error) {
    warnings.push(`Unable to establish the canonical tool-output root: ${errorMessage(error)}.`);
    return emptyToolOutputRetentionResult();
  }

  let rootStats: Stats;
  let entries;
  try {
    rootStats = await lstat(root);
    if (!trustedToolOutputDirectory(rootStats)) {
      warnings.push(`Skipping unsafe tool-output root ${root}.`);
      return emptyToolOutputRetentionResult();
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return emptyToolOutputRetentionResult();
    warnings.push(`Unable to read tool-output root ${root}: ${errorMessage(error)}.`);
    return emptyToolOutputRetentionResult();
  }

  const candidates: ToolOutputDirectoryCandidate[] = [];
  let scannedToolOutputDirectoryCount = 0;
  let skippedActiveToolOutputDirectoryCount = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || toolOutputRunDirectoryName(entry.name) !== entry.name) {
      warnings.push(`Skipping unexpected tool-output entry ${safeJoin(root, entry.name)}.`);
      continue;
    }
    const path = safeJoin(root, entry.name);
    let stats: Stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      warnings.push(`Unable to inspect tool-output directory ${path}: ${errorMessage(error)}.`);
      continue;
    }
    scannedToolOutputDirectoryCount += 1;
    if (!trustedToolOutputDirectory(stats) || !Number.isFinite(stats.mtimeMs)) {
      warnings.push(`Skipping unsafe tool-output directory ${path}.`);
      continue;
    }
    if (protectedNames.has(entry.name)
        || normalized.now - stats.mtimeMs <= TOOL_OUTPUT_RECENT_WRITE_GRACE_MS) {
      skippedActiveToolOutputDirectoryCount += 1;
      continue;
    }
    candidates.push({
      name: entry.name,
      path,
      mtimeMs: stats.mtimeMs,
      identity: identityOf(stats),
    });
  }

  const selected = selectPrunableToolOutputDirectories(candidates, normalized);
  const removedDirectoryPaths: string[] = [];
  const rootIdentity = identityOf(rootStats);
  for (const candidate of selected) {
    if (normalized.shouldContinue?.() === false) {
      warnings.push("Artifact retention cancelled before all selected tool-output directories were pruned.");
      break;
    }
    const removed = await removeToolOutputDirectory(
      root,
      rootIdentity,
      candidate,
      normalized.dryRun,
      warnings,
    );
    if (removed) removedDirectoryPaths.push(candidate.path);
  }

  return {
    scannedToolOutputDirectoryCount,
    eligibleToolOutputDirectoryCount: candidates.length,
    skippedActiveToolOutputDirectoryCount,
    prunedToolOutputDirectoryCount: removedDirectoryPaths.length,
    removedDirectoryPaths,
  };
}

function selectPrunableToolOutputDirectories(
  candidates: readonly ToolOutputDirectoryCandidate[],
  options: NormalizedRetentionOptions,
): readonly ToolOutputDirectoryCandidate[] {
  const selected = new Map<string, ToolOutputDirectoryCandidate>();
  if (options.maxAgeMs !== undefined) {
    for (const candidate of candidates) {
      if (options.now - candidate.mtimeMs > options.maxAgeMs) selected.set(candidate.name, candidate);
    }
  }
  if (options.maxCount !== undefined) {
    const newestFirst = [...candidates].sort((left, right) =>
      right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    for (const candidate of newestFirst.slice(options.maxCount)) selected.set(candidate.name, candidate);
  }
  return [...selected.values()].sort((left, right) =>
    left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
}

async function removeToolOutputDirectory(
  root: string,
  rootIdentity: FileIdentity,
  candidate: ToolOutputDirectoryCandidate,
  dryRun: boolean,
  warnings: string[],
): Promise<boolean> {
  let currentRoot: Stats;
  let currentCandidate: Stats;
  try {
    currentRoot = await lstat(root);
    currentCandidate = await lstat(candidate.path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    warnings.push(`Unable to revalidate tool-output directory ${candidate.path}: ${errorMessage(error)}.`);
    return false;
  }
  if (!trustedToolOutputDirectory(currentRoot)
      || !sameIdentity(rootIdentity, currentRoot)
      || !trustedToolOutputDirectory(currentCandidate)
      || !sameIdentity(candidate.identity, currentCandidate)
      || currentCandidate.mtimeMs !== candidate.mtimeMs) {
    warnings.push(`Keeping tool-output directory ${candidate.path} because its identity, modification time, or containment root changed.`);
    return false;
  }
  if (dryRun) return true;
  try {
    await rm(candidate.path, { recursive: true });
    return true;
  } catch (error) {
    warnings.push(`Unable to remove tool-output directory ${candidate.path}: ${errorMessage(error)}.`);
    return false;
  }
}

function trustedToolOutputDirectory(stats: Stats): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) return false;
  return process.platform === "win32" || (stats.mode & 0o022) === 0;
}

function identityOf(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(identity: FileIdentity, stats: Stats): boolean {
  return identity.dev === stats.dev && identity.ino === stats.ino;
}

function protectToolOutputDirectoryForSummaryFile(
  fileName: string,
  protectedNames: Set<string>,
): void {
  const baseName = fileName.slice(0, -SUMMARY_SUFFIX.length);
  if (toolOutputRunDirectoryName(baseName) === baseName) protectedNames.add(baseName);
}

function emptyToolOutputRetentionResult(): {
  readonly scannedToolOutputDirectoryCount: number;
  readonly eligibleToolOutputDirectoryCount: number;
  readonly skippedActiveToolOutputDirectoryCount: number;
  readonly prunedToolOutputDirectoryCount: number;
  readonly removedDirectoryPaths: readonly string[];
} {
  return {
    scannedToolOutputDirectoryCount: 0,
    eligibleToolOutputDirectoryCount: 0,
    skippedActiveToolOutputDirectoryCount: 0,
    prunedToolOutputDirectoryCount: 0,
    removedDirectoryPaths: [],
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
    scope: normalizeRunArtifactScope(options.scope),
    dryRun: options.dryRun === true,
    now,
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    ...(maxCount === undefined ? {} : { maxCount }),
    ...(options.shouldContinue === undefined ? {} : { shouldContinue: options.shouldContinue }),
  };
}

function emptyRetentionNamespace(): {
  readonly scannedSummaryFiles: number;
  readonly parsedSummaryFiles: number;
  readonly skippedRunningCount: number;
  readonly terminalSummaries: readonly ParsedRetentionSummary[];
} {
  return {
    scannedSummaryFiles: 0,
    parsedSummaryFiles: 0,
    skippedRunningCount: 0,
    terminalSummaries: [],
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
    ...emptyToolOutputRetentionResult(),
    warnings,
  };
}
