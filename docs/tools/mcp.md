---
title: "MCP servers"
sidebar:
  order: 2
---

# MCP servers

This page covers how mono-agent attaches [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers to your agent through `tools.mcpConfigPath`, how the path is resolved and forwarded to the runtime, and the one rule that surprises people: **MCP tools are not gated by `tools.allowedTools`**. Coverage type: `config`.

## What `tools.mcpConfigPath` does

Point `tools.mcpConfigPath` at an `mcp.json` file describing one or more MCP servers (stdio, SSE, or streamable HTTP). The agent gains every tool those servers advertise.

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep"],
    "disallowedTools": ["Bash"],
    "mcpConfigPath": "./mcp.json"
  }
}
```

| Key | Type | Notes |
| --- | --- | --- |
| `tools.mcpConfigPath` | string | Path to an `mcp.json`. Resolved against the workspace, not the config file. |
| `tools.allowedTools` | string[] | Allowlist for **built-in** runtime tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`) and adapter send tools. Omit (or `["*"]`) for allow-all; a specific list narrows to those names. Does not affect MCP tools. |
| `tools.disallowedTools` | string[] | Denylist; deny always wins, even under allow-all. Filters built-ins, `ReadSkill`, and adapter send tools. On the pi-native runtime it does **not** filter external MCP-server tools (see below). |

Env var: `MONO_AGENT_MCP_CONFIG_PATH` overrides `tools.mcpConfigPath`.

`mcpConfigPath` resolves against the **workspace** (`runtime.workspace`, default `"."`), so a relative path like `./mcp.json` is read from the same folder the agent operates in. Keep the file beside your `mono-agent.config.json` and reference it relatively for portability.

## Example `mcp.json` (stdio server)

A stdio server is a child process the runtime spawns and talks to over stdin/stdout:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

SSE and streamable HTTP servers use a `url` instead of `command`/`args`:

```json
{
  "mcpServers": {
    "remote-api": {
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

Keep tokens as placeholders in committed files; prefer `env` references or a non-tracked `mcp.json`. Run `mono-agent validate` to confirm the file is found — it reports the resolved `MCP config:` path or a `MCP config file is missing:` warning.

:::tip
:::
You can also inline servers directly in config via `tools.mcpServers` (an object keyed by server name) instead of a separate file. The file (`mcpConfigPath`) and the inline form (`mcpServers`) carry the same per-server schema.

## SDK runtimes vs CLI runtimes

How the servers reach the underlying runtime depends on the backend:

- **SDK runtimes** — the servers are **inlined** into the runtime options the agent passes to the provider session. The `mcp.json` is read and its `mcpServers` are merged into the request.
- **CLI runtimes** — the `mcpConfigPath` is **forwarded** as a path; the CLI process reads the file itself.

Either way you author one `mcp.json` and mono-agent does the right thing for the configured backend. See [Runtime backends](/runtime/backends/) for which backends are SDK vs CLI.

## MCP tools are NOT gated by `tools.allowedTools`

This is the load-bearing rule. `tools.allowedTools` / `tools.disallowedTools` filter the **built-in** runtime tools (`Read`, `Bash`, …) only. They do **not** suppress tools provided by an MCP server.

Consequences:

- Under allow-all (the default) MCP tools are available because their server is declared, not because of the wildcard. Setting `tools.allowedTools: []` ("no built-in tools") still leaves every MCP tool available.
- An MCP tool's availability is governed by whether its server is **declared** in `mcp.json` / `tools.mcpServers`, not by the allowlist. To withhold an MCP tool, remove or don't declare its server.
- On the **pi-native runtime**, `disallowedTools` does **not** filter external MCP-server tools either — declaring the server is the only lever. (The Claude/Codex CLI runtimes do pass `--disallowedTools` down to the CLI.) So to hard-restrict an external MCP tool on pi, don't declare its server.
- This same model covers app-injected MCP tools such as `MemoryRecall` and the `AskCollaborator` orchestration tool — they are gated by their own enable switches, not by the allowlist.

The `MemoryRecall` description is written to direct **proactive** recall: the agent is told to call it whenever context is missing or uncertain, before assuming or asking. This is behavioral guidance, not a gate — `MemoryRecall`'s availability is still governed by `config.memory.recallTool.enabled`. See [Capture & recall](/memory/capture-and-recall/).

:::note
The **app-owned adapter send tools** (`SlackSendMessage`, `TelegramSendMessage`, `TelegramAskButtons`, `TelegramSendFile`, `AskUser`) are delivered as MCP tools but, unlike external MCP tools, they **are** governed by the tool policy. Under allow-all (the default) they become available automatically once the matching channel is enabled — no allowlist entry needed. They only need an explicit `tools.allowedTools` entry when you switch to a hand-picked allowlist, and a `disallowedTools` entry removes them on any runtime. Valid `slack.*` / `telegram.*` adapter config is required either way. See [Delivery & send tools](/channels/delivery-and-send-tools/).
:::

For the full allow/deny semantics of built-in tools, see [Tool policy](/tools/policy/). For how `Bash` is confined, see [Sandbox](/tools/sandbox/).

## Related

- [Tool policy](/tools/policy/) — the built-in allow/deny model that MCP tools sit outside of.
- [Tools & guards](/runtime/tools-and-guards/) — built-in tool catalog and runtime guards.
- [Capture & recall](/memory/capture-and-recall/) — `MemoryRecall`, an app-injected MCP tool.
- [Slack team bot with MCP tools](/playbooks/slack-team-bot-mcp-tools/) — end-to-end playbook wiring MCP servers into a channel agent.
- Need to register MCP servers from code instead of config? See [Programmatic composition](/programmatic/composition/).
