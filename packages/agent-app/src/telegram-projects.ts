import type { TelegramChatObservation, TelegramKnownTopicName } from "@mono-agent/telegram-adapter";
import {
  beginWebExternalTurn,
  markWebExternalConversationGone,
  resolveWebExternalProjectDestination,
  syncWebExternalConversations,
  withProjectContext,
  type ConsoleToolOperation,
  type DeliverWebNotificationOptions,
  type WebExternalObservationInput,
} from "@mono-agent/web";

import { telegramTargetFromConversation, type TelegramDestinationTarget } from "./telegram-destination.js";
import type { TelegramDirectoryEntry, TelegramTopicDirectoryStore } from "./telegram-topic-directory.js";

/**
 * `telegram.projects`: forum topics as ordinary web-console projects.
 *
 * Telegram is only the communication layer. This app-owned service feeds the
 * passive topic ledger to the web console (the only owner of projects and
 * bindings) over the owner-private ingress, reads a topic's project context
 * for each turn, and resolves a project back to its topic for sends. Topic
 * ids stay host-owned: they travel only between this process and the console.
 * When the console is unreachable, a turn uses the last context this process
 * fetched for that topic and logs it; Telegram keeps answering either way.
 */

const SYNC_BATCH = 100;
const SYNC_DEBOUNCE_MS = 250;
const SYNC_RETRY_MIN_MS = 15_000;
const SYNC_RETRY_MAX_MS = 5 * 60_000;
const TURN_TIMEOUT_MS = 2_000;
const CONTEXT_CACHE_MAX = 1_024;

type Logger = {
  info?: (message: string, metadata?: Record<string, unknown>) => void;
  warn?: (message: string, metadata?: Record<string, unknown>) => void;
};

export interface TelegramProjectsServiceOptions {
  readonly directory: TelegramTopicDirectoryStore;
  readonly botId: string;
  /** This agent's web-console source id; without one nothing is mirrored. */
  readonly sourceId: string | undefined;
  /** The adapter allowlist, rechecked at every resolution. */
  readonly isAllowedChat: (chatId: string) => boolean;
  readonly logger?: Logger;
  /** Test seam for the console's state directory and transport. */
  readonly web?: DeliverWebNotificationOptions;
  readonly pid?: number;
  readonly syncDebounceMs?: number;
}

/** One Telegram turn's view of its project. */
export interface TelegramProjectTurn {
  /** Prepends the project's shared context to the prompt copy of the user message. */
  readonly decorateUserMessage?: (message: string) => string;
  /** Console project tools, when a capability was issued for this turn. */
  readonly call?: (operation: ConsoleToolOperation) => Promise<Record<string, unknown>>;
  /** Why tools are unavailable, when they were asked for. */
  readonly unavailable?: string;
  /** Where the context came from. */
  readonly context: "live" | "cached" | "none";
  revoke(): Promise<void>;
}

export type TelegramProjectDestination =
  | { readonly ok: true; readonly conversationId: string; readonly label: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface TelegramProjectsService {
  readonly knownTopicNames: readonly TelegramKnownTopicName[];
  /** Record one allowlisted sighting and mirror it. Never throws. */
  observe(observation: TelegramChatObservation): void;
  /** Read this turn's project context and, when asked, its project tools. */
  beginTurn(input: { readonly conversationId: string; readonly turnKey: string; readonly tools: boolean }): Promise<TelegramProjectTurn>;
  /** Resolve a project to its bound topic, rechecking the allowlist. */
  resolveDestination(projectId: string): Promise<TelegramProjectDestination>;
  /** A send proved this topic gone. Best effort. */
  reportGone(conversationId: string): Promise<void>;
  close(): Promise<void>;
}

/** Host-owned topic key: never model-visible, stored only by the web console. */
export function telegramProjectKey(botId: string, target: TelegramDestinationTarget): string | undefined {
  const chat = String(target.chatId);
  if (!/^-?\d{1,20}$/u.test(chat)) return undefined;
  return `telegram:${botId}:${chat}:${target.messageThreadId === undefined ? "main" : String(target.messageThreadId)}`;
}

export function createTelegramProjectsService(options: TelegramProjectsServiceOptions): TelegramProjectsService {
  const { directory, botId } = options;
  const web: DeliverWebNotificationOptions = { ...options.web };
  const pid = options.pid ?? process.pid;
  // Last context fetched per conversation; `null` records "no project".
  const contexts = new Map<string, { readonly name: string; readonly context: string } | null>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let syncing: Promise<void> | undefined;
  let rerun = false;
  let retryMs = SYNC_RETRY_MIN_MS;
  let lastSyncWarning: string | undefined;

  const knownTopicNames = directory.knownTopicNames();
  // A restart replays everything: the console may have been reset meanwhile.
  directory.markAllPending();

  const observationOf = (entry: TelegramDirectoryEntry): WebExternalObservationInput | undefined => {
    const key = telegramProjectKey(botId, { chatId: entry.chatId, ...(entry.topicId === undefined ? {} : { messageThreadId: entry.topicId }) });
    if (key === undefined) return undefined;
    return {
      key,
      kind: entry.topicId === undefined ? "main" : "topic",
      ...(entry.chatTitle === undefined ? {} : { chatLabel: entry.chatTitle }),
      ...(entry.topicName === undefined ? {} : { topicLabel: entry.topicName }),
      ...(entry.state === undefined ? {} : { state: entry.state, ...(entry.stateAt === undefined ? {} : { stateAt: entry.stateAt }) }),
      seenAt: entry.lastSeenAt,
    };
  };

  // One pending timer; a fresh sighting pulls a distant backoff retry forward,
  // so a console that came back is caught up promptly without busy retries.
  let timerDueAt = 0;
  const schedule = (delayMs: number): void => {
    if (closed || options.sourceId === undefined) return;
    const dueAt = Date.now() + delayMs;
    if (timer !== undefined) {
      if (timerDueAt <= dueAt) return;
      clearTimeout(timer);
    }
    timerDueAt = dueAt;
    timer = setTimeout(() => {
      timer = undefined;
      void sync();
    }, delayMs);
    timer.unref?.();
  };

  const sync = async (): Promise<void> => {
    if (syncing !== undefined) { rerun = true; return syncing; }
    syncing = (async () => {
      try {
        do {
          rerun = false;
          // Bounded batches until nothing is pending; a failure stops the
          // round and retries later with backoff.
          for (;;) {
            if (closed) return;
            const pending = directory.pending(SYNC_BATCH);
            if (pending.entries.length === 0) break;
            const observations = pending.entries.flatMap((entry) => observationOf(entry) ?? []);
            if (observations.length > 0) {
              const result = await syncWebExternalConversations({ sourceId: options.sourceId!, channel: "telegram", observations }, web);
              if (result.truncated) options.logger?.warn?.("The web console holds its maximum number of Telegram topics; newer topics are not projects.");
            }
            directory.acknowledge(pending.acknowledgement);
          }
        } while (rerun);
        retryMs = SYNC_RETRY_MIN_MS;
        lastSyncWarning = undefined;
      } catch (error) {
        const code = errorCode(error);
        if (lastSyncWarning !== code) {
          lastSyncWarning = code;
          options.logger?.warn?.("Telegram topics could not be mirrored to the web console; retrying later.", { code });
        }
        const delay = retryMs;
        retryMs = Math.min(retryMs * 2, SYNC_RETRY_MAX_MS);
        schedule(delay);
      } finally {
        syncing = undefined;
      }
    })();
    return syncing;
  };

  schedule(0);

  const remember = (conversationId: string, value: { readonly name: string; readonly context: string } | null): void => {
    contexts.delete(conversationId);
    contexts.set(conversationId, value);
    if (contexts.size > CONTEXT_CACHE_MAX) {
      const oldest = contexts.keys().next().value;
      if (oldest !== undefined) contexts.delete(oldest);
    }
  };

  const decorator = (project: { readonly name: string; readonly context: string } | null | undefined) =>
    project === undefined || project === null || project.context.trim().length === 0
      ? undefined
      : (message: string) => withProjectContext(message, { name: project.name, context: project.context });

  return {
    knownTopicNames,
    observe(observation) {
      // Only forums have topics; private chats and plain groups are never recorded.
      if (observation.isForum !== true && observation.topic === undefined) return;
      if (closed || !options.isAllowedChat(String(observation.chatId))) return;
      if (directory.observe(observation)) schedule(options.syncDebounceMs ?? SYNC_DEBOUNCE_MS);
    },
    async beginTurn(input) {
      const none = { context: "none" as const, revoke: async () => {} };
      const target = telegramTargetFromConversation(input.conversationId);
      if (closed || target === undefined || options.sourceId === undefined || !options.isAllowedChat(String(target.chatId))) {
        return { ...none, ...(input.tools ? { unavailable: "console_capability_unavailable" } : {}) };
      }
      const base = input.conversationId.split("#", 1)[0]!;
      const entry = directory.entry(String(target.chatId), target.messageThreadId);
      const key = entry === undefined ? undefined : telegramProjectKey(botId, target);
      if (key === undefined && !input.tools) return none;
      try {
        const turn = await beginWebExternalTurn({
          sourceId: options.sourceId, channel: "telegram", pid, turnKey: input.turnKey, tools: input.tools,
          ...(key === undefined ? {} : { key, observation: observationOf(entry!)! }),
        }, { ...web, timeoutMs: web.timeoutMs ?? TURN_TIMEOUT_MS });
        const project = turn.project === undefined ? null : { name: turn.project.name, context: turn.project.context };
        if (key !== undefined) remember(base, project);
        const decorate = decorator(project);
        return {
          context: "live",
          ...(decorate === undefined ? {} : { decorateUserMessage: decorate }),
          ...(turn.call === undefined ? {} : { call: turn.call }),
          ...(input.tools && turn.call === undefined ? { unavailable: turn.capabilityError ?? "console_capability_unavailable" } : {}),
          revoke: () => turn.revoke(),
        };
      } catch (error) {
        const unavailable = input.tools ? { unavailable: "console_capability_unavailable" } : {};
        if (key === undefined) return { ...none, ...unavailable };
        if (contexts.has(base)) {
          const project = contexts.get(base)!;
          options.logger?.warn?.("Web console unreachable; this Telegram turn uses the last known project context.", { code: errorCode(error) });
          const decorate = decorator(project);
          return { ...none, context: "cached", ...(decorate === undefined ? {} : { decorateUserMessage: decorate }), ...unavailable };
        }
        options.logger?.warn?.("Web console unreachable and no project context was fetched for this Telegram topic yet; continuing without project instructions.", { code: errorCode(error) });
        return { ...none, ...unavailable };
      }
    },
    async resolveDestination(projectId) {
      if (closed || options.sourceId === undefined) return { ok: false, code: "project_destinations_unavailable", message: "Project destinations are unavailable." };
      let resolved: { readonly key: string; readonly label: string };
      try {
        resolved = await resolveWebExternalProjectDestination({ sourceId: options.sourceId, channel: "telegram", projectId }, web);
      } catch (error) {
        const code = errorCode(error);
        return { ok: false, code, message: DESTINATION_MESSAGES[code] ?? "The web console could not resolve that project; it may be unreachable." };
      }
      const match = /^telegram:(\d{1,20}):(-?\d{1,20}):(main|\d{1,16})$/u.exec(resolved.key);
      if (match === null || match[1] !== botId) {
        return { ok: false, code: "project_not_linked", message: DESTINATION_MESSAGES.project_not_linked! };
      }
      const chatId = match[2]!;
      if (!options.isAllowedChat(chatId)) {
        return { ok: false, code: "telegram_chat_not_allowed", message: "That project's Telegram chat is not in the adapter allowlist." };
      }
      const conversationId = match[3] === "main" ? `telegram:${chatId}` : `telegram:${chatId}:${match[3]!}`;
      return { ok: true, conversationId, label: resolved.label };
    },
    async reportGone(conversationId) {
      const target = telegramTargetFromConversation(conversationId);
      if (closed || target === undefined || target.messageThreadId === undefined || options.sourceId === undefined) return;
      const key = telegramProjectKey(botId, target);
      if (key === undefined) return;
      directory.refreshOnNextSighting(String(target.chatId), target.messageThreadId);
      options.logger?.warn?.("A Telegram forum topic no longer exists; its project is marked as gone.");
      try {
        await markWebExternalConversationGone({ sourceId: options.sourceId, channel: "telegram", key }, web);
      } catch (error) {
        options.logger?.warn?.("The web console could not record a gone Telegram topic.", { code: errorCode(error) });
      }
    },
    async close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await syncing?.catch(() => undefined);
    },
  };
}

const DESTINATION_MESSAGES: Readonly<Record<string, string>> = {
  project_not_found: "No project has that id. Use ListProjects to find it.",
  project_not_linked: "That project is not linked to a Telegram topic.",
  external_conversation_gone: "That project's Telegram topic no longer exists. Ask the user where to send instead.",
  external_conversation_closed: "That project's Telegram topic is closed. Ask the user to reopen it in Telegram first.",
};

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  return /^[a-z_]{1,64}$/u.test(code) ? code : "web_console_unavailable";
}

/** Request metadata objects the Telegram channel issued a project turn for. Identity-keyed, never serialized. */
const telegramProjectTurns = new WeakMap<object, { readonly service: TelegramProjectsService; readonly conversationId: string; readonly human: boolean }>();

/** Bind a Telegram request to the service; only the app-owned channel driver calls this. */
export function bindTelegramProjectTurn(
  metadata: object,
  binding: { readonly service: TelegramProjectsService; readonly conversationId: string; readonly human: boolean },
): void {
  telegramProjectTurns.set(metadata, binding);
}

/** The binding the Telegram channel issued for this exact request, if any. */
export function telegramProjectTurnFor(metadata: object | undefined): { readonly service: TelegramProjectsService; readonly conversationId: string; readonly human: boolean } | undefined {
  return metadata === undefined ? undefined : telegramProjectTurns.get(metadata);
}
