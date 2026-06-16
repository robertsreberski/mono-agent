# @mono-agent/memory-mcp

## Category

Category: `context`

## Responsibility

MCP **stdio** server exposing the Bullet-Journal memory engine to any MCP client (Claude Code, the agent itself, another tool). It surfaces three tools backed by the SQLite substrate, and is the v2 replacement for the retired v1 `memory.tools` config mechanism.

| Tool | Input | Does | Tier |
|------|-------|------|------|
| `memory_recall` | `{ query, limit? }` | Hybrid (keyword + semantic) search over long-term memory. Read-only. | all (FTS at minimum; embeddings improve ranking) |
| `memory_capture` | `{ text }` | Intelligent store: distil → reconcile (ADD/UPDATE/SUPERSEDE/NOOP) → extract entities. | **bujo only** — returns an explicit error result when the store has no chat LLM |
| `memory_note` | `{ text }` | Quick deterministic rapid-log append to today's daily file. No LLM. | all |

Rituals (reflection / migration) are intentionally **not** exposed as tools — they stay scheduled (in-app or via the `memory-bujo` CLI).

## Install / Usage

The server reads its configuration from the environment (the same `MONO_AGENT_MEMORY_*` vars the agent and the `memory-bujo` CLI use), so pointing a client at it means running the `memory-mcp` bin in an environment with at least `MONO_AGENT_MEMORY_PATH` set.

```bash
pnpm --filter @mono-agent/memory-mcp run build

# Minimal (recall ranks by FTS; capture will report it needs the bujo tier):
MONO_AGENT_MEMORY_PATH=./.mono-agent/memory memory-mcp

# Full bujo tier (semantic recall + intelligent capture):
MONO_AGENT_MEMORY_PATH=./.mono-agent/memory \
MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER=ollama \
MONO_AGENT_MEMORY_EMBEDDINGS_MODEL=nomic-embed-text:v1.5 \
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest \
memory-mcp
```

### Environment

| Var | Required | Effect |
|-----|----------|--------|
| `MONO_AGENT_MEMORY_PATH` | yes | Memory root (holds the daily markdown + `memory.db`). |
| `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` / `_MODEL` / `_ENDPOINT` / `_API_KEY` | no | Enables semantic recall ranking. Without it, `memory_recall` falls back to FTS keyword search. |
| `MONO_AGENT_MEMORY_LLM_MODEL` / `_ENDPOINT` | for `memory_capture` | Ollama chat model for the intelligent capture pipeline. Absent → `memory_capture` returns an explicit "requires the bujo tier" error. |

Register it with an MCP client as a stdio server whose command is the `memory-mcp` bin (or `node <dist>/main.js`). Stdout is the MCP channel; diagnostics go to stderr.

## Public API

- `createMemoryTools(deps)` — the pure tool logic (`recall` / `capture` / `note`) over a `BujoMemoryStore`, decoupled from MCP transport (directly unit-testable).
- `createMemoryMcpServer(deps)` — an `McpServer` with the three tools registered.
- `createMemoryMcpServerFromConfig(config)` — builds the backing `BujoMemoryStore` (embeddings + optional Ollama LLM) and returns `{ server, store }` so the caller can close the store.
- `resolveMemoryMcpMainPath()` — absolute path to the compiled `main.js` stdio entry (for spawning).

## Dependency Boundary

Depends on `@mono-agent/memory-bujo` (BuJo engine + `BujoMemoryStore`), `@mono-agent/memory-search` (embedding-provider config), and `@mono-agent/memory-store` (the `MemoryStore` contract + `RecallHit`). External: `@modelcontextprotocol/sdk`, `zod`.

Concurrency: the server opens its own `memory.db` handle. The substrate uses WAL (concurrent readers + one writer) and better-sqlite3's 5000 ms `busy_timeout`, so a second writer (this server running next to a live agent) retries on a locked db instead of throwing `SQLITE_BUSY`. On `SIGINT`/`SIGTERM` the server drains the capture queue (`store.close()` flushes) before exiting.

## What This Package Does Not Own

It does not own the SQLite substrate (`memory-store`), the BuJo engine (`memory-bujo`), or embedding implementations (`memory-search`). It does not own per-turn agent memory writes — that is the harness (`memory.writeMode`) wired by `agent-host`/`agent-app`.

## Verification

```bash
pnpm --filter @mono-agent/memory-mcp run typecheck
pnpm --filter @mono-agent/memory-mcp run test
pnpm --filter @mono-agent/memory-mcp run build
```
