import { describe, expect, it } from "vitest";

import type {
  AgentAttachment,
  AgentRequestBase,
} from "../index.js";

describe("multimodal attachment contracts", () => {
  it("models image and document attachments", () => {
    const image: AgentAttachment = {
      kind: "image",
      mimeType: "image/png",
      data: "aGVsbG8=",
      name: "screenshot.png",
      sizeBytes: 5,
    };
    const document: AgentAttachment = {
      kind: "document",
      mimeType: "application/pdf",
      data: "JVBERi0=",
      text: "extracted text",
    };
    expect(image.kind).toBe("image");
    expect(document.text).toBe("extracted text");
  });

  it("extends AgentRequestBase with an optional attachments array", () => {
    const withAttachments: AgentRequestBase = {
      conversationId: "c:1",
      text: "describe this",
      abortSignal: new AbortController().signal,
      attachments: [
        { kind: "image", mimeType: "image/jpeg", data: "Zm9v" },
      ],
    };
    // Backward compatible: omitting attachments is still valid.
    const withoutAttachments: AgentRequestBase = {
      conversationId: "c:2",
      text: "hi",
      abortSignal: new AbortController().signal,
    };
    expect(withAttachments.attachments?.[0]?.kind).toBe("image");
    expect(withoutAttachments.attachments).toBeUndefined();
  });

  it("keeps reply targets and continuation synthesis controls host-side", () => {
    const request: AgentRequestBase = {
      conversationId: "slack:C1:thread#2026-07-14",
      text: "synthesize the completed delegation",
      abortSignal: new AbortController().signal,
      replyTo: { conversationId: "slack:C1:thread" },
      continuation: {
        continuationId: "continuation-1",
        originRunId: "run-origin",
        toolsDisabled: true,
        deferHistoryCommit: true,
      },
    };

    expect(request.replyTo?.conversationId).toBe("slack:C1:thread");
    expect(request.continuation?.originRunId).toBe("run-origin");
  });
});
