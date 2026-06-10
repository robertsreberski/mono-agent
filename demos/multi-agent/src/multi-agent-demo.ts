import { resolve } from "node:path";

import {
  startOperatorConsole,
} from "@mono-agent/operator-console";
import type {
  ConfigApplyResult,
  OperatorConsoleEvent,
  OperatorConsoleOptions,
  OperatorConsoleStartResult,
} from "@mono-agent/operator-console";
import {
  CORE_AGENT_FIELD_GROUPS,
  loadMonoAgentConfigWithSources,
} from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  loadA2AAdapterConfig,
  createA2AConsumerResponder,
  startA2AProvider,
  a2aFieldGroup,
} from "@mono-agent/a2a-adapter";
import type {
  A2AAdapterConfig,
  A2AProviderOptions,
  A2AProviderStartResult,
} from "@mono-agent/a2a-adapter";
import {
  createConfiguredAgentResponder,
  createConfiguredAgentRuntime,
} from "@mono-agent/agent-host";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import {
  createCollaboratorToolRuntimeExtension,
} from "@mono-agent/agent-orchestrator";
import type { OrchestratorCollaborator } from "@mono-agent/agent-orchestrator";
import {
  registerTraceSource,
} from "@mono-agent/observability";
import type { TraceSourceHandle } from "@mono-agent/observability";
import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";
import {
  TelegramAdapter,
  TelegramBotApiClient,
  TelegramLongPoller,
  loadTelegramAdapterConfig,
  telegramFieldGroup,
} from "@mono-agent/telegram-adapter";
import type {
  TelegramAdapterConfig,
  TelegramAdapterOptions,
  TelegramBotApi,
  TelegramLongPollerOptions,
  TelegramLongPollerStartOptions,
} from "@mono-agent/telegram-adapter";
import type { FieldGroup } from "@mono-agent/settings";

import {
  DEFAULT_MULTI_AGENT_CONFIG_DIR,
  MULTI_AGENT_ROLES,
  roleConfigPath,
} from "./deployment.js";
import {
  type MultiAgentRole,
} from "./orchestrator-responder.js";

export const MULTI_AGENT_FIELD_GROUPS: readonly FieldGroup[] = [
  ...CORE_AGENT_FIELD_GROUPS,
  telegramFieldGroup,
  a2aFieldGroup,
];

export interface MultiAgentDemoLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface MultiAgentDemoPollerLike {
  start(options?: TelegramLongPollerStartOptions): Promise<void>;
}

export interface MultiAgentDemoOptions {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly configDir?: string;
  readonly operatorConsolePort?: number;
  readonly startTelegram?: boolean;
  readonly startA2A?: boolean;
  readonly logger?: MultiAgentDemoLogger;
  readonly runtime?: MonoRuntimeLike;
  readonly runtimeFactory?: (role: MultiAgentRole, config: MonoAgentConfig) => MonoRuntimeLike;
  readonly telegramApi?: TelegramBotApi;
  readonly pollerFactory?: (options: TelegramLongPollerOptions) => MultiAgentDemoPollerLike;
  readonly a2aProviderFactory?: (options: A2AProviderOptions) => Promise<A2AProviderStartResult>;
  readonly operatorConsoleFactory?: (options: OperatorConsoleOptions) => Promise<OperatorConsoleStartResult>;
  readonly fieldGroups?: readonly FieldGroup[];
}

export interface MultiAgentDemoOperatorConsole {
  readonly url: string;
  readonly appUrl: string;
  readonly token: string;
  readonly configPath: string;
}

export type MultiAgentRoleStatus =
  | {
      readonly kind: "running";
      readonly role: MultiAgentRole;
      readonly agentCardUrl: string;
      readonly artifactDir: string;
      readonly traceSourceId: string;
    }
  | { readonly kind: "disabled"; readonly role: MultiAgentRole; readonly reason: string }
  | { readonly kind: "failed"; readonly role: MultiAgentRole; readonly reason: string };

export type MultiAgentTelegramStatus =
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "waiting_for_config"; readonly reason: string }
  | { readonly kind: "running"; readonly allowedChatCount: number; readonly allowAllChats: boolean }
  | { readonly kind: "failed"; readonly reason: string };

export type MultiAgentTraceabilityStatus =
  | {
      readonly kind: "running";
      readonly role: MultiAgentRole;
      readonly sourceId: string;
      readonly registryDir: string;
      readonly artifactDir: string;
    }
  | { readonly kind: "failed"; readonly role: MultiAgentRole; readonly reason: string };

export interface MultiAgentDemo {
  readonly operatorConsole: MultiAgentDemoOperatorConsole;
  readonly orchestratorStatus: MultiAgentRoleStatus;
  readonly researcherStatus: MultiAgentRoleStatus;
  readonly workerStatus: MultiAgentRoleStatus;
  readonly telegramStatus: MultiAgentTelegramStatus;
  readonly traceabilityStatuses: Record<MultiAgentRole, MultiAgentTraceabilityStatus>;
  stop(): Promise<void>;
}

interface LoadedRole {
  readonly role: MultiAgentRole;
  readonly configPath: string;
  readonly coreConfig: MonoAgentConfig;
  readonly a2aConfig: A2AAdapterConfig;
  readonly runtime: MonoRuntimeLike;
  readonly responder: AgentResponder;
}

interface RunningRole {
  readonly loaded: LoadedRole;
  readonly provider?: A2AProviderStartResult;
  readonly status: MultiAgentRoleStatus;
  readonly traceSource: TraceSourceHandle;
  readonly traceabilityStatus: MultiAgentTraceabilityStatus;
}

interface RunningTelegram {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export async function startMultiAgentDemo(options: MultiAgentDemoOptions = {}): Promise<MultiAgentDemo> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configDir = resolve(cwd, options.configDir ?? DEFAULT_MULTI_AGENT_CONFIG_DIR);
  const env = options.env ?? process.env;
  const configPaths = {
    orchestrator: roleConfigPath({ cwd, configDir, role: "orchestrator" }),
    researcher: roleConfigPath({ cwd, configDir, role: "researcher" }),
    worker: roleConfigPath({ cwd, configDir, role: "worker" }),
  } satisfies Record<MultiAgentRole, string>;

  const loaded = await loadRoles({
    cwd,
    env,
    configPaths,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
  });

  let activeTransportNames = (): readonly string[] => ["operator-console"];
  const consoleFactory = options.operatorConsoleFactory ?? startOperatorConsole;
  const operatorConsole = await consoleFactory({
    configPath: configPaths.orchestrator,
    cwd,
    fieldGroups: options.fieldGroups ?? MULTI_AGENT_FIELD_GROUPS,
    observability: {
      artifactDir: loaded.orchestrator.coreConfig.artifacts.dir,
      maxRuns: 100,
      maxEventsPerRun: 750,
    },
    traceability: {
      registryDir: loaded.orchestrator.coreConfig.traceability.registryDir,
      maxRuns: 100,
      maxEventsPerRun: 750,
      ...(loaded.orchestrator.coreConfig.traceability.staleAfterMs === undefined
        ? {}
        : { staleAfterMs: loaded.orchestrator.coreConfig.traceability.staleAfterMs }),
    },
    applyConfigWrite: async () => applyConfigRestartNotice(activeTransportNames),
    ...(options.operatorConsolePort === undefined ? {} : { port: options.operatorConsolePort }),
    log: (event) => logOperatorConsoleEvent(options.logger, event),
  });

  const controller = new MultiAgentDemoController({
    cwd,
    env,
    operatorConsole,
    configPath: configPaths.orchestrator,
    loaded,
    startA2A: options.startA2A !== false,
    startTelegram: options.startTelegram !== false,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.telegramApi === undefined ? {} : { telegramApi: options.telegramApi }),
    ...(options.pollerFactory === undefined ? {} : { pollerFactory: options.pollerFactory }),
    ...(options.a2aProviderFactory === undefined ? {} : { a2aProviderFactory: options.a2aProviderFactory }),
  });

  activeTransportNames = controller.activeTransportNames.bind(controller);
  await controller.start();
  return controller;
}

class MultiAgentDemoController implements MultiAgentDemo {
  readonly operatorConsole: MultiAgentDemoOperatorConsole;
  private readonly env: Record<string, string | undefined>;
  private readonly cwd: string;
  private readonly configPath: string;
  private readonly consoleServer: OperatorConsoleStartResult;
  private readonly loaded: Record<MultiAgentRole, LoadedRole>;
  private readonly shouldStartA2A: boolean;
  private readonly shouldStartTelegram: boolean;
  private readonly logger: MultiAgentDemoLogger | undefined;
  private readonly telegramApi: TelegramBotApi | undefined;
  private readonly pollerFactory: ((options: TelegramLongPollerOptions) => MultiAgentDemoPollerLike) | undefined;
  private readonly a2aProviderFactory: ((options: A2AProviderOptions) => Promise<A2AProviderStartResult>) | undefined;

  private running: Partial<Record<MultiAgentRole, RunningRole>> = {};
  private runningTelegram: RunningTelegram | undefined;
  private telegramStatusValue: MultiAgentTelegramStatus = {
    kind: "waiting_for_config",
    reason: "Telegram has not been configured yet.",
  };
  private stopped = false;

  constructor(input: {
    readonly env: Record<string, string | undefined>;
    readonly cwd: string;
    readonly configPath: string;
    readonly operatorConsole: OperatorConsoleStartResult;
    readonly loaded: Record<MultiAgentRole, LoadedRole>;
    readonly startA2A: boolean;
    readonly startTelegram: boolean;
    readonly logger?: MultiAgentDemoLogger;
    readonly telegramApi?: TelegramBotApi;
    readonly pollerFactory?: (options: TelegramLongPollerOptions) => MultiAgentDemoPollerLike;
    readonly a2aProviderFactory?: (options: A2AProviderOptions) => Promise<A2AProviderStartResult>;
  }) {
    this.env = input.env;
    this.cwd = input.cwd;
    this.configPath = input.configPath;
    this.consoleServer = input.operatorConsole;
    this.loaded = input.loaded;
    this.shouldStartA2A = input.startA2A;
    this.shouldStartTelegram = input.startTelegram;
    this.logger = input.logger;
    this.telegramApi = input.telegramApi;
    this.pollerFactory = input.pollerFactory;
    this.a2aProviderFactory = input.a2aProviderFactory;
    this.operatorConsole = {
      url: input.operatorConsole.url,
      appUrl: `${input.operatorConsole.url}/?t=${input.operatorConsole.token}`,
      token: input.operatorConsole.token,
      configPath: input.configPath,
    };
  }

  get orchestratorStatus(): MultiAgentRoleStatus {
    return this.roleStatus("orchestrator");
  }

  get researcherStatus(): MultiAgentRoleStatus {
    return this.roleStatus("researcher");
  }

  get workerStatus(): MultiAgentRoleStatus {
    return this.roleStatus("worker");
  }

  get telegramStatus(): MultiAgentTelegramStatus {
    return this.telegramStatusValue;
  }

  get traceabilityStatuses(): Record<MultiAgentRole, MultiAgentTraceabilityStatus> {
    return {
      orchestrator: this.traceStatus("orchestrator"),
      researcher: this.traceStatus("researcher"),
      worker: this.traceStatus("worker"),
    };
  }

  async start(): Promise<void> {
    try {
      this.running.researcher = await this.startRole("researcher", this.loaded.researcher.responder);
      this.running.worker = await this.startRole("worker", this.loaded.worker.responder);

      const researcher = this.running.researcher;
      const worker = this.running.worker;
      if (researcher?.status.kind !== "running" || worker?.status.kind !== "running") {
        this.running.orchestrator = await this.startRole("orchestrator", this.loaded.orchestrator.responder);
        this.telegramStatusValue = {
          kind: "failed",
          reason: "Researcher and worker A2A providers must be running before Telegram orchestration starts.",
        };
        return;
      }

      const collaborative = this.createCollaborativeOrchestratorResponder({
        researcherAgentUrl: researcher.status.agentCardUrl,
        workerAgentUrl: worker.status.agentCardUrl,
      });

      this.running.orchestrator = await this.startRole("orchestrator", collaborative);
      this.telegramStatusValue = await this.startTelegram(collaborative);
      await this.refreshTraceSources("startup-complete");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  activeTransportNames(): readonly string[] {
    const transports = ["operator-console"];
    if (this.telegramStatusValue.kind === "running") {
      transports.push("telegram");
    }
    for (const role of MULTI_AGENT_ROLES) {
      const running = this.running[role];
      if (running?.status.kind === "running") {
        transports.push(`${role}:a2a`);
      }
    }
    return transports;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.stopTelegram();
    await Promise.all(MULTI_AGENT_ROLES.map(async (role) => {
      const running = this.running[role];
      if (running?.provider !== undefined) {
        await running.provider.stop().catch((error: unknown) => {
          this.logger?.warn?.("A2A provider did not stop cleanly.", { role, reason: reasonOf(error) });
        });
      }
      if (running?.traceSource !== undefined) {
        await running.traceSource.stop({
          status: "stopped",
          transports: this.activeTransportNames(),
          metadata: this.traceMetadata(role, "stop"),
        }).catch((error: unknown) => {
          this.logger?.warn?.("Trace source did not stop cleanly.", { role, reason: reasonOf(error) });
        });
      }
    }));
    await this.consoleServer.stop();
  }

  private async startRole(role: MultiAgentRole, responder: AgentResponder): Promise<RunningRole> {
    const loaded = this.loaded[role];
    const traceSource = await this.registerRoleTraceSource(loaded, "startup");
    if (!this.shouldStartA2A) {
      const status: MultiAgentRoleStatus = { kind: "disabled", role, reason: "A2A startup disabled by host option." };
      return {
        loaded,
        status,
        traceSource,
        traceabilityStatus: this.traceabilityStatusFor(loaded),
      };
    }
    if (!loaded.a2aConfig.provider.enabled) {
      const status: MultiAgentRoleStatus = { kind: "disabled", role, reason: "A2A provider is disabled." };
      return {
        loaded,
        status,
        traceSource,
        traceabilityStatus: this.traceabilityStatusFor(loaded),
      };
    }
    if (loaded.a2aConfig.agent === undefined || loaded.a2aConfig.skill === undefined) {
      const status: MultiAgentRoleStatus = { kind: "failed", role, reason: "A2A provider requires agent and skill configuration." };
      return {
        loaded,
        status,
        traceSource,
        traceabilityStatus: this.traceabilityStatusFor(loaded),
      };
    }

    const providerFactory = this.a2aProviderFactory ?? startA2AProvider;
    const provider = await providerFactory({
      host: loaded.a2aConfig.provider.host,
      port: loaded.a2aConfig.provider.port,
      ...(loaded.a2aConfig.provider.publicBaseUrl === undefined ? {} : { publicBaseUrl: loaded.a2aConfig.provider.publicBaseUrl }),
      allowNonLoopback: loaded.a2aConfig.provider.allowNonLoopback,
      requireBearer: loaded.a2aConfig.provider.requireBearer,
      ...(loaded.a2aConfig.provider.bearerToken === undefined ? {} : { bearerToken: loaded.a2aConfig.provider.bearerToken }),
      responder,
      agent: {
        name: loaded.a2aConfig.agent.name,
        description: loaded.a2aConfig.agent.description,
        version: loaded.a2aConfig.agent.version,
        ...(loaded.a2aConfig.agent.providerOrganization === undefined || loaded.a2aConfig.agent.providerUrl === undefined
          ? {}
          : {
              provider: {
                organization: loaded.a2aConfig.agent.providerOrganization,
                url: loaded.a2aConfig.agent.providerUrl,
              },
            }),
      },
      skill: loaded.a2aConfig.skill,
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    });
    const status: MultiAgentRoleStatus = {
      kind: "running",
      role,
      agentCardUrl: provider.agentCardUrl,
      artifactDir: loaded.coreConfig.artifacts.dir,
      traceSourceId: this.traceSourceId(loaded),
    };
    await traceSource.update({
      transports: this.activeTransportNames(),
      metadata: this.traceMetadata(role, "a2a-running", provider.agentCardUrl),
    });
    this.logger?.info?.("Multi-agent role A2A provider is running.", { role, agentCardUrl: provider.agentCardUrl });
    return {
      loaded,
      provider,
      status,
      traceSource,
      traceabilityStatus: this.traceabilityStatusFor(loaded),
    };
  }

  private createCollaborativeOrchestratorResponder(input: {
    readonly researcherAgentUrl: string;
    readonly workerAgentUrl: string;
  }): AgentResponder {
    const timeoutMs = this.loaded.orchestrator.a2aConfig.consumer.timeoutMs;
    const collaborators: readonly OrchestratorCollaborator[] = [
      {
        id: "researcher",
        label: "Researcher",
        description: "Find current external context when it materially helps.",
        responder: createA2AConsumerResponder({
          agentUrl: input.researcherAgentUrl,
          timeoutMs,
          streamRemote: true,
        }),
        timeoutMs,
      },
      {
        id: "worker",
        label: "Worker",
        description: "Inspect the dedicated local workspace with read-only tools.",
        responder: createA2AConsumerResponder({
          agentUrl: input.workerAgentUrl,
          timeoutMs,
          streamRemote: true,
        }),
        timeoutMs,
      },
    ];
    return createConfiguredAgentResponder({
      config: this.loaded.orchestrator.coreConfig,
      runtime: this.loaded.orchestrator.runtime,
      runtimeOptionsForRequest: async (input) => {
        const extension = await createCollaboratorToolRuntimeExtension({
          conversationId: input.request.conversationId,
          originalUserMessage: input.request.userMessage,
          abortSignal: input.request.abortSignal,
          collaborators,
        });
        return {
          runtimeOptions: extension.runtimeOptions,
          cleanup: extension.cleanup,
        };
      },
    });
  }

  private async startTelegram(responder: AgentResponder): Promise<MultiAgentTelegramStatus> {
    if (!this.shouldStartTelegram) {
      return { kind: "disabled", reason: "Telegram startup disabled by host option." };
    }
    let telegramConfig: TelegramAdapterConfig;
    try {
      telegramConfig = await loadTelegramAdapterConfig({
        env: this.env,
        jsonPath: this.configPath,
      });
    } catch (error) {
      return { kind: "waiting_for_config", reason: reasonOf(error) };
    }

    try {
      const api = this.telegramApi ?? new TelegramBotApiClient({ token: telegramConfig.botToken });
      const adapterOptions: TelegramAdapterOptions = {
        api,
        responder,
        allowedChatIds: [...telegramConfig.allowedChatIds],
        allowAllChats: telegramConfig.allowAllChats,
        stream: {
          initialStatusText: "Multi-Agent orchestrator is thinking...",
          editDebounceMs: 350,
        },
        messages: multiAgentTelegramMessages(),
        ...(this.logger === undefined ? {} : { logger: this.logger }),
      };
      const adapter = new TelegramAdapter(adapterOptions);
      const pollerOptions: TelegramLongPollerOptions = {
        api,
        adapter,
        deleteWebhookOnStart: true,
        allowedUpdates: ["message"],
        ...(this.logger === undefined ? {} : { logger: this.logger }),
      };
      const poller = this.pollerFactory?.(pollerOptions) ?? new TelegramLongPoller(pollerOptions);
      const controller = new AbortController();
      const promise = poller.start({ signal: controller.signal })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            this.telegramStatusValue = { kind: "failed", reason: reasonOf(error) };
            this.logger?.error?.("Multi-agent Telegram polling stopped with an error.", { reason: reasonOf(error) });
          }
        });
      this.runningTelegram = { controller, promise };
      return {
        kind: "running",
        allowedChatCount: telegramConfig.allowedChatIds.length,
        allowAllChats: telegramConfig.allowAllChats,
      };
    } catch (error) {
      return { kind: "failed", reason: reasonOf(error) };
    }
  }

  private async stopTelegram(): Promise<void> {
    const running = this.runningTelegram;
    if (running === undefined) {
      return;
    }
    this.runningTelegram = undefined;
    running.controller.abort();
    await running.promise.catch((error: unknown) => {
      this.logger?.warn?.("Telegram polling did not stop cleanly.", { reason: reasonOf(error) });
    });
  }

  private async registerRoleTraceSource(loaded: LoadedRole, reason: string): Promise<TraceSourceHandle> {
    const traceSource = await registerTraceSource({
      registryDir: loaded.coreConfig.traceability.registryDir,
      sourceId: this.traceSourceId(loaded),
      label: this.traceSourceLabel(loaded),
      artifactDir: loaded.coreConfig.artifacts.dir,
      pid: process.pid,
      transports: this.activeTransportNames(),
      configPath: loaded.configPath,
      metadata: this.traceMetadata(loaded.role, reason),
      ...(loaded.coreConfig.traceability.heartbeatMs === undefined
        ? {}
        : { heartbeatMs: loaded.coreConfig.traceability.heartbeatMs }),
    });
    this.logger?.info?.("Multi-agent trace source registered.", {
      role: loaded.role,
      sourceId: this.traceSourceId(loaded),
      registryDir: loaded.coreConfig.traceability.registryDir,
    });
    return traceSource;
  }

  private async refreshTraceSources(reason: string): Promise<void> {
    await Promise.all(MULTI_AGENT_ROLES.map(async (role) => {
      const running = this.running[role];
      if (running === undefined) {
        return;
      }
      await running.traceSource.update({
        transports: this.activeTransportNames(),
        metadata: this.traceMetadata(role, reason, running.status.kind === "running" ? running.status.agentCardUrl : undefined),
      }).catch((error: unknown) => {
        this.logger?.warn?.("Trace source update failed.", { role, reason: reasonOf(error) });
      });
    }));
  }

  private roleStatus(role: MultiAgentRole): MultiAgentRoleStatus {
    return this.running[role]?.status ?? { kind: "failed", role, reason: "Role has not started." };
  }

  private traceStatus(role: MultiAgentRole): MultiAgentTraceabilityStatus {
    return this.running[role]?.traceabilityStatus ?? { kind: "failed", role, reason: "Trace source has not started." };
  }

  private traceabilityStatusFor(loaded: LoadedRole): MultiAgentTraceabilityStatus {
    return {
      kind: "running",
      role: loaded.role,
      sourceId: this.traceSourceId(loaded),
      registryDir: loaded.coreConfig.traceability.registryDir,
      artifactDir: loaded.coreConfig.artifacts.dir,
    };
  }

  private traceSourceId(loaded: LoadedRole): string {
    return loaded.coreConfig.traceability.sourceId ?? `multi-agent-${loaded.role}`;
  }

  private traceSourceLabel(loaded: LoadedRole): string {
    return loaded.coreConfig.traceability.sourceLabel ?? `Multi-Agent ${titleCase(loaded.role)}`;
  }

  private traceMetadata(role: MultiAgentRole, reason: string, agentCardUrl?: string): Record<string, unknown> {
    return {
      role,
      reason,
      operatorConsole: {
        url: this.operatorConsole.url,
        configPath: this.operatorConsole.configPath,
      },
      telegram: summarizeTelegramStatus(this.telegramStatusValue),
      ...(agentCardUrl === undefined ? {} : { agentCardUrl }),
    };
  }
}

async function loadRoles(input: {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly configPaths: Record<MultiAgentRole, string>;
  readonly runtime?: MonoRuntimeLike;
  readonly runtimeFactory?: (role: MultiAgentRole, config: MonoAgentConfig) => MonoRuntimeLike;
}): Promise<Record<MultiAgentRole, LoadedRole>> {
  const entries = await Promise.all(MULTI_AGENT_ROLES.map(async (role) => {
    const coreConfig = await loadMonoAgentConfigWithSources({
      env: input.env,
      cwd: input.cwd,
      jsonPath: input.configPaths[role],
    });
    const a2aConfig = await loadA2AAdapterConfig({
      env: input.env,
      jsonPath: input.configPaths[role],
    });
    const runtime = input.runtimeFactory?.(role, coreConfig) ??
      input.runtime ??
      createConfiguredAgentRuntime(coreConfig);
    const loaded: LoadedRole = {
      role,
      configPath: input.configPaths[role],
      coreConfig,
      a2aConfig,
      runtime,
      responder: createConfiguredAgentResponder({ config: coreConfig, runtime }),
    };
    return [role, loaded] as const;
  }));
  return Object.fromEntries(entries) as Record<MultiAgentRole, LoadedRole>;
}

function multiAgentTelegramMessages(): NonNullable<TelegramAdapterOptions["messages"]> {
  return {
    welcomeText: "Multi-Agent Demo is online. Send a request and the orchestrator will ask the researcher and worker before answering.",
    helpText: "Send a text request to run the multi-agent demo. Use /cancel to stop an in-flight response.",
    unauthorizedText: "This chat is not allowlisted for this Multi-Agent Demo.",
    errorText: "The Multi-Agent Demo failed honestly; check local trace artifacts for details.",
  };
}

function applyConfigRestartNotice(
  activeTransportNames: () => readonly string[],
): ConfigApplyResult {
  return {
    kind: "waiting_for_config",
    message: "Saved config. Restart the multi-agent demo to apply role and collaborator changes.",
    transports: activeTransportNames(),
  };
}

function logOperatorConsoleEvent(logger: MultiAgentDemoLogger | undefined, event: OperatorConsoleEvent): void {
  if (event.kind === "validation_failed" || event.kind === "unauthorized") {
    logger?.warn?.("Operator Console event.", { event });
    return;
  }
  logger?.debug?.("Operator Console event.", { event });
}

function summarizeTelegramStatus(status: MultiAgentTelegramStatus): Record<string, unknown> {
  if (status.kind === "running") {
    return {
      kind: "running",
      allowedChatCount: status.allowedChatCount,
      allowAllChats: status.allowAllChats,
    };
  }
  return { kind: status.kind, reason: status.reason };
}

function titleCase(role: MultiAgentRole): string {
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
