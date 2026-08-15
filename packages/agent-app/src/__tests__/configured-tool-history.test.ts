import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolHistoryWriter, type ToolHistoryWriterHandle } from "@mono-agent/agent-harness";
import { describe, expect, it, vi } from "vitest";

import { lazyConfiguredToolHistory } from "../configured-agent.js";

describe("configured tool-history acquisition", () => {
  it("bounds the initial wait, progressively fast-fails ordinary outage cadence, and recovers without poison", async () => {
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
    let now = 0;
    const history = lazyConfiguredToolHistory({
      root: join(tmpdir(), "configured-tool-history-retry"),
      artifactRoot: join(tmpdir(), "configured-tool-history-artifacts"),
      rollover: "daily",
      onWarning: (message) => warnings.push(message),
      acquireWriter: acquireWriter as never,
      now: () => now,
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

    now = 1_500;
    const cooldownBinding = { ...firstBinding, runId: "cooldown-run" };
    await expect(history.writer.createSink(cooldownBinding)({ ...event, toolCallId: "cooldown-call" }))
      .rejects.toMatchObject({ code: "history_writer_in_use" });
    expect(acquireWriter).toHaveBeenCalledTimes(1);

    now = 30_000;
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

    // The failed probe doubles the cooldown. Ordinary turns throughout that
    // interval reuse the settled failure instead of paying another full
    // restart-handoff acquisition ceiling.
    for (const [cadenceMs, runId] of [[31_500, "cadence-a"], [60_000, "cadence-b"], [89_999, "cadence-c"]] as const) {
      now = cadenceMs;
      await expect(history.writer.createSink({ ...retryBinding, runId })({
        ...event,
        toolCallId: `${runId}-call`,
      })).rejects.toMatchObject({ code: "history_writer_in_use" });
      expect(acquireWriter).toHaveBeenCalledTimes(2);
    }

    now = 90_000;
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
      "Tool history writer acquisition failed (history_writer_in_use); new turns fail fast for 30000 ms and repeated failures back off to 300000 ms, while explicit reset may retry immediately.",
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
    let now = 0;
    const history = lazyConfiguredToolHistory({
      root,
      artifactRoot: join(base, "artifacts"),
      rollover: "daily",
      onWarning: (message) => warnings.push(message),
      acquireWriter: acquireWriter as never,
      acquisitionFailureBackoffMs: 1_000,
      acquisitionFailureBackoffMaxMs: 4_000,
      now: () => now,
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

      const cooldownBinding = { ...outageBinding, runId: "cooldown-run" };
      await expect(history.writer.createSink(cooldownBinding)({ ...event, toolCallId: "cooldown-call" }))
        .rejects.toMatchObject({ code: "history_writer_in_use" });
      expect(acquireWriter).toHaveBeenCalledTimes(3);

      now = 4_000;
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
        "Tool history writer acquisition failed (history_writer_in_use); new turns fail fast for 1000 ms and repeated failures back off to 4000 ms, while explicit reset may retry immediately.",
        "Tool history writer acquisition recovered; lifecycle persistence resumed.",
      ]);
      expect(warnings.join(" ")).not.toContain("private outage detail");
    } finally {
      await history.release?.();
      await rm(base, { recursive: true, force: true });
    }
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("invalidates closed and dead cached writers, then shares each reset-recovered handle", async () => {
    const base = await mkdtemp(join(tmpdir(), "configured-tool-history-worker-recovery-"));
    const root = join(base, "history");
    const initialized = await ToolHistoryWriter.open({ root });
    await initialized.close();

    let firstClosed = false;
    const firstPersist = vi.fn(async () => {
      firstClosed = true;
      return { persistence: "failed" as const, errorCode: "history_writer_closed" };
    });
    const firstRelease = vi.fn(async () => undefined);
    const firstHandle: ToolHistoryWriterHandle = {
      writer: {
        get isClosed() { return firstClosed; },
        persist: firstPersist,
      } as unknown as ToolHistoryWriter,
      release: firstRelease,
    };

    let secondClosed = false;
    const secondPersist = vi.fn(async () => ({ persistence: "persisted" as const }));
    const secondFinish = vi.fn(async () => undefined);
    const secondReset = vi.fn(async () => undefined);
    const secondRelease = vi.fn(async () => undefined);
    const secondHandle: ToolHistoryWriterHandle = {
      writer: {
        get isClosed() { return secondClosed; },
        persist: secondPersist,
        finishRun: secondFinish,
        resetConversation: secondReset,
      } as unknown as ToolHistoryWriter,
      release: secondRelease,
    };

    const thirdPersist = vi.fn(async () => ({ persistence: "persisted" as const }));
    const thirdReset = vi.fn(async () => undefined);
    const thirdRelease = vi.fn(async () => undefined);
    const thirdHandle: ToolHistoryWriterHandle = {
      writer: {
        isClosed: false,
        persist: thirdPersist,
        finishRun: vi.fn(async () => undefined),
        resetConversation: thirdReset,
      } as unknown as ToolHistoryWriter,
      release: thirdRelease,
    };
    const handles = [firstHandle, secondHandle, thirdHandle];
    const acquireWriter = vi.fn(async () => handles.shift()!);
    const history = lazyConfiguredToolHistory({
      root,
      artifactRoot: join(base, "artifacts"),
      rollover: "daily",
      acquireWriter: acquireWriter as never,
    });
    const event = {
      phase: "invocation" as const,
      toolCallId: "call",
      toolName: "Read",
      arguments: {},
    };
    const firstBinding = {
      conversationId: "chat:42#2026-08-14",
      logicalConversationId: "chat:42",
      runId: "closed-run",
      isolated: false,
    };

    try {
      const firstSink = history.writer.createSink(firstBinding);
      await expect(firstSink(event)).resolves.toEqual({
        persistence: "failed",
        errorCode: "history_writer_closed",
      });
      await expect(firstSink({ ...event, toolCallId: "same-turn-call" }))
        .rejects.toMatchObject({ code: "history_writer_closed" });
      expect(acquireWriter).toHaveBeenCalledTimes(1);

      await expect(history.writer.resetConversation("chat:42")).resolves.toBeUndefined();
      expect(acquireWriter).toHaveBeenCalledTimes(2);
      expect(firstRelease).toHaveBeenCalledTimes(1);
      expect(secondReset).toHaveBeenCalledTimes(1);

      const sharedBinding = { ...firstBinding, runId: "shared-second-handle" };
      await expect(history.writer.createSink(sharedBinding)({ ...event, toolCallId: "shared-call" }))
        .resolves.toEqual({ persistence: "persisted" });
      expect(acquireWriter).toHaveBeenCalledTimes(2);
      expect(secondPersist).toHaveBeenCalledTimes(1);

      secondClosed = true;
      const deadBinding = { ...firstBinding, runId: "dead-worker-run" };
      await expect(history.writer.createSink(deadBinding)({ ...event, toolCallId: "dead-call" }))
        .rejects.toMatchObject({ code: "history_writer_closed" });
      expect(acquireWriter).toHaveBeenCalledTimes(2);

      await expect(history.writer.resetConversation("chat:42")).resolves.toBeUndefined();
      expect(acquireWriter).toHaveBeenCalledTimes(3);
      expect(secondRelease).toHaveBeenCalledTimes(1);
      expect(thirdReset).toHaveBeenCalledTimes(1);

      const recoveredBinding = { ...firstBinding, runId: "shared-third-handle" };
      await expect(history.writer.createSink(recoveredBinding)({ ...event, toolCallId: "recovered-call" }))
        .resolves.toEqual({ persistence: "persisted" });
      expect(acquireWriter).toHaveBeenCalledTimes(3);
      expect(thirdPersist).toHaveBeenCalledTimes(1);
    } finally {
      await history.release?.();
      await rm(base, { recursive: true, force: true });
    }
    expect(thirdRelease).toHaveBeenCalledTimes(1);
  });
});
