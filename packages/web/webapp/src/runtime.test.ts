import { describe, expect, it } from "vitest";
import { canSendInConsole, canUploadInConsole, convertWebMessage } from "./runtime";
import { agent, attachment, thread } from "./test/fixtures";
import type { WebMessage } from "./types";

const message = (overrides: Partial<WebMessage> = {}): WebMessage => ({
  id: "message-1",
  threadId: "thread-1",
  role: "user",
  parts: [],
  attachments: [],
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  status: "complete",
  ...overrides,
});

describe("convertWebMessage", () => {
  it("preserves attachment-only user messages without manufacturing text or running state", () => {
    const converted = convertWebMessage(
      message({
        attachments: [
          attachment("document", {
            name: "brief.pdf",
            contentType: "application/pdf",
            contentUrl: "/api/v1/uploads/document/content",
            uploaded: true,
          }),
        ],
      }),
    );

    expect(converted.content).toEqual([]);
    expect(converted).not.toHaveProperty("status");
    expect(converted.attachments?.[0]).toMatchObject({
      type: "document",
      content: [
        {
          type: "file",
          data: "/api/v1/uploads/document/content",
          filename: "brief.pdf",
        },
      ],
    });
  });

  it("maps image content URLs into safe persisted image attachment content", () => {
    const converted = convertWebMessage(
      message({
        attachments: [
          attachment("image", {
            name: "chart.png",
            contentType: "image/png",
            kind: "image",
            contentUrl: "/api/v1/uploads/image/content",
            uploaded: true,
          }),
        ],
      }),
    );

    expect(converted.attachments?.[0]?.content).toEqual([
      {
        type: "image",
        image: "/api/v1/uploads/image/content",
        filename: "chart.png",
      },
    ]);
  });

  it("preserves visible parts while keeping persisted telemetry out of assistant-ui content", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "running",
        parts: [
          { type: "reasoning", text: "Inspecting" },
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "inspect",
            args: { depth: 2 },
            result: { ok: true },
            status: "complete",
          },
          { type: "telemetry", event: "usage_update", data: { tokens: { input: 10 } } },
          { type: "text", text: "Ready" },
        ],
      }),
    );

    expect(Array.isArray(converted.content)).toBe(true);
    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual([
      "reasoning",
      "tool-call",
      "text",
    ]);
    expect(converted.status).toEqual({ type: "running" });
  });

  it("skips a part type this bundle does not know instead of corrupting the transcript", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        // A precached console can outlive a server upgrade by a whole release.
        parts: [{ type: "from-a-newer-server" } as never, { type: "text", text: "Ready" }],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content).toEqual([{ type: "text", text: "Ready" }]);
  });

  it("converts a delegation into one named data part that keeps its nested calls", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          {
            type: "subagent",
            toolCallId: "call-1",
            name: "researcher",
            label: "read the router",
            status: "complete",
            executionMs: 12_400,
            result: "<subagent: researcher · ok>",
            calls: [
              { toolCallId: "agent:call-1:t1", toolName: "Read", args: { file_path: "/repo/a.ts" }, status: "complete" },
            ],
          },
          { type: "text", text: "Ready" },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual(["data-subagent", "text"]);
    // assistant-ui tool-call parts carry no children, so the whole group has to
    // survive as one payload or the nesting is lost on the way to the renderer.
    expect(converted.content[0]).toMatchObject({
      type: "data-subagent",
      data: {
        name: "researcher",
        label: "read the router",
        status: "complete",
        calls: [{ toolCallId: "agent:call-1:t1", toolName: "Read" }],
      },
    });
  });

  it("exposes only canonical compaction telemetry as a named assistant-ui data part", () => {
    const converted = convertWebMessage(message({
      role: "assistant",
      status: "running",
      parts: [
        { type: "telemetry", event: "usage_update", data: { tokens: { input: 10 } } },
        {
          type: "telemetry",
          event: "runtime_telemetry",
          data: {
            type: "runtime_telemetry",
            kind: "context_compaction",
            data: {
              operationId: "compact-1",
              status: "running",
              sdk: "pi",
              trigger: "proactive",
            },
          },
        },
      ],
    }));

    expect(converted.content).toEqual([
      {
        type: "data-context-compaction",
        data: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: {
            operationId: "compact-1",
            status: "running",
            sdk: "pi",
            trigger: "proactive",
          },
        },
      },
    ]);
  });

  it("maps a persisted quote into assistant-ui message metadata", () => {
    const converted = convertWebMessage(message({
      quote: { text: "Quoted response", messageId: "source-message" },
      parts: [{ type: "text", text: "Follow up" }],
    }));

    expect(converted.metadata?.custom?.quote).toEqual({
      text: "Quoted response",
      messageId: "source-message",
    });
    expect(converted.content).toEqual([{ type: "text", text: "Follow up" }]);
  });

  it("exposes live follow-up delivery state as message metadata", () => {
    const converted = convertWebMessage(message({
      liveInputStatus: "queued",
      parts: [{ type: "text", text: "Use the smaller scope" }],
    }));

    expect(converted.metadata?.custom?.liveInputStatus).toBe("queued");
  });
});

describe("runtime capability gates", () => {
  const activeThread = thread("thread", "agent");

  it("keeps degraded agents send-capable while they are connected", () => {
    expect(canSendInConsole("live", agent("agent", { status: "degraded" }), activeThread)).toBe(true);
  });

  it("disables sending offline, while reconnecting, and for archived/read-only threads", () => {
    expect(canSendInConsole("live", agent("agent", { status: "offline" }), activeThread)).toBe(false);
    expect(canSendInConsole("reconnecting", agent("agent"), activeThread)).toBe(false);
    expect(
      canSendInConsole(
        "live",
        agent("agent"),
        thread("archived", "agent", { archivedAt: "2026-07-17T12:00:00.000Z" }),
      ),
    ).toBe(false);
    expect(
      canSendInConsole("live", agent("agent"), thread("readonly", "agent", { canSend: false })),
    ).toBe(false);
  });

  it("uses the same connection and capability checks for attachments", () => {
    expect(canUploadInConsole("live", agent("agent"), activeThread)).toBe(true);
    expect(canUploadInConsole("offline", agent("agent"), activeThread)).toBe(false);
    expect(canUploadInConsole("reconnecting", agent("agent"), activeThread)).toBe(false);
    expect(
      canUploadInConsole("live", agent("agent", { supportsAttachments: false }), activeThread),
    ).toBe(false);
    expect(
      canUploadInConsole("live", agent("agent"), thread("no-files", "agent", { canUpload: false })),
    ).toBe(false);
  });
});
