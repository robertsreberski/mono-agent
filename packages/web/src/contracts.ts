import {
  AGENT_LIVE_INPUT_MAX_MESSAGES,
  type AgentReplyMcpAppPart,
  type AgentReplyPartFailure,
  type CronOperatorHealth,
  type CronOperatorJob,
  type CronOperatorOverview,
  type CronOperatorRun,
  type CronOperatorRunBase,
  type CronOperatorRunDetail,
  type CronOperatorRunPage,
  type CronOperatorRunStatus,
  type CronOperatorRunSummary,
  type CronOperatorRunTrigger,
  type CronOperatorRunTruncatedField,
  type SessionToolHistoryEventMetadata,
  type MonitorProjection,
  type ProcessJobProjection,
} from "@mono-agent/agent-contracts";

/** Machine-readable discovery contract consumed by local ACP clients such as Worklab. */
export const ACP_BRIDGE_DISCOVERY_SCHEMA = "mono-agent.acp-discovery.v1" as const;
export const ACP_BRIDGE_SOURCE_SCHEMA = "mono-agent.acp-source.v1" as const;
export const ACP_BRIDGE_VERSION = 1 as const;
export const ACP_PROTOCOL_VERSION = 1 as const;

export type AcpBridgeSourceHealth = "running" | "stale" | "stopped" | "failed";

export interface AcpBridgeSourceDescriptor {
  readonly schema: typeof ACP_BRIDGE_SOURCE_SCHEMA;
  /** Version published by this running source; clients compare it with ACP_BRIDGE_VERSION. */
  readonly bridgeVersion: number;
  /** ACP protocol version published by this running source. */
  readonly protocolVersion: number;
  readonly installedVersion: string;
  readonly sourceId: string;
  readonly label: string;
  readonly health: AcpBridgeSourceHealth;
  readonly compatible: boolean;
  readonly workspace: {
    readonly path: string;
    readonly owner: "agent";
  };
  readonly ownership: {
    readonly configuration: "agent";
    readonly workspace: "agent";
    readonly mcp: "agent";
  };
  readonly constraints: {
    readonly promptContent: readonly ["text", "resource_link"];
    readonly clientMcp: false;
    readonly clientFilesystem: false;
    readonly clientTerminal: false;
    readonly attachments: false;
    readonly additionalDirectories: false;
  };
  readonly warnings: readonly string[];
}

export interface AcpBridgeDiscovery {
  readonly schema: typeof ACP_BRIDGE_DISCOVERY_SCHEMA;
  readonly bridgeVersion: typeof ACP_BRIDGE_VERSION;
  readonly protocolVersion: typeof ACP_PROTOCOL_VERSION;
  readonly sources: readonly AcpBridgeSourceDescriptor[];
}

/** Version of the browser-facing JSON and SSE contract. */
export const WEB_API_VERSION = 1 as const;

/** Curated console themes accepted by the server, CLI, and browser client. */
export const WEB_THEMES = ["evergreen", "ocean", "plum", "terracotta"] as const;
export type WebTheme = (typeof WEB_THEMES)[number];
export const DEFAULT_WEB_THEME: WebTheme = "evergreen";

export const WEB_MAX_FILES_PER_TURN = 10;
export const WEB_MAX_TURN_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const WEB_STAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const WEB_MAX_STAGED_UPLOAD_BYTES = 256 * 1024 * 1024;
export const WEB_MAX_STAGED_UPLOADS = 100;
export const WEB_MAX_CONCURRENT_UPLOADS = 4;
export const WEB_MAX_ACTIVE_ATTACHMENT_TURN_BYTES = 64 * 1024 * 1024;
export const WEB_MAX_QUEUED_ATTACHMENT_TURNS = 32;
export const WEB_MAX_TURN_TEXT_CHARACTERS = 200_000;
export const WEB_MAX_LIVE_INPUTS_PER_THREAD = AGENT_LIVE_INPUT_MAX_MESSAGES;

export type WebAgentStatus = "online" | "offline" | "degraded";
export type WebThreadNotificationTriggerKind = "cron" | "webhook";
export type WebNotificationTriggerKind = WebThreadNotificationTriggerKind | "job" | "monitor";

export type WebThreadTrigger =
  | { readonly kind: "webhook" }
  | {
      readonly kind: "cron";
      readonly jobId?: string;
      /** False keeps historical channel history visible after the job leaves config. */
      readonly configured?: boolean;
    };

export interface WebCronCapability {
  readonly read: boolean;
  readonly actions: boolean;
}

export interface WebModelOption {
  readonly effortLevels?: readonly string[];
  readonly reasoning?: boolean;
  readonly reasoningMode?: string;
  readonly label?: string;
  readonly contextWindow?: number;
}

export interface WebAgentSummary {
  readonly sourceId: string;
  /**
   * Opaque token for the agent PROCESS this summary describes: stable while
   * that process lives, different once it is replaced. Additive, and additive
   * only -- no client is required to read it.
   *
   * A source id outlives the process behind it, so anything a client caches
   * per agent (the `/v1/models` pages the model picker fetches, above all)
   * outlives the catalog that filled it. The console's server already scopes
   * its own catalog cache this way; before this field the browser had nothing
   * generation-shaped to observe at all -- no pid, no start time, and an
   * `updatedAt` that is a discovery heartbeat -- so a tab kept offering a
   * restarted agent's retired models until it was reloaded.
   *
   * Absent on any summary not built from a live discovery pass.
   */
  readonly generation?: string;
  readonly label: string;
  readonly status: WebAgentStatus;
  readonly pinned?: boolean;
  readonly health?: string;
  readonly supportsAttachments: boolean;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  readonly defaultEffort?: string;
  readonly efforts?: readonly string[];
  readonly modelOptions?: Readonly<Record<string, WebModelOption>>;
  /**
   * Providers this agent supports. `models`/`modelOptions` stay the configured
   * shortlist; this is what the selector groups and filters by, and what tells
   * a client which providers are worth requesting a `/v1/models` page for.
   * Absent when the agent predates the provider catalog.
   */
  readonly providers?: readonly WebAgentProvider[];
  /** Absent when the addressed agent predates first-class cron operator routes. */
  readonly cron?: WebCronCapability;
  readonly supportsAskById?: boolean;
  readonly updatedAt: string;
}

export type WebSkillAvailability = "inlined" | "on-demand" | "unavailable";
export type WebSkillUnavailableReason = "not-selected" | "read-skill-disabled" | "unsupported-name";

export interface WebSkillInfo {
  readonly name: string;
  readonly description: string;
  readonly availability: WebSkillAvailability;
  readonly reference?: string;
  readonly unavailableReason?: WebSkillUnavailableReason;
}

export type WebSkillRegistry =
  | {
      readonly status: "ready";
      readonly items: readonly WebSkillInfo[];
      readonly total: number;
      readonly truncated?: true;
    }
  | {
      readonly status: "error" | "unsupported" | "offline";
      readonly items: readonly [];
    };

export type WebRunStatus =
  | "idle"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface WebRunState {
  readonly id?: string;
  readonly status: WebRunStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: { readonly code?: string; readonly message: string };
  readonly model?: string;
  readonly effort?: string;
}

export interface WebThread {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly trigger?: WebThreadTrigger;
  readonly lastMessagePreview?: string;
  readonly messageCount: number;
  readonly runState: WebRunState;
  readonly canSend: boolean;
  readonly canUpload: boolean;
  /** Per-conversation model override, or null when the agent default applies. */
  readonly runModel: string | null;
  /** Per-conversation effort override, or null when the agent default applies. */
  readonly runEffort: string | null;
}

export type WebMessageStatus = "running" | "complete" | "failed" | "cancelled" | "interrupted";

export type WebToolCallStatus = "running" | "complete" | "failed";

/** One tool call, whether the agent made it or one of its subagents did. */
export interface WebToolCall {
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
  readonly status: WebToolCallStatus;
  /**
   * How long the runtime spent executing the call, when it reported a timing.
   * Historical rows recorded before the console preserved it have none, so
   * renderers must treat a missing duration as normal rather than as zero.
   */
  readonly executionMs?: number;
  /** Canonical durable-tool record metadata received on the live event. */
  readonly history?: SessionToolHistoryEventMetadata;
}

export type WebMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | ({ readonly type: "tool-call" } & WebToolCall)
  /**
   * One `Agent` delegation and the tool calls its subagent made. The children
   * are owned by the delegation rather than listed alongside it because
   * concurrent subagents interleave their events: a flat transcript would
   * shuffle several agents' work into one indistinguishable run.
   */
  | {
      readonly type: "subagent";
      /** The parent `Agent` tool call id, which every child event carries. */
      readonly toolCallId: string;
      /** The subagent profile that ran. */
      readonly name: string;
      /** The model's short label for this task, when it supplied one. */
      readonly label?: string;
      readonly args?: unknown;
      readonly result?: unknown;
      readonly executionMs?: number;
      /** What this delegation cost, when the runtime priced its model. */
      readonly costUsd?: number;
      /** Metadata for the persisted parent `Agent` call; child internals omit it. */
      readonly history?: SessionToolHistoryEventMetadata;
      readonly status: WebToolCallStatus;
      readonly calls: readonly WebToolCall[];
    }
  | {
      readonly type: "process-job";
      readonly job: ProcessJobProjection;
      /** Bounded normal-turn answer produced by the terminal wake, when ready. */
      readonly responseText?: string;
    }
  | {
      readonly type: "monitor-activity";
      /** One compact run-level row, with one latest projection per Monitor. */
      readonly monitors: readonly {
        readonly projection: MonitorProjection;
        /** Exact delivered wake identities, retained only for idempotent UI aggregation. */
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
      /** Short-lived, message-bound URL added only to browser DTOs. */
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
      readonly protocolVersion: AgentReplyMcpAppPart["protocolVersion"];
      readonly title?: string;
      readonly description?: string;
      readonly expiresAt?: string;
      /** Short-lived, message-bound host endpoints added only to browser DTOs. */
      readonly resourceUrl?: string;
      readonly bridgeUrl?: string;
    }
  | {
      readonly type: "failure";
      readonly id: string;
      readonly code: AgentReplyPartFailure["code"];
      readonly message: string;
      readonly relatedPartId?: string;
    };

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
  readonly parts: readonly WebMessagePart[];
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
  readonly status: WebMessageStatus;
  readonly liveInputStatus?: "pending" | "applied" | "queued" | "cancelled";
}

export interface WebQuote {
  readonly text: string;
  readonly messageId: string;
}

export interface WebThreadDetail {
  readonly thread: WebThread;
  readonly messages: readonly WebMessage[];
  /** Opaque keyset cursor for the next older message page. */
  readonly messagesNextCursor?: string;
}

export interface WebThreadPage {
  readonly threads: readonly WebThread[];
  readonly nextCursor?: string;
}

export interface WebMessagePage {
  readonly messages: readonly WebMessage[];
  readonly nextCursor?: string;
}

/** One conversation that matched a search, with the evidence for the match. */
export interface WebThreadSearchHit {
  readonly thread: WebThread;
  /**
   * The best-ranked matching message, with each match wrapped in the
   * `WEB_SEARCH_HIGHLIGHT_*` sentinels. Absent when only the title matched.
   */
  readonly snippet?: string;
  /**
   * Matching messages inside the bounded scan window, so a term used hundreds
   * of times reports the window figure rather than the true total.
   */
  readonly messageMatches: number;
  readonly titleMatch: boolean;
}

export interface WebThreadSearchPage {
  readonly hits: readonly WebThreadSearchHit[];
  /** Some matches were cut: the counts and the list are a bounded view. */
  readonly truncated: boolean;
}

export interface SearchWebThreadsInput {
  readonly sourceId: string;
  readonly query: string;
  readonly limit?: number;
}

export type WebCronRunTrigger = CronOperatorRunTrigger;
export type WebCronRunStatus = CronOperatorRunStatus;
export type WebCronHealth = CronOperatorHealth;
export type WebCronRunTruncatedField = CronOperatorRunTruncatedField;
export type WebCronRunBase = CronOperatorRunBase;
export type WebCronRunSummary = CronOperatorRunSummary;
export type WebCronRunDetail = CronOperatorRunDetail;
export type WebCronRun = CronOperatorRun;

export interface WebCronJob extends CronOperatorJob {
  readonly threadId: string;
}

export interface WebCronOverview extends Omit<CronOperatorOverview, "jobs"> {
  readonly jobs: readonly WebCronJob[];
}

export interface WebCronRunPage extends CronOperatorRunPage {
  /** Canonical messages reconciled by the web backend for this page. */
  readonly messages?: readonly WebMessage[];
}

/** One provider an agent advertises as supported. */
export interface WebAgentProvider {
  readonly id: string;
  readonly label: string;
  /** The agent declared this provider or routes through it. */
  readonly configured?: true;
}

/** One model served by the lazy agent `/v1/models` catalog endpoint. */
export interface WebCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
  readonly effortLevels?: readonly string[];
  readonly reasoningMode?: string;
}

/** A bounded model-catalog page proxied from an agent's `/v1/models` endpoint. */
export interface WebModelPage {
  readonly models: readonly WebCatalogModel[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
}

export interface WebCronConfirmation {
  readonly token: string;
  readonly expiresAt: string;
  readonly message: string;
}

export type WebCronMutationResult<T> =
  | { readonly kind: "confirmation_required"; readonly confirmation: WebCronConfirmation }
  | { readonly kind: "completed"; readonly value: T; readonly replayed: boolean };

export interface WebChannelConfigViewField {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly source: "env" | "json" | "default";
  readonly redacted?: boolean;
  readonly envKey?: string;
}

export interface WebChannelConfigView {
  readonly id: string;
  readonly label: string;
  readonly status: "active" | "disabled";
  readonly fields: readonly WebChannelConfigViewField[];
}

export interface WebConsoleIdentity {
  readonly hostName: string;
  readonly theme: WebTheme;
}

export interface WebPushBootstrap {
  readonly applicationServerKey: string;
  readonly keyFingerprint: string;
  readonly serviceWorkerVersion: 2;
}

export type WebPushSubscriptionState = "active" | "disabled" | "expired";

/** Secret-free projection returned by the subscription API. */
export interface WebPushSubscriptionStatus {
  readonly id: string;
  readonly state: WebPushSubscriptionState;
  readonly keyFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSuccessAt?: string;
  readonly lastErrorAt?: string;
  readonly lastErrorCode?: string;
}

export interface WebBootstrap {
  readonly version: typeof WEB_API_VERSION;
  readonly console: WebConsoleIdentity;
  readonly push: WebPushBootstrap;
  readonly agents: readonly WebAgentSummary[];
  readonly threads: readonly WebThread[];
  readonly currentThreadId?: string;
  readonly limits: {
    readonly maxFileBytes: number;
    readonly maxFilesPerTurn: number;
    readonly maxTurnBytes: number;
    readonly accept: readonly string[];
  };
}

export type WebEventType =
  | "ready"
  | "agents.changed"
  | "cron.changed"
  | "threads.changed"
  | "thread.changed"
  | "message.changed"
  | "turn.changed"
  | "attachment.changed"
  | "push.pending";

export interface WebEvent {
  readonly id: string;
  readonly version: typeof WEB_API_VERSION;
  readonly type: WebEventType;
  readonly at: string;
  readonly threadId?: string;
  /** Event-specific detail. `agents.changed` omits this and invalidates the bootstrap snapshot. */
  readonly payload?: unknown;
}

export interface CreateWebThreadInput {
  readonly sourceId: string;
}

export interface PatchWebAgentInput {
  readonly pinned: boolean;
}

export interface PatchWebThreadInput {
  readonly title?: string;
  readonly archived?: boolean;
  readonly model?: string | null;
  readonly effort?: string | null;
  /**
   * Compare-and-set: apply nothing unless this conversation still has NO run
   * override. The console's one-time adoption of a browser-local preference
   * reads the thread and then writes it, and between those two calls another
   * tab (or another device) can set a real override -- an unconditional write
   * then makes the adopting tab's stale local value the final server state.
   * The precondition is checked and the write applied in one synchronous step,
   * so nothing can interleave. When it does not hold the current thread comes
   * back untouched, which is exactly what the caller must adopt.
   */
  readonly ifRunConfigUnset?: boolean;
}

export interface StartWebTurnInput {
  readonly text?: string;
  readonly quote?: WebQuote;
  readonly attachmentIds?: readonly string[];
  readonly model?: string;
  readonly effort?: string;
}

export interface StartWebLiveInputInput {
  readonly text: string;
}

export interface WebLiveInputReceipt {
  readonly message: WebMessage;
  readonly disposition: "pending" | "queued";
}

export interface CreateWebUploadInput {
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes?: number;
}
