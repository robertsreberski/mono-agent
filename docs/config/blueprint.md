---
title: "Annotated config file"
sidebar:
  order: 1
---

# Annotated config file

A single `mono-agent.config.json` declares the whole agent: runtime, providers, context, memory, tools, sandbox, observability, and every channel. This page reproduces the complete annotated file so you can copy any section verbatim. Each top-level section links out to its deep-dive page at the bottom.

Paths are relative to the agent folder. Every field also has a `MONO_AGENT_*` env var that overrides it — precedence is **env > JSON > defaults**. Omit a section to leave that capability off: every section except `runtime.model` and `context.identityPath` is optional.

This is a **config**-coverage reference. Capabilities that config cannot express need the [programmatic escape hatch](/programmatic/) — see the note at the end.

## Folder layout

```text
my-agent/
  mono-agent.config.json   # the single declaration below
  IDENTITY.md              # role, boundaries, references to existing knowledge
  skills/                  # optional: <skill-name>/SKILL.md per selected skill
  cron/                    # optional: <job-id>.md scheduled prompts
  mcp.json                 # optional: MCP server definitions
  .env                     # optional: secrets; auto-loaded by the CLI, never committed
  .mono-agent/
    artifacts/             # JSONL run summaries + events
    workspace/             # runtime working directory (if not ".")
    memory/                # journal memory root (daily notes, graph.jsonl, index/)
    whatsapp-auth/         # Baileys auth state (WhatsApp channel only)
    trace-sources/         # traceability registry (if kept folder-local)
```

See [Folder layout](/config/folder-layout/) for the full directory contract.

## The full annotated config

```jsonc
{
  // Runtime: primary model plus ordered backups tried on retryable provider
  // failures (failover is reported in run results, never silent).
  "runtime": {
    "model": "codex:gpt-5.6-terra",        // pi:<provider>:<model> | claude:* | codex:* | opencode:*
    "fallbackModels": ["pi:opencode-go:kimi-k2.6", "pi:ollama:gemma4:31b"],
    "executionMode": "cli",                // sdk | cli (default inferred from model)
    "effort": "medium",                    // none|low|medium|high|xhigh|max
    "permissionMode": "default",           // default|plan|acceptEdits|bypassPermissions (CLI backends)
    "maxTurns": 0,                         // 0 or omitted means unlimited; 1-100 caps turns
    "workspace": ".",
    "session": {
      "mode": "continuous",                // or "per-message"
      "idleTimeoutMs": 1800000,
      "rollover": "none",                  // none|daily; daily buckets conversation ids by day
      "rolloverTimezone": "UTC",           // optional IANA timezone for daily rollover
      "rolloverNotice": false              // adapter-visible new-bucket notice; default off / unset
    }
  },

  // Local/self-hosted providers for pi:<provider>:<model> references.
  "providers": {
    "piAuthPath": "~/.pi/agent/auth.json", // Pi credentials (OAuth/account + API-key providers)
    // Pi-native bridge tuning (all optional).
    "piNative": {
      "piMaxRetries": 2,                   // 0-8; transient provider-transport retries
      "maxRetryDelayMs": 60000,            // backoff cap between retries (ms)
      "piSessionsRoot": ".mono-agent/sessions" // durable JSONL sessions → resume across restarts (unset = in-memory)
    },
    "local": [
      {
        "id": "ollama",
        "type": "ollama",                  // ollama | lmstudio | openai_compat
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "trustPublicUrl": false,           // explicit opt-in for non-private URLs
        "apiKeyEnv": "MY_PROVIDER_KEY",    // or inline "apiKey" (untracked file only)
        "models": [{ "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }]
      }
    ]
  },

  // Identity, optional soul, and selected skills.
  "context": {
    "identityPath": "./IDENTITY.md",
    "soulPath": "./SOUL.md",
    "skillsRoot": "./skills",
    "selectedSkills": ["research"],        // exact names; no auto-selection
    "skillMaxBytes": 48000                 // per-skill byte cap (256-1,000,000)
  },

  // Memory strategy. Omit the section for no memory.
  // Three tiers over one substrate (@mono-agent/memory store + bujo subpaths):
  //   lite    — FTS keyword recall + rapid-log; no external deps.
  //   journal — + hybrid recall (BM25+vector) + decay; needs embeddings.
  //   bujo    — + LLM capture/reconcile + entity graph + auto-scheduled
  //             lightweight consolidation; needs embeddings + an app-level memory.llm for capture/tier selection.
  "memory": {
    "mode": "bujo",                        // lite | journal | bujo
    "path": "./.mono-agent/memory",        // root directory for all tiers
    "writeMode": "capture",                // disabled | append-host-summary | capture (bujo only)
    "maxBytes": 64000,
    "embeddings": {                        // required for journal and bujo
      "provider": "ollama",                // ollama | openai
      "model": "nomic-embed-text:v1.5",   // use exact :v1.5 tag (pull first with ollama pull)
      "endpoint": "http://localhost:11434",
      "apiKeyEnv": "OPENAI_API_KEY",       // or inline "apiKey"; required for openai
      "dim": 768                           // nomic-embed-text:v1.5 output dimension
    },
    "llm": {                               // enables bujo capture and the effective bujo tier; omit for lite/journal
      // Env: MONO_AGENT_MEMORY_LLM_PROVIDER / _MODEL / _EXECUTION_MODE / _ENDPOINT / _TIMEOUT_MS.
      "provider": "ollama",                // ollama | agent-host
      "model": "qwen3.6:latest",           // ollama: model string; agent-host: runtime ref, e.g. pi:openai-codex:gpt-5.6-terra
      "endpoint": "http://localhost:11434", // ollama only; invalid for agent-host
      "timeoutMs": 60000                   // in-app per-call timeout; 1000-600000, default 60000. Raise for slow local models.
      // For agent-host, use: "model": "pi:openai-codex:gpt-5.6-terra", "executionMode": "sdk"; omit endpoint.
    },
    // Bujo auto-scheduler — override the default or disable it.
    // Consolidation runs in-app; no external cron or launchd needed.
    "consolidation": { "enabled": true, "cron": "0 */2 * * *" } // default: every two hours
  },

  // Tool policy (allow-all by default) + MCP servers. Deny wins; overlap is rejected.
  "tools": {
    "allowedTools": ["*"],                 // omit or ["*"] = all tools; ["Read","Bash"] = just those; [] = none (chat-only)
    "disallowedTools": ["Bash"],           // deny wins even under allow-all; the escape hatch to subtract one tool
    "mcpConfigPath": "./mcp.json",         // stdio/sse/http servers; inlined for SDK runtimes
    "mcpCallTimeoutMs": 120000,            // inactivity cap per MCP call; tool progress resets it
    "mcpCallMaxTotalTimeoutMs": 2700000    // hard per-call wall clock (45 min); progress cannot extend it
  },

  // Human-in-the-loop bridge: blocking AskUser + tool progress → channel status
  // messages. Optional — auto-starts when AskUser is allowed (allow-all, or
  // listed in tools.allowedTools) or when this block is present.
  "interaction": {
    "bridge": { "host": "127.0.0.1", "port": 0 }, // 0 = ephemeral; tools get the URL via env
    "askUser": { "timeoutMs": 600000 },           // max wait per question (10 min)
    "progress": { "enabled": true }
  },

  // Sandbox for runtime commands. Omit for no sandboxing.
  "sandbox": {
    "mode": "native",                      // native (srt-wrapped) | off
    "network": { "mode": "none", "allowlist": [] }, // none|localhost|allowlist|all; *.suffix wildcards
    "readableRoots": ["."],                // relative entries resolve against the workspace
    "writableRoots": ["."],
    "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"], // these are the defaults
    "fallback": "fail-closed",             // fail-closed | unsafe-host-process
    "unsafeAllowHostProcess": false        // explicit opt-in required for the unsafe fallback
  },

  // Observability: JSONL artifacts (always written; the local fallback) + the
  // trace-source registry that `mono-agent status` reads.
  "artifacts": {
    "dir": "./.mono-agent/artifacts",
    "retention": {
      "maxAgeDays": 365,
      "maxCount": 50000,
      "dryRun": false
    },
    "memoryRetention": {
      "maxAgeDays": 7,                    // memory-maintenance mem-* runs
      "maxCount": 5000,
      "dryRun": false                     // defaults to retention.dryRun when omitted
    }
  },
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceId": "my-agent",
    "sourceLabel": "My Agent",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000,
    "globalDiscovery": true                // mirror into ~/.mono-agent/trace-sources too (default true)
  },

  // Optional trace viewer: add a Phoenix (OTLP) exporter to browse traces in
  // Phoenix. Omit this entry to keep only the local JSONL artifacts.
  "observability": {
    "exporters": [
      { "type": "phoenix", "endpoint": "http://127.0.0.1:6006/v1/traces" }
    ]
  },

  // ----- Channels: one section per channel; all independent. Most channels are
  // ----- opt-in; operator surfaces (`tui`, `live`) default on and can opt out.
  // ----- A waiting/disabled channel never blocks the others.

  "tui": {
    "enabled": true,                       // default-on loopback operator console endpoint
    "host": "127.0.0.1",
    "port": 0,
    "basePath": "/tui",
    "allowNonLoopback": false,
    "apiKey": "optional-bearer"
  },

  "live": {
    "enabled": true,                       // default-on read-only SSE relay for mono-agent web
    "host": "127.0.0.1",
    "port": 0,
    "basePath": "/live",
    "allowNonLoopback": false,
    "apiKey": "optional-bearer"
  },

  "webhook": {
    "enabled": true,
    "host": "127.0.0.1",                   // loopback-only unless allowNonLoopback
    "port": 0,                             // 0 picks a free port
    "path": "/webhook/invoke",
    "allowNonLoopback": false,
    "defaultMode": "sync",                 // sync | async (202 + status URL polling)
    "retentionMs": 300000,                 // async status retention
    "maxStoredRequests": 100
  },

  "openaiApi": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4040,
    "basePath": "/v1",                     // serves /v1/models + /v1/chat/completions (SSE)
    "allowNonLoopback": false,
    "modelId": "my-agent",                 // model id advertised to API clients
    "apiKey": "sk-..."                     // optional bearer required from clients
  },

  // Telegram & Slack deliver only the FINAL answer by default (no streamed
  // interim edits) while showing a working indicator — Telegram a "typing…"
  // action, Slack a 👀 "seen" reaction. This is built-in behavior (not a JSON
  // field); restoring live interim streaming needs a custom channel driver with
  // stream.finalOnly=false. The OpenAI-compatible endpoint still streams tokens.
  "telegram": {
    "enabled": true,                       // opt-in; defaults to false (off → "disabled")
    "botToken": "...",
    "allowedChatIds": ["123456789"],       // or "allowAllChats": true
    "allowAllChats": false
  },

  "slack": {
    "enabled": true,                       // opt-in; defaults to false (off → "disabled")
    "botToken": "xoxb-...",                // Socket Mode app
    "appToken": "xapp-...",
    "allowedChannelIds": ["C0123"],        // or "allowAllChannels": true
    "allowAllChannels": false,
    "botUserIds": ["U0BOT"],               // mention detection
    "mentionTextAliases": ["@agent"],
    "stripMentionText": true
  },

  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "config": {
          "enabled": true,                 // opt-in; defaults to false (off -> "disabled")
          "allowedChatJids": ["123@s.whatsapp.net"], // or "allowAllChats": true
          "allowAllChats": false,
          "groupMode": "mention",          // mention | any (group trigger rule)
          "botJids": ["456@s.whatsapp.net"],
          "mentionTextAliases": ["@agent"],
          "stripMentionText": true
          // Baileys auth state lives in .mono-agent/whatsapp-auth; the start log
          // prints a QR code to scan on first login.
        }
      },
      {
        "package": "@mono-agent/a2a-adapter",
        "id": "a2a",
        "config": {
          "enabled": true,
          "provider": {
            "host": "127.0.0.1",
            "port": 4201,
            "publicBaseUrl": "https://agent.example.com", // Agent Card URL when fronted by a proxy
            "allowNonLoopback": false,
            "requireBearer": false,
            "bearerToken": "..."
          },
          "agent": { "name": "My Agent", "description": "What it does.", "version": "0.1.0" },
          "skill": { "id": "main", "name": "Main", "description": "Primary skill.", "tags": ["agent"] },
          "consumer": {                    // settings for calling remote A2A agents
            "remoteAgentUrls": ["http://127.0.0.1:4202"],
            "defaultRemoteAgentUrl": "http://127.0.0.1:4202",
            "bearerToken": "...",
            "timeoutMs": 30000
            // Consumed programmatically (createA2AConsumerResponder); the app's A2A
            // channel runs the provider side.
          }
        }
      }
    ]
  },

  "cron": {
    "dir": "cron",                         // optional: folder of *.md jobs (frontmatter + prompt body), default "cron"
    "jobs": [
      {
        "id": "daily",
        "enabled": true,
        "expression": "0 9 * * *",         // five-field cron
        "timezone": "UTC",                 // IANA timezone
        "prompt": "Post the morning summary.",
        "conversationId": "cron-daily"     // optional: share memory/history across ticks
      }
    ]
    // Jobs here merge with cron/*.md files (duplicate ids error).
    // Overlapping ticks of the same job are skipped, never queued.
  }
}
```

## Lifecycle

```bash
mono-agent init --model codex:gpt-5.6-terra --fallback-models pi:opencode-go:kimi-k2.6,pi:ollama:gemma4:31b [--memory lite|journal|bujo]
mono-agent validate     # per-section report incl. sandbox, observability, every channel; exit 0 means structurally valid
mono-agent validate --consumer ../local-agent-alpha  # read-only report for a downstream folder
mono-agent start        # traceability + every configured channel
mono-agent restart      # apply config edits (config is JSON-first; restart to re-apply)
mono-agent restart --force  # restart AND purge persisted pi sessions (fresh start; durable memory kept)
```

Config is JSON-first: edit `mono-agent.config.json` directly (agents can edit it too) and run `mono-agent restart` to apply. There is no live browser re-apply. `start` prints the traceability source (Phoenix when an `observability.exporters` Phoenix entry is configured, otherwise the local JSONL artifacts) and one status line per channel: `running` with its endpoint facts, `waiting_for_config` with the exact missing setting, `disabled`, or `failed` with the reason.

A `.env` file in the folder is loaded automatically (exported shell variables win); use `--env-file <path>` for an alternate file. `validate --consumer <path>` loads the consumer folder's `.env` by default and resolves relative `--config` / `--env-file` paths there. Keep all secrets there or in `MONO_AGENT_*` env vars — never commit real tokens.

:::caution
:::
For `memory.llm`, CLI-backed refs such as `codex:gpt-5.6-terra` are rejected; use `provider: "ollama"` with a local model string, or `provider: "agent-host"` with an SDK runtime ref like `pi:openai-codex:gpt-5.6-terra` and `executionMode: "sdk"` (omit `endpoint`). See [Capture & recall](/memory/capture-and-recall/).

## Section reference

Every top-level section maps to a deep-dive page:

| Section | What it controls | Deep dive |
| --- | --- | --- |
| `runtime` | Model, fallback chain, execution mode, effort, sessions | [Backends](/runtime/backends/), [Effort & permissions](/runtime/execution-effort-permissions/), [Fallback](/runtime/fallback/), [Sessions & concurrency](/runtime/sessions-concurrency/) |
| `providers` | Pi auth, `piNative` bridge tuning, local/self-hosted providers | [Local providers](/runtime/local-providers/) |
| `context` | Identity, soul, skills selection | [Identity & soul](/context/identity-and-soul/), [Skills](/context/skills/), [Assembly](/context/assembly/) |
| `memory` | Tier, embeddings, capture LLM, consolidation | [Embeddings](/memory/embeddings/), [Capture & recall](/memory/capture-and-recall/), [Consolidation](/memory/rituals/) |
| `tools` | Allow/deny tool policy, MCP servers | [Tool policy](/tools/policy/), [MCP](/tools/mcp/) |
| `sandbox` | Filesystem/network confinement for runtime commands | [Sandbox](/tools/sandbox/) |
| `artifacts`, `traceability` | JSONL run summaries + the trace-source registry | [Artifacts & traces](/observability/artifacts-and-traces/) |
| `observability` | Optional Phoenix (OTLP) exporter | [Phoenix & backfill](/observability/phoenix-and-backfill/) |
| `webhook` | HTTP invoke endpoint (sync/async) | [Webhook](/channels/webhook/) |
| `openaiApi` | OpenAI-compatible `/v1` endpoint (streams tokens) | [OpenAI API](/channels/openai-api/) |
| `telegram` | Telegram bot channel | [Telegram](/channels/telegram/) |
| `slack` | Slack Socket Mode channel | [Slack](/channels/slack/) |
| `channels.plugins[]` | External channel packages such as WhatsApp and A2A | [Write your own channel adapter](/programmatic/custom-channels/), [WhatsApp](/channels/whatsapp/), [A2A](/channels/a2a/) |
| `cron` | Scheduled prompt jobs (inline + `cron/*.md`) | [Cron](/channels/cron/) |

For per-section env vars see [Environment variables](/config/env-vars/). When config cannot express what you need (custom runtime, request-scoped extensions, custom channels, tool-approval gates, structured-output schemas), use the [programmatic escape hatch](/programmatic/).
