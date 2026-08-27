import { realpath } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { AgentMessageStream, AgentReplyPart, AgentRequestBase, AgentResponder, ProcessJobOperator, ProcessJobProjection, RunningChannel } from "@mono-agent/agent-contracts";
import type { DiscoveredLocalModel, LocalProviderDefinition } from "@mono-agent/runtime-adapter";
import type { TuiAdapterConfig, TuiAdapterInfo, TuiAdapterOptions, TuiAdapterStartResult } from "@mono-agent/operator-adapter";
import type { DeliverWebNotificationInput } from "@mono-agent/web";
import { WebConsoleError } from "@mono-agent/web";

import type { ChannelDriver, ChannelStartInput } from "../channels.js";
import { createTuiChannelDriver } from "../channels.js";
import { startAppOwnedTuiChannel } from "../channel-drivers/tui.js";

const noopResponder: AgentResponder = {
  async respond() {
    return {};
  },
};

const baseConfig: TuiAdapterConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 0,
  basePath: "/gui",
  allowNonLoopback: false,
};

interface BuildInputOptions {
  readonly effort?: string;
  readonly fallbackModels?: readonly { sdk: string; model: string; provider?: string; reference?: string }[];
  readonly localProviders?: readonly LocalProviderDefinition[];
}

function baseInput(options: BuildInputOptions = {}): ChannelStartInput<TuiAdapterConfig> {
  return {
    coreConfig: {
      runtime: {
        model: { sdk: "claude", model: "claude-fable-5" },
        workspace: "/tmp",
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.fallbackModels === undefined ? {} : { fallbackModels: options.fallbackModels }),
      },
      context: { identityPath: "/tmp/IDENTITY.md", selectedSkills: [] },
      tools: { disallowedTools: [] },
      ...(options.localProviders === undefined ? {} : { providers: { local: options.localProviders } }),
    } as never,
    responder: noopResponder,
    cwd: "/tmp",
    onFailure: () => {},
    config: baseConfig,
  };
}

interface StartOptions extends BuildInputOptions {
  readonly discoverModels?: (
    providers: readonly LocalProviderDefinition[] | undefined,
  ) => Promise<readonly DiscoveredLocalModel[]>;
}

async function startCapturingTui(options: StartOptions = {}): Promise<TuiAdapterOptions> {
  let captured: TuiAdapterOptions | undefined;
  const driver = createTuiChannelDriver({
    adapterFactory: (adapterOptions): Promise<TuiAdapterStartResult> => {
      captured = adapterOptions;
      return Promise.resolve({
        url: "http://127.0.0.1:0",
        baseUrl: "http://127.0.0.1:0/gui",
        infoUrl: "http://127.0.0.1:0/gui/v1/info",
        turnsUrl: "http://127.0.0.1:0/gui/v1/turns",
        host: "127.0.0.1",
        port: 0,
        stop: () => Promise.resolve(),
      });
    },
    ...(options.discoverModels === undefined ? {} : { discoverModels: options.discoverModels }),
  });

  await driver.start(baseInput(options));
  if (captured === undefined) {
    throw new Error("TUI adapter was not started.");
  }
  return captured;
}

/** `captured.info` is always an info PROVIDER (see design note on createTuiChannelDriver); resolve it. */
async function resolveInfo(captured: TuiAdapterOptions): Promise<TuiAdapterInfo> {
  if (typeof captured.info !== "function") {
    throw new Error("Expected info to be a provider function.");
  }
  return await captured.info();
}

describe("tui channel driver — info composition", () => {
  it("publishes a secret-free ACP bridge compatibility summary", async () => {
    const driver = createTuiChannelDriver({
      adapterFactory: async (): Promise<TuiAdapterStartResult> => ({
        url: "http://127.0.0.1:0",
        baseUrl: "http://127.0.0.1:0/gui",
        infoUrl: "http://127.0.0.1:0/gui/v1/info",
        turnsUrl: "http://127.0.0.1:0/gui/v1/turns",
        host: "127.0.0.1",
        port: 0,
        stop: async () => {},
      }),
      discoverModels: async () => [],
    });

    const started = await driver.start(baseInput());

    expect(started.summary).toEqual({
      baseUrl: "http://127.0.0.1:0/gui",
      acpBridge: {
        schema: "mono-agent.acp-source.v1",
        bridgeVersion: 1,
        protocolVersion: 1,
        installedVersion: "0.20.6",
        workspacePath: await realpath("/tmp"),
      },
    });
    expect(JSON.stringify(started.summary)).not.toMatch(/apiKey|credential|configPath/u);
  });

  it("passes the configured runtime effort through to the adapter's info", async () => {
    const captured = await startCapturingTui({ effort: "high" });
    const info = await resolveInfo(captured);

    expect(info).toEqual({
      model: "claude:claude-fable-5",
      effort: "high",
      models: ["claude:claude-fable-5"],
      modelOptions: { "claude:claude-fable-5": { reasoning: true } },
      skills: { status: "ready", items: [], total: 0 },
    });
  });

  it("omits effort from info when the runtime has none configured", async () => {
    const captured = await startCapturingTui();
    const info = await resolveInfo(captured);

    expect(info).toEqual({
      model: "claude:claude-fable-5",
      models: ["claude:claude-fable-5"],
      modelOptions: { "claude:claude-fable-5": { reasoning: true } },
      skills: { status: "ready", items: [], total: 0 },
    });
  });

  it("lists the primary then fallback models as candidate models, de-duplicated", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        { sdk: "codex", model: "gpt-5.5" },
        { sdk: "claude", model: "claude-fable-5" },
      ],
    });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["claude:claude-fable-5", "codex:gpt-5.5"]);
  });

  it("publishes known direct and Pi context windows, preferring configured Pi capabilities", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        { sdk: "codex", model: "gpt-5.6-sol" },
        { sdk: "pi", provider: "openai-codex", model: "gpt-5.5" },
        { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-terra" },
        { sdk: "pi", provider: "openai-codex", model: "gpt-5.4" },
        { sdk: "pi", provider: "anthropic", model: "claude-sonnet-4-6" },
        { sdk: "pi", provider: "unknown-provider", model: "unknown-model" },
      ],
      localProviders: [{
        id: "openai-codex",
        type: "openai_compat",
        baseUrl: "http://localhost:1234",
        enabled: true,
        models: [
          {
            name: "gpt-5.5",
            capabilities: { context_window: 16_384, num_ctx: 8_192 },
          },
          {
            name: "gpt-5.6-terra",
            capabilities: { num_ctx: 32_768 },
          },
          {
            name: "gpt-5.4",
            capabilities: { context_window: 0, num_ctx: -1 },
          },
        ],
      }],
      discoverModels: async () => [],
    });
    const info = await resolveInfo(captured);

    // Sourced from pi's generated catalog, corrected to 272_000 in pi-ai 0.83.0.
    expect(info.modelOptions?.["codex:gpt-5.6-sol"]?.contextWindow).toBe(272_000);
    expect(info.modelOptions?.["pi:openai-codex:gpt-5.5"]?.contextWindow).toBe(16_384);
    expect(info.modelOptions?.["pi:openai-codex:gpt-5.6-terra"]?.contextWindow).toBe(32_768);
    expect(info.modelOptions?.["pi:openai-codex:gpt-5.4"]).not.toHaveProperty("contextWindow");
    expect(info.modelOptions?.["pi:anthropic:claude-sonnet-4-6"]?.contextWindow).toBe(1_000_000);
    expect(info.modelOptions?.["pi:unknown-provider:unknown-model"]).not.toHaveProperty("contextWindow");
    expect(info.modelOptions?.["claude:claude-fable-5"]).not.toHaveProperty("contextWindow");
  });

  it("degrades to no discovered models/no local modelOptions detail when no local providers are configured", async () => {
    const discoverModels = vi.fn().mockResolvedValue([]);
    const captured = await startCapturingTui({ discoverModels });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["claude:claude-fable-5"]);
    // The configured cloud model still gets a `reasoning: true` degrade entry
    // (so the TUI knows it's reasoning-capable) but no precise effortLevels.
    expect(info.modelOptions).toEqual({ "claude:claude-fable-5": { reasoning: true } });
  });

  it("includes locally discovered models in info.models and their resolved effort levels in info.modelOptions", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      {
        id: "lmstudio",
        type: "lmstudio",
        baseUrl: "http://localhost:1234",
        enabled: true,
        models: [
          {
            name: "qwen/qwen3-8b",
            capabilities: {
              reasoning: true,
              reasoning_mode: "effort",
              reasoning_levels: ["low", "medium", "high"],
              context_window: 65_536,
            },
          },
        ],
      },
    ];
    const discoverModels = vi.fn().mockResolvedValue([
      { ref: "pi:lmstudio:qwen/qwen3-8b", label: "qwen/qwen3-8b", providerId: "lmstudio" },
      { ref: "pi:lmstudio:llama-3.1", label: "llama-3.1", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders, discoverModels });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual([
      "claude:claude-fable-5",
      "pi:lmstudio:qwen/qwen3-8b",
      "pi:lmstudio:llama-3.1",
    ]);
    expect(info.modelOptions).toEqual({
      "claude:claude-fable-5": { reasoning: true },
      "pi:lmstudio:qwen/qwen3-8b": {
        effortLevels: ["low", "medium", "high"],
        reasoning: true,
        reasoningMode: "effort",
        label: "qwen/qwen3-8b",
        contextWindow: 65_536,
      },
      "pi:lmstudio:llama-3.1": { reasoning: false, reasoningMode: "none", label: "llama-3.1" },
    });
    expect(discoverModels).toHaveBeenCalledWith(localProviders);
  });

  it("surfaces reasoningMode:'toggle' (no effortLevels) for a discovered Ollama toggle-reasoning model (e.g. qwen)", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([
      { ref: "pi:ollama:qwen3.6:latest", label: "qwen3.6:latest", providerId: "ollama" },
      { ref: "pi:ollama:gpt-oss:20b", label: "gpt-oss:20b", providerId: "ollama" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders, discoverModels });
    const info = await resolveInfo(captured);

    // Toggle model carries the mode but NO graded effortLevels; the effort model
    // carries mode + levels. The TUI renders on/off vs graded from this.
    expect(info.modelOptions?.["pi:ollama:qwen3.6:latest"]).toEqual({
      reasoning: true,
      reasoningMode: "toggle",
      label: "qwen3.6:latest",
    });
    expect(info.modelOptions?.["pi:ollama:gpt-oss:20b"]).toEqual({
      effortLevels: ["low", "medium", "high"],
      reasoning: true,
      reasoningMode: "effort",
      label: "gpt-oss:20b",
    });
  });

  it("dedups a discovered model that collides with a config-listed model, keeping the config model first", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([
      { ref: "claude:claude-fable-5", label: "claude-fable-5", providerId: "lmstudio" },
      { ref: "pi:lmstudio:qwen3-8b", label: "qwen3-8b", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders, discoverModels });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["claude:claude-fable-5", "pi:lmstudio:qwen3-8b"]);
  });

  it("caches discovered models within the TTL window, avoiding a fresh discovery call on every /v1/info", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([]);
    const captured = await startCapturingTui({ localProviders, discoverModels });

    await resolveInfo(captured);
    await resolveInfo(captured);
    await resolveInfo(captured);

    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("refreshes discovery once the TTL window elapses", async () => {
    vi.useFakeTimers();
    try {
      const localProviders: readonly LocalProviderDefinition[] = [
        { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
      ];
      const discoverModels = vi.fn().mockResolvedValue([]);
      const captured = await startCapturingTui({ localProviders, discoverModels });

      await resolveInfo(captured);
      vi.advanceTimersByTime(30_001);
      await resolveInfo(captured);

      expect(discoverModels).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tui channel driver — process jobs", () => {
  it("does not expose process-job authority through the generic driver start contract", async () => {
    const captured = await startCapturingTui();
    expect(captured.processJobs).toBeUndefined();
    expect(captured.processJobsBearer).toBeUndefined();
  });

  it("rejects an arbitrary driver that merely claims the TUI id from the owner path", () => {
    const start = vi.fn(async () => ({ summary: {}, stop: async () => undefined }));
    const impostor = {
      id: "tui",
      label: "third-party impostor",
      loadConfig: async () => baseConfig,
      isConfigError: () => false,
      start,
    } satisfies ChannelDriver<TuiAdapterConfig>;
    const processJobs: ProcessJobOperator = {
      operatorToken: "must-not-leak",
      list: async () => [],
      get: async () => undefined,
      cancel: async () => { throw new Error("must not run"); },
    };

    expect(startAppOwnedTuiChannel(impostor, baseInput(), processJobs)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it("passes the owner bearer and wakes one existing web thread through a normal history turn", async () => {
    let captured: TuiAdapterOptions | undefined;
    const deliverNotification = vi.fn(async (_input: DeliverWebNotificationInput) => ({ threadId: "thread-1", duplicate: false }));
    const driver = createTuiChannelDriver({
      adapterFactory: async (options): Promise<TuiAdapterStartResult> => {
        captured = options;
        return {
          url: "http://127.0.0.1:0",
          baseUrl: "http://127.0.0.1:0/gui",
          infoUrl: "http://127.0.0.1:0/gui/v1/info",
          turnsUrl: "http://127.0.0.1:0/gui/v1/turns",
          host: "127.0.0.1",
          port: 0,
          stop: async () => undefined,
        };
      },
      discoverModels: async () => [],
      deliverNotification,
    });
    const respond = vi.fn<AgentResponder["respond"]>(async (_request: AgentRequestBase, _stream: AgentMessageStream) => ({ text: "Job finished safely." }));
    const deliverVerbatim = vi.fn(async () => undefined);
    const processJobs: ProcessJobOperator = {
      operatorToken: "owner-token",
      list: async () => [],
      get: async () => undefined,
      cancel: async () => { throw new Error("not used"); },
    };
    const start = startAppOwnedTuiChannel(driver, {
      ...baseInput(),
      responder: { respond, deliverVerbatim },
      sourceId: "agent-one",
    }, processJobs);
    if (start === undefined) throw new Error("expected the app-owned TUI start path");
    const running = await start;
    expect(captured?.processJobs).toBe(processJobs);
    expect(captured?.processJobsBearer).toBe("owner-token");

    await expect(running.notify?.({
      conversationId: "web:thread-1",
      text: "bounded untrusted wake",
      deliveryKey: PROCESS_JOB.wake.deliveryKey,
      processJob: PROCESS_JOB,
    })).resolves.toMatchObject({ delivered: true, historyRecorded: true });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "web:thread-1",
      text: "bounded untrusted wake",
      metadata: { source: "web", web: { trigger: "job" } },
    });
    expect(deliverVerbatim).not.toHaveBeenCalled();
    expect(deliverNotification).toHaveBeenCalledWith({
      sourceId: "agent-one",
      triggerKind: "job",
      deliveryKey: PROCESS_JOB.wake.deliveryKey,
      threadId: "thread-1",
      processJob: PROCESS_JOB,
      text: "Job finished safely.",
    });

    respond.mockResolvedValueOnce({ parts: RICH_REPLY_PARTS });
    const partOnlyDeliveryKey = `${PROCESS_JOB.wake.deliveryKey}:part-only`;
    await expect(running.notify?.({
      conversationId: "web:thread-1",
      text: "render rich answer",
      deliveryKey: partOnlyDeliveryKey,
      processJob: {
        ...PROCESS_JOB,
        wake: { ...PROCESS_JOB.wake, deliveryKey: partOnlyDeliveryKey },
      },
    })).resolves.toMatchObject({ delivered: true, historyRecorded: true });
    expect(deliverNotification).toHaveBeenLastCalledWith({
      sourceId: "agent-one",
      triggerKind: "job",
      deliveryKey: partOnlyDeliveryKey,
      threadId: "thread-1",
      processJob: {
        ...PROCESS_JOB,
        wake: { ...PROCESS_JOB.wake, deliveryKey: partOnlyDeliveryKey },
      },
      parts: RICH_REPLY_PARTS,
    });

    respond.mockResolvedValueOnce({ text: "Rich answer ready.", parts: RICH_REPLY_PARTS });
    const mixedDeliveryKey = `${PROCESS_JOB.wake.deliveryKey}:mixed`;
    await expect(running.notify?.({
      conversationId: "web:thread-1",
      text: "render mixed answer",
      deliveryKey: mixedDeliveryKey,
      processJob: {
        ...PROCESS_JOB,
        wake: { ...PROCESS_JOB.wake, deliveryKey: mixedDeliveryKey },
      },
    })).resolves.toMatchObject({ delivered: true, historyRecorded: true });
    expect(deliverNotification).toHaveBeenLastCalledWith(expect.objectContaining({
      deliveryKey: mixedDeliveryKey,
      text: "Rich answer ready.",
      parts: RICH_REPLY_PARTS,
    }));

    await expect(running.notify?.({
      conversationId: "web:thread-1#wrong-bucket",
      text: "wrong bucket",
      deliveryKey: PROCESS_JOB.wake.deliveryKey,
      processJob: PROCESS_JOB,
    })).resolves.toMatchObject({ delivered: false, code: "process_job_origin_mismatch" });
    expect(respond).toHaveBeenCalledTimes(3);

    respond.mockResolvedValueOnce({ text: "x".repeat(8_100) });
    await expect(running.notify?.({
      conversationId: "web:thread-1",
      text: "bounded untrusted wake",
      deliveryKey: `${PROCESS_JOB.wake.deliveryKey}:bounded`,
      processJob: {
        ...PROCESS_JOB,
        wake: { ...PROCESS_JOB.wake, deliveryKey: `${PROCESS_JOB.wake.deliveryKey}:bounded` },
      },
    })).resolves.toMatchObject({ delivered: true });
    const boundedText = deliverNotification.mock.calls.at(-1)?.[0].text;
    expect(boundedText).toHaveLength(8_000);
    expect(boundedText).toMatch(/… \[response truncated\]$/u);

    await expect(running.notify?.({ conversationId: "tui:direct", text: "wake" }))
      .resolves.toMatchObject({ delivered: false, code: "background_unsupported_channel" });
    expect(respond).toHaveBeenCalledTimes(4);
  });
});

const RICH_REPLY_PARTS = [
  {
    type: "attachment",
    id: "wake-attachment",
    reference: { scheme: "mono-agent-artifact", id: "wake-artifact" },
    name: "report.txt",
    mediaType: "text/plain",
    sizeBytes: 12,
    integrityId: `sha256:${"a".repeat(64)}`,
  },
  {
    type: "mcp_app",
    id: "11111111-1111-4111-8111-111111111111",
    invocationId: "11111111-1111-4111-8111-111111111111",
    connectionId: "wake-connection",
    serverName: "widgets",
    toolName: "show_chart",
    resourceUri: "ui://widgets/chart",
    mediaType: "text/html;profile=mcp-app",
    protocolVersion: "2026-01-26",
    title: "Wake chart",
  },
  {
    type: "failure",
    id: "wake-failure",
    code: "artifact_missing",
    message: "One optional artifact expired.",
  },
] as const satisfies readonly AgentReplyPart[];

const PROCESS_JOB: ProcessJobProjection = {
  schema: "mono-agent.process-job-projection.v1",
  jobId: "11111111-1111-4111-8111-111111111111",
  tool: "Exec",
  state: "succeeded",
  summary: "worker",
  origin: {
    conversationId: "web:thread-1#2026-07-21",
    channel: "web",
    runId: "run-1",
    historyBoundary: "web:thread-1",
    bucket: "2026-07-21",
  },
  timestamps: {
    admittedAt: "2026-07-21T09:00:00.000Z",
    queueDeadlineAt: "2026-07-21T09:05:00.000Z",
    startedAt: "2026-07-21T09:00:01.000Z",
    runtimeDeadlineAt: "2026-07-21T09:30:01.000Z",
    completedAt: "2026-07-21T09:00:02.000Z",
  },
  limits: { maxRuntimeMs: 1_800_000, maxOutputBytes: 1_048_576, previewChars: 2_000, chainDepth: 0 },
  output: { stdoutBytes: 0, stderrBytes: 0, truncated: false, preview: "", stdoutRef: null, stderrRef: null },
  wake: {
    state: "pending",
    attempts: 1,
    deliveryKey: "process-job:11111111-1111-4111-8111-111111111111",
    lastAttemptAt: "2026-07-21T09:00:03.000Z",
  },
  exitCode: 0,
  signal: null,
  durationMs: 1_000,
  cancelRequested: false,
  lastError: null,
};


async function runningWebChannel(
  deliverNotification: (input: DeliverWebNotificationInput) => Promise<unknown>,
): Promise<RunningChannel> {
  const driver = createTuiChannelDriver({
    adapterFactory: async (): Promise<TuiAdapterStartResult> => ({
      url: "http://127.0.0.1:0",
      baseUrl: "http://127.0.0.1:0/gui",
      infoUrl: "http://127.0.0.1:0/gui/v1/info",
      turnsUrl: "http://127.0.0.1:0/gui/v1/turns",
      host: "127.0.0.1",
      port: 0,
      stop: async () => undefined,
    }),
    discoverModels: async () => [],
    deliverNotification: deliverNotification as never,
  });
  const start = startAppOwnedTuiChannel(driver, {
    ...baseInput(),
    responder: {
      respond: async () => ({ text: "Job finished safely." }),
      deliverVerbatim: async () => undefined,
    },
    sourceId: "agent-one",
  }, {
    operatorToken: "owner-token",
    list: async () => [],
    get: async () => undefined,
    cancel: async () => { throw new Error("not used"); },
  });
  if (start === undefined) throw new Error("expected the app-owned TUI start path");
  return await start;
}

describe("web process-job wake classification", () => {
  const wakeInput = {
    conversationId: "web:thread-1",
    text: "bounded untrusted wake",
    deliveryKey: PROCESS_JOB.wake.deliveryKey,
    processJob: PROCESS_JOB,
  };

  it("retries only a failure that provably delivered nothing", async () => {
    // The console re-runs the wake turn on every accepted call, so a connect
    // failure is the one case safe to replay. Previously EVERY non-delivery was
    // permanent on attempt 1 and the completion turn was simply lost.
    const running = await runningWebChannel(async () => {
      throw new WebConsoleError("notification_ingress_unavailable", "console is down", 503);
    });

    await expect(running.processJobs?.wake(wakeInput)).resolves.toMatchObject({
      delivered: false,
      code: "destination_channel_unavailable",
      retryable: true,
    });
  });

  it("keeps an ambiguous wake permanent so no job reports twice", async () => {
    for (const code of ["notification_ingress_timeout", "notification_delivery_failed", "invalid_notification_response"]) {
      const running = await runningWebChannel(async () => {
        throw new WebConsoleError(code, `failed: ${code}`, 502);
      });

      await expect(running.processJobs?.wake(wakeInput)).resolves.toMatchObject({
        delivered: false,
        code: "process_job_wake_failed",
        retryable: false,
        ambiguous: true,
      });
    }
  });

  it("treats a missing wake receipt as ambiguous rather than merely failed", async () => {
    const running = await runningWebChannel(async () => ({ threadId: "thread-1", duplicate: false }));

    await expect(running.processJobs?.wake(wakeInput)).resolves.toMatchObject({
      delivered: false,
      code: "process_job_wake_failed",
      retryable: false,
      ambiguous: true,
    });
  });

  it("keeps an origin mismatch non-retryable", async () => {
    const running = await runningWebChannel(async () => {
      throw new Error("must not be called");
    });

    await expect(running.processJobs?.wake({ ...wakeInput, conversationId: "web:other-thread" }))
      .resolves.toMatchObject({
        delivered: false,
        code: "process_job_origin_mismatch",
        retryable: false,
      });
  });

  it("reports a delivered wake unchanged", async () => {
    const running = await runningWebChannel(async () => ({
      threadId: "thread-1",
      duplicate: false,
      delivery: { delivered: true },
    }));

    await expect(running.processJobs?.wake(wakeInput)).resolves.toMatchObject({
      delivered: true,
      code: "delivered",
      channelId: "tui",
      historyRecorded: true,
    });
  });
});
