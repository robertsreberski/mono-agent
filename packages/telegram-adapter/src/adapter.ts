import type {
  AgentRequestBase,
  AgentResponder as SharedAgentResponder,
  AgentResponse,
} from "@mono-agent/agent-contracts";

import {
  TelegramMessageStream,
  type AgentMessageStream,
  type TelegramMessageStreamLogger,
} from "./message-stream.js";
import type {
  TelegramChatId,
  TelegramAudio,
  TelegramDocument,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
  TelegramUser,
  TelegramVideo,
  TelegramVoice,
} from "./types.js";

export type TelegramAttachmentKind = "document" | "photo" | "audio" | "video" | "voice";

export interface TelegramAttachmentBase {
  kind: TelegramAttachmentKind;
  fileId: string;
  fileUniqueId: string;
  fileSize?: number;
}

export interface TelegramDocumentAttachment extends TelegramAttachmentBase {
  kind: "document";
  fileName?: string;
  mimeType?: string;
}

export interface TelegramPhotoAttachmentSize {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
  fileSize?: number;
}

export interface TelegramPhotoAttachment extends TelegramAttachmentBase {
  kind: "photo";
  width: number;
  height: number;
  sizes: readonly TelegramPhotoAttachmentSize[];
}

export interface TelegramAudioAttachment extends TelegramAttachmentBase {
  kind: "audio";
  duration: number;
  fileName?: string;
  mimeType?: string;
}

export interface TelegramVideoAttachment extends TelegramAttachmentBase {
  kind: "video";
  duration: number;
  width: number;
  height: number;
  fileName?: string;
  mimeType?: string;
}

export interface TelegramVoiceAttachment extends TelegramAttachmentBase {
  kind: "voice";
  duration: number;
  mimeType?: string;
}

export type TelegramAttachment =
  | TelegramDocumentAttachment
  | TelegramPhotoAttachment
  | TelegramAudioAttachment
  | TelegramVideoAttachment
  | TelegramVoiceAttachment;

export interface TelegramAgentMessageInput {
  text: string;
  attachments: readonly TelegramAttachment[];
}

export interface AgentRequest extends AgentRequestBase {
  conversationId: string;
  chatId: TelegramChatId;
  messageId: number;
  updateId: number;
  userId?: number;
  username?: string;
  text: string;
  attachments?: readonly TelegramAttachment[];
  abortSignal: AbortSignal;
  metadata: {
    telegram: TelegramRequestMetadata;
    [key: string]: unknown;
  };
}

export interface TelegramRequestMetadata {
  updateId: number;
  chat: {
    id: TelegramChatId;
    type?: string;
    title?: string;
    username?: string;
  };
  message: {
    id: number;
    date?: number;
  };
  attachments?: readonly TelegramAttachment[];
  from?: {
    id: number;
    isBot?: boolean;
    username?: string;
    firstName?: string;
    lastName?: string;
    languageCode?: string;
  };
}

export type { AgentResponse };
export type AgentResponder = SharedAgentResponder<AgentRequest, AgentMessageStream, AgentResponse>;

export interface TelegramAdapterMessages {
  welcomeText?: string;
  helpText?: string;
  busyText?: string;
  unauthorizedText?: string;
  cancelledText?: string;
  errorText?: TelegramAdapterErrorText;
  unsupportedText?: string;
}

export type TelegramAdapterErrorText =
  | string
  | ((input: TelegramAdapterErrorTextInput) => string | Promise<string>);

export interface TelegramAdapterErrorTextInput {
  readonly error: unknown;
  readonly request: AgentRequest;
}

export interface TelegramAdapterStreamOptions {
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
  maxSendRetries?: number;
  retryCapMs?: number;
  retryBaseDelayMs?: number;
  showThoughts?: boolean;
  showHints?: boolean;
  formatMarkdown?: boolean;
}

export interface TelegramAdapterLogger extends TelegramMessageStreamLogger {
  info?(message: string, metadata?: Record<string, unknown>): void;
}

export const DEFAULT_ERROR_TEXT = "The agent failed while processing your message.";

export const DEFAULT_MESSAGES: Required<TelegramAdapterMessages> = {
  welcomeText:
    "Hello! Send text or Telegram media. I will pass captions and attachment metadata to the configured agent.",
  helpText:
    "Send text, documents, photos, audio, video, or voice messages. I forward captions and Telegram attachment metadata, not file contents. Use /cancel to stop the current response.",
  busyText: "I am still working on your previous message. Use /cancel to stop it.",
  unauthorizedText: "This Telegram chat is not authorized to use this bot.",
  cancelledText: "Cancelled.",
  errorText: DEFAULT_ERROR_TEXT,
  unsupportedText: "I can handle text and Telegram document, photo, audio, video, or voice metadata in this adapter.",
};

/**
 * Build the responder-facing {@link AgentRequest} from a Telegram update. The
 * grammY message handler passes `ctx.update` and `ctx.message`, which are
 * structurally compatible with the wire types this reads.
 */
export function buildAgentRequest(
  update: TelegramUpdate,
  message: TelegramMessage,
  input: TelegramAgentMessageInput,
  abortSignal: AbortSignal,
): AgentRequest {
  const from = metadataFromUser(message.from);
  const telegramMetadata: TelegramRequestMetadata = {
    updateId: update.update_id,
    chat: metadataFromChat(message.chat),
    message: metadataFromMessage(message),
  };
  if (input.attachments.length > 0) {
    telegramMetadata.attachments = input.attachments;
  }
  const request: AgentRequest = {
    conversationId: `telegram:${String(message.chat.id)}`,
    chatId: message.chat.id,
    messageId: message.message_id,
    updateId: update.update_id,
    text: input.text,
    abortSignal,
    metadata: {
      telegram: telegramMetadata,
    },
  };

  if (input.attachments.length > 0) {
    request.attachments = input.attachments;
  }
  if (message.from?.id !== undefined) {
    request.userId = message.from.id;
  }
  if (message.from?.username !== undefined) {
    request.username = message.from.username;
  }
  if (from !== undefined) {
    request.metadata.telegram.from = from;
  }

  return request;
}

export function normalizeTelegramMessageInput(
  message: TelegramMessage,
): TelegramAgentMessageInput | undefined {
  if (message.animation !== undefined) {
    return undefined;
  }
  const text = normalizeMessageText(message);
  const attachments = extractTelegramAttachments(message);
  if (text.length === 0 && attachments.length === 0) {
    return undefined;
  }
  return {
    text: text.length > 0 ? text : summarizeTelegramAttachments(attachments),
    attachments,
  };
}

function metadataFromChat(messageChat: TelegramMessage["chat"]): TelegramRequestMetadata["chat"] {
  const chat: TelegramRequestMetadata["chat"] = { id: messageChat.id };
  if (messageChat.type !== undefined) {
    chat.type = messageChat.type;
  }
  if (messageChat.title !== undefined) {
    chat.title = messageChat.title;
  }
  if (messageChat.username !== undefined) {
    chat.username = messageChat.username;
  }
  return chat;
}

function metadataFromMessage(
  message: TelegramMessage,
): TelegramRequestMetadata["message"] {
  const metadata: TelegramRequestMetadata["message"] = { id: message.message_id };
  if (message.date !== undefined) {
    metadata.date = message.date;
  }
  return metadata;
}

function normalizeMessageText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? "").trim();
}

function extractTelegramAttachments(message: TelegramMessage): readonly TelegramAttachment[] {
  const attachments: TelegramAttachment[] = [];
  const document = attachmentFromDocument(message.document);
  if (document !== undefined) {
    attachments.push(document);
  }
  const photo = attachmentFromPhoto(message.photo);
  if (photo !== undefined) {
    attachments.push(photo);
  }
  const audio = attachmentFromAudio(message.audio);
  if (audio !== undefined) {
    attachments.push(audio);
  }
  const video = attachmentFromVideo(message.video);
  if (video !== undefined) {
    attachments.push(video);
  }
  const voice = attachmentFromVoice(message.voice);
  if (voice !== undefined) {
    attachments.push(voice);
  }
  return attachments;
}

function attachmentFromDocument(
  document: TelegramDocument | undefined,
): TelegramDocumentAttachment | undefined {
  if (document === undefined) {
    return undefined;
  }
  const attachment: TelegramDocumentAttachment = {
    kind: "document",
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id,
  };
  addFileSize(attachment, document.file_size);
  if (document.file_name !== undefined) {
    attachment.fileName = document.file_name;
  }
  if (document.mime_type !== undefined) {
    attachment.mimeType = document.mime_type;
  }
  return attachment;
}

function attachmentFromPhoto(
  photos: TelegramPhotoSize[] | undefined,
): TelegramPhotoAttachment | undefined {
  const sizes = photos?.map(photoSizeFromTelegram).filter(isDefined) ?? [];
  if (sizes.length === 0) {
    return undefined;
  }
  const largest = sizes.reduce((best, candidate) =>
    candidate.width * candidate.height > best.width * best.height ? candidate : best,
  );
  const attachment: TelegramPhotoAttachment = {
    kind: "photo",
    fileId: largest.fileId,
    fileUniqueId: largest.fileUniqueId,
    width: largest.width,
    height: largest.height,
    sizes,
  };
  addFileSize(attachment, largest.fileSize);
  return attachment;
}

function attachmentFromAudio(audio: TelegramAudio | undefined): TelegramAudioAttachment | undefined {
  if (audio === undefined) {
    return undefined;
  }
  const attachment: TelegramAudioAttachment = {
    kind: "audio",
    fileId: audio.file_id,
    fileUniqueId: audio.file_unique_id,
    duration: audio.duration,
  };
  addFileSize(attachment, audio.file_size);
  if (audio.file_name !== undefined) {
    attachment.fileName = audio.file_name;
  }
  if (audio.mime_type !== undefined) {
    attachment.mimeType = audio.mime_type;
  }
  return attachment;
}

function attachmentFromVideo(video: TelegramVideo | undefined): TelegramVideoAttachment | undefined {
  if (video === undefined) {
    return undefined;
  }
  const attachment: TelegramVideoAttachment = {
    kind: "video",
    fileId: video.file_id,
    fileUniqueId: video.file_unique_id,
    duration: video.duration,
    width: video.width,
    height: video.height,
  };
  addFileSize(attachment, video.file_size);
  if (video.file_name !== undefined) {
    attachment.fileName = video.file_name;
  }
  if (video.mime_type !== undefined) {
    attachment.mimeType = video.mime_type;
  }
  return attachment;
}

function attachmentFromVoice(voice: TelegramVoice | undefined): TelegramVoiceAttachment | undefined {
  if (voice === undefined) {
    return undefined;
  }
  const attachment: TelegramVoiceAttachment = {
    kind: "voice",
    fileId: voice.file_id,
    fileUniqueId: voice.file_unique_id,
    duration: voice.duration,
  };
  addFileSize(attachment, voice.file_size);
  if (voice.mime_type !== undefined) {
    attachment.mimeType = voice.mime_type;
  }
  return attachment;
}

function photoSizeFromTelegram(
  size: TelegramPhotoSize,
): TelegramPhotoAttachmentSize | undefined {
  const attachmentSize: TelegramPhotoAttachmentSize = {
    fileId: size.file_id,
    fileUniqueId: size.file_unique_id,
    width: size.width,
    height: size.height,
  };
  addFileSize(attachmentSize, size.file_size);
  return attachmentSize;
}

function addFileSize(target: { fileSize?: number }, fileSize: number | undefined): void {
  if (typeof fileSize === "number" && Number.isFinite(fileSize)) {
    target.fileSize = fileSize;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function summarizeTelegramAttachments(attachments: readonly TelegramAttachment[]): string {
  return attachments.map(describeTelegramAttachment).join("\n");
}

function describeTelegramAttachment(attachment: TelegramAttachment): string {
  const details = attachmentDetails(attachment);
  return details.length === 0
    ? `Telegram ${attachment.kind}`
    : `Telegram ${attachment.kind}: ${details.join(", ")}`;
}

function attachmentDetails(attachment: TelegramAttachment): string[] {
  const details: string[] = [];
  if ("fileName" in attachment && attachment.fileName !== undefined) {
    details.push(attachment.fileName);
  }
  if ("mimeType" in attachment && attachment.mimeType !== undefined) {
    details.push(attachment.mimeType);
  }
  if ("width" in attachment && "height" in attachment) {
    details.push(`${attachment.width}x${attachment.height}`);
  }
  if ("duration" in attachment) {
    details.push(`${attachment.duration}s`);
  }
  if (attachment.fileSize !== undefined) {
    details.push(formatBytes(attachment.fileSize));
  }
  return details;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function metadataFromUser(
  user: TelegramUser | undefined,
): TelegramRequestMetadata["from"] | undefined {
  if (user === undefined) {
    return undefined;
  }

  const metadata: NonNullable<TelegramRequestMetadata["from"]> = { id: user.id };
  if (user.is_bot !== undefined) {
    metadata.isBot = user.is_bot;
  }
  if (user.username !== undefined) {
    metadata.username = user.username;
  }
  if (user.first_name !== undefined) {
    metadata.firstName = user.first_name;
  }
  if (user.last_name !== undefined) {
    metadata.lastName = user.last_name;
  }
  if (user.language_code !== undefined) {
    metadata.languageCode = user.language_code;
  }
  return metadata;
}

/**
 * Deliver a terminal/system message (cancelled, error, …) in place. Such copy is
 * fixed text we author, not model output, so it is delivered as plain text
 * (`format: false`) — no MarkdownV2 escaping — while still reusing the stream's
 * resilient edit-or-recreate delivery.
 */
export async function finishSafely(
  stream: TelegramMessageStream,
  text: string,
  logger: TelegramAdapterLogger | undefined,
): Promise<void> {
  try {
    await stream.finish(text, { format: false });
  } catch (error) {
    logger?.error?.("Failed to send Telegram terminal stream message.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function resolveErrorText(input: {
  readonly configured: TelegramAdapterErrorText;
  readonly error: unknown;
  readonly request: AgentRequest;
  readonly logger: TelegramAdapterLogger | undefined;
}): Promise<string> {
  if (typeof input.configured === "string") {
    return input.configured;
  }

  try {
    const resolved = await input.configured({
      error: input.error,
      request: input.request,
    });
    if (typeof resolved === "string" && resolved.trim().length > 0) {
      return resolved;
    }
    input.logger?.warn?.("Telegram adapter error text callback returned empty text.");
  } catch (error) {
    input.logger?.error?.("Telegram adapter error text callback failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return DEFAULT_ERROR_TEXT;
}
