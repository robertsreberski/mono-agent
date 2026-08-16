import { loadAppCoreConfig, isAppCoreConfigError } from "./app-config.js";
import type {
  ChannelDriver,
  ChannelId,
  ChannelStatus,
  MonoAgentAppLogger,
  RunningChannel,
} from "./channels.js";
import {
  routeProcessJobSurfaceUpdate,
  routeProcessJobWake,
} from "./process-job-channel-routing.js";
import { loadProcessJobsSettings } from "./process-jobs-config.js";
import type { ProcessJobsSettings } from "./process-jobs-config.js";
import { runWithProcessJobWakeContext } from "./process-jobs-context.js";
import {
  openProcessJobsService,
  ProcessJobServiceError,
  type ProcessJobsHealth,
  type ProcessJobsServiceHandle,
} from "./process-jobs-service.js";
import { reasonOf } from "./app-controller-utils.js";
import {
  assertAgentRootLeaseOutsideWorkspace,
  type AgentRootOwnership,
} from "./agent-root-coordinator.js";
import {
  attestProcessJobsRootRegistrySnapshot,
  failedProcessJobsRootRegistryProtection,
  loadProcessJobsRootRegistryProtection,
  registerProcessJobsRoot,
  type ProcessJobsRootRegistrationProof,
  type ProcessJobsRootRegistrySnapshot,
} from "./process-jobs-root-registry.js";
import { hasExactProcessJobStateMarkers } from "./process-jobs-store.js";
import {
  unsafeProcessJobsProtectionStatus,
  resolveProcessJobsProtectionPosture,
  type ProcessJobsProtectionPosture,
} from "./process-jobs-protection.js";

export interface ProcessJobsControllerPort {
  readonly cwd: string;
  readonly configReadPath: string;
  readonly env: Record<string, string | undefined>;
  readonly logger: MonoAgentAppLogger | undefined;
  readonly drivers: readonly ChannelDriver[];
  readonly running: Map<ChannelId, RunningChannel>;
  readonly statuses: Map<ChannelId, ChannelStatus>;
  readonly stopped: boolean;
  readonly agentRootOwnership: AgentRootOwnership;
  processJobsService: ProcessJobsServiceHandle | undefined;
  processJobsServiceStart: Promise<ProcessJobsServiceHandle | undefined> | undefined;
  processJobsServiceStartFlight?: symbol | undefined;
  processJobsStateDir: string | undefined;
  processJobsDegradation: { readonly stateDir: string; readonly reason: string } | undefined;
  processJobsRegistry: ProcessJobsRootRegistrySnapshot | undefined;
  processJobsProtectionPosture?: ProcessJobsProtectionPosture | undefined;
  preparedProcessJobs: {
    readonly settings: ProcessJobsSettings;
    readonly workspace: string;
    readonly protectionPosture: ProcessJobsProtectionPosture;
    readonly registration?: ProcessJobsRootRegistrationProof;
  } | undefined;
  observabilityContext(): Promise<{ readonly sourceId?: string }>;
  setStatus(id: ChannelId, status: ChannelStatus): ChannelStatus;
  refreshTraceSource(reason: string): Promise<void>;
}

export function ensureProcessJobsService(
  controller: ProcessJobsControllerPort,
): Promise<ProcessJobsServiceHandle | undefined> {
  if (controller.processJobsServiceStart !== undefined) {
    return controller.processJobsServiceStart;
  }

  const flight = Symbol("process-jobs-service-start");
  controller.processJobsServiceStartFlight = flight;
  const isCurrentFlight = (): boolean =>
    !controller.stopped && controller.processJobsServiceStartFlight === flight;
  const start = (async () => {
    const prepared = controller.preparedProcessJobs;
    if (!isCurrentFlight()) return undefined;
    if (prepared === undefined) {
      controller.processJobsDegradation = {
        stateDir: "",
        reason: "Process-job private-state protection is unavailable.",
      };
      return undefined;
    }
    const { settings, workspace, registration } = prepared;
    controller.processJobsStateDir = settings.enabled ? settings.stateDir : undefined;
    if (!settings.enabled) {
      controller.processJobsDegradation = undefined;
      return undefined;
    }
    if (registration === undefined || controller.processJobsRegistry?.kind !== "ready") {
      controller.processJobsDegradation = {
        stateDir: settings.stateDir,
        reason: "Process-job private-state protection is unavailable.",
      };
      return undefined;
    }
    let mutationGate;
    try {
      mutationGate = await controller.agentRootOwnership.coordinator.publishAndAcquireMutationGate(
        registration.snapshot.generation,
        registration.rootKey,
      );
      if (!isCurrentFlight()) return undefined;
      const service = await openProcessJobsService({
        cwd: controller.cwd,
        workspace,
        settings,
        registration,
        wake: async (input) => await runWithProcessJobWakeContext(
          { jobId: input.projection.jobId, chainDepth: input.chainDepth },
          async () => await routeProcessJobWake({
            conversationId: input.conversationId,
            text: input.prompt,
            deliveryKey: input.deliveryKey,
            projection: input.projection,
            drivers: controller.drivers,
            running: controller.running,
            ...(controller.logger === undefined ? {} : { logger: controller.logger }),
          }),
          input.deliveryKey,
        ),
        surfaceUpdate: async (projection) => {
          const outcome = await routeProcessJobSurfaceUpdate({
            conversationId: projection.origin.conversationId.split("#", 1)[0]
              ?? projection.origin.conversationId,
            deliveryKey: projection.wake.deliveryKey,
            projection,
            drivers: controller.drivers,
            running: controller.running,
            ...(controller.logger === undefined ? {} : { logger: controller.logger }),
          });
          if (!outcome.delivered) {
            throw new Error(outcome.reason ?? "The native process-job lifecycle update was not delivered.");
          }
        },
        onHealthChange: async (health) =>
          await publishProcessJobsHealth(controller, settings.stateDir, health),
        ...(controller.logger === undefined ? {} : { logger: controller.logger }),
      });
      if (!isCurrentFlight()) {
        await stopLateProcessJobsService(controller, service);
        return undefined;
      }
      controller.processJobsService = service;
      controller.processJobsDegradation = undefined;
      controller.logger?.info?.("Process-job controller started.", { stateDir: settings.stateDir });
      return service;
    } catch (error) {
      if (!isCurrentFlight()) return undefined;
      if (error instanceof ProcessJobServiceError && error.code === "process_job_platform_unsupported") {
        controller.processJobsDegradation = undefined;
        controller.logger?.warn?.("Process-job controller is unavailable on this platform.", { reason: error.message });
        return undefined;
      }
      const degradation = { stateDir: settings.stateDir, reason: reasonOf(error) };
      controller.processJobsDegradation = degradation;
      controller.logger?.error?.("Process-job controller failed to start; the agent is continuing without background jobs.", degradation);
      return undefined;
    } finally {
      mutationGate?.release();
    }
  })();
  controller.processJobsServiceStart = start;
  return start;
}

async function stopLateProcessJobsService(
  controller: ProcessJobsControllerPort,
  service: ProcessJobsServiceHandle,
): Promise<void> {
  try {
    await service.stop();
  } catch (error) {
    controller.logger?.warn?.("Late process-job controller did not stop cleanly.", {
      reason: reasonOf(error),
    });
  }
}

/**
 * Load/bootstrap/publish the next durable protection generation. On reload this
 * runs before channel teardown; store opening remains deferred until afterward.
 */
export async function prepareProcessJobsProtection(
  controller: ProcessJobsControllerPort,
  reason: string,
): Promise<void> {
  controller.preparedProcessJobs = undefined;
  let coreConfig;
  try {
    coreConfig = await loadAppCoreConfig({
      env: controller.env,
      cwd: controller.cwd,
      configPath: controller.configReadPath,
    });
  } catch (error) {
    if (isAppCoreConfigError(error)) {
      controller.logger?.debug?.("Process-job protection is waiting for valid core configuration.", { reason });
      return;
    }
    throw error;
  }
  assertAgentRootLeaseOutsideWorkspace(controller.agentRootOwnership, coreConfig.runtime.workspace);
  const settings = await loadProcessJobsSettings({
    cwd: controller.cwd,
    configPath: controller.configReadPath,
    env: controller.env,
  });
  let registry = await loadProcessJobsRootRegistryProtection(
    controller.agentRootOwnership.agentRoot,
    coreConfig.runtime.workspace,
  );
  let registration: ProcessJobsRootRegistrationProof | undefined;
  try {
    const bootstrapRoot = settings.enabled
      || await hasExactProcessJobStateMarkers(controller.cwd, settings.stateDir)
      ? settings.stateDir
      : undefined;
    if (bootstrapRoot !== undefined) {
      registration = await registerProcessJobsRoot({
        agentRoot: controller.agentRootOwnership.agentRoot,
        workspace: coreConfig.runtime.workspace,
        stateDir: bootstrapRoot,
        coordinator: controller.agentRootOwnership.coordinator,
      });
      registry = registration.snapshot;
    } else {
      const failedGeneration = failedProcessJobsRootRegistryProtection(
        controller.agentRootOwnership.agentRoot,
      ).generation;
      const currentGeneration = controller.agentRootOwnership.coordinator.currentGeneration();
      // A failed snapshot cannot admit request leases. Once the durable
      // registry is healthy again, let a disabled/no-marker reload recover the
      // process-global coordinator instead of trapping every model surface in
      // provider-zero state until process restart.
      if (currentGeneration?.id === failedGeneration.id) {
        controller.agentRootOwnership.coordinator.publishGeneration(registry.generation);
      } else {
        controller.agentRootOwnership.coordinator.synchronizeGeneration(registry.generation);
      }
    }
    registry = await attestProcessJobsRootRegistrySnapshot(
      registry,
      coreConfig.runtime.workspace,
    );
  } catch (error) {
    registry = failedProcessJobsRootRegistryProtection(controller.agentRootOwnership.agentRoot);
    controller.agentRootOwnership.coordinator.publishGeneration(registry.generation);
    controller.logger?.error?.("Process-job private-state registry could not be established.", {
      reason: reasonOf(error),
    });
  }
  const protectionPosture = resolveProcessJobsProtectionPosture({
    settings,
    registry,
    coreConfig,
  });
  controller.processJobsRegistry = registry;
  controller.processJobsProtectionPosture = protectionPosture;
  controller.processJobsStateDir = settings.enabled ? settings.stateDir : undefined;
  controller.preparedProcessJobs = {
    settings,
    workspace: coreConfig.runtime.workspace,
    protectionPosture,
    ...(settings.enabled && registry.kind === "ready" && registration !== undefined ? { registration } : {}),
  };
}

/** Publish a later store-health transition to both live operator surfaces. */
export async function publishProcessJobsHealth(
  controller: ProcessJobsControllerPort,
  stateDir: string,
  health: ProcessJobsHealth,
): Promise<void> {
  const tui = controller.running.get("tui");
  if (tui !== undefined) {
    const protectionStatus = unsafeProcessJobsProtectionStatus(controller.processJobsProtectionPosture);
    const summary = {
      ...tui.summary,
      ...(protectionStatus === undefined
        ? {}
        : { processJobsProtection: protectionStatus }),
      processJobs: {
        stateDir,
        health: health.state,
        quarantinedTransactions: health.quarantinedTransactions,
        ...(health.failureOperation === undefined
          ? {}
          : { failureOperation: health.failureOperation }),
        ...(health.failureDetectedAt === undefined
          ? {}
          : { failureDetectedAt: health.failureDetectedAt }),
      },
    };
    controller.running.set("tui", { ...tui, summary });
    if (controller.statuses.get("tui")?.kind === "running") {
      controller.setStatus("tui", { kind: "running", summary });
    }
  }
  await controller.refreshTraceSource("process-jobs-health");
}

export async function startProcessJobsIfConfigured(
  controller: ProcessJobsControllerPort,
  reason: string,
): Promise<void> {
  if (controller.stopped) return;
  if (controller.preparedProcessJobs === undefined) {
    await prepareProcessJobsProtection(controller, reason);
  }
  await ensureProcessJobsService(controller);
}

export async function activateProcessJobWakes(controller: ProcessJobsControllerPort): Promise<void> {
  await controller.processJobsService?.activateWakes();
}

export async function stopProcessJobsService(controller: ProcessJobsControllerPort): Promise<void> {
  const service = controller.processJobsService;
  const start = controller.processJobsServiceStart;
  controller.processJobsService = undefined;
  controller.processJobsServiceStart = undefined;
  controller.processJobsServiceStartFlight = undefined;
  controller.processJobsStateDir = undefined;
  controller.processJobsDegradation = undefined;
  try {
    await service?.stop();
  } catch (error) {
    // The service itself attempts every cancellation, owned-process cleanup,
    // and lock release before rejecting. Keep app reload/shutdown moving so a
    // cleanup diagnostic cannot strand the channel and runtime teardown that
    // follows this boundary.
    controller.logger?.warn?.("Process-job controller did not stop cleanly.", { reason: reasonOf(error) });
  }
  let started: ProcessJobsServiceHandle | undefined;
  try {
    started = await start;
  } catch (error) {
    controller.logger?.warn?.("Process-job controller start did not settle cleanly during teardown.", {
      reason: reasonOf(error),
    });
  }
  if (started !== undefined && started !== service) {
    await stopLateProcessJobsService(controller, started);
  }
}
