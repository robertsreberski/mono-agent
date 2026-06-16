# @mono-agent/memory-mcp

## Category

Category: `context`

## Responsibility

MCP stdio server exposing the Bullet-Journal memory engine. Provides three tools — `memory_recall`, `memory_capture`, and `memory_note` — backed by the SQLite substrate. Replaces the retired v1 `memory.tools` config mechanism.

## Install / Usage

```bash
# Build first
pnpm --filter @mono-agent/memory-mcp run build

# Run the stdio server (required: MONO_AGENT_MEMORY_PATH)
MONO_AGENT_MEMORY_PATH=./memory memory-mcp
```

```ts
import { resolveMemoryMcpMainPath } from "@mono-agent/memory-mcp";
```

## Public API

- `resolveMemoryMcpMainPath()` — returns the absolute path to the compiled `main.js` stdio entry point.

## Dependency Boundary

Depends on `@mono-agent/memory-bujo` (BuJo engine + store), `@mono-agent/memory-search` (embedding provider config), and `@mono-agent/memory-store` (MemoryStore contract). External: `@modelcontextprotocol/sdk`, `zod`.

## What This Package Does Not Own

It does not own the SQLite substrate (that is `memory-store`), the BuJo engine (that is `memory-bujo`), or embedding implementations (that is `memory-search`). It does not own agent harness integration — that is `agent-host`.

## Verification

```bash
pnpm --filter @mono-agent/memory-mcp run typecheck
pnpm --filter @mono-agent/memory-mcp run test
```
