import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import { createSandboxPolicy } from "@mono-agent/runtime-adapter";

const memoryState = vi.hoisted(() => ({
  complete: vi.fn(async () => "[]"),
  embed: vi.fn(async () => [[0]]),
}));
const processIdentity = vi.hoisted(() => ({
  current: {
    schema: "mono-agent.process-incarnation.v1" as const,
    bootSessionId: "test-boot",
    processStartId: "vitest-configured-memory",
  },
}));

vi.mock("@mono-agent/memory/search", () => ({
  createEmbeddingProvider: () => ({ id: "test:embedding", embed: memoryState.embed }),
  createCircuitBreakerEmbeddingProvider: (provider: unknown) => provider,
}));

vi.mock("@mono-agent/memory/bujo", () => ({
  createOllamaLlm: () => ({ complete: memoryState.complete }),
  createBujoMemoryStore: (options: {
    readonly embeddings: { embed(texts: readonly string[]): Promise<number[][]> };
    readonly llm: { complete(prompt: string): Promise<string> };
  }) => ({
    capture: async () => await options.llm.complete("capture memory"),
    recall: async () => await options.embeddings.embed(["recall memory"]),
    close: async () => undefined,
  }),
}));

vi.mock("../process-incarnation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../process-incarnation.js")>(),
  currentProcessIncarnation: async () => processIdentity.current,
  isSameProcessIncarnation: () => true,
}));

const { createConfiguredMemory } = await import("../index.js");
const { createConfiguredMemoryForApp } = await import("../configured-agent.js");
const { resolveProcessJobsProtectionPosture } = await import("../process-jobs-protection.js");
const {
  acquireAgentRootOwnership,
  agentRootLeasePath,
} = await import("../agent-root-coordinator.js");
const {
  loadProcessJobsRootRegistryProtection,
  registerProcessJobsRoot,
} = await import("../process-jobs-root-registry.js");

const temporaryDirectories: string[] = [];
const ownerships: Array<{
  ownership: Awaited<ReturnType<typeof acquireAgentRootOwnership>>;
  leasePath: string;
}> = [];

afterEach(async () => {
  const held = ownerships.splice(0);
  for (const { ownership } of held) ownership.release();
  await Promise.all(held.map(async ({ leasePath }) => {
    await vi.waitFor(async () => {
      await expect(lstat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    }, { timeout: 2_000, interval: 10 });
  }));
  // mockReset, not mockClear: a queued mockImplementationOnce that its own test
  // never consumed would otherwise leak into the next test as a never-settling
  // embed. Reset restores the base implementation given to vi.fn.
  memoryState.complete.mockReset();
  memoryState.embed.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe("direct configured memory provider protection", () => {
  it("allows direct non-Pi LLM and embedding providers while the registry is empty", async () => {
    const fixture = await memoryFixture("empty");
    const ownership = await seedRegistry(fixture);
    const store = await createConfiguredMemory(memoryConfig(fixture), { cwd: fixture.root }) as unknown as {
      capture(): Promise<unknown>;
      recall(): Promise<unknown>;
      close(): Promise<void>;
    };

    await expect(store.capture()).resolves.toBe("[]");
    await expect(store.recall()).resolves.toEqual([[0]]);
    expect(memoryState.complete).toHaveBeenCalledOnce();
    expect(memoryState.embed).toHaveBeenCalledOnce();
    await store.close();
    ownership.release();
  });

  // Regression for #664. These providers used to be rejected outright once any
  // private root was retained, which made `processJobs.enabled` mutually
  // exclusive with the bujo/journal memory tiers that REQUIRE an embedding
  // provider — recall and completed-turn capture failed on every single turn.
  it("allows direct tool-less LLM and embedding providers while a private root is retained", async () => {
    const fixture = await memoryFixture("sealed");
    const ownership = await seedRegistry(fixture, join(fixture.root, ".state", "jobs"));
    const store = await createConfiguredMemory(memoryConfig(fixture), { cwd: fixture.root }) as unknown as {
      capture(): Promise<unknown>;
      recall(): Promise<unknown>;
      close(): Promise<void>;
    };

    await expect(store.capture()).resolves.toBe("[]");
    await expect(store.recall()).resolves.toEqual([[0]]);
    expect(memoryState.complete).toHaveBeenCalledOnce();
    expect(memoryState.embed).toHaveBeenCalledOnce();
    await store.close();
    ownership.release();
  });

  it("allows direct tool-less LLM and embedding providers under the safe srt-protected posture", async () => {
    const fixture = await memoryFixture("srt-protected");
    const ownership = await seedRegistry(fixture, join(fixture.root, ".state", "jobs"));
    const config = memoryConfig(fixture);
    const registry = await loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace);
    const posture = resolveProcessJobsProtectionPosture({
      settings: { enabled: true, unsafeAllowUnprotectedState: false },
      registry,
      coreConfig: config,
    });
    expect(posture.kind).toBe("srt-protected");
    expect(posture.suppressSyntheticSandbox).toBe(false);
    const store = await createConfiguredMemoryForApp(config, { cwd: fixture.root }, posture) as unknown as {
      capture(): Promise<unknown>;
      recall(): Promise<unknown>;
      close(): Promise<void>;
    };

    await expect(store.capture()).resolves.toBe("[]");
    await expect(store.recall()).resolves.toEqual([[0]]);
    expect(memoryState.complete).toHaveBeenCalledOnce();
    expect(memoryState.embed).toHaveBeenCalledOnce();
    await store.close();
    ownership.release();
  });

  it("retains cooperative root ownership across a permitted embedding call while a private root is retained", async () => {
    const fixture = await memoryFixture("srt-protected-settlement");
    const ownership = await seedRegistry(fixture, join(fixture.root, ".state", "jobs"));
    const config = memoryConfig(fixture);
    const registry = await loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace);
    const posture = resolveProcessJobsProtectionPosture({
      settings: { enabled: true, unsafeAllowUnprotectedState: false },
      registry,
      coreConfig: config,
    });
    const leasePath = agentRootLeasePath(ownership.agentRoot, fixture.home);
    let settleEmbedding: ((value: number[][]) => void) | undefined;
    memoryState.embed.mockImplementationOnce(async () => await new Promise<number[][]>((resolve) => {
      settleEmbedding = resolve;
    }));
    const store = await createConfiguredMemoryForApp(config, { cwd: fixture.root }, posture) as unknown as {
      recall(): Promise<unknown>;
      close(): Promise<void>;
    };

    const pendingRecall = store.recall();
    await vi.waitFor(() => expect(memoryState.embed).toHaveBeenCalledOnce());
    ownership.release();
    await expect(lstat(leasePath)).resolves.toBeDefined();

    settleEmbedding?.([[3]]);
    await expect(pendingRecall).resolves.toEqual([[3]]);
    await vi.waitFor(async () => {
      await expect(lstat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    }, { timeout: 2_000, interval: 10 });
    await store.close();
  });

  it("retains settlement ownership for direct tool-less providers under the unsafe posture", async () => {
    const fixture = await memoryFixture("unsafe-retained");
    const ownership = await seedRegistry(fixture, join(fixture.root, ".state", "jobs"));
    const config = memoryConfig(fixture, true);
    const registry = await loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace);
    const posture = resolveProcessJobsProtectionPosture({
      settings: { enabled: true, unsafeAllowUnprotectedState: true },
      registry,
      coreConfig: config,
    });
    const leasePath = agentRootLeasePath(ownership.agentRoot, fixture.home);
    let settleEmbedding: ((value: number[][]) => void) | undefined;
    memoryState.embed.mockImplementationOnce(async () => await new Promise<number[][]>((resolve) => {
      settleEmbedding = resolve;
    }));
    const store = await createConfiguredMemoryForApp(
      config,
      { cwd: fixture.root },
      posture,
    ) as unknown as {
      capture(): Promise<unknown>;
      recall(): Promise<unknown>;
      close(): Promise<void>;
    };

    await expect(store.capture()).resolves.toBe("[]");
    expect(memoryState.complete).toHaveBeenCalledOnce();
    const pendingRecall = store.recall();
    await vi.waitFor(() => expect(memoryState.embed).toHaveBeenCalledOnce());
    ownership.release();
    await expect(lstat(leasePath)).resolves.toBeDefined();

    settleEmbedding?.([[2]]);
    await expect(pendingRecall).resolves.toEqual([[2]]);
    await vi.waitFor(async () => {
      await expect(lstat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    }, { timeout: 2_000, interval: 10 });
    await store.close();
  });

  it("retains cooperative root ownership until an out-of-harness embedding provider truly settles", async () => {
    const fixture = await memoryFixture("embedding-settlement");
    const ownership = await seedRegistry(fixture);
    const leasePath = agentRootLeasePath(ownership.agentRoot, fixture.home);
    let settleEmbedding: ((value: number[][]) => void) | undefined;
    memoryState.embed.mockImplementationOnce(async () => await new Promise<number[][]>((resolve) => {
      settleEmbedding = resolve;
    }));
    const store = await createConfiguredMemory(memoryConfig(fixture), { cwd: fixture.root }) as unknown as {
      recall(): Promise<unknown>;
      close(): Promise<void>;
    };

    const pendingRecall = store.recall();
    await vi.waitFor(() => expect(memoryState.embed).toHaveBeenCalledOnce());
    ownership.release();
    await expect(lstat(leasePath)).resolves.toBeDefined();

    settleEmbedding?.([[1]]);
    await expect(pendingRecall).resolves.toEqual([[1]]);
    await vi.waitFor(async () => {
      await expect(lstat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    }, { timeout: 2_000, interval: 10 });
    await store.close();
  });
});

async function memoryFixture(label: string): Promise<{
  root: string;
  workspace: string;
  home: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), `mono-agent-configured-memory-${label}-`));
  temporaryDirectories.push(parent);
  const lexicalRoot = join(parent, "agent");
  const lexicalWorkspace = join(lexicalRoot, "workspace");
  const home = join(parent, "home");
  await Promise.all([
    mkdir(lexicalWorkspace, { recursive: true, mode: 0o700 }),
    mkdir(home, { mode: 0o700 }),
  ]);
  return {
    root: await realpath(lexicalRoot),
    workspace: await realpath(lexicalWorkspace),
    home,
  };
}

async function seedRegistry(
  fixture: { root: string; workspace: string; home: string },
  stateDir?: string,
) {
  const ownership = await acquireAgentRootOwnership(fixture.root, { homeDir: fixture.home });
  ownerships.push({
    ownership,
    leasePath: agentRootLeasePath(ownership.agentRoot, fixture.home),
  });
  const empty = await loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace);
  ownership.coordinator.synchronizeGeneration(empty.generation);
  if (stateDir !== undefined) {
    await registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir,
      coordinator: ownership.coordinator,
    });
  }
  return ownership;
}

function memoryConfig(
  fixture: { root: string; workspace: string },
  unsafe = false,
): MonoAgentConfig {
  return {
    runtime: {
      model: {
        sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol",
        reference: "pi:openai-codex:gpt-5.6-sol",
      },
      executionMode: "sdk",
      workspace: fixture.workspace,
      session: { mode: "continuous", idleTimeoutMs: 1_800_000 },
    },
    context: { identityPath: join(fixture.root, "IDENTITY.md"), selectedSkills: [] },
    memory: {
      mode: "bujo",
      path: join(fixture.root, "memory"),
      writeMode: "disabled",
      embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      llm: { provider: "ollama", model: "qwen3:8b" },
    },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(fixture.root, "artifacts") },
    traceability: { registryDir: join(fixture.root, "trace") },
    ...(unsafe
      ? { sandbox: createSandboxPolicy({ mode: "off", root: fixture.workspace }) }
      : {}),
  } as unknown as MonoAgentConfig;
}
