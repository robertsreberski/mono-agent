import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";
import type { ChannelDriver, ChannelId, ChannelStatus, RunningChannel } from "./channels.js";
import type { ConfigApplyResult, SandboxStatus, TraceabilityStatus, ExporterStatus } from "./app-controller-types.js";

export interface LifecycleControllerPort {
  readonly drivers: readonly ChannelDriver[];
  readonly driversById: ReadonlyMap<ChannelId, ChannelDriver>;
  readonly running: Map<ChannelId, RunningChannel>;
  readonly startsInFlight: Map<ChannelId, Promise<ChannelStatus>>;
  readonly activeRuntimes: MonoRuntimeLike[];
  configApplyTail: Promise<void>;
  stopped: boolean;
  invalidateMemoryHealthRefresh(): void;
  stopChannel(id: ChannelId, reason: string): Promise<void>;
  stopContinuationService(): Promise<void>;
  stopProcessJobsService(): Promise<void>;
  stopMonitorsService(): Promise<void>;
  stopInteractionBridge(): Promise<void>;
  stopMemoryRituals(): void;
  stopArtifactRetentionScheduler(): void;
  resetSharedMemory(): Promise<void>;
  stopTraceSource(reason: string): Promise<void>;
  refreshSandboxStatus(reason: string): Promise<SandboxStatus>;
  startTraceability(reason: string): Promise<TraceabilityStatus>;
  startExporters(reason: string): Promise<ExporterStatus>;
  startContinuationServiceIfConfigured(reason: string): Promise<void>;
  prepareProcessJobsProtection(reason: string): Promise<void>;
  startProcessJobsIfConfigured(reason: string): Promise<void>;
  activateProcessJobWakes(): Promise<void>;
  prepareMonitors(): Promise<void>;
  startMonitorsIfConfigured(): Promise<void>;
  activateMonitorWakes(): Promise<void>;
  startChannelIfConfigured(id: ChannelId, reason: string): Promise<ChannelStatus>;
  startMemoryRitualsIfConfigured(reason: string): Promise<void>;
  refreshMemoryHealthAfterLifecycle(reason: string, beforePublish?: () => void): Promise<void>;
  applyResult(): ConfigApplyResult;
  channelStatus(id: ChannelId): ChannelStatus;
  refreshTraceSource(reason: string): Promise<void>;
  startChannel(driver: ChannelDriver, reason: string): Promise<ChannelStatus>;
  releaseAgentRootOwnership(): Promise<void>;
}

export async function applyConfigChange(controller: LifecycleControllerPort, reason: string): Promise<ConfigApplyResult> {
  const run = async (): Promise<ConfigApplyResult> => {
    if (controller.stopped) {
      return {
        kind: "failed",
        message: "Mono agent app has already stopped.",
        transports: [],
      };
    }
    // Freeze periodic memory work before any channel/store teardown. A probe
    // that already entered is generation-fenced and is deliberately not
    // awaited, so config reload cannot hang behind native/filesystem work.
    controller.invalidateMemoryHealthRefresh();
    // Publish the durable A+B protection generation before stopping admission.
    // Store/secret creation remains behind the post-drain mutation gate below.
    await controller.prepareProcessJobsProtection(`${reason}:prepare`);
    // Monitors own live watcher process groups, so they are torn down before
    // the process-job store that owns their shared protected state root.
    await controller.stopMonitorsService();
    await controller.stopProcessJobsService();
    await controller.prepareMonitors();
    await Promise.all(controller.drivers.map(
      (driver) => controller.stopChannel(driver.id, `${reason}:reload`),
    ));
    await controller.stopContinuationService();
    // Tool policy/runtime-family changes must re-evaluate implicit AskUser.
    // Clearing the cached promise also prevents stale bridge env from a Pi
    // config leaking into a reloaded direct-OpenCode responder.
    await controller.stopInteractionBridge();
    controller.stopMemoryRituals();
    controller.stopArtifactRetentionScheduler();
    await controller.resetSharedMemory();
    await controller.stopTraceSource(`${reason}:reload`);
    await controller.refreshSandboxStatus(reason);
    await controller.startTraceability(reason);
    await controller.startExporters(reason);
    await controller.startContinuationServiceIfConfigured(reason);
    await controller.startProcessJobsIfConfigured(reason);
    await controller.startMonitorsIfConfigured();
    await Promise.all(controller.drivers.map((driver) => controller.startChannelIfConfigured(driver.id, reason)));
    await controller.activateProcessJobWakes();
    await controller.activateMonitorWakes();
    await controller.startMemoryRitualsIfConfigured(reason);
    await controller.refreshMemoryHealthAfterLifecycle(`${reason}:complete`);
    return controller.applyResult();
  };

  const next = controller.configApplyTail.then(run, run);
  controller.configApplyTail = next.then(
    () => undefined,
    () => undefined,
  );
  return await next;
}

export async function startChannelIfConfigured(controller: LifecycleControllerPort, id: ChannelId, reason: string): Promise<ChannelStatus> {
  const driver = controller.driversById.get(id);
  if (driver === undefined || controller.stopped) {
    return controller.channelStatus(id);
  }
  if (controller.running.has(id)) {
    await controller.refreshTraceSource(reason);
    return controller.channelStatus(id);
  }
  const inFlight = controller.startsInFlight.get(id);
  if (inFlight !== undefined) {
    const status = await inFlight;
    await controller.refreshTraceSource(reason);
    return status;
  }

  const start = controller.startChannel(driver, reason);
  controller.startsInFlight.set(id, start);
  let status: ChannelStatus;
  try {
    status = await start;
  } finally {
    // Teardown joins only channel ownership/publication. A trace or memory
    // refresh may be unbounded and must not remain reachable through this map.
    // Identity-check so a superseded flight cannot clear a newer generation.
    if (controller.startsInFlight.get(id) === start) {
      controller.startsInFlight.delete(id);
    }
  }
  await controller.refreshTraceSource(reason);
  return status;
}

export async function stop(controller: LifecycleControllerPort): Promise<void> {
  if (controller.stopped) {
    return;
  }
  controller.stopped = true;
  // Stop the periodic audit before the first teardown await. Already-entered
  // computation is generation-fenced and must never delay shutdown.
  controller.invalidateMemoryHealthRefresh();
  await controller.stopMonitorsService();
  await controller.stopProcessJobsService();
  await Promise.all(controller.drivers.map((driver) => controller.stopChannel(driver.id, "stop")));
  await controller.stopContinuationService();
  await controller.stopInteractionBridge();
  controller.stopMemoryRituals();
  controller.stopArtifactRetentionScheduler();
  await controller.resetSharedMemory();
  await controller.stopTraceSource("stop");
  for (const runtime of controller.activeRuntimes.splice(0)) {
    await runtime.disposeAllSessions?.().catch(() => undefined);
  }
  await controller.releaseAgentRootOwnership();
}
