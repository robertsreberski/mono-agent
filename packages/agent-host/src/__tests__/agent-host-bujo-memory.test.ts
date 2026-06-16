/**
 * Verifies createConfiguredMemory wires memory.mode "bujo" to a BujoMemoryStore
 * (and NOT the markdown fallback). Hermetic: the host-branch test only constructs
 * the harness (no embedding/network at construction); the direct-store tests inject
 * a fake embeddings provider so no Ollama call is made.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "@mono-agent/memory-search";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import type { RuntimeRunOptions } from "@mono-agent/runtime-adapter";

import { createConfiguredAgentHarness, createConfiguredMemory } from "../index.js";

/** Deterministic non-zero fake embeddings — no network. */
const fakeEmbeddings: EmbeddingProvider = {
  id: "fake",
  embed: async (texts) => texts.map(() => Array.from({ length: 768 }, () => 0.01)),
};

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-bujo-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createConfiguredMemory — bujo mode", () => {
  it("constructs a harness for mode: bujo without throwing (exercises the bujo branch)", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");

    const fakeRuntime = { async run() { return { text: "ok" }; } };
    const harness = createConfiguredAgentHarness({
      config: bujoConfig({ dir, identityPath, memoryRoot: join(dir, "bujo-memory") }),
      runtime: fakeRuntime as never,
    });
    expect(harness).toBeDefined();
    expect(typeof harness.run).toBe("function");
  });

  it("BujoMemoryStore.appendHostSummary writes into <root>/daily/ (proves bujo, not markdown)", async () => {
    const dir = await tempDir();
    const memoryRoot = join(dir, "bujo-memory");
    const store = createBujoMemoryStore({ root: memoryRoot, embeddings: fakeEmbeddings, dim: 768 });
    await store.appendHostSummary("conv-1", "A summary of this turn.");
    await store.close();

    const files = await readdir(join(memoryRoot, "daily"));
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/u);
  });

  it("BujoMemoryStore exposes load, appendHostSummary, and capture (full contract)", async () => {
    const dir = await tempDir();

    const bujoStore = createBujoMemoryStore({ root: join(dir, "bujo-memory"), embeddings: fakeEmbeddings, dim: 768 });

    expect(typeof bujoStore.load).toBe("function");
    expect(typeof bujoStore.appendHostSummary).toBe("function");
    expect(typeof bujoStore.capture).toBe("function");
    await bujoStore.close();
  });

  it("lite-tier BujoMemoryStore (no embeddings) exposes the same contract, capture returns undefined", async () => {
    const dir = await tempDir();

    // lite tier: no embeddings — FTS only
    const liteStore = createBujoMemoryStore({ root: join(dir, "lite-memory") });

    expect(typeof liteStore.load).toBe("function");
    expect(typeof liteStore.appendHostSummary).toBe("function");
    // capture with no LLM returns undefined (not throws)
    const result = await liteStore.capture("conv-1", "summary text");
    expect(result).toBeUndefined();
    await liteStore.close();
  });

  it("keeps bujo tier when memory.llm uses an agent-host runtime model", async () => {
    const dir = await tempDir();
    const runtime = createRecordingRuntime();
    const store = createConfiguredMemory(
      bujoConfig({
        dir,
        identityPath: join(dir, "IDENTITY.md"),
        memoryRoot: join(dir, "agent-host-memory"),
        llm: {
          provider: "agent-host",
          model: "pi:openai-codex:gpt-5.5",
          executionMode: "sdk",
        },
      }),
      { runtime },
    );

    expect(store).toBeDefined();
    expect((store as unknown as { tier(): string }).tier()).toBe("bujo");
    await (store as unknown as { close(): Promise<void> }).close();
  });

  it("runs agent-host memory LLM calls without tools or MCP servers", async () => {
    const dir = await tempDir();
    const runtime = createRecordingRuntime();
    const store = createConfiguredMemory(
      bujoConfig({
        dir,
        identityPath: join(dir, "IDENTITY.md"),
        memoryRoot: join(dir, "agent-host-memory"),
        llm: {
          provider: "agent-host",
          model: "pi:openai-codex:gpt-5.5",
          executionMode: "sdk",
        },
      }),
      { runtime },
    );

    const result = await (store as unknown as { capture(conversationId: string, text: string): Promise<unknown> })
      .capture("conv-1", "Robert prefers agent-host memory LLM calls.");

    expect(result).toEqual({ actions: 0, entities: 0 });
    expect(runtime.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of runtime.calls) {
      expect(call.systemPrompt).toMatch(/private memory maintenance LLM/u);
      expect(call.options.model).toMatchObject({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5" });
      expect(call.options.executionMode).toBe("sdk");
      expect(call.options.cwd).toBe(dir);
      expect(call.options.maxTurns).toBe(1);
      expect(call.options.allowedTools).toEqual([]);
      expect(call.options.disallowedTools).toEqual([]);
      expect(call.options.mcpServers).toEqual({});
    }
    await (store as unknown as { close(): Promise<void> }).close();
  });

  it("rejects CLI-backed agent-host memory LLM configs", async () => {
    const dir = await tempDir();
    expect(() =>
      createConfiguredMemory(
        bujoConfig({
          dir,
          identityPath: join(dir, "IDENTITY.md"),
          memoryRoot: join(dir, "agent-host-memory"),
          llm: {
            provider: "agent-host",
            model: "codex:gpt-5.5",
          },
        }),
        { runtime: createRecordingRuntime() },
      ),
    ).toThrow(/SDK execution mode only/u);
  });
});

function bujoConfig(input: {
  readonly dir: string;
  readonly identityPath: string;
  readonly memoryRoot: string;
  readonly llm?: NonNullable<MonoAgentConfig["memory"]>["llm"];
}): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "ollama", model: "qwen3:8b", reference: "pi:ollama:qwen3:8b" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: input.dir,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
    },
    context: { identityPath: input.identityPath, selectedSkills: [] },
    memory: {
      mode: "bujo",
      path: input.memoryRoot,
      writeMode: "disabled",
      maxBytes: 8_000,
      embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      ...(input.llm === undefined ? {} : { llm: input.llm }),
    },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(input.dir, "artifacts") },
    traceability: { registryDir: join(input.dir, "trace-sources") },
  };
}

function createRecordingRuntime() {
  const calls: Array<{ systemPrompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    async run(systemPrompt: string, options: RuntimeRunOptions) {
      calls.push({ systemPrompt, options });
      return { text: "[]" };
    },
  };
}
