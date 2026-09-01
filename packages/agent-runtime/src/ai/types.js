// Runtime contracts. These are JSDoc-only; the codebase is JS
// (no TypeScript), so the types document the bridge surface that active
// runtimes implement through src/ai/runtime/registry.js.
//
// `tsc -p tsconfig.types.json` (allowJs + declaration + emitDeclarationOnly)
// compiles these typedefs into packages/agent-runtime/types/ai/types.d.ts;
// downstream TS consumers (currently the runtime-adapter package) import them
// via `import('./types.js').X` JSDoc syntax from the other seam files, or
// transitively through the package root's generated declarations.
//
/**
 * @typedef {"pi"} RuntimeSdkId
 * Runtime-result and telemetry label. Model references no longer carry this
 * field because Pi is the sole runtime bridge.
 */

/**
 * @typedef {"pi"} RuntimeBridgeId
 * Registry bridge id. See src/ai/runtime/registry.js's builtinBridgeSpecs.
 */

/**
 * @typedef {Object} RuntimeModelRef
 * @property {string} provider            Pi provider id.
 * @property {string} model               Provider model id.
 * @property {string} reference           Canonical `<provider>:<model>` reference.
 */

/**
 * @typedef {Object} RuntimeSubagentIdentity
 * Provider-neutral identity attached to every `subagent_activity` event.
 * @property {string} id The canonical parent attachment key: the initiating
 *   parent tool-use id when the provider exposes it, or a stable synthetic key
 *   for an orphan lifecycle record. A provider-native task/thread id never replaces it.
 * @property {string} [nativeId] Provider-native task or thread id, retained only
 *   as diagnostic/correlation metadata.
 * @property {string} name Provider-neutral profile/agent name.
 * @property {number} callIndex Provider call-order ordinal; consumers must not
 *   use it as an identity key.
 * @property {string} [label] Short task label or description.
 * @property {string} [agentPath] Provider-reported ancestry for a
 *   nested native agent. Informational only; `id` remains the attachment key.
 * @property {number} [costUsd] Priced delegation cost, when the runtime can
 *   attribute it to this subagent.
 */

/**
 * @typedef {"agent_started"|"started"|"completed"|"message"|"agent_completed"} RuntimeSubagentActivityPhase
 * `agent_started`/`agent_completed` bracket the delegation; `started`/`completed`
 * bracket one child tool call; `message` carries optional child-only prose or
 * thinking and must never be treated as parent answer text or a completed tool.
 */

/**
 * @typedef {Object} RuntimeSubagentActivityEvent
 * One normalized native or in-process subagent activity event.
 * @property {"subagent_activity"} type
 * @property {RuntimeSubagentIdentity} subagent
 * @property {RuntimeSubagentActivityPhase} phase
 * @property {string} id Unique activity-row id, namespaced from the canonical
 *   `subagent.id` for lifecycle and tool rows.
 * @property {string} [name]
 * @property {*} [arguments]
 * @property {*} [content]
 * @property {"text"|"thinking"|"status"|"warning"|"error"} [kind] Present on a
 *   `message` phase when known.
 * @property {"assistant"|"user"} [role] Present on a `message` phase when known.
 * @property {boolean} [isError]
 * @property {number} [executionMs]
 * @property {number} [totalTokens]
 */

/**
 * @typedef {RuntimeSubagentActivityEvent | {type: string, [key: string]: *}} RuntimeEvent
 * Structured runtime/telemetry event. Subagent activity uses the normalized
 * shape above; every other event kind (tool_approval_pending,
 * provider_failover_started, context_compaction, ...) adds its own fields.
 */

/** @typedef {"success"|"rejected"|"error"|"exit_nonzero"|"timeout"|"signal"|"cancelled"|"interrupted"} RuntimeToolLifecycleTerminalState */

/**
 * @typedef {Readonly<{
 *   phase: "invocation",
 *   toolCallId: string,
 *   toolName: string,
 *   arguments?: unknown,
 * }>} RuntimeToolLifecycleInvocationEvent
 * Provider-neutral invocation half sent to the host-owned lifecycle sink.
 */

/**
 * @typedef {Readonly<{
 *   phase: "result",
 *   toolCallId: string,
 *   toolName?: string,
 *   content?: unknown,
 *   state: RuntimeToolLifecycleTerminalState,
 *   failureKind?: string,
 *   detailCode?: string,
 *   executionMs?: number,
 *   artifacts?: ReadonlyArray<Readonly<{path: string, available?: boolean}>>,
 * }>} RuntimeToolLifecycleResultEvent
 * Provider-neutral terminal half sent to the host-owned lifecycle sink.
 */

/** @typedef {RuntimeToolLifecycleInvocationEvent | RuntimeToolLifecycleResultEvent} RuntimeToolLifecycleEvent */

/**
 * @typedef {Readonly<{
 *   recordId?: string,
 *   sequence?: number,
 *   persistence: "persisted"|"failed",
 *   truncated?: boolean,
 *   originalBytes?: number,
 *   retainedBytes?: number,
 *   artifactReferences?: ReadonlyArray<Readonly<{id: string, available: boolean}>>,
 *   errorCode?: string,
 * }>} RuntimeToolLifecyclePersistence
 * Bounded metadata returned after one lifecycle half becomes durable.
 */

/**
 * @callback RuntimeToolLifecycleSink
 * @param {RuntimeToolLifecycleEvent} event
 * @returns {Promise<RuntimeToolLifecyclePersistence|undefined>}
 */

/**
 * @typedef {Object} RuntimeObserver
 * Per-call or host-level observer merged by createObserverHub (ai/observer.js).
 * Loose on purpose: observer.js is not a kernel seam file.
 * @property {(event: RuntimeEvent) => (void|Promise<void>)} [onEvent]
 * @property {() => (void|Promise<void>)} [flush]
 */

/**
 * @typedef {Object} RuntimeToolLimits
 * Typed per-run tool-output limits (the supported replacement for the
 * `agent_tool_*` / `agent_mcp_*` keys of the deprecated `settings` bag). Every
 * field is optional; an omitted field falls back to the kernel default (see
 * resolveAgentCompactionPolicy, agent/compaction.js).
 * @property {number} [toolTextLimitChars]        Max chars of a builtin tool's text result.
 * @property {number} [bashOutputLimitChars]      Max chars of bash stdout/stderr.
 * @property {number} [mcpTextLimitChars]         Max chars of an MCP tool's text result.
 * @property {number} [searchResultLimit]         Max Grep/search hits returned.
 * @property {number} [imageInlineMaxBytes]       Max bytes of an inlined image result.
 * @property {number} [toolPayloadMaxBytes]       Hard cap on a single tool_result payload.
 * @property {number} [mcpCallTimeoutMs]          Per-MCP-call inactivity timeout.
 * @property {number} [mcpCallMaxTotalTimeoutMs]  Hard wall-clock cap for one MCP call.
 * @property {number} [bashTimeoutMs]             Foreground ceiling and default for
 *   Bash/Exec timeouts on the Pi bridge, applied by `normalizePiBuiltinToolParams`
 *   (defaults to 120_000). Background hand-offs deliberately ignore it: a process job is
 *   bounded by the host's `processJobs.maxRuntimeMs` instead.
 */

/**
 * @typedef {Object} RuntimeCompactionPolicy
 * Typed per-run context-compaction policy (the supported replacement for the
 * `agent_compaction_*` keys of the deprecated `settings` bag). Every field is
 * optional; omitted scalar budgets resolve adaptively against the effective
 * model context window.
 * @property {boolean} [enabled]              Whether auto-compaction runs at all.
 * @property {number} [triggerRatio]          Fraction of the context window that arms the proactive trigger.
 * @property {number} [keepRecentTokens]      Recent-token budget preserved across a compaction.
 * @property {number} [summaryMaxTokens]      Combined output-token budget for generated compaction summaries.
 * @property {number} [minSavingsTokens]      Minimum token savings required for proactive compaction; reactive recovery accepts any positive reduction.
 * @property {boolean} [fixedOverheadEnabled] Whether the system-prompt + tool-schema overhead correction is folded into the trigger.
 * @property {number} [contextWindowOverride] Persistent correction for provider context-window metadata; learned overflow evidence may lower it process-locally (applied at resolveLiveCompactionPolicy; has no legacy settings equivalent).
 */

/**
 * @typedef {Object} RuntimePromptOverrides
 * Optional overrides for the kernel's built-in prompt fragments. Precedence is
 * run over host over the kernel default: an absent field leaves the built-in
 * string in place. Supplied on both AgentRuntimeHostOptions (host default) and
 * RuntimeRunOptions (per-run).
 * @property {(systemPrompt: string) => string} [structuredOutputInstruction]
 *   Replaces the StructuredOutput system-prompt instruction (receives the raw
 *   system prompt, returns the augmented one). Only applied when an outputSchema is active.
 * @property {() => string} [structuredOutputFinalization]
 *   Replaces the structured-output finalization re-prompt.
 * @property {(body: string) => string} [liveInputGuidance]
 *   Replaces the live-input steering wrapper (receives the raw guidance body).
 */

/**
 * @typedef {Object} RuntimeRunOptions
 * The options object a host passes to `createRuntime(host).run(systemPrompt, options)`.
 * @property {RuntimeModelRef} model                     Resolved model reference; see parseRuntimeModelReference.
 * @property {string} [sessionId]                         Host conversation/session key for resumable bridges.
 * @property {string} [providerSessionId]                 Provider-owned resume id for resumable bridges.
 * @property {boolean} [sessionKeepAlive]                 Keep resumable provider state alive after the turn.
 * @property {number} [sessionIdleTimeoutMs]              Idle TTL for resumable provider state.
 * @property {AsyncIterable<{body: string, id?: string, receivedAt?: string, acknowledge?: () => void, reject?: (error?: unknown) => void}>} [liveInput] Stream of in-flight user messages for steering an active run. Providers acknowledge only after accepting a message into the active turn.
 * @property {ReadonlyArray<*>} [observers]               Per-call observers (see RuntimeObserver) merged with host-level (createRuntime) observers.
 * @property {(event: RuntimeEvent) => void} [onEvent]
 * @property {RuntimeToolLifecycleSink} [toolLifecycleSink] Awaited host-owned incremental lifecycle persistence boundary.
 * @property {ReadonlyArray<Object>} [messages]
 * @property {string} [effort]
 * @property {string} [cwd]
 * @property {Object<string, Object>} [mcpServers]
 * @property {ReadonlyArray<{name: string, description?: string}>} [skills] Skills disclosed to this run, as `{name, description}`. Non-empty makes `supports_skills` a routing requirement (see router.js), so a chain entry that lacks it is skipped.
 * @property {string} [skillsRoot]                       Directory holding `<name>/SKILL.md`. Required alongside `skills` for `ReadSkill` to be built.
 * @property {ReadonlyArray<string>} [allowedTools]
 * @property {ReadonlyArray<string>} [disallowedTools]
 * @property {string} [permissionMode]
 * @property {number} [maxTurns]
 * @property {Object} [outputSchema]
 * @property {string} [runArtifactDir]
 * @property {AbortSignal} [abortSignal]
 * @property {{schema: 1, values: Readonly<Record<string, string>>, pathPrepend?: readonly string[]}} [toolEnvironment] Host-only environment for Bash, Exec, and nested subagents in this run.
 * @property {import('../agent/sandbox-seam.js').SandboxPolicy} [sandboxPolicy] Per-run sandbox policy; merged monotonically with the host policy (see resolveSandboxPolicy, agent/tools/shared/tool-context.js).
 * @property {import('../agent/sandbox-seam.js').RuntimeSandboxEngine} [sandboxEngine] Per-run concrete sandbox engine handed to the active sandbox implementation.
 * @property {import('../agent/sandbox-seam.js').RuntimeSandbox} [sandbox] Per-run sandbox IMPLEMENTATION override; when set it enforces this run's tools instead of the host/ToolContext impl (precedence run > host > passthrough). Policy DATA still merges monotonically (I13); this overrides only the enforcing code.
 * @property {RuntimeToolLimits} [toolLimits] Typed per-run tool-output limits (supported replacement for the deprecated `settings` tool keys).
 * @property {RuntimeCompactionPolicy} [compaction] Typed per-run compaction policy (supported replacement for the deprecated `settings` compaction keys).
 * @property {RuntimePromptOverrides} [prompts] Per-run prompt-fragment overrides (run wins over the host default).
 * @property {{backend?: "auto"|"searxng"|"codex"|"keyless", endpoint?: string, codex?: {model?: string}}} [webSearchConfig] Run-scoped WebSearch backend configuration.
 * @property {{render?: "never"|"auto", browserCommand?: string}} [webFetchConfig] Run-scoped WebFetch extraction/render configuration.
 * @property {"sequential"|"safe-parallel"} [piToolExecutionMode] Pi built-in tool scheduling mode. Safe parallelism is the default.
 * @property {"one-at-a-time"|"all"} [piToolParallelismMode] DEPRECATED. Compatibility alias mapped to piToolExecutionMode.
 * @property {Object} [settings] DEPRECATED. Legacy flat settings bag; consumed only as a per-group FALLBACK when the corresponding typed object (`toolLimits` / `compaction`) is absent. Consuming any key emits one `deprecated_settings_option` runtime_warning per run. Migrate via resolveRuntimePolicies (@mono-agent/runtime-adapter).
 * @property {RuntimeSubagentsOptions} [subagents] In-process `Agent` built-in: profiles, caps, and the nested-run callback.
 * @property {import('../agent/tools/shared/process-jobs.js').ProcessJobsController} [processJobs] Pi-native-only structural process-job controller. When absent, Exec/Bash schemas and foreground behavior are unchanged.
 * @property {Object} [diagnosticsSeed] Set by createRouterRuntime (ai/runtime/router.js) with a `resume_snapshot` when
 *   failing over mid-chain; a host-level coordinator may relay it forward (see agent/transcript.js), not read by any
 *   bridge in this package today.
 * @property {string} [systemPromptPrefix] Set by createRouterRuntime alongside diagnosticsSeed; the router also
 *   prepends the same text to the systemPrompt argument directly, so bridges that ignore this field still continue
 *   correctly.
 */

/**
 * @typedef {RuntimeRunOptions
 *   & Pick<AgentRuntimeHostOptions, "resolveCustomPricing" | "resolvePiApiKey" | "persistArtifact" | "onCompactionRecorded" | "onToolApprovalRequest" | "toolRiskTiers" | "approvalDefaultRiskTier" | "approvalTimeoutMs" | "approvalAlwaysAllowTools">
 *   & {runtimeBrand: import('../runtime-brand.js').RuntimeBrand, toolContext?: import('../agent/tools/shared/tool-context.js').ToolContext, observerHub: {emit: (event: RuntimeEvent) => void, flush: () => Promise<void>}}
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
 * @property {RuntimeModelRef} [model] Absent inherits the parent's configured route.
 * @property {string} [effort]
 * @property {ReadonlyArray<string>} [allowedTools] Absent uses the safe read-only default set.
 * @property {ReadonlyArray<string>} [disallowedTools]
 * @property {Object<string, Object>} [mcpServers]
 * @property {number} [maxTurns]
 * @property {number} [timeoutMs]
 */

/**
 * @callback RuntimeSubagentRun
 * Owning-layer callback that actually executes one child turn. The kernel
 * supplies a self-run fallback so `createRuntime` works without host wiring;
 * agent-app replaces it so subagent runs get the configured fallback chain,
 * same-model retries, and run recording.
 * @param {Object} request
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
 * @typedef {Object} RuntimeSubagentsOptions
 * @property {ReadonlyArray<RuntimeSubagentDefinition>} [definitions] Named profiles.
 * @property {RuntimeInlineSubagentsOptions} [inline] Call-time authoring policy.
 * @property {number} [maxConcurrent] In-flight subagents per parent turn. Default 5.
 * @property {number} [maxPerTurn] Total Agent calls per parent turn. Default 20.
 * @property {number} [maxTurns] Default per-subagent turn cap. Default 100.
 * @property {number} [timeoutMs] Default per-subagent wall clock.
 * @property {RuntimeSubagentRun} [run] Nested-run callback; absent uses the kernel self-run.
 * @property {number} [depth] Kernel-owned. Absent/0 is the parent; >=1 suppresses the `Agent` tool.
 */

/**
 * @typedef {Object} RuntimeResult
 * @property {string|null} [text]
 * @property {*} [structuredResult]
 * @property {string|null} [structuredResultSource]
 * @property {Array<RuntimeEvent>} [events]
 * @property {Object} [usage]
 * @property {number} [durationMs]
 * @property {number} [numTurns]
 * @property {string} [model]
 * @property {string} [effort]
 * @property {RuntimeSdkId} [sdk]
 * @property {boolean} [cancelled]
 * @property {string|null} [error]
 * @property {Object|null} [errorDetails]
 * @property {string|null} [failureKind]
 * @property {string|null} [providerSessionId]
 * @property {string|null} [stderrTail] Bounded stderr tail from a CLI-backed bridge; see createStderrTail (ai/failure.js).
 * @property {Array<Object>} [runtimeWarnings]
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
 * A fully loaded bridge (registry.js's resolveRuntimeBridge result): the
 * executable provider implementation. Unlike RuntimeBridgeDescriptor,
 * `capabilities` here is the bridge module's own static value (computed once
 * at module load, e.g. `runtimeCapabilities("pi")`), not a callable.
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
 * Payload passed to a host's `onCompactionRecorded` callback (ai/providers/pi-native.js)
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
 * Combines the tool-runtime keys (forwarded to configureToolRuntime) and the
 * host-integration callbacks (bound once, applied to every run via hostDefaults).
 * @property {string} [workspace]
 * @property {string} [repoRoot]
 * @property {string} [ripgrepPath]
 * @property {string} [qaOutputDir]
 * @property {import('../agent/sandbox-seam.js').SandboxPolicy} [sandboxPolicy]
 * @property {import('../agent/sandbox-seam.js').RuntimeSandboxEngine} [sandboxEngine]
 * @property {import('../agent/sandbox-seam.js').RuntimeSandbox} [sandbox] Sandbox seam implementation (see agent/sandbox-seam.js); defaults to the zero-dependency passthroughSandbox. Real hosts inject runtime-adapter's implementation from packages/runtime-adapter/src/sandbox.ts.
 * @property {RuntimePromptOverrides} [prompts] Host-level prompt-fragment override defaults; a per-run `options.prompts` field wins over these (see resolvePrompts, runtime.js).
 * @property {ReadonlyArray<*>} [observers] Observer instances (see RuntimeObserver); loose because observer.js is not a kernel seam file.
 * @property {*} [runtimeBrand] See resolveRuntimeBrand (runtime-brand.js); accepts a partial RuntimeBrand.
 * @property {(parsed: {provider: string, model: string}) => (import('./cost.js').NormalizedPricing|null)} [resolveCustomPricing] See resolvePricing (ai/cost.js).
 * @property {import('../pi-auth.js').PiApiKeyResolver} [resolvePiApiKey] See createPiOAuthApiKeyResolver (pi-auth.js) for a ready-made implementation.
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
 * @property {string} [ripgrepPath]
 * @property {string} [qaOutputDir]
 * @property {import('../agent/sandbox-seam.js').SandboxPolicy} [sandboxPolicy]
 * @property {import('../agent/sandbox-seam.js').RuntimeSandboxEngine} [sandboxEngine]
 * @property {import('../agent/sandbox-seam.js').RuntimeSandbox} [sandbox]
 */

/**
 * @typedef {Object} AgentRuntimeInstance
 * The object `createRuntime`/`createRouterRuntime` return.
 * @property {(systemPrompt: string, options: RuntimeRunOptions) => Promise<RuntimeResult>} run
 * @property {(next?: AgentRuntimeToolOptions) => void} configureTools
 * @property {(providerSessionId: string) => Promise<boolean>} syncSession
 * @property {(providerSessionId: string) => Promise<void>} refreshSession Guarantees the id has no reusable process-local handle; rejects on failure.
 * @property {(providerSessionId: string, sessionsRoot: string) => Promise<void>} retireDurableSession Permanently deletes every durable transcript with the exact id; absence is success.
 * @property {(providerSessionId: string) => Promise<boolean>} disposeSession
 * @property {(providerSessionId: string) => Promise<boolean>} invalidateSession
 * @property {() => Promise<void>} disposeAllSessions
 */

export const PROVIDER_KIND_VALUES = ["claude", "pi", "codex", "opencode", "acp"];
