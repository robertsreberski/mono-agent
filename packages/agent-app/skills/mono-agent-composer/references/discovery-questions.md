# Discovery Questions

Use this sequence to fill `mono-agent.config.json` before running anything. Ask one question at a time. Skip questions whose answer is already explicit in the user's request. Each answer maps to concrete config keys.

## 1. Runtime And Backup Models

Question:

```text
Which model should drive the agent, and should any backups take over when the provider fails?

1. `claude:<model>` through SDK or CLI mode
2. `codex:<model>` through CLI mode
3. `pi:<provider>:<model>` through SDK mode (OpenAI, Copilot, OpenRouter, local Ollama, ...)
4. A custom MonoRuntimeLike supplied programmatically (escape hatch)
```

Fills: `runtime.model`, `runtime.fallbackModels` (ordered backup references tried on retryable provider failures), `runtime.executionMode` (usually inferred), `runtime.effort`, `runtime.maxTurns`.

For local models also fill `providers.local` (e.g. an Ollama base URL plus model capabilities). Follow-up only if needed: continuous provider session per conversation (`runtime.session.mode: "continuous"`, default) versus stateless per-message.

## 2. Channels Of Communication

Question:

```text
Where should people (or other agents) reach this agent? Pick every channel that applies:

1. Webhook (HTTP POST, zero credentials — good first smoke test)
2. OpenAI-compatible API (OpenWebUI and other API clients)
3. Telegram
4. Slack
5. WhatsApp
6. A2A (agent-to-agent provider/consumer)
7. Cron (scheduled prompts, no inbound channel)
```

Fills one config section per choice: `webhook`, `openaiApi`, `telegram`, `slack`, `whatsapp`, `a2a`, `cron`. Channels are independent: an unconfigured channel reports `waiting_for_config` and never blocks the others. For chat channels collect tokens and allowlists (chat IDs, channel IDs, JIDs). For HTTP channels collect host/port/path and whether non-loopback binding is allowed (default: loopback only).

## 3. Identity And Existing Knowledge

Question:

```text
What is this agent's role, and does this folder already contain knowledge it must respect?
```

Fills: `context.identityPath` (default `./IDENTITY.md`), optional `context.soulPath`, `runtime.workspace`. `mono-agent init` detects `AGENTS.md`, `CLAUDE.md`, `README.md`, and `SOUL.md` and references them from the generated identity — keep those references rather than copying content.

## 4. Skills

Question:

```text
Should this agent load selected skills?

1. Yes, from a `skills/` directory in this folder
2. Yes, from an external skills directory
3. No selected skills for the first pass
```

Fills: `context.skillsRoot`, `context.selectedSkills`, optionally `context.skillMaxBytes` (per-skill byte cap, default 48000). Skill discovery loads immediate child directories only: `<skillsRoot>/<skill-name>/SKILL.md`. Skill files may carry YAML frontmatter (Claude Code style); the description is the first prose paragraph after it.

## 5. Tools And MCP Servers

Question:

```text
What tools or MCP servers does the agent actually need?

1. No tools yet; fail closed (recommended)
2. A small allowlist of built-in tools
3. MCP servers from an mcp.json config file
4. Both
```

Fills: `tools.allowedTools`, `tools.disallowedTools` (denylist wins), `tools.mcpConfigPath`. Record exact tool names; do not broaden access as a convenience.

## 6. Memory Strategy

Question:

```text
Should the agent remember anything between conversations?

1. No durable memory yet (recommended for first integration)
2. Markdown memory file (read into context; optional host summaries appended)
3. Journal memory (daily notes + entity graph, optional MCP recall tools)
4. Journal memory with semantic search (adds an embedding index for memory_search)
```

Fills: the `memory` section — `mode` (`markdown`/`journal`), `path`, `writeMode` (`disabled`/`append-host-summary`), `scope`, and for journal mode `tools.enabled` / `tools.allowJournalAppend` to give the runtime memory recall/append tools over MCP. The entity graph defaults to `<path>/graph.jsonl` (`memory.graphPath` to relocate). For semantic search fill `memory.embeddings`: `provider` (`ollama` with local `nomic-embed-text` — pull it first with `ollama pull nomic-embed-text` — or `openai` which requires `apiKey`/`apiKeyEnv`), optional `model`/`endpoint`. Without embeddings, `memory_search` falls back to keyword search.

## 7. Sandbox

Question:

```text
Should runtime commands run inside a sandbox?

1. No sandbox for the first pass
2. Native sandbox, no network (fail closed)
3. Native sandbox with localhost or an explicit network allowlist
4. Native sandbox with custom filesystem scopes (extra readable/writable roots)
```

Fills: the `sandbox` section — `mode`, `network.mode` (`none`/`localhost`/`allowlist`/`all`), `network.allowlist`, `readableRoots`/`writableRoots` (relative entries resolve against the workspace; default: workspace only), `denyWrite` glob patterns (defaults already deny `.env*`, `.git/config`, `.git/hooks/**`), `fallback` (`fail-closed` recommended; `unsafe-host-process` only with explicit consent plus `unsafeAllowHostProcess: true`).

## 8. Observability

Question:

```text
Do you need browsable traceability or just local artifacts?

1. JSONL artifacts and the operator console (recommended; console is on by default)
2. JSONL artifacts and the console on a fixed port
3. JSONL artifacts only (headless)
```

Fills: `artifacts.dir`, `traceability.registryDir` / `sourceId` / `sourceLabel`, and the `console` section — `console.port` for a fixed loopback port, `console.enabled: false` (or `start --no-console`) for headless. Artifacts record runtime/tool/message events and summaries, not private chain-of-thought. For a local terminal chat instead of (or alongside) the browser console, mention `mono-agent-tui --config ./mono-agent.config.json`.

## 9. Acceptance Smoke Test

Question:

```text
What proves this agent works?

1. A curl POST to the webhook invoke URL
2. A curl to /v1/models and /v1/chat/completions
3. A Telegram/Slack/WhatsApp message from an allowed sender
4. An A2A message to the Agent Card URL
5. A cron tick
```

The answer decides which smoke from `references/validation.md` must pass before the work is done.
