import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";

import type { ChannelId } from "./channels.js";
import { monitorWakeContextForRequest } from "./monitors-context.js";
import type { MonitorsServiceHandle } from "./monitors-service.js";
import {
  processJobOriginForRequest,
  PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR,
} from "./process-jobs-runtime.js";
import {
  processJobSteeringDepth,
  processJobWakeContextForRequest,
} from "./process-jobs-context.js";
import type { ProcessJobOriginRecord } from "./process-jobs-store.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";

/**
 * Channel schemes whose adapters can actually deliver a monitor wake today.
 *
 * The web console renders background jobs as durable cards through its own
 * notification ingress; monitors have no such card yet, so a web-origin monitor
 * would start happily and then have nowhere to report. Offering the tool where
 * its wakes cannot land is the worse failure, so the gate refuses it outright.
 */
export const MONITOR_WAKE_CAPABLE_SCHEMES: ReadonlySet<string> = new Set(["telegram", "slack"]);

export interface MonitorsRuntimeExtensionOptions {
  readonly next?: RuntimeOptionsExtension;
  /** Optional because monitors stay unavailable when their service cannot open. */
  readonly service: MonitorsServiceHandle | undefined;
  readonly coreConfig: MonoAgentConfig;
  readonly channelId: ChannelId | undefined;
  readonly conversationScheme?: string | undefined;
  readonly routesOnlyPiNative?: (metadata: Record<string, unknown> | undefined) => boolean;
}

/** Inject the monitor controller only for a Pi-native, wake-capable, allowed turn. */
export function createMonitorsRuntimeExtension(
  options: MonitorsRuntimeExtensionOptions,
): RuntimeOptionsExtension {
  return async (input) => {
    let result: Awaited<ReturnType<RuntimeOptionsExtension>> | undefined;
    try {
      if (options.service !== undefined
        && options.routesOnlyPiNative !== undefined
        && !options.routesOnlyPiNative(input.request.metadata)) {
        throw new Error(
          `${PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR} Not every route reachable for this request is Pi-native.`,
        );
      }
      result = options.next === undefined
        ? { runtimeOptions: {}, cleanup: async () => {} }
        : await options.next(input);
      let runtimeOptions = result.runtimeOptions ?? {};
      const service = options.service;
      if (service !== undefined) {
        const origin = monitorOriginForRequest(input, options.channelId, options.conversationScheme);
        // Chain depth comes from whichever host wake raised this turn. Monitor
        // wakes nest inside the process-job wake context, so both resolvers see
        // the same flight and the depth cannot be forged from either side.
        const monitorWake = monitorWakeContextForRequest(input.request);
        const hostWake = processJobWakeContextForRequest(input.request);
        const missed = monitorWake.kind === "missed" || hostWake.kind === "missed";
        const chainDepth = Math.max(
          monitorWake.kind === "resolved" ? monitorWake.context.chainDepth : 0,
          hostWake.kind === "resolved" ? hostWake.context.chainDepth : 0,
        );
        // The steering target is registered ONCE per run, by the process-jobs
        // extension. Registering a second one here would make the conversation's
        // active run ambiguous and silently break process-job steering, because
        // that registry admits a steer only when exactly one candidate matches.
        if (monitorsAdmissible(origin, missed, chainDepth, service, options.coreConfig)) {
          runtimeOptions = {
            ...runtimeOptions,
            monitors: service.controller(origin!, () => steeringDepth(origin!, chainDepth)),
          };
        }
      }
      return { ...result, runtimeOptions };
    } catch (error) {
      try {
        await result?.cleanup?.();
      } finally {
        await result?.settleCleanup?.();
      }
      throw error;
    }
  };
}

/** Strict host-origin classifier narrowed to schemes that can deliver a wake. */
export function monitorOriginForRequest(
  input: Pick<AgentHarnessRuntimeOptionsInput, "request" | "runId">,
  channelId: ChannelId | undefined,
  conversationScheme?: string,
): ProcessJobOriginRecord | undefined {
  const origin = processJobOriginForRequest(input, channelId, conversationScheme);
  return origin !== undefined && MONITOR_WAKE_CAPABLE_SCHEMES.has(origin.channel) ? origin : undefined;
}

function monitorsAdmissible(
  origin: ProcessJobOriginRecord | undefined,
  missedWake: boolean,
  chainDepth: number,
  service: MonitorsServiceHandle | undefined,
  coreConfig: MonoAgentConfig,
): boolean {
  return origin !== undefined
    && !missedWake
    && service !== undefined
    && chainDepth < service.settings.maxChainDepth
    && hasAllowedMonitorTools(coreConfig);
}

/**
 * Read the live depth from the shared steering registration when this run has
 * one, so a monitor started after a wake was steered into this very turn still
 * sees the raised depth rather than the depth the run began with.
 */
function steeringDepth(origin: ProcessJobOriginRecord, fallback: number): number {
  return Math.max(fallback, processJobSteeringDepth(origin.baseConversationId) ?? fallback);
}

export interface MonitorsAvailabilityOptions {
  readonly service: MonitorsServiceHandle | undefined;
  readonly coreConfig: MonoAgentConfig;
  readonly channelId: ChannelId | undefined;
  readonly conversationScheme?: string | undefined;
  readonly routesOnlyPiNative?: (metadata: Record<string, unknown> | undefined) => boolean;
}

/**
 * The same gate the extension applies, minus the checks that only exist once a
 * run is under way. Exported so prompt guidance and tool availability are
 * decided by one predicate; it errs strict, because telling the model it can
 * watch something it cannot is the worse failure.
 */
export function monitorsAvailableForRequest(
  input: Pick<AgentHarnessRuntimeOptionsInput, "request" | "runId">,
  options: MonitorsAvailabilityOptions,
): boolean {
  if (options.service === undefined) return false;
  if (options.routesOnlyPiNative?.(input.request.metadata) === false) return false;
  const origin = monitorOriginForRequest(input, options.channelId, options.conversationScheme);
  const monitorWake = monitorWakeContextForRequest(input.request);
  const hostWake = processJobWakeContextForRequest(input.request);
  const missed = monitorWake.kind === "missed" || hostWake.kind === "missed";
  const chainDepth = Math.max(
    monitorWake.kind === "resolved" ? monitorWake.context.chainDepth : 0,
    hostWake.kind === "resolved" ? hostWake.context.chainDepth : 0,
  );
  return monitorsAdmissible(origin, missed, chainDepth, options.service, options.coreConfig);
}

/**
 * Both names must be reachable. A Monitor the model cannot stop is a capacity
 * leak it has no way to repair, so denying MonitorStop denies Monitor too.
 */
function hasAllowedMonitorTools(config: MonoAgentConfig): boolean {
  const allowed = config.tools.allowedTools;
  const denied = new Set(config.tools.disallowedTools.map((name) => name.toLowerCase()));
  const allowAll = allowed.some((name) => name === "*");
  return ["Monitor", "MonitorStop"].every((name) =>
    !denied.has(name.toLowerCase())
    && (allowAll || allowed.some((allowedName) => allowedName.toLowerCase() === name.toLowerCase())));
}
