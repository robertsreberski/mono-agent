import { AGENT_LIVE_INPUT_MAX_MESSAGES } from "@mono-agent/agent-contracts";

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
export type WebNotificationTriggerKind = "cron" | "webhook";

export interface WebThreadTrigger {
  readonly kind: WebNotificationTriggerKind;
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
}

export type WebMessageStatus = "running" | "complete" | "failed" | "cancelled" | "interrupted";

export type WebToolCallStatus = "running" | "complete" | "failed";

/** One tool call, whether the agent made it or one of its subagents did. */
export interface WebToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly status: WebToolCallStatus;
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
      readonly status: WebToolCallStatus;
      readonly calls: readonly WebToolCall[];
    }
  | { readonly type: "telemetry"; readonly event: string; readonly data?: unknown }
  | { readonly type: "error"; readonly code?: string; readonly message: string };

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
