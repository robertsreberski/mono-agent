import type {
  AgentResponder,
  AgentContinuationOriginContext,
  ChannelConfigViewSection,
  ChannelDriver as ContractChannelDriver,
  ChannelId as ContractChannelId,
  ChannelInteractionAnswerKind,
  ChannelLogger,
  ChannelStartInput as ContractChannelStartInput,
  RunningChannel,
} from "@mono-agent/agent-contracts";
import { NOTHING_TO_REPORT_SENTINEL } from "@mono-agent/agent-contracts";
import { AgentHarnessFailureError } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";
import type {
  CronAdapterConfig,
  CronAdapterOptions,
  CronAdapterStartResult,
  CronJobConfig,
  CronJobResult,
} from "@mono-agent/cron-adapter";
import { describeRunFailureKind } from "@mono-agent/observability";
import type {
  OpenAIApiAdapterConfig,
  OpenAIApiAdapterOptions,
  OpenAIApiAdapterStartResult,
} from "@mono-agent/openai-api-adapter";
import type {
  SlackAdapterConfig,
  SlackAdapterStartOptions,
  SlackAdapterStartResult,
} from "@mono-agent/slack-adapter";
import type {
  TelegramAdapterConfig,
  TelegramAdapterErrorTextInput,
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
  TelegramChatId,
  TelegramTranscriptionConfig,
} from "@mono-agent/telegram-adapter";
import type {
  TuiAdapterConfig,
  TuiAdapterInfo,
  TuiAdapterOptions,
  TuiAdapterStartResult,
} from "@mono-agent/operator-adapter";
import type {
  LiveAdapterConfig,
  LiveAdapterHandle,
  LiveAdapterOptions,
} from "@mono-agent/operator-adapter";
import type {
  WebhookAdapterConfig,
  WebhookAdapterOptions,
  WebhookAdapterStartResult,
  WebhookEndpointConfig,
  WebhookInvocationRequest,
  WebhookInvocationStatus,
} from "@mono-agent/webhook-adapter";
import {
  discoverLocalProviderModels,
  modelReferenceKey,
  parseMonoRuntimeModelReference,
  resolveModelEffortLevels,
} from "@mono-agent/runtime-adapter";
import type { DiscoveredLocalModel, LocalProviderDefinition } from "@mono-agent/runtime-adapter";

import { isAdapterSendToolAllowed } from "./adapter-send-tools.js";
import { isChannelConfigured } from "./channel-gate.js";
import type { ChannelGateSpec } from "./channel-gate.js";
import { buildChannelConfigView } from "./channel-config-view.js";
import {
  resolveConfiguredChannelPlugins,
} from "./channel-plugins.js";
import { findTriggerOverrideIssues } from "./trigger-overrides.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import type { NotifyDestination } from "./notify-destinations.js";
import type { NotifyDeliveryResult } from "./proactive-notify.js";
import { appendPostedMessage, lookupProducingConversation } from "./posted-message-index.js";
import { configuredRuntimeModels } from "./runtime-routes.js";

/**
 * The channel contract now lives in @mono-agent/agent-contracts (neutral,
 * dependency-free) so third-party drivers depend on the contracts package, not
 * this host. The aliases below bind the contract's core-config parameter to
 * MonoAgentConfig and preserve every historical export from this module.
 */
export type ChannelId = ContractChannelId;
export type MonoAgentAppLogger = ChannelLogger;
export type { ChannelLogger, ChannelStatus, NotifyDeliveryResult, NotifyDestination, RunningChannel } from "@mono-agent/agent-contracts";
export type ChannelStartInput<TConfig> = ContractChannelStartInput<TConfig, MonoAgentConfig>;
export type ChannelDriver<TConfig = unknown> = ContractChannelDriver<TConfig, MonoAgentConfig>;

/** Host-neutral pre-model outcome returned by a channel continuation adapter. */
export type ContinuationChannelSynthesisResult =
  | { readonly kind: "synthesized"; readonly text: string }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly reason: string;
      readonly retryAfterMs?: number;
    };

/** The channel ids this app can drive from config (third-party drivers add their own). */
export const BUILTIN_CHANNEL_IDS = [
  "telegram",
  "slack",
  "webhook",
  "openai-api",
  "cron",
  "tui",
  "live",
] as const;
export type BuiltinChannelId = (typeof BUILTIN_CHANNEL_IDS)[number];

/**
 * Built-in adapters load lazily: each module is imported only once its channel
 * passes the {@link isChannelConfigured} gate (JSON section present, a prefixed
 * env var set, or the jobs/endpoints folder existing). A webhook-only agent
 * therefore never loads the chat SDKs. A2A and WhatsApp are external channel
 * plugins; the app reaches them only when declared in `channels.plugins[]` or
 * supplied directly by programmatic callers.
 *
 * For an unconfigured channel the driver answers with the adapter loader's own
 * empty-input output (the UNCONFIGURED_* constants below) — a drift-guard test
 * asserts each constant deep-equals the real loader's result on empty input.
 */
type TelegramAdapterModule = typeof import("@mono-agent/telegram-adapter");
type SlackAdapterModule = typeof import("@mono-agent/slack-adapter");
type WebhookAdapterModule = typeof import("@mono-agent/webhook-adapter");
type OpenAIApiAdapterModule = typeof import("@mono-agent/openai-api-adapter");
type CronAdapterModule = typeof import("@mono-agent/cron-adapter");
type TuiAdapterModule = typeof import("@mono-agent/operator-adapter");

let telegramModule: TelegramAdapterModule | undefined;
let slackModule: SlackAdapterModule | undefined;
let webhookModule: WebhookAdapterModule | undefined;
let openaiApiModule: OpenAIApiAdapterModule | undefined;
let cronModule: CronAdapterModule | undefined;
let tuiModule: TuiAdapterModule | undefined;

const loadTelegramModule = async (): Promise<TelegramAdapterModule> =>
  (telegramModule ??= await import("@mono-agent/telegram-adapter"));
const loadSlackModule = async (): Promise<SlackAdapterModule> =>
  (slackModule ??= await import("@mono-agent/slack-adapter"));
const loadWebhookModule = async (): Promise<WebhookAdapterModule> =>
  (webhookModule ??= await import("@mono-agent/webhook-adapter"));
const loadOpenAIApiModule = async (): Promise<OpenAIApiAdapterModule> =>
  (openaiApiModule ??= await import("@mono-agent/openai-api-adapter"));
const loadCronModule = async (): Promise<CronAdapterModule> =>
  (cronModule ??= await import("@mono-agent/cron-adapter"));
const loadTuiModule = async (): Promise<TuiAdapterModule> =>
  (tuiModule ??= await import("@mono-agent/operator-adapter"));

type LiveAdapterModule = typeof import("@mono-agent/operator-adapter");
let liveModule: LiveAdapterModule | undefined;
const loadLiveModule = async (): Promise<LiveAdapterModule> =>
  (liveModule ??= await import("@mono-agent/operator-adapter"));

const TELEGRAM_GATE: ChannelGateSpec = { jsonKey: "telegram", envPrefix: "MONO_AGENT_TELEGRAM_" };
const SLACK_GATE: ChannelGateSpec = { jsonKey: "slack", envPrefix: "MONO_AGENT_SLACK_" };
const WEBHOOK_GATE: ChannelGateSpec = { jsonKey: "webhook", envPrefix: "MONO_AGENT_WEBHOOK_", dir: "webhook" };
const OPENAI_API_GATE: ChannelGateSpec = { jsonKey: "openaiApi", envPrefix: "MONO_AGENT_OPENAI_API_" };
const CRON_GATE: ChannelGateSpec = { jsonKey: "cron", envPrefix: "MONO_AGENT_CRON_", dir: "cron" };

const UNCONFIGURED_TELEGRAM_CONFIG: TelegramAdapterConfig = {
  enabled: false,
  botToken: "",
  allowedChatIds: [],
  allowAllChats: false,
};
const UNCONFIGURED_SLACK_CONFIG: SlackAdapterConfig = {
  enabled: false,
  botToken: "",
  appToken: "",
  allowedChannelIds: [],
  allowAllChannels: false,
  botUserIds: [],
  mentionTextAliases: [],
  stripMentionText: false,
  shortcuts: [],
  homeTab: { enabled: false, buttons: [] },
};
const UNCONFIGURED_WEBHOOK_CONFIG: WebhookAdapterConfig = {
  enabled: false,
  host: "127.0.0.1",
  port: 0,
  allowNonLoopback: false,
  retentionMs: 300_000,
  maxStoredRequests: 100,
  endpoints: [{ name: "default", path: "/webhook/invoke", mode: "sync", enabled: true }],
  path: "/webhook/invoke",
  defaultMode: "sync",
};
const UNCONFIGURED_OPENAI_API_CONFIG: OpenAIApiAdapterConfig = {
  enabled: false,
  host: "127.0.0.1",
  port: 0,
  basePath: "/v1",
  allowNonLoopback: false,
  modelId: "agent",
};
const UNCONFIGURED_CRON_CONFIG: CronAdapterConfig = { jobs: [] };

/** Config-view section for a channel the gate found no intent for (no fields to annotate). */
function unconfiguredChannelView(id: string, label: string): ChannelConfigViewSection {
  return { id, label, status: "disabled", fields: [] };
}

export interface TelegramChannelOverrides {
  readonly botFactory?: TelegramAdapterStartOptions["botFactory"];
  readonly runnerFactory?: TelegramAdapterStartOptions["runnerFactory"];
  readonly startAdapter?: (
    options: TelegramAdapterStartOptions,
  ) => Promise<TelegramAdapterStartResult>;
}

export function createTelegramChannelDriver(
  overrides: TelegramChannelOverrides = {},
): ChannelDriver<TelegramAdapterConfig> {
  return {
    id: "telegram",
    label: "Telegram",
    async configView(input) {
      if (!(await isChannelConfigured(input, TELEGRAM_GATE))) {
        return unconfiguredChannelView("telegram", "Telegram");
      }
      const adapter = await loadTelegramModule();
      return await buildChannelConfigView(this, adapter.TELEGRAM_CONFIG_FIELDS, input);
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, TELEGRAM_GATE))) {
        return UNCONFIGURED_TELEGRAM_CONFIG;
      }
      const adapter = await loadTelegramModule();
      return await adapter.loadTelegramAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return telegramModule !== undefined && error instanceof telegramModule.TelegramAdapterConfigError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Telegram is disabled.";
    },
    async start(input) {
      const adapter = await loadTelegramModule();
      const startAdapter = overrides.startAdapter ?? adapter.startTelegramAdapter;
      const result = await startAdapter(telegramStartOptions(input, overrides));
      // Register this channel's interaction sink so the host bridge can post
      // AskUser questions and tool-progress status lines into Telegram chats.
      // The sink enforces the adapter allowlist: a tool-supplied conversation
      // can never reach a chat the operator never allowlisted.
      input.interaction?.registerSink("telegram", {
        postQuestion: async (conversationId, text) => {
          await result.post(requireAllowedTelegramChat(conversationId, input), text);
        },
        postStatus: async (conversationId, text, statusOptions) => {
          await result.postStatus(requireAllowedTelegramChat(conversationId, input), text, statusOptions);
        },
      });
      return {
        summary: {},
        stop: () => result.stop(),
        // Push delivery: a proactive nudge to telegram:<chat> runs as a turn on
        // this chat's own harness and is delivered through the normal stream.
        // Enforces the adapter allowlist so a payload-supplied destination cannot
        // reach a chat the operator never allowlisted.
        notify: async (request) => {
          const { conversationId, text, verbatim } = request;
          const chatId = telegramChatIdFromConversation(conversationId);
          if (chatId === undefined) {
            input.logger?.warn?.("Telegram proactive notify skipped: unparseable destination.", { conversationId });
            return { delivered: false, reason: "unparseable telegram destination" };
          }
          if (!input.config.allowAllChats && !input.config.allowedChatIds.includes(String(chatId))) {
            input.logger?.warn?.("Telegram proactive notify skipped: destination not in allowlist.", { conversationId });
            return { delivered: false, reason: "telegram chat is not in the adapter allowlist" };
          }
          // During configured quiet hours, deliver silently (disable_notification)
          // so an overnight cron/webhook result lands without a push sound.
          const silent =
            input.config.quietHours !== undefined &&
            adapter.isWithinQuietHours(new Date(), input.config.quietHours);
          const notifyOptions =
            verbatim === undefined && !silent
              ? undefined
              : {
                  ...(verbatim === undefined ? {} : { verbatim }),
                  ...(silent ? { silent: true } : {}),
                };
          return await result.notify(chatId, text, notifyOptions);
        },
      };
    },
  };
}

/**
 * Download-path attachment options from config (`maxUploadBytes` stays with the
 * send tools, which reload the config themselves). Auto-transcription config is
 * forwarded here too so inbound audio gets an inlined transcript.
 */
function telegramAttachmentOptions(
  config: TelegramAdapterConfig,
): {
  maxBytes?: number;
  downloadTimeoutMs?: number;
  transcription?: TelegramTranscriptionConfig;
} | undefined {
  const attachments = config.attachments;
  const transcription = config.transcription;
  if (
    attachments?.maxBytes === undefined &&
    attachments?.downloadTimeoutMs === undefined &&
    transcription === undefined
  ) {
    return undefined;
  }
  return {
    ...(attachments?.maxBytes === undefined ? {} : { maxBytes: attachments.maxBytes }),
    ...(attachments?.downloadTimeoutMs === undefined ? {} : { downloadTimeoutMs: attachments.downloadTimeoutMs }),
    ...(transcription === undefined ? {} : { transcription }),
  };
}

/** Resolve + allowlist-check a `telegram:<chat>` destination for interaction-sink posts. */
function requireAllowedTelegramChat(
  conversationId: string,
  input: ChannelStartInput<TelegramAdapterConfig>,
): TelegramChatId {
  const chatId = telegramChatIdFromConversation(conversationId);
  if (chatId === undefined) {
    throw new Error(`unparseable telegram destination: ${conversationId}`);
  }
  if (!input.config.allowAllChats && !input.config.allowedChatIds.includes(String(chatId))) {
    throw new Error("telegram chat is not in the adapter allowlist.");
  }
  return chatId;
}

/** Extract the Telegram chat id from a `telegram:<chat>` conversationId (numeric ids become numbers; a rollover #bucket suffix is stripped). */
export function telegramChatIdFromConversation(conversationId: string): TelegramChatId | undefined {
  const prefix = "telegram:";
  if (!conversationId.startsWith(prefix)) {
    return undefined;
  }
  const raw = conversationId.slice(prefix.length).split("#", 1)[0]?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return /^-?\d+$/u.test(raw) ? Number(raw) : raw;
}

export interface SlackChannelOverrides {
  readonly createApi?: SlackAdapterStartOptions["createApi"];
  readonly webSocketFactory?: SlackAdapterStartOptions["webSocketFactory"];
  readonly startAdapter?: (options: SlackAdapterStartOptions) => Promise<SlackAdapterStartResult>;
}

export function createSlackChannelDriver(
  overrides: SlackChannelOverrides = {},
): ChannelDriver<SlackAdapterConfig> {
  return {
    id: "slack",
    label: "Slack",
    async configView(input) {
      if (!(await isChannelConfigured(input, SLACK_GATE))) {
        return unconfiguredChannelView("slack", "Slack");
      }
      const adapter = await loadSlackModule();
      return await buildChannelConfigView(this, adapter.SLACK_CONFIG_FIELDS, input);
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, SLACK_GATE))) {
        return UNCONFIGURED_SLACK_CONFIG;
      }
      const adapter = await loadSlackModule();
      return await adapter.loadSlackAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return slackModule !== undefined && error instanceof slackModule.SlackAdapterConfigError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Slack is disabled.";
    },
    async start(input) {
      const adapter = await loadSlackModule();
      const startAdapter = overrides.startAdapter ?? adapter.startSlackAdapter;
      // Link posted messages to their producing conversation so an in-thread reply
      // resumes that conversation instead of a fresh, history-less slack: thread.
      const indexPath = input.postedMessageIndexPath;
      // Forward the operator's optional Socket Mode resilience tuning; omitting a
      // field lets the runner apply its own default.
      const reconnect: {
        initialMs?: number;
        maxMs?: number;
        stabilityMs?: number;
        startupGraceMs?: number;
        drainDeadlineMs?: number;
      } = {};
      if (input.config.reconnectInitialBackoffMs !== undefined) reconnect.initialMs = input.config.reconnectInitialBackoffMs;
      if (input.config.reconnectMaxBackoffMs !== undefined) reconnect.maxMs = input.config.reconnectMaxBackoffMs;
      if (input.config.reconnectStabilityMs !== undefined) reconnect.stabilityMs = input.config.reconnectStabilityMs;
      if (input.config.reconnectStartupGraceMs !== undefined) reconnect.startupGraceMs = input.config.reconnectStartupGraceMs;
      if (input.config.drainDeadlineMs !== undefined) reconnect.drainDeadlineMs = input.config.drainDeadlineMs;
      const heartbeat: { intervalMs?: number; timeoutMs?: number } = {};
      if (input.config.heartbeatIntervalMs !== undefined) heartbeat.intervalMs = input.config.heartbeatIntervalMs;
      if (input.config.heartbeatTimeoutMs !== undefined) heartbeat.timeoutMs = input.config.heartbeatTimeoutMs;
      const result = await startAdapter({
        botToken: input.config.botToken,
        appToken: input.config.appToken,
        allowedChannelIds: input.config.allowedChannelIds,
        allowAllChannels: input.config.allowAllChannels,
        botUserIds: input.config.botUserIds,
        mentionTextAliases: input.config.mentionTextAliases,
        stripMentionText: input.config.stripMentionText,
        shortcuts: input.config.shortcuts,
        homeTab: input.config.homeTab,
        responder: input.responder,
        // A Socket Mode drop is recoverable by construction (the runner always
        // reconnects with backoff), so report it as DEGRADED — keep the responder/
        // harness alive — rather than fatal. onConnectionRestored flips the channel
        // back to running once a reconnect stays up past the stability window.
        onConnectionLost: (reason) => input.onDegraded?.(reason),
        onConnectionRestored: () => input.onRecovered?.(),
        ...(Object.keys(reconnect).length === 0 ? {} : { reconnect }),
        ...(Object.keys(heartbeat).length === 0 ? {} : { heartbeat }),
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        ...(indexPath === undefined
          ? {}
          : {
              resolvePostIndex: (channelId: string, ts: string) =>
                lookupProducingConversation(indexPath, channelId, ts),
              recordPostedMessage: (channelId: string, ts: string, conversationId: string) => {
                void appendPostedMessage(indexPath, { channelId, ts, conversationId });
              },
            }),
        ...(overrides.createApi === undefined ? {} : { createApi: overrides.createApi }),
        ...(overrides.webSocketFactory === undefined ? {} : { webSocketFactory: overrides.webSocketFactory }),
      });
      return {
        summary: {},
        stop: () => result.stop(),
        // Push delivery: a proactive nudge to slack:<ch>[:<thread>] runs as a turn
        // on that conversation's own harness and is delivered through the stream.
        // Enforces the adapter allowlist so a payload-supplied destination cannot
        // reach a channel the operator never allowlisted.
        notify: async (request) => {
          const { conversationId, text, verbatim } = request;
          const { deliveryKey } = request;
          const target = slackTargetFromConversation(conversationId);
          if (target === undefined) {
            input.logger?.warn?.("Slack proactive notify skipped: unparseable destination.", { conversationId });
            return { delivered: false, reason: "unparseable slack destination" };
          }
          const normalized = target.channelId.trim().toLowerCase();
          const allowed =
            input.config.allowAllChannels ||
            input.config.allowedChannelIds.some((id) => id.trim().toLowerCase() === normalized);
          if (!allowed) {
            input.logger?.warn?.("Slack proactive notify skipped: destination not in allowlist.", { conversationId });
            return { delivered: false, reason: "slack channel is not in the adapter allowlist" };
          }
          return await result.adapter.notify(
            target.channelId,
            target.threadTs,
            text,
            verbatim === undefined && deliveryKey === undefined
              ? undefined
              : {
                  ...(verbatim === undefined ? {} : { verbatim }),
                  ...(deliveryKey === undefined ? {} : { deliveryKey }),
                },
          );
        },
        synthesizeContinuation: async (continuationInput: {
          readonly continuationId: string;
          readonly originRunId: string;
          readonly historyBoundary?: string;
          readonly originContextPolicy: "pinned" | "detached_latest";
          readonly originContext?: AgentContinuationOriginContext;
          readonly originConversationId: string;
          readonly replyToConversationId: string;
          readonly prompt: string;
        }) => {
          const target = slackTargetFromConversation(continuationInput.replyToConversationId);
          if (target === undefined) throw new Error("Unparseable Slack continuation destination.");
          const normalized = target.channelId.trim().toLowerCase();
          const allowed = input.config.allowAllChannels
            || input.config.allowedChannelIds.some((id) => id.trim().toLowerCase() === normalized);
          if (!allowed) throw new Error("Slack continuation destination is not in the adapter allowlist.");
          try {
            const continuation = continuationInput.originContextPolicy === "pinned"
              ? (() => {
                  if (continuationInput.historyBoundary === undefined || continuationInput.originContext === undefined) {
                    throw new Error("Pinned Slack continuation input is missing its immutable origin context.");
                  }
                  return {
                    continuationId: continuationInput.continuationId,
                    originRunId: continuationInput.originRunId,
                    historyBoundary: continuationInput.historyBoundary,
                    originContextPolicy: "pinned" as const,
                    originContext: continuationInput.originContext,
                    toolsDisabled: true as const,
                    deferHistoryCommit: true as const,
                  };
                })()
              : {
                  continuationId: continuationInput.continuationId,
                  originRunId: continuationInput.originRunId,
                  originContextPolicy: "detached_latest" as const,
                  toolsDisabled: true as const,
                  deferHistoryCommit: true as const,
                };
            const text = await result.adapter.synthesizeContinuation({
              conversationId: continuationInput.originConversationId,
              replyToConversationId: continuationInput.replyToConversationId,
              channelId: target.channelId,
              ...(target.threadTs === undefined ? {} : { threadTs: target.threadTs }),
              prompt: continuationInput.prompt,
              continuation,
            });
            return { kind: "synthesized", text } satisfies ContinuationChannelSynthesisResult;
          } catch (error) {
            if (error instanceof adapter.SerialQueueFullError) {
              return {
                kind: "unavailable",
                code: "destination_queue_full",
                reason: error.message,
                retryAfterMs: 1_000,
              } satisfies ContinuationChannelSynthesisResult;
            }
            if (error instanceof AgentHarnessFailureError && error.failure.kind === "history_boundary_not_found") {
              return {
                kind: "unavailable",
                code: "origin_history_not_ready",
                reason: "The originating run has not committed its continuation history boundary yet.",
                retryAfterMs: 1_000,
              } satisfies ContinuationChannelSynthesisResult;
            }
            throw error;
          }
        },
        recordContinuationHistory: async (continuationInput: {
          readonly conversationId: string;
          readonly text: string;
          readonly deliveryKey: string;
        }) => {
          const target = slackTargetFromConversation(continuationInput.conversationId);
          if (target === undefined) return { recorded: false as const, code: "unparseable_slack_destination" };
          const normalized = target.channelId.trim().toLowerCase();
          const allowed = input.config.allowAllChannels
            || input.config.allowedChannelIds.some((id) => id.trim().toLowerCase() === normalized);
          if (!allowed) return { recorded: false as const, code: "slack_destination_not_allowlisted" };
          return await result.adapter.recordContinuationHistory(
            continuationInput.conversationId,
            continuationInput.text,
            continuationInput.deliveryKey,
          );
        },
      };
    },
  };
}

/** Extract `{channelId, threadTs?}` from a `slack:<ch>[:<thread>]` conversationId (a rollover #bucket suffix is stripped). */
export function slackTargetFromConversation(
  conversationId: string,
): { readonly channelId: string; readonly threadTs?: string } | undefined {
  const prefix = "slack:";
  if (!conversationId.startsWith(prefix)) {
    return undefined;
  }
  const rest = conversationId.slice(prefix.length).split("#", 1)[0];
  if (rest === undefined || rest.length === 0) {
    return undefined;
  }
  const colon = rest.indexOf(":");
  if (colon < 0) {
    const channelId = rest.trim();
    if (channelId.length === 0) {
      return undefined;
    }
    return { channelId };
  }
  const channelId = rest.slice(0, colon).trim();
  const threadTs = rest.slice(colon + 1).trim();
  if (channelId.length === 0) {
    return undefined;
  }
  if (threadTs.length === 0) {
    return { channelId };
  }
  // A canonical Slack threadTs (e.g. 1718800000.123456) never contains a colon, so a
  // stray/double colon is an operator typo — reject it so the driver warns + skips
  // cleanly rather than posting to the Slack API with a malformed thread_ts.
  if (threadTs.includes(":")) {
    return undefined;
  }
  return { channelId, threadTs };
}

export interface WebhookChannelOverrides {
  readonly adapterFactory?: (options: WebhookAdapterOptions) => Promise<WebhookAdapterStartResult>;
}

// Default wall-clock bound for a webhook run, reclaiming a hung slot. Mirrors
// {@link DEFAULT_CRON_MAX_RUN_MS}; an operator can override via webhook.maxRunMs.
const DEFAULT_WEBHOOK_MAX_RUN_MS = 20 * 60 * 1000;

export function createWebhookChannelDriver(
  overrides: WebhookChannelOverrides = {},
): ChannelDriver<WebhookAdapterConfig> {
  return {
    id: "webhook",
    label: "Webhook",
    async configView(input) {
      if (!(await isChannelConfigured(input, WEBHOOK_GATE))) {
        return unconfiguredChannelView("webhook", "Webhook");
      }
      const adapter = await loadWebhookModule();
      return await buildChannelConfigView(this, adapter.WEBHOOK_CONFIG_FIELDS, input);
    },
    configIssues(config) {
      return findTriggerOverrideIssues(
        config.endpoints
          .filter((endpoint) => endpoint.enabled)
          .map((endpoint) => ({
            name: `webhook endpoint "${endpoint.name}"`,
            ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
            ...(endpoint.effort === undefined ? {} : { effort: endpoint.effort }),
          })),
      );
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, WEBHOOK_GATE))) {
        return UNCONFIGURED_WEBHOOK_CONFIG;
      }
      const adapter = await loadWebhookModule();
      // cwd is required so `webhook/*.md` endpoint files are discovered.
      return await adapter.loadWebhookAdapterConfig({ env: input.env, jsonPath: input.configPath, cwd: input.cwd });
    },
    isConfigError(error) {
      return webhookModule !== undefined && error instanceof webhookModule.WebhookAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Webhook adapter is disabled.";
    },
    waitingReason(config) {
      return config.endpoints.some((endpoint) => endpoint.enabled)
        ? undefined
        : "Webhook adapter has no enabled endpoints.";
    },
    async start(input) {
      const endpoints = input.config.endpoints.filter((endpoint) => endpoint.enabled);
      const endpointByName = new Map(endpoints.map((endpoint) => [endpoint.name, endpoint]));
      const inferredNotifyDestination = endpoints.some(
        (endpoint) => endpoint.notify === true && endpoint.notifyConversationId === undefined,
      )
        ? await inferUniqueNotifyDestination({
            ...(input.listNotifyDestinations === undefined ? {} : { listNotifyDestinations: input.listNotifyDestinations }),
          })
        : undefined;
      const adapterModule = await loadWebhookModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startWebhookAdapter;
      const adapter = await adapterFactory({
        host: input.config.host,
        port: input.config.port,
        allowNonLoopback: input.config.allowNonLoopback,
        defaultMode: input.config.defaultMode,
        retentionMs: input.config.retentionMs,
        maxStoredRequests: input.config.maxStoredRequests,
        // Default-on max-run bound so a hung (esp. async) webhook can't hold a
        // conversation slot forever; mirrors the cron adapter's 20-min default.
        maxRunMs: input.config.maxRunMs ?? DEFAULT_WEBHOOK_MAX_RUN_MS,
        endpoints: endpoints
          .map((endpoint) => ({
            name: endpoint.name,
            path: endpoint.path,
            mode: endpoint.mode,
            ...(endpoint.prompt === undefined ? {} : { prompt: endpoint.prompt }),
            ...(endpoint.notify === undefined ? {} : { notify: endpoint.notify }),
            ...(endpoint.notifyConversationId === undefined ? {} : { notifyConversationId: endpoint.notifyConversationId }),
            ...(endpoint.notify === true && endpoint.notifyConversationId === undefined && inferredNotifyDestination !== undefined
              ? { notifyFallbackConversationId: inferredNotifyDestination }
              : {}),
            ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
            ...(endpoint.effort === undefined ? {} : { effort: endpoint.effort }),
          })),
        responder: input.responder,
        onResult: (status, request) => {
          void deliverNativeWebhookNotification({
            endpoint: endpointByName.get(request.metadata.webhook.endpointName),
            status,
            request,
            ...(input.notifyDestination === undefined ? {} : { notifyDestination: input.notifyDestination }),
            ...(input.listNotifyDestinations === undefined ? {} : { listNotifyDestinations: input.listNotifyDestinations }),
            ...(input.logger === undefined ? {} : { logger: input.logger }),
          });
        },
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: {
          invokeUrl: adapter.invokeUrl,
          port: adapter.port,
          invokeUrls: Object.fromEntries((adapter.endpoints ?? []).map((endpoint) => [endpoint.name, endpoint.invokeUrl])),
        },
        stop: () => adapter.stop(),
      };
    },
  };
}

export interface OpenAIApiChannelOverrides {
  readonly adapterFactory?: (options: OpenAIApiAdapterOptions) => Promise<OpenAIApiAdapterStartResult>;
}

export function createOpenAIApiChannelDriver(
  overrides: OpenAIApiChannelOverrides = {},
): ChannelDriver<OpenAIApiAdapterConfig> {
  return {
    id: "openai-api",
    label: "OpenAI API",
    async configView(input) {
      if (!(await isChannelConfigured(input, OPENAI_API_GATE))) {
        return unconfiguredChannelView("openai-api", "OpenAI API");
      }
      const adapter = await loadOpenAIApiModule();
      return await buildChannelConfigView(this, adapter.OPENAI_API_CONFIG_FIELDS, input, { jsonKey: "openaiApi" });
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, OPENAI_API_GATE))) {
        return UNCONFIGURED_OPENAI_API_CONFIG;
      }
      const adapter = await loadOpenAIApiModule();
      return await adapter.loadOpenAIApiAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return openaiApiModule !== undefined && error instanceof openaiApiModule.OpenAIApiAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "OpenAI API adapter is disabled.";
    },
    async start(input) {
      const adapterModule = await loadOpenAIApiModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startOpenAIApiAdapter;
      const adapter = await adapterFactory({
        host: input.config.host,
        port: input.config.port,
        basePath: input.config.basePath,
        allowNonLoopback: input.config.allowNonLoopback,
        ...(input.config.apiKey === undefined ? {} : { apiKey: input.config.apiKey }),
        modelId: input.config.modelId,
        responder: input.responder,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      const baseUrls = adapter.baseUrls ?? [adapter.baseUrl];
      return {
        summary: {
          baseUrl: adapter.baseUrl,
          ...(baseUrls.length > 1 ? { baseUrls } : {}),
        },
        stop: () => adapter.stop(),
      };
    },
  };
}

/**
 * `/v1/info` re-runs local-provider discovery at most this often; the TUI
 * fetches info on connect + agent switch (not per turn), so this just bounds
 * how often a flaky/slow local endpoint gets probed rather than affecting
 * perceived freshness in practice.
 */
const LOCAL_MODEL_DISCOVERY_TTL_MS = 30_000;

export interface TuiChannelOverrides {
  readonly adapterFactory?: (options: TuiAdapterOptions) => Promise<TuiAdapterStartResult>;
  /** Test seam: replaces the real local-provider model discovery call. */
  readonly discoverModels?: (
    providers: readonly LocalProviderDefinition[] | undefined,
  ) => Promise<readonly DiscoveredLocalModel[]>;
}

/**
 * The TUI stream endpoint deviates from the channels-off convention: with no
 * `tui` section and no `MONO_AGENT_TUI_*` env it is ENABLED on loopback with
 * an ephemeral port, so `mono-agent tui` can reach any running agent without a
 * per-agent config edit. There is consequently no isChannelConfigured gate and
 * no synthetic UNCONFIGURED constant — the real loader always answers (its
 * empty-input output is `enabled: true` + defaults). `"tui": {"enabled": false}`
 * opts out.
 */
export function createTuiChannelDriver(
  overrides: TuiChannelOverrides = {},
): ChannelDriver<TuiAdapterConfig> {
  return {
    id: "tui",
    label: "TUI",
    async configView(input) {
      const adapter = await loadTuiModule();
      return await buildChannelConfigView(this, adapter.TUI_CONFIG_FIELDS, input, { jsonKey: "tui" });
    },
    async loadConfig(input) {
      const adapter = await loadTuiModule();
      return await adapter.loadTuiAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return tuiModule !== undefined && error instanceof tuiModule.TuiAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "TUI stream endpoint is disabled.";
    },
    async start(input) {
      const adapterModule = await loadTuiModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startTuiAdapter;
      const discoverModels = overrides.discoverModels ?? discoverLocalProviderModels;
      const localProviders = input.coreConfig.providers?.local;

      // The statically configured candidate models: the primary first, then
      // each configured fallback, as canonical `modelReferenceKey` strings,
      // de-duplicated (a fallback redundantly naming the primary collapses away).
      const configModelKeys: string[] = [];
      for (const ref of configuredRuntimeModels(input.coreConfig.runtime)) {
        const key = modelReferenceKey(ref);
        if (!configModelKeys.includes(key)) {
          configModelKeys.push(key);
        }
      }

      // Local-provider discovery is async and its result can change after
      // startup (an endpoint started later, a model loaded/unloaded) — so
      // `info` is a PROVIDER the adapter re-invokes on every GET /v1/info,
      // rather than a value snapshotted once at channel composition. A short
      // TTL cache keeps a flaky/slow endpoint from being hammered; the TUI
      // only calls /v1/info on connect + agent switch, not per turn, so 30s
      // of staleness there is unnoticeable in practice.
      let discoveryCache: { readonly expiresAt: number; readonly models: readonly DiscoveredLocalModel[] } | undefined;
      const discoverModelsCached = async (): Promise<readonly DiscoveredLocalModel[]> => {
        const now = Date.now();
        if (discoveryCache !== undefined && now < discoveryCache.expiresAt) {
          return discoveryCache.models;
        }
        const models = await discoverModels(localProviders);
        discoveryCache = { expiresAt: now + LOCAL_MODEL_DISCOVERY_TTL_MS, models };
        return models;
      };

      const buildInfo = async (): Promise<TuiAdapterInfo> => {
        const discovered = await discoverModelsCached();
        const labelByRef = new Map(discovered.map((model) => [model.ref, model.label]));
        const models = [...configModelKeys];
        for (const model of discovered) {
          if (!models.includes(model.ref)) {
            models.push(model.ref);
          }
        }

        const modelOptions: Record<string, { effortLevels?: readonly string[]; reasoning?: boolean; reasoningMode?: string; label?: string }> = {};
        for (const ref of models) {
          let parsedRef;
          try {
            parsedRef = parseMonoRuntimeModelReference(ref);
          } catch {
            continue;
          }
          const resolved = resolveModelEffortLevels(parsedRef, localProviders);
          const label = labelByRef.get(ref);
          const entry = {
            ...(resolved.effortLevels === undefined ? {} : { effortLevels: resolved.effortLevels }),
            reasoning: resolved.reasoning,
            ...(resolved.reasoningMode === undefined ? {} : { reasoningMode: resolved.reasoningMode }),
            ...(label === undefined ? {} : { label }),
          };
          if (Object.keys(entry).length > 0) {
            modelOptions[ref] = entry;
          }
        }

        return {
          model: modelReferenceKey(input.coreConfig.runtime.model),
          ...(input.coreConfig.runtime.effort === undefined ? {} : { effort: input.coreConfig.runtime.effort }),
          models,
          ...(Object.keys(modelOptions).length === 0 ? {} : { modelOptions }),
        };
      };

      const adapter = await adapterFactory({
        host: input.config.host,
        port: input.config.port,
        basePath: input.config.basePath,
        allowNonLoopback: input.config.allowNonLoopback,
        ...(input.config.apiKey === undefined ? {} : { apiKey: input.config.apiKey }),
        responder: input.responder,
        info: buildInfo,
        // A dead endpoint must flip the channel to failed, not serve nothing
        // silently — the TUI's only discovery signal is this channel's status.
        onServerError: (reason) => input.onFailure(reason),
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: { baseUrl: adapter.baseUrl },
        stop: () => adapter.stop(),
      };
    },
  };
}

export interface LiveChannelOverrides {
  readonly adapterFactory?: (options: LiveAdapterOptions) => Promise<LiveAdapterHandle>;
}

/**
 * The live event relay, like the TUI endpoint, deviates from the channels-off
 * convention: it is ENABLED by default on loopback with an ephemeral port so
 * `mono-agent web` can observe any running agent without a per-agent config edit.
 * It is passive and read-only — it relays the host's in-process run-event bus over
 * SSE and never drives a turn. `"live": {"enabled": false}` opts out.
 */
export function createLiveChannelDriver(
  overrides: LiveChannelOverrides = {},
): ChannelDriver<LiveAdapterConfig> {
  return {
    id: "live",
    label: "Live",
    async configView(input) {
      const adapter = await loadLiveModule();
      return await buildChannelConfigView(this, adapter.LIVE_CONFIG_FIELDS, input, { jsonKey: "live" });
    },
    async loadConfig(input) {
      const adapter = await loadLiveModule();
      return await adapter.loadLiveAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return liveModule !== undefined && error instanceof liveModule.LiveAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Live event relay is disabled.";
    },
    async start(input) {
      const adapterModule = await loadLiveModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startLiveAdapter;
      // The host feeds the shared run-event bus (via the broadcast recorder). If it
      // has none, still serve an (empty) stream rather than failing the channel.
      const bus = input.liveEventBus ?? adapterModule.createLiveEventBus();
      const adapter = await adapterFactory({
        bus,
        host: input.config.host,
        port: input.config.port,
        basePath: input.config.basePath,
        allowNonLoopback: input.config.allowNonLoopback,
        ...(input.config.apiKey === undefined ? {} : { apiKey: input.config.apiKey }),
        // A dead endpoint must flip the channel to failed, not serve nothing
        // silently — the web surface's only per-agent live signal is this status.
        onServerError: (reason) => input.onFailure(reason),
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: { baseUrl: adapter.baseUrl },
        stop: () => adapter.stop(),
      };
    },
  };
}

export interface CronChannelOverrides {
  readonly adapterFactory?: (options: CronAdapterOptions) => CronAdapterStartResult;
  /** Test seam for cooldown decisions; production uses the system clock. */
  readonly now?: () => Date;
  /**
   * Watchdog: max wall-clock a single cron run may take before it is aborted and its slot
   * reclaimed. Defaults to {@link DEFAULT_CRON_MAX_RUN_MS}. Without this, a wedged responder
   * leaves `state.active` set forever and every later firing is skipped as "a prior run is
   * still active" — the failure that silently starved hourly scans for days.
   */
  readonly maxRunMs?: number;
}

/**
 * 20 minutes — comfortably above any real briefing/scan (observed max ~6.5 min) yet bounded, so a
 * hung run is reclaimed rather than blocking the job indefinitely.
 */
const DEFAULT_CRON_MAX_RUN_MS = 20 * 60 * 1000;
const DEFAULT_CRON_FAILURE_NOTICE_COOLDOWN_HOURS = 6;
const MAX_CRON_FAILURE_NOTICE_ERROR_CHARS = 180;

/**
 * Whether a notify-enabled turn's final text should suppress delivery: empty /
 * whitespace-only (the agent chose to stay silent) or exactly the
 * {@link NOTHING_TO_REPORT_SENTINEL} token. Matched trimmed and
 * case-insensitively; never substring-matched, so a digest that merely mentions
 * the phrase is still delivered.
 */
function suppressesNotification(text: string | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  return trimmed.length === 0 || trimmed.toUpperCase() === NOTHING_TO_REPORT_SENTINEL;
}

/** A conversationId a verbatim notification can be delivered to (a push channel with a notify hook). */
function isDeliverableConversation(conversationId: string): boolean {
  return conversationId.startsWith("telegram:") || conversationId.startsWith("slack:");
}

export function createCronChannelDriver(
  overrides: CronChannelOverrides = {},
): ChannelDriver<CronAdapterConfig> {
  const failureNoticeLastSentMsByJobId = new Map<string, number>();
  return {
    id: "cron",
    label: "Cron",
    async configView(input) {
      if (!(await isChannelConfigured(input, CRON_GATE))) {
        return unconfiguredChannelView("cron", "Cron");
      }
      const adapter = await loadCronModule();
      return await buildChannelConfigView(this, adapter.CRON_CONFIG_FIELDS, input);
    },
    configIssues(config) {
      return findTriggerOverrideIssues(
        config.jobs
          .filter((job) => job.enabled)
          .map((job) => ({
            name: `cron job "${job.id}"`,
            ...(job.model === undefined ? {} : { model: job.model }),
            ...(job.effort === undefined ? {} : { effort: job.effort }),
          })),
      );
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, CRON_GATE))) {
        return UNCONFIGURED_CRON_CONFIG;
      }
      const adapter = await loadCronModule();
      return await adapter.loadCronAdapterConfig({ env: input.env, jsonPath: input.configPath, cwd: input.cwd });
    },
    isConfigError(error) {
      return cronModule !== undefined && error instanceof cronModule.CronAdapterError;
    },
    disabledReason(config) {
      const enabledJobs = config.jobs.filter((job) => job.enabled);
      return enabledJobs.length > 0 ? undefined : "Cron adapter has no enabled jobs.";
    },
    async start(input) {
      const jobs = input.config.jobs.filter((job) => job.enabled);
      const jobById = new Map(jobs.map((job) => [job.id, job]));
      const inferredNotifyDestination = jobs.some(
        (job) => job.notify === true && job.notifyConversationId === undefined,
      )
        ? await inferUniqueNotifyDestination({
            ...(input.listNotifyDestinations === undefined ? {} : { listNotifyDestinations: input.listNotifyDestinations }),
          })
        : undefined;
      const adapterModule = await loadCronModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startCronAdapter;
      const adapter = adapterFactory({
        responder: input.responder,
        // Skip overlapping firings (a job still running when its next tick fires)
        // — the legacy/default app behavior. This avoids the scheduler's
        // unbounded "queue" default retaining stale ticks in memory when a job
        // runs longer than its interval. (Queue/replace remain available to
        // programmatic callers of startCronAdapter.) The watchdog below is what
        // keeps "skip" safe: a hung run no longer pins the slot forever.
        overlap: "skip",
        // Reclaim a run whose responder never settles, so a single wedged run can't
        // permanently skip every future firing of the job.
        maxRunMs: overrides.maxRunMs ?? DEFAULT_CRON_MAX_RUN_MS,
        jobs: jobs.map((job) => ({
          id: job.id,
          expression: job.expression,
          timezone: job.timezone,
          prompt: job.prompt,
          ...(job.conversationId === undefined ? {} : { conversationId: job.conversationId }),
          ...(job.maxRunMs === undefined ? {} : { maxRunMs: job.maxRunMs }),
          ...(job.notify === undefined ? {} : { notify: job.notify }),
          ...(job.notifyConversationId === undefined ? {} : { notifyConversationId: job.notifyConversationId }),
          ...(job.notify === true && job.notifyConversationId === undefined && inferredNotifyDestination !== undefined
            ? { notifyFallbackConversationId: inferredNotifyDestination }
            : {}),
          ...(job.model === undefined ? {} : { model: job.model }),
          ...(job.effort === undefined ? {} : { effort: job.effort }),
        })),
        onResult: (result) => {
          const level = result.kind === "failed" ? "error" : result.kind === "skipped" ? "warn" : "info";
          input.logger?.[level]?.("Cron job finished.", { result });
          void deliverCronModelExhaustionFailureNotice({
            job: jobById.get(result.jobId),
            result,
            cooldowns: failureNoticeLastSentMsByJobId,
            now: overrides.now ?? (() => new Date()),
            ...(input.notifyDestination === undefined ? {} : { notifyDestination: input.notifyDestination }),
            ...(input.logger === undefined ? {} : { logger: input.logger }),
          });
          void deliverNativeCronNotification({
            job: jobById.get(result.jobId),
            result,
            ...(input.notifyDestination === undefined ? {} : { notifyDestination: input.notifyDestination }),
            ...(input.listNotifyDestinations === undefined ? {} : { listNotifyDestinations: input.listNotifyDestinations }),
            ...(input.logger === undefined ? {} : { logger: input.logger }),
          });
        },
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: { jobs: adapter.jobs.length },
        async stop() {
          adapter.stop();
        },
      };
    },
  };
}

async function deliverCronModelExhaustionFailureNotice(input: {
  readonly job: CronJobConfig | undefined;
  readonly result: CronJobResult;
  readonly cooldowns: Map<string, number>;
  readonly now: () => Date;
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean },
  ) => Promise<NotifyDeliveryResult>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<void> {
  const job = input.job;
  if (
    job?.notify !== true ||
    input.result.kind !== "failed" ||
    input.result.failureKind !== "provider_unavailable_exhausted"
  ) {
    return;
  }
  if (job.notifyConversationId === undefined) {
    input.logger?.warn?.("Cron failure notice skipped: notifyConversationId is required.", { jobId: job.id });
    return;
  }
  if (input.notifyDestination === undefined) {
    input.logger?.warn?.("Cron failure notice skipped: no delivery hook is available.", { jobId: job.id });
    return;
  }

  const nowMs = input.now().getTime();
  const cooldownHours = job.notifyFailureCooldownHours ?? DEFAULT_CRON_FAILURE_NOTICE_COOLDOWN_HOURS;
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const lastSentMs = input.cooldowns.get(job.id);
  if (lastSentMs !== undefined && nowMs - lastSentMs < cooldownMs) {
    input.logger?.info?.("Cron failure notice skipped: cooldown is active.", {
      jobId: job.id,
      cooldownHours,
    });
    return;
  }

  const destination = job.notifyConversationId;
  const text = buildCronModelExhaustionFailureNotice(job, input.result);
  try {
    const delivery = await input.notifyDestination(destination, text, { verbatim: true });
    if (!delivery.delivered) {
      input.logger?.warn?.("Cron failure notice was not delivered.", {
        jobId: job.id,
        conversationId: destination,
        ...(delivery.reason === undefined ? {} : { reason: delivery.reason }),
      });
      return;
    }
    input.cooldowns.set(job.id, nowMs);
    input.logger?.info?.("Cron failure notice delivered.", { jobId: job.id, conversationId: destination });
  } catch (error) {
    input.logger?.warn?.("Cron failure notice failed.", {
      jobId: job.id,
      conversationId: destination,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildCronModelExhaustionFailureNotice(
  job: CronJobConfig,
  result: { readonly error: string },
): string {
  const jobId = oneLine(job.id);
  const latestError = truncateOneLine(result.error, MAX_CRON_FAILURE_NOTICE_ERROR_CHARS);
  const prefix = `Cron job "${jobId}" failed: all configured models failed.`;
  return latestError.length === 0 ? prefix : `${prefix} Latest error: ${latestError}`;
}

function truncateOneLine(value: string, maxChars: number): string {
  const collapsed = oneLine(value);
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

async function deliverNativeCronNotification(input: {
  readonly job: CronJobConfig | undefined;
  readonly result: CronJobResult;
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean },
  ) => Promise<NotifyDeliveryResult>;
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<void> {
  const job = input.job;
  if (job?.notify !== true || input.result.kind !== "succeeded") {
    return;
  }
  const text = input.result.text;
  // The agent stays silent by producing no final answer or the explicit sentinel.
  if (text === undefined || suppressesNotification(text)) {
    return;
  }
  try {
    if (input.notifyDestination === undefined) {
      input.logger?.warn?.("Native cron notification skipped: no delivery hook is available.", { jobId: job.id });
      return;
    }

    const destination = await resolveNativeCronNotifyDestination({
      job,
      ...(input.listNotifyDestinations === undefined ? {} : { listNotifyDestinations: input.listNotifyDestinations }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    if (destination === undefined) {
      return;
    }

    const delivery = await input.notifyDestination(destination, text, { verbatim: true });
    if (!delivery.delivered) {
      input.logger?.warn?.("Native cron notification was not delivered.", {
        jobId: job.id,
        conversationId: destination,
        ...(delivery.reason === undefined ? {} : { reason: delivery.reason }),
      });
    }
  } catch (error) {
    input.logger?.warn?.("Native cron notification failed.", {
      jobId: job.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveNativeCronNotifyDestination(input: {
  readonly job: CronJobConfig;
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<string | undefined> {
  if (input.job.notifyConversationId !== undefined) {
    return input.job.notifyConversationId;
  }
  if (input.listNotifyDestinations === undefined) {
    input.logger?.warn?.("Native cron notification skipped: no destination is configured and no destination resolver is available.", {
      jobId: input.job.id,
    });
    return undefined;
  }
  const destinations = await input.listNotifyDestinations();
  if (destinations.length !== 1) {
    input.logger?.warn?.("Native cron notification skipped: destination inference requires exactly one candidate.", {
      jobId: input.job.id,
      destinationCount: destinations.length,
    });
    return undefined;
  }
  return destinations[0]?.conversationId;
}

async function inferUniqueNotifyDestination(input: {
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
}): Promise<string | undefined> {
  if (input.listNotifyDestinations === undefined) {
    return undefined;
  }
  const destinations = await input.listNotifyDestinations();
  return destinations.length === 1 ? destinations[0]?.conversationId : undefined;
}

async function deliverNativeWebhookNotification(input: {
  readonly endpoint: WebhookEndpointConfig | undefined;
  readonly status: WebhookInvocationStatus;
  readonly request: WebhookInvocationRequest;
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean },
  ) => Promise<NotifyDeliveryResult>;
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<void> {
  const endpoint = input.endpoint;
  if (endpoint?.notify !== true || input.status.status !== "succeeded") {
    return;
  }
  const text = input.status.text;
  // The agent stays silent by producing no final answer or the explicit sentinel.
  if (text === undefined || suppressesNotification(text)) {
    return;
  }
  const source = { endpointName: input.request.metadata.webhook.endpointName };
  try {
    if (input.notifyDestination === undefined) {
      input.logger?.warn?.("Native webhook notification skipped: no delivery hook is available.", source);
      return;
    }

    const destination = await resolveNativeWebhookNotifyDestination({
      endpoint,
      source,
      requestConversationId: input.request.conversationId,
      ...(input.listNotifyDestinations === undefined ? {} : { listNotifyDestinations: input.listNotifyDestinations }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    if (destination === undefined) {
      return;
    }

    const delivery = await input.notifyDestination(destination, text, { verbatim: true });
    if (!delivery.delivered) {
      input.logger?.warn?.("Native webhook notification was not delivered.", {
        ...source,
        conversationId: destination,
        ...(delivery.reason === undefined ? {} : { reason: delivery.reason }),
      });
    }
  } catch (error) {
    input.logger?.warn?.("Native webhook notification failed.", {
      ...source,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveNativeWebhookNotifyDestination(input: {
  readonly endpoint: WebhookEndpointConfig;
  readonly source: Record<string, unknown>;
  /** The webhook request's own conversationId — the async-callback destination when the payload names a chat. */
  readonly requestConversationId?: string;
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<string | undefined> {
  if (input.endpoint.notifyConversationId !== undefined) {
    return input.endpoint.notifyConversationId;
  }
  // Async-callback pattern: when the inbound payload names a deliverable chat
  // (e.g. the service posts back the originating `telegram:`/`slack:` id), deliver
  // the answer there. The owning channel's allowlist still bounds it.
  if (input.requestConversationId !== undefined && isDeliverableConversation(input.requestConversationId)) {
    return input.requestConversationId;
  }
  if (input.listNotifyDestinations === undefined) {
    input.logger?.warn?.("Native webhook notification skipped: no destination is configured and no destination resolver is available.", input.source);
    return undefined;
  }
  const destinations = await input.listNotifyDestinations();
  if (destinations.length !== 1) {
    input.logger?.warn?.("Native webhook notification skipped: destination inference requires exactly one candidate.", {
      ...input.source,
      destinationCount: destinations.length,
    });
    return undefined;
  }
  return destinations[0]?.conversationId;
}

export interface ChannelDriverOverrides {
  readonly telegram?: TelegramChannelOverrides;
  readonly slack?: SlackChannelOverrides;
  readonly webhook?: WebhookChannelOverrides;
  readonly openaiApi?: OpenAIApiChannelOverrides;
  readonly cron?: CronChannelOverrides;
  readonly tui?: TuiChannelOverrides;
  readonly live?: LiveChannelOverrides;
}

/** Every channel the app can drive, in startup/status display order. */
export function defaultChannelDrivers(overrides: ChannelDriverOverrides = {}): readonly ChannelDriver[] {
  return [
    createTelegramChannelDriver(overrides.telegram),
    createSlackChannelDriver(overrides.slack),
    createWebhookChannelDriver(overrides.webhook),
    createOpenAIApiChannelDriver(overrides.openaiApi),
    createCronChannelDriver(overrides.cron),
    createTuiChannelDriver(overrides.tui),
    createLiveChannelDriver(overrides.live),
  ] as readonly ChannelDriver[];
}

export async function resolveChannelDrivers(
  input: MonoAgentAppConfigInput,
  overrides: ChannelDriverOverrides = {},
): Promise<readonly ChannelDriver[]> {
  const drivers = [...defaultChannelDrivers(overrides)];
  const plugins = await resolveConfiguredChannelPlugins(input, { reservedIds: BUILTIN_CHANNEL_IDS });
  for (const plugin of plugins) {
    const existing = drivers.findIndex((driver) => driver.id === plugin.id);
    if (existing >= 0) {
      drivers[existing] = plugin;
    } else {
      drivers.push(plugin);
    }
  }
  return drivers;
}

function telegramStartOptions(
  input: ChannelStartInput<TelegramAdapterConfig>,
  overrides: TelegramChannelOverrides,
): TelegramAdapterStartOptions {
  // Subscribe to (and handle) inline-keyboard taps only when the `TelegramAskButtons`
  // tool is permitted by the tool policy — so enabling the tool is the single
  // switch that turns on the whole ask/answer round-trip. Without it the bot
  // stays message-only and never registers the callback handler.
  const callbacksEnabled = isAdapterSendToolAllowed("TelegramAskButtons", {
    allowedTools: input.coreConfig.tools.allowedTools,
    disallowedTools: input.coreConfig.tools.disallowedTools,
  });
  // Keep host status transitions edge-triggered even if an adapter regression or
  // a stop/restart race repeats a lifecycle callback for the same outage.
  let pollingDegraded = false;
  return {
    botToken: input.config.botToken,
    allowedChatIds: [...input.config.allowedChatIds],
    allowAllChats: input.config.allowAllChats,
    responder: input.responder,
    allowedUpdates: callbacksEnabled ? ["message", "callback_query"] : ["message"],
    ...(callbacksEnabled ? { callbacksEnabled: true } : {}),
    deleteWebhookOnStart: true,
    stream: {
      initialStatusText: "Agent is thinking...",
      editDebounceMs: 350,
      maxSendRetries: 3,
      retryCapMs: 60_000,
      showThoughts: true,
      formatMarkdown: true,
    },
    messages: {
      welcomeText: "Agent is online. Send a message to run the configured runtime.",
      helpText: "Send a message to talk to the agent. Use /cancel to stop an in-flight response.",
      unauthorizedText: "This chat is not allowlisted for this agent.",
      errorText: telegramErrorText,
    },
    // A polling crash is recoverable by construction: the adapter always schedules
    // a backoff restart (it never gives up on its own), so report it as DEGRADED
    // (keep the responder/harness alive) rather than fatal. onPollingRecovered flips
    // the channel back to running once a restarted runner proves a healthy poll.
    onPollingError: (error) => {
      if (pollingDegraded) {
        return;
      }
      pollingDegraded = true;
      input.onDegraded?.(error instanceof Error ? error.message : String(error));
    },
    onPollingRecovered: () => {
      if (!pollingDegraded) {
        return;
      }
      pollingDegraded = false;
      input.onRecovered?.();
    },
    ...(input.config.apiRoot === undefined ? {} : { apiRoot: input.config.apiRoot }),
    ...(telegramAttachmentOptions(input.config) === undefined
      ? {}
      : { attachments: telegramAttachmentOptions(input.config)! }),
    ...(input.interaction === undefined
      ? {}
      : {
          pendingAsks: {
            tryResolve: (
              conversationId: string,
              answer: string,
              answerKind?: ChannelInteractionAnswerKind,
            ) => input.interaction!.tryResolveAsk(conversationId, answer, answerKind),
            hasPending: (conversationId: string) => input.interaction!.hasPendingAsk?.(conversationId) ?? false,
            cancel: (conversationId: string) => {
              input.interaction!.cancelAsks(conversationId);
            },
          },
        }),
    ...(input.config.ipFamily === undefined ? {} : { transport: { ipFamily: input.config.ipFamily } }),
    ...(input.config.pollWatchdogMs === undefined ? {} : { pollWatchdogMs: input.config.pollWatchdogMs }),
    ...(input.config.commands === undefined ? {} : { commands: [...input.config.commands] }),
    ...(input.config.reactions === undefined ? {} : { reactions: input.config.reactions }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(overrides.botFactory === undefined ? {} : { botFactory: overrides.botFactory }),
    ...(overrides.runnerFactory === undefined ? {} : { runnerFactory: overrides.runnerFactory }),
  };
}

function telegramErrorText(input: TelegramAdapterErrorTextInput): string {
  const failure = failureFromUnknown(input.error);
  if (failure?.kind !== undefined) {
    const description = describeRunFailureKind({ failureKind: failure.kind });
    if (description.known || failure.message === undefined || failure.message.trim().length === 0) {
      const explanation = failure.kind === "usage_limit"
        ? usageLimitExplanation(description.explanation, failure.details)
        : description.explanation;
      return `${explanation} ${description.nextStep}`;
    }
  }
  if (failure?.message !== undefined && failure.message.trim().length > 0) {
    return `I could not complete that message: ${failure.message}`;
  }
  return "I could not complete that message. Check the local artifact summary for details.";
}

function usageLimitExplanation(explanation: string, details: unknown): string {
  const maxTurns = nestedNumber(details, ["diagnostics", "max_turns"]);
  return maxTurns === undefined ? explanation : `${explanation} Configured turn cap: ${maxTurns} turns.`;
}

function failureFromUnknown(error: unknown): {
  readonly kind?: string;
  readonly message?: string;
  readonly details?: unknown;
} | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const failure = error.failure;
  if (!isRecord(failure)) {
    return undefined;
  }
  return {
    ...(typeof failure.kind === "string" ? { kind: failure.kind } : {}),
    ...(typeof failure.message === "string" ? { message: failure.message } : {}),
    ...(Object.prototype.hasOwnProperty.call(failure, "details") ? { details: failure.details } : {}),
  };
}

function nestedNumber(value: unknown, path: readonly string[]): number | undefined {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
