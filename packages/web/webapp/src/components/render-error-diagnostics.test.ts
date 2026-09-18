import { describe, expect, it } from "vitest";
import { conversationRenderContext, renderErrorReport, serializeRenderError } from "./render-error-diagnostics";

const contextInput = () => ({
  selectedThreadId: "selected", detailThreadId: "detail", runtimeThreadId: "runtime", runtimeRemoteId: "remote", runtimeAdapterThreadId: "adapter",
  loading: false, detailLoading: true, selectionLoading: false, creatingThread: false, runtimeLoading: true,
  messages: [{
    id: "message-1", role: "assistant", title: "PRIVATE TITLE",
    parts: [
      { type: "text", text: "PRIVATE PROSE" },
      { type: "reasoning", text: "PRIVATE REASONING" },
      { type: "tool-call", toolName: "PRIVATE TOOL", args: { token: "PRIVATE TOKEN" }, result: "PRIVATE RESULT" },
    ],
    attachments: [{ name: "PRIVATE FILENAME", data: "PRIVATE BYTES" }],
  }],
  runtimeMessages: [{ id: "message-1", role: "assistant", parts: [{ type: "text", text: "PRIVATE RUNTIME TEXT" }] }],
});

describe("local render diagnostics", () => {
  it("projects only metadata, preserving both source and converted transcript shapes", () => {
    const result = conversationRenderContext(contextInput());
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result).toEqual({
      selectedThreadId: "selected", detailThreadId: "detail", runtimeThreadId: "runtime", runtimeRemoteId: "remote", runtimeAdapterThreadId: "adapter",
      loading: false, detailLoading: true, selectionLoading: false, creatingThread: false, runtimeLoading: true,
      detail: { messageCount: 1, omittedMessages: 0, messages: [{ id: "message-1", role: "assistant", partCount: 3, partTypes: ["text", "reasoning", "tool-call"], omittedParts: 0 }] },
      runtime: { messageCount: 1, omittedMessages: 0, messages: [{ id: "message-1", role: "assistant", partCount: 1, partTypes: ["text"], omittedParts: 0 }] },
    });
  });

  it("bounds all transcript dimensions and copies the snapshot rather than retaining objects", () => {
    const input = contextInput();
    const message = { id: "i".repeat(300), role: "assistant", parts: Array.from({ length: 80 }, () => ({ type: "t".repeat(100) })) };
    const result = conversationRenderContext({ ...input, messages: Array.from({ length: 150 }, () => message) });
    message.parts.length = 0;
    expect(result.detail.messageCount).toBe(150);
    expect(result.detail.messages).toHaveLength(100);
    expect(result.detail.omittedMessages).toBe(50);
    expect(result.detail.messages[0]).toMatchObject({ partCount: 80, omittedParts: 48 });
    expect(result.detail.messages[0]?.partTypes).toHaveLength(32);
    expect(result.detail.messages[0]?.id).toMatch(/…\[truncated\]$/);
    expect(result.detail.messages[0]?.partTypes[0]).toMatch(/…\[truncated\]$/);
  });

  it("preserves bounded exception evidence, causes, aggregates, and non-Error throwables without custom properties", () => {
    const error = Object.assign(new Error("x".repeat(2100), { cause: new TypeError("inner") }), { transcript: "DO NOT LOG" });
    error.stack = "s".repeat(4100);
    const result = serializeRenderError(new AggregateError([error, "a string", null, 42, false, new Error("omitted")], "group"));
    expect(result.name).toBe("AggregateError");
    expect(result.message).toBe("group");
    expect(result.omittedErrors).toBe(1);
    expect(result.errors).toHaveLength(5);
    expect(result.errors?.[0]).toMatchObject({
      name: "Error", message: `${"x".repeat(2000)}…[truncated]`, stack: `${"s".repeat(4000)}…[truncated]`,
      cause: { name: "TypeError", message: "inner" },
    });
    expect(result.errors?.[1]).toEqual({ name: "NonError", type: "string", message: "a string" });
    expect(result.errors?.[2]).toEqual({ name: "NonError", type: "object", message: "null" });
    expect(JSON.stringify(result)).not.toContain("DO NOT LOG");
    // Error strings themselves are evidence, not promised to be content-free.
    expect(serializeRenderError(new Error("verbatim user quotation")).message).toBe("verbatim user quotation");
  });

  it("stops cyclic and deep causes and handles unprintable non-Errors", () => {
    const circular = new Error("cycle");
    circular.cause = circular;
    expect(serializeRenderError(circular).cause?.message).toBe("[circular reference]");
    let deep = new Error("leaf");
    for (let index = 0; index < 6; index += 1) deep = new Error("wrapper", { cause: deep });
    expect(JSON.stringify(serializeRenderError(deep))).not.toContain("leaf");
    expect(JSON.stringify(serializeRenderError(deep))).toContain("maximum cause depth");
    expect(serializeRenderError({ toString() { throw new Error("bad toString"); } }).message).toBe("[unprintable]");
  });

  it("bounds component stacks and retains the primary error if context collection fails", () => {
    const result = renderErrorReport("conversation", new Error("primary"), "c".repeat(9000), () => { throw new Error("context unavailable"); });
    expect(result.error.message).toBe("primary");
    expect(result.contextError?.message).toBe("context unavailable");
    expect(result.componentStack).toBe(`${"c".repeat(8000)}…[truncated]`);
  });
});
