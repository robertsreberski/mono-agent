import type {
  AgentReplyAttachmentPart,
  AgentReplyArtifactStream,
  AgentResponder,
} from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import { TelegramReplyFileDelivery } from "../reply-files.js";
import type { TelegramMessageSender } from "../types.js";

const part: AgentReplyAttachmentPart = {
  type: "attachment",
  id: "reply-file-1",
  reference: { scheme: "mono-agent-artifact", id: "11111111-1111-4111-8111-111111111111" },
  name: "report.txt",
  mediaType: "text/plain",
  sizeBytes: 5,
  integrityId: `sha256:${"b".repeat(64)}`,
};

function artifact(): AgentReplyArtifactStream {
  return {
    attachment: part,
    body: (async function* () { yield new TextEncoder().encode("hello"); })(),
  };
}

function fixture() {
  const openReplyArtifact = vi.fn(async () => artifact());
  const sendDocument = vi.fn(async () => ({ message_id: 99, date: 0, chat: { id: 42, type: "private" } }));
  const sender = { sendDocument } as unknown as TelegramMessageSender;
  const responder = { openReplyArtifact } as Pick<AgentResponder, "openReplyArtifact">;
  const delivery = new TelegramReplyFileDelivery(sender, responder);
  const target = {
    conversationId: "telegram:42",
    chatId: 42,
    replyToMessageId: 7,
    silent: true,
  } as const;
  return { delivery, target, openReplyArtifact, sendDocument };
}

describe("Telegram native reply files", () => {
  it("sends a document in the exact chat/reply and removes it after confirmation", async () => {
    const { delivery, target, openReplyArtifact, sendDocument } = fixture();

    await expect(delivery.deliver([part], target)).resolves.toBeUndefined();

    expect(openReplyArtifact).toHaveBeenCalledWith({
      conversationId: target.conversationId,
      reference: part.reference,
      expectedIntegrityId: part.integrityId,
    });
    expect(sendDocument).toHaveBeenCalledWith({
      chat_id: 42,
      document: new TextEncoder().encode("hello"),
      filename: "report.txt",
      reply_to_message_id: 7,
      allow_sending_without_reply: true,
      disable_notification: true,
    }, undefined);
  });

  it("preserves textual fallback when sendDocument fails", async () => {
    const { delivery, target, sendDocument } = fixture();
    sendDocument.mockRejectedValueOnce(new Error("send failed"));

    await expect(delivery.deliver([part], target)).resolves.toEqual([part]);
  });

  it("deduplicates only confirmed delivery for the same integrity id and destination", async () => {
    const { delivery, target, sendDocument } = fixture();

    await delivery.deliver([part], target);
    await delivery.deliver([part], target);
    expect(sendDocument).toHaveBeenCalledOnce();

    await delivery.deliver([part], { ...target, replyToMessageId: 8 });
    expect(sendDocument).toHaveBeenCalledTimes(2);
  });
});
