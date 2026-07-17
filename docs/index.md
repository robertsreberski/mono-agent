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

- **Any backend, one model string** — `runtime.model` defaults to `codex:gpt-5.6-terra` and can select claude (sdk/cli), codex (cli), pi (sdk, 15+ providers), or opencode (cli); e.g. `codex:gpt-5.6-terra`, `codex:gpt-5.6-sol`, `pi:openai-codex:gpt-5.6-sol`, and `pi:opencode-go:kimi-k2.6`.
- **Many channels, one config** — each transport is opt-in via an `enabled` flag and shares the same runtime, tools, memory, and context.
- **Batteries included** — managed Read/Write/Edit/Glob/Grep/Bash/NodeRepl/WebFetch/WebSearch tools, a tool policy, MCP servers, a native sandbox, tiered memory, and observability.

```json
{
  "runtime": { "model": "codex:gpt-5.6-terra" },
  "telegram": { "enabled": true },
  "openaiApi": { "enabled": true }
}
```

Equivalent env overrides: `MONO_AGENT_MODEL=codex:gpt-5.6-terra` and, for the enabled Telegram channel, `MONO_AGENT_TELEGRAM_BOT_TOKEN=...` in `.env`. Source configs omit credentials; see [Environment variables](/config/env-vars/) for the full mapping.

## Site map

- **[Getting Started](/getting-started/)** — install the CLI, scaffold a config, and run your first agent.
- **[Config](/config/)** — the `mono-agent.config.json` blueprint, env-var precedence, and folder layout.
- **[Runtime](/runtime/)** — model backends, fallback chains, local providers, effort/permissions, sessions, concurrency, and tool guards.
- **[Channels](/channels/)** — Telegram, Slack, WhatsApp, Webhook, OpenAI-compatible API, A2A, cron, and proactive delivery.
- **[Memory](/memory/)** — tiered capture/recall, embeddings, consolidation, the entity graph, and validation/CLI.
- **[Context](/context/)** — identity/soul, skills, and how the system prompt is assembled per turn.
- **[Tools](/tools/)** — the tool policy (allow/deny), MCP integration, and the native sandbox.
- **[Observability & operator consoles](/observability/)** — JSONL artifacts and traces, Phoenix/OTLP export and backfill, the CLI, TUI, always-on web console, and Session Recorder.
- **[Programmatic](/programmatic/)** — the `code`-only escape hatches: composition, approval gates, structured output, multi-agent, A2A consumers, and custom channels.
- **[Playbooks](/playbooks/)** — end-to-end recipes (Telegram BuJo assistant, Slack MCP bot, local-only Ollama, sandboxed code agent, and more).
- **[Reference](/reference/)** — the feature matrix and glossary.

## Config-first philosophy

Everything that defines a running agent lives in `mono-agent.config.json`, resolved with a strict precedence: **process env > `mono-agent.config.json` > built-in defaults**. Every config key has a matching `MONO_AGENT_*` override, so the same artifact runs in dev and prod without edits.

Channels and optional subsystems are **opt-in**: a transport is dormant until you set its `enabled` flag, and security-sensitive surfaces (sandbox fallback, network policy, send-tool allowlists) **fail closed** by default. A handful of capabilities — approval gates, structured output, live input, custom runtimes/channels — are programmatic escape hatches by design; those are covered under [Programmatic](/programmatic/).
