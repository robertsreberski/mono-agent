# @mono-agent/memory-graph

## Category

Category: `context`

## Responsibility

Local, file-first entity knowledge graph for long-term memory. It
stores entities, relations, and observations as JSON Lines using the official MCP
memory-server shape (`{type:"entity",name,entityType,observations}` /
`{type:"relation",from,to,relationType}`), holds the graph in memory, and rewrites
it atomically on each mutation. It supports create-or-merge upserts with
name-normalized dedup, cascade delete, bounded breadth-first traversal, keyword
search, and a salience-ranked digest for always-in-context recall.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory-graph run build
```

```ts
import { createEntityGraphStore } from "@mono-agent/memory-graph";

const graph = createEntityGraphStore({ path: "./.mono-agent/memory/graph.jsonl" });
await graph.upsertEntities([{ name: "Example Person", entityType: "person", observations: ["prefers concise answers"] }]);
const subgraph = await graph.getSubgraph("Example Person", 1);
```

## Public API

- `createEntityGraphStore`, `JsonlEntityGraphStore`
- `normalizeName`
- `EntityGraphError`
- `Entity`, `Relation`, `EntitySubgraph`, `EntityUpsert`, `EntityGraphStoreOptions`, `EntityGraphMutationResult`, `EntityGraphErrorCode`

## Dependency Boundary

This package depends only on the local filesystem. It has no model, network, or
database dependencies. Entity extraction (deciding what to upsert) is performed by
the host/agent during consolidation, not by this package.

## What This Package Does Not Own

It does not extract entities from text, call a model, embed or semantically rank,
journal daily notes, or expose MCP tools. Those belong to the consolidation job,
`@mono-agent/memory-search`, `@mono-agent/memory-journal`, and
`@mono-agent/memory-mcp`.

## Verification

```bash
pnpm --filter @mono-agent/memory-graph run build
pnpm --filter @mono-agent/memory-graph run typecheck
pnpm --filter @mono-agent/memory-graph run test
```
