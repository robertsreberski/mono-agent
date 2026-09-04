import type {
  ChannelDriver,
  ChannelId,
  MonoAgentAppLogger,
  RunningChannel,
} from "./channels.js";
import { loadMonitorsSettings, type MonitorsSettings } from "./monitors-config.js";
import { runWithMonitorWakeContext } from "./monitors-context.js";
import { routeMonitorWake } from "./monitor-channel-routing.js";
import {
  MonitorServiceError,
  openMonitorsService,
  type MonitorsServiceHandle,
} from "./monitors-service.js";
import { reasonOf } from "./app-controller-utils.js";

export interface MonitorsControllerPort {
  readonly configReadPath: string;
  readonly logger: MonoAgentAppLogger | undefined;
  readonly drivers: readonly ChannelDriver[];
  readonly running: Map<ChannelId, RunningChannel>;
  readonly stopped: boolean;
  /** The prepared, protected process-job state root; monitors share it. */
  readonly processJobsStateDir: string | undefined;
  monitorsService: MonitorsServiceHandle | undefined;
  monitorsServiceStart: Promise<MonitorsServiceHandle | undefined> | undefined;
  monitorsServiceStartFlight?: symbol | undefined;
  monitorsSettings: MonitorsSettings | undefined;
  monitorsDegradation: { readonly reason: string } | undefined;
}

/** Load the monitor block once per controller generation. */
export async function prepareMonitors(controller: MonitorsControllerPort): Promise<void> {
  controller.monitorsDegradation = undefined;
  try {
    controller.monitorsSettings = await loadMonitorsSettings({ configPath: controller.configReadPath });
  } catch (error) {
    controller.monitorsSettings = undefined;
    controller.monitorsDegradation = { reason: reasonOf(error) };
    controller.logger?.error?.("Monitor configuration is invalid; monitors are unavailable.", {
      reason: reasonOf(error),
    });
  }
}

export function ensureMonitorsService(
  controller: MonitorsControllerPort,
): Promise<MonitorsServiceHandle | undefined> {
  if (controller.monitorsServiceStart !== undefined) return controller.monitorsServiceStart;

  const flight = Symbol("monitors-service-start");
  controller.monitorsServiceStartFlight = flight;
  const isCurrentFlight = (): boolean =>
    !controller.stopped && controller.monitorsServiceStartFlight === flight;
  const start = (async () => {
    const settings = controller.monitorsSettings;
    if (!isCurrentFlight() || settings === undefined || !settings.enabled) return undefined;
    const stateDir = controller.processJobsStateDir;
    if (stateDir === undefined) {
      // Monitors are a streaming class of the process-job substrate and reuse
      // its protected private-state root. Without that root there is nowhere
      // safe to record a watch, so the capability stays off rather than
      // silently writing durable state into the model's own workspace.
      controller.monitorsDegradation = {
        reason: "Monitors require processJobs.enabled; its protected state root is unavailable.",
      };
      controller.logger?.warn?.("Monitors are disabled: process-job private state is unavailable.");
      return undefined;
    }
    try {
      const service = await openMonitorsService({
        stateDir,
        settings,
        wake: async (input) => await runWithMonitorWakeContext(
          { monitorId: input.projection.monitorId, chainDepth: input.chainDepth },
          async () => await routeMonitorWake({
            projection: input.projection,
            conversationId: input.conversationId,
            deliveryKey: input.deliveryKey,
            text: input.prompt,
            drivers: controller.drivers,
            running: controller.running,
            ...(controller.logger === undefined ? {} : { logger: controller.logger }),
          }),
          input.deliveryKey,
        ),
        ...(controller.logger === undefined ? {} : { logger: controller.logger }),
      });
      if (!isCurrentFlight()) {
        await stopLateMonitorsService(controller, service);
        return undefined;
      }
      controller.monitorsService = service;
      controller.monitorsDegradation = undefined;
      controller.logger?.info?.("Monitor controller started.", { stateDir });
      return service;
    } catch (error) {
      if (!isCurrentFlight()) return undefined;
      if (error instanceof MonitorServiceError && error.code === "monitor_platform_unsupported") {
        controller.monitorsDegradation = undefined;
        controller.logger?.warn?.("Monitors are unavailable on this platform.", { reason: error.message });
        return undefined;
      }
      const degradation = { reason: reasonOf(error) };
      controller.monitorsDegradation = degradation;
      controller.logger?.error?.("Monitor controller failed to start; the agent is continuing without monitors.", degradation);
      return undefined;
    }
  })();
  controller.monitorsServiceStart = start;
  return start;
}

export async function startMonitorsIfConfigured(controller: MonitorsControllerPort): Promise<void> {
  if (controller.stopped) return;
  if (controller.monitorsSettings === undefined && controller.monitorsDegradation === undefined) {
    await prepareMonitors(controller);
  }
  await ensureMonitorsService(controller);
}

export async function activateMonitorWakes(controller: MonitorsControllerPort): Promise<void> {
  await controller.monitorsService?.activateWakes();
}

export async function stopMonitorsService(controller: MonitorsControllerPort): Promise<void> {
  const service = controller.monitorsService;
  const start = controller.monitorsServiceStart;
  controller.monitorsService = undefined;
  controller.monitorsServiceStart = undefined;
  controller.monitorsServiceStartFlight = undefined;
  controller.monitorsDegradation = undefined;
  try {
    await service?.stop();
  } catch (error) {
    controller.logger?.warn?.("Monitor controller did not stop cleanly.", { reason: reasonOf(error) });
  }
  let started: MonitorsServiceHandle | undefined;
  try {
    started = await start;
  } catch (error) {
    controller.logger?.warn?.("Monitor controller start did not settle cleanly during teardown.", {
      reason: reasonOf(error),
    });
  }
  if (started !== undefined && started !== service) await stopLateMonitorsService(controller, started);
}

async function stopLateMonitorsService(
  controller: MonitorsControllerPort,
  service: MonitorsServiceHandle,
): Promise<void> {
  try {
    await service.stop();
  } catch (error) {
    controller.logger?.warn?.("Late monitor controller did not stop cleanly.", { reason: reasonOf(error) });
  }
}
