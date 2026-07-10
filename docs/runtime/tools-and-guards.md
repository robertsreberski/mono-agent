---
title: "Built-in tools & auto-guards"
sidebar:
  order: 6
---

# Built-in tools & auto-guards

This page covers the tools every mono-agent ships with out of the box (Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch) and the runtime guards that protect each turn: the tool-output bloat guard, per-run usage/cost tracking, provider-delegated context compaction, and WebFetch's in-tool retry. It also notes which behaviors you configure versus which run automatically.

## Built-in tools

Every agent gets these tools without any extra config (coverage: `config` — they exist by default; you gate them):

| Tool | Purpose |
| --- | --- |
| `Read` | Read a file (text, images, PDFs, notebooks). |
| `Write` | Create or overwrite a file. |
| `Edit` | Exact-string replacement in a file. |
| `Glob` | Match files by glob pattern. |
| `Grep` | Search file contents. |
| `Bash` | Run a shell command. |
| `WebFetch` | Fetch a URL and return its content. |
| `WebSearch` | Run a web search. |

These are gated by `tools.allowedTools` / `tools.disallowedTools`. Deny always wins, and listing the same tool in both is rejected at validation time. See [Tool Policy](/tools/policy/) for the full allow/deny semantics, plus [MCP tools](/tools/mcp/) and the [sandbox](/tools/sandbox/) for `Bash` confinement.

```json
{
  "tools": {
    "allowedTools": ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    "disallowedTools": ["Bash", "Write", "Edit"]
  }
}
```

Env equivalents: `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS` (comma-separated tool names).

:::note
:::
An **omitted** `allowedTools` (or `["*"]`) allows **every** tool subject to `disallowedTools` — the allow-all default. Listing specific names narrows to those; an **explicit empty** `[]` allows none (a deliberate chat-only agent). Add names to `disallowedTools` to subtract from the open default without switching to a full allowlist.

These are the normalized policy semantics, but the selected runtime must be able to enforce them. Direct `codex:*` normal runs currently accept exact allow-all only (`["*"]` or omitted, with no denylist); restrictive variants fail validation/runtime setup instead of being silently widened. See [Tool policy](/tools/policy/#allow-all-by-default).

## Tool-output bloat guard (auto)

Tool results are truncated at a 256KB budget so a single oversized result cannot blow up the context window or the model's reasoning. When a result exceeds the budget it is persisted as an artifact and the truncated portion is replaced with a reference, so nothing is silently lost. Artifacts land in `artifacts.dir`.

Images get a separate, larger budget than text so vision payloads are not clipped at the text limit.

This guard is always on (coverage: `auto`). You do not enable it; you only choose where artifacts are written:

```json
{
  "artifacts": {
    "dir": ".mono-agent/artifacts"
  }
}
```

Env: `MONO_AGENT_ARTIFACT_DIR`.

## Usage & cost tracking (auto)

Each run records per-turn usage, cost, and cache metrics as events in the run's append-only JSONL artifacts. This is automatic (coverage: `auto`) — it rides on the same `artifacts.dir` and needs no separate flag. Secrets are redacted and long strings truncated in the recorded events.

Related per-turn timing also lands in the JSONL: a `provider_bridge_latency` event separates provider/tool/IO time from harness overhead, and per-tool `tool_timing` events carry `execution_ms`. See [Artifacts & traces](/observability/artifacts-and-traces/) and the [CLI reference](/observability/cli-reference/) for reading these, and [Phoenix & backfill](/observability/phoenix-and-backfill/) to export them as spans.

## Context compaction (provider-delegated, auto)

Compaction is delegated to the active provider bridge rather than hand-rolled in the runtime. On the pi-native bridge, the bridge drives `AgentHarness.compact()`:

- **Proactively** — before a turn when the running model is near its context window.
- **Reactively** — if a turn still overflows, it compacts and re-prompts once.

The window auto-tracks whichever model is actually serving the request and self-corrects from a real ceiling reported in an overflow error, so a fallback to a smaller-window model is handled without manual tuning.

Every run reports `context_compaction_applied`:

| Value | Meaning |
| --- | --- |
| `true` | Compaction fired this run. |
| `false` | Enabled but not needed. |
| `null` | Compaction disabled (or the bridge does not support it). |

This is automatic on the pi-native bridge (coverage: `provider` + `settings`); tune it via the `agent_compaction_*` settings. Other bridges follow their own compaction behavior. See [Backends](/runtime/backends/) for bridge differences, [Sessions & concurrency](/runtime/sessions-concurrency/) for how sessions persist, and [Fallback](/runtime/fallback/) for window changes across the fallback chain.

## WebFetch retry (auto)

The `WebFetch` tool retries transient network failures (timeout, `ECONNRESET`, 5xx) in-tool with backoff. This keeps the model from burning reasoning rounds re-issuing a fetch that failed for a momentary network reason. It is built into the tool (coverage: `auto`) — there is nothing to configure.

:::tip
:::
This is distinct from provider-transport retries (`providers.piNative.piMaxRetries` / `maxRetryDelayMs`), which retry the model call itself. WebFetch retry is local to the tool's HTTP request. See [Fallback](/runtime/fallback/) for provider-level retry and failover.

## Tool parallelism (code-only)

By default a model step runs its tool calls one at a time. You can opt into running an independent step's tool calls concurrently (pi-agent-core QueueMode), but only programmatically:

```ts
const runtimeOptions = {
  piToolParallelismMode: "all", // default: "one-at-a-time"
};
```

There is no config-file or CLI key for this (coverage: `code`). Enable it only when a step's tools are genuinely independent — concurrent `Write`/`Edit` to the same file, or order-dependent `Bash` commands, will race. See [Programmatic composition](/programmatic/composition/) for where `runtimeOptions` is supplied.

## Coverage at a glance

| Capability | Coverage | How |
| --- | --- | --- |
| Built-in tools | `config` | `tools.allowedTools` / `tools.disallowedTools` |
| Bloat guard (256KB + artifacts) | `auto` | Built in; artifacts to `artifacts.dir` |
| Usage/cost tracking | `auto` | Recorded in JSONL artifacts |
| Context compaction | `provider` + `settings` | Bridge-driven; `agent_compaction_*` settings |
| WebFetch retry | `auto` | Built into the WebFetch tool |
| Tool parallelism | `code` | `runtimeOptions.piToolParallelismMode` |
