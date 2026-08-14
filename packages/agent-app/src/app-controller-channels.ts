import type { MonoAgentConfig } from "@mono-agent/config";
import type { AgentResponder, NotifyDeliveryContext } from "@mono-agent/agent-contracts";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
  resolveAppArtifactDir,
} from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import type {
  ChannelDriver,
  ChannelId,
  MonoAgentAppLogger,
  RunningChannel,
  ChannelStatus,
} from "./channels.js";
import { resolvePostedMessageIndexPath } from "./posted-message-index.js";
import { reasonOf } from "./app-controller-utils.js";
import type { ConfigApplyResult, TraceabilityStatus } from "./app-controller-types.js";
import { notifyDestination as notifyDestinationForChannel } from "./app-controller-maintenance.js";
import type { InteractionBridgeHandle } from "./interaction-bridge.js";
import type { ContinuationServiceHandle } from "./continuation-service.js";
import type { NotifyDeliveryResult } from "./proactive-notify.js";
import type { NotifyDestination } from "./notify-destinations.js";
import type { ProcessJobsServiceHandle } from "./process-jobs-service.js";

export interface ChannelsControllerPort {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configReadPath: string;
  readonly logger: MonoAgentAppLogger | undefined;
  readonly drivers: readonly ChannelDriver[];
  readonly driversById: ReadonlyMap<ChannelId, ChannelDriver>;
  readonly statuses: Map<ChannelId, ChannelStatus>;
  readonly running: Map<ChannelId, RunningChannel>;
  readonly channelStartGenerations: Map<ChannelId, symbol>;
  readonly stopped: boolean;
  readonly traceabilityStatusValue: TraceabilityStatus;
  readonly processJobsService: ProcessJobsServiceHandle | undefined;
  setStatus(id: ChannelId, status: ChannelStatus): ChannelStatus;
  rememberSelectedSkills(coreConfig: MonoAgentConfig): void;
  ensureInteractionBridge(coreConfig: MonoAgentConfig): Promise<InteractionBridgeHandle | undefined>;
  ensureContinuationService(coreConfig: MonoAgentConfig): Promise<ContinuationServiceHandle | undefined>;
  buildResponder(coreConfig: MonoAgentConfig, channelId?: ChannelId): Promise<AgentResponder>;
  notifyDestination(
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean; readonly deliveryKey?: string; readonly deliveryContext?: NotifyDeliveryContext },
  ): Promise<NotifyDeliveryResult>;
  listNotifyDestinations(): Promise<readonly NotifyDestination[]>;
  observabilityContext(): Promise<{
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  }>;
  refreshTraceSource(reason: string): Promise<void>;
  activeTransports(): readonly string[];
}

export async function startChannel(controller: ChannelsControllerPort, driver: ChannelDriver, reason: string): Promise<ChannelStatus> {
  const generation = Symbol(driver.id);
  controller.channelStartGenerations.set(driver.id, generation);
  const isCurrentGeneration = (): boolean => controller.channelStartGenerations.get(driver.id) === generation;
  const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };

  let config: unknown;
  try {
    config = await driver.loadConfig(input);
  } catch (error) {
    if (driver.isConfigError(error)) {
      return controller.setStatus(driver.id, { kind: "waiting_for_config", reason: reasonOf(error) });
    }
    throw error;
  }

  const disabledReason = driver.disabledReason?.(config);
  if (disabledReason !== undefined) {
    return controller.setStatus(driver.id, { kind: "disabled", reason: disabledReason });
  }

  const waitingReason = driver.waitingReason?.(config);
  if (waitingReason !== undefined) {
    return controller.setStatus(driver.id, { kind: "waiting_for_config", reason: waitingReason });
  }

  // Structural issues (e.g. an invalid per-trigger model override) fail
  // `validate` but only WARN here: the run-time override path ignores the
  // bad value and falls back, so starting is still the safe choice.
  for (const issue of driver.configIssues?.(config) ?? []) {
    controller.logger?.warn?.("Channel config issue (run `mono-agent validate`).", { channel: driver.id, issue });
  }

  let coreConfig: MonoAgentConfig;
  try {
    coreConfig = await loadAppCoreConfig(input);
    controller.rememberSelectedSkills(coreConfig);
  } catch (error) {
    if (isAppCoreConfigError(error)) {
      controller.logger?.info?.("Waiting for a valid agent config.", { reason: error.message });
      return controller.setStatus(driver.id, { kind: "waiting_for_config", reason: error.message });
    }
    throw error;
  }

  // Resolve the posted-message index path once so the Slack driver can link
  // posted messages to their producing conversation (in-thread reply continuity).
  const postedMessageIndexPath = resolvePostedMessageIndexPath(await resolveAppArtifactDir(input));

  // The bridge must exist BEFORE the responder is built (AskUser settings
  // resolution reads the exported bridge env) and before driver.start (sink
  // registration + pending-ask interception).
  const interactionBridge = await controller.ensureInteractionBridge(coreConfig);
  await controller.ensureContinuationService(coreConfig);

  try {
    // The channel identity decides the session boundary this responder applies:
    // the console owns its own (a thread), every other channel takes the
    // configured one.
    const responder = await controller.buildResponder(coreConfig, driver.id);
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
    const observability = driver.id === "tui"
      ? await controller.observabilityContext()
      : {};
    const runningChannel = await driver.start({
      config,
      coreConfig,
      responder,
      cwd: controller.cwd,
      ...(observability.sourceId === undefined ? {} : { sourceId: observability.sourceId }),
      notifyDestination: (conversationId, text, options) =>
        notifyDestinationForChannel(controller, conversationId, text, options, driver.id),
      listNotifyDestinations: () => controller.listNotifyDestinations(),
      postedMessageIndexPath,
      ...(interactionBridge === undefined ? {} : { interaction: interactionBridge }),
      ...(controller.processJobsService === undefined ? {} : { processJobs: controller.processJobsService }),
      ...(controller.logger === undefined ? {} : { logger: controller.logger }),
      onFailure: (failureReason) => {
        controller.running.delete(driver.id);
        controller.setStatus(driver.id, { kind: "failed", reason: failureReason });
        controller.logger?.error?.(`${driver.label} channel stopped with an error.`, { reason: failureReason });
        // The running-channel entry (which holds the stop/reload dispose handle)
        // was just deleted, so dispose the responder here too — otherwise a
        // transport death orphans the per-channel harness/live-session manager
        // (the stop/reload path early-returns on the now-missing entry).
        void disposeResponder()?.catch((error: unknown) => {
          controller.logger?.warn?.(`${driver.label} responder did not dispose cleanly after failure.`, {
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
        if (!isCurrentGeneration()) {
          return;
        }
        if (controller.statuses.get(driver.id)?.kind === "degraded") {
          return;
        }
        controller.setStatus(driver.id, { kind: "degraded", reason });
        controller.logger?.warn?.(`${driver.label} channel degraded; transport is recovering.`, { reason });
      },
      // The transport's self-recovery succeeded. Flip back to running, reusing the
      // preserved entry's summary. Guard on the entry: a recovery that races a
      // stop/reload must not resurrect a torn-down channel's status.
      onRecovered: () => {
        const entry = controller.running.get(driver.id);
        if (entry === undefined) {
          return;
        }
        if (controller.statuses.get(driver.id)?.kind !== "degraded") {
          return;
        }
        controller.setStatus(driver.id, { kind: "running", summary: entry.summary });
        controller.logger?.info?.(`${driver.label} channel recovered.`, {});
      },
      // Runtime controls publish a fresh immutable summary. The controller owns
      // both replacing the running entry and reapplying the status so every
      // observer reads one coherent transition; discovery is then refreshed
      // from that controller-owned snapshot.
      onSummaryChanged: (summary) => {
        if (!isCurrentGeneration()) {
          return;
        }
        const entry = controller.running.get(driver.id);
        if (entry === undefined) {
          return;
        }
        const replacement: RunningChannel = { ...entry, summary: { ...summary } };
        controller.running.set(driver.id, replacement);
        if (controller.statuses.get(driver.id)?.kind === "running") {
          controller.setStatus(driver.id, { kind: "running", summary: replacement.summary });
        }
        void controller.refreshTraceSource(`channel-${driver.id}-summary-changed`).catch((error: unknown) => {
          controller.logger?.warn?.(`${driver.label} summary changed, but discovery refresh failed.`, {
            error: reasonOf(error),
          });
        });
      },
    });
    const summary = driver.id === "tui" && controller.processJobsService !== undefined
      ? {
          ...runningChannel.summary,
          processJobs: { stateDir: controller.processJobsService.settings.stateDir },
        }
      : runningChannel.summary;
    controller.running.set(driver.id, {
      ...runningChannel,
      summary,
      stop: () => runningChannel.stop(),
      ...(hasDispose ? { dispose: () => disposeResponder() ?? Promise.resolve() } : {}),
    });
    // A driver may discover durable control-state corruption or a lease conflict
    // only during start. Preserve that fail-visible degraded status instead of
    // overwriting it with a generic running summary after start returns.
    const degraded = controller.statuses.get(driver.id);
    const status = degraded?.kind === "degraded"
      ? degraded
      : controller.setStatus(driver.id, { kind: "running", summary });
    controller.logger?.info?.(
      degraded?.kind === "degraded" ? `${driver.label} channel started in degraded mode.` : `${driver.label} channel is running.`,
      { reason, ...summary },
    );
    return status;
  } catch (error) {
    const failure = reasonOf(error);
    controller.logger?.error?.(`${driver.label} channel failed to start.`, { reason: failure });
    return controller.setStatus(driver.id, { kind: "failed", reason: failure });
  }
}

export async function stopChannel(controller: ChannelsControllerPort, id: ChannelId, reason: string): Promise<void> {
  controller.channelStartGenerations.delete(id);
  const driver = controller.driversById.get(id);
  const runningChannel = controller.running.get(id);
  if (driver === undefined || runningChannel === undefined) {
    return;
  }
  controller.running.delete(id);
  await runningChannel.stop().catch((error: unknown) => {
    controller.logger?.warn?.(`${driver.label} channel did not stop cleanly.`, { reason, error: reasonOf(error) });
  });
  // Stop the transport first (so no new turns arrive), then dispose the responder
  // so the harness/live-session manager and warm provider sessions are retired
  // rather than lingering against stale config across a reload.
  await runningChannel.dispose?.().catch((error: unknown) => {
    controller.logger?.warn?.(`${driver.label} responder did not dispose cleanly.`, { reason, error: reasonOf(error) });
  });
  if (!controller.stopped) {
    controller.setStatus(id, {
      kind: "waiting_for_config",
      reason: `${driver.label} stopped while applying config.`,
    });
  }
}

export function setStatus(controller: ChannelsControllerPort, id: ChannelId, status: ChannelStatus): ChannelStatus {
  controller.statuses.set(id, status);
  return status;
}

export function applyResult(controller: ChannelsControllerPort): ConfigApplyResult {
  const transports = controller.activeTransports();
  const statusEntries = [...controller.statuses.entries()];
  const statuses = statusEntries.map(([, status]) => status);
  const failedChannel = statuses.find((status) => status.kind === "failed");
  const failure = failedChannel?.kind === "failed"
    ? failedChannel.reason
    : controller.traceabilityStatusValue.kind === "failed"
      ? controller.traceabilityStatusValue.reason
      : undefined;
  if (failure !== undefined) {
    return {
      kind: "failed",
      message: `Saved config, but live apply failed: ${failure}`,
      transports,
    };
  }

  // A degraded channel is still serving (transport self-recovering, harness alive),
  // so it counts as running for the "is anything serving?" check.
  const hasServingChannel = statusEntries.some(
    ([, status]) => status.kind === "running" || status.kind === "degraded",
  );
  if (!hasServingChannel && statuses.some((status) => status.kind === "waiting_for_config")) {
    return {
      kind: "waiting_for_config",
      message: "Saved config, but no agent channel is running yet.",
      transports,
    };
  }

  if (transports.length === 0) {
    return {
      kind: "applied",
      message: "Saved config and reloaded with no active agent channels.",
      transports,
    };
  }

  return {
    kind: "applied",
    message: `Saved config and reloaded ${transports.join(", ")}.`,
    transports,
  };
}

export function activeTransports(controller: ChannelsControllerPort): readonly string[] {
  const transports: string[] = [];
  for (const driver of controller.drivers) {
    const kind = controller.statuses.get(driver.id)?.kind;
    // A degraded channel is still an active transport (self-recovering, serving).
    if (kind === "running" || kind === "degraded") {
      transports.push(driver.id);
    }
  }
  return transports;
}
