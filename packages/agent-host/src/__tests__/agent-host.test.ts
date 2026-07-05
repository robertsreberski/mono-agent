import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExporter,
  RunSummary,
  RuntimeEventLike,
} from "@mono-agent/observability";
import type { RunEventFrame, RunEventSink } from "@mono-agent/agent-contracts";
import { createPhoenixRunExporter } from "@mono-agent/observability/otel";
import { createBujoMemoryStore } from "@mono-agent/memory/bujo";
import type { EmbeddingProvider } from "@mono-agent/memory/search";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";
import { createSandboxPolicy } from "@mono-agent/sandbox";
import type { SandboxEngine } from "@mono-agent/sandbox";

/** Deterministic non-zero fake embeddings (dim 64) — keeps journal/bujo-tier tests hermetic (no Ollama). */
const fakeEmbeddings: EmbeddingProvider = {
  id: "fake",
  embed: async (texts) => texts.map(() => Array.from({ length: 64 }, () => 0.01)),
};

const fakeSandboxEngine: SandboxEngine = {
  id: "fake-srt",
  async isAvailable() {
    return true;
  },
  async prepareCommand() {
    throw new Error("not used by host composition tests");
  },
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

    const responder = await createConfiguredAgentResponder({
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

  it("publishes run_started, event, and run_finished frames from the normal responder path", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async (_prompt, options) => {
      options.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "live event" }] } });
      return { text: "Final answer" };
    });
    const frames: RunEventFrame[] = [];
    const runEventSink: RunEventSink = {
      publish: (frame) => {
        frames.push(frame);
      },
    };

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      createRunId: () => "run-live-broadcast",
      observabilityContext: { sourceId: "src-1", sourceLabel: "Source One" },
      runEventSink,
    });

    await responder.respond(
      { conversationId: "conversation-live", text: "Broadcast this", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(frames[0]?.t).toBe("run_started");
    expect(frames.at(-1)?.t).toBe("run_finished");
    expect(frames[0]).toMatchObject({
      sourceId: "src-1",
      sourceLabel: "Source One",
      runId: "run-live-broadcast",
      conversationId: "conversation-live",
    });
    const eventFrames = frames.filter((frame) => frame.t === "event");
    expect(eventFrames.length).toBeGreaterThan(0);
    expect(eventFrames).toContainEqual(expect.objectContaining({ sourceId: "src-1", runId: "run-live-broadcast" }));
    expect(JSON.stringify(eventFrames)).toContain("live event");
    expect(frames.at(-1)).toMatchObject({ sourceId: "src-1", runId: "run-live-broadcast", status: "succeeded" });
  });

  it("forwards the request-derived source/sourceDetail into the recorded run summary", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Digest done" }));

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      createRunId: () => "run-cron",
    });

    await harness.run({
      conversationId: "conversation-cron",
      userMessage: "Run the nightly digest.",
      abortSignal: new AbortController().signal,
      metadata: { cron: { jobId: "nightly-digest" } },
    });

    const summary = await readSummary(artifactDir, "run-cron");
    expect(summary.source).toBe("cron");
    expect(summary.sourceDetail).toBe("nightly-digest");
  });

  it("records each turn into today's daily file (journal tier) and surfaces it on the next turn", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryRoot = join(dir, "memory");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Logged answer" }));

    const responder = await createConfiguredAgentResponder({
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
    // Recalled memory rides on the user message (not the system prompt) so it
    // survives session resume on every runtime.
    const recalledMessage = String(fake.calls[1]?.options.messages?.[0]?.content);
    expect(recalledMessage).toContain("## Memory (recalled)");
    expect(recalledMessage).toContain("Logged answer");
    expect(fake.calls[1]?.prompt).not.toContain("## Memory (recalled)");
  });

  it("runs agent-host memory LLM capture on its own runtime, never the channel runtime", async () => {
    // The memory LLM must NOT ride the channel runtime: that runtime carries the
    // channel fallback chain (primary = config.runtime.model) and the fallback
    // router overrides each run's per-call model, which would silently execute
    // memory capture on config.runtime.model instead of config.memory.llm.model.
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryRoot = join(dir, "memory");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    // Channel runtime — should only ever see the channel turn (ollama), never the
    // memory model (openai-codex).
    const channel = createFakeRuntime(async () => ({ text: "Harness answer" }));
    // Dedicated memory runtime (the injection seam the production path builds for
    // itself). Captures the memory LLM calls so we can assert their shape.
    const memoryRuntime = createFakeRuntime(async () => ({ text: "[]" }));

    const config = monoConfig({
      dir,
      identityPath,
      memoryPath: memoryRoot,
      memoryMode: "bujo",
      memoryWriteMode: "capture",
      memoryEmbeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "sk-test",
        endpoint: await startEmbeddingServer(),
      },
      memoryLlm: {
        provider: "agent-host",
        model: "pi:openai-codex:gpt-5.5",
        executionMode: "sdk",
      },
      artifactDir,
    });
    const memory = await createConfiguredMemory(config, { memoryRuntime: memoryRuntime.runtime });

    const responder = await createConfiguredAgentResponder({
      config,
      runtime: channel.runtime,
      ...(memory === undefined ? {} : { memory }),
    });

    const response = await responder.respond({
      conversationId: "channel-a",
      text: "Remember that memory capture must use its own runtime.",
      abortSignal: new AbortController().signal,
    }, { append: async () => {} });

    expect(response.text).toBe("Harness answer");
    for (let i = 0; i < 20 && memoryRuntime.calls.length < 2; i += 1) {
      await delay(5);
    }

    // The channel runtime served the channel turn only — the memory model never
    // leaked onto it.
    expect(channel.calls.every((call) => call.options.model.provider !== "openai-codex")).toBe(true);

    // The memory LLM ran on its own runtime, with the configured memory model and
    // the locked-down per-call shape.
    expect(memoryRuntime.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of memoryRuntime.calls) {
      expect(call.options.model).toMatchObject({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5" });
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

    const uncapped = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, skillsRoot, selectedSkills: ["big"], artifactDir }),
      runtime: fake.runtime,
    });
    await uncapped.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[0]?.prompt).toContain("SKILL_TAIL_MARKER");

    const capped = await createConfiguredAgentResponder({
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

    await expect(
      createConfiguredAgentHarness({
        config: monoConfig({ dir, identityPath, artifactDir, mcpConfigPath: join(dir, "missing.json") }),
        runtime: fake.runtime,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "tool_policy_read_failed" }));
  });

  it("forwards runtime.permissionMode to the runtime and never sets a reasoning-summary option", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        permissionMode: "bypassPermissions",
      }),
      runtime: fake.runtime,
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.permissionMode).toBe("bypassPermissions");
    // The retired reasoning-summary knob is gone: pi-native derives reasoning from
    // effort and the codex/claude CLIs emit summaries themselves.
    expect(fake.calls[0]?.options.piReasoningSummary).toBeUndefined();
  });

  it("forwards tools.mcpCall*TimeoutMs to the runtime as agent settings, omitting settings when unset", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const configured = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        mcpCallTimeoutMs: 60_000,
        mcpCallMaxTotalTimeoutMs: 900_000,
      }),
      runtime: fake.runtime,
    });
    await configured.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[0]?.options.settings).toMatchObject({
      agent_mcp_call_timeout_ms: 60_000,
      agent_mcp_call_max_total_timeout_ms: 900_000,
    });

    // Unset timeouts must not materialize a settings object — the runtime's own
    // defaults (120s inactivity / 45 min total) apply.
    const plain = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
    });
    await plain.respond(
      { conversationId: "c2", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[1]?.options.settings).toBeUndefined();
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

    const harness = await createConfiguredAgentHarness({
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
    const harness = await createConfiguredAgentHarness({
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

    const memory = await createConfiguredMemory({
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

    const responder = await createConfiguredAgentResponder({
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

    const harness = await createConfiguredAgentHarness({
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

    const harness = await createConfiguredAgentHarness({
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

    const harness = await createConfiguredAgentHarness({
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

    const harness = await createConfiguredAgentHarness({
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

    const harness = await createConfiguredAgentHarness({
      config: {
        ...monoConfig({ dir, identityPath, artifactDir }),
        sandbox: createSandboxPolicy({
          root: dir,
          network: { mode: "none" },
        }),
      },
      runtime: fake.runtime,
      sandboxEngine: fakeSandboxEngine,
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
    expect(fake.calls[0]?.options.sandboxEngine).toBe(fakeSandboxEngine);
  });

  it("forwards continuous session config so consecutive requests resume the provider session", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-host-1" }));

    const config = monoConfig({ dir, identityPath, artifactDir });
    const harness = await createConfiguredAgentHarness({
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

    const harness = await createConfiguredAgentHarness({
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

describe("agent host phoenix exporter wiring", () => {
  function phoenixObservability(
    overrides: Partial<PhoenixExporterConfig> = {},
  ): NonNullable<MonoAgentConfig["observability"]> {
    return {
      exporters: [
        {
          type: "phoenix",
          endpoint: "http://127.0.0.1:6006/v1/traces",
          ...overrides,
        },
      ],
    };
  }

  it("still produces a response and writes JSONL artifacts when the exporter throws in every phase", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Final answer" }));

    const failing: RunExporter = {
      start: () => { throw new Error("start boom"); },
      onEvent: () => { throw new Error("onEvent boom"); },
      finish: () => { throw new Error("finish boom"); },
      fail: () => { throw new Error("fail boom"); },
    };
    const warnings: Array<{ phase: string; message: string }> = [];

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, observability: phoenixObservability() }),
      runtime: fake.runtime,
      createRunId: () => "run-failing-exporter",
      exporterFactory: () => failing,
      exporterWarn: (warning) => { warnings.push(warning); },
    });

    const response = await responder.respond(
      { conversationId: "conv-exporter", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    // Run outcome is unchanged by the failing exporter.
    expect(response.text).toBe("Final answer");

    // JSONL artifacts are written byte-for-byte as without an exporter.
    const artifactFiles = await readdir(artifactDir);
    expect(artifactFiles).toContain("run-failing-exporter.summary.json");
    expect(artifactFiles).toContain("run-failing-exporter.events.jsonl");
    expect(await readFile(join(artifactDir, "run-failing-exporter.summary.json"), "utf8")).toContain(
      "run-failing-exporter",
    );

    // Exporter failures surface only as best-effort warnings.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.map((w) => w.message).join(" ")).toContain("boom");
  });

  it("a hanging exporter resolves within the bounded timeout and warns instead of stalling the run", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Final answer" }));

    // start/finish never resolve — the composite's bounded timeout must win.
    const hanging: RunExporter = {
      start: () => new Promise<void>(() => {}),
      finish: () => new Promise<void>(() => {}),
    };
    const warnings: Array<{ phase: string; message: string }> = [];

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, observability: phoenixObservability({ timeoutMs: 25 }) }),
      runtime: fake.runtime,
      createRunId: () => "run-hanging-exporter",
      exporterFactory: () => hanging,
      exporterWarn: (warning) => { warnings.push(warning); },
    });

    const started = Date.now();
    const response = await responder.respond(
      { conversationId: "conv-hang", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    const elapsed = Date.now() - started;

    expect(response.text).toBe("Final answer");
    // The bounded timeout (25ms) keeps the run from hanging; allow generous slack.
    expect(elapsed).toBeLessThan(5_000);
    expect(warnings.some((w) => /timed out/u.test(w.message))).toBe(true);

    const artifactFiles = await readdir(artifactDir);
    expect(artifactFiles).toContain("run-hanging-exporter.summary.json");
  });

  it("does not delay startup when exporter.start hangs (harness awaits recorder.start once)", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const hangingStart: RunExporter = {
      start: () => new Promise<void>(() => {}),
    };
    const warnings: Array<{ phase: string; message: string }> = [];

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir, observability: phoenixObservability({ timeoutMs: 25 }) }),
      runtime: fake.runtime,
      createRunId: () => "run-hang-start",
      exporterFactory: () => hangingStart,
      exporterWarn: (warning) => { warnings.push(warning); },
    });

    const started = Date.now();
    const response = await harness.run({ conversationId: "conv-hang-start", userMessage: "hi", abortSignal: new AbortController().signal });
    const elapsed = Date.now() - started;

    expect(response.text).toBe("ok");
    expect(elapsed).toBeLessThan(5_000);
    expect(warnings.some((w) => w.phase === "start" && /timed out/u.test(w.message))).toBe(true);
  });

  it("still exports best-effort AND writes JSONL when a run is cancelled", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const finishCalls: RunSummary[] = [];
    const exporter: RunExporter = {
      finish: (summary) => { finishCalls.push(summary); },
    };

    const controller = new AbortController();
    controller.abort();

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir, observability: phoenixObservability() }),
      runtime: fake.runtime,
      createRunId: () => "run-cancelled",
      exporterFactory: () => exporter,
    });

    const response = await harness.run({ conversationId: "conv-cancelled", userMessage: "hi", abortSignal: controller.signal });

    // Cancelled runs surface as a failure but the runtime is never invoked.
    expect(response.failure?.kind).toBe("cancelled");
    expect(fake.calls).toHaveLength(0);

    // JSONL artifacts are written even for the cancelled path.
    const artifactFiles = await readdir(artifactDir);
    expect(artifactFiles).toContain("run-cancelled.summary.json");

    // The cancelled summary was exported best-effort.
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.status).toBe("cancelled");
  });

  it("omits raw prompt and tool payloads from the exported body in metadata-only mode (default)", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const secret = "SUPER_SECRET_PROMPT_PAYLOAD";
    const toolSecret = "TOOL_INPUT_SECRET_VALUE";

    const fake = createFakeRuntime(async (_prompt, options) => {
      options.onEvent?.({
        type: "tool_use",
        name: "Read",
        input: { path: "/etc/passwd", note: toolSecret },
      } as RuntimeEventLike);
      return { text: "ok" };
    });

    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      // The body is a binary OTLP protobuf; attribute keys/values are UTF-8, so
      // decode the bytes to assert presence/absence of readable strings.
      bodies.push(init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : "");
      return new Response(null, { status: 200 });
    };

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        // includeSensitiveData omitted -> defaults to false (metadata-only).
        observability: phoenixObservability(),
      }),
      runtime: fake.runtime,
      createRunId: () => "run-metadata-only",
      exporterFactory: (cfg) => realPhoenixExporter(cfg, { fetch: fetchImpl }),
    });

    await responder.respond(
      { conversationId: "conv-meta", text: secret, abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(bodies.length).toBeGreaterThan(0);
    const exported = bodies.join("\n");
    expect(exported).not.toContain(secret);
    expect(exported).not.toContain(toolSecret);
    expect(exported).not.toContain("/etc/passwd");
    // Identifiers are still exported.
    expect(exported).toContain("run-metadata-only");
  });

  it("does NOT construct an exporter when config.observability.exporters is empty", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    let factoryCalls = 0;

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, observability: { exporters: [] } }),
      runtime: fake.runtime,
      createRunId: () => "run-no-exporter",
      exporterFactory: () => { factoryCalls += 1; return {}; },
    });

    const response = await responder.respond(
      { conversationId: "conv-empty", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(response.text).toBe("ok");
    expect(factoryCalls).toBe(0);

    // JSONL is still written via the plain recorder.
    const artifactFiles = await readdir(artifactDir);
    expect(artifactFiles).toContain("run-no-exporter.summary.json");
  });

  it("threads source_id/source_label/config_path from observabilityContext onto root span attributes", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      // The body is a binary OTLP protobuf; attribute keys/values are UTF-8, so
      // decode the bytes to assert presence/absence of readable strings.
      bodies.push(init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : "");
      return new Response(null, { status: 200 });
    };

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, observability: phoenixObservability() }),
      runtime: fake.runtime,
      createRunId: () => "run-ctx",
      observabilityContext: {
        sourceId: "src-123",
        sourceLabel: "Local Agent Alpha",
        configPath: "/home/me/mono-agent.config.json",
      },
      exporterFactory: (cfg) => realPhoenixExporter(cfg, { fetch: fetchImpl }),
    });

    await responder.respond(
      { conversationId: "conv-ctx", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(bodies.length).toBeGreaterThan(0);
    const exported = bodies.join("\n");
    expect(exported).toContain("mono.agent.source_id");
    expect(exported).toContain("src-123");
    expect(exported).toContain("mono.agent.source_label");
    expect(exported).toContain("Local Agent Alpha");
    expect(exported).toContain("mono.agent.config_path");
    expect(exported).toContain("/home/me/mono-agent.config.json");
  });
});

function realPhoenixExporter(
  config: PhoenixExporterConfig,
  deps: { fetch: typeof fetch },
): RunExporter {
  return createPhoenixRunExporter(config, { fetch: deps.fetch });
}

/** Reads the JSONL recorder's `<runId>.summary.json` artifact for a given run. */
async function readSummary(artifactDir: string, runId: string): Promise<RunSummary> {
  const files = await readdir(artifactDir);
  const summaryFile = files.find((file) => file.startsWith(runId) && file.endsWith(".summary.json"));
  if (summaryFile === undefined) {
    throw new Error(`No summary artifact found for runId ${runId} in ${artifactDir}`);
  }
  return JSON.parse(await readFile(join(artifactDir, summaryFile), "utf8")) as RunSummary;
}

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
  readonly mcpCallTimeoutMs?: number;
  readonly mcpCallMaxTotalTimeoutMs?: number;
  readonly permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  readonly observability?: NonNullable<MonoAgentConfig["observability"]>;
}): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "ollama", model: "qwen3:8b", reference: "pi:ollama:qwen3:8b" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: input.dir,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
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
      ...(input.mcpCallTimeoutMs === undefined ? {} : { mcpCallTimeoutMs: input.mcpCallTimeoutMs }),
      ...(input.mcpCallMaxTotalTimeoutMs === undefined ? {} : { mcpCallMaxTotalTimeoutMs: input.mcpCallMaxTotalTimeoutMs }),
    },
    artifacts: {
      dir: input.artifactDir,
      retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false },
    },
    traceability: {
      registryDir: join(input.dir, "trace-sources"),
    },
    ...(input.observability === undefined ? {} : { observability: input.observability }),
  };
}
