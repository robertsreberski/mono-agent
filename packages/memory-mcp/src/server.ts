import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createEntityGraphStore } from "@mono-agent/memory-graph";
import type { Entity, EntitySubgraph, JsonlEntityGraphStore, Relation } from "@mono-agent/memory-graph";
import { createJournalMemoryStore } from "@mono-agent/memory-journal";
import type { JournalMemoryStore } from "@mono-agent/memory-journal";
import { createEmbeddingProvider, createVectorMemoryIndex, gatherMemoryChunks } from "@mono-agent/memory-search";
import type { EmbeddingProviderConfig, SearchHit, VectorMemoryIndex } from "@mono-agent/memory-search";
import * as z from "zod/v4";

import { grepMemory, listDailyNotes, readDailyNote } from "./file-store.js";

export interface ToolResult {
  // Index signature mirrors the MCP SDK's CallToolResult so named results are assignable.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface MemoryMcpDependencies {
  readonly journal: JournalMemoryStore;
  readonly graph: JsonlEntityGraphStore;
  /** Memory root holding `daily/` and `monthly/` markdown, used by read/list/grep. */
  readonly rootDir: string;
  /** Optional semantic index; when absent, search degrades to keyword grep. */
  readonly search?: VectorMemoryIndex;
}

export interface MemoryMcpConfig {
  readonly rootDir: string;
  readonly graphPath?: string;
  readonly maxBytes?: number;
  /** Enables semantic search when provided. */
  readonly embeddings?: EmbeddingProviderConfig;
  readonly indexPath?: string;
}

export interface EntityUpsertArgs {
  entities?:
    | ReadonlyArray<{ name: string; entityType?: string | undefined; observations?: readonly string[] | undefined }>
    | undefined;
  relations?: readonly Relation[] | undefined;
}

export interface MemoryTools {
  journalAppend(args: { text: string }): Promise<ToolResult>;
  readDay(args: { date: string }): Promise<ToolResult>;
  listDays(): Promise<ToolResult>;
  grep(args: { query: string; limit?: number | undefined }): Promise<ToolResult>;
  search(args: { query: string; limit?: number | undefined }): Promise<ToolResult>;
  entityGet(args: { name: string; hops?: number | undefined }): Promise<ToolResult>;
  entityUpsert(args: EntityUpsertArgs): Promise<ToolResult>;
  reindex(): Promise<ToolResult>;
}

/** Pure tool logic, decoupled from MCP transport for direct testing. */
export function createMemoryTools(deps: MemoryMcpDependencies): MemoryTools {
  return {
    async journalAppend(args) {
      const result = await deps.journal.appendEntry(args.text);
      return textResult(`Journaled to ${result.source}.`, { source: result.source, bytesWritten: result.bytesWritten });
    },

    async readDay(args) {
      let content: string | undefined;
      try {
        content = await readDailyNote(deps.rootDir, args.date);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      if (content === undefined) {
        return textResult(`No journal note exists for ${args.date}.`);
      }
      return textResult(content, { date: args.date });
    },

    async listDays() {
      const days = await listDailyNotes(deps.rootDir);
      const text = days.length === 0 ? "No daily notes yet." : days.join("\n");
      return textResult(text, { days });
    },

    async grep(args) {
      return keywordSearch(deps, args.query, clampLimit(args.limit, 8));
    },

    async search(args) {
      const limit = clampLimit(args.limit, 8);
      if (deps.search !== undefined) {
        try {
          const hits = await deps.search.search(args.query, limit);
          if (hits.length > 0) {
            return textResult(renderSearchHits(hits), {
              mode: "semantic",
              hits: hits.map((hit) => ({ id: hit.id, source: hit.source, score: hit.score })),
            });
          }
        } catch {
          // Embeddings unavailable (e.g. Ollama down) — degrade to keyword search.
        }
      }
      return keywordSearch(deps, args.query, limit);
    },

    async entityGet(args) {
      const hops = clampLimit(args.hops, 1);
      const subgraph = await deps.graph.getSubgraph(args.name, hops);
      if (subgraph.entities.length === 0) {
        return textResult(`No entity named "${args.name}" is known.`);
      }
      return textResult(renderSubgraph(subgraph), subgraphToStructured(subgraph));
    },

    async entityUpsert(args) {
      const entities = args.entities ?? [];
      const relations = args.relations ?? [];
      const entityResult = entities.length === 0
        ? { entitiesUpserted: 0, observationsAdded: 0 }
        : await deps.graph.upsertEntities(entities.map(normalizeEntityUpsert));
      const relationResult = relations.length === 0
        ? { relationsUpserted: 0 }
        : await deps.graph.upsertRelations(relations);
      const summary = {
        entitiesUpserted: entityResult.entitiesUpserted,
        observationsAdded: entityResult.observationsAdded,
        relationsUpserted: relationResult.relationsUpserted,
      };
      return textResult(
        `Upserted ${summary.entitiesUpserted} entit${summary.entitiesUpserted === 1 ? "y" : "ies"}, ` +
          `${summary.observationsAdded} observation(s), ${summary.relationsUpserted} relation(s).`,
        summary,
      );
    },

    async reindex() {
      if (deps.search === undefined) {
        return textResult("Semantic search is not configured; nothing to reindex.");
      }
      const { entities } = await deps.graph.snapshot();
      const chunks = await gatherMemoryChunks(deps.rootDir, entities);
      const { indexed } = await deps.search.rebuild(chunks);
      return textResult(`Reindexed ${indexed} memory chunk(s).`, { indexed });
    },
  };
}

export function createMemoryMcpServer(deps: MemoryMcpDependencies): McpServer {
  const tools = createMemoryTools(deps);
  const server = new McpServer({ name: "mono-agent-memory", version: "0.1.0" });

  server.registerTool(
    "journal_append",
    {
      title: "Append to today's journal",
      description: "Record a noteworthy fact, decision, or reflection into today's global daily journal note.",
      inputSchema: { text: z.string().min(1).describe("The note to journal (markdown).") },
    },
    async (args) => tools.journalAppend(args),
  );

  server.registerTool(
    "memory_read_day",
    {
      title: "Read a day's journal note",
      description: "Read the full journal note for a specific day (YYYY-MM-DD).",
      inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).describe("Day to read, YYYY-MM-DD.") },
    },
    async (args) => tools.readDay(args),
  );

  server.registerTool(
    "memory_list_days",
    {
      title: "List journal days",
      description: "List the days that have a journal note, oldest first.",
      inputSchema: {},
    },
    async () => tools.listDays(),
  );

  server.registerTool(
    "memory_grep",
    {
      title: "Keyword-search memory",
      description: "Keyword search across the journal archive and the entity graph. Use for recalling older context.",
      inputSchema: {
        query: z.string().min(1).describe("Keywords to search for."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 8)."),
      },
    },
    async (args) => tools.grep(args),
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memory (semantic)",
      description: "Semantically search older memory by meaning, falling back to keyword search. Prefer this for recall.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language description of what to recall."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 8)."),
      },
    },
    async (args) => tools.search(args),
  );

  server.registerTool(
    "entity_get",
    {
      title: "Get an entity",
      description: "Fetch an entity and its connected subgraph (people, projects, topics, decisions, events).",
      inputSchema: {
        name: z.string().min(1).describe("Entity name."),
        hops: z.number().int().min(0).max(3).optional().describe("Relation hops to expand (default 1)."),
      },
    },
    async (args) => tools.entityGet(args),
  );

  server.registerTool(
    "entity_upsert",
    {
      title: "Upsert entities and relations",
      description: "Create or merge entities (with observations) and relations in the long-term memory graph.",
      inputSchema: {
        entities: z
          .array(z.object({
            name: z.string().min(1),
            entityType: z.string().min(1).optional(),
            observations: z.array(z.string()).optional(),
          }))
          .optional()
          .describe("Entities to create or merge."),
        relations: z
          .array(z.object({ from: z.string().min(1), to: z.string().min(1), relationType: z.string().min(1) }))
          .optional()
          .describe("Directed relations between entities."),
      },
    },
    async (args) => tools.entityUpsert(args),
  );

  server.registerTool(
    "memory_reindex",
    {
      title: "Rebuild the semantic index",
      description: "Rebuild the embedding index from the journal archive and entity graph (run after consolidating).",
      inputSchema: {},
    },
    async () => tools.reindex(),
  );

  return server;
}

export function createMemoryMcpServerFromConfig(config: MemoryMcpConfig): McpServer {
  const journal = createJournalMemoryStore({ rootDir: config.rootDir, maxBytes: config.maxBytes ?? 64_000 });
  const graph = createEntityGraphStore({ path: config.graphPath ?? join(config.rootDir, "graph.jsonl") });
  const search = config.embeddings === undefined
    ? undefined
    : createVectorMemoryIndex({
        path: config.indexPath ?? join(config.rootDir, "index", "embeddings.jsonl"),
        embeddings: createEmbeddingProvider(config.embeddings),
      });
  return createMemoryMcpServer({ journal, graph, rootDir: config.rootDir, ...(search === undefined ? {} : { search }) });
}

function normalizeEntityUpsert(entity: {
  name: string;
  entityType?: string | undefined;
  observations?: readonly string[] | undefined;
}): {
  name: string;
  entityType?: string;
  observations?: readonly string[];
} {
  return {
    name: entity.name,
    ...(entity.entityType === undefined ? {} : { entityType: entity.entityType }),
    ...(entity.observations === undefined ? {} : { observations: entity.observations }),
  };
}

async function keywordSearch(deps: MemoryMcpDependencies, query: string, limit: number): Promise<ToolResult> {
  const fileHits = await grepMemory(deps.rootDir, query, limit);
  const entityHits = await deps.graph.search(query, limit);
  return textResult(renderGrep(fileHits, entityHits), {
    mode: "keyword",
    fileHits: fileHits.map((hit) => ({ source: hit.source, score: hit.score })),
    entities: entityHits.map((entity) => entity.name),
  });
}

function renderSearchHits(hits: readonly SearchHit[]): string {
  return hits
    .map((hit) => {
      const day = hit.day === undefined ? "" : ` (${hit.day})`;
      return `### ${hit.source}${day} — score ${hit.score.toFixed(2)}\n${hit.text}`;
    })
    .join("\n\n");
}

function renderGrep(fileHits: ReadonlyArray<{ source: string; snippet: string }>, entities: readonly Entity[]): string {
  const blocks: string[] = [];
  if (entities.length > 0) {
    blocks.push(`### Entities\n${entities.map((e) => `- ${e.name} (${e.entityType})`).join("\n")}`);
  }
  if (fileHits.length > 0) {
    blocks.push(fileHits.map((hit) => `### ${hit.source}\n${hit.snippet}`).join("\n\n"));
  }
  return blocks.length === 0 ? "No matches found." : blocks.join("\n\n");
}

function renderSubgraph(subgraph: EntitySubgraph): string {
  const entityLines = subgraph.entities.map((entity) => {
    const facts = entity.observations.length === 0 ? "" : `\n  ${entity.observations.map((o) => `- ${o}`).join("\n  ")}`;
    return `- ${entity.name} (${entity.entityType})${facts}`;
  });
  const relationLines = subgraph.relations.map((r) => `- ${r.from} —[${r.relationType}]→ ${r.to}`);
  const blocks = [`### Entities\n${entityLines.join("\n")}`];
  if (relationLines.length > 0) {
    blocks.push(`### Relations\n${relationLines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

function subgraphToStructured(subgraph: EntitySubgraph): Record<string, unknown> {
  return {
    entities: subgraph.entities.map((e) => ({ name: e.name, entityType: e.entityType, observations: e.observations })),
    relations: subgraph.relations.map((r) => ({ from: r.from, to: r.to, relationType: r.relationType })),
  };
}

function clampLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function textResult(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return structuredContent === undefined
    ? { content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }], structuredContent };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
