---
title: "Getting Started"
description: "Follow the path from installing mono-agent to holding your first browser conversation, then learn the concepts behind the config file."
sidebar:
  order: 0
---

This section takes you from an empty folder to an agent you are talking to in the browser. The recommended path installs the published CLI, scaffolds an agent with the guided `init`, starts it, and opens the web console. The terminal console, channel setup, memory tiers, and observability are all optional next steps, not prerequisites.

Bare `mono-agent init` on a TTY names the agent, searches the provider catalogs, and runs a real no-tool check for every selected route; on macOS the strict **Agent ready** gate then also starts the managed agent and proves its live snapshot, while other platforms stop at a manual-start handoff; flag/non-TTY init creates a scaffold only. mono-agent remains config-first: one `mono-agent.config.json`, driven by the CLI.

:::note
These docs describe the current `main` source, while npm publishes the latest release. See [Release status](/reference/release-status/) before you rely on a capability you cannot find in an installed version.
:::

## The path

1. **Install** — put the published `mono-agent` CLI on your `PATH`, or build the source CLI if you need unreleased behavior.
2. **Quickstart** — run guided init, understand catalog/auth/route verification and the full-agent gate, then start the agent and your first browser conversation.
3. **Web workspace** — learn the console you will spend most of your time in: threads, attachments, notifications, and service lifecycle.
4. **Concepts** — understand the moving parts so the rest of the docs make sense.

## Pages

| Page | What it covers |
| --- | --- |
| [Install](/getting-started/install/) | Install the `mono-agent` CLI, confirm your toolchain, start the web console, and update or build from source. |
| [Quickstart](/getting-started/quickstart/) | Scaffold a `mono-agent.config.json`, validate it, start the agent, and hold the first conversation in the browser. |
| [Concepts](/getting-started/concepts/) | The core model — agent, runtime, channels, tools, memory, and context — and how config maps onto them. |

## Where to go next

Once your agent runs, branch out by topic:

- [Always-on web console](/observability/web-console/) — persistent conversations, attachments, notifications, and the trusted-network security boundary.
- [Configuration](/config/) — the full annotated config blueprint, environment variables, and folder layout.
- [Runtime](/runtime/) — Pi runtime & model references, fallback chains, local providers, sessions, and execution effort.
- [Channels](/channels/) — connect Telegram, Slack, WhatsApp, webhooks, the OpenAI-compatible API, A2A, and cron.
- [Tools & sandbox](/tools/) — narrow the tool policy, attach MCP servers, and confine commands with the native sandbox.
- [Programmatic](/programmatic/) — for capabilities that are code-only rather than config-driven.

:::note
Every capability in mono-agent carries a coverage type — **config**, **cli**, **auto**, **code**, or **dev** — so you always know whether to reach for the config file, a CLI command, or the SDK. The [feature matrix](/reference/feature-matrix/) is the canonical map.
:::
