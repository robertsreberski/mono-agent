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
  createAgentHarness,
  createAgentResponder,
  createInMemoryHistoryStore,
} from "@worklab-ai/agent-harness";
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
  AgentResponder,
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
  loadFinalAgentDemoConfig,
  redactFinalAgentDemoConfig,
  resolveFinalDemoArtifactDir,
  type LoadedFinalAgentDemoConfig,
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

export interface FinalAgentDemo {
  readonly operatorConsole: FinalAgentDemoOperatorConsole;
  readonly telegramStatus: TelegramStatus;
  startTelegramIfConfigured(reason: string): Promise<TelegramStatus>;
  stop(): Promise<void>;
}

interface RunningTelegram {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

interface FinalAgentDemoControllerOptions extends Required<Pick<FinalAgentDemoOptions, "cwd" | "configPath">> {
  readonly env: Record<string, string | undefined>;
  readonly logger?: FinalAgentDemoLogger;
  readonly runtime?: MonoRuntimeLike;
  readonly telegramApi?: TelegramBotApi;
  readonly pollerFactory?: (options: TelegramLongPollerOptions) => FinalAgentDemoPollerLike;
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
  });

  await controller.startTelegramIfConfigured("startup");
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
  private status: TelegramStatus = {
    kind: "waiting_for_config",
    reason: "Telegram has not been configured yet.",
  };
  private startInFlight: Promise<TelegramStatus> | undefined;
  private running: RunningTelegram | undefined;
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
  }) {
    this.consoleServer = input.consoleServer;
    this.cwd = input.cwd;
    this.configPath = input.configPath;
    this.env = input.env;
    this.logger = input.logger;
    this.runtime = input.runtime;
    this.telegramApi = input.telegramApi;
    this.pollerFactory = input.pollerFactory;
    this.operatorConsole = {
      url: input.consoleServer.url,
      appUrl: `${input.consoleServer.url}/?t=${input.consoleServer.token}`,
      token: input.consoleServer.token,
      configPath: input.configPath,
    };
  }

  get telegramStatus(): TelegramStatus {
    return this.status;
  }

  async startTelegramIfConfigured(reason: string): Promise<TelegramStatus> {
    if (this.stopped) {
      return this.status;
    }
    if (this.running !== undefined) {
      if (reason === "operator-console-write") {
        this.logger?.info?.("Telegram is already running; restart the demo to apply later config changes.", {
          status: "running",
        });
      }
      return this.status;
    }
    if (this.startInFlight !== undefined) {
      return await this.startInFlight;
    }

    this.startInFlight = this.startTelegram(reason)
      .finally(() => {
        this.startInFlight = undefined;
      });
    return await this.startInFlight;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.running?.controller.abort();
    await this.running?.promise.catch(() => undefined);
    await this.consoleServer.stop();
  }

  private async startTelegram(reason: string): Promise<TelegramStatus> {
    const loaded = await this.loadConfigOrWait();
    if (loaded === undefined) {
      return this.status;
    }
    const { coreConfig, telegramConfig } = loaded;

    try {
      const redacted = redactFinalAgentDemoConfig(loaded);
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
            this.status = { kind: "failed", reason: failure };
            this.logger?.error?.("Telegram polling stopped with an error.", { reason: failure });
          }
        });

      this.running = { controller, promise };
      this.status = { kind: "running", config: redacted };
      this.logger?.info?.("Telegram demo is running.", { reason, config: redacted });
      return this.status;
    } catch (error) {
      const failure = reasonOf(error);
      this.status = { kind: "failed", reason: failure };
      this.logger?.error?.("Telegram demo failed to start.", { reason: failure });
      return this.status;
    }
  }

  private async loadConfigOrWait(): Promise<LoadedFinalAgentDemoConfig | undefined> {
    try {
      return await loadFinalAgentDemoConfig({
        env: this.env,
        cwd: this.cwd,
        configPath: this.configPath,
      });
    } catch (error) {
      if (isFinalAgentDemoConfigError(error)) {
        this.status = { kind: "waiting_for_config", reason: error.message };
        this.logger?.info?.("Waiting for a valid Mono Agent config.", { reason: error.message });
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
