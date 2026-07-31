import type { AgentSurface } from "@mono-agent/agent-contracts";

import type { SlackMessageStreamLogger } from "./message-stream.js";
import { SlackApiError } from "./slack-client.js";
import type { SlackConversationsInfoResult, SlackWebApi } from "./types.js";

/** Entries retained before the oldest is evicted. */
export const SLACK_CHANNEL_DIRECTORY_MAX_ENTRIES = 200;
/** How long a resolved surface is reused. Channel names change rarely. */
export const SLACK_CHANNEL_DIRECTORY_TTL_MS = 30 * 60_000;
/** How long an unresolvable id is remembered, so one bad id is not retried per turn. */
export const SLACK_CHANNEL_DIRECTORY_NEGATIVE_TTL_MS = 5 * 60_000;

export interface SlackChannelDirectoryOptions {
  /** Only `conversationsInfo` is used, and it is optional: an omitting client latches the directory off. */
  api: Pick<SlackWebApi, "conversationsInfo">;
  logger?: SlackMessageStreamLogger;
  maxEntries?: number;
  ttlMs?: number;
  negativeTtlMs?: number;
  /** Injectable clock so TTL behaviour is testable without fake timers. */
  now?: () => number;
}

interface CacheEntry {
  /** Absent means "looked up and unusable" — a negative entry. */
  readonly resolved?: SlackResolvedChannel;
  readonly expiresAt: number;
}

/** What `conversations.info` adds on top of what an event already told us. */
export interface SlackResolvedChannel {
  /** Channel name without a leading `#`. Absent for a DM, which has no name. */
  readonly name?: string;
  /** Authoritative kind, which an `app_mention` event cannot supply on its own. */
  readonly kind?: AgentSurface["kind"];
}

/**
 * Bounded `conversations.info` cache that names the surface a turn is on.
 *
 * The same three invariants that make {@link SlackUserDirectory} safe to call on
 * every turn apply here, for the same reasons:
 *
 * - It NEVER rejects. A surface name is a nicety — the kind alone already tells
 *   the agent whether it is in a DM or a shared channel — so every failure
 *   degrades to an unnamed surface rather than failing the turn.
 * - It NEVER invents a name. A channel with no usable `name` resolves to nothing
 *   rather than to its id: the id is carried separately and stating it twice,
 *   once dressed as a name, would only mislead.
 * - It latches OFF permanently on `missing_scope`. Naming a surface needs
 *   `channels:read`/`groups:read`/`im:read` beyond what posting needs, so a
 *   mis-scoped app is the expected case, not an exotic one — without the latch it
 *   would pay one guaranteed-failing call per turn, forever.
 *
 * Eviction is insertion-order (FIFO), not LRU: an agent talks in a handful of
 * channels, so the extra bookkeeping buys nothing against a 200-entry budget.
 */
export class SlackChannelDirectory {
  private readonly api: Pick<SlackWebApi, "conversationsInfo">;
  private readonly logger: SlackMessageStreamLogger | undefined;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private latchedOff = false;
  private loggedUnavailable = false;

  constructor(options: SlackChannelDirectoryOptions) {
    this.api = options.api;
    this.logger = options.logger;
    this.maxEntries = options.maxEntries ?? SLACK_CHANNEL_DIRECTORY_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? SLACK_CHANNEL_DIRECTORY_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? SLACK_CHANNEL_DIRECTORY_NEGATIVE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** True once `conversations.info` is known to be unusable: absent method or missing scope. */
  get unavailable(): boolean {
    return this.latchedOff;
  }

  /**
   * Resolve one channel's name and kind. Returns `undefined` — never throws —
   * when the channel cannot be described, which leaves the caller with whatever
   * the event itself already implied.
   */
  async resolve(
    channelId: string,
    signal: AbortSignal | undefined,
  ): Promise<SlackResolvedChannel | undefined> {
    const id = channelId.trim();
    if (id.length === 0) {
      return undefined;
    }
    // Cached names are served even once the directory has latched off, so losing
    // the scope mid-process degrades gradually rather than all at once.
    const cached = this.read(id);
    if (cached !== undefined) {
      return cached.resolved;
    }
    const conversationsInfo = this.api.conversationsInfo;
    if (typeof conversationsInfo !== "function") {
      this.latchedOff = true;
    }
    if (this.latchedOff) {
      this.noteUnavailable();
      return undefined;
    }

    try {
      const result = await conversationsInfo!.call(
        this.api,
        { channelId: id },
        signal === undefined ? undefined : { signal },
      );
      const resolved = channelFromSlackConversation(result.channel);
      this.write(id, resolved, resolved === undefined ? this.negativeTtlMs : this.ttlMs);
      return resolved;
    } catch (error) {
      if (error instanceof SlackApiError && error.slackError === "missing_scope") {
        this.latchedOff = true;
        this.logger?.warn?.(
          "Slack conversations.info is missing a scope; surface names are disabled for this process.",
          { ...(error.needed === undefined ? {} : { needed: error.needed }) },
        );
        return undefined;
      }
      // Everything else — channel_not_found, a rate limit, a transport failure —
      // is negative-cached rather than latched: those recover on their own, and
      // retrying the same id every turn in between is pure waste.
      this.write(id, undefined, this.negativeTtlMs);
      return undefined;
    }
  }

  private read(channelId: string): CacheEntry | undefined {
    const entry = this.cache.get(channelId);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(channelId);
      return undefined;
    }
    return entry;
  }

  private write(
    channelId: string,
    resolved: SlackResolvedChannel | undefined,
    ttlMs: number,
  ): void {
    this.cache.delete(channelId);
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(channelId, {
      ...(resolved === undefined ? {} : { resolved }),
      expiresAt: this.now() + ttlMs,
    });
  }

  private noteUnavailable(): void {
    if (this.loggedUnavailable) return;
    this.loggedUnavailable = true;
    this.logger?.debug?.("Slack surface names are unavailable; turns state the surface kind only.");
  }
}

/**
 * The describable half of a `conversations.info` channel, or `undefined` when it
 * says nothing useful.
 *
 * Kind precedence follows Slack's own flags: an `im` is a DM, an `mpim` is a
 * group DM (a shared audience without being a named channel), and everything
 * else — public or private — is a channel. Private-ness deliberately does not
 * change the kind: what matters to the agent is how many people read what it
 * writes, and a private channel is still shared.
 */
function channelFromSlackConversation(
  channel: SlackConversationsInfoResult["channel"],
): SlackResolvedChannel | undefined {
  if (channel === undefined) return undefined;
  const kind: AgentSurface["kind"] | undefined = channel.is_im === true
    ? "dm"
    : channel.is_mpim === true
      ? "group"
      : channel.is_channel === true || channel.is_group === true
        ? "channel"
        : undefined;
  // A DM's `name` is Slack bookkeeping, not a channel name, so it is dropped:
  // the DM counterpart is already named by the turn's speaker label.
  const name = kind === "dm" ? undefined : normalizeChannelName(channel.name);
  if (kind === undefined && name === undefined) {
    return undefined;
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(kind === undefined ? {} : { kind }),
  };
}

/** A channel name without its decorative leading `#`, or undefined when blank. */
function normalizeChannelName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/^#+/u, "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
