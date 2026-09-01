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
  readonly fallbackModels?: readonly { provider: string; model: string }[];
  readonly localProviders?: readonly LocalProviderDefinition[];
}

function baseInput(options: BuildInputOptions = {}): ChannelStartInput<TuiAdapterConfig> {
  return {
    coreConfig: {
      runtime: {
        model: { provider: "anthropic", model: "claude-fable-5", reference: "anthropic:claude-fable-5" },
        workspace: "/tmp",
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.fallbackModels === undefined ? {} : {
          fallbacks: options.fallbackModels.map((model) => ({
            model: { ...model, reference: `${model.provider}:${model.model}` },
          })),
        }),
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

const NOOP_MODEL_DISCOVERY = {
  discoverModels: async () => [],
};

const FABLE_MODEL_OPTIONS = {
  reasoning: true,
  reasoningMode: "effort" as const,
  effortLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
  contextWindow: 1_000_000,
  provider: "anthropic",
  providerLabel: "Anthropic",
};

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
    ...NOOP_MODEL_DISCOVERY,
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
      ...NOOP_MODEL_DISCOVERY,
      discoverModels: async () => [],
    });

    const started = await driver.start(baseInput());

    expect(started.summary).toEqual({
      baseUrl: "http://127.0.0.1:0/gui",
      acpBridge: {
        schema: "mono-agent.acp-source.v1",
        bridgeVersion: 1,
        protocolVersion: 1,
        installedVersion: "0.20.11",
        workspacePath: await realpath("/tmp"),
      },
    });
    expect(JSON.stringify(started.summary)).not.toMatch(/apiKey|credential|configPath/u);
  });

  it("passes the configured runtime effort through to the adapter's info", async () => {
    const captured = await startCapturingTui({ effort: "high" });
    const info = await resolveInfo(captured);

    expect(info).toMatchObject({
      model: "anthropic:claude-fable-5",
      effort: "high",
      models: ["anthropic:claude-fable-5"],
      modelOptions: { "anthropic:claude-fable-5": FABLE_MODEL_OPTIONS },
      skills: { status: "ready", items: [], total: 0 },
    });
    expect(info.providers?.find((provider) => provider.id === "anthropic"))
      .toMatchObject({ id: "anthropic", label: "Anthropic", source: "builtin", configured: true });
  });

  it("omits effort from info when the runtime has none configured", async () => {
    const captured = await startCapturingTui();
    const info = await resolveInfo(captured);

    expect(info).toMatchObject({
      model: "anthropic:claude-fable-5",
      models: ["anthropic:claude-fable-5"],
      modelOptions: { "anthropic:claude-fable-5": FABLE_MODEL_OPTIONS },
      skills: { status: "ready", items: [], total: 0 },
    });
    expect(info.effort).toBeUndefined();
  });

  it("lists the primary then fallback models as candidate models, de-duplicated", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        { provider: "openai-codex", model: "gpt-5.5" },
        { provider: "anthropic", model: "claude-fable-5" },
      ],
    });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["anthropic:claude-fable-5", "openai-codex:gpt-5.5"]);
  });

  it("publishes known provider context windows, preferring configured local capabilities", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        { provider: "openai-codex", model: "gpt-5.6-sol" },
        { provider: "openai-codex", model: "gpt-5.5" },
        { provider: "openai-codex", model: "gpt-5.6-terra" },
        { provider: "openai-codex", model: "gpt-5.4" },
        { provider: "anthropic", model: "claude-sonnet-4-6" },
        { provider: "unknown-provider", model: "unknown-model" },
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
    expect(info.modelOptions?.["openai-codex:gpt-5.6-sol"]?.contextWindow).toBeUndefined();
    expect(info.modelOptions?.["openai-codex:gpt-5.5"]?.contextWindow).toBe(16_384);
    expect(info.modelOptions?.["openai-codex:gpt-5.6-terra"]?.contextWindow).toBe(32_768);
    expect(info.modelOptions?.["openai-codex:gpt-5.4"]).not.toHaveProperty("contextWindow");
    expect(info.modelOptions?.["anthropic:claude-sonnet-4-6"]?.contextWindow).toBe(1_000_000);
    expect(info.modelOptions?.["unknown-provider:unknown-model"]).not.toHaveProperty("contextWindow");
    expect(info.modelOptions?.["anthropic:claude-fable-5"]?.contextWindow).toBe(1_000_000);
  });

  it("degrades to no discovered models/no local modelOptions detail when no local providers are configured", async () => {
    const discoverModels = vi.fn().mockResolvedValue([]);
    const captured = await startCapturingTui({ discoverModels });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["anthropic:claude-fable-5"]);
    expect(info.modelOptions).toEqual({ "anthropic:claude-fable-5": FABLE_MODEL_OPTIONS });
  });

  it("keeps info.models to configured routes and serves live-discovered models via the catalog", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([
      { ref: "lmstudio:qwen/qwen3-8b", label: "qwen/qwen3-8b", providerId: "lmstudio" },
      { ref: "lmstudio:llama-3.1", label: "llama-3.1", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders, discoverModels });
    const info = await resolveInfo(captured);

    // The /v1/info shortlist stays configured routes only; discovered models
    // move into the bounded provider catalog + the lazy /v1/models endpoint.
    expect(info.models).toEqual(["anthropic:claude-fable-5"]);
    expect(info.modelOptions).toEqual({ "anthropic:claude-fable-5": FABLE_MODEL_OPTIONS });
    expect(info.providers?.find((provider) => provider.id === "lmstudio")).toMatchObject({
      id: "lmstudio",
      source: "custom",
      modelCount: 2,
    });
    const page = captured.modelCatalog?.({ provider: "lmstudio", limit: 100 });
    expect(page?.models.map((model) => model.id)).toEqual(["llama-3.1", "qwen/qwen3-8b"]);
    expect(page?.truncated).toBe(false);
    expect(discoverModels).toHaveBeenCalledWith(localProviders);
  });

  it("resolves toggle reasoning for a configured Ollama route through describe", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true },
    ];

    const captured = await startCapturingTui({
      fallbackModels: [{ provider: "ollama", model: "qwen3.6:latest" }],
      localProviders,
      discoverModels: async () => [],
    });
    const info = await resolveInfo(captured);

    // Toggle model carries the mode but NO graded effortLevels.
    expect(info.modelOptions?.["ollama:qwen3.6:latest"]).toEqual({
      reasoning: true,
      reasoningMode: "toggle",
      provider: "ollama",
      providerLabel: "ollama",
    });
  });

  it("dedups discovered models within a provider's catalog page", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([
      { ref: "lmstudio:qwen3-8b", label: "qwen3-8b", providerId: "lmstudio" },
      { ref: "lmstudio:qwen3-8b", label: "qwen3-8b (duplicate)", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders, discoverModels });
    const info = await resolveInfo(captured);

    expect(info.providers?.find((provider) => provider.id === "lmstudio")?.modelCount).toBe(1);
    expect(captured.modelCatalog?.({ provider: "lmstudio", limit: 100 }).models.map((m) => m.id))
      .toEqual(["qwen3-8b"]);
  });

  it("captures local model discovery once at startup and serves /v1/info from memory", async () => {
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

  it("does not refresh local discovery after the former TTL window elapses", async () => {
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

      expect(discoverModels).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves /v1/info from memory: repeated polls do not re-read the Pi catalog", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [{ provider: "openrouter", model: "gpt-5.6-sol" }],
    });

    const first = await resolveInfo(captured);
    const second = await resolveInfo(captured);
    const third = await resolveInfo(captured);

    // The console polls /v1/info every 5s per connection, and a throwing or
    // slow info provider returns 500 for the WHOLE response — the agent shows
    // offline, not degraded. Both projections are precomputed at channel start,
    // so repeated polls hand back the very same frozen objects.
    expect(second.providers).toBe(first.providers);
    expect(third.providers).toBe(first.providers);
    expect(second.modelOptions).toBe(first.modelOptions);
    expect(third.modelOptions).toBe(first.modelOptions);
  });

  it("keeps the serialized /v1/info payload under the byte budget with openrouter configured", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [{ provider: "openrouter", model: "gpt-5.6-sol" }],
    });
    const info = await resolveInfo(captured);

    // Regression fence: the provider summary must stay bounded on /v1/info; the
    // model lists themselves ride the lazy /v1/models endpoint. Exceeding the
    // 1 MiB body cap takes the agent offline rather than degrading it.
    expect(JSON.stringify(info).length).toBeLessThan(8_192);
    // `providers` is a support gate: the agent advertises the provider its
    // route uses plus the one the fallback declares, not all 39 Pi built-ins.
    expect(info.providers?.map((provider) => provider.id).sort())
      .toEqual(["anthropic", "openrouter"]);
  });

  it("advertises exact Pi effort levels while unknown provider refs fail closed", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        { provider: "openai-codex", model: "gpt-5.6-terra" },
        { provider: "anthropic", model: "claude-sonnet-4-6" },
        { provider: "unknown-provider", model: "gemini" },
      ],
    });
    const info = await resolveInfo(captured);

    expect(info.modelOptions?.["anthropic:claude-fable-5"]).toEqual(FABLE_MODEL_OPTIONS);
    expect(info.modelOptions?.["openai-codex:gpt-5.6-terra"]).toMatchObject({
      reasoning: true,
      contextWindow: 272_000,
    });
    expect(info.modelOptions?.["anthropic:claude-sonnet-4-6"]?.effortLevels?.length).toBeGreaterThan(0);
    expect(info.modelOptions?.["unknown-provider:gemini"]).toEqual({
      reasoning: true,
      provider: "unknown-provider",
      providerLabel: "unknown-provider",
    });
  });

  it("fail-closes local capability discovery without blocking later /v1/info reads", async () => {
    const discoverModels = vi.fn(async () => {
      throw new Error("local catalog unavailable");
    });
    const captured = await startCapturingTui({
      fallbackModels: [{ provider: "openai-codex", model: "gpt-5.6-terra" }],
      discoverModels,
    });

    const first = await resolveInfo(captured);
    const second = await resolveInfo(captured);

    expect(first.modelOptions?.["anthropic:claude-fable-5"]).toEqual(FABLE_MODEL_OPTIONS);
    expect(first.modelOptions?.["openai-codex:gpt-5.6-terra"]).toMatchObject({
      reasoning: true,
      contextWindow: 272_000,
    });
    expect(second).toEqual(first);
    expect(discoverModels).toHaveBeenCalledTimes(1);
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
      ...NOOP_MODEL_DISCOVERY,
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
    ...NOOP_MODEL_DISCOVERY,
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
