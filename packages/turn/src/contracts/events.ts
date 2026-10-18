// Shared turn contracts, authored as JSDoc; no runtime implementation imports.

/**
 * Provider-neutral identity attached to every `subagent_activity` event.
 */
export type RuntimeSubagentIdentity = {
  /**
   * The canonical parent attachment key: the initiating
   * parent tool-use id when the provider exposes it, or a stable synthetic key
   * for an orphan lifecycle record. A provider-native task/thread id never replaces it.
   */
  id: string;
  /**
   * Provider-native task or thread id, retained only
   * as diagnostic/correlation metadata.
   */
  nativeId?: string;
  /**
   * Provider-neutral profile/agent name.
   */
  name: string;
  /**
   * Provider call-order ordinal; consumers must not
   * use it as an identity key.
   */
  callIndex: number;
  /**
   * Short task label or description.
   */
  label?: string;
  /**
   * Provider-reported ancestry for a
   * nested native agent. Informational only; `id` remains the attachment key.
   */
  agentPath?: string;
  /**
   * Priced delegation cost, when the runtime can
   * attribute it to this subagent.
   */
  costUsd?: number;
  /**
   * Bounded provider-route attribution for the
   * delegation. Consumers must treat it as operator telemetry. On
   * `agent_started` it is the LAUNCH route — the explicit request completed
   * with the inherited parent route — with `disposition: "unknown"`, so it
   * renders requested-only and never as a confirmed run. On `agent_completed`
   * it is the final accounting, where `requested` is the explicit request
   * alone. Absent when the runtime knows no route; never guessed.
   */
  attribution?: any;
};

/**
 * `agent_started`/`agent_completed` bracket the delegation; `started`/`completed`
 * bracket one child tool call; `message` carries optional child-only prose or
 * thinking and must never be treated as parent answer text or a completed tool.
 */
export type RuntimeSubagentActivityPhase = "agent_started" | "started" | "completed" | "message" | "agent_completed";

/**
 * One normalized native or in-process subagent activity event.
 */
export type RuntimeSubagentActivityEvent = {
  type: "subagent_activity";
  subagent: RuntimeSubagentIdentity;
  phase: RuntimeSubagentActivityPhase;
  /**
   * Unique activity-row id, namespaced from the canonical
   * `subagent.id` for lifecycle and tool rows.
   */
  id: string;
  name?: string;
  arguments?: any;
  content?: any;
  /**
   * Present on a
   * `message` phase when known.
   */
  kind?: "text" | "thinking" | "status" | "warning" | "error";
  /**
   * Present on a `message` phase when known.
   */
  role?: "assistant" | "user";
  isError?: boolean;
  executionMs?: number;
  totalTokens?: number;
};

/**
 * Structured runtime/telemetry event. Subagent activity uses the normalized
 * shape above; every other event kind (tool_approval_pending,
 * provider_failover_started, context_compaction, ...) adds its own fields.
 */
export type RuntimeEvent = RuntimeSubagentActivityEvent | {
  type: string;
  [key: string]: any;
};

export type RuntimeToolLifecycleTerminalState = "success" | "rejected" | "error" | "exit_nonzero" | "timeout" | "signal" | "cancelled" | "interrupted";

/**
 * Provider-neutral invocation half sent to the host-owned lifecycle sink.
 */
export type RuntimeToolLifecycleInvocationEvent = Readonly<{
  phase: "invocation";
  toolCallId: string;
  toolName: string;
  arguments?: unknown;
}>;

/**
 * Provider-neutral terminal half sent to the host-owned lifecycle sink.
 */
export type RuntimeToolLifecycleResultEvent = Readonly<{
  phase: "result";
  toolCallId: string;
  toolName?: string;
  content?: unknown;
  state: RuntimeToolLifecycleTerminalState;
  failureKind?: string;
  detailCode?: string;
  executionMs?: number;
  artifacts?: ReadonlyArray<Readonly<{
    path: string;
    available?: boolean;
  }>>;
}>;

export type RuntimeToolLifecycleEvent = RuntimeToolLifecycleInvocationEvent | RuntimeToolLifecycleResultEvent;

/**
 * Bounded metadata returned after one lifecycle half becomes durable.
 */
export type RuntimeToolLifecyclePersistence = Readonly<{
  recordId?: string;
  sequence?: number;
  persistence: "persisted" | "deferred" | "failed";
  truncated?: boolean;
  originalBytes?: number;
  retainedBytes?: number;
  artifactReferences?: ReadonlyArray<Readonly<{
    id: string;
    available: boolean;
  }>>;
  errorCode?: string;
}>;

export type RuntimeToolLifecycleSink = (event: RuntimeToolLifecycleEvent) => Promise<RuntimeToolLifecyclePersistence | undefined>;

/**
 * Per-call or host-level observer merged by createObserverHub (telemetry/observer.js).
 * Loose on purpose: observer.js is not a kernel seam file.
 * @coreScanRetained
 */
export type RuntimeObserver = {
  /**
   * Synchronous admission before queued lifecycle persistence.
   */
  recordToolLifecycle?: (event: RuntimeToolLifecycleEvent) => void;
  onEvent?: (event: RuntimeEvent) => (void | Promise<void>);
  flush?: () => (void | Promise<void>);
};

export type RuntimeEventLike = Readonly<{
  type?: string;
  [key: string]: unknown;
}>;
