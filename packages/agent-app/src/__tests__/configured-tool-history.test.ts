import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolHistoryWriter, ToolHistoryWriterHandle } from "@mono-agent/agent-harness";
import { describe, expect, it, vi } from "vitest";

import { lazyConfiguredToolHistory } from "../configured-agent.js";

describe("configured tool-history acquisition", () => {
  it("retries a transient acquisition rejection with one outage warning and one recovery warning", async () => {
    const persist = vi.fn(async () => ({ persistence: "persisted" as const }));
    const finishRun = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const handle: ToolHistoryWriterHandle = {
      writer: { persist, finishRun } as unknown as ToolHistoryWriter,
      release,
    };
    let attempts = 0;
    const acquireWriter = vi.fn(async (): Promise<ToolHistoryWriterHandle> => {
      attempts += 1;
      if (attempts <= 2) {
        throw Object.assign(new Error("transient private acquisition detail"), {
          code: "history_writer_in_use",
        });
      }
      return handle;
    });
    const warnings: string[] = [];
    const history = lazyConfiguredToolHistory({
      root: join(tmpdir(), "configured-tool-history-retry"),
      artifactRoot: join(tmpdir(), "configured-tool-history-artifacts"),
      rollover: "daily",
      onWarning: (message) => warnings.push(message),
      acquireWriter: acquireWriter as never,
    });
    const sink = history.writer.createSink({
      conversationId: "chat:42#2026-08-14",
      logicalConversationId: "chat:42",
      runId: "retry-run",
      isolated: false,
    });
    const event = {
      phase: "invocation" as const,
      toolCallId: "retry-call",
      toolName: "Read",
      arguments: { path: "README.md" },
    };

    await expect(sink(event)).rejects.toMatchObject({ code: "history_writer_in_use" });
    await expect(sink(event)).rejects.toMatchObject({ code: "history_writer_in_use" });
    await expect(sink(event)).resolves.toEqual({ persistence: "persisted" });
    await history.writer.finishRun({
      conversationId: "chat:42#2026-08-14",
      logicalConversationId: "chat:42",
      runId: "retry-run",
      isolated: false,
    }, "succeeded");

    expect(acquireWriter).toHaveBeenCalledTimes(3);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      "Tool history writer acquisition failed (history_writer_in_use); the next lifecycle write will retry.",
      "Tool history writer acquisition recovered; lifecycle persistence resumed.",
    ]);
    expect(warnings.join(" ")).not.toContain("transient private acquisition detail");
    await history.release?.();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
