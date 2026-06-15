import { isAgentResponseCancelledError } from "@mono-agent/agent-contracts";
import { run, type RunnerHandle, type RunOptions } from "@grammyjs/runner";
import { Bot, type Context } from "grammy";

import {
  DEFAULT_MESSAGES,
  buildAgentRequest,
  finishSafely,
  resolveErrorText,
  type AgentResponder,
  type AgentResponse,
  type TelegramAdapterLogger,
  type TelegramAdapterMessages,
  type TelegramAdapterStreamOptions,
} from "./adapter.js";
import { createGrammyTelegramApi } from "./grammy-client.js";
import {
  TelegramMessageStream,
  type TelegramMessageStreamOptions,
} from "./message-stream.js";
import type { TelegramChatId, TelegramMessage, TelegramUpdate } from "./types.js";

type RunnerFetchOptions = NonNullable<NonNullable<RunOptions<Context>["runner"]>["fetch"]>;
type AllowedUpdates = NonNullable<RunnerFetchOptions["allowed_updates"]>;

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking…";

export interface CreateTelegramBotOptions {
  readonly botToken: string;
  readonly responder: AgentResponder;
  readonly allowedChatIds?: readonly TelegramChatId[];
  readonly allowAllChats?: boolean;
  readonly stream?: TelegramAdapterStreamOptions;
  readonly messages?: TelegramAdapterMessages;
  readonly logger?: TelegramAdapterLogger;
  /** Update types to long-poll for. Defaults to messages only. */
  readonly allowedUpdates?: readonly string[];
  /** Delete any configured webhook before polling. Defaults to true. */
  readonly deleteWebhookOnStart?: boolean;
  /** Drop updates queued before start. Defaults to false. */
  readonly dropPendingUpdates?: boolean;
  /**
   * Called when polling crashes after a successful start (the runner's task
   * rejects). Lets a host mark the channel failed instead of leaving it running.
   */
  readonly onPollingError?: (error: unknown) => void;
  /** Test seam: build the grammY Bot (e.g. with a fake botInfo + transformer). */
  readonly botFactory?: (token: string) => Bot;
  /** Test seam: build the polling runner. Defaults to `@grammyjs/runner`'s `run`. */
  readonly runnerFactory?: (bot: Bot) => RunnerHandle;
}

export interface TelegramBotController {
  /** The configured grammY bot. Exposed mainly so tests can drive `handleUpdate`. */
  readonly bot: Bot;
  /** Start concurrent long polling. Idempotent while already running. */
  start(): Promise<void>;
  /** Stop polling and wait for the runner to settle. */
  stop(): Promise<void>;
}

interface ActiveRun {
  controller: AbortController;
}

/**
 * Build a grammY bot that routes authorized text messages to an agent responder.
 *
 * grammY owns the transport and (via `@grammyjs/runner`) concurrent polling.
 * Middleware order is: authorization gate → `/start` `/help` `/cancel` commands →
 * agent run handler (`message:text`) → unsupported fallback (other messages).
 *
 * Per-chat concurrency is guarded by an `activeRuns` map: a run is recorded
 * synchronously at handler entry, so a second message arriving for the same chat
 * mid-run gets a "busy" reply rather than starting a competing run. The long run
 * is intentionally NOT sequentialized, which is what makes "busy" reachable.
 */
export function createTelegramBot(options: CreateTelegramBotOptions): TelegramBotController {
  const allowAllChats = options.allowAllChats === true;
  const allowedChatIds = new Set((options.allowedChatIds ?? []).map((id) => String(id)));
  if (!allowAllChats && allowedChatIds.size === 0) {
    throw new TypeError("createTelegramBot requires allowedChatIds or allowAllChats: true.");
  }

  const messages: Required<TelegramAdapterMessages> = { ...DEFAULT_MESSAGES, ...options.messages };
  const logger = options.logger;
  const initialStatusText = options.stream?.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT;
  const activeRuns = new Map<string, ActiveRun>();

  const bot = options.botFactory?.(options.botToken) ?? new Bot(options.botToken);
  const sender = createGrammyTelegramApi(bot.api);

  const isAuthorized = (chatId: TelegramChatId | undefined): boolean =>
    chatId !== undefined && (allowAllChats || allowedChatIds.has(String(chatId)));

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      return;
    }
    if (!isAuthorized(chatId)) {
      await ctx.reply(messages.unauthorizedText);
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(messages.welcomeText);
  });
  bot.command("help", async (ctx) => {
    await ctx.reply(messages.helpText);
  });
  bot.command("cancel", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      activeRuns.get(String(chatId))?.controller.abort(new Error("Cancelled by Telegram user."));
    }
    await ctx.reply(messages.cancelledText);
  });

  bot.on("message:text", async (ctx) => {
    await handleAgentMessage(ctx);
  });
  bot.on("message", async (ctx) => {
    await ctx.reply(messages.unsupportedText);
  });

  async function handleAgentMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    const chatId = ctx.chat?.id;
    if (message === undefined || chatId === undefined) {
      return;
    }

    const text = (message.text ?? "").trim();
    if (text.length === 0) {
      await ctx.reply(messages.unsupportedText);
      return;
    }

    const key = String(chatId);
    if (activeRuns.has(key)) {
      await ctx.reply(messages.busyText);
      return;
    }

    // Record the run synchronously, before any await, so a concurrent message for
    // the same chat observes it and gets the "busy" reply above.
    const controller = new AbortController();
    const activeRun: ActiveRun = { controller };
    activeRuns.set(key, activeRun);

    const request = buildAgentRequest(
      ctx.update as unknown as TelegramUpdate,
      message as unknown as TelegramMessage,
      text,
      controller.signal,
    );
    const stream = new TelegramMessageStream(
      buildStreamOptions(chatId, message.message_id, controller.signal),
    );

    try {
      try {
        await stream.status(initialStatusText);
      } catch (statusError) {
        logger?.warn?.("Telegram initial status send failed; continuing to the agent run.", {
          error: errorMessage(statusError),
        });
      }
      if (controller.signal.aborted) {
        await finishSafely(stream, messages.cancelledText, logger);
        return;
      }

      let response: AgentResponse;
      try {
        response = await options.responder.respond(request, stream);
      } catch (error) {
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          await finishSafely(stream, messages.cancelledText, logger);
          return;
        }
        logger?.error?.("Telegram bot responder failed.", { error: errorMessage(error) });
        const errorText = await resolveErrorText({
          configured: messages.errorText,
          error,
          request,
          logger,
        });
        await finishSafely(stream, errorText, logger);
        return;
      }

      if (controller.signal.aborted) {
        await finishSafely(stream, messages.cancelledText, logger);
        return;
      }

      try {
        await stream.finish(response.text);
      } catch (error) {
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          return;
        }
        // The AI run succeeded; a delivery failure is degraded, never an error.
        logger?.error?.("Telegram final delivery failed after a successful AI run.", {
          error: errorMessage(error),
        });
      }
    } finally {
      if (activeRuns.get(key) === activeRun) {
        activeRuns.delete(key);
      }
    }
  }

  function buildStreamOptions(
    chatId: TelegramChatId,
    replyToMessageId: number,
    signal: AbortSignal,
  ): TelegramMessageStreamOptions {
    const streamOptions: TelegramMessageStreamOptions = {
      api: sender,
      chatId,
      replyToMessageId,
      abortSignal: signal,
    };
    const tuning = options.stream;
    if (tuning?.initialStatusText !== undefined) {
      streamOptions.initialStatusText = tuning.initialStatusText;
    }
    if (tuning?.editDebounceMs !== undefined) {
      streamOptions.editDebounceMs = tuning.editDebounceMs;
    }
    if (tuning?.maxMessageChars !== undefined) {
      streamOptions.maxMessageChars = tuning.maxMessageChars;
    }
    if (tuning?.maxSendRetries !== undefined) {
      streamOptions.maxSendRetries = tuning.maxSendRetries;
    }
    if (tuning?.retryCapMs !== undefined) {
      streamOptions.retryCapMs = tuning.retryCapMs;
    }
    if (tuning?.retryBaseDelayMs !== undefined) {
      streamOptions.retryBaseDelayMs = tuning.retryBaseDelayMs;
    }
    if (tuning?.showThoughts !== undefined) {
      streamOptions.showThoughts = tuning.showThoughts;
    }
    if (tuning?.formatMarkdown !== undefined) {
      streamOptions.formatMarkdown = tuning.formatMarkdown;
    }
    if (logger !== undefined) {
      streamOptions.logger = logger;
    }
    return streamOptions;
  }

  let runnerHandle: RunnerHandle | undefined;

  return {
    bot,
    async start(): Promise<void> {
      if (runnerHandle?.isRunning() === true) {
        return;
      }
      if ((options.deleteWebhookOnStart ?? true) === true) {
        await bot.api.deleteWebhook({ drop_pending_updates: options.dropPendingUpdates ?? false });
      }
      runnerHandle = (options.runnerFactory ?? defaultRunnerFactory)(bot);
      // Surface a late polling crash to the shared logger and the host's
      // onPollingError callback without leaving an unhandled rejection; stop()
      // still settles the runner independently.
      runnerHandle.task?.()?.catch((error: unknown) => {
        logger?.error?.("Telegram polling stopped with an error.", {
          error: errorMessage(error),
        });
        options.onPollingError?.(error);
      });
    },
    async stop(): Promise<void> {
      if (runnerHandle?.isRunning() === true) {
        await runnerHandle.stop();
      }
      runnerHandle = undefined;
    },
  };

  function defaultRunnerFactory(target: Bot): RunnerHandle {
    const allowed = [...(options.allowedUpdates ?? ["message"])] as unknown as AllowedUpdates;
    return run(target, { runner: { fetch: { allowed_updates: allowed } } });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
