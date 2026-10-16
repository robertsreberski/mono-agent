import type { CronAdapterOptions,CronAdapterStartResult } from "@mono-agent/trigger-cron";
import type { OpenAIApiAdapterOptions,OpenAIApiAdapterStartResult } from "@mono-agent/channel-openai-api";
import type { SlackAdapterStartOptions,SlackAdapterStartResult } from "@mono-agent/channel-slack";
import type { TelegramAdapterStartOptions,TelegramAdapterStartResult } from "@mono-agent/channel-telegram";
import type { TuiAdapterOptions,TuiAdapterStartResult } from "@mono-agent/channel-operator";
import type { WebhookAdapterOptions,WebhookAdapterStartResult } from "@mono-agent/trigger-webhook";
import type { discoverLocalProviders } from "@mono-agent/turn/host";
import type { DiscoveredLocalModel,LocalProviderDefinition } from "@mono-agent/turn/host/types";
import type { deliverWebNotification } from "@mono-agent/web";
import type { inspectCronControlStore,openCronControlStore } from "../cron-control-store.js";
import type { ChannelDriver as ContractChannelDriver,ChannelId as ContractChannelId,ChannelLogger,ChannelStartInput as ContractChannelStartInput } from "@mono-agent/contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
export type { ChannelLogger, ChannelStatus, NotifyDeliveryResult, RunningChannel } from "@mono-agent/contracts";
/**
 * The channel contract lives in @mono-agent/contracts so third-party
 * drivers depend on the neutral contracts package rather than this host.
 */
export type ChannelId = ContractChannelId;

export type MonoAgentAppLogger = ChannelLogger;

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

export interface ChannelDriverOverrides {
  readonly telegram?: TelegramChannelOverrides;
  readonly slack?: SlackChannelOverrides;
  readonly webhook?: WebhookChannelOverrides;
  readonly openaiApi?: OpenAIApiChannelOverrides;
  readonly cron?: CronChannelOverrides;
  readonly tui?: TuiChannelOverrides;
  /** Host-only dependency injection keyed by configured plugin package name. */
  readonly pluginFactoryOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface CronChannelOverrides {
  readonly adapterFactory?: (options: CronAdapterOptions) => CronAdapterStartResult;
  /** Test seam for the owner-private durable control store. */
  readonly inspectControlStore?: typeof inspectCronControlStore;
  /** Test seam for opening the owner-private durable control store. */
  readonly openControlStore?: typeof openCronControlStore;
  /** Test seam for cooldown decisions; production uses the system clock. */
  readonly now?: () => Date;
  /** Maximum wall-clock time before a hung run is aborted and its slot reclaimed. */
  readonly maxRunMs?: number;
}
export interface OpenAIApiChannelOverrides {
  readonly adapterFactory?: (options: OpenAIApiAdapterOptions) => Promise<OpenAIApiAdapterStartResult>;
}
export interface SlackChannelOverrides {
  readonly createApi?: SlackAdapterStartOptions["createApi"];
  readonly webSocketFactory?: SlackAdapterStartOptions["webSocketFactory"];
  readonly startAdapter?: (options: SlackAdapterStartOptions) => Promise<SlackAdapterStartResult>;
}
export interface TelegramChannelOverrides {
  readonly botFactory?: TelegramAdapterStartOptions["botFactory"];
  readonly runnerFactory?: TelegramAdapterStartOptions["runnerFactory"];
  readonly startAdapter?: (options: TelegramAdapterStartOptions) => Promise<TelegramAdapterStartResult>;
  /** Test seam: where `telegram.projects` reaches the web console. */
  readonly projectsWeb?: import("@mono-agent/web").DeliverWebNotificationOptions;
}
export interface TuiChannelOverrides {
  readonly adapterFactory?: (options: TuiAdapterOptions) => Promise<TuiAdapterStartResult>;
  /** Test seam: replaces the real local-provider model discovery call. */
  readonly discoverModels?: (
    providers: readonly LocalProviderDefinition[] | undefined,
  ) => Promise<readonly DiscoveredLocalModel[]>;
  /**
   * Test seam: replaces the zero-config local-provider probe. This one MUST be
   * injectable — the real implementation reaches localhost:11434 and
   * localhost:1234, so a developer with Ollama running would otherwise get
   * different test results from one who does not.
   */
  readonly discoverProviders?: typeof discoverLocalProviders;
  /** Test/embedding seam for the owner-private local web ingress. */
  readonly deliverNotification?: typeof deliverWebNotification;
}
export interface WebhookChannelOverrides {
  readonly adapterFactory?: (options: WebhookAdapterOptions) => Promise<WebhookAdapterStartResult>;
}
