import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  errorMessage,
  isErrno,
  isRecord,
  safeJoin as safeJoinGuard,
} from "./artifact-fs.js";
import { SUMMARY_SUFFIX } from "./summary-schema.js";
import type { ArtifactAuditFileIssue } from "./types.js";

export interface ArtifactSummaryRecord {
  readonly fileName: string;
  readonly raw: Record<string, unknown>;
}

export interface ReadArtifactSummaryRecordsResult {
  readonly artifactDir: string;
  readonly totalSummaryFiles: number;
  readonly parsedSummaryFiles: number;
  readonly parseFailures: readonly ArtifactAuditFileIssue[];
  readonly summaries: readonly ArtifactSummaryRecord[];
  readonly warnings: readonly string[];
}

export async function readArtifactSummaryRecords(artifactDir: string): Promise<ReadArtifactSummaryRecordsResult> {
  if (typeof artifactDir !== "string" || artifactDir.trim().length === 0) {
    throw new Error("artifactDir must be a non-empty path.");
  }

  const normalizedDir = resolve(artifactDir);
  const parseFailures: ArtifactAuditFileIssue[] = [];
  const summaries: ArtifactSummaryRecord[] = [];
  const warnings: string[] = [];

  let entries;
  try {
    entries = await readdir(normalizedDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return buildReadResult(normalizedDir, 0, parseFailures, summaries, warnings);
    }
    warnings.push(`Unable to read artifact directory: ${errorMessage(error)}.`);
    return buildReadResult(normalizedDir, 0, parseFailures, summaries, warnings);
  }

  const summaryFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SUMMARY_SUFFIX))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of summaryFiles) {
    const raw = await readSummaryRecord(normalizedDir, fileName, parseFailures);
    if (raw !== undefined) {
      summaries.push({ fileName, raw });
    }
  }

  return buildReadResult(normalizedDir, summaryFiles.length, parseFailures, summaries, warnings);
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

function buildReadResult(
  artifactDir: string,
  totalSummaryFiles: number,
  parseFailures: readonly ArtifactAuditFileIssue[],
  summaries: readonly ArtifactSummaryRecord[],
  warnings: readonly string[],
): ReadArtifactSummaryRecordsResult {
  return {
    artifactDir,
    totalSummaryFiles,
    parsedSummaryFiles: summaries.length,
    parseFailures,
    summaries,
    warnings,
  };
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
