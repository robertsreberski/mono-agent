/** @typedef {import("./policy.js").RuntimeToolLimits} RuntimeToolLimits */
/** @typedef {import("./policy.js").RuntimeCompactionPolicy} RuntimeCompactionPolicy */
/** @typedef {import("./policy.js").RuntimePromptOverrides} RuntimePromptOverrides */
// Shared turn contracts, authored as JSDoc; no runtime implementation imports.

/** @typedef {import("./model.js").RuntimeSdkId} RuntimeSdkId */
/** @typedef {import("./model.js").RuntimeBridgeId} RuntimeBridgeId */
/** @typedef {import("./model.js").RuntimeModelRef} RuntimeModelRef */
/** @typedef {import("./events.js").RuntimeEvent} RuntimeEvent */
/** @typedef {import("./events.js").RuntimeToolLifecycleSink} RuntimeToolLifecycleSink */
/** @typedef {import("./events.js").RuntimeObserver} RuntimeObserver */







/**
 * @typedef {Object} RuntimeRunOptions
 * @property {{persistentSubagents?: boolean, askParent?: boolean}} [toolExposure] Stable profile exposure, not execution authority.
 * @property {Record<string, {available: boolean, reason?: string, limits?: Record<string, number|null>}>} [hostCapabilities] Current non-authorizing host facts.
 * @property {{submit(question: {question: string, options?: string[]}): Promise<void>}} [askParentController]
 * @property {{eligible(): boolean}} [finishSilentlyController]
 * The options object a host passes to `createRuntime(host).run(systemPrompt, options)`.
 * @property {RuntimeModelRef} model                     Resolved model reference; see parseRuntimeModelReference.
 * @property {string} [sessionId]                         Host conversation/session key for resumable bridges.
 * @property {string} [providerSessionId]                 Provider-owned resume id for resumable bridges.
 * @property {string} [providerAttributionSessionId]      Host-owned provider attribution continuity key; does not authorize transcript resume.
 * @property {{runId: string, revision: number}|undefined} [sessionRecovery] Host-owned durable recovery opt-in.
 * @property {() => Promise<ReadonlyArray<Object>>} [detachedContext] Protected lazy host replay prefix; never returned or included in telemetry.
 * @property {(attempt: {descriptor: any, model: RuntimeModelRef, attemptIndex: number, retryIndex: number, result: RuntimeResult}) => Promise<void>} [onSessionTurnDetached] Protected awaited host claim before stateless replay.
 * @property {import("./session.js").RuntimeSessionTurnDescriptor|undefined} [sessionTurn] Protected host-owned native ownership/turn binding; no recovery authority.
 * @property {boolean} [sessionKeepAlive]                 Keep resumable provider state alive after the turn.
 * @property {boolean} [manualCompaction] Internal promptless Pi compaction mode; never sent to fallback routes.
 * @property {number} [sessionIdleTimeoutMs]              Idle TTL for resumable provider state.
 * @property {AsyncIterable<import("./live-input.js").RuntimeLiveInputMessage>} [liveInput] Stream of in-flight user messages for steering an active run. Native acceptance, exact transcript consumption, and uncertain delivery are distinct synchronous callbacks; thenables are never awaited as settlement confirmation. An optional opaque logicalOwner object proves that a later same-id value is a fresh callback lease for the first logical owner, not an independent duplicate.
 * @property {ReadonlyArray<*>} [observers]               Per-call observers (see RuntimeObserver) merged with host-level (createRuntime) observers.
 * @property {(event: RuntimeEvent) => void} [onEvent]
 * @property {"short"|"long"} [cacheRetention] Optional Anthropic Messages retention; omitted preserves Pi defaults/environment.
 * @property {boolean} [promptCacheDiagnostics] Emit metadata-only prompt-cache request fingerprints.
 * @property {RuntimeToolLifecycleSink} [toolLifecycleSink] Awaited host-owned incremental lifecycle persistence boundary.
 * @property {ReadonlyArray<Object>} [messages]
 * @property {string} [effort]
 * @property {string} [cwd]
 * @property {Object<string, Object>} [mcpServers]
 * @property {ReadonlyArray<{name: string, description?: string}>} [skills] Skills disclosed to this run, as `{name, description}`. Non-empty makes `supports_skills` a routing requirement (see router.js), so a chain entry that lacks it is skipped.
 * @property {string} [skillsRoot]                       Directory holding `<name>/SKILL.md`. Required alongside `skills` for `ReadSkill` to be built.
 * @property {ReadonlyArray<string>} [allowedTools]
 * @property {ReadonlyArray<string>} [disallowedTools]
 * @property {number} [maxTurns]
 * @property {number} [providerCheckMaxTokens] Internal provider-check output cap; ordinary callers must omit it.
 * @property {{env(name: string): Promise<string|undefined>, fileExists(path: string): Promise<boolean>}} [providerCheckAuthContext] Internal provider-check effective auth context; ordinary callers must omit it.
 * @property {Object} [outputSchema]
 * @property {string} [runArtifactDir]
 * @property {AbortSignal} [abortSignal]
 * @property {(artifact: {filename: string, buffer: Buffer, toolName: string, toolUseId: (string|null)}) => (string|null)} [persistArtifact] Host-owned synchronous artifact writer bound to this run.
 * @property {{schema: 1, values: Readonly<Record<string, string>>, pathPrepend?: readonly string[]}} [toolEnvironment] Host-only environment for Bash, Exec, and nested subagents in this run.
 * @property {import("../agent/sandbox-seam.js").SandboxPolicy} [sandboxPolicy] Per-run sandbox policy; merged monotonically with the host policy (see resolveSandboxPolicy, agent/tools/shared/tool-context.js).
 * @property {import("../agent/sandbox-seam.js").RuntimeSandboxEngine} [sandboxEngine] Per-run concrete sandbox engine handed to the active sandbox implementation.
 * @property {import("../agent/sandbox-seam.js").RuntimeSandbox} [sandbox] Per-run sandbox IMPLEMENTATION override; when set it enforces this run's tools instead of the host/ToolContext impl (precedence run > host > passthrough). Policy DATA still merges monotonically (I13); this overrides only the enforcing code.
 * @property {RuntimeToolLimits} [toolLimits] Typed per-run tool-output limits.
 * @property {readonly string[]} [mcpCallNoTotalTimeoutTools] Exact `server:tool`
 *   names whose host-owned lifecycle has no total deadline. Inactivity and abort still apply.
 * @property {RuntimeCompactionPolicy} [compaction] Typed per-run compaction policy.
 * @property {RuntimePromptOverrides} [prompts] Per-run prompt-fragment overrides (run wins over the host default).
 * @property {any} [webRequestCoordinator] Host-owned shared web admission and quota state.
 * @property {{backend?: string|readonly string[], maxRequestsPerRun?: number, endpoint?: string, searxng?: {endpoint?: string}, ollama?: {baseUrl?: string, apiKey?: string, apiKeyEnv?: string, trustPublicUrl?: boolean}, codex?: {model?: string}, parallel?: {apiKeyEnv?: string}}} [webSearchConfig] Run-scoped WebSearch backend configuration.
 * @property {any} [webSearchState] Private request budget and provider deferral state for one logical run.
 * @property {{provider?: "local"|"parallel"|readonly ("local"|"parallel")[], parallel?: {apiKeyEnv?: string}, render?: "never"|"auto", browserCommand?: string}} [webFetchConfig] Run-scoped WebFetch extraction/render configuration.
 * @property {"sequential"|"safe-parallel"} [piToolExecutionMode] Pi built-in tool scheduling mode. Safe parallelism is the default.
 * @property {"one-at-a-time"|"all"} [piToolParallelismMode] DEPRECATED. Compatibility alias mapped to piToolExecutionMode.
 * @property {RuntimeSubagentsOptions} [subagents] In-process `Agent` built-in: profiles, caps, and the nested-run callback.
 * @property {import("./process.js").OwnedForegroundProcesses} [ownedForegroundProcesses] Host-bound awaited command ownership; no child background capability.
 * @property {import("./process.js").ProcessJobsController} [processJobs] Pi-native-only structural process-job controller. When absent, Exec/Bash schemas and foreground behavior are unchanged.
 * @property {{chainDepth: number, maxChainDepth: number, remainingStarts: number, unavailableReason?: string}} [processJobsAvailability] Host-owned request lineage diagnostics, including when the controller is unavailable.
 * @property {Object} [diagnosticsSeed] Set by createRouterRuntime (ai/runtime/router.js) with a `resume_snapshot` when
 *   failing over mid-chain; a host-level coordinator may relay it forward (see agent/transcript.js), not read by any
 *   bridge in this package today.
 * @property {string} [systemPromptPrefix] Set by createRouterRuntime alongside diagnosticsSeed; the router also
 *   prepends the same text to the systemPrompt argument directly, so bridges that ignore this field still continue
 *   correctly.
 */

/**
 * @typedef {RuntimeRunOptions
 *   & Pick<AgentRuntimeHostOptions, "resolveCustomPricing" | "resolvePiApiKey" | "onCompactionRecorded" | "onToolApprovalRequest" | "toolRiskTiers" | "approvalDefaultRiskTier" | "approvalTimeoutMs" | "approvalAlwaysAllowTools">
 *   & {runtimeBrand: import("../runtime-brand.js").RuntimeBrand, toolContext?: import("../agent/tools/shared/tool-context.js").ToolContext, observerHub: {emit: (event: RuntimeEvent) => void, flush: () => Promise<void>}}
 * } RuntimeRequest
 * The request shape a bridge's `execute(systemPrompt, req)` receives as its
 * second (options) argument: the host-supplied RuntimeRunOptions, merged by
 * createRuntime (runtime.js) with the bound HOST_KEYS host-integration
 * callbacks, the resolved runtimeBrand, the per-instance toolContext (read by
 * internal tool helpers; absent when a host drives a bridge directly without
 * createRuntime), and the per-run observerHub (onEvent is overridden to the
 * hub's emit). `systemPrompt` is passed positionally, not folded into this object.
 */

/**
 * @typedef {Object} RuntimeSubagentDefinition
 * One named subagent profile the `Agent` built-in can deploy.
 * @property {string} name Model-visible identifier and the tool's `name` enum value.
 * @property {string} description Model-visible: when to pick this profile.
 * @property {string} systemPrompt Full system prompt for the child run.
 * @property {RuntimeModelRef} [model] Absent inherits the parent's effective route.
 * @property {string} [effort]
 * @property {ReadonlyArray<string>} [allowedTools] Absent uses the safe read-only default set.
 * @property {ReadonlyArray<string>} [disallowedTools]
 * @property {Object<string, Object>} [mcpServers]
 * @property {ReadonlyArray<string>} [mcpServerNames] Retained selections, resolved against current host policy.
 * @property {number} [maxTurns]
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {Object<string, *> & {detached?: true, deadlineAt?: number, instance?: {id: string, sessionId: string, sessionsRoot: string}}} RuntimeSubagentRunRequest
 * Instance routing is host-owned; the child receives only its own durable transcript.
 */

/**
 * @callback RuntimeSubagentRun
 * Owning-layer callback that actually executes one child turn. The kernel
 * supplies a self-run fallback so `createRuntime` works without host wiring;
 * agent-app replaces it so subagent runs get the configured fallback chain,
 * same-model retries, and run recording.
 * @param {RuntimeSubagentRunRequest} request
 * @returns {Promise<RuntimeResult>}
 */

/**
 * @typedef {Object} RuntimeInlineSubagentsOptions
 * Policy for the runtime-owned general-purpose helper and subagents the model
 * authors at call time rather than picking from `definitions`. Absent
 * suppresses authoring entirely and leaves general-purpose on its safe default.
 * @property {boolean} [enabled] Only `false` turns authoring off.
 * @property {ReadonlyArray<string>} [allowedTools] Ceiling on general-purpose's
 *   read-only tools and what an authored subagent may request. Configured
 *   definitions keep their explicit contracts. Absent means the safe read-only
 *   default set, never every built-in.
 */

/**
 * @typedef {Object} RuntimeSubagentInstance
 * @property {string} [incarnation]
 * @property {{token: string, kind: "foreground"|"detached", settlementPending: true}} [activeTurn]
 * @property {string} id
 * @property {string} conversationId
 * @property {string} name
 * @property {string} systemPrompt
 * @property {RuntimeSubagentDefinition} definition
 * @property {string} sessionId
 * @property {string} sessionsRoot
 * @property {string} [settledTurnToken]
 * @property {string} [lastStatus]
 * @property {object} [recovery]
 * @property {boolean} [recoveryBlocked]
 * @property {string} status
 * @property {{question: string, options?: string[]}} [pendingQuestion]
 * @property {{token: string}} [reservation]
 * @property {number} turns
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {{input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number}} usage
 */

/**
 * @typedef {{ack: string, message: string, background?: boolean, close?: boolean, description?: string}} RuntimeSubagentRecoveryRequest
 */

/**
 * A new route for the turn being admitted. The host persists it on the stored
 * definition, so later continuations inherit it.
 * @typedef {{model?: RuntimeModelRef, effort?: string}} RuntimeSubagentRoute
 */

/**
 * Host-owned, conversation-scoped persistent instance facade. No filesystem implementation belongs in the kernel.
 * @typedef {Object} RuntimeSubagentInstances
 * @property {() => Promise<RuntimeSubagentInstance[]>} list
 * @property {(id: string) => Promise<RuntimeSubagentInstance|undefined>} get
 * @property {(spec: {id?: string, name: string, systemPrompt: string, definition: RuntimeSubagentDefinition, verification?: {workdir: string, reportPath?: string}}, access?: unknown) => Promise<RuntimeSubagentInstance>} create
 * @property {(id: string, outcome: {status: "timeout"|"cancelled"}, turnToken?: string) => Promise<void>} [fence]
 * @property {(id: string, question: {question: string, options?: string[]}) => Promise<RuntimeSubagentInstance>} markAwaiting
 * @property {(id: string, access?: unknown) => Promise<unknown>} [inspect]
 * @property {(id: string, acknowledgement: RuntimeSubagentRecoveryRequest, access?: unknown) => Promise<void>} [checkAcknowledgement]
 * @property {(id: string, token: string, acknowledgement?: RuntimeSubagentRecoveryRequest, access?: unknown, route?: RuntimeSubagentRoute, createdForAdmission?: boolean) => Promise<RuntimeSubagentInstance>} [reserve]
 * @property {(id: string, token: string) => Promise<void>} [releaseReservation]
 * @property {(id: string, token?: string, acknowledgement?: RuntimeSubagentRecoveryRequest, access?: unknown, route?: RuntimeSubagentRoute) => Promise<RuntimeSubagentInstance>} begin
 * @property {(id: string, outcome: {status: string, failureKind?: "session_continuity_lost", question?: {question: string, options?: string[]}, usage?: {input?: number, output?: number, cacheRead?: number, cacheWrite?: number, costUsd?: number}, answerHead?: string}, token?: string) => Promise<RuntimeSubagentInstance>} finish
 * @property {(id: string, access?: unknown) => Promise<RuntimeSubagentInstance>} close
 */

/**
 * @typedef {Object} RuntimeSubagentsOptions
 * @property {ReadonlyArray<RuntimeSubagentDefinition>} [definitions] Named profiles.
 * @property {ReadonlyArray<{name: string, model: RuntimeModelRef, key: string}>} [models] Call-time model choices. Absent means no model parameter.
 * @property {{managed?: boolean, stop?(identity: {instanceId: string, instanceIncarnation: string, turnToken: string}): Promise<{jobId: string, stopRequested: boolean, childStillBusy: boolean, resumable: boolean, disposition: string|null}>, steer?(identity: {instanceId: string, instanceIncarnation: string, turnToken: string}, text: string): Promise<{jobId: string, delivery: "consumed"|"offered"|"rejected"|"unsupported", reason?: string}>, startInternal(request: {managed?: {instanceIncarnation: string, turnToken: string}, kind: "internal", tool: "Agent"|"AgentManage", jobId: string, instanceId: string, description?: string, timeoutMs: number, cleanup(): Promise<void>, run(signal: AbortSignal, writeOutput: (text: string) => void, reportProgress: (event: *) => void, execution?: {deadlineAt: number, managed?: any}): Promise<{answer?: string, output: string, status: string, childStillBusy?: boolean, question?: {question: string, options?: string[]}}>}): Promise<{jobId: string, state: "queued"|"starting"|"running", startedAt: string|null, queuePosition?: number, queueDeadlineAt?: string}>}} [backgroundSubagentController]
 * @property {RuntimeSubagentInstances} [instances] Conversation-scoped persistence; absent preserves stateless Agent.
 * @property {RuntimeInlineSubagentsOptions} [inline] Call-time authoring policy.
 * @property {number} [maxConcurrent] In-flight subagents per parent turn. Default 5.
 * @property {number} [maxPerTurn] Total Agent calls per parent turn. Default 20.
 * @property {number} [maxTurns] Default per-subagent turn cap. Default 100.
 * @property {number} [timeoutMs] Default per-subagent wall clock.
 * @property {RuntimeSubagentRun} [run] Nested-run callback; absent uses the kernel self-run.
 * @property {number} [depth] Kernel-owned. Absent/0 is the parent; >=1 suppresses the `Agent` tool.
 */

/**
 * Monotonic Pi dispatch evidence, armed only after replay seeding.
 * @typedef {Object} RuntimeDispatchProgress
 * @property {1} version
 * @property {boolean} armed
 * @property {boolean} toolAdmitted
 * @property {boolean} liveInputTaken
 */

/**
 * @typedef {Object} RuntimeResult
 * @property {RuntimeDispatchProgress} [dispatchProgress] Absence/malformed evidence never certifies no progress.
 * @property {{turnToken: string, state: "retained"|"unknown"|"lost"}} [subagentContinuity] App-owned detached settlement evidence.
 * @property {{question: string, options?: string[]}} [subagentQuestion]
 * @property {string|null} [text]
 * @property {"silent"|"visible"} [turnDisposition] Host-certified silent completion, when applicable.
 * @property {*} [structuredResult]
 * @property {string|null} [structuredResultSource]
 * @property {ReadonlyArray<import("./events.js").RuntimeEventLike>} [events]
 * @property {Object} [usage]
 * @property {number} [durationMs]
 * @property {number} [numTurns]
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [effectiveEffort] Provider-effective reasoning/thinking level when reported.
 * @property {RuntimeSdkId | (string & {})} [sdk]
 * @property {boolean} [cancelled]
 * @property {string|null} [error]
 * @property {Object|null} [errorDetails]
 * @property {string|null} [failureKind]
 * @property {boolean} [retryable] Explicit terminal safety rejection overrides route retryability.
 * @property {{runId: string, revision: number, providerSessionId: string, modelKey: string, tipId: string}} [providerSessionRecovery]
 * @property {string|null} [providerSessionId]
 * @property {string|null} [stderrTail] Bounded stderr tail from a CLI-backed bridge; see createStderrTail (ai/failure.js).
 * @property {unknown} [runtimeWarnings]
 * @property {Object} [diagnostics]
 * @property {Object} [capabilitiesUsed]
 * @property {Array<{model: RuntimeModelRef, failureKind: (string|null), requestId?: (string|null), retryableSubkind?: (string|null), retryIndex?: number, requirements?: Object}>} [failoverHistory] Set by createRouterRuntime (ai/runtime/router.js) on every failed/skipped attempt.
 */

/**
 * @typedef {Object} RuntimeCapabilities
 * Capability flags a bridge reports for a given model reference. Structural,
 * not sealed: bridges may report extra provider-specific flags (e.g.
 * supports_fast_mode) alongside the common ones from COMMON_CAPABILITIES
 * (ai/runtime/capabilities.js).
 * @property {string} [kind]
 * @property {string} [runtime]
 * @property {boolean} [streaming]
 * @property {boolean} [structured_output]
 * @property {boolean} [supports_session_resume]
 * @property {*} [native_runtime_config]
 * @property {boolean} [supports_mcp]
 * @property {boolean} [supports_skills]
 * @property {boolean} [supports_builtin_tools]
 * @property {boolean} [supports_live_input]
 * @property {boolean} [supports_native_subagents] Whether the bridge exposes provider-native subagent surfaces and
 *   normalized activity. In-process delegation is the `Agent` tool, configured by the host.
 * @property {boolean} [supports_request_tool_environment]
 * @property {boolean} [supports_fast_mode]
 * @property {"projected"|"allow_all_only"} [tool_policy] Whether the bridge can
 *   project named allow/deny policies or accepts only a semantically unrestricted
 *   policy. Built-in bridges always report this field; omission means unknown
 *   for custom structural capability objects.
 */

/**
 * @typedef {Object} RuntimeBridge
 * A fully loaded bridge (registry.js's resolveEngineTurnAdapter result): the
 * executable provider implementation. Unlike RuntimeBridgeDescriptor,
 * `capabilities` here is the bridge module's own static value (computed once
 * at module load, e.g. `runtimeCapabilities()`), not a callable.
 * @property {RuntimeBridgeId} id
 * @property {(ref: RuntimeModelRef, options?: Object) => boolean} supports
 * @property {RuntimeCapabilities} capabilities
 * @property {(systemPrompt: string, req: RuntimeRequest) => Promise<RuntimeResult>} execute
 */

/**
 * @typedef {Object} RuntimeBridgeDescriptor
 * The introspection-only projection of a RuntimeBridge (registry.js's
 * listRuntimeBridges result): id/supports/capabilities without execute, so
 * hosts can describe backend support without loading provider modules.
 * @property {RuntimeBridgeId} id
 * @property {(ref: RuntimeModelRef, options?: Object) => boolean} supports
 * @property {(ref?: RuntimeModelRef) => RuntimeCapabilities} capabilities
 */

/**
 * @typedef {Object} ApprovalRequestPayload
 * Payload passed to a host's `onToolApprovalRequest` callback (agent/approval.js).
 * @property {string} requestId
 * @property {string} toolName
 * @property {string|null} toolUseId
 * @property {string} argumentsSummary Secret-redacted, length-capped JSON summary of the tool call arguments.
 * @property {"low"|"medium"|"high"} riskTier
 * @property {string|null} model
 */

/**
 * @typedef {Object} ApprovalDecision
 * A host's response to an ApprovalRequestPayload.
 * @property {"approve"|"deny"|"always"} decision
 * @property {string} [reason]
 */

/**
 * @typedef {Object} CompactionRecordedPayload
 * Payload passed to a host's `onCompactionRecorded` callback (ai/providers/engine-turn.js)
 * after a successful context compaction, so the host can persist the row.
 * @property {string|null} task_run_id
 * @property {string} trigger
 * @property {string} provider_kind
 * @property {string|null} model
 * @property {number|null} tokens_before
 * @property {string} summary
 * @property {string|null} first_kept_entry_id
 * @property {"succeeded"} status
 * @property {number} created_at
 */

/**
 * @typedef {Object} AgentRuntimeHostOptions
 * The `host` object passed to `createRuntime(host)` / `createRouterRuntime({host, chain})`.
 * Combines the tool-context keys (bound per runtime instance) and the
 * host-integration callbacks (bound once, applied to every run via hostDefaults).
 * @property {string} [workspace]
 * @property {string} [repoRoot]
 * @property {ReadonlyArray<string>} [additionalReadRoots]
 * @property {ReadonlyArray<string>} [additionalWriteRoots]
 * @property {string} [ripgrepPath]
 * @property {string} [qaOutputDir]
 * @property {import("../agent/sandbox-seam.js").SandboxPolicy} [sandboxPolicy]
 * @property {import("../agent/sandbox-seam.js").RuntimeSandboxEngine} [sandboxEngine]
 * @property {import("../agent/sandbox-seam.js").RuntimeSandbox} [sandbox] Sandbox seam implementation (see agent/sandbox-seam.js); defaults to the zero-dependency passthroughSandbox. Real hosts inject host integration's implementation from packages/turn/src/host/sandbox.ts.
 * @property {RuntimePromptOverrides} [prompts] Host-level prompt-fragment override defaults; a per-run `options.prompts` field wins over these (see resolvePrompts, runtime.js).
 * @property {ReadonlyArray<*>} [observers] Observer instances (see RuntimeObserver); loose because observer.js is not a kernel seam file.
 * @property {*} [runtimeBrand] See resolveRuntimeBrand (runtime-brand.js); accepts a partial RuntimeBrand.
 * @property {(parsed: {provider: string, model: string}) => (import("../ai/cost.js").NormalizedPricing|null)} [resolveCustomPricing] See resolvePricing (ai/cost.js).
 * @property {import("../pi-auth.js").PiApiKeyResolver} [resolvePiApiKey] See createPiOAuthApiKeyResolver (pi-auth.js) for a ready-made implementation.
 * @property {(artifact: {filename: string, buffer: Buffer, toolName: string, toolUseId: (string|null)}) => (string|null)} [persistArtifact]
 * @property {(record: CompactionRecordedPayload) => void} [onCompactionRecorded]
 * @property {(payload: ApprovalRequestPayload) => Promise<ApprovalDecision>} [onToolApprovalRequest]
 * @property {Object<string, ("low"|"medium"|"high")>} [toolRiskTiers]
 * @property {"low"|"medium"|"high"} [approvalDefaultRiskTier]
 * @property {number} [approvalTimeoutMs]
 * @property {ReadonlyArray<string>} [approvalAlwaysAllowTools]
 */

/**
 * @typedef {Object} AgentRuntimeToolOptions
 * The subset of AgentRuntimeHostOptions accepted by `runtime.configureTools(next)`
 * (createRuntime's TOOL_RUNTIME_KEYS pick).
 * @property {string} [workspace]
 * @property {string} [repoRoot]
 * @property {ReadonlyArray<string>} [additionalReadRoots]
 * @property {ReadonlyArray<string>} [additionalWriteRoots]
 * @property {string} [ripgrepPath]
 * @property {string} [qaOutputDir]
 * @property {import("../agent/sandbox-seam.js").SandboxPolicy} [sandboxPolicy]
 * @property {import("../agent/sandbox-seam.js").RuntimeSandboxEngine} [sandboxEngine]
 * @property {import("../agent/sandbox-seam.js").RuntimeSandbox} [sandbox]
 */

/**
 * @typedef {Object} NativeDispatchSnapshot
 * @property {number} [compactionSummaryMaxTokens] Effective real-compaction output policy, captured after request extensions.
 * @property {{provider: string, id: string, api: string, contextWindow: number, maxTokens: number}} model
 * @property {{provider: string, api: string, model: string, account: string|null}} provenance
 * @property {string} systemPrompt Actual augmented instructions.
 * @property {ReadonlyArray<{name: string, description: string, parameters: Record<string, any>}>} tools Actual selected built-in/MCP/StructuredOutput declarations.
 * @property {ReadonlyArray<any>} messages Frozen request including current decorated input.
 */

/**
 * @typedef {Object} NativeDispatchBinding
 * @property {string} [sessionId]
 * @property {string} [providerSessionId]
 * @property {string} [providerAttributionSessionId]
 * @property {boolean} [sessionKeepAlive]
 * @property {number} [sessionIdleTimeoutMs]
 * @property {RuntimeRunOptions['sessionTurn']} [sessionTurn]
 * @property {RuntimeRunOptions['sessionRecovery']} [sessionRecovery]
 * @property {any} [nativeSessionAuthority]
 * @property {any} [nativeSessionProjection]
 */

/** @typedef {import("../ai/native-journal-types.js").RuntimeHandoffProducerRequest} NativeHandoffProducerRequest */
/** @typedef {import("../ai/native-journal-types.js").RuntimeHandoffSummary} NativeHandoffSummary */
/** @typedef {import("../ai/native-journal-types.js").RuntimeHandoffProducerResult} NativeHandoffProducerResult */

/**
 * @typedef {Object} NativePreparedDispatch
 * @property {() => void} [assertReady] Check availability before host P2 admission, without consuming the lease.
 * @property {NativeDispatchSnapshot} snapshot Deep-frozen nonsecret dispatch metadata.
 * @property {(input: NativeHandoffProducerRequest) => {status: "ready"}|{status: "budget_failure", reason: string}} [checkHandoffSummary] Pure preflight; no billing or native mutation.
 * @property {(input: NativeHandoffProducerRequest) => Promise<NativeHandoffProducerResult>} [produceHandoffSummary] One ordinary-auth no-tools call per lease; host owns durable admission.
 * @property {(binding?: NativeDispatchBinding) => Promise<RuntimeResult>} run Single use; no router replay/failover, tools are not rebuilt.
 * @property {() => Promise<void>} close Idempotent; while running waits for its normal cleanup. Host owns concurrency/abort.
 */

/**
 * @typedef {Object} AgentRuntimeInstance
 * The object `createRuntime`/`createRouterRuntime` return.
 * @property {(systemPrompt: string, options: RuntimeRunOptions) => Promise<RuntimeResult>} run
 * @property {(next?: AgentRuntimeToolOptions) => void} configureTools
 * @property {(systemPrompt: string, options: RuntimeRunOptions) => Promise<NativePreparedDispatch>} [prepareNativeDispatch]
 * @property {"v1"} [sessionTurnReconciliation] Explicit native evidence ownership capability.
 * @property {(request: {sessionsRoot: string, descriptor: any, purpose: "execution"|"compaction", expectedModel: {provider: string, id: string, api?: string}, expectedInputs: ReadonlyArray<{id: string, requestDigest: string, placement: "initial"|"live"}>, expectedBaseTip?: string|null}) => Promise<any>} reconcileSessionTurn Storage-only protected native reconciliation.
 * @property {(receipt: NonNullable<RuntimeResult["providerSessionRecovery"]>, context: {appliedInputIds: readonly string[]}) => Promise<boolean>} recoverSession
 * @property {(providerSessionId: string) => Promise<boolean>} syncSession
 * @property {(providerSessionId: string) => Promise<void>} refreshSession Guarantees the id has no reusable process-local handle; rejects on failure.
 * @property {(providerSessionId: string, sessionsRoot: string) => ReturnType<typeof import("../engine/session-salvage.js").salvageDurableNativeSession>} [salvageDurableSession] Read-only best-effort snapshot of a durable session transcript.
 * @property {(providerSessionId: string, sessionsRoot: string, deletion?: {hostAuthority:{version:1,rootId:string,authorityId:string,ownerKey:string,historyBucket:string},disposition:'C'|'D',assertOwned:()=>Promise<void>}) => Promise<void>} retireDurableSession Deletes every currently materialized durable transcript with the exact id; callers retry after an active retired run settles to reclaim any late same-name append. Absence is success.
 * @property {(providerSessionId: string) => Promise<boolean>} disposeSession
 * @property {(providerSessionId: string) => Promise<boolean>} invalidateSession
 * @property {() => Promise<void>} disposeAllSessions
 */

/**
 * Structural attempt runtime, distinct from the concrete factory's complete
 * lifecycle API. The router checks optional preparation/tool projection at use.
 * Method signatures preserve structural host projections with stricter inputs.
 * @typedef {{
 *   run(systemPrompt: string, options: RuntimeRunOptions): Promise<RuntimeResult>,
 *   configureTools?(next?: AgentRuntimeToolOptions): void,
 *   prepareNativeDispatch?(systemPrompt: string, options: RuntimeRunOptions): Promise<NativePreparedDispatch>,
 * }} RuntimeAttempt
 */
