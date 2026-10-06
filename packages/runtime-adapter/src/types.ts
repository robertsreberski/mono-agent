import type { OwnedForegroundProcesses } from "./owned-foreground-processes.js";
import type {
  AgentReplyMcpAppPart,
  AgentReplyPartFailure,
  AgentToolEnvironment,
} from "@mono-agent/agent-contracts";
import type { PreparedSandboxCommand, SandboxCommandSpec, SandboxPolicy } from "./sandbox.js";
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
export interface RuntimeSubagentRouteSelection {
  readonly model?: string;
  readonly effort?: string;
}

/** A route leg the provider actually ran on, with its effective effort when reported. */
export interface RuntimeSubagentRouteExecution extends RuntimeSubagentRouteSelection {
  readonly effectiveEffort?: string;
}

export interface RuntimeSubagentRouteTransition {
  readonly from: string;
  readonly to: string;
  readonly attemptIndex?: number;
  readonly reason?: string;
}

export interface RuntimeSubagentRouteRetry {
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
    && optionalNumber(value, "costUsd")
    // Declared but loosely held: attribution is operator telemetry from
    // present and future producers, so the guard admits any record shape
    // rather than rejecting a payload this console does not know yet.
    && optionalRecord(value, "attribution");
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

function optionalRecord(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const candidate = value[key];
  return candidate === undefined
    || (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate));
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
  /** Certified only by a successful, terminal FinishSilently attempt. */
  readonly turnDisposition?: "silent" | "visible";
  readonly subagentQuestion?: { question: string; options?: string[] };
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
  readonly retryable?: boolean;
  readonly providerSessionId?: string | null;
  readonly providerSessionRecovery?: { runId: string; revision: number; providerSessionId: string; modelKey: string; tipId: string };
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Typed per-run tool-output limits (mirrors agent-runtime's RuntimeToolLimits,
 * ai/types.js). Omitted fields use the kernel defaults.
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
 * RuntimeCompactionPolicy). Omitted scalar budgets resolve adaptively against
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

/**
 * Per-run prompt-fragment overrides (mirrors agent-runtime's
 * RuntimePromptOverrides). Precedence run over host over the kernel default.
 */
export interface RuntimePromptOverrides {
  readonly structuredOutputInstruction?: (systemPrompt: string) => string;
  readonly structuredOutputFinalization?: () => string;
  readonly liveInputGuidance?: (body: string) => string;
}

/** Exact native identifiers that can correlate a live follow-up to one provider run. */
export interface RuntimeLiveInputEvidence {
  readonly providerEntryId?: string;
  readonly providerRunId?: string;
}

/** A handed-off follow-up whose absence from the active provider run cannot be proved. */
export interface RuntimeLiveInputUncertainty extends RuntimeLiveInputEvidence {
  readonly reason: "delivery_uncertain";
}

/** Recognized synchronous host-settlement confirmation values. */
export type RuntimeLiveInputCallbackDisposition = "recorded" | "ignored";

/** One live follow-up delivered to a provider bridge. */
export interface RuntimeLiveInputMessage {
  readonly body: string;
  readonly id?: string;
  readonly receivedAt?: string;
  /**
   * Optional opaque in-process identity shared by fresh callback leases for
   * this same logical message. Later same-id values without this exact object
   * remain invalid duplicate owners.
   */
  readonly logicalOwner?: object;
  /** Called after the provider's native queue accepts this exact attempt. */
  readonly accepted?: (evidence?: RuntimeLiveInputEvidence) => unknown;
  /** Called only after exact native transcript consumption is proved. */
  readonly acknowledge?: (evidence?: RuntimeLiveInputEvidence) => unknown;
  /** Called when delivery cannot be proved absent and must not be retried. */
  readonly uncertain?: (details: RuntimeLiveInputUncertainty) => unknown;
  /** Per-attempt safe rejection; a later provider attempt may still replay it. */
  readonly reject?: (reason?: unknown) => unknown;
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

/** Host-owned native turn identity; distinct from terminal-recovery authority. */
export interface RuntimeSessionTurnDescriptor {
  readonly kind: "host" | "instance";
  readonly ownerKey: string;
  /** Physical canonical-history bucket; null for instance-owned execution. */
  readonly historyBucket: string | null;
  readonly turnId: string;
  readonly handleId: string;
  readonly baseRevision: number | null;
  /** Explicit native evidence preservation; host adoption is separately coordinated. */
  readonly reconciliation?: {
    readonly version: 1;
    readonly purpose: "execution" | "compaction";
    readonly fenceDigest: string;
    readonly initialInputId: string | null;
  };
}

export interface RuntimeSessionTurnReconciliationRequest {
  readonly sessionsRoot: string;
  readonly descriptor: RuntimeSessionTurnDescriptor;
  readonly purpose: "execution" | "compaction";
  readonly expectedModel: { readonly provider: string; readonly id: string; readonly api?: string };
  readonly expectedBaseTip?: string | null;
  /** Exactly one original initial input, plus every native live admission,
   * including cancelled/unconsumed entries; additional fenced host offers are
   * permitted but do not prove native execution. Digests use native formatted
   * content (live guidance, not raw body); replay of the original is initial. */
  readonly expectedInputs: readonly { readonly id: string; readonly requestDigest: string; readonly placement: "initial" | "live" }[];
}

export interface RuntimeSessionTurnResultSeal {
  readonly text: string | null;
  readonly error: string | null;
  readonly failureKind: string | null;
  readonly cancelled: boolean;
  readonly stopReason: string | null;
  readonly turnDisposition?: "silent";
}

export type RuntimeSessionTurnReconciliationResult =
  | { readonly status: "absent" }
  | { readonly status: "mismatch"; readonly reason: string }
  | {
      readonly status: "matched";
      readonly journalId: string;
      readonly handleId: string;
      readonly turnId: string;
      readonly baselineTipId: string | null;
      readonly tipId: string | null;
      readonly currentTipId: string | null;
      readonly outcome: "completed" | "failed" | "cancelled" | "interrupted";
      readonly seal: { readonly version: 1; readonly outcome: "completed" | "failed" | "cancelled" | "interrupted"; readonly result: RuntimeSessionTurnResultSeal | null } | null;
      readonly binding: RuntimeSessionTurnDescriptor & { readonly version: 1; readonly model: { readonly provider: string; readonly id: string; readonly api: string } };
      readonly inputs: readonly { readonly id: string; readonly messageId: string; readonly requestDigest: string; readonly placement: "initial" | "replay" | "live"; readonly complete: boolean }[];
      readonly admittedInputs: readonly { readonly id: string; readonly state: "queued" | "cancelled" | "consumed"; readonly placement: "live"; readonly requestDigest: string }[];
      readonly finalOperationId: string | null;
      readonly consumedInputIds: readonly string[];
      readonly operations: readonly {
        readonly operationId: string; readonly type: "prompt" | "compaction";
        readonly cause: string; readonly parentOperationId: string | null;
        readonly baselineTipId: string | null; readonly tipId: string | null;
        readonly startSeq: number; readonly endSeq: number | null;
        readonly status: "completed" | "failed" | "aborted" | "interrupted" | null;
        readonly suspended: boolean;
      }[];
      readonly commitCandidate?: RuntimeSessionTurnResultSeal;
      readonly interruptionEvidence: readonly {
        readonly cause: string; readonly operationIds: readonly string[];
        readonly calls: readonly { readonly callId: string; readonly name: string; readonly operationId: string; readonly messageId: string; readonly admission: string; readonly cause: string }[];
        readonly tipId: string | null; readonly timestamp: number;
      }[];
    };

/** Awaited host claim before a router may detach a protected native attempt. */
export interface RuntimeSessionTurnDetachedAttempt {
  readonly descriptor: RuntimeSessionTurnDescriptor;
  readonly model: RuntimeModelReference;
  readonly attemptIndex: number;
  readonly retryIndex: number;
  readonly result: RuntimeResult;
}

export interface RuntimeRunOptions {
  /** Stable configured profile, never executable authority or retained controllers. */
  readonly toolExposure?: { readonly persistentSubagents?: boolean; readonly askParent?: boolean };
  /** Current host facts only; tools must independently enforce admission. */
  readonly hostCapabilities?: Readonly<Record<string, { readonly available: boolean; readonly reason?: string; readonly limits?: Readonly<Record<string, number | null>> }>>;

  readonly askParentController?: { submit(question: { question: string; options?: string[] }): Promise<void> };
  /** Request-bound host authority, never a model-provided request flag. */
  readonly finishSilentlyController?: { eligible(): boolean };
  /** Host-owned opt-in for settled durable terminal recovery. */
  readonly sessionRecovery?: { runId: string; revision: number } | undefined;
  /** Protected host-owned journal/turn binding, not permission to recover canonical history. */
  readonly sessionTurn?: RuntimeSessionTurnDescriptor | undefined;
  readonly onSessionTurnDetached?: (attempt: RuntimeSessionTurnDetachedAttempt) => Promise<void>;
  readonly model: RuntimeModelReference;
  readonly messages: readonly RuntimeMessage[];
  readonly abortSignal: AbortSignal;
  /** Host-owned synchronous artifact writer bound to this run. */
  readonly persistArtifact?: (artifact: {
    readonly filename: string;
    readonly buffer: Buffer;
    readonly toolName: string;
    readonly toolUseId: string | null;
  }) => string | null;
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
  /** Host-scoped awaited command ownership; does not enable background tools. */
  readonly ownedForegroundProcesses?: OwnedForegroundProcesses;
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
  /** Emit metadata-only prompt-cache request fingerprints; disabled by default. */
  readonly promptCacheDiagnostics?: boolean;
  /** Optional Anthropic Messages cache retention. Unset preserves Pi defaults/environment. */
  readonly cacheRetention?: "short" | "long";
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
  /** Typed tool-output limits. */
  readonly toolLimits?: RuntimeToolLimits;
  /** Exact `server:tool` names whose host-owned lifecycle has no total deadline. */
  readonly mcpCallNoTotalTimeoutTools?: readonly string[];
  /** Typed compaction policy. */
  /** Per-reference opt-in to the runtime-owned eligible GPT 1M window. */
  readonly context1MModels?: Readonly<Record<string, boolean>>;
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
  /** Built-in tool scheduling. Safe parallelism keeps stateful/mutating tools sequential. */
  readonly piToolExecutionMode?: "sequential" | "safe-parallel";
  /** @deprecated Use piToolExecutionMode. */
  readonly piToolParallelismMode?: "one-at-a-time" | "all";
  readonly [key: string]: unknown;
}

export interface DurableSessionSalvage {
  readonly completed: readonly { readonly name: string; readonly result: string }[];
  readonly outcomeUnknown: readonly { readonly name: string }[];
  readonly omittedCompleted: number;
  readonly omittedUnknown: number;
  readonly draftText?: string;
  readonly additionalOutcomesUnknown: boolean;
}

/** Host-only storage authority; never a model-facing runtime option. */
export interface RuntimeNativeJournalAuthority {
  readonly version: 1;
  readonly canonicalVersion: 4;
  readonly rootId: string;
  readonly authorityId: string;
  readonly ownerKey: string;
  readonly historyBucket: string;
}
export interface RuntimeNativeJournalDeletion {
  readonly hostAuthority: RuntimeNativeJournalAuthority;
  readonly disposition: "C" | "D";
  readonly assertOwned: () => Promise<void>;
}

export interface MonoRuntimeLike {
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

/** Source-level built-in web search provider names; arrays are ordered fallback chains. */
type WebSearchProviderName = "searxng" | "ollama" | "codex" | "keyless" | "duckduckgo" | "startpage" | "parallel" | "local";
