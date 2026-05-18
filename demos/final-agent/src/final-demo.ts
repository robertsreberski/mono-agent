import { resolve } from "node:path";

import {
  startOperatorConsole,
} from "@worklab-ai/operator-console";
import type {
  ConfigApplyResult,
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
  createConfiguredAgentResponder,
  createConfiguredAgentRuntime,
} from "@worklab-ai/agent-host";
import type { AgentResponder } from "@worklab-ai/agent-contracts";
import {
  registerTraceSource,
} from "@worklab-ai/observability";
import type { TraceSourceHandle } from "@worklab-ai/observability";
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
import {
  FINAL_DEMO_FIELD_GROUPS,
  isFinalAgentDemoConfigError,
  loadFinalAgentA2AConfig,
  loadFinalAgentCoreConfig,
  loadFinalAgentTelegramConfig,
  redactFinalAgentDemoConfig,
  resolveFinalDemoArtifactDir,
  resolveFinalDemoTraceRegistryDir,
  resolveFinalDemoTraceHeartbeatMs,
  resolveFinalDemoTraceSourceId,
  resolveFinalDemoTraceSourceLabel,
  resolveFinalDemoTraceStaleAfterMs,
  type RedactedFinalAgentDemoConfig,
} from "./configuration.js";

export {
  resolveFinalDemoArtifactDir,
  resolveFinalDemoTraceRegistryDir,
} from "./configuration.js";

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

export type TraceabilityStatus =
  | {
      readonly kind: "running";
      readonly sourceId: string;
      readonly registryDir: string;
      readonly artifactDir: string;
    }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string; readonly registryDir?: string; readonly artifactDir?: string };

export interface FinalAgentDemo {
  readonly operatorConsole: FinalAgentDemoOperatorConsole;
  readonly telegramStatus: TelegramStatus;
  readonly a2aStatus: A2AStatus;
  readonly traceabilityStatus: TraceabilityStatus;
  applyConfigChange(reason: string): Promise<ConfigApplyResult>;
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
    traceability: {
      registryDir: () => resolveFinalDemoTraceRegistryDir({ env, cwd, configPath }),
      staleAfterMs: () => resolveFinalDemoTraceStaleAfterMs({ env, cwd, configPath }),
      maxRuns: 100,
      maxEventsPerRun: 750,
    },
    applyConfigWrite: async () => {
      if (controller === undefined) {
        return {
          kind: "failed",
          message: "Final demo lifecycle is not ready to apply config changes.",
          transports: [],
        };
      }
      return await controller.applyConfigChange("operator-console-write");
    },
    ...(options.operatorConsolePort === undefined ? {} : { port: options.operatorConsolePort }),
    log: (event) => {
      logOperatorConsoleEvent(options.logger, event);
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

  await controller.startTraceability("startup");
  await Promise.all([
    controller.startTelegramIfConfigured("startup"),
    controller.startA2AIfConfigured("startup"),
  ]);
  await controller.refreshTraceSource("startup-complete");
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
  private traceabilityStatusValue: TraceabilityStatus = {
    kind: "disabled",
    reason: "Traceability has not started yet.",
  };
  private telegramStartInFlight: Promise<TelegramStatus> | undefined;
  private a2aStartInFlight: Promise<A2AStatus> | undefined;
  private configApplyTail: Promise<void> = Promise.resolve();
  private runningTelegram: RunningTelegram | undefined;
  private runningA2A: RunningA2A | undefined;
  private traceSource: TraceSourceHandle | undefined;
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

  get traceabilityStatus(): TraceabilityStatus {
    return this.traceabilityStatusValue;
  }

  async applyConfigChange(reason: string): Promise<ConfigApplyResult> {
    const run = async (): Promise<ConfigApplyResult> => {
      if (this.stopped) {
        return {
          kind: "failed",
          message: "Final demo has already stopped.",
          transports: [],
        };
      }
      await this.stopTelegram(`${reason}:reload`);
      await this.stopA2A(`${reason}:reload`);
      await this.stopTraceSource(`${reason}:reload`);
      await this.startTraceability(reason);
      await Promise.all([
        this.startTelegramIfConfigured(reason),
        this.startA2AIfConfigured(reason),
      ]);
      await this.refreshTraceSource(`${reason}:complete`);
      return this.applyResult(reason);
    };

    const next = this.configApplyTail.then(run, run);
    this.configApplyTail = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  async startTraceability(reason: string): Promise<TraceabilityStatus> {
    if (this.stopped) {
      return this.traceabilityStatusValue;
    }
    try {
      const input = { env: this.env, cwd: this.cwd, configPath: this.configPath };
      const [registryDir, artifactDir, sourceId, label, heartbeatMs] = await Promise.all([
        resolveFinalDemoTraceRegistryDir(input),
        resolveFinalDemoArtifactDir(input),
        resolveFinalDemoTraceSourceId(input),
        resolveFinalDemoTraceSourceLabel(input),
        resolveFinalDemoTraceHeartbeatMs(input),
      ]);
      this.traceSource = await registerTraceSource({
        registryDir,
        sourceId,
        label,
        artifactDir,
        pid: process.pid,
        transports: this.activeTransports(),
        configPath: this.configPath,
        metadata: this.traceMetadata(reason),
        heartbeatMs,
      });
      this.traceabilityStatusValue = { kind: "running", sourceId, registryDir, artifactDir };
      this.logger?.info?.("Traceability source registered.", { reason, sourceId, registryDir, artifactDir });
      return this.traceabilityStatusValue;
    } catch (error) {
      const failure = reasonOf(error);
      this.traceabilityStatusValue = { kind: "failed", reason: failure };
      this.logger?.error?.("Traceability source registration failed.", { reason: failure });
      return this.traceabilityStatusValue;
    }
  }

  async refreshTraceSource(reason: string): Promise<void> {
    if (this.traceSource === undefined) {
      return;
    }
    try {
      await this.traceSource.update({
        transports: this.activeTransports(),
        metadata: this.traceMetadata(reason),
      });
    } catch (error) {
      this.logger?.warn?.("Traceability source update failed.", { reason: reasonOf(error) });
    }
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
      await this.refreshTraceSource(reason);
      return this.telegramStatusValue;
    }
    if (this.telegramStartInFlight !== undefined) {
      return await this.telegramStartInFlight;
    }

    this.telegramStartInFlight = this.startTelegram(reason)
      .finally(() => {
        this.telegramStartInFlight = undefined;
      });
    const status = await this.telegramStartInFlight;
    await this.refreshTraceSource(reason);
    return status;
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
      await this.refreshTraceSource(reason);
      return this.a2aStatusValue;
    }
    if (this.a2aStartInFlight !== undefined) {
      return await this.a2aStartInFlight;
    }

    this.a2aStartInFlight = this.startA2A(reason)
      .finally(() => {
        this.a2aStartInFlight = undefined;
      });
    const status = await this.a2aStartInFlight;
    await this.refreshTraceSource(reason);
    return status;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.stopTelegram("stop");
    await this.stopA2A("stop");
    await this.stopTraceSource("stop");
    await this.consoleServer.stop();
  }

  private async stopTelegram(reason: string): Promise<void> {
    const running = this.runningTelegram;
    if (running === undefined) {
      return;
    }
    this.runningTelegram = undefined;
    running.controller.abort();
    await running.promise.catch((error: unknown) => {
      this.logger?.warn?.("Telegram polling did not stop cleanly.", { reason, error: reasonOf(error) });
    });
    if (!this.stopped) {
      this.telegramStatusValue = {
        kind: "waiting_for_config",
        reason: "Telegram stopped while applying config.",
      };
    }
  }

  private async stopA2A(reason: string): Promise<void> {
    const running = this.runningA2A;
    if (running === undefined) {
      return;
    }
    this.runningA2A = undefined;
    await running.provider.stop().catch((error: unknown) => {
      this.logger?.warn?.("A2A provider did not stop cleanly.", { reason, error: reasonOf(error) });
    });
    if (!this.stopped) {
      this.a2aStatusValue = { kind: "disabled", reason: "A2A provider stopped while applying config." };
    }
  }

  private async stopTraceSource(reason: string): Promise<void> {
    const traceSource = this.traceSource;
    if (traceSource === undefined) {
      return;
    }
    this.traceSource = undefined;
    await traceSource.stop({
      metadata: this.traceMetadata(reason),
      transports: this.activeTransports(),
    }).catch((error: unknown) => {
      this.logger?.warn?.("Traceability source stop update failed.", { reason: reasonOf(error) });
    });
    if (!this.stopped) {
      this.traceabilityStatusValue = { kind: "disabled", reason: "Traceability source stopped while applying config." };
    }
  }

  private applyResult(reason: string): ConfigApplyResult {
    const transports = this.activeTransports();
    const failure = firstFailureReason(this.telegramStatusValue, this.a2aStatusValue, this.traceabilityStatusValue);
    if (failure !== undefined) {
      return {
        kind: "failed",
        message: `Saved config, but live apply failed: ${failure}`,
        transports,
      };
    }

    const hasRunningAgentTransport = this.telegramStatusValue.kind === "running" || this.a2aStatusValue.kind === "running";
    if (!hasRunningAgentTransport && (this.telegramStatusValue.kind === "waiting_for_config" || this.a2aStatusValue.kind === "waiting_for_config")) {
      return {
        kind: "waiting_for_config",
        message: "Saved config, but no agent transport is running yet.",
        transports,
      };
    }

    return {
      kind: "applied",
      message: `Saved config and reloaded ${transports.join(", ")}.`,
      transports,
    };
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
      const runtime = this.runtime ?? createConfiguredAgentRuntime(coreConfig);
      const responder = createConfiguredAgentResponder({ config: coreConfig, runtime });
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
      const runtime = this.runtime ?? createConfiguredAgentRuntime(coreConfig);
      const responder = createConfiguredAgentResponder({ config: coreConfig, runtime });
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

  private activeTransports(): readonly string[] {
    const transports = ["operator-console"];
    if (this.telegramStatusValue.kind === "running") {
      transports.push("telegram");
    }
    if (this.a2aStatusValue.kind === "running") {
      transports.push("a2a");
    }
    return transports;
  }

  private traceMetadata(reason: string): Record<string, unknown> {
    return {
      reason,
      operatorConsole: {
        url: this.operatorConsole.url,
        configPath: this.operatorConsole.configPath,
      },
      telegram: summarizeTelegramStatus(this.telegramStatusValue),
      a2a: summarizeA2AStatus(this.a2aStatusValue),
    };
  }
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

function summarizeTelegramStatus(status: TelegramStatus): Record<string, unknown> {
  if (status.kind === "running") {
    return { kind: "running" };
  }
  return { kind: status.kind, reason: status.reason };
}

function summarizeA2AStatus(status: A2AStatus): Record<string, unknown> {
  if (status.kind === "running") {
    return { kind: "running", agentCardUrl: status.agentCardUrl };
  }
  return { kind: status.kind, reason: status.reason };
}

function firstFailureReason(
  telegram: TelegramStatus,
  a2a: A2AStatus,
  traceability: TraceabilityStatus,
): string | undefined {
  if (telegram.kind === "failed") {
    return telegram.reason;
  }
  if (a2a.kind === "failed") {
    return a2a.reason;
  }
  if (traceability.kind === "failed") {
    return traceability.reason;
  }
  return undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
