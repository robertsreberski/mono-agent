import {
  createA2AChannelDriver,
  createCronChannelDriver,
  createOpenAIApiChannelDriver,
  createTelegramChannelDriver,
  createWebhookChannelDriver,
  startMonoAgentApp,
} from "@mono-agent/agent-app";
import type {
  ChannelDriver,
  ChannelStartInput,
  ChannelStatus,
  MonoAgentApp,
  MonoAgentAppLogger,
  TraceabilityStatus as AppTraceabilityStatus,
} from "@mono-agent/agent-app";
import type { ConfigApplyResult, OperatorConsoleOptions, OperatorConsoleStartResult } from "@mono-agent/operator-console";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { A2AProviderOptions, A2AProviderStartResult } from "@mono-agent/a2a-adapter";
import type { CronAdapterOptions, CronAdapterStartResult } from "@mono-agent/cron-adapter";
import type { OpenAIApiAdapterOptions, OpenAIApiAdapterStartResult } from "@mono-agent/openai-api-adapter";
import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";
import type {
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
} from "@mono-agent/telegram-adapter";
import type { WebhookAdapterOptions, WebhookAdapterStartResult } from "@mono-agent/webhook-adapter";
import type { FieldGroup } from "@mono-agent/settings";

import {
  FINAL_DEMO_FIELD_GROUPS,
  FINAL_DEMO_TRACE_DEFAULTS,
  redactFinalAgentDemoConfig,
} from "./configuration.js";
import type { RedactedFinalAgentDemoConfig } from "./configuration.js";

export {
  resolveFinalDemoArtifactDir,
  resolveFinalDemoTraceRegistryDir,
} from "./configuration.js";
export type { RedactedFinalAgentDemoConfig } from "./configuration.js";

export type FinalAgentDemoLogger = MonoAgentAppLogger;

/**
 * The final demo is now a thin composition over @mono-agent/agent-app: it
 * selects the five demo channels, wires the demo's DI seams into channel
 * driver overrides, and keeps its historical status shapes (which carry the
 * redacted channel configs) on top of the app's channel statuses.
 */
export interface FinalAgentDemoOptions {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly configPath?: string;
  readonly operatorConsolePort?: number;
  readonly logger?: FinalAgentDemoLogger;
  readonly runtime?: MonoRuntimeLike;
  readonly telegramStartAdapter?: (
    options: TelegramAdapterStartOptions,
  ) => Promise<TelegramAdapterStartResult>;
  readonly a2aProviderFactory?: (options: A2AProviderOptions) => Promise<A2AProviderStartResult>;
  readonly webhookAdapterFactory?: (options: WebhookAdapterOptions) => Promise<WebhookAdapterStartResult>;
  readonly openAIApiAdapterFactory?: (options: OpenAIApiAdapterOptions) => Promise<OpenAIApiAdapterStartResult>;
  readonly cronAdapterFactory?: (options: CronAdapterOptions) => CronAdapterStartResult;
  readonly operatorConsoleFactory?: (options: OperatorConsoleOptions) => Promise<OperatorConsoleStartResult>;
  readonly fieldGroups?: readonly FieldGroup[];
}

export interface FinalAgentDemoOperatorConsole {
  /** Base loopback URL for API calls, without the token query string. */
  readonly url: string;
  /** Browser URL that includes the per-boot operator console token. */
  readonly appUrl: string;
  readonly token: string;
  readonly configPath: string;
}

export type TelegramStatus =
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "waiting_for_config"; readonly reason: string }
  | { readonly kind: "running"; readonly config: RedactedFinalAgentDemoConfig }
  | { readonly kind: "failed"; readonly reason: string };

export type A2AStatus =
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "waiting_for_config"; readonly reason: string }
  | {
      readonly kind: "running";
      readonly agentCardUrl: string;
      readonly config: RedactedFinalAgentDemoConfig;
    }
  | { readonly kind: "failed"; readonly reason: string };

export type WebhookStatus =
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "waiting_for_config"; readonly reason: string }
  | {
      readonly kind: "running";
      readonly invokeUrl: string;
      readonly config: RedactedFinalAgentDemoConfig;
    }
  | { readonly kind: "failed"; readonly reason: string };

export type OpenAIApiStatus =
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "waiting_for_config"; readonly reason: string }
  | {
      readonly kind: "running";
      readonly baseUrl: string;
      readonly config: RedactedFinalAgentDemoConfig;
    }
  | { readonly kind: "failed"; readonly reason: string };

export type CronStatus =
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "waiting_for_config"; readonly reason: string }
  | {
      readonly kind: "running";
      readonly jobs: number;
      readonly config: RedactedFinalAgentDemoConfig;
    }
  | { readonly kind: "failed"; readonly reason: string };

export type TraceabilityStatus = AppTraceabilityStatus;

export interface FinalAgentDemo {
  readonly operatorConsole: FinalAgentDemoOperatorConsole;
  readonly telegramStatus: TelegramStatus;
  readonly a2aStatus: A2AStatus;
  readonly webhookStatus: WebhookStatus;
  readonly openAIApiStatus: OpenAIApiStatus;
  readonly cronStatus: CronStatus;
  readonly traceabilityStatus: TraceabilityStatus;
  applyConfigChange(reason: string): Promise<ConfigApplyResult>;
  startTelegramIfConfigured(reason: string): Promise<TelegramStatus>;
  startA2AIfConfigured(reason: string): Promise<A2AStatus>;
  startWebhookIfConfigured(reason: string): Promise<WebhookStatus>;
  startOpenAIApiIfConfigured(reason: string): Promise<OpenAIApiStatus>;
  startCronIfConfigured(reason: string): Promise<CronStatus>;
  stop(): Promise<void>;
}

export async function startFinalAgentDemo(options: FinalAgentDemoOptions = {}): Promise<FinalAgentDemo> {
  const drivers: readonly ChannelDriver[] = [
    withRedactedDemoConfig(
      createTelegramChannelDriver(
        options.telegramStartAdapter === undefined ? {} : { startAdapter: options.telegramStartAdapter },
      ),
      (config, coreConfig) => redactFinalAgentDemoConfig({ coreConfig, telegramConfig: config }),
    ),
    withRedactedDemoConfig(
      createA2AChannelDriver(
        options.a2aProviderFactory === undefined ? {} : { providerFactory: options.a2aProviderFactory },
      ),
      (config, coreConfig) => redactFinalAgentDemoConfig({ coreConfig, a2aConfig: config }),
    ),
    withRedactedDemoConfig(
      createWebhookChannelDriver(
        options.webhookAdapterFactory === undefined ? {} : { adapterFactory: options.webhookAdapterFactory },
      ),
      (config, coreConfig) => redactFinalAgentDemoConfig({ coreConfig, webhookConfig: config }),
    ),
    withRedactedDemoConfig(
      createOpenAIApiChannelDriver(
        options.openAIApiAdapterFactory === undefined ? {} : { adapterFactory: options.openAIApiAdapterFactory },
      ),
      (config, coreConfig) => redactFinalAgentDemoConfig({ coreConfig, openAIApiConfig: config }),
    ),
    withRedactedDemoConfig(
      createCronChannelDriver(
        options.cronAdapterFactory === undefined ? {} : { adapterFactory: options.cronAdapterFactory },
      ),
      (config, coreConfig) => redactFinalAgentDemoConfig({ coreConfig, cronConfig: config }),
    ),
  ];

  const app = await startMonoAgentApp({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.operatorConsolePort === undefined ? {} : { operatorConsolePort: options.operatorConsolePort }),
    ...(options.operatorConsoleFactory === undefined ? {} : { operatorConsoleFactory: options.operatorConsoleFactory }),
    drivers,
    fieldGroups: options.fieldGroups ?? FINAL_DEMO_FIELD_GROUPS,
    traceDefaults: FINAL_DEMO_TRACE_DEFAULTS,
  });

  return new FinalAgentDemoFacade(app);
}

/**
 * Enrich a channel driver's running summary with the demo's redacted
 * core+channel config so the demo statuses keep their historical shape.
 */
function withRedactedDemoConfig<TConfig>(
  driver: ChannelDriver<TConfig>,
  redact: (config: TConfig, coreConfig: MonoAgentConfig) => RedactedFinalAgentDemoConfig,
): ChannelDriver<TConfig> {
  return {
    ...driver,
    async start(input: ChannelStartInput<TConfig>) {
      const running = await driver.start(input);
      return {
        ...running,
        summary: { ...running.summary, config: redact(input.config, input.coreConfig) },
      };
    },
  };
}

class FinalAgentDemoFacade implements FinalAgentDemo {
  readonly operatorConsole: FinalAgentDemoOperatorConsole;

  constructor(private readonly app: MonoAgentApp) {
    if (app.operatorConsole === undefined) {
      throw new Error("Final agent demo requires the operator console.");
    }
    this.operatorConsole = app.operatorConsole;
  }

  get telegramStatus(): TelegramStatus {
    const status = this.app.channelStatus("telegram");
    if (status.kind === "running") {
      return { kind: "running", config: demoConfigOf(status) };
    }
    return status;
  }

  get a2aStatus(): A2AStatus {
    const status = this.app.channelStatus("a2a");
    if (status.kind === "running") {
      return {
        kind: "running",
        agentCardUrl: String(status.summary.agentCardUrl),
        config: demoConfigOf(status),
      };
    }
    return status;
  }

  get webhookStatus(): WebhookStatus {
    const status = this.app.channelStatus("webhook");
    if (status.kind === "running") {
      return {
        kind: "running",
        invokeUrl: String(status.summary.invokeUrl),
        config: demoConfigOf(status),
      };
    }
    return status;
  }

  get openAIApiStatus(): OpenAIApiStatus {
    const status = this.app.channelStatus("openai-api");
    if (status.kind === "running") {
      return {
        kind: "running",
        baseUrl: String(status.summary.baseUrl),
        config: demoConfigOf(status),
      };
    }
    return status;
  }

  get cronStatus(): CronStatus {
    const status = this.app.channelStatus("cron");
    if (status.kind === "running") {
      return {
        kind: "running",
        jobs: Number(status.summary.jobs),
        config: demoConfigOf(status),
      };
    }
    return status;
  }

  get traceabilityStatus(): TraceabilityStatus {
    return this.app.traceabilityStatus;
  }

  async applyConfigChange(reason: string): Promise<ConfigApplyResult> {
    return await this.app.applyConfigChange(reason);
  }

  async startTelegramIfConfigured(reason: string): Promise<TelegramStatus> {
    await this.app.startChannelIfConfigured("telegram", reason);
    return this.telegramStatus;
  }

  async startA2AIfConfigured(reason: string): Promise<A2AStatus> {
    await this.app.startChannelIfConfigured("a2a", reason);
    return this.a2aStatus;
  }

  async startWebhookIfConfigured(reason: string): Promise<WebhookStatus> {
    await this.app.startChannelIfConfigured("webhook", reason);
    return this.webhookStatus;
  }

  async startOpenAIApiIfConfigured(reason: string): Promise<OpenAIApiStatus> {
    await this.app.startChannelIfConfigured("openai-api", reason);
    return this.openAIApiStatus;
  }

  async startCronIfConfigured(reason: string): Promise<CronStatus> {
    await this.app.startChannelIfConfigured("cron", reason);
    return this.cronStatus;
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

function demoConfigOf(status: Extract<ChannelStatus, { kind: "running" }>): RedactedFinalAgentDemoConfig {
  return status.summary.config as RedactedFinalAgentDemoConfig;
}
