---
title: "Playbooks"
nav_order: 12
has_children: true
---

# Playbooks

This section collects 13 end-to-end recipes. Each one walks the same arc — **init → configure → validate → start → smoke** — using only real `mono-agent.config.json` keys and the `mono-agent` CLI, so you can copy a playbook, adapt the placeholders, and have a working agent in minutes.

Every recipe ends with a concrete smoke test (a Telegram message, a `curl`, a cron tick, a Phoenix span) so you can prove the agent works before you ship it.

## How to use these

1. Pick a recipe from the [selector](#pick-a-recipe) or the [full table](#all-recipes) below.
2. Run `mono-agent init` with the suggested `--model` (and `--memory` / `--fallback-models` where shown).
3. Edit `mono-agent.config.json` per the recipe — keys are cross-checked against [the config blueprint](../config/blueprint.md) and [feature registry](../reference/feature-matrix.md).
4. Run `mono-agent validate` (catches missing tokens, unreachable providers, un-pulled local models, ritual cadence, and exporter reachability), then `mono-agent start`.
5. Run the recipe's smoke test and inspect the JSONL run artifact under `artifacts.dir`.

`mono-agent init`, `validate`, and `start` are **cli** coverage; most knobs below are **config**. Recipes that compose responders in TypeScript (multi-agent, evals, some A2A) are **code**-only — see [Programmatic](../programmatic/index.md).
{: .note }

## Pick a recipe

Choose along three axes, in order: **channel** (how messages reach the agent), then **memory tier**, then **deployment shape**.

### 1. By channel

| You want the agent reachable via… | Start with |
| --- | --- |
| Telegram (long-polling) | [Personal Telegram Assistant](telegram-personal-assistant-bujo.md) |
| Slack (Socket Mode, mention-triggered) | [Slack Team Bot](slack-team-bot-mcp-tools.md) · [Cron Digest → Slack](cron-digest-proactive-notify.md) |
| An OpenAI-compatible `/v1` endpoint (Open WebUI, SDKs) | [OpenAI Endpoint for Open WebUI](openai-endpoint-open-webui.md) |
| Plain HTTP (sync + async jobs) | [Webhook Automation](webhook-automation-sync-async.md) |
| Another agent over A2A | [A2A Provider + Consumer](a2a-provider-and-consumer.md) |
| A scheduled prompt (no inbound channel) | [Cron Digest](cron-digest-proactive-notify.md) |
| The local terminal TUI only | [Local-Only Ollama Agent](local-only-ollama-agent.md) · [Phoenix-Observed Agent](phoenix-observed-agent.md) |

See [Channels](../channels/index.md) for the full per-channel reference.

### 2. By memory tier

| Memory need | Tier | Recipe |
| --- | --- | --- |
| Remember every turn, nightly reflection, monthly migration, semantic recall | `bujo` | [Telegram Assistant with BuJo](telegram-personal-assistant-bujo.md) |
| Durable notes + semantic recall, no rituals | `journal` | [Local-Only Ollama](local-only-ollama-agent.md) · [Sandboxed Code Agent](sandboxed-code-agent.md) · [Cron Digest](cron-digest-proactive-notify.md) |
| Stateless / no long-term memory | — | [Webhook](webhook-automation-sync-async.md) · [OpenAI Endpoint](openai-endpoint-open-webui.md) · [A2A](a2a-provider-and-consumer.md) |

Memory tiers, `writeMode`, embeddings, and rituals are covered in [Memory](../memory/capture-and-recall.md) and [Rituals](../memory/rituals.md).

### 3. By deployment shape

| Shape | Recipe |
| --- | --- |
| Single agent, one channel | most recipes above |
| Fully local / air-gapped (no cloud, no outbound network) | [Local-Only Ollama](local-only-ollama-agent.md) · [Sandboxed Code Agent](sandboxed-code-agent.md) |
| Reliability-hardened (ordered model fallback) | [Multi-Model Fallback Chain](multi-model-fallback-chain.md) |
| Composed / multi-agent (delegation) | [Multi-Agent Orchestration](multi-agent-orchestration.md) · [A2A Pair](a2a-provider-and-consumer.md) |
| Observed (tracing + dashboards) | [Phoenix-Observed Agent](phoenix-observed-agent.md) · [Backfill Historical Runs](backfill-historical-runs.md) |
| Quality-gated in CI | [Eval Suite](eval-suite-trajectory-cost.md) |

## All recipes

| Recipe | Who it's for | Goal |
| --- | --- | --- |
| [Personal Telegram Assistant with BuJo Memory](telegram-personal-assistant-bujo.md) | Individual power user wanting a private assistant that remembers | Telegram long-polling bot that captures every turn into BuJo memory (nightly reflection + monthly migration) and recalls past notes semantically. |
| [Slack Team Bot with MCP Tools](slack-team-bot-mcp-tools.md) | DevOps engineer running a shared team bot | Slack Socket Mode bot, mention-triggered in allowed channels, with a custom MCP tool plus Read/Grep and `slack_send_message` for proactive posts. |
| [Fully Local Ollama Agent (No Cloud)](local-only-ollama-agent.md) | Privacy-focused user with no cloud API budget | Agent running entirely on local Ollama via the Pi runtime, with journal memory on local embeddings and no outbound network. |
| [OpenAI-Compatible Endpoint for Open WebUI](openai-endpoint-open-webui.md) | AI infra engineer fronting the agent with a chat UI | Expose the agent as an OpenAI-compatible `/v1` endpoint so Open WebUI can stream responses and keep multi-turn state. |
| [Webhook Automation with Sync + Async Endpoints](webhook-automation-sync-async.md) | Backend developer integrating the agent into a pipeline | Accept fast sync HTTP calls and long-running async jobs (202 + status polling) across multiple named endpoints, some defined as markdown. |
| [Cron Digest with Proactive Slack Notify](cron-digest-proactive-notify.md) | Data analyst wanting a scheduled briefing pushed to the team | Timezone-aware cron job that builds a daily digest with shared history and proactively posts it to Slack via the send tool. |
| [A2A Provider + Consumer Pair](a2a-provider-and-consumer.md) | Platform integrator connecting two agents over A2A | Publish agent A as an A2A provider (Agent Card discovery, bearer) and configure agent B to discover and call it. |
| [Multi-Agent Orchestration (ask_collaborator)](multi-agent-orchestration.md) | Workflow designer composing specialist agents | One orchestrator delegates subtasks to named collaborator responders via the loopback `ask_collaborator` MCP tool. |
| [Sandboxed Code Agent (No Internet, Deny .env)](sandboxed-code-agent.md) | Security team deploying an internal code assistant | Agent that reads repos and runs Bash inside the native sandbox with no network and protected secrets, recalling local context. |
| [Phoenix-Observed Agent with TUI](phoenix-observed-agent.md) | Agent builder evaluating runs in a tracing dashboard | Run an agent with the TUI and stream every run lifecycle to Phoenix as OpenInference spans, with local JSONL as fallback. |
| [Backfill Historical Runs to Phoenix](backfill-historical-runs.md) | Operations engineer onboarding observability after the fact | Retroactively export already-recorded JSONL run artifacts to Phoenix with original timestamps, idempotently. |
| [Eval Suite with Trajectory + Cost Budgets](eval-suite-trajectory-cost.md) | Agent product owner gating quality in CI | Run scenarios against the composed responder asserting required tool calls, trajectory, and per-run cost ceilings. |
| [Multi-Model Fallback Chain with Transcript Resume](multi-model-fallback-chain.md) | Reliability-minded builder who can't afford a single-provider outage | Primary cloud model with ordered backups the failover router tries on retryable failures, resuming from the transcript tail. |

Always run `mono-agent validate` before `start`. It is the single fastest way to catch a missing `botToken`, an un-pulled Ollama model, an unreachable Phoenix endpoint, or a duplicate webhook path before they bite you at runtime.
{: .tip }
