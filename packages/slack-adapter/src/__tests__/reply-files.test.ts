import type {
  AgentReplyAttachmentPart,
  AgentReplyArtifactStream,
  AgentResponder,
} from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import { SlackReplyFileDelivery } from "../reply-files.js";
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
  const responder = { openReplyArtifact } as Pick<AgentResponder, "openReplyArtifact">;
  const delivery = new SlackReplyFileDelivery(api, responder);
  const target = {
    conversationId: "slack:C1:thread:100.1",
    channelId: "C1",
    threadTs: "100.1",
  } as const;
  return { delivery, target, openReplyArtifact, get, upload, complete };
}

describe("Slack native reply files", () => {
  it("uses the external upload flow and removes only a confirmed file from fallback", async () => {
    const { delivery, target, openReplyArtifact, get, upload, complete } = fixture();

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
  });

  it("preserves textual fallback when any upload phase fails", async () => {
    const { delivery, target, upload, complete } = fixture();
    upload.mockRejectedValueOnce(new Error("upload rejected"));

    await expect(delivery.deliver([part], target)).resolves.toEqual([part]);
    expect(complete).not.toHaveBeenCalled();
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
