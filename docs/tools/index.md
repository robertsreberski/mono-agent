---
title: "Tools, MCP & Sandbox"
sidebar:
  order: 0
---

# Tools, MCP & Sandbox

This section covers how an agent's tool surface is controlled in mono-agent: the **tool policy** (`@mono-agent/agent-harness`) that allow/deny-lists built-in and adapter tools, the **MCP servers** you attach to extend that surface, and the **native sandbox** (`@mono-agent/runtime-adapter`) that confines what tools like `Bash`, `Write`, and `Edit` may touch on disk and over the network.

All three are configured in `mono-agent.config.json`; enforcement depends on the selected runtime boundary and unsupported combinations fail validation rather than becoming advisory. The tool policy is **allow-all by default**. The native mono-agent sandbox applies to Pi-owned tools; direct `codex:*` rejects it and uses Codex's own network-off workspace sandbox, while Claude/direct-OpenCode reject it because their provider-owned tools cannot project the same `srt` scopes. Direct Codex and direct OpenCode accept exact allow-all only because their bridges cannot project a mono-agent name allow/deny list; use Pi for the hardened specific-list example below.

## The three pieces

| Concern | Package | Config block | Page |
| --- | --- | --- | --- |
| Which tools the model may call | `@mono-agent/agent-harness` | `tools.allowedTools` / `tools.disallowedTools` | [Tool Policy](/tools/policy/) |
| Attaching external MCP servers | `@mono-agent/agent-harness` | `tools.mcpConfigPath` → `mcp.json` | [MCP Servers](/tools/mcp/) |
| Confining what tools touch | `@mono-agent/runtime-adapter` | `sandbox.*` | [Sandbox](/tools/sandbox/) |

## At a glance

The `tools` block selects the surface; the `sandbox` block confines it. A minimal hardened configuration looks like this:

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep", "Glob"],
    "disallowedTools": ["Bash"],
    "mcpConfigPath": "./mcp.json"
  },
  "sandbox": {
    "mode": "native",
    "network": { "mode": "none", "allowlist": [] },
    "readableRoots": ["."],
    "writableRoots": ["."],
    "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"],
    "fallback": "fail-closed",
    "unsafeAllowHostProcess": false
  }
}
```

The built-in tools are `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, and `WebSearch` (coverage: `config`). They are gated by `tools.allowedTools` / `tools.disallowedTools`.

Equivalent environment overrides exist for headless deploys:

| Config key | Env var |
| --- | --- |
| `tools.allowedTools` | `MONO_AGENT_ALLOWED_TOOLS` |
| `tools.disallowedTools` | `MONO_AGENT_DISALLOWED_TOOLS` |
| `tools.mcpConfigPath` | `MONO_AGENT_MCP_CONFIG_PATH` |
| `sandbox.mode` | `MONO_AGENT_SANDBOX_MODE` |
| `sandbox.network.mode` / `.allowlist` | `MONO_AGENT_SANDBOX_NETWORK` / `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST` |
| `sandbox.fallback` | `MONO_AGENT_SANDBOX_FALLBACK` |

## Allow-all by default

Omit `tools.allowedTools` (or set it to `["*"]`) and the policy allows **every** tool — the open default. On runtimes that enforce lists, narrow it by naming specific tools or use `[]` for chat-only; deny wins and overlap is rejected. Direct Codex instead rejects all restrictive variants, including `[]` and any `disallowedTools`, so they are never silently widened.

:::caution
An **omitted** `allowedTools` and an **explicit empty** `allowedTools: []` are opposites: omitted means all tools, `[]` means none. To subtract a single tool from the open default, leave `allowedTools` off and add the name to `disallowedTools` — you do not need to switch to an explicit allowlist.
:::

:::note
Allow-all is the **config** default. Code-defined agents built directly on the harness fall back to `failClosedToolPolicy()` (an empty, fail-closed policy) when constructed with no policy — see [Tool Policy](/tools/policy/#allow-all-by-default).
:::

## Request-scoped policies only tighten

Channels and programmatic callers can supply per-request tool and sandbox policies. The harness merges supported policies monotonically: a request can narrow the configured policy, never widen it (coverage: `auto`). If the selected runtime cannot enforce that result—direct Codex/OpenCode with anything other than exact allow-all, or Claude Code CLI with explicit empty—the run fails with a capability mismatch rather than proceeding wider.

Model routing is checked against the same boundary. A direct Codex host accepts
only direct Codex fallbacks/overrides. With native mono-agent sandboxing enabled,
Claude/direct-OpenCode primaries, fallbacks, and trigger overrides are rejected;
a dynamic override to either is warned and ignored.

## Where to go next

- **[Tool Policy](/tools/policy/)** — allowlist/denylist semantics, built-in tools, naming MCP tools, and how approval gates relate (the latter is `code`-only — see [programmatic/](/programmatic/approval-and-structured-output/)).
- **[MCP Servers](/tools/mcp/)** — authoring `mcp.json`, stdio/sse/http transports, how servers are inlined for SDK runtimes versus path-forwarded for CLI runtimes.
- **[Sandbox](/tools/sandbox/)** — native srt confinement, filesystem scopes, network modes, and the fail-closed vs unsafe-host-process fallback.

For app-owned send tools (`SlackSendMessage`, `TelegramSendMessage`) that route through enabled channel adapters, see [Delivery & Send Tools](/channels/delivery-and-send-tools/).
