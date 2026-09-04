import type {
  HostWakeDeliveryResult,
  MonitorProjection,
} from "@mono-agent/agent-contracts";

import type { ChannelDriver, ChannelId, MonoAgentAppLogger, RunningChannel } from "./channels.js";

export interface MonitorChannelRoutingInput {
  readonly projection: MonitorProjection;
  readonly conversationId: string;
  readonly deliveryKey: string;
  readonly text: string;
  readonly drivers: readonly ChannelDriver[];
  readonly running: ReadonlyMap<ChannelId, RunningChannel>;
  readonly logger?: MonoAgentAppLogger;
}

/**
 * Route one monitor wake to the exact channel that owns its origin scheme.
 *
 * Every mismatch fails closed rather than falling back to "some channel that
 * could deliver this": a monitor's whole ownership model is that its events go
 * to the one conversation that asked for them.
 */
export async function routeMonitorWake(
  input: MonitorChannelRoutingInput,
): Promise<HostWakeDeliveryResult> {
  const origin = input.projection.origin;
  const expectedConversationId = baseConversationId(origin.conversationId);
  const expectedDeliveryKey = `monitor:${input.projection.monitorId}:${String(input.projection.counters.seq)}`;
  if (input.conversationId !== expectedConversationId
    || input.deliveryKey !== expectedDeliveryKey
    || !input.conversationId.startsWith(`${origin.channel}:`)) {
    return {
      delivered: false,
      code: "monitor_origin_mismatch",
      reason: "The monitor origin does not match its destination.",
      retryable: false,
    };
  }
  const candidates = input.drivers.filter(
    (driver) => driver.processJobs?.conversationScheme === origin.channel,
  );
  if (candidates.length !== 1) {
    return {
      delivered: false,
      code: "monitor_unsupported_channel",
      reason: candidates.length === 0
        ? `No channel owns conversation scheme ${origin.channel}.`
        : `Multiple channels claim conversation scheme ${origin.channel}.`,
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
  if (channel.monitors === undefined) {
    return {
      delivered: false,
      code: "monitor_unsupported_channel",
      reason: `${driver.id} channel does not deliver monitor wakes`,
      retryable: false,
    };
  }
  try {
    return await channel.monitors.wake({
      conversationId: input.conversationId,
      text: input.text,
      deliveryKey: input.deliveryKey,
      monitor: input.projection,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.logger?.warn?.("Monitor wake failed.", {
      channelId: driver.id,
      conversationId: input.conversationId,
      reason,
    });
    // An adapter that threw may or may not have posted; never replay it.
    return { delivered: false, code: "monitor_wake_failed", reason, retryable: false, ambiguous: true };
  }
}

function baseConversationId(conversationId: string): string {
  return conversationId.split("#", 1)[0] ?? conversationId;
}
