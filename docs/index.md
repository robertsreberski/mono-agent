---
title: "Home"
description: "Turn a folder into a configurable AI agent you work with in a persistent web workspace — for coding, research, writing, and planning, with your own models and channels."
sidebar:
  order: 0
---

**mono-agent** turns a folder into an AI agent you work with in a persistent web workspace. Point it at a research folder and it plans, drafts, and summarizes; hand it a codebase and it reads code, edits files, runs commands, and explains what failed. The same agent can also answer in your terminal, on Telegram or Slack, over a webhook or an OpenAI-compatible endpoint, or on a cron schedule.

What makes it configurable rather than hand-built is one `mono-agent.config.json`: the model routes, identity, tools, skills, memory, channels, and sandbox of the agent all live in that file, so an agent definition is something you can read, review, version, and move.

## Start here

```bash
npm i -g create-mono-agent     # Node.js >= 24.15.0; no pnpm required
mkdir my-agent && cd my-agent
mono-agent init                # guided wizard on a TTY; scaffold-only with flags
mono-agent start               # background service on macOS and Linux
mono-agent web run --loopback  # foreground console; keep this terminal open
```

Then open `http://127.0.0.1:5050`, choose the agent, and start a conversation. `web run` binds the console's HTTP listener to this computer and configures no proxy route, but it does not remove one that already exists — an earlier managed start, a Serve handler, or your own proxy can still make it reachable elsewhere, so check `tailscale serve status` or your proxy before treating the console as local-only. The managed `mono-agent web start` service runs in the background with the same fresh loopback bind, and on macOS it re-verifies an existing mono-agent-owned Tailscale Serve route or publishes a new one only with `--share-tailnet`; other proxies and routes are not inspected, so no bind alone proves local-only access. Neither mode has an application login. [Getting Started → Quickstart](/getting-started/quickstart/) explains every branch of that path, including what a bare `init` proves before it calls the agent ready, and [Install & prerequisites](/getting-started/install/) covers both console modes, pinned installs, one-shot scaffolding, and source builds.

:::caution[These docs describe `main`, not the latest release]
The latest published npm release is `create-mono-agent@0.21.1`, so an npm install does not yet include everything documented here. [Release status](/reference/release-status/) lists the source-only capability groups and the source-build alternative.
:::

## What you get

- **A persistent web workspace** — the browser console keeps conversations and in-flight turns in its own service, so refreshing or closing a tab does not stop the work. It auto-discovers the agents running on your machine; each conversation keeps its own history and attachments, and you pick the model for the next turn. See [Always-on web console](/observability/web-console/).
- **Coding and non-coding work in the same product** — an agent can read and edit a repository, run and interpret commands, and explain failures, or work over documents, notes, and research material with the same config surface.
- **Your models, including local ones** — route to subscription and API providers such as OpenAI Codex, Anthropic, GitHub Copilot, and OpenCode-Go, or run locally through Ollama and LM Studio. Add ordered fallback routes so a provider failure does not end the turn. See [Runtime & providers](/runtime/).
- **Channels when you want them** — Telegram, Slack, WhatsApp, webhook, an OpenAI-compatible API, A2A, and cron all feed the same configured runtime. Each channel keeps its own conversation history. See [Channels](/channels/).
- **Powerful surfaces without writing a host** — tools, tool policy, MCP servers, selected skills, tiered memory, and a native sandbox are all declarable in the config file. See [Tools, MCP & sandbox](/tools/) and [Selected skills](/context/skills/).
- **Local-first by default** — run artifacts stay on disk, credentials live in an owner-only `.env` or the provider's auth store, and the browser console has no application login, so reachability is the access boundary. See [Security policy](https://github.com/robertsreberski/mono-agent/blob/main/SECURITY.md) and [Setup security and managed runtime](/reference/setup-security/).

An agent can be small. This is a complete config:

```json
{
  "runtime": { "model": "openai-codex:gpt-5.6-terra", "workspace": "." },
  "context": { "identityPath": "./IDENTITY.md" },
  "telegram": { "enabled": true }
}
```

Core model selection stays in JSON. The enabled Telegram adapter can read `MONO_AGENT_TELEGRAM_BOT_TOKEN` from `.env`; see [Operational environment variables](/config/env-vars/).

## Site map

- **[Getting Started](/getting-started/)** — install the CLI, scaffold a config, and hold your first browser conversation.
- **[Web workspace](/observability/web-console/)** — persistent threads, attachments, notifications, projects, and service lifecycle for the browser console.
- **[Config](/config/)** — the `mono-agent.config.json` blueprint, env-var precedence, and folder layout.
- **[Runtime](/runtime/)** — Pi runtime and model references, fallback chains, local providers, effort/permissions, sessions, concurrency, and tool guards.
- **[Channels](/channels/)** — Telegram, Slack, WhatsApp, Webhook, OpenAI-compatible API, A2A, cron, and proactive delivery.
- **[Memory](/memory/)** — optional tiered capture and recall, embeddings, consolidation, and maintenance.
- **[Context](/context/)** — identity/soul, skills, and how the system prompt is assembled per turn.
- **[Tools](/tools/)** — the tool policy (allow/deny), background jobs, MCP integration, and the native sandbox.
- **[Observability & CLI](/observability/)** — local run artifacts, trace-source discovery, and the lifecycle CLI.
- **[Programmatic](/programmatic/)** — the `code`-only escape hatches: composition, approval gates, structured output, multi-agent, A2A consumers, and custom channels.
- **[Playbooks](/playbooks/)** — end-to-end recipes (Telegram BuJo assistant, Slack MCP bot, local-only Ollama, sandboxed code agent, and more).
- **[Packages](/reference/packages/)** — every published package, its ownership tier, responsibility, npm page, and authoritative README.
- **[Reference](/reference/)** — release status, the feature matrix, glossary, compatibility decisions, and setup-security contracts.

## Config-first philosophy

Everything that defines a running agent lives in `mono-agent.config.json`, with built-in defaults for omitted fields. Former core `MONO_AGENT_*` overrides are silently ignored; environment values remain for secret references, adapter inputs, and process plumbing.

External channels and optional subsystems are generally **opt-in**: a transport is dormant until you enable it, while the loopback operator endpoint (compatibility id `tui`) defaults on and can be disabled explicitly. Security-sensitive surfaces (sandbox fallback, network policy, send-tool allowlists) **fail closed** by default. Approval gates, structured output, custom runtimes/channels, and direct runtime live input are programmatic escape hatches; managed Slack, Telegram, and web-console turns provide live follow-up steering automatically on capable providers. See [Programmatic](/programmatic/).
