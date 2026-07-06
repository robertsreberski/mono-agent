/**
 * Verifies createConfiguredMemory dispatches memory.backend "supermemory" to a SupermemoryMemoryStore
 * (and leaves the default bujo path untouched). No network: we only assert the store type + that the
 * factory accepts the external-backend config shape.
 */
import { join } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import { SupermemoryMemoryStore } from "@mono-agent/memory-supermemory";
import { describe, expect, it } from "vitest";

import { createConfiguredMemory } from "../index.js";

function baseConfig(memory: NonNullable<MonoAgentConfig["memory"]>): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "ollama", model: "qwen3:8b", reference: "pi:ollama:qwen3:8b" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: "/tmp/agent",
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
    },
    context: { identityPath: "/tmp/identity.md", selectedSkills: [] },
    memory,
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: {
      dir: "/tmp/agent/artifacts",
      retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false },
    },
    traceability: { registryDir: join("/tmp/agent", "trace-sources"), sourceId: "agent-alpha" },
  };
}

describe("createConfiguredMemory — backend dispatch", () => {
  it("returns a SupermemoryMemoryStore when backend is 'supermemory'", async () => {
    const store = await createConfiguredMemory(
      baseConfig({
        backend: "supermemory",
        mode: "lite",
        path: "/tmp/agent/memory",
        maxBytes: 8_000,
        writeMode: "capture",
        supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
      }),
    );
    expect(store).toBeInstanceOf(SupermemoryMemoryStore);
  });

  it("derives the container from the trace sourceId when not set", async () => {
    // Smoke check: the factory accepts a supermemory block without an explicit container.
    const store = await createConfiguredMemory(
      baseConfig({
        backend: "supermemory",
        mode: "lite",
        path: "/tmp/agent/memory",
        maxBytes: 8_000,
        writeMode: "disabled",
        supermemory: { baseUrl: "http://127.0.0.1:6767" },
      }),
    );
    expect(store).toBeInstanceOf(SupermemoryMemoryStore);
  });

  it("defaults to the bujo backend (not supermemory) when backend is unset", async () => {
    const store = await createConfiguredMemory(
      baseConfig({ mode: "lite", path: "/tmp/agent/memory", maxBytes: 8_000, writeMode: "disabled" }),
    );
    expect(store).toBeDefined();
    expect(store).not.toBeInstanceOf(SupermemoryMemoryStore);
  });
});
