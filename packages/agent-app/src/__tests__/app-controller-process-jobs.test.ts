import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessJobProjection } from "@mono-agent/agent-contracts";
import { MonoAgentConfigError } from "@mono-agent/config";

import {
  activateProcessJobWakes,
  ensureProcessJobsService,
  stopProcessJobsService,
  type ProcessJobsControllerPort,
} from "../app-controller-process-jobs.js";
import {
  createSlackChannelDriver,
  createTelegramChannelDriver,
  type ChannelStartInput,
} from "../channels.js";
import type {
  OpenProcessJobsServiceOptions,
  ProcessJobsServiceHandle,
} from "../process-jobs-service.js";

const processJobsService = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("../process-jobs-service.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../process-jobs-service.js")>(),
  openProcessJobsService: processJobsService.open,
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  processJobsService.open.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe("process-job lifecycle surface routing", () => {
  it("fails startup with a typed config error before opening overlapping durable state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-process-job-overlap-"));
    temporaryDirectories.push(cwd);
    const configReadPath = join(cwd, "mono-agent.config.json");
    await writeFile(configReadPath, JSON.stringify({
      artifacts: { dir: ".config-state/artifacts" },
      processJobs: { enabled: true, stateDir: ".state/history" },
    }));
    const controller: ProcessJobsControllerPort = {
      cwd,
      configReadPath,
      env: { MONO_AGENT_ARTIFACT_DIR: ".state/artifacts" },
      logger: undefined,
      running: new Map(),
      statuses: new Map(),
      stopped: false,
      processJobsService: undefined,
      processJobsServiceStart: undefined,
      processJobsStateDir: undefined,
      processJobsDegradation: undefined,
      observabilityContext: async () => ({}),
      setStatus: (_id, status) => status,
      refreshTraceSource: async () => undefined,
    };

    let failure: unknown;
    try {
      await ensureProcessJobsService(controller);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MonoAgentConfigError);
    expect(failure).toMatchObject({
      code: "invalid_json",
      details: { path: "processJobs.stateDir", purgeRootKind: "durable session/tool history" },
    });
    expect(processJobsService.open).not.toHaveBeenCalled();
    expect(controller.processJobsStateDir).toBeUndefined();
    expect(controller.processJobsDegradation).toBeUndefined();
  });

  it("retains the resolved configured private root when the durable store fails to open", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-process-job-degraded-open-"));
    temporaryDirectories.push(cwd);
    const configReadPath = join(cwd, "mono-agent.config.json");
    await writeFile(configReadPath, JSON.stringify({
      processJobs: { enabled: true, stateDir: ".state/jobs" },
    }));
    processJobsService.open.mockRejectedValue(new Error("durable store unavailable"));
    const controller: ProcessJobsControllerPort = {
      cwd,
      configReadPath,
      env: {},
      logger: undefined,
      running: new Map(),
      statuses: new Map(),
      stopped: false,
      processJobsService: undefined,
      processJobsServiceStart: undefined,
      processJobsStateDir: undefined,
      processJobsDegradation: undefined,
      observabilityContext: async () => ({}),
      setStatus: (_id, status) => status,
      refreshTraceSource: async () => undefined,
    };

    await expect(ensureProcessJobsService(controller)).resolves.toBeUndefined();

    const stateDir = join(await realpath(cwd), ".state/jobs");
    expect(controller.processJobsService).toBeUndefined();
    expect(controller.processJobsStateDir).toBe(stateDir);
    expect(controller.processJobsDegradation).toEqual({
      stateDir,
      reason: "durable store unavailable",
    });
  });

  it("stops and never publishes a service whose open resolves after teardown invalidates its flight", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-process-job-late-open-"));
    temporaryDirectories.push(cwd);
    const configReadPath = join(cwd, "mono-agent.config.json");
    await writeFile(configReadPath, JSON.stringify({ processJobs: { enabled: true } }));
    const opened = deferred<ProcessJobsServiceHandle>();
    const stop = vi.fn(async () => undefined);
    const activateWakes = vi.fn(async () => undefined);
    const lateService = { stop, activateWakes } as unknown as ProcessJobsServiceHandle;
    processJobsService.open.mockImplementation(async () => await opened.promise);
    const controller: ProcessJobsControllerPort = {
      cwd,
      configReadPath,
      env: {},
      logger: undefined,
      running: new Map(),
      statuses: new Map(),
      stopped: false,
      processJobsService: undefined,
      processJobsServiceStart: undefined,
      processJobsStateDir: undefined,
      processJobsDegradation: undefined,
      observabilityContext: async () => ({}),
      setStatus: (_id, status) => status,
      refreshTraceSource: async () => undefined,
    };

    const staleStartup = ensureProcessJobsService(controller).then(async () => {
      await activateProcessJobWakes(controller);
    });
    await vi.waitFor(() => expect(processJobsService.open).toHaveBeenCalledOnce());
    const teardown = stopProcessJobsService(controller);
    expect(controller.processJobsService).toBeUndefined();
    expect(controller.processJobsServiceStart).toBeUndefined();

    opened.resolve(lateService);
    await Promise.all([staleStartup, teardown]);

    expect(stop).toHaveBeenCalledOnce();
    expect(activateWakes).not.toHaveBeenCalled();
    expect(controller.processJobsService).toBeUndefined();
    expect(controller.processJobsServiceStart).toBeUndefined();
    expect(controller.processJobsServiceStartFlight).toBeUndefined();
    expect(controller.processJobsStateDir).toBeUndefined();
    expect(controller.processJobsDegradation).toBeUndefined();
  });

  it("sends bucketed Slack and Telegram origins to their exact-base real driver destinations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-process-job-surface-"));
    temporaryDirectories.push(cwd);
    const configReadPath = join(cwd, "mono-agent.config.json");
    await writeFile(configReadPath, JSON.stringify({ processJobs: { enabled: true } }));

    const slackUpdate = vi.fn(async () => ({ delivered: true }));
    const slack = await createSlackChannelDriver({
      startAdapter: async () => ({
        stop: async () => undefined,
        adapter: { notify: vi.fn(), updateProcessJob: slackUpdate },
      }) as never,
    }).start(startInput(cwd, {
      enabled: true,
      botToken: "bot-token",
      appToken: "app-token",
      allowedChannelIds: ["C1"],
      allowAllChannels: false,
      botUserIds: [],
      mentionTextAliases: [],
      stripMentionText: false,
      shortcuts: [],
      homeTab: { enabled: false, buttons: [] },
      resolveUserNames: true,
      resolveChannelNames: true,
      threadContext: {
        enabled: true,
        maxMessages: 15,
        requestLimit: 15,
        timeoutMs: 4_000,
        includeBotMessages: true,
      },
    }));
    const telegramUpdate = vi.fn(async () => ({ delivered: true }));
    const telegram = await createTelegramChannelDriver({
      startAdapter: async () => ({
        stop: async () => undefined,
        notify: vi.fn(),
        updateProcessJob: telegramUpdate,
      }) as never,
    }).start(startInput(cwd, {
      enabled: true,
      botToken: "bot-token",
      allowedChatIds: ["42"],
      allowAllChats: false,
    }));
    const slackNotify = vi.spyOn(slack, "notify");
    const telegramNotify = vi.spyOn(telegram, "notify");
    const running = new Map([
      ["slack", slack],
      ["telegram", telegram],
    ]) as ProcessJobsControllerPort["running"];

    let serviceOptions: OpenProcessJobsServiceOptions | undefined;
    const serviceHandle = {} as ProcessJobsServiceHandle;
    processJobsService.open.mockImplementation(async (options: OpenProcessJobsServiceOptions) => {
      serviceOptions = options;
      return serviceHandle;
    });
    const controller: ProcessJobsControllerPort = {
      cwd,
      configReadPath,
      env: {},
      logger: undefined,
      running,
      statuses: new Map(),
      stopped: false,
      processJobsService: undefined,
      processJobsServiceStart: undefined,
      processJobsStateDir: undefined,
      processJobsDegradation: undefined,
      observabilityContext: async () => ({}),
      setStatus: (_id, status) => status,
      refreshTraceSource: async () => undefined,
    };

    await expect(ensureProcessJobsService(controller)).resolves.toBe(serviceHandle);
    expect(controller.processJobsStateDir).toBe(join(await realpath(cwd), ".mono-agent/process-jobs"));
    const surfaceUpdate = serviceOptions?.surfaceUpdate;
    expect(surfaceUpdate).toBeTypeOf("function");

    const slackProjection = projection("slack:C1:1.1#2026-08-15", "slack");
    const telegramProjection = projection("telegram:42#2026-08-15", "telegram");
    await surfaceUpdate!(slackProjection);
    await surfaceUpdate!(telegramProjection);

    expect(slackNotify).toHaveBeenCalledWith({
      conversationId: "slack:C1:1.1",
      text: "",
      deliveryKey: slackProjection.wake.deliveryKey,
      processJob: slackProjection,
    });
    expect(slackUpdate).toHaveBeenCalledWith("C1", "1.1", slackProjection);
    expect(telegramNotify).toHaveBeenCalledWith({
      conversationId: "telegram:42",
      text: "",
      deliveryKey: telegramProjection.wake.deliveryKey,
      processJob: telegramProjection,
    });
    expect(telegramUpdate).toHaveBeenCalledWith(42, telegramProjection, undefined);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function startInput<T>(cwd: string, config: T): ChannelStartInput<T> {
  return {
    config,
    coreConfig: {
      runtime: {
        model: {
          sdk: "pi",
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          reference: "pi:openai-codex:gpt-5.6-sol",
        },
      },
      tools: { allowedTools: [], disallowedTools: [] },
    } as never,
    responder: {} as never,
    cwd,
    onFailure: vi.fn(),
  };
}

function projection(
  conversationId: string,
  channel: "slack" | "telegram",
): ProcessJobProjection {
  return {
    schema: "mono-agent.process-job-projection.v1",
    jobId: `pj_${channel}`,
    tool: "Exec",
    state: "running",
    summary: "Exec command (values redacted)",
    origin: {
      conversationId,
      channel,
      runId: `run-${channel}`,
      historyBoundary: `run-${channel}`,
      bucket: "2026-08-15",
    },
    timestamps: {
      admittedAt: "2026-08-15T00:00:00.000Z",
      queueDeadlineAt: "2026-08-15T00:05:00.000Z",
      startedAt: "2026-08-15T00:00:01.000Z",
      runtimeDeadlineAt: "2026-08-15T00:30:01.000Z",
      completedAt: null,
    },
    limits: {
      maxRuntimeMs: 1_800_000,
      maxOutputBytes: 1_024,
      previewChars: 100,
      chainDepth: 0,
    },
    output: {
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      preview: "",
      stdoutRef: null,
      stderrRef: null,
    },
    wake: {
      state: "pending",
      attempts: 0,
      deliveryKey: `process-job:pj_${channel}`,
      lastAttemptAt: null,
    },
    exitCode: null,
    signal: null,
    durationMs: null,
    cancelRequested: false,
    lastError: null,
  };
}
