import type {
  TelegramBotApi,
  TelegramChatId,
  TelegramSentMessage,
} from "./types.js";

export interface AgentMessageStream {
  status(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace(text: string): Promise<void>;
  finish(finalText?: string): Promise<void>;
}

export interface TelegramMessageStreamOptions {
  api: TelegramBotApi;
  chatId: TelegramChatId;
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
  replyToMessageId?: number;
  logger?: TelegramMessageStreamLogger;
}

export interface TelegramMessageStreamLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking…";
const DEFAULT_EDIT_DEBOUNCE_MS = 750;
const DEFAULT_MAX_MESSAGE_CHARS = 3_800;
const EMPTY_FINAL_TEXT = "No response text was returned.";

export class TelegramMessageStream implements AgentMessageStream {
  private readonly api: TelegramBotApi;
  private readonly chatId: TelegramChatId;
  private readonly initialStatusText: string;
  private readonly editDebounceMs: number;
  private readonly maxMessageChars: number;
  private readonly replyToMessageId: number | undefined;
  private readonly logger: TelegramMessageStreamLogger | undefined;

  private currentText = "";
  private statusText: string;
  private sentMessage: TelegramSentMessage | undefined;
  private sendMessagePromise: Promise<TelegramSentMessage> | undefined;
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlightEdit: Promise<void> | undefined;
  private lastAsyncError: unknown;
  private finished = false;

  constructor(options: TelegramMessageStreamOptions) {
    this.api = options.api;
    this.chatId = options.chatId;
    this.initialStatusText = normalizeTelegramText(
      options.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT,
    );
    this.statusText = this.initialStatusText;
    this.editDebounceMs = options.editDebounceMs ?? DEFAULT_EDIT_DEBOUNCE_MS;
    this.maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    this.replyToMessageId = options.replyToMessageId;
    this.logger = options.logger;

    if (!Number.isInteger(this.maxMessageChars) || this.maxMessageChars < 32) {
      throw new RangeError("maxMessageChars must be an integer of at least 32.");
    }
    if (!Number.isFinite(this.editDebounceMs) || this.editDebounceMs < 0) {
      throw new RangeError("editDebounceMs must be a non-negative number.");
    }
  }

  async status(text: string): Promise<void> {
    this.assertOpen();
    await this.throwIfAsyncError();
    this.statusText = normalizeTelegramText(text);
    const hadMessage = this.sentMessage !== undefined;
    await this.ensureMessage();
    if (hadMessage) {
      await this.flushEdit(this.statusText);
    }
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    await this.throwIfAsyncError();
    if (delta.length === 0) {
      return;
    }

    this.currentText += delta;
    await this.ensureMessage();
    this.scheduleEdit();
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    await this.throwIfAsyncError();
    this.currentText = text;
    await this.ensureMessage();
    this.scheduleEdit();
  }

  async finish(finalText?: string): Promise<void> {
    if (this.finished) {
      return;
    }

    this.finished = true;
    if (finalText !== undefined) {
      this.currentText = finalText;
    }

    this.cancelScheduledEdit();
    await this.throwIfAsyncError();
    await this.awaitInFlightEdit();
    await this.throwIfAsyncError();

    const finalMessageText = normalizeTelegramText(
      this.currentText.length > 0 ? this.currentText : EMPTY_FINAL_TEXT,
    );
    const chunks = splitTelegramText(finalMessageText, this.maxMessageChars);
    const [firstChunk, ...remainingChunks] = chunks;

    await this.ensureMessage();
    await this.flushEdit(firstChunk ?? EMPTY_FINAL_TEXT);
    for (const chunk of remainingChunks) {
      await this.api.sendMessage({ chat_id: this.chatId, text: chunk });
    }
  }

  private async ensureMessage(): Promise<TelegramSentMessage> {
    if (this.sentMessage !== undefined) {
      return this.sentMessage;
    }

    if (this.sendMessagePromise === undefined) {
      const params: {
        chat_id: TelegramChatId;
        text: string;
        reply_to_message_id?: number;
      } = {
        chat_id: this.chatId,
        text: this.statusText,
      };
      if (this.replyToMessageId !== undefined) {
        params.reply_to_message_id = this.replyToMessageId;
      }

      this.sendMessagePromise = this.api.sendMessage(params);
    }

    this.sentMessage = await this.sendMessagePromise;
    return this.sentMessage;
  }

  private scheduleEdit(): void {
    this.cancelScheduledEdit();

    if (this.editDebounceMs === 0) {
      this.startInFlightEdit();
      return;
    }

    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      this.startInFlightEdit();
    }, this.editDebounceMs);
  }

  private startInFlightEdit(): void {
    const text = buildStreamingPreview(this.currentText, this.maxMessageChars);
    this.inFlightEdit = this.flushEdit(text).catch((error: unknown) => {
      this.lastAsyncError = error;
      this.logger?.error?.("Telegram stream edit failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
    void this.inFlightEdit.catch(() => undefined);
  }

  private async flushEdit(text: string): Promise<void> {
    const message = await this.ensureMessage();
    await this.api.editMessageText({
      chat_id: this.chatId,
      message_id: message.message_id,
      text: normalizeTelegramText(text),
    });
  }

  private cancelScheduledEdit(): void {
    if (this.editTimer !== undefined) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
  }

  private async awaitInFlightEdit(): Promise<void> {
    if (this.inFlightEdit !== undefined) {
      await this.inFlightEdit;
      this.inFlightEdit = undefined;
    }
  }

  private async throwIfAsyncError(): Promise<void> {
    if (this.inFlightEdit !== undefined) {
      await this.awaitInFlightEdit();
    }

    if (this.lastAsyncError !== undefined) {
      const error = this.lastAsyncError;
      this.lastAsyncError = undefined;
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error("Cannot write to a finished TelegramMessageStream.");
    }
  }
}

export function splitTelegramText(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars must be a positive integer.");
  }

  const normalized = normalizeTelegramText(text);
  const characters = Array.from(normalized);
  if (characters.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += maxChars) {
    chunks.push(characters.slice(index, index + maxChars).join(""));
  }

  return chunks;
}

function buildStreamingPreview(text: string, maxChars: number): string {
  const normalized = normalizeTelegramText(text);
  const characters = Array.from(normalized);
  if (characters.length <= maxChars) {
    return normalized;
  }

  const prefix = "…\n";
  const available = Math.max(1, maxChars - Array.from(prefix).length);
  return `${prefix}${characters.slice(-available).join("")}`;
}

function normalizeTelegramText(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > 0 ? trimmed : EMPTY_FINAL_TEXT;
}
