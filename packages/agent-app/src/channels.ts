import { resolve } from "node:path";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import { NOTHING_TO_REPORT_SENTINEL } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  A2AConsumerError,
  A2AProviderError,
  startA2AProvider,
} from "@mono-agent/a2a-adapter";
import type { A2AAdapterConfig, A2AProviderOptions, A2AProviderStartResult } from "@mono-agent/a2a-adapter";
import { loadA2AAdapterConfig } from "@mono-agent/a2a-adapter";
import { CronAdapterError, loadCronAdapterConfig, startCronAdapter } from "@mono-agent/cron-adapter";
import type {
  CronAdapterConfig,
  CronAdapterOptions,
  CronAdapterStartResult,
  CronJobConfig,
  CronJobResult,
} from "@mono-agent/cron-adapter";
import { describeRunFailureKind } from "@mono-agent/observability";
import {
  loadOpenAIApiAdapterConfig,
  OpenAIApiAdapterError,
  startOpenAIApiAdapter,
} from "@mono-agent/openai-api-adapter";
import type {
  OpenAIApiAdapterConfig,
  OpenAIApiAdapterOptions,
  OpenAIApiAdapterStartResult,
} from "@mono-agent/openai-api-adapter";
import {
  loadSlackAdapterConfig,
  SlackAdapterConfigError,
  startSlackAdapter,
} from "@mono-agent/slack-adapter";
import type {
  SlackAdapterConfig,
  SlackAdapterStartOptions,
  SlackAdapterStartResult,
} from "@mono-agent/slack-adapter";
import {
  isWithinQuietHours,
  loadTelegramAdapterConfig,
  startTelegramAdapter,
  TelegramAdapterConfigError,
} from "@mono-agent/telegram-adapter";
import type {
  TelegramAdapterConfig,
  TelegramAdapterErrorTextInput,
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
  TelegramChatId,
} from "@mono-agent/telegram-adapter";
import {
  loadWebhookAdapterConfig,
  startWebhookAdapter,
  WebhookAdapterError,
} from "@mono-agent/webhook-adapter";
import type {
  WebhookAdapterConfig,
  WebhookAdapterOptions,
  WebhookAdapterStartResult,
  WebhookEndpointConfig,
  WebhookInvocationRequest,
  WebhookInvocationStatus,
} from "@mono-agent/webhook-adapter";
import {
  loadWhatsAppAdapterConfig,
  startWhatsAppAdapter,
  WhatsAppAdapterConfigError,
} from "@mono-agent/whatsapp-adapter";
import type {
  StartWhatsAppAdapterOptions,
  WhatsAppAdapterConfig,
  WhatsAppAdapterStartResult,
  WhatsAppSocketFactory,
} from "@mono-agent/whatsapp-adapter";

import { isAdapterSendToolAllowed } from "./adapter-send-tools.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import type { NotifyDestination } from "./notify-destinations.js";
import type { NotifyDeliveryResult } from "./proactive-notify.js";
import { appendPostedMessage, lookupProducingConversation } from "./posted-message-index.js";

export type ChannelId =
  | "telegram"
  | "slack"
  | "a2a"
  | "webhook"
  | "openai-api"
  | "cron"
  | "whatsapp";

export interface MonoAgentAppLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export type ChannelStatus =
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "waiting_for_config"; readonly reason: string }
  | { readonly kind: "running"; readonly summary: Record<string, unknown> }
  | { readonly kind: "failed"; readonly reason: string };

export interface RunningChannel {
  /** Channel-specific connection facts (invoke URL, agent card URL, job count). */
  readonly summary: Record<string, unknown>;
  stop(): Promise<void>;
  /**
   * Optional responder/harness teardown, set by the app (not the driver). Stopping
   * the transport alone leaves the per-channel harness + live-session manager alive;
   * on stop/reload the app disposes the responder so warm provider sessions and
   * queued turns against stale config are retired. Transport stops first.
   */
  dispose?(): Promise<void>;
  /**
   * Deliver a proactive notification to a destination this channel owns: run it as
   * a turn on the destination's own harness (shared session/history) and deliver
   * through the channel's normal stream. Set only by push channels (telegram/slack);
   * absent on request-driven channels. Used by the app's proactive-notify router.
   *
   * Enforces the channel's own adapter allowlist (so a payload-supplied destination
   * cannot reach a non-allowlisted chat) and reports the outcome so the caller can
   * surface it to the model and the run summary.
   */
  notify?(input: {
    readonly conversationId: string;
    readonly text: string;
    /**
     * Deliver `text` VERBATIM — post it unchanged with no model call, then record
     * it to the destination's history (native cron/webhook notification). Without
     * it, `text` is run as a turn on the destination's harness.
     */
    readonly verbatim?: boolean;
  }): Promise<NotifyDeliveryResult>;
}

export interface ChannelStartInput<TConfig> {
  readonly config: TConfig;
  readonly coreConfig: MonoAgentConfig;
  readonly responder: AgentResponder;
  readonly cwd: string;
  readonly logger?: MonoAgentAppLogger;
  /** Reports a transport that died after a successful start (e.g. polling loop). */
  readonly onFailure: (reason: string) => void;
  /** Native scheduled/webhook delivery hook owned by the app, used by proactive trigger channels. */
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean },
  ) => Promise<NotifyDeliveryResult>;
  /** Candidate destinations for native delivery inference. */
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  /**
   * Path to the posted-message index (the artifact-dir JSONL linking a posted
   * message back to its producing conversation). The Slack driver uses it to
   * resolve in-thread replies and to record top-level proactive posts.
   */
  readonly postedMessageIndexPath?: string;
}

/**
 * One communication channel the app can run from config. Drivers stay thin:
 * they reuse the adapter package's config loader and start function and add
 * only the wiring an app host previously copied by hand.
 */
export interface ChannelDriver<TConfig = unknown> {
  readonly id: ChannelId;
  readonly label: string;
  loadConfig(input: MonoAgentAppConfigInput): Promise<TConfig>;
  /** True for the adapter's own typed config errors (incomplete config → waiting). */
  isConfigError(error: unknown): boolean;
  /** Reason the channel is explicitly disabled by its loaded config. */
  disabledReason?(config: TConfig): string | undefined;
  /** Reason a loaded, enabled config still cannot start (missing sub-section). */
  waitingReason?(config: TConfig): string | undefined;
  start(input: ChannelStartInput<TConfig>): Promise<RunningChannel>;
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
    async loadConfig(input) {
      return await loadTelegramAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return error instanceof TelegramAdapterConfigError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Telegram is disabled.";
    },
    async start(input) {
      const startAdapter = overrides.startAdapter ?? startTelegramAdapter;
      const result = await startAdapter(telegramStartOptions(input, overrides));
      return {
        summary: {},
        stop: () => result.stop(),
        // Push delivery: a proactive nudge to telegram:<chat> runs as a turn on
        // this chat's own harness and is delivered through the normal stream.
        // Enforces the adapter allowlist so a payload-supplied destination cannot
        // reach a chat the operator never allowlisted.
        notify: async ({ conversationId, text, verbatim }) => {
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
            isWithinQuietHours(new Date(), input.config.quietHours);
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
    async loadConfig(input) {
      return await loadSlackAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return error instanceof SlackAdapterConfigError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Slack is disabled.";
    },
    async start(input) {
      const startAdapter = overrides.startAdapter ?? startSlackAdapter;
      // Link posted messages to their producing conversation so an in-thread reply
      // resumes that conversation instead of a fresh, history-less slack: thread.
      const indexPath = input.postedMessageIndexPath;
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
        notify: async ({ conversationId, text, verbatim }) => {
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
            verbatim === undefined ? undefined : { verbatim },
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

export interface A2AChannelOverrides {
  readonly providerFactory?: (options: A2AProviderOptions) => Promise<A2AProviderStartResult>;
}

export function createA2AChannelDriver(
  overrides: A2AChannelOverrides = {},
): ChannelDriver<A2AAdapterConfig> {
  return {
    id: "a2a",
    label: "A2A",
    async loadConfig(input) {
      return await loadA2AAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return error instanceof A2AProviderError || error instanceof A2AConsumerError;
    },
    disabledReason(config) {
      return config.provider.enabled ? undefined : "A2A provider is disabled.";
    },
    waitingReason(config) {
      if (config.agent === undefined || config.skill === undefined) {
        return "A2A provider requires agent and skill configuration.";
      }
      return undefined;
    },
    async start(input) {
      const config = input.config;
      if (config.agent === undefined || config.skill === undefined) {
        throw new A2AProviderError("missing_required_config", "A2A provider requires agent and skill configuration.");
      }
      const providerFactory = overrides.providerFactory ?? startA2AProvider;
      const provider = await providerFactory({
        host: config.provider.host,
        port: config.provider.port,
        ...(config.provider.publicBaseUrl === undefined ? {} : { publicBaseUrl: config.provider.publicBaseUrl }),
        allowNonLoopback: config.provider.allowNonLoopback,
        requireBearer: config.provider.requireBearer,
        ...(config.provider.bearerToken === undefined ? {} : { bearerToken: config.provider.bearerToken }),
        responder: input.responder,
        agent: {
          name: config.agent.name,
          description: config.agent.description,
          version: config.agent.version,
          ...(config.agent.providerOrganization === undefined || config.agent.providerUrl === undefined
            ? {}
            : {
                provider: {
                  organization: config.agent.providerOrganization,
                  url: config.agent.providerUrl,
                },
              }),
        },
        skill: config.skill,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: { agentCardUrl: provider.agentCardUrl },
        stop: () => provider.stop(),
      };
    },
  };
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
    async loadConfig(input) {
      // cwd is required so `webhook/*.md` endpoint files are discovered.
      return await loadWebhookAdapterConfig({ env: input.env, jsonPath: input.configPath, cwd: input.cwd });
    },
    isConfigError(error) {
      return error instanceof WebhookAdapterError;
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
      const adapterFactory = overrides.adapterFactory ?? startWebhookAdapter;
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
    async loadConfig(input) {
      return await loadOpenAIApiAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return error instanceof OpenAIApiAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "OpenAI API adapter is disabled.";
    },
    async start(input) {
      const adapterFactory = overrides.adapterFactory ?? startOpenAIApiAdapter;
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
      return {
        summary: { baseUrl: adapter.baseUrl },
        stop: () => adapter.stop(),
      };
    },
  };
}

export interface CronChannelOverrides {
  readonly adapterFactory?: (options: CronAdapterOptions) => CronAdapterStartResult;
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
  return {
    id: "cron",
    label: "Cron",
    async loadConfig(input) {
      return await loadCronAdapterConfig({ env: input.env, jsonPath: input.configPath, cwd: input.cwd });
    },
    isConfigError(error) {
      return error instanceof CronAdapterError;
    },
    disabledReason(config) {
      const enabledJobs = config.jobs.filter((job) => job.enabled);
      return enabledJobs.length > 0 ? undefined : "Cron adapter has no enabled jobs.";
    },
    async start(input) {
      const jobs = input.config.jobs.filter((job) => job.enabled);
      const jobById = new Map(jobs.map((job) => [job.id, job]));
      const adapterFactory = overrides.adapterFactory ?? startCronAdapter;
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
        })),
        onResult: (result) => {
          const level = result.kind === "failed" ? "error" : result.kind === "skipped" ? "warn" : "info";
          input.logger?.[level]?.("Cron job finished.", { result });
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

export interface WhatsAppChannelOverrides {
  /** Baileys multi-file auth state directory. Defaults to .mono-agent/whatsapp-auth. */
  readonly authDir?: string;
  readonly socketFactory?: WhatsAppSocketFactory;
  readonly startAdapter?: (options: StartWhatsAppAdapterOptions) => Promise<WhatsAppAdapterStartResult>;
}

export function createWhatsAppChannelDriver(
  overrides: WhatsAppChannelOverrides = {},
): ChannelDriver<WhatsAppAdapterConfig> {
  return {
    id: "whatsapp",
    label: "WhatsApp",
    async loadConfig(input) {
      return await loadWhatsAppAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return error instanceof WhatsAppAdapterConfigError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "WhatsApp is disabled.";
    },
    async start(input) {
      const startAdapter = overrides.startAdapter ?? startWhatsAppAdapter;
      const result = await startAdapter({
        authDir: overrides.authDir ?? resolve(input.cwd, ".mono-agent", "whatsapp-auth"),
        config: input.config,
        responder: input.responder,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        onQr: (qr) => {
          input.logger?.info?.("WhatsApp login QR code received; scan it with the WhatsApp app.", { qr });
        },
        ...(overrides.socketFactory === undefined ? {} : { createSocket: overrides.socketFactory }),
      });
      return {
        summary: {},
        stop: () => result.stop(),
      };
    },
  };
}

export interface ChannelDriverOverrides {
  readonly telegram?: TelegramChannelOverrides;
  readonly slack?: SlackChannelOverrides;
  readonly a2a?: A2AChannelOverrides;
  readonly webhook?: WebhookChannelOverrides;
  readonly openaiApi?: OpenAIApiChannelOverrides;
  readonly cron?: CronChannelOverrides;
  readonly whatsapp?: WhatsAppChannelOverrides;
}

/** Every channel the app can drive, in startup/status display order. */
export function defaultChannelDrivers(overrides: ChannelDriverOverrides = {}): readonly ChannelDriver[] {
  return [
    createTelegramChannelDriver(overrides.telegram),
    createSlackChannelDriver(overrides.slack),
    createA2AChannelDriver(overrides.a2a),
    createWebhookChannelDriver(overrides.webhook),
    createOpenAIApiChannelDriver(overrides.openaiApi),
    createCronChannelDriver(overrides.cron),
    createWhatsAppChannelDriver(overrides.whatsapp),
  ] as readonly ChannelDriver[];
}

function telegramStartOptions(
  input: ChannelStartInput<TelegramAdapterConfig>,
  overrides: TelegramChannelOverrides,
): TelegramAdapterStartOptions {
  // Subscribe to (and handle) inline-keyboard taps only when the `telegram_ask`
  // tool is permitted by the tool policy — so enabling the tool is the single
  // switch that turns on the whole ask/answer round-trip. Without it the bot
  // stays message-only and never registers the callback handler.
  const callbacksEnabled = isAdapterSendToolAllowed("telegram_ask", {
    allowedTools: input.coreConfig.tools.allowedTools,
    disallowedTools: input.coreConfig.tools.disallowedTools,
  });
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
    // A polling crash after a successful start must flip the channel to failed,
    // not leave it reported as running.
    onPollingError: (error) =>
      input.onFailure(error instanceof Error ? error.message : String(error)),
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
