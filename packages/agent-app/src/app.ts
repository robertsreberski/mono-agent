import { resolve } from "node:path";

import { startOperatorConsole } from "@mono-agent/operator-console";
import type {
  ConfigApplyResult,
  OperatorConsoleEvent,
  OperatorConsoleOptions,
  OperatorConsoleStartResult,
} from "@mono-agent/operator-console";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  createConfiguredAgentResponder,
  createConfiguredAgentRuntime,
  createConfiguredMemory,
} from "@mono-agent/agent-host";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import { registerTraceSource } from "@mono-agent/observability";
import type { TraceSourceHandle } from "@mono-agent/observability";
import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";
import type { FieldGroup } from "@mono-agent/settings";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
  MONO_AGENT_APP_FIELD_GROUPS,
  resolveAppArtifactDir,
  resolveAppConsoleSettings,
  resolveAppTraceHeartbeatMs,
  resolveAppTraceRegistryDir,
  resolveAppTraceSourceId,
  resolveAppTraceSourceLabel,
  resolveAppTraceStaleAfterMs,
} from "./app-config.js";
import type { AppTraceDefaults, MonoAgentAppConfigInput } from "./app-config.js";
import { defaultChannelDrivers } from "./channels.js";
import type { ChannelDriver, ChannelId, ChannelStatus, MonoAgentAppLogger, RunningChannel } from "./channels.js";
import { startMemoryRituals } from "./memory-rituals.js";
import type { RunningRituals } from "./memory-rituals.js";

export interface MonoAgentAppOptions {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  /** Path to mono-agent.config.json; defaults to <cwd>/mono-agent.config.json. */
  readonly configPath?: string;
  readonly logger?: MonoAgentAppLogger;
  /** Channel drivers to run. Defaults to every built-in channel. */
  readonly drivers?: readonly ChannelDriver[];
  /** Shared runtime override (testing / advanced composition). */
  readonly runtime?: MonoRuntimeLike;
  /** Set false to run headless without the local operator console. */
  readonly operatorConsole?: boolean;
  readonly operatorConsolePort?: number;
  readonly operatorConsoleFactory?: (options: OperatorConsoleOptions) => Promise<OperatorConsoleStartResult>;
  readonly fieldGroups?: readonly FieldGroup[];
  readonly traceDefaults?: AppTraceDefaults;
}

export interface MonoAgentAppOperatorConsole {
  /** Base loopback URL for API calls, without the token query string. */
  readonly url: string;
  /** Browser URL that includes the per-boot operator console token. */
  readonly appUrl: string;
  readonly token: string;
  readonly configPath: string;
}

export type TraceabilityStatus =
  | {
      readonly kind: "running";
      readonly sourceId: string;
      readonly registryDir: string;
      readonly artifactDir: string;
    }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface MonoAgentApp {
  readonly operatorConsole: MonoAgentAppOperatorConsole | undefined;
  readonly configPath: string;
  readonly traceabilityStatus: TraceabilityStatus;
  channelStatus(id: ChannelId): ChannelStatus;
  channelStatuses(): ReadonlyMap<ChannelId, ChannelStatus>;
  startChannelIfConfigured(id: ChannelId, reason: string): Promise<ChannelStatus>;
  applyConfigChange(reason: string): Promise<ConfigApplyResult>;
  stop(): Promise<void>;
}

/**
 * Starts a config-first mono-agent host in `cwd`: operator console first (so
 * an incomplete config can be fixed in the browser), then traceability, then
 * every configured channel in parallel. Channels with incomplete config report
 * `waiting_for_config` instead of blocking the rest.
 */
export async function startMonoAgentApp(options: MonoAgentAppOptions = {}): Promise<MonoAgentApp> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.configPath ?? "mono-agent.config.json");
  const env = options.env ?? process.env;
  const drivers = options.drivers ?? defaultChannelDrivers();
  const input: MonoAgentAppConfigInput = { env, cwd, configPath };
  let controller: MonoAgentAppController | undefined;

  let consoleServer: OperatorConsoleStartResult | undefined;
  const consoleSettings = await resolveAppConsoleSettings(input);
  const consolePort = options.operatorConsolePort ?? consoleSettings.port;
  if (options.operatorConsole !== false && consoleSettings.enabled) {
    const consoleFactory = options.operatorConsoleFactory ?? startOperatorConsole;
    consoleServer = await consoleFactory({
      configPath,
      cwd,
      fieldGroups: options.fieldGroups ?? MONO_AGENT_APP_FIELD_GROUPS,
      observability: {
        artifactDir: () => resolveAppArtifactDir(input),
        maxRuns: 100,
        maxEventsPerRun: 750,
      },
      traceability: {
        registryDir: () => resolveAppTraceRegistryDir(input),
        staleAfterMs: () => resolveAppTraceStaleAfterMs(input),
        maxRuns: 100,
        maxEventsPerRun: 750,
      },
      applyConfigWrite: async () => {
        if (controller === undefined) {
          return {
            kind: "failed",
            message: "Mono agent app lifecycle is not ready to apply config changes.",
            transports: [],
          };
        }
        return await controller.applyConfigChange("operator-console-write");
      },
      ...(consolePort === undefined ? {} : { port: consolePort }),
      log: (event) => {
        logOperatorConsoleEvent(options.logger, event);
      },
    });
  }

  controller = new MonoAgentAppController({
    consoleServer,
    cwd,
    configPath,
    env,
    drivers,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.traceDefaults === undefined ? {} : { traceDefaults: options.traceDefaults }),
  });

  await controller.startTraceability("startup");
  await Promise.all(drivers.map((driver) => controller?.startChannelIfConfigured(driver.id, "startup")));
  await controller.startMemoryRitualsIfConfigured("startup");
  await controller.refreshTraceSource("startup-complete");
  return controller;
}

interface MonoAgentAppControllerInput {
  readonly consoleServer: OperatorConsoleStartResult | undefined;
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
  readonly drivers: readonly ChannelDriver[];
  readonly logger?: MonoAgentAppLogger;
  readonly runtime?: MonoRuntimeLike;
  readonly traceDefaults?: AppTraceDefaults;
}

class MonoAgentAppController implements MonoAgentApp {
  readonly operatorConsole: MonoAgentAppOperatorConsole | undefined;
  readonly configPath: string;
  private readonly consoleServer: OperatorConsoleStartResult | undefined;
  private readonly cwd: string;
  private readonly env: Record<string, string | undefined>;
  private readonly drivers: readonly ChannelDriver[];
  private readonly driversById: ReadonlyMap<ChannelId, ChannelDriver>;
  private readonly logger: MonoAgentAppLogger | undefined;
  private readonly runtime: MonoRuntimeLike | undefined;
  private readonly traceDefaults: AppTraceDefaults | undefined;
  private readonly activeRuntimes: MonoRuntimeLike[] = [];
  private readonly statuses = new Map<ChannelId, ChannelStatus>();
  private readonly running = new Map<ChannelId, RunningChannel>();
  private readonly startsInFlight = new Map<ChannelId, Promise<ChannelStatus>>();
  private traceabilityStatusValue: TraceabilityStatus = {
    kind: "disabled",
    reason: "Traceability has not started yet.",
  };
  private traceSource: TraceSourceHandle | undefined;
  private memoryRituals: RunningRituals | undefined;
  // One shared memory store across all channel responders + the ritual scheduler, so there is a single
  // memory.db handle (not one per channel plus one for rituals). Rebuilt on config reload, closed on stop.
  private sharedMemory: ReturnType<typeof createConfiguredMemory> = undefined;
  private sharedMemoryBuilt = false;
  private configApplyTail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(input: MonoAgentAppControllerInput) {
    this.consoleServer = input.consoleServer;
    this.cwd = input.cwd;
    this.configPath = input.configPath;
    this.env = input.env;
    this.drivers = input.drivers;
    this.driversById = new Map(input.drivers.map((driver) => [driver.id, driver]));
    this.logger = input.logger;
    this.runtime = input.runtime;
    this.traceDefaults = input.traceDefaults;
    for (const driver of input.drivers) {
      this.statuses.set(driver.id, {
        kind: "waiting_for_config",
        reason: `${driver.label} has not been configured yet.`,
      });
    }
    this.operatorConsole = input.consoleServer === undefined
      ? undefined
      : {
          url: input.consoleServer.url,
          appUrl: `${input.consoleServer.url}/?t=${input.consoleServer.token}`,
          token: input.consoleServer.token,
          configPath: input.configPath,
        };
  }

  get traceabilityStatus(): TraceabilityStatus {
    return this.traceabilityStatusValue;
  }

  channelStatus(id: ChannelId): ChannelStatus {
    const status = this.statuses.get(id);
    if (status === undefined) {
      return { kind: "disabled", reason: `Channel ${id} is not registered with this app.` };
    }
    return status;
  }

  channelStatuses(): ReadonlyMap<ChannelId, ChannelStatus> {
    return new Map(this.statuses);
  }

  async applyConfigChange(reason: string): Promise<ConfigApplyResult> {
    const run = async (): Promise<ConfigApplyResult> => {
      if (this.stopped) {
        return {
          kind: "failed",
          message: "Mono agent app has already stopped.",
          transports: [],
        };
      }
      for (const driver of this.drivers) {
        await this.stopChannel(driver.id, `${reason}:reload`);
      }
      this.stopMemoryRituals();
      await this.resetSharedMemory();
      await this.stopTraceSource(`${reason}:reload`);
      await this.startTraceability(reason);
      await Promise.all(this.drivers.map((driver) => this.startChannelIfConfigured(driver.id, reason)));
      await this.startMemoryRitualsIfConfigured(reason);
      await this.refreshTraceSource(`${reason}:complete`);
      return this.applyResult();
    };

    const next = this.configApplyTail.then(run, run);
    this.configApplyTail = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  async startChannelIfConfigured(id: ChannelId, reason: string): Promise<ChannelStatus> {
    const driver = this.driversById.get(id);
    if (driver === undefined || this.stopped) {
      return this.channelStatus(id);
    }
    if (this.running.has(id)) {
      if (reason === "operator-console-write") {
        this.logger?.info?.(`${driver.label} is already running; restart the app to apply later config changes.`, {
          status: "running",
        });
      }
      await this.refreshTraceSource(reason);
      return this.channelStatus(id);
    }
    const inFlight = this.startsInFlight.get(id);
    if (inFlight !== undefined) {
      return await inFlight;
    }

    const start = this.startChannel(driver, reason).finally(() => {
      this.startsInFlight.delete(id);
    });
    this.startsInFlight.set(id, start);
    const status = await start;
    await this.refreshTraceSource(reason);
    return status;
  }

  async startTraceability(reason: string): Promise<TraceabilityStatus> {
    if (this.stopped) {
      return this.traceabilityStatusValue;
    }
    try {
      const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };
      const [registryDir, artifactDir, sourceId, label, heartbeatMs] = await Promise.all([
        resolveAppTraceRegistryDir(input),
        resolveAppArtifactDir(input),
        resolveAppTraceSourceId(input, this.traceDefaults),
        resolveAppTraceSourceLabel(input, this.traceDefaults),
        resolveAppTraceHeartbeatMs(input),
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
    } catch (error) {
      const failure = reasonOf(error);
      this.traceabilityStatusValue = { kind: "failed", reason: failure };
      this.logger?.error?.("Traceability source registration failed.", { reason: failure });
    }
    return this.traceabilityStatusValue;
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

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const driver of this.drivers) {
      await this.stopChannel(driver.id, "stop");
    }
    this.stopMemoryRituals();
    await this.resetSharedMemory();
    await this.stopTraceSource("stop");
    await this.consoleServer?.stop();
    for (const runtime of this.activeRuntimes.splice(0)) {
      await runtime.disposeAllSessions?.().catch(() => undefined);
    }
  }

  async startMemoryRitualsIfConfigured(reason: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    let coreConfig: MonoAgentConfig;
    try {
      const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };
      coreConfig = await loadAppCoreConfig(input);
    } catch {
      // Config not ready yet — rituals will start on the next applyConfigChange.
      return;
    }

    if (coreConfig.memory?.mode !== "bujo") {
      return;
    }

    const store = this.memoryStore(coreConfig);
    // Duck-type: only bujo-tier BujoMemoryStore has reflect/migrate.
    // Cast through unknown to bypass the MemoryStore contract's type mismatch.
    const storeAsAny = store as unknown as Record<string, unknown>;
    if (
      store === undefined ||
      typeof storeAsAny["reflect"] !== "function" ||
      typeof storeAsAny["migrate"] !== "function" ||
      typeof storeAsAny["tier"] !== "function"
    ) {
      return;
    }

    const bujoStore = store as unknown as {
      tier(): string;
      reflect(): Promise<unknown>;
      migrate(): Promise<unknown>;
    };

    this.memoryRituals = startMemoryRituals({
      store: bujoStore,
      ...(coreConfig.memory.reflection !== undefined && { reflection: coreConfig.memory.reflection }),
      ...(coreConfig.memory.migration !== undefined && { migration: coreConfig.memory.migration }),
      ...(this.logger !== undefined && {
        logger: {
          info: (m: string) => this.logger?.info?.(m),
          warn: (m: string) => this.logger?.warn?.(m),
        },
      }),
    });

    this.logger?.info?.("Memory ritual scheduler started.", { reason, mode: "bujo" });
  }

  private stopMemoryRituals(): void {
    const rituals = this.memoryRituals;
    if (rituals === undefined) {
      return;
    }
    this.memoryRituals = undefined;
    rituals.stop();
    this.logger?.info?.("Memory ritual scheduler stopped.");
  }

  private async startChannel(driver: ChannelDriver, reason: string): Promise<ChannelStatus> {
    const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };

    let config: unknown;
    try {
      config = await driver.loadConfig(input);
    } catch (error) {
      if (driver.isConfigError(error)) {
        return this.setStatus(driver.id, { kind: "waiting_for_config", reason: reasonOf(error) });
      }
      throw error;
    }

    const disabledReason = driver.disabledReason?.(config);
    if (disabledReason !== undefined) {
      return this.setStatus(driver.id, { kind: "disabled", reason: disabledReason });
    }

    const waitingReason = driver.waitingReason?.(config);
    if (waitingReason !== undefined) {
      return this.setStatus(driver.id, { kind: "waiting_for_config", reason: waitingReason });
    }

    let coreConfig: MonoAgentConfig;
    try {
      coreConfig = await loadAppCoreConfig(input);
    } catch (error) {
      if (isAppCoreConfigError(error)) {
        this.logger?.info?.("Waiting for a valid agent config.", { reason: error.message });
        return this.setStatus(driver.id, { kind: "waiting_for_config", reason: error.message });
      }
      throw error;
    }

    try {
      const responder = this.buildResponder(coreConfig);
      const runningChannel = await driver.start({
        config,
        coreConfig,
        responder,
        cwd: this.cwd,
        ...(this.logger === undefined ? {} : { logger: this.logger }),
        onFailure: (failureReason) => {
          this.running.delete(driver.id);
          this.setStatus(driver.id, { kind: "failed", reason: failureReason });
          this.logger?.error?.(`${driver.label} channel stopped with an error.`, { reason: failureReason });
        },
      });
      this.running.set(driver.id, runningChannel);
      const status = this.setStatus(driver.id, { kind: "running", summary: runningChannel.summary });
      this.logger?.info?.(`${driver.label} channel is running.`, { reason, ...runningChannel.summary });
      return status;
    } catch (error) {
      const failure = reasonOf(error);
      this.logger?.error?.(`${driver.label} channel failed to start.`, { reason: failure });
      return this.setStatus(driver.id, { kind: "failed", reason: failure });
    }
  }

  private async stopChannel(id: ChannelId, reason: string): Promise<void> {
    const driver = this.driversById.get(id);
    const runningChannel = this.running.get(id);
    if (driver === undefined || runningChannel === undefined) {
      return;
    }
    this.running.delete(id);
    await runningChannel.stop().catch((error: unknown) => {
      this.logger?.warn?.(`${driver.label} channel did not stop cleanly.`, { reason, error: reasonOf(error) });
    });
    if (!this.stopped) {
      this.setStatus(id, {
        kind: "waiting_for_config",
        reason: `${driver.label} stopped while applying config.`,
      });
    }
  }

  private buildResponder(coreConfig: MonoAgentConfig): AgentResponder {
    const runtime = this.runtime ?? createConfiguredAgentRuntime(coreConfig);
    if (!this.activeRuntimes.includes(runtime)) {
      this.activeRuntimes.push(runtime);
    }
    const memory = this.memoryStore(coreConfig);
    return createConfiguredAgentResponder({
      config: coreConfig,
      runtime,
      ...(memory !== undefined && { memory }),
    });
  }

  /** Build the configured memory store once and share it across responders + the ritual scheduler. */
  private memoryStore(coreConfig: MonoAgentConfig): ReturnType<typeof createConfiguredMemory> {
    if (!this.sharedMemoryBuilt) {
      const appLogger = this.logger;
      const logger = appLogger?.warn !== undefined
        ? { warn: (message: string) => { appLogger.warn?.(message); } }
        : undefined;
      this.sharedMemory = createConfiguredMemory(coreConfig, ...(logger !== undefined ? [{ logger }] : []));
      this.sharedMemoryBuilt = true;
    }
    return this.sharedMemory;
  }

  /** Close + clear the shared memory store (on config reload or stop) so the next build is fresh. */
  private async resetSharedMemory(): Promise<void> {
    const mem = this.sharedMemory as
      | { flush?: () => Promise<void>; close?: () => Promise<void> | void }
      | undefined;
    this.sharedMemory = undefined;
    this.sharedMemoryBuilt = false;
    if (mem?.flush !== undefined) {
      await Promise.resolve(mem.flush()).catch(() => undefined);
    }
    if (mem?.close !== undefined) {
      await Promise.resolve(mem.close()).catch(() => undefined);
    }
  }

  /** @internal Test-only seam: seed the shared memory store without going through config. */
  __setSharedMemoryForTest(store: ReturnType<typeof createConfiguredMemory>): void {
    this.sharedMemory = store;
    this.sharedMemoryBuilt = true;
  }

  private setStatus(id: ChannelId, status: ChannelStatus): ChannelStatus {
    this.statuses.set(id, status);
    return status;
  }

  private applyResult(): ConfigApplyResult {
    const transports = this.activeTransports();
    const statuses = [...this.statuses.values()];
    const failedChannel = statuses.find((status) => status.kind === "failed");
    const failure = failedChannel?.kind === "failed"
      ? failedChannel.reason
      : this.traceabilityStatusValue.kind === "failed"
        ? this.traceabilityStatusValue.reason
        : undefined;
    if (failure !== undefined) {
      return {
        kind: "failed",
        message: `Saved config, but live apply failed: ${failure}`,
        transports,
      };
    }

    const hasRunningChannel = statuses.some((status) => status.kind === "running");
    if (!hasRunningChannel && statuses.some((status) => status.kind === "waiting_for_config")) {
      return {
        kind: "waiting_for_config",
        message: "Saved config, but no agent channel is running yet.",
        transports,
      };
    }

    return {
      kind: "applied",
      message: `Saved config and reloaded ${transports.join(", ")}.`,
      transports,
    };
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

  private activeTransports(): readonly string[] {
    const transports: string[] = [];
    if (this.consoleServer !== undefined) {
      transports.push("operator-console");
    }
    for (const driver of this.drivers) {
      if (this.statuses.get(driver.id)?.kind === "running") {
        transports.push(driver.id);
      }
    }
    return transports;
  }

  private traceMetadata(reason: string): Record<string, unknown> {
    const channels: Record<string, unknown> = {};
    for (const driver of this.drivers) {
      const status = this.statuses.get(driver.id);
      if (status === undefined) {
        continue;
      }
      channels[driver.id] = status.kind === "running"
        ? { kind: "running", ...status.summary }
        : { kind: status.kind, reason: status.reason };
    }
    return {
      reason,
      ...(this.operatorConsole === undefined
        ? {}
        : {
            operatorConsole: {
              // Only the base loopback URL is persisted — never the per-boot
              // access token. A detached `status`/`start` reader surfaces this
              // URL and points at the logs for the tokenized link.
              url: this.operatorConsole.url,
              configPath: this.operatorConsole.configPath,
            },
          }),
      channels,
    };
  }
}

function logOperatorConsoleEvent(logger: MonoAgentAppLogger | undefined, event: OperatorConsoleEvent): void {
  if (event.kind === "validation_failed" || event.kind === "unauthorized") {
    logger?.warn?.("Operator Console event.", { event });
    return;
  }
  logger?.debug?.("Operator Console event.", { event });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
