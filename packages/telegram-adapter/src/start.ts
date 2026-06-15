import type { RunnerHandle } from "@grammyjs/runner";
import type { Bot } from "grammy";

import type {
  AgentResponder,
  TelegramAdapterLogger,
  TelegramAdapterMessages,
  TelegramAdapterStreamOptions,
} from "./adapter.js";
import { createTelegramBot, type CreateTelegramBotOptions } from "./bot.js";
import type { TelegramChatId } from "./types.js";

export interface TelegramAdapterStartOptions {
  /** Bot API token used to construct the grammY {@link Bot}. */
  readonly botToken: string;
  /** Allowlisted chat ids. Required unless {@link allowAllChats} is true. */
  readonly allowedChatIds?: readonly TelegramChatId[];
  /** Explicitly permit every chat. Leave off when using an allowlist. */
  readonly allowAllChats?: boolean;
  /** Responder the bot routes authorized text messages to. */
  readonly responder: AgentResponder;
  /** Optional per-response stream tuning. */
  readonly stream?: TelegramAdapterStreamOptions;
  /** Optional message-copy overrides. */
  readonly messages?: TelegramAdapterMessages;
  /** Optional logger shared by the bot and stream. */
  readonly logger?: TelegramAdapterLogger;
  /** Restrict the update types polled from Telegram. Defaults to messages only. */
  readonly allowedUpdates?: readonly string[];
  /** Delete any configured webhook before polling. Defaults to true. */
  readonly deleteWebhookOnStart?: boolean;
  /** Drop updates queued before start. Defaults to false. */
  readonly dropPendingUpdates?: boolean;
  /** Called when polling crashes after a successful start (lets the host mark the channel failed). */
  readonly onPollingError?: (error: unknown) => void;
  /** Test seam: build the grammY {@link Bot}. */
  readonly botFactory?: (token: string) => Bot;
  /** Test seam: build the polling runner. */
  readonly runnerFactory?: (bot: Bot) => RunnerHandle;
}

export interface TelegramAdapterStartResult {
  /** Stops polling and waits for the runner to settle. */
  stop(): Promise<void>;
}

/**
 * Composition-root entrypoint: builds and starts a grammY-backed Telegram bot
 * from a single options bag. Mirrors the HTTP adapters' `startX(options):
 * Promise<{ stop }>` shape so a host can launch Telegram with one call.
 *
 * Fail-closed: {@link createTelegramBot} throws when neither
 * {@link TelegramAdapterStartOptions.allowedChatIds} nor
 * {@link TelegramAdapterStartOptions.allowAllChats} is provided.
 */
export async function startTelegramAdapter(
  options: TelegramAdapterStartOptions,
): Promise<TelegramAdapterStartResult> {
  const controller = createTelegramBot(toCreateOptions(options));
  await controller.start();
  return {
    stop: () => controller.stop(),
  };
}

function toCreateOptions(options: TelegramAdapterStartOptions): CreateTelegramBotOptions {
  return {
    botToken: options.botToken,
    responder: options.responder,
    ...(options.allowedChatIds === undefined ? {} : { allowedChatIds: options.allowedChatIds }),
    ...(options.allowAllChats === undefined ? {} : { allowAllChats: options.allowAllChats }),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
    ...(options.messages === undefined ? {} : { messages: options.messages }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.allowedUpdates === undefined ? {} : { allowedUpdates: options.allowedUpdates }),
    ...(options.deleteWebhookOnStart === undefined
      ? {}
      : { deleteWebhookOnStart: options.deleteWebhookOnStart }),
    ...(options.dropPendingUpdates === undefined
      ? {}
      : { dropPendingUpdates: options.dropPendingUpdates }),
    ...(options.onPollingError === undefined ? {} : { onPollingError: options.onPollingError }),
    ...(options.botFactory === undefined ? {} : { botFactory: options.botFactory }),
    ...(options.runnerFactory === undefined ? {} : { runnerFactory: options.runnerFactory }),
  };
}
