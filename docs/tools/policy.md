---
title: "Tool policy"
sidebar:
  order: 1
---

# Tool policy

The tool policy decides which tools an agent may call — built-in tools (Read, Bash, …), adapter send tools, and MCP tools. It is **fail-closed**: an empty allowlist means the agent has *no* tools. You declare it under `tools.allowedTools` / `tools.disallowedTools` (coverage: `config`), with deny always winning and overlaps rejected up front.

## Fail-closed by default

If you set no `tools` block, or leave `allowedTools` empty, the agent starts with **zero callable tools**. There is no implicit "allow everything" — you opt tools in by name. This is enforced at agent creation: `failClosedToolPolicy()` returns `{ allowedTools: [], disallowedTools: [] }`.

To give an agent tools, list them explicitly:

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep", "Glob"]
  }
}
```

:::caution
If your agent appears to have no tools available, the most common cause is an empty or missing `allowedTools`.
:::

## allowedTools / disallowedTools

| Key | Type | Behavior |
| --- | --- | --- |
| `tools.allowedTools` | `string[]` | The allowlist. Only tools named here are callable. |
| `tools.disallowedTools` | `string[]` | The denylist. Tools named here are always blocked. |

Two rules govern how the lists combine:

- **Deny wins.** A tool in `disallowedTools` is blocked regardless of anything else.
- **Overlap is rejected, not resolved.** If the same tool name appears in *both* lists, agent creation fails with an `invalid_tool_policy` error (`"Tools cannot be both allowed and disallowed."`) reporting the overlapping names. The policy is not silently reconciled — you must fix the config.

Each list must contain unique, non-empty strings; duplicate names within a single list also raise `invalid_tool_policy`. Name matching is case-insensitive for duplicate detection.

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep", "WebFetch"],
    "disallowedTools": ["Bash"]
  }
}
```

:::note
The example above lets the agent read files, grep, and fetch URLs, while keeping `Bash` denied even if a later edit accidentally adds it to the allowlist (deny wins). Listing `Bash` in both lists at once would be an error.
:::

## Built-in tool names

These are the names recognized for built-in runtime tools (coverage: `config`, gated by this policy):

`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`

Commands run by `Bash` are further constrained by the [sandbox](/tools/sandbox/) (filesystem scopes and network policy) when `sandbox.mode` is `native`. The allowlist controls *whether* a tool exists; the sandbox controls *what it can reach*. See [Tools and guards](/runtime/tools-and-guards/).

## Adapter send tools

The app can expose MCP tools that send messages back out through an already-enabled channel adapter: `slack_send_message` and `telegram_send_message` (coverage: `config`). These are **not** on by default — they must be added to `tools.allowedTools` by their exact name, and the matching `slack.*` / `telegram.*` adapter config must be present and valid.

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep", "slack_send_message", "telegram_send_message"]
  }
}
```

:::note
The adapter's own allowlist (channels/chats it may post to) remains the destination boundary — allowlisting the tool does not widen where messages can go. See [Delivery and send tools](/channels/delivery-and-send-tools/), [Slack](/channels/slack/), and [Telegram](/channels/telegram/).
:::

## MCP tools

MCP servers are configured alongside the policy via `tools.mcpServers` (inline) or `tools.mcpConfigPath` (a path to a JSON file). The tools they expose are subject to the same allow/deny rules. See [MCP servers](/tools/mcp/) for the server configuration shape.

## Environment overrides

The allow/deny lists can be supplied via environment variables (coverage: `config`):

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_ALLOWED_TOOLS` | `tools.allowedTools` |
| `MONO_AGENT_DISALLOWED_TOOLS` | `tools.disallowedTools` |

The same fail-closed, deny-wins, and overlap-rejection rules apply to values provided through the environment. See [Environment variables](/config/env-vars/).

## Programmatic use

The policy is also available as a library for code-defined agents: `createToolPolicy()`, `failClosedToolPolicy()`, `loadToolPolicyFromJsonFile()`, and `toolPolicyToRuntimeOptions()` from `@mono-agent/agent-harness`. Errors are thrown as `ToolPolicyError` with codes `invalid_tool_policy` and `tool_policy_read_failed`. See [Programmatic API](/programmatic/).
