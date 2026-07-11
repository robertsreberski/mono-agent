import { resolve } from "node:path";

import { loadToolPolicyFromJsonFileSync } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createLiveEventBus } from "@mono-agent/agent-contracts";
import type { AgentResponder, RunEventBus } from "@mono-agent/agent-contracts";
import { pruneTraceSources, reconcileStaleRunArtifacts, registerTraceSource } from "@mono-agent/observability";
import type { TraceSourceHandle } from "@mono-agent/observability";
import { modelReferenceKey } from "@mono-agent/runtime-adapter";
import type { MonoRuntimeLike, RuntimeModelReference } from "@mono-agent/runtime-adapter";
import {
  describeSandboxEffectiveState,
  resolveSandboxEffectiveState,
  sandboxEffectiveStateWarning,
} from "@mono-agent/runtime-adapter";
import type { SandboxEffectiveState, SandboxEngine } from "@mono-agent/runtime-adapter";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
  resolveAppArtifactDir,
  resolveAppObservabilityExporters,
  resolveAppTraceGlobalDiscovery,
  resolveAppTraceHeartbeatMs,
  resolveAppTraceRegistryDir,
  resolveAppTraceSourceId,
  resolveAppTraceSourceLabel,
  resolveAppTraceStaleAfterMs,
  resolveGlobalTraceRegistryDir,
  resolveTraceTmpdirRoot,
  shouldMirrorTraceSourceGlobally,
} from "./app-config.js";
import type { AppTraceDefaults, MonoAgentAppConfigInput, ResolvedExporter } from "./app-config.js";
import {
  createConfiguredAgentResponder,
  createConfiguredAgentRuntime,
  createConfiguredMemory,
} from "./configured-agent.js";
import type { ConfiguredAgentSessionEvent, ConfiguredAgentSessionSnapshot } from "./configured-agent.js";
import { resolveChannelDrivers } from "./channels.js";
import type { ChannelDriver, ChannelId, ChannelStatus, MonoAgentAppLogger, RunningChannel } from "./channels.js";
import { routeProactiveNotification } from "./proactive-notify.js";
import type { NotifyDeliveryResult } from "./proactive-notify.js";
import {
  adapterSendToolNames,
  createAdapterSendToolsRuntimeExtension,
  isAdapterSendToolAllowed,
  resolveAdapterSendToolsSettings,
} from "./adapter-send-tools.js";
import { loadInteractionSettings, startInteractionBridge } from "./interaction-bridge.js";
import type { InteractionBridgeHandle } from "./interaction-bridge.js";
import { startMemoryRituals } from "./memory-rituals.js";
import type { RunningRituals } from "./memory-rituals.js";
import { startArtifactRetentionScheduler } from "./artifact-retention.js";
import type { RunningArtifactRetentionScheduler } from "./artifact-retention.js";
import {
  resolveMemoryRecallSettings,
} from "./memory-recall.js";
import {
  isSharedRecallStore,
  MemoryRetrievalService,
} from "./memory-retrieval.js";
import {
  composeRuntimeOptionExtensions,
  type RuntimeOptionsExtension,
} from "./runtime-option-extensions.js";
import {
  createRunHistoryRuntimeExtension,
  isRunHistoryToolAllowed,
} from "./run-history.js";
import {
  createRequestModelOverrideRuntimeExtension,
  requestModelOverrideTargetsDirectOpenCode,
} from "./request-model-override.js";
import { resolveNotifyDestinations } from "./notify-destinations.js";
import type { NotifyDestination } from "./notify-destinations.js";
import { resolvePostedMessageIndexPath } from "./posted-message-index.js";
import {
  configuredRuntimeFallbackModels,
  configuredRuntimeModels,
  hasConfiguredRuntimeFallbacks,
} from "./runtime-routes.js";

/**
 * Outcome of a live config re-apply (`applyConfigChange`). Consumed by callers
 * that trigger a reload and by demos that surface the result.
 */
export type ConfigApplyResult =
  | { readonly kind: "applied"; readonly message: string; readonly transports: readonly string[] }
  | { readonly kind: "waiting_for_config"; readonly message: string; readonly transports: readonly string[] }
  | { readonly kind: "failed"; readonly message: string; readonly transports: readonly string[] };

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
  /** Sandbox engine override (testing / advanced composition). */
  readonly sandboxEngine?: SandboxEngine;
  readonly traceDefaults?: AppTraceDefaults;
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

/**
 * Best-effort observability exporter status. `configured` does not assert
 * reachability (Phoenix may start later — only `validate` probes); export
 * failures during runs surface as `lastWarning`/`lastError` without changing the
 * run outcome.
 */
export type ExporterStatus =
  | {
      readonly kind: "configured";
      readonly endpoint: string;
      readonly includeSensitiveData: boolean;
      readonly lastWarning?: string;
      readonly lastError?: string;
    }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface SandboxStatus extends SandboxEffectiveState {
  readonly detail: string;
  readonly warning?: string;
  readonly resolutionError?: string;
}

type SessionTraceState = "warm" | "cold";

interface SessionTraceMetadata {
  readonly currentBucketId: string;
  readonly state: SessionTraceState;
  readonly event: ConfiguredAgentSessionEvent["kind"];
  readonly updatedAt: string;
  readonly snapshot?: readonly ConfiguredAgentSessionSnapshot[];
  readonly providerSessionId?: string;
  readonly createdAt?: number;
  readonly lastActivityAt?: number;
  readonly busy?: boolean;
  readonly reason?: string;
  readonly nextRolloverAt?: string;
}

export interface MonoAgentApp {
  readonly configPath: string;
  readonly traceabilityStatus: TraceabilityStatus;
  readonly exporterStatus: ExporterStatus;
  readonly sandboxStatus: SandboxStatus;
  readonly selectedSkills: readonly string[] | undefined;
  channelStatus(id: ChannelId): ChannelStatus;
  channelStatuses(): ReadonlyMap<ChannelId, ChannelStatus>;
  startChannelIfConfigured(id: ChannelId, reason: string): Promise<ChannelStatus>;
  applyConfigChange(reason: string): Promise<ConfigApplyResult>;
  stop(): Promise<void>;
}

/**
 * Starts a config-first mono-agent host in `cwd`: traceability first, then every
 * configured channel in parallel. Channels with incomplete config report
 * `waiting_for_config` instead of blocking the rest. The host runs headless;
 * config changes take effect on the next restart.
 */
export async function startMonoAgentApp(options: MonoAgentAppOptions = {}): Promise<MonoAgentApp> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.configPath ?? "mono-agent.config.json");
  const env = options.env ?? process.env;
  const drivers = options.drivers ?? await resolveChannelDrivers({ env, cwd, configPath });

  const controller = new MonoAgentAppController({
    cwd,
    configPath,
    env,
    drivers,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.sandboxEngine === undefined ? {} : { sandboxEngine: options.sandboxEngine }),
    ...(options.traceDefaults === undefined ? {} : { traceDefaults: options.traceDefaults }),
  });

  await controller.refreshSandboxStatus("startup");
  await controller.startTraceability("startup");
  await controller.startExporters("startup");
  await Promise.all(drivers.map((driver) => controller?.startChannelIfConfigured(driver.id, "startup")));
  await controller.startMemoryRitualsIfConfigured("startup");
  await controller.refreshTraceSource("startup-complete");
  return controller;
}

interface MonoAgentAppControllerInput {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
  readonly drivers: readonly ChannelDriver[];
  readonly logger?: MonoAgentAppLogger;
  readonly runtime?: MonoRuntimeLike;
  readonly sandboxEngine?: SandboxEngine;
  readonly traceDefaults?: AppTraceDefaults;
}

const DEFAULT_SANDBOX_STATUS: SandboxStatus = sandboxStatusFromState({
  configured: false,
  configuredMode: undefined,
  effective: "off",
  engine: undefined,
  engineAvailable: undefined,
  fallback: undefined,
  fallbackActive: false,
  unsafeAllowHostProcess: false,
});

class MonoAgentAppController implements MonoAgentApp {
  readonly configPath: string;
  private readonly cwd: string;
  private readonly env: Record<string, string | undefined>;
  private readonly drivers: readonly ChannelDriver[];
  private readonly driversById: ReadonlyMap<ChannelId, ChannelDriver>;
  private readonly logger: MonoAgentAppLogger | undefined;
  private readonly runtime: MonoRuntimeLike | undefined;
  private readonly sandboxEngine: SandboxEngine | undefined;
  private readonly traceDefaults: AppTraceDefaults | undefined;
  private readonly activeRuntimes: MonoRuntimeLike[] = [];
  private readonly statuses = new Map<ChannelId, ChannelStatus>();
  private readonly running = new Map<ChannelId, RunningChannel>();
  private readonly startsInFlight = new Map<ChannelId, Promise<ChannelStatus>>();
  /** Captured at construction (~process start): the cutoff for reclaiming orphaned "running" runs. */
  private readonly processStartMs = Date.now();
  private staleRunsReconciled = false;
  private traceabilityStatusValue: TraceabilityStatus = {
    kind: "disabled",
    reason: "Traceability has not started yet.",
  };
  private exporterStatusValue: ExporterStatus = {
    kind: "disabled",
    reason: "No observability exporter configured.",
  };
  private sandboxStatusValue: SandboxStatus = DEFAULT_SANDBOX_STATUS;
  private selectedSkillsValue: readonly string[] | undefined;
  private sessionMetadataValue: SessionTraceMetadata | undefined;
  /** The exporter the responder threads into agent-host (first configured exporter). */
  private resolvedExporter: ResolvedExporter | undefined;
  private traceSource: TraceSourceHandle | undefined;
  private traceRefreshTail: Promise<void> = Promise.resolve();
  // Best-effort mirror of `traceSource` into the machine-wide global registry,
  // present only when `shouldMirrorTraceSourceGlobally` gates it on (see
  // `startTraceability`). Kept in lockstep with `traceSource` on every
  // refresh/stop so both manifests describe the same instance identically.
  private globalTraceSource: TraceSourceHandle | undefined;
  private artifactRetentionScheduler: RunningArtifactRetentionScheduler | undefined;
  private artifactRetentionGeneration = 0;
  private memoryRituals: RunningRituals | undefined;
  // One shared memory store across all channel responders + the ritual scheduler, so there is a single
  // memory.db handle (not one per channel plus one for rituals). Rebuilt on config reload, closed on stop.
  private sharedMemory: Awaited<ReturnType<typeof createConfiguredMemory>> = undefined;
  private sharedMemoryRetrieval: MemoryRetrievalService | undefined;
  private sharedMemoryBuilt = false;
  private sharedMemoryBuild: Promise<Awaited<ReturnType<typeof createConfiguredMemory>>> | undefined;
  private configApplyTail: Promise<void> = Promise.resolve();
  private stopped = false;
  // Interaction bridge (AskUser + tool progress): lazily started once, shared
  // by every channel; the exported env keys are tracked for cleanup on stop.
  private interactionBridge: InteractionBridgeHandle | undefined;
  private interactionBridgeStart: Promise<InteractionBridgeHandle | undefined> | undefined;
  private interactionBridgeEnvKeys: readonly string[] = [];
  // Shared in-process run-event bus: every run's recorder publishes to it (via the
  // broadcast recorder threaded as `runEventSink`), and the `live` channel relays
  // it over SSE. One instance for the app's lifetime — cheap, bounded ring buffer,
  // and it must exist before any responder is built (like the interaction bridge).
  private readonly liveEventBus: RunEventBus = createLiveEventBus();

  constructor(input: MonoAgentAppControllerInput) {
    this.cwd = input.cwd;
    this.configPath = input.configPath;
    this.env = input.env;
    this.drivers = input.drivers;
    this.driversById = new Map(input.drivers.map((driver) => [driver.id, driver]));
    this.logger = input.logger;
    this.runtime = input.runtime;
    this.sandboxEngine = input.sandboxEngine;
    this.traceDefaults = input.traceDefaults;
    for (const driver of input.drivers) {
      this.statuses.set(driver.id, {
        kind: "waiting_for_config",
        reason: `${driver.label} has not been configured yet.`,
      });
    }
  }

  get traceabilityStatus(): TraceabilityStatus {
    return this.traceabilityStatusValue;
  }

  get exporterStatus(): ExporterStatus {
    return this.exporterStatusValue;
  }

  get sandboxStatus(): SandboxStatus {
    return this.sandboxStatusValue;
  }

  get selectedSkills(): readonly string[] | undefined {
    return this.selectedSkillsValue;
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
      // Tool policy/runtime-family changes must re-evaluate implicit AskUser.
      // Clearing the cached promise also prevents stale bridge env from a Pi
      // config leaking into a reloaded direct-OpenCode responder.
      await this.stopInteractionBridge();
      this.stopMemoryRituals();
      this.stopArtifactRetentionScheduler();
      await this.resetSharedMemory();
      await this.stopTraceSource(`${reason}:reload`);
      await this.refreshSandboxStatus(reason);
      await this.startTraceability(reason);
      await this.startExporters(reason);
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
    let artifactDirForRetention: string | undefined;
    try {
      const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };
      await this.refreshSelectedSkillsSnapshot(reason);
      const [registryDir, artifactDir, sourceId, label, heartbeatMs, globalDiscovery] = await Promise.all([
        resolveAppTraceRegistryDir(input),
        resolveAppArtifactDir(input),
        resolveAppTraceSourceId(input, this.traceDefaults),
        resolveAppTraceSourceLabel(input, this.traceDefaults),
        resolveAppTraceHeartbeatMs(input),
        resolveAppTraceGlobalDiscovery(input),
      ]);
      artifactDirForRetention = artifactDir;
      const registerOptions = {
        registryDir,
        sourceId,
        label,
        artifactDir,
        pid: process.pid,
        transports: this.activeTransports(),
        configPath: this.configPath,
        metadata: this.traceMetadata(reason),
        heartbeatMs,
      };
      this.traceSource = await registerTraceSource(registerOptions);
      this.traceabilityStatusValue = { kind: "running", sourceId, registryDir, artifactDir };
      this.logger?.info?.("Traceability source registered.", { reason, sourceId, registryDir, artifactDir });
      void pruneTraceSources({ registryDir });

      // Best-effort global mirror: makes this agent discoverable by `mono-agent
      // tui` run anywhere on the machine, even when its own registryDir is a
      // config-local override (e.g. `mono-agent init`'s scaffold). A mirror
      // failure must never affect the primary registration above.
      const globalRegistryDir = resolveGlobalTraceRegistryDir(this.env);
      const tmpdirRoot = resolveTraceTmpdirRoot(this.env);
      if (shouldMirrorTraceSourceGlobally({ registryDir, globalRegistryDir, globalDiscovery, tmpdirRoot })) {
        try {
          this.globalTraceSource = await registerTraceSource({ ...registerOptions, registryDir: globalRegistryDir });
          void pruneTraceSources({ registryDir: globalRegistryDir });
        } catch (error) {
          this.globalTraceSource = undefined;
          this.logger?.warn?.("Global trace-source mirror registration failed.", { reason: reasonOf(error) });
        }
      } else {
        this.globalTraceSource = undefined;
      }

    } catch (error) {
      const failure = reasonOf(error);
      this.traceabilityStatusValue = { kind: "failed", reason: failure };
      this.logger?.error?.("Traceability source registration failed.", { reason: failure });
    } finally {
      if (artifactDirForRetention !== undefined) {
        // Fire-and-forget: orphan reclamation and retention are best-effort cleanup
        // and must not gate startup readiness. Keep them independent from trace
        // source registration; a broken registry should not disable artifact GC.
        this.restartArtifactRetentionScheduler(artifactDirForRetention, reason);
      }
    }
    return this.traceabilityStatusValue;
  }

  async refreshSandboxStatus(reason: string): Promise<SandboxStatus> {
    try {
      const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };
      const coreConfig = await loadAppCoreConfig(input);
      const state = await resolveSandboxEffectiveState({
        ...(coreConfig.sandbox === undefined ? {} : { policy: coreConfig.sandbox }),
        ...(this.sandboxEngine === undefined ? {} : { engine: this.sandboxEngine }),
      });
      const status = sandboxStatusFromState(state);
      this.sandboxStatusValue = status;
      if (status.warning !== undefined) {
        this.logger?.warn?.(status.warning, { reason, detail: status.detail });
      }
      return status;
    } catch (error) {
      const resolutionError = reasonOf(error);
      const status = {
        ...DEFAULT_SANDBOX_STATUS,
        detail: `Sandbox status unavailable until agent config loads: ${resolutionError}`,
        resolutionError,
      };
      this.sandboxStatusValue = status;
      this.logger?.info?.("Sandbox status unavailable until agent config loads.", { reason, detail: resolutionError });
      return status;
    }
  }

  /**
   * One-shot at startup: a process that crashed mid-run leaves its summary stuck at "running"
   * forever (a ghost run in `status`/observability). Reclaim those — any "running" summary that
   * began before THIS process started — by rewriting them to "interrupted". Gated so a config
   * reload (which re-runs startTraceability) does not repeat the scan. Best-effort: never fatal.
   */
  private async reconcileStaleRunsOnce(artifactDir: string): Promise<void> {
    if (this.staleRunsReconciled) {
      return;
    }
    this.staleRunsReconciled = true;
    try {
      const { reconciled, warnings } = await reconcileStaleRunArtifacts(artifactDir, {
        startedBeforeMs: this.processStartMs,
      });
      for (const warning of warnings) {
        this.logger?.warn?.(`Stale-run reconciliation: ${warning}`);
      }
      if (reconciled.length > 0) {
        this.logger?.info?.('Reclaimed orphaned runs left as "running" by a prior process.', {
          count: reconciled.length,
          runIds: reconciled.slice(0, 20),
        });
      }
    } catch (error) {
      this.logger?.warn?.("Stale-run reconciliation failed.", { reason: reasonOf(error) });
    }
  }

  /**
   * Resolve the configured observability exporter(s) and publish the export
   * status. No reachability probe runs here — Phoenix may start after the agent,
   * so an unreachable endpoint must not block startup (that probe runs in
   * `validate`). A present-but-invalid exporter config surfaces as `failed`.
   */
  async startExporters(reason: string): Promise<ExporterStatus> {
    if (this.stopped) {
      return this.exporterStatusValue;
    }
    const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };
    let exporters: readonly ResolvedExporter[];
    try {
      exporters = await resolveAppObservabilityExporters(input);
    } catch (error) {
      this.resolvedExporter = undefined;
      this.exporterStatusValue = { kind: "failed", reason: reasonOf(error) };
      this.logger?.error?.("Observability exporter config is invalid.", { reason: reasonOf(error) });
      return this.exporterStatusValue;
    }

    const exporter = exporters[0];
    if (exporter === undefined) {
      this.resolvedExporter = undefined;
      this.exporterStatusValue = { kind: "disabled", reason: "No observability exporter configured." };
      return this.exporterStatusValue;
    }

    this.resolvedExporter = exporter;
    this.exporterStatusValue = {
      kind: "configured",
      endpoint: exporter.endpoint,
      includeSensitiveData: exporter.includeSensitiveData ?? false,
    };
    this.logger?.info?.("Observability exporter configured.", {
      reason,
      endpoint: exporter.endpoint,
      includeSensitiveData: exporter.includeSensitiveData ?? false,
    });
    return this.exporterStatusValue;
  }

  /** Record a best-effort export warning so `status` can surface it without failing the run. */
  private recordExporterWarning(warning: { phase: string; message: string }): void {
    const current = this.exporterStatusValue;
    if (current.kind !== "configured") {
      return;
    }
    const message = `${warning.phase}: ${warning.message}`;
    // The "fail" phase fires only when export fails on the run-failure path;
    // surface it as lastError so operators can tell it apart from a transient
    // best-effort warning. The run outcome is unchanged either way.
    this.exporterStatusValue =
      warning.phase === "fail" ? { ...current, lastError: message } : { ...current, lastWarning: message };
    this.logger?.warn?.("Observability export warning.", { phase: warning.phase, message: warning.message });
    // Persist to the trace-source manifest so the detached `mono-agent status`
    // (which reads the manifest, not this live object) can surface it too.
    void this.refreshTraceSource("exporter-warning").catch(() => undefined);
  }

  async refreshTraceSource(reason: string): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.traceSource === undefined) {
        return;
      }
      const patch = { transports: this.activeTransports(), metadata: this.traceMetadata(reason) };
      try {
        await this.traceSource.update(patch);
      } catch (error) {
        this.logger?.warn?.("Traceability source update failed.", { reason: reasonOf(error) });
      }
      if (this.globalTraceSource !== undefined) {
        try {
          await this.globalTraceSource.update(patch);
        } catch (error) {
          this.logger?.warn?.("Global trace-source mirror update failed.", { reason: reasonOf(error) });
        }
      }
    };
    const next = this.traceRefreshTail.then(run, run);
    this.traceRefreshTail = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  /**
   * Start the interaction bridge once, when a blocking ask tool is allowed by
   * the tool policy or the operator configured the `interaction` block. Exports the
   * bridge env into the app env AND process env so settings resolution and
   * spawned stdio tool children (which inherit process.env) can reach it.
   */
  private ensureInteractionBridge(coreConfig: MonoAgentConfig): Promise<InteractionBridgeHandle | undefined> {
    this.interactionBridgeStart ??= (async () => {
      const directOpenCodeRoute = runtimeRouteContainsDirectOpenCode(coreConfig);
      const settings = await loadInteractionSettings({ env: this.env, configPath: this.configPath });
      const askUserAllowed = !directOpenCodeRoute && isAdapterSendToolAllowed("AskUser", {
        allowedTools: coreConfig.tools.allowedTools,
        disallowedTools: coreConfig.tools.disallowedTools,
      });
      const telegramAskAllowed = !directOpenCodeRoute && isAdapterSendToolAllowed("TelegramAskButtons", {
        allowedTools: coreConfig.tools.allowedTools,
        disallowedTools: coreConfig.tools.disallowedTools,
      });
      if (!askUserAllowed && !telegramAskAllowed && !settings.configured) {
        return undefined;
      }
      try {
        const bridge = await startInteractionBridge({
          host: settings.host,
          port: settings.port,
          askTimeoutMs: settings.askTimeoutMs,
          ...(this.logger === undefined ? {} : { logger: this.logger }),
        });
        const bridgeEnv = bridge.env();
        this.interactionBridgeEnvKeys = Object.keys(bridgeEnv);
        Object.assign(this.env, bridgeEnv);
        if ((this.env as unknown) !== process.env) {
          Object.assign(process.env, bridgeEnv);
        }
        this.interactionBridge = bridge;
        this.logger?.info?.("Interaction bridge started.", { url: bridge.url });
        return bridge;
      } catch (error) {
        this.logger?.warn?.("Interaction bridge failed to start; AskUser and tool progress are unavailable.", {
          reason: reasonOf(error),
        });
        return undefined;
      }
    })();
    return this.interactionBridgeStart;
  }

  private async stopInteractionBridge(): Promise<void> {
    const bridge = this.interactionBridge;
    this.interactionBridge = undefined;
    this.interactionBridgeStart = undefined;
    for (const key of this.interactionBridgeEnvKeys) {
      delete this.env[key];
      if ((this.env as unknown) !== process.env) {
        delete process.env[key];
      }
    }
    this.interactionBridgeEnvKeys = [];
    await bridge?.stop().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const driver of this.drivers) {
      await this.stopChannel(driver.id, "stop");
    }
    await this.stopInteractionBridge();
    this.stopMemoryRituals();
    this.stopArtifactRetentionScheduler();
    await this.resetSharedMemory();
    await this.stopTraceSource("stop");
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
      this.rememberSelectedSkills(coreConfig);
    } catch {
      // Config not ready yet — consolidation will start on the next applyConfigChange.
      return;
    }

    if (coreConfig.memory?.mode !== "bujo") {
      return;
    }

    const runtime = this.runtime ?? createConfiguredAgentRuntime({
      config: coreConfig,
      ...(this.sandboxEngine === undefined ? {} : { sandboxEngine: this.sandboxEngine }),
    });
    if (!this.activeRuntimes.includes(runtime)) {
      this.activeRuntimes.push(runtime);
    }
    const store = await this.memoryStore(coreConfig);
    // Duck-type: only bujo-tier BujoMemoryStore has consolidate().
    // Cast through unknown to bypass the MemoryStore contract's type mismatch.
    const storeAsAny = store as unknown as Record<string, unknown>;
    if (
      store === undefined ||
      typeof storeAsAny["consolidate"] !== "function" ||
      typeof storeAsAny["tier"] !== "function"
    ) {
      this.logger?.info?.("Memory consolidation scheduler skipped — store does not support consolidate().", { reason });
      return;
    }

    const bujoStore = store as unknown as {
      tier(): string;
      consolidate(): Promise<unknown>;
    };

    // `memory.mode` is "bujo", but the store derives the runtime tier from its options: without a
    // `memory.llm` it downgrades to "journal", where startMemoryRituals is a no-op. Don't claim the
    // scheduler started in that case — log an accurate skip instead.
    const tier = bujoStore.tier();
    if (tier !== "bujo") {
      this.logger?.info?.(
        "Memory consolidation scheduler skipped — configured bujo mode resolved to the journal tier because memory.llm is missing.",
        { reason, tier },
      );
      return;
    }

    this.memoryRituals = startMemoryRituals({
      store: bujoStore,
      ...(coreConfig.memory.consolidation !== undefined && { consolidation: coreConfig.memory.consolidation }),
      ...(this.logger !== undefined && {
        logger: {
          info: (m: string) => this.logger?.info?.(m),
          warn: (m: string) => this.logger?.warn?.(m),
        },
      }),
    });

    this.logger?.info?.("Memory consolidation scheduler started.", { reason, mode: "bujo" });
  }

  private stopMemoryRituals(): void {
    const rituals = this.memoryRituals;
    if (rituals === undefined) {
      return;
    }
    this.memoryRituals = undefined;
    rituals.stop();
    this.logger?.info?.("Memory consolidation scheduler stopped.");
  }

  private restartArtifactRetentionScheduler(artifactDir: string, reason: string): void {
    this.stopArtifactRetentionScheduler();
    const generation = ++this.artifactRetentionGeneration;
    void (async () => {
      let coreConfig: MonoAgentConfig;
      try {
        const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };
        coreConfig = await loadAppCoreConfig(input);
        this.rememberSelectedSkills(coreConfig);
      } catch (error) {
        this.logger?.warn?.("Artifact retention scheduler skipped until core config loads.", { reason: reasonOf(error) });
        void this.reconcileStaleRunsOnce(artifactDir);
        return;
      }
      if (this.stopped || generation !== this.artifactRetentionGeneration) {
        return;
      }
      this.artifactRetentionScheduler = startArtifactRetentionScheduler({
        artifactDir,
        retention: coreConfig.artifacts.retention,
        memoryRetention: coreConfig.artifacts.memoryRetention,
        ...(this.logger === undefined ? {} : { logger: this.logger }),
        beforeFirstRun: () => this.reconcileStaleRunsOnce(artifactDir),
      });
      this.logger?.info?.("Artifact retention scheduler started.", {
        reason,
        artifactDir,
        agent: {
          maxAgeDays: coreConfig.artifacts.retention.maxAgeDays,
          maxCount: coreConfig.artifacts.retention.maxCount,
          dryRun: coreConfig.artifacts.retention.dryRun,
        },
        memory: {
          maxAgeDays: coreConfig.artifacts.memoryRetention.maxAgeDays,
          maxCount: coreConfig.artifacts.memoryRetention.maxCount,
          dryRun: coreConfig.artifacts.memoryRetention.dryRun,
        },
      });
    })();
  }

  private stopArtifactRetentionScheduler(): void {
    this.artifactRetentionGeneration += 1;
    const scheduler = this.artifactRetentionScheduler;
    if (scheduler === undefined) {
      return;
    }
    this.artifactRetentionScheduler = undefined;
    scheduler.stop();
    this.logger?.info?.("Artifact retention scheduler stopped.");
  }

  /**
   * Deliver a native cron/webhook notification to whichever running channel owns
   * the destination conversationId. With `verbatim`, the channel posts `text`
   * unchanged (no model call) and records it to history; otherwise it runs `text`
   * as a turn. Best-effort: an unavailable/unsupported destination is warned and
   * skipped, never thrown back to the cron/webhook trigger.
   */
  private async notifyDestination(
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean },
  ): Promise<NotifyDeliveryResult> {
    const result = await routeProactiveNotification({
      conversationId,
      text,
      running: this.running,
      ...(options?.verbatim === undefined ? {} : { verbatim: options.verbatim }),
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    });
    // Make the delivery outcome inspectable (the failure cases already warn inside
    // the router / channel hooks; log the success path too so a notify is auditable).
    if (result.delivered) {
      this.logger?.info?.("Proactive notification delivered.", { conversationId });
    }
    return result;
  }

  /**
   * Candidate destinations for native cron/webhook notification delivery, used to
   * infer a target when a job/endpoint sets no explicit `notifyConversationId`.
   */
  private async listNotifyDestinations(): Promise<readonly NotifyDestination[]> {
    const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };
    const artifactDir = await resolveAppArtifactDir(input);
    return await resolveNotifyDestinations({
      input,
      artifactDir,
      isRunning: (id) => this.running.has(id),
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    });
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

    // Structural issues (e.g. an invalid per-trigger model override) fail
    // `validate` but only WARN here: the run-time override path ignores the
    // bad value and falls back, so starting is still the safe choice.
    for (const issue of driver.configIssues?.(config) ?? []) {
      this.logger?.warn?.("Channel config issue (run `mono-agent validate`).", { channel: driver.id, issue });
    }

    let coreConfig: MonoAgentConfig;
    try {
      coreConfig = await loadAppCoreConfig(input);
      this.rememberSelectedSkills(coreConfig);
    } catch (error) {
      if (isAppCoreConfigError(error)) {
        this.logger?.info?.("Waiting for a valid agent config.", { reason: error.message });
        return this.setStatus(driver.id, { kind: "waiting_for_config", reason: error.message });
      }
      throw error;
    }

    // Resolve the posted-message index path once so the Slack driver can link
    // posted messages to their producing conversation (in-thread reply continuity).
    const postedMessageIndexPath = resolvePostedMessageIndexPath(await resolveAppArtifactDir(input));

    // The bridge must exist BEFORE the responder is built (AskUser settings
    // resolution reads the exported bridge env) and before driver.start (sink
    // registration + pending-ask interception).
    const interactionBridge = await this.ensureInteractionBridge(coreConfig);

    try {
      const responder = await this.buildResponder(coreConfig);
      // The AgentResponder contract has no dispose(), but the configured responder
      // (createAgentResponder) exposes one that tears down the harness + live-session
      // manager. Read it LAZILY (at teardown time) off the `responder` so both the
      // normal stop/reload path AND the onFailure (transport-death) path retire the
      // per-channel harness rather than orphan it, and any wrapper applied to the
      // responder is honored. Duck-typed, consistent with the resetSharedMemory /
      // bujo-store patterns elsewhere in this file.
      const disposeResponder = (): Promise<void> | undefined =>
        (responder as { dispose?: () => Promise<void> }).dispose?.();
      const hasDispose = typeof (responder as { dispose?: () => Promise<void> }).dispose === "function";
      const runningChannel = await driver.start({
        config,
        coreConfig,
        responder,
        cwd: this.cwd,
        notifyDestination: (conversationId, text, options) => this.notifyDestination(conversationId, text, options),
        listNotifyDestinations: () => this.listNotifyDestinations(),
        postedMessageIndexPath,
        ...(interactionBridge === undefined ? {} : { interaction: interactionBridge }),
        liveEventBus: this.liveEventBus,
        ...(this.logger === undefined ? {} : { logger: this.logger }),
        onFailure: (failureReason) => {
          this.running.delete(driver.id);
          this.setStatus(driver.id, { kind: "failed", reason: failureReason });
          this.logger?.error?.(`${driver.label} channel stopped with an error.`, { reason: failureReason });
          // The running-channel entry (which holds the stop/reload dispose handle)
          // was just deleted, so dispose the responder here too — otherwise a
          // transport death orphans the per-channel harness/live-session manager
          // (the stop/reload path early-returns on the now-missing entry).
          void disposeResponder()?.catch((error: unknown) => {
            this.logger?.warn?.(`${driver.label} responder did not dispose cleanly after failure.`, {
              reason: failureReason,
              error: reasonOf(error),
            });
          });
        },
        // A self-recovering transport (e.g. telegram poll crash on a network blip).
        // Unlike onFailure, this must NOT delete the running entry or dispose the
        // responder: the channel owns its own restart, so the harness stays alive
        // for the restarted transport to deliver into, and a later stop/reload still
        // finds the entry and disposes it exactly once.
        onDegraded: (reason) => {
          if (this.statuses.get(driver.id)?.kind === "degraded") {
            return;
          }
          this.setStatus(driver.id, { kind: "degraded", reason });
          this.logger?.warn?.(`${driver.label} channel degraded; transport is recovering.`, { reason });
        },
        // The transport's self-recovery succeeded. Flip back to running, reusing the
        // preserved entry's summary. Guard on the entry: a recovery that races a
        // stop/reload must not resurrect a torn-down channel's status.
        onRecovered: () => {
          const entry = this.running.get(driver.id);
          if (entry === undefined) {
            return;
          }
          if (this.statuses.get(driver.id)?.kind !== "degraded") {
            return;
          }
          this.setStatus(driver.id, { kind: "running", summary: entry.summary });
          this.logger?.info?.(`${driver.label} channel recovered.`, {});
        },
      });
      this.running.set(driver.id, {
        ...runningChannel,
        stop: () => runningChannel.stop(),
        ...(hasDispose ? { dispose: () => disposeResponder() ?? Promise.resolve() } : {}),
      });
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
    // Stop the transport first (so no new turns arrive), then dispose the responder
    // so the harness/live-session manager and warm provider sessions are retired
    // rather than lingering against stale config across a reload.
    await runningChannel.dispose?.().catch((error: unknown) => {
      this.logger?.warn?.(`${driver.label} responder did not dispose cleanly.`, { reason, error: reasonOf(error) });
    });
    if (!this.stopped) {
      this.setStatus(id, {
        kind: "waiting_for_config",
        reason: `${driver.label} stopped while applying config.`,
      });
    }
  }

  private async buildResponder(coreConfig: MonoAgentConfig): Promise<AgentResponder> {
    const runtime = this.runtime ?? createConfiguredAgentRuntime(coreConfig);
    if (!this.activeRuntimes.includes(runtime)) {
      this.activeRuntimes.push(runtime);
    }
    const memoryBackend = await this.memoryStore(coreConfig);
    const memoryRetrieval = this.ensureSharedMemoryRetrieval(coreConfig, memoryBackend);
    const memory = memoryRetrieval ?? memoryBackend;
    const memoryRecallEnabled = this.reportMemoryRecallStatus(coreConfig, memoryRetrieval);
    const supermemoryMcp = this.supermemoryMcpRuntimeOptions(coreConfig);
    const adapterSendTools = await this.adapterSendToolsRuntimeOptions(coreConfig);
    const runHistoryBase = isRunHistoryToolAllowed(coreConfig.tools)
      && !runtimeRouteContainsDirectOpenCode(coreConfig)
      ? createRunHistoryRuntimeExtension({
          artifactDir: coreConfig.artifacts.dir,
          onUnavailable: (error) => {
            this.logger?.warn?.("RunHistory tool endpoint could not start; continuing without prior-run inspection.", {
              reason: reasonOf(error),
            });
          },
        })
      : undefined;
    // Always active: a no-op for interactive turns (which carry no cron/webhook
    // metadata), it applies the per-trigger model/effort override otherwise.
    const mcpSources: string[] = [];
    if (coreConfig.tools.mcpConfigPath !== undefined) {
      try {
        const names = Object.keys(loadToolPolicyFromJsonFileSync(coreConfig.tools.mcpConfigPath).mcpServers ?? {});
        if (names.length > 0) mcpSources.push(`tools.mcpConfigPath (${names.join(", ")})`);
      } catch {
        // Responder construction owns the missing/malformed policy error.
      }
    }
    if (memoryRecallEnabled) mcpSources.push("memory.recallTool");
    if (supermemoryMcp !== undefined) mcpSources.push("memory.supermemory.exposeMcpServer");
    if (adapterSendTools.blockingToolNames.length > 0) {
      mcpSources.push(`adapter send tools (${adapterSendTools.blockingToolNames.join(", ")})`);
    }
    const requestModelOverride = this.requestModelOverrideRuntimeOptions(coreConfig, {
      mcpSources,
      indexSkillsActive: coreConfig.context.skillDisclosure === "index"
        && coreConfig.context.skillsRoot !== undefined,
    });
    const adapterSendToolsExtension = adapterSendTools.createExtension?.(
      requestModelOverride.targetsDirectOpenCode,
    );
    const runHistoryExtension: RuntimeOptionsExtension | undefined = runHistoryBase === undefined
      ? undefined
      : async (requestInput) => requestModelOverride.targetsDirectOpenCode(requestInput.request.metadata)
        ? { runtimeOptions: {}, cleanup: async () => {} }
        : await runHistoryBase(requestInput);
    const runtimeOptionsForRequest = composeRuntimeOptionExtensions([
      supermemoryMcp,
      runHistoryExtension,
      adapterSendToolsExtension,
      requestModelOverride.extension,
    ]);
    // The override factory is only needed when fallbacks are configured: the
    // fallback router freezes the model chain, so an override must run on a runtime
    // whose chain has it as primary. With no fallbacks the shared (plain) runtime
    // honors the per-run model directly, so building a separate runtime would be
    // redundant. Omit the factory there and the harness uses the shared runtime.
    const runtimeForModel = hasConfiguredRuntimeFallbacks(coreConfig.runtime)
      ? this.buildRuntimeForModel(coreConfig)
      : undefined;
    const observabilityContext = await this.observabilityContext();
    const responder = await createConfiguredAgentResponder({
      config: coreConfig,
      cwd: this.cwd,
      runtime,
      ...(runtimeForModel === undefined ? {} : { runtimeForModel }),
      ...(this.sandboxEngine === undefined ? {} : { sandboxEngine: this.sandboxEngine }),
      ...(memory !== undefined && { memory }),
      ...(this.interactionBridge === undefined ? {} : { turnHistoryEnricher: this.interactionBridge }),
      ...(runtimeOptionsForRequest === undefined ? {} : { runtimeOptionsForRequest }),
      onMemoryRecallUnavailable: (error) => {
        this.logger?.warn?.(
          "MemoryRecall tool endpoint could not start; continuing without the explicit tool.",
          { error: reasonOf(error) },
        );
      },
      onMemoryWarning: (message) => {
        this.logger?.warn?.(message);
      },
      // Thread run-identifying context onto exported spans and surface per-run
      // export warnings to `exporterStatus` (agent-host only builds the exporter
      // when config.observability.exporters is non-empty).
      observabilityContext,
      exporterWarn: (warning) => this.recordExporterWarning(warning),
      onSessionEvent: (event) => this.recordSessionEvent(event, coreConfig),
      // Publish every run's start/event/finish to the shared bus so the `live`
      // channel can relay it. Best-effort + additive (see broadcast recorder).
      runEventSink: this.liveEventBus,
    });
    return responder;
  }

  /**
   * Per-request extension that applies a cron/webhook/tui per-trigger model +
   * effort override (validated, warn-and-ignore on bad input). Threads the
   * configured local providers so a LOCAL-model override recomputes its endpoint
   * block for the OVERRIDE model (see request-model-override doc). Composed
   * alongside the memory/adapter extensions.
   */
  private requestModelOverrideRuntimeOptions(
    coreConfig: MonoAgentConfig,
    compatibility: { readonly mcpSources: readonly string[]; readonly indexSkillsActive: boolean },
  ): {
    readonly extension: RuntimeOptionsExtension;
    readonly targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean;
  } {
    const options = {
      ...(this.logger === undefined ? {} : { logger: this.logger }),
      baseModel: coreConfig.runtime.model,
      ...(configuredRuntimeFallbackModels(coreConfig.runtime).length === 0
        ? {}
        : { fallbackModels: configuredRuntimeFallbackModels(coreConfig.runtime) }),
      ...(coreConfig.runtime.effort === undefined ? {} : { baseEffort: coreConfig.runtime.effort }),
      ...(coreConfig.runtime.maxTurns === undefined ? {} : { baseMaxTurns: coreConfig.runtime.maxTurns }),
      ...(compatibility.mcpSources.length === 0 ? {} : { mcpSources: compatibility.mcpSources }),
      ...(compatibility.indexSkillsActive ? { indexSkillsActive: true } : {}),
      ...(coreConfig.sandbox === undefined ? {} : { sandboxPolicy: coreConfig.sandbox }),
      toolPolicy: coreConfig.tools,
      ...(coreConfig.providers?.local === undefined ? {} : { localProviders: coreConfig.providers.local }),
    };
    const extension = createRequestModelOverrideRuntimeExtension(options);
    return {
      extension: async (input) => extension({ request: input.request }),
      targetsDirectOpenCode: (metadata) => requestModelOverrideTargetsDirectOpenCode(metadata, options),
    };
  }

  /**
   * Memoized factory for runtimes bound to a per-request override model. Reuses
   * createConfiguredAgentRuntime so the override becomes the fallback-chain
   * primary with the configured backups after it (override + keep fallbacks).
   * Built runtimes register in `activeRuntimes`, which is disposed on `stop()`
   * (config reload rebuilds the responder but does not drain prior runtimes —
   * same lifetime as the base runtime built in `buildResponder`).
   */
  private buildRuntimeForModel(
    coreConfig: MonoAgentConfig,
  ): (model: RuntimeModelReference, executionMode?: string) => MonoRuntimeLike {
    const cache = new Map<string, MonoRuntimeLike>();
    return (model, executionMode) => {
      const key = `${modelReferenceKey(model)}|${executionMode ?? ""}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const runtime = createConfiguredAgentRuntime({
        config: coreConfig,
        model,
        ...(executionMode === undefined ? {} : { executionMode }),
        ...(this.sandboxEngine === undefined ? {} : { sandboxEngine: this.sandboxEngine }),
      });
      cache.set(key, runtime);
      this.activeRuntimes.push(runtime);
      return runtime;
    };
  }

  /**
   * Run-identifying context threaded onto exported spans (Phoenix shows the same
   * source/run identifiers as the local trace-source registry, so local artifact
   * lookup stays possible). Resolved with the same source-id/label resolvers the
   * trace source uses.
   */
  private async observabilityContext(): Promise<{
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  }> {
    const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };
    const [sourceId, sourceLabel] = await Promise.all([
      resolveAppTraceSourceId(input, this.traceDefaults),
      resolveAppTraceSourceLabel(input, this.traceDefaults),
    ]);
    return { sourceId, sourceLabel, configPath: this.configPath };
  }

  private reportMemoryRecallStatus(
    coreConfig: MonoAgentConfig,
    service: MemoryRetrievalService | undefined,
  ): boolean {
    const settings = resolveMemoryRecallSettings(coreConfig);
    if (settings === undefined) {
      return false;
    }
    if (service === undefined) {
      this.logger?.warn?.("MemoryRecall could not be enabled because the configured store has no recall surface.");
      return false;
    }
    this.logger?.info?.("Read-only MemoryRecall tool enabled.", {
      provider: "supermemory" in settings ? "supermemory" : settings.embeddings?.provider ?? "fts-only",
    });
    return true;
  }

  /**
   * Optional CLOUD-ONLY escape hatch: when `memory.supermemory.exposeMcpServer` is on, ALSO inject
   * Supermemory's hosted MCP server alongside the in-app `MemoryRecall` tool. The hosted MCP cannot
   * point at a self-hosted instance, so self-hosters rely on the in-app recall tool; this just adds
   * the cloud server's richer tools for cloud deployments. Requires an apiKey (skipped + warned if
   * absent).
   */
  private supermemoryMcpRuntimeOptions(coreConfig: MonoAgentConfig): RuntimeOptionsExtension | undefined {
    const memory = coreConfig.memory;
    if (memory?.backend !== "supermemory" || memory.supermemory?.exposeMcpServer !== true) {
      return undefined;
    }
    const apiKey = memory.supermemory.apiKey;
    if (apiKey === undefined) {
      this.logger?.warn?.(
        "memory.supermemory.exposeMcpServer is on but no apiKey is set; the hosted Supermemory MCP server (cloud-only) was not injected.",
      );
      return undefined;
    }
    this.logger?.info?.("Supermemory hosted MCP server injected (cloud-only).");
    const entry = {
      supermemory: {
        type: "http",
        url: "https://mcp.supermemory.ai/mcp",
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    };
    return async () => ({ runtimeOptions: { mcpServers: entry }, cleanup: async () => {} });
  }

  private async adapterSendToolsRuntimeOptions(coreConfig: MonoAgentConfig): Promise<{
    readonly createExtension?: (
      targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean,
    ) => RuntimeOptionsExtension;
    readonly blockingToolNames: readonly string[];
  }> {
    const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };
    const settings = await resolveAdapterSendToolsSettings(input, {
      allowedTools: coreConfig.tools.allowedTools,
      disallowedTools: coreConfig.tools.disallowedTools,
      logger: this.logger,
      suppressInteractionTools: runtimeRouteContainsDirectOpenCode(coreConfig),
    });
    if (settings === undefined) {
      return { blockingToolNames: [] };
    }
    const toolNames = adapterSendToolNames(settings);
    const blockingToolNames = toolNames.filter((name) => !isInteractionToolName(name));
    this.logger?.info?.("Adapter send tools enabled.", { tools: toolNames });
    // Forward the posted-message index path so `SlackSendMessage` links each post
    // back to the producing conversation (so a later in-thread reply resumes it).
    const indexPath = resolvePostedMessageIndexPath(await resolveAppArtifactDir(input));
    const interaction = settings.askUser ?? settings.telegram?.askBridge;
    const createExtension = (
      targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean,
    ): RuntimeOptionsExtension => async (requestInput) => {
      const effectiveToolNames = targetsDirectOpenCode(requestInput.request.metadata)
        ? toolNames.filter((name) => !isInteractionToolName(name))
        : toolNames;
      if (effectiveToolNames.length === 0) {
        return { runtimeOptions: {}, cleanup: async () => {} };
      }
      const effectiveInteraction = effectiveToolNames.some(isInteractionToolName)
        ? interaction
        : undefined;
      return await createAdapterSendToolsRuntimeExtension(
        this.configPath,
        this.cwd,
        effectiveToolNames,
        indexPath,
        effectiveInteraction,
      )(requestInput);
    };
    return { createExtension, blockingToolNames };
  }

  /** Build the configured memory store once and share it across responders + the ritual scheduler. */
  private async memoryStore(
    coreConfig: MonoAgentConfig,
  ): Promise<Awaited<ReturnType<typeof createConfiguredMemory>>> {
    if (this.sharedMemoryBuilt) {
      return this.sharedMemory;
    }
    if (this.sharedMemoryBuild !== undefined) {
      return await this.sharedMemoryBuild;
    }
    this.sharedMemoryBuild = (async () => {
      const appLogger = this.logger;
      const logger = appLogger?.warn !== undefined
        ? { warn: (message: string) => { appLogger.warn?.(message); } }
        : undefined;
      // Thread the per-app observability context so the bujo memory LLM records
      // capture and consolidation runs through the same JSONL + Phoenix pipeline
      // as channel runs (gated by `memory.llm.trace`, default on). The context is
      // per-app (not per-request), so caching it into the shared store is correct.
      //
      // The channel runtime is intentionally NOT passed: the memory LLM must run
      // on `config.memory.llm.model`, but the channel runtime carries the channel
      // fallback chain whose primary is `config.runtime.model` and the fallback
      // router overrides each run's per-call model. createConfiguredMemory builds
      // the memory LLM its own fallback-free runtime when no `memoryRuntime` is set.
      const observabilityContext = await this.observabilityContext();
      const observability = {
        observabilityContext,
        exporterWarn: (warning: { readonly phase: string; readonly message: string }) => this.recordExporterWarning(warning),
        runEventSink: this.liveEventBus,
      };
      this.sharedMemory = await createConfiguredMemory(coreConfig, {
        cwd: this.cwd,
        ...(logger === undefined ? {} : { logger }),
        observability,
      });
      this.ensureSharedMemoryRetrieval(coreConfig, this.sharedMemory);
      this.sharedMemoryBuilt = true;
      return this.sharedMemory;
    })();
    try {
      return await this.sharedMemoryBuild;
    } finally {
      this.sharedMemoryBuild = undefined;
    }
  }

  /** Close + clear the shared memory store (on config reload or stop) so the next build is fresh. */
  private async resetSharedMemory(): Promise<void> {
    const mem = this.sharedMemory as
      | { flush?: () => Promise<void>; close?: () => Promise<void> | void }
      | undefined;
    this.sharedMemory = undefined;
    this.sharedMemoryRetrieval?.releaseAllTurns();
    this.sharedMemoryRetrieval = undefined;
    this.sharedMemoryBuilt = false;
    this.sharedMemoryBuild = undefined;
    if (mem?.close !== undefined) {
      await Promise.resolve(mem.close()).catch(() => undefined);
    } else if (mem?.flush !== undefined) {
      // Stores without a lifecycle-aware close retain the legacy best-effort
      // drain. BuJo close owns its bounded shutdown deadline itself.
      await Promise.resolve(mem.flush()).catch(() => undefined);
    }
  }

  /** @internal Test-only seam: seed the shared memory store without going through config. */
  __setSharedMemoryForTest(store: Awaited<ReturnType<typeof createConfiguredMemory>>): void {
    this.sharedMemory = store;
    this.sharedMemoryRetrieval = undefined;
    this.sharedMemoryBuilt = true;
  }

  private ensureSharedMemoryRetrieval(
    coreConfig: MonoAgentConfig,
    store: Awaited<ReturnType<typeof createConfiguredMemory>>,
  ): MemoryRetrievalService | undefined {
    if (this.sharedMemoryRetrieval !== undefined) return this.sharedMemoryRetrieval;
    if (coreConfig.memory === undefined || !isSharedRecallStore(store)) return undefined;
    this.sharedMemoryRetrieval = new MemoryRetrievalService(store, {
      maxBytes: coreConfig.memory.maxBytes,
      source: (coreConfig.memory.backend ?? "bujo") === "supermemory" ? "supermemory" : "memory-bujo",
    });
    return this.sharedMemoryRetrieval;
  }

  private setStatus(id: ChannelId, status: ChannelStatus): ChannelStatus {
    this.statuses.set(id, status);
    return status;
  }

  private applyResult(): ConfigApplyResult {
    const transports = this.activeTransports();
    const statusEntries = [...this.statuses.entries()];
    const statuses = statusEntries.map(([, status]) => status);
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

    // A degraded channel is still serving (transport self-recovering, harness alive),
    // so it counts as running for the "is anything live?" check.
    const hasServingChannel = statusEntries.some(
      ([id, status]) => id !== "live" && (status.kind === "running" || status.kind === "degraded"),
    );
    if (!hasServingChannel && statuses.some((status) => status.kind === "waiting_for_config")) {
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
    const globalTraceSource = this.globalTraceSource;
    if (traceSource === undefined && globalTraceSource === undefined) {
      return;
    }
    this.traceSource = undefined;
    this.globalTraceSource = undefined;
    const patch = { metadata: this.traceMetadata(reason), transports: this.activeTransports() };
    await traceSource?.stop(patch).catch((error: unknown) => {
      this.logger?.warn?.("Traceability source stop update failed.", { reason: reasonOf(error) });
    });
    await globalTraceSource?.stop(patch).catch((error: unknown) => {
      this.logger?.warn?.("Global trace-source mirror stop update failed.", { reason: reasonOf(error) });
    });
    if (!this.stopped) {
      this.traceabilityStatusValue = { kind: "disabled", reason: "Traceability source stopped while applying config." };
    }
  }

  private activeTransports(): readonly string[] {
    const transports: string[] = [];
    for (const driver of this.drivers) {
      const kind = this.statuses.get(driver.id)?.kind;
      // A degraded channel is still an active transport (self-recovering, serving).
      if (kind === "running" || kind === "degraded") {
        transports.push(driver.id);
      }
    }
    return transports;
  }

  private async refreshSelectedSkillsSnapshot(reason: string): Promise<void> {
    try {
      const input: MonoAgentAppConfigInput = { env: this.env, cwd: this.cwd, configPath: this.configPath };
      this.rememberSelectedSkills(await loadAppCoreConfig(input));
    } catch (error) {
      this.selectedSkillsValue = undefined;
      this.logger?.info?.("Selected skills unavailable until agent config loads.", { reason, detail: reasonOf(error) });
    }
  }

  private rememberSelectedSkills(coreConfig: MonoAgentConfig): void {
    this.selectedSkillsValue = [...coreConfig.context.selectedSkills];
  }

  private recordSessionEvent(event: ConfiguredAgentSessionEvent, coreConfig: MonoAgentConfig): void {
    const now = new Date();
    const nextRolloverAt = coreConfig.runtime.session.rollover === "daily"
      ? nextDailyRolloverAt(now, coreConfig.runtime.session.rolloverTimezone)
      : undefined;
    const snapshot = event.snapshot ?? [];
    const current = snapshot.find((entry) => entry.conversationId === event.conversationId);
    const providerSessionId = current?.providerSessionId ?? event.providerSessionId;
    this.sessionMetadataValue = {
      currentBucketId: event.conversationId,
      state: current === undefined ? "cold" : "warm",
      event: event.kind,
      updatedAt: now.toISOString(),
      ...(snapshot.length === 0 ? {} : { snapshot }),
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(current?.createdAt === undefined ? {} : { createdAt: current.createdAt }),
      ...(current?.lastActivityAt === undefined ? {} : { lastActivityAt: current.lastActivityAt }),
      ...(current?.busy === undefined ? {} : { busy: current.busy }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(nextRolloverAt === undefined ? {} : { nextRolloverAt }),
    };
    if (event.kind === "evicted") {
      this.logger?.info?.("Provider session evicted.", {
        conversationId: event.conversationId,
        providerSessionId: event.providerSessionId,
        reason: event.reason,
      });
    }
    void this.refreshTraceSource(`session-${event.kind}`).catch(() => undefined);
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
      ...(this.exporterStatusValue.kind === "configured"
        ? {
            observability: {
              // Persist only the endpoint + warning/error strings (never headers
              // or secrets) so the detached `status` reader can surface exporter
              // state. JSONL artifacts always remain local.
              endpoint: this.exporterStatusValue.endpoint,
              includeSensitiveData: this.exporterStatusValue.includeSensitiveData,
              jsonlArtifactsLocal: true,
              ...(this.exporterStatusValue.lastWarning === undefined
                ? {}
                : { lastWarning: this.exporterStatusValue.lastWarning }),
              ...(this.exporterStatusValue.lastError === undefined
                ? {}
                : { lastError: this.exporterStatusValue.lastError }),
            },
          }
        : {}),
      sandbox: {
        configured: this.sandboxStatusValue.configured,
        configuredMode: this.sandboxStatusValue.configuredMode,
        effective: this.sandboxStatusValue.effective,
        engine: this.sandboxStatusValue.engine,
        engineAvailable: this.sandboxStatusValue.engineAvailable,
        fallback: this.sandboxStatusValue.fallback,
        fallbackActive: this.sandboxStatusValue.fallbackActive,
        unsafeAllowHostProcess: this.sandboxStatusValue.unsafeAllowHostProcess,
        detail: this.sandboxStatusValue.detail,
        ...(this.sandboxStatusValue.warning === undefined ? {} : { warning: this.sandboxStatusValue.warning }),
        ...(this.sandboxStatusValue.resolutionError === undefined
          ? {}
          : { resolutionError: this.sandboxStatusValue.resolutionError }),
      },
      ...(this.selectedSkillsValue === undefined
        ? {}
        : {
            context: {
              selectedSkills: [...this.selectedSkillsValue],
            },
          }),
      ...(this.sessionMetadataValue === undefined ? {} : { session: this.sessionMetadataValue }),
      channels,
    };
  }
}

function nextDailyRolloverAt(now: Date, timezone: string | undefined): string | undefined {
  if (timezone === undefined || timezone.trim().length === 0) {
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return next.toISOString();
  }
  try {
    const parts = datePartsInTimeZone(now, timezone);
    return new Date(zonedDateTimeToUtcMs(
      {
        year: parts.year,
        month: parts.month,
        day: parts.day + 1,
        hour: 0,
        minute: 0,
        second: 0,
      },
      timezone,
    )).toISOString();
  } catch {
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return next.toISOString();
  }
}

interface DateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function zonedDateTimeToUtcMs(parts: DateTimeParts, timezone: string): number {
  const targetAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let utcMs = targetAsUtc - timeZoneOffsetMs(new Date(targetAsUtc), timezone);
  utcMs = targetAsUtc - timeZoneOffsetMs(new Date(utcMs), timezone);
  return utcMs;
}

function timeZoneOffsetMs(date: Date, timezone: string): number {
  const parts = datePartsInTimeZone(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function datePartsInTimeZone(date: Date, timezone: string): DateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const entries = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(entries.get("year")),
    month: Number(entries.get("month")),
    day: Number(entries.get("day")),
    hour: Number(entries.get("hour")),
    minute: Number(entries.get("minute")),
    second: Number(entries.get("second")),
  };
}

function sandboxStatusFromState(state: SandboxEffectiveState): SandboxStatus {
  const warning = sandboxEffectiveStateWarning(state);
  return {
    ...state,
    detail: describeSandboxEffectiveState(state),
    ...(warning === undefined ? {} : { warning }),
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeRouteContainsDirectOpenCode(config: MonoAgentConfig): boolean {
  return configuredRuntimeModels(config.runtime)
    .some((model) => model.sdk === "opencode");
}

function isInteractionToolName(name: string): boolean {
  return name === "AskUser" || name === "TelegramAskButtons";
}
