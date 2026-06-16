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
2. Lite memory — FTS keyword recall + rapid-log capture; zero external deps
3. Journal memory — hybrid recall (BM25+vector) + salience decay; requires local Ollama embeddings
4. BuJo memory — full tier: journal + LLM capture/reconcile + entity graph + auto-scheduled
   reflection/migration; requires Ollama embeddings AND a local chat model
```

All tiers share the same `@mono-agent/memory-bujo` substrate. Fills: `memory.mode`
(`lite`/`journal`/`bujo`), `memory.path`, `memory.writeMode`
(`disabled`/`append-host-summary`), and tier-specific blocks below.

**Tier 2 — lite (no external deps):**

Write:

```jsonc
"memory": {
  "mode": "lite",
  "path": "./.mono-agent/memory",
  "writeMode": "append-host-summary"
}
```

No prerequisites. No Ollama. SQLite is bundled.

**Tier 3 — journal (embeddings required):**

- Ask: which local Ollama embeddings model? (default `nomic-embed-text:v1.5` — use the
  exact `:v1.5` tag; pull first with `ollama pull nomic-embed-text:v1.5`).
- Default `memory.embeddings.dim` to `768` for `nomic-embed-text:v1.5`.

Write:

```jsonc
"memory": {
  "mode": "journal",
  "path": "./.mono-agent/memory",
  "writeMode": "append-host-summary",
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text:v1.5",
    "dim": 768
  }
}
```

After writing, remind the user to run `mono-agent validate` (checks Ollama reachability
and that the model is pulled — warns loudly on any failure, never silently falls back).

**Tier 4 — bujo (embeddings + chat model + auto-rituals):**

Proactively explain what bujo does: capture → reconcile (ADD/UPDATE/SUPERSEDE/NOOP),
hybrid BM25+vector recall, entity graph, reflection (decay + insight synthesis), monthly
migration (promote/reschedule/cluster/forget), living `index.md` + `future-log.md`.
The reflection and migration rituals are **auto-scheduled in-app** — no external cron or
launchd setup needed.

- Ask: which local Ollama embeddings model? (default `nomic-embed-text:v1.5` — exact
  `:v1.5` tag; `ollama pull nomic-embed-text:v1.5`).
- Ask: which local chat model for LLM pipelines? (e.g. `qwen3.6:latest`;
  `ollama pull qwen3.6:latest`). A chat model is required — without it the `bujo` tier
  cannot run capture/reflect/migrate.
- Ask: should we keep the default reflection/migration schedule (nightly `0 3 * * *` /
  monthly `0 4 1 * *`), or customise the cron expressions?

Write (embeddings + chat model):

```jsonc
"memory": {
  "mode": "bujo",
  "path": "./.mono-agent/memory",
  "writeMode": "append-host-summary",
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text:v1.5",
    "dim": 768
  },
  "llm": {
    "provider": "ollama",
    "model": "qwen3.6:latest"
  }
}
```

If the user customises the ritual schedule, add the `reflection`/`migration` blocks:

```jsonc
"reflection": { "enabled": true, "cron": "0 3 * * *" },
"migration":  { "enabled": true, "cron": "0 4 1 * *" }
```

After writing, append a prerequisite note:

```
Before running mono-agent validate, pull the required models:
  ollama pull nomic-embed-text:v1.5
  ollama pull qwen3.6:latest          # (or whichever chat model you chose)
```

Then run `mono-agent validate` — the Memory section confirms Ollama reachability, both
models are present, the root is writable, and the ritual cadence (with next-run times).
See `docs/memory.md` for the full tier table, config shapes, and CLI subcommands
(`memory-bujo rebuild|recall|index|reflect|migrate`).

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
