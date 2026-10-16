import type * as Policies from "#turn/contracts/policy";
import type { RuntimeLiveInputEvidence } from "#turn/contracts/live-input";
import type { RuntimeLiveInputUncertainty } from "#turn/contracts/live-input";
import type { RuntimeLiveInputMessage } from "#turn/contracts/live-input";
import type { RuntimeMcpAppConnection } from "#turn/contracts/mcp-apps";
import type { RuntimeMcpAppRegistration } from "#turn/contracts/mcp-apps";
import type { RuntimeMcpAppHost } from "#turn/contracts/mcp-apps";
import type { RuntimeSessionTurnDescriptor } from "#turn/contracts/session";
import type { RuntimeSessionTurnReconciliationRequest } from "#turn/contracts/session";
import type { RuntimeSessionTurnReconciliationResult } from "#turn/contracts/session";
import type { RuntimeNativeSessionAuthority } from "#turn/contracts/session";
import type { RuntimeNativeSessionProjection } from "#turn/contracts/session";
import type { ProcessJobProcessResult } from "#turn/contracts/process";
import type { ProcessJobProcessHandle } from "#turn/contracts/process";
import type { ProcessJobStartRequest } from "#turn/contracts/process";
import type { ProcessJobStartResult } from "#turn/contracts/process";
import type { ProcessJobsController } from "#turn/contracts/process";
import type { OwnedForegroundProcessRequest } from "#turn/contracts/process";
import type { OwnedForegroundProcesses } from "#turn/contracts/process";
import type * as RuntimeContracts from "#turn/contracts/runtime";
import type * as Events from "#turn/contracts/events";
import type * as Pricing from "#turn/telemetry/cost";
import type {
  AgentReplyMcpAppPart,
  AgentReplyPartFailure,
  AgentToolEnvironment,
} from "@mono-agent/contracts";
import type { PreparedSandboxCommand, SandboxCommandSpec, SandboxPolicy } from "./sandbox/contracts.js";
import type { RuntimeToolLifecycleTerminalState } from "#turn/contracts/events";
import type { RuntimeNativeJournalAuthority, RuntimeNativeJournalDeletion, RuntimeNativeJournalDescriptor, RuntimeNativeJournalRef, RuntimeNativeEpochContext, RuntimeNativeJournalStorage, RuntimeNativeJournalPresence, RuntimeNativeEvidenceView, RuntimeHandoffBudget, RuntimePreparedHandoff, RuntimeHandoffSummary, RuntimeHandoffProducerRequest, RuntimeHandoffFit, RuntimeHandoffProducerResult, RuntimeHandoffOptions, RuntimeHandoffProposal, RuntimeNativePreparationStorage } from "#turn/contracts/native-storage";


export interface MonoRuntimeSandboxEngine {
  readonly id?: string;
  isAvailable(): Promise<boolean>;
  prepareCommand(command: SandboxCommandSpec, policy: SandboxPolicy): Promise<PreparedSandboxCommand>;
}


export type RuntimeModelReference = Readonly<RuntimeContracts.RuntimeModelRef>;


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
  readonly providerBoundary: "Pi SDK provider gateway via @mono-agent/turn";
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
  /**
   * Bounded provider-route attribution for the delegation. On `agent_started`
   * this is the LAUNCH route — the explicit request completed with the
   * inherited parent route — with `disposition: "unknown"`, so consumers must
   * render it requested-only, never as a confirmed run. On `agent_completed`
   * it is the final accounting, where `requested` is the explicit request
   * alone. Absent when the runtime knows no route; never guessed.
   */
  readonly attribution?: RuntimeSubagentRouteAttribution;
}


/** Explicitly requested leg of one delegation's route, as `<provider>:<model>`. */
interface RuntimeSubagentRouteSelection {
  readonly model?: string;
  readonly effort?: string;
}


/** A route leg the provider actually ran on, with its effective effort when reported. */
interface RuntimeSubagentRouteExecution extends RuntimeSubagentRouteSelection {
  readonly effectiveEffort?: string;
}


interface RuntimeSubagentRouteTransition {
  readonly from: string;
  readonly to: string;
  readonly attemptIndex?: number;
  readonly reason?: string;
}


interface RuntimeSubagentRouteRetry {
  readonly model?: string;
  readonly retryIndex?: number;
  readonly attempts?: number;
  readonly reason?: string;
}


/** Bounded provider-route attribution for one delegation; see `RuntimeSubagentIdentity.attribution`. */
export interface RuntimeSubagentRouteAttribution {
  readonly requested: RuntimeSubagentRouteSelection;
  readonly attempted?: RuntimeSubagentRouteExecution;
  readonly executed?: RuntimeSubagentRouteExecution;
  readonly disposition: "requested" | "fallback" | "unknown";
  readonly transitions: readonly RuntimeSubagentRouteTransition[];
  readonly retries: readonly RuntimeSubagentRouteRetry[];
  readonly truncated?: true;
}


/** Normalized subagent lifecycle/activity phases. */
export type RuntimeSubagentActivityPhase =
  | "agent_started"
  | "started"
  | "completed"
  | "message"
  | "agent_completed";
/** Open telemetry remains intentionally permissive. */
export type RuntimeEventLike = Events.RuntimeEventLike;



/** Provider-neutral, host-persisted half of a managed tool lifecycle.
 */
export type RuntimeToolLifecycleEvent = Events.RuntimeToolLifecycleEvent;


/** Host acknowledgement for one accepted lifecycle half.
 */
export type RuntimeToolLifecyclePersistence = Events.RuntimeToolLifecyclePersistence;


/** Awaited host boundary used to persist managed tool lifecycles. */
export type RuntimeToolLifecycleSink = Events.RuntimeToolLifecycleSink;


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


/** Monotonic per-execution evidence, armed only after canonical replay seeding. */
export type RuntimeDispatchProgress = Readonly<NonNullable<RuntimeContracts.RuntimeResult["dispatchProgress"]>>;
/** Readonly host projection; unknown provider diagnostics remain open. */
export type RuntimeResult = Readonly<Pick<RuntimeContracts.RuntimeResult, "turnDisposition" | "subagentQuestion" | "text" | "structuredResult" | "structuredResultSource" | "events" | "durationMs" | "numTurns" | "model" | "effort" | "sdk" | "cancelled" | "error" | "failureKind" | "retryable" | "providerSessionId" | "providerSessionRecovery" | "runtimeWarnings">> & {
  readonly dispatchProgress?: RuntimeDispatchProgress;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly errorDetails?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
  readonly [key: string]: unknown;
};



/**
 * Typed per-run tool-output limits (mirrors agent-runtime's RuntimeToolLimits,
 * contracts/runtime.js). Omitted fields use the turn defaults.
 */
export type RuntimeToolLimits = Readonly<Policies.RuntimeToolLimits>;


/**
 * Typed per-run context-compaction policy (mirrors agent-runtime's
 * RuntimeCompactionPolicy). Omitted scalar budgets resolve adaptively against
 * the effective model context window.
 */
export type RuntimeCompactionPolicy = Readonly<Policies.RuntimeCompactionPolicy>;


/**
 * Per-run prompt-fragment overrides (mirrors agent-runtime's
 * RuntimePromptOverrides). Precedence run over host over the kernel default.
 */
export type RuntimePromptOverrides = Readonly<Policies.RuntimePromptOverrides>;



/** Recognized synchronous host-settlement confirmation values. */
type RuntimeLiveInputCallbackDisposition = "recorded" | "ignored";



/** Provider transport requested for Pi-native runs. Unsupported providers ignore it. */
export const PI_TRANSPORTS = ["auto", "sse", "websocket", "websocket-cached"] as const;

export type PiTransport = (typeof PI_TRANSPORTS)[number];



/** Awaited host claim before a router may detach a protected native attempt. */
export interface RuntimeSessionTurnDetachedAttempt {
  readonly descriptor: RuntimeSessionTurnDescriptor;
  readonly model: RuntimeModelReference;
  readonly attemptIndex: number;
  readonly retryIndex: number;
  readonly result: RuntimeResult;
}
/** Common request facts, narrowed by the host's authority and required inputs. */
export type RuntimeRunOptions = Readonly<Pick<RuntimeContracts.RuntimeRunOptions, "sessionRecovery" | "sessionTurn" | "model" | "providerAttributionSessionId" | "processJobs" | "ownedForegroundProcesses" | "promptCacheDiagnostics" | "cacheRetention" | "toolLifecycleSink" | "effort" | "cwd" | "maxTurns" | "allowedTools" | "disallowedTools" | "mcpCallNoTotalTimeoutTools" | "liveInput" | "piToolExecutionMode" | "piToolParallelismMode">> & {
  readonly toolLimits?: RuntimeToolLimits;
  readonly compaction?: RuntimeCompactionPolicy;
  readonly prompts?: RuntimePromptOverrides;
  /** Stable configured profile, never executable authority or retained controllers. */
  readonly toolExposure?: { readonly persistentSubagents?: boolean; readonly askParent?: boolean };
  /** Current host facts only; tools must independently enforce admission. */
  readonly hostCapabilities?: Readonly<Record<string, { readonly available: boolean; readonly reason?: string; readonly limits?: Readonly<Record<string, number | null>> }>>;

  readonly askParentController?: { submit(question: { question: string; options?: string[] }): Promise<void> };
  /** Request-bound host authority, never a model-provided request flag. */
  readonly finishSilentlyController?: { eligible(): boolean };
  readonly nativeSessionAuthority?: RuntimeNativeSessionAuthority;
  readonly nativeSessionProjection?: RuntimeNativeSessionProjection;
  /** Protected, lazy host replay prefix for stateless attempts; never telemetry. */
  readonly detachedContext?: () => Promise<readonly RuntimeMessage[]>;
  readonly onSessionTurnDetached?: (attempt: RuntimeSessionTurnDetachedAttempt) => Promise<void>;
  readonly messages: readonly RuntimeMessage[];
  readonly abortSignal: AbortSignal;
  /** Host-owned synchronous artifact writer bound to this run. */
  readonly persistArtifact?: (artifact: {
    readonly filename: string;
    readonly buffer: Buffer;
    readonly toolName: string;
    readonly toolUseId: string | null;
  }) => string | null;
  /** Host-only environment applied to Bash, Exec, and their nested subagents for this run. */
  readonly toolEnvironment?: AgentToolEnvironment;
  /** Request lineage diagnostics, including when no start controller is available. */
  readonly backgroundCapacity?: {
    readonly observedAt: string;
    readonly perConversation: { readonly running: number; readonly maxActivePerConversation: number; readonly queued: number; readonly availableRunningSlots: number };
    readonly global: { readonly running: number; readonly maxConcurrent: number; readonly queued: number; readonly maxQueued: number };
    readonly maxQueueAgeMs: number;
  };
  readonly processJobsAvailability?: {
    readonly chainDepth: number;
    readonly maxChainDepth: number;
    readonly remainingStarts: number;
    readonly unavailableReason?: "chain_depth_exhausted" | "origin_unavailable" | "wake_context_unavailable" | "tool_unavailable";
  };
  readonly onEvent?: (event: RuntimeEventLike) => void;
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
  /** Typed compaction policy. */
  /** Per-reference opt-in to the runtime-owned eligible GPT 1M window. */
  readonly context1MModels?: Readonly<Record<string, boolean>>;
  // Pi-native provider knobs (all optional; Pi is the only bridge).
  readonly piTransport?: PiTransport;
  readonly piMaxRetries?: number;
  readonly maxRetryDelayMs?: number;
  readonly sessionsRoot?: string;
  /** Host-owned shared web admission; never model-configurable. */
  readonly webRequestCoordinator?: {
    readonly scope: string;
    acquire(request: { kind: "searxng" | "ollama" | "duckduckgo" | "startpage" | "codex" | "fetch" | "parallel" | "local" | (string & {}); key: string; deadlineMs: number; signal?: AbortSignal }): Promise<{
      readonly waitMs: number;
      complete(outcome: { status: "ok" | "rate_limited" | "unavailable" | "cancelled"; retryAfterMs?: number; retryAtMs?: number }): Promise<void | { retryAfterMs: number; retryAtMs: number }>;
    }>;
    readQuota(): Promise<{ checkedAt: number; value: unknown } | undefined>;
    writeQuota(value: unknown): Promise<void>;
  };
  /** Local-first WebSearch backend selection for this run. */
  readonly webSearchConfig?: {
    readonly backend?: WebSearchProviderName | readonly WebSearchProviderName[];
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
    readonly parallel?: { readonly apiKeyEnv?: string };
    /** @deprecated Endpoint settings are rejected: local search is built in. */
    readonly hound?: { readonly endpoint?: string };
    readonly codex?: { readonly model?: string };
  };
  /** Static WebFetch extraction and optional isolated browser-render policy. */
  readonly webFetchConfig?: {
    readonly provider?: "local" | "parallel" | readonly ("local" | "parallel")[];
    readonly parallel?: { readonly apiKeyEnv?: string };
    /** @deprecated Endpoint settings are rejected: local fetch is built in. */
    readonly hound?: { readonly endpoint?: string };
    readonly render?: "never" | "auto";
    readonly browserCommand?: string;
  };
  readonly [key: string]: unknown;
};



export interface DurableSessionSalvage {
  readonly completed: readonly { readonly name: string; readonly result: string }[];
  readonly outcomeUnknown: readonly { readonly name: string }[];
  readonly omittedCompleted: number;
  readonly omittedUnknown: number;
  readonly draftText?: string;
  readonly additionalOutcomesUnknown: boolean;
}


/** Actual resolved native request, never credentials/auth headers. */
export interface RuntimeNativeDispatchSnapshot {
  readonly compactionSummaryMaxTokens?: number;
  readonly model: { readonly provider: string; readonly id: string; readonly api: string; readonly contextWindow: number; readonly maxTokens: number };
  readonly provenance: { readonly provider: string; readonly api: string; readonly model: string; readonly account: string | null };
  readonly systemPrompt: string;
  readonly tools: readonly { readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> }[];
  readonly messages: readonly RuntimeMessage[];
}

/** Only session binding is supplied after preparation. Instructions, input,
 * root, model, policy and resolved tools cannot be replaced at run time. */
export type RuntimeNativeDispatchBinding = Partial<Pick<RuntimeRunOptions, "sessionId" | "providerSessionId" | "providerAttributionSessionId"
  | "sessionKeepAlive" | "sessionIdleTimeoutMs" | "sessionTurn" | "sessionRecovery" | "nativeSessionAuthority" | "nativeSessionProjection">>;

export interface RuntimeNativePreparedDispatch {
  readonly snapshot: RuntimeNativeDispatchSnapshot;
  assertReady?(): void;
  checkHandoffSummary?(input: RuntimeHandoffProducerRequest): RuntimeHandoffFit;
  produceHandoffSummary?(input: RuntimeHandoffProducerRequest): Promise<RuntimeHandoffProducerResult>;
  /** Single primary attempt; no router replay/failover or repeated tool setup. */
  run(binding?: RuntimeNativeDispatchBinding): Promise<RuntimeResult>;
  /** Idempotent. During a running dispatch waits for normal cleanup; abort via
   * the original signal. Host must retain its concurrency permit until settled. */
  close(): Promise<void>;
}


export interface MonoRuntimeLike {
  prepareNativeDispatch?(systemPrompt: string, options: RuntimeRunOptions): Promise<RuntimeNativePreparedDispatch>;
  run(systemPrompt: string, options: RuntimeRunOptions): Promise<RuntimeResult>;
  configureTools?(next?: RuntimeToolOptions): void;
  /** Flush provider-owned durable transcript state before host history commit. */
  syncSession?(providerSessionId: string): Promise<boolean>;
  /** Explicit native evidence ownership, never inferred from method presence. */
  readonly sessionTurnReconciliation?: "v1" | undefined;
  reconcileSessionTurn?(request: RuntimeSessionTurnReconciliationRequest): Promise<RuntimeSessionTurnReconciliationResult>;
  recoverSession?(receipt: NonNullable<RuntimeResult["providerSessionRecovery"]>, context: { appliedInputIds: readonly string[] }): Promise<boolean>;
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
  salvageDurableSession?(providerSessionId: string, sessionsRoot: string): Promise<DurableSessionSalvage>;
  retireDurableSession?(providerSessionId: string, sessionsRoot: string, deletion?: RuntimeNativeJournalDeletion): Promise<void>;
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
export type MonoRuntimeParsedPricingModel = Readonly<Pricing.ParsedModelReference>;


/** agent-runtime's normalized per-token pricing row (see ai/cost.js's NormalizedPricing). */
export type MonoRuntimePricing = Readonly<Pricing.NormalizedPricing>;


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


/** Payload passed to `onCompactionRecorded` after a successful context compaction (see execution/pi/run.js). */
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


/** Source-level built-in web search provider names; arrays are ordered fallback chains. */
type WebSearchProviderName = "searxng" | "ollama" | "codex" | "keyless" | "duckduckgo" | "startpage" | "parallel" | "local";
