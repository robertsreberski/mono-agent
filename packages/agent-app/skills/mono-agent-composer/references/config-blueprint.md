# Config Blueprint

> A prose, per-domain version of this reference (runtime, channels, memory, …)
> lives on the published docs site:
> <https://mono-agent-docs.vercel.app/config/>. This annotated JSON
> stays the offline canonical shape.

One `mono-agent.config.json` declares the whole agent. Paths are relative to the folder; every field also has a `MONO_AGENT_*` env var that overrides it (env > JSON > defaults). Omit a section to leave that capability off — every section except `runtime.model` and `context.identityPath` is optional. `references/feature-coverage.md` maps every framework feature to its config key; if a capability is not listed there, it needs the programmatic escape hatch.

## Folder Layout

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

## Annotated Config

```jsonc
{
  // Runtime: primary model plus ordered backups tried on retryable provider
  // failures (failover is reported in run results, never silent).
  "runtime": {
    "model": "claude:claude-sonnet-4-6",   // claude:* | codex:* | pi:<provider>:<model>
    "fallbackModels": ["pi:ollama:gemma4:31b"],
    "executionMode": "sdk",                // sdk | cli (default inferred from model)
    "effort": "medium",                    // none|low|medium|high|xhigh|max
    "permissionMode": "default",           // default|plan|acceptEdits|bypassPermissions (CLI backends)
    "reasoningSummary": "auto",            // auto|concise|detailed|off|on
    "maxTurns": 0,                         // 0 or omitted means unlimited; 1-100 caps turns
    "workspace": ".",
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000 } // or "per-message"
  },

  // Local/self-hosted providers for pi:<provider>:<model> references.
  "providers": {
    "piAuthPath": "~/.pi/agent/auth.json", // Pi OAuth credentials (openai-codex, ...)
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
  // Three tiers over one substrate (memory-store + memory-bujo):
  //   lite    — FTS keyword recall + rapid-log; no external deps.
  //   journal — + hybrid recall (BM25+vector) + decay; needs embeddings.
  //   bujo    — + LLM capture/reconcile + entity graph + auto-scheduled
  //             reflection/migration; needs embeddings + an app-level memory.llm.
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
    "llm": {                               // enables bujo capture/rituals; omit for lite/journal
      // Env: MONO_AGENT_MEMORY_LLM_PROVIDER / _MODEL / _EXECUTION_MODE / _ENDPOINT.
      "provider": "ollama",                // ollama | agent-host
      "model": "qwen3.6:latest",           // ollama: model string; agent-host: runtime ref, e.g. pi:openai-codex:gpt-5.5
      "endpoint": "http://localhost:11434" // ollama only; invalid for agent-host
      // For agent-host, use: "model": "pi:openai-codex:gpt-5.5", "executionMode": "sdk"; omit endpoint.
    },
    // Bujo auto-scheduler — override defaults or disable per-ritual.
    // Rituals run in-app; no external cron or launchd needed.
    "reflection": { "enabled": true, "cron": "0 3 * * *" },  // default: nightly 03:00
    "migration":  { "enabled": true, "cron": "0 4 1 * *" }   // default: 1st of month 04:00
  },

  // Fail-closed tool policy + MCP servers. Deny wins; overlap is rejected.
  "tools": {
    "allowedTools": ["Read", "Grep"],      // built-ins: Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch
    "disallowedTools": ["Bash"],
    "mcpConfigPath": "./mcp.json"          // stdio/sse/http servers; inlined for SDK runtimes
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
  "artifacts": { "dir": "./.mono-agent/artifacts" },
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceId": "my-agent",
    "sourceLabel": "My Agent",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000
  },

  // Optional trace viewer: add a Phoenix (OTLP) exporter to browse traces in
  // Phoenix. Omit this entry to keep only the local JSONL artifacts.
  "observability": {
    "exporters": [
      { "type": "phoenix", "endpoint": "http://127.0.0.1:6006/v1/traces" }
    ]
  },

  // ----- Channels: one section per channel; all independent. An unconfigured
  // ----- channel reports waiting_for_config and never blocks the others.

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
    "apiKey": "..."                        // optional bearer required from clients
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

  "whatsapp": {
    "enabled": true,                       // opt-in; defaults to false (off → "disabled")
    "allowedChatJids": ["123@s.whatsapp.net"], // or "allowAllChats": true
    "allowAllChats": false,
    "groupMode": "mention",                // mention | any (group trigger rule)
    "botJids": ["456@s.whatsapp.net"],
    "mentionTextAliases": ["@agent"],
    "stripMentionText": true
    // Baileys auth state lives in .mono-agent/whatsapp-auth; the start log
    // prints a QR code to scan on first login.
  },

  "a2a": {
    "provider": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 4201,
      "publicBaseUrl": "https://agent.example.com", // Agent Card URL when fronted by a proxy
      "allowNonLoopback": false,
      "requireBearer": false,
      "bearerToken": "..."
    },
    "agent": { "name": "My Agent", "description": "What it does.", "version": "0.1.0" },
    "skill": { "id": "main", "name": "Main", "description": "Primary skill.", "tags": ["agent"] },
    "consumer": {                          // settings for calling remote A2A agents
      "remoteAgentUrls": ["http://127.0.0.1:4202"],
      "defaultRemoteAgentUrl": "http://127.0.0.1:4202",
      "bearerToken": "...",
      "timeoutMs": 30000
      // Consumed programmatically (createA2AConsumerResponder); the app's A2A
      // channel runs the provider side.
    }
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
mono-agent init --model claude:claude-sonnet-4-6 --fallback-models pi:ollama:gemma4:31b [--memory lite|journal|bujo]
mono-agent validate     # per-section report incl. sandbox, observability, every channel; exit 0 means ready
mono-agent start        # traceability + every configured channel
mono-agent restart      # apply config edits (config is JSON-first; restart to re-apply)
mono-agent restart --force  # restart AND purge persisted pi sessions (fresh start; durable memory kept)
```

A `.env` file in the folder is loaded automatically (exported shell variables win); use `--env-file <path>` for an alternate file. `start` prints the traceability source (Phoenix when an `observability.exporters` Phoenix entry is configured, otherwise the local JSONL artifacts) and one status line per channel: `running` with its endpoint facts, `waiting_for_config` with the exact missing setting, `disabled`, or `failed` with the reason. Config is JSON-first: edit `mono-agent.config.json` directly (agents can edit it) and run `mono-agent restart` to apply — there is no live browser re-apply.

For BuJo capture and rituals, configure `memory.llm`. Use `provider: "ollama"` with a local Ollama chat model string and optional `endpoint`, or `provider: "agent-host"` with `model` as a normal SDK runtime model reference such as `pi:openai-codex:gpt-5.5` and `executionMode: "sdk"`. `endpoint` is Ollama-only, and CLI-backed refs such as `codex:gpt-5.5` are rejected for memory LLMs until runtimes can enforce no external actions. The same values can be supplied via `MONO_AGENT_MEMORY_LLM_PROVIDER`, `MONO_AGENT_MEMORY_LLM_MODEL`, `MONO_AGENT_MEMORY_LLM_EXECUTION_MODE`, and `MONO_AGENT_MEMORY_LLM_ENDPOINT`. The standalone `memory-bujo` maintenance CLI remains Ollama-only; `agent-host` LLM capture is an in-app composition path that injects the `LlmComplete` implementation into the BuJo store.

For a local terminal chat, `@mono-agent/tui` ships a `mono-agent-tui` bin. The TUI is a communication adapter, not a harness: `--responder <file>` (an ESM module that default-exports an `AgentResponderLike`, or exports `createResponder(env, cwd, configJson)`) is **required**; `--config <path>` is optional and only enables the Config pane (forwarded to `createResponder()`). Example: `mono-agent-tui --responder ./responder.mjs --config ./mono-agent.config.json`.

## Programmatic Escape Hatch

When config cannot express the host (custom runtime, request-scoped runtime extensions, custom channels, tool approval gates, structured output schemas), compose on the same package the CLI uses:

```ts
import { startMonoAgentApp, defaultChannelDrivers } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({
  cwd: process.cwd(),
  runtime: myCustomRuntime,            // any MonoRuntimeLike
  drivers: [...defaultChannelDrivers(), myCustomDriver],
});
```

For a bare responder without channels, use `@mono-agent/config` + `@mono-agent/agent-host` (`createConfiguredAgentResponder` — also takes `memory`, `historyStore`, `runtimeOptions`, `runtimeOptionsForRequest`). For multi-agent orchestration, add `@mono-agent/agent-orchestrator` (`createCollaboratorToolRuntimeExtension`) — see `references/package-map.md`. Channel message texts and stream tuning (welcome/help/error texts, edit debounce) are channel-driver overrides, not config keys.
