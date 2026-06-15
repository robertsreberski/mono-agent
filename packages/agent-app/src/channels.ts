import { resolve } from "node:path";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  A2AConsumerError,
  A2AProviderError,
  startA2AProvider,
} from "@mono-agent/a2a-adapter";
import type { A2AAdapterConfig, A2AProviderOptions, A2AProviderStartResult } from "@mono-agent/a2a-adapter";
import { loadA2AAdapterConfig } from "@mono-agent/a2a-adapter";
import { CronAdapterError, loadCronAdapterConfig, startCronAdapter } from "@mono-agent/cron-adapter";
import type { CronAdapterConfig, CronAdapterOptions, CronAdapterStartResult } from "@mono-agent/cron-adapter";
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
  loadTelegramAdapterConfig,
  startTelegramAdapter,
  TelegramAdapterConfigError,
} from "@mono-agent/telegram-adapter";
import type {
  TelegramAdapterConfig,
  TelegramAdapterErrorTextInput,
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
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

import type { MonoAgentAppConfigInput } from "./app-config.js";

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
}

export interface ChannelStartInput<TConfig> {
  readonly config: TConfig;
  readonly coreConfig: MonoAgentConfig;
  readonly responder: AgentResponder;
  readonly cwd: string;
  readonly logger?: MonoAgentAppLogger;
  /** Reports a transport that died after a successful start (e.g. polling loop). */
  readonly onFailure: (reason: string) => void;
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
      };
    },
  };
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
      const result = await startAdapter({
        botToken: input.config.botToken,
        appToken: input.config.appToken,
        allowedChannelIds: input.config.allowedChannelIds,
        allowAllChannels: input.config.allowAllChannels,
        botUserIds: input.config.botUserIds,
        mentionTextAliases: input.config.mentionTextAliases,
        stripMentionText: input.config.stripMentionText,
        responder: input.responder,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        ...(overrides.createApi === undefined ? {} : { createApi: overrides.createApi }),
        ...(overrides.webSocketFactory === undefined ? {} : { webSocketFactory: overrides.webSocketFactory }),
      });
      return {
        summary: {},
        stop: () => result.stop(),
      };
    },
  };
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

export function createWebhookChannelDriver(
  overrides: WebhookChannelOverrides = {},
): ChannelDriver<WebhookAdapterConfig> {
  return {
    id: "webhook",
    label: "Webhook",
    async loadConfig(input) {
      return await loadWebhookAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return error instanceof WebhookAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Webhook adapter is disabled.";
    },
    async start(input) {
      const adapterFactory = overrides.adapterFactory ?? startWebhookAdapter;
      const adapter = await adapterFactory({
        host: input.config.host,
        port: input.config.port,
        path: input.config.path,
        allowNonLoopback: input.config.allowNonLoopback,
        defaultMode: input.config.defaultMode,
        retentionMs: input.config.retentionMs,
        maxStoredRequests: input.config.maxStoredRequests,
        responder: input.responder,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: { invokeUrl: adapter.invokeUrl },
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
      const adapterFactory = overrides.adapterFactory ?? startCronAdapter;
      const adapter = adapterFactory({
        responder: input.responder,
        jobs: jobs.map((job) => ({
          id: job.id,
          expression: job.expression,
          timezone: job.timezone,
          prompt: job.prompt,
          ...(job.conversationId === undefined ? {} : { conversationId: job.conversationId }),
        })),
        onResult: (result) => {
          const level = result.kind === "failed" ? "error" : result.kind === "skipped" ? "warn" : "info";
          input.logger?.[level]?.("Cron job finished.", { result });
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
  return {
    botToken: input.config.botToken,
    allowedChatIds: [...input.config.allowedChatIds],
    allowAllChats: input.config.allowAllChats,
    responder: input.responder,
    allowedUpdates: ["message"],
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
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(overrides.botFactory === undefined ? {} : { botFactory: overrides.botFactory }),
    ...(overrides.runnerFactory === undefined ? {} : { runnerFactory: overrides.runnerFactory }),
  };
}

function telegramErrorText(input: TelegramAdapterErrorTextInput): string {
  const failure = failureFromUnknown(input.error);
  if (failure?.kind === "usage_limit") {
    const maxTurns = nestedNumber(failure.details, ["diagnostics", "max_turns"]);
    return [
      `I hit the runtime turn limit${maxTurns === undefined ? "" : ` (${maxTurns} turns)`} before I could finish.`,
      "Send a narrower follow-up, or check the local artifact summary for the incomplete run.",
    ].join(" ");
  }
  if (failure?.kind === "cancelled") {
    return "Cancelled.";
  }
  if (failure?.message !== undefined && failure.message.trim().length > 0) {
    return `I could not complete that message: ${failure.message}`;
  }
  return "I could not complete that message. Check the local artifact summary for details.";
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
