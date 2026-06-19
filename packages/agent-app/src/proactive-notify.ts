import type { ChannelId, MonoAgentAppLogger, RunningChannel } from "./channels.js";

/**
 * Push channels a proactive notification can be delivered to. The conversationId
 * scheme (the part before the first `:`) identifies the owning channel; only
 * these channels run a destination harness that can both produce and deliver a
 * turn. cron/webhook/openai-api/a2a are request-driven, not push destinations.
 */
const PUSH_CHANNEL_BY_SCHEME: Partial<Record<string, ChannelId>> = {
  telegram: "telegram",
  slack: "slack",
  whatsapp: "whatsapp",
};

/** The push channel that owns a destination conversationId (requires a `<scheme>:<target>` form), or undefined. */
export function channelIdForConversation(conversationId: string): ChannelId | undefined {
  const colon = conversationId.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  return PUSH_CHANNEL_BY_SCHEME[conversationId.slice(0, colon)];
}

export interface ProactiveNotifyInput {
  /** Destination conversationId, e.g. `telegram:42` or `slack:C1:171.5`. */
  readonly conversationId: string;
  /** The framed nudge text to run as a turn on the destination's harness. */
  readonly text: string;
  /** Currently running channels, keyed by id (the app's live registry). */
  readonly running: ReadonlyMap<ChannelId, Pick<RunningChannel, "notify">>;
  readonly logger?: MonoAgentAppLogger;
}

/**
 * Route a proactive notification to the channel that owns its destination
 * conversation, so the message runs as a real turn on that channel's own harness
 * (shared session/history) and is delivered through its normal stream. Returns
 * whether it was delivered; a non-deliverable or unavailable destination is
 * warned and skipped (never throws — the trigger run already succeeded).
 */
export async function routeProactiveNotification(input: ProactiveNotifyInput): Promise<boolean> {
  const channelId = channelIdForConversation(input.conversationId);
  if (channelId === undefined) {
    input.logger?.warn?.("Proactive notification skipped: unrecognized destination.", {
      conversationId: input.conversationId,
    });
    return false;
  }
  const channel = input.running.get(channelId);
  if (channel?.notify === undefined) {
    input.logger?.warn?.(
      "Proactive notification skipped: destination channel is not running or does not support delivery.",
      { conversationId: input.conversationId, channelId },
    );
    return false;
  }
  await channel.notify({ conversationId: input.conversationId, text: input.text });
  return true;
}
