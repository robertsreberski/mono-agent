import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@worklab-ai/runtime-adapter";
import { sendA2AMessage } from "@worklab-ai/a2a-adapter";
import type {
  TelegramBotApi,
  TelegramLongPollerOptions,
  TelegramLongPollerStartOptions,
} from "@worklab-ai/telegram-adapter";

import {
  resolveFinalDemoArtifactDir,
  resolveFinalDemoTraceRegistryDir,
  startFinalAgentDemo,
} from "./final-demo.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-final-demo-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("final agent demo", () => {
  it("starts a loopback operator console and waits honestly when config is missing", async () => {
    const dir = await tempDir();
    let pollerConstructed = false;
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: createFakeRuntime().runtime,
      telegramApi: createFakeTelegramApi().api,
      pollerFactory: () => {
        pollerConstructed = true;
        return createAbortableFakePoller().poller;
      },
    });

    try {
      expect(demo.operatorConsole.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(demo.operatorConsole.appUrl).toBe(`${demo.operatorConsole.url}/?t=${demo.operatorConsole.token}`);
      expect(demo.operatorConsole.token).toMatch(/^[0-9a-f]{64}$/u);
      expect(demo.operatorConsole.configPath).toBe(resolve(dir, "mono-agent.config.json"));
      const missingConfigStatus = demo.telegramStatus;
      if (missingConfigStatus.kind !== "waiting_for_config") {
        throw new Error(`Expected waiting_for_config, got ${missingConfigStatus.kind}.`);
      }
      expect(missingConfigStatus.reason).toMatch(/MONO_AGENT_MODEL/u);
      expect(demo.a2aStatus).toMatchObject({ kind: "disabled" });
      expect(pollerConstructed).toBe(false);

      const health = await fetch(`${demo.operatorConsole.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const observability = await getObservabilityRuns(demo.operatorConsole.url, demo.operatorConsole.token);
      expect(observability.enabled).toBe(true);
      expect(observability.artifactDir).toBe(resolve(dir, ".mono-agent", "artifacts"));
      expect(observability.runs).toEqual([]);
      expect(demo.traceabilityStatus).toMatchObject({
        kind: "running",
        registryDir: resolve(dir, "trace-registry"),
        artifactDir: resolve(dir, ".mono-agent", "artifacts"),
      });
      const traceability = await getTraceabilityRuns(demo.operatorConsole.url, demo.operatorConsole.token);
      expect(traceability.enabled).toBe(true);
      expect(traceability.sources[0]).toMatchObject({ label: "Final Agent Demo", health: "running" });
    } finally {
      await demo.stop();
    }

    await expect(fetch(`${demo.operatorConsole.url}/api/health`)).rejects.toThrow();
  });

  it("starts Telegram exactly once after a valid operator console write", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono from operator console.", "utf8");

    const fakeRuntime = createFakeRuntime();
    const fakeApi = createFakeTelegramApi();
    const started: TelegramLongPollerStartOptions[] = [];
    let factoryCalls = 0;
    let pollerOptions: TelegramLongPollerOptions | undefined;

    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: fakeRuntime.runtime,
      telegramApi: fakeApi.api,
      pollerFactory: (options) => {
        factoryCalls += 1;
        pollerOptions = options;
        return createAbortableFakePoller(started).poller;
      },
    });

    try {
      expect(demo.telegramStatus.kind).toBe("waiting_for_config");
      const initial = await getConfig(demo.operatorConsole.url, demo.operatorConsole.token);
      const put = await putConfig(demo.operatorConsole.url, demo.operatorConsole.token, initial.version, validConfigPatch());
      expect(put.status).toBe(200);

      await waitFor(() => started.length === 1);
      expect(factoryCalls).toBe(1);
      expect(pollerOptions).toMatchObject({ deleteWebhookOnStart: true, allowedUpdates: ["message"] });
      expect(demo.telegramStatus.kind).toBe("running");
      expect(demo.a2aStatus.kind).toBe("disabled");
      expect(JSON.stringify(demo.telegramStatus)).not.toContain("secret-token");
      expect(JSON.stringify(demo.telegramStatus)).not.toContain("987654321");

      const second = await putConfig(demo.operatorConsole.url, demo.operatorConsole.token, put.body.version, {
        runtime: { maxTurns: 9 },
      });
      expect(second.status).toBe(200);
      await delay(25);
      expect(started).toHaveLength(1);
    } finally {
      await demo.stop();
    }

    expect(started[0]?.signal?.aborted).toBe(true);
  });

  it("resolves the observability artifact directory without requiring a valid full config", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "mono-agent.config.json");

    await writeFile(configPath, "{ this is not valid json", "utf8");
    await expect(resolveFinalDemoArtifactDir({ env: { MONO_AGENT_ARTIFACT_DIR: "./from-env" }, cwd: dir, configPath }))
      .resolves.toBe(resolve(dir, "from-env"));
    await expect(resolveFinalDemoArtifactDir({ env: {}, cwd: dir, configPath }))
      .resolves.toBe(resolve(dir, ".mono-agent", "artifacts"));

    await writeFile(configPath, `${JSON.stringify({ artifacts: { dir: "./from-config" } })}\n`, "utf8");
    await expect(resolveFinalDemoArtifactDir({ env: {}, cwd: dir, configPath }))
      .resolves.toBe(resolve(dir, "from-config"));
  });

  it("resolves traceability settings without requiring a valid full config", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "mono-agent.config.json");

    await writeFile(configPath, "{ this is not valid json", "utf8");
    await expect(resolveFinalDemoTraceRegistryDir({ env: { MONO_AGENT_TRACE_REGISTRY_DIR: "./from-env" }, cwd: dir, configPath }))
      .resolves.toBe(resolve(dir, "from-env"));
    await expect(resolveFinalDemoTraceRegistryDir({ env: {}, cwd: dir, configPath }))
      .resolves.toBe(resolve(homedir(), ".mono-agent", "trace-sources"));

    await writeFile(configPath, `${JSON.stringify({ traceability: { registryDir: "./from-config" } })}\n`, "utf8");
    await expect(resolveFinalDemoTraceRegistryDir({ env: {}, cwd: dir, configPath }))
      .resolves.toBe(resolve(dir, "from-config"));
  });

  it("starts an A2A provider independently when Telegram is not configured", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono over A2A.", "utf8");
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify(validA2AOnlyConfigPatch(), null, 2)}\n`,
      "utf8",
    );

    let pollerConstructed = false;
    const fakeRuntime = createFakeRuntime();
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: fakeRuntime.runtime,
      telegramApi: createFakeTelegramApi().api,
      pollerFactory: () => {
        pollerConstructed = true;
        return createAbortableFakePoller().poller;
      },
    });

    try {
      expect(demo.telegramStatus.kind).toBe("waiting_for_config");
      expect(pollerConstructed).toBe(false);
      const a2aStatus = demo.a2aStatus;
      if (a2aStatus.kind !== "running") {
        throw new Error(`Expected A2A running, got ${a2aStatus.kind}.`);
      }
      expect(a2aStatus.agentCardUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\.well-known\/agent-card\.json$/u);
      expect(JSON.stringify(a2aStatus)).not.toContain("a2a-secret");

      const cardResponse = await fetch(a2aStatus.agentCardUrl);
      expect(cardResponse.status).toBe(200);
      expect(await cardResponse.json()).toMatchObject({
        name: "Final Demo A2A",
      });

      const response = await sendA2AMessage({
        agentUrl: a2aStatus.agentCardUrl,
        text: "Hello from another Mono agent",
      });
      expect(response.text).toBe("runtime ok");
      expect(fakeRuntime.calls).toHaveLength(1);
      expect(fakeRuntime.calls[0]?.prompt).toContain("You are Mono over A2A.");
    } finally {
      const agentCardUrl = demo.a2aStatus.kind === "running" ? demo.a2aStatus.agentCardUrl : undefined;
      await demo.stop();
      if (agentCardUrl !== undefined) {
        await expect(fetch(agentCardUrl)).rejects.toThrow();
      }
    }
  });

  it("composes operator console, Telegram, harness, runtime, memory, tools, and artifacts", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono and you love small LEGO blocks.", "utf8");
    await writeFile(join(dir, "MEMORY.md"), "Remember: prefer small package boundaries.", "utf8");
    await writeFile(join(dir, "mono-agent.config.json"), `${JSON.stringify(validConfigPatch(), null, 2)}\n`, "utf8");

    const fakeRuntime = createFakeRuntime();
    const fakeApi = createFakeTelegramApi();
    let pollerOptions: TelegramLongPollerOptions | undefined;
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: fakeRuntime.runtime,
      telegramApi: fakeApi.api,
      pollerFactory: (options) => {
        pollerOptions = options;
        return createAbortableFakePoller().poller;
      },
    });

    try {
      expect(demo.telegramStatus.kind).toBe("running");
      expect(pollerOptions).toBeDefined();
      const result = await pollerOptions?.adapter.handleUpdate({
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: 987654321, type: "private" },
          from: { id: 77, username: "tester" },
          text: "Hello demo",
        },
      });

      expect(result).toMatchObject({ kind: "handled", action: "responded" });
      expect(fakeRuntime.calls).toHaveLength(1);
      const call = fakeRuntime.calls[0];
      expect(call?.prompt).toContain("You are Mono and you love small LEGO blocks.");
      expect(call?.prompt).toContain("Remember: prefer small package boundaries.");
      expect(call?.options.model).toMatchObject({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5" });
      expect(call?.options.executionMode).toBe("sdk");
      expect(call?.options.cwd).toBe(resolve(dir, "workspace"));
      expect(call?.options.maxTurns).toBe(4);
      expect(call?.options.allowedTools).toEqual(["Read", "Grep"]);
      expect(call?.options.disallowedTools).toEqual(["Bash"]);
      expect(call?.options.mcpConfigPath).toBe(resolve(dir, "mcp.json"));

      const memory = await readFile(join(dir, "MEMORY.md"), "utf8");
      expect(memory).toContain("Host-observed completed turn.");
      expect(memory).toContain("Hello demo");
      const artifactFiles = await readdir(join(dir, "artifacts"));
      const summaryFile = artifactFiles.find((file) => file.endsWith(".summary.json"));
      expect(summaryFile).toBeDefined();
      expect(await readFile(join(dir, "artifacts", summaryFile as string), "utf8")).toContain("capabilitiesUsed");

      const observedRuns = await getObservabilityRuns(demo.operatorConsole.url, demo.operatorConsole.token);
      expect(observedRuns.enabled).toBe(true);
      expect(observedRuns.artifactDir).toBe(resolve(dir, "artifacts"));
      expect(observedRuns.runs[0]).toMatchObject({ conversationId: "telegram:987654321", status: "succeeded" });
      const observedDetail = await getObservedRun(demo.operatorConsole.url, demo.operatorConsole.token, observedRuns.runs[0]?.runId ?? "");
      expect(observedDetail.run?.events[0]).toMatchObject({ category: "runtime", type: "fake-event" });
      expect(JSON.stringify(observedDetail)).not.toContain("should-redact");
      const traceability = await getTraceabilityRuns(demo.operatorConsole.url, demo.operatorConsole.token);
      expect(traceability.runs[0]).toMatchObject({
        conversationId: "telegram:987654321",
        source: { label: "Final Agent Demo" },
      });
      const traceDetail = await getTraceabilityRun(
        demo.operatorConsole.url,
        demo.operatorConsole.token,
        traceability.runs[0]?.source.sourceId ?? "",
        traceability.runs[0]?.runId ?? "",
      );
      expect(traceDetail.detail?.run.events[0]).toMatchObject({ category: "runtime", type: "fake-event" });
      expect(fakeApi.sentTexts.join("\n")).toContain("runtime ok");
    } finally {
      await demo.stop();
    }
  });

  it("passes configured local Pi provider context into runtime calls", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono with local runtime support.", "utf8");
    const patch = validConfigPatch();
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify({
        ...patch,
        runtime: {
          ...patch.runtime,
          model: "pi:ollama:qwen3:8b",
        },
        providers: {
          local: [
            {
              id: "ollama",
              type: "ollama",
              baseUrl: "http://localhost:11434",
              enabled: true,
              models: [
                {
                  name: "qwen3:8b",
                  capabilities: { context_window: 32768 },
                },
              ],
            },
          ],
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const fakeRuntime = createFakeRuntime();
    let pollerOptions: TelegramLongPollerOptions | undefined;
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: fakeRuntime.runtime,
      telegramApi: createFakeTelegramApi().api,
      pollerFactory: (options) => {
        pollerOptions = options;
        return createAbortableFakePoller().poller;
      },
    });

    try {
      expect(demo.telegramStatus.kind).toBe("running");
      const result = await pollerOptions?.adapter.handleUpdate({
        update_id: 2,
        message: {
          message_id: 20,
          chat: { id: 987654321, type: "private" },
          from: { id: 77, username: "tester" },
          text: "Use local model",
        },
      });

      expect(result).toMatchObject({ kind: "handled", action: "responded" });
      expect(fakeRuntime.calls).toHaveLength(1);
      const call = fakeRuntime.calls[0];
      expect(call?.options.model).toMatchObject({ sdk: "pi", provider: "ollama", model: "qwen3:8b" });
      expect(call?.options.customProvider).toMatchObject({
        id: "ollama",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
        enabled: true,
      });
      expect(call?.options.customModel).toMatchObject({
        model_name: "qwen3:8b",
        display_name: "qwen3:8b",
        enabled: true,
      });
      expect(call?.options.modelCapabilities).toMatchObject({
        context_window: 32768,
        reasoning: true,
      });
      expect(call?.options.isPrivateProvider).toBe(true);
    } finally {
      await demo.stop();
    }
  });

  it("waits for config instead of starting Telegram when a local provider URL is unsafe", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono with local runtime support.", "utf8");
    const patch = validConfigPatch();
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify({
        ...patch,
        runtime: {
          ...patch.runtime,
          model: "pi:ollama:qwen3:8b",
        },
        providers: {
          local: [
            {
              id: "ollama",
              type: "ollama",
              baseUrl: "http://api.example.com",
              enabled: true,
            },
          ],
        },
      }, null, 2)}\n`,
      "utf8",
    );
    let pollerConstructed = false;

    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: createFakeRuntime().runtime,
      telegramApi: createFakeTelegramApi().api,
      pollerFactory: () => {
        pollerConstructed = true;
        return createAbortableFakePoller().poller;
      },
    });

    try {
      const status = demo.telegramStatus;
      if (status.kind !== "waiting_for_config") {
        throw new Error(`Expected waiting_for_config, got ${status.kind}.`);
      }
      expect(status.reason).toMatch(/public host/u);
      expect(pollerConstructed).toBe(false);
    } finally {
      await demo.stop();
    }
  });
});

function validConfigPatch() {
  return {
    telegram: {
      botToken: "123456:secret-token",
      allowedChatIds: ["987654321"],
    },
    runtime: {
      model: "pi:openai-codex:gpt-5.5",
      executionMode: "sdk",
      maxTurns: 4,
      workspace: "./workspace",
    },
    context: {
      identityPath: "./IDENTITY.md",
      selectedSkills: [],
    },
    memory: {
      path: "./MEMORY.md",
      maxBytes: 64_000,
      scope: "single-file" as const,
      writeMode: "append-host-summary" as const,
    },
    tools: {
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      mcpConfigPath: "./mcp.json",
    },
    artifacts: {
      dir: "./artifacts",
    },
    traceability: {
      registryDir: "./trace-registry",
    },
  };
}

function testTraceEnv(): Record<string, string> {
  return {
    MONO_AGENT_TRACE_REGISTRY_DIR: "./trace-registry",
  };
}

function validA2AOnlyConfigPatch() {
  const { telegram: _telegram, memory: _memory, ...patch } = validConfigPatch();
  return {
    ...patch,
    a2a: {
      provider: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
      },
      agent: {
        name: "Final Demo A2A",
        description: "Final demo A2A provider.",
        version: "0.1.0",
      },
      skill: {
        id: "final-demo",
        name: "Final Demo",
        description: "Runs the configured final demo runtime over A2A.",
        tags: ["mono-agent", "a2a"],
      },
    },
  };
}

async function getConfig(url: string, token: string): Promise<{ version: string; config: unknown }> {
  const response = await fetch(`${url}/api/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as { version: string; config: unknown };
}

async function getObservabilityRuns(
  url: string,
  token: string,
): Promise<{
  enabled: boolean;
  artifactDir?: string;
  runs: Array<{ runId: string; conversationId: string; status: string }>;
}> {
  const response = await fetch(`${url}/api/observability/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as {
    enabled: boolean;
    artifactDir?: string;
    runs: Array<{ runId: string; conversationId: string; status: string }>;
  };
}

async function getTraceabilityRuns(
  url: string,
  token: string,
): Promise<{
  enabled: boolean;
  sources: Array<{ sourceId: string; label: string; health: string }>;
  runs: Array<{ runId: string; conversationId: string; source: { sourceId: string; label: string } }>;
}> {
  const response = await fetch(`${url}/api/traceability/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as {
    enabled: boolean;
    sources: Array<{ sourceId: string; label: string; health: string }>;
    runs: Array<{ runId: string; conversationId: string; source: { sourceId: string; label: string } }>;
  };
}

async function getTraceabilityRun(
  url: string,
  token: string,
  sourceId: string,
  runId: string,
): Promise<{ detail?: { run: { events: Array<{ category: string; type?: string }> } } }> {
  const response = await fetch(`${url}/api/traceability/runs/${encodeURIComponent(sourceId)}/${encodeURIComponent(runId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as { detail?: { run: { events: Array<{ category: string; type?: string }> } } };
}

async function getObservedRun(
  url: string,
  token: string,
  runId: string,
): Promise<{ run?: { events: Array<{ category: string; type?: string }> } }> {
  const response = await fetch(`${url}/api/observability/runs/${encodeURIComponent(runId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as { run?: { events: Array<{ category: string; type?: string }> } };
}

async function putConfig(
  url: string,
  token: string,
  expectedVersion: string,
  patch: unknown,
): Promise<{ status: number; body: { version: string } }> {
  const response = await fetch(`${url}/api/config`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expectedVersion, patch }),
  });
  return {
    status: response.status,
    body: await response.json() as { version: string },
  };
}

function createFakeRuntime(): {
  readonly calls: Array<{ prompt: string; options: RuntimeRunOptions; metadataRunId?: string }>;
  readonly runtime: { run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> };
} {
  const calls: Array<{ prompt: string; options: RuntimeRunOptions; metadataRunId?: string }> = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        options.onEvent?.({ type: "fake-event", token: "should-redact" });
        calls.push({ prompt, options });
        return {
          text: "runtime ok",
          model: options.model.model,
          sdk: options.model.sdk,
          cost: { totalUsd: 0 },
          capabilitiesUsed: ["telegram", "operator-console"],
        };
      },
    },
  };
}

function createFakeTelegramApi(): { readonly api: TelegramBotApi; readonly sentTexts: string[] } {
  const sentTexts: string[] = [];
  return {
    sentTexts,
    api: {
      async sendMessage(params) {
        sentTexts.push(params.text);
        return { message_id: sentTexts.length, chat: { id: params.chat_id }, text: params.text };
      },
      async editMessageText(params) {
        sentTexts.push(params.text);
        return { message_id: params.message_id ?? sentTexts.length, chat: { id: params.chat_id ?? 987654321 }, text: params.text };
      },
      async getUpdates() {
        return [];
      },
      async deleteWebhook() {
        return true;
      },
    },
  };
}

function createAbortableFakePoller(started: TelegramLongPollerStartOptions[] = []): {
  readonly poller: { start(options?: TelegramLongPollerStartOptions): Promise<void> };
} {
  return {
    poller: {
      async start(options: TelegramLongPollerStartOptions = {}): Promise<void> {
        started.push(options);
        if (options.signal?.aborted === true) {
          return;
        }
        await new Promise<void>((resolvePromise) => {
          options.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
        });
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await delay(10);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
