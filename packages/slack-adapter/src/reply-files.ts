import { createHash } from "node:crypto";

import type {
  AgentReplyAttachmentPart,
  AgentReplyPart,
  AgentResponder,
} from "@mono-agent/agent-contracts";

import type { SlackMessageStreamLogger } from "./message-stream.js";
import {
  isSafeSlackPrototypeInstance,
  readSafeSlackDataProperty,
  redactSlackErrorMessage,
} from "./log-redaction.js";
import { SlackApiError } from "./slack-client.js";
import type { SlackChannelId, SlackMessageTs, SlackWebApi } from "./types.js";

const CONFIRMED_DELIVERY_CACHE_MAX = 512;
const REPLY_FILE_UPLOAD_STAGES = [
  "open_artifact",
  "verify_artifact",
  "request_upload_url",
  "upload_bytes",
  "complete_upload",
] as const;
const SLACK_UPLOAD_METHODS = new Set([
  "files.getUploadURLExternal",
  "files.uploadExternal",
  "files.completeUploadExternal",
]);
const REPLY_FILE_LOCATION_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:^|[\s"'(])\/[^\s"'<>]+|(?:^|[\s"'(])[a-z]:[\\/][^\s"'<>]+)/iu;
const REDACTED_REPLY_FILE_DETAILS = "[SLACK_REPLY_FILE_DETAILS_REDACTED]";

type SlackReplyFileUploadStage = typeof REPLY_FILE_UPLOAD_STAGES[number];

class SlackReplyFileUploadError extends Error {
  override readonly cause: unknown;

  constructor(
    readonly stage: SlackReplyFileUploadStage,
    cause: unknown,
  ) {
    super("Slack reply-file upload stage failed.");
    this.name = "SlackReplyFileUploadError";
    this.cause = cause;
  }
}

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
      .catch((error: unknown) => {
        this.logger?.warn?.("Slack reply file upload failed; textual fallback retained.", {
          ...replyFileFailureMetadata(part.id, error),
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
    const opened = await runUploadStage("open_artifact", () => (
      openReplyArtifact.call(this.responder, {
        conversationId: target.conversationId,
        reference: part.reference,
        expectedIntegrityId: part.integrityId,
      })
    ));
    const data = await runUploadStage("verify_artifact", async () => {
      assertMatchingAttachment(part, opened.attachment);
      return collectExactBytes(opened.body, part.sizeBytes, target.signal);
    });
    const requestOptions = target.signal === undefined ? undefined : { signal: target.signal };
    const pending = await runUploadStage("request_upload_url", () => (
      getUploadUrl.call(
        this.api,
        { filename: part.name, length: data.byteLength },
        requestOptions,
      )
    ));
    await runUploadStage("upload_bytes", () => (
      uploadExternal.call(
        this.api,
        { uploadUrl: pending.upload_url, data },
        requestOptions,
      )
    ));
    await runUploadStage("complete_upload", () => (
      completeUpload.call(
        this.api,
        {
          files: [{ id: pending.file_id, title: part.name }],
          channel_id: target.channelId,
          ...(target.threadTs === undefined ? {} : { thread_ts: target.threadTs }),
        },
        requestOptions,
      )
    ));
  }
}

async function runUploadStage<T>(
  stage: SlackReplyFileUploadStage,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new SlackReplyFileUploadError(stage, error);
  }
}

function replyFileFailureMetadata(
  partId: string,
  error: unknown,
): Record<string, unknown> {
  const wrapped = isSafeSlackPrototypeInstance(error, SlackReplyFileUploadError.prototype);
  const rawStage = wrapped ? readSafeSlackDataProperty(error, "stage") : undefined;
  const cause = wrapped ? readSafeSlackDataProperty(error, "cause") : error;
  const metadata: Record<string, unknown> = {
    partId,
    stage: isReplyFileUploadStage(rawStage) ? rawStage : "unknown",
    error: redactReplyFileErrorMessage(cause),
  };
  if (!isSafeSlackPrototypeInstance(cause, SlackApiError.prototype)) return metadata;

  const kind = readSafeSlackDataProperty(cause, "kind");
  if (isSlackApiErrorKind(kind)) metadata.kind = kind;

  const method = readSafeSlackDataProperty(cause, "method");
  if (typeof method === "string" && SLACK_UPLOAD_METHODS.has(method)) {
    metadata.method = method;
  }

  const status = readSafeSlackDataProperty(cause, "status");
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    metadata.status = status;
  }

  addSafeTextMetadata(metadata, cause, "slackError");
  addSafeTextMetadata(metadata, cause, "needed");
  addSafeTextMetadata(metadata, cause, "provided");
  addSafeTextMetadata(metadata, cause, "warning");

  const retryAfterMs = readSafeSlackDataProperty(cause, "retryAfterMs");
  if (
    typeof retryAfterMs === "number"
    && Number.isSafeInteger(retryAfterMs)
    && retryAfterMs >= 0
    && retryAfterMs <= 86_400_000
  ) {
    metadata.retryAfterMs = retryAfterMs;
  }
  return metadata;
}

function redactReplyFileErrorMessage(error: unknown): string {
  const redacted = redactSlackErrorMessage(error);
  return REPLY_FILE_LOCATION_PATTERN.test(redacted)
    ? REDACTED_REPLY_FILE_DETAILS
    : redacted;
}

function addSafeTextMetadata(
  metadata: Record<string, unknown>,
  error: unknown,
  key: "slackError" | "needed" | "provided" | "warning",
): void {
  const value = readSafeSlackDataProperty(error, key);
  if (typeof value === "string") metadata[key] = redactSlackErrorMessage(value);
}

function isReplyFileUploadStage(value: unknown): value is SlackReplyFileUploadStage {
  return typeof value === "string"
    && (REPLY_FILE_UPLOAD_STAGES as readonly string[]).includes(value);
}

function isSlackApiErrorKind(value: unknown): value is "http" | "slack" | "malformed" | "network" | "aborted" {
  return value === "http"
    || value === "slack"
    || value === "malformed"
    || value === "network"
    || value === "aborted";
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
