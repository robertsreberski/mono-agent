export const API_VERSION = 1 as const;

export type WebTheme = "evergreen" | "ocean" | "plum" | "terracotta";

export interface ConsoleIdentity {
  readonly hostName: string;
  readonly theme: WebTheme;
}

export interface PushBootstrap {
  readonly applicationServerKey: string;
  readonly keyFingerprint: string;
  readonly serviceWorkerVersion: 2;
}

export interface PushSubscriptionStatus {
  readonly id: string;
  readonly state: "active" | "disabled" | "expired";
  readonly keyFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSuccessAt?: string;
  readonly lastErrorAt?: string;
  readonly lastErrorCode?: string;
}

export type AgentStatus = "online" | "offline" | "degraded";
export type NotificationTriggerKind = "cron" | "webhook";
export type ProcessJobState =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_failed"
  | "queue_expired"
  | "interrupted";

export interface ProcessJobProjection {
  readonly schema: "mono-agent.process-job-projection.v1";
  readonly jobId: string;
  readonly tool: "Exec" | "Bash";
  readonly state: ProcessJobState;
  readonly summary: string;
  readonly origin: {
    readonly conversationId: string;
    readonly channel: string;
    readonly runId: string;
    readonly historyBoundary: string;
    readonly bucket: string | null;
  };
  readonly timestamps: {
    readonly admittedAt: string;
    readonly queueDeadlineAt: string;
    readonly startedAt: string | null;
    readonly runtimeDeadlineAt: string | null;
    readonly completedAt: string | null;
  };
  readonly limits: {
    readonly maxRuntimeMs: number;
    readonly maxOutputBytes: number;
    readonly previewChars: number;
    readonly chainDepth: number;
  };
  readonly output: {
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
    readonly truncated: boolean;
    readonly preview: string;
    readonly stdoutRef: string | null;
    readonly stderrRef: string | null;
  };
  readonly wake: {
    readonly state: "pending" | "delivered" | "failed";
    readonly attempts: number;
    readonly deliveryKey: string;
    readonly lastAttemptAt: string | null;
  };
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly cancelRequested: boolean;
  readonly lastError: { readonly code: string; readonly message: string } | null;
}

export type MonitorState =
  | "starting"
  | "running"
  | "exited"
  | "timed_out"
  | "cancelled"
  | "spawn_failed"
  | "rate_limited"
  | "interrupted";

/** Secret-free Monitor state retained by the Web console for activity display. */
export interface MonitorProjection {
  readonly schema: "mono-agent.monitor-projection.v1";
  readonly monitorId: string;
  readonly state: MonitorState;
  readonly description: string;
  readonly persistent: boolean;
  readonly origin: {
    readonly conversationId: string;
    readonly channel: string;
    readonly runId: string;
    readonly bucket: string | null;
  };
  readonly timestamps: {
    readonly startedAt: string;
    readonly runtimeDeadlineAt: string | null;
    readonly lastEventAt: string | null;
    readonly completedAt: string | null;
  };
  readonly limits: {
    readonly maxRuntimeMs: number;
    readonly coalesceMs: number;
    readonly maxBatchLines: number;
    readonly maxBatchBytes: number;
    readonly chainDepth: number;
  };
  readonly counters: {
    readonly seq: number;
    readonly batchesDelivered: number;
    readonly linesObserved: number;
    readonly linesDelivered: number;
    readonly droppedLines: number;
    readonly pendingLines: number;
  };
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly cancelRequested: boolean;
  readonly lastError: { readonly code: string; readonly message: string } | null;
}
export type RunStatus =
  | "idle"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ModelOption {
  readonly effortLevels?: readonly string[];
  readonly reasoning?: boolean;
  readonly reasoningMode?: string;
  readonly label?: string;
  readonly contextWindow?: number;
  readonly provider?: string;
}

export interface AskOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface AskQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly AskOption[];
  readonly multiSelect: boolean;
}

export interface AskAnswer {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
  readonly customReply?: string;
}

export interface AskSnapshot {
  readonly interactionId: string;
  readonly message?: string;
  readonly questions: readonly AskQuestion[];
  readonly answers: readonly AskAnswer[];
  readonly activeQuestionIndex: number;
  readonly status: "pending" | "answered" | "expired" | "cancelled";
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface AskSubmissionResult {
  readonly accepted: boolean;
  readonly code?: "not_found" | "stale" | "invalid_answer";
  readonly snapshot?: AskSnapshot;
}

export interface AgentSummary {
  readonly sourceId: string;
  /**
   * Opaque token for the agent PROCESS this summary describes, mirrored from
   * `WebAgentSummary`: stable while that process lives, different once it is
   * replaced.
   *
   * A source id outlives the process behind it, so everything this console
   * caches per agent -- above all the `/v1/models` pages the model picker walks
   * -- outlives the catalog that filled it. Nothing else on this summary is
   * generation-shaped: there is no pid, no start time, and `updatedAt` is a
   * discovery heartbeat that changes while nothing has. Absent on any summary
   * an older server built.
   */
  readonly generation?: string;
  readonly label: string;
  readonly status: AgentStatus;
  readonly pinned: boolean;
  readonly health?: string;
  readonly supportsAttachments: boolean;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  readonly defaultEffort?: string;
  readonly efforts?: readonly string[];
  readonly modelOptions?: Readonly<Record<string, ModelOption>>;
  /**
   * Providers this agent supports, mirrored from `WebAgentSummary`. This is the
   * set the selector groups and filters by; `modelOptions` stays the configured
   * shortlist. A provider declared purely to widen selection appears here and
   * nowhere else, so deriving the chip list from the shortlist hides it.
   */
  readonly providers?: readonly AgentProvider[];
  readonly cron?: { readonly read: boolean; readonly actions: boolean };
  readonly supportsAskById?: boolean;
  readonly updatedAt: string;
}

export type SkillAvailability = "inlined" | "on-demand" | "unavailable";
export type SkillUnavailableReason = "not-selected" | "read-skill-disabled" | "unsupported-name";

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  readonly availability: SkillAvailability;
  readonly reference?: string;
  readonly unavailableReason?: SkillUnavailableReason;
}

export type AgentSkillRegistry =
  | {
      readonly status: "ready";
      readonly items: readonly SkillInfo[];
      readonly total: number;
      readonly truncated?: true;
    }
  | {
      readonly status: "error" | "unsupported" | "offline";
      readonly items: readonly [];
    };

/** Browser-derived states wrap the live endpoint while a refresh is in flight. */
export type SkillRegistryState =
  | AgentSkillRegistry
  | { readonly status: "loading"; readonly items: readonly [] }
  | {
      readonly status: "stale";
      readonly items: readonly SkillInfo[];
      readonly total: number;
      readonly truncated?: true;
    };

export interface RunState {
  readonly id?: string;
  readonly status: RunStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: { readonly code?: string; readonly message: string };
  readonly model?: string;
  readonly effort?: string;
}

export interface ThreadSummary {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly trigger?:
    | { readonly kind: "webhook" }
    | { readonly kind: "cron"; readonly jobId?: string; readonly configured?: boolean };
  readonly lastMessagePreview?: string;
  readonly messageCount: number;
  readonly runState: RunState;
  readonly canSend: boolean;
  readonly canUpload: boolean;
  /** Per-conversation model override, or null when the agent default applies. */
  readonly runModel?: string | null;
  /** Per-conversation effort override, or null when the agent default applies. */
  readonly runEffort?: string | null;
}

export type ToolCallStatus = "running" | "complete" | "failed";

export interface SessionToolHistoryMetadata {
  readonly recordId?: string;
  readonly sequence?: number;
  readonly persistence: "persisted" | "failed";
  readonly terminalState?: "success" | "rejected" | "error" | "exit_nonzero" | "timeout" | "signal" | "cancelled" | "interrupted";
  readonly truncated?: boolean;
  readonly originalBytes?: number;
  readonly retainedBytes?: number;
  readonly artifactReferences?: readonly { readonly id: string; readonly available: boolean }[];
  readonly errorCode?: string;
  readonly untrusted: true;
}

/**
 * Per-tool-call metadata the console renders but assistant-ui's tool-call part cannot
 * type. Both fields ride in that part's single `artifact` slot, so they are wrapped
 * together rather than competing for it.
 */
export interface ToolCallArtifact {
  readonly history?: unknown;
  readonly structuredResult?: unknown;
  readonly executionMs?: number;
}

/** One tool call, whether the agent made it or one of its subagents did. */
export interface ToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly result?: unknown;
  /**
   * An MCP tool's machine-readable result, when it returned one. `result` is the
   * model-facing text and is lossy; renderers that must reason about the outcome
   * (the AskUser card reads `interactionId`/`answered`) read this instead.
   */
  readonly structuredResult?: unknown;
  readonly status: ToolCallStatus;
  /**
   * How long the runtime spent executing the call, when it reported a timing.
   * Messages recorded before the console preserved it have none, so a missing
   * duration is normal and must never render as zero.
   */
  readonly executionMs?: number;
  readonly history?: SessionToolHistoryMetadata;
}

export type MessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | ({ readonly type: "tool-call" } & ToolCall)
  /** One `Agent` delegation and the tool calls its subagent made. */
  | {
      readonly type: "subagent";
      readonly toolCallId: string;
      readonly name: string;
      readonly label?: string;
      readonly args?: unknown;
      readonly result?: unknown;
      readonly executionMs?: number;
      /** What this delegation cost, when the runtime priced its model. */
      readonly costUsd?: number;
      readonly history?: SessionToolHistoryMetadata;
      readonly status: ToolCallStatus;
      readonly calls: readonly ToolCall[];
    }
  | {
      readonly type: "process-job";
      readonly job: ProcessJobProjection;
      readonly responseText?: string;
    }
  | {
      readonly type: "monitor-activity";
      readonly monitors: readonly {
        readonly projection: MonitorProjection;
        readonly deliveryKeys: readonly string[];
      }[];
    }
  | { readonly type: "telemetry"; readonly event: string; readonly data?: unknown }
  | { readonly type: "error"; readonly code?: string; readonly message: string }
  | {
      readonly type: "attachment";
      readonly id: string;
      readonly artifactId: string;
      readonly name: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly integrityId: string;
      readonly expiresAt?: string;
      /**
       * Stable path to the console's own durable copy, present once an image has
       * been persisted. Unlike `contentUrl` it carries no capability token and
       * never expires, so it keeps working past the agent's retention deadline
       * and while that agent is stopped.
       */
      readonly storedUrl?: string;
      /** Short-lived, exact-message URL minted by the web service. */
      readonly contentUrl?: string;
    }
  | {
      readonly type: "mcp_app";
      readonly id: string;
      readonly invocationId: string;
      readonly connectionId: string;
      readonly serverName: string;
      readonly toolName: string;
      readonly resourceUri: string;
      readonly mediaType: "text/html;profile=mcp-app";
      readonly protocolVersion: "2026-01-26" | "2025-11-21";
      readonly title?: string;
      readonly description?: string;
      readonly expiresAt?: string;
      /** Short-lived, exact-message endpoints minted by the web service. */
      readonly resourceUrl?: string;
      readonly bridgeUrl?: string;
    }
  | {
      readonly type: "failure";
      readonly id: string;
      readonly code: string;
      readonly message: string;
      readonly relatedPartId?: string;
    };

export type McpAppPart = Extract<MessagePart, { readonly type: "mcp_app" }>;

export interface McpAppResource {
  readonly app: McpAppPart;
  readonly html: string;
  readonly toolInput?: unknown;
  readonly toolResult?: unknown;
  readonly resourceMetadata?: Readonly<Record<string, unknown>>;
  readonly connected: boolean;
}

export interface WebAttachment {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly kind: "image" | "document";
  readonly status: "staged" | "committed";
  readonly uploaded: boolean;
  readonly createdAt: string;
  readonly contentUrl?: string;
}

export interface WebMessage {
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly quote?: WebQuote;
  readonly parts: readonly MessagePart[];
  readonly attachments: readonly WebAttachment[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * When the turn that produced this assistant message reached a terminal state
   * (complete, failed, cancelled or interrupted). `createdAt` is that turn's
   * start, so the pair is the turn's wall-clock window. Absent while the turn
   * runs, on user and system rows, and on assistant rows with no turn.
   */
  readonly finishedAt?: string;
  readonly status: "running" | "complete" | "failed" | "cancelled" | "interrupted";
  readonly liveInputStatus?: "pending" | "applied" | "queued" | "cancelled";
}

export interface WebQuote {
  readonly text: string;
  readonly messageId: string;
}

export interface ThreadDetail {
  readonly thread: ThreadSummary;
  readonly messages: readonly WebMessage[];
  readonly messagesNextCursor?: string;
}

export interface ThreadPage {
  readonly threads: readonly ThreadSummary[];
  readonly nextCursor?: string;
}

/** One conversation that matched a search, with the evidence for the match. */
export interface ThreadSearchHit {
  readonly thread: ThreadSummary;
  /**
   * The best-ranked matching message, with each match wrapped in the
   * `SEARCH_HIGHLIGHT_*` sentinels. Absent when only the title matched.
   */
  readonly snippet?: string;
  /**
   * Matching messages inside the server's bounded scan window, so a very common
   * term reports the window figure rather than a true total.
   */
  readonly messageMatches: number;
  readonly titleMatch: boolean;
}

export interface ThreadSearchPage {
  readonly hits: readonly ThreadSearchHit[];
  /** Some matches were cut: the counts and the list are a bounded view. */
  readonly truncated: boolean;
}

export interface MessagePage {
  readonly messages: readonly WebMessage[];
  readonly nextCursor?: string;
}

export type CronRunStatus =
  | "admitted" | "running" | "queued" | "succeeded" | "failed" | "cancelled"
  | "skipped_overlap" | "dropped";
export type CronHealth = "healthy" | "warning" | "unhealthy" | "disabled" | "unknown";

export interface CronRun {
  readonly projection: "summary";
  readonly runId: string;
  readonly jobId: string;
  readonly scheduledAt: string;
  readonly orderedAt: string;
  readonly sequence: number;
  readonly trigger: "scheduled" | "manual";
  readonly status: CronRunStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly artifactRunId?: string;
  readonly text?: string;
  readonly error?: string;
  readonly failureKind?: string;
  readonly blockedByRunId?: string;
  readonly blockedByTrigger?: "scheduled" | "manual";
  readonly queueDepth?: number;
  readonly eventCount: number;
  readonly fieldsTruncated?: readonly ("artifactRunId" | "error" | "failureKind" | "text")[];
  readonly eventsTruncated?: true;
}

export interface CronJob {
  readonly jobId: string;
  readonly expression?: string;
  readonly timezone?: string;
  readonly conversationId: string;
  readonly configured: boolean;
  readonly declaredEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly nextRunAt?: string;
  readonly health: CronHealth;
  readonly lastRun?: CronRun;
  readonly activeRunId?: string;
  readonly threadId: string;
}

export interface CronOverview {
  readonly generatedAt: string;
  readonly actionsEnabled: boolean;
  readonly jobs: readonly CronJob[];
  readonly degradedReason?: string;
  readonly jobsTruncated?: true;
}

export interface CronRunPage {
  readonly runs: readonly CronRun[];
  readonly nextCursor?: string;
  readonly messages?: readonly WebMessage[];
}

export interface CronConfirmation {
  readonly token: string;
  readonly expiresAt: string;
  readonly message: string;
}

export type CronMutationResult<T> =
  | { readonly kind: "confirmation_required"; readonly confirmation: CronConfirmation }
  | { readonly kind: "completed"; readonly value: T; readonly replayed: boolean };

export interface ChannelConfigView {
  readonly id: string;
  readonly label: string;
  readonly status: "active" | "disabled";
  readonly fields: readonly {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly source: "env" | "json" | "default";
    readonly redacted?: boolean;
    readonly envKey?: string;
  }[];
}

export interface UploadLimits {
  readonly maxFileBytes: number;
  readonly maxFilesPerTurn: number;
  readonly maxTurnBytes: number;
  readonly accept: readonly string[];
}

export interface Bootstrap {
  readonly version: typeof API_VERSION;
  readonly console: ConsoleIdentity;
  readonly push: PushBootstrap;
  /** Every discovered agent: the rail shows all of them at once. */
  readonly agents: readonly AgentSummary[];
  /** One page of ONE (agent, archived) bucket -- the one `threadsSourceId` names. */
  readonly threads: readonly ThreadSummary[];
  /** The bucket `threads` came from, or `null` when there is no agent to open on. */
  readonly threadsSourceId: string | null;
  /** Keyset cursor for the next older page of that bucket, or `null` at its end. */
  readonly threadsNextCursor: string | null;
  readonly currentThreadId?: string;
  readonly limits: UploadLimits;
}

export interface WebEvent {
  readonly id: string;
  readonly version: typeof API_VERSION;
  readonly type:
    | "ready"
    | "agents.changed"
    | "cron.changed"
    | "threads.changed"
    | "thread.changed"
    | "message.changed"
    | "turn.changed"
    | "attachment.changed"
    | "push.pending";
  readonly at: string;
  readonly threadId?: string;
  readonly payload?: unknown;
}

export interface ModelCatalogPage {
  readonly models: readonly CatalogModel[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
}

/** One model served by an agent's lazy `/v1/models` catalog endpoint. */
export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  readonly configured?: true;
}

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
  readonly effortLevels?: readonly string[];
  readonly reasoningMode?: string;
}

export interface StartTurnInput {
  readonly text?: string;
  readonly quote?: WebQuote;
  readonly attachmentIds?: readonly string[];
  readonly model?: string;
  readonly effort?: string;
}

export interface LiveInputReceipt {
  readonly message: WebMessage;
  readonly disposition: "pending" | "queued";
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxFilesPerTurn: 10,
  maxTurnBytes: 64 * 1024 * 1024,
  accept: [],
};
