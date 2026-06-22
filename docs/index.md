---
title: "Home"
sidebar:
  order: 0
---

# mono-agent

**mono-agent** is a config-first agent framework: one `mono-agent.config.json` turns any folder into a running agent, served at once over Webhook, an OpenAI-compatible API, Telegram, Slack, WhatsApp, A2A, and cron. It is published as `@mono-agent/*` packages on npm and driven by the `mono-agent` CLI — point a model at a workspace, flip on the channels you want, and `mono-agent start`.

:::note
New here? Read [Getting Started → Quickstart](/getting-started/quickstart/) to go from an empty folder to a live agent in a few commands.
:::

## What you get

- **Any backend, one model string** — `runtime.model` selects claude (sdk/cli), codex (cli), pi (sdk, 15+ providers), or opencode (cli); e.g. `claude:claude-sonnet-4-6`, `codex:gpt-5.5`, `pi:openai:gpt-5.5`.
- **Many channels, one config** — each transport is opt-in via an `enabled` flag and shares the same runtime, tools, memory, and context.
- **Batteries included** — built-in Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch tools, a tool policy, MCP servers, a native sandbox, tiered memory, and observability.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "telegram": { "enabled": true, "botToken": "..." },
  "openaiApi": { "enabled": true }
}
```

Equivalent env override: `MONO_AGENT_MODEL=claude:claude-sonnet-4-6`. See [Environment variables](/config/env-vars/) for the full mapping.

## Site map

- **[Getting Started](/getting-started/)** — install the CLI, scaffold a config, and run your first agent.
- **[Config](/config/)** — the `mono-agent.config.json` blueprint, env-var precedence, and folder layout.
- **[Runtime](/runtime/)** — model backends, fallback chains, local providers, effort/permissions, sessions, concurrency, and tool guards.
- **[Channels](/channels/)** — Telegram, Slack, WhatsApp, Webhook, OpenAI-compatible API, A2A, cron, and proactive delivery.
- **[Memory](/memory/)** — tiered capture/recall, embeddings, rituals, the entity graph, and validation/CLI.
- **[Context](/context/)** — identity/soul, skills, and how the system prompt is assembled per turn.
- **[Tools](/tools/)** — the tool policy (allow/deny), MCP integration, and the native sandbox.
- **[Observability](/observability/)** — JSONL artifacts and traces, Phoenix/OTLP export and backfill, the CLI, and the TUI.
- **[Programmatic](/programmatic/)** — the `code`-only escape hatches: composition, approval gates, structured output, multi-agent, A2A consumers, and custom channels.
- **[Evals](/evals/)** — trajectory, cost, and quality evaluation harnesses.
- **[Playbooks](/playbooks/)** — end-to-end recipes (Telegram BuJo assistant, Slack MCP bot, local-only Ollama, sandboxed code agent, and more).
- **[Reference](/reference/)** — the feature matrix and glossary.

## Config-first philosophy

Everything that defines a running agent lives in `mono-agent.config.json`, resolved with a strict precedence: **process env > `mono-agent.config.json` > built-in defaults**. Every config key has a matching `MONO_AGENT_*` override, so the same artifact runs in dev and prod without edits.

Channels and optional subsystems are **opt-in**: a transport is dormant until you set its `enabled` flag, and security-sensitive surfaces (sandbox fallback, network policy, send-tool allowlists) **fail closed** by default. A handful of capabilities — approval gates, structured output, live input, custom runtimes/channels — are programmatic escape hatches by design; those are covered under [Programmatic](/programmatic/).
