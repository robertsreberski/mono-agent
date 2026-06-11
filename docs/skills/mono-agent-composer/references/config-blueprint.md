# Config Blueprint

One `mono-agent.config.json` declares the whole agent. Paths are relative to the folder; env vars (`MONO_AGENT_*`) override any field. Omit a section to leave that capability off — every section except `runtime.model` and `context.identityPath` is optional.

## Folder Layout

```text
my-agent/
  mono-agent.config.json   # the single declaration below
  IDENTITY.md              # role, boundaries, references to existing knowledge
  skills/                  # optional: <skill-name>/SKILL.md per selected skill
  mcp.json                 # optional: MCP server definitions
  .mono-agent/
    artifacts/             # JSONL run summaries + events
    workspace/             # runtime working directory (if not ".")
    trace-sources/         # traceability registry (if kept folder-local)
```

## Annotated Config

```jsonc
{
  // Runtime: primary model plus ordered backups tried on retryable provider
  // failures (failover is reported in run results, never silent).
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "fallbackModels": ["pi:ollama:gemma4:31b"],
    "effort": "medium",                    // none|low|medium|high|xhigh|max
    "maxTurns": 8,
    "workspace": ".",
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000 }
  },

  // Local/self-hosted providers for pi:<provider>:<model> references.
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "models": [{ "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }]
      }
    ]
  },

  // Identity, optional soul, and selected skills.
  "context": {
    "identityPath": "./IDENTITY.md",
    "soulPath": "./SOUL.md",
    "skillsRoot": "./skills",
    "selectedSkills": ["research"]
  },

  // Memory strategy. Omit the section for no memory.
  "memory": {
    "mode": "journal",                     // markdown | journal
    "path": "./.mono-agent/memory",        // file for markdown, dir for journal
    "writeMode": "append-host-summary",    // disabled | append-host-summary
    "scope": "single-file",                // markdown only
    "maxBytes": 64000,
    "tools": { "enabled": true, "allowJournalAppend": true } // journal only
  },

  // Fail-closed tool policy + MCP servers.
  "tools": {
    "allowedTools": ["Read", "Grep"],
    "disallowedTools": ["Bash"],
    "mcpConfigPath": "./mcp.json"
  },

  // Sandbox for runtime commands. Omit for no sandboxing.
  "sandbox": {
    "mode": "native",                      // native | off
    "network": { "mode": "none", "allowlist": [] }, // none|localhost|allowlist|all
    "fallback": "fail-closed"              // fail-closed | unsafe-host-process
  },

  "artifacts": { "dir": "./.mono-agent/artifacts" },
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceId": "my-agent",
    "sourceLabel": "My Agent"
  },

  // ----- Channels: one section per channel; all independent. -----

  "webhook": {
    "enabled": true,                       // port 0 picks a free loopback port
    "path": "/webhook/invoke",
    "defaultMode": "sync"                  // sync | async
  },

  "openaiApi": {
    "enabled": true,
    "port": 4040,
    "modelId": "my-agent",
    "apiKey": "..."                        // optional bearer for clients
  },

  "telegram": {
    "botToken": "...",
    "allowedChatIds": ["123456789"]        // or "allowAllChats": true
  },

  "slack": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedChannelIds": ["C0123"]         // or "allowAllChannels": true
  },

  "whatsapp": {
    "allowedChatJids": ["123@s.whatsapp.net"], // or "allowAllChats": true
    "groupMode": "mention"                 // mention | any
    // Baileys auth state lives in .mono-agent/whatsapp-auth; the start log
    // prints a QR code to scan on first login.
  },

  "a2a": {
    "provider": { "enabled": true, "host": "127.0.0.1", "port": 4201 },
    "agent": { "name": "My Agent", "description": "What it does.", "version": "0.1.0" },
    "skill": { "id": "main", "name": "Main", "description": "Primary skill.", "tags": ["agent"] }
  },

  "cron": {
    "jobs": [
      { "id": "daily", "enabled": true, "expression": "0 9 * * *", "timezone": "UTC", "prompt": "Post the morning summary." }
    ]
  }
}
```

## Lifecycle

```bash
mono-agent init --model claude:claude-sonnet-4-6 --fallback-models pi:ollama:gemma4:31b
mono-agent validate     # per-section report; exit 0 means ready
mono-agent start        # console + traceability + every configured channel
mono-agent start --no-console   # headless
```

`start` prints the operator console URL (config editing in the browser; saves re-apply live without restarting), the traceability source, and one status line per channel: `running` with its endpoint facts, `waiting_for_config` with the exact missing setting, `disabled`, or `failed` with the reason.

## Programmatic Escape Hatch

When config cannot express the host (custom runtime, request-scoped runtime extensions, custom channels), compose on the same package the CLI uses:

```ts
import { startMonoAgentApp, defaultChannelDrivers } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({
  cwd: process.cwd(),
  runtime: myCustomRuntime,            // any MonoRuntimeLike
  drivers: [...defaultChannelDrivers(), myCustomDriver],
});
```

For a bare responder without channels, use `@mono-agent/config` + `@mono-agent/agent-host` (`createConfiguredAgentResponder`). For multi-agent orchestration, add `@mono-agent/agent-orchestrator` — see `references/package-map.md`.
