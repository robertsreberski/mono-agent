---
title: "Tool policy"
sidebar:
  order: 1
---

# Tool policy

The tool policy decides which tools an agent may call — built-in tools (Read, Bash, …), adapter send tools, and MCP tools. It is **allow-all by default**: an agent with no `tools` block gets every tool, and you subtract from there. You declare it under `tools.allowedTools` / `tools.disallowedTools` (coverage: `config`), with deny always winning and overlaps rejected up front.

## Allow-all by default

If you set no `tools` block, or omit `allowedTools`, the agent can call **every** built-in and every enabled channel's send tools. There is no allowlist to curate before an agent can do anything — you start open and remove what you don't want. `allowedTools` accepts four shapes:

| `tools.allowedTools` | Result |
| --- | --- |
| omitted | **all tools** (the default) |
| `["*"]` | all tools (explicit allow-all) |
| `["Read", "Bash"]` | just those tools |
| `[]` | **no tools** — a deliberate chat-only agent |

```json
{
  "tools": {
    "allowedTools": ["*"]
  }
}
```

An explicit empty list is still expressible and still meaningful: `"allowedTools": []` means the agent can hold a conversation but cannot read files, run commands, or send proactively. [`validate` / `doctor`](/observability/cli-reference/#validate) reports that as `waiting` (never a silent `ok`) so an accidental empty list surfaces, while allow-all reports `All tools allowed.`

:::note
Allow-all is the **config** default, not a programmatic one. For code-defined agents built directly on `@mono-agent/agent-harness`, the no-config safety net is the opposite: `failClosedToolPolicy()` returns `{ allowedTools: [], disallowedTools: [] }` — an empty, fail-closed policy — so a harness constructed with no policy starts with zero tools until you pass one. The allow-all default lives in the config loader, not the harness.
:::

:::caution
**Enforcement varies by runtime.** The two guarantees above — `[]` yields a chat-only agent, and a specific list restricts to exactly those names — are enforced in full only on the **pi-native** runtime.

- **pi-native** — both guarantees hold: `[]` is a true chat-only agent, and a specific list is the agent's complete tool surface.
- **Claude Code** CLI — a specific non-empty list is passed as `--tools` and *does* restrict, but `[]` omits `--tools`, so Claude Code falls back to its **full default toolset** (auto-approved under a permissive `permissionMode`). To constrain it, use `disallowedTools` or a stricter `permissionMode` rather than relying on `[]`.
- **Codex** CLI — `allowedTools` (`[]`, a specific list, or `["*"]`) is inert for Codex's own native tools; the tool policy does not gate them.

`disallowedTools` still filters mono-agent's built-in, skill, and adapter send tools on every runtime (see [Deny is enforced on every runtime](#deny-is-enforced-on-every-runtime)).
:::

## allowedTools / disallowedTools

| Key | Type | Behavior |
| --- | --- | --- |
| `tools.allowedTools` | `string[]` | The allowlist. Omitted or `["*"]` means all tools; a specific list narrows to those names; `[]` means none. |
| `tools.disallowedTools` | `string[]` | The denylist. Tools named here are always blocked, even under allow-all. |

Two rules govern how the lists combine:

- **Deny wins.** A tool in `disallowedTools` is blocked regardless of anything else — including allow-all. `disallowedTools` is how you subtract a single tool from the open default without switching to an explicit allowlist.
- **Overlap is rejected, not resolved.** If the same tool name appears in *both* lists, agent creation fails with an `invalid_tool_policy` error (`"Tools cannot be both allowed and disallowed."`) reporting the overlapping names. The policy is not silently reconciled — you must fix the config.

Each list must contain unique, non-empty strings; duplicate names within a single list also raise `invalid_tool_policy`. Name matching is case-insensitive for duplicate detection.

```json
{
  "tools": {
    "disallowedTools": ["Bash"]
  }
}
```

:::note
The example above keeps allow-all (every tool stays available) but denies `Bash` — the agent can read, edit, fetch, and send, just not run shell commands. To go the other way and hand-pick a minimal surface, list the exact names in `allowedTools` instead.
:::

## Deny is enforced on every runtime

`disallowedTools` is honored on **every** runtime, including the pi-native bridge. It filters the built-in tools (`Read`, `Bash`, …), the progressive-disclosure `ReadSkill` tool, and the app-owned adapter send tools (`SlackSendMessage`, `TelegramSendMessage`, …). The **Claude Code** CLI runtime additionally passes `--disallowedTools` down to the underlying CLI, so the denial reaches the tools Claude Code itself exposes. The **Codex** CLI runtime passes **no** tool denylist flag — there, `disallowedTools` still filters mono-agent's built-in, skill, and adapter send tools, but it does **not** gate the Codex CLI's own native tools.

:::caution
**Known limitation — external MCP tools on pi.** Arbitrary tools advertised by an external MCP server are **not** deny-filtered on the pi-native runtime yet. Listing such a tool in `disallowedTools` has no effect there. To hard-restrict an external MCP tool on pi, **don't declare its server** in `mcp.json` / `tools.mcpServers` — server declaration, not the denylist, is what governs its availability. (The app-owned adapter send tools are exempt from this limitation: they are gated by the app, so their `disallowedTools` entries are honored everywhere.)
:::

## Built-in tool names

These are the names recognized for built-in runtime tools (coverage: `config`, gated by this policy):

`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`

Commands run by `Bash` are further constrained by the [sandbox](/tools/sandbox/) (filesystem scopes and network policy) when `sandbox.mode` is `native`. The allowlist controls *whether* a tool exists; the sandbox controls *what it can reach*. See [Tools and guards](/runtime/tools-and-guards/).

## Adapter send tools

The app can expose MCP tools that send messages back out through an already-enabled channel adapter: `SlackSendMessage`, `TelegramSendMessage`, `TelegramAskButtons` (inline-keyboard question), `TelegramSendFile` (document or photo), and the channel-agnostic `AskUser` (coverage: `config`).

Under **allow-all** these are available automatically once the matching channel is enabled — you do not add them to any list. They only need an explicit `allowedTools` entry when you switch to a hand-picked allowlist: in that case, add the exact tool name **in addition** to valid `slack.*` / `telegram.*` adapter config. Either way, `disallowedTools` can remove them.

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep", "SlackSendMessage", "TelegramSendMessage"]
  }
}
```

:::note
The adapter's own allowlist (channels/chats it may post to) remains the destination boundary — allowing the tool does not widen where messages can go. See [Delivery and send tools](/channels/delivery-and-send-tools/), [Slack](/channels/slack/), and [Telegram](/channels/telegram/).
:::

## Tools not gated by allowedTools

Two families are never gated by `allowedTools` and are unaffected by the allow-all / specific-list choice:

- **`MemoryRecall`** — auto-provisioned from `config.memory.recallTool.enabled`. See [Capture & recall](/memory/capture-and-recall/).
- **MCP-server tools** (`mcp__…`) — governed by whether their server is declared, not by the allowlist. See below and [MCP servers](/tools/mcp/).

## MCP tools

MCP servers are configured alongside the policy via `tools.mcpServers` (inline) or `tools.mcpConfigPath` (a path to a JSON file). Their tools are always available once the server is declared; the allowlist neither adds nor removes them (and on pi the denylist can't either — see the known limitation above). See [MCP servers](/tools/mcp/) for the server configuration shape.

## Environment overrides

The allow/deny lists can be supplied via environment variables (coverage: `config`):

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_ALLOWED_TOOLS` | `tools.allowedTools` |
| `MONO_AGENT_DISALLOWED_TOOLS` | `tools.disallowedTools` |

The same rules apply through the environment: an **unset** `MONO_AGENT_ALLOWED_TOOLS` keeps the allow-all default, an empty value (`MONO_AGENT_ALLOWED_TOOLS=""`) is the explicit chat-only `[]`, and deny-wins / overlap-rejection are unchanged. See [Environment variables](/config/env-vars/).

## Back-compat: legacy tool names

The tools were renamed to PascalCase, and the old snake_case spellings (`slack_send_message`, `telegram_ask`, `read_skill`, …) are still accepted as **deprecated input aliases** in `allowedTools` / `disallowedTools`. `telegram_send_document` and `telegram_send_photo` both now map to the single `TelegramSendFile` tool, so a `disallowedTools` entry for either legacy name denies the whole file tool. The new PascalCase names are the only ones ever registered, emitted, or recommended — update hand-written lists when convenient. See [Presets & modules](/reference/recipes/#back-compat-legacy-tool-names).

## Programmatic use

The policy is also available as a library for code-defined agents: `createToolPolicy()`, `failClosedToolPolicy()`, `loadToolPolicyFromJsonFile()`, and `toolPolicyToRuntimeOptions()` from `@mono-agent/agent-harness`. Errors are thrown as `ToolPolicyError` with codes `invalid_tool_policy` and `tool_policy_read_failed`. See [Programmatic API](/programmatic/).
