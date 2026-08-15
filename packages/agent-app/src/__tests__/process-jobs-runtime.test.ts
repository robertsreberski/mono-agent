import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createAgentHarness,
  createAgentResponder,
  createInMemoryHistoryStore,
  createLiveSessionManager,
} from "@mono-agent/agent-harness";

import {
  createProcessJobsRuntimeExtension,
  processJobOriginForRequest,
} from "../process-jobs-runtime.js";
import {
  bindProcessJobWakeContextToResponder,
  processJobWakeContextForRequest,
  runWithProcessJobWakeContext,
} from "../process-jobs-context.js";
import {
  publishProcessJobsHealth,
  stopProcessJobsService,
} from "../app-controller-process-jobs.js";
import { traceMetadata } from "../app-controller-traceability.js";

const PROCESS_JOB_WAKE_DELIVERY_METADATA = Symbol.for("mono-agent.process-job-wake.delivery-key.v1");

describe("process-job request availability", () => {
  it("publishes later storage degradation to live TUI status and trace metadata", async () => {
    const refreshTraceSource = vi.fn(async () => undefined);
    const setStatus = vi.fn((_id, status) => status);
    const health = {
      state: "degraded",
      quarantinedTransactions: 2,
      failureOperation: "list",
      failureDetectedAt: "2026-08-15T12:00:00.000Z",
    } as const;
    const processJobsService = {
      settings: { stateDir: "/private/state/process-jobs" },
      health,
    };
    const controllerState = {
      running: new Map([[
        "tui",
        { stop: vi.fn(), summary: { transport: "tui", existing: true } },
      ]]),
      statuses: new Map([[
        "tui",
        { kind: "running", summary: { transport: "tui", existing: true } },
      ]]),
      setStatus,
      refreshTraceSource,
      processJobsService,
      processJobsDegradation: undefined,
      drivers: [],
      startupCompleted: false,
      backgroundSnapshot: undefined,
      exporterStatusValue: { kind: "disabled", reason: "test" },
      sandboxStatusValue: {
        configured: false,
        effective: "off",
        fallbackActive: false,
        unsafeAllowHostProcess: false,
      },
      memoryHealthValue: { state: "disabled" },
      selectedSkillsValue: undefined,
      sessionMetadataValue: undefined,
    };
    const controller = controllerState as never;

    await publishProcessJobsHealth(controller, "/private/state/process-jobs", health);

    expect(controllerState.running.get("tui")).toMatchObject({
      summary: {
        existing: true,
        processJobs: {
          stateDir: "/private/state/process-jobs",
          health: "degraded",
          quarantinedTransactions: 2,
          failureOperation: "list",
        },
      },
    });
    expect(setStatus).toHaveBeenCalledWith("tui", expect.objectContaining({
      kind: "running",
      summary: expect.objectContaining({ processJobs: expect.objectContaining({ health: "degraded" }) }),
    }));
    expect(refreshTraceSource).toHaveBeenCalledWith("process-jobs-health");
    expect(traceMetadata(controller, "heartbeat")).toMatchObject({
      processJobs: {
        stateDir: "/private/state/process-jobs",
        state: "degraded",
        failureOperation: "list",
        failureDetectedAt: "2026-08-15T12:00:00.000Z",
      },
    });
  });

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
    }, "process-job:parent-depth-2");
    let atMaximum!: ReturnType<typeof responder.respond>;
    await runWithProcessJobWakeContext({ jobId: "parent-depth-3", chainDepth: 4 }, async () => {
      atMaximum = responder.respond({
        conversationId: "slack:C1:1.1",
        text: "at-maximum",
        abortSignal,
        metadata: { chainDepth: 0 },
      }, stream);
    }, "process-job:parent-depth-3");
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

  it.each(["slack", "telegram"] as const)(
    "retains inherited depth when a %s wake waits behind a busy conversation",
    async (channel) => {
      const conversationId = channel === "slack" ? "slack:C1:1.1" : "telegram:42";
      const controller = vi.fn((_request: unknown, _chainDepth: number) => ({ start: vi.fn() }));
      const extension = createProcessJobsRuntimeExtension({
        service: { settings: { maxChainDepth: 4 }, controller } as never,
        coreConfig: {
          runtime: { model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" }, executionMode: "sdk" },
          tools: { allowedTools: ["Exec"], disallowedTools: [] },
        } as never,
        channelId: channel,
        targetsPiNative: () => true,
      });
      let release!: () => void;
      const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
      let activeStarted = false;
      let outcome: Awaited<ReturnType<typeof extension>> | undefined;
      const manager = createLiveSessionManager({
        run: async (request) => {
          if (request.userMessage === "active") {
            activeStarted = true;
            await gate;
          }
          else outcome = await extension({ runId: "wake-run", request, context: {} } as never);
          return {
            text: "ok",
            metadata: {
              runId: "run",
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
          return { text: response.text ?? "", metadata: response.metadata };
        },
      });
      const stream = { append: async () => undefined };
      const first = responder.respond({
        conversationId,
        text: "active",
        metadata: { source: "interactive" },
        abortSignal: new AbortController().signal,
      }, stream);
      await vi.waitFor(() => expect(activeStarted).toBe(true));
      const deliveryKey = `process-job:${channel}-parent`;
      const wake = runWithProcessJobWakeContext(
        { jobId: "parent", chainDepth: 3 },
        async () => await responder.respond({
          conversationId,
          text: "wake",
          metadata: {
            forgedDepth: 0,
            [PROCESS_JOB_WAKE_DELIVERY_METADATA]: deliveryKey,
          },
          abortSignal: new AbortController().signal,
        }, stream),
        deliveryKey,
      );
      await vi.waitFor(() => expect(manager.pendingCount(conversationId)).toBe(1));
      release();
      await Promise.all([first, wake]);
      expect(outcome).toMatchObject({ runtimeOptions: { processJobs: expect.any(Object) } });
      expect(controller).toHaveBeenCalledWith(expect.any(Object), 3);
      await manager.dispose();
    },
  );

  it.each([
    { label: "below limit", chainDepth: 3, expectedCalls: 2 },
    { label: "at limit", chainDepth: 4, expectedCalls: 0 },
  ])("keeps wake context across a real harness resume retry $label", async ({ chainDepth, expectedCalls }) => {
    const dir = await mkdtemp(join(tmpdir(), "agent-app-process-job-retry-"));
    try {
      const identityPath = join(dir, "IDENTITY.md");
      await writeFile(identityPath, "You are Mono.", "utf8");
      const controller = vi.fn((_request: unknown, _chainDepth: number) => ({ start: vi.fn() }));
      const extension = createProcessJobsRuntimeExtension({
        service: { settings: { maxChainDepth: 4 }, controller } as never,
        coreConfig: {
          runtime: { model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" }, executionMode: "sdk" },
          tools: { allowedTools: ["Exec"], disallowedTools: [] },
        } as never,
        channelId: "slack",
        targetsPiNative: () => true,
      });
      let runtimeCall = 0;
      const harness = createAgentHarness({
        identityPath,
        model: {
          sdk: "pi",
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          reference: "pi:openai-codex:gpt-5.6-sol",
        },
        executionMode: "sdk",
        session: { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true },
        historyStore: createInMemoryHistoryStore({ maxMessages: 10 }),
        runtimeOptionsForRequest: extension,
        runtime: {
          async run(_prompt, options) {
            runtimeCall += 1;
            if (runtimeCall === 2 && options.sessionId !== undefined) {
              return { failureKind: "session_not_found", error: "stale" };
            }
            return { text: "ok", providerSessionId: `session-${String(runtimeCall)}` };
          },
          async disposeSession() { return true; },
        },
      });
      const responder = bindProcessJobWakeContextToResponder(createAgentResponder({ harness }));
      const stream = { append: async () => undefined };
      const request = {
        conversationId: "slack:C1:1.1",
        text: "prime",
        metadata: { source: "slack" },
        abortSignal: new AbortController().signal,
      };
      await responder.respond(request, stream);
      controller.mockClear();
      await runWithProcessJobWakeContext(
        { jobId: "parent", chainDepth },
        async () => await responder.respond({ ...request, text: "wake" }, stream),
        "process-job:parent",
      );
      expect(runtimeCall).toBe(3);
      expect(controller).toHaveBeenCalledTimes(expectedCalls);
      for (const call of controller.mock.calls) expect(call[1]).toBe(chainDepth);
      await harness.dispose?.();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves only the exact wake delivery identity while unrelated requests resolve none", async () => {
    const deliveryKey = "process-job:exact-parent";
    let release!: () => void;
    let registered!: () => void;
    const registeredPromise = new Promise<void>((resolve) => { registered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const flight = runWithProcessJobWakeContext(
      { jobId: "exact-parent", chainDepth: 3 },
      async () => {
        registered();
        await gate;
      },
      deliveryKey,
    );
    await registeredPromise;

    expect(processJobWakeContextForRequest({
      metadata: { [PROCESS_JOB_WAKE_DELIVERY_METADATA]: deliveryKey },
    })).toEqual({
      kind: "resolved",
      context: { jobId: "exact-parent", chainDepth: 3 },
    });
    expect(processJobWakeContextForRequest({
      metadata: { source: "slack", interactive: true },
    })).toEqual({ kind: "none" });
    expect(processJobWakeContextForRequest({})).toEqual({ kind: "none" });

    release();
    await flight;
  });

  it("fails closed when overlapping wake flights reuse one exact delivery discriminator", async () => {
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
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const deliveryKey = "process-job:ambiguous";
    const first = runWithProcessJobWakeContext(
      { jobId: "one", chainDepth: 1 }, async () => await gate, deliveryKey,
    );
    const second = runWithProcessJobWakeContext(
      { jobId: "one", chainDepth: 1 }, async () => await gate, deliveryKey,
    );
    const outcome = await extension({
      runId: "lost",
      request: {
        conversationId: "slack:C1:1.1",
        text: "wake",
        metadata: {
          forgedDepth: 0,
          [PROCESS_JOB_WAKE_DELIVERY_METADATA]: deliveryKey,
        },
      },
      context: {},
    } as never);
    expect(outcome).toEqual({ runtimeOptions: {}, cleanup: expect.any(Function) });
    expect(controller).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
  });

  it("removes only the exact re-entrant responder binding that each invocation installed", async () => {
    const metadata = {};
    const request = {
      conversationId: "slack:C1:1.1",
      text: "wake",
      metadata,
      abortSignal: new AbortController().signal,
    };
    let nested = false;
    let afterInner: ReturnType<typeof processJobWakeContextForRequest> | undefined;
    let responder!: ReturnType<typeof bindProcessJobWakeContextToResponder>;
    responder = bindProcessJobWakeContextToResponder({
      respond: async (input, stream) => {
        if (!nested) {
          nested = true;
          await responder.respond(input, stream);
          afterInner = processJobWakeContextForRequest(input);
        }
        return { text: "ok" };
      },
    });
    await runWithProcessJobWakeContext(
      { jobId: "parent", chainDepth: 2 },
      async () => await responder.respond(request, { append: async () => undefined }),
      "process-job:parent",
    );
    expect(afterInner).toEqual({
      kind: "resolved",
      context: { jobId: "parent", chainDepth: 2 },
    });
    expect(processJobWakeContextForRequest(request)).toEqual({ kind: "none" });
  });

  it("preserves rich-reply host methods with their original responder binding", async () => {
    let owner: object;
    const openReplyArtifact = vi.fn(async function (this: object) {
      expect(this).toBe(owner);
      return {} as never;
    });
    const loadMcpApp = vi.fn(async function (this: object) {
      expect(this).toBe(owner);
      return {} as never;
    });
    const requestMcpApp = vi.fn(async function (this: object) {
      expect(this).toBe(owner);
      return { accepted: true };
    });
    owner = {
      respond: async () => ({ text: "ok" }),
      openReplyArtifact,
      loadMcpApp,
      requestMcpApp,
    };
    const responder = bindProcessJobWakeContextToResponder(owner as never);

    await expect(responder.openReplyArtifact?.({} as never)).resolves.toEqual({});
    await expect(responder.loadMcpApp?.({} as never)).resolves.toEqual({});
    await expect(responder.requestMcpApp?.({} as never)).resolves.toEqual({ accepted: true });
    expect(openReplyArtifact).toHaveBeenCalledOnce();
    expect(loadMcpApp).toHaveBeenCalledOnce();
    expect(requestMcpApp).toHaveBeenCalledOnce();
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
      "process-job:parent",
    )).rejects.toThrow(/missing its host-owned request identity/u);
    expect(respond).not.toHaveBeenCalled();
  });
});
