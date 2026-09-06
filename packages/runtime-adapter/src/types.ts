import type {
  AgentReplyMcpAppPart,
  AgentReplyPartFailure,
  AgentToolEnvironment,
} from "@mono-agent/agent-contracts";
import type { PreparedSandboxCommand, SandboxCommandSpec, SandboxPolicy } from "./sandbox.js";
import type { MonitorsController } from "./monitors.js";
import type { ProcessJobsController } from "./process-jobs.js";

export interface MonoRuntimeSandboxEngine {
  readonly id?: string;
  isAvailable(): Promise<boolean>;
  prepareCommand(command: SandboxCommandSpec, policy: SandboxPolicy): Promise<PreparedSandboxCommand>;
}

export interface RuntimeModelReference {
  readonly provider: string;
  readonly model: string;
  readonly reference: string;
}

export interface MonoRuntimeBackendCapabilities {
  readonly kind?: string;
  readonly runtime?: string;
  readonly streaming?: boolean;
  readonly structured_output?: boolean;
  readonly supports_session_resume?: boolean;
  readonly native_runtime_config?: unknown;
  readonly supports_mcp?: boolean;
  readonly supports_mcp_apps?: boolean;
  readonly supports_skills?: boolean;
  readonly supports_builtin_tools?: boolean;
  readonly supports_live_input?: boolean;
  /** Native surface/activity support, not caller-defined profile injection. */
  readonly supports_native_subagents?: boolean;
  readonly supports_request_tool_environment?: boolean;
  readonly tool_policy?: "projected" | "allow_all_only";
  readonly [key: string]: unknown;
}

export interface MonoRuntimeBackendDescriptor {
  readonly id: "pi-sdk";
  readonly runtimeBridgeId: "pi";
  readonly label: "Pi SDK provider";
  readonly sdk: "pi";
  readonly transport: "sdk";
  readonly providerBoundary: "Pi SDK provider gateway via @mono-agent/agent-runtime";
  readonly modelReferenceExamples: readonly string[];
  readonly acceptsProviderIds: true;
  readonly capabilities: MonoRuntimeBackendCapabilities;
}

export interface MonoRuntimeSupportDescription {
  readonly model: RuntimeModelReference;
  readonly compatible: true;
  readonly backend: MonoRuntimeBackendDescriptor;
}

export interface RuntimeMessage {
  readonly role: string;
  readonly content: unknown;
  readonly timestamp?: number | string;
  readonly [key: string]: unknown;
}

/** Provider-neutral identity attached to every normalized subagent event. */
export interface RuntimeSubagentIdentity {
  /**
   * Canonical parent attachment key: normally the initiating parent tool-use
   * id, with a stable synthetic fallback only for an orphan lifecycle record.
   */
  readonly id: string;
  /** Provider-native task or thread id; correlation metadata only. */
  readonly nativeId?: string;
  /** Provider-neutral profile or agent name. */
  readonly name: string;
  /** Provider call-order ordinal; never an identity key. */
  readonly callIndex: number;
  readonly label?: string;
  /** Provider-reported ancestry; informational only. */
  readonly agentPath?: string;
  readonly costUsd?: number;
}

/** Normalized subagent lifecycle/activity phases. */
export type RuntimeSubagentActivityPhase =
  | "agent_started"
  | "started"
  | "completed"
  | "message"
  | "agent_completed";

/**
 * Permissive compatibility shape for the runtime's open telemetry stream.
 * Use {@link isRuntimeSubagentActivityEvent} for the exact normalized subagent
 * event contract.
 */
export interface RuntimeEventLike {
  readonly type?: string;
  readonly [key: string]: unknown;
}

/** Durable terminal classification for one managed tool invocation. */
export type RuntimeToolLifecycleTerminalState =
  | "success"
  | "rejected"
  | "error"
  | "exit_nonzero"
  | "timeout"
  | "signal"
  | "cancelled"
  | "interrupted";

/** Provider-neutral, host-persisted half of a managed tool lifecycle. */
export type RuntimeToolLifecycleEvent =
  | {
      readonly phase: "invocation";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments?: unknown;
    }
  | {
      readonly phase: "result";
      readonly toolCallId: string;
      readonly toolName?: string;
      readonly content?: unknown;
      readonly state: RuntimeToolLifecycleTerminalState;
      /** Existing observability failure taxonomy; no competing errorKind. */
      readonly failureKind?: string;
      readonly detailCode?: string;
      readonly executionMs?: number;
      readonly artifacts?: readonly {
        readonly path: string;
        readonly available?: boolean;
      }[];
    };

/** Host acknowledgement for one accepted lifecycle half. */
export interface RuntimeToolLifecyclePersistence {
  readonly recordId?: string;
  readonly sequence?: number;
  /** Persisted now, accepted for bounded reconciliation, or definitively failed. */
  readonly persistence: "persisted" | "deferred" | "failed";
  readonly truncated?: boolean;
  readonly originalBytes?: number;
  readonly retainedBytes?: number;
  readonly artifactReferences?: readonly {
    readonly id: string;
    readonly available: boolean;
  }[];
  readonly errorCode?: string;
}

/** Awaited host boundary used to persist managed tool lifecycles. */
export type RuntimeToolLifecycleSink = (
  event: RuntimeToolLifecycleEvent,
) => Promise<RuntimeToolLifecyclePersistence | undefined>;

/** One exact normalized native or in-process subagent activity event. */
export interface RuntimeSubagentActivityEvent extends RuntimeEventLike {
  readonly type: "subagent_activity";
  readonly subagent: RuntimeSubagentIdentity;
  readonly phase: RuntimeSubagentActivityPhase;
  /** Unique lifecycle/tool/message row id, namespaced from `subagent.id`. */
  readonly id: string;
  readonly name?: string;
  readonly arguments?: unknown;
  readonly content?: unknown;
  readonly kind?: "text" | "thinking" | "status" | "warning" | "error";
  readonly role?: "assistant" | "user";
  readonly isError?: boolean;
  readonly executionMs?: number;
  readonly totalTokens?: number;
}

/** Narrow an open runtime event to the exact normalized subagent contract. */
export function isRuntimeSubagentActivityEvent(value: unknown): value is RuntimeSubagentActivityEvent {
  if (!isUnknownRecord(value) || value.type !== "subagent_activity") {
    return false;
  }
  if (
    typeof value.id !== "string"
    || !isRuntimeSubagentActivityPhase(value.phase)
    || !isRuntimeSubagentIdentity(value.subagent)
  ) {
    return false;
  }
  return optionalString(value, "name")
    && optionalLiteral(value, "kind", ["text", "thinking", "status", "warning", "error"])
    && optionalLiteral(value, "role", ["assistant", "user"])
    && optionalBoolean(value, "isError")
    && optionalNumber(value, "executionMs")
    && optionalNumber(value, "totalTokens");
}

function isRuntimeSubagentIdentity(value: unknown): value is RuntimeSubagentIdentity {
  if (!isUnknownRecord(value)) {
    return false;
  }
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.callIndex === "number"
    && optionalString(value, "nativeId")
    && optionalString(value, "label")
    && optionalString(value, "agentPath")
    && optionalNumber(value, "costUsd");
}

function isRuntimeSubagentActivityPhase(value: unknown): value is RuntimeSubagentActivityPhase {
  return value === "agent_started"
    || value === "started"
    || value === "completed"
    || value === "message"
    || value === "agent_completed";
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return !(key in value) || typeof value[key] === "string";
}

function optionalNumber(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return !(key in value) || typeof value[key] === "number";
}

function optionalBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return !(key in value) || typeof value[key] === "boolean";
}

function optionalLiteral(
  value: Readonly<Record<string, unknown>>,
  key: string,
  choices: readonly string[],
): boolean {
  return !(key in value) || (typeof value[key] === "string" && choices.includes(value[key]));
}

export interface RuntimeResult {
  readonly text?: string | null;
  readonly structuredResult?: unknown;
  readonly structuredResultSource?: string | null;
  readonly events?: readonly RuntimeEventLike[];
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly durationMs?: number;
  readonly numTurns?: number;
  readonly model?: string;
  readonly effort?: string;
  readonly sdk?: string;
  readonly cancelled?: boolean;
  readonly error?: string | null;
  readonly errorDetails?: unknown;
  readonly failureKind?: string | null;
  readonly providerSessionId?: string | null;
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Typed per-run tool-output limits (mirrors agent-runtime's RuntimeToolLimits,
 * ai/types.js). The supported replacement for the deprecated `settings` tool
 * keys; build one with {@link resolveRuntimePolicies}.
 */
export interface RuntimeToolLimits {
  readonly toolTextLimitChars?: number;
  readonly bashOutputLimitChars?: number;
  readonly mcpTextLimitChars?: number;
  readonly searchResultLimit?: number;
  readonly imageInlineMaxBytes?: number;
  readonly toolPayloadMaxBytes?: number;
  readonly mcpCallTimeoutMs?: number;
  readonly mcpCallMaxTotalTimeoutMs?: number;
  /**
   * Foreground ceiling and default for Bash/Exec timeouts on the Pi bridge
   * (defaults to 120_000). Background process-job hand-offs ignore it and are
   * bounded by `processJobs.maxRuntimeMs` on the host side instead.
   */
  readonly bashTimeoutMs?: number;
}

/**
 * Typed per-run context-compaction policy (mirrors agent-runtime's
 * RuntimeCompactionPolicy). The supported replacement for the deprecated
 * `settings` compaction keys. Omitted scalar budgets resolve adaptively against
 * the effective model context window.
 */
export interface RuntimeCompactionPolicy {
  readonly enabled?: boolean;
  readonly triggerRatio?: number;
  readonly keepRecentTokens?: number;
  readonly summaryMaxTokens?: number;
  readonly minSavingsTokens?: number;
  readonly fixedOverheadEnabled?: boolean;
  readonly contextWindowOverride?: number;
}

/** The pair {@link resolveRuntimePolicies} returns from a legacy settings bag. */
export interface RuntimePolicies {
  readonly toolLimits: RuntimeToolLimits;
  readonly compaction: RuntimeCompactionPolicy;
}

/**
 * Per-run prompt-fragment overrides (mirrors agent-runtime's
 * RuntimePromptOverrides). Precedence run over host over the kernel default.
 */
export interface RuntimePromptOverrides {
  readonly structuredOutputInstruction?: (systemPrompt: string) => string;
  readonly structuredOutputFinalization?: () => string;
  readonly liveInputGuidance?: (body: string) => string;
}

/** One live follow-up delivered to a provider bridge. */
export interface RuntimeLiveInputMessage {
  readonly body: string;
  readonly id?: string;
  readonly receivedAt?: string;
  /** Called only after the provider's native steering boundary accepts it. */
  readonly acknowledge?: () => void;
  /** Per-attempt rejection; a later provider attempt may still replay it. */
  readonly reject?: (reason?: unknown) => void;
}

/** Provider transport requested for Pi-native runs. Unsupported providers ignore it. */
export const PI_TRANSPORTS = ["auto", "sse", "websocket", "websocket-cached"] as const;
export type PiTransport = (typeof PI_TRANSPORTS)[number];

/** Exact live MCP connection leased to the app-owned host after a UI tool call. */
export interface RuntimeMcpAppConnection {
  readonly connectionId: string;
  readResource(uri: string): Promise<unknown>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface RuntimeMcpAppRegistration {
  readonly runId?: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly toolCallId: string;
  readonly resourceUri: string;
  readonly protocolVersion: string;
  readonly toolInput: unknown;
  readonly toolResult: unknown;
  readonly resource: unknown;
  readonly appVisibleTools: readonly string[];
  readonly connection: RuntimeMcpAppConnection;
}

/** App-owned registry consumed only by Pi's exact MCP client path. */
export interface RuntimeMcpAppHost {
  readonly protocolVersions: readonly string[];
  readonly mimeTypes: readonly string[];
  register(input: RuntimeMcpAppRegistration): Promise<{
    readonly part: AgentReplyMcpAppPart | AgentReplyPartFailure;
    readonly retainConnection: boolean;
  }>;
  recordFailure(input: {
    readonly runId?: string;
    readonly serverName: string;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly code: AgentReplyPartFailure["code"];
    readonly message: string;
  }): Promise<AgentReplyPartFailure>;
}

export interface RuntimeRunOptions {
  readonly model: RuntimeModelReference;
  readonly messages: readonly RuntimeMessage[];
  readonly abortSignal: AbortSignal;
  /**
   * Host-owned provider attribution continuity key. Pi-native sends this raw
   * value only to providers that require session attribution; it does not by
   * itself authorize resuming provider transcript state.
   */
  readonly providerAttributionSessionId?: string;
  /** Host-only environment applied to Bash, Exec, and their nested subagents for this run. */
  readonly toolEnvironment?: AgentToolEnvironment;
  /** Host-only Pi-native process-job controller; never model/provider visible. */
  readonly processJobs?: ProcessJobsController;
  /** Host-only Pi-native monitor controller; never model/provider visible. */
  readonly monitors?: MonitorsController;
  readonly onEvent?: (event: RuntimeEventLike) => void;
  /** Emit metadata-only prompt-cache request fingerprints; disabled by default. */
  readonly promptCacheDiagnostics?: boolean;
  /** Host-owned, incremental durable tool-lifecycle writer for this run. */
  readonly toolLifecycleSink?: RuntimeToolLifecycleSink;
  readonly effort?: string;
  readonly cwd?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /** Request-scoped MCP servers. */
  readonly mcpServers?: Record<string, unknown>;
  /** Exact-connection MCP Apps host. Currently consumed by Pi-native routes. */
  readonly mcpApps?: RuntimeMcpAppHost;
  readonly mcpConfigPath?: string;
  readonly sandboxPolicy?: SandboxPolicy;
  readonly sandboxEngine?: MonoRuntimeSandboxEngine;
  /** The sandbox implementation is owned by createMonoRuntime; callers supply policy/engine data only. */
  readonly sandbox?: never;
  /**
   * Withdrawn in 0.21.0 with the runtime bridges that honored them. Left as
   * `never` rather than simply deleted: the Pi runtime ignores these, so a
   * caller that kept passing one would otherwise get silently different
   * behavior from the contract it was written against. Failing to compile says
   * so out loud.
   */
  readonly settingSources?: never;
  readonly codexLoadProjectDocs?: never;
  readonly codexSandboxNetworkAccess?: never;
  /**
   * Also withdrawn: no surviving bridge reads either. `fastMode` was a Claude
   * concept, and native teammate definitions were projected only by the deleted
   * Claude bridges -- the Pi bridge hardcodes an empty `nativeSubagentsUsed`.
   * In-process delegation is the `Agent` tool, configured by the host.
   */
  readonly fastMode?: never;
  readonly nativeSubagents?: never;
  /** Typed tool-output limits (supported replacement for the `settings` tool keys). */
  readonly toolLimits?: RuntimeToolLimits;
  /** Exact `server:tool` names whose host-owned lifecycle has no total deadline. */
  readonly mcpCallNoTotalTimeoutTools?: readonly string[];
  /** Typed compaction policy (supported replacement for the `settings` compaction keys). */
  readonly compaction?: RuntimeCompactionPolicy;
  /** Per-run prompt-fragment overrides. */
  readonly prompts?: RuntimePromptOverrides;
  /** In-flight user guidance consumed by a provider's native steering API. */
  readonly liveInput?: AsyncIterable<RuntimeLiveInputMessage>;
  // Pi-native provider knobs (all optional; Pi is the only bridge).
  readonly piTransport?: PiTransport;
  readonly piMaxRetries?: number;
  readonly maxRetryDelayMs?: number;
  readonly piSessionsRoot?: string;
  /** Host-owned shared web admission; never model-configurable. */
  readonly webRequestCoordinator?: {
    readonly scope: string;
    acquire(request: { kind: "searxng" | "ollama" | "duckduckgo" | "startpage" | "codex" | "fetch"; key: string; deadlineMs: number; signal?: AbortSignal }): Promise<{
      readonly waitMs: number;
      complete(outcome: { status: "ok" | "rate_limited" | "unavailable" | "cancelled"; retryAfterMs?: number; retryAtMs?: number }): Promise<void | { retryAfterMs: number; retryAtMs: number }>;
    }>;
    readQuota(): Promise<{ checkedAt: number; value: unknown } | undefined>;
    writeQuota(value: unknown): Promise<void>;
  };
  /** Local-first WebSearch backend selection for this run. */
  readonly webSearchConfig?: {
    readonly backend?: "auto" | "searxng" | "ollama" | "codex" | "keyless";
    readonly maxRequestsPerRun?: number;
    /** @deprecated Use searxng.endpoint. */
    readonly endpoint?: string;
    readonly searxng?: { readonly endpoint?: string };
    readonly ollama?: {
      readonly baseUrl?: string;
      readonly apiKey?: string;
      readonly apiKeyEnv?: string;
      readonly trustPublicUrl?: boolean;
    };
    readonly codex?: { readonly model?: string };
  };
  /** Static WebFetch extraction and optional isolated browser-render policy. */
  readonly webFetchConfig?: {
    readonly render?: "never" | "auto";
    readonly browserCommand?: string;
  };
  /** Built-in tool scheduling. Safe parallelism keeps stateful/mutating tools sequential. */
  readonly piToolExecutionMode?: "sequential" | "safe-parallel";
  /** @deprecated Use piToolExecutionMode. */
  readonly piToolParallelismMode?: "one-at-a-time" | "all";
  readonly [key: string]: unknown;
}

export interface MonoRuntimeLike {
  run(systemPrompt: string, options: RuntimeRunOptions): Promise<RuntimeResult>;
  configureTools?(next?: RuntimeToolOptions): void;
  /** Flush provider-owned durable transcript state before host history commit. */
  syncSession?(providerSessionId: string): Promise<boolean>;
  /**
   * Guarantee that the next resume cannot reuse process-local provider state.
   * Resolves for both removed and already-absent handles; rejects if the
   * guarantee cannot be made. Durable provider transcripts remain intact.
   */
  refreshSession?(providerSessionId: string): Promise<void>;
  /**
   * Permanently remove every provider transcript with this exact id from the
   * supplied durable sessions root. Absence is success; uncertainty rejects.
   */
  retireDurableSession?(providerSessionId: string, sessionsRoot: string): Promise<void>;
  disposeSession?(providerSessionId: string): Promise<boolean>;
  /** Permanently discard live and durable provider transcript state. */
  invalidateSession?(providerSessionId: string): Promise<boolean>;
  disposeAllSessions?(): Promise<void>;
}

export interface RuntimeToolOptions {
  readonly workspace?: string;
  readonly repoRoot?: string;
  readonly additionalReadRoots?: readonly string[];
  readonly additionalWriteRoots?: readonly string[];
  readonly ripgrepPath?: string;
  readonly qaOutputDir?: string;
  readonly sandboxPolicy?: SandboxPolicy;
  readonly sandboxEngine?: MonoRuntimeSandboxEngine;
  /** The sandbox implementation is owned by createMonoRuntime; callers supply policy/engine data only. */
  readonly sandbox?: never;
  readonly [key: string]: unknown;
}

/** A parsed model reference as agent-runtime's pricing resolvers receive it (see ai/cost.js's ParsedModelReference). */
export interface MonoRuntimeParsedPricingModel {
  readonly provider: string;
  readonly model: string;
}

/** agent-runtime's normalized per-token pricing row (see ai/cost.js's NormalizedPricing). */
export interface MonoRuntimePricing {
  readonly input: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly source: string;
  readonly priced: boolean;
}

/** Payload passed to `onToolApprovalRequest` (see agent/approval.js's ApprovalRequestPayload). */
export interface MonoRuntimeApprovalRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolUseId: string | null;
  readonly argumentsSummary: string;
  readonly riskTier: "low" | "medium" | "high";
  readonly model: string | null;
}

/** A host's response to a MonoRuntimeApprovalRequest. */
export interface MonoRuntimeApprovalDecision {
  readonly decision: "approve" | "deny" | "always";
  readonly reason?: string;
}

/** Payload passed to `onCompactionRecorded` after a successful context compaction (see ai/providers/pi-native.js). */
export interface MonoRuntimeCompactionRecord {
  readonly task_run_id: string | null;
  readonly trigger: string;
  readonly provider_kind: string;
  readonly model: string | null;
  readonly tokens_before: number | null;
  readonly summary: string;
  readonly first_kept_entry_id: string | null;
  readonly status: "succeeded";
  readonly created_at: number;
}

export interface MonoRuntimeHostOptions extends RuntimeToolOptions {
  readonly observers?: readonly unknown[];
  readonly runtimeBrand?: unknown;
  /** Host-level prompt-fragment override defaults; a per-run `prompts` wins over these. */
  readonly prompts?: RuntimePromptOverrides;
  readonly resolveCustomPricing?: (parsed: MonoRuntimeParsedPricingModel) => MonoRuntimePricing | null;
  readonly resolvePiApiKey?: (provider: string) => Promise<string | undefined>;
  readonly persistArtifact?: (artifact: {
    readonly filename: string;
    readonly buffer: Buffer;
    readonly toolName: string;
    readonly toolUseId: string | null;
  }) => string | null;
  readonly onCompactionRecorded?: (record: MonoRuntimeCompactionRecord) => void;
  readonly onToolApprovalRequest?: (payload: MonoRuntimeApprovalRequest) => Promise<MonoRuntimeApprovalDecision>;
  readonly toolRiskTiers?: Readonly<Record<string, "low" | "medium" | "high">>;
  readonly approvalDefaultRiskTier?: "low" | "medium" | "high";
  readonly approvalTimeoutMs?: number;
  readonly approvalAlwaysAllowTools?: readonly string[];
  readonly [key: string]: unknown;
}
