import { resolve } from "node:path";

import {
  CORE_FIELD_GROUPS,
  defineFieldGroup,
  startConfigUiBridge,
} from "@worklab-ai/config-ui";
import type {
  ConfigUiBridgeEvent,
  ConfigUiBridgeOptions,
  ConfigUiBridgeStartResult,
  FieldGroup,
} from "@worklab-ai/config-ui";
import {
  loadMonoAgentConfigWithSources,
  MonoAgentConfigError,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
} from "@worklab-ai/config";
import type {
  MonoAgentConfig,
  RedactedMonoAgentConfig,
} from "@worklab-ai/config";
import {
  createAgentHarness,
  createAgentResponder,
  createInMemoryHistoryStore,
} from "@worklab-ai/agent-harness";
import { createMarkdownMemoryStore } from "@worklab-ai/memory-md";
import { createJsonlRunRecorder } from "@worklab-ai/observability";
import {
  createMonoRuntime,
} from "@worklab-ai/runtime-adapter";
import type { MonoRuntimeLike } from "@worklab-ai/runtime-adapter";
import {
  TelegramBotApiClient,
  TelegramBridge,
  TelegramLongPoller,
} from "@worklab-ai/telegram-bridge";
import type {
  AgentResponder,
  TelegramBotApi,
  TelegramBridgeOptions,
  TelegramLongPollerOptions,
  TelegramLongPollerStartOptions,
} from "@worklab-ai/telegram-bridge";
import { createToolPolicy } from "@worklab-ai/tool-policy";
import type { ToolPolicyInput } from "@worklab-ai/tool-policy";

const FINAL_DEMO_FIELD_GROUPS: readonly FieldGroup[] = [
  ...CORE_FIELD_GROUPS,
  defineFieldGroup({
    id: "artifacts",
    label: "Artifacts",
    description: "Where run event JSONL files and summaries are written.",
    fields: [
      {
        id: "artifacts.dir",
        label: "Artifact directory",
        description: "Directory for observability events and run summaries.",
        kind: "path",
        placeholder: "./.mono-agent/artifacts",
        path: ["artifacts", "dir"],
      },
    ],
  }),
];

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
  readonly configUiPort?: number;
  readonly logger?: FinalAgentDemoLogger;
  readonly runtime?: MonoRuntimeLike;
  readonly telegramApi?: TelegramBotApi;
  readonly pollerFactory?: (options: TelegramLongPollerOptions) => FinalAgentDemoPollerLike;
  readonly configUiBridgeFactory?: (options: ConfigUiBridgeOptions) => Promise<ConfigUiBridgeStartResult>;
  readonly fieldGroups?: readonly FieldGroup[];
}

export interface FinalAgentDemoConfigUi {
  /** Base loopback URL for API calls, without the token query string. */
  readonly url: string;
  /** Browser URL that includes the per-boot config UI token. */
  readonly appUrl: string;
  readonly token: string;
  readonly configPath: string;
}

export type TelegramStatus =
  | { readonly kind: "waiting_for_config"; readonly reason: string }
  | { readonly kind: "running"; readonly config: RedactedMonoAgentConfig }
  | { readonly kind: "failed"; readonly reason: string };

export interface FinalAgentDemo {
  readonly configUi: FinalAgentDemoConfigUi;
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
  const bridgeFactory = options.configUiBridgeFactory ?? startConfigUiBridge;
  const fieldGroups = options.fieldGroups ?? FINAL_DEMO_FIELD_GROUPS;
  let controller: FinalAgentDemoController | undefined;

  const bridge = await bridgeFactory({
    configPath,
    cwd,
    fieldGroups,
    observability: {
      artifactDir: () => resolveFinalDemoArtifactDir({ env, cwd, configPath }),
      maxRuns: 100,
      maxEventsPerRun: 750,
    },
    ...(options.configUiPort === undefined ? {} : { port: options.configUiPort }),
    log: (event) => {
      logConfigUiEvent(options.logger, event);
      if (event.kind === "write") {
        void controller?.startTelegramIfConfigured("config-ui-write");
      }
    },
  });

  controller = new FinalAgentDemoController({
    bridge,
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

export async function resolveFinalDemoArtifactDir(input: {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configPath: string;
}): Promise<string> {
  const envDir = input.env.MONO_AGENT_ARTIFACT_DIR?.trim();
  if (envDir !== undefined && envDir.length > 0) {
    return resolve(input.cwd, envDir);
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const configDir = typeof json.artifacts?.dir === "string" ? json.artifacts.dir.trim() : "";
    if (configDir.length > 0) {
      return resolve(input.cwd, configDir);
    }
  } catch {
    // Keep Observability usable for already-written default artifacts even while
    // the user is fixing an incomplete or invalid demo config.
  }

  return resolve(input.cwd, ".mono-agent", "artifacts");
}

class FinalAgentDemoController implements FinalAgentDemo {
  readonly configUi: FinalAgentDemoConfigUi;
  private readonly bridge: ConfigUiBridgeStartResult;
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
    readonly bridge: ConfigUiBridgeStartResult;
    readonly cwd: string;
    readonly configPath: string;
    readonly env: Record<string, string | undefined>;
    readonly logger?: FinalAgentDemoLogger;
    readonly runtime?: MonoRuntimeLike;
    readonly telegramApi?: TelegramBotApi;
    readonly pollerFactory?: (options: TelegramLongPollerOptions) => FinalAgentDemoPollerLike;
  }) {
    this.bridge = input.bridge;
    this.cwd = input.cwd;
    this.configPath = input.configPath;
    this.env = input.env;
    this.logger = input.logger;
    this.runtime = input.runtime;
    this.telegramApi = input.telegramApi;
    this.pollerFactory = input.pollerFactory;
    this.configUi = {
      url: input.bridge.url,
      appUrl: `${input.bridge.url}/?t=${input.bridge.token}`,
      token: input.bridge.token,
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
      if (reason === "config-ui-write") {
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
    await this.bridge.stop();
  }

  private async startTelegram(reason: string): Promise<TelegramStatus> {
    const config = await this.loadConfigOrWait();
    if (config === undefined) {
      return this.status;
    }

    try {
      const redacted = redactMonoAgentConfig(config);
      const api = this.telegramApi ?? new TelegramBotApiClient({ token: config.telegram.botToken });
      const runtime = this.runtime ?? createMonoRuntime({
        workspace: config.runtime.workspace,
        qaOutputDir: config.artifacts.dir,
      });
      const responder = createConfiguredResponder(config, runtime);
      const bridgeOptions = buildBridgeOptions({
        api,
        responder,
        config,
        ...(this.logger === undefined ? {} : { logger: this.logger }),
      });
      const bridge = new TelegramBridge(bridgeOptions);
      const pollerOptions = buildPollerOptions({
        api,
        bridge,
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

  private async loadConfigOrWait(): Promise<MonoAgentConfig | undefined> {
    try {
      return await loadMonoAgentConfigWithSources({
        env: this.env,
        cwd: this.cwd,
        jsonPath: this.configPath,
      });
    } catch (error) {
      if (error instanceof MonoAgentConfigError) {
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

function buildBridgeOptions(input: {
  readonly api: TelegramBotApi;
  readonly responder: AgentResponder;
  readonly config: MonoAgentConfig;
  readonly logger?: FinalAgentDemoLogger;
}): TelegramBridgeOptions {
  return {
    api: input.api,
    responder: input.responder,
    allowedChatIds: [...input.config.telegram.allowedChatIds],
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
  readonly bridge: TelegramBridge;
  readonly logger?: FinalAgentDemoLogger;
}): TelegramLongPollerOptions {
  return {
    api: input.api,
    bridge: input.bridge,
    deleteWebhookOnStart: true,
    allowedUpdates: ["message"],
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  };
}

function logConfigUiEvent(logger: FinalAgentDemoLogger | undefined, event: ConfigUiBridgeEvent): void {
  if (event.kind === "validation_failed" || event.kind === "unauthorized") {
    logger?.warn?.("Config UI event.", { event });
    return;
  }
  logger?.debug?.("Config UI event.", { event });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
