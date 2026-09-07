// Wire types belong to the producer. These type-only references never load
// server modules into the browser bundle.
import type * as Wire from "../../src/contracts";
import type {
  AgentMcpAppResource,
  ChannelAskOption,
  ChannelAskQuestion,
  ChannelAskAnswer,
  ChannelAskSnapshot,
  ChannelAskSubmissionResult,
  SessionToolHistoryEventMetadata,
} from "@mono-agent/agent-contracts";

export type {
  ProcessJobState,
  ProcessJobProjection,
  MonitorState,
  MonitorProjection,
  ProviderAuthMethod,
  ProviderAuthProviderStatus,
  ProviderAuthStatusSnapshot,
  ProviderAuthSessionSnapshot,
} from "@mono-agent/agent-contracts";

export const API_VERSION: typeof Wire.WEB_API_VERSION = 1;

export type WebTheme = Wire.WebTheme;
export type ConsoleIdentity = Wire.WebConsoleIdentity;
export type PushBootstrap = Wire.WebPushBootstrap;
export type PushSubscriptionStatus = Wire.WebPushSubscriptionStatus;
export type AgentStatus = Wire.WebAgentStatus;
export type NotificationTriggerKind = Wire.WebThreadNotificationTriggerKind;
export type RunStatus = Wire.WebRunStatus;
export type ModelOption = Wire.WebModelOption;
export type RunSettingSource = Wire.WebRunSettingSource;
export type AgentRunSettings = Wire.WebAgentRunSettings;
export type AgentSummary = Wire.WebAgentSummary;
export type SkillAvailability = Wire.WebSkillAvailability;
export type SkillUnavailableReason = Wire.WebSkillUnavailableReason;
export type SkillInfo = Wire.WebSkillInfo;
export type AgentSkillRegistry = Wire.WebSkillRegistry;
export type RunSelection = Wire.WebRunSelection;
export type RunExecution = Wire.WebRunExecution;
export type RunTransition = Wire.WebRunTransition;
export type RunRetry = Wire.WebRunRetry;
export type RunAttribution = Wire.WebRunAttribution;
export type RunState = Wire.WebRunState;
export type JobActivity = Wire.WebJobActivity;
export type ToolCallStatus = Wire.WebToolCallStatus;
export type ToolCall = Wire.WebToolCall;
export type MessagePart = Wire.WebMessagePart;
export type WebAttachment = Wire.WebAttachment;
export type WebQuote = Wire.WebQuote;
export type MessageDeltaOp = Wire.WebMessageDeltaOp;
export type MessageDelta = Wire.WebMessageDelta;
export type CronRunStatus = Wire.WebCronRunStatus;
export type CronHealth = Wire.WebCronHealth;
export type CronRun = Wire.WebCronRunSummary;
export type CronJob = Wire.WebCronJob;
export type CronOverview = Wire.WebCronOverview;
export type WebEvent = Wire.WebEvent;
export type ModelCatalogPage = Wire.WebModelPage;
export type AgentProvider = Wire.WebAgentProvider;
export type CatalogModel = Wire.WebCatalogModel;
export type StartTurnInput = Wire.StartWebTurnInput;

export type AskOption = ChannelAskOption;
export type AskQuestion = ChannelAskQuestion;
export type AskAnswer = ChannelAskAnswer;
export type AskSnapshot = ChannelAskSnapshot;
export type AskSubmissionResult = ChannelAskSubmissionResult;
export type SessionToolHistoryMetadata = SessionToolHistoryEventMetadata;
export type UploadLimits = Wire.WebBootstrap["limits"];

// Locally minted optimistic messages and persisted caches can predate these
// server fields. Keep that browser compatibility explicit and narrowly scoped.
export type ThreadSummary = Omit<Wire.WebThread, "runModel" | "runEffort">
  & Partial<Pick<Wire.WebThread, "runModel" | "runEffort">>;
export type WebMessage = Omit<Wire.WebMessage, "seq"> & Partial<Pick<Wire.WebMessage, "seq">>;
export type ThreadDetail = Omit<Wire.WebThreadDetail, "thread" | "messages"> & {
  readonly thread: ThreadSummary;
  readonly messages: readonly WebMessage[];
};
export type ThreadPage = Omit<Wire.WebThreadPage, "threads"> & { readonly threads: readonly ThreadSummary[] };
export type ThreadSearchHit = Omit<Wire.WebThreadSearchHit, "thread"> & { readonly thread: ThreadSummary };
export type ThreadSearchPage = Omit<Wire.WebThreadSearchPage, "hits"> & { readonly hits: readonly ThreadSearchHit[] };
export type MessagePage = Omit<Wire.WebMessagePage, "messages"> & { readonly messages: readonly WebMessage[] };
export type CronRunPage = Omit<Wire.WebCronRunPage, "messages"> & { readonly messages?: readonly WebMessage[] };
export type Bootstrap = Omit<Wire.WebBootstrap, "threads"> & { readonly threads: readonly ThreadSummary[] };
export type LiveInputReceipt = Omit<Wire.WebLiveInputReceipt, "message"> & { readonly message: WebMessage };

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

/**
 * Per-tool-call metadata the console renders but assistant-ui's tool-call part cannot
 * type. Both fields ride in that part's single `artifact` slot, so they are wrapped
 * together rather than competing for it.
 */
export interface ToolCallArtifact {
  readonly history?: unknown;
  readonly structuredResult?: unknown;
  readonly executionMs?: number;
  /** See {@link ToolCall.resultTruncated}; carried through assistant-ui's one metadata slot. */
  readonly resultTruncated?: boolean;
  readonly resultBytes?: number;
  readonly argsTruncated?: boolean;
  readonly argsBytes?: number;
}

export type McpAppPart = Extract<MessagePart, { readonly type: "mcp_app" }>;

export interface McpAppResource extends Omit<AgentMcpAppResource, "app"> {
  readonly app: McpAppPart;
  readonly connected: boolean;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxFilesPerTurn: 10,
  maxTurnBytes: 64 * 1024 * 1024,
  accept: [],
};
