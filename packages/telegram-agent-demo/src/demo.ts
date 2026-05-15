import { createAgentHarness, createAgentResponder, createInMemoryHistoryStore } from "@worklab-ai/agent-harness";
import { loadMonoAgentConfig, redactMonoAgentConfig } from "@worklab-ai/config";
import type { MonoAgentConfig, RedactedMonoAgentConfig } from "@worklab-ai/config";
import { createMarkdownMemoryStore } from "@worklab-ai/memory-md";
import { createJsonlRunRecorder } from "@worklab-ai/observability";
import type { MonoRuntimeLike } from "@worklab-ai/runtime-adapter";
import { createMonoRuntime } from "@worklab-ai/runtime-adapter";
import {
  TelegramBotApiClient,
  TelegramBridge,
  TelegramLongPoller,
} from "@worklab-ai/telegram-bridge";
import type {
  AgentResponder,
  TelegramBotApi,
  TelegramBridgeLogger,
  TelegramBridgeOptions,
  TelegramLongPollerOptions,
  TelegramLongPollerStartOptions,
} from "@worklab-ai/telegram-bridge";
import { createToolPolicy, loadToolPolicyFromJsonFile } from "@worklab-ai/tool-policy";
import type { ToolPolicy, ToolPolicyInput } from "@worklab-ai/tool-policy";

export interface TelegramAgentDemoPollerLike {
  start(options?: TelegramLongPollerStartOptions): Promise<void>;
}

export interface TelegramAgentDemoOptions {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly logger?: TelegramBridgeLogger;
  readonly runtime?: MonoRuntimeLike;
  readonly api?: TelegramBotApi;
  readonly pollerFactory?: (options: TelegramLongPollerOptions) => TelegramAgentDemoPollerLike;
}

export interface TelegramAgentDemo {
  readonly config: RedactedMonoAgentConfig;
  readonly api: TelegramBotApi;
  readonly bridge: TelegramBridge;
  readonly responder: AgentResponder;
  readonly poller: TelegramAgentDemoPollerLike;
  start(options?: TelegramLongPollerStartOptions): Promise<void>;
}

export async function createTelegramAgentDemo(options: TelegramAgentDemoOptions = {}): Promise<TelegramAgentDemo> {
  const rawConfig = loadMonoAgentConfig({
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
  });
  const toolPolicy = await loadDemoToolPolicy(rawConfig);
  const runtime = options.runtime ?? createMonoRuntime({
    workspace: rawConfig.runtime.workspace,
    qaOutputDir: rawConfig.artifacts.dir,
  });
  const memory = rawConfig.memory === undefined
    ? undefined
    : createMarkdownMemoryStore({
        path: rawConfig.memory.path,
        maxBytes: rawConfig.memory.maxBytes,
        scope: rawConfig.memory.scope,
      });

  const historyStore = createInMemoryHistoryStore({ maxMessages: rawConfig.runtime.maxTurns * 2 });
  const harness = createAgentHarness({
    identityPath: rawConfig.context.identityPath,
    ...(rawConfig.context.soulPath === undefined ? {} : { soulPath: rawConfig.context.soulPath }),
    ...(rawConfig.context.skillsRoot === undefined ? {} : { skillsRoot: rawConfig.context.skillsRoot }),
    selectedSkills: rawConfig.context.selectedSkills,
    runtime,
    model: rawConfig.runtime.model,
    executionMode: rawConfig.runtime.executionMode,
    cwd: rawConfig.runtime.workspace,
    ...(rawConfig.runtime.effort === undefined ? {} : { effort: rawConfig.runtime.effort }),
    maxTurns: rawConfig.runtime.maxTurns,
    ...(memory === undefined ? {} : { memory }),
    memoryWriteMode: rawConfig.memory?.writeMode ?? "disabled",
    historyStore,
    toolPolicy,
    recorderFactory: ({ runId, conversationId }) => createJsonlRunRecorder({
      runId,
      conversationId,
      artifactDir: rawConfig.artifacts.dir,
    }),
  });

  const responder = createAgentResponder({ harness }) as AgentResponder;
  const api = options.api ?? new TelegramBotApiClient({ token: rawConfig.telegram.botToken });
  const bridge = new TelegramBridge(buildBridgeOptions({
    api,
    responder,
    config: rawConfig,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }));
  const pollerOptions = buildPollerOptions({
    api,
    bridge,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const poller = options.pollerFactory?.(pollerOptions) ?? new TelegramLongPoller(pollerOptions);

  return {
    config: redactMonoAgentConfig(rawConfig),
    api,
    bridge,
    responder,
    poller,
    start(options: TelegramLongPollerStartOptions = {}) {
      return poller.start(options);
    },
  };
}

export async function startTelegramAgentDemo(options: TelegramAgentDemoOptions = {}): Promise<void> {
  const demo = await createTelegramAgentDemo(options);
  const controller = new AbortController();
  const cleanup = installSignalHandlers(controller, options.logger);
  try {
    options.logger?.info?.("Starting Mono Agent Telegram demo.", { config: demo.config });
    await demo.start({ signal: controller.signal });
  } finally {
    cleanup();
  }
}

async function loadDemoToolPolicy(config: MonoAgentConfig): Promise<ToolPolicy> {
  const filePolicy = config.tools.mcpConfigPath === undefined ? undefined : await loadToolPolicyFromJsonFile(config.tools.mcpConfigPath);
  const input: ToolPolicyInput = {
    ...(filePolicy === undefined ? {} : filePolicy),
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
  };
  return createToolPolicy(input);
}

function buildBridgeOptions(input: {
  readonly api: TelegramBotApi;
  readonly responder: AgentResponder;
  readonly config: MonoAgentConfig;
  readonly logger?: TelegramBridgeLogger;
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
  readonly logger?: TelegramBridgeLogger;
}): TelegramLongPollerOptions {
  return {
    api: input.api,
    bridge: input.bridge,
    deleteWebhookOnStart: true,
    allowedUpdates: ["message"],
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  };
}

function installSignalHandlers(controller: AbortController, logger: TelegramBridgeLogger | undefined): () => void {
  const handler = (signalName: NodeJS.Signals) => {
    logger?.info?.("Stopping Mono Agent Telegram demo.", { signal: signalName });
    controller.abort();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
