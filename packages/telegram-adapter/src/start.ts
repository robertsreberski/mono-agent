import {
  TelegramAdapter,
  type AgentResponder,
  type TelegramAdapterLogger,
  type TelegramAdapterMessages,
  type TelegramAdapterStreamOptions,
} from "./adapter.js";
import {
  TelegramLongPoller,
  type TelegramLongPollerOptions,
  type TelegramLongPollerStartOptions,
} from "./long-poller.js";
import {
  TelegramBotApiClient,
  type TelegramBotApiClientOptions,
} from "./telegram-client.js";
import type { TelegramBotApi, TelegramChatId } from "./types.js";

/**
 * Minimal surface a long poller must expose for {@link startTelegramAdapter} to
 * drive it. The real {@link TelegramLongPoller} satisfies this, and tests can
 * supply a fake via {@link TelegramAdapterStartOptions.pollerFactory}.
 */
export interface TelegramPollerLike {
  start(options?: TelegramLongPollerStartOptions): Promise<void>;
}

export interface TelegramAdapterStartOptions {
  /** Bot API token, used to construct the default {@link TelegramBotApiClient}. */
  readonly botToken: string;
  /** Allowlisted chat ids. Required unless {@link allowAllChats} is true. */
  readonly allowedChatIds?: readonly TelegramChatId[];
  /** Explicitly permit every chat. Leave off when using an allowlist. */
  readonly allowAllChats?: boolean;
  /** Responder the adapter routes authorized text updates to. */
  readonly responder: AgentResponder;
  /** Optional per-response stream tuning forwarded to the adapter. */
  readonly stream?: TelegramAdapterStreamOptions;
  /** Optional message-copy overrides forwarded to the adapter. */
  readonly messages?: TelegramAdapterMessages;
  /** Optional logger shared by the adapter, stream, and poller. */
  readonly logger?: TelegramAdapterLogger;
  /** Restrict the update types requested from Telegram. Defaults to messages only. */
  readonly allowedUpdates?: readonly string[];
  /** Delete any configured webhook before polling. Defaults to true. */
  readonly deleteWebhookOnStart?: boolean;
  /**
   * Override how the {@link TelegramBotApi} client is built. Defaults to a real
   * {@link TelegramBotApiClient}. Tests inject a fake to avoid hitting Telegram.
   */
  readonly clientFactory?: (options: TelegramBotApiClientOptions) => TelegramBotApi;
  /**
   * Override how the long poller is built. Defaults to a real
   * {@link TelegramLongPoller}. Tests inject a fake to assert wiring and stop.
   */
  readonly pollerFactory?: (options: TelegramLongPollerOptions) => TelegramPollerLike;
}

export interface TelegramAdapterStartResult {
  /** Stops the long poller cleanly and waits for the polling loop to settle. */
  stop(): Promise<void>;
}

/**
 * Composition-root entrypoint: builds the Telegram client, adapter, and long
 * poller from a single options bag and starts polling. Mirrors the HTTP
 * adapters' `startX(options): Promise<{ stop }>` shape so a host can launch
 * Telegram with one call.
 *
 * Fail-closed: the underlying {@link TelegramAdapter} throws when neither
 * {@link TelegramAdapterStartOptions.allowedChatIds} nor
 * {@link TelegramAdapterStartOptions.allowAllChats} is provided.
 */
export async function startTelegramAdapter(
  options: TelegramAdapterStartOptions,
): Promise<TelegramAdapterStartResult> {
  const buildClient = options.clientFactory ?? ((clientOptions) => new TelegramBotApiClient(clientOptions));
  const buildPoller = options.pollerFactory ?? ((pollerOptions) => new TelegramLongPoller(pollerOptions));

  const api = buildClient({ token: options.botToken });

  const adapter = new TelegramAdapter({
    api,
    responder: options.responder,
    ...(options.allowedChatIds === undefined ? {} : { allowedChatIds: [...options.allowedChatIds] }),
    ...(options.allowAllChats === undefined ? {} : { allowAllChats: options.allowAllChats }),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
    ...(options.messages === undefined ? {} : { messages: options.messages }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const poller = buildPoller({
    api,
    adapter,
    deleteWebhookOnStart: options.deleteWebhookOnStart ?? true,
    allowedUpdates: options.allowedUpdates === undefined ? ["message"] : [...options.allowedUpdates],
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const controller = new AbortController();
  const running = poller.start({ signal: controller.signal });
  // Surface late polling failures to the shared logger without leaving an
  // unhandled rejection; stop() still awaits this same promise.
  running.catch((error: unknown) => {
    if (!controller.signal.aborted) {
      options.logger?.error?.("Telegram polling stopped with an error.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  let stopped = false;
  return {
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      controller.abort();
      await running.catch(() => undefined);
    },
  };
}
