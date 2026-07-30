import {
  AGENT_PRECEDING_MESSAGES_MAX_COUNT,
  AGENT_PRECEDING_MESSAGES_MAX_TOTAL_BYTES,
  AGENT_PRECEDING_MESSAGE_MAX_TEXT_BYTES,
  type AgentMessageSender,
  type AgentPrecedingMessage,
} from "@mono-agent/agent-contracts";

import {
  normalizeSlackMarkdownToMarkdown,
  renderSlackMentionTokens,
} from "./slack-markdown.js";
import type { SlackConversationMessage } from "./types.js";

/**
 * Messages of context sent per turn. Matches Slack's 15-object ceiling for
 * non-Marketplace apps so the default works everywhere; internal apps can raise it.
 */
export const SLACK_THREAD_CONTEXT_DEFAULT_MAX_MESSAGES = 15;
/** Objects requested per call. Same 15-object reasoning as the message default. */
export const SLACK_THREAD_CONTEXT_DEFAULT_REQUEST_LIMIT = 15;
/**
 * Budget for the whole context phase. Deliberately far below the Slack client's
 * own 45s request timeout: this work sits between the 👀 reaction and the run, so
 * a slow read must be abandoned rather than waited on.
 */
export const SLACK_THREAD_CONTEXT_DEFAULT_TIMEOUT_MS = 4_000;
/** Fallback cooldown when a rate-limited response carries no `Retry-After`. */
export const SLACK_THREAD_CONTEXT_RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Sending more than the harness renders is pointless, so this is the hard ceiling. */
export const SLACK_THREAD_CONTEXT_MAX_MESSAGES_CEILING = AGENT_PRECEDING_MESSAGES_MAX_COUNT;
/** Upper bound accepted for `requestLimit`; Slack's own maximum for internal apps. */
export const SLACK_THREAD_CONTEXT_REQUEST_LIMIT_CEILING = 1_000;

/**
 * Subtypes that still carry real human or app content. An ALLOWLIST, so an
 * unknown future subtype fails closed rather than leaking a system notice
 * ("X joined the channel") into the prompt as though someone had said it.
 */
const CONTEXT_ALLOWED_SUBTYPES: ReadonlySet<string> = new Set([
  "file_share",
  "thread_broadcast",
  "bot_message",
]);

/** Mirrors the harness's own marker so a clamped body reads the same either way. */
const TRUNCATION_MARKER = "…[truncated]";

/** Tunes the best-effort thread/channel context read. */
export interface SlackThreadContextOptions {
  /** Default `true`. */
  readonly enabled?: boolean;
  /** Messages sent per turn; clamped to 0..30. `0` disables the read. */
  readonly maxMessages?: number;
  /** Objects requested from Slack; clamped to 1..1000. */
  readonly requestLimit?: number;
  /** Budget for the whole phase (fetch + name resolution). `0` means no extra deadline. */
  readonly timeoutMs?: number;
  /** Include OTHER apps' messages, labelled `isBot`. Default `true`; our own are always excluded. */
  readonly includeBotMessages?: boolean;
}

/** Every resolved knob, with defaults applied and bounds enforced. */
export interface ResolvedSlackThreadContext {
  readonly enabled: boolean;
  readonly maxMessages: number;
  readonly requestLimit: number;
  readonly timeoutMs: number;
  readonly includeBotMessages: boolean;
}

/** Why a turn carried no transcript. Logged as a count; never with content. */
export type SlackThreadContextSkipReason =
  | "disabled"
  | "unsupported_client"
  | "window_missed"
  | "rate_limited"
  | "missing_scope"
  | "not_in_channel"
  | "timeout"
  | "api_error"
  | "empty";

export function resolveSlackThreadContext(
  options: SlackThreadContextOptions | undefined,
): ResolvedSlackThreadContext {
  return {
    enabled: options?.enabled !== false,
    maxMessages: clampInteger(
      options?.maxMessages ?? SLACK_THREAD_CONTEXT_DEFAULT_MAX_MESSAGES,
      0,
      SLACK_THREAD_CONTEXT_MAX_MESSAGES_CEILING,
    ),
    requestLimit: clampInteger(
      options?.requestLimit ?? SLACK_THREAD_CONTEXT_DEFAULT_REQUEST_LIMIT,
      1,
      SLACK_THREAD_CONTEXT_REQUEST_LIMIT_CEILING,
    ),
    timeoutMs: Math.max(0, Math.trunc(options?.timeoutMs ?? SLACK_THREAD_CONTEXT_DEFAULT_TIMEOUT_MS)),
    includeBotMessages: options?.includeBotMessages !== false,
  };
}

/**
 * The newest usable messages strictly preceding the trigger, oldest first.
 *
 * Pure: no clock, no network. Makes NO assumption about the order Slack returned
 * (`conversations.history` is newest-first, `conversations.replies` oldest-first,
 * and the latter always injects the thread parent), so everything is sorted
 * locally by numeric timestamp.
 *
 * `requireTrigger` is the window check for the replies path. Slack's docs do not
 * say which end `limit` truncates, so instead of trusting either reading we ask
 * for a page anchored at the trigger and verify the trigger came back. If it did
 * not, Slack gave us an unrelated slice of the thread and the only safe answer is
 * no transcript at all — a misleading one is worse than none.
 */
export function selectPrecedingSlackMessages(input: {
  readonly raw: readonly SlackConversationMessage[];
  readonly triggerTs: string;
  readonly maxMessages: number;
  readonly requireTrigger: boolean;
  readonly ownBotUserIds: ReadonlySet<string>;
  readonly ownBotId?: string;
  readonly includeBotMessages: boolean;
}): {
  readonly kept: readonly SlackConversationMessage[];
  readonly windowMissed: boolean;
} {
  if (input.requireTrigger && !input.raw.some((message) => message.ts === input.triggerTs)) {
    return { kept: [], windowMissed: true };
  }

  const limit = clampInteger(input.maxMessages, 0, SLACK_THREAD_CONTEXT_MAX_MESSAGES_CEILING);
  if (limit === 0) {
    return { kept: [], windowMissed: false };
  }

  const triggerSeconds = slackTsToSeconds(input.triggerTs);
  const usable: { readonly message: SlackConversationMessage; readonly seconds: number }[] = [];
  for (const message of input.raw) {
    const seconds = slackTsToSeconds(message.ts);
    if (seconds === undefined) continue;
    // Strictly before the trigger. This drops the trigger itself and anything a
    // colleague sent while the fetch was in flight.
    if (triggerSeconds !== undefined && seconds >= triggerSeconds) continue;
    if (isOwnPost(message, input.ownBotUserIds, input.ownBotId)) continue;
    if (message.subtype !== undefined && !CONTEXT_ALLOWED_SUBTYPES.has(message.subtype)) continue;
    if (!input.includeBotMessages && message.bot_id !== undefined) continue;
    usable.push({ message, seconds });
  }

  usable.sort((left, right) => left.seconds - right.seconds);
  return { kept: usable.slice(-limit).map((entry) => entry.message), windowMissed: false };
}

/**
 * One contract entry, or `undefined` when nothing usable survives.
 *
 * The body is normalized the same way inbound turn text is, EXCEPT that the
 * bot's own mention is left in place: a transcript should show that someone
 * pinged the agent. Reserved harness markup is deliberately NOT neutralized here
 * — the harness owns that, and escaping twice would corrupt legitimate text.
 */
export function toAgentPrecedingMessage(
  message: SlackConversationMessage,
  sender: AgentMessageSender | undefined,
): AgentPrecedingMessage | undefined {
  const text = normalizeBody(message.text);
  if (text === undefined) return undefined;
  const resolvedSender = sender ?? botSenderFromMessage(message);
  const timestamp = slackTsToIsoTimestamp(message.ts);
  return {
    ...(resolvedSender === undefined ? {} : { sender: resolvedSender }),
    text,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

/**
 * Keeps the newest entries that fit `maxTotalBytes`, mirroring the harness's own
 * accumulation. Pre-trimming here is what keeps the `turn_context` counts honest:
 * the harness would silently drop the overflow either way.
 */
export function trimPrecedingToTotalBytes<T extends { readonly text: string }>(
  entries: readonly T[],
  maxTotalBytes: number = AGENT_PRECEDING_MESSAGES_MAX_TOTAL_BYTES,
): readonly T[] {
  const kept: T[] = [];
  let budget = maxTotalBytes;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const cost = utf8Bytes(entry.text) + 1;
    if (cost > budget) break;
    budget -= cost;
    kept.push(entry);
  }
  kept.reverse();
  return kept.length === entries.length ? entries : kept;
}

/**
 * A Slack `seconds.micros` timestamp as canonical ISO-8601, or `undefined`.
 *
 * The harness echoes a timestamp only when it round-trips exactly
 * (`new Date(Date.parse(v)).toISOString() === v`), so anything this cannot
 * represent is dropped rather than guessed at — including values so large that
 * `toISOString` would throw.
 */
export function slackTsToIsoTimestamp(ts: string | undefined): string | undefined {
  const seconds = slackTsToSeconds(ts);
  if (seconds === undefined) return undefined;
  const milliseconds = Math.round(seconds * 1_000);
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    // RangeError past the representable date range.
    return undefined;
  }
}

/** One combined signal for the whole context phase, plus its cleanup. */
export function withContextDeadline(
  signal: AbortSignal,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  if (timeoutMs <= 0) {
    return { signal, dispose: () => undefined };
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The turn can outlive this phase by minutes; an un-unref'd timer would keep
  // the process alive that much longer for no reason.
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Resolved when the phase deadline wins the race against in-flight work. */
export const SLACK_CONTEXT_DEADLINE_EXCEEDED = Symbol("slack-context-deadline-exceeded");

/**
 * `work`, unless `signal` aborts first — in which case the deadline sentinel is
 * returned and the in-flight work is abandoned.
 *
 * Aborting the signal is not enough on its own: a `SlackWebApi` implementation is
 * free to ignore `options.signal`, and then awaiting it would let the context
 * phase outlive its budget and delay the turn. Racing makes the bound hold no
 * matter how the client behaves.
 *
 * Rejections still propagate, so the caller can classify a failure (and latch a
 * rate-limit cooldown) rather than mistaking it for a timeout.
 */
export function raceAgainstDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof SLACK_CONTEXT_DEADLINE_EXCEEDED> {
  if (signal.aborted) {
    // Nothing is attached to `work` on this path, so swallow a late rejection
    // rather than leaving it unhandled.
    void work.catch(() => undefined);
    return Promise.resolve(SLACK_CONTEXT_DEADLINE_EXCEEDED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(SLACK_CONTEXT_DEADLINE_EXCEEDED);
    signal.addEventListener("abort", onAbort, { once: true });
    // Attached in both outcomes, so an abandoned read's later rejection is
    // consumed here instead of surfacing as an unhandled rejection.
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** True when the message is one of ours, by user id or by app id. */
function isOwnPost(
  message: SlackConversationMessage,
  ownBotUserIds: ReadonlySet<string>,
  ownBotId: string | undefined,
): boolean {
  if (typeof message.user === "string" && ownBotUserIds.has(message.user.trim().toLowerCase())) {
    return true;
  }
  return ownBotId !== undefined && message.bot_id === ownBotId;
}

/**
 * An app's own message carries its name, so a bot speaker costs no `users.info`
 * call. `isBot` comes from the transport rather than the user, which is what
 * makes it the contract's only trustworthy discriminator.
 */
function botSenderFromMessage(
  message: SlackConversationMessage,
): AgentMessageSender | undefined {
  if (message.bot_id === undefined) return undefined;
  const displayName = firstNonBlank(message.bot_profile?.name, message.username);
  return {
    ...(displayName === undefined ? {} : { displayName }),
    isBot: true,
  };
}

function normalizeBody(text: string | undefined): string | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  const normalized = normalizeSlackMarkdownToMarkdown(renderSlackMentionTokens(text)).trim();
  if (normalized.length === 0) return undefined;
  if (utf8Bytes(normalized) <= AGENT_PRECEDING_MESSAGE_MAX_TEXT_BYTES) {
    return normalized;
  }
  // Clamp to leave room for the marker, so the result still fits the harness's
  // own per-message bound and it does not truncate (and re-mark) a second time.
  const room = AGENT_PRECEDING_MESSAGE_MAX_TEXT_BYTES - utf8Bytes(TRUNCATION_MARKER);
  const clamped = clampUtf8Bytes(normalized, room).trimEnd();
  return clamped.length === 0 ? undefined : `${clamped}${TRUNCATION_MARKER}`;
}

/**
 * `"1753970042.123456"` as fractional seconds. Rejects blanks, non-numerics, and
 * non-finite values so a malformed ts can never order or date a transcript.
 */
function slackTsToSeconds(ts: string | undefined): number | undefined {
  if (typeof ts !== "string") return undefined;
  const trimmed = ts.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds;
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function clampUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += character;
  }
  return result;
}

function firstNonBlank(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
