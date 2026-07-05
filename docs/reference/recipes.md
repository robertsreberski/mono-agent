---
title: "Recipe catalog"
sidebar:
  order: 5
---

# Recipe catalog

Recipes are **executable example configs**: each one generates a working `mono-agent.config.json` with every secret externalized to a `.env.example` (never written into the JSON), plus any scaffold files the setup needs (e.g. a `cron/*.md` job). They are the fastest way from nothing to a running shape you can then tune field-by-field.

```bash
mono-agent recipes list                      # catalog with risk levels
mono-agent recipes show <id>                 # generated config + .env.example + checklist
mono-agent init --recipe <id>                # scaffold it (add --with <csv> for extra channels)
mono-agent setup                             # interactive: pick a recipe, answer prompts
mono-agent validate --recipe <id>            # completeness report against the recipe's promises
```

Most recipes mirror a copy-paste [playbook](/playbooks/) that walks the same setup end-to-end with credentials and smoke tests.

## The catalog

| Id | What you get | Risk | Playbook |
| --- | --- | --- | --- |
| `minimal-webhook` | Minimal webhook agent — the zero-channel-credential starter; HTTP in, answer out. | low | [Webhook automation](/playbooks/webhook-automation-sync-async/) |
| `personal-telegram-bujo` | Personal Telegram assistant (BuJo memory) — chat allowlist, tiered local memory with embeddings. | medium | [Telegram personal assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `personal-telegram-supermemory` | Personal Telegram assistant (Supermemory) — external memory backend instead of local BuJo. | medium | [Telegram + Supermemory](/playbooks/telegram-supermemory-memory/) |
| `slack-team-bot` | Slack team bot — Socket Mode, channel allowlist, MCP tools. | medium | [Slack team bot](/playbooks/slack-team-bot-mcp-tools/) |
| `openai-api-gateway` | OpenAI-compatible API gateway — Chat Completions endpoint for OpenWebUI-style clients. | medium | [OpenAI endpoint](/playbooks/openai-endpoint-open-webui/) |
| `cron-digest` | Cron digest agent — scheduled prompt with native proactive notification. | low | [Cron digest](/playbooks/cron-digest-proactive-notify/) |
| `a2a-provider` | A2A provider — Agent Card discovery + JSON-RPC/REST endpoints, optional bearer. | medium | [A2A provider & consumer](/playbooks/a2a-provider-and-consumer/) |
| `local-ollama-private` | Local Ollama private agent — fully local model + memory, no cloud calls. | low | [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) |
| `local-lmstudio-private` | Local LM Studio private agent — fully local model + lite (FTS-only) memory, no cloud calls; playbook covers an optional journal-tier upgrade using LM Studio's own embeddings. | low | [Local-only LM Studio agent](/playbooks/local-only-lmstudio-agent/) |
| `phoenix-observed` | Phoenix-observed agent — OTLP trace export of every run to a local Phoenix. | low | [Phoenix-observed agent](/playbooks/phoenix-observed-agent/) |
| `sandboxed-code-agent` | Sandboxed code agent — native `srt` sandbox; if the engine is missing, commands fail closed with `sandbox_unavailable` instead of running on the host. | medium | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `full-safe` | Full (safe) blueprint — every channel enabled with conservative defaults and a fail-closed native sandbox. | medium | — |
| `full-local-power` | Full (local power) blueprint — intentionally unsafe local operator profile with `unsafe-host-process`; if `srt` is missing, commands run unsandboxed and roots/denyWrite are inert. | high | — |

Risk levels reflect blast radius, not difficulty: `low` recipes expose nothing beyond loopback and need at most a model key; `medium` recipes talk to external services or hold channel credentials; `high` recipes enable permissive tool/sandbox settings you should read before running.

## Sandboxed recipes

Recipes that generate `"sandbox": { "mode": "native" }` require `srt` on `PATH`. Check the engine before trusting the sandbox:

```bash
command -v srt
srt --version
mono-agent validate --recipe sandboxed-code-agent
```

Safe sandboxed recipes (`sandboxed-code-agent`, `full-safe`) set `fallback: "fail-closed"`. If `srt` is unavailable, sandboxed commands stop with `sandbox_unavailable`; they do not quietly run as normal host processes.

`full-local-power` is different on purpose. It sets `fallback: "unsafe-host-process"` and `unsafeAllowHostProcess: true`, so it is high risk. If the engine is unavailable, mono-agent reports `WARNING: Unsafe sandbox fallback is active: all sandbox roots/denyWrite entries are inert; commands run unsandboxed.` Use it only for a trusted local operator profile where that consequence is acceptable.

`mono-agent validate --recipe <id>` checks the recipe's sandbox promise against the doctor report. A missing `srt` engine shows the `Sandbox` section as `waiting` and the recipe block as incomplete. `mono-agent start` and `mono-agent status` surface the effective sandbox state (`native`, `blocked`, `unsafe-host-process`, or `off`), the engine availability, the fallback, and whether the fallback is active. Existing configs are not rewritten; change `sandbox.fallback` explicitly if you want a different behavior.

## How recipes relate to the config

A recipe is not a separate format — `recipes show <id>` prints the exact `mono-agent.config.json` it would write. Everything a recipe configures can be edited afterwards like any hand-written config, and [`mono-agent config`](/observability/cli-reference/#config) shows the resolved result field-by-field with provenance. The catalog lives in `packages/agent-app/src/recipes/catalog.ts`; a parity test keeps this page in sync with it.
