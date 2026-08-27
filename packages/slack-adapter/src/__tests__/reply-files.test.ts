import type {
  AgentReplyAttachmentPart,
  AgentReplyArtifactStream,
  AgentResponder,
} from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import { SlackReplyFileDelivery } from "../reply-files.js";
import { SlackApiError } from "../slack-client.js";
import type { SlackWebApi } from "../types.js";

const part: AgentReplyAttachmentPart = {
  type: "attachment",
  id: "reply-file-1",
  reference: { scheme: "mono-agent-artifact", id: "11111111-1111-4111-8111-111111111111" },
  name: "report.txt",
  mediaType: "text/plain",
  sizeBytes: 5,
  integrityId: `sha256:${"a".repeat(64)}`,
};

function artifact(): AgentReplyArtifactStream {
  return {
    attachment: part,
    body: (async function* () { yield new TextEncoder().encode("hello"); })(),
  };
}

function fixture() {
  const openReplyArtifact = vi.fn(async () => artifact());
  const get = vi.fn(async () => ({
    ok: true as const,
    upload_url: "https://uploads.slack.test/private-capability",
    file_id: "F123",
  }));
  const upload = vi.fn(async () => {});
  const complete = vi.fn(async () => ({ ok: true as const }));
  const api = {
    filesGetUploadURLExternal: get,
    filesUploadExternal: upload,
    filesCompleteUploadExternal: complete,
  } as unknown as SlackWebApi;
  const warn = vi.fn();
  const responder = { openReplyArtifact } as Pick<AgentResponder, "openReplyArtifact">;
  const delivery = new SlackReplyFileDelivery(api, responder, { warn });
  const target = {
    conversationId: "slack:C1:thread:100.1",
    channelId: "C1",
    threadTs: "100.1",
  } as const;
  return { delivery, target, openReplyArtifact, get, upload, complete, warn };
}

describe("Slack native reply files", () => {
  it("uses the external upload flow and removes only a confirmed file from fallback", async () => {
    const { delivery, target, openReplyArtifact, get, upload, complete, warn } = fixture();

    await expect(delivery.deliver([part], target)).resolves.toBeUndefined();

    expect(openReplyArtifact).toHaveBeenCalledWith({
      conversationId: target.conversationId,
      reference: part.reference,
      expectedIntegrityId: part.integrityId,
    });
    expect(get).toHaveBeenCalledWith(
      { filename: "report.txt", length: 5 },
      undefined,
    );
    expect(upload).toHaveBeenCalledWith({
      uploadUrl: "https://uploads.slack.test/private-capability",
      data: new TextEncoder().encode("hello"),
    }, undefined);
    expect(complete).toHaveBeenCalledWith({
      files: [{ id: "F123", title: "report.txt" }],
      channel_id: "C1",
      thread_ts: "100.1",
    }, undefined);
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(upload.mock.invocationCallOrder[0]!);
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]!);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      stage: "open_artifact",
      fail: (value: ReturnType<typeof fixture>) => value.openReplyArtifact.mockRejectedValueOnce(
        new Error("artifact open rejected"),
      ),
    },
    {
      stage: "verify_artifact",
      fail: (value: ReturnType<typeof fixture>) => value.openReplyArtifact.mockResolvedValueOnce({
        ...artifact(),
        attachment: { ...part, name: "wrong.txt" },
      }),
    },
    {
      stage: "request_upload_url",
      fail: (value: ReturnType<typeof fixture>) => value.get.mockRejectedValueOnce(
        new Error("URL request rejected"),
      ),
    },
    {
      stage: "upload_bytes",
      fail: (value: ReturnType<typeof fixture>) => value.upload.mockRejectedValueOnce(
        new Error("byte upload rejected"),
      ),
    },
    {
      stage: "complete_upload",
      fail: (value: ReturnType<typeof fixture>) => value.complete.mockRejectedValueOnce(
        new Error("completion rejected"),
      ),
    },
  ])("preserves textual fallback and reports the $stage stage", async ({ stage, fail }) => {
    const value = fixture();
    fail(value);

    await expect(value.delivery.deliver([part], value.target)).resolves.toEqual([part]);
    expect(value.warn).toHaveBeenCalledOnce();
    expect(value.warn).toHaveBeenCalledWith(
      "Slack reply file upload failed; textual fallback retained.",
      expect.objectContaining({ partId: part.id, stage }),
    );
  });

  it("reports bounded Slack API details without delivery secrets", async () => {
    const { delivery, target, get, warn } = fixture();
    get.mockRejectedValueOnce(new SlackApiError("Slack rejected xoxb-secret-token.", {
      kind: "slack",
      method: "files.getUploadURLExternal",
      status: 403,
      slackError: "missing_scope",
      needed: "files:write",
      provided: "chat:write",
      warning: "scope update required",
      retryAfterMs: 1_000,
    }));

    await expect(delivery.deliver([part], target)).resolves.toEqual([part]);

    const metadata = warn.mock.calls[0]?.[1];
    expect(metadata).toEqual({
      partId: part.id,
      stage: "request_upload_url",
      error: "Slack rejected [REDACTED_SLACK_TOKEN].",
      kind: "slack",
      method: "files.getUploadURLExternal",
      status: 403,
      slackError: "missing_scope",
      needed: "files:write",
      provided: "chat:write",
      warning: "scope update required",
      retryAfterMs: 1_000,
    });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain("xoxb-secret-token");
    expect(serialized).not.toContain("private-capability");
    expect(serialized).not.toContain(target.conversationId);
    expect(serialized).not.toContain(target.channelId);
    expect(serialized).not.toContain(target.threadTs);
    expect(serialized).not.toContain(part.reference.id);
  });

  it("does not execute hostile error accessors while logging a failure", async () => {
    const { delivery, target, upload, warn } = fixture();
    const message = vi.fn(() => "private-capability");
    upload.mockRejectedValueOnce(new Proxy(new Error("hidden"), {
      get: message,
    }));

    await expect(delivery.deliver([part], target)).resolves.toEqual([part]);

    expect(message).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[1]).toEqual({
      partId: part.id,
      stage: "upload_bytes",
      error: "[SLACK_LOG_DETAILS_UNAVAILABLE]",
    });
  });

  it("replaces local paths and capability URLs in error messages", async () => {
    const { delivery, target, openReplyArtifact, warn } = fixture();
    openReplyArtifact.mockRejectedValueOnce(new Error(
      "Failed /Users/operator/private/report.txt via https://uploads.slack.test/private-capability.",
    ));

    await expect(delivery.deliver([part], target)).resolves.toEqual([part]);

    expect(warn.mock.calls[0]?.[1]).toEqual({
      partId: part.id,
      stage: "open_artifact",
      error: "[SLACK_REPLY_FILE_DETAILS_REDACTED]",
    });
  });

  it("deduplicates a confirmed integrity id only within the exact destination thread", async () => {
    const { delivery, target, get, upload, complete } = fixture();

    await delivery.deliver([part], target);
    await delivery.deliver([part], target);
    expect(get).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();

    await delivery.deliver([part], { ...target, threadTs: "200.2" });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
