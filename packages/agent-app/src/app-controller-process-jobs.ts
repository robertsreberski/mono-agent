import { loadAppCoreConfig, isAppCoreConfigError } from "./app-config.js";
import { deliverWebNotification } from "@mono-agent/web";
import type { ChannelId, MonoAgentAppLogger, RunningChannel } from "./channels.js";
import { routeProactiveNotification } from "./proactive-notify.js";
import { loadProcessJobsSettings } from "./process-jobs-config.js";
import { runWithProcessJobWakeContext } from "./process-jobs-context.js";
import {
  openProcessJobsService,
  ProcessJobServiceError,
  type ProcessJobsServiceHandle,
} from "./process-jobs-service.js";
import { reasonOf } from "./app-controller-utils.js";

export interface ProcessJobsControllerPort {
  readonly cwd: string;
  readonly configReadPath: string;
  readonly env: Record<string, string | undefined>;
  readonly logger: MonoAgentAppLogger | undefined;
  readonly running: Map<ChannelId, RunningChannel>;
  readonly stopped: boolean;
  processJobsService: ProcessJobsServiceHandle | undefined;
  processJobsServiceStart: Promise<ProcessJobsServiceHandle | undefined> | undefined;
  observabilityContext(): Promise<{ readonly sourceId?: string }>;
}

export function ensureProcessJobsService(
  controller: ProcessJobsControllerPort,
): Promise<ProcessJobsServiceHandle | undefined> {
  controller.processJobsServiceStart ??= (async () => {
    const settings = await loadProcessJobsSettings({
      cwd: controller.cwd,
      configPath: controller.configReadPath,
    });
    if (!settings.enabled) return undefined;
    try {
      const sourceId = (await controller.observabilityContext()).sourceId;
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
        ),
        surfaceUpdate: async (projection) => {
          if (projection.origin.channel !== "web") return;
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
        },
        ...(controller.logger === undefined ? {} : { logger: controller.logger }),
      });
      controller.processJobsService = service;
      controller.logger?.info?.("Process-job controller started.", { stateDir: settings.stateDir });
      return service;
    } catch (error) {
      if (error instanceof ProcessJobServiceError && error.code === "process_job_platform_unsupported") {
        controller.logger?.warn?.("Process-job controller is unavailable on this platform.", { reason: error.message });
        return undefined;
      }
      controller.logger?.error?.("Process-job controller failed to start.", { reason: reasonOf(error) });
      throw error;
    }
  })();
  return controller.processJobsServiceStart;
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
  controller.processJobsService = undefined;
  controller.processJobsServiceStart = undefined;
  try {
    await service?.stop();
  } catch (error) {
    // The service itself attempts every cancellation, owned-process cleanup,
    // and lock release before rejecting. Keep app reload/shutdown moving so a
    // cleanup diagnostic cannot strand the channel and runtime teardown that
    // follows this boundary.
    controller.logger?.warn?.("Process-job controller did not stop cleanly.", { reason: reasonOf(error) });
  }
}
