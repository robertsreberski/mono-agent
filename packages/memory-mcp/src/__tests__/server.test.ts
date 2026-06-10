import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntityGraphStore } from "@mono-agent/memory-graph";
import { createJournalMemoryStore, journalDayFor } from "@mono-agent/memory-journal";
import { createVectorMemoryIndex } from "@mono-agent/memory-search";
import type { EmbeddingProvider } from "@mono-agent/memory-search";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryMcpServer, createMemoryTools, grepMemory } from "../index.js";

const stubEmbeddings: EmbeddingProvider = {
  id: "stub",
  async embed(texts) {
    return texts.map(() => [1, 0, 0]);
  },
};

const tempDirs: string[] = [];

async function deps() {
  const root = await mkdtemp(join(tmpdir(), "memory-mcp-test-"));
  tempDirs.push(root);
  return {
    rootDir: root,
    journal: createJournalMemoryStore({ rootDir: root, maxBytes: 64_000 }),
    graph: createEntityGraphStore({ path: join(root, "graph.jsonl") }),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("memory MCP tools", () => {
  it("journals and reads back today's note", async () => {
    const tools = createMemoryTools(await deps());
    const append = await tools.journalAppend({ text: "Robert prefers concise answers." });
    expect(append.isError).toBeUndefined();

    const today = journalDayFor(new Date());
    const read = await tools.readDay({ date: today });
    expect(read.content[0]?.text).toContain("Robert prefers concise answers.");

    const list = await tools.listDays();
    expect((list.structuredContent?.days as string[]).includes(today)).toBe(true);
  });

  it("rejects malformed dates without touching the filesystem", async () => {
    const tools = createMemoryTools(await deps());
    const read = await tools.readDay({ date: "../etc/passwd" });
    expect(read.isError).toBe(true);
    expect(read.content[0]?.text).toMatch(/YYYY-MM-DD/u);
  });

  it("upserts entities and relations and reads the subgraph back", async () => {
    const tools = createMemoryTools(await deps());
    const upsert = await tools.entityUpsert({
      entities: [{ name: "Robert", entityType: "person", observations: ["leads mono-agent"] }],
      relations: [{ from: "Robert", to: "mono-agent", relationType: "works on" }],
    });
    expect(upsert.structuredContent).toMatchObject({ entitiesUpserted: 1, relationsUpserted: 1 });

    const get = await tools.entityGet({ name: "Robert", hops: 1 });
    expect(get.content[0]?.text).toContain("Robert (person)");
    expect(get.content[0]?.text).toContain("works on");
    const structured = get.structuredContent as { entities: Array<{ name: string }> };
    expect(structured.entities.map((e) => e.name).sort()).toEqual(["Robert", "mono-agent"]);
  });

  it("keyword-greps across the journal archive and the entity graph", async () => {
    const d = await deps();
    const tools = createMemoryTools(d);
    await tools.journalAppend({ text: "Discussed the pricing migration in detail." });
    await tools.entityUpsert({ entities: [{ name: "Pricing migration", entityType: "project", observations: ["due Q3"] }] });

    const grep = await tools.grep({ query: "pricing migration" });
    expect(grep.content[0]?.text).toContain("Pricing migration (project)");
    expect(grep.content[0]?.text.toLowerCase()).toContain("pricing migration");
  });

  it("scores sections by distinct query tokens, ignoring duplicates", async () => {
    const d = await deps();
    const tools = createMemoryTools(d);
    await tools.journalAppend({ text: "Discussed the pricing migration in detail." });

    const [single] = await grepMemory(d.rootDir, "pricing");
    const [duplicated] = await grepMemory(d.rootDir, "pricing pricing");
    expect(single?.score).toBe(1);
    expect(duplicated?.score).toBe(1);
  });

  it("returns a friendly message for unknown entities", async () => {
    const tools = createMemoryTools(await deps());
    const get = await tools.entityGet({ name: "Nobody" });
    expect(get.content[0]?.text).toContain('No entity named "Nobody"');
  });

  it("uses the semantic index for search when present", async () => {
    const base = await deps();
    const tools = createMemoryTools({
      ...base,
      search: {
        async search() {
          return [{ id: "a", source: "daily/2026-06-09.md", text: "Robert likes short replies.", score: 0.71, day: "2026-06-09" }];
        },
        async rebuild() {
          return { indexed: 0 };
        },
        async size() {
          return 1;
        },
      } as never,
    });

    const result = await tools.search({ query: "communication preferences" });
    expect(result.structuredContent?.mode).toBe("semantic");
    expect(result.content[0]?.text).toContain("Robert likes short replies.");
  });

  it("falls back to keyword search when the semantic index throws", async () => {
    const base = await deps();
    await base.journal.appendEntry("Reviewed the billing migration plan.");
    const tools = createMemoryTools({
      ...base,
      search: {
        async search() {
          throw new Error("ollama down");
        },
        async rebuild() {
          return { indexed: 0 };
        },
        async size() {
          return 0;
        },
      } as never,
    });

    const result = await tools.search({ query: "billing migration" });
    expect(result.structuredContent?.mode).toBe("keyword");
    expect(result.content[0]?.text.toLowerCase()).toContain("billing migration");
  });

  it("reindexes the journal archive and entity graph into the semantic index", async () => {
    const base = await deps();
    await base.journal.appendEntry("Talked through the pricing migration.");
    await base.graph.upsertEntities([{ name: "Pricing", entityType: "project", observations: ["due Q3"] }]);
    const search = createVectorMemoryIndex({ path: join(base.rootDir, "index", "embeddings.jsonl"), embeddings: stubEmbeddings });
    const tools = createMemoryTools({ ...base, search });

    const result = await tools.reindex();
    expect(result.structuredContent?.indexed as number).toBeGreaterThan(0);
    expect(await search.size()).toBeGreaterThan(0);
  });

  it("reports when reindex is called without a configured index", async () => {
    const tools = createMemoryTools(await deps());
    const result = await tools.reindex();
    expect(result.content[0]?.text).toContain("not configured");
  });

  it("builds an MCP server without throwing", async () => {
    const server = createMemoryMcpServer(await deps());
    expect(server).toBeDefined();
  });
});
