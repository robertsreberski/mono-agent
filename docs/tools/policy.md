---
title: "Tool policy"
description: "Allow or deny built-in and app-owned tools while keeping external MCP server boundaries explicit."
sidebar:
  order: 1
---

The tool policy decides which tools an agent may call — built-in tools (Read, Bash, …) and policy-gated app-owned MCP tools such as `RunHistory`, `SessionHistory`, `SetConversationTitle`, `Remember`, and adapter send tools. It is **allow-all by default**: an agent with no `tools` block gets every policy-gated tool, and you subtract from there. You declare it under `tools.allowedTools` / `tools.disallowedTools` (coverage: `config`), with deny always winning and overlaps rejected up front. External MCP-server tools use server declaration as their boundary instead.

## Allow-all by default

If you set no `tools` block, or omit `allowedTools`, the agent can call **every** built-in, the eligible app-owned history, web-title, structured-question, and durable-memory-write tools, and every enabled channel's send tools. There is no allowlist to curate before an agent can do anything — you start open and remove what you don't want. `allowedTools` accepts four shapes:

| `tools.allowedTools` | Result |
| --- | --- |
| omitted | **all tools** (the default) |
| `["*"]` | all tools (explicit allow-all) |
| `["*", "Read"]` | all tools (`"*"` dominates named entries) |
| `["Read", "Bash"]` | just those tools |
| `[]` | **no policy-gated tools** — a deliberate chat-only agent |

```json
{
  "tools": {
    "allowedTools": ["*"]
  }
}
```

An explicit empty list is still expressible and still meaningful: `"allowedTools": []` means the agent can hold a conversation but cannot read files, run commands, or send proactively. It does not remove tools this policy never gated — see the caution below. [`validate` / `doctor`](/observability/cli-reference/#validate) reports that as `waiting` (never a silent `ok`) so an accidental empty list surfaces, while allow-all reports `All tools allowed.`

In guided init, **Allow all tools** remains the default product choice. The flow explicitly names the resulting code-execution, file, web, and enabled channel-send surface before accepting it. If no enforceable sandbox constrains the runtime, a second confirmation is required before continuing; the review never presents allow-all as a risk-free default.

:::note
Allow-all is the **config** default, not a programmatic one. For code-defined agents built directly on `@mono-agent/agent-harness`, the no-config safety net is the opposite: `failClosedToolPolicy()` returns `{ allowedTools: [], disallowedTools: [] }` — an empty, fail-closed policy — so a harness constructed with no policy starts with zero tools until you pass one. The allow-all default lives in the config loader, not the harness.
:::

:::caution
**Enforcement is uniform.** Every route runs the Pi runtime, which projects the
policy directly instead of silently widening the tool surface. A specific list is
the agent's complete surface of policy-gated tools, and any `disallowedTools`
entry is honored for built-ins and app-owned tools. There is no route that
downgrades a restrictive policy to allow-all — a combination the runtime cannot
enforce fails before provider startup.

**`[]` is chat-only for the tools this policy gates.** It does not switch off the
two families listed under [Tools not gated by allowedTools](#tools-not-gated-by-allowedtools):
an external server declared in `tools.mcpServers` / `tools.mcpConfigPath` still
contributes its tools, and `MemoryRecall` still comes from
`memory.recallTool.enabled`. A genuinely tool-free agent needs `[]` *and* no
declared MCP server *and* recall left off.
:::

Runtime discovery still exposes this distinction as
`RuntimeCapabilities.tool_policy`. The Pi bridge always reports
`"projected"`, meaning it enforces the allow/deny lists directly. A custom
structural bridge (injected via `MonoRuntimeLike`) that omits the field has
unknown tool-policy capability and should be treated conservatively.

## allowedTools / disallowedTools

| Key | Type | Behavior |
| --- | --- | --- |
| `tools.allowedTools` | `string[]` | The allowlist. Omitted or containing `"*"` means all tools; a specific named-only list narrows to those names; `[]` means none. |
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

## Deny enforcement

`disallowedTools` filters the built-in tools (`Read`, `Bash`, …), the progressive-disclosure `ReadSkill` tool, `RunHistory`, `SessionHistory`, `SetConversationTitle`, and app-owned adapter send tools (`SlackSendMessage`, `TelegramSendMessage`, …). The Pi runtime honors the list for all of those on every route.

:::caution
**Known limitation — external MCP tools on pi.** Arbitrary tools advertised by an external MCP server are **not** deny-filtered on the pi-native runtime yet. Listing such a tool in `disallowedTools` has no effect there. To hard-restrict an external MCP tool on pi, **don't declare its server** in `mcp.json` / `tools.mcpServers` — server declaration, not the denylist, is what governs its availability. (The app-owned adapter send tools are exempt from this limitation: they are gated by the app, so their `disallowedTools` entries are honored everywhere.)
:::

## Built-in tool names

These are the names recognized for built-in runtime tools (coverage: `config`, gated by this policy):

Managed built-ins: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `Exec`,
`NodeRepl`, `WebFetch`, `WebSearch`. They are supplied through the Pi runtime's
managed tool seam on every route.

`Exec` runs direct argv; `Bash` is reserved for shell syntax. `NodeRepl`
evaluates JavaScript in one REPL child per run. Code run by `Exec`, `Bash`, or
`NodeRepl` is further constrained by the [sandbox](/tools/sandbox/) (filesystem
scopes and network policy) when `sandbox.mode` is `native`. The allowlist
controls *whether* a tool exists; the sandbox controls *what it can reach*. See
[Tools and guards](/runtime/tools-and-guards/).

## Adapter send tools

The app can expose MCP tools that send messages back out through an already-enabled channel adapter: `SlackSendMessage`, `TelegramSendMessage` (optionally with non-blocking reply buttons), `TelegramSendFile` (document or photo), and one structured `AskUser` tool across web, Slack, and Telegram (coverage: `config`).

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

## RunHistory

`RunHistory` is an app-owned, read-only, request-scoped MCP tool for listing, searching, and cursor-inspecting safe normalized evidence from settled prior runs (`succeeded`, `failed`, `cancelled`, or `interrupted`) in the logical current conversation. Configured daily rollover buckets do not partition that scope. It has no separate config key:

- Under allow-all, it is available automatically on every route.
- Under a specific allowlist, include `RunHistory` explicitly.
- `disallowedTools` can remove it, with deny still winning.
- `run_history` is accepted only as a deprecated policy alias; the registered/model-facing name is `RunHistory`. Tool input also accepts `run_id` as an alias for `runId`.

The tool excludes the current/running run, unrelated conversations or threads, system prompts, reasoning, recalled memory, and raw artifact paths. Cancelled/interrupted overviews label output as incomplete evidence and provide the exact run-scoped `SessionHistory` recovery handoff when available. See [MCP servers](/tools/mcp/#runhistory-prior-run-evidence) for its list/search/overview/timeline interface and [Artifacts and traces](/observability/artifacts-and-traces/#agent-facing-prior-run-evidence-runhistory) for its evidence boundary.

## SessionHistory

`SessionHistory` is the separate read-only, request-scoped tool for redacted and bounded managed-tool invocations/results retained in the current logical session. Under a specific allowlist, include `SessionHistory`; `session_history` is a deprecated policy alias, and deny still wins. Recovery from a cancelled/interrupted `RunHistory` candidate uses a run-scoped search with `includeIsolated: true` and no `states` narrowing. Search navigation distinguishes the invocation `recordId` from the terminal `resultRecordId`, directs inspection of the result when present and the invocation when needed, preserves the isolation flag, uses the supported 8192-byte bound, and supplies exact cursor continuations. A bounded preview is not a substitute for record-level inspection, and an empty exact-run search must not be broadened. The tool excludes the current run and isolated/proactive records by default, keeps foreign conversations opaque, and cannot execute or mutate anything. It does not resume provider state, replay tools, rerun work, or guarantee continuation from an interrupted point; continuation is fresh work in the current run with currently available tools and verification. See [MCP servers](/tools/mcp/#sessionhistory-retained-tool-lifecycles) for search/get, cursor, tombstone, artifact, and untrusted-data bounds.

## SetConversationTitle

`SetConversationTitle` is an app-owned, request-scoped MCP tool supplied only to
ordinary interactive web turns whose title remains automatic. It accepts one
normalized semantic title of at most 80 characters. Under a specific allowlist,
include `SetConversationTitle`; deny still wins. Trigger-created and archived
threads are ineligible, and any user rename permanently locks the title against
agent updates. If it is unavailable or unused, the web console keeps its
existing first-user-message fallback. See
[MCP servers](/tools/mcp/#setconversationtitle-web-conversation-naming) for the
request and persistence boundary.

## `Remember`

`Remember` durably stores one explicitly stated fact in long-term memory. Unlike
read-only `MemoryRecall` it **is** allowlist-gated, so an operator can withhold
durable writes while keeping recall: under allow-all it is offered
automatically, a restrictive `allowedTools` must name `Remember`, and
`disallowedTools` removes it with deny winning.

Policy is necessary but not sufficient. The tool also requires a configured
memory block with `memory.rememberTool.enabled` left on, and a store that can
actually accept writes — which excludes read-only stores and the Supermemory
backend. See [MCP servers](/tools/mcp/#remember-durable-memory-writes) for the
storage contract and the credential-rejection boundary.

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

The same rules apply through the environment: an **unset** `MONO_AGENT_ALLOWED_TOOLS` keeps the allow-all default, while an empty value (`MONO_AGENT_ALLOWED_TOOLS=""`) requests explicit chat-only `[]`, which every route enforces. Deny-wins / overlap-rejection are unchanged. See [Environment variables](/config/env-vars/).

## Back-compat: legacy tool names

Most tools were renamed to PascalCase, and the remaining snake_case send/file,
skill, memory, and run-history spellings continue as deprecated policy-input
aliases. Mono-agent cannot safely rewrite hand-authored deny-lists, so those
entries must not silently stop matching. `telegram_send_document` and
`telegram_send_photo` both map to the single `TelegramSendFile` tool, so a
`disallowedTools` entry for either name denies the whole file tool. Canonical
PascalCase names are the only ones registered, emitted, or recommended. See
[Presets & modules](/reference/presets/#back-compat-legacy-tool-names) and the
canonical [deprecation tracker](/reference/deprecations/).

## Programmatic use

The policy is also available as a library for code-defined agents: `createToolPolicy()`, `failClosedToolPolicy()`, `loadToolPolicyFromJsonFile()`, and `toolPolicyToRuntimeOptions()` from `@mono-agent/agent-harness`. Errors are thrown as `ToolPolicyError` with codes `invalid_tool_policy` and `tool_policy_read_failed`. See [Programmatic API](/programmatic/).
