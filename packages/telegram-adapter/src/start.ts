import type { RunnerHandle } from "@grammyjs/runner";
import type { Bot } from "grammy";

import type {
  AgentResponder,
  DownloadTelegramAttachmentsOptions,
  TelegramAdapterLogger,
  TelegramAdapterMessages,
  TelegramAdapterStreamOptions,
} from "./adapter.js";
import {
  createTelegramBot,
  type CreateTelegramBotOptions,
  type TelegramNotifyOptions,
  type TelegramNotifyResult,
} from "./bot.js";
import type { TelegramCommandConfig } from "./config.js";
import type { TelegramChatId } from "./types.js";

export type { TelegramNotifyOptions, TelegramNotifyResult } from "./bot.js";

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
  /**
   * Inbound attachment download tuning (byte cap + MIME allowlist + timeout).
   * Inbound Telegram media bytes are fetched via the Bot API and inlined into
   * `request.attachments`; failures skip the attachment without failing the run.
   */
  readonly attachments?: DownloadTelegramAttachmentsOptions;
  /** Restrict the update types polled from Telegram. Defaults to messages only. */
  readonly allowedUpdates?: readonly string[];
  /** Custom command-menu entries registered via setMyCommands and dispatched as turns. */
  readonly commands?: readonly TelegramCommandConfig[];
  /** React to inbound messages with a lifecycle emoji (👀/👍/👎). Default off. */
  readonly reactions?: boolean;
  /** Subscribe to and handle inline-keyboard taps (telegram_ask callbacks). Default off. */
  readonly callbacksEnabled?: boolean;
  /** Delete any configured webhook before polling. Defaults to true. */
  readonly deleteWebhookOnStart?: boolean;
  /** Bound (ms) for the startup deleteWebhook call so a flaky network can't stall boot. Default 5000. */
  readonly deleteWebhookTimeoutMs?: number;
  /** Drop updates queued before start. Defaults to false. */
  readonly dropPendingUpdates?: boolean;
  /** Pin the Bot API HTTP client to IPv4 (`4`) or IPv6 (`6`). Omit for dual-stack. */
  readonly transport?: { readonly ipFamily?: 4 | 6 };
  /** Poll-liveness watchdog window (ms). Default 120000; set <= 0 to disable. */
  readonly pollWatchdogMs?: number;
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
  /**
   * Deliver a proactive notification to a chat, serialized through that chat's
   * per-chat queue. By default runs `text` as a turn and posts the answer; with
   * `options.verbatim` posts `text` unchanged (no model call) and records it to
   * history. Used by cron/webhook nudges so the destination channel — not a side
   * channel — owns the message.
   */
  notify(chatId: TelegramChatId, text: string, options?: TelegramNotifyOptions): Promise<TelegramNotifyResult>;
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
    notify: (chatId, text, notifyOptions) => controller.notify(chatId, text, notifyOptions),
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
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.allowedUpdates === undefined ? {} : { allowedUpdates: options.allowedUpdates }),
    ...(options.commands === undefined ? {} : { commands: options.commands }),
    ...(options.reactions === undefined ? {} : { reactions: options.reactions }),
    ...(options.callbacksEnabled === undefined ? {} : { callbacksEnabled: options.callbacksEnabled }),
    ...(options.deleteWebhookOnStart === undefined
      ? {}
      : { deleteWebhookOnStart: options.deleteWebhookOnStart }),
    ...(options.deleteWebhookTimeoutMs === undefined
      ? {}
      : { deleteWebhookTimeoutMs: options.deleteWebhookTimeoutMs }),
    ...(options.dropPendingUpdates === undefined
      ? {}
      : { dropPendingUpdates: options.dropPendingUpdates }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.pollWatchdogMs === undefined ? {} : { pollWatchdogMs: options.pollWatchdogMs }),
    ...(options.onPollingError === undefined ? {} : { onPollingError: options.onPollingError }),
    ...(options.botFactory === undefined ? {} : { botFactory: options.botFactory }),
    ...(options.runnerFactory === undefined ? {} : { runnerFactory: options.runnerFactory }),
  };
}
