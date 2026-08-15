import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolHistoryWriter, type ToolHistoryWriterHandle } from "@mono-agent/agent-harness";
import { describe, expect, it, vi } from "vitest";

import { lazyConfiguredToolHistory } from "../configured-agent.js";

describe("configured tool-history acquisition", () => {
  it("latches an acquisition outage for existing turns, re-arms on the next turn, and shares the recovered handle", async () => {
    const persist = vi.fn(async () => ({ persistence: "persisted" as const }));
    const finishRun = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const handle: ToolHistoryWriterHandle = {
      writer: { persist, finishRun } as unknown as ToolHistoryWriter,
      release,
    };
    const acquisitionError = Object.assign(new Error("transient private acquisition detail"), {
      code: "history_writer_in_use",
    });
    let rejectInitial!: (error: unknown) => void;
    const initialAttempt = new Promise<ToolHistoryWriterHandle>((_resolve, reject) => {
      rejectInitial = reject;
    });
    let attempts = 0;
    const acquireWriter = vi.fn((): Promise<ToolHistoryWriterHandle> => {
      attempts += 1;
      if (attempts === 1) return initialAttempt;
      if (attempts === 2) return Promise.reject(acquisitionError);
      return Promise.resolve(handle);
    });
    const warnings: string[] = [];
    const history = lazyConfiguredToolHistory({
      root: join(tmpdir(), "configured-tool-history-retry"),
      artifactRoot: join(tmpdir(), "configured-tool-history-artifacts"),
      rollover: "daily",
      onWarning: (message) => warnings.push(message),
      acquireWriter: acquireWriter as never,
    });
    const firstBinding = {
      conversationId: "chat:42#2026-08-14",
      logicalConversationId: "chat:42",
      runId: "outage-run",
      isolated: false,
    };
    const sink = history.writer.createSink(firstBinding);
    const event = {
      phase: "invocation" as const,
      toolCallId: "outage-call",
      toolName: "Read",
      arguments: { path: "README.md" },
    };

    let initialSettled = false;
    const initialWrite = sink(event);
    void initialWrite.then(
      () => { initialSettled = true; },
      () => { initialSettled = true; },
    );
    await Promise.resolve();
    expect(acquireWriter).toHaveBeenCalledTimes(1);
    expect(initialSettled).toBe(false);

    rejectInitial(acquisitionError);
    await expect(initialWrite).rejects.toMatchObject({ code: "history_writer_in_use" });

    // Later writes, including a recreated sink for the same run (for example a
    // provider fallback), reuse the settled rejection without another open.
    await expect(sink({ ...event, toolCallId: "later-call" }))
      .rejects.toMatchObject({ code: "history_writer_in_use" });
    await expect(history.writer.createSink(firstBinding)({ ...event, toolCallId: "fallback-call" }))
      .rejects.toMatchObject({ code: "history_writer_in_use" });
    expect(acquireWriter).toHaveBeenCalledTimes(1);

    const retryBinding = {
      conversationId: "chat:42#2026-08-14",
      logicalConversationId: "chat:42",
      runId: "retry-run",
      isolated: false,
    };
    const retrySink = history.writer.createSink(retryBinding);
    await expect(retrySink({ ...event, toolCallId: "retry-call" }))
      .rejects.toMatchObject({ code: "history_writer_in_use" });
    await expect(retrySink({ ...event, toolCallId: "retry-later-call" }))
      .rejects.toMatchObject({ code: "history_writer_in_use" });
    expect(acquireWriter).toHaveBeenCalledTimes(2);

    const recoveredBinding = { ...retryBinding, runId: "recovery-run" };
    await expect(history.writer.createSink(recoveredBinding)({ ...event, toolCallId: "recovery-call" }))
      .resolves.toEqual({ persistence: "persisted" });
    await expect(history.writer.createSink({ ...recoveredBinding, runId: "shared-handle-run" })({
      ...event,
      toolCallId: "shared-handle-call",
    })).resolves.toEqual({ persistence: "persisted" });
    await history.writer.finishRun(recoveredBinding, "succeeded");

    expect(acquireWriter).toHaveBeenCalledTimes(3);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      "Tool history writer acquisition failed (history_writer_in_use); the next turn will retry.",
      "Tool history writer acquisition recovered; lifecycle persistence resumed.",
    ]);
    expect(warnings.join(" ")).not.toContain("transient private acquisition detail");
    await history.release?.();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("serializes one fresh acquisition attempt per explicit reset after an outage while preserving turn latches", async () => {
    const base = await mkdtemp(join(tmpdir(), "configured-tool-history-reset-"));
    const root = join(base, "history");
    const initialized = await ToolHistoryWriter.open({ root });
    await initialized.close();

    const persist = vi.fn(async () => ({ persistence: "persisted" as const }));
    const finishRun = vi.fn(async () => undefined);
    const resetConversation = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const handle: ToolHistoryWriterHandle = {
      writer: { persist, finishRun, resetConversation } as unknown as ToolHistoryWriter,
      release,
    };
    const acquisitionError = Object.assign(new Error("private outage detail"), {
      code: "history_writer_in_use",
    });
    const pending: Array<{
      readonly resolve: (handle: ToolHistoryWriterHandle) => void;
      readonly reject: (error: unknown) => void;
    }> = [];
    let activeAttempts = 0;
    let maxActiveAttempts = 0;
    const acquireWriter = vi.fn((): Promise<ToolHistoryWriterHandle> => {
      activeAttempts += 1;
      maxActiveAttempts = Math.max(maxActiveAttempts, activeAttempts);
      return new Promise<ToolHistoryWriterHandle>((resolve, reject) => {
        pending.push({
          resolve: (resolvedHandle) => {
            activeAttempts -= 1;
            resolve(resolvedHandle);
          },
          reject: (error) => {
            activeAttempts -= 1;
            reject(error);
          },
        });
      });
    });
    const warnings: string[] = [];
    const history = lazyConfiguredToolHistory({
      root,
      artifactRoot: join(base, "artifacts"),
      rollover: "daily",
      onWarning: (message) => warnings.push(message),
      acquireWriter: acquireWriter as never,
    });
    const outageBinding = {
      conversationId: "chat:42#2026-08-14",
      logicalConversationId: "chat:42",
      runId: "outage-run",
      isolated: false,
    };
    const outageSink = history.writer.createSink(outageBinding);
    const event = {
      phase: "invocation" as const,
      toolCallId: "outage-call",
      toolName: "Read",
      arguments: { path: "README.md" },
    };

    try {
      const initialWrite = outageSink(event);
      await vi.waitFor(() => expect(acquireWriter).toHaveBeenCalledTimes(1));
      pending[0]!.reject(acquisitionError);
      await expect(initialWrite).rejects.toMatchObject({ code: "history_writer_in_use" });

      const firstReset = history.writer.resetConversation("chat:42");
      const secondReset = history.writer.resetConversation("chat:42");
      const firstResetResult = expect(firstReset).rejects.toMatchObject({ code: "history_writer_in_use" });
      const secondResetResult = expect(secondReset).rejects.toMatchObject({ code: "history_writer_in_use" });

      await vi.waitFor(() => expect(acquireWriter).toHaveBeenCalledTimes(2));
      expect(activeAttempts).toBe(1);
      pending[1]!.reject(acquisitionError);
      await firstResetResult;

      await vi.waitFor(() => expect(acquireWriter).toHaveBeenCalledTimes(3));
      expect(activeAttempts).toBe(1);
      pending[2]!.reject(acquisitionError);
      await secondResetResult;

      expect(maxActiveAttempts).toBe(1);
      expect(resetConversation).not.toHaveBeenCalled();
      await expect(outageSink({ ...event, toolCallId: "cached-failure-call" }))
        .rejects.toMatchObject({ code: "history_writer_in_use" });
      expect(acquireWriter).toHaveBeenCalledTimes(3);

      const recoveredBinding = { ...outageBinding, runId: "recovered-run" };
      const recoveredSink = history.writer.createSink(recoveredBinding);
      const recoveredFallbackSink = history.writer.createSink(recoveredBinding);
      const recoveredWrite = recoveredSink({ ...event, toolCallId: "recovered-call" });
      const recoveredFallbackWrite = recoveredFallbackSink({
        ...event,
        toolCallId: "recovered-fallback-call",
      });
      await vi.waitFor(() => expect(acquireWriter).toHaveBeenCalledTimes(4));
      expect(activeAttempts).toBe(1);
      pending[3]!.resolve(handle);
      await expect(recoveredWrite).resolves.toEqual({ persistence: "persisted" });
      await expect(recoveredFallbackWrite).resolves.toEqual({ persistence: "persisted" });
      await expect(history.writer.resetConversation("chat:42")).resolves.toBeUndefined();

      expect(acquireWriter).toHaveBeenCalledTimes(4);
      expect(maxActiveAttempts).toBe(1);
      expect(persist).toHaveBeenCalledTimes(2);
      expect(resetConversation).toHaveBeenCalledTimes(1);
      expect(warnings).toEqual([
        "Tool history writer acquisition failed (history_writer_in_use); the next turn will retry.",
        "Tool history writer acquisition recovered; lifecycle persistence resumed.",
      ]);
      expect(warnings.join(" ")).not.toContain("private outage detail");
    } finally {
      await history.release?.();
      await rm(base, { recursive: true, force: true });
    }
    expect(release).toHaveBeenCalledTimes(1);
  });
});
