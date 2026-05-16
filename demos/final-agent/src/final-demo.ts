import { resolve } from "node:path";

import {
  startOperatorConsole,
} from "@worklab-ai/operator-console";
import type {
  OperatorConsoleEvent,
  OperatorConsoleOptions,
  OperatorConsoleStartResult,
} from "@worklab-ai/operator-console";
import type { MonoAgentConfig } from "@worklab-ai/config";
import {
  startA2AProvider,
} from "@worklab-ai/a2a-adapter";
import type {
  A2AAdapterConfig,
  A2AProviderOptions,
  A2AProviderStartResult,
} from "@worklab-ai/a2a-adapter";
import {
  createAgentHarness,
  createAgentResponder,
  createInMemoryHistoryStore,
} from "@worklab-ai/agent-harness";
import type { AgentResponder } from "@worklab-ai/agent-contracts";
import { createMarkdownMemoryStore } from "@worklab-ai/memory-md";
import { createJsonlRunRecorder } from "@worklab-ai/observability";
import {
  createMonoRuntime,
  runtimeOptionsForLocalProvider,
} from "@worklab-ai/runtime-adapter";
import type { MonoRuntimeLike } from "@worklab-ai/runtime-adapter";
import {
  TelegramBotApiClient,
  TelegramAdapter,
  TelegramLongPoller,
} from "@worklab-ai/telegram-adapter";
import type {
  TelegramBotApi,
  TelegramAdapterConfig,
  TelegramAdapterOptions,
  TelegramLongPollerOptions,
  TelegramLongPollerStartOptions,
} from "@worklab-ai/telegram-adapter";
import type { FieldGroup } from "@worklab-ai/settings";
import { createToolPolicy } from "@worklab-ai/tool-policy";
import type { ToolPolicyInput } from "@worklab-ai/tool-policy";
import {
  FINAL_DEMO_FIELD_GROUPS,
  isFinalAgentDemoConfigError,
  loadFinalAgentA2AConfig,
  loadFinalAgentCoreConfig,
  loadFinalAgentTelegramConfig,
  redactFinalAgentDemoConfig,
  resolveFinalDemoArtifactDir,
  type RedactedFinalAgentDemoConfig,
} from "./configuration.js";

export { resolveFinalDemoArtifactDir } from "./configuration.js";

export interface FinalAgentDemoLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface FinalAgentDemoPollerLike {
  start(options?: TelegramLongPollerStartOptions): Promise<void>;
}

export interface FinalAgentDemoOptions {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly configPath?: string;
  readonly operatorConsolePort?: number;
  readonly logger?: FinalAgentDemoLogger;
  readonly runtime?: MonoRuntimeLike;
  readonly telegramApi?: TelegramBotApi;
  readonly pollerFactory?: (options: TelegramLongPollerOptions) => FinalAgentDemoPollerLike;
  readonly a2aProviderFactory?: (options: A2AProviderOptions) => Promise<A2AProviderStartResult>;
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

export interface FinalAgentDemo {
  readonly operatorConsole: FinalAgentDemoOperatorConsole;
  readonly telegramStatus: TelegramStatus;
  readonly a2aStatus: A2AStatus;
  startTelegramIfConfigured(reason: string): Promise<TelegramStatus>;
  startA2AIfConfigured(reason: string): Promise<A2AStatus>;
  stop(): Promise<void>;
}

interface RunningTelegram {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

interface RunningA2A {
  readonly provider: A2AProviderStartResult;
}

interface FinalAgentDemoControllerOptions extends Required<Pick<FinalAgentDemoOptions, "cwd" | "configPath">> {
  readonly env: Record<string, string | undefined>;
  readonly logger?: FinalAgentDemoLogger;
  readonly runtime?: MonoRuntimeLike;
  readonly telegramApi?: TelegramBotApi;
  readonly pollerFactory?: (options: TelegramLongPollerOptions) => FinalAgentDemoPollerLike;
  readonly a2aProviderFactory?: (options: A2AProviderOptions) => Promise<A2AProviderStartResult>;
}

export async function startFinalAgentDemo(options: FinalAgentDemoOptions = {}): Promise<FinalAgentDemo> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.configPath ?? "mono-agent.config.json");
  const env = options.env ?? process.env;
  const consoleFactory = options.operatorConsoleFactory ?? startOperatorConsole;
  const fieldGroups = options.fieldGroups ?? FINAL_DEMO_FIELD_GROUPS;
  let controller: FinalAgentDemoController | undefined;

  const consoleServer = await consoleFactory({
    configPath,
    cwd,
    fieldGroups,
    observability: {
      artifactDir: () => resolveFinalDemoArtifactDir({ env, cwd, configPath }),
      maxRuns: 100,
      maxEventsPerRun: 750,
    },
    ...(options.operatorConsolePort === undefined ? {} : { port: options.operatorConsolePort }),
    log: (event) => {
      logOperatorConsoleEvent(options.logger, event);
      if (event.kind === "write") {
        void controller?.startTelegramIfConfigured("operator-console-write");
        void controller?.startA2AIfConfigured("operator-console-write");
      }
    },
  });

  controller = new FinalAgentDemoController({
    consoleServer,
    cwd,
    configPath,
    env,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.telegramApi === undefined ? {} : { telegramApi: options.telegramApi }),
    ...(options.pollerFactory === undefined ? {} : { pollerFactory: options.pollerFactory }),
    ...(options.a2aProviderFactory === undefined ? {} : { a2aProviderFactory: options.a2aProviderFactory }),
  });

  await Promise.all([
    controller.startTelegramIfConfigured("startup"),
    controller.startA2AIfConfigured("startup"),
  ]);
  return controller;
}

class FinalAgentDemoController implements FinalAgentDemo {
  readonly operatorConsole: FinalAgentDemoOperatorConsole;
  private readonly consoleServer: OperatorConsoleStartResult;
  private readonly cwd: string;
  private readonly configPath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly logger: FinalAgentDemoLogger | undefined;
  private readonly runtime: MonoRuntimeLike | undefined;
  private readonly telegramApi: TelegramBotApi | undefined;
  private readonly pollerFactory: ((options: TelegramLongPollerOptions) => FinalAgentDemoPollerLike) | undefined;
  private readonly a2aProviderFactory: ((options: A2AProviderOptions) => Promise<A2AProviderStartResult>) | undefined;
  private telegramStatusValue: TelegramStatus = {
    kind: "waiting_for_config",
    reason: "Telegram has not been configured yet.",
  };
  private a2aStatusValue: A2AStatus = {
    kind: "disabled",
    reason: "A2A provider is disabled.",
  };
  private telegramStartInFlight: Promise<TelegramStatus> | undefined;
  private a2aStartInFlight: Promise<A2AStatus> | undefined;
  private runningTelegram: RunningTelegram | undefined;
  private runningA2A: RunningA2A | undefined;
  private stopped = false;

  constructor(input: {
    readonly consoleServer: OperatorConsoleStartResult;
    readonly cwd: string;
    readonly configPath: string;
    readonly env: Record<string, string | undefined>;
    readonly logger?: FinalAgentDemoLogger;
    readonly runtime?: MonoRuntimeLike;
    readonly telegramApi?: TelegramBotApi;
    readonly pollerFactory?: (options: TelegramLongPollerOptions) => FinalAgentDemoPollerLike;
    readonly a2aProviderFactory?: (options: A2AProviderOptions) => Promise<A2AProviderStartResult>;
  }) {
    this.consoleServer = input.consoleServer;
    this.cwd = input.cwd;
    this.configPath = input.configPath;
    this.env = input.env;
    this.logger = input.logger;
    this.runtime = input.runtime;
    this.telegramApi = input.telegramApi;
    this.pollerFactory = input.pollerFactory;
    this.a2aProviderFactory = input.a2aProviderFactory;
    this.operatorConsole = {
      url: input.consoleServer.url,
      appUrl: `${input.consoleServer.url}/?t=${input.consoleServer.token}`,
      token: input.consoleServer.token,
      configPath: input.configPath,
    };
  }

  get telegramStatus(): TelegramStatus {
    return this.telegramStatusValue;
  }

  get a2aStatus(): A2AStatus {
    return this.a2aStatusValue;
  }

  async startTelegramIfConfigured(reason: string): Promise<TelegramStatus> {
    if (this.stopped) {
      return this.telegramStatusValue;
    }
    if (this.runningTelegram !== undefined) {
      if (reason === "operator-console-write") {
        this.logger?.info?.("Telegram is already running; restart the demo to apply later config changes.", {
          status: "running",
        });
      }
      return this.telegramStatusValue;
    }
    if (this.telegramStartInFlight !== undefined) {
      return await this.telegramStartInFlight;
    }

    this.telegramStartInFlight = this.startTelegram(reason)
      .finally(() => {
        this.telegramStartInFlight = undefined;
      });
    return await this.telegramStartInFlight;
  }

  async startA2AIfConfigured(reason: string): Promise<A2AStatus> {
    if (this.stopped) {
      return this.a2aStatusValue;
    }
    if (this.runningA2A !== undefined) {
      if (reason === "operator-console-write") {
        this.logger?.info?.("A2A provider is already running; restart the demo to apply later config changes.", {
          status: "running",
        });
      }
      return this.a2aStatusValue;
    }
    if (this.a2aStartInFlight !== undefined) {
      return await this.a2aStartInFlight;
    }

    this.a2aStartInFlight = this.startA2A(reason)
      .finally(() => {
        this.a2aStartInFlight = undefined;
      });
    return await this.a2aStartInFlight;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.runningTelegram?.controller.abort();
    await this.runningTelegram?.promise.catch(() => undefined);
    await this.runningA2A?.provider.stop().catch(() => undefined);
    await this.consoleServer.stop();
  }

  private async startTelegram(reason: string): Promise<TelegramStatus> {
    const coreConfig = await this.loadCoreConfigOrWait("telegram");
    if (coreConfig === undefined) {
      return this.telegramStatusValue;
    }
    const telegramConfig = await this.loadTelegramConfigOrWait();
    if (telegramConfig === undefined) {
      return this.telegramStatusValue;
    }

    try {
      const redacted = redactFinalAgentDemoConfig({ coreConfig, telegramConfig });
      const api = this.telegramApi ?? new TelegramBotApiClient({ token: telegramConfig.botToken });
      const runtime = this.runtime ?? createMonoRuntime({
        workspace: coreConfig.runtime.workspace,
        qaOutputDir: coreConfig.artifacts.dir,
      });
      const responder = createConfiguredResponder(coreConfig, runtime);
      const adapterOptions = buildAdapterOptions({
        api,
        responder,
        telegramConfig,
        ...(this.logger === undefined ? {} : { logger: this.logger }),
      });
      const adapter = new TelegramAdapter(adapterOptions);
      const pollerOptions = buildPollerOptions({
        api,
        adapter,
        ...(this.logger === undefined ? {} : { logger: this.logger }),
      });
      const poller = this.pollerFactory?.(pollerOptions) ?? new TelegramLongPoller(pollerOptions);
      const controller = new AbortController();
      const promise = poller.start({ signal: controller.signal })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            const failure = reasonOf(error);
            this.telegramStatusValue = { kind: "failed", reason: failure };
            this.logger?.error?.("Telegram polling stopped with an error.", { reason: failure });
          }
        });

      this.runningTelegram = { controller, promise };
      this.telegramStatusValue = { kind: "running", config: redacted };
      this.logger?.info?.("Telegram demo is running.", { reason, config: redacted });
      return this.telegramStatusValue;
    } catch (error) {
      const failure = reasonOf(error);
      this.telegramStatusValue = { kind: "failed", reason: failure };
      this.logger?.error?.("Telegram demo failed to start.", { reason: failure });
      return this.telegramStatusValue;
    }
  }

  private async startA2A(reason: string): Promise<A2AStatus> {
    const a2aConfig = await this.loadA2AConfigOrWait();
    if (a2aConfig === undefined) {
      return this.a2aStatusValue;
    }
    if (!a2aConfig.provider.enabled) {
      this.a2aStatusValue = { kind: "disabled", reason: "A2A provider is disabled." };
      return this.a2aStatusValue;
    }
    const coreConfig = await this.loadCoreConfigOrWait("a2a");
    if (coreConfig === undefined) {
      return this.a2aStatusValue;
    }
    if (a2aConfig.agent === undefined || a2aConfig.skill === undefined) {
      this.a2aStatusValue = {
        kind: "waiting_for_config",
        reason: "A2A provider requires agent and skill configuration.",
      };
      return this.a2aStatusValue;
    }

    try {
      const runtime = this.runtime ?? createMonoRuntime({
        workspace: coreConfig.runtime.workspace,
        qaOutputDir: coreConfig.artifacts.dir,
      });
      const responder = createConfiguredResponder(coreConfig, runtime);
      const providerFactory = this.a2aProviderFactory ?? startA2AProvider;
      const provider = await providerFactory({
        host: a2aConfig.provider.host,
        port: a2aConfig.provider.port,
        ...(a2aConfig.provider.publicBaseUrl === undefined ? {} : { publicBaseUrl: a2aConfig.provider.publicBaseUrl }),
        allowNonLoopback: a2aConfig.provider.allowNonLoopback,
        requireBearer: a2aConfig.provider.requireBearer,
        ...(a2aConfig.provider.bearerToken === undefined ? {} : { bearerToken: a2aConfig.provider.bearerToken }),
        responder,
        agent: {
          name: a2aConfig.agent.name,
          description: a2aConfig.agent.description,
          version: a2aConfig.agent.version,
          ...(a2aConfig.agent.providerOrganization === undefined || a2aConfig.agent.providerUrl === undefined
            ? {}
            : {
                provider: {
                  organization: a2aConfig.agent.providerOrganization,
                  url: a2aConfig.agent.providerUrl,
                },
              }),
        },
        skill: a2aConfig.skill,
        ...(this.logger === undefined ? {} : { logger: this.logger }),
      });
      const redacted = redactFinalAgentDemoConfig({ coreConfig, a2aConfig });
      this.runningA2A = { provider };
      this.a2aStatusValue = {
        kind: "running",
        agentCardUrl: provider.agentCardUrl,
        config: redacted,
      };
      this.logger?.info?.("A2A provider is running.", {
        reason,
        agentCardUrl: provider.agentCardUrl,
        config: redacted,
      });
      return this.a2aStatusValue;
    } catch (error) {
      const failure = reasonOf(error);
      this.a2aStatusValue = { kind: "failed", reason: failure };
      this.logger?.error?.("A2A provider failed to start.", { reason: failure });
      return this.a2aStatusValue;
    }
  }

  private async loadCoreConfigOrWait(adapter: "telegram" | "a2a"): Promise<MonoAgentConfig | undefined> {
    try {
      return await loadFinalAgentCoreConfig({
        env: this.env,
        cwd: this.cwd,
        configPath: this.configPath,
      });
    } catch (error) {
      if (isFinalAgentDemoConfigError(error)) {
        if (adapter === "telegram") {
          this.telegramStatusValue = { kind: "waiting_for_config", reason: error.message };
        } else {
          this.a2aStatusValue = { kind: "waiting_for_config", reason: error.message };
        }
        this.logger?.info?.("Waiting for a valid Mono Agent config.", { reason: error.message });
        return undefined;
      }
      throw error;
    }
  }

  private async loadTelegramConfigOrWait(): Promise<TelegramAdapterConfig | undefined> {
    try {
      return await loadFinalAgentTelegramConfig({
        env: this.env,
        cwd: this.cwd,
        configPath: this.configPath,
      });
    } catch (error) {
      if (isFinalAgentDemoConfigError(error)) {
        this.telegramStatusValue = { kind: "waiting_for_config", reason: error.message };
        this.logger?.info?.("Waiting for a valid Telegram config.", { reason: error.message });
        return undefined;
      }
      throw error;
    }
  }

  private async loadA2AConfigOrWait(): Promise<A2AAdapterConfig | undefined> {
    try {
      return await loadFinalAgentA2AConfig({
        env: this.env,
        cwd: this.cwd,
        configPath: this.configPath,
      });
    } catch (error) {
      if (isFinalAgentDemoConfigError(error)) {
        this.a2aStatusValue = { kind: "waiting_for_config", reason: error.message };
        this.logger?.info?.("Waiting for a valid A2A config.", { reason: error.message });
        return undefined;
      }
      throw error;
    }
  }
}

function createConfiguredResponder(config: MonoAgentConfig, runtime: MonoRuntimeLike): AgentResponder {
  const memory = config.memory === undefined
    ? undefined
    : createMarkdownMemoryStore({
        path: config.memory.path,
        maxBytes: config.memory.maxBytes,
        scope: config.memory.scope,
      });
  const historyStore = createInMemoryHistoryStore({ maxMessages: config.runtime.maxTurns * 2 });
  const harness = createAgentHarness({
    identityPath: config.context.identityPath,
    ...(config.context.soulPath === undefined ? {} : { soulPath: config.context.soulPath }),
    ...(config.context.skillsRoot === undefined ? {} : { skillsRoot: config.context.skillsRoot }),
    selectedSkills: config.context.selectedSkills,
    runtime,
    model: config.runtime.model,
    executionMode: config.runtime.executionMode,
    cwd: config.runtime.workspace,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    maxTurns: config.runtime.maxTurns,
    runtimeOptions: runtimeOptionsForLocalProvider(config.runtime.model, config.providers?.local),
    ...(memory === undefined ? {} : { memory }),
    memoryWriteMode: config.memory?.writeMode ?? "disabled",
    historyStore,
    toolPolicy: createToolPolicy(loadToolPolicyInput(config)),
    recorderFactory: ({ runId, conversationId }) => createJsonlRunRecorder({
      runId,
      conversationId,
      artifactDir: config.artifacts.dir,
    }),
  });
  return createAgentResponder({ harness }) as AgentResponder;
}

function loadToolPolicyInput(config: MonoAgentConfig): ToolPolicyInput {
  return {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
    ...(config.tools.mcpConfigPath === undefined ? {} : { mcpConfigPath: config.tools.mcpConfigPath }),
  };
}

function buildAdapterOptions(input: {
  readonly api: TelegramBotApi;
  readonly responder: AgentResponder;
  readonly telegramConfig: TelegramAdapterConfig;
  readonly logger?: FinalAgentDemoLogger;
}): TelegramAdapterOptions {
  return {
    api: input.api,
    responder: input.responder,
    allowedChatIds: [...input.telegramConfig.allowedChatIds],
    allowAllChats: input.telegramConfig.allowAllChats,
    stream: {
      initialStatusText: "Mono Agent is thinking…",
      editDebounceMs: 350,
    },
    messages: {
      welcomeText: "Mono Agent is online. Send a message to run the configured runtime.",
      helpText: "Send a message to talk to Mono Agent. Use /cancel to stop an in-flight response.",
      unauthorizedText: "This chat is not allowlisted for this Mono Agent demo.",
      errorText: "Mono Agent failed honestly; check the local artifact summary for details.",
    },
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  };
}

function buildPollerOptions(input: {
  readonly api: TelegramBotApi;
  readonly adapter: TelegramAdapter;
  readonly logger?: FinalAgentDemoLogger;
}): TelegramLongPollerOptions {
  return {
    api: input.api,
    adapter: input.adapter,
    deleteWebhookOnStart: true,
    allowedUpdates: ["message"],
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  };
}

function logOperatorConsoleEvent(logger: FinalAgentDemoLogger | undefined, event: OperatorConsoleEvent): void {
  if (event.kind === "validation_failed" || event.kind === "unauthorized") {
    logger?.warn?.("Operator Console event.", { event });
    return;
  }
  logger?.debug?.("Operator Console event.", { event });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
