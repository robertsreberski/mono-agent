// Shared turn contracts, authored as JSDoc; no runtime implementation imports.



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
 * @property {*} [attribution] Bounded provider-route attribution for the
 *   delegation. Consumers must treat it as operator telemetry. On
 *   `agent_started` it is the LAUNCH route — the explicit request completed
 *   with the inherited parent route — with `disposition: "unknown"`, so it
 *   renders requested-only and never as a confirmed run. On `agent_completed`
 *   it is the final accounting, where `requested` is the explicit request
 *   alone. Absent when the runtime knows no route; never guessed.
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
 *   persistence: "persisted"|"deferred"|"failed",
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
 * Per-call or host-level observer merged by createObserverHub (telemetry/observer.js).
 * Loose on purpose: observer.js is not a kernel seam file.
 * @property {(event: RuntimeToolLifecycleEvent) => void} [recordToolLifecycle] Synchronous admission before queued lifecycle persistence.
 * @property {(event: RuntimeEvent) => (void|Promise<void>)} [onEvent]
 * @property {() => (void|Promise<void>)} [flush]
 */

/** @typedef {Readonly<{type?: string, [key: string]: unknown}>} RuntimeEventLike */
