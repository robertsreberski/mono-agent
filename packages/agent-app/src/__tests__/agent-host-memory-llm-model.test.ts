/**
 * Regression for the bug where the bujo memory LLM executed on the CHANNEL
 * runtime model instead of `config.memory.llm.model`.
 *
 * Root cause: createConfiguredMemory reused the channel runtime — which carries
 * the channel fallback chain (primary = config.runtime.model) — for the memory
 * LLM. The agent-runtime fallback router overrides each run's per-call `model`
 * with the chain's primary entry, so memory capture silently ran on
 * config.runtime.model. The fix gives the memory LLM its OWN fallback-free
 * runtime so the per-call memory model is the sole/effective primary.
 *
 * The runtime-adapter is mocked at module scope (mirrors agent-host-fallback /
 * agent-host-runtime-auth) so we can observe the OPTIONS createMonoRuntime is
 * built with AND capture the `model` reaching each `runtime.run`.
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import { createSandboxPolicy, type RuntimeRunOptions } from "@mono-agent/runtime-adapter";

const runCalls: Array<{ systemPrompt: string; options: RuntimeRunOptions }> = [];
const fakeRuntime = {
  async run(systemPrompt: string, options: RuntimeRunOptions) {
    runCalls.push({ systemPrompt, options });
    // Empty JSON extraction so capture short-circuits without further work.
    return { text: "[]" };
  },
};
const createMonoRuntimeMock = vi.fn((_options: unknown) => fakeRuntime);
const createSrtSandboxEngineMock = vi.fn(() => ({
  id: "unexpected-srt",
  isAvailable: async () => true,
  prepareCommand: async (command: unknown) => command,
}));
const coordinatorHome = vi.hoisted(() => ({ path: "" }));

vi.mock("@mono-agent/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/runtime-adapter")>();
  return {
    ...actual,
    createMonoRuntime: (options: unknown) => createMonoRuntimeMock(options),
    createSrtSandboxEngine: (..._args: unknown[]) => createSrtSandboxEngineMock(),
  };
});
vi.mock("../account-home.js", () => ({
  accountHomeDirectory: () => coordinatorHome.path,
}));
vi.mock("../process-incarnation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../process-incarnation.js")>(),
  currentProcessIncarnation: async () => ({
    schema: "mono-agent.process-incarnation.v1" as const,
    bootSessionId: "test-boot",
    processStartId: "vitest-agent-host-memory-model",
  }),
  isSameProcessIncarnation: () => true,
}));

const { createConfiguredMemory } = await import("../index.js");
const { createConfiguredMemoryForApp } = await import("../configured-agent.js");
const {
  acquireAgentRootOwnership,
  releaseAgentRootOwnershipWhenIdle,
} = await import("../agent-root-coordinator.js");
const {
  loadProcessJobsRootRegistryProtection,
  registerProcessJobsRoot,
} = await import("../process-jobs-root-registry.js");
const { resolveProcessJobsProtectionPosture } = await import("../process-jobs-protection.js");

const tempDirs: string[] = [];
beforeAll(async () => {
  coordinatorHome.path = await mkdtemp(join(tmpdir(), "agent-host-memory-model-coordinator-home-"));
});
afterAll(async () => {
  await vi.waitFor(async () => {
    expect(await readdir(join(coordinatorHome.path, ".mono-agent", "agent-root-leases"))).toEqual([]);
  }, { timeout: 2_000, interval: 10 });
  await rm(coordinatorHome.path, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-memory-model-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  runCalls.length = 0;
  createMonoRuntimeMock.mockClear();
  createSrtSandboxEngineMock.mockClear();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const RUNTIME_MODEL = { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" } as const;
const FALLBACK_MODEL = { provider: "opencode-go", model: "kimi-k2.6", reference: "opencode-go:kimi-k2.6" } as const;
const MEMORY_MODEL_REF = "opencode-go:deepseek-v4-pro";

describe("memory LLM honours config.memory.llm.model", () => {
  it("runs the memory LLM on config.memory.llm.model even when runtime.model differs and fallbackModels is non-empty", async () => {
    const dir = await tempDir();

    const store = await createConfiguredMemory(memoryModelConfig(dir), {}) as unknown as {
      capture(conversationId: string, text: string): Promise<unknown>;
      close(): Promise<void>;
    };

    await store.capture("conv-1", "Morgan prefers the configured memory model.");
    await store.close();

    // The memory LLM must have actually run.
    expect(runCalls.length).toBeGreaterThanOrEqual(1);

    // Every memory run targets the configured memory model — NOT the runtime
    // model and NOT the fallback model. This is the core regression assertion.
    for (const call of runCalls) {
      expect(call.options.model).toMatchObject({ provider: "opencode-go", model: "deepseek-v4-pro" });
      expect(call.options.model).not.toMatchObject({ provider: "openai-codex", model: "gpt-5.5" });
    }

    // The memory LLM's runtime was built WITHOUT a fallback chain, so the
    // per-call memory model is the sole/effective primary (a fallback chain would
    // let the router override `model` with the channel primary again).
    const memoryRuntimeOptions = createMonoRuntimeMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(memoryRuntimeOptions.length).toBeGreaterThanOrEqual(1);
    for (const options of memoryRuntimeOptions) {
      expect(options.fallbackChain).toBeUndefined();
    }
  });

  it("keeps Pi agent-host memory tool-less and SRT-free under validated unsafe app authority", async () => {
    const lexicalDir = await tempDir();
    const ownership = await acquireAgentRootOwnership(lexicalDir);
    const dir = ownership.agentRoot;
    const workspace = join(dir, "workspace");
    await mkdir(workspace, { recursive: true });
    const config = memoryModelConfig(dir, workspace, true);
    const loaded = await loadProcessJobsRootRegistryProtection(dir, workspace);
    ownership.coordinator.synchronizeGeneration(loaded.generation);
    const registration = await registerProcessJobsRoot({
      agentRoot: ownership.agentRoot,
      workspace,
      stateDir: join(dir, ".state", "process-jobs"),
      coordinator: ownership.coordinator,
    });
    const posture = resolveProcessJobsProtectionPosture({
      settings: { enabled: true, unsafeAllowUnprotectedState: true },
      registry: registration.snapshot,
      coreConfig: config,
    });
    await releaseAgentRootOwnershipWhenIdle(ownership);
    const store = await createConfiguredMemoryForApp(config, { cwd: dir }, posture) as unknown as {
      capture(conversationId: string, text: string): Promise<unknown>;
      close(): Promise<void>;
    };

    await store.capture("conv-unsafe", "Keep trusted host memory direct.");
    await store.close();

    expect(createSrtSandboxEngineMock).not.toHaveBeenCalled();
    expect(runCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of runCalls) {
      expect(call.options.model.provider).toBe("opencode-go");
      expect(call.options.sandboxEngine).toBeUndefined();
      expect(call.options.sandboxPolicy?.protectedRoots ?? []).toHaveLength(0);
      expect(call.options.allowedTools).toEqual([]);
      expect(call.options.mcpServers).toEqual({});
    }
  });
});

function memoryModelConfig(
  dir: string,
  workspace = dir,
  unsafe = false,
): MonoAgentConfig {
  return {
    runtime: {
      model: { ...RUNTIME_MODEL },
      fallbacks: [{ model: { ...FALLBACK_MODEL } }],
      maxTurns: 4,
      workspace,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
    },
    context: { identityPath: join(dir, "IDENTITY.md"), selectedSkills: [] },
    memory: {
      mode: "bujo",
      path: join(dir, "bujo-memory"),
      writeMode: "disabled",
      maxBytes: 8_000,
      embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      llm: { provider: "agent-host", model: MEMORY_MODEL_REF },
    },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: {
      dir: join(dir, "artifacts"),
      retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false },
    },
    traceability: { registryDir: join(dir, "trace-sources") },
    ...(unsafe
      ? { sandbox: createSandboxPolicy({ mode: "off", root: workspace }) }
      : {}),
  };
}
