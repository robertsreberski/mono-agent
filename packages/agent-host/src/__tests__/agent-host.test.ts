import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import type { EmbeddingProvider } from "@mono-agent/memory-search";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";
import { createSandboxPolicy } from "@mono-agent/sandbox";

/** Deterministic non-zero fake embeddings (dim 64) — keeps journal/bujo-tier tests hermetic (no Ollama). */
const fakeEmbeddings: EmbeddingProvider = {
  id: "fake",
  embed: async (texts) => texts.map(() => Array.from({ length: 64 }, () => 0.01)),
};

import {
  createConfiguredAgentHarness,
  createConfiguredAgentResponder,
  createConfiguredAgentRuntime,
  createConfiguredMemory,
} from "../index.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent host composition helpers", () => {
  it("creates a responder from MonoAgentConfig with runtime, tools, local providers, request extensions, and recording", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async (_prompt, options) => {
      options.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "streamed " }] } });
      return {
        text: "Final answer",
        model: options.model.model,
        sdk: options.model.sdk,
        capabilitiesUsed: ["agent-host"],
        cost: { totalUsd: 0 },
      };
    });

    const responder = createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      createRunId: () => "run-host",
      runtimeOptionsForRequest: ({ request, runId }) => {
        expect(request.conversationId).toBe("conversation-host");
        expect(runId).toBe("run-host");
        return {
          runtimeOptions: {
            allowedTools: ["ask_collaborator"],
            mcpServers: {
              collaborators: { type: "http", url: "http://127.0.0.1:9876/mcp" },
            },
          },
        };
      },
    });

    const streamText: string[] = [];
    const response = await responder.respond(
      { conversationId: "conversation-host", text: "What changed?", abortSignal: new AbortController().signal },
      { append: async (delta) => { streamText.push(delta); } },
    );

    expect(response.text).toBe("Final answer");
    expect(streamText).toEqual(["streamed "]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.prompt).toContain("You are Mono.");
    expect(fake.calls[0]?.options).toMatchObject({
      cwd: dir,
      maxTurns: 4,
      allowedTools: ["Read", "ask_collaborator"],
      disallowedTools: ["Write"],
      customProvider: {
        id: "ollama",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
      },
      customModel: {
        provider_id: "ollama",
        model_name: "qwen3:8b",
      },
      mcpServers: {
        collaborators: { type: "http", url: "http://127.0.0.1:9876/mcp" },
      },
    });

    const artifactFiles = await readdir(artifactDir);
    const summaryFile = artifactFiles.find((file) => file.endsWith(".summary.json"));
    expect(summaryFile).toBeDefined();
    expect(await readFile(join(artifactDir, summaryFile as string), "utf8")).toContain("run-host");
  });

  it("records each turn into today's daily file (journal tier) and surfaces it on the next turn", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryRoot = join(dir, "memory");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Logged answer" }));

    const responder = createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        memoryPath: memoryRoot,
        memoryMode: "journal",
        memoryWriteMode: "append-host-summary",
        artifactDir,
      }),
      runtime: fake.runtime,
      // Inject a fake-embeddings journal-tier store so the test is hermetic (no live Ollama in CI).
      memory: createBujoMemoryStore({ root: memoryRoot, embeddings: fakeEmbeddings, dim: 64 }),
    });

    await responder.respond(
      { conversationId: "channel-a", text: "First message", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    // The completed turn is appended as a bullet in today's daily file.
    const dailyFiles = await readdir(join(memoryRoot, "daily"));
    expect(dailyFiles.length).toBeGreaterThan(0);
    const todayFile = dailyFiles.find((f) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(f));
    expect(todayFile).toBeDefined();
    const dailyContent = await readFile(join(memoryRoot, "daily", todayFile!), "utf8");
    expect(dailyContent).toContain("Logged answer");

    // A second turn sees the stored memory in context via FTS/semantic recall.
    await responder.respond(
      { conversationId: "channel-b", text: "Logged answer", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[1]?.prompt).toContain("## Memory (recalled)");
    expect(fake.calls[1]?.prompt).toContain("Logged answer");
  });

  it("uses the injected harness runtime for agent-host memory LLM capture", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryRoot = join(dir, "memory");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const embeddingsEndpoint = await startEmbeddingServer();
    const fake = createFakeRuntime(async (_prompt, options) => {
      if (options.model.provider === "openai-codex") {
        return { text: "[]" };
      }
      return { text: "Harness answer" };
    });

    const responder = createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        memoryPath: memoryRoot,
        memoryMode: "bujo",
        memoryWriteMode: "capture",
        memoryEmbeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKey: "sk-test",
          endpoint: embeddingsEndpoint,
        },
        memoryLlm: {
          provider: "agent-host",
          model: "pi:openai-codex:gpt-5.5",
          executionMode: "sdk",
        },
        artifactDir,
      }),
      runtime: fake.runtime,
    });

    const response = await responder.respond({
      conversationId: "channel-a",
      text: "Remember that memory capture should reuse the injected runtime.",
      abortSignal: new AbortController().signal,
    }, { append: async () => {} });

    expect(response.text).toBe("Harness answer");
    for (let i = 0; i < 20 && fake.calls.length < 3; i += 1) {
      await delay(5);
    }
    const memoryCalls = fake.calls.filter((call) => call.options.model.provider === "openai-codex");
    expect(memoryCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of memoryCalls) {
      expect(call.options.allowedTools).toEqual([]);
      expect(call.options.disallowedTools).toEqual([]);
      expect(call.options.mcpServers).toEqual({});
      expect(call.options.maxTurns).toBe(1);
    }
  });

  it("caps selected skill bodies at context.skillMaxBytes", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const skillsRoot = join(dir, "skills");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    await mkdir(join(skillsRoot, "big"), { recursive: true });
    await writeFile(
      join(skillsRoot, "big", "SKILL.md"),
      `Big skill description.\n\n${"filler ".repeat(64)}SKILL_TAIL_MARKER`,
      "utf8",
    );
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const uncapped = createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, skillsRoot, selectedSkills: ["big"], artifactDir }),
      runtime: fake.runtime,
    });
    await uncapped.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[0]?.prompt).toContain("SKILL_TAIL_MARKER");

    const capped = createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, skillsRoot, selectedSkills: ["big"], skillMaxBytes: 256, artifactDir }),
      runtime: fake.runtime,
    });
    await capped.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[1]?.prompt).not.toContain("SKILL_TAIL_MARKER");
  });

  it("fails closed when tools.mcpConfigPath points at a missing file", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    expect(() =>
      createConfiguredAgentHarness({
        config: monoConfig({ dir, identityPath, artifactDir, mcpConfigPath: join(dir, "missing.json") }),
        runtime: fake.runtime,
      }),
    ).toThrowError(expect.objectContaining({ code: "tool_policy_read_failed" }));
  });

  it("forwards runtime.permissionMode to the runtime and does NOT forward the deprecated reasoningSummary", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const responder = createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        permissionMode: "bypassPermissions",
        reasoningSummary: "detailed",
      }),
      runtime: fake.runtime,
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.permissionMode).toBe("bypassPermissions");
    // reasoningSummary is no longer wired to a runtime option: pi-native derives
    // reasoning from effort and the codex/claude CLIs emit summaries themselves.
    expect(fake.calls[0]?.options.piReasoningSummary).toBeUndefined();
  });

  it("bounds in-flight runs at concurrency.maxConcurrentRuns", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");

    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const fake = createFakeRuntime(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { release.push(resolve); });
      active -= 1;
      return { text: "ok" };
    });

    const harness = createConfiguredAgentHarness({
      config: { ...monoConfig({ dir, identityPath, artifactDir }), concurrency: { maxConcurrentRuns: 1 } },
      runtime: fake.runtime,
    });

    const first = harness.run({ conversationId: "c1", userMessage: "a", abortSignal: new AbortController().signal });
    const second = harness.run({ conversationId: "c2", userMessage: "b", abortSignal: new AbortController().signal });

    // Let the limiter settle: only one run should be in-flight.
    for (let i = 0; i < 20 && release.length < 1; i += 1) {
      await delay(5);
    }
    expect(release.length).toBe(1);
    release.shift()?.();
    for (let i = 0; i < 20 && release.length < 1; i += 1) {
      await delay(5);
    }
    release.shift()?.();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });

  it("threads concurrency.maxPendingRuns from config so over-capacity runs fail fast", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");

    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const release: Array<() => void> = [];
    let calls = 0;
    const fake = createFakeRuntime(async () => {
      calls += 1;
      if (calls === 1) {
        started();
      }
      await new Promise<void>((resolve) => { release.push(resolve); });
      return { text: "ok" };
    });

    // maxPendingRuns is config-only plumbing: if it were not threaded into the
    // harness, the third run would not fail fast.
    const harness = createConfiguredAgentHarness({
      config: { ...monoConfig({ dir, identityPath, artifactDir }), concurrency: { maxConcurrentRuns: 1, maxPendingRuns: 1 } },
      runtime: fake.runtime,
    });

    // First admits and runs (holds the only provider slot).
    const first = harness.run({ conversationId: "c1", userMessage: "a", abortSignal: new AbortController().signal });
    await firstStarted;
    // Second admits but parks waiting for the slot (pending = 1).
    const second = harness.run({ conversationId: "c2", userMessage: "b", abortSignal: new AbortController().signal });
    await delay(10);
    // Third arrives at capacity -> fails fast.
    const third = await harness.run({ conversationId: "c3", userMessage: "c", abortSignal: new AbortController().signal });

    expect(third.failure?.kind).toBe("capacity_exceeded");
    expect(calls).toBe(1);

    // Drain.
    for (const fn of release.splice(0)) { fn(); }
    await first;
    for (let i = 0; i < 20 && release.length < 1; i += 1) { await delay(5); }
    for (const fn of release.splice(0)) { fn(); }
    await second;
  });

  it("trips the embeddings circuit breaker at the configured failureThreshold", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    const memoryRoot = join(dir, "memory");
    await writeFile(identityPath, "You are Mono.", "utf8");

    // A counting embeddings server that always errors. With failureThreshold 1 the breaker
    // trips OPEN after the first failure, so the second recall must NOT reach the server.
    let requests = 0;
    const endpoint = await startFailingEmbeddingServer(() => { requests += 1; });

    const memory = createConfiguredMemory({
      ...monoConfig({
        dir,
        identityPath,
        artifactDir,
        memoryPath: memoryRoot,
        memoryMode: "journal",
        memoryEmbeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test", endpoint },
      }),
      memory: {
        mode: "journal",
        path: memoryRoot,
        maxBytes: 64_000,
        writeMode: "disabled",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKey: "sk-test",
          endpoint,
          timeoutMs: 1000,
          circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
        },
      },
    } as MonoAgentConfig);

    // First load drives an embedding request that fails and trips the breaker.
    await expect(memory!.load("conv")).rejects.toThrow();
    expect(requests).toBe(1);
    // Second load fast-fails on the OPEN breaker without hitting the server again.
    await expect(memory!.load("conv")).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("lets host runtimeOptions override config runtime flags", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const responder = createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, permissionMode: "acceptEdits" }),
      runtime: fake.runtime,
      runtimeOptions: { permissionMode: "bypassPermissions" },
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.permissionMode).toBe("bypassPermissions");
  });

  it("creates a configured harness when a host wants to wrap the responder itself", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Harness answer" }));

    const harness = createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      createRunId: () => "run-harness",
    });

    const response = await harness.run({
      conversationId: "conversation-harness",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe("Harness answer");
    expect(fake.calls[0]?.options.maxTurns).toBe(4);
  });

  it("omits maxTurns from runtime options when the config leaves it unlimited", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Unlimited answer" }));
    const config = monoConfig({ dir, identityPath, artifactDir });
    const { maxTurns: _maxTurns, ...runtime } = config.runtime;

    const harness = createConfiguredAgentHarness({
      config: { ...config, runtime } as MonoAgentConfig,
      runtime: fake.runtime,
    });

    const response = await harness.run({
      conversationId: "conversation-unlimited",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe("Unlimited answer");
    expect(fake.calls[0]?.options.maxTurns).toBeUndefined();
  });

  it("overrides config model and executionMode when supplied at composition time", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async (_prompt, options) => ({ text: "ok", model: options.model.model }));

    const harness = createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      model: { sdk: "claude", model: "claude-opus-4-7" },
      executionMode: "stream",
    });

    await harness.run({
      conversationId: "conversation-override",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(fake.calls[0]?.options.model).toEqual({ sdk: "claude", model: "claude-opus-4-7" });
    expect(fake.calls[0]?.options.executionMode).toBe("stream");
  });

  it("falls back to config model and executionMode when no override is supplied", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async (_prompt, options) => ({ text: "ok", model: options.model.model }));

    const harness = createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
    });

    await harness.run({
      conversationId: "conversation-fallback",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(fake.calls[0]?.options.model.sdk).toBe("pi");
    expect(fake.calls[0]?.options.executionMode).toBe("sdk");
  });

  it("creates the default Mono runtime with config workspace and artifact directory", () => {
    const config = monoConfig({
      dir: "/tmp/mono-agent-host",
      identityPath: "/tmp/mono-agent-host/IDENTITY.md",
      artifactDir: "/tmp/mono-agent-host/artifacts",
    });

    const runtime = createConfiguredAgentRuntime(config);

    expect(runtime.run).toEqual(expect.any(Function));
    expect(runtime.configureTools).toEqual(expect.any(Function));
  });

  it("passes configured sandbox policy into runtime options", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const harness = createConfiguredAgentHarness({
      config: {
        ...monoConfig({ dir, identityPath, artifactDir }),
        sandbox: createSandboxPolicy({
          root: dir,
          network: { mode: "none" },
        }),
      },
      runtime: fake.runtime,
    });

    await harness.run({
      conversationId: "conversation-sandbox",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(fake.calls[0]?.options.sandboxPolicy).toMatchObject({
      mode: "native",
      fallback: "fail-closed",
      network: { mode: "none", allowlist: [] },
    });
  });

  it("forwards continuous session config so consecutive requests resume the provider session", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-host-1" }));

    const config = monoConfig({ dir, identityPath, artifactDir });
    const harness = createConfiguredAgentHarness({
      config: {
        ...config,
        runtime: { ...config.runtime, session: { mode: "continuous", idleTimeoutMs: 60_000 } },
      },
      runtime: fake.runtime,
    });

    await harness.run({ conversationId: "conv-session", userMessage: "first", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "conv-session", userMessage: "second", abortSignal: new AbortController().signal });

    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.sessionKeepAlive).toBe(true);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-host-1");
    expect(fake.calls[1]?.options.sessionKeepAlive).toBe(true);
  });

  it("never passes session keys in per-message mode", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-host-1" }));

    const harness = createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
    });

    await harness.run({ conversationId: "conv-per-message", userMessage: "first", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "conv-per-message", userMessage: "second", abortSignal: new AbortController().signal });

    for (const call of fake.calls) {
      expect(call.options.sessionId).toBeUndefined();
      expect(call.options.sessionKeepAlive).toBeUndefined();
    }
  });
});

function createFakeRuntime(run: (prompt: string, options: RuntimeRunOptions) => Promise<RuntimeResult>) {
  const calls: Array<{ prompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return await run(prompt, options);
      },
    },
  };
}

async function startEmbeddingServer(): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/embeddings") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { input?: unknown };
      const input = Array.isArray(parsed.input) ? parsed.input : [];
      const data = input.map(() => ({ embedding: Array.from({ length: 768 }, () => 0.01) }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Failed to start embeddings test server.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startFailingEmbeddingServer(onRequest: () => void): Promise<string> {
  const server = createServer((req, res) => {
    onRequest();
    req.resume();
    req.on("end", () => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "backend down" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Failed to start failing embeddings test server.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function monoConfig(input: {
  readonly dir: string;
  readonly identityPath: string;
  readonly memoryPath?: string;
  readonly memoryMode?: "lite" | "journal" | "bujo";
  readonly memoryWriteMode?: "disabled" | "append-host-summary" | "capture";
  readonly memoryEmbeddings?: {
    readonly provider: "ollama" | "openai";
    readonly model: string;
    readonly endpoint?: string;
    readonly apiKey?: string;
  };
  readonly memoryLlm?: NonNullable<MonoAgentConfig["memory"]>["llm"];
  readonly skillsRoot?: string;
  readonly selectedSkills?: readonly string[];
  readonly skillMaxBytes?: number;
  readonly artifactDir: string;
  readonly mcpConfigPath?: string;
  readonly permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  readonly reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on";
}): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "ollama", model: "qwen3:8b", reference: "pi:ollama:qwen3:8b" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: input.dir,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.reasoningSummary === undefined ? {} : { reasoningSummary: input.reasoningSummary }),
    },
    providers: {
      local: [
        {
          id: "ollama",
          type: "ollama",
          baseUrl: "http://localhost:11434",
          enabled: true,
          models: [{ name: "qwen3:8b", capabilities: { context_window: 32768 } }],
        },
      ],
    },
    context: {
      identityPath: input.identityPath,
      selectedSkills: input.selectedSkills ?? [],
      ...(input.skillsRoot === undefined ? {} : { skillsRoot: input.skillsRoot }),
      ...(input.skillMaxBytes === undefined ? {} : { skillMaxBytes: input.skillMaxBytes }),
    },
    ...(input.memoryPath === undefined
      ? {}
      : {
          memory: {
            mode: input.memoryMode ?? "lite",
            path: input.memoryPath,
            maxBytes: 64_000,
            writeMode: input.memoryWriteMode ?? "disabled",
            ...(input.memoryEmbeddings === undefined ? {} : { embeddings: input.memoryEmbeddings }),
            ...(input.memoryLlm === undefined ? {} : { llm: input.memoryLlm }),
          },
        }),
    tools: {
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
      ...(input.mcpConfigPath === undefined ? {} : { mcpConfigPath: input.mcpConfigPath }),
    },
    artifacts: {
      dir: input.artifactDir,
    },
    traceability: {
      registryDir: join(input.dir, "trace-sources"),
    },
  };
}
