import type { LocalProviderDefinition, RuntimeExecutionMode, RuntimeModelReference } from "@mono-agent/runtime-adapter";
import type { SandboxPolicy } from "@mono-agent/sandbox";
import type { RedactedSecretValue } from "@mono-agent/settings";

import type { EFFORT_LEVELS, PERMISSION_MODES, REASONING_SUMMARIES } from "./field-groups.js";

export type MemoryWriteMode = "disabled" | "append-host-summary" | "capture";
export type MemoryMode = "lite" | "journal" | "bujo";
/** Configuration for a bujo-tier auto-ritual (reflection or migration). */
export interface MemoryRitualConfig {
  readonly enabled?: boolean;
  readonly cron?: string;
}
export type MemoryEmbeddingsProvider = "ollama" | "openai";
/** Circuit-breaker tuning for the embeddings provider used by journal/bujo recall. */
export interface MemoryEmbeddingsCircuitBreakerConfig {
  /** Consecutive failures before the breaker trips OPEN (default 3). */
  readonly failureThreshold?: number;
  /** How long the breaker stays OPEN before a half-open trial, in ms (default 30000). */
  readonly cooldownMs?: number;
}
export interface MemoryEmbeddingsConfig {
  readonly provider: MemoryEmbeddingsProvider;
  readonly model: string;
  readonly endpoint?: string;
  /** Resolved key value (inline or read from `apiKeyEnv` at load time). */
  readonly apiKey?: string;
  /** Name of the env var the key was read from, kept for redacted display. */
  readonly apiKeyEnv?: string;
  /** Embedding vector dimension (bujo mode default: 768 for nomic-embed-text). */
  readonly dim?: number;
  /** Per-call embeddings timeout in ms (default 10000 in the host). */
  readonly timeoutMs?: number;
  /** Circuit-breaker overrides; unset fields fall back to the breaker defaults. */
  readonly circuitBreaker?: MemoryEmbeddingsCircuitBreakerConfig;
}
export type MemoryLlmProvider = "ollama" | "agent-host";
export interface MemoryOllamaLlmConfig {
  readonly provider: "ollama";
  readonly model: string;
  readonly endpoint?: string;
}
export interface MemoryAgentHostLlmConfig {
  readonly provider: "agent-host";
  /** Runtime model reference string, parsed by the host when constructing the LLM. */
  readonly model: string;
  readonly executionMode?: RuntimeExecutionMode;
}
export type MemoryLlmConfig = MemoryOllamaLlmConfig | MemoryAgentHostLlmConfig;
export type SessionMode = "continuous" | "per-message";
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type ReasoningSummary = (typeof REASONING_SUMMARIES)[number];

export interface MonoAgentConfig {
  readonly runtime: {
    readonly model: RuntimeModelReference;
    /**
     * Ordered backup models tried after `model` when a run fails with a
     * retryable provider error. Each entry runs under its default execution
     * mode.
     */
    readonly fallbackModels?: readonly RuntimeModelReference[];
    readonly executionMode: RuntimeExecutionMode;
    readonly effort?: EffortLevel;
    /** Tool-permission posture forwarded to the runtime (CLI execution modes). */
    readonly permissionMode?: PermissionMode;
    /** Verbosity of provider reasoning summaries surfaced by the runtime. */
    readonly reasoningSummary?: ReasoningSummary;
    /** Optional hard cap per run; omitted means unlimited. */
    readonly maxTurns?: number;
    readonly workspace: string;
    readonly session: {
      readonly mode: SessionMode;
      readonly idleTimeoutMs: number;
    };
  };
  /**
   * Global concurrency bound across all conversations. Unset (default) means
   * runs are unbounded; a positive cap limits how many runs are in flight.
   */
  readonly concurrency?: {
    readonly maxConcurrentRuns?: number;
  };
  readonly context: {
    readonly identityPath: string;
    readonly soulPath?: string;
    readonly skillsRoot?: string;
    readonly selectedSkills: readonly string[];
    /** Hard byte cap per selected skill body (default 48000 in the harness). */
    readonly skillMaxBytes?: number;
  };
  readonly memory?: {
    readonly mode: MemoryMode;
    readonly path: string;
    readonly maxBytes: number;
    readonly writeMode: MemoryWriteMode;
    /** Embedding provider for semantic memory_search; keyword fallback when unset. */
    readonly embeddings?: MemoryEmbeddingsConfig;
    /** LLM for bujo capture/reflect/migrate. */
    readonly llm?: MemoryLlmConfig;
    /** Bujo-tier reflection ritual (nightly summarise/compress). Default cron: `0 3 * * *`. */
    readonly reflection?: MemoryRitualConfig;
    /** Bujo-tier migration ritual (monthly archive/rebalance). Default cron: `0 4 1 * *`. */
    readonly migration?: MemoryRitualConfig;
  };
  readonly tools: {
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
    readonly mcpConfigPath?: string;
  };
  readonly sandbox?: SandboxPolicy;
  readonly artifacts: {
    readonly dir: string;
  };
  readonly traceability: {
    readonly registryDir: string;
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly heartbeatMs?: number;
    readonly staleAfterMs?: number;
  };
  readonly providers?: {
    readonly piAuthPath?: string;
    readonly local?: readonly LocalProviderDefinition[];
  };
}

export type RedactedLocalProviderDefinition = Omit<LocalProviderDefinition, "apiKey"> & {
  readonly apiKey?: RedactedSecretValue;
};

export type RedactedMemoryEmbeddingsConfig = Omit<MemoryEmbeddingsConfig, "apiKey"> & {
  readonly apiKey?: RedactedSecretValue;
};

export type RedactedMemoryConfig = Omit<NonNullable<MonoAgentConfig["memory"]>, "embeddings"> & {
  readonly embeddings?: RedactedMemoryEmbeddingsConfig;
};

export interface RedactedMonoAgentConfig {
  readonly runtime: MonoAgentConfig["runtime"];
  readonly concurrency?: MonoAgentConfig["concurrency"];
  readonly context: MonoAgentConfig["context"];
  readonly memory?: RedactedMemoryConfig;
  readonly tools: MonoAgentConfig["tools"];
  readonly sandbox?: MonoAgentConfig["sandbox"];
  readonly artifacts: MonoAgentConfig["artifacts"];
  readonly traceability: MonoAgentConfig["traceability"];
  readonly providers?: {
    readonly piAuthPath?: string;
    readonly local?: readonly RedactedLocalProviderDefinition[];
  };
}
