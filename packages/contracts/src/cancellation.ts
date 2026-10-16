
import { types as nodeUtilTypes } from "node:util";


export interface AgentResponseCancelledErrorOptions {
  readonly reason?: unknown;
}

/**
 * Stable abort reason for an explicit channel-user cancellation such as
 * `/cancel`. Adapters use this to distinguish a command they already
 * acknowledged from provider, transport, or shutdown cancellation, whose
 * existing terminal delivery behavior must remain unchanged.
 */
export class ChannelUserCancelReason extends Error {
  readonly channel: string;
  /** Cross-package brand; survives duplicate package identities. */
  readonly channelUserCancel = true as const;

  constructor(channel: string) {
    const normalizedChannel = channel.trim();
    if (normalizedChannel.length === 0) {
      throw new TypeError("Channel user cancel reason requires a channel name.");
    }
    super(`Cancelled by ${normalizedChannel} user.`);
    this.name = "ChannelUserCancelReason";
    this.channel = normalizedChannel;
  }
}

/** Create the branded reason passed to responder and adapter abort controllers. */
export function createChannelUserCancelReason(channel: string): ChannelUserCancelReason {
  return new ChannelUserCancelReason(channel);
}

/** Recognize a channel-user cancellation across duplicate package identities. */
export function isChannelUserCancelReason(
  reason: unknown,
): reason is ChannelUserCancelReason {
  return hasOwnTrueDataProperty(reason, "channelUserCancel");
}

export class AgentResponseCancelledError extends Error {
  readonly reason?: unknown;
  /**
   * Stable brand so the guard recognizes cancellation even across duplicate
   * class identities (e.g. two copies of this package in a dependency graph),
   * without string-matching subclass `name`s.
   */
  readonly agentResponseCancelled = true as const;

  constructor(
    message = "Agent response was cancelled.",
    options: AgentResponseCancelledErrorOptions = {},
  ) {
    super(message);
    this.name = "AgentResponseCancelledError";
    if (options.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}

export function isAgentResponseCancelledError(
  error: unknown,
): error is AgentResponseCancelledError {
  return hasOwnTrueDataProperty(error, "agentResponseCancelled");
}

/** Read one exact cross-package brand without invoking accessors or Proxy traps. */
function hasOwnTrueDataProperty(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.value === true;
  } catch {
    return false;
  }
}
