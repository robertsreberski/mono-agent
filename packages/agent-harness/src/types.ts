import type {
  AgentAttachment,
  AgentContinuationTurn,
  AgentReplyTarget,
  MemoryStore,
} from "@mono-agent/agent-contracts";
import type { RunRecorder, RunSummary, RuntimeEventLike } from "@mono-agent/observability";
import type { MonoRuntimeLike, RuntimeModelReference, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import type { SandboxPolicy } from "@mono-agent/runtime-adapter";

import type { BuiltAgentContext, HistoryMessage } from "./context/index.js";
import type { SkillsCache } from "./skills/index.js";
import type { ToolPolicy } from "./tool-policy/index.js";

export type MemoryWriteMode = "disabled" | "append-host-summary" | "capture";

export interface ConversationHistoryStore {
  load(conversationId: string): Promise<readonly HistoryMessage[]>;
  append(conversationId: string, messages: readonly HistoryMessage[]): Promise<void>;
}

export interface InMemoryHistoryStoreOptions {
  readonly maxMessages?: number;
}

export interface AgentHarnessRequest {
  readonly conversationId: string;
  readonly userMessage: string;
  readonly abortSignal: AbortSignal;
  readonly metadata?: Record<string, unknown>;
  readonly onEvent?: (event: RuntimeEventLike) => void;
  readonly sessionBoundary?: AgentHarnessSessionBoundary;
  /**
   * Multimodal attachments. The harness saves each to `attachmentsDir` and
   * references the saved path (plus inlined text for documents) in the prompt,
   * so the agent opens them with its own file tools — no provider multimodal
   * contract required.
   */
  readonly attachments?: readonly AgentAttachment[];
  /** Host-owned physical delivery target. Never included in prompts or traces. */
  readonly replyTo?: AgentReplyTarget;
  /** Host-owned continuation synthesis controls. Never included in prompts. */
  readonly continuation?: AgentContinuationTurn;
}

export interface AgentHarnessFailure {
  readonly kind: string;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * Recorder summaries may retain the compiled system prompt in private run
 * artifacts. Harness responses cross a channel boundary, so their public
 * summary projection excludes that sensitive field in both the exported type
 * and the runtime payload.
 */
export type ExternalRunSummary = Omit<RunSummary, "systemPrompt">;

export interface AgentHarnessResponse {
  readonly text?: string;
  readonly metadata: {
    readonly runId: string;
    readonly conversationId: string;
    readonly contextSources: readonly string[];
    readonly contextSectionIds: readonly string[];
    readonly runtime?: Record<string, unknown>;
    readonly summary?: ExternalRunSummary;
  };
  readonly failure?: AgentHarnessFailure;
}

export interface AgentHarness {
  run(request: AgentHarnessRequest): Promise<AgentHarnessResponse>;
  /**
   * Queue-after-turn entry point. In continuous-session mode a same-conversation
   * request that arrives while a turn is in flight is queued and answered after
   * the current turn finishes — so it resumes the warm session rather than
   * racing fresh; different conversations still run concurrently. Falls back to
   * run() outside continuous mode.
   */
  submit?(request: AgentHarnessRequest): Promise<AgentHarnessResponse>;
  /** Abort the in-flight turn for a conversation and clear its queued follow-ups. */
  cancel?(conversationId: string, reason?: unknown): void;
  /**
   * Record a message posted VERBATIM into `conversationId` by a channel (native
   * cron/webhook notification) without running a turn: append it to durable
   * history and retire any warm provider session so a later reply cold-loads the
   * delivered message into context. No model call.
   */
  appendVerbatimTurn?(
    conversationId: string,
    text: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
  /** Retire all live provider sessions (graceful shutdown). */
  dispose?(): Promise<void>;
}

export type AgentSessionMode = "continuous" | "per-message";

export type AgentHarnessSessionBoundaryKind = "rollover" | "isolated" | "resume_replay";

export interface AgentHarnessSessionBoundary {
  readonly type: "session_boundary";
  readonly kind: AgentHarnessSessionBoundaryKind;
  readonly conversationId: string;
  readonly baseConversationId?: string;
  readonly previousConversationId?: string;
  readonly providerSessionId?: string;
  readonly reason?: string;
  readonly timestamp?: string;
}

export type AgentHarnessSessionEventKind = "acquired" | "released" | "saved" | "evicted" | "isolated" | "cold";

export interface AgentHarnessSessionSnapshot {
  readonly conversationId: string;
  readonly providerSessionId: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly busy: boolean;
}

export interface AgentHarnessSessionEvent {
  readonly kind: AgentHarnessSessionEventKind;
  readonly conversationId: string;
  readonly providerSessionId?: string;
  readonly createdAt?: number;
  readonly lastActivityAt?: number;
  readonly busy?: boolean;
  readonly reason?: string;
  readonly snapshot?: readonly AgentHarnessSessionSnapshot[];
}

export interface AgentHarnessSessionOptions {
  readonly mode: AgentSessionMode;
  readonly idleTimeoutMs: number;
  /**
   * Overrides backend capability detection (monoRuntimeSupportsSessionResume)
   * — primarily for tests and custom runtimes.
   */
  readonly supportsResume?: boolean;
  /**
   * When true, a cron/proactive request (one carrying `metadata.cron`) is run as
   * a one-shot ephemeral turn: it does NOT acquire/resume the shared continuous
   * session and does NOT persist a warm session back into it, so its large tool
   * dumps stay out of the interactive transcript. Interactive (non-cron) turns
   * are unaffected. Default false (no behavior change).
   */
  readonly isolateProactive?: boolean;
  readonly onSessionEvent?: (event: AgentHarnessSessionEvent) => void | Promise<void>;
}

export interface AgentHarnessRecorderFactoryInput {
  readonly runId: string;
  readonly conversationId: string;
  /** The user's prompt for this run, so recorders/exporters can surface it. */
  readonly userInput?: string;
  /**
   * Originating channel/trigger kind for this run, e.g. "tui" | "telegram" |
   * "slack" | "cron" | "webhook", derived from the request metadata (falling
   * back to a conversationId-prefix guess). Forwarded to the recorder so
   * summaries/exports can classify the run without re-deriving it.
   */
  readonly source?: string;
  /** Trigger name for `source`, e.g. the cron job id or webhook endpoint name. */
  readonly sourceDetail?: string;
  /** Whether the run is detached from the shared warm provider session. */
  readonly isolated?: boolean;
}

/**
 * Optional app-owned hook that can add request-scoped interaction details to
 * the durable assistant history entry without changing the delivered response
 * or memory capture. Implementations must release all run-scoped state after
 * {@link releaseRun}.
 */
export interface AgentHarnessTurnHistoryEnricher {
  enrichAssistantHistory(input: {
    readonly runId: string;
    readonly conversationId: string;
    readonly assistantText: string;
  }): string | Promise<string>;
  releaseRun(input: {
    readonly runId: string;
    readonly conversationId: string;
  }): void | Promise<void>;
}

/** A short-lived bridge credential that can report progress for one run only. */
export interface AgentHarnessProgressCapability {
  readonly url: string;
  readonly token: string;
  /** Revoke the capability. Safe to call more than once. */
  release(): void | Promise<void>;
}

/** App-owned issuer for request-bound progress capabilities. */
export interface AgentHarnessProgressCapabilityIssuer {
  issueProgressCapability(input: {
    readonly runId: string;
    readonly conversationId: string;
  }): AgentHarnessProgressCapability | Promise<AgentHarnessProgressCapability>;
}

export type AgentHarnessContinuationMode =
  | "reply"
  | "notify_if_actionable"
  | "silent"
  | "capture";

/** A short-lived claim credential bound to one run, server, and host route. */
export interface AgentHarnessContinuationClaimCapability {
  readonly url: string;
  readonly token: string;
  readonly fingerprint: string;
  readonly mode: AgentHarnessContinuationMode;
  /** Revoke the capability. Safe to call more than once. */
  release(): void | Promise<void>;
}

/** App-owned issuer for destination-bound continuation claim capabilities. */
export interface AgentHarnessContinuationClaimCapabilityIssuer {
  issueContinuationClaimCapability(input: {
    readonly runId: string;
    readonly serverName: string;
    readonly conversationId: string;
    readonly replyTo?: AgentReplyTarget;
    /** Interactive origin snapshot; absent for detached named-route claims. */
    readonly historyBoundary?: string;
  }):
    | AgentHarnessContinuationClaimCapability
    | undefined
    | Promise<AgentHarnessContinuationClaimCapability | undefined>;
}

/**
 * Trusted continuation context injected only into explicitly selected stdio or
 * loopback-HTTP MCP servers. It is independent of raw MCP request context.
 */
export interface AgentHarnessContinuationContextOptions {
  readonly serverNames: readonly string[];
  readonly capabilityIssuer: AgentHarnessContinuationClaimCapabilityIssuer;
}

/**
 * Trusted context injected into explicitly opted-in stdio MCP servers after all
 * runtime/tool-policy option layers have been merged.
 */
export interface AgentHarnessMcpRequestContextOptions {
  readonly serverNames: readonly string[];
  readonly runOutputRoot: string;
  readonly progressCapabilityIssuer?: AgentHarnessProgressCapabilityIssuer;
}

export interface AgentHarnessOptions {
  readonly identityPath: string;
  readonly soulPath?: string;
  readonly skillsRoot?: string;
  readonly selectedSkills?: readonly string[];
  readonly skillMaxBytes?: number;
  /**
   * How skill bodies reach the agent. "full" (default) preserves the legacy
   * up-front inlining of `selectedSkills` bodies (via skillInstructions); "index"
   * injects the skill INDEX only and wires the runtime's `ReadSkill` tool so the
   * agent pulls a full body on demand. Unset = "full".
   */
  readonly skillDisclosure?: "index" | "full";
  /**
   * Optional shared skills cache. Skills are re-read from disk every turn
   * otherwise; pass one cache instance across turns (and across harnesses for a
   * conversation) to skip unchanged reads. Defaults to a per-harness cache.
   */
  readonly skillsCache?: SkillsCache;
  /**
   * Directory where inbound request attachments are saved before the agent
   * opens them. Should sit under a sandbox-readable root. When unset,
   * attachment bytes are not persisted (document text is still inlined).
   */
  readonly attachmentsDir?: string;
  readonly runtime: MonoRuntimeLike;
  readonly model: RuntimeModelReference;
  readonly executionMode?: string;
  readonly cwd?: string;
  readonly effort?: string;
  readonly maxTurns?: number;
  /**
   * Durable pi-native session root directory. When set, provider sessions are
   * persisted to disk (JSONL) so a turn can resume across restarts instead of
   * falling back to a full conversation-history re-send. Unset = in-memory only.
   */
  readonly piSessionsRoot?: string;
  readonly runtimeOptions?: Omit<RuntimeRunOptions, "model" | "messages" | "abortSignal" | "executionMode" | "onEvent">;
  readonly runtimeOptionsForRequest?: (
    input: AgentHarnessRuntimeOptionsInput,
  ) => AgentHarnessRuntimeOptionsExtension | Promise<AgentHarnessRuntimeOptionsExtension>;
  readonly mcpRequestContext?: AgentHarnessMcpRequestContextOptions;
  readonly continuationContext?: AgentHarnessContinuationContextOptions;
  /**
   * Factory for a runtime bound to a specific model, used when a per-request
   * extension overrides {@link model} (cron job / webhook per-turn model). The
   * app wires this to build a runtime whose fallback chain has the override as
   * primary followed by the configured backups, so an override keeps failover.
   * When unset, an override still sets the per-run model but cannot reshape a
   * frozen fallback chain (the router would ignore it).
   */
  readonly runtimeForModel?: (model: RuntimeModelReference, executionMode?: string) => MonoRuntimeLike;
  readonly memory?: MemoryStore;
  readonly memoryWriteMode?: MemoryWriteMode;
  /** Best-effort post-provider persistence warning sink (host log/metric). */
  readonly onMemoryWarning?: (message: string) => void;
  readonly historyStore?: ConversationHistoryStore;
  /** Best-effort enrichment applied only to the assistant history entry. */
  readonly turnHistoryEnricher?: AgentHarnessTurnHistoryEnricher;
  readonly toolPolicy?: ToolPolicy;
  readonly sandboxPolicy?: SandboxPolicy;
  readonly recorderFactory?: (input: AgentHarnessRecorderFactoryInput) => RunRecorder;
  readonly createRunId?: () => string;
  readonly now?: () => Date;
  readonly session?: AgentHarnessSessionOptions;
  /**
   * Optional concurrency bounds across all conversations served by this
   * harness. Two independent tiers, both unset = unbounded (default):
   *
   * - `maxConcurrentRuns` bounds provider EXECUTION WIDTH: how many runs may be
   *   in the model call at once (a semaphore acquired around the provider call
   *   only). Queued follow-ups wait in the per-conversation queue, holding no
   *   slot, until a slot frees.
   * - `maxPendingRuns` bounds ADMISSION: how many runs may be simultaneously
   *   past the front door — i.e. holding persisted attachments + built context
   *   in memory — before the costly pre-provider work runs. A request arriving
   *   when this counter is already at the bound fails fast (a "capacity_exceeded"
   *   failure) instead of doing the expensive work and parking in the unbounded
   *   semaphore queue. This is backpressure; it is deliberately NOT the
   *   semaphore (whose waiter queue is unbounded — that is the gap it closes).
   *
   * Bounds apply per channel harness instance, not globally across channels:
   * the app builds one harness per channel, so with N configured channels the
   * effective ceiling is N× this value.
   */
  readonly concurrency?: { readonly maxConcurrentRuns?: number; readonly maxPendingRuns?: number };
}

export interface AgentHarnessRuntimeOptionsInput {
  readonly request: AgentHarnessRequest;
  readonly runId: string;
  readonly context: BuiltAgentContext;
}

export interface AgentHarnessRuntimeOptionsExtension {
  // `model`/`effort` are allowed so a per-request extension can override them for
  // a single turn (cron/webhook per-trigger model). The harness applies them with
  // precedence over its defaults. `Partial` keeps every field optional (an
  // extension that sets only `mcpServers` stays valid). `messages`/`abortSignal`/
  // `onEvent` and `executionMode` stay harness-owned: executionMode is derived
  // from the effective model + host config in the harness, so an extension must
  // not set it.
  readonly runtimeOptions?: Partial<Omit<RuntimeRunOptions, "messages" | "abortSignal" | "onEvent" | "executionMode">>;
  /**
   * Authoritative request-scoped tool boundary. When present, it replaces the
   * host/static allowed, denied, MCP-server, and MCP-config-path fields instead
   * of unioning with them. Use for narrowly authenticated turns such as local
   * configuration where ordinary action tools must not leak through.
   */
  readonly toolPolicyOverride?: ToolPolicy;
  readonly cleanup?: () => void | Promise<void>;
  /**
   * Cleanup that must wait until the runtime call and all of its tool clients
   * have settled. Unlike `cleanup`, this is never invoked by the eager abort
   * release path. Use it for deleting request-owned files that a slow provider
   * may still have open.
   */
  readonly settleCleanup?: () => void | Promise<void>;
}
