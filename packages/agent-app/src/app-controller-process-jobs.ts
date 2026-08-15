import { loadAppCoreConfig, isAppCoreConfigError } from "./app-config.js";
import { deliverWebNotification } from "@mono-agent/web";
import type {
  ChannelId,
  ChannelStatus,
  MonoAgentAppLogger,
  RunningChannel,
} from "./channels.js";
import { routeProactiveNotification } from "./proactive-notify.js";
import { loadProcessJobsSettings } from "./process-jobs-config.js";
import { runWithProcessJobWakeContext } from "./process-jobs-context.js";
import {
  openProcessJobsService,
  ProcessJobServiceError,
  type ProcessJobsHealth,
  type ProcessJobsServiceHandle,
} from "./process-jobs-service.js";
import { reasonOf } from "./app-controller-utils.js";

export interface ProcessJobsControllerPort {
  readonly cwd: string;
  readonly configReadPath: string;
  readonly env: Record<string, string | undefined>;
  readonly logger: MonoAgentAppLogger | undefined;
  readonly running: Map<ChannelId, RunningChannel>;
  readonly statuses: Map<ChannelId, ChannelStatus>;
  readonly stopped: boolean;
  processJobsService: ProcessJobsServiceHandle | undefined;
  processJobsServiceStart: Promise<ProcessJobsServiceHandle | undefined> | undefined;
  processJobsServiceStartFlight?: symbol | undefined;
  processJobsStateDir: string | undefined;
  processJobsDegradation: { readonly stateDir: string; readonly reason: string } | undefined;
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
    let settings: Awaited<ReturnType<typeof loadProcessJobsSettings>>;
    try {
      settings = await loadProcessJobsSettings({
        cwd: controller.cwd,
        configPath: controller.configReadPath,
        env: controller.env,
      });
    } catch (error) {
      if (!isCurrentFlight()) return undefined;
      throw error;
    }
    if (!isCurrentFlight()) return undefined;
    controller.processJobsStateDir = settings.enabled ? settings.stateDir : undefined;
    if (!settings.enabled) {
      controller.processJobsDegradation = undefined;
      return undefined;
    }
    try {
      const sourceId = (await controller.observabilityContext()).sourceId;
      if (!isCurrentFlight()) return undefined;
      const service = await openProcessJobsService({
        cwd: controller.cwd,
        settings,
        wake: async (input) => await runWithProcessJobWakeContext(
          { jobId: input.projection.jobId, chainDepth: input.chainDepth },
          async () => await routeProactiveNotification({
            conversationId: input.conversationId,
            text: input.prompt,
            deliveryKey: input.deliveryKey,
            processJob: input.projection,
            running: controller.running,
            ...(controller.logger === undefined ? {} : { logger: controller.logger }),
          }),
          input.deliveryKey,
        ),
        surfaceUpdate: async (projection) => {
          if (projection.origin.channel === "web") {
            if (sourceId === undefined) throw new Error("The agent source identity is unavailable for a web job card.");
            const threadId = webThreadId(projection.origin.conversationId);
            if (threadId === undefined) throw new Error("The process job does not identify an existing web thread.");
            await deliverWebNotification({
              sourceId,
              triggerKind: "job",
              deliveryKey: projection.wake.deliveryKey,
              threadId,
              processJob: projection,
            });
            return;
          }
          const outcome = await routeProactiveNotification({
            conversationId: projection.origin.conversationId.split("#", 1)[0]
              ?? projection.origin.conversationId,
            text: "",
            deliveryKey: projection.wake.deliveryKey,
            processJob: projection,
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

/** Publish a later store-health transition to both live operator surfaces. */
export async function publishProcessJobsHealth(
  controller: ProcessJobsControllerPort,
  stateDir: string,
  health: ProcessJobsHealth,
): Promise<void> {
  const tui = controller.running.get("tui");
  if (tui !== undefined) {
    const summary = {
      ...tui.summary,
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

function webThreadId(conversationId: string): string | undefined {
  const base = conversationId.split("#", 1)[0];
  if (base === undefined || !base.startsWith("web:") || base === "web:new") return undefined;
  const threadId = base.slice("web:".length).trim();
  return threadId.length === 0 ? undefined : threadId;
}

export async function startProcessJobsIfConfigured(
  controller: ProcessJobsControllerPort,
  reason: string,
): Promise<void> {
  if (controller.stopped) return;
  try {
    await loadAppCoreConfig({ env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath });
  } catch (error) {
    if (isAppCoreConfigError(error)) {
      controller.logger?.debug?.("Process-job controller is waiting for valid core configuration.", { reason });
      return;
    }
    throw error;
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
