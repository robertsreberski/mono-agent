import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";
import { sendA2AMessage } from "@mono-agent/a2a-adapter";
import type {
  A2AProviderOptions,
  A2AProviderStartResult,
} from "@mono-agent/a2a-adapter";
import type {
  TelegramBotApi,
  TelegramLongPollerOptions,
  TelegramLongPollerStartOptions,
} from "@mono-agent/telegram-adapter";
import type {
  CronAdapterOptions,
  CronAdapterStartResult,
} from "@mono-agent/cron-adapter";

import {
  resolveFinalDemoArtifactDir,
  resolveFinalDemoTraceRegistryDir,
  startFinalAgentDemo,
} from "../final-demo.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-final-demo-"));
  tempDirs.push(dir);
  return dir;
}

// The shared config patch references ./mcp.json; the host fails closed when
// the file is missing, so fixtures must provide it.
async function writeDemoMcpJson(dir: string): Promise<void> {
  await writeFile(
    join(dir, "mcp.json"),
    `${JSON.stringify({ mcpServers: { demo: { command: "demo-mcp" } } })}\n`,
    "utf8",
  );
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
      if (missingConfigStatus.kind !== "disabled") {
        throw new Error(`Expected disabled, got ${missingConfigStatus.kind}.`);
      }
      expect(missingConfigStatus.reason).toMatch(/disabled/iu);
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

  it("restarts Telegram after operator console writes and uses the updated runtime config", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono from operator console.", "utf8");
    await writeDemoMcpJson(dir);

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
      expect(demo.telegramStatus.kind).toBe("disabled");
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

      const firstSignal = started[0]?.signal;
      const second = await putConfig(demo.operatorConsole.url, demo.operatorConsole.token, put.body.version, {
        runtime: { maxTurns: 9 },
        tools: { allowedTools: ["Read"] },
      });
      expect(second.status).toBe(200);
      expect(second.body.apply?.kind).toBe("applied");
      await waitFor(() => started.length === 2);
      expect(firstSignal?.aborted).toBe(true);
      expect(factoryCalls).toBe(2);

      const result = await pollerOptions?.adapter.handleUpdate({
        update_id: 2,
        message: {
          message_id: 20,
          chat: { id: 987654321, type: "private" },
          from: { id: 77, username: "tester" },
          text: "Use the reloaded config",
        },
      });
      expect(result).toMatchObject({ kind: "handled", action: "responded" });
      expect(fakeRuntime.calls[0]?.options.maxTurns).toBe(9);
      expect(fakeRuntime.calls[0]?.options.allowedTools).toEqual(["Read"]);
    } finally {
      await demo.stop();
    }

    expect(started[1]?.signal?.aborted).toBe(true);
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
    await writeDemoMcpJson(dir);
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
      expect(demo.telegramStatus.kind).toBe("disabled");
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

  it("restarts the A2A provider after an operator console write", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono over a reloaded A2A provider.", "utf8");
    await writeDemoMcpJson(dir);
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify(validA2AOnlyConfigPatch(), null, 2)}\n`,
      "utf8",
    );

    const providers: Array<{ options: A2AProviderOptions; stopped: boolean }> = [];
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: createFakeRuntime().runtime,
      telegramApi: createFakeTelegramApi().api,
      a2aProviderFactory: async (options) => createFakeA2AProvider(options, providers),
    });

    try {
      expect(providers).toHaveLength(1);
      expect(providers[0]?.options.agent.name).toBe("Final Demo A2A");
      const initial = await getConfig(demo.operatorConsole.url, demo.operatorConsole.token);
      const put = await putConfig(demo.operatorConsole.url, demo.operatorConsole.token, initial.version, {
        a2a: {
          agent: { name: "Reloaded Final Demo A2A" },
        },
      });

      expect(put.status).toBe(200);
      expect(put.body.apply?.kind).toBe("applied");
      await waitFor(() => providers.length === 2);
      expect(providers[0]?.stopped).toBe(true);
      expect(providers[1]?.options.agent.name).toBe("Reloaded Final Demo A2A");
      expect(demo.a2aStatus).toMatchObject({
        kind: "running",
        agentCardUrl: "http://127.0.0.1:4201/.well-known/agent-card.json",
      });
    } finally {
      await demo.stop();
    }

    expect(providers[1]?.stopped).toBe(true);
  });

  it("re-registers traceability after trace source config changes", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono with reloaded traceability.", "utf8");
    await writeDemoMcpJson(dir);
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify({
        ...validConfigPatch(),
        traceability: {
          registryDir: "./trace-registry-a",
          sourceId: "source-a",
          sourceLabel: "Source A",
          heartbeatMs: 500,
          staleAfterMs: 1500,
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const started: TelegramLongPollerStartOptions[] = [];
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: {},
      runtime: createFakeRuntime().runtime,
      telegramApi: createFakeTelegramApi().api,
      pollerFactory: () => createAbortableFakePoller(started).poller,
    });

    try {
      await waitFor(() => started.length === 1);
      expect(demo.traceabilityStatus).toMatchObject({
        kind: "running",
        sourceId: "source-a",
        registryDir: resolve(dir, "trace-registry-a"),
      });
      const initial = await getConfig(demo.operatorConsole.url, demo.operatorConsole.token);
      const put = await putConfig(demo.operatorConsole.url, demo.operatorConsole.token, initial.version, {
        artifacts: { dir: "./artifacts-b" },
        traceability: {
          registryDir: "./trace-registry-b",
          sourceId: "source-b",
          sourceLabel: "Source B",
          heartbeatMs: 750,
          staleAfterMs: 2500,
        },
      });

      expect(put.status).toBe(200);
      expect(put.body.apply?.kind).toBe("applied");
      await waitFor(() => demo.traceabilityStatus.kind === "running" && demo.traceabilityStatus.sourceId === "source-b");
      expect(demo.traceabilityStatus).toMatchObject({
        kind: "running",
        sourceId: "source-b",
        registryDir: resolve(dir, "trace-registry-b"),
        artifactDir: resolve(dir, "artifacts-b"),
      });

      const oldManifest = JSON.parse(await readFile(join(dir, "trace-registry-a", "source-a.json"), "utf8")) as { status: string };
      expect(oldManifest.status).toBe("stopped");
      const traceability = await getTraceabilityRuns(demo.operatorConsole.url, demo.operatorConsole.token);
      expect(traceability.sources.map((source) => [source.sourceId, source.label, source.health])).toEqual([
        ["source-b", "Source B", "running"],
      ]);
    } finally {
      await demo.stop();
    }
  });

  it("composes operator console, Telegram, harness, runtime, memory, tools, and artifacts", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono and you love small LEGO blocks.", "utf8");
    await writeDemoMcpJson(dir);
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
      expect(call?.options.mcpServers).toMatchObject({ demo: { command: "demo-mcp" } });

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
      expect(JSON.stringify(observedDetail)).not.toContain("redacted-value");
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

  it("starts webhook, OpenAI API, and cron adapters from demo config", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono from webhook, OpenAI API, and cron.", "utf8");
    await writeDemoMcpJson(dir);
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify({
        ...validConfigPatch(),
        webhook: {
          enabled: true,
          host: "127.0.0.1",
          port: 0,
          path: "/hook",
          defaultMode: "sync",
        },
        openaiApi: {
          enabled: true,
          host: "127.0.0.1",
          port: 0,
          modelId: "agent",
        },
        cron: {
          enabled: true,
          expression: "* * * * *",
          timezone: "UTC",
          prompt: "scheduled check",
          conversationId: "cron:demo",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const fakeRuntime = createFakeRuntime();
    const cronStarts: CronAdapterOptions[] = [];
    const stoppedCronAdapters: CronAdapterStartResult[] = [];
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: fakeRuntime.runtime,
      telegramApi: createFakeTelegramApi().api,
      pollerFactory: () => createAbortableFakePoller().poller,
      cronAdapterFactory: (options) => createFakeCronAdapter(options, cronStarts, stoppedCronAdapters),
    });

    try {
      const webhookStatus = demo.webhookStatus;
      if (webhookStatus.kind !== "running") {
        throw new Error(`Expected webhook running, got ${webhookStatus.kind}.`);
      }
      expect(webhookStatus.invokeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/u);
      expect(JSON.stringify(webhookStatus)).toContain("\"defaultMode\":\"sync\"");

      const openAIApiStatus = demo.openAIApiStatus;
      if (openAIApiStatus.kind !== "running") {
        throw new Error(`Expected OpenAI API running, got ${openAIApiStatus.kind}.`);
      }
      expect(openAIApiStatus.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      expect(JSON.stringify(openAIApiStatus)).toContain("\"modelId\":\"agent\"");

      const cronStatus = demo.cronStatus;
      if (cronStatus.kind !== "running") {
        throw new Error(`Expected cron running, got ${cronStatus.kind}.`);
      }
      expect(cronStatus.jobs).toBe(1);
      expect(cronStarts[0]?.jobs).toEqual([
        {
          id: "default",
          expression: "* * * * *",
          timezone: "UTC",
          prompt: "scheduled check",
          conversationId: "cron:demo",
        },
      ]);

      const response = await fetch(webhookStatus.invokeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello webhook", conversationId: "webhook:test" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "succeeded",
        conversationId: "webhook:test",
        text: "runtime ok",
      });
      expect(fakeRuntime.calls[0]?.prompt).toContain("You are Mono from webhook, OpenAI API, and cron.");
      expect(fakeRuntime.calls[0]?.options.model).toMatchObject({ sdk: "pi", model: "gpt-5.5" });

      const models = await fetch(`${openAIApiStatus.baseUrl}/models`);
      expect(models.status).toBe(200);
      await expect(models.json()).resolves.toMatchObject({
        data: [expect.objectContaining({ id: "agent" })],
      });

      const chat = await fetch(`${openAIApiStatus.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          metadata: { conversation_id: "openai-api:test" },
          messages: [{ role: "user", content: "Hello from OpenWebUI" }],
        }),
      });
      expect(chat.status).toBe(200);
      await expect(chat.json()).resolves.toMatchObject({
        choices: [{ message: { role: "assistant", content: "runtime ok" } }],
      });
      expect(fakeRuntime.calls[1]?.prompt).toContain("You are Mono from webhook, OpenAI API, and cron.");
      expect(fakeRuntime.calls[1]?.prompt).toContain("user: Hello from OpenWebUI");

      const traceability = await getTraceabilityRuns(demo.operatorConsole.url, demo.operatorConsole.token);
      expect(traceability.sources[0]).toMatchObject({
        transports: expect.arrayContaining(["webhook", "openai-api", "cron"]),
      });
    } finally {
      const invokeUrl = demo.webhookStatus.kind === "running" ? demo.webhookStatus.invokeUrl : undefined;
      const openAIApiBaseUrl = demo.openAIApiStatus.kind === "running" ? demo.openAIApiStatus.baseUrl : undefined;
      await demo.stop();
      expect(stoppedCronAdapters).toHaveLength(1);
      if (invokeUrl !== undefined) {
        await expect(fetch(invokeUrl, { method: "POST" })).rejects.toThrow();
      }
      if (openAIApiBaseUrl !== undefined) {
        await expect(fetch(`${openAIApiBaseUrl}/models`)).rejects.toThrow();
      }
    }
  });

  it("passes configured local Pi provider context into runtime calls", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono with local runtime support.", "utf8");
    await writeDemoMcpJson(dir);
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
    await writeDemoMcpJson(dir);
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
      enabled: true,
      botToken: "123456:test-token",
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
        tags: ["agent", "a2a"],
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
  sources: Array<{ sourceId: string; label: string; health: string; transports?: readonly string[] }>;
  runs: Array<{ runId: string; conversationId: string; source: { sourceId: string; label: string } }>;
}> {
  const response = await fetch(`${url}/api/traceability/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as {
    enabled: boolean;
    sources: Array<{ sourceId: string; label: string; health: string; transports?: readonly string[] }>;
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
): Promise<{
  status: number;
  body: {
    version: string;
    apply?: { kind: string; message: string; transports: readonly string[] };
  };
}> {
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
    body: await response.json() as {
      version: string;
      apply?: { kind: string; message: string; transports: readonly string[] };
    },
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
        options.onEvent?.({ type: "fake-event", token: "redacted-value" });
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

function createFakeA2AProvider(
  options: A2AProviderOptions,
  providers: Array<{ options: A2AProviderOptions; stopped: boolean }>,
): A2AProviderStartResult {
  const index = providers.length;
  const entry = { options, stopped: false };
  providers.push(entry);
  const port = 4200 + index;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    agentCardUrl: `${url}/.well-known/agent-card.json`,
    jsonRpcUrl: `${url}/a2a/json-rpc`,
    restUrl: `${url}/a2a/rest`,
    host: options.host ?? "127.0.0.1",
    port,
    agentCard: {
      name: options.agent.name,
      description: options.agent.description,
      version: options.agent.version,
      skills: [options.skill],
    } as A2AProviderStartResult["agentCard"],
    async stop() {
      entry.stopped = true;
    },
  };
}

function createFakeCronAdapter(
  options: CronAdapterOptions,
  starts: CronAdapterOptions[],
  stopped: CronAdapterStartResult[],
): CronAdapterStartResult {
  starts.push(options);
  const adapter: CronAdapterStartResult = {
    jobs: options.jobs.slice(),
    activeJobCount: 0,
    stop() {
      stopped.push(adapter);
    },
  };
  return adapter;
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
