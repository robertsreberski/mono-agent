import { createHash } from "node:crypto";

import type {
  AgentReplyAttachmentPart,
  AgentReplyPart,
  AgentResponder,
} from "@mono-agent/agent-contracts";

import type { TelegramMessageStreamLogger } from "./message-stream.js";
import type { TelegramChatId, TelegramMessageSender } from "./types.js";

const CONFIRMED_DELIVERY_CACHE_MAX = 512;

export interface TelegramReplyFileTarget {
  readonly conversationId: string;
  readonly chatId: TelegramChatId;
  readonly replyToMessageId?: number;
  readonly silent?: boolean;
  readonly signal?: AbortSignal;
}

/** Native generated-file delivery with retry-safe, destination-bound deduplication. */
export class TelegramReplyFileDelivery {
  private readonly confirmed = new Map<string, true>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly sender: TelegramMessageSender,
    private readonly responder: Pick<AgentResponder, "openReplyArtifact">,
    private readonly logger?: TelegramMessageStreamLogger,
  ) {}

  async deliver(
    parts: readonly AgentReplyPart[] | undefined,
    target: TelegramReplyFileTarget,
  ): Promise<readonly AgentReplyPart[] | undefined> {
    if (parts === undefined || parts.length === 0) return parts;
    const remaining: AgentReplyPart[] = [];
    for (const part of parts) {
      if (part.type !== "attachment" || !(await this.deliverAttachment(part, target))) {
        remaining.push(part);
      }
    }
    return remaining.length === 0 ? undefined : remaining;
  }

  private async deliverAttachment(
    part: AgentReplyAttachmentPart,
    target: TelegramReplyFileTarget,
  ): Promise<boolean> {
    if (this.responder.openReplyArtifact === undefined || this.sender.sendDocument === undefined) {
      return false;
    }
    const key = deliveryKey(part.integrityId, target.chatId, target.replyToMessageId);
    if (this.confirmed.delete(key)) {
      this.confirmed.set(key, true);
      return true;
    }
    const active = this.inFlight.get(key);
    if (active !== undefined) return active;

    const delivery = this.upload(part, target)
      .then(() => {
        this.confirmed.set(key, true);
        while (this.confirmed.size > CONFIRMED_DELIVERY_CACHE_MAX) {
          const oldest = this.confirmed.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.confirmed.delete(oldest);
        }
        return true;
      })
      .catch(() => {
        this.logger?.warn?.("Telegram reply file upload failed; textual fallback retained.", {
          partId: part.id,
        });
        return false;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, delivery);
    return delivery;
  }

  private async upload(
    part: AgentReplyAttachmentPart,
    target: TelegramReplyFileTarget,
  ): Promise<void> {
    const openReplyArtifact = this.responder.openReplyArtifact;
    const sendDocument = this.sender.sendDocument;
    if (openReplyArtifact === undefined || sendDocument === undefined) {
      throw new Error("Telegram reply-file upload capability is unavailable.");
    }
    const opened = await openReplyArtifact.call(this.responder, {
      conversationId: target.conversationId,
      reference: part.reference,
      expectedIntegrityId: part.integrityId,
    });
    assertMatchingAttachment(part, opened.attachment);
    const document = await collectExactBytes(opened.body, part.sizeBytes, target.signal);
    const requestOptions = target.signal === undefined ? undefined : { signal: target.signal };
    await sendDocument.call(
      this.sender,
      {
        chat_id: target.chatId,
        document,
        filename: part.name,
        ...(target.replyToMessageId === undefined
          ? {}
          : {
              reply_to_message_id: target.replyToMessageId,
              allow_sending_without_reply: true,
            }),
        ...(target.silent === undefined ? {} : { disable_notification: target.silent }),
      },
      requestOptions,
    );
  }
}

function deliveryKey(
  integrityId: string,
  chatId: TelegramChatId,
  replyToMessageId: number | undefined,
): string {
  return createHash("sha256")
    .update("telegram-reply-file-v1\0")
    .update(integrityId)
    .update("\0")
    .update(String(chatId))
    .update("\0")
    .update(replyToMessageId === undefined ? "" : String(replyToMessageId))
    .digest("hex");
}

function assertMatchingAttachment(
  expected: AgentReplyAttachmentPart,
  actual: AgentReplyAttachmentPart,
): void {
  if (
    actual.reference.id !== expected.reference.id
    || actual.integrityId !== expected.integrityId
    || actual.sizeBytes !== expected.sizeBytes
    || actual.name !== expected.name
    || actual.mediaType !== expected.mediaType
  ) {
    throw new Error("Authorized reply artifact metadata did not match the reply part.");
  }
}

async function collectExactBytes(
  body: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (signal?.aborted === true) throw signal.reason ?? new Error("Reply-file upload aborted.");
    total += chunk.byteLength;
    if (total > expectedBytes) throw new Error("Reply artifact exceeded its declared size.");
    chunks.push(chunk);
  }
  if (total !== expectedBytes) throw new Error("Reply artifact did not match its declared size.");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
