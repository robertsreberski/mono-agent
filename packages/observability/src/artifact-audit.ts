import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  errorMessage,
  isErrno,
  isRecord,
  safeJoin as safeJoinGuard,
} from "./artifact-fs.js";
import {
  KNOWN_ARTIFACT_FAILURE_KINDS,
  RUN_SUMMARY_STATUSES,
  SUMMARY_SUFFIX,
  isKnownArtifactFailureKind,
  isRunSummaryStatus,
  isStaleRunningSummary,
} from "./summary-schema.js";
import type {
  ArtifactAuditFileIssue,
  ArtifactAuditReport,
  ArtifactFailureKindRate,
  KnownArtifactFailureKind,
  RunSummaryStatus,
} from "./types.js";

export interface AuditRecordedRunsOptions {
  readonly now?: number;
  readonly staleAfterMs: number;
}

export async function auditRecordedRuns(
  artifactDir: string,
  options: AuditRecordedRunsOptions,
): Promise<ArtifactAuditReport> {
  if (typeof artifactDir !== "string" || artifactDir.trim().length === 0) {
    throw new Error("artifactDir must be a non-empty path.");
  }
  if (!Number.isFinite(options.staleAfterMs) || !Number.isInteger(options.staleAfterMs) || options.staleAfterMs < 1) {
    throw new Error("staleAfterMs must be a positive integer.");
  }
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("now must be a finite epoch millisecond value.");
  }

  const normalizedDir = resolve(artifactDir);
  const startedBeforeMs = now - options.staleAfterMs;
  const statusHistogram = emptyStatusHistogram();
  const failureKindHistogram = emptyFailureKindHistogram();
  const parseFailures: ArtifactAuditFileIssue[] = [];
  const unrecognizedStatuses: ArtifactAuditFileIssue[] = [];
  const unrecognizedFailureKinds: ArtifactAuditFileIssue[] = [];
  const staleRunning: ArtifactAuditFileIssue[] = [];
  const warnings: string[] = [];
  let totalSummaryFiles = 0;
  let parsedSummaryFiles = 0;
  let summariesWithFailureKind = 0;

  let entries;
  try {
    entries = await readdir(normalizedDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return buildReport({
        artifactDir: normalizedDir,
        totalSummaryFiles,
        parsedSummaryFiles,
        summariesWithFailureKind,
        statusHistogram,
        failureKindHistogram,
        parseFailures,
        unrecognizedStatuses,
        unrecognizedFailureKinds,
        staleRunning,
        warnings,
      });
    }
    warnings.push(`Unable to read artifact directory: ${errorMessage(error)}.`);
    return buildReport({
      artifactDir: normalizedDir,
      totalSummaryFiles,
      parsedSummaryFiles,
      summariesWithFailureKind,
      statusHistogram,
      failureKindHistogram,
      parseFailures,
      unrecognizedStatuses,
      unrecognizedFailureKinds,
      staleRunning,
      warnings,
    });
  }

  const summaryFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SUMMARY_SUFFIX))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of summaryFiles) {
    totalSummaryFiles += 1;
    const raw = await readSummaryRecord(normalizedDir, fileName, parseFailures);
    if (raw === undefined) {
      continue;
    }
    parsedSummaryFiles += 1;
    recordStatus(raw, fileName, statusHistogram, unrecognizedStatuses);
    summariesWithFailureKind += recordFailureKind(raw, fileName, failureKindHistogram, unrecognizedFailureKinds);
    if (isStaleRunningSummary(raw, startedBeforeMs)) {
      staleRunning.push(fileIssue(fileName, staleRunningReason(raw), raw.startedAt));
    }
  }

  return buildReport({
    artifactDir: normalizedDir,
    totalSummaryFiles,
    parsedSummaryFiles,
    summariesWithFailureKind,
    statusHistogram,
    failureKindHistogram,
    parseFailures,
    unrecognizedStatuses,
    unrecognizedFailureKinds,
    staleRunning,
    warnings,
  });
}

async function readSummaryRecord(
  artifactDir: string,
  fileName: string,
  parseFailures: ArtifactAuditFileIssue[],
): Promise<Record<string, unknown> | undefined> {
  const filePath = safeJoin(artifactDir, fileName);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    parseFailures.push(fileIssue(fileName, `unable to read: ${errorMessage(error)}`));
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    parseFailures.push(fileIssue(fileName, `invalid JSON: ${errorMessage(error)}`));
    return undefined;
  }
  if (!isRecord(parsed)) {
    parseFailures.push(fileIssue(fileName, "summary is not an object", parsed));
    return undefined;
  }
  return parsed;
}

function recordStatus(
  raw: Record<string, unknown>,
  fileName: string,
  statusHistogram: Record<RunSummaryStatus, number>,
  unrecognizedStatuses: ArtifactAuditFileIssue[],
): void {
  const status = raw.status;
  if (isRunSummaryStatus(status)) {
    statusHistogram[status] += 1;
    return;
  }
  if (status === undefined) {
    unrecognizedStatuses.push(fileIssue(fileName, "missing status"));
    return;
  }
  unrecognizedStatuses.push(fileIssue(fileName, typeof status === "string" ? "unrecognized status" : "status is not a string", status));
}

function recordFailureKind(
  raw: Record<string, unknown>,
  fileName: string,
  failureKindHistogram: Record<KnownArtifactFailureKind, number>,
  unrecognizedFailureKinds: ArtifactAuditFileIssue[],
): number {
  if (!Object.hasOwn(raw, "failureKind")) {
    return 0;
  }
  const failureKind = raw.failureKind;
  if (isKnownArtifactFailureKind(failureKind)) {
    failureKindHistogram[failureKind] += 1;
  } else {
    unrecognizedFailureKinds.push(fileIssue(
      fileName,
      typeof failureKind === "string" ? "unrecognized failureKind" : "failureKind is not a string",
      failureKind,
    ));
  }
  return 1;
}

function staleRunningReason(raw: Record<string, unknown>): string {
  if (typeof raw.startedAt !== "string") {
    return "running summary has missing startedAt";
  }
  if (!Number.isFinite(Date.parse(raw.startedAt))) {
    return "running summary has invalid startedAt";
  }
  return "running summary started before stale cutoff";
}

function buildReport(input: {
  readonly artifactDir: string;
  readonly totalSummaryFiles: number;
  readonly parsedSummaryFiles: number;
  readonly summariesWithFailureKind: number;
  readonly statusHistogram: Record<RunSummaryStatus, number>;
  readonly failureKindHistogram: Record<KnownArtifactFailureKind, number>;
  readonly parseFailures: readonly ArtifactAuditFileIssue[];
  readonly unrecognizedStatuses: readonly ArtifactAuditFileIssue[];
  readonly unrecognizedFailureKinds: readonly ArtifactAuditFileIssue[];
  readonly staleRunning: readonly ArtifactAuditFileIssue[];
  readonly warnings: readonly string[];
}): ArtifactAuditReport {
  return {
    artifactDir: input.artifactDir,
    totalSummaryFiles: input.totalSummaryFiles,
    parsedSummaryFiles: input.parsedSummaryFiles,
    parseFailureCount: input.parseFailures.length,
    parseFailures: input.parseFailures,
    statusHistogram: input.statusHistogram,
    unrecognizedStatusCount: input.unrecognizedStatuses.length,
    unrecognizedStatuses: input.unrecognizedStatuses,
    failureKindHistogram: input.failureKindHistogram,
    summariesWithFailureKind: input.summariesWithFailureKind,
    unrecognizedFailureKindCount: input.unrecognizedFailureKinds.length,
    unrecognizedFailureKinds: input.unrecognizedFailureKinds,
    staleRunningCount: input.staleRunning.length,
    staleRunning: input.staleRunning,
    failureKindRates: failureKindRates(input.failureKindHistogram, input.parsedSummaryFiles, input.summariesWithFailureKind),
    rateDenominators: {
      parsedSummaries: input.parsedSummaryFiles,
      summariesWithFailureKind: input.summariesWithFailureKind,
    },
    warnings: input.warnings,
  };
}

function failureKindRates(
  histogram: Record<KnownArtifactFailureKind, number>,
  parsedSummaryFiles: number,
  summariesWithFailureKind: number,
): readonly ArtifactFailureKindRate[] {
  return KNOWN_ARTIFACT_FAILURE_KINDS.map((failureKind) => {
    const count = histogram[failureKind];
    return {
      failureKind,
      count,
      rateOfParsedSummaries: rate(count, parsedSummaryFiles),
      rateOfSummariesWithFailureKind: rate(count, summariesWithFailureKind),
    };
  });
}

function rate(count: number, denominator: number): number {
  return denominator === 0 ? 0 : count / denominator;
}

function emptyStatusHistogram(): Record<RunSummaryStatus, number> {
  return RUN_SUMMARY_STATUSES.reduce(
    (histogram, status) => ({ ...histogram, [status]: 0 }),
    {} as Record<RunSummaryStatus, number>,
  );
}

function emptyFailureKindHistogram(): Record<KnownArtifactFailureKind, number> {
  return KNOWN_ARTIFACT_FAILURE_KINDS.reduce(
    (histogram, failureKind) => ({ ...histogram, [failureKind]: 0 }),
    {} as Record<KnownArtifactFailureKind, number>,
  );
}

function safeJoin(root: string, fileName: string): string {
  return safeJoinGuard(root, fileName, () => {
    throw new Error("Resolved artifact path escapes artifactDir.");
  });
}

function fileIssue(fileName: string, reason: string, value?: unknown): ArtifactAuditFileIssue {
  return value === undefined
    ? { fileName, reason }
    : { fileName, reason, value: describeValue(value) };
}

function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}
