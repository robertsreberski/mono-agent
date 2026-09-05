import {
  readSettingsJson,
  SettingsJsonError,
  writeSettingsJson,
} from "@mono-agent/agent-contracts";
import type { SettingsJson, SettingsJsonValue } from "@mono-agent/agent-contracts";
import type { PiTransport } from "@mono-agent/runtime-adapter";

import { MonoAgentConfigError, RETIRED_CONFIG_FIELDS } from "./config.js";
import type { MemoryBackend, MemoryEmbeddingsProvider, MemoryLlmProvider, MemoryMode, MemoryWriteMode } from "./types.js";

/** JSON form of one canonical runtime fallback route. */
export type MonoAgentRuntimeFallbackJson = {
  readonly model?: string;
  readonly effort?: string;
  /** Total attempts on this route including the first, 1-10. Omitted = single shot. */
  readonly attempts?: number;
};

/** JSON-serialisable shape for run-artifact retention. */
export type MonoAgentArtifactRetentionJson = {
  readonly maxAgeDays?: number;
  readonly maxCount?: number;
  readonly dryRun?: boolean;
};

/** JSON-serialisable shape for the embeddings circuit-breaker block. */
export type MonoAgentMemoryEmbeddingsCircuitBreakerJson = {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
};

/** JSON-serialisable shape for the memory embeddings block. */
export type MonoAgentMemoryEmbeddingsJson = {
  readonly provider?: MemoryEmbeddingsProvider;
  readonly model?: string;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly dim?: number;
  readonly timeoutMs?: number;
  readonly circuitBreaker?: MonoAgentMemoryEmbeddingsCircuitBreakerJson;
};

/** JSON-serialisable shape for the Supermemory external-backend block. */
export type MonoAgentMemorySupermemoryJson = {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly container?: string;
  readonly timeoutMs?: number;
  readonly exposeMcpServer?: boolean;
};

/** JSON-serialisable shape for memory consolidation config. */
export type MonoAgentMemoryConsolidationJson = {
  readonly enabled?: boolean;
  readonly cron?: string;
};

export type MonoAgentLocalProviderModelJson = {
  readonly name?: string;
  readonly alias?: string;
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly capabilities?: { readonly [key: string]: SettingsJsonValue };
  readonly pricing?: { readonly [key: string]: SettingsJsonValue };
};

export type MonoAgentLocalProviderJson = {
  readonly id?: string;
  readonly type?: string;
  readonly baseUrl?: string;
  readonly enabled?: boolean;
  readonly trustPublicUrl?: boolean;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly models?: readonly MonoAgentLocalProviderModelJson[];
  readonly maxAdvertisedModels?: number;
};

/** Map entry form; its provider id is the containing `providers` key. */
export type MonoAgentProviderJson = Omit<MonoAgentLocalProviderJson, "id">;

type MonoAgentPiNativeProviderJson = {
  readonly transport?: PiTransport;
  readonly piMaxRetries?: number;
  readonly maxRetryDelayMs?: number;
  readonly piSessionsRoot?: string;
};

export type MonoAgentProvidersJson = {
  readonly piAuthPath?: string;
  readonly local?: readonly MonoAgentLocalProviderJson[];
  readonly piNative?: MonoAgentPiNativeProviderJson;
  readonly [providerId: string]:
    | string
    | readonly MonoAgentLocalProviderJson[]
    | MonoAgentPiNativeProviderJson
    | MonoAgentProviderJson;
};

export type MonoAgentMemoryLlmJson = {
  readonly provider?: MemoryLlmProvider;
  readonly model?: string;
  readonly endpoint?: string;
  readonly trace?: boolean;
  readonly timeoutMs?: number;
};

/** JSON-serialisable shape for a single observability exporter block. */
export type MonoAgentObservabilityExporterJson = {
  readonly type?: string;
  readonly endpoint?: string;
  readonly headers?: { readonly [k: string]: string };
  readonly includeSensitiveData?: boolean;
  readonly contentPatternRedaction?: boolean;
  readonly timeoutMs?: number;
};

/**
 * Serializable shape of MonoAgentConfig persisted as `mono-agent.config.json`.
 *
 * All fields are optional so a partially-configured file is acceptable. Env
 * variables can still satisfy missing fields when the layered loader runs.
 *
 * Paths inside this file are relative to the file's containing directory (or
 * the loader's `cwd`); they are resolved by the loader, not at write time.
 */
export interface MonoAgentConfigJson extends SettingsJson {
  readonly agent?: {
    readonly name?: string;
  };
  readonly runtime?: {
    readonly model?: string;
    readonly fallbacks?: readonly MonoAgentRuntimeFallbackJson[];
    readonly retry?: {
      readonly primaryAttempts?: number;
      readonly backoffMs?: number;
      readonly maxBackoffMs?: number;
    };
    readonly effort?: string;
    readonly permissionMode?: string;
    readonly maxTurns?: number;
    readonly compaction?: {
      readonly enabled?: boolean;
      readonly triggerRatio?: number;
      readonly keepRecentTokens?: number;
      readonly summaryMaxTokens?: number;
      readonly minSavingsTokens?: number;
      readonly fixedOverheadEnabled?: boolean;
      readonly contextWindowOverride?: number;
    };
    readonly workspace?: string;
    readonly session?: {
      readonly mode?: string;
      readonly idleTimeoutMs?: number;
      readonly rollover?: string;
      readonly rolloverTimezone?: string;
      readonly rolloverNotice?: boolean;
      readonly isolateProactive?: boolean;
    };
  };
  readonly subagents?: {
    readonly enabled?: boolean;
    readonly maxConcurrent?: number;
    readonly maxPerTurn?: number;
    readonly timeoutMs?: number;
    readonly maxTurns?: number;
    /**
     * Ceiling on a subagent the MODEL authors at call time. Parsed and validated
     * by readSubagentsConfig, and read by agent-app and doctor — it was simply
     * missing from this interface, so a config that set it typechecked only by
     * accident of the whole block being optional.
     */
    readonly inline?: {
      readonly enabled?: boolean;
      readonly allowedTools?: readonly string[];
    };
    readonly definitions?: readonly {
      readonly name?: string;
      readonly description?: string;
      readonly prompt?: string;
      readonly promptPath?: string;
      readonly model?: string;
      readonly effort?: string;
      readonly allowedTools?: readonly string[];
      readonly disallowedTools?: readonly string[];
      readonly mcpServers?: readonly string[];
      readonly maxTurns?: number;
      readonly timeoutMs?: number;
    }[];
  };
  readonly concurrency?: {
    readonly maxConcurrentRuns?: number;
    readonly maxPendingRuns?: number;
  };
  readonly context?: {
    readonly identityPath?: string;
    readonly soulPath?: string;
    readonly skillsRoot?: string;
    readonly selectedSkills?: readonly string[];
    readonly skillMaxBytes?: number;
    readonly skillDisclosure?: string;
  };
  readonly memory?: {
    readonly backend?: MemoryBackend;
    readonly mode?: MemoryMode;
    readonly path?: string;
    readonly maxBytes?: number;
    readonly writeMode?: MemoryWriteMode;
    readonly supermemory?: MonoAgentMemorySupermemoryJson;
    readonly embeddings?: MonoAgentMemoryEmbeddingsJson;
    readonly llm?: MonoAgentMemoryLlmJson;
    readonly recallTool?: { readonly enabled?: boolean };
    readonly rememberTool?: { readonly enabled?: boolean };
    readonly consolidation?: MonoAgentMemoryConsolidationJson;
    /** Removed and ignored; retained so stale JSON stays typed/tolerated. */
    readonly reflection?: MonoAgentMemoryConsolidationJson;
    /** Removed and ignored; retained so stale JSON stays typed/tolerated. */
    readonly migration?: MonoAgentMemoryConsolidationJson;
  };
  readonly tools?: {
    readonly allowedTools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly mcpConfigPath?: string;
    readonly mcpRequestContextServers?: readonly string[];
    readonly continuationServers?: readonly string[];
    readonly mcpCallTimeoutMs?: number;
    readonly mcpCallMaxTotalTimeoutMs?: number;
    readonly web?: {
      readonly coordination?: "process" | "host";
      readonly search?: {
        readonly backend?: string;
        readonly endpoint?: string;
        readonly codex?: {
          readonly model?: string;
        };
      };
      readonly fetch?: {
        readonly render?: string;
        readonly browserCommand?: string;
      };
    };
  };
  readonly sandbox?: {
    readonly mode?: string;
    readonly network?: {
      readonly mode?: string;
      readonly allowlist?: readonly string[];
    };
    readonly readableRoots?: readonly string[];
    readonly writableRoots?: readonly string[];
    readonly denyWrite?: readonly string[];
    readonly fallback?: string;
    readonly unsafeAllowHostProcess?: boolean;
  };
  readonly artifacts?: {
    readonly dir?: string;
    readonly retention?: MonoAgentArtifactRetentionJson;
    readonly memoryRetention?: MonoAgentArtifactRetentionJson;
  };
  readonly traceability?: {
    readonly registryDir?: string;
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly heartbeatMs?: number;
    readonly staleAfterMs?: number;
    readonly globalDiscovery?: boolean;
  };
  readonly observability?: {
    readonly exporters?: readonly MonoAgentObservabilityExporterJson[];
  };
  readonly providers?: MonoAgentProvidersJson;
}

export interface ReadMonoAgentConfigJsonResult {
  readonly json: MonoAgentConfigJson;
  /** sha-256 of the parsed content (or empty string when the file is missing). */
  readonly version: string;
  /** Absolute path actually read. */
  readonly path: string;
  /** True when the file did not exist on disk. */
  readonly missing: boolean;
}

/**
 * Read a JSON config file. Missing file returns an empty config rather than
 * throwing; that lets hosts ship a blank config and fall back to env defaults.
 */
export async function readMonoAgentConfigJson(path: string): Promise<ReadMonoAgentConfigJsonResult> {
  let result: Awaited<ReturnType<typeof readSettingsJson>>;
  try {
    result = await readSettingsJson(path);
  } catch (error) {
    throw toConfigError(error, path);
  }
  assertNoRetiredMonoAgentConfigJson(result.json);
  return {
    ...result,
    json: result.json as MonoAgentConfigJson,
  };
}

/**
 * Reject removed JSON fields before a host's generic unknown-key validation.
 *
 * Reports every retired key present, not just the first: migrating by hand is one edit
 * pass, and a config carrying all four retired keys used to surface them one re-run at a
 * time. `path` stays the first match so existing single-key consumers are unchanged;
 * `paths` carries the full set.
 */
export function assertNoRetiredMonoAgentConfigJson(json: object): void {
  const retired = RETIRED_CONFIG_FIELDS.filter((field) => hasOwnJsonPath(json, field.path));
  if (retired.length === 0) return;
  throw new MonoAgentConfigError("invalid_json", retired.map((field) => field.message).join(" "), {
    path: retired[0]!.path,
    paths: retired.map((field) => field.path),
  });
}

function hasOwnJsonPath(json: object, path: string): boolean {
  let current: unknown = json;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return false;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

/**
 * Atomically write a JSON config file. Writes to `<path>.tmp` first, fsyncs,
 * then renames over the target. The temp file is unlinked on failure so we
 * never leave a half-written `.tmp` behind on the next run.
 */
export async function writeMonoAgentConfigJson(input: {
  readonly path: string;
  readonly patch: MonoAgentConfigJson;
}): Promise<{ readonly version: string }> {
  try {
    return await writeSettingsJson({
      path: input.path,
      patch: input.patch,
    });
  } catch (error) {
    throw toConfigError(error, input.path);
  }
}

function toConfigError(error: unknown, path: string): MonoAgentConfigError {
  if (error instanceof SettingsJsonError) {
    return new MonoAgentConfigError("invalid_env", error.message, {
      path,
      reason: error.message,
    });
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new MonoAgentConfigError("invalid_env", reason, { path, reason });
}
