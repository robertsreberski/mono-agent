import { describe, expect, it, vi } from "vitest";

import {
  createProcessJobsRuntimeExtension,
  processJobOriginForRequest,
} from "../process-jobs-runtime.js";
import { runWithProcessJobWakeContext } from "../process-jobs-context.js";
import { stopProcessJobsService } from "../app-controller-process-jobs.js";

describe("process-job request availability", () => {
  it("clears the app service and reports cleanup failures without blocking lifecycle teardown", async () => {
    const stop = vi.fn(async () => { throw new Error("cleanup failed"); });
    const warn = vi.fn();
    const controller = {
      logger: { warn },
      processJobsService: { stop },
      processJobsServiceStart: Promise.resolve(undefined),
    } as never;

    await expect(stopProcessJobsService(controller)).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    expect(controller).toMatchObject({
      processJobsService: undefined,
      processJobsServiceStart: undefined,
    });
    expect(warn).toHaveBeenCalledWith(
      "Process-job controller did not stop cleanly.",
      { reason: "cleanup failed" },
    );
  });

  it("captures exact Slack, Telegram, and existing-web origins including bucket and reply boundary", () => {
    expect(processJobOriginForRequest({
      runId: "run-slack",
      request: {
        conversationId: "slack:C1:1.1#2026-08-14",
        replyTo: { conversationId: "slack:C1:1.1#2026-08-14" },
        text: "hello",
      } as never,
    }, "slack")).toEqual({
      conversationId: "slack:C1:1.1#2026-08-14",
      baseConversationId: "slack:C1:1.1",
      bucket: "2026-08-14",
      replyToConversationId: "slack:C1:1.1",
      normalizedReplyTarget: "slack:C1:1.1",
      runId: "run-slack",
      historyBoundary: "run-slack",
      channel: "slack",
    });
    expect(processJobOriginForRequest({
      runId: "run-tg",
      request: { conversationId: "telegram:42", text: "hello" } as never,
    }, "telegram")).toMatchObject({ channel: "telegram", replyToConversationId: "telegram:42" });
    expect(processJobOriginForRequest({
      runId: "run-web",
      request: { conversationId: "web:thread-1", text: "hello", metadata: { source: "web" } } as never,
    }, "tui")).toMatchObject({ channel: "web", replyToConversationId: "web:thread-1" });
  });

  it("refuses TUI-direct, new-web, cron, webhook, OpenAI API, A2A, and mismatched reply origins", () => {
    const cases = [
      ["tui", { conversationId: "tui:direct", metadata: { source: "tui" } }],
      ["tui", { conversationId: "web:new", metadata: { source: "web" } }],
      ["cron", { conversationId: "cron:job" }],
      ["webhook", { conversationId: "webhook:event" }],
      ["openai-api", { conversationId: "openai-api:request" }],
      ["a2a", { conversationId: "a2a:request" }],
      ["slack", { conversationId: "slack:C1:1.1", replyTo: { conversationId: "telegram:42" } }],
    ] as const;
    for (const [channelId, request] of cases) {
      expect(processJobOriginForRequest({ runId: "run", request: { text: "hello", ...request } as never }, channelId as never)).toBeUndefined();
    }
  });

  it("injects only for allowed Pi-native turns and removes the schema at the host chain-depth ceiling", async () => {
    const controller = vi.fn(() => ({ start: vi.fn() }));
    const extension = createProcessJobsRuntimeExtension({
      service: {
        settings: { maxChainDepth: 4 },
        controller,
      } as never,
      coreConfig: {
        runtime: { model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" }, executionMode: "sdk" },
        tools: { allowedTools: ["Exec", "Bash"], disallowedTools: [] },
      } as never,
      channelId: "slack",
      targetsPiNative: (metadata) => metadata?.route !== "claude",
    });
    const input = (metadata?: Record<string, unknown>) => ({
      runId: "run-1",
      request: { conversationId: "slack:C1:1.1", text: "hello", ...(metadata === undefined ? {} : { metadata }) },
    }) as never;
    await expect(extension(input())).resolves.toMatchObject({ runtimeOptions: { processJobs: expect.any(Object) } });
    expect(controller).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "slack:C1:1.1" }), 0);
    await expect(extension(input({ route: "claude" }))).resolves.toEqual({ runtimeOptions: {}, cleanup: expect.any(Function) });

    const depthLimited = createProcessJobsRuntimeExtension({
      service: { settings: { maxChainDepth: 4 }, controller } as never,
      coreConfig: {
        runtime: { model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" }, executionMode: "sdk" },
        tools: { allowedTools: ["Exec"], disallowedTools: [] },
      } as never,
      channelId: "slack",
      targetsPiNative: () => true,
    });
    await expect(runWithProcessJobWakeContext(
      { jobId: "parent", chainDepth: 4 },
      async () => await depthLimited(input({ chainDepth: 0 })),
    )).resolves.toEqual({ runtimeOptions: {}, cleanup: expect.any(Function) });
  });
});
