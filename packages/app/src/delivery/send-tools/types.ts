import type { SlackWebApi } from "@mono-agent/channel-slack";
import type { TelegramMessageSender } from "@mono-agent/channel-telegram";

import type { MonoAgentAppConfigInput } from "../../app-config.js";
import type { FileIdentity } from "./file-identity.js";

export interface SlackSendToolSettings {
  readonly botToken: string;
  readonly allowedChannelIds: readonly string[];
  readonly allowAllChannels: boolean;
}

export interface TelegramSendToolSettings {
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly allowAllChats: boolean;
  /** Self-hosted Bot API base URL (also unlocks file:// for non-strict path uploads). */
  readonly apiRoot?: string;
  /** Upload cap for the TelegramSendFile tool; the resolver fills the 20 MiB default. */
  readonly maxUploadBytes?: number;
  /** Which telegram tools the policy permits (the adapter config gates the rest). */
  readonly tools: {
    readonly send: boolean;
    /** The single TelegramSendFile tool (document + photo via a `kind` param). */
    readonly file: boolean;
  };
  readonly sendTools?: {
    readonly scope?: "producing-conversation";
    readonly pathScope?: "run-output";
  };
  /** Trusted exact request conversation, injected by the app-owned parent. */
  readonly producingConversationId?: string;
  /** Trusted current-run output directory, injected by the app-owned parent. */
  readonly runOutputDir?: string;
  /** Identity of the app-created directory object; prevents root path swaps. */
  readonly runOutputIdentity?: FileIdentity;
  /** `telegram.projects` is enabled: sends may address a project's forum topic by `projectId`. */
  readonly projects?: boolean;
}

/**
 * Blocking ask-the-user tool, backed by the app's interaction bridge. Channel
 * agnostic: the tool only talks to the bridge; the bridge posts the question
 * through whichever channel sink owns the conversation. `conversationId` is
 * present only in the spawned child (from the per-request env) — without it the
 * tool has no target and is not registered.
 */
export interface AskUserToolSettings {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly timeoutMs: number | null;
  readonly producerConversationId?: string;
  readonly interactionConversationId?: string;
  readonly runId?: string;
}

export interface AdapterSendToolsSettings {
  readonly slack?: SlackSendToolSettings;
  readonly telegram?: TelegramSendToolSettings;
  readonly askUser?: AskUserToolSettings;
}

export interface AdapterSendToolsClients {
  readonly slack?: Pick<SlackWebApi, "chatPostMessage">;
  readonly telegram?: Partial<Pick<TelegramMessageSender, "sendMessage" | "sendDocument" | "sendPhoto">>;
}

export interface AdapterSendToolsHttpOptions {
  readonly fetchImpl?: typeof fetch;
  readonly deliveryHistory?: AdapterSendToolsDeliveryHistory;
}

export interface AdapterSendToolsDeliveryHistory {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
}

export interface AdapterSendToolsDeliveryHistoryCapabilityIssuer {
  issueDeliveryHistoryCapability(input: {
    readonly runId: string;
    readonly producerConversationId: string;
    readonly allowedChannels: readonly ("slack" | "telegram")[];
  }): { readonly url: string; readonly token: string; release(): void };
}

export interface AdapterSendToolsRuntimeExtension {
  readonly runtimeOptions: {
    readonly mcpServers: Record<string, unknown>;
    readonly mcpCallNoTotalTimeoutTools?: readonly string[];
    readonly hostCapabilities?: import("@mono-agent/turn/host/types").RuntimeRunOptions["hostCapabilities"];
  };
  readonly cleanup: () => Promise<void>;
  readonly settleCleanup?: () => Promise<void>;
}

/**
 * Where a posted message should be linked back to its producing conversation.
 * Forwarded to the stdio child so `SlackSendMessage` can record
 * `(channel, ts) → conversationId` — see {@link appendPostedMessage}.
 */
export interface AdapterSendToolsIndexing {
  readonly conversationId: string;
  readonly indexPath: string;
}

/** Minimal shape of the per-request runtime-options input we read. */
export interface AdapterSendToolsRequestInput {
  readonly request?: {
    readonly conversationId?: string;
    readonly replyTo?: { readonly conversationId?: string };
  };
  readonly runId?: string;
}

export interface AdapterSendToolsResolveOptions {
  readonly allowedTools?: readonly string[] | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
  readonly logger?: {
    warn?: (message: string, metadata?: Record<string, unknown>) => void;
  } | undefined;
  /** Suppress bridge-backed AskUser for MCP-incompatible routes. */
  readonly suppressInteractionTools?: boolean | undefined;
  /** App-owned master bridge settings; never sourced from project MCP config. */
  readonly interaction?: AdapterSendToolsInteractionEnv | undefined;
}

/**
 * Per-request context forwarded to the stdio child. `conversationId` alone
 * targets AskUser at the producing conversation; `indexPath` additionally
 * enables the posted-message index (Slack reply continuity).
 */
export interface AdapterSendToolsChildContext {
  readonly conversationId?: string;
  readonly interactionConversationId?: string;
  readonly runId?: string;
  readonly indexPath?: string;
  readonly runOutputDir?: string;
  readonly runOutputIdentity?: FileIdentity;
  readonly deliveryHistory?: AdapterSendToolsDeliveryHistory;
}

export interface AdapterSendToolsInteractionEnv {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly timeoutMs: number | null;
}

export interface AdapterSendToolsChildConfig {
  readonly input: MonoAgentAppConfigInput;
  readonly allowedTools: readonly string[];
  readonly indexing?: AdapterSendToolsIndexing;
  readonly deliveryHistory?: AdapterSendToolsDeliveryHistory;
}

export type SlackAdapterModule = typeof import("@mono-agent/channel-slack");
export type TelegramAdapterModule = typeof import("@mono-agent/channel-telegram");
