import type {
  NotifyDeliveryResult,
  ProcessJobProjection,
  ProcessJobWakeDeliveryResult,
} from "@mono-agent/agent-contracts";

import type { ChannelDriver, ChannelId, MonoAgentAppLogger, RunningChannel } from "./channels.js";

export interface ProcessJobChannelRoutingInput {
  readonly projection: ProcessJobProjection;
  readonly conversationId: string;
  readonly deliveryKey: string;
  readonly drivers: readonly ChannelDriver[];
  readonly running: ReadonlyMap<ChannelId, RunningChannel>;
  readonly logger?: MonoAgentAppLogger;
}

export function assertUniqueProcessJobChannelSchemes(
  drivers: readonly ChannelDriver[],
): void {
  const owners = new Map<string, string>();
  for (const driver of drivers) {
    const scheme = driver.processJobs?.conversationScheme;
    if (scheme === undefined) continue;
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(scheme)) {
      throw new TypeError(
        `Channel ${driver.id} declares invalid process-job conversation scheme ${JSON.stringify(scheme)}.`,
      );
    }
    const existing = owners.get(scheme);
    if (existing !== undefined) {
      throw new TypeError(
        `Channels ${existing} and ${driver.id} both claim process-job conversation scheme ${scheme}.`,
      );
    }
    owners.set(scheme, driver.id);
  }
}

export async function routeProcessJobSurfaceUpdate(
  input: ProcessJobChannelRoutingInput,
): Promise<NotifyDeliveryResult> {
  const resolved = resolveProcessJobChannel(input);
  if ("delivered" in resolved) return resolved;
  try {
    return await resolved.channel.processJobs!.update({
      conversationId: input.conversationId,
      deliveryKey: input.deliveryKey,
      processJob: input.projection,
    });
  } catch (error) {
    return routingFailure(input, resolved.driver.id, "surface update", error);
  }
}

export async function routeProcessJobWake(
  input: ProcessJobChannelRoutingInput & { readonly text: string },
): Promise<ProcessJobWakeDeliveryResult> {
  const resolved = resolveProcessJobChannel(input);
  if ("delivered" in resolved) return resolved;
  try {
    return await resolved.channel.processJobs!.wake({
      conversationId: input.conversationId,
      text: input.text,
      deliveryKey: input.deliveryKey,
      processJob: input.projection,
    });
  } catch (error) {
    return routingFailure(input, resolved.driver.id, "wake", error);
  }
}

function resolveProcessJobChannel(input: ProcessJobChannelRoutingInput):
  | { readonly driver: ChannelDriver; readonly channel: RunningChannel }
  | NotifyDeliveryResult {
  const origin = input.projection.origin;
  const expectedConversationId = baseConversationId(origin.conversationId);
  if (input.conversationId !== expectedConversationId
    || input.deliveryKey !== input.projection.wake.deliveryKey
    || !input.conversationId.startsWith(`${origin.channel}:`)) {
    return {
      delivered: false,
      code: "process_job_origin_mismatch",
      reason: "The process-job origin does not match its destination.",
      retryable: false,
    };
  }
  const candidates = input.drivers.filter(
    (driver) => driver.processJobs?.conversationScheme === origin.channel,
  );
  if (candidates.length !== 1) {
    return {
      delivered: false,
      code: "background_unsupported_channel",
      reason: candidates.length === 0
        ? `No channel owns process-job scheme ${origin.channel}.`
        : `Multiple channels claim process-job scheme ${origin.channel}.`,
      retryable: false,
    };
  }
  const driver = candidates[0]!;
  const channel = input.running.get(driver.id);
  if (channel === undefined) {
    return {
      delivered: false,
      code: "destination_channel_unavailable",
      reason: `${driver.id} channel is not running`,
      retryable: true,
    };
  }
  if (channel.processJobs === undefined) {
    return {
      delivered: false,
      code: "background_unsupported_channel",
      reason: `${driver.id} channel did not publish its declared process-job capability`,
      retryable: false,
    };
  }
  return { driver, channel };
}

function routingFailure(
  input: ProcessJobChannelRoutingInput,
  channelId: string,
  operation: string,
  error: unknown,
): NotifyDeliveryResult {
  const reason = error instanceof Error ? error.message : String(error);
  input.logger?.warn?.(`Process-job ${operation} failed.`, {
    channelId,
    conversationId: input.conversationId,
    reason,
  });
  return { delivered: false, code: "process_job_wake_failed", reason, retryable: false };
}

function baseConversationId(conversationId: string): string {
  return conversationId.split("#", 1)[0] ?? conversationId;
}
