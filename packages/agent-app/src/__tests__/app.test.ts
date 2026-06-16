import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const fakeConsoleFactory = vi.fn(async () => ({
  url: "http://127.0.0.1:7777",
  token: "test-token",
  stop: vi.fn(async () => undefined),
}));


describe("startMonoAgentApp", () => {
  it("starts configured channels, reports waiting/disabled for the rest, and stops cleanly", async () => {
    await writeConfig({
      ...baseConfig(),
      webhook: { enabled: true, port: 0 },
    });

    const webhookStop = vi.fn(async () => undefined);
    const webhookFactory = vi.fn(async () => ({
      invokeUrl: "http://127.0.0.1:9999/webhook/invoke",
      stop: webhookStop,
    }));

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      operatorConsoleFactory: fakeConsoleFactory,
      drivers: defaultChannelDrivers({ webhook: { adapterFactory: webhookFactory as never } }),
    });

    expect(app.operatorConsole?.appUrl).toBe("http://127.0.0.1:7777/?t=test-token");
    expect(app.channelStatus("webhook")).toEqual({
      kind: "running",
      summary: { invokeUrl: "http://127.0.0.1:9999/webhook/invoke" },
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

  it("reports waiting_for_config for every channel when the core config is incomplete", async () => {
    await writeConfig({
      // No runtime.model: core config cannot load.
      context: { identityPath: "./IDENTITY.md" },
      webhook: { enabled: true },
    });

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      operatorConsoleFactory: fakeConsoleFactory,
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
      operatorConsoleFactory: fakeConsoleFactory,
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
      operatorConsoleFactory: fakeConsoleFactory,
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
      operatorConsoleFactory: fakeConsoleFactory,
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

  it("disables the operator console from the config console section", async () => {
    await writeConfig({ ...baseConfig(), console: { enabled: false } });
    const consoleFactory = vi.fn(async () => ({
      url: "http://127.0.0.1:7777",
      token: "test-token",
      stop: vi.fn(async () => undefined),
    }));

    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      operatorConsoleFactory: consoleFactory,
    });

    expect(app.operatorConsole).toBeUndefined();
    expect(consoleFactory).not.toHaveBeenCalled();
    await app.stop();
  });

  it("uses the configured console port unless the host passes an explicit port", async () => {
    await writeConfig({ ...baseConfig(), console: { port: 4321 } });
    const consoleFactory = vi.fn(async () => ({
      url: "http://127.0.0.1:7777",
      token: "test-token",
      stop: vi.fn(async () => undefined),
    }));

    const fromConfig = await startMonoAgentApp({
      cwd: dir,
      env: {},
      operatorConsoleFactory: consoleFactory,
    });
    expect(consoleFactory).toHaveBeenLastCalledWith(expect.objectContaining({ port: 4321 }));
    await fromConfig.stop();

    const overridden = await startMonoAgentApp({
      cwd: dir,
      env: {},
      operatorConsolePort: 9999,
      operatorConsoleFactory: consoleFactory,
    });
    expect(consoleFactory).toHaveBeenLastCalledWith(expect.objectContaining({ port: 9999 }));
    await overridden.stop();
  });

  it("lets env override the console config section", async () => {
    await writeConfig({ ...baseConfig(), console: { enabled: true, port: 4321 } });
    const consoleFactory = vi.fn(async () => ({
      url: "http://127.0.0.1:7777",
      token: "test-token",
      stop: vi.fn(async () => undefined),
    }));

    const app = await startMonoAgentApp({
      cwd: dir,
      env: { MONO_AGENT_CONSOLE_ENABLED: "false" },
      operatorConsoleFactory: consoleFactory,
    });

    expect(app.operatorConsole).toBeUndefined();
    expect(consoleFactory).not.toHaveBeenCalled();
    await app.stop();
  });

  it("runs headless when the operator console is disabled", async () => {
    await writeConfig(baseConfig());

    const consoleFactory = vi.fn(fakeConsoleFactory);
    const app = await startMonoAgentApp({
      cwd: dir,
      env: {},
      operatorConsole: false,
      operatorConsoleFactory: consoleFactory,
    });

    expect(app.operatorConsole).toBeUndefined();
    expect(consoleFactory).not.toHaveBeenCalled();
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
        return { stop: async () => undefined };
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
    expect(terminalText).toContain("turn limit");
    expect(terminalText).not.toContain("failed honestly");

    await running.stop();
  });

  it("reports a post-start Telegram polling crash to onFailure", async () => {
    const onFailure = vi.fn();
    const driver = createTelegramChannelDriver({
      // Simulate the adapter starting, then its polling loop crashing later.
      startAdapter: async (options: TelegramAdapterStartOptions) => {
        queueMicrotask(() => options.onPollingError?.(new Error("getUpdates died")));
        return { stop: async () => undefined };
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
      operatorConsole: false,
      operatorConsoleFactory: fakeConsoleFactory,
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
      operatorConsole: false,
      operatorConsoleFactory: fakeConsoleFactory,
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
      operatorConsole: false,
      operatorConsoleFactory: fakeConsoleFactory,
    });

    // Inject a fake store via the test-only seam.
    (app as unknown as { __setSharedMemoryForTest(store: unknown): void })
      .__setSharedMemoryForTest(fakeStore);

    await app.stop();
    expect(order).toEqual(["flush", "close"]);
  });
});
