import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import { journalDayFor } from "@mono-agent/memory-journal";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";
import { createSandboxPolicy } from "@mono-agent/sandbox";

import {
  createConfiguredAgentHarness,
  createConfiguredAgentResponder,
  createConfiguredAgentRuntime,
} from "../index.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent host composition helpers", () => {
  it("creates a responder from MonoAgentConfig with runtime, memory, tools, local providers, request extensions, and recording", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryPath = join(dir, "MEMORY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    await writeFile(memoryPath, "Remember: answer briefly.", "utf8");
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
      config: monoConfig({ dir, identityPath, memoryPath, artifactDir }),
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
    expect(fake.calls[0]?.prompt).toContain("Remember: answer briefly.");
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

  it("journals each turn into today's note (journal mode) and injects it on the next turn", async () => {
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
    });

    await responder.respond(
      { conversationId: "channel-a", text: "First message", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    // The completed turn is journaled into today's global daily note.
    const dailyPath = join(memoryRoot, "daily", `${journalDayFor(new Date())}.md`);
    const dailyContent = await readFile(dailyPath, "utf8");
    expect(dailyContent).toContain("Conversation: `channel-a`");
    expect(dailyContent).toContain("Logged answer");

    // A second turn (different conversation — one global brain) sees today's note in context.
    await responder.respond(
      { conversationId: "channel-b", text: "Second message", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[1]?.prompt).toContain("## Memory");
    expect(fake.calls[1]?.prompt).toContain("Logged answer");
  });

  it("folds the entity-graph digest into the always-in-context block (journal mode)", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryRoot = join(dir, "memory");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(
      join(memoryRoot, "graph.jsonl"),
      `${JSON.stringify({ type: "entity", name: "Example Person", entityType: "person", observations: ["prefers concise answers"] })}\n`,
      "utf8",
    );
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const responder = createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, memoryPath: memoryRoot, memoryMode: "journal", artifactDir }),
      runtime: fake.runtime,
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.prompt).toContain("Long-term memory (entity digest)");
    expect(fake.calls[0]?.prompt).toContain("Example Person (person)");
  });

  it("injects memory MCP recall tools when journal memory tools are enabled", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryRoot = join(dir, "memory");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const responder = createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        memoryPath: memoryRoot,
        memoryMode: "journal",
        memoryTools: { enabled: true, allowJournalAppend: false },
        artifactDir,
      }),
      runtime: fake.runtime,
    });
    await responder.respond(
      { conversationId: "c", text: "recall prior context", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.allowedTools).toEqual([
      "Read",
      "memory_read_day",
      "memory_list_days",
      "memory_grep",
      "memory_search",
      "entity_get",
    ]);
    expect(fake.calls[0]?.options.mcpServers).toMatchObject({
      memory: {
        command: "node",
        env: { MONO_AGENT_MEMORY_PATH: memoryRoot },
      },
    });
    const memoryServer = (fake.calls[0]?.options.mcpServers as Record<string, { readonly args?: readonly string[] }>).memory;
    expect(memoryServer?.args?.[0]).toMatch(/memory-mcp[/\\]dist[/\\]main\.js$/u);
  });

  it("allows journal_append only when memory tools permit manual notes", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryRoot = join(dir, "memory");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const responder = createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        memoryPath: memoryRoot,
        memoryMode: "journal",
        memoryTools: { enabled: true, allowJournalAppend: true },
        artifactDir,
      }),
      runtime: fake.runtime,
    });
    await responder.respond(
      { conversationId: "c", text: "remember this", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.allowedTools).toContain("journal_append");
    expect(fake.calls[0]?.options.allowedTools).not.toContain("entity_upsert");
    expect(fake.calls[0]?.options.allowedTools).not.toContain("memory_reindex");
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

function monoConfig(input: {
  readonly dir: string;
  readonly identityPath: string;
  readonly memoryPath?: string;
  readonly memoryMode?: "markdown" | "journal";
  readonly memoryWriteMode?: "disabled" | "append-host-summary";
  readonly memoryTools?: {
    readonly enabled: boolean;
    readonly allowJournalAppend: boolean;
  };
  readonly artifactDir: string;
}): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "ollama", model: "qwen3:8b", reference: "pi:ollama:qwen3:8b" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: input.dir,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
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
      selectedSkills: [],
    },
    ...(input.memoryPath === undefined
      ? {}
      : {
          memory: {
            mode: input.memoryMode ?? "markdown",
            path: input.memoryPath,
            maxBytes: 64_000,
            scope: "single-file",
            writeMode: input.memoryWriteMode ?? "disabled",
            ...(input.memoryTools === undefined ? {} : { tools: input.memoryTools }),
          },
        }),
    tools: {
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
    },
    artifacts: {
      dir: input.artifactDir,
    },
    traceability: {
      registryDir: join(input.dir, "trace-sources"),
    },
  } as unknown as MonoAgentConfig;
}
