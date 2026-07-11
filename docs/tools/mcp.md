---
title: "MCP servers"
sidebar:
  order: 2
---

# MCP servers

This page covers how mono-agent attaches [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers to your agent through `tools.mcpConfigPath`, how the path is resolved and forwarded to the runtime, and the one rule that surprises people: **external MCP-server tools are not gated by `tools.allowedTools`**. App-owned MCP tools can define a narrower policy boundary; `RunHistory` and the adapter send tools do. Coverage type: `config`.

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
| `tools.allowedTools` | string[] | Allowlist for **built-in** runtime tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`) and policy-gated app-owned tools such as `RunHistory` and adapter send tools. Omit (or `["*"]`) for allow-all; a specific list narrows to those names. Does not affect external MCP-server tools. |
| `tools.disallowedTools` | string[] | Denylist; deny always wins, even under allow-all. Filters built-ins, `ReadSkill`, `RunHistory`, and adapter send tools. On the pi-native runtime it does **not** filter external MCP-server tools (see below). |

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

## Runtime support

How the servers reach the underlying runtime depends on the backend:

- **SDK runtimes** — the servers are **inlined** into the runtime options the agent passes to the provider session. The `mcp.json` is read and its `mcpServers` are merged into the request.
- **Supported CLI runtimes** — mono-agent translates or forwards the server config into the provider-native shape.
- **Direct OpenCode** — MCP is intentionally unsupported because provider-owned shell tools inherit the server environment. Any configured server, `MemoryRecall`, hosted Supermemory MCP, or real adapter send-tool injection fails validation and the bridge before startup. The host's implicit `RunHistory` and bridge-backed `AskUser` / `TelegramAskButtons` tools are omitted for a direct OpenCode primary/fallback and for an accepted per-trigger direct OpenCode turn; they do not make an otherwise minimal exact-allow-all config unusable. A rejected per-trigger override stays on its base runtime and keeps those tools. Use a Pi runtime, including `pi:opencode-go:*`, when MCP or host-mediated questions are required.

For supported backends, you author one `mcp.json` and mono-agent does the translation. See [Runtime backends](/runtime/backends/) for the exact capability boundary.

## External MCP tools are NOT gated by `tools.allowedTools`

This is the load-bearing rule for declared external servers. `tools.allowedTools` / `tools.disallowedTools` filter built-in runtime tools (`Read`, `Bash`, …) and policy-gated app-owned tools. They do **not** suppress tools provided by an external MCP server.

Consequences:

- Under allow-all (the default) MCP tools are available because their server is declared, not because of the wildcard. Setting `tools.allowedTools: []` ("no built-in tools") still leaves every MCP tool available.
- An MCP tool's availability is governed by whether its server is **declared** in `mcp.json` / `tools.mcpServers`, not by the allowlist. To withhold an MCP tool, remove or don't declare its server.
- On the **pi-native runtime**, `disallowedTools` does **not** filter external MCP-server tools either — declaring the server is the only lever. Claude Code receives `--disallowedTools`; direct Codex has no native name-policy projection and therefore rejects any normal-run restrictive policy instead of partially enforcing it. To hard-restrict an external MCP tool on pi, don't declare its server.
- App-injected MCP tools define their own boundary. `MemoryRecall` and `AskCollaborator` are gated by their own enablement/composition switches; `RunHistory` and adapter send tools are deliberately governed by the normal tool policy.

The `MemoryRecall` description is written to direct **proactive** recall: the agent is told to call it whenever context is missing or uncertain, before assuming or asking. This is behavioral guidance, not a gate — `MemoryRecall`'s availability is still governed by `config.memory.recallTool.enabled`. See [Capture & recall](/memory/capture-and-recall/).

## `RunHistory`: prior-run evidence

`RunHistory` is an app-owned, read-only, request-scoped MCP tool over the existing local run artifacts. There is no new config key. Under allow-all it is exposed automatically on MCP-capable routes; under a restrictive policy, add the exact `RunHistory` name. The deprecated input alias `run_history` is accepted in `tools.allowedTools` / `tools.disallowedTools`, but only `RunHistory` is registered and shown to the model. Direct OpenCode and other MCP-incompatible routes suppress it.

It supports two actions:

- `{ "action": "list", "limit": 5 }` lists recent completed prior runs from the exact current conversation bucket; `limit` is optional (default 5, range 1–10).
- `{ "action": "inspect", "runId": "..." }` verifies that the selected run belongs to that same bucket, then returns normalized chronological evidence: trigger text, visible assistant output, tool calls with linked results, warnings/provider failures, timestamps, and final output.

The current or any running run is excluded, as are other conversations and rollover buckets. The safe projection never returns system prompts, reasoning/thinking, recalled memory or turn-context payloads, raw artifact paths, provider-session metadata, or sensitive-key values. Structured and artifact-shaped opaque tool results are scrubbed or omitted. Existing redaction and per-string bounds apply; total results are deterministically capped and announce truncation. All historical content is labelled untrusted evidence, never instructions.

Use active conversation history first for the current exchange. Use `MemoryRecall` for intentionally captured durable facts, and `RunHistory` for exact evidence from an earlier run or tool call. See [Artifacts and traces](/observability/artifacts-and-traces/#agent-facing-prior-run-evidence-runhistory).

:::note
The **app-owned adapter send tools** (`SlackSendMessage`, `TelegramSendMessage`, `TelegramAskButtons`, `TelegramSendFile`, `AskUser`) are also delivered as MCP tools but, unlike external MCP tools, they **are** governed by the tool policy. Under allow-all they become available automatically once the matching channel is enabled. On runtimes that enforce specific lists, name them explicitly or deny them normally; direct Codex rejects the restrictive configuration before a run. Valid `slack.*` / `telegram.*` adapter config is required either way. See [Delivery & send tools](/channels/delivery-and-send-tools/).
:::

For the full allow/deny semantics of built-in tools, see [Tool policy](/tools/policy/). For how `Bash` is confined, see [Sandbox](/tools/sandbox/).

## Related

- [Tool policy](/tools/policy/) — the allow/deny model and app-owned MCP exceptions.
- [Tools & guards](/runtime/tools-and-guards/) — built-in tool catalog and runtime guards.
- [Capture & recall](/memory/capture-and-recall/) — `MemoryRecall`, an app-injected MCP tool.
- [Artifacts and traces](/observability/artifacts-and-traces/) — the run records projected safely by `RunHistory`.
- [Slack team bot with MCP tools](/playbooks/slack-team-bot-mcp-tools/) — end-to-end playbook wiring MCP servers into a channel agent.
- Need to register MCP servers from code instead of config? See [Programmatic composition](/programmatic/composition/).
