import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessJobProjection } from "@mono-agent/agent-contracts";

import {
  ensureProcessJobsService,
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
      processJobsDegradation: undefined,
      observabilityContext: async () => ({}),
      setStatus: (_id, status) => status,
      refreshTraceSource: async () => undefined,
    };

    await expect(ensureProcessJobsService(controller)).resolves.toBe(serviceHandle);
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
