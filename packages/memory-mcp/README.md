# @mono-agent/memory-mcp

## Category

Category: `context`

## Responsibility

MCP stdio server that exposes Mono Agent's long-term memory to the model as tools.
It composes `@mono-agent/memory-journal` and `@mono-agent/memory-graph` and
registers: `journal_append` (write a note into today's journal), `memory_read_day`
and `memory_list_days` (read older notes directly), `memory_grep` (keyword search
across the journal archive and entity graph), and `entity_get` / `entity_upsert`
(traverse and maintain the entity graph — the latter used by nightly
consolidation). Semantic search is layered on later via `@mono-agent/memory-search`.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory-mcp run build
```

Run as an MCP server (spawned by the runtime via the tool-policy `mcpServers`
config). It reads `MONO_AGENT_MEMORY_PATH` (memory root) and optional
`MONO_AGENT_MEMORY_GRAPH_PATH`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["packages/memory-mcp/dist/main.js"],
      "env": { "MONO_AGENT_MEMORY_PATH": "./.mono-agent/memory" }
    }
  }
}
```

```ts
import { createMemoryMcpServerFromConfig } from "@mono-agent/memory-mcp";
const server = createMemoryMcpServerFromConfig({ rootDir: "./.mono-agent/memory" });
```

## Public API

- `createMemoryMcpServer`, `createMemoryMcpServerFromConfig`, `createMemoryTools`
- `readDailyNote`, `listDailyNotes`, `grepMemory`, `isValidDay`
- `MemoryMcpDependencies`, `MemoryMcpConfig`, `MemoryTools`, `ToolResult`, `EntityUpsertArgs`, `GrepHit`

## Dependency Boundary

Depends on `@modelcontextprotocol/sdk` and `zod` for the tool surface, and on the
`@mono-agent/memory-journal` and `@mono-agent/memory-graph` context packages for
storage. It owns no storage format itself and performs no model calls; it is a thin
tool adapter over the memory stores.

## What This Package Does Not Own

It does not embed text, run semantic search, decide what to remember, schedule
consolidation, or build prompt context. Those belong to `@mono-agent/memory-search`,
the consolidation cron job, and `@mono-agent/context`.

## Verification

```bash
pnpm --filter @mono-agent/memory-mcp run build
pnpm --filter @mono-agent/memory-mcp run typecheck
pnpm --filter @mono-agent/memory-mcp run test
```
