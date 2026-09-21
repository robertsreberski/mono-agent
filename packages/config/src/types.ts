import type { LocalProviderDefinition, PiTransport, ProviderDefinition, RuntimeCompactionPolicy, RuntimeModelReference } from "@mono-agent/runtime-adapter";
import type { SandboxPolicy } from "@mono-agent/runtime-adapter";
import type { RedactedSecretValue } from "@mono-agent/agent-contracts";

import type {
  EFFORT_LEVELS,
  MEMORY_BACKENDS,
  MEMORY_EMBEDDINGS_PROVIDERS,
  MEMORY_LLM_PROVIDERS,
  MEMORY_MODES,
  MEMORY_WRITE_MODES,
} from "./enums.js";

export type MemoryWriteMode = (typeof MEMORY_WRITE_MODES)[number];
export type MemoryMode = (typeof MEMORY_MODES)[number];
export type WebSearchBackend = "searxng" | "ollama" | "codex" | "keyless" | "duckduckgo" | "startpage" | "parallel" | "hound";
export type WebFetchProvider = "local" | "parallel" | "hound";
export interface ParallelWebConfig {
  /** Environment variable name only; the credential is read at call time. */
  readonly apiKeyEnv?: string;
}
export type WebFetchRenderMode = "never" | "auto";

export interface SearxngWebSearchConfig {
  /** SearXNG must be unauthenticated loopback HTTP. */
  readonly endpoint: string;
}

/** @deprecated Source-compatible tombstone; any endpoint setting is rejected.
 * Hound is a built-in native provider and needs no service endpoint.
 */
export interface HoundWebEndpointConfig {
  /** @deprecated Remove this setting; no external Hound service is contacted. */
  readonly endpoint: string;
}

export interface OllamaWebSearchConfig {
  /** Ollama service origin. Defaults to http://127.0.0.1:11434. */
  readonly baseUrl: string;
  /** Resolved API key for the exact https://ollama.com origin only. */
  readonly apiKey?: string;
  /** Name of the environment variable holding the API key. */
  readonly apiKeyEnv?: string;
  /** Required acknowledgement for non-private custom HTTPS origins. */
  readonly trustPublicUrl: boolean;
}
/** Built-in memory engine selector. */
export type MemoryBackend = (typeof MEMORY_BACKENDS)[number];
/** Configuration for bujo-tier lightweight consolidation. */
export interface MemoryConsolidationConfig {
  readonly enabled?: boolean;
  readonly cron?: string;
}
export type MemoryEmbeddingsProvider = (typeof MEMORY_EMBEDDINGS_PROVIDERS)[number];
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
  /**
   * Provider service root. LM Studio defaults to `http://localhost:1234` and
   * resolves embeddings below this root at `/v1/embeddings`.
   */
  readonly endpoint?: string;
  /** Resolved key value (inline or read from `apiKeyEnv` at load time). */
  readonly apiKey?: string;
  /**
   * Name of the env var configured for the key. Optional-auth local providers
   * keep it even while unset so readiness can report a waiting credential.
   */
  readonly apiKeyEnv?: string;
  /** Embedding vector dimension (bujo mode default: 768 for nomic-embed-text). */
  readonly dim?: number;
  /** Per-call embeddings timeout in ms (default 10000 in the host). */
  readonly timeoutMs?: number;
  /** Circuit-breaker overrides; unset fields fall back to the breaker defaults. */
  readonly circuitBreaker?: MemoryEmbeddingsCircuitBreakerConfig;
}
export type MemoryLlmProvider = (typeof MEMORY_LLM_PROVIDERS)[number];
export interface MemoryOllamaLlmConfig {
  readonly provider: "ollama";
  readonly model: string;
  readonly endpoint?: string;
}
export interface MemoryAgentHostLlmConfig {
  readonly provider: "agent-host";
  /** Runtime model reference string, parsed by the host when constructing the LLM. */
  readonly model: string;
  /**
   * Record each memory LLM `complete()` as a run through the same local JSONL
   * pipeline as channel runs (per-ritual labelled, `mem-*` run ids). Defaults to
   * `true`; set `false` to keep memory LLM calls unrecorded.
   */
  readonly trace?: boolean;
  /**
   * Per-`complete()` timeout in ms before the memory LLM run is aborted. Defaults
   * to 60000. Raise it when a slow local model (e.g. opencode-go) trips the cap on
   * the heavier reconcile/entities steps.
   */
  readonly timeoutMs?: number;
}
export type MemoryLlmConfig = MemoryOllamaLlmConfig | MemoryAgentHostLlmConfig;

export type SessionMode = "continuous" | "per-message";

/**
 * Session rollover policy. "daily" appends a local-date bucket to each
 * conversationId so a new calendar day starts a fresh session across ALL
 * channels (cron, telegram, slack, …), bounding unbounded history growth;
 * within-day growth is absorbed by context compaction. "none" = unchanged.
 */
export type SessionRollover = "none" | "daily";

/**
 * Skill disclosure mode. "index" injects only the skill index (names +
 * descriptions) plus a `ReadSkill` tool the agent calls to pull a full body on
 * demand; "full" inlines `selectedSkills` bodies into the prompt up front. See
 * `MonoAgentConfig.context.skillDisclosure`. Default "full" (legacy behavior); set
 * "index" to opt in to progressive disclosure.
 */
export type SkillDisclosureMode = "index" | "full";
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** One canonical fallback route. Omitted effort means provider default. */
export interface RuntimeFallbackConfig {
  readonly model: RuntimeModelReference;
  readonly effort?: EffortLevel;
  /**
   * Total attempts on this route including the first, 1–10. Omitted means a
   * single shot, so only the primary retries by default.
   */
  readonly attempts?: number;
}

/**
 * Same-model retry policy. A retry re-runs the whole logical turn on the same
 * route before the chain advances, and only fires for transient provider
 * failures (overloaded, rate-limited, timeout, network, 5xx). Deterministic
 * failures — context overflow, bad credentials — advance immediately, because
 * a second identical request cannot succeed where the first did not.
 */
export interface RuntimeRetryConfig {
  /** Total attempts on `runtime.model` including the first. Bounded 1–10, default 2. */
  readonly primaryAttempts: number;
  /** Delay before the first retry; doubles each retry. Bounded 0–60000, default 1000. */
  readonly backoffMs: number;
  /** Ceiling for the doubled delay. Bounded 0–300000, default 15000. */
  readonly maxBackoffMs: number;
}

/**
 * One named subagent the `Agent` tool can deploy. Shaped to project onto the
 * Claude-native `Task` definitions (`{name, description, helperSystemPrompt,
 * allowedTools, disallowedTools, modelRef, mcpServers}`) so one config block can
 * drive both the in-process Pi tool and Claude's native surface. Codex owns its
 * collaboration-agent definitions instead of accepting this projection.
 */
export interface MonoAgentSubagentConfig {
  /** Model-visible identifier and the `Agent` tool's `name` enum value. */
  readonly name: string;
  /** Model-visible: when to pick this profile. One sentence. */
  readonly description: string;
  /** The subagent's system prompt. Mutually exclusive with `promptPath`. */
  readonly prompt?: string;
  /** File holding the system prompt, resolved against the config directory. */
  readonly promptPath?: string;
  /** Absent inherits the parent's configured route and its fallback chain. */
  readonly model?: RuntimeModelReference;
  readonly effort?: EffortLevel;
  /** Absent uses the safe read-only default set. `"*"` is rejected. */
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /** Names of servers from `tools.mcpConfigPath` to expose to this subagent. */
  readonly mcpServers?: readonly string[];
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
}

/**
 * Whether the agent may author a specialized subagent at call time instead of
 * picking a pre-declared profile, and the ceiling for the runtime-owned
 * general-purpose helper.
 */
export interface MonoAgentInlineSubagentsConfig {
  /** Default true whenever subagents are enabled. */
  readonly enabled?: boolean;
  /**
   * Ceiling on the runtime-owned general-purpose helper's read-only tools and
   * on what an authored subagent may request. Pre-declared profiles retain their
   * explicit contracts. Absent means the parent agent's own effective built-ins,
   * so an in-flight helper can never reach further than the agent that created
   * it. `"*"` is rejected.
   */
  readonly allowedTools?: readonly string[];
}

/** One model the parent may pick per `Agent` call (`subagents.models`). */
export interface MonoAgentSubagentModelChoice {
  /** Optional short name; otherwise the canonical model reference is used. */
  readonly name?: string;
  readonly model: RuntimeModelReference;
}

/**
 * Subagent deployment policy. Absent or `enabled: false` means the `Agent` tool
 * is never registered.
 */
export interface MonoAgentSubagentsConfig {
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

  /** Operator allow-list for call-time Agent model overrides. */
  readonly models?: readonly MonoAgentSubagentModelChoice[];
  readonly enabled?: boolean;
  /** In-flight subagents per parent turn. Default 5. */
  readonly maxConcurrent?: number;
  /** Total `Agent` calls per parent turn — the runaway guard. Default 20. */
  readonly maxPerTurn?: number;
  /** Default per-subagent wall clock in ms. Default 300000. */
  readonly timeoutMs?: number;
  /** Detached child foreground Bash/Exec ceiling in ms. Default 1800000; bounded by its job deadline. */
  readonly commandTimeoutMs?: number;
  /** Default per-subagent turn cap. Default 100. */
  readonly maxTurns?: number;
  readonly definitions?: readonly MonoAgentSubagentConfig[];
  readonly inline?: MonoAgentInlineSubagentsConfig;
}

export interface ArtifactRetentionConfig {
  /** Delete terminal run artifacts older than this many days. */
  readonly maxAgeDays: number;
  /** Keep at most this many newest terminal runs after age pruning. */
  readonly maxCount: number;
  /** Report what would be deleted without unlinking files. */
  readonly dryRun: boolean;
}

export interface MonoAgentConfig {
  /** Public display identity. It never participates in paths or service ids. */
  readonly agent?: {
    readonly name: string;
  };
  readonly runtime: {
    readonly model: RuntimeModelReference;
    /** Canonical fallback routes. Omitted per-route effort uses the provider default. */
    readonly fallbacks?: readonly RuntimeFallbackConfig[];
    /**
     * Same-model retry policy. `loadMonoAgentConfig` always materializes it, so
     * loaded configs always carry it. It stays optional because MonoAgentConfig
     * is hand-constructible by programmatic embedders: a config built without
     * this block keeps the pre-retry behavior of one attempt per route rather
     * than failing to compile.
     */
    readonly retry?: RuntimeRetryConfig;
    readonly effort?: EffortLevel;
    /** Optional hard cap per run; omitted means unlimited. */
    readonly maxTurns?: number;
    /** Adaptive context compaction policy forwarded directly to the runtime. */
    readonly compaction?: RuntimeCompactionPolicy;
    readonly workspace: string;
    readonly session: {
      readonly mode: SessionMode;
      readonly idleTimeoutMs: number;
      /** Daily/none session rollover; default "none". */
      readonly rollover?: SessionRollover;
      /** IANA timezone for the rollover date boundary; default system-local. */
      readonly rolloverTimezone?: string;
      /** Show an operator-facing notice when session rollover starts a fresh session. */
      readonly rolloverNotice?: boolean;
      /**
       * When true, cron/proactive runs are handled as one-shot ephemeral turns:
       * they neither resume nor persist into the shared continuous session, so
       * their large tool dumps stay out of the interactive transcript. Interactive
       * (non-cron) turns are unaffected. Default false (no behavior change).
       */
      readonly isolateProactive?: boolean;
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
  /** Subagent profiles and caps for the `Agent` tool. */
  readonly subagents?: MonoAgentSubagentsConfig;
  readonly context: {
    readonly identityPath: string;
    readonly soulPath?: string;
    readonly skillsRoot?: string;
    readonly selectedSkills: readonly string[];
    /** Hard byte cap per selected skill body (default 48000 in the harness). */
    readonly skillMaxBytes?: number;
    /**
     * How skill bodies reach the agent. "full" (default) preserves the legacy
     * behavior where `selectedSkills` bodies are inlined into the prompt up front
     * (via skillInstructions). "index" injects only the skill INDEX (names +
     * descriptions) and exposes a `ReadSkill` tool so the agent pulls a full body
     * on demand — keeping the system prompt small. Unset = "full".
     */
    readonly skillDisclosure?: SkillDisclosureMode;
  };
  readonly memory?: {
    /** Memory engine. `"bujo"` is the built-in SQLite engine driven by `mode`. */
    readonly backend?: MemoryBackend;
    readonly mode: MemoryMode;
    readonly path: string;
    readonly maxBytes: number;
    readonly writeMode: MemoryWriteMode;
    /** Embedding provider for semantic memory recall; keyword fallback when unset. */
    readonly embeddings?: MemoryEmbeddingsConfig;
    /** LLM for bujo capture and effective tier selection. */
    readonly llm?: MemoryLlmConfig;
    /**
     * Explicit read-only memory tools exposed to the agent. `MemoryRecall`
     * provides targeted search for every backend; capable local tiers may also
     * provide policy-gated `MemoryJournal` chronology. Derived from this single
     * memory block — no hand-wired MCP entry. Defaults on for every configured
     * local tier; explicit false opts out of both explicit read tools without
     * disabling automatic memory context.
     */
    readonly recallTool?: { readonly enabled: boolean };
    /**
     * Agent-callable `Remember` tool that durably stores one explicitly stated
     * fact. Deterministic and append-only; it takes no chat LLM. Defaults on for
     * every local tier; explicit false opts out.
     */
    readonly rememberTool?: { readonly enabled: boolean };
    /** Bujo-tier lightweight consolidation. Scheduler default cadence: every two hours. */
    readonly consolidation?: MemoryConsolidationConfig;
  };
  readonly tools: {
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
    /**
     * Extra roots for the managed Read/Write/Edit/Glob/Grep tools while the
     * process sandbox is off. These extend the workspace boundary without
     * widening it to a common parent directory; native sandbox roots remain
     * authoritative when sandboxing is enabled.
     */
    readonly filesystem?: {
      readonly readableRoots: readonly string[];
      readonly writableRoots: readonly string[];
    };
    readonly mcpConfigPath?: string;
    /**
     * Names of configured stdio MCP servers that receive trusted per-request
     * producing-conversation, run, output-directory, and progress capability
     * context. Unlisted servers preserve the legacy static environment.
     */
    readonly mcpRequestContextServers?: readonly string[];
    /**
     * Names of stdio or loopback-HTTP MCP servers allowed to receive a
     * host-minted, destination-bound continuation claim capability.
     */
    readonly continuationServers?: readonly string[];
    /** Inactivity timeout per MCP tool call; progress notifications reset it. Runtime default: 120s. */
    readonly mcpCallTimeoutMs?: number;
    /** Hard wall clock per MCP tool call that progress cannot extend. Runtime default: 45 min. */
    readonly mcpCallMaxTotalTimeoutMs?: number;
    /** Local-first public web research tools. */
    readonly web?: {
      readonly coordination?: "process" | "host";
      readonly search: {
        readonly backend: WebSearchBackend | readonly WebSearchBackend[];
        /** Hard ceiling on answered provider searches per logical run; failed dispatches are refunded. */
        readonly maxRequestsPerRun: number;
        /** @deprecated Use searxng.endpoint. Accepted for programmatic embedders. */
        readonly endpoint?: string;
        readonly searxng?: SearxngWebSearchConfig;
        readonly ollama?: OllamaWebSearchConfig;
        readonly parallel?: ParallelWebConfig;
        /** @deprecated Endpoint settings are rejected: Hound search is built in. */
        readonly hound?: HoundWebEndpointConfig;
        /** ChatGPT-subscription Codex app-server search settings. */
        readonly codex?: {
          /** Defaults to the low-cost, low-latency GPT-5.6 Luna route. */
          readonly model: string;
        };
      };
      readonly fetch: {
        readonly provider?: WebFetchProvider | readonly WebFetchProvider[];
        readonly parallel?: ParallelWebConfig;
        /** @deprecated Endpoint settings are rejected: Hound fetch is built in. */
        readonly hound?: HoundWebEndpointConfig;
        readonly render: WebFetchRenderMode;
        readonly browserCommand: string;
      };
    };
  };
  readonly sandbox?: SandboxPolicy;
  readonly artifacts: {
    readonly dir: string;
    readonly retention: ArtifactRetentionConfig;
    /** Retention policy for memory-run artifacts under the memory namespace. */
    readonly memoryRetention: ArtifactRetentionConfig;
  };
  readonly traceability: {
    readonly registryDir: string;
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly heartbeatMs?: number;
    readonly staleAfterMs?: number;
    /**
     * When this agent's own `registryDir` is not the machine-wide default
     * (e.g. `mono-agent init`'s config-local scaffold), also mirror its
     * heartbeat manifest into the global `~/.mono-agent/trace-sources`
     * registry so machine-wide operator clients can find it. Default true; set
     * false to keep this agent's registration local-only.
     */
    readonly globalDiscovery?: boolean;
  };
  readonly providers?: {
    readonly piAuthPath?: string;
    /** Canonical provider definitions, sorted by id after config load. */
    readonly entries?: readonly ProviderDefinition[];
    /**
     * Compatibility projection for existing endpoint consumers. New callers
     * should use {@link resolveConfiguredProviders} and filter by `type`.
     */
    readonly local?: readonly LocalProviderDefinition[];
    readonly piNative?: PiNativeProviderConfig;
  };
}

/** One deterministic answer shared by catalog, doctor, and runtime consumers. */
export interface ResolvedProviders {
  readonly entries: readonly ProviderDefinition[];
  readonly byId: ReadonlyMap<string, ProviderDefinition>;
  readonly piAuthPath: string;
  readonly piNative?: PiNativeProviderConfig;
}

/** Tuning knobs for the pi-native provider bridge. */
export interface PiNativeProviderConfig {
  /** Preferred Pi provider transport (default auto; unsupported providers ignore it). */
  readonly transport?: PiTransport;
  /** Emit metadata-only prompt-cache request fingerprints into run artifacts (default false). */
  readonly promptCacheDiagnostics?: boolean;
  /** Anthropic Messages cache retention. Config loading defaults to long; short opts out. */
  readonly cacheRetention?: "short" | "long";
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

export type RedactedProviderDefinition = Omit<ProviderDefinition, "apiKey"> & {
  readonly apiKey?: RedactedSecretValue;
};

export type RedactedMemoryEmbeddingsConfig = Omit<MemoryEmbeddingsConfig, "apiKey"> & {
  readonly apiKey?: RedactedSecretValue;
};

export type RedactedOllamaWebSearchConfig = Omit<OllamaWebSearchConfig, "apiKey"> & {
  readonly apiKey?: RedactedSecretValue;
};

export type RedactedToolsConfig = Omit<MonoAgentConfig["tools"], "web"> & {
  readonly web?: Omit<NonNullable<MonoAgentConfig["tools"]["web"]>, "search"> & {
    readonly search: Omit<NonNullable<MonoAgentConfig["tools"]["web"]>["search"], "ollama"> & {
      readonly ollama?: RedactedOllamaWebSearchConfig;
    };
  };
};

export type RedactedMemoryConfig = Omit<
  NonNullable<MonoAgentConfig["memory"]>,
  "embeddings"
> & {
  readonly embeddings?: RedactedMemoryEmbeddingsConfig;
};

export interface RedactedMonoAgentConfig {
  readonly agent?: MonoAgentConfig["agent"];
  readonly runtime: MonoAgentConfig["runtime"];
  readonly concurrency?: MonoAgentConfig["concurrency"];
  readonly context: MonoAgentConfig["context"];
  readonly memory?: RedactedMemoryConfig;
  readonly tools: RedactedToolsConfig;
  readonly sandbox?: MonoAgentConfig["sandbox"];
  readonly artifacts: MonoAgentConfig["artifacts"];
  readonly traceability: MonoAgentConfig["traceability"];
  readonly providers?: {
    readonly piAuthPath?: string;
    readonly entries?: readonly RedactedProviderDefinition[];
    readonly local?: readonly RedactedLocalProviderDefinition[];
    readonly piNative?: PiNativeProviderConfig;
  };
}
