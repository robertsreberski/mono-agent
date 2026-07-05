import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBujoMemoryStore } from "@mono-agent/memory/bujo";
import type { BujoMemoryStore } from "@mono-agent/memory/bujo";
import type { MonoAgentConfig } from "@mono-agent/config";
import { SupermemoryMemoryStore } from "@mono-agent/memory-supermemory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MEMORY_RECALL_MCP_SERVER_NAME,
  createMemoryRecallServer,
  createRecallStore,
  memoryRecallMcpEnv,
  memoryRecallMcpServerSpec,
  memoryRecallSettingsFromEnv,
  resolveMemoryRecallSettings,
} from "../memory-recall.js";
import type { MemoryRecallBujoSettings, MemoryRecallSettings } from "../memory-recall.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-memory-recall-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Build a MonoAgentConfig whose only meaningful field for recall is the memory block. */
function configWithMemory(memory: MonoAgentConfig["memory"]): MonoAgentConfig {
  return { memory } as unknown as MonoAgentConfig;
}

/** Narrow recall settings to the bujo shape (asserts it is not the supermemory backend). */
function bujo(settings: MemoryRecallSettings | undefined): MemoryRecallBujoSettings {
  if (settings === undefined || "supermemory" in settings) {
    throw new Error("expected bujo recall settings");
  }
  return settings;
}

describe("resolveMemoryRecallSettings", () => {
  it("returns undefined when memory is unconfigured", () => {
    expect(resolveMemoryRecallSettings(configWithMemory(undefined))).toBeUndefined();
  });

  it("returns undefined when the recall tool is disabled", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text" },
        recallTool: { enabled: false },
      }),
    );
    expect(settings).toBeUndefined();
  });

  it("returns root WITHOUT embeddings when explicitly enabled on a no-embeddings (lite) store", () => {
    // F12: the operator opts in to FTS-only recall despite no embeddings default.
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "lite",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        recallTool: { enabled: true },
      }),
    );
    expect(settings).toEqual({ root: "/memory" });
    expect(bujo(settings).embeddings).toBeUndefined();
  });

  it("carries embeddings timeout + circuit-breaker tuning into the recall settings", () => {
    // F11: the resilience knobs must reach the recall child, not be dropped.
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          timeoutMs: 4_000,
          circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
        },
        recallTool: { enabled: true },
      }),
    );
    expect(bujo(settings).embeddings).toMatchObject({
      timeoutMs: 4_000,
      circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
    });
  });

  it("forwards the apiKeyEnv NAME instead of the resolved secret value (F13)", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKey: "resolved-secret",
          apiKeyEnv: "MY_OPENAI_KEY",
        },
        recallTool: { enabled: true },
      }),
    );
    expect(bujo(settings).embeddings?.apiKeyEnv).toBe("MY_OPENAI_KEY");
  });

  it("returns root + embeddings when enabled with embeddings", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "journal",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          endpoint: "https://api.openai.com/v1",
          apiKey: "secret",
          dim: 1536,
        },
        recallTool: { enabled: true },
      }),
    );
    expect(settings).toEqual({
      root: "/memory",
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        endpoint: "https://api.openai.com/v1",
        apiKey: "secret",
        dim: 1536,
      },
    });
  });
});

describe("memoryRecallMcpServerSpec / env", () => {
  const settings = {
    root: "/memory",
    embeddings: {
      provider: "ollama" as const,
      model: "nomic-embed-text:v1.5",
      endpoint: "http://localhost:11434",
      dim: 768,
    },
  };

  it("emits a stdio spec pointing at the recall bin with the memory env", () => {
    const spec = memoryRecallMcpServerSpec(settings, "/agent");
    expect(spec.type).toBe("stdio");
    expect(spec.command).toBe(process.execPath);
    expect(spec.cwd).toBe("/agent");
    expect(String((spec.args as string[])[0])).toMatch(/memory-recall-main\.js$/u);
    expect(spec.env).toMatchObject({
      MONO_AGENT_MEMORY_PATH: "/memory",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "nomic-embed-text:v1.5",
      MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT: "http://localhost:11434",
      MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "768",
    });
  });

  it("round-trips through the MONO_AGENT_MEMORY_* env back to settings", () => {
    const env = memoryRecallMcpEnv(settings);
    expect(memoryRecallSettingsFromEnv(env)).toEqual(settings);
  });

  it("rejects env missing the required memory path", () => {
    expect(() => memoryRecallSettingsFromEnv({})).toThrow(/missing required environment/u);
  });

  it("round-trips embeddings timeout + circuit-breaker tuning through the env (F11)", () => {
    const tuned: MemoryRecallSettings = {
      root: "/memory",
      embeddings: {
        provider: "ollama",
        model: "nomic-embed-text:v1.5",
        timeoutMs: 4_000,
        circuitBreaker: { failureThreshold: 7, cooldownMs: 12_000 },
      },
    };
    const env = memoryRecallMcpEnv(tuned);
    expect(env).toMatchObject({
      MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS: "4000",
      MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD: "7",
      MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS: "12000",
    });
    expect(memoryRecallSettingsFromEnv(env)).toEqual(tuned);
  });

  it("forwards the apiKeyEnv NAME (not the secret) and the child resolves it from inherited env (F13)", () => {
    const withApiKeyEnv: MemoryRecallSettings = {
      root: "/memory",
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "resolved-secret",
        apiKeyEnv: "MY_OPENAI_KEY",
      },
    };
    const env = memoryRecallMcpEnv(withApiKeyEnv);
    // The NAME is forwarded; the raw secret value is NOT placed in the spec env.
    expect(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV).toBe("MY_OPENAI_KEY");
    expect(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY).toBeUndefined();
    expect(Object.values(env)).not.toContain("resolved-secret");

    // The child re-reads the key from its inherited env at runtime.
    const resolved = bujo(memoryRecallSettingsFromEnv({ ...env, MY_OPENAI_KEY: "resolved-secret" }));
    expect(resolved.embeddings?.apiKey).toBe("resolved-secret");
    expect(resolved.embeddings?.apiKeyEnv).toBe("MY_OPENAI_KEY");
  });

  it("falls back to forwarding a literal inline apiKey when no apiKeyEnv is present (F13 residual)", () => {
    const inline: MemoryRecallSettings = {
      root: "/memory",
      embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "inline-secret" },
    };
    const env = memoryRecallMcpEnv(inline);
    expect(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY).toBe("inline-secret");
    expect(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV).toBeUndefined();
    expect(bujo(memoryRecallSettingsFromEnv(env)).embeddings?.apiKey).toBe("inline-secret");
  });

  it("round-trips an FTS-only (no-embeddings) settings object through the env (F12)", () => {
    const ftsOnly: MemoryRecallSettings = { root: "/memory" };
    const env = memoryRecallMcpEnv(ftsOnly);
    expect(env).toEqual({ MONO_AGENT_MEMORY_PATH: "/memory" });
    expect(memoryRecallSettingsFromEnv(env)).toEqual(ftsOnly);
  });

  it("resolves FTS-only settings from an env carrying only the memory path (F12)", () => {
    expect(memoryRecallSettingsFromEnv({ MONO_AGENT_MEMORY_PATH: "/memory" })).toEqual({ root: "/memory" });
  });
});

describe("memory_recall MCP tool (FTS, hermetic)", () => {
  it("answers a tools/call against a lite (FTS-only) store", async () => {
    // No embeddings → lite tier → FTS-only recall, so the test needs no Ollama/OpenAI.
    const store = createBujoMemoryStore({ root: dir });
    await store.appendHostSummary("conv-1", "The deploy pipeline uses blue-green releases on Fridays.");
    await store.appendHostSummary("conv-1", "Lunch preferences are irrelevant noise.");

    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["memory_recall"]);

      const result = (await client.callTool({
        name: "memory_recall",
        arguments: { query: "deploy pipeline releases" },
      })) as { content: Array<{ type: string; text: string }>; structuredContent?: { hits: Array<{ text: string }> } };

      const text = result.content.map((part) => part.text).join("\n");
      expect(text).toContain("blue-green releases");
      expect(result.structuredContent?.hits.some((hit) => hit.text.includes("blue-green releases"))).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("returns a no-match message when nothing matches", async () => {
    const store = createBujoMemoryStore({ root: dir });
    await store.appendHostSummary("conv-1", "An unrelated note about gardening.");
    const server = createMemoryRecallServer(store);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "memory_recall",
        arguments: { query: "quantum chromodynamics lattice gauge" },
      })) as { content: Array<{ type: string; text: string }>; structuredContent?: { hits: unknown[] } };
      expect(result.content[0]?.text).toMatch(/No memories matched/u);
      expect(result.structuredContent?.hits).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });
});

describe("createRecallStore", () => {
  it("builds an FTS-only store when settings carry no embeddings (F12)", async () => {
    // No embeddings → lite tier → FTS recall answers without any Ollama/OpenAI backend.
    const store = (await createRecallStore({ root: dir })) as unknown as BujoMemoryStore;
    try {
      expect(store.tier()).toBe("lite");
      await store.appendHostSummary("conv-1", "The deploy pipeline uses blue-green releases on Fridays.");
      const hits = await store.recall("deploy pipeline releases");
      expect(hits.some((hit) => hit.record.text.includes("blue-green releases"))).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("applies the embeddings timeout + circuit breaker so a dead backend fast-fails (F11)", async () => {
    // Unreachable endpoint + tiny timeout + a one-failure breaker: the first embed fails and trips
    // the breaker OPEN, so a subsequent recall fast-fails (no 30s hang, no inner provider call).
    const store = await createRecallStore({
      root: dir,
      embeddings: {
        provider: "ollama",
        model: "nomic-embed-text:v1.5",
        endpoint: "http://127.0.0.1:1",
        timeoutMs: 50,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      },
    }) as unknown as BujoMemoryStore;
    try {
      // First embed (during append) fails fast (timeout/refused) and opens the breaker.
      await expect(store.appendHostSummary("conv-1", "Anything that needs an embedding.")).rejects.toThrow();
      // With the breaker OPEN, recall fast-fails without re-hitting the dead backend.
      await expect(store.recall("anything")).rejects.toThrow(/circuit is open/u);
    } finally {
      await store.close();
    }
  });
});

function supermemoryConfig(overrides: {
  readonly recallEnabled?: boolean;
  readonly container?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly sourceId?: string;
}): MonoAgentConfig {
  return {
    memory: {
      backend: "supermemory",
      mode: "lite",
      path: "/memory",
      maxBytes: 64_000,
      writeMode: "capture",
      recallTool: { enabled: overrides.recallEnabled ?? true },
      supermemory: {
        baseUrl: "http://127.0.0.1:6767",
        ...(overrides.container === undefined ? {} : { container: overrides.container }),
        ...(overrides.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
        ...(overrides.apiKeyEnv === undefined ? {} : { apiKeyEnv: overrides.apiKeyEnv }),
      },
    },
    traceability: { registryDir: "/trace", ...(overrides.sourceId === undefined ? {} : { sourceId: overrides.sourceId }) },
  } as unknown as MonoAgentConfig;
}

describe("supermemory backend recall", () => {
  it("resolves supermemory recall settings with the container derived from the trace sourceId", () => {
    const settings = resolveMemoryRecallSettings(supermemoryConfig({ sourceId: "agent-alpha" }));
    expect(settings).toEqual({
      supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
    });
  });

  it("honors an explicit container over the trace identity", () => {
    const settings = resolveMemoryRecallSettings(supermemoryConfig({ sourceId: "agent-alpha", container: "custom" }));
    expect(settings).toEqual({
      supermemory: { baseUrl: "http://127.0.0.1:6767", container: "custom" },
    });
  });

  it("returns undefined when the recall tool is disabled", () => {
    expect(resolveMemoryRecallSettings(supermemoryConfig({ recallEnabled: false }))).toBeUndefined();
  });

  it("forwards the resolved apiKey VALUE into the child env and round-trips it (cross-runtime safe)", () => {
    // The loader already resolved any apiKeyEnv → apiKey, so recall forwards the value (not a name):
    // the stdio child does not inherit the parent's full env under every runtime.
    const settings: MemoryRecallSettings = {
      supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha", apiKey: "sm-secret", timeoutMs: 5_000 },
    };
    const env = memoryRecallMcpEnv(settings);
    expect(env.MONO_AGENT_MEMORY_BACKEND).toBe("supermemory");
    expect(env.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY).toBe("sm-secret");
    expect(memoryRecallSettingsFromEnv(env)).toEqual(settings);
  });

  it("round-trips a keyless (local, no-auth) supermemory recall config", () => {
    const keyless: MemoryRecallSettings = {
      supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
    };
    const env = memoryRecallMcpEnv(keyless);
    expect(env.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY).toBeUndefined();
    expect(memoryRecallSettingsFromEnv(env)).toEqual(keyless);
  });

  it("fails loud when the child env is missing the container (wiring bug, not a default)", () => {
    expect(() =>
      memoryRecallSettingsFromEnv({
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:6767",
      }),
    ).toThrow(/SUPERMEMORY_CONTAINER/);
  });

  it("builds a SupermemoryMemoryStore from supermemory settings", async () => {
    const store = await createRecallStore({ supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" } });
    expect(store).toBeInstanceOf(SupermemoryMemoryStore);
  });

  it("answers a tools/call against a recall-capable store (backend-agnostic server)", async () => {
    const fakeStore = {
      recall: async () => [{ score: 0.9, record: { id: "m1", text: "user prefers dark mode" } }],
      close: async () => {},
    };
    const server = createMemoryRecallServer(fakeStore);
    const client = new Client({ name: "memory-recall-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "memory_recall",
        arguments: { query: "preferences" },
      })) as { content: Array<{ type: string; text: string }>; structuredContent?: { hits: Array<{ text: string }> } };
      const text = result.content.map((part) => part.text).join("\n");
      expect(text).toContain("user prefers dark mode");
      expect(result.structuredContent?.hits[0]?.text).toBe("user prefers dark mode");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("MEMORY_RECALL_MCP_SERVER_NAME", () => {
  it("is the stable server name the app injects", () => {
    expect(MEMORY_RECALL_MCP_SERVER_NAME).toBe("mono-agent-memory");
  });
});
