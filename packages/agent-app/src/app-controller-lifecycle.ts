import type { ChannelId, ChannelStatus } from "./channels.js";
import type { ConfigApplyResult, MonoAgentAppController } from "./app-controller.js";

export async function applyConfigChange(controller: MonoAgentAppController, reason: string): Promise<ConfigApplyResult> {
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
    await Promise.all(controller.drivers.map((driver) => controller.startChannelIfConfigured(driver.id, reason)));
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

export async function startChannelIfConfigured(controller: MonoAgentAppController, id: ChannelId, reason: string): Promise<ChannelStatus> {
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
    return await inFlight;
  }

  const start = controller.startChannel(driver, reason).finally(() => {
    controller.startsInFlight.delete(id);
  });
  controller.startsInFlight.set(id, start);
  const status = await start;
  await controller.refreshTraceSource(reason);
  return status;
}

export async function stop(controller: MonoAgentAppController): Promise<void> {
  if (controller.stopped) {
    return;
  }
  controller.stopped = true;
  // Stop the periodic audit before the first teardown await. Already-entered
  // computation is generation-fenced and must never delay shutdown.
  controller.invalidateMemoryHealthRefresh();
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
}
