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
  readonly expiresAt: string;
}

export interface AskSubmissionResult {
  readonly accepted: boolean;
  readonly code?: "not_found" | "stale" | "invalid_answer";
  readonly snapshot?: AskSnapshot;
}

export interface AgentSummary {
  readonly sourceId: string;
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
  readonly agents: readonly AgentSummary[];
  readonly threads: readonly ThreadSummary[];
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
