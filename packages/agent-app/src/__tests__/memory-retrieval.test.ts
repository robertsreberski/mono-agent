import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MemoryWriteResult } from "@mono-agent/agent-contracts";
import { describe, expect, it } from "vitest";

import {
  createSharedMemoryRecallRuntimeExtension,
  MemoryRetrievalService,
  normalizeMemoryRecallQuery,
  type SharedRecallStore,
} from "../memory-retrieval.js";

function fakeStore(options: { readonly fail?: boolean } = {}): SharedRecallStore & { readonly queries: string[]; readonly accesses: string[][] } {
  const queries: string[] = [];
  const accesses: string[][] = [];
  return {
    queries,
    accesses,
    async load() { return undefined; },
    async recall(query) {
      queries.push(query);
      if (options.fail) throw new Error("embedding endpoint offline");
      if (query.includes("unrelated")) {
        return [{ score: 0.05, record: { id: "low", text: "low confidence neighbour" } }];
      }
      return Array.from({ length: 12 }, (_, index) => ({
        score: 0.95 - index * 0.01,
        record: { id: `hit-${index}`, text: `Relevant memory ${index}` },
      }));
    },
    recordAccess(ids) { accesses.push([...ids]); },
    async appendHostSummary(conversationId): Promise<MemoryWriteResult> {
      return { conversationId, source: "fake", bytesWritten: 0 };
    },
    async close() {},
  };
}

describe("MemoryRetrievalService", () => {
  it("shares one normalized backend lookup between automatic and tool recall in a turn", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);

    const block = await service.load("conversation", "  DEPLOY\n pipeline  ", { turnId: "turn-1" });
    const hits = await service.recallForTurn("turn-1", "deploy pipeline", { topK: 8 });
    await service.recallForTurn("turn-1", "different query", { topK: 8 });

    expect(block).toBeDefined();
    expect(block?.content.match(/Relevant memory/gu)).toHaveLength(5);
    expect(Buffer.byteLength(block?.content ?? "", "utf8")).toBeLessThanOrEqual(8_000);
    expect(hits).toHaveLength(8);
    expect(store.queries).toEqual(["deploy pipeline", "different query"]);
    expect(store.accesses.flat()).toEqual([
      "hit-0", "hit-1", "hit-2", "hit-3", "hit-4", "hit-5", "hit-6", "hit-7",
    ]);
  });

  it("abstains from automatic injection below the confidence floor", async () => {
    const service = new MemoryRetrievalService(fakeStore());
    await expect(service.load("conversation", "unrelated topic", { turnId: "turn-2" })).resolves.toBeUndefined();
  });

  it("normalizes Unicode, case, and whitespace deterministically", () => {
    expect(normalizeMemoryRecallQuery("  ＤEPLOY\n\tPipeline  ")).toBe("deploy pipeline");
  });

  it("drops the query cache when the logical turn is released", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);
    await service.load("conversation", "deploy pipeline", { turnId: "turn-release" });
    service.releaseTurn("turn-release");
    await service.recallForTurn("turn-release", "deploy pipeline");
    expect(store.queries).toEqual(["deploy pipeline", "deploy pipeline"]);
  });
});

describe("shared MemoryRecall MCP", () => {
  it("serves the shared store over a per-turn loopback endpoint", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);
    await service.load("conversation", "deploy pipeline", { turnId: "turn-http" });
    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-http" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["MemoryRecall"]);
      const result = await client.callTool({ name: "MemoryRecall", arguments: { query: " DEPLOY pipeline ", limit: 8 } });
      expect(result.structuredContent).toMatchObject({ hits: expect.any(Array) });
      expect(store.queries).toEqual(["deploy pipeline"]);
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup();
    }
  });

  it("reports backend failure as an honest degraded tool result", async () => {
    const service = new MemoryRetrievalService(fakeStore({ fail: true }));
    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-fail" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({ name: "MemoryRecall", arguments: { query: "deploy" } });
      expect(result.structuredContent).toMatchObject({ hits: [], degraded: true });
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("temporarily unavailable") }),
      ]));
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup();
    }
  });
});
