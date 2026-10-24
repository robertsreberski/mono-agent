import type { RuntimeDurableCompactionCheckpoint } from "./session.js";
// Shared turn contracts, authored as JSDoc; no runtime implementation imports.

export type RuntimeToolLimits = import("./policy.js").RuntimeToolLimits;

export type RuntimeCompactionPolicy = import("./policy.js").RuntimeCompactionPolicy;

export type RuntimePromptOverrides = import("./policy.js").RuntimePromptOverrides;

export type RuntimeSdkId = import("./model.js").RuntimeSdkId;

export type RuntimeBridgeId = import("./model.js").RuntimeBridgeId;

export type RuntimeModelRef = import("./model.js").RuntimeModelRef;

export type RuntimeEvent = import("./events.js").RuntimeEvent;

export type RuntimeToolLifecycleSink = import("./events.js").RuntimeToolLifecycleSink;


export type RuntimeRunOptions = {
  /** Request-local provider outage recovery window (0–180000 ms); default 0. */
  piRequestRetryBudgetMs?: number;
  /** Owner-held capacity/preparation barrier before publishing a native cut. */
  onCompactionPreparing?: (checkpoint: RuntimeDurableCompactionCheckpoint) => Promise<void>;
  /** Request-owned recorder. Awaited; composed with the runtime host recorder. */
  onCompactionRecorded?: ((record: CompactionRecordedPayload) => void) | ((record: CompactionRecordedPayload) => Promise<void>);
  /**
   * Stable profile exposure, not execution authority.
   */
  toolExposure?: {
    persistentSubagents?: boolean;
    askParent?: boolean;
  };
  /**
   * Current non-authorizing host facts.
   */
  hostCapabilities?: Record<string, {
    available: boolean;
    reason?: string;
    limits?: Record<string, number | null>;
  }>;
  askParentController?: {
    submit(question: {
      question: string;
      options?: string[];
    }): Promise<void>;
  };
  /**
   * The options object a host passes to `createRuntime(host).run(systemPrompt, options)`.
   */
  finishSilentlyController?: {
    eligible(): boolean;
  };
  /**
   * Resolved model reference; see parseRuntimeModelReference.
   */
  model: RuntimeModelRef;
  /**
   * Host conversation/session key for resumable bridges.
   */
  sessionId?: string;
  /**
   * Provider-owned resume id for resumable bridges.
   */
  providerSessionId?: string;
  /**
   * Host-owned provider attribution continuity key; does not authorize transcript resume.
   */
  providerAttributionSessionId?: string;
  /**
   * Host-owned durable recovery opt-in.
   */
  sessionRecovery?: {
    runId: string;
    revision: number;
  } | undefined;
  /**
   * Protected lazy host replay prefix; never returned or included in telemetry.
   */
  detachedContext?: () => Promise<ReadonlyArray<any>>;
  /**
   * Protected awaited host claim before stateless replay.
   */
  onSessionTurnDetached?: (attempt: {
    descriptor: any;
    model: RuntimeModelRef;
    attemptIndex: number;
    retryIndex: number;
    result: RuntimeResult;
  }) => Promise<void>;
  /**
   * Protected host-owned native ownership/turn binding; no recovery authority.
   */
  sessionTurn?: import("./session.js").RuntimeSessionTurnDescriptor | undefined;
  /**
   * Keep resumable provider state alive after the turn.
   */
  sessionKeepAlive?: boolean;
  /**
   * Internal promptless Pi compaction mode; never sent to fallback routes.
   */
  manualCompaction?: boolean;
  /**
   * Idle TTL for resumable provider state.
   */
  sessionIdleTimeoutMs?: number;
  /**
   * Stream of in-flight user messages for steering an active run. Native acceptance, exact transcript consumption, and uncertain delivery are distinct synchronous callbacks; thenables are never awaited as settlement confirmation. An optional opaque logicalOwner object proves that a later same-id value is a fresh callback lease for the first logical owner, not an independent duplicate.
   */
  liveInput?: AsyncIterable<import("./live-input.js").RuntimeLiveInputMessage>;
  /**
   * Per-call observers (see telemetry/observer.ts) merged with host-level (createRuntime) observers.
   */
  observers?: ReadonlyArray<any>;
  onEvent?: (event: RuntimeEvent) => void;
  /**
   * Optional Anthropic Messages retention; omitted preserves Pi defaults/environment.
   */
  cacheRetention?: "short" | "long";
  /**
   * Emit metadata-only prompt-cache request fingerprints.
   */
  promptCacheDiagnostics?: boolean;
  /**
   * Awaited host-owned incremental lifecycle persistence boundary.
   */
  toolLifecycleSink?: RuntimeToolLifecycleSink;
  messages?: ReadonlyArray<any>;
  effort?: string;
  cwd?: string;
  mcpServers?: {
    [x: string]: any;
  };
  /**
   * Skills disclosed to this run, as `{name, description}`. Non-empty makes `supports_skills` a routing requirement (see router.js), so a chain entry that lacks it is skipped.
   */
  skills?: ReadonlyArray<{
    name: string;
    description?: string;
  }>;
  /**
   * Directory holding `<name>/SKILL.md`. Required alongside `skills` for `ReadSkill` to be built.
   */
  skillsRoot?: string;
  allowedTools?: ReadonlyArray<string>;
  disallowedTools?: ReadonlyArray<string>;
  maxTurns?: number;
  /**
   * Internal provider-check output cap; ordinary callers must omit it.
   */
  providerCheckMaxTokens?: number;
  /**
   * Internal provider-check effective auth context; ordinary callers must omit it.
   */
  providerCheckAuthContext?: {
    env(name: string): Promise<string | undefined>;
    fileExists(path: string): Promise<boolean>;
  };
  outputSchema?: any;
  runArtifactDir?: string;
  abortSignal?: AbortSignal;
  /**
   * Host-owned synchronous artifact writer bound to this run.
   */
  persistArtifact?: (artifact: {
    filename: string;
    buffer: Buffer;
    toolName: string;
    toolUseId: (string | null);
  }) => (string | null);
  /**
   * Host-only environment for Bash, Exec, and nested subagents in this run.
   */
  toolEnvironment?: {
    schema: 1;
    values: Readonly<Record<string, string>>;
    pathPrepend?: readonly string[];
  };
  /**
   * Per-run sandbox policy; merged monotonically with the host policy (see resolveSandboxPolicy, tools/shared/tool-context.js).
   */
  sandboxPolicy?: import("../agent/sandbox-seam.js").SandboxPolicy;
  /**
   * Per-run concrete sandbox engine handed to the active sandbox implementation.
   */
  sandboxEngine?: import("../agent/sandbox-seam.js").RuntimeSandboxEngine;
  /**
   * Per-run sandbox IMPLEMENTATION override; when set it enforces this run's tools instead of the host/ToolContext impl (precedence run > host > passthrough). Policy DATA still merges monotonically (I13); this overrides only the enforcing code.
   */
  sandbox?: import("../agent/sandbox-seam.js").RuntimeSandbox;
  /**
   * Typed per-run tool-output limits.
   */
  toolLimits?: RuntimeToolLimits;
  /**
   * Exact `server:tool`
   * names whose host-owned lifecycle has no total deadline. Inactivity and abort still apply.
   */
  mcpCallNoTotalTimeoutTools?: readonly string[];
  /**
   * Typed per-run compaction policy.
   */
  compaction?: RuntimeCompactionPolicy;
  /**
   * Per-run prompt-fragment overrides (run wins over the host default).
   */
  prompts?: RuntimePromptOverrides;
  /**
   * Host-owned shared web admission and quota state.
   */
  webRequestCoordinator?: any;
  /**
   * Run-scoped WebSearch backend configuration.
   */
  webSearchConfig?: {
    backend?: string | readonly string[];
    maxRequestsPerRun?: number;
    endpoint?: string;
    searxng?: {
      endpoint?: string;
    };
    ollama?: {
      baseUrl?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      trustPublicUrl?: boolean;
    };
    codex?: {
      model?: string;
    };
    parallel?: {
      apiKeyEnv?: string;
    };
  };
  /**
   * Private request budget and provider deferral state for one logical run.
   */
  webSearchState?: any;
  /**
   * Run-scoped WebFetch extraction/render configuration.
   */
  webFetchConfig?: {
    provider?: "local" | "parallel" | readonly ("local" | "parallel")[];
    parallel?: {
      apiKeyEnv?: string;
    };
    render?: "never" | "auto";
    browserCommand?: string;
  };
  /**
   * Pi built-in tool scheduling mode. Safe parallelism is the default.
   */
  piToolExecutionMode?: "sequential" | "safe-parallel";
  /**
   * In-process `Agent` built-in: profiles, caps, and the nested-run callback.
   */
  subagents?: RuntimeSubagentsOptions;
  /**
   * Host-bound awaited command ownership; no child background capability.
   */
  ownedForegroundProcesses?: import("./process.js").OwnedForegroundProcesses;
  /**
   * Pi-native-only structural process-job controller. When absent, Exec/Bash schemas and foreground behavior are unchanged.
   */
  processJobs?: import("./process.js").ProcessJobsController;
  /**
   * Host-owned request lineage diagnostics, including when the controller is unavailable.
   */
  processJobsAvailability?: {
    chainDepth: number;
    maxChainDepth: number;
    remainingStarts: number;
    unavailableReason?: string;
  };
  /**
   * Set by createRouterRuntime (runtime/router.js) with a `resume_snapshot` when
   * failing over mid-chain; a host-level coordinator may relay it forward (see agent/transcript.js), not read by any
   * bridge in this package today.
   */
  diagnosticsSeed?: any;
  /**
   * Set by createRouterRuntime alongside diagnosticsSeed; the router also
   * prepends the same text to the systemPrompt argument directly, so bridges that ignore this field still continue
   * correctly.
   */
  systemPromptPrefix?: string;
};

/**
 * The request shape a bridge's `execute(systemPrompt, req)` receives as its
 * second (options) argument: the host-supplied RuntimeRunOptions, merged by
 * createRuntime (runtime/create-runtime.ts) with the bound HOST_KEYS host-integration
 * callbacks, the resolved runtimeBrand, the per-instance toolContext (read by
 * internal tool helpers; absent when a host drives a bridge directly without
 * createRuntime), and the per-run observerHub (onEvent is overridden to the
 * hub's emit). `systemPrompt` is passed positionally, not folded into this object.
 */
export type RuntimeRequest = RuntimeRunOptions & Pick<TurnHostOptions, "resolveCustomPricing" | "resolvePiApiKey" | "onToolApprovalRequest" | "toolRiskTiers" | "approvalDefaultRiskTier" | "approvalTimeoutMs" | "approvalAlwaysAllowTools"> & {
  /** Internal positive host recorder capability; not a config or model option. */
  continuityRecording?: true;
  runtimeBrand: import("../runtime-brand.js").RuntimeBrand;
  toolContext?: import("../tools/shared/tool-context.js").ToolContext;
  observerHub: {
    emit: (event: RuntimeEvent) => void;
    flush: () => Promise<void>;
  };
};

/**
 * One named subagent profile the `Agent` built-in can deploy.
 */
export type RuntimeSubagentDefinition = {
  /**
   * Model-visible identifier and the tool's `name` enum value.
   */
  name: string;
  /**
   * Model-visible: when to pick this profile.
   */
  description: string;
  /**
   * Full system prompt for the child run.
   */
  systemPrompt: string;
  /**
   * Absent inherits the parent's effective route.
   */
  model?: RuntimeModelRef;
  effort?: string;
  /**
   * Absent uses the safe read-only default set.
   */
  allowedTools?: ReadonlyArray<string>;
  disallowedTools?: ReadonlyArray<string>;
  mcpServers?: {
    [x: string]: any;
  };
  /**
   * Retained selections, resolved against current host policy.
   */
  mcpServerNames?: ReadonlyArray<string>;
  maxTurns?: number;
  timeoutMs?: number;
};

/**
 * Instance routing is host-owned; the child receives only its own durable transcript.
 */
export type RuntimeSubagentRunRequest = {
  [x: string]: any;
} & {
  detached?: true;
  deadlineAt?: number;
  instance?: {
    id: string;
    sessionId: string;
    sessionsRoot: string;
  };
};

/**
 * Owning-layer callback that actually executes one child turn. The kernel
 * supplies a self-run fallback so `createRuntime` works without host wiring;
 * app replaces it so subagent runs get the configured fallback chain,
 * same-model retries, and run recording.
 */
export type RuntimeSubagentRun = (request: RuntimeSubagentRunRequest) => Promise<RuntimeResult>;

/**
 * Policy for the runtime-owned general-purpose helper and subagents the model
 * authors at call time rather than picking from `definitions`. Absent
 * suppresses authoring entirely and leaves general-purpose on its safe default.
 */
export type RuntimeInlineSubagentsOptions = {
  /**
   * Only `false` turns authoring off.
   */
  enabled?: boolean;
  /**
   * Ceiling on general-purpose's
   * read-only tools and what an authored subagent may request. Configured
   * definitions keep their explicit contracts. Absent means the safe read-only
   * default set, never every built-in.
   */
  allowedTools?: ReadonlyArray<string>;
};

export type RuntimeSubagentInstance = {
  incarnation?: string;
  activeTurn?: {
    token: string;
    kind: "foreground" | "detached";
    settlementPending: true;
  };
  id: string;
  conversationId: string;
  name: string;
  systemPrompt: string;
  definition: RuntimeSubagentDefinition;
  sessionId: string;
  sessionsRoot: string;
  settledTurnToken?: string;
  lastStatus?: string;
  recovery?: object & { certifiedTimeout?: unknown; reason?: unknown };
  recoveryBlocked?: boolean;
  status: string;
  pendingQuestion?: {
    question: string;
    options?: string[];
  };
  reservation?: {
    token: string;
  };
  turns: number;
  createdAt: number;
  updatedAt: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number | null;
    knownCostUsd?: number;
  };
};

export type RuntimeSubagentRecoveryRequest = {
  ack: string;
  message: string;
  background?: boolean;
  close?: boolean;
  description?: string;
};

/**
 * A new route for the turn being admitted. The host persists it on the stored
 * definition, so later continuations inherit it.
 */
export type RuntimeSubagentRoute = {
  model?: RuntimeModelRef;
  effort?: string;
};

/**
 * Host-owned, conversation-scoped persistent instance facade. No filesystem implementation belongs in the kernel.
 */
export type RuntimeSubagentInstances = {
  list: () => Promise<RuntimeSubagentInstance[]>;
  get: (id: string) => Promise<RuntimeSubagentInstance | undefined>;
  create: (spec: {
    id?: string;
    name: string;
    systemPrompt: string;
    definition: RuntimeSubagentDefinition;
    verification?: {
      workdir: string;
      reportPath?: string;
    };
  }, access?: unknown) => Promise<RuntimeSubagentInstance>;
  fence?: (id: string, outcome: {
    status: "timeout" | "cancelled";
  }, turnToken?: string) => Promise<void>;
  markAwaiting: (id: string, question: {
    question: string;
    options?: string[];
  }) => Promise<RuntimeSubagentInstance>;
  inspect?: (id: string, access?: unknown) => Promise<unknown>;
  checkAcknowledgement?: (id: string, acknowledgement: RuntimeSubagentRecoveryRequest, access?: unknown) => Promise<void>;
  reserve?: (id: string, token: string, acknowledgement?: RuntimeSubagentRecoveryRequest, access?: unknown, route?: RuntimeSubagentRoute, createdForAdmission?: boolean) => Promise<RuntimeSubagentInstance>;
  releaseReservation?: (id: string, token: string) => Promise<void>;
  begin: (id: string, token?: string, acknowledgement?: RuntimeSubagentRecoveryRequest, access?: unknown, route?: RuntimeSubagentRoute) => Promise<RuntimeSubagentInstance>;
  finish: (id: string, outcome: {
    status: string;
    failureKind?: "session_continuity_lost";
    question?: {
      question: string;
      options?: string[];
    };
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      costUsd?: number | null;
  knownCostUsd?: number;
    };
    answerHead?: string;
  }, token?: string) => Promise<RuntimeSubagentInstance>;
  close: (id: string, access?: unknown) => Promise<RuntimeSubagentInstance>;
};

export type RuntimeSubagentsOptions = {
  /**
   * Named profiles.
   */
  definitions?: ReadonlyArray<RuntimeSubagentDefinition>;
  /**
   * Call-time model choices. Absent means no model parameter.
   */
  models?: ReadonlyArray<{
    name: string;
    model: RuntimeModelRef;
    key: string;
  }>;
  backgroundSubagentController?: {
    managed?: boolean;
    stop?(identity: {
      instanceId: string;
      instanceIncarnation: string;
      turnToken: string;
    }): Promise<{
      jobId: string;
      stopRequested: boolean;
      childStillBusy: boolean;
      resumable: boolean;
      disposition: string | null;
    }>;
    steer?(identity: {
      instanceId: string;
      instanceIncarnation: string;
      turnToken: string;
    }, text: string): Promise<{
      jobId: string;
      delivery: "consumed" | "offered" | "rejected" | "unsupported";
      reason?: string;
    }>;
    startInternal(request: {
      managed?: {
        instanceIncarnation: string;
        turnToken: string;
      };
      kind: "internal";
      tool: "Agent" | "AgentManage";
      jobId: string;
      instanceId: string;
      description?: string;
      /**
       * Default per-subagent wall clock.
       */
      timeoutMs: number;
      cleanup(): Promise<void>;
      /**
       * Nested-run callback; absent uses the kernel self-run.
       */
      run(signal: AbortSignal, writeOutput: (text: string) => void, reportProgress: (event: any) => void, execution?: {
        deadlineAt: number;
        managed?: any;
      }): Promise<{
        answer?: string;
        output: string;
        status: string;
        childStillBusy?: boolean;
        question?: {
          question: string;
          options?: string[];
        };
      }>;
    }): Promise<{
      jobId: string;
      state: "queued" | "starting" | "running";
      startedAt: string | null;
      queuePosition?: number;
      queueDeadlineAt?: string;
    }>;
  };
  /**
   * Conversation-scoped persistence; absent preserves stateless Agent.
   */
  instances?: RuntimeSubagentInstances;
  /**
   * Call-time authoring policy.
   */
  inline?: RuntimeInlineSubagentsOptions;
  /**
   * In-flight subagents per parent turn. Default 5.
   */
  maxConcurrent?: number;
  /**
   * Total Agent calls per parent turn. Default 20.
   */
  maxPerTurn?: number;
  /**
   * Default per-subagent turn cap. Default 100.
   */
  maxTurns?: number;
  /**
   * Default per-subagent wall clock.
   */
  timeoutMs?: number;
  /**
   * Nested-run callback; absent uses the kernel self-run.
   */
  run?: RuntimeSubagentRun;
  /**
   * Kernel-owned. Absent/0 is the parent; >=1 suppresses the `Agent` tool.
   */
  depth?: number;
};

/**
 * Monotonic Pi dispatch evidence, armed only after replay seeding.
 */
export type RuntimeDispatchProgress = {
  version: 1;
  armed: boolean;
  toolAdmitted: boolean;
  liveInputTaken: boolean;
};

export type RuntimeResult = {
  /**
   * Absence/malformed evidence never certifies no progress.
   */
  dispatchProgress?: RuntimeDispatchProgress;
  /**
   * App-owned detached settlement evidence.
   */
  subagentContinuity?: {
    turnToken: string;
    state: "retained" | "unknown" | "lost";
  };
  subagentQuestion?: {
    question: string;
    options?: string[];
  };
  text?: string | null;
  /**
   * Host-certified silent completion, when applicable.
   */
  turnDisposition?: "silent" | "visible";
  structuredResult?: any;
  structuredResultSource?: string | null;
  events?: Array<RuntimeEvent>;
  usage?: any;
  durationMs?: number;
  numTurns?: number;
  model?: string;
  effort?: string;
  /**
   * Provider-effective reasoning/thinking level when reported.
   */
  effectiveEffort?: string;
  sdk?: RuntimeSdkId;
  cancelled?: boolean;
  error?: string | null;
  errorDetails?: any | null;
  failureKind?: string | null | undefined;
  /**
   * Explicit terminal safety rejection overrides route retryability.
   */
  retryable?: boolean;
  providerSessionRecovery?: {
    runId: string;
    revision: number;
    providerSessionId: string;
    modelKey: string;
    tipId: string;
  };
  providerSessionId?: string | null;
  /**
   * Bounded stderr tail from a CLI-backed bridge; see createStderrTail (telemetry/failure.js).
   */
  stderrTail?: string | null;
  runtimeWarnings?: Array<any>;
  diagnostics?: any;
  capabilitiesUsed?: any;
  /**
   * Set by createRouterRuntime (runtime/router.js) on every failed/skipped attempt.
   */
  failoverHistory?: Array<{
    model: RuntimeModelRef;
    failureKind: (string | null);
    requestId?: (string | null);
    retryableSubkind?: (string | null);
    retryIndex?: number;
    requirements?: any;
  }>;
};

/**
 * Capability flags a bridge reports for a given model reference. Structural,
 * not sealed: bridges may report extra provider-specific flags (e.g.
 * supports_fast_mode) alongside the common ones from COMMON_CAPABILITIES
 * (runtime/capabilities.js).
 */
export type RuntimeCapabilities = {
  kind?: string;
  runtime?: string;
  streaming?: boolean;
  structured_output?: boolean;
  supports_session_resume?: boolean;
  native_runtime_config?: any;
  supports_mcp?: boolean;
  supports_skills?: boolean;
  supports_builtin_tools?: boolean;
  supports_live_input?: boolean;
  /**
   * Whether the bridge exposes provider-native subagent surfaces and
   * normalized activity. In-process delegation is the `Agent` tool, configured by the host.
   */
  supports_native_subagents?: boolean;
  supports_request_tool_environment?: boolean;
  supports_fast_mode?: boolean;
  /**
   * Whether the bridge can
   * project named allow/deny policies or accepts only a semantically unrestricted
   * policy. Built-in bridges always report this field; omission means unknown
   * for custom structural capability objects.
   */
  tool_policy?: "projected" | "allow_all_only";
};

/**
 * A fully loaded bridge (registry.js's resolveEngineTurnAdapter result): the
 * executable provider implementation. Unlike RuntimeBridgeDescriptor,
 * `capabilities` here is the bridge module's own static value (computed once
 * at module load, e.g. `runtimeCapabilities()`), not a callable.
 * @coreScanRetained
 */
export type RuntimeBridge = {
  id: RuntimeBridgeId;
  supports: (ref: RuntimeModelRef, options?: any) => boolean;
  capabilities: RuntimeCapabilities;
  execute: (systemPrompt: string, req: RuntimeRequest) => Promise<RuntimeResult>;
};

/**
 * The introspection-only projection of a RuntimeBridge (registry.js's
 * listRuntimeBridges result): id/supports/capabilities without execute, so
 * hosts can describe backend support without loading provider modules.
 * @coreScanRetained
 */
export type RuntimeBridgeDescriptor = {
  id: RuntimeBridgeId;
  supports: (ref: RuntimeModelRef, options?: any) => boolean;
  capabilities: (ref?: RuntimeModelRef) => RuntimeCapabilities;
};

/**
 * Payload passed to a host's `onToolApprovalRequest` callback (agent/approval.js).
 */
export type ApprovalRequestPayload = {
  requestId: string;
  toolName: string;
  toolUseId: string | null;
  /**
   * Secret-redacted, length-capped JSON summary of the tool call arguments.
   */
  argumentsSummary: string;
  riskTier: "low" | "medium" | "high";
  model: string | null;
};

/**
 * A host's response to an ApprovalRequestPayload.
 */
export type ApprovalDecision = {
  decision: "approve" | "deny" | "always";
  reason?: string;
};

/**
 * Payload passed to a host's `onCompactionRecorded` callback (execution/pi/run.js)
 * after a successful context compaction, so the host can persist the row.
 */
export type CompactionRecordedPayload = {
  checkpoint?: RuntimeDurableCompactionCheckpoint;
  task_run_id: string | null;
  trigger: string;
  provider_kind: string;
  model: string | null;
  tokens_before: number | null;
  summary: string;
  first_kept_entry_id: string | null;
  status: "succeeded";
  created_at: number;
};

/**
 * The `host` object passed to `createRuntime(host)` / `createRouterRuntime({host, chain})`.
 * Combines the tool-context keys (bound per runtime instance) and the
 * host-integration callbacks (bound once, applied to every run via hostDefaults).
 */
export type TurnHostOptions = {
  workspace?: string;
  repoRoot?: string;
  additionalReadRoots?: ReadonlyArray<string>;
  additionalWriteRoots?: ReadonlyArray<string>;
  ripgrepPath?: string;
  qaOutputDir?: string;
  sandboxPolicy?: import("../agent/sandbox-seam.js").SandboxPolicy;
  sandboxEngine?: import("../agent/sandbox-seam.js").RuntimeSandboxEngine;
  /**
   * Sandbox seam implementation (see agent/sandbox-seam.js); defaults to the zero-dependency passthroughSandbox. Real hosts inject host integration's implementation from packages/turn/src/host/sandbox/index.ts.
   */
  sandbox?: import("../agent/sandbox-seam.js").RuntimeSandbox;
  /**
   * Host-level prompt-fragment override defaults; a per-run `options.prompts` field wins over these (see resolvePrompts, runtime/create-runtime.ts).
   */
  prompts?: RuntimePromptOverrides;
  /**
   * Observer instances (see telemetry/observer.ts); loose because telemetry/observer.ts is not a kernel seam file.
   */
  observers?: ReadonlyArray<any>;
  /**
   * See resolveRuntimeBrand (runtime-brand.ts); accepts a partial RuntimeBrand.
   */
  runtimeBrand?: any;
  /**
   * See resolvePricing (telemetry/cost.js).
   */
  resolveCustomPricing?: (parsed: {
    provider: string;
    model: string;
  }) => (import("../telemetry/cost.js").NormalizedPricing | null);
  /**
   * See createPiOAuthApiKeyResolver (providers/pi/auth.js) for a ready-made implementation.
   */
  resolvePiApiKey?: import("../providers/pi/auth.js").PiApiKeyResolver;
  persistArtifact?: (artifact: {
    filename: string;
    buffer: Buffer;
    toolName: string;
    toolUseId: (string | null);
  }) => (string | null);
  onCompactionRecorded?: ((record: CompactionRecordedPayload) => void) | ((record: CompactionRecordedPayload) => Promise<void>);
  onToolApprovalRequest?: (payload: ApprovalRequestPayload) => Promise<ApprovalDecision>;
  toolRiskTiers?: {
    [x: string]: "low" | "medium" | "high";
  };
  approvalDefaultRiskTier?: "low" | "medium" | "high";
  approvalTimeoutMs?: number;
  approvalAlwaysAllowTools?: ReadonlyArray<string>;
};

/**
 * The subset of TurnHostOptions accepted by `runtime.configureTools(next)`
 * (createRuntime's TOOL_RUNTIME_KEYS pick).
 */
export type TurnToolOptions = {
  workspace?: string;
  repoRoot?: string;
  additionalReadRoots?: ReadonlyArray<string>;
  additionalWriteRoots?: ReadonlyArray<string>;
  ripgrepPath?: string;
  qaOutputDir?: string;
  sandboxPolicy?: import("../agent/sandbox-seam.js").SandboxPolicy;
  sandboxEngine?: import("../agent/sandbox-seam.js").RuntimeSandboxEngine;
  sandbox?: import("../agent/sandbox-seam.js").RuntimeSandbox;
};

export type NativeDispatchSnapshot = {
  /**
   * Effective real-compaction output policy, captured after request extensions.
   */
  compactionSummaryMaxTokens?: number;
  model: {
    provider: string;
    id: string;
    api: string;
    contextWindow: number;
    maxTokens: number;
  };
  provenance: {
    provider: string;
    api: string;
    model: string;
    account: string | null;
  };
  /**
   * Actual augmented instructions.
   */
  systemPrompt: string;
  /**
   * Actual selected built-in/MCP/StructuredOutput declarations.
   */
  tools: ReadonlyArray<{
    name: string;
    description: string;
    parameters: Record<string, any>;
  }>;
  /**
   * Frozen request including current decorated input.
   */
  messages: ReadonlyArray<any>;
};

export type NativeDispatchBinding = {
  sessionId?: string;
  providerSessionId?: string;
  providerAttributionSessionId?: string;
  sessionKeepAlive?: boolean;
  sessionIdleTimeoutMs?: number;
  sessionTurn?: RuntimeRunOptions["sessionTurn"];
  sessionRecovery?: RuntimeRunOptions["sessionRecovery"];
  nativeSessionAuthority?: any;
  nativeSessionProjection?: any;
};

/**
 * Public core handoff input keeps its open-record compatibility view; host
 * storage retains the richer readonly, unknown-data contract in native-storage.
 */
export type NativeHandoffProducerRequest = {
  prepared: {
    status: import("./native-storage.js").RuntimePreparedHandoff["status"];
  } & Record<"checkpoints" | "ledger" | "recent" | "older" | "coverage", ReadonlyArray<Record<string, any>>> & Partial<Omit<import("./native-storage.js").RuntimePreparedHandoff, "status" | "checkpoints" | "ledger" | "recent" | "older" | "coverage">>;
  outputReserve: import("./native-storage.js").RuntimeHandoffProducerRequest["outputReserve"];
};

export type { RuntimeHandoffSummary as NativeHandoffSummary } from "./native-storage.js";

export type NativeHandoffResultView<T> = { -readonly [K in keyof T]: K extends "usage" ? any : T[K]; };

export type NativeHandoffProducerResult = NativeHandoffResultView<import("./native-storage.js").RuntimeHandoffProducerResult>;

export type NativePreparedDispatch = {
  /**
   * Check availability before host P2 admission, without consuming the lease.
   */
  assertReady?: () => void;
  /**
   * Deep-frozen nonsecret dispatch metadata.
   */
  snapshot: NativeDispatchSnapshot;
  /**
   * Pure preflight; no billing or native mutation.
   */
  checkHandoffSummary?: (input: NativeHandoffProducerRequest) => {
    status: "ready";
  } | {
    status: "budget_failure";
    reason: string;
  };
  /**
   * One ordinary-auth no-tools call per lease; host owns durable admission.
   */
  produceHandoffSummary?: (input: NativeHandoffProducerRequest) => Promise<NativeHandoffProducerResult>;
  /**
   * Single use; no router replay/failover, tools are not rebuilt.
   */
  run: (binding?: NativeDispatchBinding) => Promise<RuntimeResult>;
  /**
   * Idempotent; while running waits for its normal cleanup. Host owns concurrency/abort.
   */
  close: () => Promise<void>;
};

/**
 * The object `createRuntime`/`createRouterRuntime` return.
 * @coreScanRetained
 */
export type AgentRuntimeInstance = {
  run: (systemPrompt: string, options: RuntimeRunOptions) => Promise<RuntimeResult>;
  configureTools: (next?: TurnToolOptions) => void;
  prepareNativeDispatch?: (systemPrompt: string, options: RuntimeRunOptions) => Promise<NativePreparedDispatch>;
  /**
   * Explicit native evidence ownership capability.
   */
  sessionTurnReconciliation?: "v1" | undefined;
  /**
   * Storage-only protected native reconciliation.
   */
  reconcileSessionTurn: (request: {
    sessionsRoot: string;
    descriptor: any;
    purpose: "execution" | "compaction";
    expectedModel: {
      provider: string;
      id: string;
      api?: string;
    };
    expectedInputs: ReadonlyArray<{
      id: string;
      requestDigest: string;
      placement: "initial" | "live";
    }>;
    expectedBaseTip?: string | null;
  }) => Promise<any>;
  recoverSession: (receipt: NonNullable<RuntimeResult["providerSessionRecovery"]>, context: {
    appliedInputIds: readonly string[];
  }) => Promise<boolean>;
  syncSession: (providerSessionId: string) => Promise<boolean>;
  /**
   * Guarantees the id has no reusable process-local handle; rejects on failure.
   */
  refreshSession: (providerSessionId: string) => Promise<void>;
  /**
   * Read-only best-effort snapshot of a durable session transcript.
   */
  salvageDurableSession?: (providerSessionId: string, sessionsRoot: string) => ReturnType<typeof import("../engine/session-salvage.js").salvageDurableNativeSession>;
  /**
   * Deletes every currently materialized durable transcript with the exact id; callers retry after an active retired run settles to reclaim any late same-name append. Absence is success.
   */
  retireDurableSession: (providerSessionId: string, sessionsRoot: string, deletion?: {
    hostAuthority: {
      version: 1;
      rootId: string;
      authorityId: string;
      ownerKey: string;
      historyBucket: string;
    };
    disposition: "C" | "D";
    assertOwned: () => Promise<void>;
  }) => Promise<void>;
  disposeSession: (providerSessionId: string) => Promise<boolean>;
  invalidateSession: (providerSessionId: string) => Promise<boolean>;
  disposeAllSessions: () => Promise<void>;
};

/**
 * Host-attempt telemetry is intentionally opaque; it must not weaken the public
 * createRuntime result, whose events and warnings retain their array contracts.
 */
export type RuntimeAttemptResult = Omit<RuntimeResult, "events" | "runtimeWarnings" | "sdk"> & {
  events?: ReadonlyArray<import("./events.js").RuntimeEventLike>;
  runtimeWarnings?: unknown;
  sdk?: string;
};

export type RuntimeAttemptRunOptions = Omit<RuntimeRunOptions, "onSessionTurnDetached"> & {
  onSessionTurnDetached?: (attempt: {
    descriptor: any;
    model: RuntimeModelRef;
    attemptIndex: number;
    retryIndex: number;
    result: RuntimeAttemptResult;
  }) => Promise<void>;
};

export type RuntimeAttemptPreparedDispatch = Omit<NativePreparedDispatch, "run" | "checkHandoffSummary" | "produceHandoffSummary"> & {
  run(binding?: NativeDispatchBinding): Promise<RuntimeAttemptResult>;
  checkHandoffSummary?(input: import("./native-storage.js").RuntimeHandoffProducerRequest): import("./native-storage.js").RuntimeHandoffFit;
  produceHandoffSummary?(input: import("./native-storage.js").RuntimeHandoffProducerRequest): Promise<import("./native-storage.js").RuntimeHandoffProducerResult>;
};

/**
 * Structural attempt runtime, distinct from the concrete factory's complete
 * lifecycle API. The router checks optional preparation/tool projection at use.
 * Method signatures preserve structural host projections with stricter inputs.
 */
export type RuntimeAttempt = {
  run(systemPrompt: string, options: RuntimeAttemptRunOptions): Promise<RuntimeAttemptResult>;
  configureTools?(next?: TurnToolOptions): void;
  prepareNativeDispatch?(systemPrompt: string, options: RuntimeAttemptRunOptions): Promise<RuntimeAttemptPreparedDispatch>;
};
