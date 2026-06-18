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

/**
 * Phoenix OTLP-HTTP trace exporter config. Best-effort, additive sink: never
 * changes run outcome and never suppresses the local JSONL recorder. Header
 * values are secrets and are redacted by `redactMonoAgentConfig`.
 */
export interface PhoenixExporterConfig {
  readonly type: "phoenix";
  /** OTLP/HTTP traces endpoint; defaults to Phoenix's local `/v1/traces`. */
  readonly endpoint?: string;
  /** Extra HTTP headers (e.g. auth) sent on the OTLP POST. Values are secrets. */
  readonly headers?: Readonly<Record<string, string>>;
  /** When true, redacted raw payloads are exported; default false (metadata only). */
  readonly includeSensitiveData?: boolean;
  /** Hard cap (ms) on a single export attempt; bounded {1..60000}, default 5000. */
  readonly timeoutMs?: number;
  /**
   * Phoenix project the traces land in (resource attr `openinference.project.name`,
   * also sent as the `x-project-name` header). Defaults to the run's trace source
   * label/id, else "default". Not a secret.
   */
  readonly projectName?: string;
}

/** Union of supported observability exporters (future: langfuse/otlp). */
export type ObservabilityExporterConfig = PhoenixExporterConfig;

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
   * Concurrency bounds across all conversations. Two independent tiers, both
   * unset (default) = unbounded:
   * - `maxConcurrentRuns` caps how many runs execute against the provider at
   *   once (execution width, around the model call only).
   * - `maxPendingRuns` caps how many runs may be admitted before the expensive
   *   pre-provider work (attachment persistence + context prep); requests over
   *   this bound fail fast instead of queuing, providing backpressure.
   *
   * Bounds apply per channel harness instance, not globally across channels:
   * the app builds one harness per channel, so with N configured channels the
   * effective ceiling is N× this value.
   */
  readonly concurrency?: {
    readonly maxConcurrentRuns?: number;
    readonly maxPendingRuns?: number;
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
    /**
     * Read-only `memory_recall` tool exposed to the agent (embeddings + FTS, no
     * chat LLM). Derived from this single memory block — no hand-wired MCP entry.
     * Defaults on when the resolved tier has embeddings; off for lite.
     */
    readonly recallTool?: { readonly enabled: boolean };
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
  /**
   * Best-effort observability sinks. Present only when at least one exporter is
   * configured; the local JSONL recorder always runs regardless.
   */
  readonly observability?: {
    readonly exporters: readonly ObservabilityExporterConfig[];
  };
  readonly providers?: {
    readonly piAuthPath?: string;
    readonly local?: readonly LocalProviderDefinition[];
    readonly piNative?: PiNativeProviderConfig;
  };
}

/** Tuning knobs for the pi-native provider bridge. */
export interface PiNativeProviderConfig {
  /** Max retry attempts for the pi provider transport (0-8; default 2). */
  readonly piMaxRetries?: number;
  /** Maximum delay between retry attempts, in milliseconds (default 60000). */
  readonly maxRetryDelayMs?: number;
  /**
   * Directory for durable JSONL session storage. When set, provider sessions
   * persist to disk and resume across restarts; unset keeps sessions in-memory.
   */
  readonly piSessionsRoot?: string;
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

export type RedactedPhoenixExporterConfig = Omit<PhoenixExporterConfig, "headers"> & {
  /** Header VALUES are secrets and replaced with the literal `[redacted]`. */
  readonly headers?: Readonly<Record<string, "[redacted]">>;
};

export type RedactedObservabilityExporterConfig = RedactedPhoenixExporterConfig;

export interface RedactedObservabilityConfig {
  readonly exporters: readonly RedactedObservabilityExporterConfig[];
}

export interface RedactedMonoAgentConfig {
  readonly runtime: MonoAgentConfig["runtime"];
  readonly concurrency?: MonoAgentConfig["concurrency"];
  readonly context: MonoAgentConfig["context"];
  readonly memory?: RedactedMemoryConfig;
  readonly tools: MonoAgentConfig["tools"];
  readonly sandbox?: MonoAgentConfig["sandbox"];
  readonly artifacts: MonoAgentConfig["artifacts"];
  readonly traceability: MonoAgentConfig["traceability"];
  readonly observability?: RedactedObservabilityConfig;
  readonly providers?: {
    readonly piAuthPath?: string;
    readonly local?: readonly RedactedLocalProviderDefinition[];
    readonly piNative?: PiNativeProviderConfig;
  };
}
