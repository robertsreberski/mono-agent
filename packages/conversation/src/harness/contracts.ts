import type { ContinuityUpkeepResult } from "@mono-agent/turn/host";
import type { UpkeepMutation, UpkeepAdmission, UpkeepReservation } from "../continuity/admission.js";
import type { LedgerGeneration } from "../continuity/ledger.js";
import type { SessionContextCapabilities } from "./session-capabilities.js";
import type { AgentLiveInputOffer, AgentLiveInputOwnership, AgentLiveInputRequest, AgentAttachment, AgentContextImportRequest, AgentContextImportResult, AgentContinuationOriginContext, AgentContinuationTurn, AgentMessageSender, AgentPrecedingMessage, AgentReplyTarget, AgentSurface, AgentToolEnvironment, MemoryStore, MemoryCaptureSpeakerKind } from "@mono-agent/contracts";
import type { RunRecorder, RunSummary, RuntimeEventLike } from "@mono-agent/observability";
import type { MonoRuntimeLike, RuntimeModelReference, RuntimeRunOptions } from "@mono-agent/turn/host/types";
import type { SandboxPolicy } from "@mono-agent/turn/host/types";

import type { BuiltAgentContext } from "../context/index.js";
import type { SkillsCache } from "../skills/index.js";
import type { ToolHistoryReader } from "../tool-history/reader.js";
import type { ToolHistoryWriter } from "../tool-history/writer.js";
import type { ToolPolicy } from "../tool-policy/index.js";

import type { ConversationHistoryStore } from "../history/contracts.js";

export type MemoryWriteMode = "disabled" | "append-host-summary" | "capture";

export interface ConversationHarnessRequest {
  /** Host-stamped memory provenance; never inferred from metadata.source. */
  readonly captureSpeakerKind?: MemoryCaptureSpeakerKind;
  readonly onLiveInputOwnership?: (event: AgentLiveInputOwnership) => void;
  readonly conversationId: string;
  readonly userMessage: string;
  readonly abortSignal: AbortSignal;
  readonly metadata?: Record<string, unknown>;
  readonly onEvent?: (event: RuntimeEventLike) => void;
  readonly sessionBoundary?: ConversationHarnessSessionBoundary;
  /**
   * Multimodal attachments. The harness saves each to `attachmentsDir` and
   * references the saved path (plus inlined text for documents) in the prompt,
   * so the agent opens them with its own file tools — no provider multimodal
   * contract required.
   */
  readonly attachments?: readonly AgentAttachment[];
  /** Host-only, request-scoped process-tool environment. */
  readonly toolEnvironment?: AgentToolEnvironment;
  /** Speaker identity. Model-visible (name and handle); `sender.id` is host-only. */
  readonly sender?: AgentMessageSender;
  /** Untrusted background transcript. Model-visible for this turn only; never persisted. */
  readonly precedingMessages?: readonly AgentPrecedingMessage[];
  /** Which surface this turn is on. Model-visible in full, `id` included. */
  readonly surface?: AgentSurface;
  /** Host-owned physical delivery target. Never included in prompts or traces. */
  readonly replyTo?: AgentReplyTarget;
  /** Host-owned continuation synthesis controls. Never included in prompts. */
  readonly continuation?: AgentContinuationTurn;
}

export interface ConversationHarnessFailure {
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

export interface ConversationHarnessResponse {
  readonly text?: string;
  readonly metadata: {
    readonly runId: string;
    readonly conversationId: string;
    readonly contextSources: readonly string[];
    readonly contextSectionIds: readonly string[];
    readonly turnDisposition?: "silent" | "visible";
    readonly runtime?: Record<string, unknown>;
    readonly summary?: ExternalRunSummary;
  };
  readonly failure?: ConversationHarnessFailure;
}

export interface ConversationHarness {
  compactConversation?(
    conversationId: string,
    options?: import("@mono-agent/contracts").AgentManualCompactionOptions,
    signal?: AbortSignal,
  ): Promise<import("@mono-agent/contracts").AgentManualCompactionResult>;
  readonly liveInputOwnership?: { readonly version: 1 };
  run(request: ConversationHarnessRequest): Promise<ConversationHarnessResponse>;
  /** Offer user guidance to this conversation's active interactive turn. */
  offerLiveInput?(request: AgentLiveInputRequest): AgentLiveInputOffer;
  /**
   * Queue-after-turn entry point. In continuous-session mode a same-conversation
   * request that arrives while a turn is in flight is queued and answered after
   * the current turn finishes — so it resumes the warm session rather than
   * racing fresh; different conversations still run concurrently. Falls back to
   * run() outside continuous mode.
   */
  submit?(request: ConversationHarnessRequest): Promise<ConversationHarnessResponse>;
  /** Abort the in-flight turn for a conversation and clear its queued follow-ups. */
  cancel?(conversationId: string, reason?: unknown): void;
  /** Retire and clear one conversation so its next turn rebuilds startup context. */
  resetConversation?(conversationId: string): Promise<void>;
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
  /** Import canonical provenance plus assistant context without a model turn. */
  importContext?(
    conversationId: string,
    request: AgentContextImportRequest,
  ): Promise<AgentContextImportResult>;
  /** Drain admitted work, retire live provider sessions, and permanently stop accepting turns. */
  dispose?(): Promise<void>;
}

export type AgentSessionMode = "continuous" | "per-message";

export type ConversationHarnessSessionBoundaryKind = "rollover" | "isolated" | "resume_replay";

export interface ConversationHarnessSessionBoundary {
  readonly type: "session_boundary";
  readonly kind: ConversationHarnessSessionBoundaryKind;
  /** Provider context disposition; optional for older/custom producers. */
  readonly context?: "retained" | "reconstructed" | "handoff";
  /** Content-free facts about the canonical reconstruction, when available. */
  readonly replayedMessageCount?: number;
  readonly toolProjectionBytes?: number;
  readonly toolProjectionRecords?: number;
  readonly coverageStartTimestamp?: string;
  readonly conversationId: string;
  readonly baseConversationId?: string;
  readonly previousConversationId?: string;
  readonly providerSessionId?: string;
  readonly reason?: string;
  readonly timestamp?: string;
}

export type ConversationHarnessSessionEventKind = "acquired" | "released" | "saved" | "evicted" | "isolated" | "cold";

export interface ConversationHarnessSessionSnapshot {
  readonly modelKey?: string;
  readonly conversationId: string;
  readonly providerSessionId: string;
  /** Durable provider transcript revision held by this process, when coordinated. */
  readonly providerSessionRevision?: number;
  /** Canonical host-history version consumed by this warm provider handle. */
  readonly historyVersion?: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly busy: boolean;
}

export interface ConversationHarnessSessionEvent {
  readonly modelKey?: string;
  readonly kind: ConversationHarnessSessionEventKind;
  readonly conversationId: string;
  readonly providerSessionId?: string;
  readonly providerSessionRevision?: number;
  readonly historyVersion?: string;
  readonly createdAt?: number;
  readonly lastActivityAt?: number;
  readonly busy?: boolean;
  readonly reason?: string;
  readonly snapshot?: readonly ConversationHarnessSessionSnapshot[];
}

export interface ConversationHarnessSessionOptions {
  readonly mode: AgentSessionMode;
  readonly idleTimeoutMs: number;
  /** Provider settlement window after cancellation or failure. Defaults to 1,000 ms. */
  readonly terminalRecoverySettlementMs?: number;
  /** Total continuity wait budget, including republish. Defaults to 30,000 ms; integer 1–2,147,483,647. */
  readonly turnContinuityPublicationWaitMs?: number;
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
  readonly onSessionEvent?: (event: ConversationHarnessSessionEvent) => void | Promise<void>;
}

export interface ConversationHarnessRecorderFactoryInput {
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
export interface ConversationHarnessTurnHistoryEnricher {
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
export interface ConversationHarnessProgressCapability {
  readonly url: string;
  readonly token: string;
  /** Revoke the capability. Safe to call more than once. */
  release(): void | Promise<void>;
}

/** App-owned issuer for request-bound progress capabilities. */
export interface ConversationHarnessProgressCapabilityIssuer {
  issueProgressCapability(input: {
    readonly runId: string;
    readonly conversationId: string;
  }): ConversationHarnessProgressCapability | Promise<ConversationHarnessProgressCapability>;
}

export type ConversationHarnessContinuationMode =
  | "reply"
  | "notify_if_actionable"
  | "silent"
  | "capture";

/** A short-lived claim credential bound to one run, server, and host route. */
export interface ConversationHarnessContinuationClaimCapability {
  readonly url: string;
  readonly token: string;
  readonly fingerprint: string;
  readonly mode: ConversationHarnessContinuationMode;
  /**
   * Report whether a drained capability has any active interactive claims that
   * need the completed origin turn. Valid after `release()`.
   */
  requiresOriginContext(): boolean | Promise<boolean>;
  /**
   * Persist the completed origin turn into every claim made with this
   * capability. This handle remains valid after `release()` revokes the token.
   */
  finalizeOriginContext(snapshot: AgentContinuationOriginContext): void | Promise<void>;
  /** Publish a prepared snapshot only after the origin run commits successfully. */
  activateOriginContext(): void | Promise<void>;
  /** Permanently close claimed continuations whose origin run did not commit. */
  abandonOriginContext(): void | Promise<void>;
  /** Revoke the capability. Safe to call more than once. */
  release(): void | Promise<void>;
}

/** App-owned issuer for destination-bound continuation claim capabilities. */
export interface ConversationHarnessContinuationClaimCapabilityIssuer {
  issueContinuationClaimCapability(input: {
    readonly runId: string;
    readonly serverName: string;
    readonly conversationId: string;
    readonly replyTo?: AgentReplyTarget;
    /** Interactive origin snapshot; absent for detached named-route claims. */
    readonly historyBoundary?: string;
  }):
    | ConversationHarnessContinuationClaimCapability
    | undefined
    | Promise<ConversationHarnessContinuationClaimCapability | undefined>;
}

/**
 * Trusted continuation context injected only into explicitly selected stdio or
 * loopback-HTTP MCP servers. It is independent of raw MCP request context.
 */
export interface ConversationHarnessContinuationContextOptions {
  readonly serverNames: readonly string[];
  readonly capabilityIssuer: ConversationHarnessContinuationClaimCapabilityIssuer;
}

/**
 * Trusted context injected into explicitly opted-in stdio MCP servers after all
 * runtime/tool-policy option layers have been merged.
 */
export interface ConversationHarnessMcpRequestContextOptions {
  readonly serverNames: readonly string[];
  readonly runOutputRoot: string;
  readonly progressCapabilityIssuer?: ConversationHarnessProgressCapabilityIssuer;
}

export interface ConversationHarnessOptions {
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
  readonly cwd?: string;
  readonly effort?: string;
  readonly maxTurns?: number;
  /**
   * Durable sessions root directory. When set, provider sessions are
   * persisted to disk (JSONL) only when the history store implements the
   * crash-safe provider-session turn transaction. Custom stores without that
   * contract remain in-memory. Unset = in-memory only.
   */
  readonly sessionsRoot?: string;
  readonly runtimeOptions?: Omit<RuntimeRunOptions, "model" | "messages" | "abortSignal" | "onEvent" | "toolLifecycleSink" | "detachedContext">;
  readonly runtimeOptionsForRequest?: (
    input: ConversationHarnessRuntimeOptionsInput,
  ) => ConversationHarnessRuntimeOptionsExtension | Promise<ConversationHarnessRuntimeOptionsExtension>;
  /** Model/context policy selection for promptless manual compaction. Must not allocate turn tools. */
  readonly runtimeOptionsForManualCompaction?: (
    model: string,
    context1M?: boolean,
  ) => Partial<Pick<NonNullable<ConversationHarnessRuntimeOptionsExtension["runtimeOptions"]>,
    "customProvider" | "customModel" | "modelCapabilities" | "isPrivateProvider" | "context1MModels">> | Promise<Partial<Pick<NonNullable<ConversationHarnessRuntimeOptionsExtension["runtimeOptions"]>,
    "customProvider" | "customModel" | "modelCapabilities" | "isPrivateProvider" | "context1MModels">>>;
  readonly mcpRequestContext?: ConversationHarnessMcpRequestContextOptions;
  readonly continuationContext?: ConversationHarnessContinuationContextOptions;
  /**
   * Factory for a runtime bound to a specific model, used when a per-request
   * extension overrides {@link model} (cron job / webhook per-turn model). The
   * app wires this to build a runtime whose fallback chain has the override as
   * primary followed by the configured backups, so an override keeps failover.
   * When unset, an override still sets the per-run model but cannot reshape a
   * frozen fallback chain (the router would ignore it).
   */
  readonly runtimeForModel?: (model: RuntimeModelReference) => MonoRuntimeLike;
  readonly memory?: MemoryStore;
  readonly memoryWriteMode?: MemoryWriteMode;
  /** Disable automatic capture admission for host-identified cron turns only. */
  readonly memoryCaptureCron?: boolean;
  /** Disable automatic capture admission for host-identified webhook turns only. */
  readonly memoryCaptureWebhook?: boolean;
  /** Host-provisioned Remember capability; never inferred from request content. */
  readonly memoryRememberEnabled?: boolean;
  /** Host-provisioned Remember detail support (BuJo). */
  readonly memoryRememberDetails?: boolean;
  /** Best-effort post-provider persistence warning sink (host log/metric). */
  readonly onMemoryWarning?: (message: string) => void;
  readonly historyStore?: ConversationHistoryStore;
  /**
   * Host-owned lifecycle sidecar. It is intentionally independent of
   * ConversationHistoryStore: starts/results are fsynced while tools run, even
   * when the surrounding turn never reaches the canonical-history commit.
   */
  readonly toolHistory?: ConversationHarnessToolHistoryOptions;
  /**
   * Whether this turn's `Exec`/`Bash` will carry the `background` field, so the
   * session block can explain a capability the model can actually see. The
   * harness cannot decide this itself: the process-job controller is a host
   * decision made per request, and the runtime-options extension that makes it
   * runs after context assembly. Hosts must answer with the same predicate that
   * injects the schema — guidance for an absent capability is worse than none.
   */
  readonly subagentInstancesFor?: (input: { readonly request: ConversationHarnessRequest; readonly runId: string }) => Promise<NonNullable<SessionContextCapabilities["subagentInstances"]>>;
  /** App-verified attribution for the Session context; metadata alone is never trusted. */
  readonly verifiedPeerCallerFor?: (input: { readonly request: ConversationHarnessRequest }) => Promise<string | undefined>;
  readonly backgroundSubagentsAvailable?: (input: { readonly request: ConversationHarnessRequest; readonly runId: string }) => boolean;
  readonly backgroundProcessJobsAvailable?: (
    input: { readonly request: ConversationHarnessRequest; readonly runId: string },
  ) => boolean;
  /** Best-effort enrichment applied only to the assistant history entry. */
  readonly turnHistoryEnricher?: ConversationHarnessTurnHistoryEnricher;
  readonly toolPolicy?: ToolPolicy;
  readonly sandboxPolicy?: SandboxPolicy;
  readonly recorderFactory?: (input: ConversationHarnessRecorderFactoryInput) => RunRecorder;
  readonly createRunId?: () => string;
  readonly now?: () => Date;
  readonly session?: ConversationHarnessSessionOptions;
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

export interface ConversationHarnessRuntimeOptionsInput {
  readonly request: ConversationHarnessRequest;
  readonly runId: string;
  readonly context: BuiltAgentContext;
}

export interface ConversationHarnessRuntimeOptionsExtension {
  // `model`/`effort` are allowed so a per-request extension can override them for
  // a single turn (cron/webhook/TUI per-trigger model). In continuous-session
  // mode, a model change must already be declared in that request metadata so
  // the harness isolates it before assembling context. `Partial` keeps every field optional (an
  // extension that sets only `mcpServers` stays valid). `messages`/`abortSignal`/
  // `onEvent` stays harness-owned. Provider-session ids, keep-alive fields, and
  // sessionsRoot are accepted structurally for compatibility but stripped
  // and replaced by the harness's coordinated decision.
  readonly runtimeOptions?: Omit<
    Partial<Omit<RuntimeRunOptions, "messages" | "abortSignal" | "onEvent" | "toolLifecycleSink" | "detachedContext">>,
    "effort"
  > & {
    /**
     * A string pins this turn's effort, `null` explicitly selects the provider
     * default, and omission inherits the harness effort.
     */
    readonly effort?: string | null;
  };
  /**
   * Authoritative request-scoped tool boundary. When present, it replaces the
   * host/static allowed, denied, MCP-server, and MCP-config-path fields instead
   * of unioning with them. Use for narrowly authenticated turns such as local
   * configuration where ordinary action tools must not leak through.
   */
  readonly toolPolicyOverride?: ToolPolicy;
  /**
   * Host-owned standing context for this one turn, such as a project's shared
   * instructions: rewrites only the prompt copy of the user message (after
   * speaker context, before recalled memory). History, memory recall queries
   * and memory capture keep the canonical message. Continuation synthesis
   * applies it to its host-synthesized prompt copy as well.
   */
  readonly decorateUserMessage?: (userMessage: string) => string;
  readonly cleanup?: () => void | Promise<void>;
  /**
   * Cleanup that must wait until the runtime call and all of its tool clients
   * have settled. Unlike `cleanup`, this is never invoked by the eager abort
   * release path. Use it for deleting request-owned files that a slow provider
   * may still have open.
   */
  readonly settleCleanup?: () => void | Promise<void>;
}

export interface ConversationHarnessToolHistoryOptions {
  /** Positive configured capture capability; omitted for the legacy/OFF path. */
  readonly continuityEnabled?: true;
  /** Default-on deterministic cold rebuild evidence; false retains recording/retrieval. */
  readonly packEnabled?: boolean;
  readonly ledgerEnabled?: boolean;
  readonly upkeep?: ({ readonly enabled: true; readonly recorderNamespace: string } | { readonly enabled: false; readonly recorderNamespace?: string }) & { readonly model?: string; readonly complete: (prompt: string, signal: AbortSignal, budget?: { readonly operationId: string; readonly inputTokens: 64000 | 128000; maxEntries?: number | undefined }) => Promise<ContinuityUpkeepResult> };
  readonly mutateUpkeep?: (input: UpkeepMutation) => Promise<UpkeepAdmission | null>;
  readonly publishLedger?: (generation: LedgerGeneration, reservation?: UpkeepReservation) => Promise<void>;
  readonly conversationHistoryAvailable?: boolean;
  readonly writer: Pick<ToolHistoryWriter, "createSink" | "finishRun" | "resetConversation">;
  readonly reader: ToolHistoryReader;
  /** Collapse a physical rollover bucket into its current logical session. */
  readonly logicalConversationId: (conversationId: string) => string;
  /** Release this harness's process-global writer reference on disposal. */
  readonly release?: () => Promise<void>;
}
