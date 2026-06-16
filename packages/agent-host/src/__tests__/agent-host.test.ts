import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
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

  it("forwards runtime.permissionMode and runtime.reasoningSummary to the runtime", async () => {
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
    expect(fake.calls[0]?.options.piReasoningSummary).toBe("detailed");
  });

  it("lets host runtimeOptions override config runtime flags", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const responder = createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, reasoningSummary: "detailed" }),
      runtime: fake.runtime,
      runtimeOptions: { piReasoningSummary: "concise" },
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.piReasoningSummary).toBe("concise");
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

function monoConfig(input: {
  readonly dir: string;
  readonly identityPath: string;
  readonly memoryPath?: string;
  readonly memoryMode?: "lite" | "journal" | "bujo";
  readonly memoryWriteMode?: "disabled" | "append-host-summary";
  readonly memoryEmbeddings?: {
    readonly provider: "ollama" | "openai";
    readonly model: string;
    readonly endpoint?: string;
    readonly apiKey?: string;
  };
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
            scope: "single-file",
            writeMode: input.memoryWriteMode ?? "disabled",
            ...(input.memoryEmbeddings === undefined ? {} : { embeddings: input.memoryEmbeddings }),
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
  } as unknown as MonoAgentConfig;
}
