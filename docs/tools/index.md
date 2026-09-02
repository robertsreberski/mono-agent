---
title: "Tools, MCP & Sandbox"
description: "Configure built-in tools, background process jobs, local-first web research, MCP servers, durable continuations, and runtime sandboxing."
sidebar:
  order: 0
---

This section covers how an agent's tool surface is controlled in mono-agent: the **tool policy** (`@mono-agent/agent-harness`) that allow/deny-lists built-in and adapter tools, the **MCP servers** you attach to extend that surface, and the **native sandbox** (`@mono-agent/runtime-adapter`) that confines what tools like `Exec`, `Bash`, `NodeRepl`, `Write`, and `Edit` may touch on disk and over the network.

All three are configured in `mono-agent.config.json`; every route runs the Pi runtime, so enforcement is uniform and unsupported combinations fail closed. The tool policy is **allow-all by default**. When `sandbox.mode` is `native`, SRT confines what tool subprocesses may reach on disk and over the network. With `sandbox.mode: "off"` — or no `sandbox` block at all — `mono-agent validate` reports its Sandbox section as `disabled` (the runtime state is `effective: "off"`) and Bash/stdio MCP subprocesses run unsandboxed. That is a different case from `native` with no usable engine: there the default `sandbox.fallback: "fail-closed"` refuses the **command**, so the tool call fails and the run continues instead of the command running unsandboxed. What the model and the transcript actually see is a `sandbox_prepare_failed` tool outcome reading `Error: Sandbox engine is unavailable and policy is fail-closed.`; `sandbox_unavailable` is the internal sandbox error behind it and the engine state `mono-agent validate` and `mono-agent status` report, not a tool-result code. Only the opt-in `sandbox.fallback: "unsafe-host-process"` (which additionally requires `unsafeAllowHostProcess`) lets that command fall through to the host, and it is loudly warned. Unsupported capabilities are never silently removed.

## The three pieces

| Concern | Package | Config block | Page |
| --- | --- | --- | --- |
| Which tools the model may call | `@mono-agent/agent-harness` | `tools.allowedTools` / `tools.disallowedTools` | [Tool Policy](/tools/policy/) |
| Searching and fetching the public web | `@mono-agent/agent-runtime` | `tools.web.*` | [Local-first web research](/tools/web-research/) |
| Letting local Exec/Bash calls finish after the turn | `@mono-agent/agent-app` + Pi runtime | `processJobs.*` | [Background process jobs](/tools/background-process-jobs/) |
| Attaching external MCP servers | `@mono-agent/agent-harness` | `tools.mcpConfigPath` → `mcp.json` | [MCP Servers](/tools/mcp/) |
| Durably saving facts the user asks you to remember | `@mono-agent/memory` + `@mono-agent/agent-app` | `memory.rememberTool.enabled` + `Remember` tool policy | [MCP Servers](/tools/mcp/#remember-durable-memory-writes) |
| Maintaining semantic web conversation titles | `@mono-agent/agent-app` + `@mono-agent/web` | `SetConversationTitle` tool policy | [MCP Servers](/tools/mcp/#setconversationtitle-web-conversation-naming) |
| Publishing files and interactive app replies | `@mono-agent/agent-app` | `tools.allowedTools` + runtime capability | [Reply files and MCP Apps](/tools/rich-replies/) |
| Searching version-matched docs while authoring | `@mono-agent/docs-mcp` | harness MCP entry installed with the composer | [Documentation MCP companion](/tools/documentation-mcp/) |
| Returning trusted asynchronous results | `@mono-agent/agent-app` + harness | `tools.continuationServers` + `continuations.*` | [Durable continuations](/tools/durable-continuations/) |
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

The managed built-ins are `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`,
`Exec`, `NodeRepl`, `WebFetch`, and `WebSearch` (coverage: `config`). They are
gated by `tools.allowedTools` / `tools.disallowedTools` and supplied through the
Pi runtime's managed tool seam.

`Exec` is the direct-argv process tool; use `Bash` only for shell syntax.
`NodeRepl` shares state only within one run and uses the same sandbox policy.
See [Built-in tools & auto-guards](/runtime/tools-and-guards/) for process
lifecycle and limits. An opt-in Pi-native host can also add `background: true`
to Exec and Bash; see [Background process jobs](/tools/background-process-jobs/).

Equivalent environment overrides exist for headless deploys:

| Config key | Env var |
| --- | --- |
| `tools.allowedTools` | `MONO_AGENT_ALLOWED_TOOLS` |
| `tools.disallowedTools` | `MONO_AGENT_DISALLOWED_TOOLS` |
| `tools.mcpConfigPath` | `MONO_AGENT_MCP_CONFIG_PATH` |
| `tools.continuationServers` | `MONO_AGENT_CONTINUATION_SERVERS` |
| `tools.web.search.backend` / `.endpoint` / `.codex.model` | `MONO_AGENT_WEB_SEARCH_BACKEND` / `MONO_AGENT_WEB_SEARCH_ENDPOINT` / `MONO_AGENT_WEB_SEARCH_CODEX_MODEL` |
| `tools.web.fetch.render` / `.browserCommand` | `MONO_AGENT_WEB_FETCH_RENDER` / `MONO_AGENT_WEB_BROWSER_COMMAND` |
| `sandbox.mode` | `MONO_AGENT_SANDBOX_MODE` |
| `sandbox.network.mode` / `.allowlist` | `MONO_AGENT_SANDBOX_NETWORK` / `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST` |
| `sandbox.fallback` | `MONO_AGENT_SANDBOX_FALLBACK` |

## Allow-all by default

Omit `tools.allowedTools` (or include `"*"` in it) and the policy allows **every** tool — the open default. A wildcard dominates any named entries beside it. Narrow it by naming specific tools or use `[]` for chat-only; deny wins and overlap is rejected. Every route enforces the same policy — no runtime downgrades a restrictive list to allow-all.

:::caution
An **omitted** `allowedTools` and an **explicit empty** `allowedTools: []` are opposites: omitted means all tools, `[]` means none. To subtract a single tool from the open default, leave `allowedTools` off and add the name to `disallowedTools` — you do not need to switch to an explicit allowlist.
:::

:::note
Allow-all is the **config** default. Code-defined agents built directly on the harness fall back to `failClosedToolPolicy()` (an empty, fail-closed policy) when constructed with no policy — see [Tool Policy](/tools/policy/#allow-all-by-default).
:::

## Request-scoped policies only tighten

Channels and programmatic callers can supply per-request tool and sandbox policies. The harness merges supported policies monotonically: a request can narrow the configured policy, never widen it (coverage: `auto`). If the merged result cannot be enforced, the run fails with a capability mismatch rather than proceeding wider.

Model routing is checked against the same absence of silent widening: an
incompatible fallback or model override is rejected before provider execution,
and a dynamic override that cannot be honored is warned and ignored instead of
approximated.

## Where to go next

- **[Tool Policy](/tools/policy/)** — allowlist/denylist semantics, built-in tools, naming MCP tools, and how approval gates relate (the latter is `code`-only, and covers built-in tools only — MCP-backed tools are authorized by declaring their server, not per call. See [programmatic/](/programmatic/approval-and-structured-output/)).
- **[Local-first web research](/tools/web-research/)** — SearXNG, ChatGPT-subscription Codex, and keyless discovery with static extraction, retry, browser isolation, and validation.
- **[MCP Servers](/tools/mcp/)** — authoring `mcp.json`, stdio/sse/http transports, and how the Pi runtime inlines servers into run options.
- **[Reply files and MCP Apps](/tools/rich-replies/)** — opaque file publication, native Slack/Telegram delivery, browser sandboxing, limits, retention, and fallback policy.
- **[Documentation MCP companion](/tools/documentation-mcp/)** — offline semantic and exact-identifier search for the composer and other MCP clients.
- **[Background process jobs](/tools/background-process-jobs/)** — opt-in durable ownership, bounded output, exact-thread wake, cancellation, and restart recovery for Pi-native Exec/Bash.
- **[Durable continuations](/tools/durable-continuations/)** — trusted claim capabilities, immutable later results, tool-free synthesis, native delivery, and recovery.
- **[Sandbox](/tools/sandbox/)** — native srt confinement, filesystem scopes, network modes, and the fail-closed vs unsafe-host-process fallback.

For app-owned send tools (`SlackSendMessage`, `TelegramSendMessage`) that route through enabled channel adapters, see [Delivery & Send Tools](/channels/delivery-and-send-tools/).
