import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import type { MonoAgentConfig } from "@mono-agent/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MEMORY_RECALL_MCP_SERVER_NAME,
  createMemoryRecallServer,
  memoryRecallMcpEnv,
  memoryRecallMcpServerSpec,
  memoryRecallSettingsFromEnv,
  resolveMemoryRecallSettings,
} from "../memory-recall.js";

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

  it("returns undefined when embeddings are absent even if enabled", () => {
    const settings = resolveMemoryRecallSettings(
      configWithMemory({
        mode: "lite",
        path: "/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        recallTool: { enabled: true },
      }),
    );
    expect(settings).toBeUndefined();
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

  it("rejects env missing required keys", () => {
    expect(() => memoryRecallSettingsFromEnv({ MONO_AGENT_MEMORY_PATH: "/memory" })).toThrow(/missing required environment/u);
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

describe("MEMORY_RECALL_MCP_SERVER_NAME", () => {
  it("is the stable server name the app injects", () => {
    expect(MEMORY_RECALL_MCP_SERVER_NAME).toBe("mono-agent-memory");
  });
});
