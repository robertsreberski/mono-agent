
import type { SettingsJson, SettingsJsonValue } from "@mono-agent/contracts";

import type { PiTransport } from "@mono-agent/turn/host/types";

import type {
  MemoryBackend,
  MemoryEmbeddingsInstructions,
  MemoryEmbeddingsProvider,
  MemoryLlmProvider,
  MemoryMode,
  MemoryWriteMode,
} from "./types.js";

/** An opt-in model declaration; effort remains a sibling runtime setting. */
export type MonoAgentModelSelectionJson = string | { readonly model: string; readonly context1M?: boolean };

/** Read a model reference without flattening the caller-owned JSON object. */
export function modelReferenceFromConfigJson(value: MonoAgentModelSelectionJson | undefined): string | undefined {
  return typeof value === "string" ? value : value?.model;
}

/** JSON form of one canonical runtime fallback route. */
export type MonoAgentRuntimeFallbackJson = {
  readonly model?: string;
  readonly effort?: string;
  readonly context1M?: boolean;
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
type MonoAgentMemoryEmbeddingsCircuitBreakerJson = {
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
  readonly instructions?: MemoryEmbeddingsInstructions;
  readonly circuitBreaker?: MonoAgentMemoryEmbeddingsCircuitBreakerJson;
};

/** @deprecated Compatibility tombstone. Only an exact empty object is accepted. */
export type MonoAgentMemorySupermemoryJson = Readonly<Record<string, never>>;

/** JSON-serialisable shape for memory consolidation config. */
export type MonoAgentMemoryConsolidationJson = {
  readonly enabled?: boolean;
  readonly cron?: string;
};

type MonoAgentLocalProviderModelJson = {
  readonly name?: string;
  readonly alias?: string;
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly capabilities?: { readonly [key: string]: SettingsJsonValue };
  readonly pricing?: { readonly [key: string]: SettingsJsonValue };
};

type MonoAgentLocalProviderJson = {
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
type MonoAgentProviderJson = Omit<MonoAgentLocalProviderJson, "id">;

type MonoAgentPiNativeProviderJson = {
  readonly transport?: PiTransport;
  readonly promptCacheDiagnostics?: boolean;
  /** Anthropic Messages cache retention. Config loading defaults to long; short opts out. */
  readonly cacheRetention?: "short" | "long";
  readonly piMaxRetries?: number;
  readonly maxRetryDelayMs?: number;
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

/**
 * Serializable shape of MonoAgentConfig persisted as `mono-agent.config.json`.
 *
 * All fields are optional for partial authoring. The resolver validates required
 * fields and applies built-in defaults; core environment variables are ignored.
 *
 * Paths inside this file are relative to the file's containing directory (or
 * the loader's `cwd`); they are resolved by the loader, not at write time.
 */
export interface MonoAgentConfigJson extends SettingsJson {
  readonly agent?: {
    readonly name?: string;
  };
  readonly runtime?: {
    readonly model?: MonoAgentModelSelectionJson;
    readonly fallbacks?: readonly MonoAgentRuntimeFallbackJson[];
    readonly retry?: {
      readonly primaryAttempts?: number;
      readonly backoffMs?: number;
      readonly maxBackoffMs?: number;
    };
    readonly effort?: string;
    readonly maxTurns?: number;
    readonly compaction?: {
      readonly enabled?: boolean;
      readonly triggerRatio?: number;
      readonly maxInputTokens?: number;
      readonly keepRecentTokens?: number;
      readonly summaryMaxTokens?: number;
      readonly effort?: string;
      readonly failureCooldownMs?: number;
      readonly minSavingsTokens?: number;
      readonly fixedOverheadEnabled?: boolean;
      readonly contextWindowOverride?: number;
    };
    readonly workspace?: string;
    readonly session?: {
      readonly root?: string;
      readonly mode?: string;
      readonly idleTimeoutMs?: number;
      readonly rollover?: string;
      readonly rolloverTimezone?: string;
      readonly rolloverNotice?: boolean;
      readonly isolateProactive?: boolean;
      readonly modelSwitch?: {
        readonly enabled?: boolean;
      };
    };
  };
  readonly peers?: Readonly<Record<string, { readonly sourceId: string }>>;
  readonly subagents?: {
  readonly instances?: {
    /** Default true when subagents are enabled. */
    readonly enabled?: boolean;
    /** Default <artifacts.dir>/../subagents. Relative paths use the config directory. */
    readonly root?: string;
    /** Live instances per conversation: 1–32, default 8. */
    readonly maxPerConversation?: number;
    /** Idle expiry in milliseconds: 60000–604800000, default 86400000. */
    readonly idleTtlMs?: number;
    /** Total child turns per instance: 1–500, default 60. */
    readonly maxTurns?: number;
  };

    readonly models?: readonly (string | { readonly name?: string; readonly model: string; readonly context1M?: boolean })[];
    readonly enabled?: boolean;
    readonly maxConcurrent?: number;
    readonly maxPerTurn?: number;
    readonly commandTimeoutMs?: number;
    readonly timeoutMs?: number;
    readonly maxTurns?: number;
    /**
     * Ceiling on a subagent the MODEL authors at call time. Parsed and validated
     * by readSubagentsConfig, and read by app composition and doctor — it was simply
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
      readonly model?: MonoAgentModelSelectionJson;
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
    readonly capture?: { readonly focus?: string; readonly only?: readonly string[]; readonly reconcileModel?: string; readonly cron?: boolean; readonly webhook?: boolean; readonly intentLifecycle?: boolean };
    readonly supermemory?: MonoAgentMemorySupermemoryJson;
    readonly embeddings?: MonoAgentMemoryEmbeddingsJson;
    readonly llm?: MonoAgentMemoryLlmJson;
    readonly recallTool?: { readonly enabled?: boolean };
    readonly recall?: { readonly intentExpiry?: boolean; readonly recency?: boolean };
    readonly profile?: { readonly enabled?: boolean };
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
    readonly filesystem?: {
      readonly readableRoots?: readonly string[];
      readonly writableRoots?: readonly string[];
    };
    /** Default-off BuJo owner-web conversation evidence. */
    readonly conversationSearch?: { readonly datedSnippets?: boolean };
    /** Opt-in local desktop control via the separately installed cua-driver. */
    readonly computerUse?: {
      readonly backend: "cua-driver";
      readonly command?: string;
    };
    readonly mcpConfigPath?: string;
    readonly mcpRequestContextServers?: readonly string[];
    readonly continuationServers?: readonly string[];
    readonly mcpCallTimeoutMs?: number;
    readonly mcpCallMaxTotalTimeoutMs?: number;
    readonly web?: {
      readonly coordination?: "process" | "host";
      readonly search?: {
        readonly backend?: string | readonly string[];
        readonly parallel?: { readonly apiKeyEnv?: string };
        readonly maxRequestsPerRun?: number;
        /** Compatibility alias for tools.web.search.searxng.endpoint. */
        readonly endpoint?: string;
        readonly searxng?: {
          readonly endpoint?: string;
        };
        /** @deprecated Endpoint tombstone; presence is rejected before layering. */
        readonly hound?: {
          readonly endpoint?: string;
        };
        readonly ollama?: {
          readonly baseUrl?: string;
          readonly apiKeyEnv?: string;
          readonly trustPublicUrl?: boolean;
        };
        readonly codex?: {
          readonly model?: string;
        };
      };
      readonly fetch?: {
        readonly provider?: string | readonly string[];
        readonly parallel?: { readonly apiKeyEnv?: string };
        /** @deprecated Endpoint tombstone; presence is rejected before layering. */
        readonly hound?: {
          readonly endpoint?: string;
        };
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
    readonly replyFiles?: { readonly maxStorageBytes?: number | "unlimited"; readonly maxFileBytes?: number };
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
  /** Removed exporter compatibility: only an absent/empty object or empty array is accepted on read. */
  readonly observability?: {
    readonly exporters?: readonly never[];
  };
  readonly providers?: MonoAgentProvidersJson;
}
