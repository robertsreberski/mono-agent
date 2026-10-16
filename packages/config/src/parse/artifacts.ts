

import type { MonoAgentConfig } from "../types.js";

import { MonoAgentConfigError } from "../errors.js";

import { jsonBoolean, jsonInteger, jsonRecord } from "./scalars.js";

const DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS = 365;

const DEFAULT_ARTIFACT_RETENTION_MAX_COUNT = 50_000;

const DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS = 7;

const DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT = 5_000;

export function replyFileByteLimit(value: unknown, path: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new MonoAgentConfigError("invalid_json", `${path} must be a positive safe integer in bytes (1–${maximum}).`, { path });
  }
  return value;
}

export function readArtifactRetentionConfig(value: unknown): MonoAgentConfig["artifacts"]["retention"] {
  const retention = jsonRecord(value, "artifacts.retention") ?? {};
  return {
    maxAgeDays: jsonInteger(
      retention.maxAgeDays,
      "artifacts.retention.maxAgeDays",
      DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS,
      { min: 1, max: 3_650 },
    ),
    maxCount: jsonInteger(
      retention.maxCount,
      "artifacts.retention.maxCount",
      DEFAULT_ARTIFACT_RETENTION_MAX_COUNT,
      { min: 1, max: 1_000_000 },
    ),
    dryRun: jsonBoolean(
      retention.dryRun,
      "artifacts.retention.dryRun",
      false,
    ),
  };
}

export function readMemoryArtifactRetentionConfig(
  value: unknown,
  agentRetention: MonoAgentConfig["artifacts"]["retention"],
): MonoAgentConfig["artifacts"]["memoryRetention"] {
  const retention = jsonRecord(value, "artifacts.memoryRetention") ?? {};
  return {
    maxAgeDays: jsonInteger(
      retention.maxAgeDays,
      "artifacts.memoryRetention.maxAgeDays",
      DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS,
      { min: 1, max: 3_650 },
    ),
    maxCount: jsonInteger(
      retention.maxCount,
      "artifacts.memoryRetention.maxCount",
      DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT,
      { min: 1, max: 1_000_000 },
    ),
    dryRun: jsonBoolean(
      retention.dryRun,
      "artifacts.memoryRetention.dryRun",
      agentRetention.dryRun,
    ),
  };
}
