---
title: "Getting Started"
description: "Follow the path from installing mono-agent to holding your first browser conversation, then learn the concepts behind the config file."
sidebar:
  order: 0
---

This section takes you from a new computer to an agent you are talking to in the browser. Start with the [tutorial](/getting-started/tutorial/): it installs the CLI with the one-line installer, checks the host, scaffolds an agent with the guided `init`, starts the browser console for a first conversation, and turns on one optional feature from the Capabilities page. Channel setup, memory tiers, and observability are optional next steps, not prerequisites.

Bare `mono-agent init` on a TTY names the agent, searches the provider catalogs, and runs a real no-tool check for every selected route; on macOS the strict **Agent ready** gate then also starts the managed agent and proves its live snapshot, while other platforms stop at a manual-start handoff; flag/non-TTY init creates a scaffold only. mono-agent remains config-first: one `mono-agent.config.json`, driven by the CLI.

:::note
The latest published release is `0.27.1` (registry checked 2026-11-16; all 20 current catalog packages). Current `main` carries unreleased changes after `v0.27.1`: console usage analytics with on-demand subscription quota history and a manual-compaction fix, shipping in the next release. The Node-version guard, `mono-agent preflight`, the browser console's Capabilities page with its Enable actions, write-only credential fields and Undo, and the console handoff at the end of guided `init` are included in the published release. See [Release status](/reference/release-status/) for the upgrade boundary and any later source-only changes.
:::

## The path

The pages in this section, in sidebar order:

1. **Tutorial** — five steps from a new computer to a first conversation in the browser console, then one optional feature turned on.
2. **Feature tour** — what an agent can do, and whether each feature is turned on in the console, in the config, or with a CLI command.
3. **Set up with a coding agent** — let Claude Code or Codex do the setup with the bundled composer skill.
4. **Install** — reference for every install route.
5. **Setup reference** — reference for `init`, `validate`, and start paths.
6. **Concepts** — understand the moving parts so the rest of the docs make sense.

After the tutorial, most of your time is in the [web workspace](/observability/web-console/): threads, attachments, notifications, and service lifecycle.

## Pages

| Page | What it covers |
| --- | --- |
| [Tutorial: your first agent](/getting-started/tutorial/) | The guided path: installer, host preflight, guided `init`, the browser console, and one Enable action on the Capabilities page, with what to do when a step fails. |
| [Feature tour](/getting-started/feature-tour/) | What an agent can do and where each feature is turned on: console Enable, credential fields, config, or CLI. |
| [Set up with a coding agent](/getting-started/coding-agent-setup/) | Let Claude Code, Codex, or another coding agent build the agent with `mono-agent install-skill`, the composer skill, and the docs MCP server. |
| [Install](/getting-started/install/) | Reference for every install route: the private-Node installer, npm, `npm create`, pinned versions, updating, and building from source. |
| [Setup reference](/getting-started/quickstart/) | Reference for guided and scaffold-only `init`, `validate` statuses, start paths per platform, init flags, and generated files. |
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
