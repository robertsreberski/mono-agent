---
title: "Tools, MCP & Sandbox"
sidebar:
  order: 0
---

# Tools, MCP & Sandbox

This section covers how an agent's tool surface is controlled in mono-agent: the **fail-closed tool policy** (`@mono-agent/tool-policy`) that allow/deny-lists built-in and MCP tools, the **MCP servers** you attach to extend that surface, and the **native sandbox** (`@mono-agent/runtime-adapter`) that confines what tools like `Bash`, `Write`, and `Edit` may touch on disk and over the network.

All three are configured in `mono-agent.config.json` and are enforced by the harness — they are not advisory. The default posture is restrictive: tools are denied unless allowed, and filesystem/network access is scoped to the workspace.

## The three pieces

| Concern | Package | Config block | Page |
| --- | --- | --- | --- |
| Which tools the model may call | `@mono-agent/tool-policy` | `tools.allowedTools` / `tools.disallowedTools` | [Tool Policy](/tools/policy/) |
| Attaching external MCP servers | `@mono-agent/tool-policy` | `tools.mcpConfigPath` → `mcp.json` | [MCP Servers](/tools/mcp/) |
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

## Fail-closed by default

When `tools.allowedTools` is empty the policy denies **every** tool — an empty allowlist means no tools, not all tools (coverage: `auto`). Deny always wins over allow, and listing the same tool in both `allowedTools` and `disallowedTools` is rejected as a configuration error.

:::caution
If you only set `disallowedTools` and leave `allowedTools` empty, the agent still has no tools — `disallowedTools` subtracts from an allowlist, it does not implicitly allow the rest.
:::

## Request-scoped policies only tighten

Channels and programmatic callers can supply per-request tool and sandbox policies, but the harness merges them monotonically: a request can **narrow** the configured policy, never widen it (coverage: `auto`). Configure your maximum allowed surface once in `mono-agent.config.json` and trust that no inbound request can exceed it.

## Where to go next

- **[Tool Policy](/tools/policy/)** — allowlist/denylist semantics, built-in tools, naming MCP tools, and how approval gates relate (the latter is `code`-only — see [programmatic/](/programmatic/approval-and-structured-output/)).
- **[MCP Servers](/tools/mcp/)** — authoring `mcp.json`, stdio/sse/http transports, how servers are inlined for SDK runtimes versus path-forwarded for CLI runtimes.
- **[Sandbox](/tools/sandbox/)** — native srt confinement, filesystem scopes, network modes, and the fail-closed vs unsafe-host-process fallback.

For app-owned send tools (`slack_send_message`, `telegram_send_message`) that route through enabled channel adapters, see [Delivery & Send Tools](/channels/delivery-and-send-tools/).
