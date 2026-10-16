


import { modelReferenceKey,parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";





import {
normalizeOptionalString,
readChoice
} from "@mono-agent/contracts";

import {
EFFORT_LEVELS
} from "../enums.js";


import type { EffortLevel,MonoAgentConfig,RuntimeFallbackConfig,RuntimeRetryConfig,SessionMode,SessionRollover } from "../types.js";

import { invalidJson,MonoAgentConfigError } from "../errors.js";



import { assertJsonScalarFields,jsonBoolean,jsonChoice,jsonInteger,jsonOptionalBoolean,jsonOptionalInteger,jsonOptionalNumber,jsonRecord,jsonString } from "./scalars.js";

import { modelReferenceEcho,modelReferenceReason } from "./model-reference.js";

import { readOptionalPath } from "./paths.js";

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 1_800_000;

export function readFallbacks(value: unknown): readonly RuntimeFallbackConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", "runtime.fallbacks must be an array.", {
      path: "runtime.fallbacks",
    });
  }
  const parsed = value;
  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `runtime.fallbacks entry ${index + 1} must be an object with a model.`,
        { path: "runtime.fallbacks", index },
      );
    }
    const record = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (key) => key !== "model" && key !== "effort" && key !== "attempts" && key !== "context1M",
    );
    if (unknownKeys.length > 0) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `runtime.fallbacks entry ${index + 1} contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.sort().join(", ")}. Only model, effort, attempts, and context1M are supported.`,
        { path: "runtime.fallbacks", index, unknownKeys: unknownKeys.sort() },
      );
    }
    if (typeof record.model !== "string" || record.model.trim().length === 0) {
      throw new MonoAgentConfigError(
        "invalid_model_reference",
        `runtime.fallbacks entry ${index + 1} must contain a non-empty model reference.`,
        { path: "runtime.fallbacks", index },
      );
    }
    const model = parseFallbackModel(record.model, index);
    const attempts = readFallbackAttempts(record.attempts, index);
    if (record.effort === undefined) {
      return attempts === undefined ? { model } : { model, attempts };
    }
    if (typeof record.effort !== "string") {
      throw new MonoAgentConfigError(
        "invalid_json",
        `runtime.fallbacks entry ${index + 1} effort must be one of: ${EFFORT_LEVELS.join(", ")}.`,
        { path: "runtime.fallbacks", index },
      );
    }
    const normalizedEffort = normalizeOptionalString(record.effort);
    if (normalizedEffort === undefined) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `runtime.fallbacks entry ${index + 1} effort must be one of: ${EFFORT_LEVELS.join(", ")}.`,
        { path: "runtime.fallbacks", index },
      );
    }
    const effort = readChoice<EffortLevel>(
      normalizedEffort,
      `runtime.fallbacks[${index}].effort`,
      EFFORT_LEVELS,
      "medium",
      invalidJson,
    );
    return attempts === undefined ? { model, effort } : { model, effort, attempts };
  });
}

function readFallbackAttempts(value: unknown, index: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `runtime.fallbacks entry ${index + 1} attempts must be an integer between 1 and 10.`,
      { path: "runtime.fallbacks", index },
    );
  }
  return value;
}

export function readRetryConfig(runtime: Record<string, unknown> | undefined): RuntimeRetryConfig {
  const retry = jsonRecord(runtime?.retry, "runtime.retry") ?? {};
  return {
    primaryAttempts: readRetryInteger(retry.primaryAttempts, "runtime.retry.primaryAttempts", 2, 1, 10),
    backoffMs: readRetryInteger(retry.backoffMs, "runtime.retry.backoffMs", 1_000, 0, 60_000),
    maxBackoffMs: readRetryInteger(retry.maxBackoffMs, "runtime.retry.maxBackoffMs", 15_000, 0, 300_000),
  };
}

function readRetryInteger(
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const normalized = normalizeOptionalString(jsonString(value, path));
  if (normalized === undefined) {
    return fallback;
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${path} must be an integer between ${min} and ${max}.`,
      { path },
    );
  }
  return parsed;
}

function parseFallbackModel(raw: string, index: number): MonoAgentConfig["runtime"]["model"] {
  const path = `runtime.fallbacks[${index}].model`;
  try {
    return parseMonoRuntimeModelReference(raw.trim());
  } catch (error) {
    const reason = modelReferenceReason(error);
    throw new MonoAgentConfigError(
      "invalid_model_reference",
      `${path} \`${modelReferenceEcho(raw)}\` is not a valid runtime model reference: ${reason}`,
      { path, index, reason },
    );
  }
}

export function assertUniqueFallbackRoutes(
  primary: MonoAgentConfig["runtime"]["model"],
  canonical: readonly RuntimeFallbackConfig[],
): void {
  const seen = new Map<string, string>([[modelReferenceKey(primary), "runtime.model"]]);
  const routes = canonical.map((entry, index) => ({ model: entry.model, path: `runtime.fallbacks[${index}]` }));
  for (const route of routes) {
    const key = modelReferenceKey(route.model);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `Duplicate runtime route \`${key}\` at ${route.path}; it is already selected at ${first}.`,
        { route: key, path: route.path, duplicateOf: first },
      );
    }
    seen.set(key, route.path);
  }
}

export function readMaxTurns(value: unknown): number | undefined {
  const maxTurns = jsonInteger(value, "runtime.maxTurns", 0, { min: 0, max: 100 });
  return maxTurns === 0 ? undefined : maxTurns;
}

export function readRuntimeCompactionConfig(
  value: unknown,
): NonNullable<MonoAgentConfig["runtime"]["compaction"]> {
  const compaction = jsonRecord(value, "runtime.compaction") ?? {};
  const triggerRatio = jsonOptionalNumber(
    compaction.triggerRatio,
    "runtime.compaction.triggerRatio",
    { min: 0.2, max: 0.95 },
  );
  const keepRecentTokens = jsonOptionalInteger(
    compaction.keepRecentTokens,
    "runtime.compaction.keepRecentTokens",
    { min: 4_000, max: 200_000 },
  );
  const summaryMaxTokens = jsonOptionalInteger(
    compaction.summaryMaxTokens,
    "runtime.compaction.summaryMaxTokens",
    { min: 1_000, max: 64_000 },
  );
  const minSavingsTokens = jsonOptionalInteger(
    compaction.minSavingsTokens,
    "runtime.compaction.minSavingsTokens",
    { min: 0, max: 500_000 },
  );
  const contextWindowOverride = jsonOptionalInteger(
    compaction.contextWindowOverride,
    "runtime.compaction.contextWindowOverride",
    { min: 32_000, max: 10_000_000 },
  );
  return {
    enabled: jsonBoolean(
      compaction.enabled,
      "runtime.compaction.enabled",
      true,
    ),
    ...(triggerRatio === undefined ? {} : { triggerRatio }),
    ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
    ...(summaryMaxTokens === undefined ? {} : { summaryMaxTokens }),
    ...(minSavingsTokens === undefined ? {} : { minSavingsTokens }),
    fixedOverheadEnabled: jsonBoolean(
      compaction.fixedOverheadEnabled,
      "runtime.compaction.fixedOverheadEnabled",
      true,
    ),
    ...(contextWindowOverride === undefined ? {} : { contextWindowOverride }),
  };
}

export function readSessionConfig(value: unknown, cwd: string): MonoAgentConfig["runtime"]["session"] {
  const session = jsonRecord(value, "runtime.session") ?? {};
  const root = readOptionalPath(jsonString(session.root, "runtime.session.root"), cwd);
  const mode = jsonChoice<SessionMode>(session.mode, "runtime.session.mode", [
    "continuous",
    "per-message",
  ], "continuous");
  const idleTimeoutMs = jsonInteger(
    session.idleTimeoutMs,
    "runtime.session.idleTimeoutMs",
    DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    { min: 1_000, max: 86_400_000 },
  );
  const rollover = jsonChoice<SessionRollover>(session.rollover, "runtime.session.rollover", [
    "none",
    "daily",
  ], "none");
  const rolloverTimezone = normalizeOptionalString(jsonString(session.rolloverTimezone, "runtime.session.rolloverTimezone"));
  // Unset stays undefined so hosts can keep their existing display policy;
  // explicit false is preserved for operators who want to suppress notices.
  const rolloverNotice = jsonOptionalBoolean(session.rolloverNotice, "runtime.session.rolloverNotice");
  // Unset stays undefined so the harness default (false, no behavior change) is
  // preserved byte-for-byte; only parse the boolean when an operator opts in.
  const isolateProactive = jsonOptionalBoolean(session.isolateProactive, "runtime.session.isolateProactive");
  const switchJson = jsonRecord(session.modelSwitch, "runtime.session.modelSwitch");
  if (switchJson) assertJsonScalarFields(switchJson, "runtime.session.modelSwitch", { enabled: "boolean" });
  const enabled = switchJson === undefined ? undefined : jsonOptionalBoolean(switchJson.enabled, "runtime.session.modelSwitch.enabled");
  if (enabled === true && mode !== "continuous") throw new MonoAgentConfigError(
    "invalid_json", "Model switching requires continuous sessions.", { path: "runtime.session.mode" });
  return {
    mode,
    idleTimeoutMs,
    ...(root === undefined ? {} : { root }),
    ...(enabled === true ? { modelSwitch: { enabled } } : {}),
    rollover,
    ...(rolloverTimezone === undefined ? {} : { rolloverTimezone }),
    ...(rolloverNotice === undefined ? {} : { rolloverNotice }),
    ...(isolateProactive === undefined ? {} : { isolateProactive }),
  };
}

export function readEffort(raw: string | undefined): EffortLevel | undefined {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return undefined;
  }
  return readChoice<EffortLevel>(normalized, "runtime.effort", EFFORT_LEVELS, EFFORT_LEVELS[0], invalidJson);
}
