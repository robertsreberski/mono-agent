import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listTraceSources } from "@mono-agent/observability";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import type {
  TelegramAdapterErrorText,
  TelegramAdapterStartOptions,
} from "@mono-agent/telegram-adapter";

import { startMonoAgentApp } from "../app.js";
import { createTelegramChannelDriver, defaultChannelDrivers } from "../channels.js";

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
        return { stop: async () => undefined, notify: async () => ({ delivered: true }) };
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

  it("reports a post-start Telegram polling crash to onFailure", async () => {
    const onFailure = vi.fn();
    const driver = createTelegramChannelDriver({
      // Simulate the adapter starting, then its polling loop crashing later.
      startAdapter: async (options: TelegramAdapterStartOptions) => {
        queueMicrotask(() => options.onPollingError?.(new Error("getUpdates died")));
        return { stop: async () => undefined, notify: async () => ({ delivered: true }) };
      },
    });

    const running = await driver.start({
      config: { enabled: true, botToken: "test-token", allowedChatIds: ["42"], allowAllChats: false },
      coreConfig: baseConfig() as never,
      responder: { async respond() { return { text: "ok" }; } },
      cwd: dir,
      onFailure,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onFailure).toHaveBeenCalledWith("getUpdates died");

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
});
