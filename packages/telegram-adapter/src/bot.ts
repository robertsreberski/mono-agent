import { isAgentResponseCancelledError } from "@mono-agent/agent-contracts";
import { run, type RunnerHandle, type RunOptions } from "@grammyjs/runner";
import { Bot, type Context } from "grammy";

import {
  DEFAULT_MESSAGES,
  buildAgentRequest,
  downloadTelegramAttachments,
  finishSafely,
  mergeTelegramMessageInputs,
  normalizeTelegramMessageInput,
  resolveErrorText,
  type AgentResponder,
  type AgentResponse,
  type DownloadTelegramAttachmentsOptions,
  type TelegramAgentMessageInput,
  type TelegramAdapterLogger,
  type TelegramAdapterMessages,
  type TelegramAdapterStreamOptions,
  type TelegramFileDownloader,
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
// Quiet window after the last album message before we flush the group as one
// request. Telegram sends album parts back-to-back (sub-second), so ~1s is safe.
const DEFAULT_ALBUM_AGGREGATION_DELAY_MS = 1000;

/**
 * Minimal per-conversation serial queue: each submitted task runs only after the
 * previous one settles, preserving arrival order. A task's failure does not
 * poison the queue (the chain swallows it; the caller still sees the rejection).
 */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.depth += 1;
    const result = this.tail.then(() => task());
    this.tail = result.then(() => undefined, () => undefined);
    void result.then(
      () => { this.depth -= 1; },
      () => { this.depth -= 1; },
    );
    return result;
  }

  /** True when no task is queued or running. */
  get idle(): boolean {
    return this.depth === 0;
  }
}

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
  /**
   * Quiet window (ms) for aggregating a multi-photo/video album (messages sharing
   * a `media_group_id`) into one request. Defaults to 1000. Set 0 to flush on the
   * next tick (used by tests).
   */
  readonly albumAggregationDelayMs?: number;
  /** Delete any configured webhook before polling. Defaults to true. */
  readonly deleteWebhookOnStart?: boolean;
  /** Drop updates queued before start. Defaults to false. */
  readonly dropPendingUpdates?: boolean;
  /**
   * Called when polling crashes after a successful start (the runner's task
   * rejects). Lets a host mark the channel failed instead of leaving it running.
   */
  readonly onPollingError?: (error: unknown) => void;
  /**
   * Inbound attachment download tuning (byte cap + MIME allowlist). Inbound
   * Telegram media bytes are fetched via the Bot API and inlined into
   * `request.attachments`; failures skip the attachment without failing the run.
   */
  readonly attachments?: DownloadTelegramAttachmentsOptions;
  /** Test seam: build the grammY Bot (e.g. with a fake botInfo + transformer). */
  readonly botFactory?: (token: string) => Bot;
  /**
   * Test seam: override the file downloader (getFile + file URL fetch). Defaults
   * to one backed by `bot.api.getFile` and `fetch` against the Telegram file URL.
   */
  readonly fileDownloaderFactory?: (bot: Bot, token: string) => TelegramFileDownloader;
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

type TelegramControlCommand = "start" | "help" | "cancel";

/**
 * Build a grammY bot that routes authorized text messages to an agent responder.
 *
 * grammY owns the transport and (via `@grammyjs/runner`) concurrent polling.
 * Middleware order is: authorization gate → `/start` `/help` `/cancel` commands →
 * agent run handler (`message:text`) → unsupported fallback (other messages).
 *
 * Concurrency is NOT rejected per chat. Every message is handed to the responder,
 * which routes through the runtime harness; the harness serializes per
 * conversation (queue-after-turn follow-ups answered on the warm session). For
 * each in-flight message the bot tracks an `AbortController` in a per-chat set so
 * `/cancel` can abort every live turn for the chat (in addition to clearing
 * queued follow-ups via `responder.cancel`).
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
  // Per-chat set of AbortControllers for in-flight messages. The runtime harness
  // serializes turns per conversation, so we never reject concurrent messages —
  // we only track them so `/cancel` can abort every live turn for the chat.
  const activeControllers = new Map<string, Set<AbortController>>();

  /**
   * Create and register a fresh AbortController for a chat BEFORE the turn is
   * admitted to the per-chat queue. Registering eagerly means a /cancel can abort
   * a message that is still parked behind an earlier run (the controller would
   * otherwise not exist until the queue reached its runAgentTurn).
   */
  function registerController(chatId: TelegramChatId): AbortController {
    const key = String(chatId);
    const controller = new AbortController();
    const controllers = activeControllers.get(key);
    if (controllers === undefined) {
      activeControllers.set(key, new Set([controller]));
    } else {
      controllers.add(controller);
    }
    return controller;
  }
  // Per-conversation admission queue. grammY (via @grammyjs/runner) dispatches
  // updates concurrently, and the pre-respond work (status + attachment download)
  // is variable latency, so without this a later text-only message could reach
  // responder.respond() (and the harness FIFO) before an earlier still-downloading
  // media message in the same chat — and many same-chat downloads would run
  // unbounded. We serialize runAgentTurn per chat to preserve arrival order and
  // bound concurrent same-chat downloads. /cancel stays out-of-band (it never
  // enters this queue, so a queued turn can never block cancellation).
  const admissionQueues = new Map<string, SerialQueue>();
  // Set in stop() so a pending album timer (or a late update) cannot fire a turn
  // after the channel was torn down. Mirrors the slack/whatsapp adapters.
  let stopped = false;

  // Telegram delivers a multi-photo/video album as N separate messages sharing a
  // `media_group_id`, arriving back-to-back. We buffer them per group and flush
  // once after a short quiet window so the album becomes ONE request with all
  // attachments (the caption rides on only one message).
  const albumBuffers = new Map<string, {
    readonly ctx: Context;
    readonly messages: TelegramMessage[];
    timer: ReturnType<typeof setTimeout>;
  }>();
  const albumDelayMs = options.albumAggregationDelayMs ?? DEFAULT_ALBUM_AGGREGATION_DELAY_MS;

  const cancelChat = (chatId: TelegramChatId): void => {
    const conversationId = `telegram:${String(chatId)}`;
    // Clear queued follow-ups (and signal the harness to abort the in-flight
    // turn) first, then abort every controller we are tracking for this chat.
    options.responder.cancel?.(conversationId);
    const controllers = activeControllers.get(String(chatId));
    if (controllers !== undefined) {
      for (const controller of controllers) {
        controller.abort(new Error("Cancelled by Telegram user."));
      }
    }
    // Drop any album still buffering for this chat so /cancel does not leave it
    // to fire a turn after the user asked to stop.
    for (const [key, buffer] of albumBuffers) {
      if (key.startsWith(`${String(chatId)}:`)) {
        clearTimeout(buffer.timer);
        albumBuffers.delete(key);
      }
    }
  };

  const bot = options.botFactory?.(options.botToken) ?? new Bot(options.botToken);
  const sender = createGrammyTelegramApi(bot.api);
  const fileDownloader =
    options.fileDownloaderFactory?.(bot, options.botToken) ??
    createDefaultFileDownloader(bot, options.botToken, {
      ...(options.attachments?.downloadTimeoutMs !== undefined
        ? { downloadTimeoutMs: options.attachments.downloadTimeoutMs }
        : {}),
      ...(logger !== undefined ? { logger } : {}),
    });

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
      cancelChat(chatId);
    }
    await ctx.reply(messages.cancelledText);
  });

  // A single handler for every message type so all messages reach the per-chat
  // admission queue at the same middleware depth. Separate per-type handlers sit
  // at different filter positions, and grammY yields a microtask per non-matching
  // filter — so a later text message (matched by the first `message:text` filter)
  // could overtake an earlier document/photo (filtered one step further) before
  // admission, breaking arrival order. handleAgentMessage routes supported types
  // and replies unsupportedText for the rest (normalizeTelegramMessageInput
  // returns undefined), so a single `message` handler covers both cases.
  bot.on("message", async (ctx) => {
    await handleAgentMessage(ctx);
  });

  /**
   * Run a turn through the per-chat admission queue so same-chat turns serialize
   * (preserving harness FIFO arrival order and bounding concurrent same-chat
   * downloads). Cross-chat concurrency is preserved because queues are keyed per
   * chat id (the same key /cancel uses for activeControllers).
   */
  async function admit(
    chatId: TelegramChatId,
    task: () => Promise<void>,
  ): Promise<void> {
    const key = String(chatId);
    let queue = admissionQueues.get(key);
    if (queue === undefined) {
      queue = new SerialQueue();
      admissionQueues.set(key, queue);
    }
    try {
      await queue.run(task);
    } finally {
      if (queue.idle && admissionQueues.get(key) === queue) {
        admissionQueues.delete(key);
      }
    }
  }

  async function handleAgentMessage(ctx: Context): Promise<void> {
    if (stopped) {
      return;
    }
    const message = ctx.message;
    const chatId = ctx.chat?.id;
    if (message === undefined || chatId === undefined) {
      return;
    }
    const telegramMessage = message as unknown as TelegramMessage;

    // A multi-photo/video album arrives as several messages sharing a
    // media_group_id; buffer them and flush once so the agent sees one request
    // with every attachment instead of N single-attachment turns.
    const groupId = telegramMessage.media_group_id;
    if (typeof groupId === "string" && groupId.length > 0) {
      bufferAlbumMessage(ctx, chatId, groupId, telegramMessage);
      return;
    }

    const captionCommand = controlCommandFromCaption(telegramMessage, ctx.me.username);
    if (captionCommand !== undefined) {
      await handleControlCommand(ctx, captionCommand);
      return;
    }

    const input = normalizeTelegramMessageInput(telegramMessage);
    if (input === undefined) {
      await ctx.reply(messages.unsupportedText);
      return;
    }
    // Register the controller before admission so /cancel can abort this message
    // even while it is still parked behind an earlier same-chat run.
    const controller = registerController(chatId);
    await admit(chatId, () => runAgentTurn(ctx, telegramMessage, input, controller));
  }

  function bufferAlbumMessage(
    ctx: Context,
    chatId: TelegramChatId,
    groupId: string,
    message: TelegramMessage,
  ): void {
    const key = `${String(chatId)}:${groupId}`;
    const schedule = (): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(() => {
        void flushAlbum(key);
      }, albumDelayMs);
      timer.unref?.();
      return timer;
    };
    const existing = albumBuffers.get(key);
    if (existing === undefined) {
      albumBuffers.set(key, { ctx, messages: [message], timer: schedule() });
      return;
    }
    existing.messages.push(message);
    clearTimeout(existing.timer);
    existing.timer = schedule();
  }

  async function flushAlbum(key: string): Promise<void> {
    if (stopped) {
      return;
    }
    const buffer = albumBuffers.get(key);
    if (buffer === undefined) {
      return;
    }
    albumBuffers.delete(key);
    const { ctx, messages: parts } = buffer;

    // A control command in any album caption controls the chat.
    for (const part of parts) {
      const command = controlCommandFromCaption(part, ctx.me.username);
      if (command !== undefined) {
        await handleControlCommand(ctx, command);
        return;
      }
    }

    const primary = parts[0];
    const input = mergeTelegramMessageInputs(parts);
    if (primary === undefined || input === undefined) {
      await ctx.reply(messages.unsupportedText);
      return;
    }
    const controller = registerController(primary.chat.id);
    await admit(primary.chat.id, () => runAgentTurn(ctx, primary, input, controller));
  }

  async function runAgentTurn(
    ctx: Context,
    message: TelegramMessage,
    input: TelegramAgentMessageInput,
    controller: AbortController,
  ): Promise<void> {
    const chatId = message.chat.id;
    const key = String(chatId);
    // The AbortController is created and registered in activeControllers by the
    // caller BEFORE admission, so a /cancel can abort a message still parked in the
    // per-chat queue (the controller would otherwise not exist until the queue
    // reached this run). This function owns unregistering it in the finally below.

    // Download attachment bytes (best-effort) before handing the request to the
    // responder. Failures skip the attachment; the run proceeds regardless. The
    // download is tied to this message's abort signal.
    let resolvedAttachments: Awaited<ReturnType<typeof downloadTelegramAttachments>> = [];
    if (input.attachments.length > 0 && !controller.signal.aborted) {
      const downloadOptions: DownloadTelegramAttachmentsOptions = {
        ...options.attachments,
        ...(logger !== undefined ? { logger } : {}),
      };
      resolvedAttachments = await downloadTelegramAttachments(
        input.attachments,
        fileDownloader,
        controller.signal,
        downloadOptions,
      );
    }

    const request = buildAgentRequest(
      ctx.update as unknown as TelegramUpdate,
      message as unknown as TelegramMessage,
      input,
      controller.signal,
      resolvedAttachments,
    );
    const stream = new TelegramMessageStream(
      buildStreamOptions(chatId, message.message_id, controller.signal),
    );

    try {
      // Parked-then-cancelled: /cancel aborted this controller while the message
      // waited behind an earlier same-chat run. Bail before any responder call so a
      // queued message is genuinely cancelled (not run on the warm session later).
      if (controller.signal.aborted) {
        await finishSafely(stream, messages.cancelledText, logger);
        return;
      }
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
      const set = activeControllers.get(key);
      if (set !== undefined) {
        set.delete(controller);
        if (set.size === 0) {
          activeControllers.delete(key);
        }
      }
    }
  }

  async function handleControlCommand(
    ctx: Context,
    command: TelegramControlCommand,
  ): Promise<void> {
    if (command === "start") {
      await ctx.reply(messages.welcomeText);
      return;
    }
    if (command === "help") {
      await ctx.reply(messages.helpText);
      return;
    }
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      cancelChat(chatId);
    }
    await ctx.reply(messages.cancelledText);
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
      // Default to "typing…" + final-answer-only delivery (no streamed interim
      // edits); a tuning override can restore interim streaming.
      finalOnly: options.stream?.finalOnly ?? true,
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
    if (tuning?.showHints !== undefined) {
      streamOptions.showHints = tuning.showHints;
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
      // Guard the timer/late-update paths first: a pending album timer must not
      // flush a turn after teardown. Clear every outstanding album timer and drop
      // the buffers (mirrors cancelChat's per-chat cleanup, but for all chats).
      stopped = true;
      for (const buffer of albumBuffers.values()) {
        clearTimeout(buffer.timer);
      }
      albumBuffers.clear();
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

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

interface DefaultFileDownloaderOptions {
  /** Per-file download timeout (ms), composed with the run abort signal. Default 30000. */
  readonly downloadTimeoutMs?: number;
  readonly logger?: TelegramAdapterLogger;
}

/**
 * Default {@link TelegramFileDownloader}: resolve a `file_id` to a `file_path`
 * via `bot.api.getFile`, then download it from the Telegram file URL
 * (`https://api.telegram.org/file/bot<token>/<file_path>`) with `fetch`. Both
 * calls honor the request abort signal.
 *
 * The download is hardened against oversized/stale-`file_size` bodies: a
 * `Content-Length` header over the cap is rejected before reading the body, and
 * the body is streamed with a running byte counter that cancels the reader the
 * moment the cap is exceeded (so the whole payload is never buffered first). A
 * `downloadTimeoutMs` timer is composed with the run signal so a stalled
 * transfer is bounded by a dedicated timeout, not just the overall run.
 */
function createDefaultFileDownloader(
  bot: Bot,
  token: string,
  options?: DefaultFileDownloaderOptions,
): TelegramFileDownloader {
  const timeoutMs = options?.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  return {
    async resolveFilePath(fileId, signal): Promise<string | undefined> {
      const file = await bot.api.getFile(fileId, signal as unknown as Parameters<typeof bot.api.getFile>[1]);
      return file.file_path;
    },
    async download(filePath, signal, maxBytes): Promise<Uint8Array> {
      const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
      const { signal: fetchSignal, cleanup } = composeDownloadSignal(signal, timeoutMs);
      try {
        const response = await fetch(url, fetchSignal === undefined ? {} : { signal: fetchSignal });
        if (!response.ok) {
          throw new Error(`Telegram file download failed with status ${response.status}.`);
        }
        // Early skip: a declared Content-Length over the cap means we never read
        // the body at all (the adapter turns the throw into a logged skip).
        if (maxBytes !== undefined) {
          const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
          if (Number.isFinite(declared) && declared > maxBytes) {
            throw new Error("Telegram file exceeded the configured byte cap (Content-Length).");
          }
        }
        return await readBodyWithCap(response, maxBytes);
      } finally {
        cleanup();
      }
    },
  };
}

/**
 * Compose a `downloadTimeoutMs` timer with the run abort signal into a single
 * signal for `fetch`. The returned `cleanup` clears the timer (and detaches the
 * forwarding listener) in every path so no timer leaks/keeps the loop alive.
 */
function composeDownloadSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal?: AbortSignal; cleanup: () => void } {
  const shouldUseTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!shouldUseTimeout) {
    if (externalSignal === undefined) {
      return { cleanup: () => undefined };
    }
    return { signal: externalSignal, cleanup: () => undefined };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("Telegram file download timed out."));
  }, timeoutMs);
  timer.unref?.();

  const forwardAbort = (): void => {
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      forwardAbort();
    } else {
      externalSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

/**
 * Read a response body into a single `Uint8Array`, rejecting once `maxBytes` is
 * exceeded. Streams the body where possible so an oversized file is abandoned
 * without buffering the whole thing; falls back to an `arrayBuffer()` read (still
 * cap-checked) when the runtime exposes no readable stream.
 */
async function readBodyWithCap(
  response: Response,
  maxBytes: number | undefined,
): Promise<Uint8Array> {
  const cap =
    maxBytes !== undefined && Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : undefined;

  const body = response.body;
  if (body === null || typeof body.getReader !== "function") {
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (cap !== undefined && bytes.byteLength > cap) {
      throw new Error("Telegram file exceeded the configured byte cap.");
    }
    return bytes;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (cap !== undefined && total > cap) {
        await reader.cancel();
        throw new Error("Telegram file exceeded the configured byte cap.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function controlCommandFromCaption(
  message: TelegramMessage,
  botUsername: string | undefined,
): TelegramControlCommand | undefined {
  if (message.text !== undefined || message.caption === undefined) {
    return undefined;
  }
  const match = message.caption.trim().match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/u);
  const command = match?.[1]?.toLowerCase();
  const target = match?.[2]?.toLowerCase();
  if (target !== undefined) {
    if (botUsername === undefined || target !== botUsername.toLowerCase()) {
      return undefined;
    }
  }
  return command === "start" || command === "help" || command === "cancel"
    ? command
    : undefined;
}
