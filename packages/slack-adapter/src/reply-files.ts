import { createHash } from "node:crypto";

import type {
  AgentReplyAttachmentPart,
  AgentReplyPart,
  AgentResponder,
} from "@mono-agent/agent-contracts";

import type { SlackMessageStreamLogger } from "./message-stream.js";
import type { SlackChannelId, SlackMessageTs, SlackWebApi } from "./types.js";

const CONFIRMED_DELIVERY_CACHE_MAX = 512;

export interface SlackReplyFileTarget {
  readonly conversationId: string;
  readonly channelId: SlackChannelId;
  readonly threadTs?: SlackMessageTs;
  readonly signal?: AbortSignal;
}

/** Native generated-file delivery with retry-safe, destination-bound deduplication. */
export class SlackReplyFileDelivery {
  private readonly confirmed = new Map<string, true>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly api: SlackWebApi,
    private readonly responder: Pick<AgentResponder, "openReplyArtifact">,
    private readonly logger?: SlackMessageStreamLogger,
  ) {}

  async deliver(
    parts: readonly AgentReplyPart[] | undefined,
    target: SlackReplyFileTarget,
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
    target: SlackReplyFileTarget,
  ): Promise<boolean> {
    if (
      this.responder.openReplyArtifact === undefined
      || this.api.filesGetUploadURLExternal === undefined
      || this.api.filesUploadExternal === undefined
      || this.api.filesCompleteUploadExternal === undefined
    ) {
      return false;
    }

    const key = deliveryKey(part.integrityId, target.channelId, target.threadTs);
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
        this.logger?.warn?.("Slack reply file upload failed; textual fallback retained.", {
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
    target: SlackReplyFileTarget,
  ): Promise<void> {
    const openReplyArtifact = this.responder.openReplyArtifact;
    const getUploadUrl = this.api.filesGetUploadURLExternal;
    const uploadExternal = this.api.filesUploadExternal;
    const completeUpload = this.api.filesCompleteUploadExternal;
    if (
      openReplyArtifact === undefined
      || getUploadUrl === undefined
      || uploadExternal === undefined
      || completeUpload === undefined
    ) {
      throw new Error("Slack reply-file upload capability is unavailable.");
    }
    const opened = await openReplyArtifact.call(this.responder, {
      conversationId: target.conversationId,
      reference: part.reference,
      expectedIntegrityId: part.integrityId,
    });
    assertMatchingAttachment(part, opened.attachment);
    const data = await collectExactBytes(opened.body, part.sizeBytes, target.signal);
    const requestOptions = target.signal === undefined ? undefined : { signal: target.signal };
    const pending = await getUploadUrl.call(
      this.api,
      { filename: part.name, length: data.byteLength },
      requestOptions,
    );
    await uploadExternal.call(
      this.api,
      { uploadUrl: pending.upload_url, data },
      requestOptions,
    );
    await completeUpload.call(
      this.api,
      {
        files: [{ id: pending.file_id, title: part.name }],
        channel_id: target.channelId,
        ...(target.threadTs === undefined ? {} : { thread_ts: target.threadTs }),
      },
      requestOptions,
    );
  }
}

function deliveryKey(
  integrityId: string,
  channelId: SlackChannelId,
  threadTs: SlackMessageTs | undefined,
): string {
  return createHash("sha256")
    .update("slack-reply-file-v1\0")
    .update(integrityId)
    .update("\0")
    .update(channelId)
    .update("\0")
    .update(threadTs ?? "")
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
