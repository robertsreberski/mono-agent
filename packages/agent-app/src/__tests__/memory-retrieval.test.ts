import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MemoryWriteResult } from "@mono-agent/agent-contracts";
import { createAgentHarness } from "@mono-agent/agent-harness";
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
      if (query.includes("launch color")) {
        return [
          { score: 1.005, record: { id: "answer", text: "Morgan selected cobalt as the launch color." } },
          { score: 0.751, record: { id: "adjacent", text: "Morgan's office is in Amsterdam." } },
          { score: 0.708, record: { id: "other", text: "The launch date is 2026-08-14." } },
        ];
      }
      return Array.from({ length: 12 }, (_, index) => ({
        score: 0.95 - index * 0.01,
        record: {
          id: `hit-${index}`,
          text: `Morgan selected cobalt-${index} as the deployment color.`,
          type: "task" as const,
          status: index === 0 ? "done" as const : "open" as const,
          isInsight: index === 0,
        },
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

    const block = await service.load("conversation", "  What deployment color\ndid Morgan select?  ", { turnId: "turn-1" });
    const hits = await service.recallForTurn("turn-1", "what deployment color did morgan select?", { topK: 8 });
    await service.recallForTurn("turn-1", "different query", { topK: 8 });

    expect(block).toBeDefined();
    expect(block?.content.match(/deployment color/gu)).toHaveLength(5);
    expect(block?.content).toContain("- [x] Morgan selected cobalt-0 as the deployment color. *");
    expect(Buffer.byteLength(block?.content ?? "", "utf8")).toBeLessThanOrEqual(8_000);
    expect(hits).toHaveLength(8);
    expect(store.queries).toEqual(["what deployment color did morgan select?", "different query"]);
    expect(store.accesses.flat()).toEqual([
      "hit-0", "hit-1", "hit-2", "hit-3", "hit-4", "hit-5", "hit-6", "hit-7",
    ]);
  });

  it("abstains from automatic injection below the confidence floor", async () => {
    const service = new MemoryRetrievalService(fakeStore());
    await expect(service.load("conversation", "unrelated topic", { turnId: "turn-2" })).resolves.toBeUndefined();
  });

  it("drops high-similarity adjacent results outside the top-relative confidence band", async () => {
    const service = new MemoryRetrievalService(fakeStore());
    const block = await service.load("conversation", "What launch color did Morgan select?", { turnId: "turn-calibrated" });
    expect(block?.content).toContain("selected cobalt as the launch color");
    expect(block?.content).not.toContain("office");
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
  it("does not query the configured backend for the exact Telegram last-message question", async () => {
    const store = fakeStore();
    const service = new MemoryRetrievalService(store);
    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-last-message" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({
        name: "MemoryRecall",
        arguments: { query: "What did you send in the last message?" },
      });
      expect(result.structuredContent).toMatchObject({ hits: [], conversationRelative: true });
      expect(store.queries).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup();
    }
  });

  it("keeps graph expansion explicit-only while reusing one raw backend lookup", async () => {
    const store = fakeStore();
    let expansionCalls = 0;
    store.recall = async (query) => {
      store.queries.push(query);
      return [
        { score: 1, record: { id: "seed", text: "Taylor joined the Atlas project." } },
        ...Array.from({ length: 8 }, (_, index) => ({
          score: 0.9 - index * 0.01,
          record: { id: `distractor-${index}`, text: `Unrelated planning note ${index}.` },
        })),
        { score: 0.1, record: { id: "graph-target", text: "Morgan manages Taylor and uses cobalt." } },
      ];
    };
    store.expandGraph = (_query, direct, options) => {
      expansionCalls += 1;
      const target = direct.find((hit) => hit.record.id === "graph-target");
      return target === undefined
        ? direct.slice(0, options?.topK ?? 8)
        : [target, ...direct.filter((hit) => hit.record.id !== target.record.id)].slice(0, options?.topK ?? 8);
    };
    const service = new MemoryRetrievalService(store);
    const query = "Who manages Taylor?";
    await expect(service.load("conversation", query, { turnId: "turn-graph" })).resolves.toBeUndefined();

    const extension = await createSharedMemoryRecallRuntimeExtension(service)({ runId: "turn-graph" });
    const spec = extension.runtimeOptions.mcpServers["mono-agent-memory"] as { url: string };
    const client = new Client({ name: "memory-retrieval-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({ name: "MemoryRecall", arguments: { query, limit: 5 } });
      expect(result.structuredContent).toMatchObject({
        hits: expect.arrayContaining([expect.objectContaining({ id: "graph-target" })]),
      });
      const servedIds = (result.structuredContent as { hits: Array<{ id: string }> }).hits.map((hit) => hit.id);
      expect(store.queries).toEqual(["who manages taylor?"]);
      expect(expansionCalls).toBe(1);
      expect(store.accesses).toEqual([servedIds]);
      expect(servedIds).not.toContain("distractor-7");
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup();
    }
  });

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

  it("omits the tool and reports degradation when its loopback endpoint cannot start", async () => {
    const warnings: unknown[] = [];
    const service = new MemoryRetrievalService(fakeStore());
    const extension = await createSharedMemoryRecallRuntimeExtension(service, {
      listen: async () => { throw new Error("loopback unavailable"); },
      onUnavailable: (error) => { warnings.push(error); },
    })({ runId: "turn-startup-fail" });

    expect(extension.runtimeOptions.mcpServers).toEqual({});
    expect(warnings).toEqual([expect.objectContaining({ message: "loopback unavailable" })]);
    await expect(extension.cleanup()).resolves.toBeUndefined();
  });

  it("continues the provider turn when the loopback endpoint cannot start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-retrieval-"));
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const warnings: unknown[] = [];
    const seenMcpServers: unknown[] = [];
    try {
      const service = new MemoryRetrievalService(fakeStore());
      const harness = createAgentHarness({
        identityPath,
        model: {
          sdk: "pi",
          provider: "openai-codex",
          model: "gpt-5.5",
          reference: "pi:openai-codex:gpt-5.5",
        },
        runtime: {
          async run(_prompt, options) {
            seenMcpServers.push(options.mcpServers);
            return { text: "provider still ran" };
          },
        },
        runtimeOptionsForRequest: createSharedMemoryRecallRuntimeExtension(service, {
          listen: async () => { throw new Error("loopback unavailable"); },
          onUnavailable: (error) => { warnings.push(error); },
        }),
      });

      const response = await harness.run({
        conversationId: "turn-startup-degraded",
        userMessage: "hello",
        abortSignal: new AbortController().signal,
      });
      expect(response.text).toBe("provider still ran");
      expect(response.failure).toBeUndefined();
      expect(seenMcpServers).toEqual([{}]);
      expect(warnings).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("releases the shared turn cache before admitting another run after an abort-ignoring provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-retrieval-abort-"));
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const releases: Array<() => void> = [];
    let runtimeCalls = 0;
    try {
      const service = new MemoryRetrievalService(fakeStore());
      const activeTurnCount = (): number => (service as unknown as { turns: Map<string, unknown> }).turns.size;
      const harness = createAgentHarness({
        identityPath,
        model: {
          sdk: "pi",
          provider: "openai-codex",
          model: "gpt-5.5",
          reference: "pi:openai-codex:gpt-5.5",
        },
        runtime: {
          async run() {
            runtimeCalls += 1;
            await new Promise<void>((resolve) => { releases.push(resolve); });
            return { text: "late provider answer" };
          },
        },
        memory: service,
        concurrency: { maxConcurrentRuns: 1 },
        runtimeOptionsForRequest: createSharedMemoryRecallRuntimeExtension(service),
      });

      const zombies: Array<Promise<unknown>> = [];
      for (let index = 0; index < 3; index += 1) {
        const abort = new AbortController();
        zombies.push(harness.run({
          conversationId: `zombie-${index}`,
          userMessage: "deploy pipeline",
          abortSignal: abort.signal,
        }));
        for (let attempt = 0; attempt < 40 && runtimeCalls <= index; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(runtimeCalls).toBe(index + 1);
        expect(activeTurnCount()).toBe(1);
        abort.abort(new Error("cancelled"));
        for (let attempt = 0; attempt < 40 && activeTurnCount() !== 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(activeTurnCount()).toBe(0);
      }

      for (const release of releases) release();
      await expect(Promise.all(zombies)).resolves.toEqual(
        Array.from({ length: 3 }, () => expect.objectContaining({
          failure: expect.objectContaining({ kind: "cancelled" }),
        })),
      );
      expect(activeTurnCount()).toBe(0);
    } finally {
      for (const release of releases) release();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
