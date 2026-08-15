import { describe, expect, it, vi } from "vitest";

import { createLiveSessionManager } from "@mono-agent/agent-harness";

import {
  createProcessJobsRuntimeExtension,
  processJobOriginForRequest,
} from "../process-jobs-runtime.js";
import {
  bindProcessJobWakeContextToResponder,
  runWithProcessJobWakeContext,
} from "../process-jobs-context.js";
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
      ["slack", { conversationId: "slack:C1:1.1", replyTo: { conversationId: "slack:C2:2.2" } }],
      ["slack", { conversationId: "telegram:42", replyTo: { conversationId: "slack:C1:1.1" } }],
      ["slack", { conversationId: "slack:c1:1.1", replyTo: { conversationId: "slack:c1:1.1" } }],
      ["telegram", { conversationId: "telegram:042", replyTo: { conversationId: "telegram:042" } }],
      ["tui", { conversationId: "web:thread-1", replyTo: { conversationId: "web:thread-2" }, metadata: { source: "web" } }],
    ] as const;
    for (const [channelId, request] of cases) {
      expect(processJobOriginForRequest({ runId: "run", request: { text: "hello", ...request } as never }, channelId as never)).toBeUndefined();
    }
  });

  it("injects only for allowed Pi-native turns", async () => {
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

  });

  it("preserves parent-plus-one depth through a busy live-session queue and removes capability at max depth", async () => {
    const controller = vi.fn(() => ({ start: vi.fn() }));
    const extension = createProcessJobsRuntimeExtension({
      service: { settings: { maxChainDepth: 4 }, controller } as never,
      coreConfig: {
        runtime: { model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" }, executionMode: "sdk" },
        tools: { allowedTools: ["Exec"], disallowedTools: [] },
      } as never,
      channelId: "slack",
      targetsPiNative: () => true,
    });
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
    let activeStarted = false;
    const outcomes = new Map<string, Awaited<ReturnType<typeof extension>>>();
    const manager = createLiveSessionManager({
      run: async (request) => {
        if (request.userMessage === "active") {
          activeStarted = true;
          await activeGate;
        } else {
          outcomes.set(request.userMessage, await extension({
            runId: `run-${request.userMessage}`,
            request,
            context: {},
          } as never));
        }
        return {
          text: "ok",
          metadata: {
            runId: `run-${request.userMessage}`,
            conversationId: request.conversationId,
            contextSources: [],
            contextSectionIds: [],
          },
        };
      },
    });
    const responder = bindProcessJobWakeContextToResponder({
      respond: async (request) => {
        const response = await manager.enqueue(request.conversationId, {
          conversationId: request.conversationId,
          userMessage: request.text,
          abortSignal: request.abortSignal,
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        });
        return {
          ...(response.text === undefined ? {} : { text: response.text }),
          metadata: response.metadata,
        };
      },
    });
    const stream = { append: async () => undefined };
    const abortSignal = new AbortController().signal;
    const active = responder.respond({
      conversationId: "slack:C1:1.1",
      text: "active",
      abortSignal,
      metadata: { source: "interactive" },
    }, stream);
    await vi.waitFor(() => expect(activeStarted).toBe(true));

    let parentPlusOne!: ReturnType<typeof responder.respond>;
    await runWithProcessJobWakeContext({ jobId: "parent-depth-2", chainDepth: 3 }, async () => {
      parentPlusOne = responder.respond({
        conversationId: "slack:C1:1.1",
        text: "parent-plus-one",
        abortSignal,
        metadata: { chainDepth: 0, userForgeAttempt: 999 },
      }, stream);
    });
    let atMaximum!: ReturnType<typeof responder.respond>;
    await runWithProcessJobWakeContext({ jobId: "parent-depth-3", chainDepth: 4 }, async () => {
      atMaximum = responder.respond({
        conversationId: "slack:C1:1.1",
        text: "at-maximum",
        abortSignal,
        metadata: { chainDepth: 0 },
      }, stream);
    });
    expect(manager.pendingCount("slack:C1:1.1")).toBe(2);

    releaseActive();
    await Promise.all([active, parentPlusOne, atMaximum]);
    expect(outcomes.get("parent-plus-one")).toMatchObject({
      runtimeOptions: { processJobs: expect.any(Object) },
    });
    expect(outcomes.get("at-maximum")).toEqual({ runtimeOptions: {}, cleanup: expect.any(Function) });
    expect(controller).toHaveBeenCalledOnce();
    expect(controller).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "slack:C1:1.1" }),
      3,
    );
    await manager.dispose();
  });

  it("fails closed when a host wake lacks the private request-identity seam", async () => {
    const respond = vi.fn(async () => ({ text: "unexpected" }));
    const responder = bindProcessJobWakeContextToResponder({ respond });

    await expect(runWithProcessJobWakeContext(
      { jobId: "parent", chainDepth: 1 },
      async () => await responder.respond({
        conversationId: "slack:C1:1.1",
        text: "wake",
        abortSignal: new AbortController().signal,
      }, { append: async () => undefined }),
    )).rejects.toThrow(/missing its host-owned request identity/u);
    expect(respond).not.toHaveBeenCalled();
  });
});
