import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listTraceSources } from "@mono-agent/observability";
import type { AgentResponder, ChannelInteractionHub, ChannelInteractionSink } from "@mono-agent/agent-contracts";
import type { SandboxEngine } from "@mono-agent/sandbox";
import type {
  TelegramAdapterErrorText,
  TelegramAdapterStartOptions,
} from "@mono-agent/telegram-adapter";
import type { SlackAdapterStartOptions } from "@mono-agent/slack-adapter";

import { startMonoAgentApp } from "../app.js";
import {
  createSlackChannelDriver,
  createTelegramChannelDriver,
  defaultChannelDrivers,
} from "../channels.js";
import type { ChannelDriver } from "../channels.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-test-"));
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\n\nTest agent.\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(json: Record<string, unknown>): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify(json, null, 2));
  return configPath;
}

function baseConfig(): Record<string, unknown> {
  return {
    runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
    context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: "./artifacts" },
    traceability: { registryDir: "./trace-sources", sourceId: "app-test", sourceLabel: "App Test" },
  };
}

const unavailableSandboxEngine: SandboxEngine = {
  id: "fake-srt",
  async isAvailable() {
    return false;
  },
  async prepareCommand() {
    throw new Error("not used by app startup status");
  },
};

describe("startMonoAgentApp", () => {
  it("starts configured channels, reports waiting/disabled for the rest, and stops cleanly", async () => {
    await writeConfig({
      ...baseConfig(),
      webhook: { enabled: true, port: 0 },
    });

    const webhookStop = vi.fn(async () => undefined);
    const webhookFactory = vi.fn(async () => ({
      invokeUrl: "http://127.0.0.1:9999/webhook/invoke",
      port: 9999,
      endpoints: [
        {
          name: "default",
          path: "/webhook/invoke",
          invokeUrl: "http://127.0.0.1:9999/webhook/invoke",
          statusBasePath: "/webhook/requests",
          mode: "sync",
        },
      ],
      stop: webhookStop,
    }));

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      drivers: defaultChannelDrivers({ webhook: { adapterFactory: webhookFactory as never } }),
    });

    expect(app.channelStatus("webhook")).toEqual({
      kind: "running",
      summary: {
        invokeUrl: "http://127.0.0.1:9999/webhook/invoke",
        port: 9999,
        invokeUrls: { default: "http://127.0.0.1:9999/webhook/invoke" },
      },
    });
    expect(app.channelStatus("telegram").kind).toBe("disabled");
    expect(app.channelStatus("slack").kind).toBe("disabled");
    expect(app.channelStatus("whatsapp").kind).toBe("disabled");
    expect(app.channelStatus("a2a").kind).toBe("disabled");
    expect(app.channelStatus("openai-api").kind).toBe("disabled");
    expect(app.channelStatus("cron").kind).toBe("disabled");
    expect(app.traceabilityStatus.kind).toBe("running");
    expect(webhookFactory).toHaveBeenCalledTimes(1);

    await app.stop();
    expect(webhookStop).toHaveBeenCalledTimes(1);
  });

  it("reports a configured exporter status when observability.exporters is set", async () => {
    await writeConfig({
      ...baseConfig(),
      observability: {
        exporters: [{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces", includeSensitiveData: false }],
      },
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
    });

    expect(app.exporterStatus.kind).toBe("configured");
    if (app.exporterStatus.kind === "configured") {
      expect(app.exporterStatus.endpoint).toBe("http://127.0.0.1:6006/v1/traces");
      expect(app.exporterStatus.includeSensitiveData).toBe(false);
    }
    await app.stop();
  });

  it("persists active selected skills in the trace-source manifest", async () => {
    await writeConfig({
      ...baseConfig(),
      context: { identityPath: "./IDENTITY.md", selectedSkills: ["context-example", "todoist-cli"] },
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
    });

    expect(app.selectedSkills).toEqual(["context-example", "todoist-cli"]);
    const { sources } = await listTraceSources({ registryDir: join(dir, "trace-sources") });
    const context = sources[0]?.metadata?.context as { selectedSkills?: readonly string[] } | undefined;
    expect(context?.selectedSkills).toEqual(["context-example", "todoist-cli"]);

    await app.stop();
  });

  it("logs and persists unsafe sandbox fallback status at startup", async () => {
    const warnings: string[] = [];
    await writeConfig({
      ...baseConfig(),
      sandbox: {
        mode: "native",
        fallback: "unsafe-host-process",
        unsafeAllowHostProcess: true,
        denyWrite: [".env", "secrets/**"],
      },
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      sandboxEngine: unavailableSandboxEngine,
      logger: {
        warn(message: string) {
          warnings.push(message);
        },
      },
    });

    expect(app.sandboxStatus.effective).toBe("unsafe-host-process");
    expect(app.sandboxStatus.fallbackActive).toBe(true);
    expect(warnings.join("\n")).toContain("WARNING: Unsafe sandbox fallback is active");
    expect(warnings.join("\n")).toContain("all sandbox roots/denyWrite entries are inert; commands run unsandboxed");

    const { sources } = await listTraceSources({ registryDir: join(dir, "trace-sources") });
    const sandbox = sources[0]?.metadata?.sandbox as
      | { effective?: string; engineAvailable?: boolean; fallbackActive?: boolean; warning?: string }
      | undefined;
    expect(sandbox?.effective).toBe("unsafe-host-process");
    expect(sandbox?.engineAvailable).toBe(false);
    expect(sandbox?.fallbackActive).toBe(true);
    expect(sandbox?.warning).toContain("all sandbox roots/denyWrite entries are inert; commands run unsandboxed");

    await app.stop();
  });

  it("routes export warnings to lastWarning/lastError and persists them to the trace-source manifest", async () => {
    await writeConfig({
      ...baseConfig(),
      observability: { exporters: [{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }] },
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
    });

    const seam = app as unknown as {
      recordExporterWarning(w: { phase: string; message: string }): void;
      refreshTraceSource(reason: string): Promise<void>;
    };
    // Spy that calls through: lets us assert the auto-trigger AND deterministically
    // await the otherwise fire-and-forget manifest writes (no polling, no races).
    const refreshSpy = vi.spyOn(seam, "refreshTraceSource");
    const flush = async (): Promise<void> => {
      await Promise.all(refreshSpy.mock.results.map((r) => Promise.resolve(r.value).catch(() => undefined)));
    };

    // Serialize the two warnings so the stale snapshot of the first write cannot
    // land after the second; in production at most one warning fires per run.
    seam.recordExporterWarning({ phase: "finish", message: "export boom" });
    await flush();
    seam.recordExporterWarning({ phase: "fail", message: "fail boom" });
    await flush();

    // recordExporterWarning must route by phase and persist via refreshTraceSource.
    expect(refreshSpy).toHaveBeenCalledWith("exporter-warning");
    expect(app.exporterStatus.kind).toBe("configured");
    if (app.exporterStatus.kind === "configured") {
      expect(app.exporterStatus.lastWarning).toContain("export boom");
      expect(app.exporterStatus.lastError).toContain("fail boom");
    }

    // The detached `mono-agent status` reads the manifest, not this live object,
    // so the warning/error must reach the persisted trace-source metadata.
    const { sources } = await listTraceSources({ registryDir: join(dir, "trace-sources") });
    const meta = sources[0]?.metadata?.observability as { lastWarning?: string; lastError?: string } | undefined;
    expect(meta?.lastWarning).toContain("export boom");
    expect(meta?.lastError).toContain("fail boom");

    await app.stop();
  });

  it("reports a disabled exporter status when no exporter is configured", async () => {
    await writeConfig({ ...baseConfig() });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
    });

    expect(app.exporterStatus.kind).toBe("disabled");
    await app.stop();
  });

  it("reports a failed exporter status for an invalid exporter config", async () => {
    await writeConfig({
      ...baseConfig(),
      observability: { exporters: [{ type: "not-a-thing" }] },
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
    });

    expect(app.exporterStatus.kind).toBe("failed");
    await app.stop();
  });

  it("reports waiting_for_config for every channel when the core config is incomplete", async () => {
    await writeConfig({
      // No runtime.model: core config cannot load.
      context: { identityPath: "./IDENTITY.md" },
      webhook: { enabled: true },
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
    });

    const webhookStatus = app.channelStatus("webhook");
    expect(webhookStatus.kind).toBe("waiting_for_config");
    if (webhookStatus.kind === "waiting_for_config") {
      expect(webhookStatus.reason).toContain("MONO_AGENT_MODEL");
    }
    await app.stop();
  });

  it("marks a channel failed when its adapter cannot start, without blocking others", async () => {
    await writeConfig({
      ...baseConfig(),
      webhook: { enabled: true },
      openaiApi: { enabled: true, modelId: "mono-agent" },
    });

    const webhookFactory = vi.fn(async () => ({
      invokeUrl: "http://127.0.0.1:9999/webhook/invoke",
      stop: vi.fn(async () => undefined),
    }));
    const openAIApiFactory = vi.fn(async () => {
      throw new Error("port already in use");
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      drivers: defaultChannelDrivers({
        webhook: { adapterFactory: webhookFactory as never },
        openaiApi: { adapterFactory: openAIApiFactory as never },
      }),
    });

    expect(app.channelStatus("webhook").kind).toBe("running");
    expect(app.channelStatus("openai-api")).toEqual({ kind: "failed", reason: "port already in use" });
    await app.stop();
  });

  it("applies config changes by stopping and restarting channels", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      webhook: { enabled: true },
    });

    const stops: string[] = [];
    let starts = 0;
    const webhookFactory = vi.fn(async () => {
      starts += 1;
      const id = `start-${starts}`;
      return {
        invokeUrl: `http://127.0.0.1:9999/${id}`,
        stop: async () => {
          stops.push(id);
        },
      };
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      drivers: defaultChannelDrivers({ webhook: { adapterFactory: webhookFactory as never } }),
    });
    expect(starts).toBe(1);

    await writeFile(configPath, JSON.stringify({ ...baseConfig(), webhook: { enabled: true, path: "/hooks/x" } }, null, 2));
    const result = await app.applyConfigChange("test-edit");

    expect(result.kind).toBe("applied");
    expect(result.transports).toContain("webhook");
    expect(stops).toEqual(["start-1"]);
    expect(starts).toBe(2);
    await app.stop();
    expect(stops).toEqual(["start-1", "start-2"]);
  });

  it("does not report an apply as serving when only the passive live channel is running", async () => {
    await writeConfig({ ...baseConfig() });
    const liveDriver: ChannelDriver = {
      id: "live",
      label: "Live",
      loadConfig: async () => ({}),
      isConfigError: () => false,
      start: async () => ({ summary: { baseUrl: "http://127.0.0.1:9999/live" }, stop: async () => undefined }),
    };
    const webhookDriver: ChannelDriver = {
      id: "webhook",
      label: "Webhook",
      loadConfig: async () => ({}),
      isConfigError: () => false,
      waitingReason: () => "Webhook is missing an endpoint.",
      start: async () => ({ summary: {}, stop: async () => undefined }),
    };

    const app = await startMonoAgentApp({ cwd: dir, env: {}, drivers: [liveDriver, webhookDriver] });
    const result = await app.applyConfigChange("live-only");

    expect(result.kind).toBe("waiting_for_config");
    expect(result.transports).toEqual(["live"]);
    await app.stop();
  });

  it("disposes the channel responder (not just the transport) on reload and stop", async () => {
    const configPath = await writeConfig({ ...baseConfig(), webhook: { enabled: true, port: 0 } });
    const webhookFactory = vi.fn(async () => ({
      invokeUrl: "http://127.0.0.1:9999/webhook/invoke",
      stop: async () => undefined,
    }));
    const drivers = defaultChannelDrivers({ webhook: { adapterFactory: webhookFactory as never } });
    const webhookDriver = drivers.find((driver) => driver.id === "webhook");
    if (webhookDriver === undefined) throw new Error("webhook driver missing");
    const disposeSpy = vi.fn(async () => {});
    const wrapped = {
      ...webhookDriver,
      async start(input: Parameters<typeof webhookDriver.start>[0]) {
        // The configured responder really exposes dispose(); replace it with a spy
        // so we can prove the app tears the responder down on stop/reload — not just
        // the transport (the F10 regression a transport-only stop misses).
        (input.responder as { dispose?: () => Promise<void> }).dispose = disposeSpy;
        return webhookDriver.start(input);
      },
    };
    const finalDrivers = drivers.map((driver) => (driver.id === "webhook" ? wrapped : driver));

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      drivers: finalDrivers,
    });
    expect(app.channelStatus("webhook").kind).toBe("running");

    // A reload that changes the webhook config restarts the channel; the OLD
    // responder/harness must be disposed, not left running against stale config.
    await writeFile(
      configPath,
      JSON.stringify({ ...baseConfig(), webhook: { enabled: true, path: "/hooks/x" } }, null, 2),
    );
    const result = await app.applyConfigChange("dispose-test");
    expect(result.kind).toBe("applied");
    expect(disposeSpy).toHaveBeenCalledTimes(1);

    await app.stop();
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent start requests for the same channel", async () => {
    await writeConfig({
      ...baseConfig(),
      webhook: { enabled: true },
    });

    let resolveStart: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      resolveStart = resolveGate;
    });
    const webhookFactory = vi.fn(async () => {
      await gate;
      return { invokeUrl: "http://127.0.0.1:9999/once", stop: async () => undefined };
    });

    const appPromise = startMonoAgentApp({
      cwd: dir,
      env: {},
      drivers: defaultChannelDrivers({ webhook: { adapterFactory: webhookFactory as never } }),
    });

    // Allow startup to reach the gated webhook start, then release it.
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    resolveStart?.();
    const app = await appPromise;

    const [first, second] = await Promise.all([
      app.startChannelIfConfigured("webhook", "test"),
      app.startChannelIfConfigured("webhook", "test"),
    ]);
    expect(first.kind).toBe("running");
    expect(second.kind).toBe("running");
    expect(webhookFactory).toHaveBeenCalledTimes(1);
    await app.stop();
  });

  it("maps Telegram runtime turn-limit failures to actionable channel copy", async () => {
    let captured: TelegramAdapterStartOptions | undefined;
    const responder: AgentResponder = {
      async respond() {
        throw new Error("unused — the channel's errorText mapping is under test");
      },
    };
    const driver = createTelegramChannelDriver({
      startAdapter: async (options) => {
        captured = options;
        return { stop: async () => undefined, notify: async () => ({ delivered: true }), post: async () => undefined, postStatus: async () => undefined };
      },
    });

    const running = await driver.start({
      config: { enabled: true, botToken: "test-token", allowedChatIds: ["42"], allowAllChats: false },
      coreConfig: baseConfig() as never,
      responder,
      cwd: dir,
      onFailure: vi.fn(),
    });

    // The channel wires a host errorText callback that turns runtime usage-limit
    // failures into actionable copy; the adapter applies it on responder failure.
    const errorText = captured?.messages?.errorText;
    expect(typeof errorText).toBe("function");
    const terminalText = await (errorText as Extract<TelegramAdapterErrorText, (input: never) => unknown>)({
      error: Object.assign(new Error("Agent runtime failed."), {
        failure: {
          kind: "usage_limit",
          message: "Agent runtime failed.",
          details: { diagnostics: { max_turns: 8 } },
        },
      }),
      request: { text: "calendar lions" } as never,
    });
    expect(terminalText).toContain("model, provider, turn, or context limit");
    expect(terminalText).toContain("8 turns");
    expect(terminalText).toContain("Narrow the prompt or task");
    expect(terminalText).not.toContain("failed honestly");

    const cancelledText = await (errorText as Extract<TelegramAdapterErrorText, (input: never) => unknown>)({
      error: Object.assign(new Error("cancelled"), {
        failure: {
          kind: "cancelled",
          message: "cancelled",
        },
      }),
      request: { text: "calendar lions" } as never,
    });
    expect(cancelledText).toContain("The run was cancelled before completion");
    expect(cancelledText).toContain("If the cancellation was expected");

    await running.stop();
  });

  it("starts the interaction bridge when ask_user is allowed, exports its env, and hands the hub to channels", async () => {
    await writeConfig({
      ...baseConfig(),
      tools: { allowedTools: ["ask_user"], disallowedTools: [] },
      telegram: { enabled: true, botToken: "test-token", allowedChatIds: ["42"] },
    });
    let captured: TelegramAdapterStartOptions | undefined;
    const driver = createTelegramChannelDriver({
      startAdapter: async (options) => {
        captured = options;
        return {
          stop: async () => undefined,
          notify: async () => ({ delivered: true }),
          post: async () => undefined,
          postStatus: async () => undefined,
        };
      },
    });
    const env: Record<string, string | undefined> = {};

    const app = await startMonoAgentApp({ cwd: dir, env, drivers: [driver] });
    try {
      // The bridge env is exported so settings resolution and spawned tool
      // children can reach it.
      expect(env.MONO_AGENT_INTERACTION_BRIDGE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(env.MONO_AGENT_INTERACTION_BRIDGE_TOKEN).toBeDefined();
      // The channel received the hub (visible as the bot's pendingAsks seam).
      expect(captured?.pendingAsks).toBeDefined();
    } finally {
      await app.stop();
    }
    // Stop tears the bridge down and cleans the exported env.
    expect(env.MONO_AGENT_INTERACTION_BRIDGE_URL).toBeUndefined();
  });

  it("does not start the interaction bridge when neither ask_user nor an interaction block is configured", async () => {
    await writeConfig({
      ...baseConfig(),
      telegram: { enabled: true, botToken: "test-token", allowedChatIds: ["42"] },
    });
    let captured: TelegramAdapterStartOptions | undefined;
    const driver = createTelegramChannelDriver({
      startAdapter: async (options) => {
        captured = options;
        return {
          stop: async () => undefined,
          notify: async () => ({ delivered: true }),
          post: async () => undefined,
          postStatus: async () => undefined,
        };
      },
    });
    const env: Record<string, string | undefined> = {};

    const app = await startMonoAgentApp({ cwd: dir, env, drivers: [driver] });
    try {
      expect(env.MONO_AGENT_INTERACTION_BRIDGE_URL).toBeUndefined();
      expect(captured?.pendingAsks).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it("forwards apiRoot and attachment sizing from telegram config into the adapter start options", async () => {
    let captured: TelegramAdapterStartOptions | undefined;
    const driver = createTelegramChannelDriver({
      startAdapter: async (options) => {
        captured = options;
        return {
          stop: async () => undefined,
          notify: async () => ({ delivered: true }),
          post: async () => undefined,
          postStatus: async () => undefined,
        };
      },
    });

    const running = await driver.start({
      config: {
        enabled: true,
        botToken: "test-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        apiRoot: "http://127.0.0.1:8081",
        attachments: { maxBytes: 268_435_456, downloadTimeoutMs: 120_000, maxUploadBytes: 268_435_456 },
      },
      coreConfig: baseConfig() as never,
      responder: { respond: async () => ({ text: "" }) },
      cwd: dir,
      onFailure: vi.fn(),
    });

    expect(captured?.apiRoot).toBe("http://127.0.0.1:8081");
    // maxUploadBytes is a send-tools concern; only the download knobs flow here.
    expect(captured?.attachments).toEqual({ maxBytes: 268_435_456, downloadTimeoutMs: 120_000 });
    await running.stop();
  });

  it("wires the interaction hub into the Telegram adapter and registers an allowlist-enforcing sink", async () => {
    let captured: TelegramAdapterStartOptions | undefined;
    const post = vi.fn(async () => undefined);
    const postStatus = vi.fn(async () => undefined);
    const driver = createTelegramChannelDriver({
      startAdapter: async (options) => {
        captured = options;
        return {
          stop: async () => undefined,
          notify: async () => ({ delivered: true }),
          post,
          postStatus,
        };
      },
    });
    const sinks = new Map<string, ChannelInteractionSink>();
    const tryResolveAsk = vi.fn(() => true);
    const cancelAsks = vi.fn();
    const hub: ChannelInteractionHub = {
      registerSink: (channelId, sink) => sinks.set(channelId, sink),
      tryResolveAsk,
      cancelAsks,
    };

    const running = await driver.start({
      config: { enabled: true, botToken: "test-token", allowedChatIds: ["42"], allowAllChats: false },
      coreConfig: baseConfig() as never,
      responder: { respond: async () => ({ text: "" }) },
      cwd: dir,
      onFailure: vi.fn(),
      interaction: hub,
    });

    // The bot receives the pending-ask interceptor bound to the hub…
    expect(captured?.pendingAsks).toBeDefined();
    await captured?.pendingAsks?.tryResolve("telegram:42", "the answer");
    expect(tryResolveAsk).toHaveBeenCalledWith("telegram:42", "the answer");
    captured?.pendingAsks?.cancel("telegram:42");
    expect(cancelAsks).toHaveBeenCalledWith("telegram:42");

    // …and the driver registered a telegram sink that posts through the adapter.
    const sink = sinks.get("telegram");
    expect(sink).toBeDefined();
    await sink?.postQuestion("telegram:42", "Who is speaking?");
    expect(post).toHaveBeenCalledWith(42, "Who is speaking?");
    await sink?.postStatus("telegram:42#2026-07-02", "Transcribing…", { key: "job", state: "working" });
    expect(postStatus).toHaveBeenCalledWith(42, "Transcribing…", { key: "job", state: "working" });
    // Destination boundary: a chat outside the adapter allowlist is refused.
    await expect(sink?.postQuestion("telegram:999", "nope")).rejects.toThrow(/allowlist/iu);

    await running.stop();
  });

  it("routes a Telegram poll crash to onDegraded (not the fatal onFailure) and recovery to onRecovered", async () => {
    const onFailure = vi.fn();
    const onDegraded = vi.fn();
    const onRecovered = vi.fn();
    let captured: TelegramAdapterStartOptions | undefined;
    const driver = createTelegramChannelDriver({
      startAdapter: async (options: TelegramAdapterStartOptions) => {
        captured = options;
        return { stop: async () => undefined, notify: async () => ({ delivered: true }), post: async () => undefined, postStatus: async () => undefined };
      },
    });

    const running = await driver.start({
      config: { enabled: true, botToken: "test-token", allowedChatIds: ["42"], allowAllChats: false },
      coreConfig: baseConfig() as never,
      responder: { async respond() { return { text: "ok" }; } },
      cwd: dir,
      onFailure,
      onDegraded,
      onRecovered,
    });

    // A polling crash is recoverable (the adapter self-restarts) → degraded, NOT the
    // fatal onFailure path that would dispose the harness.
    captured?.onPollingError?.(new Error("getUpdates died"));
    expect(onDegraded).toHaveBeenCalledWith("getUpdates died");
    expect(onFailure).not.toHaveBeenCalled();

    // The adapter's later recovery flips the channel back to running.
    captured?.onPollingRecovered?.();
    expect(onRecovered).toHaveBeenCalledTimes(1);

    await running.stop();
  });

  it("routes a Slack Socket Mode loss to onDegraded (not the fatal onFailure) and recovery to onRecovered", async () => {
    const onFailure = vi.fn();
    const onDegraded = vi.fn();
    const onRecovered = vi.fn();
    let captured: SlackAdapterStartOptions | undefined;
    const driver = createSlackChannelDriver({
      startAdapter: async (options: SlackAdapterStartOptions) => {
        captured = options;
        return {
          stop: async () => undefined,
          adapter: { notify: async () => ({ delivered: true }) },
        } as never;
      },
    });

    const running = await driver.start({
      config: {
        enabled: true,
        botToken: "xoxb",
        appToken: "xapp",
        allowedChannelIds: ["D1"],
        allowAllChannels: false,
        botUserIds: [],
        mentionTextAliases: [],
        stripMentionText: false,
      } as never,
      coreConfig: baseConfig() as never,
      responder: { async respond() { return { text: "ok" }; } },
      cwd: dir,
      onFailure,
      onDegraded,
      onRecovered,
    });

    // A Socket Mode drop is recoverable (the runner reconnects with backoff) →
    // degraded (responder/harness kept alive), NOT the fatal onFailure path.
    captured?.onConnectionLost?.("too_many_websockets");
    expect(onDegraded).toHaveBeenCalledWith("too_many_websockets");
    expect(onFailure).not.toHaveBeenCalled();

    // A reconnect that stays up past the stability window flips back to running.
    captured?.onConnectionRestored?.();
    expect(onRecovered).toHaveBeenCalledTimes(1);

    await running.stop();
  });

  it("forwards Slack Socket Mode tuning config into the adapter's reconnect/heartbeat options", async () => {
    let captured: SlackAdapterStartOptions | undefined;
    const driver = createSlackChannelDriver({
      startAdapter: async (options: SlackAdapterStartOptions) => {
        captured = options;
        return {
          stop: async () => undefined,
          adapter: { notify: async () => ({ delivered: true }) },
        } as never;
      },
    });

    const running = await driver.start({
      config: {
        enabled: true,
        botToken: "xoxb",
        appToken: "xapp",
        allowedChannelIds: ["D1"],
        allowAllChannels: false,
        botUserIds: [],
        mentionTextAliases: [],
        stripMentionText: false,
        reconnectMaxBackoffMs: 45000,
        reconnectStabilityMs: 20000,
        heartbeatTimeoutMs: 120000,
      } as never,
      coreConfig: baseConfig() as never,
      responder: { async respond() { return { text: "ok" }; } },
      cwd: dir,
      onFailure: vi.fn(),
    });

    expect(captured?.reconnect?.maxMs).toBe(45000);
    expect(captured?.reconnect?.stabilityMs).toBe(20000);
    expect(captured?.heartbeat?.timeoutMs).toBe(120000);

    await running.stop();
  });

  it("disposes the responder when a channel's transport dies after start (onFailure path)", async () => {
    await writeConfig({ ...baseConfig(), webhook: { enabled: true, port: 0 } });
    const webhookFactory = vi.fn(async () => ({
      invokeUrl: "http://127.0.0.1:9999/webhook/invoke",
      stop: async () => undefined,
    }));
    const drivers = defaultChannelDrivers({ webhook: { adapterFactory: webhookFactory as never } });
    const webhookDriver = drivers.find((driver) => driver.id === "webhook");
    if (webhookDriver === undefined) throw new Error("webhook driver missing");
    const disposeSpy = vi.fn(async () => {});
    const wrapped = {
      ...webhookDriver,
      async start(input: Parameters<typeof webhookDriver.start>[0]) {
        (input.responder as { dispose?: () => Promise<void> }).dispose = disposeSpy;
        const running = await webhookDriver.start(input);
        // Simulate the transport dying after a successful start (a macrotask so it
        // fires after startChannel has stored the running-channel record).
        setTimeout(() => input.onFailure?.("transport died"), 0);
        return running;
      },
    };
    const finalDrivers = drivers.map((driver) => (driver.id === "webhook" ? wrapped : driver));

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      drivers: finalDrivers,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The dead channel reports failed AND its responder/harness was disposed (not
    // orphaned), even though the running-channel record was already deleted.
    expect(app.channelStatus("webhook").kind).toBe("failed");
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    await app.stop();
  });

  it("keeps the responder alive on a transient Telegram poll crash, marks degraded, then recovers", async () => {
    await writeConfig({ ...baseConfig(), telegram: { enabled: true, botToken: "test-token", allowAllChats: true } });
    let captured: TelegramAdapterStartOptions | undefined;
    const telegramDriver = createTelegramChannelDriver({
      startAdapter: async (options) => {
        captured = options;
        return { stop: async () => undefined, notify: async () => ({ delivered: true }), post: async () => undefined, postStatus: async () => undefined };
      },
    });
    const disposeSpy = vi.fn(async () => {});
    const wrapped = {
      ...telegramDriver,
      async start(input: Parameters<typeof telegramDriver.start>[0]) {
        (input.responder as { dispose?: () => Promise<void> }).dispose = disposeSpy;
        return await telegramDriver.start(input);
      },
    };
    const drivers = defaultChannelDrivers().map((driver) => (driver.id === "telegram" ? wrapped : driver));

    const app = await startMonoAgentApp({ cwd: dir, env: {}, drivers });
    expect(app.channelStatus("telegram").kind).toBe("running");

    // Transient poll crash → degraded, and crucially the responder is NOT disposed
    // (the adapter self-restarts and must deliver into a live harness).
    captured?.onPollingError?.(new Error("connect ENETUNREACH"));
    expect(app.channelStatus("telegram").kind).toBe("degraded");
    expect(disposeSpy).not.toHaveBeenCalled();

    // The adapter's restart stays up → recovered → back to running.
    captured?.onPollingRecovered?.();
    expect(app.channelStatus("telegram").kind).toBe("running");

    // A genuine stop still disposes the responder exactly once.
    await app.stop();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a stopped channel when recovery races the stop", async () => {
    await writeConfig({ ...baseConfig(), telegram: { enabled: true, botToken: "test-token", allowAllChats: true } });
    let captured: TelegramAdapterStartOptions | undefined;
    const telegramDriver = createTelegramChannelDriver({
      startAdapter: async (options) => {
        captured = options;
        return { stop: async () => undefined, notify: async () => ({ delivered: true }), post: async () => undefined, postStatus: async () => undefined };
      },
    });
    const disposeSpy = vi.fn(async () => {});
    const wrapped = {
      ...telegramDriver,
      async start(input: Parameters<typeof telegramDriver.start>[0]) {
        (input.responder as { dispose?: () => Promise<void> }).dispose = disposeSpy;
        return await telegramDriver.start(input);
      },
    };
    const drivers = defaultChannelDrivers().map((driver) => (driver.id === "telegram" ? wrapped : driver));

    const app = await startMonoAgentApp({ cwd: dir, env: {}, drivers });
    captured?.onPollingError?.(new Error("connect ENETUNREACH"));
    await app.stop();
    expect(disposeSpy).toHaveBeenCalledTimes(1);

    // A late recovery firing after the channel was stopped/disposed must NOT
    // resurrect it to running (the onRecovered guard checks the running entry).
    captured?.onPollingRecovered?.();
    expect(app.channelStatus("telegram").kind).not.toBe("running");
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("logs an accurate skip (not 'started') when bujo mode has no chat LLM (tier downgrades to journal)", async () => {
    const infos: string[] = [];
    const logger = { info: (m: string) => { infos.push(m); } };

    await writeConfig({
      ...baseConfig(),
      memory: {
        mode: "bujo",
        path: join(dir, "mem"),
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        // no llm → runtime tier is "journal" → rituals are a no-op
      },
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      logger,
    });

    expect(infos.some((m) => /ritual scheduler skipped/iu.test(m))).toBe(true);
    expect(infos.some((m) => /ritual scheduler started/iu.test(m))).toBe(false);
    await app.stop();
  });

  it("logs 'scheduler started' when bujo mode has a chat LLM (tier=bujo)", async () => {
    const infos: string[] = [];
    const logger = { info: (m: string) => { infos.push(m); } };

    await writeConfig({
      ...baseConfig(),
      memory: {
        mode: "bujo",
        path: join(dir, "mem"),
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
      },
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      logger,
    });

    expect(infos.some((m) => /ritual scheduler started/iu.test(m))).toBe(true);
    await app.stop();
  });

  it("drains pending captures (flush) before closing memory on stop", async () => {
    await writeConfig(baseConfig());

    const order: string[] = [];
    const fakeStore = {
      load: async () => undefined,
      appendHostSummary: async () => ({ conversationId: "c", source: "s", bytesWritten: 1 }),
      flush: async () => { order.push("flush"); },
      close: async () => { order.push("close"); },
    };

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
    });

    // Inject a fake store via the test-only seam.
    (app as unknown as { __setSharedMemoryForTest(store: unknown): void })
      .__setSharedMemoryForTest(fakeStore);

    await app.stop();
    expect(order).toEqual(["flush", "close"]);
  });

  it("builds the shared memory store once when concurrent channel startup requests it", async () => {
    await writeConfig(baseConfig());
    const app = await startMonoAgentApp({ cwd: dir, env: {}, drivers: [] });
    const coreConfig = {
      runtime: { model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" }, executionMode: "sdk", maxTurns: 4, workspace: dir, session: { mode: "per-message", idleTimeoutMs: 1_800_000 } },
      context: { identityPath: join(dir, "IDENTITY.md"), selectedSkills: [] },
      memory: { mode: "lite", path: join(dir, "mem"), writeMode: "disabled", maxBytes: 8_000 },
      tools: { allowedTools: [], disallowedTools: [] },
      artifacts: { dir: join(dir, "artifacts") },
      traceability: { registryDir: join(dir, "trace-sources"), sourceId: "app-test", sourceLabel: "App Test" },
    };

    try {
      const controller = app as unknown as { memoryStore(config: unknown): Promise<unknown> };
      const [first, second] = await Promise.all([
        controller.memoryStore(coreConfig),
        controller.memoryStore(coreConfig),
      ]);

      expect(first).toBe(second);
    } finally {
      await app.stop();
    }
  });
});

describe("startMonoAgentApp global trace-source mirror", () => {
  // Every fixture lives under the REAL os.tmpdir() (a hard kill mid-suite can
  // never leave junk in the working tree). The tmpdir guard would normally
  // suppress the mirror for exactly such paths, so the positive tests point
  // the guard's root elsewhere via the MONO_AGENT_TRACE_TMPDIR_ROOT env seam
  // (same pattern as MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR); the guard test
  // leaves the seam unset so the real end-to-end guard fires.
  let mirrorDir: string;

  beforeEach(async () => {
    mirrorDir = await mkdtemp(join(tmpdir(), "agent-app-mirror-test-"));
    await writeFile(join(mirrorDir, "IDENTITY.md"), "# Identity\n\nMirror test agent.\n");
  });

  afterEach(async () => {
    await rm(mirrorDir, { recursive: true, force: true });
  });

  function mirrorConfig(traceability: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
      context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
      artifacts: { dir: "./artifacts" },
      traceability: { registryDir: "./trace-sources", sourceId: "mirror-test", sourceLabel: "Mirror Test", ...traceability },
    };
  }

  async function writeMirrorConfig(json: Record<string, unknown>): Promise<void> {
    await writeFile(join(mirrorDir, "mono-agent.config.json"), JSON.stringify(json, null, 2));
  }

  /** Env with the tmpdir guard pointed AWAY from the real tmpdir, so the fixture can exercise the mirror path. */
  function guardOffEnv(globalRegistryDir: string): Record<string, string> {
    return {
      MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: globalRegistryDir,
      MONO_AGENT_TRACE_TMPDIR_ROOT: join(mirrorDir, "fake-tmp-root"),
    };
  }

  it("mirrors an identical manifest into the global registry, and unregister removes both", async () => {
    await writeMirrorConfig(mirrorConfig());
    const globalRegistryDir = join(mirrorDir, "global-trace-sources");

    const app = await startMonoAgentApp({
      cwd: mirrorDir,
      env: guardOffEnv(globalRegistryDir),
    });

    const local = await listTraceSources({ registryDir: join(mirrorDir, "trace-sources") });
    const global = await listTraceSources({ registryDir: globalRegistryDir });
    expect(local.sources).toHaveLength(1);
    expect(global.sources).toHaveLength(1);
    const localSource = local.sources[0];
    const globalSource = global.sources[0];
    expect(globalSource?.sourceId).toBe(localSource?.sourceId);
    expect(globalSource?.label).toBe(localSource?.label);
    expect(globalSource?.artifactDir).toBe(localSource?.artifactDir);
    expect(globalSource?.pid).toBe(localSource?.pid);
    expect(globalSource?.configPath).toBe(localSource?.configPath);
    expect(globalSource?.transports).toEqual(localSource?.transports);

    await app.stop();

    const localAfterStop = await listTraceSources({ registryDir: join(mirrorDir, "trace-sources") });
    const globalAfterStop = await listTraceSources({ registryDir: globalRegistryDir });
    expect(localAfterStop.sources[0]?.status).toBe("stopped");
    expect(globalAfterStop.sources[0]?.status).toBe("stopped");
  });

  it("skips the mirror when the registry resolves under the REAL os.tmpdir() (test-isolation guard, end-to-end)", async () => {
    await writeMirrorConfig(mirrorConfig());
    const globalRegistryDir = join(mirrorDir, "global-trace-sources");

    const app = await startMonoAgentApp({
      cwd: mirrorDir,
      // No MONO_AGENT_TRACE_TMPDIR_ROOT: the guard compares against the real
      // os.tmpdir(), which this whole fixture lives under — the mirror must
      // be skipped so ephemeral runs never pollute a real global registry.
      env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: globalRegistryDir },
    });

    const local = await listTraceSources({ registryDir: join(mirrorDir, "trace-sources") });
    expect(local.sources).toHaveLength(1);
    // The mirror target must stay untouched — never even created.
    expect(existsSync(globalRegistryDir)).toBe(false);
    const global = await listTraceSources({ registryDir: globalRegistryDir });
    expect(global.sources).toHaveLength(0);

    await app.stop();
    expect(existsSync(globalRegistryDir)).toBe(false);
  });

  it("does not mirror when traceability.globalDiscovery is false", async () => {
    await writeMirrorConfig(mirrorConfig({ globalDiscovery: false }));
    const globalRegistryDir = join(mirrorDir, "global-trace-sources");

    const app = await startMonoAgentApp({
      cwd: mirrorDir,
      env: guardOffEnv(globalRegistryDir),
    });

    const local = await listTraceSources({ registryDir: join(mirrorDir, "trace-sources") });
    const global = await listTraceSources({ registryDir: globalRegistryDir });
    expect(local.sources).toHaveLength(1);
    expect(global.sources).toHaveLength(0);

    await app.stop();
  });

  it("does not mirror when the resolved registryDir already IS the global registry", async () => {
    const globalRegistryDir = join(mirrorDir, "trace-sources");
    await writeMirrorConfig(mirrorConfig());

    const app = await startMonoAgentApp({
      cwd: mirrorDir,
      // The global override points at the SAME dir the agent already registers
      // in: nothing to mirror, and only one manifest file should exist.
      env: guardOffEnv(globalRegistryDir),
    });

    const { sources } = await listTraceSources({ registryDir: globalRegistryDir });
    expect(sources).toHaveLength(1);

    await app.stop();
  });
});
