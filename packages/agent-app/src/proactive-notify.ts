import type {
  NotifyDeliveryContext,
  NotifyDeliveryResult,
  ProcessJobProjection,
} from "@mono-agent/agent-contracts";

import type { ChannelDriver, ChannelId, MonoAgentAppLogger, RunningChannel } from "./channels.js";

// The delivery-result contract moved to @mono-agent/agent-contracts; keep the
// historical export from this module.
export type { NotifyDeliveryResult } from "@mono-agent/agent-contracts";

/**
 * Push-shaped conversation schemes known to the app. The running channel's
 * optional `notify` hook remains the authoritative delivery capability, so a
 * recognized plugin destination can still fail closed as unsupported. This is
 * intentionally wider than the webhook callback list: WhatsApp is recognized
 * here, but its plugin driver does not expose a native notify hook yet, while
 * the Messenger plugin driver does.
 * web/cron/webhook/openai-api/a2a are request-driven, not ordinary push
 * destinations. Process-job web lifecycle routing is handled explicitly below.
 */
const PUSH_CHANNEL_BY_SCHEME: Partial<Record<string, ChannelId>> = {
  telegram: "telegram",
  slack: "slack",
  whatsapp: "whatsapp",
  messenger: "messenger",
};

/**
 * Channels whose conversations can receive a proactive notification turn — the
 * single capability registry behind BOTH artifact-sighting admission and
 * destination resolution. Keeping one set means a channel can never be
 * notify-capable for one half of inference and invisible to the other.
 * WhatsApp is a recognized push scheme but has no notify hook yet, so it is
 * absent here and its conversations are never offered as candidates.
 */
export const NOTIFY_CAPABLE_CHANNELS: ReadonlySet<ChannelId> = new Set<ChannelId>([
  "telegram",
  "slack",
  "messenger",
]);

/** Whether a channel can receive an inferred native cron/webhook notification. */
export function isNotifyCapableChannel(channelId: ChannelId | undefined): channelId is ChannelId {
  return channelId !== undefined && NOTIFY_CAPABLE_CHANNELS.has(channelId);
}

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
  /** The message to deliver. With `verbatim`, posted as-is; otherwise run as a turn. */
  readonly text: string;
  /**
   * Deliver `text` VERBATIM — post it to the destination unchanged with no model
   * call, then record it to the conversation's history (native cron/webhook
   * notification). Without it, `text` is a prompt run as a turn on the
   * destination's harness (e.g. a Slack interactive trigger).
   */
  readonly verbatim?: boolean;
  /** Stable host delivery identity for adapters with duplicate suppression. */
  readonly deliveryKey?: string;
  readonly deliveryContext?: NotifyDeliveryContext;
  /** Secret-free state for a process-job wake and web card update. */
  readonly processJob?: ProcessJobProjection;
  /** Currently running channels, keyed by id (the app's live registry). */
  readonly running: ReadonlyMap<ChannelId, Pick<RunningChannel, "notify">>;
  /**
   * Registered channel drivers, used to map a conversation SCHEME to the id the
   * owning driver actually runs under. A plugin may be registered under a
   * custom `id` while declaring a fixed `processJobs.conversationScheme`, so
   * the scheme alone is not a running-registry key. Omit to key by scheme
   * directly (the built-in channels, whose id and scheme coincide).
   */
  readonly drivers?: readonly Pick<ChannelDriver, "id" | "processJobs">[];
  readonly logger?: MonoAgentAppLogger;
}

/**
 * Resolve the running-registry id that owns a conversation scheme.
 *
 * Mirrors `routeMonitorWake`: a driver that DECLARES the scheme owns it, under
 * whatever id it was registered with. Zero declarations means a built-in
 * channel whose id is the scheme itself; two or more is ambiguous and fails
 * closed rather than guessing which instance should receive the message.
 * (`assertUniqueProcessJobChannelSchemes` rejects that at startup — this is the
 * defensive second gate.)
 */
function resolveOwningChannelId(
  scheme: ChannelId,
  drivers: readonly Pick<ChannelDriver, "id" | "processJobs">[] | undefined,
): { readonly channelId: ChannelId } | { readonly ambiguous: true } {
  if (drivers === undefined) {
    return { channelId: scheme };
  }
  const owners = drivers.filter((driver) => driver.processJobs?.conversationScheme === scheme);
  if (owners.length > 1) {
    return { ambiguous: true };
  }
  return { channelId: owners[0]?.id ?? scheme };
}

/**
 * Route a proactive notification to the channel that owns its destination
 * conversation, so the message runs as a real turn on that channel's own harness
 * (shared session/history) and is delivered through its normal stream. The owning
 * channel's `notify` hook enforces its adapter allowlist before delivering, so a
 * non-allowlisted (e.g. payload-supplied) destination is rejected here. Returns a
 * structured {@link NotifyDeliveryResult}; never throws (the trigger run already
 * succeeded), so the caller can report the outcome to the model.
 */
export async function routeProactiveNotification(input: ProactiveNotifyInput): Promise<NotifyDeliveryResult> {
  const webProcessJobChannel = processJobWebChannel(input);
  if (input.processJob?.origin.channel === "web" && webProcessJobChannel === undefined) {
    return {
      delivered: false,
      code: "process_job_origin_mismatch",
      reason: "The process-job origin does not match the web destination.",
      retryable: false,
    };
  }
  const scheme = webProcessJobChannel ?? channelIdForConversation(input.conversationId);
  if (scheme === undefined) {
    input.logger?.warn?.("Proactive notification skipped: unrecognized destination.", {
      conversationId: input.conversationId,
    });
    return { delivered: false, reason: "unrecognized destination conversationId" };
  }
  const owner = resolveOwningChannelId(scheme, input.drivers);
  if ("ambiguous" in owner) {
    input.logger?.warn?.("Proactive notification skipped: multiple channels claim the destination scheme.", {
      conversationId: input.conversationId,
      scheme,
    });
    return {
      delivered: false,
      code: "destination_channel_unsupported",
      reason: `Multiple channels claim conversation scheme ${scheme}.`,
      retryable: false,
    };
  }
  const channelId = owner.channelId;
  const channel = input.running.get(channelId);
  if (channel === undefined) {
    input.logger?.warn?.(
      "Proactive notification skipped: destination channel is not running.",
      { conversationId: input.conversationId, channelId },
    );
    return {
      delivered: false,
      code: "destination_channel_unavailable",
      reason: `${channelId} channel is not running`,
      retryable: true,
    };
  }
  if (channel.notify === undefined) {
    input.logger?.warn?.(
      "Proactive notification skipped: destination channel does not support delivery.",
      { conversationId: input.conversationId, channelId },
    );
    return {
      delivered: false,
      code: "destination_channel_unsupported",
      reason: `${channelId} channel does not support proactive delivery`,
      retryable: false,
    };
  }
  try {
    return await channel.notify({
      conversationId: input.conversationId,
      text: input.text,
      ...(input.verbatim === undefined ? {} : { verbatim: input.verbatim }),
      ...(input.deliveryKey === undefined ? {} : { deliveryKey: input.deliveryKey }),
      ...(input.deliveryContext === undefined ? {} : { deliveryContext: input.deliveryContext }),
      ...(input.processJob === undefined ? {} : { processJob: input.processJob }),
    });
  } catch (error) {
    const reason = reasonOf(error);
    input.logger?.warn?.("Proactive notification failed: destination channel notify threw.", {
      conversationId: input.conversationId,
      channelId,
      reason,
    });
    return { delivered: false, reason };
  }
}

function processJobWebChannel(input: ProactiveNotifyInput): ChannelId | undefined {
  const origin = input.processJob?.origin;
  return origin?.channel === "web"
    && baseConversationId(origin.conversationId) === input.conversationId
    && input.conversationId.startsWith("web:")
    && input.conversationId !== "web:new"
    ? "tui"
    : undefined;
}

function baseConversationId(conversationId: string): string {
  return conversationId.split("#", 1)[0] ?? conversationId;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
