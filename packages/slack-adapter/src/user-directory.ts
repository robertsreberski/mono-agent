import type { AgentMessageSender } from "@mono-agent/agent-contracts";

import type { SlackMessageStreamLogger } from "./message-stream.js";
import { SlackApiError } from "./slack-client.js";
import type { SlackUsersInfoResult, SlackWebApi } from "./types.js";

/** Entries retained before the oldest is evicted. */
export const SLACK_USER_DIRECTORY_MAX_ENTRIES = 500;
/** How long a resolved name is reused. Display names change rarely. */
export const SLACK_USER_DIRECTORY_TTL_MS = 30 * 60_000;
/** How long an unresolvable id is remembered, so one bad id is not retried per turn. */
export const SLACK_USER_DIRECTORY_NEGATIVE_TTL_MS = 5 * 60_000;
/** Concurrent `users.info` calls. Keeps a cold thread well inside the Tier 4 budget. */
export const SLACK_USER_DIRECTORY_LOOKUP_CONCURRENCY = 3;

export interface SlackUserDirectoryOptions {
  /** Only `usersInfo` is used, and it is optional: an omitting client latches the directory off. */
  api: Pick<SlackWebApi, "usersInfo">;
  logger?: SlackMessageStreamLogger;
  maxEntries?: number;
  ttlMs?: number;
  negativeTtlMs?: number;
  /** Injectable clock so TTL behaviour is testable without fake timers. */
  now?: () => number;
}

interface CacheEntry {
  /** Absent means "looked up and unusable" — a negative entry. */
  readonly sender?: AgentMessageSender;
  readonly expiresAt: number;
}

/**
 * Bounded `users.info` cache that turns Slack user ids into model-visible
 * {@link AgentMessageSender} names.
 *
 * Three invariants make it safe to call on every turn:
 *
 * - It NEVER rejects. A speaker name is a nicety; failing a turn over one would
 *   be absurd, so every failure degrades to an unnamed speaker.
 * - It NEVER exposes an id as a name. A Slack user id doubles as a DM channel id,
 *   so the contract treats it as an exfiltration token rather than an identity.
 *   A profile with no usable name resolves to nothing.
 * - It latches OFF permanently on `missing_scope`. Without that, a mis-scoped app
 *   pays one guaranteed-failing call per speaker per turn, forever.
 *
 * Eviction is insertion-order (FIFO), not LRU: with a 500-entry budget against a
 * workspace's active speakers, the extra bookkeeping buys nothing.
 */
export class SlackUserDirectory {
  private readonly api: Pick<SlackWebApi, "usersInfo">;
  private readonly logger: SlackMessageStreamLogger | undefined;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private latchedOff = false;
  private loggedUnavailable = false;

  constructor(options: SlackUserDirectoryOptions) {
    this.api = options.api;
    this.logger = options.logger;
    this.maxEntries = options.maxEntries ?? SLACK_USER_DIRECTORY_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? SLACK_USER_DIRECTORY_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? SLACK_USER_DIRECTORY_NEGATIVE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** True once `users.info` is known to be unusable: absent method or missing scope. */
  get unavailable(): boolean {
    return this.latchedOff;
  }

  /**
   * Resolve as many of `userIds` as the cache and `maxLookups` allow. Deduped,
   * concurrency-bounded, and abort-aware. Ids that cannot be named are simply
   * absent from the returned map.
   */
  async resolveMany(
    userIds: readonly string[],
    signal: AbortSignal | undefined,
    maxLookups: number,
  ): Promise<ReadonlyMap<string, AgentMessageSender>> {
    const resolved = new Map<string, AgentMessageSender>();
    const pending: string[] = [];
    // Cached names are served even once the directory has latched off, so losing
    // the scope mid-process degrades gradually rather than all at once.
    for (const userId of dedupe(userIds)) {
      const cached = this.read(userId);
      if (cached !== undefined) {
        if (cached.sender !== undefined) {
          resolved.set(userId, cached.sender);
        }
        continue;
      }
      pending.push(userId);
    }

    if (pending.length === 0 || maxLookups <= 0) {
      return resolved;
    }
    if (typeof this.api.usersInfo !== "function") {
      this.latchedOff = true;
    }
    if (this.latchedOff) {
      this.noteUnavailable();
      return resolved;
    }

    const queue = pending.slice(0, maxLookups);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < queue.length) {
        if (signal?.aborted === true || this.latchedOff) return;
        const userId = queue[next]!;
        next += 1;
        const sender = await this.lookup(userId, signal);
        if (sender !== undefined) {
          resolved.set(userId, sender);
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(SLACK_USER_DIRECTORY_LOOKUP_CONCURRENCY, queue.length) },
        () => worker(),
      ),
    );
    return resolved;
  }

  /** One lookup. Caches both outcomes and never throws. */
  private async lookup(
    userId: string,
    signal: AbortSignal | undefined,
  ): Promise<AgentMessageSender | undefined> {
    const usersInfo = this.api.usersInfo;
    if (typeof usersInfo !== "function") {
      this.latchedOff = true;
      this.noteUnavailable();
      return undefined;
    }

    try {
      const result = await usersInfo.call(
        this.api,
        { userId },
        signal === undefined ? undefined : { signal },
      );
      const sender = senderFromSlackUser(result.user);
      this.write(userId, sender, sender === undefined ? this.negativeTtlMs : this.ttlMs);
      return sender;
    } catch (error) {
      if (error instanceof SlackApiError && error.slackError === "missing_scope") {
        this.latchedOff = true;
        this.logger?.warn?.(
          "Slack users.info is missing a scope; speaker names are disabled for this process.",
          { ...(error.needed === undefined ? {} : { needed: error.needed }) },
        );
        return undefined;
      }
      // Everything else — user_not_found, a rate limit, a transport failure — is
      // negative-cached rather than latched: those recover on their own, and
      // retrying the same id every turn in between is pure waste.
      this.write(userId, undefined, this.negativeTtlMs);
      return undefined;
    }
  }

  private read(userId: string): CacheEntry | undefined {
    const entry = this.cache.get(userId);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(userId);
      return undefined;
    }
    return entry;
  }

  private write(userId: string, sender: AgentMessageSender | undefined, ttlMs: number): void {
    this.cache.delete(userId);
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(userId, {
      ...(sender === undefined ? {} : { sender }),
      expiresAt: this.now() + ttlMs,
    });
  }

  private noteUnavailable(): void {
    if (this.loggedUnavailable) return;
    this.loggedUnavailable = true;
    this.logger?.debug?.("Slack speaker names are unavailable; turns stay unnamed.");
  }
}

/** Distinct, trimmed, non-blank ids in first-seen order. */
function dedupe(userIds: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const userId of userIds) {
    const trimmed = userId.trim();
    if (trimmed.length > 0) {
      seen.add(trimmed);
    }
  }
  return [...seen];
}

/**
 * The model-visible half of a Slack profile, or `undefined` when there is no
 * usable name. `id` is deliberately never read here — see the class docs.
 */
function senderFromSlackUser(
  user: SlackUsersInfoResult["user"],
): AgentMessageSender | undefined {
  if (user === undefined) return undefined;
  const displayName = firstNonBlank(
    user.profile?.display_name,
    user.profile?.real_name,
    user.real_name,
  );
  const handle = normalizeHandle(user.name);
  if (displayName === undefined && handle === undefined) return undefined;
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(handle === undefined ? {} : { handle }),
    ...(user.is_bot === true ? { isBot: true } : {}),
  };
}

function firstNonBlank(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** Slack handles reach the contract without a leading `@`. */
function normalizeHandle(name: string | undefined): string | undefined {
  const trimmed = firstNonBlank(name);
  if (trimmed === undefined) return undefined;
  const stripped = trimmed.replace(/^@+/u, "").trim();
  return stripped.length === 0 ? undefined : stripped;
}
