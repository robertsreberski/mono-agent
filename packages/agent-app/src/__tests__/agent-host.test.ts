import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as agentHarness from "@mono-agent/agent-harness";
import { MonoAgentConfigError } from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import type {
  RunSummary,
} from "@mono-agent/observability";
import type { MemoryStore } from "@mono-agent/agent-contracts";
import { createBujoMemoryStore } from "@mono-agent/memory/bujo";
import type { EmbeddingProvider } from "@mono-agent/memory/search";
import type { JournalBrowseSnapshot } from "@mono-agent/memory/store";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";
import { createSandboxPolicy } from "@mono-agent/runtime-adapter";
import type { SandboxEngine } from "@mono-agent/runtime-adapter";
import {
  ToolHistoryReader,
  type ConversationHistoryStore,
  type HistoryMessage,
} from "@mono-agent/agent-harness";

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

// These composition tests exercise harness/runtime wiring, not the real
// cooperative owner. Dedicated coordinator and configured-root suites cover
// the filesystem-backed lifetime contract.
const agentRootOwnershipSpies = vi.hoisted(() => ({
  acquire: vi.fn(async (root: string | undefined) => ({
    agentRoot: root ?? process.cwd(),
    coordinator: {
      synchronizeGeneration() {},
      acquireRequestLease: (generation: unknown) => ({
        generation,
        releaseAfterSettlement() {},
      }),
    },
    release() {},
  })),
}));

vi.mock("../agent-root-coordinator.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent-root-coordinator.js")>(),
  acquireAgentRootOwnership: agentRootOwnershipSpies.acquire,
  releaseAgentRootOwnershipWhenIdle: async (ownership: { release(): void }) => {
    ownership.release();
    return true;
  },
  assertAgentRootLeaseOutsideWorkspace() {},
}));

import {
  createConfiguredAgentHarness,
  createConfiguredAgentResponder,
  createConfiguredAgentRuntime,
  createConfiguredMemory,
} from "../index.js";
import { createConfiguredAgentResponderForApp } from "../configured-agent.js";
import { isNotifyDestinationConversationId } from "../notify-destinations.js";
import { createSeenNotifyDestinationCache } from "../seen-conversations.js";

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

const RETIRED_MEMORY_CONFIG_CASES = [
  {
    label: "a plain retired selector",
    backend: "supermemory",
    supermemory: {},
    path: "memory.backend",
    secrets: [],
  },
  {
    label: "a padded retired selector",
    backend: "  supermemory  ",
    supermemory: {},
    path: "memory.backend",
    secrets: [],
  },
  {
    label: "an active retired block with BuJo",
    backend: "bujo",
    supermemory: { baseUrl: "https://retired.invalid/private", apiKey: "retired-key" },
    path: "memory.supermemory",
    secrets: ["https://retired.invalid/private", "retired-key"],
  },
  {
    label: "an active retired block without a selector",
    backend: undefined,
    supermemory: { baseUrl: "https://retired.invalid/private", apiKeyEnv: "PRIVATE_RETIRED_KEY" },
    path: "memory.supermemory",
    secrets: ["https://retired.invalid/private", "PRIVATE_RETIRED_KEY"],
  },
] as const;

const RETIRED_COMPOSITION_CASES = [
  ["configured harness without injected memory", "harness", false],
  ["configured harness with injected memory", "harness", true],
  ["configured responder without injected memory", "responder", false],
  ["configured responder with injected memory", "responder", true],
] as const;

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
        sdk: options.model.provider,
        capabilitiesUsed: ["agent-host"],
        cost: { totalUsd: 0 },
      };
    });

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        compaction: {
          enabled: true,
          triggerRatio: 0.75,
          keepRecentTokens: 9_000,
          summaryMaxTokens: 3_000,
          minSavingsTokens: 7_000,
          fixedOverheadEnabled: false,
          contextWindowOverride: 128_000,
        },
      }),
      runtime: fake.runtime,
      createRunId: () => "run-host",
      runtimeOptionsForRequest: ({ request, runId }) => {
        expect(request.conversationId).toBe("conversation-host");
        expect(runId).toBe("run-host");
        return {
          runtimeOptions: {
            allowedTools: ["AskCollaborator"],
            mcpServers: {
              collaborators: { type: "http", url: "http://127.0.0.1:9876/mcp" },
            },
          },
        };
      },
    });

    expect(responder.liveInputOwnership).toEqual({ version: 1 });
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
      allowedTools: ["Read", "AskCollaborator"],
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
      compaction: {
        enabled: true,
        triggerRatio: 0.75,
        keepRecentTokens: 9_000,
        summaryMaxTokens: 3_000,
        minSavingsTokens: 7_000,
        fixedOverheadEnabled: false,
        contextWindowOverride: 128_000,
      },
    });

    const artifactFiles = await readdir(artifactDir);
    const summaryFile = artifactFiles.find((file) => file.endsWith(".summary.json"));
    expect(summaryFile).toBeDefined();
    expect(await readFile(join(artifactDir, summaryFile as string), "utf8")).toContain("run-host");
  });

  it("auto-provisions MemoryRecall in direct configured responders and composes caller tools", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Configured" }));
    const base = monoConfig({ dir, identityPath, artifactDir, memoryPath: join(dir, "memory") });
    const config: MonoAgentConfig = {
      ...base,
      memory: { ...base.memory!, recallTool: { enabled: true } },
    };
    const memory = {
      async load() { return undefined; },
      async recall() { return []; },
      async persistCompletedTurn(turn: { runId: string; conversationId: string }) {
        return { id: turn.runId, runId: turn.runId, conversationId: turn.conversationId, source: "test", bytesWritten: 0, admissionStatus: "admitted" as const };
      },
      async close() {},
    } satisfies MemoryStore & { recall(): Promise<readonly []>; close(): Promise<void> };

    const responder = await createConfiguredAgentResponder({
      config,
      runtime: fake.runtime,
      memory,
      runtimeOptionsForRequest: () => ({
        runtimeOptions: {
          allowedTools: ["CustomProposalTool"],
          mcpServers: {
            supermemory: {
              type: "http",
              url: "https://mcp.supermemory.ai/operator-authored",
              headers: { Authorization: "Bearer operator-authored" },
            },
          },
        },
      }),
    });

    await responder.respond(
      { conversationId: "custom-tool", text: "Use the custom tool", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.allowedTools).toEqual(["Read", "CustomProposalTool"]);
    expect(fake.calls[0]?.options.mcpServers).toMatchObject({
      "mono-agent-memory": { type: "http", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//u) },
      supermemory: {
        type: "http",
        url: "https://mcp.supermemory.ai/operator-authored",
        headers: { Authorization: "Bearer operator-authored" },
      },
    });
  });

  it("composes MemoryJournal only for enabled, policy-allowed, affirmative local memory", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const base = monoConfig({ dir, identityPath, artifactDir, memoryPath: join(dir, "memory") });

    async function run(input: { readonly readEnabled: boolean; readonly policyAllowed: boolean; readonly capable: boolean }) {
      const fake = createFakeRuntime(async () => ({ text: "Configured" }));
      const config: MonoAgentConfig = {
        ...base,
        memory: { ...base.memory!, recallTool: { enabled: input.readEnabled } },
        tools: {
          allowedTools: input.policyAllowed ? ["MemoryJournal"] : ["Read"],
          disallowedTools: [],
        },
      };
      const memory = {
        async load() { return undefined; },
        async recall() { return []; },
        tier: () => "lite" as const,
        supportsJournalBrowse: () => input.capable,
        async browseJournal() {
          return {
            records: [],
            rangeScanComplete: true,
            truncatedBy: [],
            nonJournalProvenanceExcluded: false,
          };
        },
        async persistCompletedTurn(turn: { runId: string; conversationId: string }) {
          return { id: turn.runId, runId: turn.runId, conversationId: turn.conversationId, source: "test", bytesWritten: 0, admissionStatus: "admitted" as const };
        },
        async close() {},
      } satisfies MemoryStore & {
        recall(): Promise<readonly []>;
        tier(): "lite";
        supportsJournalBrowse(): boolean;
        browseJournal(): Promise<JournalBrowseSnapshot>;
        close(): Promise<void>;
      };
      const responder = await createConfiguredAgentResponder({ config, runtime: fake.runtime, memory });
      await responder.respond(
        { conversationId: "journal-composition", text: "Review this week", abortSignal: new AbortController().signal },
        { append: async () => {} },
      );
      return Object.keys(fake.calls[0]?.options.mcpServers ?? {});
    }

    await expect(run({ readEnabled: true, policyAllowed: true, capable: true })).resolves.toEqual([
      "mono-agent-memory",
      "mono-agent-memory-journal",
    ]);
    await expect(run({ readEnabled: true, policyAllowed: false, capable: true })).resolves.toEqual([
      "mono-agent-memory",
    ]);
    await expect(run({ readEnabled: false, policyAllowed: true, capable: true })).resolves.toEqual([]);
    await expect(run({ readEnabled: true, policyAllowed: true, capable: false })).resolves.toEqual([
      "mono-agent-memory",
    ]);
  });

  it("preserves failure instructions and the original runtime error through the artifact commit hook", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "Stable failure recording identity.");
    const originalError = new TypeError("fixture runtime failure");
    const fake = createFakeRuntime(async () => { throw originalError; });
    const onRunArtifactCommitted = vi.fn();
    const responder = await createConfiguredAgentResponderForApp({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      createRunId: () => "run-failure-context",
    }, { onRunArtifactCommitted });

    await expect(responder.respond(
      { conversationId: "telegram:42", text: "current-question-marker", abortSignal: new AbortController().signal },
      { append: async () => {} },
    )).rejects.toThrow(originalError.message);
    expect(fake.calls).toHaveLength(1);
    const summary = JSON.parse(await readFile(join(artifactDir, "run-failure-context.summary.json"), "utf8")) as RunSummary;
    expect(summary).toMatchObject({ status: "failed", failureKind: "TypeError", systemPrompt: fake.calls[0]!.prompt });
    expect(summary.systemPrompt).toContain("Stable failure recording identity.");
    expect(summary.systemPrompt).not.toContain("current-question-marker");
    expect(onRunArtifactCommitted.mock.calls.map(([event]) => event.phase)).toEqual(["started", "finished"]);
  });

  it("invalidates artifact-derived destinations at local recorder commits", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");

    let scanCalls = 0;
    const cache = createSeenNotifyDestinationCache({
      scan: async () => [{ conversationId: `telegram:${++scanCalls}`, channelId: "telegram" }],
    });
    await cache.list(artifactDir);
    expect(scanCalls).toBe(1);

    const committedPhases: string[] = [];
    const responder = await createConfiguredAgentResponderForApp({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: createFakeRuntime(async () => ({ text: "Done" })).runtime,
      createRunId: () => "run-artifact-cache-boundary",
    }, {
      onRunArtifactCommitted: (event) => {
        committedPhases.push(event.phase);
        if (isNotifyDestinationConversationId(event.conversationId)) cache.invalidate();
      },
    });

    await responder.respond(
      { conversationId: "telegram:42", text: "Run", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(committedPhases).toEqual(["started", "finished"]);
    expect(JSON.parse(await readFile(join(artifactDir, "run-artifact-cache-boundary.summary.json"), "utf8")))
      .toMatchObject({ status: "succeeded", conversationId: "telegram:42" });
    await cache.list(artifactDir);
    expect(scanCalls).toBe(2);
  });

  it.each([
    ["a trim-normalized retired selector", "  supermemory  ", {}],
    ["an active retired block with BuJo", "bujo", { baseUrl: "https://retired.invalid/private", apiKey: "retired-key" }],
    ["an active retired block without a selector", undefined, { baseUrl: "https://retired.invalid/private", apiKeyEnv: "PRIVATE_RETIRED_KEY" }],
  ] as const)("rejects %s before direct configured-memory composition creates local state", async (_label, backend, supermemory) => {
    const dir = await tempDir();
    const memoryPath = join(dir, "store");
    const config = monoConfig({
      dir,
      identityPath: join(dir, "IDENTITY.md"),
      artifactDir: join(dir, "artifacts"),
      memoryPath,
    });
    const legacyConfig = {
      ...config,
      memory: {
        ...config.memory,
        ...(backend === undefined ? {} : { backend }),
        supermemory,
      },
    } as unknown as MonoAgentConfig;

    let rejection: unknown;
    try {
      await createConfiguredMemory(legacyConfig, { cwd: dir });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(MonoAgentConfigError);
    expect(rejection).toMatchObject({
      code: "invalid_json",
      details: {
        path: backend?.trim() === "supermemory" ? "memory.backend" : "memory.supermemory",
      },
    });
    const diagnostic = rejection instanceof Error
      ? JSON.stringify({ message: rejection.message, ...(rejection instanceof MonoAgentConfigError ? { details: rejection.details } : {}) })
      : "";
    expect([
      "https://retired.invalid/private",
      "retired-key",
      "PRIVATE_RETIRED_KEY",
    ].some((value) => diagnostic.includes(value))).toBe(false);
    await expect(access(memoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(RETIRED_COMPOSITION_CASES.flatMap(([factoryLabel, factory, injectMemory]) =>
    RETIRED_MEMORY_CONFIG_CASES.map((configCase) => [
      factoryLabel,
      configCase.label,
      factory,
      injectMemory,
      configCase,
    ] as const),
  ))("rejects %s with %s before composition side effects", async (
    _factoryLabel,
    _configLabel,
    factory,
    injectMemory,
    configCase,
  ) => {
    const dir = await tempDir();
    const base = monoConfig({
      dir,
      identityPath: join(dir, "IDENTITY.md"),
      artifactDir: join(dir, "artifacts"),
      memoryPath: join(dir, "memory"),
    });
    const config = {
      ...base,
      memory: {
        ...base.memory,
        ...(configCase.backend === undefined ? {} : { backend: configCase.backend }),
        supermemory: configCase.supermemory,
      },
    } as unknown as MonoAgentConfig;
    const configureTools = vi.fn();
    const run = vi.fn(async () => ({ text: "must not run" }));
    const load = vi.fn(async () => undefined);
    const persistCompletedTurn = vi.fn(async (turn: { runId: string; conversationId: string }) => ({
      id: turn.runId,
      runId: turn.runId,
      conversationId: turn.conversationId,
      source: "test",
      bytesWritten: 0,
      admissionStatus: "admitted" as const,
    }));
    const memory: MemoryStore = { load, persistCompletedTurn };
    const options = {
      config,
      cwd: dir,
      runtime: { configureTools, run },
      ...(injectMemory ? { memory } : {}),
    };
    agentRootOwnershipSpies.acquire.mockClear();

    let rejection: unknown;
    try {
      if (factory === "harness") {
        await createConfiguredAgentHarness(options);
      } else {
        await createConfiguredAgentResponder(options);
      }
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(MonoAgentConfigError);
    expect(rejection).toMatchObject({
      code: "invalid_json",
      details: { path: configCase.path },
    });
    const diagnostic = rejection instanceof Error
      ? JSON.stringify({
          message: rejection.message,
          ...(rejection instanceof MonoAgentConfigError ? { details: rejection.details } : {}),
        })
      : "";
    expect(diagnostic).toContain("first-party Supermemory support");
    expect(diagnostic).toContain("remote data remains untouched");
    expect(configCase.secrets.some((secret) => diagnostic.includes(secret))).toBe(false);
    expect(configureTools).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(persistCompletedTurn).not.toHaveBeenCalled();
    expect(agentRootOwnershipSpies.acquire).not.toHaveBeenCalled();
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it.each(RETIRED_MEMORY_CONFIG_CASES)(
    "rejects $label before standalone configured-runtime setup",
    (configCase) => {
      const dir = join(tmpdir(), "retired-runtime-boundary");
      const base = monoConfig({
        dir,
        identityPath: join(dir, "IDENTITY.md"),
        artifactDir: join(dir, "artifacts"),
        memoryPath: join(dir, "memory"),
      });
      const providerReads = vi.fn(() => base.providers);
      const config = {
        ...base,
        memory: {
          ...base.memory,
          ...(configCase.backend === undefined ? {} : { backend: configCase.backend }),
          supermemory: configCase.supermemory,
        },
      } as unknown as MonoAgentConfig;
      Object.defineProperty(config, "providers", {
        enumerable: true,
        get: providerReads,
      });

      let rejection: unknown;
      try {
        createConfiguredAgentRuntime(config);
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(MonoAgentConfigError);
      expect(rejection).toMatchObject({
        code: "invalid_json",
        details: { path: configCase.path },
      });
      const diagnostic = rejection instanceof Error
        ? JSON.stringify({
            message: rejection.message,
            ...(rejection instanceof MonoAgentConfigError ? { details: rejection.details } : {}),
          })
        : "";
      expect(diagnostic).toContain("first-party Supermemory support");
      expect(diagnostic).toContain("remote data remains untouched");
      expect(configCase.secrets.some((secret) => diagnostic.includes(secret))).toBe(false);
      expect(providerReads).not.toHaveBeenCalled();
    },
  );

  it("keeps an inert retired block compatible with direct local-memory composition", async () => {
    const dir = await tempDir();
    const memoryPath = join(dir, "store");
    const config = monoConfig({
      dir,
      identityPath: join(dir, "IDENTITY.md"),
      artifactDir: join(dir, "artifacts"),
      memoryPath,
    });
    const compatibleConfig = {
      ...config,
      memory: { ...config.memory, backend: "bujo", supermemory: {} },
    } as unknown as MonoAgentConfig;

    const memory = await createConfiguredMemory(compatibleConfig, { cwd: dir });
    expect(memory).toBeDefined();
    await expect(access(memoryPath)).resolves.toBeUndefined();
    await (memory as unknown as { close(): Promise<void> }).close();
  });

  it("forwards load and completed-turn persistence to a neutral injected MemoryStore", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const load = vi.fn(async () => ({
      kind: "markdown" as const,
      content: "Neutral injected memory.",
      source: "operator-store",
      truncated: false,
    }));
    const persistCompletedTurn = vi.fn(async (turn: { runId: string; conversationId: string }) => ({
      id: turn.runId,
      runId: turn.runId,
      conversationId: turn.conversationId,
      source: "operator-store",
      bytesWritten: 64,
      admissionStatus: "admitted" as const,
    }));
    const memory: MemoryStore = { load, persistCompletedTurn };
    const fake = createFakeRuntime(async () => ({ text: "Generic store answer" }));
    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        memoryPath: join(dir, "memory"),
        memoryWriteMode: "append-host-summary",
      }),
      runtime: fake.runtime,
      memory,
      createRunId: () => "run-generic-store",
    });

    await responder.respond(
      { conversationId: "generic-store", text: "Recall this", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(load).toHaveBeenCalledWith("generic-store", "Recall this", expect.objectContaining({ turnId: "run-generic-store" }));
    expect(JSON.stringify(fake.calls[0])).toContain("Neutral injected memory.");
    expect(persistCompletedTurn).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-generic-store",
      conversationId: "generic-store",
      summary: expect.stringContaining("Generic store answer"),
    }));
  });

  it("records memory persistence degradation in local artifacts", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const memory: MemoryStore = {
      load: async () => undefined,
      persistCompletedTurn: async () => { throw new Error("memory disk became read-only"); },
    };
    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        memoryPath: join(dir, "memory"),
        memoryWriteMode: "append-host-summary",
      }),
      runtime: createFakeRuntime(async () => ({ text: "Provider answer survives" })).runtime,
      memory,
      createRunId: () => "run-memory-warning-order",
      observabilityContext: { sourceId: "src-warning" },
    });

    const response = await responder.respond(
      { conversationId: "telegram:warning", text: "remember this", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(response.text).toBe("Provider answer survives");
    const eventArtifact = await readFile(join(artifactDir, "run-memory-warning-order.events.jsonl"), "utf8");
    expect(eventArtifact).toContain("memory_persistence_degraded");
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

  it("records compound host summaries without auto-injecting ambiguous text", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryRoot = join(dir, "memory");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Logged answer" }));

    // Inject a fake-embeddings journal-tier store so the test is hermetic (no live Ollama in CI).
    const memory = createBujoMemoryStore({ root: memoryRoot, embeddings: fakeEmbeddings, dim: 64 });
    try {
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
        memory,
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

      // A compound host summary contains User/Assistant roles and is deliberately
      // outside the canonical direct-fact contract. It remains available through
      // the default-on explicit MemoryRecall endpoint instead of being injected.
      await responder.respond(
        { conversationId: "channel-b", text: "Logged answer", abortSignal: new AbortController().signal },
        { append: async () => {} },
      );
      const recalledMessage = String(fake.calls[1]?.options.messages?.[0]?.content);
      expect(recalledMessage).toMatch(/<\/host_turn_context>\n\nLogged answer$/u);
      expect(fake.calls[1]?.prompt).not.toContain("## Memory (recalled)");
    } finally {
      await memory.close();
    }
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
    const memoryRuntime = createFakeRuntime(async () => ({ text: '{"memories":[],"entities":[],"relations":[]}' }));

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
        model: "openai-codex:gpt-5.5",
      },
      artifactDir,
    });
    const memory = await createConfiguredMemory(config, { memoryRuntime: memoryRuntime.runtime });
    try {
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
      for (let i = 0; i < 20 && memoryRuntime.calls.length < 1; i += 1) {
        await delay(5);
      }

      // The channel runtime served the channel turn only — the memory model never
      // leaked onto it.
      expect(channel.calls.every((call) => call.options.model.provider !== "openai-codex")).toBe(true);

      // The memory LLM ran on its own runtime, with the configured memory model and
      // the locked-down per-call shape.
      expect(memoryRuntime.calls).toHaveLength(1);
      for (const call of memoryRuntime.calls) {
        expect(call.options.model).toMatchObject({ provider: "openai-codex", model: "gpt-5.5" });
        expect(call.options.allowedTools).toEqual([]);
        expect(call.options.disallowedTools).toEqual([]);
        expect(call.options.mcpServers).toEqual({});
        // A schema-bound call gets the structured-output finalization turn; nothing else does.
        expect(call.options.maxTurns).toBe(call.options.outputSchema === undefined ? 1 : 3);
      }
    } finally {
      await (memory as unknown as { close(): Promise<void> }).close();
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

  it("filters a stale installed retired project skill before harness loading", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const skillsRoot = join(dir, "skills");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    await mkdir(join(skillsRoot, "mono-agent-configure"), { recursive: true });
    await writeFile(
      join(skillsRoot, "mono-agent-configure", "SKILL.md"),
      "---\nname: mono-agent-configure\ndescription: Retired project skill.\n---\n\nRETIRED_CONFIGURATION_SKILL_MUST_NOT_LOAD",
      "utf8",
    );
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        skillsRoot,
        selectedSkills: ["mono-agent-configure"],
        artifactDir,
      }),
      runtime: fake.runtime,
    });

    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.prompt).not.toContain("RETIRED_CONFIGURATION_SKILL_MUST_NOT_LOAD");
    expect(fake.calls[0]?.options.skills).toBeUndefined();
  });

  it("falls back from index to full disclosure while filtering a retired selected skill", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const skillsRoot = join(dir, "skills");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    await mkdir(join(skillsRoot, "mono-agent-configure"), { recursive: true });
    await mkdir(join(skillsRoot, "incident-response"), { recursive: true });
    await writeFile(
      join(skillsRoot, "mono-agent-configure", "SKILL.md"),
      "---\nname: mono-agent-configure\ndescription: Retired project skill.\n---\n\nRETIRED_CONFIGURATION_SKILL_MUST_NOT_LOAD",
      "utf8",
    );
    await writeFile(
      join(skillsRoot, "incident-response", "SKILL.md"),
      "---\nname: incident-response\ndescription: Active project skill.\n---\n\nACTIVE_INCIDENT_RESPONSE_SKILL_BODY",
      "utf8",
    );
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        skillsRoot,
        selectedSkills: ["mono-agent-configure", "incident-response"],
        skillDisclosure: "index",
        artifactDir,
      }),
      runtime: fake.runtime,
    });

    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.prompt).not.toContain("RETIRED_CONFIGURATION_SKILL_MUST_NOT_LOAD");
    expect(fake.calls[0]?.prompt).toContain("ACTIVE_INCIDENT_RESPONSE_SKILL_BODY");
    expect(fake.calls[0]?.prompt).not.toContain("ReadSkill");
    expect(fake.calls[0]?.options.skills).toBeUndefined();
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

  it("never sets a retired permission or reasoning-summary option", async () => {
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
      }),
      runtime: fake.runtime,
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options).not.toHaveProperty("permissionMode");
    // The retired reasoning-summary knob is gone: pi-native derives reasoning from
    // effort and the codex/claude CLIs emit summaries themselves.
    expect(fake.calls[0]?.options.piReasoningSummary).toBeUndefined();
  });

  it("forwards tools.mcpCall*TimeoutMs as typed tool limits, omitting limits when unset", async () => {
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
    expect(fake.calls[0]?.options.toolLimits).toMatchObject({
      mcpCallTimeoutMs: 60_000,
      mcpCallMaxTotalTimeoutMs: 900_000,
    });

    // Unset timeouts must not materialize a tool limits object — the runtime's own
    // defaults (120s inactivity / 45 min total) apply.
    const plain = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
    });
    await plain.respond(
      { conversationId: "c2", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[1]?.options.toolLimits).toBeUndefined();
  });

  it("bounds in-flight runs at concurrency.maxConcurrentRuns", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");

    let active = 0;
    let peak = 0;
    let startedFirst!: () => void;
    let startedSecond!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    const secondStarted = new Promise<void>((resolve) => { startedSecond = resolve; });
    let calls = 0;
    const release: Array<() => void> = [];
    const fake = createFakeRuntime(async () => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (calls === 1) startedFirst();
      if (calls === 2) startedSecond();
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

    // The provider-entry signals are emitted only after the limiter admits a
    // run, so they prove the second cannot enter before the first releases.
    await firstStarted;
    expect(release.length).toBe(1);
    release.shift()?.();
    await secondStarted;
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
    let admittedSecond!: () => void;
    const secondAdmitted = new Promise<void>((resolve) => { admittedSecond = resolve; });
    const second = harness.run({
      conversationId: "c2",
      userMessage: "b",
      abortSignal: new AbortController().signal,
      sessionBoundary: {
        type: "session_boundary",
        kind: "rollover",
        conversationId: "c2",
        reason: "test_pending_admission",
      },
      onEvent: (event) => {
        if (event.type === "session_boundary" && event.reason === "test_pending_admission") {
          admittedSecond();
        }
      },
    });
    // The harness emits this boundary only after incrementing its pending-run
    // counter, so the third arrival deterministically observes pending = 1.
    await secondAdmitted;
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

    try {
      // First load drives an embedding request that fails and trips the breaker.
      await expect(memory!.load("conv")).rejects.toThrow();
      expect(requests).toBe(1);
      // Second load fast-fails on the OPEN breaker without hitting the server again.
      await expect(memory!.load("conv")).rejects.toThrow();
      expect(requests).toBe(1);
    } finally {
      await (memory as unknown as { close(): Promise<void> }).close();
    }
  });

  it.each([undefined, false, true])("plumbs prompt cache diagnostics %s only when configured", async (enabled) => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    const base = monoConfig({ dir, identityPath, artifactDir });
    const responder = await createConfiguredAgentResponder({
      config: { ...base, ...(enabled === undefined ? {} : { providers: { ...base.providers, piNative: { promptCacheDiagnostics: enabled } } }) },
      runtime: fake.runtime,
    });
    await responder.respond({ conversationId: "c", text: "hi", abortSignal: new AbortController().signal }, { append: async () => {} });
    if (enabled === undefined) expect(fake.calls[0]?.options).not.toHaveProperty("promptCacheDiagnostics");
    else expect(fake.calls[0]?.options.promptCacheDiagnostics).toBe(enabled);
  });

  it("lets host runtimeOptions override config flags and carry code-only runtime controls", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      runtimeOptions: {
        piMaxRetries: 5,
      },
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options).not.toHaveProperty("permissionMode");
    expect(fake.calls[0]?.options.piMaxRetries).toBe(5);
  });

  it("keeps the configured Pi transport authoritative over request extensions", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    const base = monoConfig({ dir, identityPath, artifactDir });

    const responder = await createConfiguredAgentResponder({
      config: {
        ...base,
        providers: { ...base.providers, piNative: { transport: "sse" } },
      },
      runtime: fake.runtime,
      runtimeOptionsForRequest: () => ({ runtimeOptions: { piTransport: "websocket" } }),
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.piTransport).toBe("sse");
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

  it("restarts with the default 64-message durable history when maxTurns is unlimited", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const config = monoConfig({ dir, identityPath, artifactDir });
    const { maxTurns: _maxTurns, ...unlimitedRuntime } = config.runtime;
    const unlimitedConfig = { ...config, runtime: unlimitedRuntime } as MonoAgentConfig;
    let turn = 0;
    const firstRuntime = createFakeRuntime(async () => ({ text: `answer-${++turn}` }));
    const firstHarness = await createConfiguredAgentHarness({ config: unlimitedConfig, runtime: firstRuntime.runtime });

    for (let index = 1; index <= 34; index += 1) {
      await firstHarness.run({
        conversationId: "conversation-restart",
        userMessage: `question-${index}`,
        abortSignal: new AbortController().signal,
      });
    }

    const restartedRuntime = createFakeRuntime(async () => ({ text: "answer-after-restart" }));
    const restartedHarness = await createConfiguredAgentHarness({
      config: unlimitedConfig,
      runtime: restartedRuntime.runtime,
    });
    await restartedHarness.run({
      conversationId: "conversation-restart",
      userMessage: "question-after-restart",
      abortSignal: new AbortController().signal,
    });

    expect(restartedRuntime.calls[0]?.options.maxTurns).toBeUndefined();
    expect(JSON.stringify(restartedRuntime.calls[0]?.options.messages)).toContain("question-3");
    expect(JSON.stringify(restartedRuntime.calls[0]?.options.messages)).toContain("answer-3");
    // 34 completed two-message turns retain exactly the latest 32 turns;
    // the new current turn is appended after those 64 canonical messages.
    expect(restartedRuntime.calls[0]?.options.messages).toHaveLength(65);
    expect(JSON.stringify(restartedRuntime.calls[0]?.options.messages)).not.toContain('question-2"');
    const historyEntries = await readdir(join(dir, ".mono-agent", "history"));
    expect(historyEntries.filter((name) => name.endsWith(".history.json"))).toHaveLength(1);
    expect(historyEntries).toContain(".locks");
  });

  it("recreates a Telegram-like stateless responder with the first turn replayed exactly once", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const base = monoConfig({ dir, identityPath, artifactDir });
    const config: MonoAgentConfig = {
      ...base,
      runtime: {
        ...base.runtime,
        maxTurns: 0,
        fallbacks: [{
          model: {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            reference: "openai-codex:gpt-5.6-sol",
          },
        }],
        session: {
          mode: "continuous",
          idleTimeoutMs: 60_000,
          rollover: "daily",
          rolloverTimezone: "UTC",
        },
      },
      tools: { allowedTools: ["*"], disallowedTools: [] },
    };
    const now = () => new Date("2026-07-17T12:00:00Z");
    const firstRuntime = createFakeRuntime(async () => ({
      text: "FIRST_ASSISTANT_REPLAY_MARKER",
      providerSessionId: "must-not-resume",
    }));
    const firstResponder = await createConfiguredAgentResponder({ config, runtime: firstRuntime.runtime, now });
    await firstResponder.respond(
      {
        conversationId: "telegram:42",
        text: "FIRST_USER_REPLAY_MARKER",
        abortSignal: new AbortController().signal,
      },
      { append: async () => {} },
    );

    const restartedRuntime = createFakeRuntime(async () => ({ text: "answer-after-restart" }));
    const restartedResponder = await createConfiguredAgentResponder({ config, runtime: restartedRuntime.runtime, now });
    await restartedResponder.respond(
      {
        conversationId: "telegram:42",
        text: "What did you send?",
        abortSignal: new AbortController().signal,
      },
      { append: async () => {} },
    );

    const secondPrompt = restartedRuntime.calls[0]?.options.messages?.map((message) => message.content).join("\n") ?? "";
    expect(restartedRuntime.calls[0]?.options.sessionId).toBeUndefined();
    expect(restartedRuntime.calls[0]?.options.providerSessionId).toBeUndefined();
    expect(secondPrompt.split("FIRST_USER_REPLAY_MARKER")).toHaveLength(2);
    expect(secondPrompt.split("FIRST_ASSISTANT_REPLAY_MARKER")).toHaveLength(2);
    expect((await readdir(join(dir, ".mono-agent", "history")))
      .filter((name) => name.endsWith(".history.json"))).toHaveLength(1);
  });

  it("keeps configured tool history with a caller-supplied conversation history store", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    const historyRoot = join(dir, ".mono-agent", "history");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const persisted: HistoryMessage[] = [];
    let loads = 0;
    const historyStore: ConversationHistoryStore = {
      async load() {
        loads += 1;
        return [...persisted];
      },
      async append(_conversationId: string, messages: readonly HistoryMessage[]) {
        persisted.push(...messages);
      },
    };
    const runtime = createFakeRuntime(async (_prompt, options) => {
      await options.toolLifecycleSink?.({
        phase: "invocation",
        toolCallId: "custom-store-read",
        toolName: "Read",
        arguments: { file_path: "/Users/example/repo/src/config.ts" },
      });
      await options.toolLifecycleSink?.({
        phase: "result",
        toolCallId: "custom-store-read",
        state: "success",
        content: "custom-store-tool-result",
      });
      return { text: "custom-store-answer" };
    });
    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: runtime.runtime,
      historyStore,
      createRunId: () => "run-custom-store",
    });

    try {
      await harness.run({
        conversationId: "custom-store",
        userMessage: "custom-store-question",
        abortSignal: new AbortController().signal,
      });

      expect(loads).toBeGreaterThan(0);
      expect(persisted.map((message) => message.content)).toEqual([
        "custom-store-question",
        "custom-store-answer",
      ]);
      expect(new ToolHistoryReader(historyRoot).search({
        logicalConversationId: "custom-store",
        currentConversationId: "custom-store",
        currentRunId: "later-run",
      }).items).toEqual([
        expect.objectContaining({
          runId: "run-custom-store",
          toolCallId: "custom-store-read",
          toolName: "Read",
          state: "success",
        }),
      ]);
      expect((await readdir(historyRoot)).filter((name) => name.endsWith(".history.json")))
        .toEqual([]);
    } finally {
      await harness.dispose?.();
    }
  });

  it("preserves a custom store's positive context-import contract through configured ownership", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const runtime = createFakeRuntime(async () => ({ text: "must not run" }));
    const committed: HistoryMessage[] = [];
    const historyStore: ConversationHistoryStore = {
      load: async () => committed,
      append: async (_id, messages) => { committed.push(...messages); },
      contextImport: {
        version: 1,
        maxTextBytes: 32_768,
        providerState: "absent",
        beginExclusiveTurn: async () => ({
          history: committed,
          historyVersion: "a".repeat(64),
          prepareCommit: async () => ({
            append: { commit: async () => undefined, abort: async () => undefined },
            committedHistoryVersion: "b".repeat(64),
          }),
          abort: async () => undefined,
        }),
        prepareImport: async (_conversationId, request) => ({
          result: { status: "appended" },
          append: {
            commit: async () => { committed.push({ role: "assistant", content: request.text }); },
            abort: async () => undefined,
          },
        }),
      },
    };
    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: runtime.runtime,
      historyStore,
    });
    try {
      await expect(harness.importContext?.("custom-store", { text: "snapshot", idempotencyKey: "run:1" }))
        .resolves.toEqual({ status: "appended" });
      expect(committed).toEqual([{ role: "assistant", content: "snapshot" }]);
      expect(runtime.calls).toEqual([]);
    } finally {
      await harness.dispose?.();
    }
  });

  it("overrides the config model when supplied at composition time", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async (_prompt, options) => ({ text: "ok", model: options.model.model }));

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      model: { provider: "anthropic", model: "claude-opus-4-7", reference: "anthropic:claude-opus-4-7" },
    });

    await harness.run({
      conversationId: "conversation-override",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(fake.calls[0]?.options.model).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
      reference: "anthropic:claude-opus-4-7",
    });
  });

  it("falls back to the config model when no override is supplied", async () => {
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

    expect(fake.calls[0]?.options.model.provider).toBe("ollama");
  });

  it("threads resolved WebSearch and WebFetch config into each runtime run", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    const baseConfig = monoConfig({ dir, identityPath, artifactDir });

    const harness = await createConfiguredAgentHarness({
      config: {
        ...baseConfig,
        tools: {
          ...baseConfig.tools,
          web: {
            coordination: "host",
            search: { backend: "ollama", maxRequestsPerRun: 4, ollama: { baseUrl: "http://127.0.0.1:11434", trustPublicUrl: false } },
            fetch: { render: "auto", browserCommand: "/opt/homebrew/bin/agent-browser" },
          },
        },
      },
      runtime: fake.runtime,
    });

    await harness.run({
      conversationId: "conversation-web-tools",
      userMessage: "Research this",
      abortSignal: new AbortController().signal,
    });

    expect(fake.calls[0]?.options.webRequestCoordinator?.scope).toMatch(/^host:/u);
    expect(fake.calls[0]?.options.webSearchConfig).toEqual({
      backend: "ollama",
      maxRequestsPerRun: 4,
      ollama: { baseUrl: "http://127.0.0.1:11434", trustPublicUrl: false },
    });
    expect(fake.calls[0]?.options.webFetchConfig).toEqual({
      render: "auto",
      browserCommand: "/opt/homebrew/bin/agent-browser",
    });
    expect(fake.calls[0]?.options.persistArtifact).toBeTypeOf("function");
  });

  it("threads the same WebSearch and WebFetch config into subagent runs", async () => {
    // A subagent builds its OWN web controller outside the harness. When these
    // two keys were not inherited, every child search silently fell back to the
    // keyless backend and rate-limited itself into a cooldown while the parent
    // kept working — so this asserts the child, not just the parent turn.
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    const baseConfig = monoConfig({ dir, identityPath, artifactDir });

    const harness = await createConfiguredAgentHarness({
      config: {
        ...baseConfig,
        tools: {
          ...baseConfig.tools,
          allowedTools: [...(baseConfig.tools.allowedTools ?? []), "Agent"],
          web: {
            coordination: "host",
            search: { backend: "ollama", maxRequestsPerRun: 4, ollama: { baseUrl: "http://127.0.0.1:11434", trustPublicUrl: false } },
            fetch: { render: "auto", browserCommand: "/opt/homebrew/bin/agent-browser" },
          },
        },
        subagents: { enabled: true },
      },
      runtime: fake.runtime,
    });

    await harness.run({
      conversationId: "conversation-subagent-web-tools",
      userMessage: "Delegate this",
      abortSignal: new AbortController().signal,
    });

    const subagentRun = (fake.calls[0]?.options as unknown as {
      subagents?: { run?: (request: unknown) => Promise<unknown> };
    }).subagents?.run;
    expect(subagentRun).toBeTypeOf("function");

    await subagentRun?.({
      systemPrompt: "You are a researcher.",
      prompt: "Find the current timetable.",
      definition: { name: "researcher", allowedTools: ["WebSearch", "WebFetch"] },
      maxTurns: 4,
      depth: 0,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    const childCall = fake.calls[1];
    expect(childCall).toBeDefined();
    expect(childCall?.options.webRequestCoordinator?.scope).toBe(fake.calls[0]?.options.webRequestCoordinator?.scope);
    expect(childCall?.options.webRequestCoordinator?.acquire).toBeTypeOf("function");
    expect(childCall?.options.webSearchConfig).toEqual({
      backend: "ollama",
      maxRequestsPerRun: 4,
      ollama: { baseUrl: "http://127.0.0.1:11434", trustPublicUrl: false },
    });
    expect(childCall?.options.webFetchConfig).toEqual({
      render: "auto",
      browserCommand: "/opt/homebrew/bin/agent-browser",
    });
    expect(fake.calls[0]?.options.persistArtifact).toBeTypeOf("function");
    expect(childCall?.options.persistArtifact).toBeUndefined();
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

  it("forwards the host terminal recovery settlement window to harness session options", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const createHarness = vi.spyOn(agentHarness, "createAgentHarness");
    let harness: Awaited<ReturnType<typeof createConfiguredAgentHarness>> | undefined;
    try {
      harness = await createConfiguredAgentHarness({
        config: monoConfig({ dir, identityPath, artifactDir: join(dir, "artifacts") }),
        runtime: createFakeRuntime(async () => ({ text: "unused" })).runtime,
        terminalRecoverySettlementMs: 30_000,
      });
      expect(createHarness).toHaveBeenCalledWith(expect.objectContaining({
        session: expect.objectContaining({ terminalRecoverySettlementMs: 30_000 }),
      }));
    } finally {
      createHarness.mockRestore();
      await harness?.dispose?.();
    }
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

  it("keeps OpenAI API and Telegram histories and provider sessions independent", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async (_prompt, options) => ({
      text: String(options.messages.at(-1)?.content).includes("TELEGRAM_") ? "TELEGRAM_ANSWER" : "OPENAI_API_ANSWER",
      providerSessionId: String(options.messages.at(-1)?.content).includes("TELEGRAM_") ? "telegram-provider-session" : "openai-api-provider-session",
    }));
    const base = monoConfig({ dir, identityPath, artifactDir });
    const harness = await createConfiguredAgentHarness({
      config: {
        ...base,
        runtime: { ...base.runtime, session: { mode: "continuous", idleTimeoutMs: 60_000 } },
      },
      runtime: fake.runtime,
    });

    await harness.run({ conversationId: "telegram:42", userMessage: "TELEGRAM_FIRST", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "openai-arequest-1", userMessage: "OPENAI_API_FIRST", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "telegram:42", userMessage: "TELEGRAM_SECOND", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "openai-arequest-1", userMessage: "OPENAI_API_SECOND", abortSignal: new AbortController().signal });

    expect(fake.calls.map((call) => call.options.sessionId)).toEqual([
      undefined,
      undefined,
      "telegram-provider-session",
      "openai-api-provider-session",
    ]);
    const historyRoot = join(dir, ".mono-agent", "history");
    const historyFiles = (await readdir(historyRoot)).filter((name) => name.endsWith(".history.json"));
    expect(historyFiles).toHaveLength(2);
    const histories = await Promise.all(historyFiles.map((name) => readFile(join(historyRoot, name), "utf8")));
    const telegramHistory = histories.find((history) => history.includes("TELEGRAM_FIRST"));
    const openaiApiHistory = histories.find((history) => history.includes("OPENAI_API_FIRST"));
    expect(telegramHistory).toContain("TELEGRAM_SECOND");
    expect(telegramHistory).not.toContain("OPENAI_API_FIRST");
    expect(openaiApiHistory).toContain("OPENAI_API_SECOND");
    expect(openaiApiHistory).not.toContain("TELEGRAM_FIRST");
  });

  it("replays later-turn history after a stateless fallback answer when maxTurns is unlimited", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    let turn = 0;
    const fake = createFakeRuntime(async () => ({
      text: `answer-${++turn}`,
    }));
    const base = monoConfig({ dir, identityPath, artifactDir });
    const harness = await createConfiguredAgentHarness({
      config: {
        ...base,
        runtime: {
          ...base.runtime,
          maxTurns: 0,
          fallbacks: [{
            model: {
              provider: "openai-codex",
              model: "gpt-5.6-sol",
              reference: "openai-codex:gpt-5.6-sol",
            },
          }],
          session: { mode: "continuous", idleTimeoutMs: 60_000 },
        },
        tools: { allowedTools: ["*"], disallowedTools: [] },
      },
      runtime: fake.runtime,
    });

    await harness.run({ conversationId: "conv-mixed", userMessage: "first question", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "conv-mixed", userMessage: "second question", abortSignal: new AbortController().signal });

    for (const call of fake.calls) {
      expect(call.options.sessionId).toBeUndefined();
      expect(call.options.providerSessionId).toBeUndefined();
      expect(call.options.sessionKeepAlive).toBe(true);
    }
    expect(fake.calls[1]?.prompt).not.toContain("Conversation History");
    expect(fake.calls[1]?.prompt).toBe(fake.calls[0]?.prompt);
    expect(fake.calls[1]?.options.messages?.length).toBe(3);
    expect(JSON.stringify(fake.calls[1]?.options.messages)).toContain("first question");
    expect(JSON.stringify(fake.calls[1]?.options.messages)).toContain("answer-1");
  });

  it("resumes the primary across turns with canonical fallbacks configured", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    let turn = 0;
    const fake = createFakeRuntime(async () => ({
      text: `answer-${++turn}`,
      providerSessionId: "resumable-provider-session",
    }));
    const base = monoConfig({ dir, identityPath, artifactDir });
    const harness = await createConfiguredAgentHarness({
      config: {
        ...base,
        runtime: {
          ...base.runtime,
          fallbacks: [{
            model: {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              reference: "anthropic:claude-sonnet-4-6",
            },
          }],
          session: { mode: "continuous", idleTimeoutMs: 60_000 },
        },
      },
      runtime: fake.runtime,
    });

    await harness.run({ conversationId: "conv-canonical", userMessage: "first", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "conv-canonical", userMessage: "second", abortSignal: new AbortController().signal });

    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.sessionKeepAlive).toBe(true);
    expect(fake.calls[1]?.options.sessionId).toBe("resumable-provider-session");
    expect(fake.calls[1]?.options.providerSessionId).toBe("resumable-provider-session");
    expect(fake.calls[1]?.options.sessionKeepAlive).toBe(true);
    expect(fake.calls[1]?.prompt).toBe(fake.calls[0]?.prompt);
    expect(fake.calls[1]?.options.messages).toEqual([
      { role: "user", content: expect.stringContaining("second") },
    ]);
    expect(JSON.stringify(fake.calls[1]?.options.messages)).not.toContain("answer-1");
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
    readonly provider: "ollama" | "lmstudio" | "openai";
    readonly model: string;
    readonly endpoint?: string;
    readonly apiKey?: string;
  };
  readonly memoryLlm?: NonNullable<MonoAgentConfig["memory"]>["llm"];
  readonly skillsRoot?: string;
  readonly selectedSkills?: readonly string[];
  readonly skillDisclosure?: "index" | "full";
  readonly skillMaxBytes?: number;
  readonly artifactDir: string;
  readonly mcpConfigPath?: string;
  readonly mcpCallTimeoutMs?: number;
  readonly mcpCallMaxTotalTimeoutMs?: number;
  readonly compaction?: NonNullable<MonoAgentConfig["runtime"]["compaction"]>;
}): MonoAgentConfig {
  return {
    runtime: {
      model: { provider: "ollama", model: "qwen3:8b", reference: "ollama:qwen3:8b" },
      maxTurns: 4,
      workspace: input.dir,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
      ...(input.compaction === undefined ? {} : { compaction: input.compaction }),
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
      ...(input.skillDisclosure === undefined ? {} : { skillDisclosure: input.skillDisclosure }),
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
      memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false },
    },
    traceability: {
      registryDir: join(input.dir, "trace-sources"),
    },
  };
}

it("retires configured override history through the cached owning runtime", async () => {
  const dir = await tempDir();
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.");
  const original = monoConfig({ dir, identityPath, artifactDir: join(dir, "artifacts") });
  const model = { provider: "faux", model: "base", reference: "faux:base" };
  const override = { provider: "faux", model: "override", reference: "faux:override" };
  const config: MonoAgentConfig = { ...original,
    runtime: { ...original.runtime, model, session: { mode: "continuous", idleTimeoutMs: 60000 } },
    providers: { piNative: { piSessionsRoot: join(dir, "pi") } } };
  const owner = () => ({ run: vi.fn(async (_prompt: string, options: RuntimeRunOptions) => ({ text: "answer", providerSessionId: String(options.sessionId) })),
    refreshSession: vi.fn(async () => undefined), syncSession: vi.fn(async () => true),
    invalidateSession: vi.fn(async () => true), disposeSession: vi.fn(async () => true), retireDurableSession: vi.fn(async () => undefined) });
  const base = owner();
  const alternate = owner();
  const factory = vi.fn(() => alternate);
  const options = { config, cwd: dir, runtime: base, runtimeForModel: factory, sandboxEngine: fakeSandboxEngine,
    runtimeOptionsForRequest: ({ request }: { request: { metadata?: Readonly<Record<string, unknown>> } }) => ({
      runtimeOptions: { model: request.metadata?.web ? override : model } }) };
  const request = { conversationId: "bound-configured", userMessage: "hello", abortSignal: new AbortController().signal,
    metadata: { web: { model: override.reference } } };
  const first = await createConfiguredAgentHarness(options);
  expect((await first.run(request)).text).toBe("answer");
  const id = alternate.run.mock.calls[0]![1].sessionId;
  await first.dispose?.();
  const next = await createConfiguredAgentHarness(options);
  expect((await next.run(request)).text).toBe("answer");
  expect(alternate.run.mock.calls[1]![1].sessionId).toBe(id);
  await next.resetConversation?.(request.conversationId);
  expect(alternate.invalidateSession).toHaveBeenCalledWith(id);
  expect(alternate.retireDurableSession).toHaveBeenCalledWith(id, join(dir, "pi"));
  expect(base.invalidateSession).not.toHaveBeenCalled();
  expect(base.retireDurableSession).not.toHaveBeenCalled();
  expect(factory).toHaveBeenCalledTimes(2); // Once per recreated configured harness lifetime.
  await next.dispose?.();
});
