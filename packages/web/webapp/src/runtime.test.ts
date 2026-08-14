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
            history: {
              recordId: "sth1_result",
              sequence: 2,
              persistence: "persisted",
              terminalState: "success",
              untrusted: true,
            },
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
    expect(converted.content.find((part) => part.type === "tool-call")).toMatchObject({
      artifact: {
        recordId: "sth1_result",
        sequence: 2,
        persistence: "persisted",
        terminalState: "success",
        untrusted: true,
      },
    });
    expect(converted.status).toEqual({ type: "running" });
  });

  it("rejoins prose a stored telemetry part split in half", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        // Exactly what a turn stored before the runtime stopped splitting text
        // across invisible telemetry: one sentence, broken mid-word.
        parts: [
          { type: "text", text: "I'm re" },
          { type: "telemetry", event: "usage_update", data: { tokens: { input: 10 } } },
          { type: "text", text: "ally sorry" },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content).toEqual([{ type: "text", text: "I'm really sorry" }]);
  });

  it("keeps text either side of a delegation apart", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          { type: "text", text: "Let me check. " },
          { type: "subagent", toolCallId: "call-1", name: "researcher", status: "complete", calls: [] },
          { type: "text", text: "You have 12 tasks." },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual([
      "data-note",
      "data-subagent",
      "text",
    ]);
  });

  it("folds a settled turn into one run of activity over the answer", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          { type: "reasoning", text: "Planning" },
          { type: "text", text: "Let me look at the inbox." },
          { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "complete" },
          { type: "text", text: "Now the calendar." },
          { type: "tool-call", toolCallId: "t2", toolName: "Calendar", args: {}, status: "complete" },
          { type: "text", text: "Here is the summary." },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    // Everything before the answer is adjacent, so the renderer coalesces it
    // into exactly one Activity disclosure instead of four interleaved ones.
    expect(converted.content.map((part) => part.type)).toEqual([
      "reasoning",
      "data-note",
      "tool-call",
      "data-note",
      "tool-call",
      "text",
    ]);
    expect(converted.content.at(0)).toEqual({ type: "reasoning", text: "Planning" });
    expect(converted.content.at(1)).toEqual({ type: "data-note", data: { text: "Let me look at the inbox." } });
    expect(converted.content.at(-1)).toEqual({ type: "text", text: "Here is the summary." });
  });

  it("leaves a running turn interleaved, because the answer is not written yet", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "running",
        parts: [
          { type: "text", text: "Let me look at the inbox." },
          { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "running" },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual(["text", "tool-call"]);
  });

  it("treats a turn cancelled mid-tool as all activity rather than inventing an answer", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "cancelled",
        parts: [
          { type: "reasoning", text: "Planning" },
          { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "running" },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual(["reasoning", "tool-call"]);
  });

  it.each(["cancelled", "failed", "interrupted"] as const)(
    "keeps a %s turn in arrival order, because its last prose is not an answer",
    (status) => {
      const converted = convertWebMessage(
        message({
          role: "assistant",
          status,
          parts: [
            { type: "text", text: "Let me look at the inbox." },
            { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "running" },
          ],
        }),
      );

      // A turn that never reached a final answer has only narration; hoisting
      // the tool above it would invert the chronology and dress the narration
      // up as the answer.
      if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
      expect(converted.content.map((part) => part.type)).toEqual(["text", "tool-call"]);
    },
  );

  it("keeps a run failure after the answer instead of letting it split the activity log", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "failed" },
          { type: "error", code: "provider_unavailable", message: "The agent run failed." },
          { type: "text", text: "I could not reach Gmail." },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual([
      "tool-call",
      "text",
      "data-error",
    ]);
  });

  it("drops blank interim prose rather than folding an empty note into the log", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          { type: "text", text: "  \n " },
          { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "complete" },
          { type: "text", text: "Done." },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual(["tool-call", "text"]);
  });

  it("keeps a settled user message exactly as stored", () => {
    const converted = convertWebMessage(
      message({
        role: "user",
        status: "complete",
        parts: [{ type: "text", text: "Go ahead with group A." }],
      }),
    );

    expect(converted.content).toEqual([{ type: "text", text: "Go ahead with group A." }]);
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
